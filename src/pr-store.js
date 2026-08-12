// pr-store.js — Pull Request persistence (BYOH PR workflow Phase 1).
//
// Per-project storage at .synapse/projects/<projectId>/prs/
//   <pr_id>.json   — one file per PR (atomic per-PR writes)
//   index.json     — lightweight manifest used for listings
//
// Design (converged via 2 rounds, 5 reviewers):
//
//   - One-file-per-PR (Gemini R1): avoids the tasks.json monolithic-JSON
//     scaling regression. Listing reads index.json only; detail/review/merge
//     reads+writes the individual PR file.
//
//   - Atomic writes via temp+rename (GLM R2): ext4/xfs `rename(2)` is atomic.
//     Mirrors the pattern in src/ssrf-config-store.js _atomicWrite.
//
//   - approvedSourceSha per review (Codex R2): each review records the git
//     HEAD sha it reviewed. Merge step verifies current source HEAD matches.
//     A new commit on the source branch invalidates prior approvals.
//
//   - requiresOperatorApproval flag (Grok R1): auto-set true when the
//     project is synapse OR the target is the live-deployment branch.
//     When true, merge ignores autoMergePolicy and requires operator action.
//
//   - PR exists BEFORE first agent write (Codex R2): callers create the PR
//     at subtask claim / chat-execute dispatch, not after task completion.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';
import { assertSafeProjectId, assertSafeId } from './safe-id.js';

const log = createLogger('pr-store');

const TEMP_SUFFIX = '.tmp';

// PR status enum
export const PR_STATUSES = Object.freeze([
  'open',
  'changes-requested',
  'approved',
  'merged',
  'closed',
]);

// Per-review status enum
export const REVIEW_STATUSES = Object.freeze([
  'approved',
  'changes-requested',
  'commented',
]);

// Auto-merge policy enum (lives in project's repoConfig)
export const AUTO_MERGE_POLICIES = Object.freeze([
  'operator',         // operator merges manually via API (default for safety)
  'n-approvals:1',    // auto-merge after 1 reviewer approval + clean guardrails
  'n-approvals:2',    // auto-merge after 2 reviewer approvals
  'never',            // never auto-merge (operator-only, no shortcuts)
]);

export class PrStore {
  /**
   * @param {string} synapseDir  Absolute path to .synapse/ directory
   * @param {object} [opts]      Optional dependencies
   * @param {object} [opts.events]  EventBus instance for emitting pr:opened
   *                                etc. If null, events are silently no-oped
   *                                (keeps Phase 1 unit tests free of bus dep).
   */
  constructor(synapseDir, opts = {}) {
    this.synapseDir = synapseDir;
    this.projectsDir = join(synapseDir, 'projects');
    this.events = opts.events || null;
  }

