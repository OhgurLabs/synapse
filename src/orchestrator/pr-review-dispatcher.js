// src/orchestrator/pr-review-dispatcher.js
// ─────────────────────────────────────────────────────────────────────────────
// PR Workflow Phase 2 — Automated review dispatch
//
// Listens for `pr:opened` events from PrStore. On each event:
//   1. Pick an eligible reviewer agent (role=reviewer, id != PR.author,
//      active, not busy/cooling, not author's own PR)
//   2. Compute the diff: git diff <target>..<source> in projectDir
//   3. Build a review prompt (similar shape to buildAuditPrompt)
//   4. Dispatch via reviewer.send() with a turn limit + timeout
//   5. Parse the response for VERDICT: APPROVED|CHANGES_REQUESTED|COMMENT
//   6. Submit verdict via PrStore.addReview with current sourceBranch HEAD SHA
//
// Design choices (per Phase 2 converged design, deliberation MD section R3):
//   - Direct .send() dispatch matches the strategist pattern (architect.send,
//     researcher.send) — NOT through the campaign/subtask system. The reviewer
//     is invoked as an internal orchestration call, not a discoverable subtask.
//   - Verdict comes from STRUCTURED TEXT response parsing. Matches the existing
//     audit/summary pattern. No new tool surface needed for v1.
//   - Diff is INLINE in the prompt with 4000-char truncation. Phase 2.5 could
//     switch to tool-call delivery for large diffs.
//   - If no reviewer is available, log warn + post a chat notice. PR stays
//     open; operator can review manually via the existing HTTP endpoints.
//   - Soft-fail at every step. The PR record is the source of truth; a failed
//     review dispatch doesn't corrupt PR state.
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import { createLogger } from '../logger.js';

const log = createLogger('pr-review-dispatcher');

const DEFAULT_REVIEW_MAX_TURNS = 5;
const DEFAULT_DIFF_BUDGET_CHARS = 4000;
const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000; // 5 min hard cap

// Verdict markers the reviewer agent must include at the end of their response.
const VERDICT_REGEX = /VERDICT:\s*(APPROVED|CHANGES[\s_-]?REQUESTED|COMMENT)/i;

function normalizeVerdict(rawVerdict) {
  const v = rawVerdict.toUpperCase().replace(/[\s_-]/g, '');
  if (v === 'APPROVED') return 'approved';
  if (v === 'CHANGESREQUESTED') return 'changes-requested';
  // Phase 1.1 enum is 'commented' (past tense); must match PrStore.REVIEW_STATUSES
  return 'commented';
}

/**
 * Parse the reviewer agent's text response for a verdict marker.
 * Returns { status, summary } on success, null on failure.
 *
 * Why the regex tolerates "CHANGES REQUESTED" + "CHANGES_REQUESTED" +
 * "CHANGES-REQUESTED": different agents normalize formatting differently
 * (claude tends to use spaces, codex uses underscores). Matching all three
 * avoids the brittle "verbatim VERDICT: CHANGES_REQUESTED required" trap.
 */
export function parseVerdict(responseText) {
  if (!responseText || typeof responseText !== 'string') return null;
  const match = responseText.match(VERDICT_REGEX);
  if (!match) return null;
  const status = normalizeVerdict(match[1]);
  // Summary is everything BEFORE the verdict line — strip trailing whitespace.
  const summary = responseText.slice(0, match.index).trim() || '(no summary provided)';
  return { status, summary };
}

/**
 * Run git diff target..source in the project dir; truncate over budget.
 * Returns null on git error (not a repo, branches missing, etc.).
 */
export function computeDiff(projectDir, targetBranch, sourceBranch, budgetChars = DEFAULT_DIFF_BUDGET_CHARS) {
  try {
    // Use --no-color and -- for safety
    const diff = execSync(`git diff --no-color ${targetBranch}..${sourceBranch} --`, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024 * 4,
    });
    if (diff.length === 0) return '(no changes between branches)';
    if (diff.length > budgetChars) {
      return diff.slice(0, budgetChars) + '\n\n... (diff truncated at ' + budgetChars + ' chars)';
    }
    return diff;
  } catch (err) {
    log.warn('computeDiff failed', { projectDir, targetBranch, sourceBranch, error: err.message });
    return null;
  }
}

/**
 * Read source branch HEAD SHA for approval-binding. Returns null on git error.
 */
