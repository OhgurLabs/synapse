import { execFileSync } from 'child_process';
import { existsSync, writeFileSync, realpathSync } from 'fs';
import { join, dirname, resolve as pathResolve } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../logger.js';

const log = createLogger('git-branches');

// ── Runtime-tree guardrail ───────────────────────────────────────────────────
// The orchestrator RUNTIME tree must never be branch-switched by the campaign
// machinery: doing so swaps the running process's own code under it, and a
// broken campaign-branch commit then crash-loops the orchestrator on restart
// (incident, 2026-06-10). Self-hosting projects (any project whose repo IS this repo) must point
// projectDir at a SEPARATE clone (/path/to/synapse-dev), never the runtime dir. This
// guard code-enforces the invariant so a config regression can't silently reopen
// the hole — a mispointed project's subtasks block (recoverable) instead of
// crashing the control plane (catastrophic).
const RUNTIME_ROOT = (() => {
  try {
    const moduleRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
    return realpathSync(process.env.SYNAPSE_ROOT_DIR || moduleRoot);
  } catch { return null; }
})();

function assertNotRuntimeTree(projectDir, op) {
  if (!RUNTIME_ROOT || !projectDir) return;
  let real;
  try { real = realpathSync(projectDir); } catch { return; } // missing dir: other guards handle
  if (real === RUNTIME_ROOT) {
    throw new Error(
      `Refusing to ${op} on the orchestrator runtime tree (${real}). A self-hosting ` +
      `project's projectDir must be a separate clone (e.g. /path/to/synapse-dev), not the ` +
      `runtime dir — branch-switching it crash-loops the orchestrator. Fix projectDir ` +
      `in .synapse/projects/<id>/config.json.`
    );
  }
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);
const BRANCH_PREFIX = 'synapse/campaign-';
const DEFAULT_REPO_CONFIG = Object.freeze({ mode: 'local', autoInit: false, branch: 'main' });

// Per-projectDir "we already warned about mode:none" set so we don't log on
// every heartbeat — operator gets one info-level message per project and
// then the runtime stays quiet.
const noneModeNoticed = new Set();

function runGit(cwd, args, timeoutMs = 10000) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    // execFileSync throws an Error whose .message is just the command string
    // ("Command failed: git checkout X") and stashes git's actual stderr on
    // .stderr. Catch sites in this file log err.message and lose the real
    // reason — which made debugging the "Failed to checkout branch" cluster
    // on 2026-06-04 require manual git invocations. Append stderr to message
    // so every catch site surfaces the actual git output by default.
    const stderr = (err.stderr || '').toString().trim();
    if (stderr) err.message = `${err.message}\nstderr: ${stderr}`;
    throw err;
  }
}

// Like runGit but returns the process exit code instead of throwing — for
// commands whose EXIT CODE is the signal (e.g. `git diff --cached --quiet`,
// which exits 1 to mean "staged changes exist"). runGit's execFileSync would
// treat that non-zero exit as a thrown error.
function gitExitCode(cwd, args, timeoutMs = 10000) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', timeout: timeoutMs });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

// Stage all changes and commit — but ONLY if `git add -A` actually staged
// something. A dirty submodule or nested-worktree gitlink is reported by
// `git status` (Y column = M) yet CANNOT be staged by `git add -A`, so an
// unconditional `git commit` fails with "nothing to commit" (exit 1, empty
// stderr) and wedges campaign-branch creation in a crash loop — observed
// 132× on 2026-06-19 via the wf_45d70ff4 worktree gitlink in /path/to/synapse-dev.
//
// The robust test is `git diff --cached --quiet` (index vs HEAD): exit 0 ⇒
// nothing staged ⇒ skip the commit. A `git status --porcelain` non-empty
// check is NOT sufficient here — the dirty submodule keeps the tree dirty
// (Y=M) even when nothing is staged (X=space), so it would still fire the
// doomed commit. Returns true iff a commit was made.
function commitAllIfStaged(projectDir, message) {
  runGit(projectDir, ['add', '-A']);
  if (gitExitCode(projectDir, ['diff', '--cached', '--quiet']) !== 0) {
    runGit(projectDir, ['commit', '-m', message]);
    return true;
  }
  return false;
}