  _emit(name, payload) {
    if (this.events?.emit) {
      try { this.events.emit(name, payload); }
      catch (err) { log.warn('event emit failed', { event: name, error: err.message }); }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  _projectPrsDir(projectId) {
    assertSafeProjectId(projectId);
    return join(this.projectsDir, projectId, 'prs');
  }

  _ensureDir(projectId) {
    const dir = this._projectPrsDir(projectId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Atomic temp+rename write — mirrors src/ssrf-config-store.js _atomicWrite.
   * ext4/xfs rename(2) is atomic; this avoids partial-write corruption when
   * two writers race. Returns true on success, false on failure (never throws).
   */
  _atomicWrite(filePath, data) {
    const tempPath = filePath + TEMP_SUFFIX + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    try {
      writeFileSync(tempPath, data, 'utf8');
      renameSync(tempPath, filePath);
      return true;
    } catch (err) {
      log.error('Atomic write failed', { path: filePath, error: err.message });
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch (_) {}
      return false;
    }
  }

  _readJson(path, fallback) {
    if (!existsSync(path)) return fallback;
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) {
      log.warn('Failed to parse JSON', { path, error: err.message });
      return fallback;
    }
  }

  _indexPath(projectId) {
    return join(this._projectPrsDir(projectId), 'index.json');
  }

  _prPath(projectId, prId) {
    // prId is filename-joined; block traversal even if projectId already checked.
    assertSafeId(prId, 'PR ID');
    return join(this._projectPrsDir(projectId), `${prId}.json`);
  }

  /**
   * Generate a PR id. Pattern: pr_<ms>_<6hex>.
   * Same shape as tasks.js task ids for visual consistency.
   */
  _newPrId() {
    return `pr_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  }

  /**
   * Generate a review id within a PR.
   */
  _newReviewId() {
    return `rv_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  }

  /**
   * Rebuild index.json from the on-disk PR files. Used at startup and as a
   * recovery action if index.json gets out of sync (e.g., from a crash mid-update).
   */
  rebuildIndex(projectId) {
    const dir = this._ensureDir(projectId);
    const entries = [];
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('pr_') || !name.endsWith('.json')) continue;
      const path = join(dir, name);
      const pr = this._readJson(path, null);
      if (!pr || !pr.id) continue;
      entries.push({
        id: pr.id,
        status: pr.status,
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        author: pr.author,
        requiresOperatorApproval: pr.requiresOperatorApproval === true,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
      });
    }
    // Sort newest-first for default listing order
    entries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    this._atomicWrite(this._indexPath(projectId), JSON.stringify({ prs: entries }, null, 2));
    return entries;
  }

  /**
   * Update or insert one entry in index.json. Read-modify-write with atomic
   * rename. NOT lock-protected — readers tolerate stale index (it's a hint,
   * the PR file is the source of truth). If two writers race, last-write-wins;
   * `rebuildIndex` recovers any miss.
   */
  _upsertIndexEntry(projectId, pr) {
    this._ensureDir(projectId);
    const idxPath = this._indexPath(projectId);
    const idx = this._readJson(idxPath, { prs: [] });
    const existing = (idx.prs || []).filter(e => e.id !== pr.id);
    existing.unshift({
      id: pr.id,
      status: pr.status,
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      author: pr.author,
      requiresOperatorApproval: pr.requiresOperatorApproval === true,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
    });
    this._atomicWrite(idxPath, JSON.stringify({ prs: existing }, null, 2));
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Determine whether this PR's target branch + project warrants requiring
   * operator approval at merge time (Grok R1 hard requirement).
   *
   * Auto-true when ANY of:
   *   - operator-pinned via explicit flag at open-time
   *   - repoConfig.requireOperatorApprovalAlways === true (per-project setting,
   *     replaces the prior hardcoded `projectId === 'synapse'` check —
   *     reviewer R1 catch, R2 Change 4)
   *   - target branch matches the project's repoConfig.liveDeploymentBranch
   *
   * NOTE: requireOperatorApprovalAlways is paired with repoConfig.blockAutoMerge
   * in the merge dispatcher as dual-control defense-in-depth. They live in
   * different code paths (evaluateMergePolicy vs computeRequiresOperatorApproval)
   * and a future editor should NOT "simplify" by removing one — they enforce
   * the same intent at two layers (reviewer R2 non-blocker).
   */
  static computeRequiresOperatorApproval({ projectId, targetBranch, repoConfig, operatorPinned }) {
    if (operatorPinned === true) return true;
    if (repoConfig?.requireOperatorApprovalAlways === true) return true;
    const liveBranch = repoConfig?.liveDeploymentBranch || repoConfig?.branch || 'main';
    if (targetBranch === liveBranch) return true;
    return false;
  }

  /**
   * Open a new PR. Returns the persisted PR object.
   *
   * @param {object} input
   * @param {string} input.projectId
   * @param {string} input.sourceBranch
   * @param {string} input.targetBranch
   * @param {string} input.author              agent id
   * @param {string} input.authorRole
   * @param {string[]} [input.taskIds]
   * @param {string} [input.campaignId]
   * @param {string} [input.title]
   * @param {string} [input.description]
   * @param {object} [input.repoConfig]        used for requiresOperatorApproval computation
   * @param {boolean} [input.operatorPinned]   force requiresOperatorApproval=true
   */
  openPR(input) {
    const {
      projectId, sourceBranch, targetBranch, author, authorRole,
      taskIds = [], campaignId = null,
      title = '(untitled PR)',
      description = '',
      repoConfig = null,
      operatorPinned = false,
    } = input;

    if (!projectId || !sourceBranch || !targetBranch || !author) {
      throw new Error('openPR: projectId, sourceBranch, targetBranch, author all required');
    }
    PrStore.assertValidBranchName(sourceBranch, 'sourceBranch');
    PrStore.assertValidBranchName(targetBranch, 'targetBranch');

    const now = new Date().toISOString();
    const pr = {
      id: this._newPrId(),
      projectId,
      taskIds: Array.isArray(taskIds) ? taskIds : [],
      campaignId,
      sourceBranch,
      targetBranch,
      author,
      authorRole: authorRole || null,
      title,
      description,
      status: 'open',
      requiresOperatorApproval: PrStore.computeRequiresOperatorApproval({
        projectId, targetBranch, repoConfig, operatorPinned,
      }),
      reviewers: [],
      reviews: [],
      commits: [],
      filesChanged: 0,
      guardrailResults: {
        commitGuard: 'not-run',
        runtimeGuardrails: 'not-run',
        ciTests: 'not-run',
      },
      operatorActions: [],
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      mergeCommit: null,
    };

    this._ensureDir(projectId);
    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`openPR: atomic write failed for ${pr.id}`);
    this._upsertIndexEntry(projectId, pr);
    log.info('PR opened', { prId: pr.id, projectId, sourceBranch, targetBranch, author, requiresOperatorApproval: pr.requiresOperatorApproval });
    this._emit('pr:opened', pr);  // BYOH PR workflow Phase 2 — pr-review-dispatcher subscribes
    return pr;
  }

  /**
   * Accept a conservative subset of Git branch names. Besides preventing
   * option-like names, this rejects every metacharacter and ref ambiguity that
   * Git itself disallows. Merge commands also use execFileSync as a second
   * line of defence, so branch names never pass through a shell.
   */
  static assertValidBranchName(value, field = 'branch') {
    if (typeof value !== 'string' || value.length > 255 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
        value.endsWith('/') || value.endsWith('.') || value.includes('..') ||
        value.includes('//') || value.includes('@{') || value === '@' ||
        value.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.lock'))) {
      throw new Error(`openPR: ${field} is not a valid branch name`);
    }
    return value;
  }

  /**
   * Read a single PR by id. Returns null if not found.
   */
  getPR(projectId, prId) {
    const path = this._prPath(projectId, prId);
    return this._readJson(path, null);
  }

  /**
   * List PRs in this project. Reads index.json (cheap). Pass status='open' or
   * an array of statuses to filter.
   */
  listPRs(projectId, { status = null } = {}) {
    const idx = this._readJson(this._indexPath(projectId), { prs: [] });
    let entries = idx.prs || [];

    // Self-heal a stale index.
    //
    // _upsertIndexEntry deliberately ignores a failed _atomicWrite, and
    // rebuildIndex's docstring says it is "used at startup and as a recovery
    // action". It was not: its ONLY caller was its own unit test. So the
    // justification for tolerating a failed index write — "rebuildIndex
    // recovers any miss" — was never true, and this method reads the index and
    // nothing else. A PR whose index write failed (ENOSPC, permissions, crash
    // mid-update) existed on disk but was invisible here FOREVER, and since
    // review and merge are driven by listings, that PR could never be actioned.
    //
    // Self-heal by comparing the SET of PR ids, not just counts.
    // Count-only heal missed the case "same number of files, different set"
    // (one PR lost from index, another orphan on disk) — still invisible forever.
    // readdir names only; rebuild (full file reads) runs only when sets disagree.
    try {
      const onDiskIds = readdirSync(this._ensureDir(projectId))
        .filter((n) => n.startsWith('pr_') && n.endsWith('.json'))
        .map((n) => n.slice(0, -'.json'.length));
      const indexedIds = (entries || []).map((e) => e.id).filter(Boolean);
      const diskKey = [...onDiskIds].sort().join('\0');
      const indexKey = [...indexedIds].sort().join('\0');
      if (diskKey !== indexKey) {
        log.warn('PR index out of sync with disk — rebuilding', {
          projectId,
          indexed: indexedIds.length,
          onDisk: onDiskIds.length,
        });
        entries = this.rebuildIndex(projectId);
      }
    } catch (err) {
      // Never let a repair attempt break a read. A stale list is still better
      // than a thrown listing.
      log.warn('PR index sync check failed; serving index as-is', { projectId, error: err.message });
    }
    if (status) {
      const allowed = Array.isArray(status) ? new Set(status) : new Set([status]);
      entries = entries.filter(e => allowed.has(e.status));
    }
    return entries;
  }

  /**
   * Add a review to a PR. Captures approvedSourceSha (Codex R2 hard requirement):
   * the SHA of the source branch HEAD at review time. Merge step compares
   * this to the current HEAD; if they diverge, approval is invalidated.
   *
   * Transitions PR.status based on review.status:
   *   approved          → 'approved'
   *   changes-requested → 'changes-requested'
   *   commented         → status unchanged
   */
  addReview(projectId, prId, review) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`addReview: PR ${prId} not found`);
    if (pr.status === 'merged' || pr.status === 'closed') {
      throw new Error(`addReview: PR ${prId} is ${pr.status}; cannot add review`);
    }
    if (!REVIEW_STATUSES.includes(review.status)) {
      throw new Error(`addReview: invalid status "${review.status}"`);
    }
    if (review.reviewer === pr.author) {
      // Grok R1 invariant + recommended default: strict author≠reviewer
      throw new Error(`addReview: reviewer "${review.reviewer}" cannot equal author "${pr.author}"`);
    }

