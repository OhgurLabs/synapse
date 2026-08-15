/**
 * Task Lifecycle System — heartbeat, planning, execution, review.
 * Drives tasks through: queued → planning → executing → reviewing → done/failed.
 * Daemon tasks cycle: executing → reviewing → sleeping → executing.
 */

import { writeFileSync, renameSync, existsSync, readFileSync, statSync } from 'fs';
import { execFile, execSync, execFileSync } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { createLogger } from '../logger.js';
import { emitTelemetry } from '../telemetry.js';
import { startSpan, endSpan, addSpanEvent } from '../tracing.js';
import { isAgentEligibleNow, filterEligibleAgentEntries } from './agent-availability.js';
import { parseStructuredJson } from './structured-json.js';

const PRIORITY_ORDER = { critical: 0, high: 1, elevated: 2, normal: 3 };
import { setAgentThinking, setAgentIdle } from './health-aggregator.js';
import { extractDomainTags } from './domain-tags.js';
import { loadAllProjects, detectPatterns } from './pattern-detection.js';
import { detectSocraticTask, executeSocraticResearch } from './socratic-agent.js';
import { generateScheduledReport } from './report-generator.js';
import { DeliberationProtocol, DELIBERATION_STATES, MESSAGE_TYPES } from './deliberation-protocol.js';
import { DeliberationCoordinator } from './deliberation-coordinator.js';
import { extractReviewFeedback } from './deliberation-feedback-extractor.js';
import { boundDeliberationHistory } from './deliberation-history-window.js';
import { createAgentCookies } from './agent-cookies.js';
import { classifyCbFailureReason } from './agent-interaction.js';
import { providerMetricsStore } from './provider-metrics-store.js';
import { getAgentCostTier } from '../tasks.js';
import { rosterAllowsAgent, rosterAllowsAgentAnyRole, resolveRosterAgentIds } from '../roster.js';
import { isLocalInference } from '../provider-capabilities.js';
import { checkoutBranch, isPathCommittedClean } from './git-branches.js';
import { serializeAgentsConfig, saveAgentsConfig } from './agents.js';
import { runRuntimeGuardrails } from './runtime-guardrails.js';
import { hasHadCrossProviderReview, getFirstReviewProvider, selectCrossProviderReviewer, createCrossProviderReviewSubtask } from './cross-provider-review.js';
import { runValidationPipeline } from './code-validation.js';
import { calculateTrustScore, formatApprovalRequest } from './trust-score.js';

const log = createLogger('lifecycle');

function getTraceId(span) {
  const traceId = span?.spanContext?.().traceId;
  if (!traceId || /^0+$/.test(traceId)) return null;
  return traceId;
}

function normalizeSuggestedRole(role) {
  if (!role) return null;
  const normalized = String(role).trim().toLowerCase();
  if (normalized === 'executor') return 'implementer';
  return normalized;
}

/**
 * Returns true if an agent with agentRole can handle a subtask with the given
 * suggestedRole. Governs the pull model's work eligibility check in
 * seekAndExecute, and the role-pause tracker's notion of "an agent capable of
 * this role" (orchestrator.js) — module-scope + exported so both consumers
 * share ONE compatibility matrix instead of drifting copies.
 *
 * developer  → implementer / developer / researcher subtasks
 * reviewer   → reviewer ONLY (an architect restricted to review — operator ruling 2026-08-15)
 * architect  → architect / strategist / reviewer / researcher + implementer fallback
 * governor   → never picks up regular work
 * no role    → generalist: handles ANY suggested role. Roles are opt-in
 *              specialization — a fresh wizard-seeded roster has no roles
 *              at all, and restricting role-less agents to implementer
 *              work silently deadlocked every first-run campaign the
 *              moment the planner emitted a reviewer or architect subtask
 *              (found live: neon-snake first project, 3/4 subtasks done,
 *              play-verify(reviewer) queued forever, staging 2026-08-02).
 */
export function canRoleHandleSuggestedRole(agentRole, neededRole) {
  neededRole = normalizeSuggestedRole(neededRole);
  if (agentRole === 'governor') return false;
  if (!neededRole) return true;
  switch (agentRole) {
    case 'developer':
      return ['implementer', 'developer', 'researcher'].includes(neededRole);
    case 'reviewer':
      return neededRole === 'reviewer';
    case 'architect':
      return ['architect', 'strategist', 'reviewer', 'researcher', 'implementer', 'developer'].includes(neededRole);
    default:
      // Explicit unknown role strings still restrict to implementer-class
      // work; a truly role-less agent is a generalist.
      return agentRole
        ? ['implementer', 'developer', 'researcher'].includes(neededRole)
        : true;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Run deterministic functional checks after a task commits.
 * Detects broken links, unreachable endpoints, and syntax errors based on changed files.
 * Returns an array of failure objects: { file, issue, severity }.
 * Called before the LLM reviewer — failures are pre-seeded into the audit prompt.
 */
export async function runFunctionalChecks(diffStat, projectDir, port) {
  const failures = [];

  const changedFiles = (diffStat || '').split('\n')
    .map(line => line.trim().split('|')[0]?.trim())
    .filter(Boolean);

  if (!changedFiles.length) return failures;

  const base = `http://localhost:${port}`;

  // ── HTML linked resource check ──────────────────────────────
  // For any modified HTML file, verify every <link href> and <script src> returns HTTP 200.
  const htmlFiles = changedFiles.filter(f => f.endsWith('.html'));
  for (const htmlFile of htmlFiles) {
    const fullPath = join(projectDir, htmlFile);
    if (!existsSync(fullPath)) continue;
    try {
      const html = readFileSync(fullPath, 'utf-8');
      const refs = [
        ...html.matchAll(/href="(css\/[^"?#]+)"/g),
        ...html.matchAll(/src="(js\/[^"?#]+)"/g),
      ].map(m => m[1]);
      for (const ref of refs) {
        // A stray `const preDispatchSnapshot = taskManager.snapshotTaskState(
        // projectId, taskId);` used to stand here. None of taskManager,
        // projectId or taskId exist in runFunctionalChecks -- it is a paste
        // from the dispatch path, where the real one lives (guarded, ~line
        // 2236) -- and the const was never read.
        //
        // It threw ReferenceError on the FIRST iteration, and the enclosing
        // `catch { /* unreadable */ }` swallowed it as an unreadable file. So
        // this check performed zero fetches and reported zero failures for
        // every modified HTML file: a UI shipping broken css/ or js/ links
        // passed validation clean. Verified with a structural repro before
        // removing it.
        try {
          const r = await fetch(`${base}/${ref}`, { signal: AbortSignal.timeout(5000) });
          if (!r.ok) {
            failures.push({ file: htmlFile, issue: `Linked resource /${ref} returns HTTP ${r.status} — file missing or server not serving it`, severity: 'critical' });
          }
        } catch (e) {
          failures.push({ file: htmlFile, issue: `Linked resource /${ref} unreachable: ${e.message}`, severity: 'critical' });
        }
      }
    } catch { /* unreadable */ }
  }

  // ── API health check ────────────────────────────────────────
  // If api.js or server files changed, verify /api/health responds.
  const touchedServer = changedFiles.some(f => /api\.js|server\.js|orchestrator\.js/.test(f));
  if (touchedServer) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) {
        failures.push({ file: 'api.js', issue: `/api/health returned HTTP ${r.status} after changes`, severity: 'critical' });
      }
    } catch (e) {
      failures.push({ file: 'api.js', issue: `/api/health unreachable after changes: ${e.message}`, severity: 'critical' });
    }
  }

  // ── JS syntax check ─────────────────────────────────────────
  // node --check is fast and catches parse errors the diff might miss.
  const jsFiles = changedFiles.filter(f => f.endsWith('.js') && existsSync(join(projectDir, f)));
  for (const jsFile of jsFiles) {
    try {
      execFileSync('node', ['--check', join(projectDir, jsFile)], { stdio: 'pipe' });
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message || '').split('\n')[0];
      failures.push({ file: jsFile, issue: `Syntax error: ${msg}`, severity: 'critical' });
    }
  }

  return failures;
}

/**
 * Done-criteria completeness gate (#79). Deterministic proxies for "the work
 * this task promised did not actually happen", applied on the NON-audited
 * promote path (audited tasks get the LLM reviewer + functional pre-checks).
 *
 * Measured motivation: 55.7% of completed tasks (63% of the most recent 200)
 * did not satisfy their own doneCriteria — and no check existed anywhere.
 * This gate cannot judge criteria semantically; it blocks the two shapes
 * that are never legitimate for a criteria-bearing task:
 *   - zero of its subtasks succeeded (0/M), or
 *   - it fell short of its own plan by 3+ subtasks (a chopped run).
 *
 * Returns { block: boolean, reason: string|null }. Pure — exported for tests.
 */
export function evaluateDoneCriteriaGate(task) {
  if (!task?.doneCriteria || typeof task.doneCriteria !== 'string' || !task.doneCriteria.trim()) {
    return { block: false, reason: null };
  }
  const subtasks = (task.subtasks || []).filter(st => !st?.meta?.auditTask);
  const total = subtasks.length;
  if (total === 0) return { block: false, reason: null };
  const done = subtasks.filter(st => st.status === 'done').length;
  if (done === 0) {
    return { block: true, reason: `done-criteria-gate: 0/${total} subtasks succeeded` };
  }
  if (total - done >= 3) {
    return { block: true, reason: `done-criteria-gate: only ${done}/${total} subtasks succeeded (short by ${total - done})` };
  }
  return { block: false, reason: null };
}

/** Snapshot `git status --porcelain` for baseline diffing. Returns null if not a git repo. */
async function captureGitBaseline(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
    return stdout.trim();
  } catch {
    return null; // not a git repo, skip
  }
}

/** Capture `git diff --stat` (staged + unstaged) for audit context. */
async function captureGitDiffStat(dir) {
  try {
    const [unstaged, staged] = await Promise.all([
      execFileAsync('git', ['diff', '--stat'], { cwd: dir }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['diff', '--cached', '--stat'], { cwd: dir }).catch(() => ({ stdout: '' })),
    ]);
    const parts = [unstaged.stdout.trim(), staged.stdout.trim()].filter(Boolean);
    return parts.join('\n') || '(no changes)';
  } catch {
    return '(git diff --stat unavailable)';
  }
}

/** Capture truncated `git diff` (staged + unstaged) for audit context. */
async function captureGitDiff(dir, maxChars = 3000) {
  try {
    const [unstaged, staged] = await Promise.all([
      execFileAsync('git', ['diff'], { cwd: dir, maxBuffer: maxChars * 2 }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['diff', '--cached'], { cwd: dir, maxBuffer: maxChars * 2 }).catch(() => ({ stdout: '' })),
    ]);
    let combined = [unstaged.stdout, staged.stdout].filter(Boolean).join('\n');
    if (combined.length > maxChars) {
      combined = combined.substring(0, maxChars) + '\n... (truncated)';
    }
    return combined || '(no diff)';
  } catch {
    return '(git diff unavailable)';
  }
}

/** Capture `git diff --stat HEAD~1 HEAD` — shows what the most recent commit changed. */
async function captureLastCommitDiffStat(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1', 'HEAD'], { cwd: dir });
    return stdout.trim() || '(no committed changes)';
  } catch {
    return '(git diff stat unavailable)';
  }
}

/** Capture truncated `git diff HEAD~1 HEAD` — shows what the most recent commit changed. */
async function captureLastCommitDiff(dir, maxChars = 3000) {
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD~1', 'HEAD'], { cwd: dir, maxBuffer: maxChars * 2 });
    let content = stdout;
    if (content.length > maxChars) content = content.substring(0, maxChars) + '\n... (truncated)';
    return content || '(no diff)';
  } catch {
    return '(git diff unavailable)';
  }
}

/**
 * Check for destructive changes — files with large net deletions.
 * Returns array of {file, insertions, deletions} for files exceeding threshold.
 * Threshold: >50 lines deleted AND deletions > 3x insertions.
 */
async function checkDestructiveChanges(dir) {
  try {
    const [unstaged, staged] = await Promise.all([
      execFileAsync('git', ['diff', '--numstat'], { cwd: dir }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['diff', '--cached', '--numstat'], { cwd: dir }).catch(() => ({ stdout: '' })),
    ]);
    const combined = [unstaged.stdout.trim(), staged.stdout.trim()].filter(Boolean).join('\n');
    if (!combined) return [];

    // Aggregate per file (a file may appear in both staged and unstaged)
    const fileStats = new Map();
    for (const line of combined.split('\n')) {
      if (!line.trim()) continue;
      const [ins, del, file] = line.split('\t');
      if (!file || ins === '-' || del === '-') continue; // binary files
      const insertions = parseInt(ins, 10) || 0;
      const deletions = parseInt(del, 10) || 0;
      const existing = fileStats.get(file) || { file, insertions: 0, deletions: 0 };
      existing.insertions += insertions;
      existing.deletions += deletions;
      fileStats.set(file, existing);
    }

    // Flag files with destructive changes: >50 lines deleted AND deletions > 3x insertions
    const destructive = [];
    for (const stat of fileStats.values()) {
      if (stat.deletions > 50 && stat.deletions > stat.insertions * 3) {
        destructive.push(stat);
      }
    }
    return destructive;
  } catch {
    return [];
  }
}

// Runtime-state artifacts that must never be committed, regardless of any
// configurable pattern: SQLite stores and their WAL/SHM siblings, error dumps,
// and the test-db fixture directory. Structural, not operator-tunable — these
// are what fueled the commit-guard snowball (08-10/08-12 soaks).
const FORBIDDEN_COMMIT_RE = /(^|\/)test-db\/|\.(db|db-shm|db-wal|sqlite|sqlite-shm|sqlite-wal|err)$/;

