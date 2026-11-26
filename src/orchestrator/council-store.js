/**
 * Lean Cross-Platform Council Store (Phase 3 Stage A — Pillar 1).
 *
 * Project-scoped SQLite store (`<synapseDir>/projects/<projectId>/council.sqlite`)
 * + durable single-writer outcome outbox (`council-outcomes.jsonl`) with:
 * - Atomic request-ID deduplication `(project_id, principal_id, request_id)`
 * - Atomic research-auto deduplication `(project_id, task_id, revision)`
 * - Atomic token-budget reservation and settlement against session cap + deadline
 * - Crash-safe fsync'd JSONL outbox with startup tail-repair & eventId dedup
 * - Zero fabricated Laplace/confidence scores — only real observed operator verdicts
 *   and verified Anchor results kept as separate measurements.
 */

import Database from 'better-sqlite3';
import {mkdirSync, existsSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, truncateSync } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('council-store');

const SAFE_PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function sha256Text(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export class CouncilStore {
  /**
   * @param {string} synapseDir - Path to `.synapse` directory (contains `projects/<id>/`)
   */
  constructor(synapseDir) {
    if (!synapseDir) throw new Error('CouncilStore requires synapseDir');
    this.synapseDir = synapseDir;
    /** @type {Map<string, { db: Database.Database, jsonlPath: string }>} */
    this._dbs = new Map();
  }

  _assertProjectId(projectId) {
    if (typeof projectId !== 'string' || !SAFE_PROJECT_ID_RE.test(projectId)) {
      throw new Error(`Invalid projectId for CouncilStore: "${projectId}"`);
    }
  }

  _projectDir(projectId) {
    this._assertProjectId(projectId);
    return join(this.synapseDir, 'projects', projectId);
  }

  getOutcomesPath(projectId) {
    return join(this._projectDir(projectId), 'council-outcomes.jsonl');
  }

  _getHandle(projectId) {
    this._assertProjectId(projectId);
    let handle = this._dbs.get(projectId);
    if (handle) return handle;

    const projDir = this._projectDir(projectId);
    mkdirSync(projDir, { recursive: true });
    const dbPath = join(projDir, 'council.sqlite');
    const jsonlPath = join(projDir, 'council-outcomes.jsonl');

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS council_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        reason_code TEXT,
        subject_hash TEXT NOT NULL,
        research_rev_key TEXT,
        rounds_started INTEGER NOT NULL DEFAULT 0,
        tokens_charged INTEGER NOT NULL DEFAULT 0,
        tokens_reserved INTEGER NOT NULL DEFAULT 0,
        max_tokens INTEGER NOT NULL,
        deadline_at TEXT NOT NULL,
        session_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_council_req_dedup
        ON council_sessions (project_id, principal_id, request_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_council_research_rev
        ON council_sessions (research_rev_key)
        WHERE research_rev_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS council_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        phase TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        charged_tokens INTEGER,
        turn_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_council_turns_session
        ON council_turns (session_id, round, created_at);

      CREATE TABLE IF NOT EXISTS council_outcomes (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        verdict TEXT NOT NULL,
        synthesis_digest TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        exported_at TEXT,
        outcome_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_council_outcomes_session
        ON council_outcomes (session_id, recorded_at);
    `);

    handle = { db, jsonlPath };
    this._dbs.set(projectId, handle);
    this.repairOutboxOnStartup(projectId);
    return handle;
  }

  close() {
    for (const { db } of this._dbs.values()) {
      try { db.close(); } catch {}
    }
    this._dbs.clear();
  }

  // ─── Session Admission & Atomic State Updates ─────────────────────

  admitSession(session, { researchRevKey = null } = {}) {
    const { db } = this._getHandle(session.projectId);
    const tx = db.transaction(() => {
      const existing = db.prepare(`
        SELECT session_json, subject_hash, mode, max_tokens
        FROM council_sessions
        WHERE project_id = ? AND principal_id = ? AND request_id = ?
      `).get(session.projectId, session.principalId, session.requestId);

      if (existing) {
        const parsed = JSON.parse(existing.session_json);
        const samePayload = existing.subject_hash === session.subjectSnapshotHash
          && existing.mode === session.mode
          && Number(existing.max_tokens) === Number(session.limits.maxTokens);
        if (!samePayload) {
          return { conflict: true, existing: parsed };
        }
        return { deduplicated: true, conflict: false, session: parsed };
      }

      if (researchRevKey) {
        const dupRev = db.prepare(`
          SELECT session_json FROM council_sessions WHERE research_rev_key = ?
        `).get(researchRevKey);
        if (dupRev) {
          return { deduplicated: true, conflict: false, session: JSON.parse(dupRev.session_json) };
        }
      }

      const now = session.createdAt || new Date().toISOString();
      db.prepare(`
        INSERT INTO council_sessions (
          id, project_id, request_id, principal_id, trigger, mode, status, reason_code,
          subject_hash, research_rev_key, rounds_started, tokens_charged, tokens_reserved,
          max_tokens, deadline_at, session_json, created_at, updated_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.projectId,
        session.requestId,
        session.principalId,
        session.trigger,
        session.mode,
        session.status,
        session.reasonCode ?? null,
        session.subjectSnapshotHash,
        researchRevKey || null,
        session.roundsStarted || 0,
        session.tokensCharged || 0,
        0,
        session.limits.maxTokens,
        session.deadlineAt,
        JSON.stringify(session),
        now,
        now,
        session.endedAt ?? null
      );
      return { deduplicated: false, conflict: false, session };
    });
    return tx();
  }

  getSession(projectId, sessionId) {
    const { db } = this._getHandle(projectId);
    const row = db.prepare('SELECT session_json FROM council_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId);
    return row ? JSON.parse(row.session_json) : null;
  }

  listSessions(projectId, { limit = 50 } = {}) {
    const { db } = this._getHandle(projectId);
    const rows = db.prepare(`
      SELECT session_json FROM council_sessions
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(projectId, Math.max(1, Math.min(200, Number(limit) || 50)));
    return rows.map(r => JSON.parse(r.session_json));
  }

  updateSessionAtomic(projectId, sessionId, mutatorFn) {
    const { db } = this._getHandle(projectId);
    const tx = db.transaction(() => {
      const row = db.prepare('SELECT session_json FROM council_sessions WHERE project_id = ? AND id = ?').get(projectId, sessionId);
      if (!row) throw new Error(`Council session "${sessionId}" not found in "${projectId}"`);
      const cur = JSON.parse(row.session_json);
      const next = mutatorFn(cur) || cur;
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE council_sessions
        SET status = ?, reason_code = ?, rounds_started = ?, tokens_charged = ?,
            session_json = ?, updated_at = ?, ended_at = ?
        WHERE project_id = ? AND id = ?
      `).run(
        next.status,
        next.reasonCode ?? null,
        next.roundsStarted || 0,
        next.tokensCharged || 0,
        JSON.stringify(next),
        now,
        next.endedAt ?? null,
        projectId,
        sessionId
      );
      return next;
    });
    return tx();
  }

  /**
   * Fence any non-terminal sessions on restart, retaining their transcripts.
   */
  fenceInterruptedSessions(projectId) {
    const { db } = this._getHandle(projectId);
    const tx = db.transaction(() => {
      const rows = db.prepare(`
        SELECT id, session_json FROM council_sessions
        WHERE project_id = ? AND status IN ('queued', 'running')
      `).all(projectId);
      const fenced = [];
      const now = new Date().toISOString();
      for (const r of rows) {
        const s = JSON.parse(r.session_json);
        s.status = 'cancelled';
        s.reasonCode = 'INTERRUPTED_ON_RESTART';
        s.endedAt = now;
        db.prepare(`
          UPDATE council_sessions
          SET status = ?, reason_code = ?, tokens_reserved = 0, session_json = ?, updated_at = ?, ended_at = ?
          WHERE project_id = ? AND id = ?
        `).run(s.status, s.reasonCode, JSON.stringify(s), now, now, projectId, s.id);

        // P2 #1: Also fence any reserved turn rows belonging to interrupted sessions!
        const reservedTurns = db.prepare(`
          SELECT id, turn_json FROM council_turns
          WHERE session_id = ? AND status = 'reserved'
        `).all(s.id);
        for (const rt of reservedTurns) {
          const tObj = JSON.parse(rt.turn_json);
          tObj.status = 'cancelled';
          tObj.reasonCode = 'INTERRUPTED_ON_RESTART';
          tObj.endedAt = now;
          db.prepare(`
            UPDATE council_turns
            SET status = 'cancelled', turn_json = ?, updated_at = ?
            WHERE session_id = ? AND id = ?
          `).run(JSON.stringify(tObj), now, s.id, rt.id);
        }
        fenced.push(s.id);
      }
      return fenced;
    });
    return tx();
  }

  // ─── Atomic Token Budget & Turn Persistence ───────────────────────

  /**
   * Atomically reserve `reserveTokens` for a new turn (plus optional `holdbackTokens`
   * for future synthesis when scheduling round turns), checking:
   *  - Session is still active (`queued`/`running`)
   *  - Wall-clock deadline has not elapsed (`nowMs < Date.parse(deadline_at)`)
   *  - `tokens_charged + tokens_reserved + reserveTokens + holdbackTokens <= max_tokens`
   */
  reserveTurnAtomic(projectId, sessionId, turn, { holdbackTokens = 0, nowFn = null, nowMs = null } = {}) {
    const { db } = this._getHandle(projectId);
    const tx = db.transaction(() => {
      const txNowMs = typeof nowFn === 'function' ? nowFn() : (Number.isFinite(nowMs) ? nowMs : Date.now());
      const row = db.prepare(`
        SELECT status, tokens_charged, tokens_reserved, max_tokens, deadline_at
        FROM council_sessions
        WHERE project_id = ? AND id = ?
      `).get(projectId, sessionId);
      if (!row) return { ok: false, reasonCode: 'SESSION_NOT_FOUND' };
      if (row.status !== 'queued' && row.status !== 'running') {
        return { ok: false, reasonCode: 'SESSION_NOT_ACTIVE', status: row.status };
      }
      if (txNowMs >= Date.parse(row.deadline_at)) {
        return { ok: false, reasonCode: 'WALL_CLOCK_EXCEEDED' };
      }
      const need = Math.max(0, Number(turn.reservedTokens) || 0);
      const hold = Math.max(0, Number(holdbackTokens) || 0);
      if (row.tokens_charged + row.tokens_reserved + need + hold > row.max_tokens) {
        return {
          ok: false,
          reasonCode: 'TOKEN_BUDGET_EXCEEDED',
          tokensCharged: row.tokens_charged,
          tokensReserved: row.tokens_reserved,
          maxTokens: row.max_tokens,
        };
      }
      const now = new Date(nowMs).toISOString();
      db.prepare(`
        UPDATE council_sessions
        SET tokens_reserved = tokens_reserved + ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(need, now, projectId, sessionId);

      db.prepare(`
        INSERT INTO council_turns (
          id, session_id, round, phase, agent_id, provider_key, attempt_id,
          status, reserved_tokens, charged_tokens, turn_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        turn.id,
        sessionId,
        turn.round,
        turn.phase,
        turn.member.agentId,
        turn.member.providerKey,
        turn.attemptId,
        turn.status,
        need,
        null,
        JSON.stringify(turn),
        now,
        now
      );
      return { ok: true, turn };
    });
    return tx();
  }

  /**
   * Atomically settle a reserved turn, releasing its reservation and charging verified tokens.
   * Fences late writes if the turn was already settled or cancelled.
   */
  /**
   * P1 #3: Atomically finish a session inside SQLite, enforcing `nowMs <= Date.parse(deadline_at)`
   * so a late synthesis settling after wall-clock expiry can NEVER mark a session `completed`!
   */
  finishSessionAtomic(projectId, sessionId, {
    status,
    reasonCode = null,
    synthesis = null,
    ledger = null,
    nowFn = null,
    nowMs = null,
  } = {}) {
    const { db } = this._getHandle(projectId);
    const tx = db.transaction(() => {
      // P1 #3: Sample clock INSIDE SQLite transaction so deadline enforcement is atomic!
      const txNowMs = typeof nowFn === 'function' ? nowFn() : (Number.isFinite(nowMs) ? nowMs : Date.now());
      const row = db.prepare(`
        SELECT status, deadline_at, session_json
        FROM council_sessions
        WHERE project_id = ? AND id = ?
      `).get(projectId, sessionId);
      if (!row) throw new Error(`Council session "${sessionId}" not found in "${projectId}"`);
      const cur = JSON.parse(row.session_json);
      if (['completed', 'limited', 'failed', 'cancelled'].includes(cur.status)) {
        return { session: cur, fenced: true, alreadyTerminal: true };
      }
      const deadlineMs = Date.parse(row.deadline_at);
      const deadlineExpired = Number.isFinite(deadlineMs) && txNowMs >= deadlineMs;
      let effectiveStatus = status;
      let effectiveReason = reasonCode;
      let effectiveSynthesis = synthesis;
      let fenced = false;
      if (effectiveStatus === 'completed' && deadlineExpired) {
        effectiveStatus = 'limited';
        effectiveReason = 'WALL_CLOCK_EXCEEDED';
        effectiveSynthesis = null;
        fenced = true;
      }
      cur.status = effectiveStatus;
      cur.reasonCode = effectiveReason;
      if (effectiveSynthesis !== null) cur.synthesis = effectiveSynthesis;
      if (ledger !== null && !fenced) cur.ledger = ledger;
      const nowIso = new Date(txNowMs).toISOString();
      cur.endedAt = nowIso;
      db.prepare(`
        UPDATE council_sessions
        SET status = ?, reason_code = ?, rounds_started = ?, tokens_charged = ?,
            session_json = ?, updated_at = ?, ended_at = ?
        WHERE project_id = ? AND id = ?
      `).run(
        cur.status,
        cur.reasonCode ?? null,
        cur.roundsStarted || 0,
        cur.tokensCharged || 0,
        JSON.stringify(cur),
        nowIso,
        cur.endedAt,
        projectId,
        sessionId
      );
      return { session: cur, fenced, alreadyTerminal: false };
    });
    return tx();
  }

  settleTurnAtomic(projectId, sessionId, turnId, {
    status,
    usage = null,
    chargedTokens = null,
    text = null,
    endedAt = new Date().toISOString(),
    reasonCode = null,
    allowWhenSessionTerminal = false,
    nowFn = null,
    nowMs = null,
    resolvedProviderKey = null,
  } = {}) {
    const { db } = this._getHandle(projectId);
    const tx = db.transaction(() => {
      const txNowMs = typeof nowFn === 'function' ? nowFn() : (Number.isFinite(nowMs) ? nowMs : Date.now());
      const sRow = db.prepare(`
        SELECT status, deadline_at, tokens_charged, tokens_reserved, session_json
        FROM council_sessions
        WHERE project_id = ? AND id = ?
      `).get(projectId, sessionId);
      const tRow = db.prepare(`
        SELECT status, reserved_tokens, turn_json
        FROM council_turns
        WHERE session_id = ? AND id = ?
      `).get(sessionId, turnId);
      if (!sRow || !tRow) return { settled: false, fenced: true, reasonCode: 'NOT_FOUND' };
      if (tRow.status !== 'reserved') {
        return { settled: false, fenced: true, reasonCode: 'ALREADY_SETTLED', turn: JSON.parse(tRow.turn_json) };
      }

      const deadlineMs = Date.parse(sRow.deadline_at);
      const deadlineExpired = Number.isFinite(deadlineMs) && txNowMs >= deadlineMs;
      const sessionActive = sRow.status === 'queued' || sRow.status === 'running';
      const curTurn = JSON.parse(tRow.turn_json);
      if (resolvedProviderKey) curTurn.resolvedProviderKey = resolvedProviderKey;
      const reserved = Number(tRow.reserved_tokens) || 0;

      // P1 #3: NEVER let allowWhenSessionTerminal bypass deadline expiry on successful turn settlement!
      const mustFenceSuccess = status === 'succeeded' && (deadlineExpired || (!sessionActive && !allowWhenSessionTerminal));
      const effectiveStatus = mustFenceSuccess ? 'cancelled' : status;
      const effectiveReason = mustFenceSuccess ? 'LATE_WRITE_FENCED' : reasonCode;

      const charge = chargedTokens !== null && chargedTokens !== undefined
        ? Math.max(0, Number(chargedTokens))
        : (effectiveStatus === 'cancelled' && usage === null ? 0 : reserved);

      curTurn.status = effectiveStatus;
      curTurn.usage = usage;
      curTurn.chargedTokens = charge;
      curTurn.text = effectiveStatus === 'succeeded' ? text : (curTurn.text ?? null);
      curTurn.endedAt = endedAt;
      curTurn.reasonCode = effectiveReason;

      const newReserved = Math.max(0, (Number(sRow.tokens_reserved) || 0) - reserved);
      const newCharged = (Number(sRow.tokens_charged) || 0) + charge;
      const curSession = JSON.parse(sRow.session_json);
      curSession.tokensCharged = newCharged;

      db.prepare(`
        UPDATE council_turns
        SET status = ?, charged_tokens = ?, turn_json = ?, updated_at = ?
        WHERE session_id = ? AND id = ?
      `).run(curTurn.status, charge, JSON.stringify(curTurn), endedAt, sessionId, turnId);

      db.prepare(`
        UPDATE council_sessions
        SET tokens_reserved = ?, tokens_charged = ?, session_json = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(newReserved, newCharged, JSON.stringify(curSession), endedAt, projectId, sessionId);

      return {
        settled: true,
        fenced: effectiveReason === 'LATE_WRITE_FENCED',
        turn: curTurn,
        tokensCharged: newCharged,
        tokensReserved: newReserved,
      };
    });
    return tx();
  }

  listTurns(projectId, sessionId) {
    const { db } = this._getHandle(projectId);
    const rows = db.prepare(`
      SELECT turn_json FROM council_turns
      WHERE session_id = ?
      ORDER BY round ASC, created_at ASC, id ASC
    `).all(sessionId);
    return rows.map(r => JSON.parse(r.turn_json));
  }

  // ─── Durable Single-Writer Outcome Outbox (`council-outcomes.jsonl`) ─

  /**
   * Cross-process outbox serialization via SQLite `BEGIN IMMEDIATE` (P1 #9):
   * Acquires SQLite's native OS write lock on `council.sqlite` for the entire
   * outbox repair/append/fsync/ack critical section and releases automatically
   * on process crash — ZERO `.lock`/`.reap` files and ZERO check-then-unlink races!
   */
  _withOutboxLock(db, fn) {
    return db.transaction(fn).immediate();
  }

  _appendJsonlSync(jsonlPath, outcome) {
    const buf = Buffer.from(JSON.stringify(outcome) + '\n', 'utf8');
    const fd = openSync(jsonlPath, 'a');
    try {
      let offset = 0;
      while (offset < buf.length) {
        const written = writeSync(fd, buf, offset, buf.length - offset);
        if (written <= 0) {
          throw new Error(`Short write while appending to ${jsonlPath}`);
        }
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Single serialized outbox repair + reconciliation + export path (P1 #9):
   * 1. Scan JSONL; if any malformed/partial line exists, truncate cleanly to `validBytes` & fsync.
   * 2. Reconcile disk `eventId` set against ALL committed SQLite outcome rows (including
   *    any previously-acknowledged rows that may have followed a malformed/truncated line!).
   * 3. Append any missing committed rows (zero duplicates, zero lost rows).
   * 4. Mark `exported_at` on un-acknowledged rows present on disk (unless `simulateCrashBeforeAck`).
   */
  _reconcileOutboxLocked(db, projectId, jsonlPath, { simulateCrashBeforeAck = false } = {}) {
    let repairedTail = false;
    const diskEventIds = new Set();

    if (existsSync(jsonlPath)) {
      const rawBuf = readFileSync(jsonlPath);
      const rawStr = rawBuf.toString('utf8');
      let validBytes = 0;
      const lines = rawStr.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isLast = i === lines.length - 1;
        if (isLast && line === '') break;
        if (isLast && !rawStr.endsWith('\n')) {
          repairedTail = true;
          break;
        }
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj.eventId === 'string') {
            diskEventIds.add(obj.eventId);
            validBytes += Buffer.byteLength(line + '\n', 'utf8');
          } else {
            repairedTail = true;
            break;
          }
        } catch {
          repairedTail = true;
          break;
        }
      }
      if (repairedTail && validBytes < rawBuf.length) {
        truncateSync(jsonlPath, validBytes);
        const fd = openSync(jsonlPath, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }

    const now = new Date().toISOString();
    let ackedFromDisk = 0;
    let flushed = 0;
    const allCommitted = db.prepare(`
      SELECT event_id, outcome_json, exported_at FROM council_outcomes
      WHERE project_id = ?
      ORDER BY recorded_at ASC, rowid ASC
    `).all(projectId);

    for (const row of allCommitted) {
      if (!diskEventIds.has(row.event_id)) {
        const obj = JSON.parse(row.outcome_json);
        this._appendJsonlSync(jsonlPath, obj);
        diskEventIds.add(row.event_id);
        flushed++;
        if (!simulateCrashBeforeAck && !row.exported_at) {
          db.prepare('UPDATE council_outcomes SET exported_at = ? WHERE event_id = ?').run(now, row.event_id);
        }
      } else if (!row.exported_at && !simulateCrashBeforeAck) {
        db.prepare('UPDATE council_outcomes SET exported_at = ? WHERE event_id = ?').run(now, row.event_id);
        ackedFromDisk++;
      }
    }
    return { repairedTail, ackedFromDisk, flushed };
  }

  repairOutboxOnStartup(projectId) {
    const handle = this._dbs.get(projectId) || this._getHandle(projectId);
    if (!handle) return { repairedTail: false, ackedFromDisk: 0, flushed: 0 };
    const { db, jsonlPath } = handle;
    return this._withOutboxLock(db, () => this._reconcileOutboxLocked(db, projectId, jsonlPath));
  }

  recordOutcome(projectId, outcome, dedupKey, { simulateCrashBeforeAck = false } = {}) {
    const { db, jsonlPath } = this._getHandle(projectId);
    const tx = db.transaction(() => {
      const existing = db.prepare(`
        SELECT outcome_json, exported_at FROM council_outcomes WHERE dedup_key = ?
      `).get(dedupKey);
      if (existing) {
        return { deduplicated: true, outcome: JSON.parse(existing.outcome_json), alreadyExported: Boolean(existing.exported_at) };
      }
      const rec = {
        v: 1,
        eventId: outcome.eventId || `cout_${randomUUID().slice(0, 12)}`,
        recordedAt: outcome.recordedAt || new Date().toISOString(),
        ...outcome,
        projectId,
      };
      db.prepare(`
        INSERT INTO council_outcomes (
          event_id, project_id, session_id, source, verdict, synthesis_digest,
          dedup_key, exported_at, outcome_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        rec.eventId,
        projectId,
        rec.sessionId,
        rec.source,
        rec.verdict,
        rec.synthesisDigest,
        dedupKey,
        JSON.stringify(rec),
        rec.recordedAt
      );
      return { deduplicated: false, outcome: rec, alreadyExported: false };
    });

    const ins = tx.immediate();
    if (!ins.alreadyExported) {
      this._withOutboxLock(db, () => {
        this._reconcileOutboxLocked(db, projectId, jsonlPath, { simulateCrashBeforeAck });
      });
    }
    return { deduplicated: ins.deduplicated, outcome: ins.outcome };
  }

  listOutcomes(projectId, sessionId = null) {
    const { db } = this._getHandle(projectId);
    const rows = sessionId
      ? db.prepare('SELECT outcome_json FROM council_outcomes WHERE project_id = ? AND session_id = ? ORDER BY recorded_at ASC').all(projectId, sessionId)
      : db.prepare('SELECT outcome_json FROM council_outcomes WHERE project_id = ? ORDER BY recorded_at ASC').all(projectId);
    return rows.map(r => JSON.parse(r.outcome_json));
  }

  /**
   * Observed outcome metrics per mode — aggregated directly across ALL project sessions
   * in SQLite (P2 #3: no silent 200-session cap!), strictly separating operator verdicts &
   * Anchor results with ZERO fabricated confidence/Laplace scores!
   */
  getOutcomeMetrics(projectId) {
    const { db } = this._getHandle(projectId);
    // P2 #3: Aggregate directly in SQLite via GROUP BY (zero row-by-row JS hydration, zero 200-session cap!)
    const modeAggs = db.prepare(`
      SELECT
        s.mode AS mode,
        COUNT(*) AS sessions,
        SUM(COALESCE(s.tokens_charged, 0)) AS total_charged_tokens,
        SUM(
          CASE
            WHEN s.created_at IS NOT NULL AND s.ended_at IS NOT NULL
                 AND (julianday(s.ended_at) - julianday(s.created_at)) >= 0
            THEN CAST(ROUND((julianday(s.ended_at) - julianday(s.created_at)) * 86400000.0) AS INTEGER)
            ELSE 0
          END
        ) AS total_latency_ms,
        SUM(
          CASE
            WHEN EXISTS (
              SELECT 1 FROM council_outcomes o
              WHERE o.project_id = s.project_id AND o.session_id = s.id
            ) THEN 1 ELSE 0
          END
        ) AS measured_sessions
      FROM council_sessions s
      WHERE s.project_id = ?
      GROUP BY s.mode
    `).all(projectId);

    const outcomeAggs = db.prepare(`
      SELECT
        s.mode AS mode,
        o.source AS source,
        o.verdict AS verdict,
        COUNT(*) AS cnt
      FROM council_outcomes o
      INNER JOIN council_sessions s
        ON s.project_id = o.project_id AND s.id = o.session_id
      WHERE o.project_id = ?
      GROUP BY s.mode, o.source, o.verdict
    `).all(projectId);

    const byMode = {};
    let totalSessions = 0;
    for (const row of modeAggs) {
      const sessions = Number(row.sessions || 0);
      const measuredSessions = Number(row.measured_sessions || 0);
      const totalLatencyMs = Number(row.total_latency_ms || 0);
      totalSessions += sessions;
      byMode[row.mode] = {
        sessions,
        measuredSessions,
        unmeasuredSessions: Math.max(0, sessions - measuredSessions),
        measurementCoverage: sessions > 0 ? Number((measuredSessions / sessions).toFixed(4)) : 0,
        operatorVerdicts: { adopted: 0, rejected: 0, partial: 0 },
        anchorResults: { pass: 0, fail: 0 },
        totalChargedTokens: Number(row.total_charged_tokens || 0),
        totalLatencyMs,
        avgLatencyMs: sessions > 0 ? Math.round(totalLatencyMs / sessions) : 0,
      };
    }

    for (const row of outcomeAggs) {
      const m = byMode[row.mode];
      if (!m) continue;
      const cnt = Number(row.cnt || 0);
      if (row.source === 'operator' && m.operatorVerdicts[row.verdict] !== undefined) {
        m.operatorVerdicts[row.verdict] += cnt;
      } else if (row.source === 'anchor' && m.anchorResults[row.verdict] !== undefined) {
        m.anchorResults[row.verdict] += cnt;
      }
    }

    return { projectId, totalSessions, byMode };
  }
}

export function createCouncilStore(synapseDir) {
  return new CouncilStore(synapseDir);
}
