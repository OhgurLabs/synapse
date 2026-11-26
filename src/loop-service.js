/**
 * Loop & Sub-Project Service Layer (Phase 2B — Stage 4).
 *
 * Single authoritative service shared by BOTH HTTP REST (`/api/loops/*`,
 * `/api/projects/:id/subprojects`) and inbound MCP (`loop.*`, `subproject.*`).
 * Enforces:
 * - Server/token-derived principal identity (never trusted from request payloads)
 * - Scoped project isolation on loops, historical versions, schedules, and per-run history
 * - Immutable Loop scope across versions (409 SCOPE_IMMUTABLE)
 * - Sub-project execution roster chain-down + parent visibility chain-up
 * - Subdir Git write subtree confinement (shared with scheduled admission via LoopEngine)
 * - Exact byte-digest & run/version verification on Evidence Packet responses
 * - Preset schedule compilation (`hourly | daily-at | weekly-at | weekdays-at` + raw cron)
 *   and server-computed next 3 fire slots from the armed pinned version
 */

import { join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';
import { LoopError, assertSubdirGitConfinement, normalizeSafeRelativePath } from './loops.js';
import { canonicalJson, GIT_SHA_RE, LOOP_ID_RE, SHA256_RE, sha256Buffer, sha256Hex } from './loop-store.js';
import {
  approveLoopRun, buildEvidenceArchive, captureArtifactPacketSnapshot, captureEvidencePacketSnapshot,
  verifyEvidencePacketSnapshot, computeAnchorSetSha256, resolveEvidencePrivatePaths, formatEvidenceVerifyCommand,
} from './loop-evidence.js';
import { cadenceToCron, parseCron, isValidTimezone, nextLoopFires, instanceTimezone } from './scheduler.js';
import {
  collectRosterAgentIds,
  resolveDescendantVisibility,
} from './roster.js';

const log = createLogger('loop-service');

function isOperatorIdentity(identity) {
  const role = String(identity?.role || '').toLowerCase();
  return role === 'operator' || role === 'admin';
}

function assertOperator(identity, action = 'loop_action') {
  if (!isOperatorIdentity(identity)) {
    throw new LoopError('FORBIDDEN', `Forbidden: operator role required for ${action}`, { statusCode: 403 });
  }
}

function normalizeIdentity(raw) {
  return {
    principalId: String(raw?.principalId || raw?.userId || raw?.name || 'operator'),
    role: String(raw?.role || 'viewer'),
    scopedProjectId: raw?.scopedProjectId || null,
  };
}

function computeNextSlotsForManifest(manifest, nowDate = new Date(), count = 3) {
  if (!manifest?.schedule?.cadence) return { cron: null, timezone: null, nextFires: [] };
  const tz = manifest.schedule.timezone || instanceTimezone();
  const cron = cadenceToCron(manifest.schedule.cadence);
  parseCron(cron); // validate syntax
  if (!isValidTimezone(tz)) {
    throw new LoopError('INVALID_TIMEZONE', `Invalid IANA timezone "${tz}"`, { statusCode: 400 });
  }
  const fires = nextLoopFires(manifest.schedule.cadence, nowDate, tz, count);
  return {
    cron,
    timezone: tz,
    nextFires: fires.map(d => (d instanceof Date ? d.toISOString() : String(d))),
  };
}

const STRICT_ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function validateIsoTimestamp(raw, label = 'effectiveFrom') {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !STRICT_ISO_DATETIME_RE.test(raw.trim())) {
    throw new LoopError('INVALID_TIMESTAMP', `${label} must be an ISO-8601 datetime string (YYYY-MM-DDTHH:MM[:SS[.sss]]Z|±HH:MM)`, { statusCode: 400 });
  }
  const d = new Date(raw.trim());
  if (!Number.isFinite(d.getTime())) {
    throw new LoopError('INVALID_TIMESTAMP', `${label} is not a valid ISO timestamp: "${raw}"`, { statusCode: 400 });
  }
  return d.toISOString();
}

function attachApprovalSummary(run) {
  if (!run || run.phase !== 'awaiting_approval') return run;
  return {
    ...run,
    approvalSummary: {
      approvedSourceSha: run.provenance?.source?.postIntegrationHeadSha || null,
      reviewSha256: run._checkerReview?.report?.sha256 || null,
      anchorSetSha256: computeAnchorSetSha256(run.anchors || []),
    },
  };
}

/** Project the durable attempt history, including older records with optional fields. */
export function projectAttemptLineage(run, manifest = null) {
  const declared = new Map((manifest?.nodes || []).map(node => [node.nodeId, node.kind]));
  const nodeIds = new Set([...declared.keys(), ...Object.keys(run.nodeAttempts || {}), ...Object.keys(run.selectedAttempts || {})]);
  const nodes = [...nodeIds].map(nodeId => ({
    nodeId,
    selectedAttemptId: run.selectedAttempts?.[nodeId] ?? null,
    attempts: (run.nodeAttempts?.[nodeId] || []).map(attempt => ({
      attemptId: attempt.attemptId,
      agentId: attempt.assignment?.agentId ?? attempt.agentId ?? null,
      agentInstanceId: attempt.assignment?.agentInstanceId ?? attempt.agentInstanceId ?? null,
      provider: attempt.assignment?.provider ?? attempt.provider ?? null,
      harness: attempt.assignment?.harness ?? attempt.harness ?? null,
      worktree: attempt._worktreePath ?? attempt.worktreePath ?? attempt.worktree ?? null,
      status: attempt.evictionReason ? 'evicted' : attempt.terminalStatus ?? attempt.status ?? 'running',
      fenceToken: attempt.fenceToken ?? null,
      evictionReason: attempt.evictionReason ?? null,
      checkerVerdict: attempt.checkerVerdict ?? null,
    })),
  }));
  const review = run._checkerReview;
  const checkerNode = nodes.find(node => node.nodeId === (review?.nodeId ?? run._checkerNodeId)) ??
    nodes.find(node => ['check', 'verify'].includes(declared.get(node.nodeId)));
  const checkerId = review?.attemptId ?? checkerNode?.selectedAttemptId;
  const checker = checkerNode?.attempts.find(attempt => attempt.attemptId === checkerId) ??
    (!checkerId ? checkerNode?.attempts.at(-1) : null);
  return {
    nodes,
    checker: review || checker ? {
      nodeId: review?.nodeId ?? checkerNode?.nodeId ?? null,
      attemptId: review?.attemptId ?? checker?.attemptId ?? null,
      agentId: review?.agentId ?? checker?.agentId ?? null,
      agentInstanceId: review?.agentInstanceId ?? checker?.agentInstanceId ?? null,
      provider: review?.provider ?? checker?.provider ?? null,
      verdict: review?.disposition ?? checker?.checkerVerdict ?? null,
      sha256: review?.report?.sha256 ?? null,
    } : null,
  };
}

