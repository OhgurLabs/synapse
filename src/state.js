import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, renameSync, rmSync, watchFile, unwatchFile } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import config from './config.js';
import { createLogger } from './logger.js';
import { normalizeRosterSpec } from './roster.js';

const log = createLogger('state');

// Sanitize IDs to prevent path traversal — only allow alphanumeric, hyphens, underscores
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
// Cap for project-level systemInstructions — injected into every agent
// prompt's trusted region; unbounded text would bloat every dispatch.
const MAX_SYSTEM_INSTRUCTIONS_LENGTH = 4000;
export function validateId(id, label = 'ID') {
  if (!id || typeof id !== 'string' || !SAFE_ID_RE.test(id) || id.length > config.state.maxIdLength) {
    throw new Error(`Invalid ${label}: "${id}" — must be alphanumeric/hyphens/underscores, max ${config.state.maxIdLength} chars`);
  }
}

// Starter project id — created on a truly fresh install (zero projects) so the
// user has somewhere to land without having to create a project first. This is
// a regular project: user can rename it, reconfigure allocation, delete it,
// anything. If they delete it and subsequently delete every other project too,
// a restart will recreate `default` so the UI always has somewhere to render.
// See docs/init-wizard-design.md "Starter project" section.
export const DEFAULT_STARTER_PROJECT_ID = 'default';
export const DEFAULT_STARTER_CHANNEL = 'general';

// repoConfig — per-project repo behavior. See docs/repo-config.md.
//   mode: 'none'   — agents skip all git operations; no branches, no commits
//   mode: 'local'  — auto-init projectDir as git repo, branch per campaign,
//                    commit locally on subtask completion, no push
//   mode: 'github' — same as local + (when SYNAPSE_ENABLE_GITHUB_PUSH=true)
//                    push branches/tags to repoConfig.remote via `gh` CLI
// Defaults to 'local' so existing projects keep current behavior unchanged.
export const REPO_MODES = Object.freeze(['none', 'local', 'github']);
// AUTO_MERGE_POLICIES — what the auto-merge dispatcher does on `pr:approved`:
//   'operator'      — never auto-merge; operator merges via POST /api/.../merge (DEFAULT)
//   'external'      — Synapse reviews internally, but auto-merge never fires;
//                     an external system (CI bot / GitHub Action / human) calls
//                     the merge endpoint after their own review (R1-R2 refactor)
//   'n-approvals:1' — auto-merge after 1 reviewer approval against current source SHA
//   'n-approvals:2' — auto-merge after 2 distinct reviewer approvals
//   'never'         — auto-merge disabled regardless of approvals
export const AUTO_MERGE_POLICIES = Object.freeze(['operator', 'external', 'n-approvals:1', 'n-approvals:2', 'never']);
export function normalizeRepoConfig(input) {
  const c = input && typeof input === 'object' ? input : {};
  const mode = REPO_MODES.includes(c.mode) ? c.mode : 'local';
  const out = {
    mode,
    branch: typeof c.branch === 'string' && c.branch.trim() ? c.branch.trim() : 'main',
    autoInit: c.autoInit !== false, // default true
    // ─── PR workflow fields (Phase 1, BYOH PR plan) ──────────────────────
    // enforcePRForAllWrites: Universal-PR-gate invariant (Codex R1). When
    // true, EVERY code-mutating dispatch on this project (lifecycle + chat-
    // execute + future paths) must execute on a non-protected branch attached
    // to an open PR. Defaults false; explicitly enable per project that
    // needs the gate (the synapse project being the canonical case).
    enforcePRForAllWrites: c.enforcePRForAllWrites === true,
    // defaultBranch: the integration branch tasks branch FROM and PRs merge
    // INTO. Distinct from `branch` (the protected/live branch). E.g. for
    // the synapse project: branch='main' (protected, live deploy),
    // defaultBranch='beta' (PR target, agent work integrates here).
    defaultBranch: typeof c.defaultBranch === 'string' && c.defaultBranch.trim() ? c.defaultBranch.trim() : null,
    // liveDeploymentBranch: branch name PrStore.computeRequiresOperatorApproval
    // uses to auto-set requiresOperatorApproval=true. Default matches `branch`
    // (so the protected branch IS the live branch by default).
    liveDeploymentBranch: typeof c.liveDeploymentBranch === 'string' && c.liveDeploymentBranch.trim()
      ? c.liveDeploymentBranch.trim() : null,
    // autoMergePolicy: see AUTO_MERGE_POLICIES enum above for valid values.
    // requiresOperatorApproval=true PRs ignore this and always require
    // operator action (Grok R1). blockAutoMerge=true also overrides this.
    autoMergePolicy: AUTO_MERGE_POLICIES.includes(c.autoMergePolicy) ? c.autoMergePolicy : 'operator',
    // deleteBranchOnMerge: whether to `git branch -D <source>` after merge.
    // Default true to keep the branch namespace clean.
    deleteBranchOnMerge: c.deleteBranchOnMerge !== false,
    // ─── R1-R2 deliberation fields (PR-config refactor 2026-06-02) ────────
    // blockAutoMerge: defense-in-depth kill switch. When true, the merge
    // dispatcher refuses to auto-merge regardless of autoMergePolicy. Stacks
    // on top of policy. Set on self-modifying projects (synapse-on-synapse)
    // and any project where the operator wants an explicit hard-block.
    // Paired with requireOperatorApprovalAlways for dual-control depth
    // (reviewer R2: document at each call site so future editors don't
    // "simplify" by removing one).
    blockAutoMerge: c.blockAutoMerge === true,
    // requireOperatorApprovalAlways: replacement for the second hardcoded
    // synapse check at pr-store.js:210 (reviewer R1 catch). When true,
    // computeRequiresOperatorApproval returns true for every PR opened on
    // this project, forcing operator-only merges regardless of policy.
    requireOperatorApprovalAlways: c.requireOperatorApprovalAlways === true,
    // selfModifying: documentation/audit field marking projects whose
    // workingDir IS the running synapse source tree (synapse-on-synapse).
    // Set explicitly at project init by the operator/bootstrap script
    // (R1-R2 dropped runtime cwd auto-detection — 4 of 5 reviewers flagged
    // it as fragile in systemd/symlink/chroot/container contexts).
    // Currently this is a documentation field; future UI/logging consumers
    // can read it for operator visibility (alice R2 non-blocker note).
    selfModifying: c.selfModifying === true,
  };
  if (mode === 'github') {
    // remote is required for github mode; if missing, runtime will downgrade
    // to local with a warning. We persist whatever the operator entered so the
    // UI can show it next time.
    out.remote = typeof c.remote === 'string' ? c.remote.trim() : '';
  }
  return out;
}
export function repoConfigOrDefault(cfg) {
  // Read-time defaulter for projects persisted before repoConfig existed.
  return normalizeRepoConfig(cfg && cfg.repoConfig);
}