function getSourceSha(projectDir, sourceBranch) {
  try {
    return execSync(`git rev-parse ${sourceBranch}`, {
      cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    log.warn('getSourceSha failed', { projectDir, sourceBranch, error: err.message });
    return null;
  }
}

/**
 * Build the review-mode prompt. Matches buildAuditPrompt's shape:
 * persona (if available) → MODE marker → context → verdict instruction → diff.
 */
export function buildReviewPrompt(reviewerAgent, pr, diff, projectId) {
  const lines = [];
  if (reviewerAgent?.persona) {
    lines.push(reviewerAgent.persona);
    lines.push('---');
  }
  lines.push('MODE: PR REVIEW');
  lines.push(`PR: ${pr.id}`);
  lines.push(`Project: ${projectId}`);
  lines.push(`Branch: ${pr.sourceBranch} → ${pr.targetBranch}`);
  lines.push(`Author: ${pr.author}${pr.authorRole ? ` (${pr.authorRole})` : ''}`);
  if (pr.title) lines.push(`Title: ${pr.title}`);
  if (pr.description) lines.push(`Description: ${pr.description}`);
  lines.push('');
  lines.push('Review the diff below. Check for:');
  lines.push('- Correctness: does the change do what the PR title/description claims?');
  lines.push('- Quality: bugs, missed edge cases, missing error handling?');
  lines.push('- Style: matches surrounding code conventions?');
  lines.push('- Safety: any destructive operations, secret leaks, or governance violations?');
  lines.push('');
  lines.push('On the LAST LINE of your response, output EXACTLY one of:');
  lines.push('  VERDICT: APPROVED');
  lines.push('  VERDICT: CHANGES_REQUESTED');
  lines.push('  VERDICT: COMMENT');
  lines.push('Above that line, write your review summary in 1–3 paragraphs.');
  lines.push('');
  lines.push('--- DIFF ---');
  lines.push(diff || '(diff unavailable)');
  lines.push('--- END DIFF ---');
  return lines.join('\n');
}

/**
 * Eligibility filter for review candidates.
 *
 * Rules:
 *   - id !== PR.author (R1 reviewer != author invariant; addReview enforces too)
 *   - role === 'reviewer'   (dedicated reviewer-role agents only for v1)
 *   - _status === 'active'  (not inactive)
 *   - not busy             (no in-flight cookie)
 *   - not cooling          (circuit-breaker / cooldown)
 *
 * Returns the FIRST matching agent (stable selection — no rotation logic yet;
 * adding rotation is straightforward when we observe reviewer pile-up).
 */
export function selectReviewer(deps, projectId, authorId) {
  const { getAgents, busyAgents, isAgentCoolingDown } = deps;
  const agents = getAgents();
  for (const [id, agent] of Object.entries(agents)) {
    if (id === authorId) continue;
    if (agent.role !== 'reviewer') continue;
    if (agent._status === 'inactive') continue;
    if (busyAgents && busyAgents.has && busyAgents.has(id)) continue;
    if (isAgentCoolingDown && isAgentCoolingDown(id, projectId)) continue;
    return agent;
  }
  return null;
}

/**
 * Race two promises: agent send + timeout. Mirrors execution.js's withTimeout
 * pattern. If withTimeout is provided in deps, use it; else local fallback.
 */
function withTimeoutFallback(promise, ms, agentId) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`review timeout (${ms}ms) for ${agentId}`)), ms
    )),
  ]);
}