const comparisonConflict = (code, message) => new LoopError(code, message, { statusCode: 409 });

function comparisonSummary(run, manifest) {
  const incomplete = () => comparisonConflict('RUN_OUTPUTS_NOT_FINALIZED', 'Run outputs are incomplete or invalid');
  if (!run.nodeAttempts || !run.selectedAttempts || !Array.isArray(run.anchors)) throw incomplete();
  const nodes = new Map((manifest.nodes || []).map(node => [node.nodeId, node]));
  const outputs = new Map();
  const selectedWorkers = [];
  let lastAttemptEnd = -Infinity;
  for (const [nodeId, attempts] of Object.entries(run.nodeAttempts)) {
    if (!nodes.has(nodeId) || !Array.isArray(attempts) || !attempts.length) throw incomplete();
    for (const attempt of attempts) {
      const end = Date.parse(attempt?.endedAt);
      if (!['succeeded', 'failed'].includes(attempt?.terminalStatus) ||
          !Number.isFinite(end) || !Array.isArray(attempt.outputs)) throw incomplete();
      lastAttemptEnd = Math.max(lastAttemptEnd, end);
    }
  }
  if (!Number.isFinite(lastAttemptEnd)) throw incomplete();
  const selections = Object.entries(run.selectedAttempts).sort(([a], [b]) => a.localeCompare(b));
  if ((run.phase === 'awaiting_approval' || ['passed', 'completed_unverified'].includes(run.verdict)) &&
      [...nodes.keys()].some(nodeId => !Object.hasOwn(run.selectedAttempts, nodeId))) throw incomplete();
  for (const [nodeId, attemptId] of selections) {
    const matches = run.nodeAttempts[nodeId]?.filter(attempt => attempt.attemptId === attemptId);
    if (matches?.length !== 1 || matches[0].terminalStatus !== 'succeeded') throw incomplete();
    const [attempt] = matches;
    const node = nodes.get(nodeId);
    if (node.kind === 'agent') {
      selectedWorkers.push({
        nodeId, selectedAttemptId: attemptId,
        agentId: attempt.assignment?.agentId ?? attempt.agentId ?? null,
        harness: attempt.assignment?.harness ?? attempt.harness ?? null,
      });
    }
    const paths = new Set();
    for (const output of attempt.outputs) {
      let path;
      try { path = normalizeSafeRelativePath(output?.path); } catch { throw incomplete(); }
      if (typeof output.sha256 !== 'string' || !SHA256_RE.test(output.sha256) || paths.has(path)) throw incomplete();
      paths.add(path);
      if (output.deleted !== true) outputs.set(JSON.stringify([nodeId, path]), { nodeId, path, sha256: output.sha256 });
    }
    if ((node.outputs || []).some(output => !paths.has(normalizeSafeRelativePath(output.path)))) throw incomplete();
  }

  const anchorOutcomes = [];
  const specs = new Map((manifest.anchors || []).map(spec => [spec.anchorId, spec]));
  for (const [nodeId, node] of nodes) {
    if (node.kind !== 'anchor') continue;
    const attemptId = run.selectedAttempts[nodeId] ?? run.nodeAttempts[nodeId]?.at(-1)?.attemptId;
    const anchor = run.anchors.find(a => a.nodeId === nodeId && a.attemptId === attemptId);
    const definition = specs.get(node.anchorId);
    if (!definition || (anchor && (anchor.anchorId !== node.anchorId ||
        anchor.runnerDigest !== definition.implementationDigest ||
        !['passed', 'failed', 'indeterminate'].includes(anchor.outcome)))) {
      throw incomplete();
    }
    if (run.selectedAttempts[nodeId] && !anchor) throw incomplete();
    anchorOutcomes.push({ anchorId: node.anchorId, nodeId, outcome: anchor?.outcome ?? null });
  }
  // Older PR runs only recorded the end of approval on the run itself.
  const started = Date.parse(run.provenance.startedAt);
  const executionEnd = run.provenance.executionEndedAt ??
    (manifest.evidence?.mode !== 'pr' && run.phase === 'terminal' ? run.provenance.endedAt : null);
  const ended = executionEnd == null ? lastAttemptEnd : Date.parse(executionEnd);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < lastAttemptEnd || ended < started) throw incomplete();
  const worker = selectedWorkers[0];
  return { outputs, summary: {
    runId: run.runId, phase: run.phase, verdict: run.verdict ?? null,
    selectedAttemptId: worker?.selectedAttemptId ?? null, agentId: worker?.agentId ?? null, harness: worker?.harness ?? null,
    selectedWorkers, wallClockMs: ended - started, checker: projectAttemptLineage(run, manifest).checker, anchorOutcomes,
  } };
}