function resolveRepoConfig(repoConfig) {
  if (!repoConfig || typeof repoConfig !== 'object') return DEFAULT_REPO_CONFIG;
  return {
    mode: repoConfig.mode || DEFAULT_REPO_CONFIG.mode,
    autoInit: repoConfig.autoInit !== false ? !!repoConfig.autoInit : false,
    branch: repoConfig.branch || DEFAULT_REPO_CONFIG.branch,
    remote: repoConfig.remote || null,
  };
}

/**
 * True iff `projectDir` is the root of a git repo (top-level `.git`).
 * Cheap, no subprocess.
 */
export function isGitRepo(projectDir) {
  if (!projectDir) return false;
  try {
    return existsSync(join(projectDir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Initialize a fresh git repo at `projectDir` and make an initial commit so
 * subsequent `git checkout -b` calls have a HEAD to fork from. Idempotent —
 * if the dir is already a git repo, returns true without changes.
 *
 * Used for repoConfig.mode='local' (and 'github') with autoInit=true. Always
 * commits with a synapse-attributed author so operator's normal git identity
 * is preserved when they take over later.
 */
export function ensureRepoInitialized(projectDir, { branch = 'main' } = {}) {
  if (!projectDir) return false;
  if (isGitRepo(projectDir)) return true;
  try {
    runGit(projectDir, ['init', '-b', branch]);
    // Configure a synapse-attributed author so the operator's `git config
    // --global user.*` (if any) doesn't pollute commits; if they want their
    // identity on these commits later, they can amend or set per-repo.
    try {
      runGit(projectDir, ['config', 'user.email', 'synapse@localhost']);
      runGit(projectDir, ['config', 'user.name', 'Synapse']);
    } catch { /* not fatal — global may already cover it */ }

    // Write a sensible .gitignore BEFORE the initial commit. Without this,
    // the later `git add -A` (e.g. "auto-commit before campaign branch")
    // slurps .synapse/ runtime state into git, which then trips the
    // runtime-state-tracking guardrail on every agent dispatch. Concrete
    // ignore list mirrors the dev-repo's expectations: anything under
    // .synapse/ is operator-private runtime state.
    const gitignorePath = join(projectDir, '.gitignore');
    if (!existsSync(gitignorePath)) {
      const lines = [
        '# Synapse runtime state — never commit',
        '.synapse/',
        '',
        '# Common',
        'node_modules/',
        '*.log',
        '*.log.*',
        '*.tmp',
        '*.bak',
        '*.bak.*',
        '.DS_Store',
        '',
        '# SQLite artifacts — test runs regenerate these constantly; tracking',
        '# them inflates every broad commit past the agent commit guard',
        'test-db/',
        '*.db',
        '*.db-shm',
        '*.db-wal',
        '*.sqlite',
        '*.sqlite-shm',
        '*.sqlite-wal',
        '*.err',
        '',
      ].join('\n');
      try {
        writeFileSync(gitignorePath, lines);
      } catch (gErr) {
        log.warn('Failed to write .gitignore (continuing)', { projectDir, error: gErr.message });
      }
    }
    // Stage + commit the .gitignore so it's part of the very first commit
    // (so even the campaign branch base sees it).
    try {
      runGit(projectDir, ['add', '.gitignore']);
    } catch { /* no-op if already committed somewhere */ }
    runGit(projectDir, ['commit', '--allow-empty', '-m', 'synapse: initial commit (auto-init with .gitignore)']);
    log.info('Auto-initialized git repo', { projectDir, branch });
    return true;
  } catch (err) {
    log.error('Failed to auto-init git repo', { projectDir, error: err.message });
    return false;
  }
}

export function campaignBranchName(campaignId) {
  return `${BRANCH_PREFIX}${campaignId}`;
}

export function getCurrentBranch(projectDir) {
  try {
    return runGit(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}

export function isProtectedBranch(branchName) {
  return PROTECTED_BRANCHES.has(branchName);
}

export function branchExists(projectDir, branchName) {
  try {
    runGit(projectDir, ['rev-parse', '--verify', branchName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a per-campaign git branch in `projectDir`. The `repoConfig` argument
 * (optional, defaults to mode='local' with no auto-init) controls behavior:
 *
 *   mode='none'   — skip silently, return null. Used by projects that don't
 *                   want any git operations (file-only sandboxes etc).
 *   mode='local'  — create the branch as usual. With autoInit=true, init the
 *                   repo first if projectDir isn't a git repo yet.
 *   mode='github' — same as local. Push happens elsewhere, behind the
 *                   SYNAPSE_ENABLE_GITHUB_PUSH flag.
 *
 * Returns the branch name on success, null on skip/failure.
 */
export function createCampaignBranch(projectDir, campaignId, repoConfig) {
  const cfg = resolveRepoConfig(repoConfig);
  const branchName = campaignBranchName(campaignId);

  if (cfg.mode === 'none') {
    const key = projectDir || '<unknown>';
    if (!noneModeNoticed.has(key)) {
      log.info('Skipping branch creation: repoConfig.mode is "none"', { projectDir });
      noneModeNoticed.add(key);
    }
    return null;
  }

  assertNotRuntimeTree(projectDir, 'create a campaign branch');

  // Auto-init when configured. Without this, mode=local on a non-git
  // projectDir falls through to "Cannot create branch — not a git repo"
  // and the campaign stalls behind the runtime guardrail.
  if (cfg.autoInit && !isGitRepo(projectDir)) {
    if (!ensureRepoInitialized(projectDir, { branch: cfg.branch })) {
      log.warn('Auto-init failed — falling back to no-branch behavior', { projectDir });
      return null;
    }
  }

  try {
    if (branchExists(projectDir, branchName)) {
      log.info('Campaign branch already exists', { branchName });
      return branchName;
    }
    const current = getCurrentBranch(projectDir);
    if (!current) {
      log.warn('Cannot create branch — not a git repo', { projectDir });
      return null;
    }

    // Two projects sharing one working tree: when project Bravo's campaign
    // arrives, the HEAD is whatever Alpha's last branch was. Always fork off
    // the configured base branch (default 'main') so a project's campaign
    // history is rooted in main, not in another project's WIP branch.
    const baseBranch = cfg.branch || 'main';
    if (current !== baseBranch && branchExists(projectDir, baseBranch)) {
      const status = runGit(projectDir, ['status', '--porcelain']);
      if (status && status.trim().length > 0 && PROTECTED_BRANCHES.has(current)) {
        log.warn('Working tree dirty on protected branch — committing before branching', {
          branch: current, projectDir,
        });
        commitAllIfStaged(projectDir, 'synapse: auto-commit before campaign branch');
      }
      // Move to the base before forking. If the tree is dirty on a non-
      // protected branch, git will refuse the checkout — let the existing
      // dirty-tree handling below (one more pass) commit and retry once.
      try {
        runGit(projectDir, ['checkout', baseBranch]);
      } catch {
        commitAllIfStaged(projectDir, 'synapse: auto-commit before campaign branch');
        runGit(projectDir, ['checkout', baseBranch]);
      }
    } else if (PROTECTED_BRANCHES.has(current)) {
      const status = runGit(projectDir, ['status', '--porcelain']);
      if (status && status.trim().length > 0) {
        log.warn('Working tree dirty on protected branch — committing before branching', {
          branch: current, projectDir,
        });
        commitAllIfStaged(projectDir, 'synapse: auto-commit before campaign branch');
      }
    }
    runGit(projectDir, ['checkout', '-b', branchName]);
    log.info('Created campaign branch', { branchName, fromBranch: baseBranch });
    return branchName;
  } catch (err) {
    log.error('Failed to create campaign branch', { branchName, error: err.message });
    return null;
  }
}

export function checkoutBranch(projectDir, branchName) {
  try {
    assertNotRuntimeTree(projectDir, `checkout branch ${branchName}`);
    const current = getCurrentBranch(projectDir);
    if (current === branchName) return true;
    // Mirror createCampaignBranch's dirty-tree handling — `git checkout` refuses
    // with "Your local changes would be overwritten" when tracked files are
    // modified. Agents legitimately modify tracked files mid-task and synapse's
    // checkout cadence can race that. Auto-commit the WIP first so the switch
    // succeeds; the committed state preserves agent work. Without this, the
    // failure cascades to lifecycle.js "Blocking subtask because campaign
    // branch is unavailable" and every dispatch into this project stalls until
    // an operator manually commits (observed 725×/12h on a busy test project
    // on 2026-06-04).
    const status = runGit(projectDir, ['status', '--porcelain']);
    if (status && status.trim().length > 0) {
      log.warn('Working tree dirty — committing before checkout', { branchName, projectDir });
      commitAllIfStaged(projectDir, 'synapse: auto-commit before campaign branch');
    }
    if (!branchExists(projectDir, branchName) && branchName.startsWith(BRANCH_PREFIX)) {
      log.info('Campaign branch does not exist on disk — creating on checkout', { branchName, projectDir });
      runGit(projectDir, ['checkout', '-b', branchName]);
    } else {
      runGit(projectDir, ['checkout', branchName]);
    }
    log.info('Checked out branch', { from: current, to: branchName });
    return true;
  } catch (err) {
    log.error('Failed to checkout branch', { branchName, error: err.message });
    return false;
  }
}

/**
 * Merge a campaign branch back into main. Honors repoConfig.mode — skips
 * for 'none', proceeds normally for 'local' and 'github'. When 'github' AND
 * SYNAPSE_ENABLE_GITHUB_PUSH=true, the merge result includes a push attempt
 * (currently a no-op stub — wire-up lands when the flag flips).
 */
/**
 * Commit specific paths on the CURRENTLY checked-out branch. Best-effort:
 * returns true on success (including "nothing to commit"), false if not a git
 * repo or the commit fails.
 *
 * Used by the UI agent-config save path (saveAgentsConfig). `.synapse/agents.json`
 * is a governance-protected file. NOTE (design updated post-2026-08-01):
 * agents.json itself is now MEMORY-AUTHORITATIVE — the integrity check
 * recognises the orchestrator's own writes by disk === serializeAgentsConfig()
 * and restores from memory (saveAgentsConfig), never via git. This commit
 * matters for the OTHER governance files and for history/audit: a committed
 * edit is recognised as legitimate via isPathCommittedClean (the git-revert
 * arm only applies to non-agents.json governance files), and an uncommitted
 * UI edit was the 2026-06-15 ship-blocker. Best-effort on non-git installs.
 *
 * Deliberately does NOT switch branches and does NOT call assertNotRuntimeTree:
 * committing a single file on the current branch never swaps the running
 * process's code (only branch-switching does), so it is safe on the runtime tree.
 * Restricts the commit to the given pathspec so unrelated agent WIP in the
 * working tree is not swept in.
 */
export function commitPaths(projectDir, paths, message) {
  try {
    if (!isGitRepo(projectDir)) return false;
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (list.length === 0) return false;
    runGit(projectDir, ['add', '--', ...list]);
    // Nothing staged for these paths (content already == HEAD)? Success, no commit.
    const staged = runGit(projectDir, ['diff', '--cached', '--name-only', '--', ...list]);
    if (!staged || staged.trim().length === 0) return true;
    runGit(projectDir, ['commit', '-m', message || 'synapse: operator config update', '--', ...list]);
    log.info('Committed operator config change', { projectDir, paths: list });
    return true;
  } catch (err) {
    log.warn('commitPaths failed', { projectDir, error: err.message });
    return false;
  }
}

/**
 * True iff `filePath` is git-tracked in `projectDir` AND has no uncommitted
 * changes vs HEAD (working tree identical to the committed version).
 *
 * This is the governance integrity check's discriminator between a legitimate
 * committed operator edit and an agent's uncommitted mid-task tampering. An
 * agent is locked out (chmod 444) during its task and cannot commit, so a
 * governance file that is tracked-and-clean-vs-HEAD can only be a committed
 * operator change. Returns false for untracked files (e.g. an un-gitignored
 * .env) — those have no HEAD to compare against and KEEP the snapshot-based
 * revert protection. Best-effort: any git error → false (fail safe = treat as
 * tampering).
 */
export function isPathCommittedClean(projectDir, filePath) {
  try {
    if (!isGitRepo(projectDir)) return false;
    // Tracked? ls-files --error-unmatch exits non-zero (throws) for untracked paths.
    runGit(projectDir, ['ls-files', '--error-unmatch', '--', filePath]);
    // Clean vs HEAD? diff --quiet exits 1 (throws) when there are differences.
    runGit(projectDir, ['diff', '--quiet', 'HEAD', '--', filePath]);
    return true;
  } catch {
    return false;
  }
}

export function mergeCampaignBranch(projectDir, campaignId, campaignTitle, repoConfig) {
  const cfg = resolveRepoConfig(repoConfig);
  const branchName = campaignBranchName(campaignId);

  if (cfg.mode === 'none') {
    return { success: true, skipped: true, reason: 'repoConfig.mode is "none"' };
  }

  try {
    const current = getCurrentBranch(projectDir);
    if (!PROTECTED_BRANCHES.has(current)) {
      runGit(projectDir, ['checkout', cfg.branch || 'main']);
    }
    if (!branchExists(projectDir, branchName)) {
      log.error('Campaign branch not found for merge', { branchName });
      return { success: false, error: 'Branch not found' };
    }
    const mergeMsg = `Merge campaign: ${campaignTitle}\n\nCampaign-ID: ${campaignId}\nBranch: ${branchName}\nMerged-by: synapse`;
    runGit(projectDir, ['merge', '--no-ff', branchName, '-m', mergeMsg]);
    log.info('Merged campaign branch', { branchName, campaignId });

    // GitHub push (gated). The flag is OFF by default for beta — the schema
    // and configuration are present, but the actual push is held back until
    // an explicit operator opt-in. When the flag flips, this branch + the
    // merge commit get pushed to repoConfig.remote via the gh CLI.
    if (cfg.mode === 'github' && process.env.SYNAPSE_ENABLE_GITHUB_PUSH === 'true' && cfg.remote) {
      try {
        runGit(projectDir, ['push', 'origin', cfg.branch || 'main']);
        runGit(projectDir, ['push', 'origin', branchName]);
        log.info('Pushed campaign branch + merge to GitHub', { branchName, remote: cfg.remote });
      } catch (pushErr) {
        log.error('GitHub push failed (merge already committed locally)', {
          branchName, remote: cfg.remote, error: pushErr.message,
        });
        return { success: true, pushFailed: true, pushError: pushErr.message };
      }
    }
    return { success: true };
  } catch (err) {
    log.error('Failed to merge campaign branch', { branchName, error: err.message });
    return { success: false, error: err.message };
  }
}

export function rollbackLastMerge(projectDir) {
  try {
    runGit(projectDir, ['revert', '-m', '1', 'HEAD', '--no-edit']);
    log.info('Rolled back last merge commit');
    return { success: true };
  } catch (err) {
    log.error('Failed to rollback merge', { error: err.message });
    return { success: false, error: err.message };
  }
}

export function deleteCampaignBranch(projectDir, campaignId, repoConfig) {
  const cfg = resolveRepoConfig(repoConfig);
  if (cfg.mode === 'none') return true;
  const branchName = campaignBranchName(campaignId);
  try {
    const current = getCurrentBranch(projectDir);
    if (current === branchName) {
      runGit(projectDir, ['checkout', cfg.branch || 'main']);
    }
    if (branchExists(projectDir, branchName)) {
      runGit(projectDir, ['branch', '-d', branchName]);
      log.info('Deleted campaign branch', { branchName });
    }
    return true;
  } catch (err) {
    log.error('Failed to delete campaign branch', { branchName, error: err.message });
    return false;
  }
}
