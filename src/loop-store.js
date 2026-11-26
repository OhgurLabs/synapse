/**
 * Phase 2A — Instance-Level Transactional LoopStore.
 *
 * Persists immutable versioned LoopManifests (CAS by baseVersion), pinned LoopRuns,
 * immutable Attempt records, schedule arming & occurrence claims, external effect receipts,
 * Git integration intents, operator approval events, and idempotent PR finalization intents
 * in one transactional SQLite database (`loops.sqlite`, WAL + busy_timeout).
 *
 * Immutable artifact bytes are written to content-addressed storage (`loop-artifacts/<sha256>`)
 * via atomic temp-rename BEFORE committing their FileRef references in SQLite.
 */

import Database from 'better-sqlite3';
import Ajv from 'ajv';
import { createHash, randomUUID } from 'crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { modelClass } from './roster.js';
import { createLogger } from './logger.js';

const log = createLogger('loop-store');
const ajv = new Ajv({ allErrors: true, strict: false });

export const LOOP_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * Deterministic canonical JSON (recursive lexicographically sorted object keys).
 * Used for hashing manifests, dependency versions, side-effect keys, and non-string prompt params.
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonicalJson cannot serialize non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new Error(`canonicalJson unsupported type: ${typeof value}`);
}

export function sha256Buffer(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return createHash('sha256').update(b).digest('hex');
}

export function sha256Hex(str) {
  return sha256Buffer(Buffer.from(String(str), 'utf8'));
}

/**
 * Extract attested quantization token separately from model family class.
 * Never invents/guesses a quant when the model identifier or adapter does not attest one.
 */
