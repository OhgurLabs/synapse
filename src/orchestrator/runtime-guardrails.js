import { execFileSync } from 'child_process';
import { resolve } from 'path';

export const DEFAULT_PROTECTED_BRANCHES = Object.freeze(['main', 'master']);
export const DEFAULT_IGNORE_DIRTY_PREFIXES = Object.freeze([
  '.synapse/',
  'TASKS.md',
  'CAMPAIGNS.md',
]);

const DEFAULT_RUNTIME_STATE_PATHS = Object.freeze([
  '.synapse/circuit-breaker-state.json',
  '.synapse/last-shutdown.json',
  '.synapse/performance.json',
  '.synapse/analytics.json',
]);

const CROSS_PROJECT_RUNTIME_FILES = Object.freeze(new Set([
  '_agent-cooldowns.json',
  '_dispatch-log.jsonl',
  '_dispatch-log.jsonl.migrated',
  '_dispatch-log.sqlite',
  '_dispatch-log.sqlite-shm',
  '_dispatch-log.sqlite-wal',
  '_circuit-breaker-transitions.jsonl',
  '_circuit-breaker-transitions.sqlite',
  '_circuit-breaker-transitions.sqlite-shm',
  '_circuit-breaker-transitions.sqlite-wal',
]));

const PROJECT_RUNTIME_FILES = Object.freeze(new Set([
  'config.json',
  'campaigns.json',
  'campaign-events.jsonl',
  'tasks.json',
  'task-events.jsonl',
  'telemetry.jsonl',
  'learnings.jsonl',
  'permission-audit.jsonl',
  'operator-audit.jsonl',
  'threads.json',
  'context.md',
  'TASKS.md',
  'CAMPAIGNS.md',
  'webhooks.json',
  // state.sqlite became the canonical live read path for campaigns/tasks
  // in the #18 migration (2026-05-30). campaigns.json/tasks.json are
  // still dual-written (durable archive) so stay on the list; add the
  // SQLite triplet alongside so unsynced external writes to either
  // backend are caught by the same guardrail.
  'state.sqlite',
  'state.sqlite-shm',
  'state.sqlite-wal',
]));

const PROJECT_RUNTIME_DIR_PREFIXES = Object.freeze([
  'channels/',
  'embeddings/',
  'snapshots/',
  'checkpoints/',
]);

function runGit(cwd, args, timeoutMs = 5000) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).trim();
}

function parsePorcelainLine(line) {
  // Porcelain v1 format: XY PATH or XY OLD -> NEW
  const raw = line || '';
  if (raw.length < 3) return null;
  const status = raw.slice(0, 2);
  let path = raw.slice(3).trim();
  if (!path) return null;
  if (path.includes(' -> ')) path = path.split(' -> ').pop();
  const untracked = status === '??';
  return { status, path, untracked };
}

function isRuntimeStatePath(path) {
  if (!path || !path.startsWith('.synapse/')) return false;
  if (DEFAULT_RUNTIME_STATE_PATHS.includes(path)) return true;
  if (!path.startsWith('.synapse/projects/')) return false;

  const rel = path.slice('.synapse/projects/'.length);
  if (!rel) return false;
  if (CROSS_PROJECT_RUNTIME_FILES.has(rel)) return true;

  const slash = rel.indexOf('/');
  if (slash < 0) return false;
  const fileRel = rel.slice(slash + 1);
  if (!fileRel) return false;
  if (PROJECT_RUNTIME_FILES.has(fileRel)) return true;
  if (PROJECT_RUNTIME_DIR_PREFIXES.some(prefix => fileRel.startsWith(prefix))) return true;
  return false;
}

export function parseProtectedBranches(input) {
  if (!input || typeof input !== 'string') return [...DEFAULT_PROTECTED_BRANCHES];
  const branches = input
    .split(',')
    .map(b => b.trim())
    .filter(Boolean);
  return branches.length > 0 ? branches : [...DEFAULT_PROTECTED_BRANCHES];
}

