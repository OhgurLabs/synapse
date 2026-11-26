import { createHash, randomUUID } from 'crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync, constants as fsConstants, fstatSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const VERSION = '1.0.0';
const ID_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$';
const ID = new RegExp(ID_PATTERN);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const digest = (data) => createHash('sha256').update(data).digest('hex');
const runnerPath = fileURLToPath(import.meta.url);
const runnerDigest = digest(readFileSync(runnerPath));
const registeredDigest = (id) => digest(runnerDigest + ':' + id);
const record = (value) => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const stringId = { type: 'string', pattern: ID_PATTERN };
const closed = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const assertionSchema = closed({ id: { type: 'string' }, passed: { type: 'boolean' } });
const proofSchema = closed({ version: { const: 1 }, assertions: { type: 'array', items: assertionSchema, minItems: 1 } });
const artifact = (path) => ({ path, storage: 'artifact' });
const node = (nodeId, kind, dependsOn, config) => ({ nodeId, kind, dependsOn, timeoutMs: 60_000,
  workspace: 'node-dir', outputs: [], ...config });
const operation = (nodeId, operationId, path) => node(nodeId, 'http', [], {
  operationId, implementationDigest: registeredDigest(operationId), effect: 'read-only', config: {},
  outputs: [artifact(path)],
});
const agent = (nodeId, role, prompt, output, workspace = 'node-dir') => node(nodeId, 'agent', [], {
  selector: { role }, prompt, outputs: [output], workspace,
});
const review = (dependsOn) => node('independent-review', 'check', dependsOn, {
  workspace: 'read-only', selector: { role: 'reviewer' }, modelSeparation: 'require-different-provider',
  outputs: [artifact('review.json')],
  prompt: 'Review the captured commit against the requested specification and engineering standards. ' +
    'Return the two verdicts, reviewedSourceSha and disposition in review.json.',
});
const reduce = (nodeId, dependsOn, transformId, path) => node(nodeId, 'reduce', dependsOn, {
  transformId, implementationDigest: registeredDigest(transformId), config: {}, outputs: [artifact(path)],
});
const anchor = (id, dependsOn) => node(id, 'anchor', dependsOn, { workspace: 'read-only', anchorId: id });
const specification = (anchorId, requiredAssertions) => ({
  anchorId, runnerId: anchorId + '@1', implementationDigest: runnerDigest, requiredAssertions, proofSchema,
});

const ANCHORS = {
  'verify-pr-source': specification('verify-pr-source', ['exact-source', 'verification-recipe']),
  'verify-benchmark': specification('verify-benchmark', ['case-coverage', 'unique-cases', 'fixture-scores']),
  'verify-health': specification('verify-health', ['fresh-data', 'health-schema', 'health-bounds']),
  'verify-integrated-source': specification('verify-integrated-source', ['exact-source', 'verification-recipe']),
};
const PR_EVIDENCE = { mode: 'pr', checkerNodeId: 'independent-review' };
const ARTIFACT_EVIDENCE = { mode: 'artifact' };
const DAILY_PARAMS = { operationId: 'service-health', time: '09:00', timezone: 'Etc/UTC' };

function pack(id, title, description, paramsSchema, defaults, rosterSpec, nodes, anchorId, evidence, schedule = null) {
  const outputs = Object.fromEntries(nodes.flatMap((entry) => entry.outputs
    .filter((out) => out.storage === 'artifact')
    .map((out) => [entry.nodeId, { nodeId: entry.nodeId, path: out.path }])));
  return { id, version: VERSION, title, description, paramsSchema, defaults, rosterSpec, manifest: {
    schemaVersion: 1, loopId: id, loopVersion: 1, title, scope: null,
    paramsSchema, defaults, nodes, outputs, anchors: [ANCHORS[anchorId]], evidence, schedule,
    scheduleEnabled: false,
  } };
}