/** Compare finalized records and their pinned manifests without reading artifacts or executing a run. */
export function compareCompletedRuns({ runA, runB, manifestA, manifestB, scopedProjectId = null }) {
  if (!runA || !runB) throw new LoopError('RUN_NOT_FOUND', 'Both Loop runs must exist', { statusCode: 400 });
  const projectA = runA.provenance?.scope?.projectId ?? null;
  const projectB = runB.provenance?.scope?.projectId ?? null;
  if (scopedProjectId && (projectA !== scopedProjectId || projectB !== scopedProjectId)) {
    throw new LoopError('FORBIDDEN', 'Run scope does not match the authorized project', { statusCode: 403 });
  }
  if (!runA.runId || !runB.runId || runA.runId === runB.runId) {
    throw new LoopError('DISTINCT_RUNS_REQUIRED', 'Select two distinct Loop runs', { statusCode: 400 });
  }
  if (projectA !== projectB) throw comparisonConflict('PROJECT_SCOPE_MISMATCH', 'Run project scopes differ');
  for (const run of [runA, runB]) {
    if (!['terminal', 'awaiting_approval'].includes(run.phase) ||
        (run.phase === 'terminal' && (typeof run.verdict !== 'string' || !run.verdict))) {
      throw comparisonConflict('RUN_NOT_COMPLETED', 'Both runs must be terminal or awaiting approval');
    }
  }

  const pinA = runA.pin ?? {};
  const pinB = runB.pin ?? {};
  const baseSha = runA.provenance?.source?.baseSha;
  for (const [a, b, valid, code, label] of [
    [pinA.loopId, pinB.loopId, value => typeof value === 'string' && LOOP_ID_RE.test(value), 'LOOP_ID_MISMATCH', 'Loop IDs'],
    [pinA.loopVersion, pinB.loopVersion, value => Number.isSafeInteger(value) && value > 0, 'LOOP_VERSION_MISMATCH', 'Loop versions'],
    [pinA.manifestHash, pinB.manifestHash, value => typeof value === 'string' && SHA256_RE.test(value), 'MANIFEST_HASH_MISMATCH', 'Manifest digests'],
    [baseSha, runB.provenance?.source?.baseSha, value => typeof value === 'string' && GIT_SHA_RE.test(value), 'BASE_SHA_MISMATCH', 'Base SHAs'],
  ]) {
    if (!valid(a) || a !== b) throw comparisonConflict(code, `${label} are missing or differ`);
  }
  const digestInputs = params => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw comparisonConflict('INPUTS_MISMATCH', 'Normalized inputs are missing');
    }
    try { return sha256Hex(canonicalJson(params)); }
    catch { throw comparisonConflict('INPUTS_MISMATCH', 'Normalized inputs are invalid'); }
  };
  const inputsDigest = digestInputs(pinA.params);
  if (inputsDigest !== digestInputs(pinB.params)) throw comparisonConflict('INPUTS_MISMATCH', 'Normalized inputs differ');

  if (!manifestA || !manifestB) throw comparisonConflict('PINNED_MANIFEST_UNAVAILABLE', 'A pinned manifest is unavailable');
  const anchorDefinitions = manifestA.anchors ?? [];
  if (!Array.isArray(anchorDefinitions) || canonicalJson(anchorDefinitions) !== canonicalJson(manifestB.anchors ?? [])) {
    throw comparisonConflict('ANCHOR_DEFINITIONS_MISMATCH', 'Pinned Anchor definitions differ');
  }
  if ([manifestA, manifestB].some(manifest => sha256Hex(canonicalJson(manifest)) !== pinA.manifestHash)) {
    throw comparisonConflict('PINNED_MANIFEST_INVALID', 'Pinned manifest digest failed verification');
  }

  const a = comparisonSummary(runA, manifestA);
  const b = comparisonSummary(runB, manifestB);
  const outputDiffs = { added: [], removed: [], changed: [] };
  for (const key of [...new Set([...a.outputs.keys(), ...b.outputs.keys()])].sort()) {
    const before = a.outputs.get(key);
    const after = b.outputs.get(key);
    if (!before) outputDiffs.added.push(after);
    else if (!after) outputDiffs.removed.push(before);
    else if (before.sha256 !== after.sha256) {
      outputDiffs.changed.push({ nodeId: before.nodeId, path: before.path, sha256A: before.sha256, sha256B: after.sha256 });
    }
  }
  return {
    sharedContext: {
      projectId: projectA, loopId: pinA.loopId, loopVersion: pinA.loopVersion, manifestHash: pinA.manifestHash,
      baseSha, inputsDigest, anchorDefinitions: structuredClone(anchorDefinitions),
    },
    runA: a.summary, runB: b.summary,
    anchorDeltas: a.summary.anchorOutcomes.flatMap(({ anchorId, nodeId, outcome }, index) => {
      const other = b.summary.anchorOutcomes[index].outcome;
      return outcome === other ? [] : [{ anchorId, nodeId, outcomeA: outcome, outcomeB: other }];
    }),
    wallClockDeltaMs: b.summary.wallClockMs - a.summary.wallClockMs,
    outputDiffs,
  };
}

