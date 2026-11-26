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
import { join, dirname, resolve } from 'path';
import { createLogger } from './logger.js';
import { assertSafeProjectId, assertSafeId } from './safe-id.js';
import { assertRegularProjectFile, withProjectLocalDb } from './persistence/project-local-db.js';

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

const MAX_DRAFT_BODY_BYTES = 64 * 1024;
const MAX_DRAFT_INLINE_BYTES = 64 * 1024;
const MAX_INLINE_COMMENTS = 100;
const DRAFT_DB = 'pr-review-drafts.sqlite';
const HEAD_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DRAFT_KEY = 'operator_id = ? AND project_id = ? AND pr_id = ?';
const DRAFT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pr_review_drafts (
    operator_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    pr_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536),
    inline_comments_json TEXT NOT NULL CHECK (
      length(CAST(inline_comments_json AS BLOB)) <= 65536
      AND json_valid(inline_comments_json)
      AND json_type(inline_comments_json) = 'array'
      AND json_array_length(inline_comments_json) <= 100
    ),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operator_id, project_id, pr_id)
  )
`;

function draftKey(operatorId, projectId, prId) {
  if (typeof operatorId !== 'string' || !operatorId.trim() || Buffer.byteLength(operatorId) > 256) {
    throw new Error('Invalid draft operator');
  }
  return [operatorId, assertSafeProjectId(projectId), assertSafeId(prId, 'PR ID')];
}

function readDraft(db, key) {
  const row = db.prepare(`SELECT head_sha, body, inline_comments_json, updated_at
    FROM pr_review_drafts WHERE ${DRAFT_KEY}`).get(...key);
  return row ? {
    headSha: row.head_sha,
    body: row.body,
    inlineComments: JSON.parse(row.inline_comments_json),
    updatedAt: row.updated_at,
  } : null;
}

function validateDraft({ headSha, body, inlineComments }) {
  if (typeof headSha !== 'string' || !HEAD_SHA.test(headSha) || typeof body !== 'string' || Buffer.byteLength(body) > MAX_DRAFT_BODY_BYTES ||
      !Array.isArray(inlineComments) || inlineComments.length > MAX_INLINE_COMMENTS) {
    throw new Error('Invalid draft HEAD, body size, or inline comment count');
  }
  const comments = inlineComments.map(comment => {
    const { path, line, body } = comment || {};
    if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 512 || /^[a-z]:/i.test(path) ||
        /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(s => !s || s === '..' || s === '.') ||
        !Number.isSafeInteger(line) || line < 1 || typeof body !== 'string' || Buffer.byteLength(body) > MAX_DRAFT_INLINE_BYTES) {
      throw new Error('Inline comments require a relative path, positive line number, and bounded body');
    }
    return { path, line, body };
  });
  const serialized = JSON.stringify(comments);
  if (Buffer.byteLength(serialized) > MAX_DRAFT_INLINE_BYTES) throw new Error('Inline comments exceed size limit');
  return serialized;
}

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
      loopManaged = false,
      loopId = null,
      verificationProof = null,
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
      loopManaged: Boolean(loopManaged || loopId || verificationProof?.kind === 'loop-evidence-v1'),
      ...(loopId ? { loopId } : {}),
      reviewers: [],
      reviews: [],
      commits: [],
      filesChanged: 0,
      guardrailResults: {
        commitGuard: 'not-run',
        runtimeGuardrails: 'not-run',
        ciTests: (verificationProof && (verificationProof.ran?.verify || verificationProof.ran?.tests || verificationProof.ran?.smokeImport))
          ? (verificationProof.overallPass === true ? 'passed' : 'failed')
          : 'not-run',
      },
      ...(verificationProof ? { verificationProof: { ...verificationProof, attachedAt: now } } : {}),
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

  // New draft routes refuse symlinks on the PR record before reading it.
  getDraftablePR(projectId, prId) {
    const path = resolve(this._prPath(projectId, prId));
    return assertRegularProjectFile(path) ? this._readJson(path, null) : null;
  }

  getDraft(operatorId, projectId, prId) {
    const key = draftKey(operatorId, projectId, prId);
    return withProjectLocalDb(this.synapseDir, projectId, DRAFT_DB, {}, db => readDraft(db, key));
  }

  saveDraft(operatorId, projectId, prId, { headSha, body = '', inlineComments = [] }) {
    const key = draftKey(operatorId, projectId, prId);
    const serialized = validateDraft({ headSha, body, inlineComments });
    return withProjectLocalDb(this.synapseDir, projectId, DRAFT_DB, { write: true }, db => {
      db.exec(DRAFT_SCHEMA);
      const result = db.prepare(`INSERT INTO pr_review_drafts
        (operator_id, project_id, pr_id, head_sha, body, inline_comments_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operator_id, project_id, pr_id) DO UPDATE SET
          body = excluded.body, inline_comments_json = excluded.inline_comments_json, updated_at = excluded.updated_at
        WHERE pr_review_drafts.head_sha = excluded.head_sha`
      ).run(...key, headSha, body, serialized, new Date().toISOString());
      if (!result.changes) {
        throw Object.assign(new Error('Head moved. Explicitly re-anchor the draft first.'), { code: 'DRAFT_HEAD_MOVED', statusCode: 409 });
      }
      return readDraft(db, key);
    });
  }

  deleteDraft(operatorId, projectId, prId) {
    const key = draftKey(operatorId, projectId, prId);
    return withProjectLocalDb(this.synapseDir, projectId, DRAFT_DB, { write: true }, db => {
      db.exec(DRAFT_SCHEMA);
      return db.prepare(`DELETE FROM pr_review_drafts WHERE ${DRAFT_KEY}`).run(...key).changes > 0;
    });
  }

  reanchorDraft(operatorId, projectId, prId, headSha) {
    const key = draftKey(operatorId, projectId, prId);
    if (typeof headSha !== 'string' || !HEAD_SHA.test(headSha)) throw new Error('An explicit target headSha is required');
    return withProjectLocalDb(this.synapseDir, projectId, DRAFT_DB, { write: true }, db => {
      db.exec(DRAFT_SCHEMA);
      db.prepare(`UPDATE pr_review_drafts SET head_sha = ?, updated_at = ? WHERE ${DRAFT_KEY} AND head_sha != ?`
      ).run(headSha, new Date().toISOString(), ...key, headSha);
      return readDraft(db, key);
    });
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
      ...(review.reviewedSourceSha ? { reviewedSourceSha: review.reviewedSourceSha } : {}),
      ...(Array.isArray(review.inlineComments) ? { inlineComments: review.inlineComments } : {}),
      ...(review.loopRunId ? { loopRunId: review.loopRunId } : {}),
      ...(review.evidencePacketSha256 ? { evidencePacketSha256: review.evidencePacketSha256 } : {}),
      ...(review.approvalEventId ? { approvalEventId: review.approvalEventId } : {}),
      ...(review.reviewSha256 ? { reviewSha256: review.reviewSha256 } : {}),
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
  /**
   * Internal helper: invalidate any prior approved reviews / status when HEAD SHA changes.
   */
  _applyShaApprovalInvalidation(pr, newHeadSha) {
    if (!pr || !newHeadSha) return false;
    let invalidated = false;
    if (Array.isArray(pr.reviews)) {
      for (const r of pr.reviews) {
        // Fail-closed (Finding #8): missing approvedSourceSha OR mismatched SHA is stale on HEAD change
        if (r && r.status === 'approved' && (!r.approvedSourceSha || r.approvedSourceSha !== newHeadSha)) {
          r.stale = true;
          r.supersededBySha = newHeadSha;
          invalidated = true;
        }
      }
    }
    if (pr.approvedSourceSha !== undefined && pr.approvedSourceSha !== newHeadSha) {
      pr.approvedSourceSha = null;
      invalidated = true;
    }
    // Phase 2A: Stale Loop-managed verificationProof and clear derived ciTests projection on SHA change
    if (pr.verificationProof && pr.verificationProof.kind === 'loop-evidence-v1') {
      const boundSha = pr.verificationProof.approvedSourceSha || pr.verificationProof.headSha || null;
      if (!boundSha || boundSha !== newHeadSha) {
        pr.verificationProof.stale = true;
        pr.verificationProof.supersededBySha = newHeadSha;
        if (pr.guardrailResults && pr.guardrailResults.ciTests === 'passed') {
          pr.guardrailResults.ciTests = 'stale';
        }
        invalidated = true;
      }
    }
    if (pr.status === 'approved' || pr.status === 'changes-requested') {
      const latestApproval = Array.isArray(pr.reviews)
        ? [...pr.reviews].reverse().find(r => r.status === 'approved' && !r.stale && Boolean(r.approvedSourceSha))
        : null;
      if (!latestApproval || latestApproval.approvedSourceSha !== newHeadSha) {
        log.info('PR new commit/headSha invalidates prior review state', {
          prId: pr.id, oldStatus: pr.status, newStatus: 'open', newHeadSha,
        });
        pr.status = 'open';
        invalidated = true;
      }
    }
    return invalidated;
  }

  /**
   * Phase 1A: Explicitly invalidate stale approval when worktree integration produces a new HEAD SHA.
   */
  invalidateApprovalOnShaChange(projectId, prId, newHeadSha) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`invalidateApprovalOnShaChange: PR ${prId} not found`);
    if (pr.status === 'merged' || pr.status === 'closed') return pr;
    pr.headSha = newHeadSha || pr.headSha || null;
    const changed = this._applyShaApprovalInvalidation(pr, newHeadSha);
    if (changed) {
      pr.updatedAt = new Date().toISOString();
      const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
      if (!ok) throw new Error(`invalidateApprovalOnShaChange: atomic write failed for ${pr.id}`);
      this._upsertIndexEntry(projectId, pr);
    }
    return pr;
  }

  recordCommit(projectId, prId, commitSha) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`recordCommit: PR ${prId} not found`);
    if (pr.status === 'merged' || pr.status === 'closed') return pr; // terminal — ignore

    pr.commits.push(commitSha);
    pr.updatedAt = new Date().toISOString();

    pr.headSha = commitSha;
    // Codex R2 + Phase 1A invariant: new commit / postIntegrationHeadSha invalidates prior approval
    this._applyShaApprovalInvalidation(pr, commitSha);

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
  recordOperatorAction(projectId, prId, action, { note = null, by = 'operator', loopRunId = null, evidencePacketSha256 = null, approvalEventId = null } = {}) {
    const pr = this.getPR(projectId, prId);
    if (!pr) throw new Error(`recordOperatorAction: PR ${prId} not found`);
    pr.operatorActions.push({
      action,
      at: new Date().toISOString(),
      by,
      note,
      ...(loopRunId ? { loopRunId } : {}),
      ...(evidencePacketSha256 ? { evidencePacketSha256 } : {}),
      ...(approvalEventId ? { approvalEventId } : {}),
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
   * Attach deterministic verification proof (verifyCmd output, syntax/security/scope
   * report, self-modifying smoke import status, diff stats) onto a PR so peer
   * reviewers and operators see verified evidence in the merge-approval packet.
   */
  attachVerificationProof(projectId, prId, proof) {
    const existing = this.getPR(projectId, prId);
    if (!existing) throw new Error(`attachVerificationProof: PR ${prId} not found`);
    if (existing.status === 'merged' || existing.status === 'closed') {
      throw new Error(`attachVerificationProof: PR ${prId} is ${existing.status}`);
    }
    const now = new Date().toISOString();
    const pr = structuredClone(existing);
    const sanitized = {
      ...proof,
      verifyOutput: typeof proof?.verifyOutput === 'string' ? proof.verifyOutput.slice(0, 600) : '',
      attachedAt: now,
    };
    pr.verificationProof = sanitized;
    if (proof?.kind === 'loop-evidence-v1') {
      pr.loopManaged = true;
    }
    if (typeof proof?.filesChanged === 'number' && proof.filesChanged >= 0) {
      pr.filesChanged = proof.filesChanged;
    }
    // Only mark ciTests passed/failed when a test, verifyCmd, or smokeImport check ACTUALLY ran
    const checksRan = Boolean(
      proof?.ran?.verify || proof?.ran?.tests || proof?.ran?.smokeImport
      || (proof?.kind === 'loop-evidence-v1' && proof?.verifyPass === true && Boolean(proof?.approvedSourceSha) && Boolean(proof?.evidencePacketSha256))
    );
    if (checksRan && typeof proof?.overallPass === 'boolean') {
      pr.guardrailResults = {
        ...(pr.guardrailResults || {}),
        ciTests: proof.overallPass ? 'passed' : 'failed',
      };
    }
    const boundHeadSha = proof?.headSha || proof?.approvedSourceSha || null;
    if (boundHeadSha) {
      pr.headSha = boundHeadSha;
      this._applyShaApprovalInvalidation(pr, boundHeadSha);
    }
    pr.updatedAt = now;
    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`attachVerificationProof: atomic write failed for ${prId}`);
    this._upsertIndexEntry(projectId, pr);
    log.info('PR verification proof attached', {
      prId: pr.id, projectId, overallPass: proof?.overallPass ?? null, headSha: proof?.headSha || null, checksRan,
    });
    this._emit('pr:verification-proof', pr);
    return pr;
  }

  /**
   * Look up the open PR (if any) for a given source branch. Used by the
   * lifecycle hook to decide whether a subtask's branch already has a PR
   * or one needs to be auto-opened.
   */
  /**
   * Phase 2A (Sol P1 #4): Mark an existing PR as durably Loop-managed at run adoption
   * so ordinary merge policy can never bypass Loop verification before proof attaches.
   */
  markLoopManaged(projectId, prId, { loopId = null } = {}) {
    const existing = this.getPR(projectId, prId);
    if (!existing) throw new Error(`markLoopManaged: PR ${prId} not found`);
    if (existing.loopManaged === true && (!loopId || existing.loopId === loopId)) return existing;
    const pr = structuredClone(existing);
    pr.loopManaged = true;
    if (loopId) pr.loopId = loopId;
    pr.updatedAt = new Date().toISOString();
    const ok = this._atomicWrite(this._prPath(projectId, pr.id), JSON.stringify(pr, null, 2));
    if (!ok) throw new Error(`markLoopManaged: atomic write failed for ${prId}`);
    this._upsertIndexEntry(projectId, pr);
    return pr;
  }

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