export function collectRuntimeDriftState({ projectDir = process.cwd(), timeoutMs = 5000 } = {}) {
  const cwd = resolve(projectDir);

  let insideRepo = false;
  try {
    insideRepo = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], timeoutMs) === 'true';
  } catch {
    insideRepo = false;
  }

  if (!insideRepo) {
    return {
      ok: false,
      cwd,
      isGitRepo: false,
      branch: null,
      dirtyTrackedPaths: [],
      dirtyUntrackedPaths: [],
      trackedRuntimeStatePaths: [],
      error: 'not_a_git_repo',
    };
  }

  let branch = null;
  try {
    branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs) || null;
  } catch {
    branch = null;
  }

  let porcelain = '';
  try {
    porcelain = runGit(cwd, ['status', '--porcelain'], timeoutMs);
  } catch {
    porcelain = '';
  }

  const dirtyTrackedPaths = [];
  const dirtyUntrackedPaths = [];
  for (const line of porcelain.split('\n').filter(Boolean)) {
    const parsed = parsePorcelainLine(line);
    if (!parsed) continue;
    if (parsed.untracked) dirtyUntrackedPaths.push(parsed.path);
    else dirtyTrackedPaths.push(parsed.path);
  }

  const trackedRuntimeStatePaths = [];
  try {
    const tracked = runGit(cwd, ['ls-files', '.synapse'], timeoutMs);
    for (const p of tracked.split('\n').filter(Boolean)) {
      if (isRuntimeStatePath(p)) {
        trackedRuntimeStatePaths.push(p);
      }
    }
  } catch {
    // ignore; missing .synapse or ls-files errors are not fatal here
  }

  return {
    ok: true,
    cwd,
    isGitRepo: true,
    branch,
    dirtyTrackedPaths,
    dirtyUntrackedPaths,
    trackedRuntimeStatePaths,
  };
}

function isIgnoredPath(path, ignoredPrefixes) {
  return ignoredPrefixes.some(prefix => path === prefix || path.startsWith(prefix));
}

export function evaluateRuntimeDrift(state, options = {}) {
  const protectedBranches = options.protectedBranches || [...DEFAULT_PROTECTED_BRANCHES];
  const ignoredDirtyPrefixes = options.ignoredDirtyPrefixes || [...DEFAULT_IGNORE_DIRTY_PREFIXES];
  const requireNonProtectedBranch = options.requireNonProtectedBranch === true;
  const failOnDirtyProtectedBranch = options.failOnDirtyProtectedBranch !== false;
  const failOnTrackedRuntimeState = options.failOnTrackedRuntimeState !== false;
  // repoMode lets callers tell the guardrail what the project asked for. When
  // mode='none', the operator has explicitly opted out of git ops, so this
  // entire guardrail is a no-op (returns OK with one informational warning so
  // it's still visible in logs). Default 'local' preserves existing behavior.
  const repoMode = options.repoMode || 'local';

  const errors = [];
  const warnings = [];

  if (repoMode === 'none') {
    warnings.push('Repository guardrail skipped: project repoConfig.mode is "none".');
    return { ok: true, errors, warnings };
  }

  if (!state?.isGitRepo) {
    errors.push('Repository guardrail failed: working directory is not a git repository.');
    return { ok: false, errors, warnings };
  }

  const branch = state.branch || '(detached)';
  const isProtectedBranch = protectedBranches.includes(branch);

  if (requireNonProtectedBranch && isProtectedBranch) {
    errors.push(`Repository guardrail failed: branch "${branch}" is protected. Use a feature/integration branch for agent execution.`);
  }

  const effectiveDirtyTracked = (state.dirtyTrackedPaths || [])
    .filter(path => !isIgnoredPath(path, ignoredDirtyPrefixes));

  if (failOnDirtyProtectedBranch && isProtectedBranch && effectiveDirtyTracked.length > 0) {
    const sample = effectiveDirtyTracked.slice(0, 8).join(', ');
    errors.push(`Repository guardrail failed: protected branch "${branch}" has tracked code changes (${sample}).`);
  }

  if ((state.dirtyUntrackedPaths || []).length > 0 && isProtectedBranch) {
    const sample = state.dirtyUntrackedPaths.slice(0, 8).join(', ');
    warnings.push(`Untracked files exist on protected branch "${branch}": ${sample}`);
  }

  if (failOnTrackedRuntimeState && (state.trackedRuntimeStatePaths || []).length > 0) {
    const sample = state.trackedRuntimeStatePaths.slice(0, 8).join(', ');
    errors.push(`Runtime state tracking guardrail failed: runtime state files are tracked by git (${sample}).`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details: {
      branch,
      isProtectedBranch,
      dirtyTrackedCount: state.dirtyTrackedPaths?.length || 0,
      dirtyUntrackedCount: state.dirtyUntrackedPaths?.length || 0,
      trackedRuntimeStateCount: state.trackedRuntimeStatePaths?.length || 0,
      effectiveDirtyTrackedCount: effectiveDirtyTracked.length,
    },
  };
}

export function runRuntimeGuardrails({ projectDir = process.cwd(), options = {} } = {}) {
  const state = collectRuntimeDriftState({ projectDir, timeoutMs: options.timeoutMs || 5000 });
  const evaluation = evaluateRuntimeDrift(state, options);
  return { ...evaluation, state };
}