// ─── contextConfig — per-project context assembly ────────────────────────
//
//   memory — the auto-distilled per-agent memories injected by context.js
//   resume — continuing a harness session within a task series
//
//   vault  — whether this project's agents may read a knowledge vault
//
// vault BELONGS HERE, and an earlier revision of this comment argued it did
// not. That argument was wrong and is recorded because the reasoning matters:
// it claimed vault access is "just a tool permission", i.e. expressible via
// agents.json `agent.tools: { allow?, deny? }`. It is not. Tool permissions
// govern WHICH TOOLS an agent holds, not WHICH ROOTS a server exposes -- a
// filesystem MCP server hands every one of its roots to anyone holding its
// tools, so denying tools is all-or-nothing across workspace/ AND the vault.
// There is no way to express "this project may read the vault" in that model.
//
// Nor can it live at invocation time today: invokeTool()'s context carries
// campaignId/taskId/subtaskId/dispatchId/traceId but no projectId, and
// api.js:4474 invokes with no context at all.
//
// DECLARED, NOT INFERRED. The first attempt (reverted in 8e752699) derived
// access from whether a vault directory happened to exist on disk. That is
// wrong independently of scoping: it makes a security-relevant grant implicit,
// silent and unauditable, and an operator who enables the vault for a project
// with no vault/ directory deserves to be told, not silently given nothing.
//
// NOT YET ENFORCED. Nothing reads this field, exactly as nothing yet reads
// memory or resume -- this is the declaration layer landing ahead of its
// consumers on purpose. Enforcement needs per-project root scoping, which
// needs either projectId plumbed through invokeTool or per-project MCP server
// instances (McpConnectionManager is a single global built at boot,
// orchestrator.js:184). Until that exists the honest state is no vault access
// at all, because ONE GLOBAL MOUNT IS WORSE THAN NONE: it handed the
// orchestrator's own vault to agents working on unrelated projects.
//
// Shaped after repoConfig deliberately: same read-time defaulting, same
// tolerance for absent/garbage input, so projects persisted before this
// existed keep working with no data migration.
//
// DEFAULT DIRECTIONS ARE NOT ARBITRARY:
//   vault  defaults ON  — read-only, costs no prompt budget and no disk.
//   memory defaults ON  — this is today's behaviour; flipping it off by
//                         default would silently change every project.
//   resume defaults OFF — opt-in per project. Harness session stores are
//                         already 730MB (.claude) and 347MB (.codex, 923 files
//                         retained since 2025-12) on this host, with single
//                         sessions reaching 227MB and no pruning anywhere.
//                         Defaulting it on would start that growth for every
//                         project without anyone choosing it.
// Hence `!== false` for the two opt-out flags and `=== true` for the opt-in
// one, matching how repoConfig distinguishes autoInit from
// enforcePRForAllWrites.
const RESUME_MAX_AGE_HOURS_DEFAULT = 24;
const RESUME_MAX_AGE_HOURS_MAX = 24 * 30;
const MEMORY_BUDGET_DEFAULT = 1000;
const MEMORY_BUDGET_MAX = 20000;

