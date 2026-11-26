/**
 * Phase 1A — Per-Subtask Git Worktree Transactionality (Single Owner).
 *
 * Isolates each executing subtask in its own ephemeral git worktree
 * (<projectDir>/.synapse-worktrees/<attemptId>) on branch
 * synapse/campaign-<shortCid>-subtask-<safeSid>-<shortAtt> branched from the
 * campaign branch, then integrates commits transactionally under a per-repo
 * async mutex after verifying:
 *  - ExecutionContract fence & persisted ownership
 *  - 2026-08-20 tracked-file deletion guard (pendingTrackedRemovals)
 *  - Protected vault paths stay outside campaign and subtask changes
 *  - Strict worktree path confinement & Git locked-worktree refusal preservation
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync, lstatSync } from 'fs';
import { join, resolve as pathResolve, relative, sep, basename } from 'path';
import { createLogger } from '../logger.js';
import config from '../config.js';
import {
  assertNotRuntimeTree,
  isGitRepo,
  getCurrentBranch,
  checkoutBranch,
} from './git-branches.js';

const log = createLogger('git-worktrees');

// Ephemeral subtask branches have a separate name from their campaign branches.
const SUBTASK_BRANCH_RE = /^synapse\/(?:campaign-[^/]+-)?subtask-/;

/**
 * Protect operator records in the maintenance, design, and audit directories
 * from campaign and subtask changes.
 * Agent-written vault/research/** and vault/campaigns/** are explicitly allowed.
 */
export const PROTECTED_VAULT_PATH_RE = /^vault\/(?:maintenance|design|audit)\//;

