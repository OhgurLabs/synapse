import { buildArgs } from '../agents/cli-runner.js';
import { DESCRIPTORS, HARNESSES } from '../harnesses/registry.js';
import { withProjectLocalDb } from '../persistence/project-local-db.js';
import { shouldResumeSession } from './lifecycle.js';
import { rehydrateContextBundle, serializeContextBundle } from './rework-context-bundle.js';

const DB_NAME = 'resume-qualification.sqlite';
const BINDING_FIELDS = ['projectId', 'agentId', 'model', 'workspace', 'permissions', 'executionMode'];
const CATALOG_ALIASES = new Map([['claudecode', 'claude'], ['gemini-cli', 'gemini']]);
const descriptors = new Map(DESCRIPTORS.map(descriptor => [descriptor.id, descriptor]));
for (const { id } of HARNESSES) {
  if (!CATALOG_ALIASES.has(id) && !descriptors.has(id)) descriptors.set(id, null);
}

export function createResumeQualificationStore(synapseDir) {
  return {
    list(projectId) {
      const rows = projectId == null ? [] : withProjectLocalDb(synapseDir, projectId, DB_NAME, {}, db => db.prepare(`
        SELECT record FROM resume_qualification AS q WHERE seq = (
          SELECT MAX(seq) FROM resume_qualification WHERE harness_id = q.harness_id
        )
      `).all());
      const latest = new Map((rows || []).map(({ record }) => {
        const parsed = JSON.parse(record);
        return [parsed.harnessId, parsed];
      }));
      return [...descriptors.keys()].map(harnessId => latest.get(harnessId) || {
        harnessId, status: 'unqualified', outcome: null, reasonCode: null, testedAt: null, verifiedFields: [],
      });
    },
    record(projectId, record) {
      withProjectLocalDb(synapseDir, projectId, DB_NAME, { write: true }, db => {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS resume_qualification (
              seq INTEGER PRIMARY KEY,
              harness_id TEXT NOT NULL,
              record TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS resume_qualification_harness
              ON resume_qualification (harness_id, seq);
          `);
          db.prepare('INSERT INTO resume_qualification (harness_id, record) VALUES (?, ?)').run(
            record.harnessId, JSON.stringify(record),
          );
        })();
      });
    },
  };
}

function descriptorProbe({ descriptor, priorDispatch }) {
  const continuation = descriptor?.continuation;
  if (continuation?.strategy !== 'session-id-provided' || !continuation.idFlag || !continuation.resumeFlag) {
    return { resumed: false, reasonCode: 'NATIVE_RESUME_UNSUPPORTED' };
  }
  const { sessionId, model } = priorDispatch;
  const argsFor = resumeSession => buildArgs(descriptor, 'Dry resume qualification', model, [], {
    sessionId, resumeSession, bypassPermissions: false,
  });
  const usesFlag = (args, flag) => args.some((arg, i) => arg === flag && args[i + 1] === sessionId);
  if (!usesFlag(argsFor(false), continuation.idFlag) || !usesFlag(argsFor(true), continuation.resumeFlag)) {
    throw new Error('Resume arguments failed verification');
  }
  return { resumed: true, sessionId };
}

/** Exercise the lifecycle gate and CLI argument builder using synthetic rework state. */
export async function qualifyHarnessResume({ harnessId, probeRunner = descriptorProbe, now = Date.now() }) {
  harnessId = CATALOG_ALIASES.get(harnessId) ?? harnessId;
  if (!descriptors.has(harnessId)) {
    throw Object.assign(new Error('Unknown harness'), { code: 'HARNESS_NOT_FOUND', statusCode: 404 });
  }
  const testedAt = new Date(now).toISOString();
  const binding = {
    projectId: 'qualification-probe', agentId: 'probe-agent', model: 'probe-model',
    workspace: '/qualification-probe/worktree', permissions: 'standard', executionMode: 'worktree',
  };
  const priorDispatch = { ...binding, sessionId: '00000000-0000-4000-8000-000000000001', at: testedAt };
  const valid = { ...binding, priorDispatch, resumeEnabled: true, isVerbatim: false, maxAgeHours: 24, now };
  const task = { id: 'qualification-rework', title: 'Interrupted rework', reviewCycle: 1 };
  const messages = [{ id: 'probe-message', content: 'Preserve the interrupted rework context', timestamp: testedAt }];
  const fallback = reasonCode => {
    const bundle = serializeContextBundle(task, messages, {
      ...binding, claimTime: testedAt, sessionId: '00000000-0000-4000-8000-000000000002',
    });
    const restored = rehydrateContextBundle(JSON.parse(JSON.stringify(bundle)));
    if (restored.taskId !== task.id || restored.reviewCycle !== task.reviewCycle ||
        restored.messages[0]?.content !== messages[0].content || restored.sessionMeta.agentId !== binding.agentId ||
        restored.sessionMeta.sessionId === priorDispatch.sessionId) {
      throw new Error('Rework bundle failed verification');
    }
    return { outcome: 'rework_bundle_fallback', reasonCode };
  };
  const route = input => {
    if (shouldResumeSession(input)) return { outcome: 'native_resume_allowed' };
    if (['checker', 'council'].includes(input.role)) {
      return { outcome: 'rejected_gate', reasonCode: 'FRESH_CONTEXT_REQUIRED' };
    }
    return fallback('RESUME_BINDING_MISMATCH');
  };

  const record = { harnessId, testedAt, verifiedFields: [] };
  let failureReason = 'FRESH_CONTEXT_GATE_FAILED';
  try {
    for (const role of ['checker', 'council']) {
      const result = route({ ...valid, role });
      if (result.outcome !== 'rejected_gate' || result.reasonCode !== 'FRESH_CONTEXT_REQUIRED') throw new Error();
    }
    failureReason = 'RESUME_BINDING_GATE_FAILED';
    for (const field of BINDING_FIELDS) {
      for (const incompatible of [
        { ...valid, [field]: 'different' }, { ...valid, [field]: undefined },
        { ...valid, priorDispatch: { ...priorDispatch, [field]: 'different' } },
        { ...valid, priorDispatch: { ...priorDispatch, [field]: undefined } },
      ]) {
        const result = route(incompatible);
        if (result.outcome !== 'rework_bundle_fallback' || result.reasonCode !== 'RESUME_BINDING_MISMATCH') throw new Error();
      }
      record.verifiedFields.push(field);
    }
    if (route(valid).outcome !== 'native_resume_allowed') throw new Error();
    failureReason = 'RESUME_PROBE_FAILED';
    const result = await probeRunner({ harnessId, descriptor: descriptors.get(harnessId), priorDispatch: { ...priorDispatch } });
    if (result?.resumed === true && result.sessionId === priorDispatch.sessionId) {
      return { ...record, status: 'qualified', outcome: 'native_resumed', reasonCode: 'NATIVE_RESUME_VERIFIED' };
    }
    if (result?.resumed !== false) throw new Error();
    const reasonCode = result.reasonCode === 'NATIVE_RESUME_UNSUPPORTED'
      ? 'NATIVE_RESUME_UNSUPPORTED' : 'NATIVE_RESUME_UNAVAILABLE';
    return { ...record, status: 'fallback_only', ...fallback(reasonCode) };
  } catch {
    return { ...record, status: 'failed', outcome: 'rejected_gate', reasonCode: failureReason };
  }
}