export function extractModelQuant(model, attestedQuant = null) {
  if (typeof attestedQuant === 'string' && attestedQuant.trim()) {
    return attestedQuant.trim();
  }
  const m = String(model || '').trim();
  if (!m) return null;
  if (/\.gguf$/i.test(m)) {
    const base = m.replace(/\.gguf$/i, '');
    const match = base.match(/[-_.]((?:UD[-_.])?(?:I?Q\d[A-Za-z0-9_]*|F16|BF16|FP16|F32))$/i);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Build pinned ModelQuantRecord entry for an agent assignment.
 * Uses roster.modelClass(model) for family identity and records quant separately.
 */
export function buildModelQuantEntry(agentId, agentDef) {
  if (!agentDef) throw new Error(`Agent "${agentId}" not found for model pin`);
  const model = String(agentDef.model || '').trim();
  if (!model) throw new Error(`Agent "${agentId}" has no model configured`);
  return {
    agentId: String(agentId),
    agentInstanceId: String(agentDef.agentInstanceId || agentDef.instanceId || `${agentDef.provider || 'unknown'}:${agentId}`),
    provider: String(agentDef.provider || 'unknown'),
    model,
    modelClass: modelClass(model) || model.toLowerCase(),
    quant: extractModelQuant(model, agentDef.quant ?? null),
  };
}

/**
 * Resolve Loop parameters in deterministic precedence order:
 *   manifest.defaults -> ancestor project defaults (declared keys only) ->
 *   child project defaults (declared keys only) -> trigger/manual overrides.
 * Validates the final object against manifest.paramsSchema via Ajv.
 */
function defineOwnDataKey(target, key, val) {
  Object.defineProperty(target, key, {
    value: structuredClone(val),
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function resolveLoopParams(manifest, {
  ancestorDefaults = [],
  projectDefaults = null,
  overrides = null,
} = {}) {
  const schema = manifest?.paramsSchema || { type: 'object', properties: {}, additionalProperties: false };
  const declaredKeys = new Set(Object.keys(schema.properties || {}));
  const resolved = Object.create(null);

  if (manifest?.defaults && typeof manifest.defaults === 'object') {
    for (const [k, v] of Object.entries(manifest.defaults)) {
      defineOwnDataKey(resolved, k, v);
    }
  }

  for (const anc of (Array.isArray(ancestorDefaults) ? ancestorDefaults : [])) {
    if (!anc || typeof anc !== 'object') continue;
    for (const [k, v] of Object.entries(anc)) {
      if (declaredKeys.has(k)) defineOwnDataKey(resolved, k, v);
    }
  }

  if (projectDefaults && typeof projectDefaults === 'object') {
    for (const [k, v] of Object.entries(projectDefaults)) {
      if (declaredKeys.has(k)) defineOwnDataKey(resolved, k, v);
    }
  }

  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      defineOwnDataKey(resolved, k, v);
    }
  }

  const validate = ajv.compile(schema);
  if (!validate(resolved)) {
    const detail = (validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
    const err = new Error(`Invalid Loop parameters: ${detail}`);
    err.code = 'INVALID_LOOP_PARAMS';
    err.statusCode = 400;
    throw err;
  }

  return resolved;
}

export class LoopStore {
  constructor(synapseDir) {
    if (!synapseDir || typeof synapseDir !== 'string') {
      throw new Error('LoopStore requires synapseDir');
    }
    this.synapseDir = synapseDir;
    this.dbPath = join(synapseDir, 'loops.sqlite');
    this.artifactsDir = join(synapseDir, 'loop-artifacts');
    this.packetsDir = join(synapseDir, 'loop-packets');
    mkdirSync(this.synapseDir, { recursive: true });
    mkdirSync(this.artifactsDir, { recursive: true });
    mkdirSync(this.packetsDir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loop_manifests (
        loop_id TEXT NOT NULL,
        loop_version INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (loop_id, loop_version)
      );

      CREATE TABLE IF NOT EXISTS loop_schedules (
        schedule_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL UNIQUE,
        loop_version INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        effective_from TEXT NOT NULL,
        cursor_utc TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        schedule_id TEXT NOT NULL,
        scheduled_slot_iso TEXT NOT NULL,
        occurrence_key TEXT NOT NULL UNIQUE,
        disposition TEXT NOT NULL,
        run_id TEXT,
        loop_version INTEGER NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (schedule_id, scheduled_slot_iso)
      );

      CREATE TABLE IF NOT EXISTS schedule_skipped_ranges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        from_utc TEXT NOT NULL,
        to_utc TEXT NOT NULL,
        skipped_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loop_runs (
        run_id TEXT PRIMARY KEY,
        loop_id TEXT NOT NULL,
        loop_version INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,
        phase TEXT NOT NULL,
        verdict TEXT,
        reason_code TEXT,
        request_id TEXT,
        occurrence_key TEXT,
        execution_owner TEXT,
        run_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_runs_req
        ON loop_runs (loop_id, request_id)
        WHERE request_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_runs_occ
        ON loop_runs (occurrence_key)
        WHERE occurrence_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS effect_receipts (
        side_effect_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS integration_intents (
        intent_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        staging_ref TEXT NOT NULL,
        prepared_commit_sha TEXT,
        post_integration_head_sha TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        principal_kind TEXT NOT NULL,
        approved_source_sha TEXT NOT NULL,
        review_sha256 TEXT NOT NULL,
        anchor_set_sha256 TEXT NOT NULL,
        approved_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finalization_intents (
        intent_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        approval_event_id TEXT NOT NULL,
        approved_source_sha TEXT NOT NULL,
        evidence_packet_sha256 TEXT,
        checksum_manifest_sha256 TEXT,
        packet_dir TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = this.db.prepare("PRAGMA table_info(loop_runs)").all().map(c => c.name);
    if (!cols.includes('execution_owner')) {
      this.db.exec('ALTER TABLE loop_runs ADD COLUMN execution_owner TEXT');
    }
  }

  close() {
    try { this.db.close(); } catch {}
  }

  // ─── Immutable Content-Addressed Artifact Storage ──────────────────

  writeArtifactBytes(logicalPath, rawBytes) {
    const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(String(rawBytes), 'utf8');
    const digest = sha256Buffer(buf);
    const dest = join(this.artifactsDir, digest);
    if (!existsSync(dest)) {
      const tmp = `${dest}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, dest);
    }
    return {
      path: String(logicalPath),
      sha256: digest,
      bytes: buf.length,
    };
  }

  readArtifactBytes(sha256) {
    if (!SHA256_RE.test(String(sha256 || ''))) {
      throw new Error(`Invalid artifact sha256: ${sha256}`);
    }
    const p = join(this.artifactsDir, sha256);
    if (!existsSync(p)) {
      throw new Error(`Artifact not found in immutable store: ${sha256}`);
    }
    const buf = readFileSync(p);
    const actual = sha256Buffer(buf);
    if (actual !== sha256) {
      throw new Error(`Artifact digest corruption for ${sha256} (actual ${actual})`);
    }
    return buf;
  }

  verifyFileRef(fileRef) {
    if (!fileRef || !SHA256_RE.test(String(fileRef.sha256 || ''))) return false;
    const p = join(this.artifactsDir, fileRef.sha256);
    if (!existsSync(p)) return false;
    const buf = readFileSync(p);
    return buf.length === fileRef.bytes && sha256Buffer(buf) === fileRef.sha256;
  }

  // ─── Immutable Versioned LoopManifest CAS Publication ──────────────

  publishLoopVersion({ manifest, baseVersion = 0, validateManifestFn = null } = {}) {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('publishLoopVersion requires a manifest object');
    }
    if (!LOOP_ID_RE.test(String(manifest.loopId || ''))) {
      const err = new Error(`Invalid loopId "${manifest.loopId}" — must match ${LOOP_ID_RE}`);
      err.code = 'INVALID_LOOP_ID';
      err.statusCode = 400;
      throw err;
    }

    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT COALESCE(MAX(loop_version), 0) AS maxVer FROM loop_manifests WHERE loop_id = ?'
      ).get(manifest.loopId);
      const currentMax = Number(row?.maxVer || 0);
      if (Number(baseVersion) !== currentMax) {
        const err = new Error(`Stale baseVersion ${baseVersion} for loop "${manifest.loopId}" (current is ${currentMax})`);
        err.code = 'STALE_BASE_VERSION';
        err.statusCode = 409;
        throw err;
      }

      const nextVersion = currentMax + 1;
      const published = structuredClone(manifest);
      published.schemaVersion = 1;
      published.loopVersion = nextVersion;

      if (typeof validateManifestFn === 'function') {
        validateManifestFn(published);
      }

      const canonical = canonicalJson(published);
      const manifestHash = sha256Hex(canonical);
      const now = new Date().toISOString();

      this.db.prepare(`
        INSERT INTO loop_manifests (loop_id, loop_version, manifest_hash, manifest_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(published.loopId, nextVersion, manifestHash, canonical, now);

      return {
        loopId: published.loopId,
        loopVersion: nextVersion,
        manifestHash,
        manifest: published,
        createdAt: now,
      };
    });

    return tx();
  }

  getLoopVersion(loopId, loopVersion = null) {
    const row = loopVersion == null
      ? this.db.prepare(
          'SELECT * FROM loop_manifests WHERE loop_id = ? ORDER BY loop_version DESC LIMIT 1'
        ).get(loopId)
      : this.db.prepare(
          'SELECT * FROM loop_manifests WHERE loop_id = ? AND loop_version = ?'
        ).get(loopId, Number(loopVersion));
    if (!row) return null;
    return {
      loopId: row.loop_id,
      loopVersion: row.loop_version,
      manifestHash: row.manifest_hash,
      manifest: JSON.parse(row.manifest_json),
      createdAt: row.created_at,
    };
  }

  listLoopVersions(loopId) {
    const rows = this.db.prepare(
      'SELECT loop_id, loop_version, manifest_hash, manifest_json, created_at FROM loop_manifests WHERE loop_id = ? ORDER BY loop_version ASC'
    ).all(loopId);
    return rows.map(r => ({
      loopId: r.loop_id,
      loopVersion: r.loop_version,
      manifestHash: r.manifest_hash,
      manifest: JSON.parse(r.manifest_json),
      createdAt: r.created_at,
    }));
  }

  listLoops({ projectId = undefined } = {}) {
    const rows = this.db.prepare(`
      SELECT m.* FROM loop_manifests m
      INNER JOIN (
        SELECT loop_id, MAX(loop_version) AS max_ver FROM loop_manifests GROUP BY loop_id
      ) latest ON m.loop_id = latest.loop_id AND m.loop_version = latest.max_ver
      ORDER BY m.loop_id ASC
    `).all();
    const out = rows.map(r => ({
      loopId: r.loop_id,
      loopVersion: r.loop_version,
      manifestHash: r.manifest_hash,
      manifest: JSON.parse(r.manifest_json),
      createdAt: r.created_at,
      schedule: this.getLoopSchedule(r.loop_id),
    }));
    if (projectId === undefined) return out;
    return out.filter(item => {
      const scopeProj = item.manifest?.scope?.projectId ?? null;
      return projectId === null ? scopeProj === null : scopeProj === projectId;
    });
  }

  // ─── Schedule Arming & Transactional Occurrence Storage ────────────

  setLoopScheduleArming(loopId, { enabled, loopVersion = null, effectiveFrom = new Date().toISOString(), cursorUtc = null } = {}) {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM loop_schedules WHERE loop_id = ?').get(loopId);
      const targetVer = loopVersion != null
        ? Number(loopVersion)
        : (existing ? existing.loop_version : this.getLoopVersion(loopId)?.loopVersion);
      if (!targetVer) {
        throw new Error(`Cannot arm schedule: loop "${loopId}" has no published version`);
      }
      const ver = this.getLoopVersion(loopId, targetVer);
      if (!ver) {
        throw new Error(`Loop "${loopId}" version ${targetVer} not found`);
      }
      const now = new Date().toISOString();
      const scheduleId = existing?.schedule_id || `lsched_${loopId}`;
      const eff = String(effectiveFrom || now);
      const cur = cursorUtc ? String(cursorUtc) : (existing?.cursor_utc || eff);

      if (existing) {
        this.db.prepare(`
          UPDATE loop_schedules
          SET loop_version = ?, enabled = ?, effective_from = ?, cursor_utc = ?, updated_at = ?
          WHERE loop_id = ?
        `).run(targetVer, enabled ? 1 : 0, eff, cur, now, loopId);
      } else {
        this.db.prepare(`
          INSERT INTO loop_schedules (schedule_id, loop_id, loop_version, enabled, effective_from, cursor_utc, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(scheduleId, loopId, targetVer, enabled ? 1 : 0, eff, cur, now);
      }
      return this.getLoopSchedule(loopId);
    });
    return tx();
  }

  getLoopSchedule(loopId) {
    const row = this.db.prepare('SELECT * FROM loop_schedules WHERE loop_id = ?').get(loopId);
    if (!row) return null;
    return {
      scheduleId: row.schedule_id,
      loopId: row.loop_id,
      loopVersion: row.loop_version,
      enabled: row.enabled === 1,
      effectiveFrom: row.effective_from,
      cursorUtc: row.cursor_utc,
      updatedAt: row.updated_at,
    };
  }

  getLoopScheduleByScheduleId(scheduleId) {
    const row = this.db.prepare('SELECT * FROM loop_schedules WHERE schedule_id = ?').get(scheduleId);
    if (!row) return null;
    return {
      scheduleId: row.schedule_id,
      loopId: row.loop_id,
      loopVersion: row.loop_version,
      enabled: row.enabled === 1,
      effectiveFrom: row.effective_from,
      cursorUtc: row.cursor_utc,
      updatedAt: row.updated_at,
    };
  }

  listArmedLoopSchedules() {
    const rows = this.db.prepare('SELECT * FROM loop_schedules WHERE enabled = 1 ORDER BY loop_id ASC').all();
    return rows.map(row => ({
      scheduleId: row.schedule_id,
      loopId: row.loop_id,
      loopVersion: row.loop_version,
      enabled: true,
      effectiveFrom: row.effective_from,
      cursorUtc: row.cursor_utc,
      updatedAt: row.updated_at,
    }));
  }

  listScheduleOccurrences(scheduleId) {
    return this.db.prepare(
      'SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY scheduled_slot_iso ASC'
    ).all(scheduleId);
  }

  listSkippedRanges(scheduleId) {
    return this.db.prepare(
      'SELECT * FROM schedule_skipped_ranges WHERE schedule_id = ? ORDER BY id ASC'
    ).all(scheduleId);
  }

  // ─── Pinned LoopRun CRUD & Transactional Admission ─────────────────

  admitRun(run, { requestId = null, occurrenceKey = null } = {}) {
    const tx = this.db.transaction(() => {
      if (requestId) {
        const dup = this.db.prepare(
          'SELECT run_json FROM loop_runs WHERE loop_id = ? AND request_id = ?'
        ).get(run.pin.loopId, requestId);
        if (dup) {
          return { deduplicated: true, run: JSON.parse(dup.run_json) };
        }
      }
      if (occurrenceKey) {
        const dupOcc = this.db.prepare(
          'SELECT run_json FROM loop_runs WHERE occurrence_key = ?'
        ).get(occurrenceKey);
        if (dupOcc) {
          return { deduplicated: true, run: JSON.parse(dupOcc.run_json) };
        }
      }
      const now = new Date().toISOString();
      const json = JSON.stringify(run);
      this.db.prepare(`
        INSERT INTO loop_runs (
          run_id, loop_id, loop_version, manifest_hash, phase, verdict, reason_code,
          request_id, occurrence_key, run_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.runId,
        run.pin.loopId,
        run.pin.loopVersion,
        run.pin.manifestHash,
        run.phase,
        run.verdict ?? null,
        run.reasonCode ?? null,
        requestId || null,
        occurrenceKey || null,
        json,
        run.provenance?.createdAt || now,
        now
      );
      return { deduplicated: false, run };
    });
    return tx();
  }

  getRun(runId) {
    const row = this.db.prepare('SELECT run_json FROM loop_runs WHERE run_id = ?').get(runId);
    return row ? JSON.parse(row.run_json) : null;
  }

  saveRun(run) {
    const now = new Date().toISOString();
    const res = this.db.prepare(`
      UPDATE loop_runs
      SET phase = ?, verdict = ?, reason_code = ?, run_json = ?, updated_at = ?
      WHERE run_id = ?
    `).run(
      run.phase,
      run.verdict ?? null,
      run.reasonCode ?? null,
      JSON.stringify(run),
      now,
      run.runId
    );
    if (res.changes !== 1) {
      throw new Error(`saveRun: run "${run.runId}" not found`);
    }
    return run;
  }

  /**
   * Mutate a run inside a single SQLite transaction so attempt selection,
   * late-completion fencing, and phase transitions are atomic.
   */
  updateRunAtomic(runId, mutatorFn) {
    const tx = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`updateRunAtomic: run "${runId}" not found`);
      const next = mutatorFn(run) || run;
      this.saveRun(next);
      return next;
    });
    return tx();
  }

  static _isExecutionOwnerAlive(ownerToken, isProcessAlive = null) {
    const raw = String(ownerToken || '');
    const m = /^(\d+):/.exec(raw) || /^eng_(\d+)_/.exec(raw);
    if (!m) return true; // Unknown legacy format: fail closed as alive
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    if (typeof isProcessAlive === 'function') {
      return Boolean(isProcessAlive(pid));
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code !== 'ESRCH';
    }
  }

  /**
   * P1 #8: Durable PID-bound SQLite CAS execution lease so two LoopEngine instances
   * sharing loops.sqlite can NEVER execute the same run concurrently, while a crashed
   * process (ESRCH) cannot permanently strand a non-terminal run.
   */
  claimRunExecution(runId, ownerToken, { isProcessAlive = null } = {}) {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT phase, execution_owner, run_json FROM loop_runs WHERE run_id = ?').get(runId);
      if (!row) return { found: false, claimed: false };
      if (row.phase === 'terminal') return { found: true, claimed: false, terminal: true, run: JSON.parse(row.run_json) };
      let reclaimedFrom = null;
      if (row.execution_owner && row.execution_owner !== ownerToken) {
        if (LoopStore._isExecutionOwnerAlive(row.execution_owner, isProcessAlive)) {
          return { found: true, claimed: false, owner: row.execution_owner };
        }
        reclaimedFrom = row.execution_owner;
      }
      const run = JSON.parse(row.run_json);
      if (run.phase === 'queued') {
        run.phase = 'running';
        run.provenance.startedAt = run.provenance.startedAt || new Date().toISOString();
      }
      const now = new Date().toISOString();
      const res = reclaimedFrom !== null
        ? this.db.prepare(`
            UPDATE loop_runs SET phase = ?, execution_owner = ?, run_json = ?, updated_at = ?
            WHERE run_id = ? AND execution_owner = ?
          `).run(run.phase, ownerToken, JSON.stringify(run), now, runId, reclaimedFrom)
        : this.db.prepare(`
            UPDATE loop_runs SET phase = ?, execution_owner = ?, run_json = ?, updated_at = ?
            WHERE run_id = ? AND (execution_owner IS NULL OR execution_owner = ?)
          `).run(run.phase, ownerToken, JSON.stringify(run), now, runId, ownerToken);
      if (res.changes !== 1) {
        return { found: true, claimed: false, owner: row.execution_owner };
      }
      return { found: true, claimed: true, ...(reclaimedFrom ? { reclaimedFrom } : {}), run };
    });
    return tx();
  }

  releaseRunExecution(runId, ownerToken) {
    this.db.prepare(
      'UPDATE loop_runs SET execution_owner = NULL WHERE run_id = ? AND execution_owner = ?'
    ).run(runId, ownerToken);
  }

  /**
   * P1 #9: Atomically mark integration intents promoted AND update run.provenance.source.postIntegrationHeadSha
   * in ONE SQLite transaction so a crash cannot leave intents promoted while provenance retains the old SHA!
   */
  commitPromotedBatchAtomic({ runId, stagingRef, postIntegrationHeadSha, entries }) {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const e of entries) {
        const intentKey = `${runId}:${e.nodeId}:${e.attemptId}`;
        this.db.prepare(`
          INSERT INTO integration_intents (intent_key, run_id, node_id, attempt_id, staging_ref, prepared_commit_sha, post_integration_head_sha, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'promoted', ?)
          ON CONFLICT(intent_key) DO UPDATE SET
            prepared_commit_sha = COALESCE(excluded.prepared_commit_sha, integration_intents.prepared_commit_sha),
            post_integration_head_sha = excluded.post_integration_head_sha,
            status = 'promoted',
            updated_at = excluded.updated_at
        `).run(intentKey, runId, e.nodeId, e.attemptId, stagingRef, e.preparedCommitSha || null, postIntegrationHeadSha, now);
      }
      const run = this.getRun(runId);
      if (run && run.provenance?.source) {
        run.provenance.source.postIntegrationHeadSha = postIntegrationHeadSha;
        this.saveRun(run);
      }
      return run;
    });
    return tx();
  }

  listRuns(loopId = null) {
    const rows = loopId
      ? this.db.prepare('SELECT run_json FROM loop_runs WHERE loop_id = ? ORDER BY created_at ASC').all(loopId)
      : this.db.prepare('SELECT run_json FROM loop_runs ORDER BY created_at ASC').all();
    return rows.map(r => JSON.parse(r.run_json));
  }

  listActiveRuns(loopId) {
    const rows = this.db.prepare(`
      SELECT run_json FROM loop_runs
      WHERE loop_id = ? AND phase != 'terminal'
      ORDER BY created_at ASC
    `).all(loopId);
    return rows.map(r => JSON.parse(r.run_json));
  }

  // ─── External Side-Effect Receipts ─────────────────────────────────

  reserveEffectReceipt({ sideEffectKey, runId, nodeId, operationId, requestDigest }) {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM effect_receipts WHERE side_effect_key = ?').get(sideEffectKey);
      if (existing) {
        return {
          existed: true,
          receipt: {
            sideEffectKey: existing.side_effect_key,
            runId: existing.run_id,
            nodeId: existing.node_id,
            operationId: existing.operation_id,
            requestDigest: existing.request_digest,
            status: existing.status,
            response: existing.response_json ? JSON.parse(existing.response_json) : null,
            updatedAt: existing.updated_at,
          },
        };
      }
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO effect_receipts (side_effect_key, run_id, node_id, operation_id, request_digest, status, response_json, updated_at)
        VALUES (?, ?, ?, ?, ?, 'reserved', NULL, ?)
      `).run(sideEffectKey, runId, nodeId, operationId, requestDigest, now);
      return {
        existed: false,
        receipt: {
          sideEffectKey, runId, nodeId, operationId, requestDigest, status: 'reserved', response: null, updatedAt: now,
        },
      };
    });
    return tx();
  }

  updateEffectReceipt(sideEffectKey, status, response = null) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE effect_receipts SET status = ?, response_json = ?, updated_at = ? WHERE side_effect_key = ?
    `).run(status, response != null ? JSON.stringify(response) : null, now, sideEffectKey);
  }

  hasUnresolvedEffects(runId) {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM effect_receipts WHERE run_id = ? AND status IN ('reserved', 'ambiguous')`
    ).get(runId);
    return Number(row?.cnt || 0) > 0;
  }

  /**
   * P1 #12: Check unresolved effect receipts across ALL runs for a loopId (active OR terminal flagged!).
   */
  findUnresolvedEffectForLoop(loopId) {
    const row = this.db.prepare(`
      SELECT e.side_effect_key, e.run_id, e.node_id, e.status
      FROM effect_receipts e
      INNER JOIN loop_runs r ON e.run_id = r.run_id
      WHERE r.loop_id = ? AND e.status IN ('reserved', 'ambiguous')
      ORDER BY e.updated_at DESC
      LIMIT 1
    `).get(loopId);
    if (!row) return null;
    return {
      sideEffectKey: row.side_effect_key,
      runId: row.run_id,
      nodeId: row.node_id,
      status: row.status,
    };
  }

  listQueuedRuns(loopId) {
    const rows = this.db.prepare(`
      SELECT run_json FROM loop_runs
      WHERE loop_id = ? AND phase = 'queued'
      ORDER BY created_at ASC
    `).all(loopId);
    return rows.map(r => JSON.parse(r.run_json));
  }

  listCancellingRuns(loopId) {
    const rows = this.db.prepare(`
      SELECT run_json FROM loop_runs
      WHERE loop_id = ? AND phase = 'cancelling'
      ORDER BY created_at ASC
    `).all(loopId);
    return rows.map(r => JSON.parse(r.run_json));
  }

  listIntegrationIntents(runId) {
    const rows = this.db.prepare(
      'SELECT * FROM integration_intents WHERE run_id = ? ORDER BY updated_at ASC'
    ).all(runId);
    return rows.map(row => ({
      intentKey: row.intent_key,
      runId: row.run_id,
      nodeId: row.node_id,
      attemptId: row.attempt_id,
      stagingRef: row.staging_ref,
      preparedCommitSha: row.prepared_commit_sha,
      postIntegrationHeadSha: row.post_integration_head_sha,
      status: row.status,
      updatedAt: row.updated_at,
    }));
  }

  // ─── Git Integration Intents ───────────────────────────────────────

  recordIntegrationIntent({ runId, nodeId, attemptId, stagingRef, preparedCommitSha = null, postIntegrationHeadSha = null, status = 'prepared' }) {
    const intentKey = `${runId}:${nodeId}:${attemptId}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO integration_intents (intent_key, run_id, node_id, attempt_id, staging_ref, prepared_commit_sha, post_integration_head_sha, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(intent_key) DO UPDATE SET
        prepared_commit_sha = COALESCE(excluded.prepared_commit_sha, integration_intents.prepared_commit_sha),
        post_integration_head_sha = COALESCE(excluded.post_integration_head_sha, integration_intents.post_integration_head_sha),
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(intentKey, runId, nodeId, attemptId, stagingRef, preparedCommitSha, postIntegrationHeadSha, status, now);
    return this.getIntegrationIntent(runId, nodeId, attemptId);
  }

  getIntegrationIntent(runId, nodeId, attemptId) {
    const row = this.db.prepare('SELECT * FROM integration_intents WHERE intent_key = ?').get(`${runId}:${nodeId}:${attemptId}`);
    if (!row) return null;
    return {
      intentKey: row.intent_key,
      runId: row.run_id,
      nodeId: row.node_id,
      attemptId: row.attempt_id,
      stagingRef: row.staging_ref,
      preparedCommitSha: row.prepared_commit_sha,
      postIntegrationHeadSha: row.post_integration_head_sha,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  // ─── Approval Events & Idempotent Finalization Intents ─────────────

  recordApprovalEvent({ eventId = `appr_${randomUUID().slice(0, 12)}`, runId, principalId, principalKind = 'operator', approvedSourceSha, reviewSha256, anchorSetSha256, approvedAt = new Date().toISOString() }) {
    this.db.prepare(`
      INSERT INTO approval_events (event_id, run_id, principal_id, principal_kind, approved_source_sha, review_sha256, anchor_set_sha256, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, runId, principalId, principalKind, approvedSourceSha, reviewSha256, anchorSetSha256, approvedAt);
    return {
      eventId, runId, principalId, principalKind, approvedSourceSha, reviewSha256, anchorSetSha256, approvedAt,
    };
  }

  getApprovalEvent(eventId) {
    const r = this.db.prepare('SELECT * FROM approval_events WHERE event_id = ?').get(eventId);
    if (!r) return null;
    return {
      eventId: r.event_id,
      runId: r.run_id,
      principalId: r.principal_id,
      principalKind: r.principal_kind,
      approvedSourceSha: r.approved_source_sha,
      reviewSha256: r.review_sha256,
      anchorSetSha256: r.anchor_set_sha256,
      approvedAt: r.approved_at,
    };
  }

  getLatestApprovalForRun(runId) {
    const r = this.db.prepare('SELECT * FROM approval_events WHERE run_id = ? ORDER BY approved_at DESC LIMIT 1').get(runId);
    if (!r) return null;
    return {
      eventId: r.event_id,
      runId: r.run_id,
      principalId: r.principal_id,
      principalKind: r.principal_kind,
      approvedSourceSha: r.approved_source_sha,
      reviewSha256: r.review_sha256,
      anchorSetSha256: r.anchor_set_sha256,
      approvedAt: r.approved_at,
    };
  }

  upsertFinalizationIntent({ runId, approvalEventId, approvedSourceSha, evidencePacketSha256 = null, checksumManifestSha256 = null, packetDir = null, status = 'pending' }) {
    const intentKey = `${runId}:${approvalEventId}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO finalization_intents (
        intent_key, run_id, approval_event_id, approved_source_sha,
        evidence_packet_sha256, checksum_manifest_sha256, packet_dir, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(intent_key) DO UPDATE SET
        evidence_packet_sha256 = COALESCE(excluded.evidence_packet_sha256, finalization_intents.evidence_packet_sha256),
        checksum_manifest_sha256 = COALESCE(excluded.checksum_manifest_sha256, finalization_intents.checksum_manifest_sha256),
        packet_dir = COALESCE(excluded.packet_dir, finalization_intents.packet_dir),
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(intentKey, runId, approvalEventId, approvedSourceSha, evidencePacketSha256, checksumManifestSha256, packetDir, status, now);
    return this.getFinalizationIntent(runId, approvalEventId);
  }

  getFinalizationIntent(runId, approvalEventId) {
    const r = this.db.prepare('SELECT * FROM finalization_intents WHERE intent_key = ?').get(`${runId}:${approvalEventId}`);
    if (!r) return null;
    return {
      intentKey: r.intent_key,
      runId: r.run_id,
      approvalEventId: r.approval_event_id,
      approvedSourceSha: r.approved_source_sha,
      evidencePacketSha256: r.evidence_packet_sha256,
      checksumManifestSha256: r.checksum_manifest_sha256,
      packetDir: r.packet_dir,
      status: r.status,
      updatedAt: r.updated_at,
    };
  }
}

export function createLoopStore(synapseDir) {
  return new LoopStore(synapseDir);
}