export function findProtectedVaultPaths(paths = []) {
  return (paths || [])
    .map(p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter(p => p && PROTECTED_VAULT_PATH_RE.test(p));
}

export function isEphemeralSubtaskBranch(branchName) {
  return typeof branchName === 'string' && SUBTASK_BRANCH_RE.test(branchName);
}

/** @type {Map<string, Promise<any>>} per-repo async integration mutex */
const repoIntegrationLocks = new Map();

function realpathOrResolve(p) {
  try {
    return realpathSync(p);
  } catch {
    return pathResolve(String(p || ''));
  }
}

function normalizeRepoKey(projectDir) {
  return realpathOrResolve(projectDir);
}

/**
 * Finding #7: Validate that `worktreePath` is strictly confined as a child inside
 * `<projectDir>/<dirName>/` (defeats path traversal, symlinks outside root, and
 * arbitrary persisted paths), and verify neither path is the runtime tree.
 */
export function assertConfinedWorktreePath(projectDir, worktreePath, dirName = '.synapse-worktrees') {
  assertNotRuntimeTree(projectDir, 'assertConfinedWorktreePath');
  if (!worktreePath) {
    throw new Error('Refusing worktree operation: worktreePath is empty');
  }
  assertNotRuntimeTree(worktreePath, 'assertConfinedWorktreePath');

  const canonicalProject = realpathSync(projectDir);
  const expectedRoot = pathResolve(canonicalProject, dirName || '.synapse-worktrees');
  const lexicalProject = pathResolve(projectDir);
  const lexicalTarget = pathResolve(worktreePath);
  const resolvedTarget = lexicalTarget.startsWith(lexicalProject + sep)
    ? pathResolve(canonicalProject, relative(lexicalProject, lexicalTarget))
    : lexicalTarget;

  if (!expectedRoot.startsWith(canonicalProject + sep) || !resolvedTarget.startsWith(expectedRoot + sep)) {
    throw new Error(
      `Refusing worktree operation outside confined root: "${resolvedTarget}" is not inside "${expectedRoot}"`
    );
  }
  let componentPath = canonicalProject;
  for (const component of relative(canonicalProject, resolvedTarget).split(sep)) {
    componentPath = join(componentPath, component);
    try {
      const stat = lstatSync(componentPath);
      if (componentPath === resolvedTarget && stat.isFile() && realpathSync(componentPath) === componentPath) {
        throw new Error(`Refusing worktree operation on "${componentPath}": not a Synapse attempt directory`);
      }
      if (!stat.isDirectory() || realpathSync(componentPath) !== componentPath) {
        throw new Error(`Refusing non-canonical worktree directory: "${componentPath}"`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      break;
    }
  }
  return resolvedTarget;
}

/**
 * Run `fn` under a per-repository async mutex so concurrent subtask integrations
 * into `campaignBranch` never interleave git index/HEAD mutations.
 */
export async function withRepoIntegrationLock(projectDir, fn) {
  const key = normalizeRepoKey(projectDir);
  const prev = repoIntegrationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chain = prev.then(() => current, () => current);
  repoIntegrationLocks.set(key, chain);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (repoIntegrationLocks.get(key) === chain) {
      repoIntegrationLocks.delete(key);
    }
  }
}

function runGit(cwd, args, timeoutMs = 15000) {
  try {
    const output = execFileSync('git', ['--no-replace-objects', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return args.includes('-z') ? output : output.trim();
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    if (stderr) err.message = `${err.message}\nstderr: ${stderr}`;
    throw err;
  }
}

function gitExitCode(cwd, args, timeoutMs = 15000) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', timeout: timeoutMs });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

function sanitizeToken(val, maxLen = 40) {
  return String(val || 'item')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen) || 'item';
}

/**
 * Finding #6: Name ephemeral subtask branches `synapse/campaign-<shortCid>-subtask-<safeSid>-<shortAtt>`
 * so `*campaign*` pre-commit hooks match them directly.
 */
export function subtaskBranchName(subtaskId, attemptId, campaignBranch = null) {
  const safeSub = sanitizeToken(subtaskId, 24);
  const safeAtt = sanitizeToken(String(attemptId || '').slice(-12), 16);
  let shortCid = 'local';
  if (campaignBranch && typeof campaignBranch === 'string') {
    const stripped = campaignBranch.replace(/^synapse\/campaign-/, '');
    shortCid = sanitizeToken(stripped, 18) || 'local';
  }
  return `synapse/campaign-${shortCid}-subtask-${safeSub}-${safeAtt}`;
}

/**
 * Parse Git's NUL-delimited worktree listing to inspect registrations and locks.
 */
function listRegisteredWorktrees(projectDir) {
  const fields = nulFields(runGit(projectDir, ['worktree', 'list', '--porcelain', '-z']));
  const entries = [];
  let current = null;
  for (const line of fields) {
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: realpathOrResolve(line.slice('worktree '.length)), locked: false, branch: null };
    } else if (current && line.startsWith('locked')) {
      current.locked = true;
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Ensure `<gitCommonDir>/info/exclude` ignores `.synapse-worktrees` without
 * modifying any tracked `.gitignore` file.
 */
export function ensureWorktreeDirExcluded(projectDir, dirName = '.synapse-worktrees') {
  try {
    const commonDirRaw = runGit(projectDir, ['rev-parse', '--git-common-dir']);
    const commonDir = pathResolve(projectDir, commonDirRaw);
    const infoDir = join(commonDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const excludePath = join(infoDir, 'exclude');
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const entry = `/${dirName}/`;
    const entryNoSlash = `${dirName}/`;
    if (!existing.split('\n').some(line => line.trim() === entry || line.trim() === entryNoSlash || line.trim() === dirName)) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(excludePath, `${existing}${prefix}${entry}\n`, 'utf8');
    }
  } catch (err) {
    log.debug('Could not update .git/info/exclude for worktrees (non-fatal)', {
      projectDir, error: err.message,
    });
  }
}

/**
 * Create an isolated git worktree for a single subtask attempt.
 */
export function createSubtaskWorktree({
  projectDir,
  campaignBranch = null,
  subtaskId,
  attemptId,
  repoConfig = null,
  worktreesConfig = null,
} = {}) {
  assertNotRuntimeTree(projectDir, 'createSubtaskWorktree');

  const wtCfg = worktreesConfig || config.worktrees || { enabled: true, dirName: '.synapse-worktrees' };
  if (repoConfig?.mode === 'none') {
    return {
      enabled: false,
      workdir: projectDir,
      worktreePath: null,
      subtaskBranch: null,
      baseBranch: null,
      reason: 'repo_mode_none',
    };
  }
  if (wtCfg.enabled === false) {
    return {
      enabled: false,
      workdir: projectDir,
      worktreePath: null,
      subtaskBranch: null,
      baseBranch: null,
      reason: 'worktrees_disabled',
    };
  }
  if (!projectDir || !isGitRepo(projectDir)) {
    // R1 #5: When worktree isolation is enabled for a repo with mode !== 'none', fail closed
    // instead of silently falling back to executing in a shared checkout.
    throw new Error(
      `Worktree isolation enabled (repoConfig.mode=${repoConfig?.mode || 'local'}) but "${projectDir}" is not a valid git repository`
    );
  }

  const dirName = wtCfg.dirName || '.synapse-worktrees';
  const baseBranch = campaignBranch || getCurrentBranch(projectDir) || repoConfig?.branch || 'main';
  const safeAttemptDir = sanitizeToken(attemptId || `att-${Date.now()}`, 48);
  const worktreePath = assertConfinedWorktreePath(projectDir, join(projectDir, dirName, safeAttemptDir), dirName);
  const subtaskBranch = subtaskBranchName(subtaskId, attemptId, baseBranch);

  mkdirSync(pathResolve(realpathSync(projectDir), dirName), { recursive: true });
  assertConfinedWorktreePath(projectDir, worktreePath, dirName);
  ensureWorktreeDirExcluded(projectDir, dirName);

  if (existsSync(worktreePath)) {
    discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
  }

  // Delete stale branch of same name if left behind by a killed process
  try {
    runGit(projectDir, ['branch', '-D', subtaskBranch]);
  } catch { /* branch did not exist */ }

  assertConfinedWorktreePath(projectDir, worktreePath, dirName);
  runGit(projectDir, ['worktree', 'add', '-b', subtaskBranch, worktreePath, baseBranch]);

  log.info('Created isolated subtask worktree', {
    projectDir, worktreePath, subtaskBranch, baseBranch, subtaskId, attemptId,
  });

  return {
    enabled: true,
    workdir: worktreePath,
    worktreePath,
    subtaskBranch,
    baseBranch,
    reason: 'created',
  };
}

/**
 * Safely discard an ephemeral subtask worktree and delete its subtask branch.
 *
 * Finding #7:
 *  - Enforces strict confinement of `worktreePath` inside `<projectDir>/<dirName>/`.
 *  - If the worktree is registered with Git (e.g. locked), delegates exclusively to
 *    `git worktree remove --force` and preserves/rethrows Git's refusal error
 *    (NEVER blindly calling `rmSync` on a locked/refused registered worktree!).
 *  - Only removes unregistered leftover directories strictly confined inside `.synapse-worktrees/`.
 *  - Never deletes protected branches (`main`, `master`) or `synapse/campaign-<id>` branches.
 */
export function discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName = '.synapse-worktrees' } = {}) {
  assertNotRuntimeTree(projectDir, 'discardSubtaskWorktree');

  let resolvedTarget = null;
  if (worktreePath) {
    resolvedTarget = assertConfinedWorktreePath(projectDir, worktreePath, dirName);
  }

  const repoIsGit = Boolean(projectDir && isGitRepo(projectDir));

  if (resolvedTarget && existsSync(resolvedTarget)) {
    if (repoIsGit) {
      const registered = listRegisteredWorktrees(projectDir);
      const match = registered.find(w => w.path === resolvedTarget);
      if (match) {
        // R1 #7 + R3 #9: Verify registered worktree is NOT detached and belongs to the expected ephemeral subtask branch
        if (!match.branch || !isEphemeralSubtaskBranch(match.branch)) {
          throw new Error(
            `Refusing to remove worktree "${resolvedTarget}": branch "${match.branch || 'DETACHED'}" is not an ephemeral subtask branch`
          );
        }
        if (subtaskBranch && match.branch !== subtaskBranch) {
          throw new Error(
            `Refusing to remove worktree "${resolvedTarget}": registered branch "${match.branch}" does not match expected "${subtaskBranch}"`
          );
        }
        // Registered git worktree: let Git enforce lock safety and preserve any refusal error!
        runGit(projectDir, ['worktree', 'remove', '--force', resolvedTarget]);
      } else {
        // Unregistered orphaned directory: must be a real directory (not symlink) matching an attempt token
        const st = lstatSync(resolvedTarget);
        const base = basename(resolvedTarget);
        if (st.isSymbolicLink() || !st.isDirectory() || !/^att[-_]/i.test(base)) {
          throw new Error(
            `Refusing to remove unregistered path "${resolvedTarget}": not a Synapse attempt directory`
          );
        }
        rmSync(resolvedTarget, { recursive: true, force: true });
      }
    } else {
      rmSync(resolvedTarget, { recursive: true, force: true });
    }
  }

  if (repoIsGit) {
    try {
      runGit(projectDir, ['worktree', 'prune']);
    } catch { /* best-effort */ }

    if (subtaskBranch && isEphemeralSubtaskBranch(subtaskBranch)) {
      try {
        runGit(projectDir, ['branch', '-D', subtaskBranch]);
      } catch { /* branch already gone or still checked out in a locked worktree */ }
    }
  }

  return {
    discarded: true,
    worktreePath: resolvedTarget,
    subtaskBranch: subtaskBranch || null,
  };
}

/**
 * Collect all uncommitted (modified, staged, untracked) paths inside `worktreePath`.
 */
const DIFF_PATH_OPTIONS = ['--name-status', '-z', '--no-ext-diff', '--no-textconv', '-M', '-C', '--find-copies-harder', '-l0'];

function nulFields(output) {
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Incomplete Git path listing');
  return output.slice(0, -1).split('\0');
}

function diffPaths(cwd, args) {
  const fields = nulFields(runGit(cwd, [...args, ...DIFF_PATH_OPTIONS, '--']));
  const entries = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(i, i + pathCount);
    i += pathCount;
    if (!/^(?:[ADMTUXB]|[MRC][0-9]{1,3})$/.test(status) ||
        paths.length !== pathCount || paths.some(path => !path)) {
      throw new Error('Invalid Git path listing');
    }
    entries.push({ status, paths });
  }
  return entries;
}

/**
 * Transactionally integrate a subtask worktree's changes onto `campaignBranch`.
 */
export async function integrateSubtaskWorktree({
  projectDir,
  worktreePath,
  subtaskBranch,
  campaignBranch = null,
  attemptId = null,
  checkFence = null,
  commitMessage = null,
  repoConfig = null,
  dirName = '.synapse-worktrees',
  onPreparedCommit = null,
  skipLock = false,
} = {}) {
  assertNotRuntimeTree(projectDir, 'integrateSubtaskWorktree');
  if (worktreePath) {
    assertConfinedWorktreePath(projectDir, worktreePath, dirName);
  }

  const runIntegration = async () => {
    const canonicalWorktree = worktreePath ? assertConfinedWorktreePath(projectDir, worktreePath, dirName) : null;
    // 1. Pre-commit fence check: if stale/cancelled, discard immediately
    if (typeof checkFence === 'function' && !checkFence()) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: true,
        merged: false,
        error: 'stale_attempt_fenced',
        postIntegrationHeadSha: null,
        changedFiles: [],
      };
    }

    if (!worktreePath || !existsSync(worktreePath)) {
      return {
        ok: false,
        fenced: false,
        merged: false,
        error: 'worktree_missing',
        postIntegrationHeadSha: null,
        changedFiles: [],
      };
    }

    // 2. Deletion guard (2026-08-20 fail-closed invariant): never auto-commit tracked file removals
    let staged;
    let unstaged;
    let untracked;
    try {
      const registered = listRegisteredWorktrees(projectDir).find(entry => entry.path === canonicalWorktree);
      if (!isEphemeralSubtaskBranch(subtaskBranch) || registered?.branch !== subtaskBranch) {
        throw new Error('Expected an isolated worktree on the subtask branch');
      }
      staged = diffPaths(worktreePath, ['diff', '--cached']);
      unstaged = diffPaths(worktreePath, ['diff']);
      untracked = nulFields(runGit(worktreePath, ['ls-files', '-z', '--others', '--exclude-standard']));
    } catch (error) {
      return { ok: false, merged: false, error: `Failed to inspect worktree paths: ${error.message}`, changedFiles: [] };
    }
    const removals = {
      staged: staged.filter(entry => entry.status === 'D').flatMap(entry => entry.paths),
      worktree: unstaged.filter(entry => entry.status === 'D').flatMap(entry => entry.paths),
    };
    if (removals.staged.length > 0 || removals.worktree.length > 0) {
      if (removals.staged.length > 0) {
        try { runGit(worktreePath, ['reset', 'HEAD', '--', ...removals.staged]); } catch { /* best-effort */ }
      }
      const deletedList = Array.from(new Set([...removals.staged, ...removals.worktree]));
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: false,
        deletionBlocked: true,
        merged: false,
        error: `Refusing to auto-commit tracked file deletion(s): ${deletedList.join(', ')}`,
        postIntegrationHeadSha: null,
        changedFiles: deletedList,
      };
    }

    // 3. Finding #6: 2026-08-20 protected vault-path disjoint-branch guard (pre-commit check)
    const dirtyPaths = new Set([...staged.flatMap(entry => entry.paths), ...unstaged.flatMap(entry => entry.paths), ...untracked]);
    const blockedDirtyVault = findProtectedVaultPaths([...dirtyPaths]);
    if (blockedDirtyVault.length > 0) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: false,
        vaultGuardBlocked: true,
        merged: false,
        error: `Refusing to commit protected vault path(s) on subtask/campaign branch: ${blockedDirtyVault.join(', ')}`,
        postIntegrationHeadSha: null,
        changedFiles: blockedDirtyVault,
      };
    }

    // 4. Stage and commit any uncommitted edits inside the isolated worktree
    //    (NEVER passing --no-verify so the 2026-08-20 pre-commit hook always runs)
    try {
      runGit(worktreePath, ['add', '-A']);
      const hasStaged = gitExitCode(worktreePath, ['diff', '--cached', '--quiet']) !== 0;
      if (hasStaged) {
        if (typeof checkFence === 'function' && !checkFence()) {
          discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
          return {
            ok: false,
            fenced: true,
            merged: false,
            error: 'stale_attempt_fenced',
            postIntegrationHeadSha: null,
            changedFiles: [],
          };
        }
        const msg = commitMessage || `chore(subtask): integrate worktree ${attemptId || subtaskBranch}`;
        runGit(worktreePath, ['commit', '-m', msg]);
      }
    } catch (commitErr) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: false,
        merged: false,
        error: `Worktree commit failed: ${commitErr.message}`,
        postIntegrationHeadSha: null,
        changedFiles: [],
      };
    }

    // 4b. Optional prepared-commit journal callback (Phase 2A Loop integration recovery)
    let preparedCommitSha = null;
    try {
      preparedCommitSha = runGit(worktreePath, ['rev-parse', 'HEAD']);
      if (typeof onPreparedCommit === 'function' && preparedCommitSha) {
        await onPreparedCommit(preparedCommitSha);
      }
    } catch (prepErr) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: false,
        merged: false,
        error: `Prepared commit journal failed: ${prepErr.message}`,
        postIntegrationHeadSha: null,
        changedFiles: [],
      };
    }

    // 5. Pre-merge fence check
    if (typeof checkFence === 'function' && !checkFence()) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: true,
        merged: false,
        error: 'stale_attempt_fenced',
        postIntegrationHeadSha: null,
        changedFiles: [],
      };
    }

    const targetBranch = campaignBranch || getCurrentBranch(projectDir) || repoConfig?.branch || 'main';

    // 6. Inspect commits and changed files between targetBranch and subtaskBranch
    let aheadCount = 0;
    let changedFiles = [];
    let targetSha;
    try {
      targetSha = runGit(projectDir, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${targetBranch}^{commit}`]);
      const sourceSha = runGit(projectDir, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${subtaskBranch}^{commit}`]);
      if (sourceSha !== preparedCommitSha) throw new Error('Worktree branch changed after preparing commit');
      const range = `${targetSha}..${preparedCommitSha}`;
      aheadCount = Number(runGit(projectDir, ['rev-list', '--count', range]));
      if (!Number.isSafeInteger(aheadCount)) throw new Error('Invalid Git commit count');
      if (aheadCount > 0) {
        const tipDiff = diffPaths(projectDir, ['diff', targetSha, preparedCommitSha]);
        const history = diffPaths(projectDir, ['log', '-m', '--format=', range]);
        const combined = new Set([...tipDiff, ...history].flatMap(entry => entry.paths));
        changedFiles = Array.from(combined);
      }
    } catch (diffErr) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: false,
        merged: false,
        error: `Failed to inspect worktree commits: ${diffErr.message}`,
        postIntegrationHeadSha: null,
        changedFiles: [],
      };
    }

    // Finding #6: Also enforce protected vault-path guard on already-committed edits inside subtaskBranch!
    const blockedCommittedVault = findProtectedVaultPaths(changedFiles);
    if (blockedCommittedVault.length > 0) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: false,
        vaultGuardBlocked: true,
        merged: false,
        error: `Refusing to integrate protected vault path(s) into ${targetBranch}: ${blockedCommittedVault.join(', ')}`,
        postIntegrationHeadSha: null,
        changedFiles: blockedCommittedVault,
      };
    }

    if (aheadCount === 0) {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: true,
        fenced: false,
        merged: false,
        noChanges: true,
        postIntegrationHeadSha: targetSha,
        changedFiles: [],
      };
    }

    // 7. Ensure projectDir is checked out to targetBranch before merging
    const curBranch = getCurrentBranch(projectDir);
    if (curBranch !== targetBranch) {
      const switched = checkoutBranch(projectDir, targetBranch);
      if (!switched) {
        discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
        return {
          ok: false,
          fenced: false,
          merged: false,
          error: `Failed to checkout target branch ${targetBranch} in ${projectDir}`,
          postIntegrationHeadSha: null,
          changedFiles,
        };
      }
    }

    // 8. Merge subtaskBranch onto targetBranch (--ff-only first, then --no-ff if targetBranch advanced concurrently)
    try {
      if (runGit(projectDir, ['rev-parse', 'HEAD']) !== targetSha) {
        throw new Error('Target branch changed during worktree inspection');
      }
      try {
        runGit(projectDir, ['merge', '--ff-only', preparedCommitSha]);
      } catch {
        const mergeMsg = commitMessage || `Merge subtask branch ${subtaskBranch} into ${targetBranch}`;
        runGit(projectDir, ['merge', '--no-ff', '-m', mergeMsg, preparedCommitSha]);
      }
    } catch (mergeErr) {
      try { runGit(projectDir, ['merge', '--abort']); } catch { /* ignore if no merge in progress */ }
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
      return {
        ok: false,
        fenced: false,
        conflict: true,
        merged: false,
        error: `Merge conflict integrating ${subtaskBranch} into ${targetBranch}: ${mergeErr.message}`,
        postIntegrationHeadSha: null,
        changedFiles,
      };
    }

    const postIntegrationHeadSha = runGit(projectDir, ['rev-parse', targetBranch]);
    let cleanupWarning = null;
    try {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch, dirName });
    } catch (cleanupErr) {
      // New P1 #2: targetBranch already advanced; surface warning without masking the landed merge!
      cleanupWarning = cleanupErr.message;
      log.warn('Post-merge worktree cleanup failed (merge already landed)', {
        projectDir, targetBranch, subtaskBranch, postIntegrationHeadSha, error: cleanupWarning,
      });
    }

    log.info('Integrated subtask worktree into campaign branch', {
      projectDir, targetBranch, subtaskBranch, postIntegrationHeadSha, filesChanged: changedFiles.length,
      ...(cleanupWarning ? { cleanupWarning } : {}),
    });

    return {
      ok: true,
      fenced: false,
      merged: true,
      preparedCommitSha,
      postIntegrationHeadSha,
      changedFiles,
      ...(cleanupWarning ? { cleanupWarning } : {}),
    };
  };
  return skipLock ? runIntegration() : withRepoIntegrationLock(projectDir, runIntegration);
}