export function normalizeContextConfig(input) {
  const c = input && typeof input === 'object' ? input : {};
  // OWN properties only. Reached via Object.create(), a plain `c.resume` read
  // walks the prototype chain, so an inherited resume:{enabled:true} would
  // silently switch on the one layer deliberately defaulted OFF for disk
  // reasons. The realistic input paths (JSON.parse of the project config, or
  // of a request body) cannot produce that -- JSON's "__proto__" arrives as an
  // ordinary own key -- but the guard costs nothing and the failure would be
  // invisible.
  const own = (k) => (Object.hasOwn(c, k) && c[k] && typeof c[k] === 'object' ? c[k] : {});
  const vault = own('vault');
  const memory = own('memory');
  const resume = own('resume');

  // budgetChars is a NUMBER rather than a bare toggle because the value
  // already exists (config.embeddings.memoryBudget || 1000) — exposing it
  // per project costs nothing and avoids a second global-only knob.
  // Clamped: a non-finite or negative budget would silently truncate every
  // injection to nothing, which is indistinguishable from memory being off.
  let resumeAgeHours = Number(resume.maxAgeHours);
  if (!Number.isFinite(resumeAgeHours) || resumeAgeHours < 0) resumeAgeHours = RESUME_MAX_AGE_HOURS_DEFAULT;
  resumeAgeHours = Math.min(resumeAgeHours, RESUME_MAX_AGE_HOURS_MAX);

  let budgetChars = Number(memory.budgetChars);
  if (!Number.isFinite(budgetChars) || budgetChars < 0) budgetChars = MEMORY_BUDGET_DEFAULT;
  budgetChars = Math.min(Math.floor(budgetChars), MEMORY_BUDGET_MAX);

  // vault.path is relative to the project directory. Reject absolute paths and
  // `..` segments so a malicious/mistyped path cannot walk outside the project
  // once enforcement starts resolving it. Null means "the project's own vault".
  let vaultPath = null;
  if (typeof vault.path === 'string') {
    const trimmed = vault.path.trim();
    if (trimmed) {
      const normalized = trimmed.replace(/\\/g, '/');
      const absolute = normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
      const hasDotDot = normalized.split('/').some((seg) => seg === '..');
      // Control characters are rejected for a DIFFERENT reason than the two
      // checks above, and the traversal guard does not imply this one.
      //
      // This value is not currently resolved as a path at all — its only
      // consumer is orchestrator/context.js, which interpolates it verbatim
      // into an agent's system prompt ("Knowledge vault: <path> ..."). A value
      // carrying newlines therefore escapes its line and injects arbitrary
      // instructions into every dispatch for that project. Measured: with only
      // the traversal checks, "vault\n\nIGNORE ALL PREVIOUS INSTRUCTIONS..."
      // was accepted and stored intact.
      //
      // The setter is operator-gated, but driving Synapse config through the
      // API is a supported path, so the attacker need not be a human at a
      // terminal — and the injected text lands in OTHER agents' prompts.
      // No legitimate filesystem path contains a control character.
      const hasControlChars = /[\u0000-\u001F\u007F]/.test(trimmed);
      if (!absolute && !hasDotDot && !hasControlChars) {
        vaultPath = trimmed;
      } else {
        log.warn('contextConfig.vault.path rejected (must be project-relative, no .., no control characters)', {
          path: trimmed.slice(0, 200),
        });
      }
    }
  }

  return {
    // OPT-IN, unlike memory. An operator turning this on is granting agents
    // read access to a knowledge store, so it should be a deliberate act
    // rather than something a project acquires by default. `path` is optional
    // and relative to the project; null means "the project's own vault", which
    // is what enforcement should default to -- knowledge scoped to the project
    // it is about, not the orchestrator's own vault handed to everyone.
    vault: {
      enabled: vault.enabled === true,
      path: vaultPath,
    },
    memory: { enabled: memory.enabled !== false, budgetChars },
    // maxAgeHours bounds how stale a session may be before a resume is refused.
    // Uses lastDispatch.at, which is already recorded, so it needs no filesystem
    // access and works for every harness regardless of where it stores sessions.
    // 24h default: a task series idle longer than that has almost certainly had
    // its working tree move underneath it, and harness stores prune on their own
    // schedules. 0 disables resume by age entirely; the clamp stops a negative or
    // NaN value from silently meaning "never expire".
    resume: { enabled: resume.enabled === true, maxAgeHours: resumeAgeHours },
  };
}

export function contextConfigOrDefault(cfg) {
  // Read-time defaulter for projects persisted before contextConfig existed.
  return normalizeContextConfig(cfg && cfg.contextConfig);
}

export class StateManager {
  // Static method to expose the logger for testing
  static getLog() {
    return log;  
  }
  
  constructor(baseDir) {
    this.rootDir = baseDir;
    this.baseDir = join(baseDir, '.synapse');
    this.configPath = join(this.baseDir, 'config.json');
    this.projectsDir = join(this.baseDir, 'projects');
    this.config = { version: 1, defaultProject: null, agents: [] };
    this.projects = new Map();
  }

  init() {
    mkdirSync(this.projectsDir, { recursive: true });

    // Load global config
    if (existsSync(this.configPath)) {
      this.config = JSON.parse(readFileSync(this.configPath, 'utf-8'));
    } else {
      this._saveConfig();
    }

    // Load all projects. The underscore-prefix filter skips state files (sqlite
    // journals, agent-cooldowns.json, etc.) that share the projects directory.
    if (existsSync(this.projectsDir)) {
      for (const dir of readdirSync(this.projectsDir, { withFileTypes: true })) {
        if (dir.isDirectory() && !dir.name.startsWith('.') && !dir.name.startsWith('_')) this._loadProject(dir.name);
      }
    }

    // Ensure the user has somewhere to land. On a fresh install or after the
    // user deletes every project, create a starter project called `default`.
    // This is a regular project — user can rename, reconfigure, or delete it.
    this._ensureDefaultStarterProject();

    // Validate projectDir exists on disk for each project (skipped when the
    // project's repoConfig is set to mode='none' — those projects don't touch
    // the filesystem at projectDir at all).
    for (const [id, cfg] of this.projects) {
      const mode = (cfg.repoConfig && cfg.repoConfig.mode) || 'local';
      if (mode === 'none') continue;
      if (cfg.projectDir && !existsSync(cfg.projectDir)) {
        log.error(`FATAL: project "${id}" has projectDir "${cfg.projectDir}" which does not exist on disk. Fix .synapse/projects/${id}/config.json`);
        process.exit(1);
      }
    }

    return this;
  }