export function createPrReviewDispatcher(deps) {
  const {
    getAgents,
    prStore,
    events,
    stateManager,
    addMessage,
    PROJECT_DIR,
    busyAgents,
    isAgentCoolingDown,
    withTimeout,
    config,
  } = deps;

  const reviewMaxTurns = config?.pr?.reviewMaxTurns || DEFAULT_REVIEW_MAX_TURNS;
  const reviewTimeoutMs = config?.pr?.reviewTimeoutMs || DEFAULT_REVIEW_TIMEOUT_MS;
  const diffBudget = config?.pr?.diffBudgetChars || DEFAULT_DIFF_BUDGET_CHARS;

  /**
   * Core dispatch flow. Called from the pr:opened subscriber and
   * exposed for direct invocation (smoke tests, manual re-review).
   */
  async function dispatchReview(pr) {
    if (!pr || !pr.projectId || !pr.id) {
      log.warn('dispatchReview: invalid pr payload', { pr });
      return { ok: false, reason: 'invalid_pr' };
    }
    const projectId = pr.projectId;
    log.info('Dispatching review', { prId: pr.id, projectId, author: pr.author });

    const reviewer = selectReviewer({ getAgents, busyAgents, isAgentCoolingDown }, projectId, pr.author);
    if (!reviewer) {
      log.warn('No eligible reviewer agent for PR', { prId: pr.id, projectId, author: pr.author });
      try {
        addMessage(projectId, '#general', 'System',
          `PR ${pr.id} opened — no reviewer agent available (operator review required).`,
          'system', {});
      } catch (_) { /* addMessage soft-fail */ }
      return { ok: false, reason: 'no_reviewer' };
    }

    const projectDir = stateManager?.getProject?.(projectId)?.projectDir || PROJECT_DIR;
    const diff = computeDiff(projectDir, pr.targetBranch, pr.sourceBranch, diffBudget);
    if (diff === null) {
      log.warn('Diff computation failed; aborting review dispatch', { prId: pr.id });
      return { ok: false, reason: 'diff_failed' };
    }

    const prompt = buildReviewPrompt(reviewer, pr, diff, projectId);
    log.info('Reviewer selected', { prId: pr.id, reviewer: reviewer.id, diffLen: diff.length });

    const race = withTimeout || withTimeoutFallback;

    let rawResponse;
    try {
      rawResponse = await race(
        reviewer.send(prompt, projectDir, { maxTurns: reviewMaxTurns }),
        reviewTimeoutMs,
        reviewer.id,
      );
    } catch (err) {
      log.error('Reviewer dispatch failed', { prId: pr.id, reviewer: reviewer.id, error: err.message });
      return { ok: false, reason: 'send_failed', error: err.message };
    }

    // Normalize response → string (matches commit 0df374f8 + d950e914 pattern)
    const text = typeof rawResponse === 'string' ? rawResponse
      : (rawResponse?.text != null ? String(rawResponse.text)
                                   : (rawResponse == null ? '' : String(rawResponse)));

    const parsed = parseVerdict(text);
    if (!parsed) {
      log.error('Reviewer response missing VERDICT marker', {
        prId: pr.id, reviewer: reviewer.id, responseLen: text.length,
        tail: text.slice(-200),
      });
      // Persist a 'commented' review with the raw text so operator can see what happened.
      // (Phase 1.1 enum is 'commented'; previously this used 'comment' which threw.)
      try {
        prStore.addReview(projectId, pr.id, {
          reviewer: reviewer.id,
          status: 'commented',
          summary: text.slice(0, 2000) + (text.length > 2000 ? '\n... (truncated)' : ''),
          approvedSourceSha: null,
        });
      } catch (e) {
        log.warn('Fallback commented-review write failed', { prId: pr.id, error: e.message });
      }
      return { ok: false, reason: 'parse_failed' };
    }

    // Bind approval to the current source HEAD SHA (Codex R2 invariant)
    const sourceSha = parsed.status === 'approved'
      ? getSourceSha(projectDir, pr.sourceBranch)
      : null;

    try {
      const updated = prStore.addReview(projectId, pr.id, {
        reviewer: reviewer.id,
        status: parsed.status,
        summary: parsed.summary,
        approvedSourceSha: sourceSha,
      });
      log.info('Review submitted', {
        prId: pr.id, reviewer: reviewer.id, status: parsed.status,
        approvedSourceSha: sourceSha, newPrStatus: updated.status,
      });
      try {
        addMessage(projectId, '#general', 'System',
          `PR ${pr.id} reviewed by @${reviewer.id}: ${parsed.status}` +
          (parsed.status === 'approved' && pr.requiresOperatorApproval
            ? ' (awaiting operator merge)' : ''),
          'system', {});
      } catch (_) { /* addMessage soft-fail */ }
      return { ok: true, prStatus: updated.status, reviewerId: reviewer.id, verdict: parsed.status };
    } catch (err) {
      log.error('addReview failed', { prId: pr.id, reviewer: reviewer.id, error: err.message });
      return { ok: false, reason: 'addReview_failed', error: err.message };
    }
  }

  // Subscribe to pr:opened — fire-and-forget so PrStore.openPR doesn't block.
  if (events?.on) {
    events.on('pr:opened', (pr) => {
      dispatchReview(pr).catch(err => {
        log.error('dispatchReview async error', { prId: pr?.id, error: err.message });
      });
    });
    log.info('PR review dispatcher subscribed to pr:opened');
  }

  return { dispatchReview };
}