/**
 * Prune orphaned subtask worktrees and ephemeral subtask branches
 * whose attemptId is not in `activeAttemptIds`.
 */
export function pruneOrphanedWorktrees(projectDir, activeAttemptIds = new Set(), dirName = '.synapse-worktrees') {
  assertNotRuntimeTree(projectDir, 'pruneOrphanedWorktrees');
  if (!projectDir || !isGitRepo(projectDir)) {
    return { prunedWorktrees: [], prunedBranches: [], skippedLocked: [] };
  }

  const activeSet = activeAttemptIds instanceof Set
    ? activeAttemptIds
    : new Set(Array.isArray(activeAttemptIds) ? activeAttemptIds : []);
  const safeActiveDirs = new Set(Array.from(activeSet).map(id => sanitizeToken(id, 48)));

  const prunedWorktrees = [];
  const prunedBranches = [];
  const skippedLocked = [];
  const worktreeRoot = join(projectDir, dirName);

  if (existsSync(worktreeRoot)) {
    for (const entry of readdirSync(worktreeRoot)) {
      if (safeActiveDirs.has(entry)) continue;
      const fullPath = join(worktreeRoot, entry);
      try {
        discardSubtaskWorktree({ projectDir, worktreePath: fullPath, subtaskBranch: null, dirName });
        prunedWorktrees.push(fullPath);
      } catch (err) {
        log.warn('Skipping locked/protected worktree during prune', { fullPath, error: err.message });
        skippedLocked.push({ path: fullPath, error: err.message });
      }
    }
  }

  try {
    runGit(projectDir, ['worktree', 'prune']);
  } catch { /* best-effort */ }

  try {
    const branchesOut = runGit(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/synapse/*']);
    const branches = branchesOut ? branchesOut.split('\n').map(s => s.trim()).filter(isEphemeralSubtaskBranch) : [];
    for (const br of branches) {
      const matchesActive = Array.from(activeSet).some(attId => {
        const shortAtt = sanitizeToken(String(attId || '').slice(-12), 16);
        return shortAtt && br.endsWith(`-${shortAtt}`);
      });
      if (!matchesActive) {
        try {
          runGit(projectDir, ['branch', '-D', br]);
          prunedBranches.push(br);
        } catch { /* in use by locked worktree or already deleted */ }
      }
    }
  } catch { /* best-effort */ }

  return { prunedWorktrees, prunedBranches, skippedLocked };
}

