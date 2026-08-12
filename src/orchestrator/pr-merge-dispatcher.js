// src/orchestrator/pr-merge-dispatcher.js
// ─────────────────────────────────────────────────────────────────────────────
// PR Workflow Phase 3 — Automated merge dispatch
//
// Listens for `pr:approved` events from PrStore. On each event:
//   1. Evaluate the merge policy — synapse-self block, requiresOperatorApproval,
//      autoMergePolicy ('operator' | 'n-approvals:N' | 'never'), stale-approval
//      check.
//   2. If policy says merge: verify source SHA, checkout target, run
//      `git merge --no-ff`, capture merge commit, call markMerged.
//   3. Optionally delete the source branch if repoConfig.deleteBranchOnMerge.
//   4. Soft-fail at every step; conflicts abort cleanly (`git merge --abort`)
//      and leave the PR in 'approved' for operator intervention.
//
// Hard rule per operator (2026-06-01): synapse-project auto-merge is BLOCKED
// regardless of policy. Review still happens (Phase 2 dispatches reviewers
// for synapse PRs), but the merge is operator-only. This is the
// self-modification safety override: /path/to/synapse IS the running process,
// and a `git merge` rewriting its own source tree mid-execution is a class
// of bug operator-mediated deploy is required to safely sequence.
//
// Per-project merge mutex: in-process Map<projectId, Promise>. Concurrent
// merges on the same project serialize via this — sufficient for the
// single-process synapse model.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { resolve as pathResolve, sep as pathSep, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../logger.js';

const log = createLogger('pr-merge-dispatcher');

const DEFAULT_MERGE_COMMAND_TIMEOUT_MS = 60 * 1000;

// ─── Wait-reason decision table (R2 reviewer-requested explicitness) ─────────
// Maps wait reasons to whether the merge endpoint can satisfy them with a
// normal merge call vs requiring an explicit `force-merge` operator override.
// Phase 3 merge endpoint re-evaluates evaluateMergePolicy defensively (R2
// Change 6 — closes alice R1's bypass-path catch). The endpoint uses this
// table to decide which `wait` outcomes are recoverable by an authenticated
// operator/external call vs which demand explicit force.
//
// Allowed without `force`: reasons where the merge is INTENDED to be operator/
// external-driven — the endpoint is the canonical exit path.
//   - 'policy_operator'           — autoMergePolicy='operator' (default)
//   - 'policy_external'           — autoMergePolicy='external' (CI/external)
//   - 'requires_operator_approval' — per-PR flag (live deploy etc.)
//   - 'needs_more_approvals'      — operator can force the count
//
// Requires explicit `force-merge`: reasons that signal an active safety
// gate that the endpoint should NOT bypass silently.
//   - 'auto_merge_blocked'        — operator/project explicitly killed auto-merge
//   - 'policy_never'              — explicit "no merges, ever, period"
//   - 'stale_approval'            — source SHA drifted past approval
//   - 'no_approved_source_sha'    — approval shape is broken
//   - 'policy_unknown'            — config corruption
//   - 'not_approved'              — defensive
export const MERGE_REASONS_ALLOWED_WITHOUT_FORCE = Object.freeze([
  'policy_operator', 'policy_external', 'requires_operator_approval', 'needs_more_approvals',
]);
export const MERGE_REASONS_REQUIRING_FORCE = Object.freeze([
  'auto_merge_blocked', 'policy_never', 'stale_approval',
  'no_approved_source_sha', 'policy_unknown', 'not_approved',
]);

// ─── Policy evaluation (pure function) ────────────────────────────────────────