  /**
   * Ensure the user has somewhere to land on a fresh install: a SEALED
   * `default` project that is an init/onboarding chat surface only — no
   * working directory, no allocation, cannot host campaigns/tasks or agent
   * dispatch. Work always happens in an explicitly named, contained project;
   * `default` exists so the UI has somewhere to render and the user has
   * somewhere to chat before they create their first real project.
   *
   * If the user deletes every project and restarts, this recreates the
   * sealed `default` so the UI always has a landing surface.
   */
  _ensureDefaultStarterProject() {
    if (this.projects.size > 0) return; // User already has at least one project

    const id = DEFAULT_STARTER_PROJECT_ID;
    log.info('No projects found on startup — creating sealed default chat surface', { id });
    this.createProject(id, {
      displayName: 'Default',
      channels: [DEFAULT_STARTER_CHANNEL],
      sealed: true,
    });
  }

  /**
   * A project is "workable" — can host campaigns/tasks/agent dispatch — only
   * if it is not sealed and has a contained working directory. The sealed
   * `default` chat surface is never workable. Single source of truth for the
   * work-creation gate.
   */
  isProjectWorkable(id) {
    const cfg = this.projects.get(id);
    if (!cfg) return false;
    if (cfg.sealed === true) return false;
    if (!cfg.projectDir) return false;
    return true;
  }

  watchProjects(onChange) {
    if (!existsSync(this.projectsDir)) return { stop: () => {} };
    const debounce = new Map();
    const DEBOUNCE_MS = 300;

    for (const entry of readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      this._watchProjectDir(entry.name, onChange, debounce, DEBOUNCE_MS);
    }

    import('chokidar').then((chokidar) => {
      const watcher = chokidar.watch(this.projectsDir, {
        ignoreInitial: true,
        depth: 1,
        awaitWriteFinish: { stabilityThreshold: 200 },
      });
      watcher.on('addDir', (dirPath) => {
        const rel = dirPath.replace(this.projectsDir + '/', '').split('/')[0];
        if (!rel || rel.startsWith('.') || rel.startsWith('_')) return;
        const cfgPath = join(this.projectsDir, rel, 'config.json');
        if (!existsSync(cfgPath)) return;
        if (!this.projects.has(rel)) {
          this._loadProject(rel);
          log.info(`[watcher] Auto-loaded project: ${rel}`);
          if (onChange) onChange(rel, 'created');
        }
      });
    }).catch(() => {
      log.info('[watcher] chokidar not available, using polling');
    });

    return { stop: () => {} };
  }

  _watchProjectDir(id, onChange, debounce, ms) {
    const cfgPath = join(this.projectsDir, id, 'config.json');
    if (!existsSync(cfgPath)) return;
    watchFile(cfgPath, { interval: ms }, () => {
      const last = debounce.get(id);
      if (last) clearTimeout(last);
      debounce.set(id, setTimeout(() => {
        debounce.delete(id);
        try {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          try { cfg.agents = normalizeRosterSpec(cfg.agents); } catch { cfg.agents = null; }
          const prev = this.projects.get(id);
          if (!prev) {
            this.projects.set(id, cfg);
            log.info(`[watcher] Auto-loaded project: ${id}`);
            if (onChange) onChange(id, 'created');
          } else if (JSON.stringify(prev) !== JSON.stringify(cfg)) {
            this.projects.set(id, cfg);
            log.info(`[watcher] Project config changed: ${id}`);
            if (onChange) onChange(id, 'updated');
          }
        } catch { /* ignore parse errors during write */ }
      }, ms));
    });
  }

  _saveConfig() {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n');
  }