export const LOOP_TEMPLATES = freeze([
  pack('multi-model-pr-review-council', 'Multi-model PR review council',
    'Capture a bound PR commit, review it independently, and verify it before operator approval.',
    closed({ prId: stringId }), { prId: 'example-pr' }, { roles: ['author', 'reviewer'], separate: ['author', 'reviewer'] },
    [operation('capture-source', 'capture-pr-source@1', 'source.json'), review(['capture-source']),
      anchor('verify-pr-source', ['independent-review'])], 'verify-pr-source', PR_EVIDENCE),
  pack('model-benchmark-suite', 'Model benchmark suite',
    'Evaluate an approved suite in parallel and verify coverage and scores against a trusted fixture.',
    closed({ suiteId: stringId, childProjectIds: { type: 'array', items: stringId, minItems: 1, maxItems: 16,
      uniqueItems: true }, caseCount: { type: 'integer', minimum: 1, maximum: 100 } }),
    { suiteId: 'example-suite', childProjectIds: ['example-child'], caseCount: 8 }, { roles: ['evaluator'] },
    [agent('evaluate-first', 'evaluator', 'Evaluate the odd positions among the first {{params.caseCount}} cases ' +
        'of registered suite {{params.suiteId}} for projects {{params.childProjectIds}}. ' +
        'Write the case IDs and scores to first.json.', artifact('first.json')),
      agent('evaluate-second', 'evaluator', 'Evaluate the even positions among the first {{params.caseCount}} cases ' +
        'of registered suite {{params.suiteId}} for projects {{params.childProjectIds}}. ' +
        'Write the case IDs and scores to second.json.', artifact('second.json')),
      reduce('scoreboard', ['evaluate-first', 'evaluate-second'], 'benchmark-scoreboard@1', 'scoreboard.json'),
      anchor('verify-benchmark', ['scoreboard'])], 'verify-benchmark', ARTIFACT_EVIDENCE),
  pack('daily-verified-ops-loop', 'Daily verified ops loop',
    'Read a registered health operation and verify its response on a disarmed daily schedule.',
    closed({ operationId: stringId, time: { type: 'string', pattern: TIME.source },
      timezone: { type: 'string', minLength: 1, maxLength: 64 } }),
    DAILY_PARAMS, { roles: [] },
    [operation('read-health', 'read-verified-health@1', 'health.json'),
      anchor('verify-health', ['read-health']),
      reduce('health-summary', ['read-health', 'verify-health'], 'verified-health-summary@1', 'summary.json')],
    'verify-health', ARTIFACT_EVIDENCE, { cadence: { preset: 'daily-at', time: DAILY_PARAMS.time },
      timezone: DAILY_PARAMS.timezone, params: DAILY_PARAMS, overlap: 'skip', missedRun: 'skip' }),
  pack('hardened-feature-pipeline', 'Hardened feature pipeline',
    'Integrate work from isolated worktrees and verify the resulting commit before independent review and approval.',
    closed({ workItemId: stringId, target: stringId }), { workItemId: 'example-work', target: 'default' },
    { roles: ['developer', 'reviewer'], separate: ['developer', 'reviewer'] },
    [agent('implementation', 'developer', 'Implement work item {{params.workItemId}} for registered target ' +
        '{{params.target}}. Write the implementation in feature.mjs.', { path: 'feature.mjs', storage: 'git' }, 'worktree'),
      agent('verification', 'developer', 'Write tests for the specification of work item {{params.workItemId}} ' +
        'for registered target {{params.target}} in feature.test.mjs.', { path: 'feature.test.mjs', storage: 'git' }, 'worktree'),
      reduce('integration', ['implementation', 'verification'], 'integrated-source-index@1', 'integration.json'),
      anchor('verify-integrated-source', ['integration']), review(['integration', 'verify-integrated-source'])],
    'verify-integrated-source', PR_EVIDENCE),
]);

export const listLoopTemplates = () => LOOP_TEMPLATES;
export const getLoopTemplate = (templateId, version = VERSION) =>
  LOOP_TEMPLATES.find((template) => template.id === templateId && template.version === version) ?? null;

function matches(value, schema) {
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems &&
    value.length <= schema.maxItems && new Set(value).size === value.length &&
    [...value].every((item) => matches(item, schema.items));
  return typeof value === 'string' && value.length >= (schema.minLength ?? 1) &&
    value.length <= (schema.maxLength ?? 64) && (!schema.pattern || new RegExp(schema.pattern).test(value));
}