    const now = new Date().toISOString();
    const newReview = {
      id: this._newReviewId(),
      reviewer: review.reviewer,
      status: review.status,
      // Codex R2: approval is tied to a specific source SHA. Merge verifies.
      approvedSourceSha: review.approvedSourceSha || null,
      findings: Array.isArray(review.findings) ? review.findings : [],
      summary: review.summary || '',
      createdAt: now,
    };

    pr.reviews.push(newReview);
    pr.updatedAt = now;

    // Status transition based on the most-recent review
    if (review.status === 'approved') pr.status = 'approved';
    else if (review.status === 'changes-requested') pr.status = 'changes-requested';
    // 'commented' leaves status unchanged

    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`addReview: atomic write failed for ${pr.id}`);
    this._upsertIndexEntry(projectId, pr);
    log.info('PR review added', { prId, reviewer: review.reviewer, status: review.status, approvedSourceSha: newReview.approvedSourceSha });
    // Phase 3 event emission. Merge dispatcher subscribes to pr:approved.
    if (review.status === 'approved') this._emit('pr:approved', pr);
    else if (review.status === 'changes-requested') this._emit('pr:changes-requested', pr);
    return pr;
  }

  /**
   * Record a new commit on the source branch. Per Codex R2: invalidates prior
   * approvals — if PR was 'approved' or 'changes-requested', set back to 'open'
   * (the reviewer must re-review against the new HEAD).
   *
   * Adds the commit sha to PR.commits.
   */
  recordCommit(projectId, prId, commitSha) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`recordCommit: PR ${prId} not found`);
    if (pr.status === 'merged' || pr.status === 'closed') return pr; // terminal — ignore

    pr.commits.push(commitSha);
    pr.updatedAt = new Date().toISOString();

    // Codex R2 invariant: new commit invalidates approval
    if (pr.status === 'approved' || pr.status === 'changes-requested') {
      log.info('PR new commit invalidates prior review state', { prId, oldStatus: pr.status, newStatus: 'open', commitSha });
      pr.status = 'open';
    }

    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`recordCommit: atomic write failed for ${pr.id}`);
    this._upsertIndexEntry(projectId, pr);
    return pr;
  }

  /**
   * Append an operator action to the audit log (approve/force-merge/close).
   * Operator actions can override the PR state machine — e.g., approve a PR
   * the reviewer rejected, or force-merge despite requiresOperatorApproval.
   */
  recordOperatorAction(projectId, prId, action, { note = null, by = 'operator' } = {}) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`recordOperatorAction: PR ${prId} not found`);
    pr.operatorActions.push({
      action,
      at: new Date().toISOString(),
      by,
      note,
    });
    pr.updatedAt = new Date().toISOString();
    // Operator approve transitions PR to 'approved' regardless of reviewer state
    if (action === 'approve') pr.status = 'approved';
    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`recordOperatorAction: atomic write failed for ${pr.id}`);
    this._upsertIndexEntry(projectId, pr);
    return pr;
  }

  /**
   * Mark a PR as merged. Records the merge commit sha.
   * Caller (lifecycle / api) is responsible for the actual `git merge` —
   * this just records the persistent state transition.
   *
   * Verifies that the latest 'approved' review's approvedSourceSha matches
   * the current source HEAD (Codex R2 hard requirement). Throws if it doesn't.
   * Caller passes the current source HEAD as `currentSourceSha`.
   */
  markMerged(projectId, prId, { mergeCommit, currentSourceSha }) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`markMerged: PR ${prId} not found`);
    if (pr.status !== 'approved') throw new Error(`markMerged: PR ${prId} is ${pr.status}, not approved`);

    // Codex R2: verify the approved-sha invariant
    const latestApproval = [...pr.reviews].reverse().find(r => r.status === 'approved');
    if (latestApproval && latestApproval.approvedSourceSha && currentSourceSha) {
      if (latestApproval.approvedSourceSha !== currentSourceSha) {
        throw new Error(
          `markMerged: source HEAD ${currentSourceSha} does not match approved SHA ` +
          `${latestApproval.approvedSourceSha}. New commits after approval invalidate it.`
        );
      }
    }

    pr.status = 'merged';
    pr.mergedAt = new Date().toISOString();
    pr.mergeCommit = mergeCommit || null;
    pr.updatedAt = pr.mergedAt;
    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`markMerged: atomic write failed for ${pr.id}`);
    this._upsertIndexEntry(projectId, pr);
    log.info('PR merged', { prId, projectId, mergeCommit });
    this._emit('pr:merged', pr);  // Phase 3 event emission. Future subscribers.
    return pr;
  }

  /**
   * Close a PR without merging (cancelled, stale, superseded).
   */
  closePR(projectId, prId, { reason = null, by = 'operator' } = {}) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`closePR: PR ${prId} not found`);
    if (pr.status === 'merged') throw new Error(`closePR: PR ${prId} already merged`);
    pr.status = 'closed';
    pr.updatedAt = new Date().toISOString();
    pr.operatorActions.push({ action: 'close', at: pr.updatedAt, by, note: reason });
    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`closePR: atomic write failed for ${pr.id}`);
    this._upsertIndexEntry(projectId, pr);
    log.info('PR closed', { prId, projectId, reason });
    return pr;
  }

  /**
   * Look up the open PR (if any) for a given source branch. Used by the
   * lifecycle hook to decide whether a subtask's branch already has a PR
   * or one needs to be auto-opened.
   */
  findOpenPRForBranch(projectId, sourceBranch) {
    const entries = this.listPRs(projectId, { status: ['open', 'changes-requested', 'approved'] });
    const match = entries.find(e => e.sourceBranch === sourceBranch);
    if (!match) return null;
    return this.getPR(projectId, match.id);
  }
}

export function createPrStore(synapseDir, opts = {}) {
  return new PrStore(synapseDir, opts);
}