/**
 * Decide what to do with an approved PR. Pure function — exported for unit
 * testing without git or process state.
 *
 * @param {object} pr             PR record (from PrStore)
 * @param {object} [repoConfig]   Per-project repoConfig
 *
 * Returns one of:
 *   { action: 'merge', mergeBy: 'auto' }
 *   { action: 'wait', reason: '<reason>' }
 *
 * Reasons:
 *   'not_approved'              — pr.status !== 'approved'
 *   'auto_merge_blocked'        — repoConfig.blockAutoMerge === true (defense-
 *                                 in-depth kill switch; replaces R1 hardcoded
 *                                 `projectId === 'synapse'` per R2 Change 1).
 *                                 Paired with requireOperatorApprovalAlways
 *                                 in pr-store.js for dual-control depth.
 *   'requires_operator_approval' — pr.requiresOperatorApproval is true
 *   'policy_operator'           — autoMergePolicy === 'operator' (default)
 *   'policy_external'           — autoMergePolicy === 'external' (R2 Change 3)
 *   'policy_never'              — autoMergePolicy === 'never'
 *   'needs_more_approvals'      — n-approvals:N but only M<N distinct approvers
 *   'no_approved_source_sha'    — latest approval missing approvedSourceSha
 *   'policy_unknown'            — config corruption
 */
/**
 * Resolve whether auto-merge is blocked for a project. Computed default
 * (path-containment vs SYNAPSE_ROOT_DIR) + stored override (repoConfig
 * .blockAutoMerge), evaluated FRESH per dispatch.
 *
 * Returns { blocked: bool, detail: 'config_explicit' | 'self_modifying_inferred' | null }
 *
 * Rationale (R3 Claude Opus deliberation 2026-06-09, third corner):
 * The earlier `repoConfig.blockAutoMerge === true` check was pure stored
 * state. R1 wanted it computed correctly at write time; R2 wanted a
 * migration to backfill it; R3 observed both treat it as persisted, which
 * loses the "default-correct on first read" property. Computed default +
 * stored override evaluated per dispatch gives operator override, no
 * backfill migration burden, and symlink-resolved path containment
 * (gina R1 critique of process.cwd() brittleness — uses
 * SYNAPSE_ROOT_DIR env or this-file-derived module root, fs.realpathSync
 * on both sides to follow symlinks).
 *
 * Caller passes projectDir; if null/undefined, falls back to stored-state-
 * only (config_explicit OR nothing) — used by call sites that can't cheaply
 * look up the project dir (e.g. webhook handlers).
 */
export function resolveAutoMergeBlock(repoConfig, projectDir) {
  // Explicit operator override wins (both directions).
  if (repoConfig?.blockAutoMerge === false) return { blocked: false, detail: null };
  if (repoConfig?.blockAutoMerge === true) return { blocked: true, detail: 'config_explicit' };
  // Stored-state-only fall-through if no projectDir to evaluate against.
  if (!projectDir) return { blocked: false, detail: null };
  // Computed default — is the project's projectDir inside the synapse root?
  try {
    const moduleRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const root = realpathSync(process.env.SYNAPSE_ROOT_DIR || moduleRoot);
    const real = realpathSync(pathResolve(projectDir));
    if (real === root || real.startsWith(root + pathSep)) {
      return { blocked: true, detail: 'self_modifying_inferred' };
    }
  } catch (err) {
    // Path resolution failed (e.g. projectDir doesn't exist on disk).
    // Fall through to "not blocked" — operator can still set blockAutoMerge
    // explicitly. Logged at warn so operators can spot mis-configured
    // projects without it being noisy.
    log.warn('resolveAutoMergeBlock path resolution failed', {
      projectDir, error: err.message,
    });
  }
  return { blocked: false, detail: null };
}