/**
 * Snapshot all git refs in `projectDir` (used to detect unauthorized extra refs/branches
 * created during native delegation execution).
 */
export function snapshotGitRefs(projectDir) {
  const out = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sp = line.indexOf(' ');
    if (sp > 0) map.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return map;
}

/**
 * Phase 3 Pillar 2 Invariant 2 (Single-Branch Output Contract):
 * Strictly verify a native delegation worktree BEFORE `integrateSubtaskWorktree`
 * (which could otherwise auto-commit dirty files!):
 *  1. Worktree & index are completely clean (`git status --porcelain -z` empty)
 *  2. Exact assigned `subtaskBranch` is checked out (rejects detached HEAD or wrong branch)
 *  3. HEAD is strictly descended from pinned `baseSha` and contains new committed work (`HEAD !== baseSha`)
 *  4. Full commit range `baseSha..HEAD` (including merge-parent diffs & both sides of R/C renames)
 *     touches ZERO `PROTECTED_VAULT_PATH_RE` paths (and stays inside `gitWriteSubtree` if set)
 *  5. No unauthorized extra refs/branches were created or modified outside `refs/heads/<subtaskBranch>`
 */
export function verifyNativeWorktreeOutput({
  projectDir,
  worktreePath,
  subtaskBranch,
  baseSha,
  preRefsSnapshot = null,
  gitWriteSubtree = null,
} = {}) {
  if (!projectDir || !worktreePath || !subtaskBranch || !baseSha) {
    return { ok: false, code: 'INVALID_WORKTREE_VERIFY_ARGS', message: 'Missing required worktree verify arguments' };
  }
  if (!existsSync(projectDir) || !existsSync(worktreePath)) {
    return { ok: false, code: 'WORKTREE_MISSING', message: 'Project dir or worktree path does not exist' };
  }

  // 0. Assert canonical git-common-dir of worktreePath matches projectDir (prevents repo spoofing!)
  try {
    const rawExpectedCommon = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const rawWorktreeCommon = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const expectedCommonDir = realpathSync(pathResolve(projectDir, rawExpectedCommon));
    const worktreeCommonDir = realpathSync(pathResolve(worktreePath, rawWorktreeCommon));
    if (worktreeCommonDir !== expectedCommonDir) {
      return {
        ok: false,
        code: 'WORKTREE_REPO_MISMATCH',
        message: `Worktree git-common-dir "${worktreeCommonDir}" does not match project repo "${expectedCommonDir}"`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      code: 'WORKTREE_REPO_MISMATCH',
      message: `Failed to verify worktree repository identity: ${err.message}`,
    };
  }

  // 1. Clean index & worktree (zero uncommitted or untracked files)
  const statusRaw = execFileSync('git', ['status', '--porcelain', '-z', '-uall'], {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8');
  if (statusRaw.length > 0) {
    return { ok: false, code: 'DIRTY_WORKTREE', message: 'Native delegation left dirty or untracked files in worktree' };
  }

  // 2. Exact assigned branch checked out (rejects detached HEAD or switched branch!)
  let currentBranch = null;
  try {
    currentBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return { ok: false, code: 'DETACHED_HEAD', message: 'Native delegation left worktree in detached HEAD state' };
  }
  if (currentBranch !== subtaskBranch) {
    return {
      ok: false,
      code: 'WRONG_BRANCH',
      message: `Native delegation switched branch to "${currentBranch}" (expected "${subtaskBranch}")`,
    };
  }

  // 3. HEAD descended from pinned baseSha AND moved forward (committed edits on HEAD)
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  let isDescendant = false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], {
      cwd: worktreePath,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    isDescendant = true;
  } catch {}
  if (!isDescendant) {
    return { ok: false, code: 'HEAD_NOT_DESCENDANT', message: `Native HEAD ${headSha} is not descended from pinned base ${baseSha}` };
  }
  if (headSha === baseSha) {
    return { ok: false, code: 'NO_COMMITTED_WORK', message: 'Native delegation produced zero commits on assigned branch' };
  }

  // Check both sides of each rename/copy, including paths in merge parents.
  let touchedPaths;
  try {
    const tipDiff = diffPaths(worktreePath, ['diff', baseSha, headSha]);
    const history = diffPaths(worktreePath, ['log', '-m', '--format=', `${baseSha}..${headSha}`]);
    touchedPaths = new Set([...tipDiff, ...history].flatMap(entry => entry.paths));
  } catch (err) {
    return { ok: false, code: 'WORKTREE_PATH_SCAN_FAILED', message: err.message };
  }

  const protectedHits = findProtectedVaultPaths([...touchedPaths]);
  if (protectedHits.length > 0) {
    return {
      ok: false,
      code: 'PROTECTED_VAULT_WRITE',
      message: `Native delegation touched protected vault path(s): ${protectedHits.join(', ')}`,
      protectedPaths: protectedHits,
    };
  }

  if (gitWriteSubtree) {
    const cleanPrefix = String(gitWriteSubtree).replace(/^\/+|\/+$/g, '');
    for (const p of touchedPaths) {
      if (p !== cleanPrefix && !p.startsWith(`${cleanPrefix}/`)) {
        return {
          ok: false,
          code: 'SUBTREE_VIOLATION',
          message: `Native delegation modified "${p}" outside subdir subtree "${cleanPrefix}/"`,
        };
      }
    }
  }

  // 5. Check symmetric diff of pre-run vs post-run refs outside refs/heads/<subtaskBranch>
  // Catches unauthorized ref creations, mutations, AND deletions!
  if (preRefsSnapshot instanceof Map) {
    const allowedRef = `refs/heads/${subtaskBranch}`;
    const postRefs = snapshotGitRefs(projectDir);
    const allRefs = new Set([...preRefsSnapshot.keys(), ...postRefs.keys()]);
    for (const refName of allRefs) {
      if (refName === allowedRef) continue;
      const beforeSha = preRefsSnapshot.get(refName);
      const afterSha = postRefs.get(refName);
      if (beforeSha !== afterSha) {
        const verb = afterSha === undefined
          ? 'deleted'
          : (beforeSha === undefined ? 'created' : 'mutated');
        return {
          ok: false,
          code: 'UNAUTHORIZED_REF_MUTATION',
          message: `Native delegation ${verb} unauthorized ref "${refName}"`,
        };
      }
    }
  }

  return {
    ok: true,
    headSha,
    touchedPaths: [...touchedPaths].sort(),
  };
}