  _loadProject(id) {
    const projDir = join(this.projectsDir, id);
    const cfgPath = join(projDir, 'config.json');
    if (!existsSync(cfgPath)) return;

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));

    // ─── R2 Change 5: idempotent migration for the synapse project ─────────
    // The R1 hardcoded `projectId === 'synapse'` checks at two sites were
    // replaced by per-project config flags (blockAutoMerge,
    // requireOperatorApprovalAlways). The production synapse project's
    // config.json predates these fields and has no repoConfig at all
    // (code-verified in R1: `"repoConfig": NOT SET`). Without this
    // migration, the safety net disappears on first load after the
    // refactor ships. Migration is one-shot + idempotent: it only writes
    // when the flags are unset, so subsequent loads are no-ops.
    //
    // Why keyed on id==='synapse' here: this is the ONLY hardcoded reference
    // remaining, and only as a one-shot bootstrap trigger — it does no
    // policy work at runtime (alice R2 acknowledged this is acceptable).
    if (id === 'synapse') {
      const needsMigration =
        !cfg.repoConfig ||
        cfg.repoConfig.blockAutoMerge === undefined ||
        cfg.repoConfig.requireOperatorApprovalAlways === undefined;
      if (needsMigration) {
        cfg.repoConfig = {
          ...(cfg.repoConfig || {}),
          blockAutoMerge: true,
          requireOperatorApprovalAlways: true,
          selfModifying: true,
        };
        // Normalize through the standard path so all PR-workflow defaults apply.
        cfg.repoConfig = normalizeRepoConfig(cfg.repoConfig);
        // Persist the migration so it doesn't repeat on next load.
        try {
          writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        } catch (err) {
          // Soft-fail: if write fails, the in-memory value is still set for
          // this run. Next load will retry the migration.
          // (Operator can re-run after fixing permissions.)
        }
      }
    }

    // Roster migration: legacy `agents: ['id', ...]` arrays become the
    // canonical RosterSpec shape ({ agents, classes, roles }). Malformed
    // rosters degrade to null (= all agents) rather than blocking the load.
    try { cfg.agents = normalizeRosterSpec(cfg.agents); } catch { cfg.agents = null; }

    this.projects.set(id, cfg);
    return cfg;
  }

  _saveProjectConfig(id) {
    const projDir = join(this.projectsDir, id);
    const cfg = this.projects.get(id);
    if (!cfg) return;
    writeFileSync(join(projDir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  }

  // --- Projects ---

  createProject(id, { displayName, projectDir, channels = ['general'], mode, repoConfig, sealed = false, firstBuildHold = false, agents = null } = {}) {
    validateId(id, 'project ID');
    for (const ch of channels) validateId(ch, 'channel ID');
    const projDir = join(this.projectsDir, id);
    mkdirSync(projDir, { recursive: true });
    mkdirSync(join(projDir, 'channels'), { recursive: true });

    // A sealed project is an init/chat surface only (this is what `default`
    // is): no working directory, no allocation, cannot host campaigns/tasks
    // or agent dispatch. A normal project ALWAYS gets a contained working dir
    // under <rootDir>/workspace/<id> — a sibling of `.synapse/` that can never
    // contain it, so agent file ops physically cannot reach the control plane
    // via relative paths. We never fall back to process.cwd(): that (projectDir
    // == parent of .synapse/) was the Iter4 self-destruct root cause.
    let resolvedProjectDir = null;
    if (!sealed) {
      resolvedProjectDir = projectDir || join(this.rootDir, 'workspace', id);
      mkdirSync(resolvedProjectDir, { recursive: true });
    }

    const cfg = {
      name: id,
      displayName: displayName || id,
      projectDir: resolvedProjectDir,
      sealed,
      channels,
      defaultChannel: channels[0] || 'general',
      allocation: sealed ? 0 : 100,
      mode: (mode === 'continuous' || mode === 'oneshot') ? mode : 'static',
      // Wizard-created starter projects: when the FIRST campaign completes,
      // the strategist flips the project to static and tells the user where
      // to review the result, instead of silently rolling into perpetual
      // improvement. Build first, then ask.
      firstBuildHold: firstBuildHold === true,
      repoConfig: normalizeRepoConfig(repoConfig),
      // Roster set AT CREATION, atomically (operator ruling 2026-08-01): a
      // project created roster-less defaults to ALL agents, and any idle
      // agent can legally claim its work in the window before a later
      // PATCH pins it. null = explicitly all agents.
      agents: normalizeRosterSpec(agents), // throws on malformed input
    };

    this.projects.set(id, cfg);
    this._saveProjectConfig(id);

    // Create channel dirs
    for (const ch of channels) {
      this._ensureChannelDir(id, ch);
    }

    if (!this.config.defaultProject) {
      this.config.defaultProject = id;
      this._saveConfig();
    }

    return cfg;
  }

  getProject(id) {
    return this.projects.get(id) || null;
  }

  setProjectVision(id, vision, { source = 'user', campaignId = null } = {}) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    const previous = cfg.vision || null;
    cfg.vision = vision;
    // Append to vision history
    if (!cfg.visionHistory) cfg.visionHistory = [];
    cfg.visionHistory.push({
      vision,
      previous,
      source,       // 'user' | 'closeout'
      campaignId,   // which campaign triggered this (if closeout)
      timestamp: new Date().toISOString(),
    });
    this._saveProjectConfig(id);
    return cfg;
  }

  getProjectVision(id) {
    const cfg = this.projects.get(id);
    return cfg?.vision || null;
  }

  getProjectVisionHistory(id) {
    const cfg = this.projects.get(id);
    return cfg?.visionHistory || [];
  }

  /**
   * Switch a project between 'static' (campaigns are created manually),
   * 'continuous' (the strategist generates campaigns from the vision), and
   * 'oneshot' (the vision is dispatched VERBATIM to a single agent — no
   * decomposition, no prompt wrapping, no review; A/B parity mode).
   * Until this existed there was NO way to flip an existing project — a
   * project created static with a vision sat inert forever.
   */
  setProjectMode(id, mode) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    if (mode !== 'static' && mode !== 'continuous' && mode !== 'oneshot') {
      throw new Error(`mode must be 'static', 'continuous', or 'oneshot', got "${mode}"`);
    }
    cfg.mode = mode;
    this._saveProjectConfig(id);
    return cfg;
  }

  /**
   * Pin a project's agent roster. Accepts null (= all agents, the default),
   * a legacy array of agent ids, or a full RosterSpec object:
   *   { agents: ['alice'], classes: ['opus-5', 'gpt-5.6-sol'],
   *     roles: { reviewer: { classes: ['opus-5'] } } }
   * agents+classes union at the top level; a roles entry REPLACES the
   * top-level spec for that role. Stored normalized (see src/roster.js).
   * This is the lever for "this project is all opus-5", multi-class
   * showdowns, and tier-per-role setups ("opus reviews what sol builds").
   */
  setProjectAgents(id, rosterInput) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    cfg.agents = normalizeRosterSpec(rosterInput); // throws on malformed input
    this._saveProjectConfig(id);
    return cfg;
  }

  setProjectFirstBuildHold(id, val) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    cfg.firstBuildHold = val === true;
    this._saveProjectConfig(id);
    return cfg;
  }

  setProjectAllocation(id, pct) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    // Number.isFinite, not typeof: NaN is typeof 'number' and slips past both
    // range comparisons (and JSON null arrives as Number(null) === 0 upstream,
    // so a blank UI field must be rejected before it zeroes a project).
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error(`allocation must be a finite number 0–100, got ${pct}`);
    }
    cfg.allocation = pct;
    this._saveProjectConfig(id);
    return cfg;
  }

  /**
   * Update the per-project repo behavior. Accepts a partial repoConfig; missing
   * fields are filled from the normalizer's defaults. Throws on unknown mode.
   */
  setProjectRepoConfig(id, patch) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    if (patch && patch.mode && !REPO_MODES.includes(patch.mode)) {
      throw new Error(`repoConfig.mode must be one of ${REPO_MODES.join(', ')} — got "${patch.mode}"`);
    }
    cfg.repoConfig = normalizeRepoConfig({ ...(cfg.repoConfig || {}), ...(patch || {}) });
    this._saveProjectConfig(id);
    return cfg.repoConfig;
  }

  getProjectRepoConfig(id) {
    const cfg = this.projects.get(id);
    if (!cfg) return null;
    return repoConfigOrDefault(cfg);
  }

  // Mirrors setProjectRepoConfig: shallow-merge the patch over what is stored,
  // normalise the result, persist.
  //
  // Merged rather than replaced so a caller can flip one flag without having to
  // resend the whole block — a PATCH that sent only { vault: { enabled: true } }
  // and replaced would silently reset memory.budgetChars to the default.
  //
  // The merge is one level deep on purpose: `{ vault: {...} }` replaces the
  // whole vault object rather than merging into it, which matches how
  // normalizeContextConfig reads each sub-object as a unit. Sending
  // { vault: { path: 'x' } } therefore clears `enabled` back to its opt-in
  // default rather than leaving a half-specified grant standing.
  setProjectContextConfig(id, patch) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    cfg.contextConfig = normalizeContextConfig({ ...(cfg.contextConfig || {}), ...(patch || {}) });
    this._saveProjectConfig(id);
    return cfg.contextConfig;
  }

  /**
   * Project-level system instructions, injected into EVERY agent prompt on
   * this project (context.js agentSystemPrompt). The field was readable but
   * had no writer — settable only by hand-editing config.json. Empty/null
   * clears. Capped: the value lands in the TRUSTED region of the prompt, so
   * an unbounded blob would bloat every dispatch on the project.
   */
  setProjectSystemInstructions(id, text) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    if (text === null || text === undefined || String(text).trim() === '') {
      delete cfg.systemInstructions;
    } else {
      if (typeof text !== 'string') throw new Error('systemInstructions must be a string');
      const trimmed = text.trim();
      if (trimmed.length > MAX_SYSTEM_INSTRUCTIONS_LENGTH) {
        throw new Error(`systemInstructions too long: ${trimmed.length} > ${MAX_SYSTEM_INSTRUCTIONS_LENGTH} chars`);
      }
      cfg.systemInstructions = trimmed;
    }
    this._saveProjectConfig(id);
    return cfg.systemInstructions ?? null;
  }

  /**
   * Set the per-project agent priority (vault/design/project-agent-priority.md,
   * #105). Shape: { ranks: [agentId, ...], strict: boolean }. Roster answers
   * who MAY work here; ranks answer in what ORDER; strict collapses routing
   * to the single highest-ranked eligible agent. Absent ⇒ legacy behavior.
   * null/undefined clears. Ranks may be a partial list of the roster —
   * unranked agents sort after ranked ones in legacy default order.
   * Roster validation happens at the API layer (the roster spec lives on the
   * project and may be null = all agents).
   */
  _validateAgentPriority(priority) {
    if (typeof priority !== 'object' || Array.isArray(priority)) {
      throw new Error('agentPriority must be an object { ranks, strict }');
    }
    const ranks = priority.ranks;
    if (!Array.isArray(ranks) || ranks.length === 0) {
      throw new Error('agentPriority.ranks must be a non-empty array of agent ids');
    }
    if (ranks.length > 100) throw new Error('agentPriority.ranks too long');
    const seen = new Set();
    for (const r of ranks) {
      if (typeof r !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(r) || r.length > 100) {
        throw new Error(`agentPriority.ranks contains an invalid agent id: ${String(r).slice(0, 80)}`);
      }
      if (seen.has(r)) throw new Error(`agentPriority.ranks contains a duplicate: ${r}`);
      seen.add(r);
    }
    return { ranks: [...ranks], strict: priority.strict === true };
  }

  setProjectAgentPriority(id, priority) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    if (priority === null || priority === undefined) {
      delete cfg.agentPriority;
    } else {
      cfg.agentPriority = this._validateAgentPriority(priority);
    }
    this._saveProjectConfig(id);
    return cfg.agentPriority ?? null;
  }

  /**
   * Per-project review fallback (operator ruling 2026-08-15): developers are
   * workers and never review — UNLESS the operator opts this project in, in
   * which case a developer may take a review only when no reviewer/architect
   * is available. Default false. null/undefined clears (⇒ false).
   */
  setProjectReviewDeveloperFallback(id, enabled) {
    const cfg = this.projects.get(id);
    if (!cfg) throw new Error(`Project not found: ${id}`);
    if (enabled === null || enabled === undefined) {
      delete cfg.reviewDeveloperFallback;
    } else {
      if (typeof enabled !== 'boolean') throw new Error('reviewDeveloperFallback must be a boolean');
      cfg.reviewDeveloperFallback = enabled;
    }
    this._saveProjectConfig(id);
    return cfg.reviewDeveloperFallback === true;
  }

  getProjectReviewDeveloperFallback(id) {
    const cfg = this.projects.get(id);
    return cfg?.reviewDeveloperFallback === true;
  }

  /**
   * GLOBAL default priority (operator: "set a one-time rank order in general
   * settings and call it a day"). Lives in the global .synapse/config.json.
   * Per-project priority overrides it — see getEffectiveAgentPriority.
   */
  setGlobalAgentPriority(priority) {
    if (priority === null || priority === undefined) {
      delete this.config.agentPriority;
    } else {
      this.config.agentPriority = this._validateAgentPriority(priority);
    }
    this._saveConfig();
    return this.config.agentPriority ?? null;
  }

  getGlobalAgentPriority() {
    const p = this.config?.agentPriority;
    if (!p || !Array.isArray(p.ranks) || p.ranks.length === 0) return null;
    return { ranks: [...p.ranks], strict: p.strict === true };
  }

  /**
   * The priority routing actually uses: project override > global default >
   * null (legacy behavior). Routing sites take this resolved value verbatim.
   */
  getEffectiveAgentPriority(projectId) {
    return this.getProjectAgentPriority(projectId) ?? this.getGlobalAgentPriority();
  }

  /** Normalised read — see getProjectContextConfig's note on raw reads. */
  getProjectAgentPriority(id) {
    const cfg = this.projects.get(id);
    if (!cfg) return null;
    const p = cfg.agentPriority;
    if (!p || !Array.isArray(p.ranks) || p.ranks.length === 0) return null;
    return { ranks: [...p.ranks], strict: p.strict === true };
  }

  // Always normalised, never the raw field.
  //
  // Callers must use this rather than reading project.contextConfig directly:
  // every project persisted before this existed has no such field, so a raw
  // read yields undefined and every layer reads as disabled. That is not a
  // hypothetical -- see the note on listProjects() below, where exactly this
  // shape ("read p.agents off listProjects(), always undefined") silently
  // disabled roster filtering on task pickup.
  getProjectContextConfig(id) {
    const cfg = this.projects.get(id);
    if (!cfg) return null;
    return contextConfigOrDefault(cfg);
  }

  listProjects() {
    return Array.from(this.projects.entries()).map(([id, cfg]) => ({
      id,
      displayName: cfg.displayName,
      sealed: cfg.sealed === true,
      channels: cfg.channels,
      projectDir: cfg.projectDir,
      allocation: cfg.allocation ?? 100,
      mode: cfg.mode || 'static',
      // #105: normalised (null unless a valid override is set) so the
      // settings UI can render the per-project priority editor.
      agentPriority: (cfg.agentPriority && Array.isArray(cfg.agentPriority.ranks) && cfg.agentPriority.ranks.length > 0)
        ? { ranks: [...cfg.agentPriority.ranks], strict: cfg.agentPriority.strict === true }
        : null,
      // Operator ruling 2026-08-15: developers never review unless this project opts in.
      reviewDeveloperFallback: cfg.reviewDeveloperFallback === true,
      repoConfig: repoConfigOrDefault(cfg),
      // Normalised here for the same reason repoConfig is: anything reading
      // this off listProjects() must see real booleans, not undefined.
      contextConfig: contextConfigOrDefault(cfg),
      vision: cfg.vision || null,
      // RosterSpec or null. Exposing this here fixed two silent bugs: the
      // task-pickup filter read p.agents off listProjects() (always
      // undefined → roster never filtered pickup), and the UI pin control
      // lost its state on every reload for the same reason.
      agents: cfg.agents || null,
    }));
  }

  // --- Channels ---

  _ensureChannelDir(projectId, channelId) {
    validateId(projectId, 'project ID');
    validateId(channelId, 'channel ID');
    const dir = join(this.projectsDir, projectId, 'channels', channelId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  _transcriptPath(projectId, channelId) {
    return join(this.projectsDir, projectId, 'channels', channelId, 'transcript.jsonl');
  }

  createChannel(projectId, channelId) {
    validateId(channelId, 'channel ID');
    const proj = this.projects.get(projectId);
    if (!proj) throw new Error(`Project "${projectId}" not found`);
    if (proj.channels.includes(channelId)) return;

    proj.channels.push(channelId);
    this._saveProjectConfig(projectId);
    this._ensureChannelDir(projectId, channelId);
  }

  deleteChannel(projectId, channelId) {
    const proj = this.projects.get(projectId);
    if (!proj) throw new Error(`Project "${projectId}" not found`);
    const idx = proj.channels.indexOf(channelId);
    if (idx < 0) return false;

    proj.channels.splice(idx, 1);
    this._saveProjectConfig(projectId);

    // Remove channel data from disk
    const chanDir = join(this.projectsDir, projectId, 'channels', channelId);
    if (existsSync(chanDir)) {
      rmSync(chanDir, { recursive: true, force: true });
    }
    return true;
  }

  getChannel(projectId, channelId) {
    const proj = this.projects.get(projectId);
    if (!proj || !proj.channels.includes(channelId)) return null;
    return { projectId, channelId, projectDir: proj.projectDir };
  }

  listChannels(projectId) {
    const proj = this.projects.get(projectId);
    return proj ? proj.channels : [];
  }

  // --- User-scoped directories ---

  _userDir(projectId, userId) {
    return join(this.projectsDir, projectId, 'users', userId);
  }

  _ensureUserDir(projectId, userId) {
    validateId(projectId, 'project ID');
    validateId(userId, 'user ID');
    const dir = this._userDir(projectId, userId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  _userActiveThreadsPath(projectId, userId) {
    return join(this._userDir(projectId, userId), 'active-threads.json');
  }

  // --- Messages ---

  addMessage(projectId, channelId, { type = 'message', speaker, content, model, threadId, replyTo, fallback, fallbackFrom, userId }) {
    const msg = {
      type,
      speaker,
      content,
      timestamp: new Date().toISOString(),
      project: projectId,
      channel: channelId,
      id: `msg_${Date.now()}_${randomUUID().slice(0, 8)}_${speaker.toLowerCase().replace(/\s/g, '')}`,
    };
    if (userId) msg.userId = userId;
    if (model) msg.model = model;
    if (threadId) msg.threadId = threadId;
    if (replyTo) msg.replyTo = replyTo;
    if (fallback) { msg.fallback = true; msg.fallbackFrom = fallbackFrom; }

    this._ensureChannelDir(projectId, channelId);
    appendFileSync(this._transcriptPath(projectId, channelId), JSON.stringify(msg) + '\n');
    return msg;
  }

  getMessages(projectId, channelId, limit = config.state.defaultMessageLimit) {
    const path = this._transcriptPath(projectId, channelId);
    if (!existsSync(path)) return [];

    const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
    const msgs = [];
    let corruptCount = 0;
    for (const line of lines) {
      try { msgs.push(JSON.parse(line)); } catch { corruptCount++; }
    }
    if (corruptCount > 0) {
      log.warn('Skipped corrupt JSONL lines', { path, count: corruptCount });
    }
    return msgs.slice(-limit);
  }

  getMessageCount(projectId, channelId) {
    const path = this._transcriptPath(projectId, channelId);
    if (!existsSync(path)) return 0;
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return 0;
    return content.split('\n').filter(Boolean).length;
  }

  getThreadMessages(projectId, channelId, threadId, limit = config.state.defaultThreadLimit) {
    const all = this.getMessages(projectId, channelId, 9999);
    const filtered = all.filter(m => m.threadId === threadId);
    return filtered.slice(-limit);
  }

  getThreadMessageCount(projectId, channelId, threadId) {
    const all = this.getMessages(projectId, channelId, 9999);
    return all.filter(m => m.threadId === threadId).length;
  }

  // --- Thread Metadata ---

  _threadsPath(projectId) {
    return join(this.projectsDir, projectId, 'threads.json');
  }

  loadThreads(projectId) {
    const path = this._threadsPath(projectId);
    if (!existsSync(path)) return { threads: {}, channelActiveThread: {} };
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch (err) { log.warn('Corrupt JSON file, using defaults', { path, error: err.message }); return { threads: {}, channelActiveThread: {} }; }
  }

  saveThreads(projectId, data) {
    const path = this._threadsPath(projectId);
    const tmp = path + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
  }

  createThread(projectId, { id, label, channel, userId }) {
    const data = this.loadThreads(projectId);
    data.threads[id] = {
      id,
      label,
      channel,
      createdBy: userId || null,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      status: 'active',
      messageCount: 0,
      participants: [],
      keywords: [],
    };
    this.saveThreads(projectId, data);
    return data.threads[id];
  }

  updateThread(projectId, threadId, updates) {
    const data = this.loadThreads(projectId);
    const thread = data.threads[threadId];
    if (!thread) return null;
    Object.assign(thread, updates, { lastActivity: new Date().toISOString() });
    this.saveThreads(projectId, data);
    return thread;
  }

  getActiveThreads(projectId, channelId) {
    const data = this.loadThreads(projectId);
    return Object.values(data.threads).filter(t => t.channel === channelId && t.status === 'active');
  }

  getThread(projectId, threadId) {
    const data = this.loadThreads(projectId);
    return data.threads[threadId] || null;
  }

  setChannelActiveThread(projectId, channelId, threadId, userId = 'default') {
    validateId(userId, 'user ID');
    this._ensureUserDir(projectId, userId);
    const path = this._userActiveThreadsPath(projectId, userId);
    let data = {};
    if (existsSync(path)) {
      try { data = JSON.parse(readFileSync(path, 'utf-8')); } catch (err) { log.warn('Corrupt JSON file, using defaults', { path, error: err.message }); data = {}; }
    }
    data[channelId] = threadId;
    const tmp = path + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
  }

  getChannelActiveThread(projectId, channelId, userId = 'default') {
    validateId(userId, 'user ID');
    // Read from user-scoped file
    const path = this._userActiveThreadsPath(projectId, userId);
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        return data[channelId] || null;
      } catch (err) { log.warn('Corrupt JSON file, using defaults', { path, error: err.message }); /* fall through */ }
    }
    // Backward compat: fall back to legacy threads.json channelActiveThread for default user
    if (userId === 'default') {
      const data = this.loadThreads(projectId);
      return data.channelActiveThread?.[channelId] || null;
    }
    return null;
  }

  // --- User State ---

  getUserState(projectId, userId) {
    validateId(userId, 'user ID');
    const dir = this._userDir(projectId, userId);
    const path = join(dir, 'state.json');
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch (err) { log.warn('Corrupt JSON file, using defaults', { path, error: err.message }); return {}; }
  }

  saveUserState(projectId, userId, data) {
    validateId(userId, 'user ID');
    this._ensureUserDir(projectId, userId);
    const path = join(this._userDir(projectId, userId), 'state.json');
    const tmp = path + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
  }

  listUsers(projectId) {
    const usersDir = join(this.projectsDir, projectId, 'users');
    if (!existsSync(usersDir)) return [];
    return readdirSync(usersDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  }

  // --- Cross-reference ---

  getChannelSummary(projectId, channelId, limit = 10) {
    return this.getMessages(projectId, channelId, limit);
  }

  // --- Cross-session context ---

  _contextPath(projectId) {
    return join(this.projectsDir, projectId, 'context.md');
  }

  getProjectContext(projectId) {
    const path = this._contextPath(projectId);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  saveProjectContext(projectId, content) {
    const path = this._contextPath(projectId);
    writeFileSync(path, content);
  }

  /**
   * Gather all recent messages across all channels in a project.
   * Used to generate cross-session context.
   */
  getAllProjectMessages(projectId, limitPerChannel = 30) {
    const proj = this.projects.get(projectId);
    if (!proj) return [];
    const all = [];
    for (const ch of proj.channels) {
      const msgs = this.getMessages(projectId, ch, limitPerChannel);
      for (const m of msgs) {
        all.push({ ...m, channel: ch });
      }
    }
    all.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return all;
  }
}