export async function runCommitGuard(files, projectDir, guardConfig) {
  const guard = guardConfig;
  if (!guard.enabled) return { ok: true };

  const errors = [];

  // Zone 3 — forbidden: hard reject, independent of counts.
  const forbidden = files.filter(f => FORBIDDEN_COMMIT_RE.test(f));
  if (forbidden.length > 0) {
    errors.push(`Runtime-state artifacts must not be committed: ${forbidden.slice(0, 5).join(', ')}${forbidden.length > 5 ? ` (+${forbidden.length - 5} more)` : ''}`);
  }

  // Zone 2 — artifact paths (evidence bundles): exempt from the file-count
  // cap (bundles are born atomic; count proxies risk only for source), but
  // bounded by bytes. Oversized bundles warn first, then block.
  const artifactPaths = guard.artifactPaths || [];
  const isArtifact = (f) => artifactPaths.some(p => f.startsWith(p));
  const artifactFiles = files.filter(f => isArtifact(f) && !FORBIDDEN_COMMIT_RE.test(f));
  if (artifactFiles.length > 0 && (guard.artifactMaxBytes || guard.artifactWarnBytes)) {
    let artifactBytes = 0;
    for (const f of artifactFiles) {
      try { artifactBytes += statSync(join(projectDir, f)).size; } catch { /* deleted file — 0 bytes */ }
    }
    if (guard.artifactMaxBytes && artifactBytes > guard.artifactMaxBytes) {
      errors.push(`Artifact bundle is ${Math.round(artifactBytes / 1024)}KB (max ${Math.round(guard.artifactMaxBytes / 1024)}KB) — split the bundle or prune captures`);
    } else if (guard.artifactWarnBytes && artifactBytes > guard.artifactWarnBytes) {
      log.warn('Large artifact bundle in commit (allowed, flagging for visibility)', {
        files: artifactFiles.length, bytes: artifactBytes,
      });
    }
  }

  // Zone 1 — source: the count cap applies to everything else.
  const sourceFiles = files.filter(f => !isArtifact(f));
  if (sourceFiles.length > guard.maxFiles) {
    errors.push(`Commit touches ${sourceFiles.length} source files (max ${guard.maxFiles}; ${artifactFiles.length} artifact files exempt) — flag for human review`);
  }

  for (const pattern of guard.blockedPatterns) {
    const blocked = files.filter(f => f.toLowerCase().includes(pattern.toLowerCase()));
    if (blocked.length > 0) {
      errors.push(`Blocked files matching "${pattern}": ${blocked.join(', ')}`);
    }
  }

  if (guard.syntaxCheck) {
    const jsFiles = files.filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
    for (const f of jsFiles) {
      try {
        execFileSync('node', ['--check', f], { cwd: projectDir, stdio: 'pipe' });
      } catch (e) {
        errors.push(`Syntax error in ${f}: ${e.stderr?.toString().trim() || e.message}`);
      }
    }
  }

  if (guard.auditLogDir) {
    try {
      const auditDir = join(projectDir, guard.auditLogDir);
      if (!existsSync(auditDir)) {
        const { mkdirSync } = await import('fs');
        mkdirSync(auditDir, { recursive: true });
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const { stdout: diffOutput } = await execFileAsync(
        'git', ['diff', '--cached', '--stat'], { cwd: projectDir }
      );
      writeFileSync(join(auditDir, `commit-${ts}.log`), [
        `Time: ${new Date().toISOString()}`,
        `Files: ${files.join(', ')}`,
        `Count: ${files.length}`,
        diffOutput,
        '---',
      ].join('\n'));
    } catch { /* audit logging is best-effort */ }
  }

  if (errors.length > 0) {
    log.warn('Commit guard rejected commit', { errors, fileCount: files.length });
    return { ok: false, errors };
  }
  return { ok: true };
}

/** Detect files changed since baseline and commit them to the project repo. */
async function detectAndCommitProjectChanges(projectDir, projectId, task, commitConfig) {
  try {
    const { stdout: currentStatus } = await execFileAsync(
      'git', ['status', '--porcelain'], { cwd: projectDir }
    );

    const baseline = new Set(
      (task.gitBaseline || '').split('\n').filter(Boolean)
    );

    // Strip only the trailing newline — git porcelain v1 format is `XY file`
    // where X (index status) is a space when the file is only modified in the
    // working tree (e.g. ' M filename'). A buffer-level `.trim()` would eat
    // that leading space, then per-line `.slice(3)` below chops the first
    // character of the filename ('logging_audit.jsonl' → 'ogging_audit.jsonl').
    // Operator-visible as "fatal: pathspec '...' did not match any files".
    const current = currentStatus.replace(/\n+$/, '').split('\n').filter(Boolean);
    const newChanges = current.filter(line => !baseline.has(line));

    if (newChanges.length === 0) return [];

    const files = newChanges.map(line => {
      let path = line.slice(3).trim();
      if (path.includes(' -> ')) path = path.split(' -> ').pop();
      return path;
    }).filter(f => f && !f.startsWith('.synapse/') && !f.startsWith('.synapse\\')
      && !f.match(/^\.?synapse\/projects\//));

    if (files.length === 0) return [];

    const guardResult = await runCommitGuard(files, projectDir, commitConfig?.commitGuard);
    if (!guardResult.ok) {
      log.error('Commit guard blocked agent commit', { projectId, errors: guardResult.errors });
      return [];
    }

    await execFileAsync('git', ['add', ...files], { cwd: projectDir });

    const agents = [...new Set(task.subtasks.map(s => s.assignee).filter(Boolean))];
    const msg = [
      `[task] ${task.title}`,
      '',
      task.campaignId ? `Campaign: ${task.campaignId}` : null,
      task.milestoneId ? `Milestone: ${task.milestoneId}` : null,
      `Task: ${task.id}`,
      `Agents: ${agents.join(', ')}`,
      `Subtasks: ${task.subtasks.filter(s => s.status === 'done').length}/${task.subtasks.length} complete`,
      '',
      `Files: ${files.join(', ')}`,
    ].filter(Boolean).join('\n');

    await execFileAsync('git', ['commit', '-m', msg], { cwd: projectDir });

    return files;
  } catch (err) {
    log.error('Project commit failed', { projectId, error: err.message });
    return [];
  }
}

/** Commit .synapse/ state files to the platform repo. */
async function commitSynapseState(synapseDir, projectId, task) {
  try {
    // Stage .synapse/ state files for this project
    const stateGlob = `.synapse/projects/${projectId}/*`;
    await execFileAsync('git', ['add', stateGlob], { cwd: synapseDir });

    // Also stage TASKS.md variants if they exist
    await execFileAsync(
      'git', ['add', '--ignore-errors', 'TASKS.md', 'CAMPAIGNS.md', `.synapse/projects/${projectId}/TASKS.md`],
      { cwd: synapseDir }
    ).catch(err => log.warn('Git add optional files failed (non-critical)', { error: err.message }));

    // Check if anything was actually staged
    const { stdout: diff } = await execFileAsync(
      'git', ['diff', '--cached', '--name-only'], { cwd: synapseDir }
    );
    if (!diff.trim()) return; // nothing staged

    const msg = `[state] ${task.title} → done (${projectId})`;
    await execFileAsync('git', ['commit', '-m', msg], { cwd: synapseDir });
  } catch (err) {
    log.error('State commit failed', { error: err.message });
  }
}

/**
 * Check whether a task has an active (non-terminal) deliberation session.
 *
 * Returns true if a deliberation session exists for the task AND its phase is
 * not yet COMPLETE or ERROR. The task state machine should not advance to
 * 'done' while this returns true.
 *
 * @param {string} taskId - The task to check
 * @param {import('./deliberation-coordinator.js').DeliberationCoordinator|null} coordinator
 * @returns {boolean}
 */
function hasActiveDeliberationSession(taskId, coordinator) {
  if (!coordinator || !taskId) return false;
  try {
    const session = coordinator.getSessionByTaskId(taskId);
    if (!session) return false;
    const status = coordinator.getDeliberationStatus(session.sessionId);
    const terminalPhases = [DELIBERATION_STATES.COMPLETE, DELIBERATION_STATES.ERROR];
    if (terminalPhases.includes(status.phase)) return false;
    // A session still at INIT has no message flow driving it — planning-time
    // sessions are initialized but nothing submits a PROPOSAL, so they can
    // never reach COMPLETE. Deferring completion for them only buys the
    // session timeout (10-15 min of dead air per multi-assignee task).
    // Review-and-revise sessions submit REVIEW_REQUEST at creation, moving
    // them to REVIEW_PENDING immediately, so they still defer correctly.
    if (status.phase === DELIBERATION_STATES.INIT) return false;
    return true;
  } catch (err) {
    // Fail open: if we can't determine session state, don't block completion
    return false;
  }
}

/**
 * Decide whether a dispatch may resume the prior harness session.
 *
 * Pure and exported ON PURPOSE: this is the gate that protects verbatim A/B
 * runs, and a gate that cannot be tested directly is a gate nobody has checked.
 * Inline, the only way to exercise it was to boot the whole lifecycle.
 *
 * Every failure returns false, which means "mint a fresh id and start cold" --
 * today's behaviour. There is no path here that makes things worse than not
 * resuming at all.
 *
 * @param {object}  a
 * @param {boolean} a.resumeEnabled  contextConfig.resume.enabled for the project
 * @param {boolean} a.isVerbatim     subtask.meta.verbatim
 * @param {object}  a.priorDispatch  subtask.meta.lastDispatch, or null
 * @param {string}  a.model          the model about to run
 * @returns {boolean}
 */
export function shouldResumeSession({ resumeEnabled, isVerbatim, priorDispatch, model, maxAgeHours, now = Date.now() }) {
  // Opt-in per project. Absent config means off.
  if (resumeEnabled !== true) return false;
  // NEVER resume a verbatim campaign. Its whole purpose is a clean one-shot
  // prompt for 1:1 A/B parity; prior context would silently invalidate the
  // comparison and the numbers would still look plausible.
  if (isVerbatim) return false;
  // Nothing to resume: first dispatch of the series.
  if (!priorDispatch || !priorDispatch.sessionId) return false;
  // Replaying one model's history on a different model is not a resume. Both
  // sides must be known -- an unrecorded prior model is treated as a mismatch
  // rather than assumed compatible.
  if (!priorDispatch.model || !model) return false;
  if (priorDispatch.model !== model) return false;
  // AGE CEILING. Harness session stores grow without bound and are never pruned
  // -- measured on this host: ~/.claude/projects 730MB/336 files,
  // ~/.codex/sessions 347MB/923 files retained since 2025-12, single sessions up
  // to 227MB. Resuming reloads that transcript, so an old session costs both
  // latency and tokens, and its recorded file state is likely stale anyway.
  // Uses lastDispatch.at, already recorded, so no filesystem access and no
  // per-harness path knowledge is required.
  // An unparseable or missing timestamp is treated as TOO OLD rather than
  // fresh: the failure direction has to be "start cold", never "resume
  // something we cannot date".
  if (Number.isFinite(maxAgeHours)) {
    if (maxAgeHours === 0) return false;
    const at = Date.parse(priorDispatch.at ?? '');
    if (!Number.isFinite(at)) return false;
    if (now - at > maxAgeHours * 3600_000) return false;
  }
  return true;
}

/**
 * Order planner candidates by preference. Pure and exported for direct testing
 * (same pattern as evaluateDoneCriteriaGate).
 *
 * Ladder: claude architect → gemini architect → codex architect → any gemini →
 * any codex → ollama architect → any architect → any claude → any non-ollama →
 * remaining non-ollama-non-architect. Non-architect ollama agents are normally
 * excluded (too slow/low-capacity for large-context planning) — EXCEPT as the
 * final rung: a roster consisting solely of non-architect local agents used to
 * produce an empty ladder here, so planning deferred forever while the notice
 * promised it would start automatically (#15). Slow planning beats no planning,
 * but only when nothing else exists.
 *
 * @param {Array<[string, Object]>} plannerPool - [agentId, agent] entries,
 *   already filtered for availability/roster/permissions.
 * @returns {Array<[string, Object]>} ordered candidate entries
 */
/**
 * Decide the promotion for a task stuck in 'reviewing' whose audit work is
 * complete (heartbeat recovery sweep). Pure and exported for direct testing.
 *
 * Mirrors the normal promote path's guards: all-empty results are an infra
 * failure, and the #79 done-criteria gate applies HERE too — this sweep used
 * to promote 0/M-failed criteria-bearing tasks to done ("failures are final")
 * when the null-reviewer branch stranded them, the exact shape the gate marks
 * failed on the normal path (#102).
 *
 * @param {Object} task - task with subtasks[] and optional doneCriteria
 * @returns {{newStatus: string, reason: string, extras: Object|null}}
 */
export function evaluateRecoveryPromotion(task) {
  const subtasks = task.subtasks || [];
  const failedCount = subtasks.filter(st => st && st.status === 'failed').length;
  const doneCount = subtasks.filter(st => st && st.status === 'done').length;
  const allEmpty = subtasks.length > 0 && subtasks.every(st =>
    !st.result || (typeof st.result === 'string' && st.result.trim().length === 0) ||
    (typeof st.result === 'object' && (!st.result.text || st.result.text.trim().length === 0))
  );
  if (allEmpty) {
    return { newStatus: 'failed', reason: 'Recovery: audit complete, all subtasks empty', extras: null };
  }
  const criteriaGate = evaluateDoneCriteriaGate(task);
  if (criteriaGate.block) {
    return { newStatus: 'failed', reason: `Recovery: ${criteriaGate.reason}`, extras: null };
  }
  if (failedCount > 0) {
    return {
      newStatus: 'done',
      reason: 'Recovery: audit complete, partial failure',
      extras: { partialFailure: true, failedSubtaskCount: failedCount, doneSubtaskCount: doneCount },
    };
  }
  return { newStatus: 'done', reason: 'Recovery: audit complete, all passed', extras: null };
}

export function orderPlannerCandidates(plannerPool) {
  const out = [];
  const seen = new Set();
  const pushFirst = (pred) => {
    for (const entry of plannerPool) {
      const [id, a] = entry;
      if (seen.has(id)) continue;
      if (!pred(id, a)) continue;
      seen.add(id);
      out.push(entry);
      return;
    }
  };
  pushFirst((_id, a) => a.role === 'architect' && a.provider === 'claude');
  pushFirst((_id, a) => a.role === 'architect' && a.provider === 'gemini');
  pushFirst((_id, a) => a.role === 'architect' && a.provider === 'codex');
  pushFirst((_id, a) => a.provider === 'gemini');
  pushFirst((_id, a) => a.provider === 'codex');
  pushFirst((_id, a) => a.role === 'architect' && a.provider === 'ollama');
  pushFirst((_id, a) => a.role === 'architect');
  pushFirst((_id, a) => a.provider === 'claude');
  pushFirst((_id, a) => a.provider !== 'ollama');
  for (const entry of plannerPool) {
    const [id, a] = entry;
    if (seen.has(id)) continue;
    if (a.provider === 'ollama' && a.role !== 'architect') continue; // local models plan only when the operator opted them in via the architect role
    seen.add(id);
    out.push(entry);
  }
  // Solo-local last resort (see doc comment): only reachable when the pool
  // contains nothing but non-architect ollama agents.
  if (out.length === 0) {
    for (const entry of plannerPool) {
      const [id] = entry;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
  }
  return out;
}

export function createLifecycleSystem(deps) {
  const {
    taskManager,
    stateManager,
    campaignManager,
    agents,
    addMessage,
    broadcastToChannel,
    withTimeout,
    config,
    routeSubtask,
    getAgentResponse,
    isAgentCoolingDown,
    setAgentCooldown,
    agentCooldowns,
    RATE_LIMIT_RE,
    MODEL_NOT_FOUND_RE,
    thinkingAgents,
    PROJECT_DIR,
    canBypassPermissions,
    filterByPermission,
    hasPermission,
    auditDispatch,
    lockGovernanceFiles,
    unlockGovernanceFiles,
    hashGovernanceFiles,
    verifyGovernanceIntegrity,
    lockSourceFiles,
    unlockSourceFiles,
    dispatchLog,
    operatorAuditStore,
  } = deps;

  const registerPersonaHash = deps.registerPersonaHash || null;
  const isRolePaused = deps.isRolePaused || null;
  // BYOH PR workflow Phase 1.3 — auto-open PR on subtask claim when the
  // project enforces the universal PR gate. Optional dep: when prStore is
  // not injected (older orchestrator wiring), the hook silently no-ops.
  const prStore = deps.prStore || null;
  const getPausedRoles = deps.getPausedRoles || null;
  const markRolePaused = deps.markRolePaused || null;
  const markRoleResumed = deps.markRoleResumed || null;
  const eventBus = deps.eventBus || null;
  const scoreboard = deps.scoreboard || null;
  const circuitBreaker = deps.circuitBreaker || null;
  const learningsManager = deps.learningsManager || null;
  const checkpointManager = deps.checkpointManager || null;
  const vaultWriter = deps.vaultWriter || null;
  const vaultQuery = deps.vaultQuery || null;
  const agentMemoryStore = deps.agentMemoryStore || null;
  const scheduledReportStore = deps.scheduledReportStore || null;
  const timelineStore = deps.timelineStore || null;
  const deliberationProtocol = deps.deliberationProtocol || null;
  const performanceStore = deps.performanceStore || null;
  const sandbox = deps.sandbox || null;

  let strategistEvaluate = deps.strategistEvaluate || null; // injected later for circular dep
  let heartbeatRunning = false;

  // Agent cookies — punch-in/punch-out tracking. Replaces busyAgents Set.
  // Source of truth = subtask state (tasks.json), cache reconciled every heartbeat.
  const agentCookies = createAgentCookies({ taskManager, stateManager, sandbox, agents, config });
  // Compatibility alias: callers that used busyAgents.has() work unchanged with agentCookies.has()
  const busyAgents = agentCookies;

  // Deliberation coordinator — manages multi-agent deliberation sessions
  // Prefer injected instance from orchestrator; fall back to creating one locally
  const deliberationCoordinator = deps.deliberationCoordinator
    || ((deliberationProtocol && eventBus)
      ? new DeliberationCoordinator(deliberationProtocol.store, eventBus)
      : null);

  // Cross-project pattern scan state
  let lastPatternScanAt = 0;
  const PATTERN_SCAN_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

  // Provider dispatch rate log — sliding window for pace gate
  // Map<provider, number[]> — timestamps of recent dispatches
  const providerDispatchLog = new Map();
  const paceOverrides = new Map();

  /**
   * Check if a dispatch is allowed by the pace gate.
   * For Gemini agents, pass `model` to apply per-model limits instead of provider-level.
   * Returns { allowed: boolean, used: number, max: number, nextFreeSec: number }
   * Does NOT consume a slot — call recordPaceDispatch() after a successful claim.
   */
  function isPaceAllowed(provider, model = null) {
    if (!config.pace?.enabled) return { allowed: true, used: 0, max: Infinity, nextFreeSec: 0 };
    // Local providers run on-premise hardware — no cloud quotas, never pace-gated.
    if (config.pace.localProviders?.has(provider)) return { allowed: true, used: 0, max: Infinity, nextFreeSec: 0 };

    // Gemini: per-model limits (each model has its own quota bucket)
    const paceKey = (provider === 'gemini' && model) ? `gemini:${model}` : provider;
    let maxPerWindow;
    if (provider === 'gemini' && model) {
      maxPerWindow = paceOverrides.get(`gemini:${model}`) ?? config.pace.maxPerModel?.[model] ?? config.pace.maxPerProvider?.gemini;
    } else {
      maxPerWindow = paceOverrides.get(provider) ?? config.pace.maxPerProvider?.[provider];
    }
    if (maxPerWindow === undefined) return { allowed: true, used: 0, max: Infinity, nextFreeSec: 0 };

    const windowMs = config.pace.windowMs ?? 3_600_000;
    const now = Date.now();
    const cutoff = now - windowMs;
    const stamps = (providerDispatchLog.get(paceKey) ?? []).filter(t => t > cutoff);
    providerDispatchLog.set(paceKey, stamps); // prune expired stamps
    const used = stamps.length;
    if (used >= maxPerWindow) {
      const nextFreeMs = stamps[0] + windowMs - now;
      return { allowed: false, used, max: maxPerWindow, nextFreeSec: Math.round(nextFreeMs / 1000) };
    }
    return { allowed: true, used, max: maxPerWindow, nextFreeSec: 0 };
  }

  /** Read current pace gate state for all known providers — used by health endpoint. */
  function getPaceGateStatus() {
    if (!config.pace?.enabled) return {};
    const windowMs = config.pace.windowMs ?? 3_600_000;
    const now = Date.now();
    const cutoff = now - windowMs;
    const result = {};
    for (const [paceKey, stamps] of providerDispatchLog.entries()) {
      const active = stamps.filter(t => t > cutoff);
      const provider = paceKey.includes(':') ? paceKey.split(':')[0] : paceKey;
      const maxPerWindow = paceKey.includes(':')
        ? config.pace.maxPerModel?.[paceKey.split(':')[1]] ?? config.pace.maxPerProvider?.[provider]
        : config.pace.maxPerProvider?.[provider];
      result[paceKey] = {
        used: active.length,
        max: maxPerWindow ?? null,
        blocked: maxPerWindow !== undefined && active.length >= maxPerWindow,
        nextFreeSec: active.length > 0 ? Math.round(Math.max(0, active[0] + windowMs - now) / 1000) : 0,
      };
    }
    return result;
  }

  function setPaceOverride(providerOrModel, maxPerWindow) {
    if (!config.pace) return false;
    if (maxPerWindow === null || maxPerWindow === undefined) {
      paceOverrides.delete(providerOrModel);
    } else {
      paceOverrides.set(providerOrModel, maxPerWindow);
    }
    return true;
  }

  /** Record a successful dispatch — called AFTER CAS claim succeeds (not on check). */
  function recordPaceDispatch(provider, model = null) {
    if (!config.pace?.enabled) return;
    if (config.pace.localProviders?.has(provider)) return;
    const paceKey = (provider === 'gemini' && model) ? `gemini:${model}` : provider;
    const stamps = providerDispatchLog.get(paceKey) ?? [];
    stamps.push(Date.now());
    providerDispatchLog.set(paceKey, stamps);
  }
  const pendingDispatch = new Set(); // taskIds scheduled for daemon wakeup (prevents double-scheduling)
  const lastNoAgentReport = new Map(); // taskId → { time, nextAvailable } — suppresses repeated messages
  const plannerProviderInFlight = new Map(); // provider -> count (task planning only)

  // ─── Pull model state ─────────────────────────────────────────
  // activePickups kept for backward compat with health endpoint but no longer
  // used as a concurrency guard — agentCookies + CAS subtask claim handle mutual exclusion.
  let activePickups = 0;
  let idleLoopsActive = false;
  const idleLoopTimers = new Map(); // agentId → current timer (initial AND rescheduled polls — every pending timer must be cancellable on stop)

  // ─── Heartbeat state ──────────────────────────────────────────
  let lastHeartbeatCompleted = Date.now(); // updated at end of each successful heartbeatTick
  const HEARTBEAT_STALL_MS = config.tasks.heartbeatStallMs || 300000;

  function plannerProviderConcurrencyCap(provider) {
    return provider === 'gemini' ? 1 : Number.POSITIVE_INFINITY;
  }

  function tryAcquirePlannerProviderSlot(provider) {
    const cap = plannerProviderConcurrencyCap(provider);
    if (!Number.isFinite(cap)) return true;
    const current = plannerProviderInFlight.get(provider) || 0;
    if (current >= cap) return false;
    plannerProviderInFlight.set(provider, current + 1);
    return true;
  }

  function releasePlannerProviderSlot(provider) {
    const cap = plannerProviderConcurrencyCap(provider);
    if (!Number.isFinite(cap)) return;
    const current = plannerProviderInFlight.get(provider) || 0;
    if (current <= 1) plannerProviderInFlight.delete(provider);
    else plannerProviderInFlight.set(provider, current - 1);
  }

  function isAgentPlanningNow(agentId) {
    if (!thinkingAgents || thinkingAgents.size === 0) return false;
    const suffix = `#${agentId}`;
    for (const key of thinkingAgents) {
      if (typeof key === 'string' && key.endsWith(suffix)) return true;
    }
    return false;
  }

  function deferTaskForCooldown(projectId, channelId, taskId, taskTitle, agentId, mins, reasonPrefix = 'Planning deferred') {
    const untilMs = agentCooldowns?.get(agentId) || (Date.now() + mins * 60_000);
    const untilIso = new Date(untilMs).toISOString();
    taskManager.deferTask(projectId, taskId, untilIso, 'system', `${reasonPrefix}: ${agentId} rate limited (${mins}m cooldown)`);
    addMessage(projectId, channelId, 'System',
      `${reasonPrefix} — @${agentId} hit rate limit (${mins}m cooldown). Retry scheduled for ${new Date(untilMs).toLocaleTimeString()}.`,
      'system');
  }

  /**
   * Parse structured ReviewFeedback from a reviewer's response.
   * Expected format: { status: 'approved'|'rejected'|'commented', findings: [...], summary: '...' }
   * Returns null if no structured feedback is found.
   */
  function parseReviewFeedback(response) {
    if (!response || typeof response !== 'string') return null;

    // Find the start of a JSON object containing "status"
    const statusMatch = response.match(/"status"\s*:\s*"(approved|rejected|commented)"/);
    if (!statusMatch) return null;

    // Find the opening brace before the status field
    let start = response.lastIndexOf('{', statusMatch.index);
    if (start === -1) return null;

    // Balance braces to find the complete JSON object
    let depth = 0;
    let end = -1;
    for (let i = start; i < response.length; i++) {
      if (response[i] === '{') depth++;
      else if (response[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) return null;

    try {
      const jsonStr = response.substring(start, end);
      const parsed = JSON.parse(jsonStr);
      if (parsed.status && ['approved', 'rejected', 'commented'].includes(parsed.status)) {
        return {
          status: parsed.status,
          findings: Array.isArray(parsed.findings) ? parsed.findings.map(f => ({
            severity: f.severity || 'moderate',
            file: f.file || null,
            line: f.line || null,
            issue: f.issue || f.description || String(f),
            fix: f.fix || f.suggestion || null,
          })) : [],
          summary: parsed.summary || '',
        };
      }
    } catch { /* fall through */ }

    return null;
  }

  /**
   * Extract top-level balanced {...} or [...] blocks from mixed prose+JSON
   * text in a single linear pass (string-aware, escape-aware). Replaces the
   * previous lazy-regex extraction, whose stacked [\s\S]*? groups backtracked
   * super-linearly on adversarial reviewer output.
   */
  function extractBalancedBlocks(text, open, close, maxBlocks = 8) {
    const blocks = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length && blocks.length < maxBlocks; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { if (depth > 0) inStr = true; continue; }
      if (ch === open) { if (depth === 0) start = i; depth++; }
      else if (ch === close && depth > 0 && --depth === 0) blocks.push(text.slice(start, i + 1));
    }
    return blocks;
  }

  /**
   * Parse structured review findings from a reviewer's audit response.
   * Handles JSON responses and falls back to prose.
   */
  function parseReviewFindings(auditResult) {
    if (!auditResult || typeof auditResult !== 'string') return [];

    // Try to extract a JSON object with a findings array
    for (const block of extractBalancedBlocks(auditResult, '{', '}')) {
      if (!block.includes('"findings"')) continue;
      try {
        const parsed = JSON.parse(block);
        if (Array.isArray(parsed.findings)) {
          if (parsed.findings.length > 0) {
            return parsed.findings.map(f => ({
              severity: f.severity || 'moderate',
              file: f.file || null,
              line: f.line || null,
              issue: f.issue || f.description || String(f),
              fix: f.fix || f.suggestion || null,
            }));
          }
          // Empty findings array: synthesize from summary on FAIL, or treat as PASS
          if (parsed.verdict === 'FAIL' || parsed.verdict === 'fail') {
            const summary = parsed.summary || parsed.reason || 'Reviewer indicated failure without specific findings.';
            return [{ severity: 'moderate', file: null, line: null, issue: summary, fix: null }];
          }
          return []; // PASS with empty findings — clean run
        }
      } catch { /* fall through to next parser */ }
    }

    // Try bare JSON array of finding objects
    for (const arrBlock of extractBalancedBlocks(auditResult, '[', ']')) {
      try {
        const parsed = JSON.parse(arrBlock);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].issue) {
          return parsed.map(f => ({
            severity: f.severity || 'unknown',
            file: f.file || null,
            line: f.line || null,
            issue: f.issue || String(f),
            fix: f.fix || null,
          }));
        }
      } catch { /* fall through to prose fallback */ }
    }

    // Prose fallback — single finding from full text
    return [{ severity: 'unknown', file: null, line: null, issue: auditResult.substring(0, 2000), fix: null }];
  }

  /** Create fix subtasks from structured review findings. */
  function createFixSubtasks(findings) {
    const subtasks = [];
    for (const finding of findings) {
      if (finding.severity === 'unknown' && findings.length === 1) {
        // Prose fallback — single fix subtask with full review text
        subtasks.push({
          text: `Fix review issues: ${finding.issue.substring(0, 200)}`,
          role: 'implementer',
          complexity: 'high',
          meta: { reviewFinding: finding },
        });
      } else {
        const fileRef = finding.file ? ` in ${finding.file}${finding.line ? ':' + finding.line : ''}` : '';
        subtasks.push({
          text: `Fix ${finding.severity}${fileRef}: ${(finding.issue || '').substring(0, 150)}`,
          role: 'implementer',
          complexity: finding.severity === 'critical' ? 'high' : 'medium',
          meta: { reviewFinding: finding },
        });
      }
    }
    return subtasks;
  }
  /**
   * Validate review findings against the filesystem and prior fix cycles.
   * Discards hallucinated findings (non-existent files) and duplicate findings
   * that already failed in a previous fix cycle.
   * Returns only actionable findings.
   */
  function validateFindings(findings, projectDir, task) {
    if (!findings || findings.length === 0) return [];
    const validated = [];
    const previousFindings = task.reviewFindings || [];

    for (const finding of findings) {
      // Blocker findings (external dependencies) bypass file/dedup checks — escalate as-is
      if (finding.severity === 'blocker') {
        validated.push(finding);
        continue;
      }

      // Layer 1: File existence check — catch reviewer hallucinations
      if (finding.file) {
        const absPath = join(projectDir, finding.file);
        if (!existsSync(absPath)) {
          log.warn('Review finding references non-existent file — discarding', {
            taskId: task.id, file: finding.file, issue: (finding.issue || '').substring(0, 100),
          });
          if (learningsManager) {
            learningsManager.add(task.project, {
              category: 'review_hallucination',
              pattern: `Reviewer referenced non-existent file: ${finding.file}`,
              why: `Finding "${(finding.issue || '').substring(0, 150)}" references ${finding.file} which does not exist.`,
              correction: 'Finding auto-discarded. Reviewer hallucinated a file path.',
              severity: 'important',
              source: { taskId: task.id, campaignId: task.campaignId, milestoneId: task.milestoneId },
              tags: ['pattern:phantom-file', `file:${finding.file}`],
            });
          }
          continue;
        }
      }

      // Layer 2: Dedup across fix cycles — same finding appearing again means unfixable
      if (previousFindings.length > 0) {
        const isDuplicate = previousFindings.some(prev =>
          prev.file === finding.file &&
          prev.issue && finding.issue &&
          prev.issue.substring(0, 100) === finding.issue.substring(0, 100)
        );
        if (isDuplicate) {
          log.warn('Review finding is duplicate from previous fix cycle — discarding', {
            taskId: task.id, file: finding.file, issue: (finding.issue || '').substring(0, 100),
          });
          continue;
        }
      }

      validated.push(finding);
    }

    if (validated.length < findings.length) {
      log.info('Review findings filtered', {
        taskId: task.id, original: findings.length, validated: validated.length,
        discarded: findings.length - validated.length,
      });
    }

    return validated;
  }

  let heartbeatInterval = null;
  const HEARTBEAT_INTERVAL_MS = config.tasks.heartbeatIntervalMs;
  const planningTasksInFlight = new Set();
  const auditTasksInFlight = new Set(); // prevents double review dispatch (heartbeat + completion chain)
  const deferralNotified = new Set(); // U6: dedupe the "planning queued" notice so it posts once per deferral, not every retry tick
  const planningEmptyDefers = new Map(); // #110: taskId → consecutive empty-planner-output deferrals (fail after 3)
  const idleStrategistKickAt = new Map(); // projectId -> timestamp ms
  const IDLE_STRATEGIST_KICK_THROTTLE_MS = Math.max(30_000, HEARTBEAT_INTERVAL_MS * 2);

  /** Pick the best available non-governor agent for a reflection call (architects first). */
  function selectArchitectForReflection() {
    const candidates = Object.entries(agents).filter(([id, a]) => {
      if (a.status === 'inactive') return false;
      if (busyAgents.has(id)) return false;
      if (isAgentCoolingDown(id)) return false;
      if (circuitBreaker && !circuitBreaker.canRequest(id)) return false;
      if (a.role === 'governor') return false;
      return true;
    });
    candidates.sort(([idA, aA], [idB, aB]) => {
      const pri = (_id, a) => a.role === 'architect' && a.provider === 'claude' ? 0 : a.role === 'architect' ? 1 : a.provider === 'claude' ? 2 : 3;
      return pri(idA, aA) - pri(idB, aB);
    });
    return candidates[0] || null; // [agentId, agentObj]
  }

  /**
   * Ask an architect to diagnose a terminally-failed subtask and optionally reformulate it.
   * Guards against re-entry via subtask.meta.reflectionAttempted.
   * Returns { correction, newText, architectId } or null.
   */
  async function reflectOnTerminalSubtask(projectId, taskId, subtask, failureError) {
    if (subtask.meta?.reflectionAttempted) return null;

    // Mark attempted BEFORE the call to prevent re-entry on crash recovery
    taskManager.updateSubtask(projectId, taskId, subtask.id,
      { meta: { reflectionAttempted: true } }, 'system');

    const candidate = selectArchitectForReflection();
    if (!candidate) return null;
    const [architectId, architectAgent] = candidate;

    const allFailed = subtask.failedProviders || [];
    const prompt = [
      'DIAGNOSTIC REQUEST: A subtask has exhausted all AI providers without success.',
      '',
      `SUBTASK: ${subtask.text}`,
      `FAILED PROVIDERS: ${allFailed.join(', ') || 'unknown'}`,
      `FAILURE EVIDENCE: ${(failureError || 'Empty response').substring(0, 400)}`,
      '',
      'In 3-5 sentences:',
      '1. What is the most likely root cause of these failures?',
      '2. Is there a fundamentally different approach that would succeed?',
      '   If yes — give the corrected subtask description (one actionable sentence).',
      '   If no — explain why this cannot be automated.',
      '',
      'FORMAT your response as:',
      'ROOT CAUSE: <diagnosis>',
      'APPROACH: <corrected subtask text OR "Cannot be automated — <reason>">',
    ].join('\n');

    try {
      const result = await Promise.race([
        getAgentResponse(architectId, architectAgent, projectId, null, prompt, null, null,
          { silent: true, maxTurns: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('reflection_timeout')), 30_000)),
      ]);

      if (!result?.trim()) return null;

      const rootCauseMatch = result.match(/ROOT CAUSE:\s*(.+?)(?=APPROACH:|$)/si);
      const approachMatch  = result.match(/APPROACH:\s*(.+)/si);
      const correction = rootCauseMatch?.[1]?.trim() || String(result).substring(0, 300);
      const approach   = approachMatch?.[1]?.trim() || null;
      const cannotAutomate = approach && /cannot be automated/i.test(approach);
      const newText = (approach && !cannotAutomate && approach.length > 20 && approach.length < 500)
        ? approach : null;

      log.info('Reflection completed', { subtaskId: subtask.id, architectId, hasNewApproach: !!newText });
      return { correction, newText, architectId };
    } catch (err) {
      log.warn('Reflection failed or timed out', { subtaskId: subtask.id, error: err.message });
      return null;
    }
  }

  /** Plan a task: use architect agent to decompose into subtasks. */
  async function planTask(task, taskSpan = null) {
    const { project: projectId, channel: channelId, id: taskId } = task;
    if (planningTasksInFlight.has(taskId)) {
      log.info('Task planning already in flight, skipping duplicate plan attempt', { taskId, projectId });
      return false;
    }
    planningTasksInFlight.add(taskId);
    try {
      // OTel: Add planning start event
      if (taskSpan) {
        addSpanEvent(taskSpan, 'task_planning_start', { status: 'planning' });
      }

    // Verbatim one-shot tasks are pre-planned by construction (the single
    // subtask IS the vision text). Never send them through an LLM planner —
    // that would rewrite the prompt and break A/B parity.
    const hasVerbatimSubtask = task.subtasks?.some(s =>
      s.meta?.verbatim === true &&
      (s.status === 'queued' || s.status === 'claimed' || s.status === 'executing')
    );
    if (hasVerbatimSubtask) {
      taskManager.updateTaskStatus(projectId, taskId, 'executing', 'system', 'Verbatim one-shot: subtask pre-planned, skipping planner');
      if (taskSpan) {
        addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'executing' });
        endSpan(taskSpan, { success: true });
      }
      return false;
    }

    // Check if this is a Socratic campaign task - handle specially
    const isSocraticTask = detectSocraticTask(task, campaignManager);
    
    if (isSocraticTask) {
      log.info('Detected Socratic task - executing specialized research flow', { taskId, projectId, campaignId: task.campaignId });
      
      // Skip if task already has actionable subtasks
      const hasActionableSubtasks = task.subtasks?.some(s => s.status === 'queued' || s.status === 'executing' || s.status === 'claimed');
      if (hasActionableSubtasks) {
        log.info('Socratic task already has subtasks, skipping re-plan', { taskId: task.id, count: task.subtasks.length });
        taskManager.updateTaskStatus(projectId, taskId, 'executing', 'system', 'Already has subtasks');
        if (taskSpan) {
          addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'executing' });
          endSpan(taskSpan, { success: true });
        }
        return false;
      }

// Execute Socratic research pipeline
       try {
        const deps = {
          campaignManager,
          learningsManager,
          timelineStore: null,
          patternScanner: null,
          projectsDir: stateManager?.projectsDir,
        };

        const savedState = deps.projectsDir 
          ? (await import('./socratic-agent.js'))._loadState(deps.projectsDir, projectId, task.id)
          : null;

        const resumingMessage = savedState 
          ? ` (resuming from phase: ${savedState.currentPhase})` 
          : '';

        addMessage(projectId, channelId, 'System',
          `Planning Socratic task: **${task.title}**\nExecuting research pipeline...${resumingMessage}`, 'system');

        const researchResult = await executeSocraticResearch(task, deps);

        // Check for errors in research execution
        if (researchResult.errors.length > 0) {
          log.warn('Socratic research had errors', { taskId, errors: researchResult.errors });
          taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', 
            `Socratic research failed: ${researchResult.errors.join('; ')}`);
          if (taskSpan) {
            addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'failed' });
            endSpan(taskSpan, { success: false, error: new Error(researchResult.errors[0]) });
          }
          return false;
        }

        // Validate output
        if (!researchResult.output || !researchResult.output.validation.valid) {
          log.warn('Socratic research output validation failed', { taskId, 
            validationError: researchResult.output?.validation?.error });
          taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', 
            'Socratic research output validation failed');
          if (taskSpan) {
            addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'failed' });
            endSpan(taskSpan, { success: false, error: new Error('Validation failed') });
          }
          return false;
        }

        // Update task status based on research completion
        const questionCount = researchResult.output.questions?.length || 0;
        log.info('Socratic research completed', { 
          taskId, 
          questionCount,
          researchSummary: researchResult.output.researchSummary 
        });

        addMessage(projectId, channelId, 'System',
          `Socratic task planned with ${questionCount} questions generated.`, 'system');

        if (taskSpan) {
          addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'executing' });
          endSpan(taskSpan, { success: true });
        }

        // Task is now executing - agents will pick up any subtasks if needed
        return true;

      } catch (err) {
        log.error('Socratic research execution failed', { taskId, error: err.message, stack: err.stack });
        taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', 
          `Socratic research error: ${err.message}`);
        if (taskSpan) {
          addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'failed' });
          endSpan(taskSpan, { success: false, error: err });
        }
        return false;
      }
    }

    // Skip if task already has actionable subtasks (prevents duplicate decomposition)
    const hasActionableSubtasks = task.subtasks?.some(s => s.status === 'queued' || s.status === 'executing' || s.status === 'claimed');
    if (hasActionableSubtasks) {
      log.info('Task already has subtasks, skipping re-plan', { taskId: task.id, count: task.subtasks.length });
      taskManager.updateTaskStatus(projectId, taskId, 'executing', 'system', 'Already has subtasks');
      if (taskSpan) {
        addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'executing' });
        endSpan(taskSpan, { success: true });
      }
      return false;
    }

    addMessage(projectId, channelId, 'System',
      `Planning task: **${task.title}**\nDecomposing into subtasks...`, 'system');

    const isDaemon = task.type === 'daemon';
    const cycleNum = isDaemon ? (task.daemon?.cycleCount || 0) + 1 : 0;

    // Build enriched context — matching the pattern from strategist.js milestone decomposition
    const vision = stateManager.getProjectVision ? stateManager.getProjectVision(projectId) : null;
    const campaignCtx = (task.campaignId && campaignManager)
      ? campaignManager.formatCampaignContext(projectId, task.campaignId)
      : null;
    const learningsCtx = learningsManager
      ? learningsManager.buildDecompositionContext(projectId)
      : '';

    const planPrompt = [
      'You are a task planner. Before decomposing, read the relevant source files in the working',
      'directory to understand what already exists. Then decompose into concrete, actionable subtasks.',
      '',
      'Each subtask should reference specific files/modules where the work happens.',
      'Each subtask should be completable by a single agent in one session.',
      isDaemon ? `This is a DAEMON (recurring) task — cycle ${cycleNum}. Design subtasks for ONE cycle.` : '',
      isDaemon && cycleNum > 1 ? `Previous cycles have run ${cycleNum - 1} times. Adapt if needed.` : '',
      '',
      // Inject enriched context
      vision ? `=== PROJECT VISION ===\n${vision}\n` : '',
      campaignCtx ? `=== CAMPAIGN CONTEXT ===\n${campaignCtx}\n` : '',
      learningsCtx || '',
      '=== TASK ===',
      `Title: ${task.title}`,
      task.description !== task.title ? `Description: ${task.description}` : '',
      task.doneCriteria ? `Done criteria: ${task.doneCriteria}` : '',
      task.context ? `Context: ${task.context}` : '',
      isDaemon && task.plan ? `Previous plan (for reference): ${task.plan}` : '',
      '',
      'RESPOND WITH ONLY a JSON array of subtask objects. Each object has:',
      '- "text": what to do (concrete action, naming the exact file path(s) it touches — a subtask',
      '  without a concrete path sends its agent searching the tree instead of working)',
      '- "role": who should do it — "implementer" (write/create/extract/wire code), "reviewer" (audit/verify/test quality), "architect" (design/plan complex systems), "researcher" (investigate/compare/explore)',
      '- "complexity": how hard — "low" (straightforward, mechanical), "medium" (requires judgment), "high" (requires deep expertise or multi-file reasoning)',
      '',
      'Example:',
      '[{"text": "Audit the imports of src/report/generator.js and list unused dependencies in docs/audit.md", "role": "reviewer", "complexity": "medium"},',
      ' {"text": "Extract the date helpers from src/report/generator.js into src/utils/dates.js", "role": "implementer", "complexity": "low"},',
      ' {"text": "Design the new export API in docs/design/export-api.md, covering src/api/routes.js integration", "role": "architect", "complexity": "high"},',
      ' {"text": "Write tests in test/utils-dates.test.js for the extracted src/utils/dates.js", "role": "implementer", "complexity": "medium"}]',
      '',
      'Route implementer work as low/medium unless it truly requires deep reasoning.',
      'Keep subtasks concrete and ordered. 3-8 subtasks typical.',
    ].filter(Boolean).join('\n');

    // Pick planner via the role/provider preference ladder (see orderPlannerCandidates).
    // Use shared availability semantics: active + not cooling down + circuit breaker closed + not busy.
    // busyAgents must be included — without it, multiple concurrent planning attempts all select the
    // same preferred architect, spawning N processes simultaneously → SIGTERM.
    const availableAll = filterEligibleAgentEntries(agents, { isAgentCoolingDown, circuitBreaker, busyAgents });
    // Roster is enforced at EVERY dispatch stage, planning included — the
    // pickup and review paths already filter, but the planner ladder chose
    // from the global pool and let an off-roster agent plan a pinned
    // project (settings-pass finding F10: codex planned a claude-only
    // project). An empty rostered pool defers planning (requeue below),
    // same as no-agents-available.
    const projectRosterSpec = stateManager.getProject(projectId)?.agents;
    // Governors never plan (same rule as pickup/reflection) — the ladder
    // let a governor check out planning cookies (F10b: warden planned
    // conc-b twice). Applies even when the governor is on the roster.
    const available = availableAll.filter(([id, a]) =>
      a.role !== 'governor' && rosterAllowsAgentAnyRole(projectRosterSpec, id, a));
    const eligible = hasPermission
      ? available.filter(([id]) => hasPermission(id, 'task:plan'))
      : available;
    const plannerPool = eligible.length > 0 ? eligible : available;
    const orderedPlannerCandidates = orderPlannerCandidates(plannerPool);
    if (orderedPlannerCandidates.length === 0) {
      // Don't fail — revert to queued so retry isn't burned
      taskManager.updateTaskStatus(projectId, taskId, 'queued', 'system', 'Planning deferred: no agents available');
      // U6: post the notice once per deferral, not on every retry tick.
      if (!deferralNotified.has(taskId)) {
        deferralNotified.add(taskId);
        addMessage(projectId, channelId, 'System', `Planning “${task.title}” is queued — waiting for an available agent. It will start automatically.`, 'system');
      }
      return;
    }
    // Planning is proceeding — allow a fresh notice if it ever defers again.
    deferralNotified.delete(taskId);

    const workingDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
    const planTimeout = config.tasks.planningTimeoutMs;
    const planMaxTurns = config.tasks.planningMaxTurns;
    let lastPlannerFailure = null;
    let cooldownDefer = null; // soonest retry among rate-limited planners if all fallbacks are exhausted

    for (let i = 0; i < orderedPlannerCandidates.length; i++) {
      const [plannerId, planner] = orderedPlannerCandidates[i];
      if (isAgentPlanningNow(plannerId)) {
        const hasNonThinkingAlternative = orderedPlannerCandidates.some(([otherId]) =>
          otherId !== plannerId && !isAgentPlanningNow(otherId)
        );
        if (hasNonThinkingAlternative) {
          log.info('Planner is already thinking on another task; trying non-thinking fallback', {
            taskId, plannerId, attempt: i + 1,
          });
          continue;
        }
      }
      const canBypass = canBypassPermissions ? canBypassPermissions(plannerId) : true;
      const plannerProvider = planner.provider || plannerId;
      let acquiredPlannerSlot = false;
      if (!tryAcquirePlannerProviderSlot(plannerProvider)) {
        log.info('Planner provider concurrency cap reached; trying fallback', {
          taskId, plannerId, provider: plannerProvider, attempt: i + 1,
        });
        continue;
      }
      acquiredPlannerSlot = true;
      agentCookies.checkout(plannerId, { type: 'planning', projectId, taskId });
      const thinkingKey = `${projectId}#${channelId}#${plannerId}`;
      setAgentThinking(thinkingAgents, thinkingKey);
      broadcastToChannel(projectId, channelId, { type: 'status', speaker: plannerId, status: 'thinking' });
      try {
        const response = await withTimeout(
          planner.send(planPrompt, workingDir, { maxTurns: planMaxTurns, bypassPermissions: canBypass }),
          planTimeout, planner.name
        );
        if (response && MODEL_NOT_FOUND_RE && MODEL_NOT_FOUND_RE.test(response)) {
          log.error('Planner model not found — config error', { taskId, plannerId, attempt: i + 1 });
          // plannerProvider, not plannerId: a bare string key is PROVIDER scope in
          // the breaker, so the agent id minted a phantom provider entry that
          // gated nothing (canRequest resolves agents to agent scope + real
          // provider) and polluted status/persisted state. Provider scoping
          // matches the execution-path sites for the same failure classes.
          if (circuitBreaker) circuitBreaker.recordFailure(plannerProvider, null, 'auth_error');
          continue;
        }
        if (response && RATE_LIMIT_RE.test(response)) {
          const mins = setAgentCooldown(plannerId, response);
          if (circuitBreaker) circuitBreaker.recordFailure(plannerProvider, null, 'rate_limit');
          if (!cooldownDefer || mins < cooldownDefer.mins) cooldownDefer = { plannerId, mins };
          log.warn('Planner rate limited; trying fallback', { taskId, plannerId, mins, attempt: i + 1 });
          continue;
        }

        const parsed = parseStructuredJson(response, 'array');
        if (!parsed.ok && parsed.reason === 'not_found') {
          lastPlannerFailure = { kind: 'no_structured_output', plannerId, response };
          log.warn('Planner returned no structured output; trying fallback', { taskId, plannerId, attempt: i + 1 });
          continue;
        }

        if (!parsed.ok) {
          lastPlannerFailure = { kind: 'invalid_json', plannerId, response };
          log.warn('Planner returned invalid JSON; trying fallback', { taskId, plannerId, attempt: i + 1 });
          continue;
        }
        let subtasks = parsed.value;

        if (!Array.isArray(subtasks) || subtasks.length === 0) {
          lastPlannerFailure = { kind: 'empty_subtask_list', plannerId, response };
          log.warn('Planner returned empty subtask list; trying fallback', { taskId, plannerId, attempt: i + 1 });
          continue;
        }

        // Normalize: support both string arrays (legacy) and object arrays (new structured format)
        subtasks = subtasks.map(s => {
          if (typeof s === 'string') return { text: s, role: null, complexity: 'medium' };
          return { text: s.text || String(s), role: s.role || null, complexity: s.complexity || 'medium' };
        });

        const planText = subtasks.map((s, idx) => {
          const tag = s.role ? ` [${s.role}/${s.complexity}]` : '';
          return `${idx + 1}. ${s.text}${tag}`;
        }).join('\n');
        // TaskManager doesn't expose `_save` — only `_saveWithRetry`. Earlier
        // code referenced the wrong method name and silently failed planning.
        taskManager._saveWithRetry(projectId, (d) => {
          const taskObj = d.tasks.find(t => t.id === taskId);
          if (taskObj) {
            taskObj.plan = planText;
            taskObj.updatedAt = new Date().toISOString();
          }
          return d;
        });

        planningEmptyDefers.delete(taskId); // planning succeeded — reset the empty-output deferral count
        taskManager.addSubtasks(projectId, taskId, subtasks, planner.name);
        taskManager.updateTaskStatus(projectId, taskId, 'executing', 'system', 'Planning complete');

        // Multi-agent deliberation: initialize session if task has multiple agents
        if (deliberationCoordinator) {
          const freshTask = taskManager.getTask(projectId, taskId);
          const taskCategory = freshTask?.taskCategory || freshTask?.category || null;

          if (taskCategory === 'architecture_decision') {
            const topicText = [
              freshTask?.title,
              freshTask?.description,
              freshTask?.context,
            ].filter(Boolean).join('\n');
            const domainTags = extractDomainTags(topicText);
            const keywordTags = (topicText.toLowerCase().match(/[a-z][a-z0-9_:-]{3,}/g) || [])
              .filter(t => t.length <= 24);
            const topicKeywords = Array.from(new Set([...domainTags, ...keywordTags]));
            const deliberationTags = ['deliberation', 'multi-agent', 'consensus', 'architecture', 'design'];

            const availableEntries = filterEligibleAgentEntries(agents, { isAgentCoolingDown, circuitBreaker, busyAgents });
            const eligibleEntries = hasPermission
              ? availableEntries.filter(([id]) => hasPermission(id, 'task:execute'))
              : availableEntries;
            const candidateEntries = (eligibleEntries.length > 0 ? eligibleEntries : availableEntries)
              .filter(([id, a]) => a && a.role !== 'governor');

            const boostFactor = config.tasks?.deliberation?.memoryBoostFactor ?? 1.0;

            const scoredCandidates = candidateEntries.map(([agentId, agent]) => {
              let relevanceScore = 0;
              let matchCount = 0;
              if (topicKeywords.length > 0 && agentMemoryStore?.queryExpertiseForTopic) {
                try {
                  const result = agentMemoryStore.queryExpertiseForTopic(agentId, topicKeywords);
                  if (typeof result === 'number') relevanceScore = result;
                  else if (result && typeof result.score === 'number') relevanceScore = result.score;
                  else if (result && typeof result.relevanceScore === 'number') relevanceScore = result.relevanceScore;
                  else if (result && typeof result.matchCount === 'number') matchCount = result.matchCount;
                } catch (err) {
                  log.warn('Architecture decision memory query failed', { taskId, projectId, agentId, error: err.message });
                }
              } else if (topicKeywords.length > 0 && agentMemoryStore?.query) {
                const expertise = agentMemoryStore.query(agentId, { tags: topicKeywords, category: 'expertise', limit: 5 });
                const experience = agentMemoryStore.query(agentId, { tags: topicKeywords, category: 'experience', limit: 5 });
                const deliberation = agentMemoryStore.query(agentId, { tags: deliberationTags, limit: 5 });
                const combined = [...expertise, ...experience, ...deliberation];
                matchCount = combined.length;
                if (combined.length > 0) {
                  const confidenceSum = combined.reduce((sum, rec) => {
                    const c = typeof rec.confidence === 'number' ? rec.confidence : 0.5;
                    return sum + c;
                  }, 0);
                  relevanceScore = Math.min(1, confidenceSum / (combined.length * 1.2));
                }
              }
              const weight = 1 + relevanceScore * boostFactor;
              return { agentId, provider: agent?.provider || null, weight, relevanceScore, matchCount };
            });

            const ranked = scoredCandidates
              .sort((a, b) => (b.weight - a.weight) || a.agentId.localeCompare(b.agentId));
            const selectedAgents = ranked.slice(0, Math.min(3, ranked.length)).map(r => r.agentId);

            if (selectedAgents.length >= 2) {
              try {
                const { sessionId } = deliberationCoordinator.initSession(
                  taskId,
                  selectedAgents,
                  freshTask.title || freshTask.description || 'Architecture decision',
                  {
                    projectId,
                    timeoutMs: 900000, // 15 minutes
                    maxTurns: 20,
                    consensusThreshold: Math.ceil(selectedAgents.length / 2), // Majority
                    minMessages: 3,
                  }
                );

                // Persist deliberation configuration on task
                taskManager._saveWithRetry(projectId, (d) => {
                  const taskObj = d.tasks.find(t => t.id === taskId);
                  if (taskObj) {
                    taskObj.deliberation = {
                      enabled: true,
                      sessionId,
                      assignedAgents: selectedAgents,
                      minMessages: 3,
                    };
                    taskObj.updatedAt = new Date().toISOString();
                  }
                  return d;
                });

                // Tag subtasks with deliberation session id
                const updatedTask = taskManager.getTask(projectId, taskId);
                (updatedTask?.subtasks || []).forEach(st => {
                  try {
                    taskManager.updateSubtask(projectId, taskId, st.id, {
                      meta: { deliberationSessionId: sessionId },
                    }, 'system');
                  } catch (err) {
                    log.warn('Failed to tag subtask with deliberation session', {
                      taskId, projectId, subtaskId: st.id, error: err.message,
                    });
                  }
                });

                log.info('Initialized architecture_decision deliberation session', {
                  taskId, projectId, sessionId,
                  participants: selectedAgents.length,
                  agents: selectedAgents,
                  topicKeywordsCount: topicKeywords.length,
                });

                addMessage(projectId, channelId, 'System',
                  `Architecture decision deliberation enabled: ${selectedAgents.length} agents (${selectedAgents.join(', ')}) selected based on memory + routing weights.`, 'system');
              } catch (err) {
                // Non-blocking: log error but continue task execution
                log.warn('Failed to initialize architecture_decision deliberation session', {
                  taskId, projectId, error: err.message,
                });
              }
            } else {
              log.warn('Architecture decision deliberation skipped: insufficient eligible agents', {
                taskId, projectId, eligibleAgents: ranked.length,
              });
            }
          } else {
            const assignedAgents = [...new Set(
              freshTask.subtasks
                ?.map(s => s.assignee)
                .filter(Boolean) || []
            )];

            if (assignedAgents.length >= 2) {
              try {
                const { sessionId } = deliberationCoordinator.initSession(
                  taskId,
                  assignedAgents,
                  freshTask.title,
                  {
                    projectId,
                    timeoutMs: 600000, // 10 minutes
                    maxTurns: 20,
                    consensusThreshold: Math.ceil(assignedAgents.length / 2), // Majority
                  }
                );
                log.info('Initialized deliberation session for multi-agent task', {
                  taskId, projectId, sessionId,
                  participants: assignedAgents.length,
                  agents: assignedAgents,
                });
                addMessage(projectId, channelId, 'System',
                  `Multi-agent deliberation enabled: ${assignedAgents.length} agents (${assignedAgents.join(', ')}) will collaborate on this task.`, 'system');
              } catch (err) {
                // Non-blocking: log error but continue task execution
                log.warn('Failed to initialize deliberation session', {
                  taskId, projectId, error: err.message,
                });
              }
            }
          }
        }

        // Task is now executing — agents' idle loops (10s staggered) will pick up the
        // first subtask naturally. No broadcast needed; that's the pull model.

        addMessage(projectId, channelId, 'System',
          `Task planned with ${subtasks.length} subtasks:\n${planText}\n\nExecution starting...`, 'system');
        if (taskSpan) {
          addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'executing' });
          endSpan(taskSpan, { success: true });
        }
        return true;
      } catch (err) {
        if (MODEL_NOT_FOUND_RE && MODEL_NOT_FOUND_RE.test(err.message)) {
          log.error('Planner model not found — config error', { taskId, plannerId, error: err.message.slice(0, 200), attempt: i + 1 });
          // plannerProvider, not plannerId: a bare string key is PROVIDER scope in
          // the breaker, so the agent id minted a phantom provider entry that
          // gated nothing (canRequest resolves agents to agent scope + real
          // provider) and polluted status/persisted state. Provider scoping
          // matches the execution-path sites for the same failure classes.
          if (circuitBreaker) circuitBreaker.recordFailure(plannerProvider, null, 'auth_error');
          continue;
        }
        if (RATE_LIMIT_RE.test(err.message)) {
          const mins = setAgentCooldown(plannerId, err.message);
          if (circuitBreaker) circuitBreaker.recordFailure(plannerProvider, null, 'rate_limit');
          if (!cooldownDefer || mins < cooldownDefer.mins) cooldownDefer = { plannerId, mins };
          log.warn('Planner error matched rate limit; trying fallback', { taskId, plannerId, mins, attempt: i + 1 });
          continue;
        }
        if (/already has an active process|per-agent exclusivity/i.test(err.message || '')) {
          log.info('Planner is busy with another active process; trying fallback', {
            taskId, plannerId, attempt: i + 1,
          });
          continue;
        }
        lastPlannerFailure = { kind: 'planner_error', plannerId, error: err };
        log.warn('Planner failed; trying fallback', { taskId, plannerId, error: err.message, attempt: i + 1 });
      } finally {
        agentCookies.checkin(plannerId);
        setAgentIdle(thinkingAgents, thinkingKey);
        if (acquiredPlannerSlot) releasePlannerProviderSlot(plannerProvider);
      }
    }

    if (cooldownDefer && !lastPlannerFailure) {
      deferTaskForCooldown(projectId, channelId, taskId, task.title, cooldownDefer.plannerId, cooldownDefer.mins, 'Task planning deferred');
      return;
    }

    if (lastPlannerFailure?.kind === 'no_structured_output') {
      // Transient-empty deferral (#110): empty planner output is usually
      // contention, not capability — observed 2026-08-12 when a post-restart
      // planning burst exhausted every candidate in 219ms and FAILED tasks
      // that a retry minutes later planned fine. Defer (the treatment the
      // no-planner and rate-limit cases already get) up to 3 times before
      // the terminal fail, so persistent planner breakage still surfaces.
      const emptyCount = (planningEmptyDefers.get(taskId) || 0) + 1;
      if (emptyCount <= 3) {
        planningEmptyDefers.set(taskId, emptyCount);
        const untilIso = new Date(Date.now() + 2 * 60_000).toISOString();
        taskManager.deferTask(projectId, taskId, untilIso, 'system',
          `Planning deferred: planners returned no plan (attempt ${emptyCount}/3, retrying in 2m)`);
        addMessage(projectId, channelId, 'System',
          `Couldn’t break “${task.title}” into steps just yet — retrying in 2 minutes (${emptyCount}/3).`, 'system');
        if (taskSpan) {
          addSpanEvent(taskSpan, 'task_planning_deferred', { reason: 'no_structured_output', attempt: emptyCount });
          endSpan(taskSpan, { success: false });
        }
        return false;
      }
      planningEmptyDefers.delete(taskId);
      taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', 'Planning failed: no structured output');
      addMessage(projectId, channelId, 'System',
        `Couldn’t break “${task.title}” into steps just yet — it will be retried automatically.`, 'system');
      if (taskSpan) {
        addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'failed' });
        addSpanEvent(taskSpan, 'task_planning_failed', { reason: 'no_structured_output' });
        endSpan(taskSpan, { success: false, error: new Error('No structured output') });
      }
      return false;
    }
    if (lastPlannerFailure?.kind === 'invalid_json') {
      taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', 'Planning failed: invalid JSON');
      addMessage(projectId, channelId, 'System', `Couldn’t break “${task.title}” into steps just yet — it will be retried automatically.`, 'system');
      if (taskSpan) {
        addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'failed' });
        addSpanEvent(taskSpan, 'task_planning_failed', { reason: 'invalid_json' });
        endSpan(taskSpan, { success: false, error: new Error('Invalid JSON') });
      }
      return false;
    }
    if (lastPlannerFailure?.kind === 'empty_subtask_list') {
      taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', 'Planning failed: empty subtask list');
      addMessage(projectId, channelId, 'System', `Couldn’t break “${task.title}” into steps just yet — it will be retried automatically.`, 'system');
      if (taskSpan) {
        addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'failed' });
        addSpanEvent(taskSpan, 'task_planning_failed', { reason: 'empty_subtask_list' });
        endSpan(taskSpan, { success: false, error: new Error('Empty subtask list') });
      }
      return false;
    }
    if (lastPlannerFailure?.kind === 'planner_error') {
      taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', `Planning error: ${lastPlannerFailure.error.message}`);
      addMessage(projectId, channelId, 'System', `Task planning error: ${lastPlannerFailure.error.message}`, 'system');
      if (taskSpan) {
        addSpanEvent(taskSpan, 'task_status_change', { from: 'planning', to: 'failed' });
        addSpanEvent(taskSpan, 'task_planning_failed', { reason: 'planner_error', error: lastPlannerFailure.error.message });
        endSpan(taskSpan, { success: false, error: lastPlannerFailure.error });
      }
      return false;
    }

    log.info('Planning attempt exhausted without hard failure; keeping task in planning for retry', {
      taskId, projectId,
    });
    return false;
    } finally {
      planningTasksInFlight.delete(taskId);
    }
  }


  function shouldClearFailedProvidersExclusion(subtask) {
    if (!subtask || subtask.status !== 'queued') return false;
    const failedProviders = Array.isArray(subtask.failedProviders)
      ? subtask.failedProviders.filter(Boolean)
      : [];
    if (failedProviders.length === 0) return false;

    // Use "eligible right now" semantics (cooldowns + circuit breaker aware),
    // not just static active status, to avoid deadlocks on long provider cooldowns.
    const eligibleProviders = new Set();
    for (const [id, agent] of Object.entries(agents || {})) {
      if (!agent) continue;
      if (!isAgentEligibleNow(agents, id, { isAgentCoolingDown, circuitBreaker })) continue;
      if (!canRoleHandleSuggestedRole(agent.role, subtask.suggestedRole || null)) continue;
      eligibleProviders.add(agent.provider || id);
    }
    if (eligibleProviders.size === 0) return false;

    const failedSet = new Set(failedProviders);
    return [...eligibleProviders].every(provider => failedSet.has(provider));
  }

  function _canAgentHandleRole(agentId, neededRole) {
    const agentRole = agents[agentId]?.role;
    return canRoleHandleSuggestedRole(agentRole, neededRole);
  }

  // Roster-role authority (#103, operator design): a roster spec's explicit
  // roles entry (e.g. roles.architect naming a local agent) IS the
  // capability grant for that role on that project — the operator's
  // per-project mapping overrides the global role matrix. Without an entry
  // for the role, the global matrix stands.
  function _canAgentHandleRoleForProject(agentId, neededRole, projectId) {
    if (_canAgentHandleRole(agentId, neededRole)) return true;
    if (!projectId) return false;
    // Operator ruling 2026-08-15: a project may opt developers into review
    // (fallback when no reviewer/architect is free). Pull-model grant.
    if (normalizeSuggestedRole(neededRole) === 'reviewer'
        && agents[agentId]?.role === 'developer'
        && stateManager.getProjectReviewDeveloperFallback?.(projectId) === true) return true;
    const spec = stateManager.getProject?.(projectId)?.agents;
    if (!spec || Array.isArray(spec) || !spec.roles) return false;
    const normalized = normalizeSuggestedRole(neededRole);
    if (!normalized || !spec.roles[normalized]) return false;
    return rosterAllowsAgent(spec, agentId, agents[agentId], normalized);
  }

  // Failover follows the operator's priority ranks — the static provider
  // chain table is dead (design addendum, vault/design/project-agent-priority.md):
  //   1. ROSTER IS A HARD BOUNDARY: fallback never leaves the project's
  //      configured agents. A one-agent project has NO fallback — the work
  //      waits for the breaker (operator's stated trade).
  //   2. LOCALS REQUIRE EXPLICIT RANKING: a local-inference agent is
  //      fallback-eligible only when present in the effective ranks —
  //      ranking a local IS the GPU opt-in. Unranked cloud roster agents
  //      stay eligible (roster = configured).
  //   3. Rank-ordering/strict semantics ride routeSubtask (#105): strict
  //      with the top-ranked agent's provider blocked ⇒ null ⇒ defer.
  function selectCircuitBreakerFallback(subtask, blockedProvider, projectId = null) {
    if (!routeSubtask) return null;

    const failedProviders = Array.isArray(subtask?.failedProviders)
      ? subtask.failedProviders.filter(Boolean)
      : [];
    const excludedProviders = new Set([blockedProvider, ...failedProviders].filter(Boolean));
    const priority = stateManager.getEffectiveAgentPriority?.(projectId) ?? null;
    const rankedIds = new Set(priority?.ranks || []);
    const rosterSpec = stateManager.getProject?.(projectId)?.agents ?? null;

    const pool = Object.entries(agents || {})
      .filter(([id, agent]) =>
        agent
        && !excludedProviders.has(agent.provider || id)
        && (!rosterSpec || rosterAllowsAgentAnyRole(rosterSpec, id, agent))
        && (!isLocalInference(agent) || rankedIds.has(id))
        && isAgentEligibleNow(agents, id, { isAgentCoolingDown, circuitBreaker, busyAgents })
      )
      .map(([id]) => id);
    if (pool.length === 0) return null;

    const eligible = filterByPermission
      ? filterByPermission(pool, 'task:execute', agents)
      : pool;
    if (eligible.length === 0) return null;

    const roleMatchedAgents = eligible.filter(id =>
      _canAgentHandleRoleForProject(id, subtask.suggestedRole || null, projectId)
    );
    const candidatePool = roleMatchedAgents.length > 0 ? roleMatchedAgents : eligible;
    const fallbackAgentId = routeSubtask(
      subtask.text,
      candidatePool,
      agents,
      {
        complexity: subtask.complexity || 'medium',
        suggestedRole: subtask.suggestedRole || null,
        failedProviders: [...excludedProviders],
      },
      filterByPermission,
      config.tasks,
      scoreboard,
      [],
      null,
      isAgentCoolingDown,
      circuitBreaker,
      busyAgents,
      priority,
    );
    if (!fallbackAgentId) return null;
    return {
      agentId: fallbackAgentId,
      provider: agents[fallbackAgentId]?.provider ?? fallbackAgentId,
      chain: priority?.ranks ?? [], // informational: the rank order consulted
      roleMatched: roleMatchedAgents.includes(fallbackAgentId),
    };
  }

  function resolveFallbackExecution(agentId, subtask, projectId = null) {
    if (!subtask?.assignee || subtask.assignee === agentId || !circuitBreaker) return null;
    const blockedProvider = agents[subtask.assignee]?.provider || subtask.assignee;
    if (!blockedProvider || circuitBreaker.canRequestProvider(blockedProvider)) return null;
    const fallback = selectCircuitBreakerFallback(subtask, blockedProvider, projectId);
    if (!fallback || fallback.agentId !== agentId) return null;
    return { ...fallback, blockedProvider };
  }

  /**
   * Agent self-pickup: the agent scans all executing tasks across all projects, finds the
   * first subtask it is eligible to handle, atomically claims it, and executes it.
   *
   * This replaces the dispatcher model (orchestrator picks agent and pushes work).
   * In the pull model agents drive themselves — no burst, no thundering herd.
   *
   * Priority order within each project:
   *   1. Tasks with failed/retried queued subtasks first ("finish before starting new")
   *   2. Oldest startedAt first (pressure focus — longer-running tasks take priority)
   *
   * Ollama is hard-capped at 1 concurrent process (single GPU slot).
   * All other providers are uncapped — the agent's own busy state is the throttle.
   */
  async function seekAndExecute(agentId) {
    const agent = agents[agentId];
    if (!agent) {
      log.debug('seekAndExecute: agent not found', { agentId });
      return false;
    }

    // Don't seek if already busy or ineligible (cooling, circuit open, inactive)
    if (busyAgents.has(agentId)) {
      log.debug('seekAndExecute: agent already busy', { agentId });
      return false;
    }
    const isEligible = isAgentEligibleNow(agents, agentId, { isAgentCoolingDown, circuitBreaker, busyAgents });
    if (!isEligible) {
      log.debug('seekAndExecute: agent not eligible', { agentId, isAgentCoolingDown: isAgentCoolingDown(agentId), canRequest: circuitBreaker ? circuitBreaker.canRequest(agentId) : null });
      return false;
    }

    // Pickup slot check: limit concurrent work-seeking to prevent thundering herd
    // Governors excluded (special handling), cost-tier priority (cheapest first)
    log.debug('About to call tryAcquirePickupSlot', { agentId, busyAgents: !!busyAgents, hasTryAcquire: typeof busyAgents.tryAcquirePickupSlot === 'function' });
    const slotAcquired = busyAgents.tryAcquirePickupSlot(agentId);
    if (!slotAcquired) {
      log.debug('seekAndExecute: no pickup slot available', {
        agentId,
        slotsInUse: busyAgents.getPickupSlotStats().total - busyAgents.getPickupSlotStats().available,
        maxSlots: 3,
      });
      return false;
    }

    // debug, not info: this fires for every eligible agent on every poll tick
    // and was drowning the journal under multi-project load (#15).
    log.debug('seekAndExecute: agent eligible, seeking work', { agentId, provider: agent.provider || agentId, role: agent.role });

    const agentProvider = agent.provider || agentId;

    // Helper to release slot on early exit
    const earlyExit = () => {
      if (agentCookies.hasPickupSlot(agentId)) {
        agentCookies.releasePickupSlot(agentId);
      }
      return false;
    };

    // Every path after slot acquisition must either release the pickup slot or
    // convert it into a regular execution cookie. Individual return sites are
    // deliberately not responsible for cleanup: recovery, circuit-breaker,
    // and exception paths have historically leaked slots and eventually
    // exhausted the global pickup pool.
    try {

    // Ollama: cap at 2 concurrent (configurable via SYNAPSE_SANDBOX_MAX_PER_PROVIDER_OLLAMA),
    // each running llama.cpp --parallel 1 on separate hardware. One slot per machine.
    if (agentProvider === 'ollama') {
      const ollamaBusy = agentCookies.countByProvider('ollama');
      // Guard the sandbox level too: a config without a sandbox section made
      // this line THROW inside seekAndExecute's catch-all — every local
      // agent's pull silently returned false and locals never picked up work.
      if (ollamaBusy >= (config.sandbox?.maxPerProvider?.ollama ?? 2)) return earlyExit();
    }

    // Claude: cap at 4 concurrent (7 non-gov agents; Anthropic Max allows ~3 sessions).
    // SIGTERMs (exit 143) requeue cleanly with 2m cooldown, so marginal overshoot self-recovers.
    if (agentProvider === 'claude') {
      const claudeCap = config.tasks.maxConcurrentPerProvider?.claude ?? 4;
      const claudeBusy = agentCookies.countByProvider('claude');
      if (claudeBusy >= claudeCap) return earlyExit();
    }

    // Pace gate: dispatch rate limiter per provider/model (separate from concurrency gate)
    const agentModel = agent.model || null;
    const paceCheck = isPaceAllowed(agentProvider, agentModel);
    if (!paceCheck.allowed) {
      log.warn('seekAndExecute: pace gate blocking — all agents will retry on next poll', {
        agentId, agentProvider, agentModel,
        used: paceCheck.used, max: paceCheck.max, nextFreeSec: paceCheck.nextFreeSec,
      });
      return earlyExit();
    }

    // Allocation-weighted project order. Per-project agent rosters
    // (RosterSpec: explicit ids, model-tier classes, role matrix — see
    // src/roster.js) gate which projects this agent may work. Any-role
    // check here: a role entry can widen beyond the top-level spec, and
    // the per-subtask role check below does the precise gating.
    const allProjects = stateManager.listProjects()
      .filter(p => (p.allocation ?? 100) > 0)
      .filter(p => rosterAllowsAgentAnyRole(p.agents, agentId, agents[agentId]));
    if (allProjects.length === 0) return earlyExit();
    const totalAlloc = allProjects.reduce((s, p) => s + (p.allocation ?? 100), 0);
    let draw = Math.random() * totalAlloc;
    let primaryProj = allProjects[0];
    for (const p of allProjects) {
      draw -= (p.allocation ?? 100);
      if (draw <= 0) { primaryProj = p; break; }
    }
    const projects = [primaryProj, ...allProjects.filter(p => p.id !== primaryProj.id)];

    for (const proj of projects) {
      const allTasks = taskManager.listTasks(proj.id);
      // Paused campaigns must actually PAUSE: agents kept claiming subtasks
      // of paused campaigns (pause only stopped milestone promotion), which
      // made the operator's pause lever a no-op for in-flight work — and
      // starved every other project of agents.
      const _pausedCache = new Map();
      const _taskCampaignPaused = (t) => {
        if (!t.campaignId) return false;
        if (!_pausedCache.has(t.campaignId)) {
          const c = campaignManager?.getCampaign(proj.id, t.campaignId);
          // Paused blocks; so does a MISSING campaign — deleting a campaign
          // orphaned its tasks and agents kept executing them (the orphans
          // sailed straight past the paused check).
          _pausedCache.set(t.campaignId, !c || c.status === 'paused');
        }
        return _pausedCache.get(t.campaignId);
      };
      const executingTasks = allTasks.filter(t => (t.status === 'executing' || t.status === 'reviewing') && !_taskCampaignPaused(t));
      const queuedTasks = allTasks.filter(t => t.status === 'queued' && !_taskCampaignPaused(t));
      log.debug('seekAndExecute: project task counts', { projectId: proj.id, executing: executingTasks.length, queued: queuedTasks.length });
      // Build a campaign-age cache for this project so the sort doesn't hit campaignManager repeatedly.
      // Campaign 1 (oldest createdAt) always has priority over Campaign 2.
      // When Campaign 1's tasks have no queued subtasks (time-gated), agents naturally skip them
      // and fall through to Campaign 2 — no special logic needed, the sort handles it.
      const campaignAgeCache = new Map();
      const campaignPriorityCache = new Map();
      const getCampaignAge = (task) => {
        if (!task.campaignId) return Infinity;
        if (!campaignAgeCache.has(task.campaignId)) {
          const c = campaignManager?.getCampaign(proj.id, task.campaignId);
          const ageTs = (c?.type === 'evergreen') && c?.cycleHistory?.length > 0
            ? new Date(c.cycleHistory.at(-1).completedAt).getTime()
            : c?.createdAt ? new Date(c.createdAt).getTime() : Infinity;
          campaignAgeCache.set(task.campaignId, ageTs);
        }
        return campaignAgeCache.get(task.campaignId);
      };
      const getCampaignPriority = (task) => {
        if (!task.campaignId) return 3;
        if (!campaignPriorityCache.has(task.campaignId)) {
          const c = campaignManager?.getCampaign(proj.id, task.campaignId);
          campaignPriorityCache.set(task.campaignId, PRIORITY_ORDER[c?.priority] ?? 3);
        }
        return campaignPriorityCache.get(task.campaignId);
      };
      const getMilestonePriority = (task) => {
        if (!task.campaignId || !task.milestoneId) return 3;
        const c = campaignManager?.getCampaign(proj.id, task.campaignId);
        const ms = c?.milestones?.find(m => m.id === task.milestoneId);
        return (ms?.priority && PRIORITY_ORDER[ms.priority] !== undefined) ? PRIORITY_ORDER[ms.priority] : 3;
      };

      const tasks = executingTasks.sort((a, b) => {
        const mpA = Math.min(getCampaignPriority(a), getMilestonePriority(a));
        const mpB = Math.min(getCampaignPriority(b), getMilestonePriority(b));
        if (mpA !== mpB) return mpA - mpB;
        const ageA = getCampaignAge(a);
        const ageB = getCampaignAge(b);
        if (ageA !== ageB) return ageA - ageB;
        const aFail = a.subtasks?.some(s => s.status === 'queued' && (s.error || (s.retryCount ?? 0) > 0)) ? 0 : 1;
        const bFail = b.subtasks?.some(s => s.status === 'queued' && (s.error || (s.retryCount ?? 0) > 0)) ? 0 : 1;
        if (aFail !== bFail) return aFail - bFail;
        const ta = a.startedAt ? new Date(a.startedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const tb = b.startedAt ? new Date(b.startedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return ta - tb;
      });

      for (const task of tasks) {
        const { project: projectId, channel: channelId, id: taskId } = task;
        // Pass agentProvider so getNextSubtask skips subtasks this provider already failed on,
        // allowing the agent to pick up other subtasks in the same task rather than skipping it.
        let subtask = taskManager.getNextSubtask(projectId, taskId, agentProvider);
        if (!subtask) {
          log.debug('seekAndExecute: no queued subtasks', { taskId, projectId });
          continue;
        }
        log.info('seekAndExecute: found queued subtask', {
          taskId,
          projectId,
          subtaskId: subtask.id,
          subtaskStatus: subtask.status,
          suggestedRole: subtask.suggestedRole,
          assignee: subtask.assignee,
        });

        // Role eligibility: can this agent handle this subtask's required role?
        const canHandleRole = _canAgentHandleRoleForProject(agentId, subtask.suggestedRole || null, projectId);
        const fallbackExecution = canHandleRole ? null : resolveFallbackExecution(agentId, subtask, projectId);
        if (!canHandleRole && !fallbackExecution) {
          log.debug('seekAndExecute: agent cannot handle role', { agentId, role: subtask.suggestedRole });
          continue;
        }
        if (fallbackExecution) {
          log.info('seekAndExecute: allowing circuit breaker fallback execution', {
            agentId,
            subtaskId: subtask.id,
            blockedProvider: fallbackExecution.blockedProvider,
            fallbackProvider: fallbackExecution.provider,
            roleMatched: fallbackExecution.roleMatched,
          });
        }

        // Cooldown check: skip if this agent is on cooldown for this subtask
        if (subtask.cooldownUntil && new Date(subtask.cooldownUntil).getTime() > Date.now()) {
          log.debug('seekAndExecute: agent on cooldown for subtask', {
            agentId,
            subtaskId: subtask.id,
            cooldownExpires: subtask.cooldownUntil
          });
          continue;
        }

        // Provider exclusion: skip if this agent's provider already failed on this subtask.
        // If all eligible providers are excluded, auto-clear stale exclusions and retry routing.
        if ((subtask.failedProviders || []).includes(agentProvider)) {
          if (!shouldClearFailedProvidersExclusion(subtask)) continue;
          const clearedAt = new Date().toISOString();
          try {
            taskManager.updateSubtask(projectId, taskId, subtask.id, {
              failedProviders: [],
              error: null,
              updatedAt: clearedAt,
            }, 'system');
            subtask.failedProviders = [];
            subtask.error = null;
            subtask.updatedAt = clearedAt;
            log.info('Cleared stale failedProviders exclusion set during pickup', {
              projectId,
              taskId,
              subtaskId: subtask.id,
              role: subtask.suggestedRole || null,
              provider: agentProvider,
            });
          } catch (err) {
            log.warn('Failed to clear stale failedProviders exclusion set', {
              projectId,
              taskId,
              subtaskId: subtask.id,
              error: err.message,
            });
            continue;
          }
        }

        // Assignee preference: if another eligible agent is explicitly assigned, yield to them.
        // Watchdog first: if the pinned assignee is role-incompatible with this subtask's
        // suggestedRole, clear the assignment — leaving it pinned to a wrong-role agent
        // produces a silent deadlock (no one can claim it, no error surfaces). This catches
        // the case where the cross-provider review selector runs out of reviewer-role agents
        // and pins a developer to a reviewer subtask.
        if (subtask.assignee && subtask.assignee !== agentId) {
          const assigneeRoleOk = _canAgentHandleRole(subtask.assignee, subtask.suggestedRole || null);
          if (!assigneeRoleOk) {
            log.warn('seekAndExecute: clearing role-incompatible assignee', {
              taskId,
              subtaskId: subtask.id,
              suggestedRole: subtask.suggestedRole,
              clearedAssignee: subtask.assignee,
              clearedRole: agents[subtask.assignee]?.role || null,
            });
            try {
              taskManager.updateSubtask(projectId, taskId, subtask.id, { assignee: null }, 'system');
              subtask.assignee = null; // keep local view in sync so the role check below proceeds
            } catch {
              continue; // CAS race — next heartbeat will retry the clearance
            }
          } else if (isAgentEligibleNow(agents, subtask.assignee, { isAgentCoolingDown, circuitBreaker, busyAgents })) {
            continue;
          }
        }

        // Role-scoped roster gating: the project-level filter is any-role;
        // THIS subtask's role decides precise membership ("opus only
        // reviews" must not let opus claim developer subtasks).
        if (!rosterAllowsAgent(stateManager.getProject(projectId)?.agents, agentId, agent, subtask.suggestedRole || 'developer')) {
          continue;
        }

        // Atomic claim via CAS — claimSubtask throws if another agent already claimed it
        // Verbatim one-shot subtasks (A/B parity mode) run effectively uncapped:
        // the outside one-shot has no timeout, so the inside half can't either.
        const isVerbatim = subtask.meta?.verbatim === true;
        // Complexity-scaled window (#110): the flat per-provider timeout kept
        // killing legitimate heavy subtasks (2026-08-10 soak: repeated 600s
        // glm timeouts on test-authoring work). Escalation bumps complexity,
        // so retries of timed-out work automatically earn a longer window.
        const complexityScale = { low: 1, medium: 1.5, high: 2 }[subtask.complexity] || 1;
        const timeout = isVerbatim
          ? config.tasks.oneshotTimeoutMs
          : Math.round((config.tasks.executionTimeouts[agentProvider] || 600000) * complexityScale);
        const leaseTimeoutMs = timeout + 120_000;
        try {
          taskManager.claimSubtask(projectId, taskId, subtask.id, agentId, leaseTimeoutMs);
        } catch {
          continue; // race lost — try next task
        }

        // Circuit breaker check (provider-level) — requeue if provider is OPEN
        if (circuitBreaker && !circuitBreaker.canRequestProvider(agentProvider)) {
          const priorFailures = Array.isArray(subtask.failedProviders) ? subtask.failedProviders : [];
          const failedProviders = Array.from(new Set([...priorFailures, agentProvider]));
          const fallback = selectCircuitBreakerFallback(subtask, agentProvider, projectId);
          // No chain suggestion when the rank-walk found nobody: fallback is
          // roster-bounded now, and naming an off-roster provider in the
          // message would promise a retarget that can never happen.
          const nextProvider = fallback?.provider ?? null;
          const reason = fallback
            ? `Circuit breaker open for ${agentProvider}; requeued to try @${fallback.agentId} on ${fallback.provider}`
            : `Circuit breaker open for ${agentProvider}; waiting for provider recovery (no roster fallback)`;

          taskManager.updateSubtask(projectId, taskId, subtask.id,
            {
              status: 'queued',
              failedProviders,
              assignee: fallback?.agentId ?? null,
              error: reason,
              meta: {
                circuitBreakerFallback: {
                  blockedProvider: agentProvider,
                  nextProvider: nextProvider || null,
                  nextAgentId: fallback?.agentId || null,
                  attemptedAt: new Date().toISOString(),
                },
              },
            }, 'system');
          addMessage(projectId, channelId, 'System',
            `Subtask requeued: "${subtask.text}" — ${reason}`, 'system');
          return true;
        }

        // Claimed. Record pace dispatch + mark executing + add to busy set.
        recordPaceDispatch(agentProvider, agentModel);
        if (eventBus) {
          emitTelemetry(eventBus, 'subtask_claimed', {
            agentId, taskId, projectId, phase: 'subtask_lifecycle',
            payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', status: 'claimed' },
          });
        }
        taskManager.updateSubtask(projectId, taskId, subtask.id, { status: 'executing' }, agentId);
        if (eventBus) {
          emitTelemetry(eventBus, 'subtask_executing', {
            agentId, taskId, projectId, phase: 'subtask_lifecycle',
            payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', status: 'executing' },
          });
        }
        // Release pickup slot - agent now has a regular cookie
        if (agentCookies.hasPickupSlot(agentId)) {
          agentCookies.releasePickupSlot(agentId);
        }
        agentCookies.checkout(agentId, { type: 'executing', projectId, taskId, subtaskId: subtask.id });
        lastNoAgentReport.delete(taskId);

        addMessage(projectId, channelId, 'System',
          `Subtask started: "${subtask.text}" \u2192 @${agentId}`, 'system');

        // ── Execution body ─────────────────────────────────────────────────────────
        const agentRole = subtask.suggestedRole || 'developer';
        // Verbatim one-shot (A/B parity): the agent sees the vision text EXACTLY
        // as an outside `claude -p` run would — no campaign context, no role
        // framing, no vault injection. The prompt is the whole method.
        const taskContext = isVerbatim
          ? subtask.text
          : taskManager.formatForAgentContext(projectId, taskId, subtask.id, campaignManager, learningsManager, vaultQuery, agentRole, agentProvider, agentId, agentMemoryStore);
        const workingDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;

        // Checkout campaign branch if one exists (Phase 1: project lifecycle)
        if (task.campaignId && campaignManager) {
          try {
            const campaign = campaignManager.getCampaign(projectId, task.campaignId);
            if (campaign?.branch) {
              const checkedOut = checkoutBranch(workingDir, campaign.branch);
              if (!checkedOut) {
                throw new Error(`Campaign branch checkout failed: ${campaign.branch}`);
              }
              agentCookies.touchPreparing?.(agentId);
            } else if (campaign) {
              const { createCampaignBranch } = await import('./git-branches.js');
              const taskRepoConfig = stateManager?.getProjectRepoConfig?.(projectId);
              const newBranch = createCampaignBranch(workingDir, task.campaignId, taskRepoConfig);
              if (newBranch) {
                campaignManager.patchCampaign(projectId, task.campaignId, { branch: newBranch });
                log.info('Created missing campaign branch at execution time', {
                  campaignId: task.campaignId, branch: newBranch,
                });
              } else if (taskRepoConfig?.mode !== 'none') {
                throw new Error(`Campaign branch creation failed for ${task.campaignId}`);
              }
            }
          } catch (err) {
            log.error('Blocking subtask because campaign branch is unavailable', {
              campaignId: task.campaignId, error: err.message,
            });
            throw err;
          }
        }

        // BYOH PR workflow Phase 1.3 — auto-open PR on subtask claim.
        // Codex R2 hard requirement: branch + PR exist BEFORE first agent
        // write, not after task completion. Runs after claim succeeds and
        // BEFORE the runtime-guardrails branch check below so that:
        //   1. We can detect "current branch is the protected branch" and
        //      surface a clearer error than the guardrail's generic message.
        //   2. We open the PR while we still know the claiming agent +
        //      task context; deferring this to after dispatch would create
        //      the unreviewed-mutation window R2 flagged.
        // Conservative form (Phase 1.3a): synapse does NOT auto-create the
        // feature branch yet — operator pre-checkouts a non-protected branch
        // for the project. synapse auto-opens the PR for the current branch
        // if enforcePRForAllWrites is true and no open PR exists. Auto-
        // branch-creation lands in Phase 1.5+ along with branch lifecycle.
        try {
          const prRepoCfg = stateManager?.getProjectRepoConfig?.(projectId);
          if (prStore && prRepoCfg?.enforcePRForAllWrites === true) {
            // Read current git branch from the project workingDir
            let currentBranch = null;
            try {
              const { execSync } = await import('child_process');
              currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: workingDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
              }).trim();
            } catch (_) {
              // not a git repo or git unavailable — runtime-guardrails will
              // produce a clearer error below. Don't block here on git lookup.
            }
            if (currentBranch) {
              // Check existing PR for this branch
              const existing = prStore.findOpenPRForBranch(projectId, currentBranch);
              if (!existing) {
                const targetBranch = prRepoCfg.defaultBranch || prRepoCfg.branch || 'main';
                if (currentBranch !== targetBranch) {
                  try {
                    const newPR = prStore.openPR({
                      projectId,
                      sourceBranch: currentBranch,
                      targetBranch,
                      author: agentId,
                      authorRole: agent.role || null,
                      taskIds: [taskId],
                      campaignId: task.campaignId || null,
                      title: subtask.text ? subtask.text.slice(0, 80) : `task ${taskId}`,
                      description: `Auto-opened by lifecycle for subtask ${subtask.id} on claim. Agent: ${agentId}. Branch: ${currentBranch} → ${targetBranch}.`,
                      repoConfig: prRepoCfg,
                    });
                    log.info('Auto-opened PR on subtask claim', {
                      prId: newPR.id, projectId, sourceBranch: currentBranch, targetBranch,
                      agentId, taskId, subtaskId: subtask.id,
                      requiresOperatorApproval: newPR.requiresOperatorApproval,
                    });
                    // Setup still progressing — extend preparing grace so reconcile
                    // does not requeue mid-PR-open / branch work.
                    agentCookies.touchPreparing?.(agentId);
                    addMessage(projectId, channelId, 'System',
                      `PR opened by @${agentId}: ${currentBranch} → ${targetBranch}` +
                      (newPR.requiresOperatorApproval ? ' (requires operator approval to merge)' : ''),
                      'system', { threadId: task.threadId });
                  } catch (prErr) {
                    log.error('Failed to auto-open PR on subtask claim', {
                      projectId, sourceBranch: currentBranch, targetBranch,
                      taskId, subtaskId: subtask.id, error: prErr.message,
                    });
                    // Soft-fail: PR creation failed but runtime-guardrails below
                    // will still enforce branch protection. Don't block dispatch
                    // on PR storage errors — operator can open the PR manually.
                  }
                }
              }
            }
          }
        } catch (err) {
          log.warn('PR auto-open hook errored (non-blocking)', {
            projectId, taskId, subtaskId: subtask.id, error: err.message,
          });
        }

        // Runtime guardrails: block execution on protected branches. Honors
        // the project's repoConfig.mode — when 'none', the guardrail no-ops
        // because the operator has explicitly opted out of git ops.
        try {
          const guardRepoCfg = stateManager?.getProjectRepoConfig?.(projectId);
          const guardResult = runRuntimeGuardrails({
            projectDir: workingDir,
            options: {
              requireNonProtectedBranch: true,
              repoMode: guardRepoCfg?.mode || 'local',
            },
          });
          if (!guardResult.ok) {
            log.error('Runtime guardrail blocked agent execution', {
              agentId, taskId, subtaskId: subtask.id,
              errors: guardResult.errors, branch: guardResult.state?.branch,
            });
            taskManager.updateSubtask(projectId, taskId, subtask.id, {
              status: 'queued',
              error: `Guardrail: ${guardResult.errors.join('; ')}`,
            }, agentId);
            continue;
          }
          if (guardResult.warnings?.length > 0) {
            log.warn('Runtime guardrail warnings', {
              agentId, taskId, warnings: guardResult.warnings,
            });
          }
        } catch (err) {
          log.warn('Runtime guardrail check failed (non-blocking)', {
            error: err.message,
          });
        }

        // Tag subtask with vault attribution for pass/fail analysis
        if (taskContext && taskContext.includes('=== VAULT CONTEXT')) {
          const vaultMatch = taskContext.match(/=== VAULT CONTEXT[\s\S]*?=== END VAULT ===/);
          const vaultChars = vaultMatch ? vaultMatch[0].length : 0;
          try {
            taskManager.updateSubtask(projectId, taskId, subtask.id, {
              meta: { ...subtask.meta, vaultInjected: true, vaultChars },
            }, 'system');
          } catch { /* non-blocking */ }
        }

        const thinkingKey = `${projectId}#${channelId}#${agentId}`;
        setAgentThinking(thinkingAgents, thinkingKey);
        broadcastToChannel(projectId, channelId, { type: 'status', speaker: agentId, status: 'thinking' });
        // Verbatim one-shot: no --max-turns flag at all (cli-runner omits the
        // flag when maxTurns is null), matching the outside one-shot method.
        const maxTurns = isVerbatim ? null : config.tasks.executionMaxTurns;

        const canBypass = canBypassPermissions ? canBypassPermissions(agentId) : true;
        if (config.permissions.auditLog && auditDispatch) {
          auditDispatch(stateManager.projectsDir, projectId, {
            action: 'task_execution', agent: agentId, subtask: subtask.id, bypass: canBypass,
          });
        }

        // ─── Governance file locking ─────────────────────────────────
        let govLocked = [];
        let govHashes = null;
        if (lockGovernanceFiles) {
          govLocked = lockGovernanceFiles(PROJECT_DIR);
          govHashes = hashGovernanceFiles ? hashGovernanceFiles(PROJECT_DIR) : null;
        }

        const dispatchStartTime = Date.now();
        let dispatchSpan = null;
        if (task.taskSpan) {
          dispatchSpan = startSpan('dispatch.agent', {
            agentId,
            provider: agent.provider || 'unknown',
            model: agent.model || 'unknown',
            taskId: task.id,
            subtaskId: subtask.id,
            taskCategory: 'subtask',
            success: false,
            durationMs: 0,
          }, task.taskSpan.spanContext());
        }

        const dispatchTraceId = getTraceId(dispatchSpan);
        if (dispatchLog?.append) {
          await dispatchLog.append({
            taskCategory: 'subtask',
            campaignId: task.campaignId || null,
            milestoneId: task.milestoneId || null,
            taskId: task.id || null,
            subtaskId: subtask.id || null,
            selectedAgent: agentId,
            selectionReason: subtask.assignee === agentId ? 'explicit_assignment' : 'agent_self_pickup',
            candidates: [{ agentId, provider: agent.provider || null, successRate: null, decayedRate: null }],
            constraintsApplied: [],
            weights: [],
            roll: null,
            traceId: dispatchTraceId,
          });
        }

        // Snapshot task state before dispatch — used to rollback on provider errors
        const preDispatchSnapshot = taskManager.snapshotTaskState?.(projectId, taskId) || null;

        // ── Session continuation, per (agent, task, model) ──────────────
        //
        // Decide here, render in buildArgs. A harness whose continuation
        // strategy is not 'session-id-provided' ignores both fields entirely,
        // so this is inert for every harness that has not been wired.
        //
        // GATES, in the order they can disqualify a resume:
        //  1. contextConfig.resume must be enabled for this project (opt-in).
        //  2. NEVER for a verbatim campaign. Verbatim exists to give a clean
        //     one-shot prompt for 1:1 A/B parity; carrying prior context in
        //     would silently invalidate the comparison while leaving the
        //     numbers looking plausible. Highest-consequence gate here.
        //  3. The prior session's RESOLVED MODEL must match the model about to
        //     run. Replaying one model's history on another is not a resume.
        //  4. A prior session id must exist. Absent means first dispatch of the
        //     series -- mint a fresh one.
        // Any failure falls back to a NEW id, i.e. a cold prompt, which is
        // exactly today's behaviour. The fallback is safe by construction.
        const resumeCfg = stateManager.getProjectContextConfig?.(projectId)?.resume;
        const priorDispatch = subtask.meta?.lastDispatch || null;
        const canResumeSession = shouldResumeSession({
          resumeEnabled: resumeCfg?.enabled,
          isVerbatim,
          priorDispatch,
          model: agent.model,
          maxAgeHours: resumeCfg?.maxAgeHours,
        });
        const sessionId = canResumeSession ? priorDispatch.sessionId : randomUUID();

        try {
          // Final preparing touch before spawn grace shrinks to 5s.
          agentCookies.touchPreparing?.(agentId);
          agentCookies.markDispatchStarted(agentId);
          const rawResponse = await withTimeout(
            agent.send(taskContext, workingDir, {
              maxTurns,
              bypassPermissions: canBypass,
              maxLifetimeMs: isVerbatim ? timeout : null,
              sessionId,
              resumeSession: canResumeSession,
            }),
            timeout, agent.name
          );
          setAgentIdle(thinkingAgents, thinkingKey);

          // Normalize response: some agents (codex) return {text, inputTokens, ...} objects
          const response = typeof rawResponse === 'string' ? rawResponse
            : (rawResponse?.text != null ? String(rawResponse.text) : String(rawResponse ?? ''));

          // Persist a dispatch preview on the subtask so an operator can see
          // WHAT the agent was asked and answered when a subtask later fails
          // (previously only a terse error string survived). Truncated: this
          // is a debugging breadcrumb, not an archive.
          try {
            taskManager.updateSubtask(projectId, taskId, subtask.id, {
              meta: {
                lastDispatch: {
                  agentId,
                  at: new Date().toISOString(),
                  promptPreview: String(taskContext || '').slice(0, 4000),
                  responsePreview: String(response || '').slice(0, 4000),
                  // Harness session identifier and the model that produced it.
                  //
                  // Recorded so a later dispatch in the same task series can
                  // resume that session instead of starting cold (#82 step 2).
                  // Storing them HERE rather than in a new store because this
                  // write already runs on every successful task dispatch and is
                  // already located by (projectId, taskId, subtask.id) and
                  // stamped with agentId -- which is the whole key. taskId is
                  // not in scope in agent-interaction.js at all, so this is the
                  // only dispatch path where the key actually exists.
                  //
                  // The model is the RESOLVED one reported by the harness, not
                  // the configured name, and it is stored because resuming a
                  // session whose history was produced by a different model is
                  // not a resume -- step 3 must invalidate on a mismatch.
                  //
                  // rawResponse is a plain string for some agents (normalised
                  // two lines above), hence the optional access rather than a
                  // destructure. Null simply means "no session to resume",
                  // which every harness with continuation:'none' will report.
                  // Prefer what the harness reported; fall back to the id WE
                  // supplied. For 'session-id-provided' harnesses the harness
                  // prints nothing parseable, so without this fallback the id
                  // we just minted would be lost and every dispatch would look
                  // like a first dispatch -- resume would never fire.
                  sessionId: (typeof rawResponse === 'object' && rawResponse && rawResponse.sessionId)
                    ? rawResponse.sessionId
                    : (sessionId ?? null),
                  model: (typeof rawResponse === 'object' && rawResponse) ? (rawResponse.model ?? null) : (agent?.model ?? null),
                },
              },
            }, 'system');
          } catch { /* preview is best-effort; never block the dispatch path */ }

          if (dispatchSpan) {
            const durationMs = Date.now() - dispatchStartTime;
            dispatchSpan.setAttribute('durationMs', durationMs);
            dispatchSpan.setAttribute('success', true);
            endSpan(dispatchSpan, { success: true });

            // Record provider latency for scorecard integration
            providerMetricsStore.recordProviderLatency({
              provider: agentProvider,
              latencyMs: durationMs,
              dispatchId: dispatchTraceId || subtask.id,
              agentId,
              campaignId: task.campaignId || null,
              cbState: circuitBreaker?.getState?.(agentProvider) || 'UNKNOWN',
              success: true,
            });
          }

          if (response && response.trim()) {
            // Model-not-found is a config error, not a rate limit
            if (MODEL_NOT_FOUND_RE && MODEL_NOT_FOUND_RE.test(response)) {
              log.error('Agent model not found during execution — config error', { taskId, agentId });
              if (circuitBreaker) circuitBreaker.recordFailure(agentProvider, null, 'auth_error');
              if (dispatchSpan) {
                const durationMs = Date.now() - dispatchStartTime;
                dispatchSpan.setAttribute('durationMs', durationMs);
                dispatchSpan.setAttribute('success', false);
                dispatchSpan.setAttribute('errorCategory', 'model_not_found');
                endSpan(dispatchSpan, { success: false });

                // Record provider latency for failed dispatch
                providerMetricsStore.recordProviderLatency({
                  provider: agentProvider,
                  latencyMs: durationMs,
                  dispatchId: dispatchTraceId || subtask.id,
                  agentId,
                  campaignId: task.campaignId || null,
                  cbState: circuitBreaker?.getState?.(agentProvider) || 'UNKNOWN',
                  success: false,
                });
              }
              taskManager.updateSubtask(projectId, taskId, subtask.id,
                { status: 'failed', error: `Model not found (${agentId} — check agent config)` }, agentId);
              return true;
            }

            // Rate limit detection
            if (RATE_LIMIT_RE.test(response)) {
              const mins = setAgentCooldown(agentId, response);
              if (circuitBreaker) circuitBreaker.recordFailure(agentProvider, null, 'rate_limit');
              // Record infra failure (rate_limit is infrastructure, not quality)
              if (performanceStore) {
                const durationMs = Date.now() - dispatchStartTime;
                performanceStore.updateAgentPerformance(agentId, subtask.suggestedRole || 'implementer', false, durationMs, task.campaignId || null, 'rate_limit');
              }
              if (dispatchSpan) {
                const durationMs = Date.now() - dispatchStartTime;
                dispatchSpan.setAttribute('durationMs', durationMs);
                dispatchSpan.setAttribute('success', false);
                dispatchSpan.setAttribute('errorCategory', 'rate_limit');
                dispatchSpan.setAttribute('cooldownMinutes', mins);
                endSpan(dispatchSpan, { success: false });

                // Record provider latency for rate-limited dispatch
                providerMetricsStore.recordProviderLatency({
                  provider: agentProvider,
                  latencyMs: durationMs,
                  dispatchId: dispatchTraceId || subtask.id,
                  agentId,
                  campaignId: task.campaignId || null,
                  cbState: circuitBreaker?.getState?.(agentProvider) || 'UNKNOWN',
                  success: false,
                });
              }
              taskManager.updateSubtask(projectId, taskId, subtask.id,
                { status: 'failed', error: `Rate limited (${agentId}, ${mins}m cooldown)` }, agentId);
              if (eventBus) {
                emitTelemetry(eventBus, 'subtask_failed', {
                  agentId, taskId, projectId, phase: 'subtask_lifecycle',
                  payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', status: 'failed', error: `Rate limited (${mins}m cooldown)`, requeued: true },
                });
              }
              taskManager.updateSubtask(projectId, taskId, subtask.id,
                { status: 'queued', error: `Requeued after ${agentId} rate limit` }, 'system');
              addMessage(projectId, channelId, 'System',
                `Subtask requeued: "${subtask.text}" \u2014 @${agentId} hit rate limit (${mins}m cooldown)`, 'system');
              return true;
            }

            // Record the agent's response (coerce to string — ResponseObject causes [object Object] in UI)
            addMessage(projectId, channelId, agent.name, String(response), 'message', { model: agent.model });

            // No-op detection: check if task mentions files but no git changes
            let noOpWarning = null;
            const subtaskText = subtask.text.toLowerCase();
            const contextDir = workingDir || PROJECT_DIR;
            const fileKeywords = ['fix', 'edit', 'change', 'update', 'implement', 'write', 'modify', 'add', 'remove', 'delete', 'create', 'make', 'set', 'replace'];
            const mightNeedFileChanges = fileKeywords.some(kw => subtaskText.includes(kw));
            if (mightNeedFileChanges) {
              try {
                const changedFiles = execSync(`git status --porcelain | grep -v "??" | cut -f 2- -d " " | sed 's/.* -> //' | sort | uniq`, {
                  cwd: contextDir, encoding: 'utf8', stdio: 'pipe'
                }).trim().split('\n').filter(f => f.trim().length > 0);
                const modifiedFiles = execSync(`git diff --name-only`, {
                  cwd: contextDir, encoding: 'utf8', stdio: 'pipe'
                }).trim().split('\n').filter(f => f.trim().length > 0);
                if (changedFiles.length === 0 && modifiedFiles.length === 0) {
                  noOpWarning = 'No file changes detected via git. Task mentioned file operations but repository state unchanged.';
                  log.warn('No-op detection', { projectId, taskId, subtaskId: subtask.id, agentId, warning: noOpWarning });
                }
              } catch (gitErr) {
                log.debug('Git commands failed for no-op detection', { error: gitErr.message });
              }
            }

            // Mark subtask done — coerce response to string (agents may return objects)
            const responseStr = typeof response === 'string' ? response : String(response ?? '');
            const resultSummary = noOpWarning
              ? responseStr.substring(0, 900) + '...\n\u26a0 ' + noOpWarning
              : (responseStr.length > 1000 ? responseStr.substring(0, 1000) + '...' : responseStr);
            taskManager.updateSubtask(projectId, taskId, subtask.id,
              { status: 'done', result: resultSummary }, agentId);

            // Record successful outcome in performance store (pull model path)
            if (performanceStore) {
              const durationMs = Date.now() - dispatchStartTime;
              const category = subtask.suggestedRole || 'implementer';
              const campaignId = task.campaignId || null;
              performanceStore.updateAgentPerformance(agentId, category, true, durationMs, campaignId);
            }

            // Review-and-Revise: Check if this is a review-and-revise workflow
            const isReviewAndReviseSubtask = subtask.meta?.auditTask && subtask.meta?.deliberationSessionId;
            const taskForReview = taskManager.getTask(projectId, taskId);
            const deliberationSessionId = subtask.meta?.deliberationSessionId || taskForReview?.deliberationSessionId;
            const currentIteration = taskForReview?.reviewIterationCount || 0;
            const maxIterations = taskForReview?.maxReviewIterations || 3;

            // Parse structured ReviewFeedback if this is a reviewer subtask
            let reviewFeedback = null;
            if (subtask.suggestedRole === 'reviewer') {
              reviewFeedback = parseReviewFeedback(response);
            }

            // Determine reviewer verdict: use structured feedback if available, else fall back to FAIL/PASS regex
            const feedbackStatus = reviewFeedback?.status ||
              (/\bFAIL\b/i.test(response) && !/\bPASS\b/i.test(response) ? 'rejected' :
               /\bPASS\b/i.test(response) ? 'approved' : null);

            // Reviewer-subtask rejection path: create revision subtasks
            if (subtask.suggestedRole === 'reviewer' && feedbackStatus === 'rejected') {
              const subtaskProjectDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
              // Use findings from structured feedback if available, else parse from response text
              const rawFindings = reviewFeedback?.findings?.length > 0
                ? reviewFeedback.findings
                : parseReviewFindings(response);
              const validFindings = validateFindings(rawFindings, subtaskProjectDir, taskForReview);
              const feedbackSummary = reviewFeedback?.summary || `${validFindings.length} issues found. Revision required.`;

              // Review-and-Revise: Emit feedback-received event
              if (isReviewAndReviseSubtask && eventBus) {
                emitTelemetry(eventBus, 'feedback_received', {
                  projectId,
                  taskId,
                  agentId,
                  phase: 'review_and_revise',
                  payload: {
                    sessionId: deliberationSessionId,
                    reviewerId: agentId,
                    status: 'rejected',
                    findingsCount: validFindings.length,
                    iterationCount: currentIteration,
                    feedbackSummary: validFindings.slice(0, 3).map(f => f.issue?.substring(0, 100)).join('; '),
                    feedbackContent: validFindings.slice(0, 5).map(f => ({
                      severity: f.severity,
                      file: f.file,
                      line: f.line,
                      issue: f.issue?.substring(0, 150),
                    })),
                  },
                });
              }

              if (validFindings.length > 0) {
                const fixSubtasks = createFixSubtasks(validFindings);
                if (fixSubtasks.length > 0) {
                  // Check if max iterations reached
                  const nextIteration = currentIteration + 1;
                  const maxIterationsReached = nextIteration >= maxIterations;

                  taskManager._saveWithRetry(projectId, (d) => {
                    const taskObj = d.tasks.find(x => x.id === taskId);
                    if (taskObj) {
                      taskObj.reviewFindings = validFindings;
                      taskObj.reviewCycle = (taskObj.reviewCycle || 0) + 1;
                      if (isReviewAndReviseSubtask) {
                        taskObj.reviewIterationCount = nextIteration;
                      }
                      taskObj.updatedAt = new Date().toISOString();
                    }
                    return d;
                  });

                  // Review-and-Revise: Check max iterations before creating fix subtasks
                  if (maxIterationsReached && isReviewAndReviseSubtask) {
                    log.warn('Max review iterations reached — forcing completion', {
                      taskId, projectId, currentIteration: nextIteration, maxIterations,
                      unresolvedFindings: validFindings.length,
                    });
                    addMessage(projectId, channelId, 'System',
                      `Max review iterations (${maxIterations}) reached. Task force-completed with ${validFindings.length} unresolved finding(s).`,
                      'system');

                    // Emit max-iterations-reached event
                    if (eventBus) {
                      emitTelemetry(eventBus, 'max_iterations_reached', {
                        projectId,
                        taskId,
                        agentId,
                        phase: 'review_and_revise',
                        payload: {
                          sessionId: deliberationSessionId,
                          reviewerId: agentId,
                          iterationCount: nextIteration,
                          maxIterations,
                          unresolvedFindings: validFindings.length,
                          findingsSummary: validFindings.map(f => ({
                            severity: f.severity,
                            file: f.file,
                            issue: f.issue?.substring(0, 100),
                          })),
                        },
                      });
                    }

                    // Submit final feedback to deliberation protocol and force-complete
                    if (deliberationProtocol && deliberationSessionId) {
                      try {
                        deliberationProtocol.submitMessage(
                          deliberationSessionId,
                          MESSAGE_TYPES.REVIEW_FEEDBACK,
                          {
                            status: 'max_iterations_reached',
                            findings: validFindings,
                            summary: `Max iterations (${maxIterations}) reached. ${validFindings.length} findings remain unresolved.`,
                          },
                          agentId
                        );

                        // Ingest DELIBERATION_FEEDBACK event to timeline
                        if (timelineStore) {
                          try {
                            timelineStore.ingest(
                              'deliberation_feedback',
                              {
                                sessionId: deliberationSessionId,
                                reviewerId: agentId,
                                status: 'max_iterations_reached',
                                feedbackText: `Max iterations (${maxIterations}) reached. ${validFindings.length} findings remain unresolved.`,
                                feedbackSummary: `Max iterations reached`,
                                feedbackContent: validFindings.slice(0, 5).map(f => ({
                                  severity: f.severity,
                                  file: f.file,
                                  line: f.line,
                                  issue: f.issue?.substring(0, 150),
                                })),
                                approved: false,
                                timestamp: new Date().toISOString(),
                              },
                              {
                                campaignId: task.campaign || null,
                                taskId,
                                agentId,
                              }
                            );
                          } catch (err) {
                            log.warn('Failed to ingest DELIBERATION_FEEDBACK to timeline', {
                              sessionId: deliberationSessionId,
                              error: err.message,
                            });
                          }
                        }
                      } catch (err) {
                        log.warn('Failed to submit max-iterations feedback to deliberation', {
                          sessionId: deliberationSessionId, error: err.message,
                        });
                      }
                    }

                    // Force-complete: promote task to DONE
                    taskManager.updateTaskStatus(projectId, taskId, 'done', 'system',
                      `Max review iterations (${maxIterations}) reached. Force-completing with ${validFindings.length} unresolved finding(s).`);
                    taskManager._saveWithRetry(projectId, (d) => {
                      const taskObj = d.tasks.find(x => x.id === taskId);
                      if (taskObj) { taskObj.reworkInProgress = false; taskObj.updatedAt = new Date().toISOString(); }
                      return d;
                    });
                  } else {
                    // Normal path: create fix subtasks, assigned to original agent in review-and-revise workflow
                    let fixSubtasksToAdd = fixSubtasks;
                    if (isReviewAndReviseSubtask) {
                      const primaryAgentId = (taskForReview?.subtasks || [])
                        .filter(s => s.status === 'done' && !s.meta?.auditTask && s.assignee)
                        .map(s => s.assignee)
                        .find(id => id) || taskForReview?.assignee || null;
                      if (primaryAgentId) {
                        fixSubtasksToAdd = fixSubtasks.map(fs => ({ ...fs, assignee: primaryAgentId }));
                      }
                    }
                    taskManager.addSubtasks(projectId, taskId, fixSubtasksToAdd, 'system');
                    log.info('Reviewer subtask FAIL — fix subtasks created', {
                      agentId, taskId, projectId, subtaskId: subtask.id,
                      findingsCount: validFindings.length, fixSubtasksCount: fixSubtasks.length,
                    });
                    addMessage(projectId, channelId, 'System',
                      `Reviewer subtask FAIL — ${validFindings.length} issue(s) found by @${agentId}. Fix subtasks added.`, 'system');

                    // Review-and-Revise: Emit revision-started event
                    if (isReviewAndReviseSubtask && eventBus) {
                      emitTelemetry(eventBus, 'revision_started', {
                        projectId,
                        taskId,
                        agentId,
                        phase: 'review_and_revise',
                        payload: {
                          sessionId: deliberationSessionId,
                          reviewerId: agentId,
                          iterationCount: nextIteration,
                          findingsCount: validFindings.length,
                          fixSubtasksCount: fixSubtasks.length,
                          feedbackContent: validFindings.slice(0, 5).map(f => ({
                            severity: f.severity,
                            file: f.file,
                            line: f.line,
                            issue: f.issue?.substring(0, 150),
                          })),
                        },
                      });
                    }

                    // Submit feedback to deliberation protocol (transitions to REVISING state)
                    if (deliberationProtocol && deliberationSessionId) {
                      try {
                        deliberationProtocol.submitMessage(
                          deliberationSessionId,
                          MESSAGE_TYPES.REVIEW_FEEDBACK,
                          {
                            status: 'rejected',
                            findings: validFindings,
                            summary: feedbackSummary,
                          },
                          agentId
                        );
                        log.info('Review feedback submitted to deliberation session', {
                          sessionId: deliberationSessionId,
                          status: 'rejected',
                          findingsCount: validFindings.length,
                        });

                        // Ingest DELIBERATION_FEEDBACK event to timeline
                        if (timelineStore) {
                          try {
                            timelineStore.ingest(
                              'deliberation_feedback',
                              {
                                sessionId: deliberationSessionId,
                                reviewerId: agentId,
                                status: 'rejected',
                                feedbackText: feedbackSummary,
                                feedbackSummary,
                                feedbackContent: validFindings.slice(0, 5).map(f => ({
                                  severity: f.severity,
                                  file: f.file,
                                  line: f.line,
                                  issue: f.issue?.substring(0, 150),
                                })),
                                approved: false,
                                timestamp: new Date().toISOString(),
                              },
                              {
                                campaignId: task.campaign || null,
                                taskId,
                                agentId,
                              }
                            );
                          } catch (err) {
                            log.warn('Failed to ingest DELIBERATION_FEEDBACK to timeline', {
                              sessionId: deliberationSessionId,
                              error: err.message,
                            });
                          }
                        }
                      } catch (err) {
                        log.warn('Failed to submit feedback to deliberation', {
                          sessionId: deliberationSessionId, error: err.message,
                        });
                      }
                    }

                    // Ingest DELIBERATION_REVISION event to timeline (revision starts)
                    if (timelineStore && deliberationSessionId) {
                      try {
                        const primaryAgentId = (taskForReview?.subtasks || [])
                          .filter(s => s.status === 'done' && !s.meta?.auditTask && s.assignee)
                          .map(s => s.assignee)
                          .find(id => id) || taskForReview?.assignee || null;

                        if (primaryAgentId) {
                          timelineStore.ingest(
                            'deliberation_revision',
                            {
                              sessionId: deliberationSessionId,
                              executorId: primaryAgentId,
                              revisionText: `Revisions requested: ${validFindings.length} finding(s)`,
                              feedbackContent: validFindings.slice(0, 5).map(f => ({
                                severity: f.severity,
                                file: f.file,
                                line: f.line,
                                issue: f.issue?.substring(0, 150),
                              })),
                              timestamp: new Date().toISOString(),
                            },
                            {
                              campaignId: task.campaign || null,
                              taskId,
                              agentId: primaryAgentId,
                            }
                          );
                        }
                      } catch (err) {
                        log.warn('Failed to ingest DELIBERATION_REVISION to timeline', {
                          sessionId: deliberationSessionId,
                          error: err.message,
                        });
                      }
                    }
                  }

                  // Vault: create incident note from review findings
                  if (vaultWriter) {
                    try {
                      vaultWriter.onReviewFindings({
                        projectId, taskId, subtaskId: subtask.id, agentId,
                        findings: validFindings,
                      });
                    } catch (vaultErr) {
                      log.warn('Vault incident write failed (non-blocking)', { projectId, taskId, error: vaultErr.message });
                    }
                  }
                }
              }
            } else if (subtask.suggestedRole === 'reviewer' && feedbackStatus === 'approved') {
              // Reviewer-subtask approval path
              const feedbackSummary = reviewFeedback?.summary || 'Changes approved';
              log.info('Reviewer subtask approved', { agentId, taskId, projectId, subtaskId: subtask.id });
              addMessage(projectId, channelId, 'System',
                `Review approved — ${feedbackSummary} (@${agentId})`, 'system');

              // Review-and-Revise: Emit revision-accepted event
              if (isReviewAndReviseSubtask && eventBus) {
                emitTelemetry(eventBus, 'revision_accepted', {
                  projectId,
                  taskId,
                  agentId,
                  phase: 'review_and_revise',
                  payload: {
                    sessionId: deliberationSessionId,
                    reviewerId: agentId,
                    iterationCount: currentIteration,
                    feedbackContent: response.substring(0, 500),
                  },
                });
              }

              // Review-and-Revise: Emit feedback-received event for approval
              if (isReviewAndReviseSubtask && eventBus) {
                emitTelemetry(eventBus, 'feedback_received', {
                  projectId,
                  taskId,
                  agentId,
                  phase: 'review_and_revise',
                  payload: {
                    sessionId: deliberationSessionId,
                    reviewerId: agentId,
                    status: 'approved',
                    findingsCount: reviewFeedback?.findings?.length || 0,
                    iterationCount: currentIteration,
                    feedbackSummary,
                  },
                });
              }

              // Submit approval to deliberation protocol (transitions to COMPLETE state)
              if (deliberationProtocol && deliberationSessionId) {
                try {
                  deliberationProtocol.submitMessage(
                    deliberationSessionId,
                    MESSAGE_TYPES.REVIEW_FEEDBACK,
                    {
                      status: 'approved',
                      findings: reviewFeedback?.findings || [],
                      summary: feedbackSummary,
                    },
                    agentId
                  );
                  log.info('Review approval submitted to deliberation session', {
                    sessionId: deliberationSessionId,
                    status: 'approved',
                  });

                  // Ingest DELIBERATION_FEEDBACK event to timeline
                  if (timelineStore) {
                    try {
                      timelineStore.ingest(
                        'deliberation_feedback',
                        {
                          sessionId: deliberationSessionId,
                          reviewerId: agentId,
                          status: 'approved',
                          feedbackText: feedbackSummary,
                          feedbackSummary,
                          feedbackContent: response.substring(0, 500),
                          approved: true,
                          timestamp: new Date().toISOString(),
                        },
                        {
                          campaignId: task.campaign || null,
                          taskId,
                          agentId,
                        }
                      );
                    } catch (err) {
                      log.warn('Failed to ingest DELIBERATION_FEEDBACK to timeline', {
                        sessionId: deliberationSessionId,
                        error: err.message,
                      });
                    }
                  }
                } catch (err) {
                  log.warn('Failed to submit approval to deliberation', {
                    sessionId: deliberationSessionId, error: err.message,
                  });
                }
              }

              // Review-and-Revise: promote task to DONE on approval
              if (isReviewAndReviseSubtask) {
                taskManager.updateTaskStatus(projectId, taskId, 'done', 'system', `Review approved by @${agentId}: ${feedbackSummary}`);
                taskManager._saveWithRetry(projectId, (d) => {
                  const taskObj = d.tasks.find(x => x.id === taskId);
                  if (taskObj) {
                    taskObj.reworkInProgress = false;
                    taskObj.updatedAt = new Date().toISOString();
                  }
                  return d;
                });
                log.info('Review-and-revise: task promoted to DONE on reviewer approval', {
                  taskId, projectId, agentId, sessionId: deliberationSessionId, feedbackSummary,
                });
              }
            } else if (subtask.suggestedRole === 'reviewer' && feedbackStatus === 'commented') {
              // Reviewer-subtask commented path: non-blocking feedback
              const feedbackSummary = reviewFeedback?.summary || 'Comments provided';
              const findings = reviewFeedback?.findings || [];
              log.info('Reviewer provided non-blocking comments', {
                agentId, taskId, projectId, subtaskId: subtask.id, commentsCount: findings.length,
              });
              addMessage(projectId, channelId, 'System',
                `Review comments from @${agentId}: ${feedbackSummary}${findings.length > 0 ? ` (${findings.length} suggestion(s))` : ''}`, 'system');

              // Submit comments to deliberation protocol (does not change session state)
              if (deliberationProtocol && deliberationSessionId) {
                try {
                  deliberationProtocol.submitMessage(
                    deliberationSessionId,
                    MESSAGE_TYPES.REVIEW_FEEDBACK,
                    {
                      status: 'commented',
                      findings: findings,
                      summary: feedbackSummary,
                    },
                    agentId
                  );
                  log.info('Review comments submitted to deliberation session', {
                    sessionId: deliberationSessionId,
                    status: 'commented',
                    commentsCount: findings.length,
                  });

                  // Ingest DELIBERATION_FEEDBACK event to timeline
                  if (timelineStore) {
                    try {
                      timelineStore.ingest(
                        'deliberation_feedback',
                        {
                          sessionId: deliberationSessionId,
                          reviewerId: agentId,
                          status: 'commented',
                          feedbackText: feedbackSummary,
                          feedbackSummary,
                          feedbackContent: findings.slice(0, 5).map(f => ({
                            severity: f.severity,
                            file: f.file,
                            line: f.line,
                            issue: f.issue?.substring(0, 150),
                          })),
                          approved: false,
                          timestamp: new Date().toISOString(),
                        },
                        {
                          campaignId: task.campaign || null,
                          taskId,
                          agentId,
                        }
                      );
                    } catch (err) {
                      log.warn('Failed to ingest DELIBERATION_FEEDBACK to timeline', {
                        sessionId: deliberationSessionId,
                        error: err.message,
                      });
                    }
                  }
                } catch (err) {
                  log.warn('Failed to submit comments to deliberation', {
                    sessionId: deliberationSessionId, error: err.message,
                  });
                }
              }

              // Emit feedback-received event for comments
              if (isReviewAndReviseSubtask && eventBus) {
                emitTelemetry(eventBus, 'feedback_received', {
                  projectId,
                  taskId,
                  agentId,
                  phase: 'review_and_revise',
                  payload: {
                    sessionId: deliberationSessionId,
                    reviewerId: agentId,
                    status: 'commented',
                    findingsCount: findings.length,
                    iterationCount: currentIteration,
                    feedbackSummary,
                  },
                });
              }

              // Comments don't block task completion — allow normal flow to continue
            }

            if (eventBus) {
              emitTelemetry(eventBus, 'subtask_done', {
                agentId, taskId, projectId, phase: 'subtask_lifecycle',
                payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', status: 'done', result: resultSummary.substring(0, 500), noOpWarning: noOpWarning || null },
              });
            }

            // Fire-and-forget checkpoint creation for campaign subtasks
            if (checkpointManager) {
              try {
                const campaign = campaignManager.findCampaignByTask(projectId, taskId);
                if (campaign) {
                  checkpointManager.createCheckpoint({
                    projectId, campaignId: campaign.id, taskId, subtaskId: subtask.id,
                  });
                  log.info('Checkpoint created', { projectId, campaignId: campaign.id, taskId, subtaskId: subtask.id });
                }
              } catch (checkpointErr) {
                log.warn('Checkpoint creation failed (non-blocking)', {
                  projectId, taskId, subtaskId: subtask.id, error: checkpointErr.message,
                });
              }
            }

            // Fire-and-forget vault note creation from git diff
            if (vaultWriter) {
              try {
                const subtaskProjectDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
                const subtaskChangedFiles = vaultWriter._getChangedFiles(subtaskProjectDir);
                vaultWriter.onSubtaskComplete({
                  projectId, taskId, subtaskId: subtask.id, agentId,
                  result: resultSummary, workingDir: subtaskProjectDir,
                });
                // Bump lastVerified on related module notes
                if (subtaskChangedFiles.length > 0) {
                  vaultWriter.bumpVerified(projectId, subtaskChangedFiles);
                }
              } catch (vaultErr) {
                log.warn('Vault write failed on subtask complete (non-blocking)', {
                  projectId, taskId, subtaskId: subtask.id, error: vaultErr.message,
                });
              }
            }

            if (noOpWarning) {
              addMessage(projectId, channelId, 'System',
                `\u26a0 No-op warning: "${subtask.text}" completed by @${agentId} but no file changes detected.`, 'system');
            }

            addMessage(projectId, channelId, 'System',
              `Subtask completed: "${subtask.text}" by @${agentId}`, 'system');

            // Review-and-Revise: Check if this was a fix subtask and if all fix subtasks are complete
            if (subtask.meta?.reviewFinding && deliberationProtocol && deliberationSessionId) {
              const taskObj = taskManager.getTask(projectId, taskId);
              const allFixSubtasks = taskObj.subtasks.filter(s => s.meta?.reviewFinding);
              const completedFixSubtasks = allFixSubtasks.filter(s => s.status === 'done');
              
              if (completedFixSubtasks.length === allFixSubtasks.length && allFixSubtasks.length > 0) {
                // All fix subtasks completed — trigger new review cycle
                const currentIteration = taskObj.reviewIterationCount || 0;
                const maxIterations = taskObj.maxReviewIterations || 3;
                
                if (currentIteration < maxIterations) {
                  log.info('All fix subtasks completed — triggering re-review', {
                    taskId, projectId, sessionId: deliberationSessionId,
                    iteration: currentIteration, fixSubtasksCount: allFixSubtasks.length,
                  });
                  
                  addMessage(projectId, channelId, 'System',
                    `All ${allFixSubtasks.length} fix subtask(s) completed by @${agentId}. Requesting re-review.`, 'system');
                  
                  // Submit new REVIEW_REQUEST to deliberation protocol
                  try {
                    const latestOutput = completedFixSubtasks
                      .map(s => s.result)
                      .filter(r => r)
                      .join('\n\n');
                    
                    deliberationProtocol.submitMessage(
                      deliberationSessionId,
                      MESSAGE_TYPES.REVIEW_REQUEST,
                      {
                        output: `Revision v${currentIteration + 1}`,
                        outputDetails: latestOutput.substring(0, 2000),
                        criteria: ['correctness', 'tests'],
                        originalMessageId: `revision-v${currentIteration + 1}`,
                      },
                      agentId
                    );
                    
                    log.info('Re-review request submitted to deliberation protocol', {
                      taskId, projectId, sessionId: deliberationSessionId, iteration: currentIteration + 1,
                    });
                  } catch (err) {
                    log.warn('Failed to submit re-review request to deliberation', {
                      sessionId: deliberationSessionId, error: err.message,
                    });
                  }
                } else {
                  log.warn('Max review iterations reached — not triggering re-review', {
                    taskId, projectId, currentIteration, maxIterations,
                  });
                }
              }
            }

            // Record success for adaptive routing
            if (scoreboard) {
              const elapsed = Date.now() - (subtask.claimedAt ? new Date(subtask.claimedAt).getTime() : Date.now());
              scoreboard.record(agentId, { success: true, durationMs: elapsed, complexity: subtask.complexity || 'medium', provider: agentProvider });
            }
            if (circuitBreaker) circuitBreaker.recordSuccess(agentProvider);
          } else {
            // Empty response — escalate to higher-tier agent
            if (circuitBreaker) circuitBreaker.recordFailure(agentProvider, null, 'empty_response');
            // Record infra failure in performance store (empty_response is infrastructure, not quality)
            if (performanceStore) {
              const durationMs = Date.now() - dispatchStartTime;
              const category = subtask.suggestedRole || 'implementer';
              performanceStore.updateAgentPerformance(agentId, category, false, durationMs, task.campaignId || null, 'empty_response');
            }
            const escalated = taskManager.escalateSubtask(projectId, taskId, subtask.id, agentProvider, { agentId, claimedAt: subtask.claimedAt });
            let reflection = null; // populated in terminal else; used by pattern_detected learning below
            if (escalated === 'stale') return true; // claim changed hands — outcome already superseded
            if (escalated) {
              addMessage(projectId, channelId, 'System',
                `Subtask failed (empty response) by @${agentId} \u2014 auto-escalating to higher-tier agent`, 'system');
              if (eventBus) {
                emitTelemetry(eventBus, 'subtask_escalated', {
                  agentId, taskId, projectId, phase: 'subtask_lifecycle',
                  payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', reason: 'empty_response', provider: agentProvider },
                });
              }
            } else {
              const finalError = 'Empty response \u2014 all providers exhausted';
              if (!subtask.meta?.reflectionAttempted) {
                reflection = await reflectOnTerminalSubtask(projectId, taskId, subtask, finalError);
              }
              if (reflection?.newText) {
                taskManager.updateSubtask(projectId, taskId, subtask.id, {
                  status: 'queued', text: reflection.newText,
                  failedProviders: [], retryCount: 0,
                  error: `Reformulated after reflection (prior: ${(subtask.failedProviders||[]).join(', ')})`,
                  meta: { reflectionAttempted: true, originalText: subtask.text },
                }, 'system');
                addMessage(projectId, channelId, 'System',
                  `Subtask reformulated by @${reflection.architectId}: "${reflection.newText.substring(0, 120)}"`, 'system');
              } else {
                taskManager.updateSubtask(projectId, taskId, subtask.id,
                  { status: 'failed', error: finalError }, agentId);
                addMessage(projectId, channelId, 'System',
                  `Subtask failed (empty response): "${subtask.text}" by @${agentId} \u2014 all providers exhausted`, 'system');
                if (eventBus) {
                  emitTelemetry(eventBus, 'subtask_failed', {
                    agentId, taskId, projectId, phase: 'subtask_lifecycle',
                    payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', status: 'failed', error: finalError },
                  });
                }
              }
            }
            // Capture escalation as learning
            if (learningsManager) {
              learningsManager.add(projectId, {
                category: 'escalation_failure',
                pattern: `Empty response from ${agentProvider} on subtask: ${(subtask.text || '').substring(0, 200)}`,
                why: `Provider ${agentProvider} returned empty response. Complexity: ${subtask.complexity || 'medium'}.`,
                correction: `Escalated from ${subtask.complexity || 'medium'}. Provider ${agentProvider} failed, excluding from future routing.`,
                severity: 'important',
                source: { taskId, subtaskId: subtask.id, agentId, campaignId: task.campaignId, milestoneId: task.milestoneId },
                tags: [`provider:${agentProvider}`, `complexity:${subtask.complexity || 'medium'}`],
              });
              const priorFailures = subtask.failedProviders || [];
              if (priorFailures.length >= 1) {
                const allFailed = [...priorFailures, agentProvider];
                learningsManager.add(projectId, {
                  category: 'pattern_detected',
                  pattern: `Subtask failed across ${allFailed.length} providers: ${(subtask.text || '').substring(0, 200)}`,
                  why: `Providers [${allFailed.join(', ')}] all failed. ${escalated ? 'Escalation continuing.' : 'All providers exhausted.'}`,
                  correction: reflection?.correction
                    || (escalated ? 'Subtask requires higher-tier agent or manual intervention.'
                                 : 'Requires manual intervention \u2014 all providers exhausted.'),
                  severity: allFailed.length >= 3 ? 'critical' : 'important',
                  source: { taskId, subtaskId: subtask.id, agentId, campaignId: task.campaignId, milestoneId: task.milestoneId },
                  tags: [...allFailed.map(p => `provider:${p}`), 'pattern:repeated-failure',
                         ...extractDomainTags(subtask.text || '')],
                });
              }
            }
          }

        } catch (err) {
          setAgentIdle(thinkingAgents, thinkingKey);

          // Late-outcome guard (#108): if this run no longer owns the claim
          // (reconcile requeued it and another agent claimed), DISCARD the
          // outcome entirely — no rollback (the snapshot restore would stomp
          // the new owner's task state), no breaker/cooldown records (a
          // killed run's rejection is not a provider failure — three such
          // misattributed 'unknown' failures tripped the claude breaker
          // live on 08-10), no retry/escalate (they clobbered the
          // successor's live claim in a ~60s loop).
          {
            const freshSt = taskManager.getTask(projectId, taskId)?.subtasks?.find(s2 => s2.id === subtask.id);
            const stillOurs = freshSt && freshSt.assignee === agentId
              && (freshSt.status === 'claimed' || freshSt.status === 'executing')
              && (!subtask.claimedAt || freshSt.claimedAt === subtask.claimedAt);
            if (!stillOurs) {
              log.info('Discarding stale run outcome — subtask no longer owned by this run', {
                agentId, taskId, subtaskId: subtask.id,
                currentAssignee: freshSt?.assignee ?? null, currentStatus: freshSt?.status ?? 'missing',
                error: String(err.message || err).slice(0, 120),
              });
              return true;
            }
          }

          // Roll back task state to pre-dispatch snapshot to avoid partial writes
          if (preDispatchSnapshot) {
            try {
              taskManager.restoreTaskState(projectId, preDispatchSnapshot, 'provider_error');
              const restoredTask = taskManager.getTask(projectId, taskId);
              if (restoredTask) {
                subtask = restoredTask.subtasks.find(s => s.id === subtask.id) || subtask;
              }
            } catch (restoreErr) {
              log.warn('Failed to restore task snapshot after provider error', {
                taskId,
                subtaskId: subtask?.id,
                error: restoreErr.message,
              });
            }
          }

          // Debugging breadcrumb (after rollback so it survives the restore):
          // what was asked + what the transport error was.
          try {
            taskManager.updateSubtask(projectId, taskId, subtask.id, {
              meta: {
                lastDispatch: {
                  agentId,
                  at: new Date().toISOString(),
                  promptPreview: String(taskContext || '').slice(0, 4000),
                  responsePreview: null,
                  error: String(err.message || err).slice(0, 1000),
                },
              },
            }, 'system');
          } catch { /* best-effort */ }

          // SIGTERM (exit 143) = Anthropic concurrent session overflow. Capacity, not capability.
          // Requeue cleanly like a rate limit — do not escalate, do not add to failedProviders,
          // do not record CB fault (provider is healthy, just overloaded).
          const isSigterm = /exit 143/.test(err.message || '');
          // exit null = process killed by signal (shutdown, reaper, OOM). A
          // provider cannot signal-kill our local process, so this is NEVER a
          // capability failure — recording it poisoned breakers with 'unknown'
          // during the 2026-08-10 restart storm. Same no-CB treatment as 143.
          const isSignalKill = isSigterm || /exit null\b/.test(err.message || '');
          // Sandbox capacity rejection = transient, not a provider failure.
          // e.g. "Sandbox: per-provider limit reached for ollama" when the local agent is already busy.
          const isSandboxCap = /per-provider limit reached/i.test(err.message || '');
          // Per-agent exclusivity = agent already running a subtask, strategist or seek tried to double-spawn.
          // Capacity signal, not capability failure — same treatment as isSandboxCap.
          const isDuplicateSpawn = /duplicate spawn blocked/i.test(err.message || '')
            || /already has an active process/i.test(err.message || '');
          const isCapacityError = isSandboxCap || isDuplicateSpawn;

          if (!isSignalKill && !isCapacityError && circuitBreaker) {
            // Classify the failure so the CB carries the reason into the
            // circuit_breaker:open event. Cooldown-setter then picks a
            // proportional duration — short for timeout/empty, long for real
            // rate-limit messages. See RATE_LIMIT_SEMANTICS.cooldownByReason.
            const failureReason = classifyCbFailureReason(err);
            circuitBreaker.recordFailure(agentProvider, null, failureReason);
          }

          if (dispatchSpan) {
            const durationMs = Date.now() - dispatchStartTime;
            dispatchSpan.setAttribute('durationMs', durationMs);
            dispatchSpan.setAttribute('success', false);
            const errCat = isSigterm ? 'sigterm' : isCapacityError ? 'sandbox_capacity' : 'agent_error';
            dispatchSpan.setAttribute('errorCategory', errCat);
            if (!isSigterm && !isCapacityError) dispatchSpan.recordException(err);
            endSpan(dispatchSpan, { error: err });

            // Record provider latency for failed dispatch
            providerMetricsStore.recordProviderLatency({
              provider: agentProvider,
              latencyMs: durationMs,
              dispatchId: dispatchTraceId || subtask.id,
              agentId,
              campaignId: task.campaignId || null,
              cbState: circuitBreaker?.getState?.(agentProvider) || 'UNKNOWN',
              success: false,
            });
          }

          // Sandbox capacity or duplicate spawn — transient, requeue immediately (no cooldown, no failedProviders)
          if (isCapacityError) {
            log.warn('Capacity error — requeuing subtask (no escalation)', { agentId, taskId, subtaskId: subtask.id, reason: isDuplicateSpawn ? 'duplicate_spawn' : 'sandbox_cap' });
            taskManager.updateSubtask(projectId, taskId, subtask.id,
              { status: 'queued', error: `Requeued: sandbox capacity for ${agentProvider}` }, 'system');
            return true;
          }

          // SIGTERM — requeue subtask so any Claude agent can retry after cooldowns clear
          if (isSigterm) {
            const cooldownMs = 2 * 60 * 1000;
            agentCooldowns.set(agentId, { until: Date.now() + cooldownMs, reason: 'sigterm', confidence: 'soft' });
            log.warn('Agent killed by SIGTERM during task execution — requeuing subtask', { agentId, taskId, subtaskId: subtask.id });
            taskManager.updateSubtask(projectId, taskId, subtask.id,
              { status: 'queued', error: `Requeued after SIGTERM on @${agentId}` }, 'system');
            addMessage(projectId, channelId, 'System',
              `Subtask requeued: "${subtask.text}" \u2014 @${agentId} killed by concurrent session limit (2m cooldown)`, 'system');
            return true;
          }

          // Signal-killed without an exit code (exit null) \u2014 local lifecycle
          // event (shutdown/reaper/OOM), not agent capability. Requeue with a
          // soft cooldown; never escalate or burn retry budget on it.
          if (isSignalKill) {
            const cooldownMs = 2 * 60 * 1000;
            agentCooldowns.set(agentId, { until: Date.now() + cooldownMs, reason: 'signal_kill', confidence: 'soft' });
            log.warn('Agent process signal-killed during execution \u2014 requeuing subtask', { agentId, taskId, subtaskId: subtask.id });
            taskManager.updateSubtask(projectId, taskId, subtask.id,
              { status: 'queued', error: `Requeued after signal kill on @${agentId}` }, 'system');
            return true;
          }

          // Rate limit errors are availability failures — requeue cleanly
          if (RATE_LIMIT_RE.test(err.message || '')) {
            const mins = setAgentCooldown(agentId, err.message || '');
            taskManager.updateSubtask(projectId, taskId, subtask.id,
              { status: 'failed', error: `Rate limited (${agentId}, ${mins}m cooldown)` }, agentId);
            if (eventBus) {
              emitTelemetry(eventBus, 'subtask_failed', {
                agentId, taskId, projectId, phase: 'subtask_lifecycle',
                payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', status: 'failed', error: `Rate limited (${mins}m cooldown)`, requeued: true },
              });
            }
            taskManager.updateSubtask(projectId, taskId, subtask.id,
              { status: 'queued', error: `Requeued after ${agentId} rate limit` }, 'system');
            addMessage(projectId, channelId, 'System',
              `Subtask requeued: "${subtask.text}" \u2014 @${agentId} hit rate limit (${mins}m cooldown)`, 'system');
            return true;
          }

          // Retry with exponential backoff before escalation
          const retried = taskManager.retrySubtask(projectId, taskId, subtask.id, { agentId, claimedAt: subtask.claimedAt });
          if (retried === 'stale') return true; // claim changed hands — outcome superseded
          let reflection = null; // populated in terminal else; used by pattern_detected learning below
          if (retried) {
            const subtaskAfterRetry = taskManager.getTask(projectId, taskId)?.subtasks.find(s => s.id === subtask.id);
            const backoffMs = subtaskAfterRetry?.backoffMs || 0;
            const retryAttempts = subtaskAfterRetry?.retryAttempts || 1;
            addMessage(projectId, channelId, 'System',
              `Subtask failed by @${agentId} (${err.message}) \u2014 retrying (attempt ${retryAttempts}/3, backoff ${backoffMs}ms)`, 'system');
            if (eventBus) {
              emitTelemetry(eventBus, 'subtask_retried', {
                agentId, taskId, projectId, phase: 'subtask_lifecycle',
                payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', reason: 'execution_error', error: err.message, provider: agentProvider, retryAttempts, backoffMs },
              });
            }
            return true;
          }
          // Retries exhausted (3 attempts) — escalate to higher-tier agent
          const escalated = taskManager.escalateSubtask(projectId, taskId, subtask.id, agentProvider, { agentId, claimedAt: subtask.claimedAt });
          if (escalated === 'stale') return true; // claim changed hands — outcome superseded
          if (escalated) {
            addMessage(projectId, channelId, 'System',
              `Subtask failed by @${agentId} (${err.message}) \u2014 retry exhausted, escalating to higher-tier agent`, 'system');
            if (eventBus) {
              emitTelemetry(eventBus, 'subtask_escalated', {
                agentId, taskId, projectId, phase: 'subtask_lifecycle',
                payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', reason: 'execution_error', error: err.message, provider: agentProvider },
              });
            }
          } else {
            const finalError = `${err.message} \u2014 all providers exhausted`;
            if (!subtask.meta?.reflectionAttempted) {
              reflection = await reflectOnTerminalSubtask(projectId, taskId, subtask, err.message);
            }
            if (reflection?.newText) {
              taskManager.updateSubtask(projectId, taskId, subtask.id, {
                status: 'queued', text: reflection.newText,
                failedProviders: [], retryCount: 0,
                error: `Reformulated after reflection (prior: ${(subtask.failedProviders||[]).join(', ')})`,
                meta: { reflectionAttempted: true, originalText: subtask.text },
              }, 'system');
              addMessage(projectId, channelId, 'System',
                `Subtask reformulated by @${reflection.architectId}: "${reflection.newText.substring(0, 120)}"`, 'system');
            } else {
              taskManager.updateSubtask(projectId, taskId, subtask.id,
                { status: 'failed', error: finalError }, agentId);
              addMessage(projectId, channelId, 'System',
                `Subtask failed: "${subtask.text}" by @${agentId} \u2014 ${err.message} (all providers exhausted)`, 'system');
              if (eventBus) {
                emitTelemetry(eventBus, 'subtask_failed', {
                  agentId, taskId, projectId, phase: 'subtask_lifecycle',
                  payload: { subtaskId: subtask.id, subtaskText: subtask.text, complexity: subtask.complexity || 'medium', status: 'failed', error: finalError },
                });
              }
            }
          }
          // Capture escalation as learning
          if (learningsManager) {
            learningsManager.add(projectId, {
              category: 'escalation_failure',
              pattern: `Execution error from ${agentProvider}: ${(err.message || '').substring(0, 200)}`,
              why: `Provider ${agentProvider} threw error on subtask. Complexity: ${subtask.complexity || 'medium'}.`,
              correction: `Escalated from ${subtask.complexity || 'medium'}. Provider ${agentProvider} errored, excluding from future routing.`,
              severity: 'important',
              source: { taskId, subtaskId: subtask.id, agentId, campaignId: task.campaignId, milestoneId: task.milestoneId },
              tags: [`provider:${agentProvider}`, `complexity:${subtask.complexity || 'medium'}`],
            });
            const priorFailures = subtask.failedProviders || [];
            if (priorFailures.length >= 1) {
              const allFailed = [...priorFailures, agentProvider];
              learningsManager.add(projectId, {
                category: 'pattern_detected',
                pattern: `Subtask failed across ${allFailed.length} providers: ${(subtask.text || '').substring(0, 200)}`,
                why: `Providers [${allFailed.join(', ')}] all failed. Errors: ${(err.message || '').substring(0, 150)}`,
                correction: reflection?.correction
                  || (escalated ? 'Subtask requires higher-tier agent or manual intervention.'
                               : 'Requires manual intervention \u2014 all providers exhausted.'),
                severity: allFailed.length >= 3 ? 'critical' : 'important',
                source: { taskId, subtaskId: subtask.id, agentId, campaignId: task.campaignId, milestoneId: task.milestoneId },
                tags: [...allFailed.map(p => `provider:${p}`), 'pattern:repeated-failure',
                       ...extractDomainTags(subtask.text || '')],
              });
            }
          }
          // Record failure for adaptive routing
          if (scoreboard) {
            const elapsed = Date.now() - (subtask.claimedAt ? new Date(subtask.claimedAt).getTime() : Date.now());
            scoreboard.record(agentId, { success: false, durationMs: elapsed, complexity: subtask.complexity || 'medium', provider: agentProvider });
          }
        } finally {
          agentCookies.checkin(agentId);
          // ─── Governance unlock + integrity check ───────────────────
          if (govLocked.length > 0 && unlockGovernanceFiles) {
            unlockGovernanceFiles(govLocked);
          }
          if (govHashes && verifyGovernanceIntegrity) {
            const tampered = verifyGovernanceIntegrity(PROJECT_DIR, govHashes);
            if (tampered.length > 0) {
              // A governance file can differ from the task-start snapshot for two
              // very different reasons:
              //   (1) an AGENT modified it mid-task → real tampering, must revert.
              //   (2) the OPERATOR edited it in the UI and saveAgentsConfig
              //       committed it → legitimate; the change is already in HEAD.
              // Reverting (2) is the ship-blocker that silently undid every UI
              // agent edit (incident 2026-06-15). Discriminator: a git-TRACKED
              // governance file that is CLEAN vs HEAD (no uncommitted diff) can
              // only be a committed operator edit — agents are chmod-444-locked
              // during their task and cannot commit. Anything with an uncommitted
              // working-tree diff, or an untracked file (e.g. .env), keeps the
              // snapshot/revert protection.
              const legitimate = [];
              const realTampered = [];
              for (const t of tampered) {
                // agents.json gets ACTOR-based attribution: the orchestrator
                // knows exactly what it writes (serializeAgentsConfig is the
                // byte-exact canonical form of live memory). disk === canonical
                // ⇒ the orchestrator's own write (validation results, status
                // heals, UI edits) — NOT tampering. The old timing-based
                // attribution blamed whichever agent had a subtask in flight
                // and, on untracked installs where the git-clean carve-out
                // can never match, escalated a routine self-write into a
                // FATAL halt + crash-restart loop (staging, 2026-08-01).
                if (t.path.endsWith(`.synapse/agents.json`) || t.path.endsWith(`.synapse\\agents.json`)) {
                  let disk = null;
                  try { disk = readFileSync(t.path, 'utf-8'); } catch { /* missing/unreadable → realTampered */ }
                  if (disk !== null && disk === serializeAgentsConfig()) {
                    legitimate.push(t);
                    continue;
                  }
                  realTampered.push({ ...t, isAgentsJson: true });
                  continue;
                }
                if (isPathCommittedClean(PROJECT_DIR, t.path)) legitimate.push(t);
                else realTampered.push(t);
              }
              // Re-baseline the snapshot for committed operator edits so neither
              // this run's stillBroken re-verify nor a later task's check treats
              // them as tampering.
              if (legitimate.length > 0) {
                const fresh = hashGovernanceFiles ? hashGovernanceFiles(PROJECT_DIR) : null;
                for (const { path: lPath } of legitimate) {
                  if (fresh && fresh.has(lPath)) govHashes.set(lPath, fresh.get(lPath));
                  log.info('Governance file change accepted (committed operator edit)', { path: lPath });
                }
              }
              if (realTampered.length > 0) {
              for (const { path: tPath, isAgentsJson } of realTampered) {
                if (isAgentsJson) {
                  // Restore from MEMORY — the orchestrator's live state is
                  // authoritative for agents.json and works on every install
                  // topology (git checkout can't restore an untracked file).
                  try {
                    saveAgentsConfig();
                    log.warn('Governance: agents.json restored from in-memory state after unexpected on-disk change', { agentId, taskId });
                  } catch (restoreErr) {
                    log.error('Governance: agents.json memory-restore failed', { error: restoreErr.message });
                  }
                  continue;
                }
                try {
                  // execFileSync: tPath is agent-influenced — never interpolate it into a shell string
                  execFileSync('git', ['checkout', 'HEAD', '--', tPath], { cwd: PROJECT_DIR, stdio: 'pipe' });
                  // Re-sync persona hash after revert — prevents integrity alarm on legitimately reverted content
                  const personaMatch = tPath.match(/\.synapse\/agents\/([^/]+)\/persona\.md$/);
                  if (personaMatch && registerPersonaHash) {
                    const revertedAgentId = personaMatch[1];
                    try {
                      const personaContent = readFileSync(join(PROJECT_DIR, tPath), 'utf-8').trim();
                      if (agents[revertedAgentId]) agents[revertedAgentId].persona = personaContent;
                      registerPersonaHash(revertedAgentId, personaContent);
                      log.info('Persona re-synced after governance revert', { agentId: revertedAgentId });
                    } catch (readErr) {
                      log.warn('Could not re-sync persona hash after revert', { agentId: revertedAgentId, error: readErr.message });
                    }
                  }
                } catch { /* best effort revert */ }
              }
              addMessage(projectId, channelId, 'System',
                `\u26a0 GOVERNANCE VIOLATION: Agent @${agentId} modified protected files during task execution. ` +
                `Files reverted: ${realTampered.map(t => t.path).join(', ')}`, 'system');
              if (learningsManager) {
                learningsManager.add(projectId, {
                  category: 'governance_violation',
                  pattern: `Agent @${agentId} modified protected governance files: ${realTampered.map(t => t.path).join(', ')}`,
                  why: 'Agent modified files that are locked read-only during execution. Governance files are constitutionally protected.',
                  correction: 'Governance files are read-only during agent execution. Never modify protected files.',
                  severity: 'critical',
                  source: { taskId, subtaskId: subtask.id, agentId, campaignId: task.campaignId, milestoneId: task.milestoneId },
                  tags: [...realTampered.map(t => `file:${t.path}`), 'pattern:governance-violation'],
                });
              }

              // GRADUATED RESPONSE. Re-verify after restore. The blast
              // radius must match the evidence:
              //   DESTROYED (file missing/unreadable, or agents.json
              //   unparseable) and unrestorable → halt. Iter4 proved a
              //   running orchestrator with a destroyed control plane
              //   thrashes uselessly; fail loud.
              //   PRESENT but content still unexpected → alert loudly,
              //   re-baseline, and continue. process.exit here punished the
              //   whole system (all agents, in-flight validations, the UI)
              //   for one suspect file write — and under systemd
              //   Restart=always a false positive became a crash-restart
              //   loop (staging, 2026-08-01).
              const stillBroken = verifyGovernanceIntegrity(PROJECT_DIR, govHashes)
                .filter(t => !isPathCommittedClean(PROJECT_DIR, t.path))
                .filter(t => !(t.path.endsWith('.synapse/agents.json') && (() => {
                  try { return readFileSync(t.path, 'utf-8') === serializeAgentsConfig(); } catch { return false; }
                })()));
              const destroyed = stillBroken.filter(t => {
                try {
                  const content = readFileSync(t.path, 'utf-8');
                  if (t.path.endsWith('agents.json')) JSON.parse(content);
                  return false;
                } catch { return true; } // missing, unreadable, or unparseable
              });
              if (destroyed.length > 0) {
                const paths = destroyed.map(t => `${t.path} (${t.actual})`).join(', ');
                log.error(
                  'FATAL: control-plane file destroyed and could not be restored — halting orchestrator to prevent silent thrash',
                  { agentId, taskId, subtaskId: subtask.id, unrecoverable: paths },
                );
                addMessage(projectId, channelId, 'System',
                  `⛔ FATAL: Synapse control plane was destroyed and could not be restored (${paths}). ` +
                  `Halting to prevent damage. Investigate, restore .synapse/, and restart.`, 'system');
                process.exit(1);
              }
              if (stillBroken.length > 0) {
                // Live, parseable files with unexpected content: accept the
                // current bytes as the new baseline so every subsequent task
                // doesn't re-alarm, but tell the operator loudly.
                const paths = stillBroken.map(t => t.path).join(', ');
                log.error('Governance: control-plane content differs after restore — re-baselining and continuing (NOT halting; files are live and parseable)',
                  { agentId, taskId, subtaskId: subtask.id, paths });
                addMessage(projectId, channelId, 'System',
                  `⚠ GOVERNANCE: control-plane files changed during @${agentId}'s task and could not be reverted to their snapshot (${paths}). ` +
                  `The system continues with the current on-disk content — review these files.`, 'system');
                const fresh2 = hashGovernanceFiles ? hashGovernanceFiles(PROJECT_DIR) : null;
                if (fresh2) for (const { path: bPath } of stillBroken) {
                  if (fresh2.has(bPath)) govHashes.set(bPath, fresh2.get(bPath));
                }
              }
              } // end if (realTampered.length > 0)
            }
          }
        }

        // Completion: this agent immediately seeks its next piece of work.
        // No broadcast — other agents are on their own timers. No burst.
        setImmediate(() => {
          const freshTask = taskManager.getTask(projectId, taskId);
          if (freshTask?.status === 'executing' && taskManager.isTaskComplete(projectId, taskId)) {
            // Transition to reviewing BEFORE calling reviewTask — promote() requires reviewing→done/failed,
            // not executing→done (which is an invalid transition and throws).
            taskManager.updateTaskStatus(projectId, taskId, 'reviewing', 'system', 'All subtasks finished');
            const reviewableTask = taskManager.getTask(projectId, taskId) || freshTask;
            reviewTask(reviewableTask).catch(err => log.error('Background reviewTask (completion chain) failed', { taskId, error: err.message }));
          }
          seekAndExecute(agentId).catch(err =>
            log.warn('Completion-chain seekAndExecute failed', { agentId, error: err.message })
          );
        });

        return true;
      }
    }

    // ── Secondary scan: failed task recovery ────────────────────────────────
    // Runs only when the primary scan found nothing to execute.
    // Three recovery paths:
    //   A. No subtasks (never planned)  → architect resets to queued and replans
    //   B. Queued subtask but task=failed (state inconsistency) → reset task to executing
    //   C. Failed subtasks, our provider not yet tried → reset retryCount, requeue, let next poll claim
    for (const proj of projects) {
      const failedTasks = taskManager.listTasks(proj.id)
        .filter(t => t.status === 'failed')
        .sort((a, b) => {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return ta - tb; // oldest failures first
        });

      for (const task of failedTasks) {
        const { project: projectId, channel: channelId, id: taskId } = task;
        const sts = task.subtasks || [];

        // Path A: never planned — architect/strategist agents replan
        if (sts.length === 0) {
          if (!_canAgentHandleRole(agentId, 'architect')) continue;
          try {
            taskManager.updateTaskStatus(projectId, taskId, 'queued', 'system',
              `Recovery: replanning by @${agentId} (no subtasks found)`);
            addMessage(projectId, channelId, 'System',
              `Task recovering: no subtasks found — @${agentId} will replan.`, 'system');
            // Inject projectId — strategist-created tasks lack the
            // `project` field that planTask destructures (only `channel`
            // and `campaignId` get set). Without this, planTask runs
            // with projectId=undefined and crashes on taskManager
            // validation.
            task.project = projectId;
            planTask(task).catch(err =>
              log.error('Background replan (recovery) failed', { taskId, error: err.message }));
            return true;
          } catch (e) {
            log.warn('Failed task recovery (replan) error', { taskId, error: e.message });
            continue;
          }
        }

       // Path B: task is 'failed' but has a queued subtask — state inconsistency, just unblock it
        const hasQueuedSubtask = sts.some(s => s.status === 'queued');
        if (hasQueuedSubtask) {
          try {
            taskManager.updateTaskStatus(projectId, taskId, 'queued', 'system',
              `Recovery: task had queued subtask while failed`);
            taskManager.updateTaskStatus(projectId, taskId, 'executing', 'system',
              `Recovery: unblocked by @${agentId}`);
            addMessage(projectId, channelId, 'System',
              `Task recovering: @${agentId} unblocked task with orphaned queued subtask.`);
            return earlyExit(); // next poll will claim it
          } catch (e) {
            log.warn('Failed task recovery (unblock) error', { taskId, error: e.message });
            continue;
          }
        }

        // Path C: failed subtasks — requeue any our provider hasn't exhausted.
        // totalRetryCount is monotonic across retryCount resets, so poisoned
        // work eventually remains terminal instead of cycling forever.
        const MAX_FAILED_TASK_RECOVERIES = 10;
        const retriable = sts.filter(s =>
          s.status === 'failed' &&
          (s.totalRetryCount || 0) < MAX_FAILED_TASK_RECOVERIES &&
          !(s.failedProviders || []).includes(agentProvider) &&
          _canAgentHandleRole(agentId, s.suggestedRole || null)
        );
        if (retriable.length === 0) continue;

        try {
          const recovery = taskManager.recoverFailedSubtasks(
            projectId,
            taskId,
            retriable.map(st => st.id),
            { agent: agentId, maxRecoveryAttempts: MAX_FAILED_TASK_RECOVERIES }
          );
          if (recovery.recoveredIds.length === 0) continue;
          taskManager.updateTaskStatus(projectId, taskId, 'executing', 'system',
            `Recovery: executing by @${agentId}`);
          addMessage(projectId, channelId, 'System',
            `Task recovering: @${agentId} requeued ${recovery.recoveredIds.length} failed subtask(s) for retry.`, 'system');
          log.info('Failed task recovery: subtasks requeued', {
            projectId, taskId, agentId, count: recovery.recoveredIds.length,
            subtaskIds: recovery.recoveredIds,
          });
          return earlyExit(); // next poll (this agent or another) will claim the requeued subtask
        } catch (e) {
          log.warn('Failed task recovery (retry) error', { taskId, error: e.message });
          continue;
        }
      }
    }

    return earlyExit(); // No eligible work found across all projects
    } finally {
      if (agentCookies.hasPickupSlot(agentId)) {
        agentCookies.releasePickupSlot(agentId);
      }
    }
  }

  /** Review a completed task. Daemons → sleeping, one-shots → done/failed with optional audit. */
  async function reviewTask(task) {
    const { project: projectId, channel: channelId, id: taskId } = task;

    if (auditTasksInFlight.has(taskId)) {
      log.info('Task review already in flight, skipping duplicate', { taskId, projectId });
      return;
    }
    auditTasksInFlight.add(taskId);

    try { // finally block ensures auditTasksInFlight.delete runs even on error
    const hasFailures = taskManager.hasFailedSubtasks(projectId, taskId);
    const taskDetail = taskManager.formatTaskDetail(projectId, taskId);

    if (task.type === 'daemon') {
      // Daemon task — cycle complete, transition to sleeping
      if (hasFailures) {
        addMessage(projectId, channelId, 'System',
          `Daemon cycle completed with failures:\n${taskDetail}\n\nWill retry next cycle.`, 'system');
      }

      // Check spend caps before allowing next cycle
      const daemonData = task.daemon || {};
      if (daemonData.paused) {
        taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system',
          `Daemon paused: ${daemonData.pauseReason || 'unknown'}`);
        addMessage(projectId, channelId, 'System',
          `Daemon paused — skipping sleep cycle.\n${taskDetail}`, 'system');
        // OTel: End task span on daemon paused
        if (task.taskSpan) {
          addSpanEvent(task.taskSpan, 'task_status_change', { from: 'reviewing', to: 'failed' });
          endSpan(task.taskSpan, { success: false, error: new Error(`Daemon paused: ${daemonData.pauseReason || 'unknown'}`) });
          task.taskSpan = null;
        }
        auditTasksInFlight.delete(taskId);
        return;
      }

      // Reset subtasks and enter sleep
      taskManager.resetDaemonCycle(projectId, taskId);
      taskManager.updateTaskStatus(projectId, taskId, 'sleeping', 'system',
        `Cycle ${(daemonData.cycleCount || 0) + 1} complete`);

      const sleepMin = Math.round((daemonData.sleepIntervalMs || 3600000) / 60000);
      const cycleNum = (daemonData.cycleCount || 0) + 1;
      addMessage(projectId, channelId, 'System',
        `Daemon cycle ${cycleNum} complete. Sleeping for ${sleepMin}m before next cycle.\n${taskDetail}`, 'system');
      broadcastToChannel(projectId, channelId, { type: 'daemon_sleeping', taskId, cycle: cycleNum, sleepMinutes: sleepMin });
      // OTel: Add task status change event for daemon sleeping
      if (task.taskSpan) {
        addSpanEvent(task.taskSpan, 'task_status_change', { from: 'reviewing', to: 'sleeping' });
      }

    } else {
      // One-shot task — standard completion with periodic audit
      taskManager.recordTaskCompletion(projectId);
      const workingDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
      let needsAudit = taskManager.shouldAudit(
        projectId, config.tasks.audit.interval, hasFailures, config.tasks.audit.onFailure
      );
      // Verbatim one-shot (A/B parity): an outside `claude -p` run has no
      // reviewer, so the inside run gets none either — no audit, no
      // cross-provider second review. Judging happens externally.
      const isVerbatimTask = (task.subtasks || []).some(s => s.meta?.verbatim === true);
      if (isVerbatimTask) needsAudit = false;

      // Check for destructive changes — force audit if detected
      let destructiveWarning = null;
      const destructiveFiles = await checkDestructiveChanges(workingDir);
      if (destructiveFiles.length > 0) {
        destructiveWarning = destructiveFiles;
        if (!needsAudit && !isVerbatimTask) {
          needsAudit = true;
          log.warn('Destructive changes detected — forcing audit', {
            taskId, files: destructiveFiles.map(d => `${d.file}: +${d.insertions}/-${d.deletions}`),
          });
        }
        addMessage(projectId, channelId, 'System',
          `⚠ Destructive changes detected: ${destructiveFiles.map(d => `${d.file} (+${d.insertions}/-${d.deletions})`).join(', ')}. Forcing audit review.`, 'system');
      }

      // Auto-commit project changes BEFORE the reviewer runs.
      // Reviewers must see a committed working tree — otherwise they flag uncommitted files
      // as "missing from git" and generate spurious FAIL cycles (one reviewer PASS vs another FAIL).
      let preCommitTouched = [];
      if (config.git.autoCommit) {
        const freshForCommit = taskManager.getTask(projectId, taskId);
        preCommitTouched = await detectAndCommitProjectChanges(workingDir, projectId, freshForCommit || task, config.git);
        if (preCommitTouched.length > 0) {
          taskManager.setTouchedFiles(projectId, taskId, preCommitTouched);
          addMessage(projectId, channelId, 'System',
            `[git] Committed ${preCommitTouched.length} file(s) before review: ${preCommitTouched.join(', ')}`, 'system');
        }
      }

      // Capture git diff for audit prompt (if audit will run).
      // When we just committed, show HEAD~1..HEAD so the reviewer sees the committed diff.
      let diffStat = '';
      let diffContent = '';
      let functionalFailures = [];
      if (needsAudit) {
        if (preCommitTouched.length > 0) {
          diffStat = await captureLastCommitDiffStat(workingDir);
          diffContent = await captureLastCommitDiff(workingDir, 3000);
        } else {
          diffStat = await captureGitDiffStat(workingDir);
          diffContent = await captureGitDiff(workingDir, 3000);
        }
        // Deterministic pre-checks before the LLM reviewer (#78 restore of
        // 14c196c9's design — the call site was lost in a refactor while the
        // function survived): node --check on changed JS, linked-resource
        // fetches for changed HTML, /api/health after server-file changes.
        // Non-fatal by design; failures are pre-seeded into the review
        // subtask so the reviewer starts from verified facts instead of
        // rediscovering (or missing) mechanical breakage.
        try {
          functionalFailures = await runFunctionalChecks(diffStat, workingDir, config.server.port);
          if (functionalFailures.length > 0) {
            log.warn('Functional pre-checks failed', { taskId, count: functionalFailures.length });
            addMessage(projectId, channelId, 'System',
              `Functional pre-checks found ${functionalFailures.length} issue(s) before review:\n` +
              functionalFailures.map(f => `- [${f.severity}] ${f.file}: ${f.issue}`).join('\n'), 'system');
          }
        } catch (e) {
          log.warn('Functional check error (non-fatal)', { taskId, error: e.message });
        }
      }

       // Promote helper — sets final status + notifies channel
        const promote = async (failed, reason, suffix = '') => {
         if (failed) {
           taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system', reason);
           addMessage(projectId, channelId, 'System',
             `Task completed with failures${suffix}:\n${taskDetail}\n\nUse \`/task retry ${taskId}\` to try again.`, 'system');
         } else {
           // Phase 3: Cross-provider second review for campaign tasks
           const freshTask = taskManager.getTask(projectId, taskId);
           if (!isVerbatimTask && freshTask?.campaignId && !hasHadCrossProviderReview(freshTask)) {
             const firstReviewerId = getFirstReviewProvider(freshTask);
             if (firstReviewerId && agents[firstReviewerId]) {
               const contributorIds = (freshTask.subtasks || [])
                 .filter(s => s?.assignee && s.assignee !== 'system' && !s.meta?.auditTask)
                 .map(s => s.assignee);
               const secondReviewer = selectCrossProviderReviewer(
                 agents, Object.keys(agents), firstReviewerId, contributorIds,
                 { isAgentCoolingDown, circuitBreaker, busyAgents }
               );
               if (secondReviewer) {
                 const [secondReviewerId, secondReviewerAgent] = secondReviewer;
                 const reviewSub = createCrossProviderReviewSubtask(
                   secondReviewerId, freshTask.title, diffStat, diffContent
                 );
                 taskManager.addSubtasks(projectId, taskId, [reviewSub], 'system');
                 log.info('Cross-provider second review scheduled', {
                   taskId, firstReviewer: firstReviewerId,
                   firstProvider: agents[firstReviewerId]?.provider,
                   secondReviewer: secondReviewerId,
                   secondProvider: secondReviewerAgent.provider,
                 });
                 addMessage(projectId, channelId, 'System',
                   `Cross-provider validation scheduled: @${secondReviewerId} (${secondReviewerAgent.provider}) reviewing.`, 'system');
                 return;
               }
             }
             log.warn('Cross-provider review skipped — no eligible second reviewer', { taskId });
           }

           // Phase 4: Automated validation pipeline for campaign tasks
           if (freshTask?.campaignId) {
             try {
               const campaign = campaignManager?.getCampaign(projectId, freshTask.campaignId);
               const validation = await runValidationPipeline(workingDir, {
                 branch: campaign?.branch || null,
                 runTests: false,
                 runLint: false,
               });
               taskManager._saveWithRetry(projectId, (d) => {
                 const taskObj = d.tasks.find(x => x.id === taskId);
                 if (taskObj) {
                   taskObj.validationReport = validation;
                   taskObj.updatedAt = new Date().toISOString();
                 }
                 return d;
               });
                if (!validation.overallPass) {
                  log.warn('Validation pipeline found issues', { taskId, validation });

                  // Security failures block approval — force a fix cycle
                  if (!validation.security?.pass) {
                    const issues = validation.security.issues || [];
                    addMessage(projectId, channelId, 'System',
                      `BLOCKED: Security issues found — approval gate denied.\n` +
                      `Issues: ${issues.join(', ')}\n` +
                      `Task will be sent back for fixing.`, 'system');
                    log.error('Security issues block approval — sending back for audit fix', {
                      taskId, issues,
                    });
                    // Transition back to executing so agents can fix the issues
                    taskManager.updateTaskStatus(projectId, taskId, 'executing', 'system',
                      `Security issues found: ${issues.join('; ')}`);
                    const fixSubtask = {
                      text: [
                        `URGENT: Security issues found in previous changes.`,
                        `Fix these before the task can be approved:`,
                        ...issues.map(i => `  - ${i}`),
                        '',
                        'Remove secrets, API keys, and credentials from the code.',
                        'Use environment variables or a secrets manager instead.',
                      ].join('\n'),
                      role: 'developer',
                      complexity: 'high',
                      meta: { securityFix: true },
                    };
                    taskManager.addSubtasks(projectId, taskId, [fixSubtask], 'system');
                    return;
                  }

                  // Syntax failures also block
                  if (!validation.syntax?.pass) {
                    addMessage(projectId, channelId, 'System',
                      `BLOCKED: Syntax errors found — cannot proceed to approval.\n` +
                      `Errors: ${(validation.syntax.errors || []).map(e => e.file + ': ' + (e.error || '')).join('; ')}`,
                      'system');
                    taskManager.updateTaskStatus(projectId, taskId, 'failed', 'system',
                      'Syntax errors in changeset');
                    promote(true, 'syntax-errors');
                    return;
                  }
                }

               // Phase 5: Trust score + approval gate
               const trustScore = calculateTrustScore(freshTask, validation);
               const approvalText = formatApprovalRequest(campaign, freshTask, trustScore, validation);
               taskManager._saveWithRetry(projectId, (d) => {
                 const taskObj = d.tasks.find(x => x.id === taskId);
                 if (taskObj) {
                   taskObj.trustScore = trustScore;
                   taskObj.updatedAt = new Date().toISOString();
                 }
                 return d;
               });

               addMessage(projectId, channelId, 'System', approvalText, 'system');
               log.info('Task awaiting approval', {
                 taskId, score: trustScore.score, tier: trustScore.tier,
                 campaignId: freshTask.campaignId,
               });
             } catch (err) {
               log.warn('Validation pipeline failed (non-blocking)', { taskId, error: err.message });
             }
           }

           taskManager.updateTaskStatus(projectId, taskId, 'done', 'system', reason);
           addMessage(projectId, channelId, 'System',
             `Task completed successfully${suffix}!\n${taskDetail}`, 'system');
         }
         // Clear reworkInProgress flag on task completion
         taskManager._saveWithRetry(projectId, (d) => {
           const taskObj = d.tasks.find(x => x.id === taskId);
           if (taskObj) {
             taskObj.reworkInProgress = false;
             taskObj.updatedAt = new Date().toISOString();
           }
           return d;
         });
         // OTel: End task span on done/failed
         if (task.taskSpan) {
           if (failed) {
             addSpanEvent(task.taskSpan, 'task_status_change', { from: 'reviewing', to: 'failed' });
             endSpan(task.taskSpan, { success: false, error: new Error(reason) });
           } else {
             addSpanEvent(task.taskSpan, 'task_status_change', { from: 'reviewing', to: 'done' });
             endSpan(task.taskSpan, { success: true });
           }
           task.taskSpan = null;
         }
       };

      if (needsAudit) {
        const contributorIds = new Set(
          (task.subtasks || [])
            .map(s => s?.assignee)
            .filter(id => id && id !== 'system' && agents[id])
        );

        // Derive taskCategory from task metadata, falling back to 'code-review' for standard audit tasks
        const taskCategory = task.taskCategory || task.category || 'code-review';

        // Check if review-and-revise workflow should be enabled for this task
        const reviewAndReviseConfig = config.tasks.reviewAndRevise || { enabled: false, maxIterations: 3, triggerTaskTypes: [] };
        const shouldEnableReviewAndRevise = reviewAndReviseConfig.enabled &&
          reviewAndReviseConfig.triggerTaskTypes.includes(taskCategory);

        // Store reviewAndRevise config on task for use during review cycles
        if (shouldEnableReviewAndRevise) {
          taskManager._saveWithRetry(projectId, (d) => {
            const taskObj = d.tasks.find(x => x.id === taskId);
            if (taskObj) {
              taskObj.reviewAndRevise = {
                enabled: true,
                maxIterations: reviewAndReviseConfig.maxIterations,
                currentIteration: taskObj.reviewIterations || 0,
              };
              taskObj.updatedAt = new Date().toISOString();
            }
            return d;
          });
          log.info('Review-and-revise workflow enabled for task', {
            taskId,
            taskCategory,
            maxIterations: reviewAndReviseConfig.maxIterations
          });
        }

        // Per-project agent roster: reviews stay on-roster too — an
        // all-opus-5 showdown project must not get judged by an off-roster
        // model.
        const projAgentRoster = stateManager.getProject(projectId)?.agents;
        const reviewerCandidates = projAgentRoster
          ? resolveRosterAgentIds(projAgentRoster, agents, 'reviewer')
          : Object.keys(agents);
        const reviewerId = routeSubtask(
          `Review task: ${task.title}`, // subtaskText
          reviewerCandidates,            // availableAgentIds (project roster or all)
          agents,                        // agentMap
          {
            suggestedRole: 'reviewer',
            // Operator ruling 2026-08-15: developers review only if this project opted in.
            allowDeveloperReviewFallback: stateManager.getProjectReviewDeveloperFallback?.(projectId) === true,
            contributorAgentIds: Array.from(contributorIds), // Pass contributor IDs
            taskCategory: taskCategory,                      // Pass task category
          },                             // subtaskMeta
          hasPermission,                 // permissionFilter
          config.tasks,                  // taskConfig
          scoreboard,                    // scoreboard
          Array.from(contributorIds),    // contributorAgentIds (to match the updated signature)
          taskCategory,                  // taskCategory (to match the updated signature)
          isAgentCoolingDown,
          circuitBreaker,
          busyAgents,
          stateManager.getEffectiveAgentPriority?.(projectId) ?? null // #105 operator priority
        );

        const reviewerEntry = reviewerId ? [reviewerId, agents[reviewerId]] : null;
        // Note: crossModelReviewers etc. are internal to routeSubtask — not available here.
        // These fallback detection flags are informational only (for log messages).
        // Safe defaults: assume no fallback was needed if reviewer was found.
        const usedAnyNonContributorFallback = false;
        const usedSameModelFallback = false;
        const usedSameAgentReviewerFallback = false;
        if (reviewerEntry) {
          const [reviewerId, reviewerAgent] = reviewerEntry;
          if (usedSameModelFallback) {
            // `contributorModels` is declared nowhere in this file, and the
            // spread would throw if this branch ever ran. It cannot today --
            // usedSameModelFallback is a hardcoded `false` a few lines above --
            // but a stub flag is exactly the thing someone later makes real,
            // and this would fail the moment they did. Dropped rather than
            // left armed.
            log.info('Same-model review fallback', { taskId, reviewerId });
            addMessage(projectId, channelId, 'System',
              `Cross-model reviewer unavailable — @${reviewerId} reviewing (same model). Preferred but not required.`,
              'system');
          }
          if (usedAnyNonContributorFallback) {
            log.info('Non-reviewer review fallback', { taskId, reviewerId, contributors: [...contributorIds] });
            addMessage(projectId, channelId, 'System',
              `Dedicated reviewers unavailable — @${reviewerId} reviewing (non-reviewer role). Independent perspective preserved.`,
              'system');
          }
          if (usedSameAgentReviewerFallback) {
            log.warn('Same-agent review fallback', { taskId, reviewerId, contributors: [...contributorIds] });
            addMessage(projectId, channelId, 'System',
              `Independent reviewer unavailable — @${reviewerId} reviewing their own work as last resort. Manual spot-check recommended.`,
              'system');
          }

          // Review-and-Revise: Initialize deliberation session if enabled
          let deliberationSessionId = null;
          let primaryAgentOutput = ''; // Declare at higher scope for use in reviewAndReviseContext
          const reviewAndReviseConfig = config.tasks?.reviewAndRevise || {};
          const isReviewAndReviseEnabled = reviewAndReviseConfig.enabled === true &&
            (reviewAndReviseConfig.triggerTaskTypes || []).includes(taskCategory);

          if (isReviewAndReviseEnabled && deliberationProtocol) {
            // Find primary agent (first non-system contributor to the task)
            const primaryAgentId = Array.from(contributorIds)[0];

              if (primaryAgentId) {
                log.info('Review-and-revise: setting up deliberation.', { taskId, projectId, primaryAgentId, reviewerId });
                // Collect primary agent's output from completed subtasks
                const completedSubtasks = (task.subtasks || [])
                  .filter(st => st.status === 'done' && st.assignee === primaryAgentId && !st.meta?.auditTask);
                if (completedSubtasks.length > 0) {
                  // Combine results from all completed subtasks by the primary agent
                  primaryAgentOutput = completedSubtasks
                    .map((st, idx) => `Subtask ${idx + 1}: ${st.text}\nResult: ${st.result || '(no result)'}`)
                    .join('\n\n');
                }

                // Initialize deliberation session with primary agent and reviewer as participants
                const sessionId = `review-${taskId}-${Date.now()}`;
                try {
                  const maxIterations = reviewAndReviseConfig.maxIterations || 3;
                deliberationProtocol.initSession(
                  sessionId,
                  [primaryAgentId, reviewerId],
                  `Review and Revise: ${task.title}`,
                  primaryAgentId,
                  { timeoutMs: 3600000, projectId } // 1 hour timeout; projectId scopes session to prevent cross-project context leaks
                );

                // Submit the primary agent's output as a REVIEW_REQUEST message
                deliberationProtocol.submitMessage(
                  sessionId,
                  MESSAGE_TYPES.REVIEW_REQUEST,
                  {
                    output: primaryAgentOutput || diffContent || '(no output captured)',
                    criteria: ['correctness', 'completeness', 'quality'],
                    originalMessageId: `task-${taskId}`,
                  },
                  primaryAgentId
                );

                deliberationSessionId = sessionId;

                // Store deliberation sessionId and iteration count on task metadata
                taskManager._saveWithRetry(projectId, (d) => {
                  const taskObj = d.tasks.find(x => x.id === taskId);
                  if (taskObj) {
                    taskObj.deliberationSessionId = sessionId;
                    taskObj.reviewIterationCount = taskObj.reviewIterationCount ?? 0;
                    taskObj.maxReviewIterations = maxIterations;
                    taskObj.updatedAt = new Date().toISOString();
                  }
                  return d;
                });

                log.info('Review-and-revise deliberation session initiated', {
                  taskId,
                  sessionId,
                  primaryAgentId,
                  reviewerId,
                  maxIterations,
                });

                addMessage(projectId, channelId, 'System',
                  `Review-and-revise workflow initiated: deliberation session ${sessionId} started with @${primaryAgentId} and @${reviewerId}.`,
                  'system');

                // Emit timeline event for review-requested
                if (eventBus) {
                  emitTelemetry(eventBus, 'review_requested', {
                    projectId,
                    taskId,
                    agentId: primaryAgentId,
                    phase: 'review_and_revise',
                    payload: {
                      sessionId,
                      primaryAgentId,
                      reviewerId,
                      iterationCount: 0,
                    },
                  });
                }

                // Ingest DELIBERATION_REQUEST event to timeline
                if (timelineStore) {
                  try {
                    timelineStore.ingest(
                      'deliberation_request',
                      {
                        sessionId,
                        requesterId: primaryAgentId,
                        taskId,
                        taskCategory,
                        reviewerId,
                        requestText: primaryAgentOutput || diffContent || '(no output captured)',
                        timestamp: new Date().toISOString(),
                      },
                      {
                        campaignId: task.campaign || null,
                        taskId,
                        agentId: primaryAgentId,
                      }
                    );
                  } catch (err) {
                    log.warn('Failed to ingest DELIBERATION_REQUEST to timeline', {
                      sessionId,
                      error: err.message,
                    });
                  }
                }
              } catch (err) {
                log.error('Failed to initialize deliberation session for review-and-revise', {
                  taskId,
                  sessionId,
                  error: err.message,
                  stack: err.stack,
                });
                // Continue with standard review if deliberation fails
              }
            } else {
              log.warn('Review-and-revise enabled but no primary agent found', { taskId, contributorIds: Array.from(contributorIds) });
            }
          }

          // Build reviewAndReviseContext for the reviewer subtask
           let reviewAndReviseContext = null;
           if (isReviewAndReviseEnabled && deliberationSessionId && deliberationProtocol) {
             try {
               const sessionState = deliberationProtocol.getState(deliberationSessionId);
               if (sessionState) {
                 // Guard: reject sessions that originated from a different project
                 if (sessionState.projectId && sessionState.projectId !== projectId) {
                   log.warn('Deliberation session projectId mismatch — cross-project context leak prevented', {
                     taskId, expectedProjectId: projectId, sessionProjectId: sessionState.projectId, deliberationSessionId,
                   });
                 } else {
                   // Get current iteration count from task
                   const currentIteration = task.reviewIterationCount || 0;

                   // deliberationHistory was previously the ENTIRE messageHistory,
                   // unbounded. On a third revision that meant every earlier
                   // round's messages rode along in the prompt, and tasks.js
                   // renders each as JSON truncated at 300 chars -- so the
                   // actionable part of a critique could be cut mid-object while
                   // approvals and chatter consumed the budget.
                   //
                   // Keep the raw tail (reviewers rely on seeing PROPOSAL and
                   // CRITIQUE messages, not just verdicts) but BOUND it, and add
                   // the structured actionable feedback beside it via the
                   // extractor -- which filters to REVIEW_FEEDBACK, drops
                   // approvals, and preserves suggestedChanges as real fields
                   // instead of truncated JSON.
                   const rr = config.tasks.reviewAndRevise || {};
                   const history = sessionState.messageHistory || [];
                   const maxHistory = rr.maxHistoryMessages || 20;

                   // Keep the HEAD as well as the tail. deliberation-protocol
                   // requires the first substantive message to be the PROPOSAL
                   // (INIT -> PROPOSAL), so a plain slice(-N) would drop the
                   // very thing under review on any session longer than the
                   // cap, leaving the reviewer with verdicts about a proposal
                   // it cannot see. Anchor on message 0, then take the most
                   // recent N-1; the gap is in the middle and is declared.
                   // Keeps the topic record and the first PROPOSAL, then fills
                   // the rest of the budget from the most recent messages.
                   // Extracted so it is testable — see deliberation-history-window.js
                   // for the two wrong versions this replaced.
                   const { bounded, truncated } = boundDeliberationHistory(history, maxHistory);

                   reviewAndReviseContext = {
                     primaryAgentOutput: primaryAgentOutput || diffContent || '(no output captured)',
                     deliberationHistory: bounded,
                     deliberationHistoryTruncated: truncated,
                     reviewFeedback: extractReviewFeedback(sessionState, {
                       maxFeedbackItems: rr.maxFeedbackItems || 10,
                     }),
                     reviewIteration: currentIteration,
                     maxIterations: task.maxReviewIterations || 3,
                   };
                 }
               }
             } catch (err) {
               log.warn('Failed to fetch deliberation session state for review context', {
                 taskId,
                 sessionId: deliberationSessionId,
                 error: err.message,
               });
             }
           }
           
           const preDetectedSection = functionalFailures.length > 0 ? [
               '',
               'PRE-DETECTED FAILURES (deterministic checks — already verified, do not re-litigate):',
               ...functionalFailures.map(f => `  [${f.severity}] ${f.file}: ${f.issue}`),
               'These are confirmed mechanical failures. Include them in your findings and check whether the same root cause breaks anything else.',
             ] : [];
           const reviewSubtask = {
             text: [
               `Review changes for task: ${task.title}`,
               ...preDetectedSection,
               '',
               'REVIEW PROCESS:',
               '1. Read the git diff to understand what changed',
               '2. VERIFY claims by using your tools — run scripts, grep for functions, check file paths exist',
               '3. Do NOT trust task descriptions or agent claims at face value — check the actual filesystem',
               '4. If the done criteria say "test passes", run the test. If it says "endpoint works", curl it.',
               '5. Report findings with exact file paths and line numbers you verified',
               '',
               'FINDING FORMAT (one per issue):',
               '  severity: critical | major | minor | nit',
               '  file: <exact path you verified exists>',
               '  line: <line number if applicable>',
               '  issue: <what is wrong>',
               '  suggestion: <how to fix>',
               '',
               'If everything passes verification, say so explicitly with what you checked.',
             ].join('\n'),
             role: 'reviewer',
             complexity: 'high',
             assignee: reviewerId,
             meta: {
               auditTask: true,
               parentTaskId: taskId,
               deliberationSessionId,
               reviewAndReviseContext,
             },
           };

          taskManager.addSubtasks(projectId, taskId, [reviewSubtask], 'system');
          log.info('Review subtask created and assigned', { taskId, reviewerId, deliberationSessionId });
          addMessage(projectId, channelId, 'System', `Review subtask created and assigned to @${reviewerId}.`, 'system');
          return; // The subtask will be picked up by the assigned reviewer via seekAndExecute
        } else {
          // No eligible reviewer found, even with fallbacks
          log.warn('No eligible reviewer found for task. Audit skipped.', { taskId });
          addMessage(projectId, channelId, 'System', 'No eligible reviewer found for task. Audit skipped.', 'system');
          return;
        }
        // (Removed: an unreachable log.debug referencing freshTask.status and
        // campaign.id. It sat after an if/else in which BOTH branches return,
        // and neither identifier is in scope here -- so it was dead code that
        // would have thrown had it ever been reached.)
      } else {
        // No audit needed — promote based on subtask outcomes.
        // Guard: if ALL subtasks returned empty results, this is an infra failure, not success.
        const allSubtasksEmpty = (task.subtasks || []).length > 0 &&
          (task.subtasks || []).every(st => !st.result || (typeof st.result === 'string' && st.result.trim().length === 0) ||
            (typeof st.result === 'object' && (!st.result.text || st.result.text.trim().length === 0)));
        if (allSubtasksEmpty) {
          log.warn('All subtasks returned empty results — marking task as failed (infra failure)', { taskId });
          promote(true, 'all-subtasks-empty');
        } else {
          // Guard: if deliberation is still in progress, defer task completion.
          // Only blocks the success path — infra failures (all-subtasks-empty) proceed regardless.
          if (!hasFailures && hasActiveDeliberationSession(taskId, deliberationCoordinator)) {
            log.info('Deliberation session active — deferring task completion pending review', { taskId });
            addMessage(projectId, channelId, 'System',
              'Deliberation review in progress — task completion deferred until reviewer approves.', 'system');
            return;
          }
          // #79: a criteria-bearing task must not promote to done when zero
          // subtasks succeeded or the run came up 3+ short of its own plan.
          const criteriaGate = evaluateDoneCriteriaGate(task);
          if (!hasFailures && criteriaGate.block) {
            log.warn('Done-criteria gate blocked promotion', { taskId, reason: criteriaGate.reason });
            addMessage(projectId, channelId, 'System',
              `Done-criteria gate: ${criteriaGate.reason}. Task marked failed instead of done — the stated criteria cannot have been met.`, 'system');
            promote(true, criteriaGate.reason);
          } else {
            promote(hasFailures, 'audit-not-required');
          }
        }
      }
    }
    } finally {
      auditTasksInFlight.delete(taskId);
    }
  }

  /** Build deliberation proposal subtask text for an agent. */
  function buildDeliberationProposalText(task, agentId = null) {
    const title = task.title || task.description || 'the task';
    const agentTag = agentId ? ` (agent ${agentId})` : '';
    return `Provide a deliberation proposal for: ${title}${agentTag}`;
  }

  /** Ensure deliberation proposal subtasks exist for all assigned agents. */
  function ensureDeliberationProposalSubtasks(projectId, task, assignedAgents) {
    if (!Array.isArray(assignedAgents) || assignedAgents.length < 2) return null;
    const existingByAgent = new Set(
      (task.subtasks || [])
        .filter(st => st.meta?.deliberationProposal && st.assignee)
        .map(st => st.assignee)
    );
    const missingAgents = assignedAgents.filter(agentId => agentId && !existingByAgent.has(agentId));
    if (missingAgents.length === 0) return null;

    const subtasks = missingAgents.map(agentId => ({
      text: buildDeliberationProposalText(task, agentId),
      assignee: agentId,
      complexity: 'medium',
      role: null,
      meta: {
        deliberationProposal: true,
        deliberationSessionId: task.deliberation?.sessionId || null,
      },
    }));

    taskManager.addSubtasks(projectId, task.id, subtasks, 'system');
    return subtasks;
  }

  /** Heartbeat tick — checks all projects for tasks needing action. Single-flight. */
  async function heartbeatTick() {
    if (heartbeatRunning) return; // Single-flight guard
    heartbeatRunning = true;

    const tickStart = Date.now();
    log.info("Heartbeat tick start");
    try {
      // Agents registered after startup (onboarding wizard's 0-agent path)
      // get their idle pull loop here — without this they never seek work.
      ensureIdleLoopsForAllAgents();

      // ─── Cookie reconciliation ─────────────────────────────────
      // Three-way check: subtask state × sandbox processes × timeouts.
      // Replaces: busyAgents self-heal, activePickups self-heal, stuck-subtask timeout.
      // Source of truth = subtask state. Dead processes → requeue. Stuck processes → kill + fail.
      agentCookies.reconcile(isAgentPlanningNow);

      // ─── Role-resume detection ───────────────────────────────────
      // Check if any previously-paused roles have recovered (at least one agent available again).
      if (getPausedRoles && isRolePaused) {
        const paused = getPausedRoles();
        for (const role of [...paused]) {
          if (!isRolePaused(role, busyAgents)) {
            if (markRoleResumed) markRoleResumed(role);
            log.info('Role resumed', { event: 'role_resumed', role });
            if (eventBus) {
              eventBus.emit('task_queue:role_resumed', { role, resumedAt: new Date().toISOString() })
                .catch(err => log.warn('EventBus emission failed', { event: 'task_queue:role_resumed', error: err.message }));
            }
          }
        }
      }

      const projects = stateManager.listProjects();

      for (const proj of projects) {
        taskManager.resumeDueDeferredTasks(proj.id, Date.now(), 'system', 'Deferred retry window reached');
        const tasks = taskManager.listTasks(proj.id);
        log.info('Heartbeat: checking project', { projectId: proj.id, taskCount: tasks.length });

        // Recover tasks stuck in 'reviewing' on every heartbeat tick.
        // Detection runs on a read snapshot; promotions go through updateTaskStatus
        // so task:status_changed / task:completed fire and downstream workflows
        // (campaign progress, milestone closeout) see the completion. Writing
        // task.status directly and saving the whole snapshot back (the old way)
        // both swallowed events and clobbered concurrent writes.
        {
          const data = taskManager.load(proj.id);
          const promotions = [];
          for (const task of data.tasks) {
            if (task.status !== 'reviewing' || auditTasksInFlight.has(task.id)) continue;

            const auditSubtasks = (task.subtasks || []).filter(st =>
              st && typeof st.meta === 'object' && st.meta && st.meta.auditTask
            );
            const hasQueuedWork = (task.subtasks || []).some(st =>
              st && (st.status === 'queued' || st.status === 'claimed' || st.status === 'executing')
            );
            const auditComplete = auditSubtasks.length === 0 ||
              auditSubtasks.every(st => st.status === 'done' || st.status === 'failed');

            if (auditComplete && !hasQueuedWork) {
              // Decision extracted to evaluateRecoveryPromotion (pure, tested)
              // so this sweep applies the SAME all-empty and done-criteria
              // guards as the normal promote path (#102).
              const p = evaluateRecoveryPromotion(task);
              const logFn = p.newStatus === 'failed' ? log.warn.bind(log) : log.info.bind(log);
              logFn(`Task recovery: promoting reviewing→${p.newStatus}`, { taskId: task.id, projectId: proj.id, reason: p.reason });
              promotions.push({ taskId: task.id, newStatus: p.newStatus, extras: p.extras, reason: p.reason });
            }
            // If audit is NOT complete and has pending work, leave in reviewing — don't cycle to executing
          }
          for (const p of promotions) {
            try {
              if (p.extras) {
                taskManager._saveWithRetry(proj.id, (d) => {
                  const t = d.tasks.find(t2 => t2.id === p.taskId);
                  if (t) Object.assign(t, p.extras);
                  return d;
                });
              }
              taskManager.updateTaskStatus(proj.id, p.taskId, p.newStatus, 'system', p.reason);
            } catch (err) {
              log.warn('Task recovery: promotion failed', { taskId: p.taskId, newStatus: p.newStatus, projectId: proj.id, error: err.message });
            }
          }
        }

        // Check for expired claims first
        taskManager.checkExpiredClaims(proj.id, agents);

        // Sort tasks by campaign priority: critical > high > elevated > normal > no campaign
        const campaignPriorityCache = new Map();
        function getCampaignPriority(campaignId) {
          if (!campaignId) return 3; // no campaign = lowest
          if (campaignPriorityCache.has(campaignId)) return campaignPriorityCache.get(campaignId);
          const campaign = campaignManager.getCampaign(proj.id, campaignId);
          let effectivePriority = campaign?.priority;
          if (campaignManager.getActiveConstraints) {
            const activeConstraints = campaignManager.getActiveConstraints(proj.id, campaignId);
            const priorityOverride = activeConstraints?.find(c => c.type === 'priority_override');
            if (priorityOverride && priorityOverride.value) {
              effectivePriority = priorityOverride.value;
            }
          }
          const p = PRIORITY_ORDER[effectivePriority] ?? 3;
          campaignPriorityCache.set(campaignId, p);
          return p;
        }
        // Sort tasks: campaign priority first (critical > revenue > normal > none),
        // then oldest first within same priority so long-running work isn't starved by new tasks.
        tasks.sort((a, b) => {
          const pa = getCampaignPriority(a.campaignId);
          const pb = getCampaignPriority(b.campaignId);
          if (pa !== pb) return pa - pb;
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return ta - tb;
        });

        // Pre-calculate active task counts per campaign to optimize max_concurrent checks
        const activeCountsByCampaign = new Map();
        for (const t of tasks) {
          if (t.campaignId && ['planning', 'executing', 'reviewing'].includes(t.status)) {
            activeCountsByCampaign.set(t.campaignId, (activeCountsByCampaign.get(t.campaignId) || 0) + 1);
          }
        }

        const allocation = proj.allocation ?? 100;
        if (allocation === 0) {
          // Project paused — housekeeping still runs (expired claim cleanup above), skip execution
          continue;
        }
        const stuckTimeoutMs = config.tasks.stuckSubtaskTimeoutMs || 600_000;
        const planningStaleMs = (config.tasks.planningTimeoutMs || 300_000) + HEARTBEAT_STALL_MS;
        // Planning cap: at most 3 new planning tasks per heartbeat tick per project.
        // Prevents overwhelming the architect pool. Agent idle loops handle executing dispatch.
        const MAX_PLANNING_PER_TICK = 3;
        let planningStarted = 0;
        // WIP cap: count in-flight tasks (planning + executing + reviewing) at tick start.
        // Don't start new planning if already at the per-project cap — finish before starting.
        const wipCount = tasks.filter(t => ['planning', 'executing', 'reviewing'].includes(t.status)).length;
        const maxWip = config.tasks.maxConcurrentTasks;

        for (const task of tasks) {
          // Skip done tasks - they're contained in completed milestones/campaigns
          if (task.status === 'done') {
            log.debug('Heartbeat: skipping done task', { taskId: task.id, status: task.status });
            continue;
          }
          // Normalize project field for legacy tasks
          if (!task.projectId && task.project) {
            task.projectId = task.project;
          }
          log.info('Heartbeat: processing task', { taskId: task.id, status: task.status, subtaskCount: task.subtasks?.length || 0, projectId: task.projectId });
          // Debug: Log if task is the executing one we're looking for
          if (task.id === 'task_1772628126253_24682d36') {
            log.info('Heartbeat: FOUND executing task!', { taskId: task.id, status: task.status, hasActiveSubtasks: task.subtasks?.some(s => s.status === 'claimed' || s.status === 'executing') });
          }
          // Debug: Log task count to see how far we've gotten
          if (task.status === 'executing' && task.subtasks?.length > 0) {
            const hasActive = task.subtasks.some(s => s.status === 'claimed' || s.status === 'executing');
            log.info('Heartbeat: executing task check', { taskId: task.id, hasActive, subtaskStatuses: task.subtasks.map(s => s.status) });
          }

          // --- max_concurrent constraint check (per-campaign) ---
          if (task.campaignId && campaignManager?.getActiveConstraints) {
            const activeConstraints = campaignManager.getActiveConstraints(proj.id, task.campaignId);
            const maxConcurrentEntry = activeConstraints?.find(c => (c.type === 'max_concurrent' && typeof c.value === 'number') || typeof c.max_concurrent === 'number');
            if (maxConcurrentEntry) {
              const campaignMaxConcurrent = maxConcurrentEntry.type === 'max_concurrent' ? maxConcurrentEntry.value : maxConcurrentEntry.max_concurrent;
              if (typeof campaignMaxConcurrent === 'number') {
                const campaignActiveCount = activeCountsByCampaign.get(task.campaignId) || 0;
                
                if (campaignActiveCount >= campaignMaxConcurrent && !['planning', 'executing', 'reviewing'].includes(task.status)) {
                  // Already at limit for this campaign, skip starting new work
                  continue;
                }
              }
            }
          }

          // Queued → planning (check dependencies and agent availability first)
          if (task.status === 'queued') {
            if (planningStarted >= MAX_PLANNING_PER_TICK) continue; // cap planners per tick
            if ((wipCount + planningStarted) >= maxWip) continue;  // WIP cap — finish before starting
            if (task.dependencies && task.dependencies.length > 0) {
              const allDone = task.dependencies.every(depId => {
                const dep = taskManager.getTask(proj.id, depId);
                return dep && dep.status === 'done';
              });
              if (!allDone) continue; // Still blocked by dependencies
            }
            // Don't enter planning if no agents can work — avoids burning retries
            const anyAvailable = Object.keys(agents).some(a =>
              isAgentEligibleNow(agents, a, { isAgentCoolingDown, circuitBreaker })
            );
            if (!anyAvailable) continue;
            try {
              taskManager.updateTaskStatus(proj.id, task.id, 'planning', 'system', 'Heartbeat: starting planning');
              if (task.campaignId) {
                activeCountsByCampaign.set(task.campaignId, (activeCountsByCampaign.get(task.campaignId) || 0) + 1);
              }
            } catch (transitionErr) {
              log.warn('Task status changed before planning could start', {
                taskId: task.id, project: proj.id, error: transitionErr.message,
              });
              continue;
            }
            // OTel: Create task lifecycle span under milestone span
            let taskSpan = null;
            let taskTraceContext = null;
            if (task.milestoneId && task.traceContext) {
              taskSpan = startSpan('task.lifecycle', {
                taskId: task.id,
                projectId: proj.id,
                status: 'planning',
                agentId: 'system',
                taskCategory: task.campaignId ? 'campaign' : 'project',
                success: false,
                durationMs: 0,
              }, task.traceContext);
              taskTraceContext = taskSpan.spanContext();
              // Store taskSpan on task object for reviewTask access
              task.taskSpan = taskSpan;
              // Persist traceContext on task for subtask spans
              // Use _saveWithRetry — TaskManager doesn't expose a bare _save.
              taskManager._saveWithRetry(proj.id, (d) => {
                const taskObj = d.tasks.find(t => t.id === task.id);
                if (taskObj) taskObj.traceContext = taskTraceContext;
                return d;
              });
            }
            task.project = proj.id;  // planTask destructures task.project (see recovery path note)
            planTask(task, taskSpan).then(async (result) => {
              if (config.git.autoCommit) {
                const projectDir = stateManager.getProject(proj.id)?.projectDir;
                if (projectDir) {
                  const baseline = await captureGitBaseline(projectDir);
                  if (baseline !== null) {
                    taskManager.setGitBaseline(proj.id, task.id, baseline);
                  }
                }
              }
              // End task span if planning succeeds
              if (taskSpan && result) {
                addSpanEvent(taskSpan, 'task_planning_complete', { status: 'executing' });
                endSpan(taskSpan, { success: true });
              }
            }).catch(err => {
              log.error('Background planTask failed', { taskId: task.id, error: err.message });
              // End task span if planning fails
              if (taskSpan) {
                addSpanEvent(taskSpan, 'task_planning_failed', { error: err.message });
                endSpan(taskSpan, { success: false, error: err });
              }
            });
            planningStarted++;
            continue;
          }

          if (task.status === 'deferred') {
            continue;
          }

          // Failed → re-queue for retry, capped by config.tasks.maxRequeues.
          // Without the cap this loop requeued every failed task on every tick
          // forever — a task that cannot succeed burns escalated-complexity
          // dispatches indefinitely. requeueCount persists on the task so the
          // cap survives restarts.
          if (task.status === 'failed') {
            const allTerminal = task.subtasks?.every(s => ['done', 'failed', 'cancelled'].includes(s.status));
            if (allTerminal) {
              const maxRequeues = config.tasks?.maxRequeues ?? 1;
              const requeueCount = task.requeueCount || 0;
              if (requeueCount >= maxRequeues) {
                if (!task.requeueExhausted) {
                  taskManager._saveWithRetry(proj.id, (d) => {
                    const t = d.tasks.find(x => x.id === task.id);
                    if (t) { t.requeueExhausted = true; t.updatedAt = new Date().toISOString(); }
                    return d;
                  });
                  log.warn('Heartbeat: failed task exhausted requeue budget — operator intervention required', {
                    taskId: task.id, projectId: proj.id, requeueCount, maxRequeues,
                  });
                  addMessage(proj.id, task.channel || 'general', 'System',
                    `⚠ Task **${task.title}** failed ${requeueCount + 1} time(s) and exhausted its automatic retry budget (maxRequeues=${maxRequeues}). It will not be retried automatically — cancel it or re-queue it manually.`);
                }
                continue;
              }
              // Audit logging: track failed task re-queue for data collection
              const failedSubtasks = task.subtasks?.filter(s => s.status === 'failed') || [];
              log.info('Heartbeat: re-queuing failed task', {
                taskId: task.id,
                projectId: proj.id,
                campaignId: task.campaignId,
                milestoneId: task.milestoneId,
                subtaskCount: task.subtasks?.length || 0,
                failedSubtaskCount: failedSubtasks.length,
                requeueCount: requeueCount + 1,
                maxRequeues,
                reason: 'All subtasks terminal — re-queued for retry',
              });
              taskManager.updateTaskStatus(proj.id, task.id, 'queued', 'system', `Failed task re-queued for retry (${requeueCount + 1}/${maxRequeues})`);
              taskManager._saveWithRetry(proj.id, (d) => {
                const t = d.tasks.find(x => x.id === task.id);
                if (t) t.requeueCount = requeueCount + 1;
                return d;
              });
              // Reset subtask statuses so agents can pick them up. retryCount
              // resets too — a requeued task gets a fresh escalation ladder
              // instead of instantly re-exhausting MAX_ESCALATIONS.
              task.subtasks.forEach(st => {
                if (st.status === 'failed') {
                  taskManager.updateSubtask(proj.id, task.id, st.id, {
                    status: 'queued',
                    error: null,
                    assignee: null,
                    claimedUntil: null,
                    retryCount: 0,
                  }, 'system');
                }
              });
            }
            continue;
          }

          // Executing → pick up next subtask
          if (task.status === 'executing') {
            log.info('Heartbeat: checking executing task', { taskId: task.id, projectId: proj.id, subtaskCount: task.subtasks.length });
            // Stuck subtask detection is now handled by agentCookies.reconcile() at the
            // top of heartbeatTick — unified timeout: checks process liveness first, then
            // kills stuck processes + fails subtasks in one operation. No standalone timeout here.

            const hasActive = task.subtasks.some(s => s.status === 'claimed' || s.status === 'executing');
            // Heartbeat: maintenance only. Agent idle loops (10s) are the primary pickup path.
            // Heartbeat just catches tasks whose all subtasks finished but reviewTask was missed.
            if (!hasActive) {
              // Check for multi-agent deliberation tasks
              const deliberationAgents = task.deliberation?.assignedAgents || [];
              const isDeliberationTask = task.deliberation?.enabled && Array.isArray(deliberationAgents) && deliberationAgents.length >= 2;

              if (isDeliberationTask) {
                const freshTask = taskManager.getTask(proj.id, task.id);
                const uniqueAgents = [...new Set(deliberationAgents)].filter(Boolean);
                ensureDeliberationProposalSubtasks(proj.id, freshTask, uniqueAgents);

                // Note: Agent idle polling (seekAndExecute) will pick up the proposal subtasks
                // automatically via their assignee field, no explicit dispatch needed here.
                log.info('Heartbeat: deliberation proposal subtasks ensured', {
                  taskId: task.id,
                  projectId: proj.id,
                  assignedAgents: uniqueAgents,
                });
                continue;
              }

              const isComplete = taskManager.isTaskComplete(proj.id, task.id);
              // debug, not info: repeats every 30s heartbeat for every task in
              // this state and was drowning the journal (#15). The transitions
              // below still log at info.
              log.debug('Heartbeat: executing task with no active subtasks', {
                taskId: task.id,
                projectId: proj.id,
                hasActive,
                isComplete,
                subtaskCount: task.subtasks.length,
                subtaskStatuses: task.subtasks.map(s => ({ id: s.id, status: s.status })),
              });
              if (isComplete && !auditTasksInFlight.has(task.id)) {
                log.info('Heartbeat: transitioning task to reviewing', { taskId: task.id, projectId: proj.id });
                taskManager.updateTaskStatus(proj.id, task.id, 'reviewing', 'system', 'All subtasks finished');
                // Clear reworkInProgress flag when transitioning back to reviewing after fix cycle
                taskManager._saveWithRetry(proj.id, (d) => {
                  const taskObj = d.tasks.find(t => t.id === task.id);
                  if (taskObj) {
                    taskObj.reworkInProgress = false;
                    taskObj.updatedAt = new Date().toISOString();
                  }
                  return d;
                });
                // OTel: Add task status change event if task span exists
                if (task.traceContext) {
                  const data = taskManager.load(proj.id);
                  const taskObj = data.tasks.find(t => t.id === task.id);
                  if (taskObj && taskObj.taskSpan) {
                    addSpanEvent(taskObj.taskSpan, 'task_status_change', { from: 'executing', to: 'reviewing' });
                  }
                }
                reviewTask(task).catch(err => log.error('Background reviewTask failed', { taskId: task.id, error: err.message }));
              } else if (isComplete && auditTasksInFlight.has(task.id)) {
                log.info('Heartbeat: review already in flight, skipping duplicate dispatch', { taskId: task.id, projectId: proj.id });
              } else if (!isComplete) {
                const hasQueued = task.subtasks.some(s => s.status === 'queued');
                if (hasQueued) {
                  // Keep role-pause tracking symmetric with the resume check at
                  // the top of the heartbeat. Dispatch remains pull-based, but
                  // operators still need to know when every agent capable of a
                  // queued role is unavailable.
                  if (isRolePaused && markRolePaused && getPausedRoles) {
                    const queuedRoles = new Set(task.subtasks
                      .filter(s => s.status === 'queued')
                      .map(s => s.suggestedRole || s.role)
                      .filter(Boolean));
                    for (const role of queuedRoles) {
                      if (isRolePaused(role, busyAgents) && !getPausedRoles().has(role)) {
                        markRolePaused(role);
                        if (eventBus) {
                          eventBus.emit('task_queue:role_paused', {
                            role,
                            reason: 'all_agents_unavailable',
                            pausedAt: new Date().toISOString(),
                          }).catch(err => log.warn('EventBus emission failed', {
                            event: 'task_queue:role_paused', error: err.message,
                          }));
                        }
                      }
                    }
                  }
                  // Force-dispatch helper `executeNextSubtask` was removed
                  // upstream; agents' pull-model (seekAndExecute, called
                  // every 10s per agent in the idle loop) is responsible
                  // for picking these up. If they don't, the issue is
                  // upstream (eligibility/permission) — fix there, not by
                  // bypassing the pull.
                  log.info('Heartbeat: executing task has queued subtasks — relying on agent pull', { taskId: task.id, projectId: proj.id });
                }
              }
            }
            // Executing tasks don't count toward planning cap — no cap on executing dispatch
            continue;
          }

          // Sleeping (daemon) → check if sleep elapsed, then wake up
          if (task.status === 'sleeping' && task.type === 'daemon') {
            if (taskManager.isDaemonReady(proj.id, task.id)) {
              // Reset daily spend if day boundary passed
              taskManager.resetDailySpendIfNeeded(proj.id, task.id);

              const cycleCount = task.daemon?.cycleCount || 0;
              const rePlanInterval = config.tasks.daemon.rePlanInterval;

              if (taskManager.daemonNeedsReplan(proj.id, task.id, rePlanInterval)) {
                taskManager.updateTaskStatus(proj.id, task.id, 'planning', 'system',
                  `Daemon waking up — re-planning (every ${rePlanInterval} cycles)`);
                addMessage(proj.id, task.channel, 'System',
                  `Daemon "${task.title}" waking up for cycle ${cycleCount + 1}. Re-planning...`, 'system');
                task.project = proj.id;  // see recovery-path note above
                planTask(task).catch(err => log.error('Background daemon planTask failed', { taskId: task.id, error: err.message }));
              } else {
                taskManager.updateTaskStatus(proj.id, task.id, 'executing', 'system',
                  `Daemon waking up — cycle ${cycleCount + 1}`);
                addMessage(proj.id, task.channel, 'System',
                  `Daemon "${task.title}" waking up for cycle ${cycleCount + 1}. Executing...`, 'system');
                // Agents will pick up the daemon's subtasks on their next idle poll (within 10s).
              }
            }
            // Don't break — sleeping daemons shouldn't block other tasks
            continue;
          }

          // Planning → re-plan/retry. Includes tasks with zero subtasks so failed decomposition
          // attempts cannot leave tasks permanently stuck in planning.
          if (task.status === 'planning') {
            const updatedAtMs = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
            const planningAgeMs = updatedAtMs > 0 ? (Date.now() - updatedAtMs) : Infinity;
            const inFlight = planningTasksInFlight.has(task.id);
            const hasSubtasks = Array.isArray(task.subtasks) && task.subtasks.length > 0;

            // Keep current in-flight attempt if it is still within timeout budget.
            if (inFlight && Number.isFinite(planningAgeMs) && planningAgeMs < planningStaleMs) {
              continue;
            }

            // If an in-flight marker outlives the planning timeout, clear it and retry.
            if (inFlight) {
              planningTasksInFlight.delete(task.id);
              log.warn('Planning task exceeded stale timeout — clearing in-flight marker', {
                taskId: task.id,
                projectId: proj.id,
                planningAgeMs,
                planningStaleMs,
                hadSubtasks: hasSubtasks,
              });
            }

            task.project = proj.id;  // see recovery-path note above
            planTask(task).catch(err => log.error('Background re-planTask failed', { taskId: task.id, error: err.message }));
            continue;
          }
        }

        // Idle kick: if there's no runnable work but failed/deferred tasks remain,
        // trigger strategist now instead of waiting for the 5-minute strategist loop.
        if (strategistEvaluate) {
          const hasRunnable = tasks.some(t => ['queued', 'planning', 'executing', 'reviewing', 'sleeping'].includes(t.status));
          const hasBlockedRetryWork = tasks.some(t => t.status === 'failed' || t.status === 'deferred');
          if (!hasRunnable && hasBlockedRetryWork) {
            const now = Date.now();
            const lastKick = idleStrategistKickAt.get(proj.id) || 0;
            if ((now - lastKick) >= IDLE_STRATEGIST_KICK_THROTTLE_MS) {
              const activeCampaigns = campaignManager.listCampaigns(proj.id, 'active');
              if (activeCampaigns.length > 0) {
                idleStrategistKickAt.set(proj.id, now);
                log.info('Idle queue detected — triggering immediate strategist evaluation', {
                  projectId: proj.id,
                  activeCampaigns: activeCampaigns.length,
                  throttleMs: IDLE_STRATEGIST_KICK_THROTTLE_MS,
                  failed: tasks.filter(t => t.status === 'failed').length,
                  deferred: tasks.filter(t => t.status === 'deferred').length,
                });
                for (const campaign of activeCampaigns) {
                  strategistEvaluate(proj.id, campaign.id).catch(err => {
                    log.error('Idle-triggered strategist evaluation failed', {
                      projectId: proj.id,
                      campaignId: campaign.id,
                      error: err.message,
                    });
                  });
                }
              }
            }
          } else if (hasRunnable) {
            idleStrategistKickAt.delete(proj.id);
          }
        }
      }

      // Cross-project pattern scan (runs at most once every 4 hours)
      if (Date.now() - lastPatternScanAt >= PATTERN_SCAN_COOLDOWN_MS) {
        try {
          const synapseDir = join(PROJECT_DIR, '.synapse');
          const normalizedData = loadAllProjects(synapseDir);
          
          // detectPatterns persists findings to anomaly-alerts.jsonl internally
          const { findings } = detectPatterns(normalizedData);

          lastPatternScanAt = Date.now();
          
          if (findings && findings.length > 0) {
            log.info('Cross-project pattern scan completed', {
              projectId: '_global',
              findingsCount: findings.length,
              lastScanAt: new Date(lastPatternScanAt).toISOString(),
            });
          }
        } catch (err) {
          log.error('Pattern scan failed', { error: err.message });
          // Update timestamp even on failure to prevent retry loops
          lastPatternScanAt = Date.now();
        }
      }

      // ─── Scheduled Report Generation ──────────────────────────────────
      // Check for due scheduled reports and trigger generation.
      // Stateless: no new intervals, just checks on existing heartbeat tick.
      if (scheduledReportStore && timelineStore) {
        try {
          const nowTs = Date.now();
          const dueSchedules = scheduledReportStore.getNextDueSchedules(nowTs);

          if (dueSchedules.length > 0) {
            log.info('Processing due scheduled reports', {
              count: dueSchedules.length,
              scheduleIds: dueSchedules.map(s => s.id),
            });

            for (const schedule of dueSchedules) {
              try {
                // Generate report asynchronously (don't block heartbeat)
                generateScheduledReport({
                  schedule,
                  scheduledReportStore,
                  timelineStore,
                  log,
                }).then(() => {
                  log.info('Scheduled report generated successfully', {
                    scheduleId: schedule.id,
                    format: schedule.format,
                    template: schedule.template,
                  });
                }).catch(err => {
                  log.error('Scheduled report generation failed', {
                    scheduleId: schedule.id,
                    error: err.message,
                    stack: err.stack,
                  });
                });
              } catch (err) {
                log.error('Failed to start scheduled report generation', {
                  scheduleId: schedule.id,
                  error: err.message,
                });
              }
            }
          }
        } catch (err) {
          log.error('Scheduled report check failed', { error: err.message });
        }
      }
    } catch (err) {
      log.error('Heartbeat error', { error: err.message });
    } finally {
      heartbeatRunning = false;
      log.info("Heartbeat tick end", { durationMs: Date.now() - tickStart });
      lastHeartbeatCompleted = Date.now();
    }
  }

  /**
   * Check if a task's executing/claimed subtasks already had their work committed
   * by comparing current git status against the task's baseline snapshot.
   * Returns: true = new uncommitted changes exist (requeue needed),
   *          false = no new changes (work was committed, mark done),
   *          null = check unavailable (no baseline, not a git repo, or fast mode).
   */
  function checkGitDedup(task, projectId) {
    if (config.recovery.mode !== 'safe') return null;
    if (task.gitBaseline == null) return null;

    const projectDir = stateManager.getProject(projectId)?.projectDir;
    if (!projectDir) return null;

    try {
      const currentStatus = execSync('git status --porcelain', {
        cwd: projectDir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      const baselineLines = new Set(
        (task.gitBaseline || '').split('\n').filter(Boolean)
      );
      const currentLines = currentStatus.split('\n').filter(Boolean);
      const newChanges = currentLines.filter(line => !baselineLines.has(line));
      return newChanges.length > 0;
    } catch {
      log.warn('Git dedup check failed, falling back to requeue', { taskId: task.id, projectId });
      return null;
    }
  }

  /** Startup recovery: requeue any claimed/executing subtasks interrupted by dirty restart.
   *  In safe mode, uses git-based dedup to detect subtasks whose work was already committed. */
  function recoverTasks({ mode = 'manual' } = {}) {
    const projects = stateManager.listProjects();
    let recovered = 0;
    let deduplicated = 0;
    let skippedPlanning = 0;
    let resetCount = 0;
    const nowMs = Date.now();
    // In watchdog mode, avoid clobbering legitimate long-running planners.
    // Only reset planning tasks if they are older than the planner timeout + stall threshold.
    const planningStaleMs = (config.tasks.planningTimeoutMs || 300_000) + HEARTBEAT_STALL_MS;

    for (const proj of projects) {
      const data = taskManager.load(proj.id);
      let modified = false;

      for (const task of data.tasks) {
        if (task.status === 'deferred' && task.nextAttemptAt && nowMs >= new Date(task.nextAttemptAt).getTime()) {
          task.status = 'queued';
          task.deferReason = null;
          task.nextAttemptAt = null;
          task.updatedAt = new Date().toISOString();
          task.completedAt = null;
          modified = true;
          recovered++;
          log.info('Task recovery: resumed deferred task', { taskId: task.id, projectId: proj.id });
        }

        // Reviewing recovery is handled in the heartbeat tick (line ~3122) — not here.
        // This recoverTasks() function only runs at startup; heartbeatTick runs every 30s.

        if (task.status !== 'executing' && task.status !== 'planning') continue;

        // Fresh-lease check removed: after restart, sandbox._cleanupOrphans() kills all
        // agent processes. A fresh claimedUntil lease has no process behind it — the subtask
        // is an orphan regardless. Git dedup below handles committed-before-crash cases.

        // Git-based dedup: check if subtask work was already committed (safe mode only)
        // Returns false when no new uncommitted changes exist beyond baseline → work was committed.
        const hasNewChanges = task.status === 'executing' ? checkGitDedup(task, proj.id) : null;

        for (const st of task.subtasks) {
          if (st.status === 'claimed' || st.status === 'executing') {
            const oldAssignee = st.assignee;

            if (hasNewChanges === false) {
              // No new dirty files beyond baseline — subtask's work was committed before crash
              st.status = 'done';
              st.result = 'Recovered: changes already committed (git dedup)';
              st.updatedAt = new Date().toISOString();
              modified = true;
              deduplicated++;
              log.info('Task recovery: dedup — subtask already committed', {
                subtaskId: st.id, previousAssignee: oldAssignee,
                projectId: proj.id, mode: 'safe',
              });
            } else {
              // New changes present, baseline unavailable, or fast mode — standard requeue
              st.status = 'queued';
              st.assignee = null;
              st.claimedUntil = null;
              st.updatedAt = new Date().toISOString();
              modified = true;
              recovered++;
              const reason = config.recovery.mode === 'fast'
                ? 'fast mode — skipped git dedup'
                : hasNewChanges === true
                  ? 'uncommitted changes detected'
                  : 'no git baseline available';
              log.info('Task recovery: requeued subtask', {
                subtaskId: st.id, previousAssignee: oldAssignee,
                projectId: proj.id, reason,
              });
            }
          }
        }

        // If task was in planning state, reset to queued to re-trigger planning
        if (task.status === 'planning') {
          const updatedAtMs = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
          const planningAgeMs = updatedAtMs > 0 ? (nowMs - updatedAtMs) : Infinity;
          const isFreshPlanning = mode === 'watchdog' && Number.isFinite(planningAgeMs) && planningAgeMs < planningStaleMs;
          if (isFreshPlanning) {
            skippedPlanning++;
            log.info('Task recovery: keeping in-flight planning task', {
              taskId: task.id,
              projectId: proj.id,
              planningAgeMs,
              planningStaleMs,
            });
            continue;
          }
          task.status = 'queued';
          task.subtasks = []; // Clear partial plan
          task.updatedAt = new Date().toISOString();
          modified = true;
          recovered++;
          log.info('Task recovery: reset planning task', {
            title: task.title, projectId: proj.id, planningAgeMs,
          });
        }
      }

      // Reset subtasks stuck unroutable due stale provider exclusions.
      // Restart is a natural clean-slate event — cleared conditions warrant a fresh attempt.
      for (const task of data.tasks) {
        for (const st of (task.subtasks || [])) {
          if (shouldClearFailedProvidersExclusion(st)) {
            st.failedProviders = [];
            st.error = null;
            st.updatedAt = new Date().toISOString();
            modified = true;
            resetCount++;
          }
        }
      }

      if (modified) {
        // Persist through the REAL store. The old direct tasks.json write was
        // a dead path after the SQLite migration: recovery counted, logged
        // success, and persisted NOTHING — orphaned claimed/executing subtasks
        // stayed claimed across every restart (#104). _saveWithRetry also
        // makes the watchdog-mode invocation safe against concurrent CAS
        // writers, which the direct write silently clobbered.
        taskManager._saveWithRetry(proj.id, () => data);
      }
    }

    if (resetCount > 0) {
      log.info(`Reset ${resetCount} unroutable subtasks — failedProviders cleared for restart`);
    }
    if (recovered > 0 || deduplicated > 0 || skippedPlanning > 0) {
      log.info('Task recovery complete', { recovered, deduplicated, skippedPlanning, mode });
    }
    return { recovered, deduplicated, skippedPlanning, resetCount, mode };
  }

  /**
   * Per-agent idle loops — the pull model for task pickup.
   *
   * Each non-governor agent runs an independent loop every agentIdlePollMs (default 10s).
   * When idle and eligible, the agent calls seekAndExecute to find and claim the best
   * available subtask it can handle. No central dispatcher — the agent drives itself.
   *
   * Initial delays are staggered 1s per agent so the first wave naturally spreads out
   * rather than all agents firing simultaneously on startup.
   */
  /**
   * Start (or no-op if already running) the idle-poll loop for ONE agent.
   * Split out of startAgentIdleLoops so agents registered AFTER startup —
   * the onboarding wizard's whole 0-agent path — get a loop too. Before
   * this, loops were derived from Object.keys(agents) exactly once at
   * heartbeat start: a fresh install (0 agents at boot) created no loops,
   * so wizard-created agents never pulled work until a service restart.
   */
  function ensureAgentIdleLoop(agentId, initialDelayMs = 1000) {
    if (!idleLoopsActive) return;
    if (idleLoopTimers.has(agentId)) return;
    const IDLE_POLL_MS = config.tasks.agentIdlePollMs || 10_000;

    // Every reschedule replaces this agent's Map entry, so stopHeartbeat can
    // always cancel the pending timer. The old push-once array only tracked the
    // INITIAL timer — a restart inside the poll window left the previous chain
    // alive and doubled every agent's poll rate.
    const poll = () => {
      if (!idleLoopsActive) return;
      if (!agents[agentId]) {
        // Agent deleted — retire its loop instead of polling a ghost.
        idleLoopTimers.delete(agentId);
        return;
      }
      // Schedule the next poll only after this one settles. The busy-agent
      // guard is useful defence-in-depth, but it should not be exercised by
      // dozens of overlapping timers during a long-running seek.
      Promise.resolve()
        .then(() => seekAndExecute(agentId))
        .catch(pollErr => {
          log.warn('Agent idle poll failed — will retry', { agentId, error: pollErr.message });
        })
        .finally(() => {
        if (idleLoopsActive) idleLoopTimers.set(agentId, setTimeout(poll, IDLE_POLL_MS));
        });
    };
    idleLoopTimers.set(agentId, setTimeout(poll, initialDelayMs));
  }

  function startAgentIdleLoops() {
    if (idleLoopsActive) return;
    idleLoopsActive = true;
    const agentIds = Object.keys(agents);
    agentIds.forEach((agentId, idx) => {
      ensureAgentIdleLoop(agentId, (idx % 10) * 1000); // spread first wave over 10s
    });

    log.info('Agent idle loops started', { agentCount: agentIds.length });
  }

  function startHeartbeat() {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
    startAgentIdleLoops();
    log.info('Task heartbeat started', { intervalSec: HEARTBEAT_INTERVAL_MS / 1000 });
  }

  // Idle-loop top-up: agents registered after startup (wizard, API) get their
  // pull loop on the next heartbeat tick. Cheap — ensure is a no-op for
  // agents that already have a timer.
  function ensureIdleLoopsForAllAgents() {
    if (!idleLoopsActive) return;
    for (const id of Object.keys(agents)) ensureAgentIdleLoop(id);
  }

  /** Stop the heartbeat interval and agent idle loops (graceful shutdown / testing). */
  function stopHeartbeat() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    idleLoopsActive = false;
    for (const t of idleLoopTimers.values()) clearTimeout(t);
    idleLoopTimers.clear();
  }

  // Epoch ms (not ISO string) so health-subsystems can do Date.now() - recovery.
  // Tests and getHealthState consumers historically mixed string/number; we store ms.
  let lastWatchdogRecovery = null;
  let lastStallReleaseAt = 0;
  let watchdogInterval = null;

  /**
   * Detect a stalled heartbeat and force-release the single-flight lock so the
   * next interval can tick. Without release, a hung tick permanently blocks
   * all future heartbeats (dead scheduler until process restart).
   *
   * Concurrency risk: the hung tick may still be running and complete later.
   * That is accepted — two overlapping ticks is better than zero forever.
   * Cooldown (HEARTBEAT_STALL_MS) prevents thrash if both keep hanging.
   */
  function watchdogCheck() {
    const now = Date.now();
    const elapsed = now - lastHeartbeatCompleted;
    if (!heartbeatRunning || elapsed <= HEARTBEAT_STALL_MS) return;

    // Already released a stall recently — wait for a real tick or next window.
    if (lastStallReleaseAt > 0 && (now - lastStallReleaseAt) < HEARTBEAT_STALL_MS) {
      return;
    }

    log.error('Heartbeat stall detected — forcing single-flight release', {
      stalledMs: elapsed,
      thresholdMs: HEARTBEAT_STALL_MS,
    });
    heartbeatRunning = false;
    lastStallReleaseAt = now;
    lastWatchdogRecovery = now;
    if (eventBus) {
      eventBus.emit('heartbeat:stall_detected', {
        stalledMs: elapsed,
        detectedAt: new Date(now).toISOString(),
        recovered: true,
      }).catch(err => log.warn('EventBus emission failed', { event: 'heartbeat:stall_detected', error: err.message }));
    }
  }

  /** Start the watchdog interval. */
  function startWatchdog() {
    if (watchdogInterval) return;
    // Check more frequently than the stall threshold (e.g. half the threshold or 5s min)
    const intervalMs = Math.max(5000, Math.floor(HEARTBEAT_STALL_MS / 2));
    watchdogInterval = setInterval(watchdogCheck, intervalMs);
    log.info('Heartbeat watchdog started', { intervalMs });
  }

  /** Stop the watchdog interval. */
  function stopWatchdog() {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
  }

  /** Set the strategistEvaluate callback (deferred wiring for circular deps). */
  function setStrategistEvaluate(fn) {
    strategistEvaluate = fn;
  }

  /** Return heartbeat health state for subsystem status reporting. */
  function getHealthState() {
    return {
      heartbeatRunning,
      lastHeartbeatCompleted,
      lastWatchdogRecovery,
      heartbeatStallMs: HEARTBEAT_STALL_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      inFlightPlanningTasks: planningTasksInFlight.size,
      inFlightAuditTasks: auditTasksInFlight.size,
      busyAgents: agentCookies.size,
      agentCookies: agentCookies.snapshot(),
      activePickups,
      idleLoopsActive,
    };
  }

  return {
    planTask,
    seekAndExecute,
    reviewTask,
    heartbeatTick,
    recoverTasks,
    selectCircuitBreakerFallback, // exported for the fallback-rule tests (#103)
    startHeartbeat,
    stopHeartbeat,
    watchdogCheck,
    startWatchdog,
    stopWatchdog,
    resetHeartbeatRunning: () => { heartbeatRunning = false; lastHeartbeatCompleted = Date.now(); },
    /** Test/ops: pretend a tick is stuck past the stall threshold (does not run work). */
    _simulateHeartbeatStallForTest: () => {
      heartbeatRunning = true;
      lastHeartbeatCompleted = Date.now() - HEARTBEAT_STALL_MS - 1;
    },
    resetPatternScan: () => { lastPatternScanAt = 0; },
    setStrategistEvaluate,
    getHealthState,
    getPaceGateStatus,
    setPaceOverride,
    _lastPatternScanAt: () => lastPatternScanAt,
    _PATTERN_SCAN_COOLDOWN_MS: () => PATTERN_SCAN_COOLDOWN_MS,
    getAgentCookies: () => agentCookies,
  };
}