function validTimezone(zone) {
  // Numeric offsets are valid Intl inputs but the schedule accepts named IANA identifiers.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

export function validateTemplateParams(template, params) {
  if (!template || !record(params)) return { valid: false, errors: ['INVALID_PARAMS'] };
  const schema = template.paramsSchema;
  if (Object.keys(params).some((name) => !Object.hasOwn(schema.properties, name))) {
    return { valid: false, errors: ['UNKNOWN_PARAM'] };
  }
  const values = { ...template.defaults, ...params };
  const errors = schema.required.filter((name) => !matches(values[name], schema.properties[name]));
  if (Object.hasOwn(values, 'timezone') && !validTimezone(values.timezone) && !errors.includes('timezone')) errors.push('timezone');
  return errors.length ? { valid: false, errors } : { valid: true, params: structuredClone(values), errors: [] };
}

const REDUCERS = {
  'benchmark-scoreboard@1': ({ artifacts }) => {
    if (artifacts.length !== 2 || artifacts.some((value) => !Array.isArray(value?.cases))) throw new Error('BENCHMARK_INPUT_INVALID');
    const cases = artifacts.flatMap((value) => value.cases);
    if (cases.length > 100 || cases.some((item) => typeof item?.caseId !== 'string' || !ID.test(item.caseId) ||
      !Number.isFinite(item?.score) || item.score < 0 || item.score > 1)) throw new Error('BENCHMARK_INPUT_INVALID');
    return { cases: cases.map(({ caseId, score }) => ({ caseId, score }))
      .sort((left, right) => left.caseId < right.caseId ? -1 : Number(left.caseId > right.caseId)) };
  },
  'verified-health-summary@1': ({ artifacts }) => {
    const { observedAt, healthy, measurements } = artifacts[0];
    return { observedAt, healthy, measurements: Object.fromEntries(Object.entries(measurements).sort()) };
  },
  'integrated-source-index@1': ({ inputs, run }) => {
    const sourceSha = run.provenance?.source?.postIntegrationHeadSha;
    if (!SHA.test(sourceSha ?? '') || inputs.length !== 2 || inputs.some((entry) => !SHA.test(entry.commitSha ?? ''))) {
      throw new Error('INTEGRATED_SOURCE_MISSING');
    }
    return { sourceSha, commits: [...inputs].sort((a, b) => a.nodeId < b.nodeId ? -1 : 1)
      .map(({ nodeId, commitSha }) => ({ nodeId, commitSha })) };
  },
};

const OPERATIONS = ['capture-pr-source@1', 'read-verified-health@1'];

// This adapter reads content-addressed artifacts through the existing Loop store.
export function createTemplateRegistries({ readArtifactBytes, operations = {} } = {}) {
  return {
    reducers: Object.fromEntries(Object.entries(REDUCERS).map(([id, reducer]) => [id, {
      id, digest: registeredDigest(id),
      execute({ node, inputs, run }) {
        const artifacts = id === 'integrated-source-index@1' ? [] :
          inputs.filter((attempt) => attempt.nodeId !== 'verify-health')
            .map((attempt) => JSON.parse(readArtifactBytes(attempt.outputs[0].sha256)));
        return [{ path: node.outputs[0].path, content: Buffer.from(JSON.stringify(reducer({ artifacts, inputs, run }))) }];
      },
    }])),
    anchors: Object.fromEntries(Object.values(ANCHORS).map((spec) => [spec.runnerId,
      { digest: spec.implementationDigest, runnerPath }])),
    operations: Object.fromEntries(OPERATIONS.filter((id) => typeof operations[id] === 'function')
      .map((id) => [id, { digest: registeredDigest(id), execute: operations[id] }])),
  };
}

export function evaluateTemplateAnchor(runnerId, input, { verifySubject } = {}) {
  const spec = Object.values(ANCHORS).find((entry) => entry.runnerId === runnerId);
  if (!spec) throw new Error('TEMPLATE_ANCHOR_UNKNOWN');
  let passed;
  if (runnerId === 'verify-benchmark@1') {
    const { cases, expectedScores, caseCount } = input;
    const rows = Array.isArray(cases) ? cases : [];
    const fixture = record(expectedScores) ? expectedScores : {};
    const ids = new Set(rows.map((entry) => entry?.caseId));
    passed = [Number.isInteger(caseCount) && caseCount > 0 && caseCount === rows.length &&
      caseCount === Object.keys(fixture).length && rows.every((entry) => Object.hasOwn(fixture, entry?.caseId)),
    rows.length > 0 && ids.size === rows.length,
    rows.length > 0 && rows.every((entry) => Number.isFinite(entry?.score) && entry.score === fixture[entry.caseId])];
  } else if (runnerId === 'verify-health@1') {
    const { response, nowMs, maxAgeMs, bounds } = input;
    const observed = typeof response?.observedAt === 'string' ? Date.parse(response.observedAt) : NaN;
    const readings = response?.measurements;
    const entries = record(bounds) ? Object.entries(bounds) : [];
    const schema = entries.length > 0 && typeof response?.healthy === 'boolean' && record(readings) &&
      Object.keys(readings).length === entries.length && entries.every(([id]) => Number.isFinite(readings[id]));
    passed = [Number.isFinite(nowMs) && Number.isFinite(maxAgeMs) && maxAgeMs > 0 &&
      nowMs >= observed && nowMs - observed <= maxAgeMs, schema,
    schema && response.healthy && entries.every(([id, bound]) =>
      Number.isFinite(bound?.min) && Number.isFinite(bound?.max) && readings[id] >= bound.min && readings[id] <= bound.max)];
  } else {
    const exact = SHA.test(input.expectedSha ?? '') && input.expectedSha === input.subjectSha;
    passed = [exact, exact && verifySubject?.(input.subjectSha) === true];
  }
  return { version: 1, assertions: spec.requiredAssertions.map((id, index) => ({ id, passed: passed[index] === true })) };
}

function approvedScope(templateId, params, scope, projectId) {
  if (scope?.projectId !== projectId) return false;
  const registered = (list, value) => Array.isArray(list) && list.includes(value);
  switch (templateId) {
    case 'multi-model-pr-review-council':
      return registered(scope.prIds, params.prId);
    case 'model-benchmark-suite':
      return registered(scope.suiteIds, params.suiteId) &&
        params.childProjectIds.every((id) => id !== projectId && registered(scope.childProjectIds, id));
    case 'daily-verified-ops-loop':
      return registered(scope.operationIds, params.operationId);
    case 'hardened-feature-pipeline':
      return registered(scope.workItemIds, params.workItemId) && registered(scope.targets, params.target);
  }
  return false;
}

function capable(template, agents) {
  if (!Array.isArray(agents)) return template.rosterSpec.roles.length === 0;
  const candidates = (role) => agents.filter((agent) => agent?.enabled !== false && agent?.paused !== true &&
    (agent?.role === role || agent?.roles?.includes(role)) && typeof agent?.id === 'string' && agent.id &&
    typeof agent?.provider === 'string' && agent.provider.trim());
  if (template.rosterSpec.roles.some((role) => !candidates(role).length)) return false;
  if (!template.rosterSpec.separate) return true;
  const [author, reviewer] = template.rosterSpec.separate.map(candidates);
  return author.some((worker) => reviewer.some((checker) => worker.id !== checker.id &&
    worker.provider.trim().toLowerCase() !== checker.provider.trim().toLowerCase()));
}

function registeredManifest(manifest, registries) {
  const pins = [
    ...manifest.anchors.map((spec) => [registries?.anchors, spec.runnerId, spec.implementationDigest]),
    ...manifest.nodes.filter(({ kind }) => kind === 'reduce').map((node) =>
      [registries?.reducers, node.transformId, node.implementationDigest]),
    ...manifest.nodes.filter(({ kind }) => kind === 'http').map((node) =>
      [registries?.operations, node.operationId, node.implementationDigest]),
  ];
  return pins.every(([registry, id, expected]) => Object.hasOwn(registry ?? {}, id) && registry[id].digest === expected);
}

// The transaction callback is serialized by request ID. In production, commit the replay record
// with the Loop version, or make publishLoop replay by its deterministic loopId and request digest.

export function createSqliteTemplateIdempotencyStore(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new Error('TEMPLATE_SQLITE_DB_REQUIRED');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS template_idempotency (
      scoped_key TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      loop_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS template_idempotency_locks (
      scoped_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const selectStmt = db.prepare('SELECT request_digest, loop_json FROM template_idempotency WHERE scoped_key = ?');
  const insertIgnoreStmt = db.prepare(`
    INSERT OR IGNORE INTO template_idempotency (scoped_key, request_digest, loop_json, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const evictExpiredLockStmt = db.prepare('DELETE FROM template_idempotency_locks WHERE scoped_key = ? AND expires_at <= ?');
  const acquireLockStmt = db.prepare('INSERT OR IGNORE INTO template_idempotency_locks (scoped_key, owner, expires_at) VALUES (?, ?, ?)');
  const renewLockStmt = db.prepare('UPDATE template_idempotency_locks SET expires_at = ? WHERE scoped_key = ? AND owner = ? AND expires_at > ?');
  const checkLockStmt = db.prepare('SELECT owner, expires_at FROM template_idempotency_locks WHERE scoped_key = ?');
  const releaseLockStmt = db.prepare('DELETE FROM template_idempotency_locks WHERE scoped_key = ? AND owner = ?');

  const LEASE_TTL_MS = 30_000;
  // Always sample Date.now() INSIDE BEGIN IMMEDIATE (after SQLite write-lock acquisition)!
  const tryAcquireLockImmediate = db.transaction((key, owner, ttlMs) => {
    const nowMs = Date.now();
    evictExpiredLockStmt.run(key, nowMs);
    acquireLockStmt.run(key, owner, nowMs + ttlMs);
    return checkLockStmt.get(key)?.owner === owner;
  });
  // Only renews an active, unexpired lease using post-lock clock (AND expires_at > nowMs); NEVER revives an expired lease!
  const renewLockImmediate = db.transaction((key, owner, ttlMs) => {
    const nowMs = Date.now();
    const res = renewLockStmt.run(nowMs + ttlMs, key, owner, nowMs);
    return res.changes === 1;
  });
  const assertLockHeldImmediate = db.transaction((key, owner) => {
    const lockRow = checkLockStmt.get(key);
    if (!lockRow || lockRow.owner !== owner || lockRow.expires_at <= Date.now()) {
      const err = new Error(`TEMPLATE_IDEMPOTENCY_LOCK_LOST:${key}`);
      err.code = 'TEMPLATE_IDEMPOTENCY_LOCK_LOST';
      throw err;
    }
  });
  const releaseLockImmediate = db.transaction((key, owner) => {
    releaseLockStmt.run(key, owner);
  });
  const readImmediate = db.transaction((key) => {
    const row = selectStmt.get(key);
    if (!row) return undefined;
    return { requestDigest: row.request_digest, loop: JSON.parse(row.loop_json) };
  });
  // Commit-once INSERT OR IGNORE gated on active lock ownership: refuses ownerless/expired writes!
  const writeOnceImmediate = db.transaction((key, owner, record) => {
    const lockRow = checkLockStmt.get(key);
    if (!lockRow || lockRow.owner !== owner || lockRow.expires_at <= Date.now()) {
      const err = new Error(`TEMPLATE_IDEMPOTENCY_LOCK_LOST:${key}`);
      err.code = 'TEMPLATE_IDEMPOTENCY_LOCK_LOST';
      throw err;
    }
    insertIgnoreStmt.run(key, record.requestDigest, JSON.stringify(record.loop), new Date().toISOString());
    const committed = selectStmt.get(key);
    return { requestDigest: committed.request_digest, loop: JSON.parse(committed.loop_json) };
  });
  const pending = new Map();
  return {
    async transact(key, operation) {
      const previous = pending.get(key) ?? Promise.resolve();
      const current = previous.then(async () => {
        const owner = `${process.pid}:${randomUUID()}`;
        const deadline = Date.now() + 10_000;
        let locked = false;
        while (!locked) {
          locked = tryAcquireLockImmediate.immediate(key, owner, LEASE_TTL_MS);
          if (!locked) {
            if (Date.now() >= deadline) {
              throw new Error(`Timed out acquiring cross-process template idempotency lock for ${key}`);
            }
            await new Promise((r) => setTimeout(r, 15));
          }
        }
        const heartbeat = setInterval(() => {
          try {
            const renewed = renewLockImmediate.immediate(key, owner, LEASE_TTL_MS);
            if (!renewed) clearInterval(heartbeat);
          } catch {}
        }, 5_000);
        if (typeof heartbeat.unref === 'function') heartbeat.unref();
        try {
          const existing = readImmediate.immediate(key);
          return await operation(
            existing,
            (record) => writeOnceImmediate.immediate(key, owner, record),
            () => assertLockHeldImmediate.immediate(key, owner),
          );
        } finally {
          clearInterval(heartbeat);
          try { releaseLockImmediate.immediate(key, owner); } catch {}
        }
      });
      const settled = current.catch(() => {});
      pending.set(key, settled);
      try { return await current; } finally {
        if (pending.get(key) === settled) pending.delete(key);
      }
    },
  };
}

export function createFileTemplateIdempotencyStore(filePath) {
  // Always backed by kernel-locked SQLite BEGIN IMMEDIATE + INSERT OR IGNORE (migrates legacy JSON records on first open!)
  const isDirectSqlite = /\.(?:sqlite|db)$/i.test(String(filePath || ''));
  const dbPath = isDirectSqlite ? filePath : `${filePath}.sqlite`;
  let sqliteStorePromise = null;
  const getStore = () => {
    if (!sqliteStorePromise) {
      sqliteStorePromise = import('better-sqlite3').then(({ default: Database }) => {
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new Database(dbPath);
        try {
          db.pragma('journal_mode = WAL');
          db.pragma('busy_timeout = 5000');
          const store = createSqliteTemplateIdempotencyStore(db);
          if (!isDirectSqlite && filePath) {
            let legacyText = null;
            try {
              legacyText = readFileSync(filePath, 'utf8');
            } catch (readErr) {
              if (readErr?.code !== 'ENOENT') throw readErr;
            }
            if (legacyText !== null) {
              const raw = JSON.parse(legacyText);
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new Error(`TEMPLATE_LEGACY_IDEMPOTENCY_INVALID:${filePath}`);
              }
              const ins = db.prepare(`
                INSERT OR IGNORE INTO template_idempotency (scoped_key, request_digest, loop_json, created_at)
                VALUES (?, ?, ?, ?)
              `);
              const migrate = db.transaction((obj) => {
                const nowIso = new Date().toISOString();
                for (const [k, rec] of Object.entries(obj)) {
                  if (typeof k === 'string' && rec && typeof rec === 'object' && typeof rec.requestDigest === 'string' && rec.loop && typeof rec.loop === 'object') {
                    ins.run(k, rec.requestDigest, JSON.stringify(rec.loop), nowIso);
                  }
                }
              });
              // Fail closed on SQLite/migration errors (e.g. SQLITE_BUSY) so legacy keys are never silently skipped!
              migrate.immediate(raw);
            }
          }
          return store;
        } catch (err) {
          try { db.close(); } catch {}
          throw err;
        }
      }).catch((err) => {
        sqliteStorePromise = null;
        throw err;
      });
    }
    return sqliteStorePromise;
  };
  return {
    async transact(key, operation) {
      const store = await getStore();
      return store.transact(key, operation);
    },
  };
}

export function createMemoryTemplateIdempotencyStore() {
  const entries = new Map();
  const pending = new Map();
  return {
    async transact(requestId, operation) {
      const previous = pending.get(requestId) ?? Promise.resolve();
      const current = previous.then(() => operation(entries.get(requestId), (record) => { if (!entries.has(requestId)) entries.set(requestId, record); return entries.get(requestId); }));
      const settled = current.catch(() => {});
      pending.set(requestId, settled);
      try { return await current; } finally {
        if (pending.get(requestId) === settled) pending.delete(requestId);
      }
    },
  };
}

export async function instantiateLoopFromTemplate({
  templateId, templateVersion = VERSION, projectId, name, params = {}, requestId, rosterSpec,
  publishLoop, idempotencyStore,
}) {
  const invalid = (code, errors) => ({ statusCode: 422, code, ...(errors ? { errors } : {}) });
  const template = getLoopTemplate(templateId, templateVersion);
  if (typeof requestId !== 'string' || !ID.test(requestId) || typeof projectId !== 'string' || !ID.test(projectId) ||
    typeof name !== 'string' || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    return invalid('TEMPLATE_REQUEST_INVALID');
  }
  if (!template) return invalid('TEMPLATE_NOT_FOUND');
  const validated = validateTemplateParams(template, params);
  if (!validated.valid) return invalid('TEMPLATE_PARAMS_INVALID', validated.errors);
  const values = validated.params;
  const requestDigest = digest(canonical({ templateId, templateVersion, projectId, name, params: values }));
  if (!idempotencyStore?.transact || typeof publishLoop !== 'function') {
    throw new Error('TEMPLATE_PUBLISH_ADAPTERS_REQUIRED');
  }

  const scopedKey = `${projectId}:${requestId}`;
  const loopId = 'loop-' + digest(canonical({ projectId, requestId })).slice(0, 40);
  const recoverPublishedVersion1 = async (save) => {
    if (typeof rosterSpec?.getExistingLoop !== 'function') return null;
    const recovered = await rosterSpec.getExistingLoop(loopId, 1);
    const recProv = recovered?.manifest?.provenance;
    if (!recovered || recovered.loopVersion !== 1 || recovered.manifest?.scope?.projectId !== projectId || recProv?.requestId !== requestId) {
      return null;
    }
    if (recProv.requestDigest === requestDigest) {
      const recoveredLoop = { ...recovered, provenance: recProv, scheduleEnabled: false };
      await save({ requestDigest, loop: structuredClone(recoveredLoop) });
      return { statusCode: 200, loop: recoveredLoop };
    }
    return { statusCode: 409, code: 'TEMPLATE_REQUEST_ID_CONFLICT' };
  };
  return idempotencyStore.transact(scopedKey, async (existing, save, assertLocked) => {
    if (!approvedScope(templateId, values, rosterSpec, projectId)) return invalid('TEMPLATE_SCOPE_INVALID');
    if (existing) return existing.requestDigest === requestDigest
      ? { statusCode: 200, loop: structuredClone(existing.loop) }
      : { statusCode: 409, code: 'TEMPLATE_REQUEST_ID_CONFLICT' };
    // Check published loopVersion === 1 BEFORE capability check so crash recovery works even after roster changes!
    const preRecovered = await recoverPublishedVersion1(save);
    if (preRecovered) return preRecovered;
    if (!capable(template, rosterSpec.agents)) return invalid('TEMPLATE_CAPABILITY_UNAVAILABLE');

    const provenance = { templateId, templateVersion, templateDigest: digest(canonical(template)), requestId, requestDigest };
    const manifest = structuredClone(template.manifest);
    Object.assign(manifest, { loopId, title: name, scope: { projectId }, defaults: values, provenance });
    // Runtime overrides must preserve the resources authorized at instantiation.
    for (const [parameter, schema] of Object.entries(manifest.paramsSchema.properties)) {
      if (!['caseCount', 'time', 'timezone'].includes(parameter)) {
        manifest.paramsSchema.properties[parameter] = { ...schema, const: values[parameter] };
      }
    }
    if (manifest.schedule) {
      manifest.schedule = { ...manifest.schedule, cadence: { preset: 'daily-at', time: values.time },
        timezone: values.timezone, params: values };
    }
    const registries = rosterSpec.registries ?? createTemplateRegistries();
    if (!registeredManifest(manifest, registries)) return invalid('TEMPLATE_REGISTRY_UNAVAILABLE');
    try {
      const compiled = await rosterSpec.validateManifest?.(structuredClone(manifest), registries);
      if (compiled === false || compiled?.valid === false) return invalid('TEMPLATE_MANIFEST_INVALID');
    } catch {
      return invalid('TEMPLATE_MANIFEST_INVALID');
    }
    if (typeof assertLocked === 'function') assertLocked();
    let loop;
    try {
      const published = await publishLoop({ loopId, projectId, baseVersion: 0, manifest,
        scheduleEnabled: false, provenance, requestId, requestDigest });
      loop = { ...published, provenance, scheduleEnabled: false };
    } catch (error) {
      if (error?.statusCode === 409) {
        const postRecovered = await recoverPublishedVersion1(save);
        if (postRecovered) return postRecovered;
      }
      if ([400, 422].includes(error.statusCode)) return invalid('TEMPLATE_PUBLISH_INVALID');
      throw error;
    }
    const committed = await save({ requestDigest, loop: structuredClone(loop) });
    if (committed && typeof committed.requestDigest === 'string' && committed.requestDigest !== requestDigest) {
      return { statusCode: 409, code: 'TEMPLATE_REQUEST_ID_CONFLICT' };
    }
    if (committed && committed.loop) {
      return { statusCode: 201, loop: structuredClone(committed.loop) };
    }
    return { statusCode: 201, loop };
  });
}

function resolveGitBinary() {
  for (const candidate of ['/usr/bin/git', '/bin/git']) {
    try { if (statSync(candidate).isFile()) return candidate; } catch {}
  }
  return '/usr/bin/git';
}

// Keep the built-in JUnit reporter on its own descriptor. A CLI destination
// path makes Node 22+ fsync the report on close, which the permission model denies.
const JUNIT_FD_REPORTER = 'data:text/javascript,' + encodeURIComponent(`
  import { junit } from 'node:test/reporters';
  import { createWriteStream } from 'node:fs';
  import { pipeline } from 'node:stream/promises';
  export default async function* (events) {
    await pipeline(junit(events), createWriteStream(null, { fd: 3, flush: false }));
  }
`);

function resolveTarBinary() {
  for (const candidate of ['/usr/bin/tar', '/bin/tar']) {
    try { if (statSync(candidate).isFile()) return candidate; } catch {}
  }
  return '/usr/bin/tar';
}

export function verifyNodeTests(subjectSha, { subjectDir, allowHostFallback = false, suiteTimeoutMs = 30_000 } = {}) {
  if (typeof subjectDir !== 'string' || !subjectDir.trim()) return false;
  if (!SHA.test(subjectSha ?? '')) return false;
  const cwd = resolve(subjectDir);
  const gitBin = resolveGitBinary();
  const gitHardened = ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesfile=/dev/null'];
  const env = {
    PATH: '/usr/bin:/bin', LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1',
  };
  const scratch = mkdtempSync(join(tmpdir(), 'synapse-template-anchor-'));
  const outPath = join(scratch, 'stdout');
  const exportDir = join(scratch, 'pinned-export');
  function run(command, args, runCwd = cwd) {
    const output = openSync(outPath, 'w', 0o600);
    try {
      execFileSync(command, args, { cwd: runCwd, env, stdio: ['ignore', output, 'ignore'], timeout: 45_000 });
    } finally {
      closeSync(output);
    }
    if (statSync(outPath).size > 1024 * 1024) throw new Error('TEMPLATE_ANCHOR_OUTPUT_LIMIT');
    return readFileSync(outPath, 'utf8');
  }
  try {
    const head = run(gitBin, [...gitHardened, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']).trim();
    if (head !== subjectSha) return false;
    const status = run(gitBin, [...gitHardened, 'status', '--porcelain', '--untracked-files=all']);
    if (status) return false;
    // Materialize the EXACT commit tree directly via ls-tree + cat-file blob
    // (100% immune to git replace refs, .gitattributes export-ignore/export-subst, untracked, and .gitignored files)
    mkdirSync(exportDir, { mode: 0o700 });
    const treeBuf = execFileSync(gitBin, [...gitHardened, 'ls-tree', '-r', '-z', subjectSha], {
      cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
    });
    const entries = treeBuf.toString('utf8').split('\0').filter(Boolean);
    const trackedTestFiles = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      if (tab < 0) return false;
      const meta = entry.slice(0, tab).split(' ');
      const rel = entry.slice(tab + 1);
      const [mode, type, oid] = meta;
      if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
        return false;
      }
      if (type !== 'blob') continue;
      if (mode === '120000') return false; // reject symlinks in pinned commit export
      const blobBytes = execFileSync(gitBin, [...gitHardened, 'cat-file', 'blob', oid], {
        cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 15_000,
      });
      const abs = join(exportDir, rel);
      mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
      writeFileSync(abs, blobBytes, { flag: 'wx', mode: mode === '100755' ? 0o500 : 0o400 });
      // Match Node's EXACT documented default discovery rules for JS & TS tests:
      // singular test/**, test.*, test-[^/]*.* (permits empty suffix like test-.ts), *.test.*, *-test.*, *_test.*
      // (NEVER tests/ plural or *.spec.*!)
      const inNodeModules = rel === 'node_modules' || rel.startsWith('node_modules/') || rel.includes('/node_modules/');
      const isNodeDefaultTest = !inNodeModules && (
        /(?:^|\/)test\/.*\.(?:[cm]?[jt]s)$/.test(rel) ||
        /(?:^|\/)(?:test|test-[^/]*|[^/]+(?:\.test|-test|_test))\.(?:[cm]?[jt]s)$/.test(rel)
      );
      if (isNodeDefaultTest) {
        trackedTestFiles.push({ rel, abs });
      }
    }
    if (entries.length === 0 || trackedTestFiles.length === 0) return false;
    trackedTestFiles.sort((a, b) => a.rel.localeCompare(b.rel));

    // Honest Loop trust boundary:
    // This verifier enforces isolated, offline, read-only, no-host-IPC execution of committed test files
    // with ZERO verifier secrets/credentials inside the candidate runtime (built-in JUnit reporter).
    // Semantic test-quality authenticity (preventing trivial `assert.ok(true)` tests) is enforced by the
    // Loop's fresh-context cross-provider Checker and Two-Key Human Approval gate.
    const childTmp = join(scratch, 'child-tmp');
    mkdirSync(childTmp, { recursive: true, mode: 0o700 });

    // Pre-execution integrity digest of exportDir (verified unchanged after execution!)
    const hashExportTree = () => {
      const h = createHash('sha256');
      const allRels = entries.map((e) => e.slice(e.indexOf('\t') + 1)).sort();
      for (const r of allRels) {
        const absP = join(exportDir, r);
        h.update(`F\0${r}\0`);
        h.update(readFileSync(absP));
      }
      return h.digest('hex');
    };
    const preDigest = hashExportTree();

    // Minimal-root bubblewrap mount set:
    // - ZERO host /tmp, /run, /var/run, /home, or host childTmp dir mounted (uses isolated --tmpfs /work-tmp!)
    // - Mounts ONLY the Node binary file itself (--ro-bind execPath execPath) if outside /usr|/bin, NEVER its parent dir
    // - Enforces --unshare-all + --die-with-parent for deterministic teardown!
    const bwrapWorkTmp = '/work-tmp';
    const bwrapMinimalArgs = [
      '--die-with-parent',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
      ...(process.execPath.startsWith('/usr/') || process.execPath.startsWith('/bin/')
        ? [] : ['--ro-bind', process.execPath, process.execPath]),
      '--tmpfs', '/tmp',
      '--tmpfs', '/run',
      '--tmpfs', '/var',
      '--tmpfs', bwrapWorkTmp,
      '--dev', '/dev',
      '--proc', '/proc',
      '--unshare-all',
      '--ro-bind', exportDir, exportDir,
    ];

    const canaryPath = join(scratch, 'perm-canary.txt');
    writeFileSync(canaryPath, 'canary\n', { mode: 0o400 });
    const hostIpcCanary = join(scratch, 'host-ipc-canary.sock');
    writeFileSync(hostIpcCanary, '', { mode: 0o600 });

    // Probe minimal-root bwrap with fixed shell script and positional args ($1, $2 — ZERO filename interpolation!):
    // 1. Host /tmp canary socket path ($1) MUST NOT exist inside sandbox
    // 2. /run MUST be empty (fresh tmpfs, zero host Unix sockets)
    // 3. chmod u+w on exported file ($2) MUST fail (kernel EROFS)
    let sandboxMode = null;
    const firstExportedFile = trackedTestFiles[0].abs;
    const bwrapCheck = spawnSync('bwrap', [
      ...bwrapMinimalArgs,
      '--', '/bin/sh', '-c',
      '[ ! -e "$1" ] && [ -z "$(ls -A /run 2>/dev/null)" ] && ! chmod u+w "$2" 2>/dev/null',
      '_', hostIpcCanary, firstExportedFile,
    ], {
      cwd: exportDir,
      env: { PATH: env.PATH, TMPDIR: bwrapWorkTmp },
      timeout: 5_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (bwrapCheck.status === 0 && !bwrapCheck.error) {
      sandboxMode = 'bwrap';
    } else if (allowHostFallback === true) {
      // Explicit non-default fallback for AppArmor-restricted unit-test hosts only (never default in CLI/production!)
      const unshareCheck = spawnSync('unshare', ['--user', '--net', '--', '/bin/true'], {
        cwd: exportDir,
        env: { PATH: env.PATH, TMPDIR: childTmp },
        timeout: 5_000,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      if (unshareCheck.status === 0 && !unshareCheck.error) sandboxMode = 'unshare';
    }
    if (!sandboxMode) return false;

    const effectiveTmpDir = sandboxMode === 'bwrap' ? bwrapWorkTmp : childTmp;
    // ALWAYS enforce Node permission model with ZERO --allow-child-process, ZERO --allow-worker,
    // and ZERO --allow-fs-read=* (only exportDir and isolated tmp readable; only isolated tmp writable by path).
    const permFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
    const permFlags = [
      permFlag,
      `--allow-fs-read=${exportDir}`,
      `--allow-fs-read=${effectiveTmpDir}`,
      `--allow-fs-write=${effectiveTmpDir}`,
    ];
    const runSandboxedNode = (nodeArgs, { timeout, junitFd = null }) => {
      const childEnv = { PATH: env.PATH, TMPDIR: effectiveTmpDir, HOME: effectiveTmpDir };
      const spawnOpts = {
        cwd: exportDir,
        encoding: 'utf8',
        env: childEnv,
        timeout,
        killSignal: 'SIGKILL',
        stdio: junitFd !== null ? ['ignore', 'ignore', 'pipe', junitFd] : ['ignore', 'pipe', 'pipe'],
      };
      if (sandboxMode === 'bwrap') {
        return spawnSync('bwrap', [
          ...bwrapMinimalArgs,
          '--', process.execPath, ...permFlags, ...nodeArgs,
        ], spawnOpts);
      }
      return spawnSync('unshare', [
        '--user', '--net', '--', process.execPath, ...permFlags, ...nodeArgs,
      ], spawnOpts);
    };

    // Active enforcement probe: prove host read, canary write, canary chmod, and child_process ALL fail ERR_ACCESS_DENIED!
    const permProbe = runSandboxedNode(['-e', [
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      "const assert = require('node:assert/strict');",
      "assert.throws(() => fs.readFileSync('/etc/passwd'), { code: 'ERR_ACCESS_DENIED' });",
      `assert.throws(() => fs.writeFileSync(${JSON.stringify(canaryPath)}, 'x'), { code: 'ERR_ACCESS_DENIED' });`,
      `assert.throws(() => fs.chmodSync(${JSON.stringify(canaryPath)}, 0o600), { code: 'ERR_ACCESS_DENIED' });`,
      "assert.throws(() => cp.execFileSync(process.execPath, ['-e', '']), { code: 'ERR_ACCESS_DENIED' });",
      "process.stdout.write('SANDBOX_OK');",
    ].join('\n')], { timeout: 5_000 });
    if (permProbe.status !== 0 || !String(permProbe.stdout || '').includes('SANDBOX_OK')) return false;

    // Single MONOTONIC suite-wide deadline (performance.now() immune to wall-clock jumps) + SIGKILL teardown!
    const effectiveSuiteTimeoutMs = Number.isFinite(suiteTimeoutMs) && suiteTimeoutMs > 0 ? suiteTimeoutMs : 30_000;
    const suiteDeadlineMono = performance.now() + effectiveSuiteTimeoutMs;

    // Execute every discovered test with JUnit output on an unlinked O_EXCL
    // descriptor so candidate stdout cannot mix with the XML.
    for (const { abs: tfAbs } of trackedTestFiles) {
      const remainingMs = Math.ceil(suiteDeadlineMono - performance.now());
      if (remainingMs <= 0) return false;
      const junitTmpPath = join(scratch, `junit-${randomUUID()}.xml`);
      const junitFd = openSync(junitTmpPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      let xml = '';
      try {
        unlinkSync(junitTmpPath);
        const runRes = runSandboxedNode([`--test-reporter=${JUNIT_FD_REPORTER}`, tfAbs], {
          timeout: remainingMs, junitFd,
        });
        if (runRes.status !== 0 || runRes.error) return false;
        const junitStat = fstatSync(junitFd);
        if (!Number.isFinite(junitStat.size) || junitStat.size <= 0 || junitStat.size > 2 * 1024 * 1024) {
          return false;
        }
        xml = readFileSync(`/proc/self/fd/${junitFd}`, 'utf8');
      } finally {
        closeSync(junitFd);
      }
      if (!xml.includes('<?xml ') || !xml.includes('<testsuites>') || !xml.includes('</testsuites>')) return false;
      if (/<(?:failure|error|skipped)\b/i.test(xml)) return false;
      const testsMatch = /<!--\s*tests\s+([1-9]\d*)\s*-->/.exec(xml);
      const passMatch = /<!--\s*pass\s+([1-9]\d*)\s*-->/.exec(xml);
      if (!testsMatch || !passMatch) return false;
      const totalTests = Number.parseInt(testsMatch[1], 10);
      const passedTests = Number.parseInt(passMatch[1], 10);
      if (passedTests !== totalTests || totalTests < 1) return false;
      if (!/<!--\s*fail\s+0\s*-->/.test(xml) || !/<!--\s*cancelled\s+0\s*-->/.test(xml) ||
          !/<!--\s*skipped\s+0\s*-->/.test(xml) || !/<!--\s*todo\s+0\s*-->/.test(xml)) {
        return false;
      }
      const testcaseCount = [...xml.matchAll(/<testcase\b/g)].length;
      if (testcaseCount < totalTests) return false;
    }

    // Verify exported commit tree remained byte-for-byte immutable throughout execution
    if (hashExportTree() !== preDigest) return false;
    return true;
  } catch { return false; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

// The Loop engine supplies trusted Anchor inputs through its anchorArgsBuilder. For commit checks,
// process.argv[4] MUST be the trusted isolated checkout directory (never untrusted input JSON).
if (process.argv[1] && resolve(process.argv[1]) === runnerPath) {
  try {
    const parsedInput = JSON.parse(process.argv[3]);
    const trustedSubjectDir = process.argv[4] || null;
    const proof = evaluateTemplateAnchor(process.argv[2], parsedInput, { verifySubject: (sha) => verifyNodeTests(sha, { subjectDir: trustedSubjectDir }) });
    process.stdout.write(JSON.stringify(proof) + '\n');
    if (proof.assertions.some((assertion) => !assertion.passed)) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