export function evaluateMergePolicy(pr, repoConfig = {}, projectDir = null) {
  if (!pr || pr.status !== 'approved') {
    return { action: 'wait', reason: 'not_approved' };
  }

  // R3 Change: replace the static `blockAutoMerge === true` check with
  // resolveAutoMergeBlock. Computed default + stored override evaluated
  // fresh per dispatch — collapses R1's process.cwd() brittleness,
  // R2's missing migration story, and the second hardcode at pr-store.js
  // into one function. Preserves the existing `auto_merge_blocked` reason
  // for downstream consumers (MERGE_REASONS_*, chat-notice handler);
  // sub-detail surfaces in decision.detail for observability.
  if (repoConfig.blockAutoMerge === true || projectDir) {
    const block = resolveAutoMergeBlock(repoConfig, projectDir);
    if (block.blocked) {
      return { action: 'wait', reason: 'auto_merge_blocked', detail: block.detail };
    }
  }

  // Operator-approval flag overrides any auto policy
  if (pr.requiresOperatorApproval === true) {
    return { action: 'wait', reason: 'requires_operator_approval' };
  }

  const policy = repoConfig.autoMergePolicy || 'operator';
  if (policy === 'operator') return { action: 'wait', reason: 'policy_operator' };
  // 'external' policy: Synapse reviews internally; external system (CI bot,
  // GitHub Action, person) calls the merge endpoint after their own review.
  // Behaviorally identical to 'operator' for the auto-dispatcher; the
  // distinction surfaces in the chat notice + endpoint allow-without-force list.
  if (policy === 'external') return { action: 'wait', reason: 'policy_external' };
  if (policy === 'never') return { action: 'wait', reason: 'policy_never' };

  // n-approvals:N
  const m = /^n-approvals:(\d+)$/.exec(policy);
  if (!m) return { action: 'wait', reason: 'policy_unknown' };
  const required = parseInt(m[1], 10);

  // Distinct approvers whose approvedSourceSha matches the LATEST approval's
  // SHA. Stale approvals (against an older source SHA) don't count.
  const approvals = (pr.reviews || []).filter(r => r.status === 'approved');
  if (approvals.length === 0) return { action: 'wait', reason: 'not_approved' };
  const latestSha = approvals[approvals.length - 1].approvedSourceSha;
  if (!latestSha) return { action: 'wait', reason: 'no_approved_source_sha' };
  const distinctApprovers = new Set(
    approvals
      .filter(r => r.approvedSourceSha === latestSha)
      .map(r => r.reviewer)
  );

  if (distinctApprovers.size < required) {
    return { action: 'wait', reason: 'needs_more_approvals', have: distinctApprovers.size, need: required };
  }

  return { action: 'merge', mergeBy: 'auto', approvedSourceSha: latestSha };
}

// ─── Git helpers (impure, exported for integration tests) ────────────────────

function gitCmd(args, cwd, timeoutMs = DEFAULT_MERGE_COMMAND_TIMEOUT_MS) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 4,
  });
}

export function gitRevParse(projectDir, ref) {
  try { return gitCmd(['rev-parse', '--verify', ref], projectDir).trim(); }
  catch (err) { log.warn('rev-parse failed', { ref, error: err.message }); return null; }
}

export function gitCurrentBranch(projectDir) {
  try { return gitCmd(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir).trim(); }
  catch (err) {
    log.debug('current branch lookup failed', { projectDir, error: err.message });
    return null;
  }
}

/**
 * Attempt the merge. Returns:
 *   { ok: true, mergeCommit }
 *   { ok: false, reason: 'conflict' | 'checkout_failed' | 'merge_failed', error }
 *
 * On conflict: `git merge --abort` is run to leave the working tree clean.
 * The caller is responsible for restoring the original branch state if needed.
 */
export function performGitMerge(projectDir, sourceBranch, targetBranch, prTitle) {
  const originalBranch = gitCurrentBranch(projectDir);

  // Step 1: checkout target
  try {
    gitCmd(['checkout', targetBranch], projectDir);
  } catch (err) {
    log.warn('merge: checkout target failed', { targetBranch, error: err.message });
    return { ok: false, reason: 'checkout_failed', error: err.message };
  }

  // Step 2: attempt merge
  const mergeMsg = `Merge PR: ${String(prTitle || '').slice(0, 200)}`;
  try {
    gitCmd(['merge', '--no-ff', '-m', mergeMsg, '--', sourceBranch], projectDir);
  } catch (err) {
    // Conflict — abort cleanly
    try { gitCmd(['merge', '--abort'], projectDir); }
    catch (abortErr) { log.debug('merge abort was unnecessary or failed', { error: abortErr.message }); }
    // Try to restore original branch
    if (originalBranch && originalBranch !== targetBranch) {
      try { gitCmd(['checkout', originalBranch], projectDir); }
      catch (restoreErr) {
        log.warn('merge: failed to restore original branch', { originalBranch, error: restoreErr.message });
      }
    }
    log.warn('merge: conflict or merge_failed', { sourceBranch, targetBranch, error: err.message });
    return { ok: false, reason: 'merge_failed', error: err.message };
  }

  // Step 3: capture merge commit SHA
  const mergeCommit = gitRevParse(projectDir, 'HEAD');
  if (!mergeCommit) {
    log.error('merge: cannot read merge commit SHA', { sourceBranch, targetBranch });
    return { ok: false, reason: 'sha_read_failed' };
  }

  return { ok: true, mergeCommit };
}