export function createLoopService({
  loopStore,
  loopEngine,
  stateManager = null,
  prStore = null,
  agentsMap = {},
  projectDir = null,
} = {}) {
  if (!loopStore) throw new Error('createLoopService requires loopStore');
  if (!loopEngine) throw new Error('createLoopService requires loopEngine');

  const getProj = (id) => (id && stateManager ? stateManager.getProject(id) : null);

  function getAuthorizedProjectIds(identity) {
    if (!stateManager) return null;
    if (identity.scopedProjectId) {
      return new Set([identity.scopedProjectId]);
    }
    return null;
  }

  function isProjectScopeAuthorized(identity, projId) {
    if (!identity.scopedProjectId) return true;
    return Boolean(projId) && projId === identity.scopedProjectId;
  }

  function isRunAuthorized(identity, run) {
    const runScopeProjId = run?.provenance?.scope?.projectId || null;
    return isProjectScopeAuthorized(identity, runScopeProjId);
  }

  function assertProjectAccess(identity, projectId, { allowNull = true } = {}) {
    if (!projectId) {
      if (!allowNull) {
        throw new LoopError('PROJECT_REQUIRED', 'projectId is required', { statusCode: 400 });
      }
      if (identity.scopedProjectId) {
        throw new LoopError('FORBIDDEN', `Scoped token for "${identity.scopedProjectId}" cannot access global scope`, { statusCode: 403 });
      }
      return null;
    }
    if (identity.scopedProjectId && identity.scopedProjectId !== projectId) {
      throw new LoopError('FORBIDDEN', `Token scoped to "${identity.scopedProjectId}" cannot access project "${projectId}"`, { statusCode: 403 });
    }
    const proj = getProj(projectId);
    if (stateManager && !proj) {
      throw new LoopError('PROJECT_NOT_FOUND', `Project "${projectId}" not found`, { statusCode: 404 });
    }
    return proj ? { id: projectId, ...proj } : null;
  }

  function isDescendantOf(candidateId, ancestorId) {
    if (!candidateId || !ancestorId || !stateManager) return false;
    if (candidateId === ancestorId) return true;
    try {
      const ancestors = stateManager.getProjectAncestors(candidateId);
      return ancestors.some(a => a.id === ancestorId);
    } catch {
      return false;
    }
  }

  function resolveGitRepoDirForProject(projectId) {
    if (!projectId || !stateManager) return projectDir;
    if (typeof stateManager.resolveGitRepoRoot === 'function') {
      return stateManager.resolveGitRepoRoot(projectId) || projectDir;
    }
    const proj = stateManager.getProject(projectId);
    return proj?.projectDir || projectDir;
  }

  function enrichLoopPointer(ptr, identity, nowDate = new Date()) {
    const latest = loopStore.getLoopVersion(ptr.loopId, ptr.currentVersion);
    const schedule = loopStore.getLoopSchedule(ptr.loopId);
    // P1 #1: Filter runs by EACH run's persisted execution scope BEFORE building summary/lastRun/runCount!
    const visibleRuns = loopStore.listRuns(ptr.loopId).filter(r => isRunAuthorized(identity, r));
    const lastRun = visibleRuns.length > 0 ? visibleRuns[0] : null;

    // P1 #3 & P2 #2: Compute preview from the ARMED PINNED VERSION ONLY if caller is authorized for that version's scope!
    const pinnedSchedManifest = schedule
      ? (loopStore.getLoopVersion(ptr.loopId, schedule.loopVersion)?.manifest || null)
      : null;
    const pinnedSchedAuthorized = !schedule || (
      pinnedSchedManifest !== null
      && isProjectScopeAuthorized(identity, pinnedSchedManifest.scope?.projectId || null)
    );
    const scheduleManifest = schedule
      ? (pinnedSchedAuthorized ? pinnedSchedManifest : null)
      : latest?.manifest || null;

    let schedulePreview = { cron: null, timezone: null, nextFires: [] };
    if (scheduleManifest?.schedule?.cadence) {
      try {
        schedulePreview = computeNextSlotsForManifest(scheduleManifest, nowDate, 3);
      } catch {}
    }

    const scopeProjectId = ptr.projectId || latest?.manifest?.scope?.projectId || null;
    const boundProj = scopeProjectId ? getProj(scopeProjectId) : null;
    return {
      loopId: ptr.loopId,
      projectId: scopeProjectId,
      parentProjectId: boundProj?.parentProjectId || null,
      scopeLabel: scopeProjectId ? (boundProj?.displayName || scopeProjectId) : 'Global',
      currentVersion: ptr.currentVersion,
      updatedAt: ptr.updatedAt,
      title: latest?.manifest?.title || ptr.loopId,
      description: latest?.manifest?.description || '',
      manifestHash: latest?.manifestHash || null,
      evidenceMode: latest?.manifest?.evidence?.mode || 'artifact',
      nodeCount: latest?.manifest?.nodes?.length || 0,
      anchorCount: latest?.manifest?.anchors?.length || 0,
      schedule: (schedule && pinnedSchedAuthorized) ? {
        ...schedule,
        cron: schedulePreview.cron,
        timezone: schedulePreview.timezone,
        nextFireUtc: schedule.enabled ? (schedulePreview.nextFires[0] || null) : null,
        nextFires: schedule.enabled ? schedulePreview.nextFires : [],
      } : (!schedule && latest?.manifest?.schedule ? {
        scheduleId: `lsched_${ptr.loopId}`,
        loopId: ptr.loopId,
        loopVersion: ptr.currentVersion,
        enabled: false,
        cron: schedulePreview.cron,
        timezone: schedulePreview.timezone,
        nextFireUtc: null,
        nextFires: schedulePreview.nextFires,
      } : null),
      lastRun: lastRun ? {
        runId: lastRun.runId,
        loopVersion: lastRun.pin?.loopVersion ?? null,
        phase: lastRun.phase,
        verdict: lastRun.verdict,
        reasonCode: lastRun.reasonCode,
        createdAt: lastRun.provenance?.createdAt || null,
        endedAt: lastRun.provenance?.endedAt || null,
        evidencePacketSha256: lastRun._evidence?.evidencePacketSha256 || null,
      } : null,
      runCount: visibleRuns.length,
    };
  }

  // ─── Loops CRUD / Versioning ──────────────────────────────────────

  function listLoops(rawIdentity, { projectId = undefined, scope = undefined, nowDate = new Date() } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    let filterProjectId = projectId;
    if (scope === 'global') filterProjectId = null;

    if (identity.scopedProjectId) {
      if (filterProjectId !== undefined && filterProjectId !== identity.scopedProjectId) {
        throw new LoopError('FORBIDDEN', `Token scoped to "${identity.scopedProjectId}" cannot query loops for "${filterProjectId ?? 'global'}"`, { statusCode: 403 });
      }
      filterProjectId = identity.scopedProjectId;
    } else if (filterProjectId) {
      assertProjectAccess(identity, filterProjectId, { allowNull: false });
    }

    const pointers = loopStore.listLoops({ projectId: filterProjectId });
    return pointers.map(p => enrichLoopPointer(p, identity, nowDate));
  }

  function getLoop(rawIdentity, loopId, { nowDate = new Date() } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    const latest = loopStore.getLoopVersion(loopId, null);
    if (!latest) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${loopId}" not found`, { statusCode: 404 });
    }
    const scopeProjectId = latest.manifest?.scope?.projectId || null;
    assertProjectAccess(identity, scopeProjectId, { allowNull: true });

    const pointers = loopStore.listLoops({ projectId: undefined });
    const ptr = pointers.find(p => p.loopId === loopId) || {
      loopId,
      projectId: scopeProjectId,
      currentVersion: latest.loopVersion,
      updatedAt: latest.createdAt,
    };
    const summary = enrichLoopPointer(ptr, identity, nowDate);
    // P1 #3: Filter historical versions by each version's own scope!
    const versions = loopStore.listLoopVersions(loopId)
      .filter(v => isProjectScopeAuthorized(identity, v.manifest?.scope?.projectId || null))
      .map(v => ({
        loopVersion: v.loopVersion,
        manifestHash: v.manifestHash,
        createdAt: v.createdAt,
        hasSchedule: Boolean(v.manifest?.schedule),
        nodeCount: v.manifest?.nodes?.length || 0,
        anchorCount: v.manifest?.anchors?.length || 0,
      }));
    // P1 #1: Filter runs by each run's persisted scope BEFORE slicing!
    const runs = loopStore.listRuns(loopId)
      .filter(r => isRunAuthorized(identity, r))
      .slice(0, 25)
      .map(attachApprovalSummary);
    return {
      ...summary,
      manifest: latest.manifest,
      versions,
      runs,
    };
  }

  function listLoopVersions(rawIdentity, loopId) {
    const identity = normalizeIdentity(rawIdentity);
    const latest = loopStore.getLoopVersion(loopId, null);
    if (!latest) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${loopId}" not found`, { statusCode: 404 });
    }
    assertProjectAccess(identity, latest.manifest?.scope?.projectId || null, { allowNull: true });
    // P1 #3: Only return historical versions authorized for this caller!
    return loopStore.listLoopVersions(loopId).filter(v =>
      isProjectScopeAuthorized(identity, v.manifest?.scope?.projectId || null)
    );
  }

  function getLoopVersion(rawIdentity, loopId, version) {
    const identity = normalizeIdentity(rawIdentity);
    const verNum = Number(version);
    if (!Number.isInteger(verNum) || verNum < 1) {
      throw new LoopError('INVALID_VERSION', `Invalid loop version "${version}"`, { statusCode: 400 });
    }
    const rec = loopStore.getLoopVersion(loopId, verNum);
    if (!rec) {
      throw new LoopError('VERSION_NOT_FOUND', `Loop "${loopId}" version ${verNum} not found`, { statusCode: 404 });
    }
    assertProjectAccess(identity, rec.manifest?.scope?.projectId || null, { allowNull: true });
    return rec;
  }

  function publishLoopVersion(rawIdentity, { loopId = null, baseVersion = 0, manifest, projectId = undefined } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'loop_publish');
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new LoopError('INVALID_MANIFEST', 'manifest object is required', { statusCode: 400 });
    }
    const nextManifest = JSON.parse(JSON.stringify(manifest));
    if (loopId && !nextManifest.loopId) nextManifest.loopId = loopId;
    if (loopId && nextManifest.loopId !== loopId) {
      throw new LoopError('LOOP_ID_MISMATCH', `Manifest loopId "${nextManifest.loopId}" does not match route "${loopId}"`, { statusCode: 400 });
    }
    if (projectId !== undefined) {
      nextManifest.scope = projectId ? { projectId } : null;
    }

    const scopeProjectId = nextManifest.scope?.projectId || null;
    const boundProj = assertProjectAccess(identity, scopeProjectId, { allowNull: true });
    if (boundProj) {
      const dynSubtree = (boundProj.workspaceMode === 'subdir' && stateManager && typeof stateManager.resolveEffectiveGitWriteSubtree === 'function')
        ? stateManager.resolveEffectiveGitWriteSubtree(scopeProjectId)
        : (boundProj.gitWriteSubtree || null);
      assertSubdirGitConfinement(nextManifest, { ...boundProj, gitWriteSubtree: dynSubtree });
    }

    // Validate schedule cadence & timezone upfront if present
    if (nextManifest.schedule) {
      computeNextSlotsForManifest(nextManifest, new Date(), 1);
    }

    // P1 #3: Enforce IMMUTABLE loop projectId scope across versions!
    const existing = loopStore.getLoopVersion(nextManifest.loopId, null);
    if (existing) {
      const existingScopeProjId = existing.manifest?.scope?.projectId || null;
      assertProjectAccess(identity, existingScopeProjId, { allowNull: true });
      if (existingScopeProjId !== scopeProjectId) {
        throw new LoopError(
          'SCOPE_IMMUTABLE',
          `Loop "${nextManifest.loopId}" scope is immutable ("${existingScopeProjId ?? 'global'}" cannot change to "${scopeProjectId ?? 'global'}")`,
          { statusCode: 409 }
        );
      }
    }

    const baseVerNum = Number(baseVersion ?? 0);
    if (!Number.isInteger(baseVerNum) || baseVerNum < 0) {
      throw new LoopError('INVALID_BASE_VERSION', `Invalid baseVersion "${baseVersion}"`, { statusCode: 400 });
    }

    try {
      const published = loopEngine.publish(nextManifest, { baseVersion: baseVerNum });
      const preview = computeNextSlotsForManifest(published.manifest, new Date(), 3);
      return {
        ...published,
        schedulePreview: preview,
      };
    } catch (err) {
      if (err instanceof LoopError) throw err;
      if (Number.isInteger(err?.statusCode)) {
        throw new LoopError(err.code || 'LOOP_ERROR', err.message, { statusCode: err.statusCode });
      }
      if (/Stale baseVersion|Version conflict/i.test(err?.message || '')) {
        throw new LoopError('STALE_BASE_VERSION', err.message, { statusCode: 409 });
      }
      throw new LoopError('INVALID_MANIFEST', err.message, { statusCode: 400 });
    }
  }

  // ─── Schedules ────────────────────────────────────────────────────

  function getLoopSchedules(rawIdentity, loopId, { nowDate = new Date() } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    const latest = loopStore.getLoopVersion(loopId, null);
    if (!latest) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${loopId}" not found`, { statusCode: 404 });
    }
    const armed = loopStore.getLoopSchedule(loopId);
    const activeVersion = armed ? loopStore.getLoopVersion(loopId, armed.loopVersion) : latest;
    // P1 #3: Authorize BOTH the latest manifest AND the actual pinned armed version!
    assertProjectAccess(identity, latest.manifest?.scope?.projectId || null, { allowNull: true });
    if (activeVersion && activeVersion !== latest) {
      assertProjectAccess(identity, activeVersion.manifest?.scope?.projectId || null, { allowNull: true });
    }

    const preview = activeVersion?.manifest?.schedule
      ? computeNextSlotsForManifest(activeVersion.manifest, nowDate, 3)
      : { cron: null, timezone: null, nextFires: [] };

    const scheduleId = armed?.scheduleId || `lsched_${loopId}`;
    const occurrences = loopStore.listScheduleOccurrences(scheduleId).slice(-20);
    const skippedRanges = loopStore.listSkippedRanges(scheduleId).slice(-10);

    return {
      loopId,
      schedule: armed ? {
        ...armed,
        cron: preview.cron,
        timezone: preview.timezone,
        nextFires: armed.enabled ? preview.nextFires : [],
        cadence: activeVersion?.manifest?.schedule?.cadence || null,
        overlap: activeVersion?.manifest?.schedule?.overlap || 'skip',
        missedRun: activeVersion?.manifest?.schedule?.missedRun || 'skip',
      } : null,
      preview,
      occurrences,
      skippedRanges,
    };
  }

  function setLoopSchedule(rawIdentity, {
    loopId,
    enabled = true,
    loopVersion = null,
    effectiveFrom = null,
    schedule = null,
    cadence = null,
    timezone = null,
    overlap = null,
    missedRun = null,
    params = null,
    nowDate = new Date(),
  } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'loop_schedule');

    // P2 #1: Validate arming inputs BEFORE publishing any new version!
    const validNowDate = nowDate instanceof Date && Number.isFinite(nowDate.getTime()) ? nowDate : new Date();
    const validatedEffFrom = effectiveFrom !== null && effectiveFrom !== undefined
      ? validateIsoTimestamp(effectiveFrom, 'effectiveFrom')
      : validNowDate.toISOString();

    const latest = loopStore.getLoopVersion(loopId, null);
    if (!latest) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${loopId}" not found`, { statusCode: 404 });
    }
    assertProjectAccess(identity, latest.manifest?.scope?.projectId || null, { allowNull: true });

    // P1 #3: Also authorize any currently-armed pinned version before altering schedule state
    const currentArmed = loopStore.getLoopSchedule(loopId);
    if (currentArmed) {
      const armedRec = loopStore.getLoopVersion(loopId, currentArmed.loopVersion);
      if (armedRec) {
        assertProjectAccess(identity, armedRec.manifest?.scope?.projectId || null, { allowNull: true });
      }
    }

    if (enabled === false) {
      const targetDisarmVer = loopVersion ?? currentArmed?.loopVersion ?? latest.loopVersion;
      const targetRec = loopStore.getLoopVersion(loopId, targetDisarmVer);
      if (!targetRec) {
        throw new LoopError('VERSION_NOT_FOUND', `Loop "${loopId}" version ${targetDisarmVer} not found`, { statusCode: 404 });
      }
      assertProjectAccess(identity, targetRec.manifest?.scope?.projectId || null, { allowNull: true });
      const disarmed = loopStore.setLoopScheduleArming(loopId, {
        enabled: false,
        loopVersion: targetDisarmVer,
        effectiveFrom: validatedEffFrom,
      });
      return {
        ...disarmed,
        cron: null,
        timezone: null,
        nextFires: [],
      };
    }

    let targetVersion = loopVersion ?? latest.loopVersion;
    let targetRec = loopStore.getLoopVersion(loopId, targetVersion);
    let targetManifest = targetRec?.manifest || null;

    const scheduleInput = schedule || (cadence ? { cadence, timezone, overlap, missedRun, params } : null);
    if (scheduleInput) {
      const nextSchedule = {
        cadence: scheduleInput.cadence,
        timezone: scheduleInput.timezone || instanceTimezone(),
        overlap: scheduleInput.overlap || 'skip',
        missedRun: scheduleInput.missedRun || 'skip',
        ...(scheduleInput.params && typeof scheduleInput.params === 'object' ? { params: scheduleInput.params } : {}),
      };
      // Validate cadence, cron, timezone, overlap, missedRun BEFORE publishing!
      const compiledCron = cadenceToCron(nextSchedule.cadence);
      parseCron(compiledCron);
      if (!isValidTimezone(nextSchedule.timezone)) {
        throw new LoopError('INVALID_TIMEZONE', `Invalid IANA timezone "${nextSchedule.timezone}"`, { statusCode: 400 });
      }
      if (!['skip', 'queue', 'cancel-prior'].includes(nextSchedule.overlap)) {
        throw new LoopError('INVALID_SCHEDULE', `Invalid overlap policy "${nextSchedule.overlap}"`, { statusCode: 400 });
      }
      if (!['skip', 'run-once-if-missed'].includes(nextSchedule.missedRun)) {
        throw new LoopError('INVALID_SCHEDULE', `Invalid missedRun policy "${nextSchedule.missedRun}"`, { statusCode: 400 });
      }
      const nextManifest = JSON.parse(JSON.stringify(latest.manifest));
      nextManifest.schedule = nextSchedule;
      const published = publishLoopVersion(identity, {
        loopId,
        baseVersion: latest.loopVersion,
        manifest: nextManifest,
      });
      targetVersion = published.loopVersion;
      targetManifest = published.manifest;
    } else {
      if (!targetRec) {
        throw new LoopError('VERSION_NOT_FOUND', `Loop "${loopId}" version ${targetVersion} not found`, { statusCode: 404 });
      }
      // P1 #3: Authorize the actual target version being armed!
      assertProjectAccess(identity, targetManifest?.scope?.projectId || null, { allowNull: true });
    }

    if (!targetManifest) {
      throw new LoopError('VERSION_NOT_FOUND', `Loop "${loopId}" version ${targetVersion} not found`, { statusCode: 404 });
    }
    if (!targetManifest.schedule?.cadence) {
      throw new LoopError('SCHEDULE_MISSING', `Loop "${loopId}" v${targetVersion} has no schedule defined; publish a version with schedule or pass cadence`, { statusCode: 400 });
    }

    const preview = computeNextSlotsForManifest(targetManifest, validNowDate, 3);
    const armed = loopStore.setLoopScheduleArming(loopId, {
      enabled: true,
      loopVersion: targetVersion,
      effectiveFrom: validatedEffFrom,
    });
    return {
      ...armed,
      cron: preview.cron,
      timezone: preview.timezone,
      overlap: targetManifest.schedule.overlap || 'skip',
      missedRun: targetManifest.schedule.missedRun || 'skip',
      nextFires: preview.nextFires,
    };
  }

  function deleteLoopSchedule(rawIdentity, scheduleId) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'loop_schedule_delete');

    let existing = loopStore.getLoopScheduleByScheduleId(scheduleId);
    if (!existing && String(scheduleId).startsWith('lsched_')) {
      existing = loopStore.getLoopSchedule(String(scheduleId).slice('lsched_'.length));
    }
    if (!existing) {
      throw new LoopError('SCHEDULE_NOT_FOUND', `Loop schedule "${scheduleId}" not found`, { statusCode: 404 });
    }
    // P1 #3: Fail closed unless BOTH the current loop version AND the pinned schedule version exist, then authorize BOTH scopes!
    const latestRec = loopStore.getLoopVersion(existing.loopId, null);
    if (!latestRec?.manifest) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${existing.loopId}" manifest missing for schedule "${scheduleId}"`, { statusCode: 404 });
    }
    const pinnedRec = loopStore.getLoopVersion(existing.loopId, existing.loopVersion);
    if (!pinnedRec?.manifest) {
      throw new LoopError('VERSION_NOT_FOUND', `Pinned loop version ${existing.loopVersion} missing for schedule "${scheduleId}"`, { statusCode: 404 });
    }
    assertProjectAccess(identity, latestRec.manifest.scope?.projectId || null, { allowNull: true });
    assertProjectAccess(identity, pinnedRec.manifest.scope?.projectId || null, { allowNull: true });

    const disarmed = loopStore.setLoopScheduleArming(existing.loopId, {
      enabled: false,
      loopVersion: existing.loopVersion,
    });
    return { deleted: true, schedule: disarmed };
  }

  // ─── Runs / Approve / Cancel / Evidence ───────────────────────────

  function startAndExecuteRun(rawIdentity, {
    loopId,
    loopVersion = null,
    projectId = null,
    subProjectId = null,
    params = null,
    requestId = null,
    source = null,
    allowQueuedOverlap = false,
    awaitExecution = false,
  } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'loop_run');

    const published = loopStore.getLoopVersion(loopId, loopVersion);
    if (!published) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${loopId}" version ${loopVersion ?? 'latest'} not found`, { statusCode: 404 });
    }
    const manifestScopeProjId = published.manifest?.scope?.projectId || null;
    const requestedTargetId = subProjectId || projectId || manifestScopeProjId || null;

    // P1 #2: Authorize BOTH the pinned manifest's scope AND the execution target's scope!
    assertProjectAccess(identity, manifestScopeProjId, { allowNull: true });

    if (manifestScopeProjId && requestedTargetId && requestedTargetId !== manifestScopeProjId) {
      if (!isDescendantOf(requestedTargetId, manifestScopeProjId)) {
        throw new LoopError(
          'SCOPE_MISMATCH',
          `Loop "${loopId}" is bound to "${manifestScopeProjId}" and cannot run against unrelated project "${requestedTargetId}"`,
          { statusCode: 400 }
        );
      }
    }

    const boundProj = assertProjectAccess(identity, requestedTargetId, { allowNull: true });
    const dynRunSubtree = (boundProj && boundProj.workspaceMode === 'subdir' && stateManager && typeof stateManager.resolveEffectiveGitWriteSubtree === 'function')
      ? stateManager.resolveEffectiveGitWriteSubtree(requestedTargetId)
      : (boundProj?.gitWriteSubtree || null);
    if (boundProj) {
      assertSubdirGitConfinement(published.manifest, { ...boundProj, gitWriteSubtree: dynRunSubtree });
    }

    // Execution roster chains DOWN + ancestor param defaults chain DOWN
    // (also enforced uniformly inside loopEngine.startRun for scheduled triggers!)
    let ancestorDefaults;
    let projectDefaults;
    let rosterSnapshot;
    let resolvedRosterSource = null;
    if (requestedTargetId && stateManager) {
      const pChain = stateManager.getProjectParamChain(requestedTargetId);
      ancestorDefaults = pChain.ancestorDefaults;
      projectDefaults = pChain.projectDefaults;
      const effRoster = stateManager.getEffectiveProjectRoster(requestedTargetId);
      rosterSnapshot = effRoster.roster;
      resolvedRosterSource = effRoster.sourceProjectId;
    }

    const admitted = loopEngine.startRun({
      loopId,
      loopVersion: published.loopVersion,
      params: params || {},
      ...(ancestorDefaults !== undefined ? { ancestorDefaults } : {}),
      ...(projectDefaults !== undefined ? { projectDefaults } : {}),
      ...(rosterSnapshot !== undefined ? { rosterSnapshot } : {}),
      trigger: {
        kind: 'manual',
        principalId: identity.principalId,
        requestId: requestId || `req_${randomUUID().slice(0, 12)}`,
      },
      source: source || null,
      scope: requestedTargetId
        ? {
            projectId: requestedTargetId,
            ...(boundProj?.workspaceMode === 'subdir' && dynRunSubtree ? { gitWriteSubtree: dynRunSubtree } : {}),
          }
        : null,
      allowQueuedOverlap,
    });

    const runId = admitted.run.runId;
    const runProjectDir = resolveGitRepoDirForProject(requestedTargetId);
    let executionPromise = null;
    if (!admitted.deduplicated && admitted.run.phase === 'queued') {
      executionPromise = Promise.resolve()
        .then(() => loopEngine.executeRun(runId, { projectDir: runProjectDir }))
        .catch(err => {
          log.warn('Background loop execution failed', { loopId, runId, error: err.message });
          return loopStore.getRun(runId);
        });
    }

    const out = {
      runId,
      deduplicated: admitted.deduplicated,
      run: admitted.run,
      resolvedScope: requestedTargetId ? { projectId: requestedTargetId, displayName: boundProj?.displayName || requestedTargetId } : { projectId: null, displayName: 'Global' },
      resolvedVersion: published.loopVersion,
      resolvedRosterSource,
      executionPromise,
    };
    if (awaitExecution && executionPromise) {
      return executionPromise.then((finalRun) => ({ ...out, run: finalRun || loopStore.getRun(runId) }));
    }
    return out;
  }

  function listRuns(rawIdentity, loopId) {
    const identity = normalizeIdentity(rawIdentity);
    const latest = loopStore.getLoopVersion(loopId, null);
    if (!latest) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${loopId}" not found`, { statusCode: 404 });
    }
    assertProjectAccess(identity, latest.manifest?.scope?.projectId || null, { allowNull: true });
    // P1 #1: Filter runs strictly by each run's persisted execution scope!
    return loopStore.listRuns(loopId)
      .filter(r => isRunAuthorized(identity, r))
      .map(attachApprovalSummary);
  }

  function getRun(rawIdentity, runId, { expectedLoopId = null } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    const run = loopStore.getRun(runId);
    if (!run) {
      throw new LoopError('RUN_NOT_FOUND', `LoopRun "${runId}" not found`, { statusCode: 404 });
    }
    if (expectedLoopId && run.pin?.loopId !== expectedLoopId) {
      throw new LoopError('RUN_NOT_FOUND', `LoopRun "${runId}" does not belong to loop "${expectedLoopId}"`, { statusCode: 404 });
    }
    const scopeProjId = run.provenance?.scope?.projectId || null;
    assertProjectAccess(identity, scopeProjId, { allowNull: true });
    return attachApprovalSummary(run);
  }

  function compareRuns(rawIdentity, { runA, runB }) {
    const identity = normalizeIdentity(rawIdentity);
    const a = loopStore.getRun(runA);
    const b = loopStore.getRun(runB);
    for (const run of [a, b]) {
      if (run) assertProjectAccess(identity, run.provenance?.scope?.projectId ?? null);
    }
    const pinnedManifest = run => run?.pin?.loopVersion == null
      ? null : loopStore.getLoopVersion(run.pin.loopId, run.pin.loopVersion)?.manifest;
    return compareCompletedRuns({
      runA: a, runB: b, scopedProjectId: identity.scopedProjectId,
      manifestA: pinnedManifest(a), manifestB: pinnedManifest(b),
    });
  }

  function cancelRun(rawIdentity, runId, { expectedLoopId = null } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'loop_cancel');
    const run = getRun(identity, runId, { expectedLoopId });
    return loopEngine.cancelRun(run.runId);
  }

  async function approveRun(rawIdentity, {
    runId,
    expectedLoopId = null,
    approvedSourceSha,
    reviewSha256,
    anchorSetSha256,
    approvalEventId = null,
  } = {}) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'loop_approve');
    const run = getRun(identity, runId, { expectedLoopId });
    if (!approvedSourceSha || !reviewSha256 || !anchorSetSha256) {
      throw new LoopError('INVALID_APPROVAL_PAYLOAD', 'approvedSourceSha, reviewSha256, and anchorSetSha256 are required', { statusCode: 400 });
    }
    const scopeProjId = run.provenance?.scope?.projectId || null;
    const runProjectDir = resolveGitRepoDirForProject(scopeProjId);
    return approveLoopRun({
      loopStore,
      prStore,
      projectDir: runProjectDir,
      archivePrivatePaths: resolveEvidencePrivatePaths(stateManager, scopeProjId, runProjectDir),
      runId: run.runId,
      principalId: identity.principalId, // Strictly server/token derived!
      approvedSourceSha,
      reviewSha256,
      anchorSetSha256,
      approvalEventId,
    });
  }

  function captureRunEvidence(run) {
    const ev = run._evidence;
    if (run.phase !== 'terminal' || run.verdict !== 'passed') {
      throw new LoopError('EVIDENCE_NOT_READY', 'Evidence packet is not finalized for this run', { statusCode: 404 });
    }

    let snapshot;
    if (ev) {
      const packetsRoot = resolve(loopStore.packetsDir);
      snapshot = captureEvidencePacketSnapshot(ev.packetDir, { authorizeRoot: dir => dir.startsWith(packetsRoot + sep) });
      const packetBytes = snapshot.memberBuffers.get('evidence-packet.json');
      if (!packetBytes || sha256Buffer(packetBytes) !== ev.evidencePacketSha256 ||
          sha256Buffer(snapshot.sumsBytes) !== ev.checksumManifestSha256) {
        throw new LoopError('EVIDENCE_DIGEST_MISMATCH', 'Evidence packet digests differ from the durable run', { statusCode: 409 });
      }
    } else {
      const pinned = loopStore.getLoopVersion(run.pin.loopId, run.pin.loopVersion);
      if (!pinned || pinned.manifestHash !== run.pin.manifestHash || pinned.manifest.evidence?.mode === 'pr') {
        throw new LoopError('EVIDENCE_NOT_READY', 'Evidence packet is not finalized for this run', { statusCode: 404 });
      }
      snapshot = captureArtifactPacketSnapshot({ loopStore, run, manifest: pinned.manifest });
    }
    const packetBytes = snapshot.memberBuffers.get('evidence-packet.json');
    const evidencePacket = JSON.parse(packetBytes.toString('utf8'));
    if (evidencePacket.run?.runId !== run.runId || evidencePacket.run?.loopId !== run.pin.loopId ||
        evidencePacket.run?.loopVersion !== run.pin.loopVersion ||
        evidencePacket.run?.manifestHash !== run.pin.manifestHash) {
      throw new LoopError('EVIDENCE_IDENTITY_MISMATCH', 'Evidence packet identity differs from the durable run', { statusCode: 409 });
    }
    return { snapshot, evidencePacket };
  }

  function getRunEvidence(rawIdentity, runId, { expectedLoopId = null } = {}) {
    const run = getRun(rawIdentity, runId, { expectedLoopId });
    const { snapshot, evidencePacket } = captureRunEvidence(run);
    const projectId = run.provenance?.scope?.projectId;
    const archivePrivatePaths = resolveEvidencePrivatePaths(stateManager, projectId, resolveGitRepoDirForProject(projectId));
    const verified = verifyEvidencePacketSnapshot(snapshot, { archivePrivatePaths });
    if (!verified.ok) {
      throw new LoopError('EVIDENCE_VERIFICATION_FAILED', 'Evidence packet failed integrity verification', { statusCode: 409 });
    }
    return {
      runId: run.runId,
      loopId: run.pin.loopId,
      loopVersion: run.pin.loopVersion,
      verified: true,
      proofSummary: { ...verified.summary, verifyCommand: formatEvidenceVerifyCommand(run.runId, archivePrivatePaths) },
      evidencePacketSha256: verified.evidencePacketSha256,
      checksumManifestSha256: verified.checksumManifestSha256,
      approvalEventId: run._evidence?.approvalEventId || null,
      packetDir: run._evidence?.packetDir || null,
      evidencePacket,
      checksumManifest: snapshot.sumsBytes.toString('utf8'),
    };
  }

  function getRunEvidenceArchive(rawIdentity, runId) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'loop_evidence_download');
    const run = getRun(identity, runId);
    const { snapshot } = captureRunEvidence(run);
    const projectId = run.provenance?.scope?.projectId;
    const privatePaths = resolveEvidencePrivatePaths(stateManager, projectId, resolveGitRepoDirForProject(projectId));
    return buildEvidenceArchive(snapshot, { privatePaths });
  }

  // ─── Sub-Projects ─────────────────────────────────────────────────

  function listSubprojects(rawIdentity, parentProjectId) {
    const identity = normalizeIdentity(rawIdentity);
    if (!stateManager) {
      throw new LoopError('STATE_UNAVAILABLE', 'State manager unavailable', { statusCode: 503 });
    }
    const parentProj = assertProjectAccess(identity, parentProjectId, { allowNull: false });
    const authorizedProjectIds = getAuthorizedProjectIds(identity);

    const allLoops = loopStore.listLoops({});
    const loopCountsByProject = {};
    for (const lp of allLoops) {
      if (lp.projectId) {
        loopCountsByProject[lp.projectId] = (loopCountsByProject[lp.projectId] || 0) + 1;
      }
    }

    const visibility = resolveDescendantVisibility(parentProjectId, stateManager.listProjects(), agentsMap, {
      loopCountsByProject,
      authorizedProjectIds,
    });
    const directChildren = visibility.descendants.filter(d => d.parentProjectId === parentProjectId);
    const parentEffRoster = stateManager.getEffectiveProjectRoster(parentProjectId);
    return {
      parentProjectId,
      parentDisplayName: parentProj?.displayName || parentProjectId,
      parentEffectiveRoster: parentEffRoster,
      subprojects: directChildren,
      visibility,
    };
  }

  function createSubproject(rawIdentity, parentProjectId, payload = {}) {
    const identity = normalizeIdentity(rawIdentity);
    assertOperator(identity, 'subproject_create');
    if (!stateManager) {
      throw new LoopError('STATE_UNAVAILABLE', 'State manager unavailable', { statusCode: 503 });
    }
    assertProjectAccess(identity, parentProjectId, { allowNull: false });

    const {
      id = null,
      slug,
      title = null,
      displayName = null,
      params = {},
      roster = undefined,
      workspaceMode = 'subdir',
      channels = ['general'],
      mode = 'static',
      repoConfig = undefined,
    } = payload || {};

    if (!slug) {
      throw new LoopError('INVALID_SLUG', 'slug is required', { statusCode: 400 });
    }

    if (roster !== undefined && roster !== null) {
      const unknownIds = collectRosterAgentIds(roster).filter(a => !agentsMap[a]);
      if (unknownIds.length > 0) {
        throw new LoopError('UNKNOWN_AGENT', `Unknown agent id(s) in roster: ${unknownIds.join(', ')}`, { statusCode: 400 });
      }
    }

    try {
      const created = stateManager.createSubProject(parentProjectId, {
        id,
        slug,
        title,
        displayName,
        params,
        roster,
        workspaceMode,
        channels,
        mode,
        repoConfig,
      });
      const effectiveRoster = stateManager.getEffectiveProjectRoster(created.id);
      return {
        ...created,
        effectiveRoster,
      };
    } catch (err) {
      const msg = String(err?.message || err);
      const isConflict = /already exists|collision/i.test(msg);
      throw new LoopError(isConflict ? 'SUBPROJECT_CONFLICT' : 'INVALID_SUBPROJECT', msg, { statusCode: isConflict ? 409 : 400 });
    }
  }

  return {
    listLoops,
    getLoop,
    listLoopVersions,
    getLoopVersion,
    publishLoopVersion,
    getLoopSchedules,
    setLoopSchedule,
    deleteLoopSchedule,
    startAndExecuteRun,
    listRuns,
    getRun,
    compareRuns,
    cancelRun,
    approveRun,
    getRunEvidence,
    getRunEvidenceArchive,
    listSubprojects,
    createSubproject,
  };
}