export function deleteBranch(projectDir, branchName) {
  try {
    gitCmd(['branch', '-d', '--', branchName], projectDir);
    return true;
  } catch (err) {
    log.warn('branch delete failed (non-fatal)', { branchName, error: err.message });
    return false;
  }
}

// ─── Dispatcher factory ───────────────────────────────────────────────────────

export function createPrMergeDispatcher(deps) {
  const {
    prStore, events, stateManager, addMessage, PROJECT_DIR,
  } = deps;

  // Per-project merge mutex. Concurrent merges on the same project serialize.
  const projectMergeLocks = new Map();

  /**
   * Acquire the merge lock for a project; runs `fn()` once the previous merge
   * (if any) settled. Returns whatever fn() returns.
   */
  async function withProjectLock(projectId, fn) {
    const prev = projectMergeLocks.get(projectId) || Promise.resolve();
    const cur = prev.then(fn, fn);  // run regardless of prev outcome
    projectMergeLocks.set(projectId, cur.then(
      () => { if (projectMergeLocks.get(projectId) === cur) projectMergeLocks.delete(projectId); },
      () => { if (projectMergeLocks.get(projectId) === cur) projectMergeLocks.delete(projectId); },
    ));
    return cur;
  }

  /**
   * Core dispatch. Called from the pr:approved subscriber. Exposed for
   * direct invocation (smoke tests, manual re-trigger).
   */
  async function dispatchMerge(pr) {
    if (!pr || !pr.projectId || !pr.id) {
      log.warn('dispatchMerge: invalid pr payload', { pr });
      return { ok: false, reason: 'invalid_pr' };
    }
    const projectId = pr.projectId;
    const repoConfig = stateManager?.getProjectRepoConfig?.(projectId) || {};
    // Look up projectDir for resolveAutoMergeBlock's path-containment check.
    // Null-safe — evaluateMergePolicy falls back to stored-state-only when
    // projectDir is missing.
    const projectDir = stateManager?.getProject?.(projectId)?.projectDir || null;

    const decision = evaluateMergePolicy(pr, repoConfig, projectDir);
    log.info('merge decision', { prId: pr.id, projectId, decision });

    if (decision.action !== 'merge') {
      // Post a friendly chat notice for the more-visible decisions.
      // (R2 Change 1: synapse_self_merge_blocked is gone, replaced by
      // auto_merge_blocked which is the per-project flag's reason.)
      const visibleReasons = ['auto_merge_blocked', 'requires_operator_approval',
                              'needs_more_approvals', 'policy_external'];
      if (visibleReasons.includes(decision.reason)) {
        try {
          let msg;
          switch (decision.reason) {
            case 'auto_merge_blocked':
              msg = `PR ${pr.id} approved — auto-merge is blocked on this project (blockAutoMerge=true). Operator merge required via API.`;
              break;
            case 'requires_operator_approval':
              msg = `PR ${pr.id} approved — operator merge required.`;
              break;
            case 'policy_external':
              msg = `PR ${pr.id} approved — external approval required (autoMergePolicy=external). External system can merge via API.`;
              break;
            case 'needs_more_approvals':
              msg = `PR ${pr.id} approved by ${decision.have} of ${decision.need} required reviewers.`;
              break;
            default:
              msg = `PR ${pr.id}: ${decision.reason}`;
          }
          addMessage(projectId, '#general', 'System', msg, 'system', {});
        } catch (messageErr) {
          log.debug('merge decision notification failed', { prId: pr.id, error: messageErr.message });
        }
      }
      return { ok: false, reason: decision.reason };
    }

    // Serialize all merges on this project
    return withProjectLock(projectId, () => doMerge(pr, repoConfig, decision));
  }

  async function doMerge(pr, repoConfig, decision) {
    const projectId = pr.projectId;
    const projectDir = stateManager?.getProject?.(projectId)?.projectDir || PROJECT_DIR;

    // Verify source SHA still matches the approved SHA (Codex R2 invariant
    // also enforced by markMerged, but check early so we don't pollute
    // working tree with a doomed checkout).
    const currentSourceSha = gitRevParse(projectDir, pr.sourceBranch);
    if (!currentSourceSha) {
      log.warn('merge: cannot read source SHA', { prId: pr.id, sourceBranch: pr.sourceBranch });
      return { ok: false, reason: 'source_sha_missing' };
    }
    if (currentSourceSha !== decision.approvedSourceSha) {
      log.warn('merge: source SHA drifted since approval', {
        prId: pr.id, currentSourceSha, approvedSourceSha: decision.approvedSourceSha,
      });
      try {
        addMessage(projectId, '#general', 'System',
          `PR ${pr.id} merge aborted: source branch advanced past approval. Re-review needed.`,
          'system', {});
      } catch (messageErr) {
        log.debug('stale approval notification failed', { prId: pr.id, error: messageErr.message });
      }
      return { ok: false, reason: 'stale_approval' };
    }

    // Attempt the merge
    const result = performGitMerge(projectDir, pr.sourceBranch, pr.targetBranch, pr.title);
    if (!result.ok) {
      log.warn('merge: performGitMerge failed', { prId: pr.id, reason: result.reason });
      try {
        addMessage(projectId, '#general', 'System',
          `PR ${pr.id} auto-merge failed (${result.reason}). PR remains approved; operator intervention required.`,
          'system', {});
      } catch (messageErr) {
        log.debug('merge failure notification failed', { prId: pr.id, error: messageErr.message });
      }
      return result;
    }

    // Record the merge
    try {
      prStore.markMerged(projectId, pr.id, {
        mergeCommit: result.mergeCommit,
        currentSourceSha,
      });
    } catch (err) {
      log.error('merge: markMerged failed (merge happened but record did not)', {
        prId: pr.id, mergeCommit: result.mergeCommit, error: err.message,
      });
      return { ok: false, reason: 'markMerged_failed', error: err.message, mergeCommit: result.mergeCommit };
    }

    // Optionally delete source branch
    let branchDeleted = false;
    if (repoConfig.deleteBranchOnMerge) {
      branchDeleted = deleteBranch(projectDir, pr.sourceBranch);
    }

    log.info('PR auto-merged', {
      prId: pr.id, projectId,
      sourceBranch: pr.sourceBranch, targetBranch: pr.targetBranch,
      mergeCommit: result.mergeCommit, branchDeleted,
    });
    try {
      addMessage(projectId, '#general', 'System',
        `PR ${pr.id} auto-merged: ${pr.sourceBranch} → ${pr.targetBranch} (${result.mergeCommit.slice(0, 8)})` +
        (branchDeleted ? ' — source branch deleted' : ''),
        'system', {});
    } catch (messageErr) {
      log.debug('merge success notification failed', { prId: pr.id, error: messageErr.message });
    }

    return { ok: true, mergeCommit: result.mergeCommit, branchDeleted };
  }

  // Subscribe to pr:approved — fire-and-forget so addReview doesn't block.
  if (events?.on) {
    events.on('pr:approved', (pr) => {
      dispatchMerge(pr).catch(err => {
        log.error('dispatchMerge async error', { prId: pr?.id, error: err.message });
      });
    });
    log.info('PR merge dispatcher subscribed to pr:approved');
  }

  return { dispatchMerge };
}
