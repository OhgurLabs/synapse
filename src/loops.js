/**
 * Phase 2A — Static Loop Engine (Hardened per GPT-6.2 Sol #88 Review).
 *
 * Implements:
 *  - validateLoopDAG: static topology (duplicate deps rejected), placeholder checks,
 *    source-bound reducer/effect/anchor digests, concurrent output-collision audit
 *  - renderLoopPrompt: single-pass UTF-8 {{params.name}} rendering (fresh Buffer copy per attempt)
 *  - validateFanIn: identity-aware + transitive-parent selected/succeeded barrier
 *  - executeReduce: allowlisted plain-code transforms (artifact-index@1, evidence-summary@1 — ZERO LLM,
 *    real source-code SHA-256 digests, node-namespaced output digests)
 *  - resolveChecker: fresh-context cross-agent/cross-provider independent checker
 *    (reconstructed exclusions on resume; excludes workers, aliases, instances & governor)
 *  - runAnchor: argv-only subprocess Anchor runner against an ISOLATED detached checkout of pinned commit SHA
 *  - createLoopEngine: single-owner run claim, Promise.allSettled quiescence, fenced terminal transitions,
 *    crash-safe single-send reservation guard, full-diff + symlink-mode worktree write audit,
 *    leaf Git worktree flush + multi-batch dynamic base SHA + crash ancestry recovery.
 */

import Ajv from 'ajv';
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve as pathResolve, sep } from 'path';
import { validateGraphDAG } from './workflow-dag.js';
import {
  LOOP_ID_RE,
  SHA256_RE,
  buildModelQuantEntry,
  canonicalJson,
  resolveLoopParams,
  sha256Buffer,
  sha256Hex,
} from './loop-store.js';
import { modelClass, rosterAllowsAgentAnyRole } from './roster.js';
import { classifyExitSignal } from './orchestrator/execution-exit.js';
import {
  createSubtaskWorktree,
  discardSubtaskWorktree,
  integrateSubtaskWorktree,
  withRepoIntegrationLock,
} from './orchestrator/git-worktrees.js';
import { createLogger } from './logger.js';

const log = createLogger('loops');
const ajv = new Ajv({ allErrors: true, strict: false });

export const VALID_LOOP_NODE_KINDS = new Set([
  'agent', 'check', 'verify', 'reduce', 'anchor', 'http', 'webhook', 'shell',
]);

export const VALID_WORKSPACES = new Set(['shared', 'node-dir', 'worktree', 'read-only']);
export const VALID_EFFECTS = new Set(['read-only', 'idempotency-key', 'single-send']);

export class LoopError extends Error {
  constructor(code, message, { statusCode = 400, details = null } = {}) {
    super(message);
    this.name = 'LoopError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

// ─── Allowlisted Plain-Code Reducers (ZERO LLM, source-bound digests) ───

function runArtifactIndexReducer({ node, inputs, run }) {
  const workers = [...inputs]
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    .map(att => ({
      nodeId: att.nodeId,
      attemptId: att.attemptId,
      ordinal: att.ordinal,
      commitSha: att.commitSha || null,
      outputs: [...(att.outputs || [])].sort((x, y) => x.path.localeCompare(y.path)),
    }));
  const fileDigests = {};
  const fileDigestsByNode = {};
  for (const w of workers) {
    fileDigestsByNode[w.nodeId] = { attemptId: w.attemptId, files: {} };
    for (const out of w.outputs) {
      fileDigestsByNode[w.nodeId].files[out.path] = out.sha256;
      const key = Object.prototype.hasOwnProperty.call(fileDigests, out.path)
        ? `${w.nodeId}:${out.path}`
        : out.path;
      fileDigests[key] = out.sha256;
    }
  }
  const payload = {
    schemaVersion: 1,
    transformId: 'artifact-index@1',
    runId: run.runId,
    nodeId: node.nodeId,
    promotedHeadSha: run.provenance?.source?.postIntegrationHeadSha || null,
    workers,
    fileDigests,
    fileDigestsByNode,
  };
  const outPath = (node.outputs && node.outputs[0]?.path) || 'build-index.json';
  return [{ path: outPath, content: Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8') }];
}

function runEvidenceSummaryReducer({ node, inputs, run }) {
  const anchorOutcomes = (run.anchors || []).map(a => ({
    anchorId: a.anchorId,
    nodeId: a.nodeId,
    attemptId: a.attemptId,
    subjectSha: a.subjectSha,
    outcome: a.outcome,
  }));
  const checkerNodeId = run._checkerNodeId || null;
  const payload = {
    schemaVersion: 1,
    transformId: 'evidence-summary@1',
    runId: run.runId,
    loopId: run.pin.loopId,
    loopVersion: run.pin.loopVersion,
    manifestHash: run.pin.manifestHash,
    promotedHeadSha: run.provenance?.source?.postIntegrationHeadSha || null,
    checkerNodeId,
    anchorOutcomes,
    inputs: [...inputs]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map(att => ({
        nodeId: att.nodeId,
        attemptId: att.attemptId,
        outputs: att.outputs || [],
      })),
  };
  const outPath = (node.outputs && node.outputs[0]?.path) || 'summary.json';
  return [{ path: outPath, content: Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8') }];
}

// P2 #4: Hash actual reducer function source code so ANY implementation change invalidates stale pins!
export const REDUCER_REGISTRY = Object.freeze({
  'artifact-index@1': {
    id: 'artifact-index@1',
    digest: sha256Hex(`artifact-index@1\n${runArtifactIndexReducer.toString()}`),
    execute: runArtifactIndexReducer,
  },
  'evidence-summary@1': {
    id: 'evidence-summary@1',
    digest: sha256Hex(`evidence-summary@1\n${runEvidenceSummaryReducer.toString()}`),
    execute: runEvidenceSummaryReducer,
  },
});

export function getReducerDigest(transformId) {
  return REDUCER_REGISTRY[transformId]?.digest || null;
}

// ─── Safe Relative Path Normalization & Collision Audit ────────────────

export function normalizeSafeRelativePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new LoopError('INVALID_OUTPUT_PATH', 'Output path must be a non-empty relative string');
  }
  if (/[\u0000-\u001F\u007F]/.test(rawPath)) {
    throw new LoopError('INVALID_OUTPUT_PATH', `Output path contains control characters: "${rawPath}"`);
  }
  const unix = rawPath.replace(/\\/g, '/');
  if (unix.startsWith('/') || /^[a-zA-Z]:/.test(unix)) {
    throw new LoopError('INVALID_OUTPUT_PATH', `Absolute output path prohibited: "${rawPath}"`);
  }
  const parts = unix.split('/');
  if (parts.some(p => p === '..')) {
    throw new LoopError('INVALID_OUTPUT_PATH', `Path traversal prohibited in output path: "${rawPath}"`);
  }
  const cleaned = parts.filter(p => p && p !== '.').join('/');
  if (!cleaned) {
    throw new LoopError('INVALID_OUTPUT_PATH', `Output path resolves to root: "${rawPath}"`);
  }
  return cleaned;
}

function pathsCollide(pathA, pathB) {
  if (pathA === pathB) return true;
  if (pathA.startsWith(pathB + '/') || pathB.startsWith(pathA + '/')) return true;
  return false;
}

/**
 * P1 #5 & #6: Enforce subdir sub-project Git write subtree confinement across both
 * manifest publication, manual/scheduled run admission, and runtime Git commit audit.
 */
export function assertSubdirGitConfinement(manifest, project) {
  if (!project || project.workspaceMode !== 'subdir' || !project.gitWriteSubtree) return;
  const prefix = normalizeSafeRelativePath(project.gitWriteSubtree);
  for (const node of (manifest.nodes || [])) {
    for (const out of (node.outputs || [])) {
      if (out.storage !== 'git') continue;
      const norm = normalizeSafeRelativePath(out.path);
      if (norm !== prefix && !norm.startsWith(`${prefix}/`)) {
        throw new LoopError(
          'SUBTREE_VIOLATION',
          `Subdir sub-project "${project.id || project.name}" restricts Git writes to "${prefix}/" (got "${norm}" in node "${node.nodeId}")`,
          { statusCode: 400 }
        );
      }
    }
  }
}

export function extractPromptParamNames(template) {
  if (typeof template !== 'string') return [];
  const names = new Set();
  const re = /\{\{params\.([a-zA-Z0-9_]+)\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

export function renderLoopPrompt(template, params = {}) {
  if (typeof template !== 'string') {
    throw new LoopError('INVALID_PROMPT', 'Loop node prompt must be a string');
  }
  const rendered = template.replace(/\{\{params\.([a-zA-Z0-9_]+)\}\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name) || params[name] === undefined) {
      throw new LoopError('UNKNOWN_PROMPT_PARAM', `Prompt references unknown parameter "${name}"`);
    }
    const val = params[name];
    return typeof val === 'string' ? val : canonicalJson(val);
  });
  return Buffer.from(rendered, 'utf8');
}

// ─── Static Loop Manifest & DAG Validation ─────────────────────────────

export function validateLoopDAG(manifest, registries = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new LoopError('INVALID_MANIFEST', 'LoopManifest must be an object');
  }
  if (manifest.schemaVersion !== 1) {
    throw new LoopError('INVALID_MANIFEST', `Unsupported LoopManifest schemaVersion: ${manifest.schemaVersion}`);
  }
  if (!LOOP_ID_RE.test(String(manifest.loopId || ''))) {
    throw new LoopError('INVALID_MANIFEST', `Invalid loopId "${manifest.loopId}"`);
  }
  if (!Array.isArray(manifest.nodes) || manifest.nodes.length === 0) {
    throw new LoopError('INVALID_MANIFEST', 'LoopManifest must declare at least one node');
  }

  const graph = validateGraphDAG(manifest.nodes, {
    idField: 'nodeId',
    depsField: 'dependsOn',
    emptyError: 'Loop must have at least one node',
    duplicateError: 'Duplicate nodeId in LoopManifest',
    cycleError: 'LoopManifest contains a cycle',
    stableOrder: true,
    requireStringIds: true,
    rejectDuplicateDeps: true,
  });
  if (!graph.valid) {
    throw new LoopError('INVALID_DAG', graph.error);
  }

  const schemaProps = manifest.paramsSchema?.properties || {};
  const anchorMap = new Map();
  for (const spec of (manifest.anchors || [])) {
    if (!spec || !LOOP_ID_RE.test(String(spec.anchorId || ''))) {
      throw new LoopError('INVALID_ANCHOR_SPEC', `Invalid anchorId "${spec?.anchorId}"`);
    }
    if (anchorMap.has(spec.anchorId)) {
      throw new LoopError('INVALID_ANCHOR_SPEC', `Duplicate anchorId "${spec.anchorId}"`);
    }
    if (!SHA256_RE.test(String(spec.implementationDigest || ''))) {
      throw new LoopError('INVALID_ANCHOR_SPEC', `Anchor "${spec.anchorId}" requires a 64-hex implementationDigest`);
    }
    if (!Array.isArray(spec.requiredAssertions) || spec.requiredAssertions.length === 0) {
      throw new LoopError('INVALID_ANCHOR_SPEC', `Anchor "${spec.anchorId}" must declare non-empty requiredAssertions`);
    }
    if (registries?.anchors && registries.anchors[spec.runnerId]) {
      const reg = registries.anchors[spec.runnerId];
      if (reg.digest && reg.digest !== spec.implementationDigest) {
        throw new LoopError('DIGEST_MISMATCH', `Anchor "${spec.anchorId}" digest does not match registered runner "${spec.runnerId}"`);
      }
    }
    anchorMap.set(spec.anchorId, spec);
  }

  const nodeMap = new Map();
  const normalizedOutputsByNode = new Map();
  const referencedAnchors = new Set();

  for (const node of manifest.nodes) {
    if (!LOOP_ID_RE.test(String(node.nodeId || ''))) {
      throw new LoopError('INVALID_NODE_ID', `Invalid nodeId "${node.nodeId}"`);
    }
    if (!VALID_LOOP_NODE_KINDS.has(node.kind)) {
      throw new LoopError('INVALID_NODE_KIND', `Invalid node kind "${node.kind}" on "${node.nodeId}"`);
    }
    if (!VALID_WORKSPACES.has(node.workspace)) {
      throw new LoopError('INVALID_WORKSPACE', `Invalid workspace "${node.workspace}" on "${node.nodeId}"`);
    }
    if (!Number.isFinite(Number(node.timeoutMs)) || Number(node.timeoutMs) <= 0) {
      throw new LoopError('INVALID_TIMEOUT', `Node "${node.nodeId}" requires positive timeoutMs`);
    }

    const normOuts = [];
    for (const out of (node.outputs || [])) {
      const normPath = normalizeSafeRelativePath(out.path);
      if (out.storage !== 'artifact' && out.storage !== 'git') {
        throw new LoopError('INVALID_OUTPUT_STORAGE', `Invalid output storage "${out.storage}" on "${node.nodeId}"`);
      }
      if (out.storage === 'git' && node.workspace !== 'worktree') {
        throw new LoopError('INVALID_GIT_WORKSPACE', `Git-writing node "${node.nodeId}" MUST use workspace="worktree"`);
      }
      normOuts.push({ path: normPath, storage: out.storage });
    }
    normalizedOutputsByNode.set(node.nodeId, normOuts);

    if (node.kind === 'agent' || node.kind === 'check' || node.kind === 'verify') {
      if (typeof node.prompt !== 'string' || node.prompt.length === 0) {
        throw new LoopError('INVALID_PROMPT', `Node "${node.nodeId}" requires a non-empty prompt`);
      }
      for (const paramName of extractPromptParamNames(node.prompt)) {
        if (!Object.prototype.hasOwnProperty.call(schemaProps, paramName)) {
          throw new LoopError('UNKNOWN_PROMPT_PARAM', `Node "${node.nodeId}" prompt references undeclared param "${paramName}"`);
        }
      }
      if (node.kind === 'check' || node.kind === 'verify') {
        if (node.modelSeparation !== 'prefer-different-class' && node.modelSeparation !== 'require-different-provider') {
          throw new LoopError('INVALID_CHECKER', `Checker node "${node.nodeId}" requires valid modelSeparation`);
        }
      }
    } else if (node.kind === 'reduce') {
      const reducer = registries?.reducers?.[node.transformId] || REDUCER_REGISTRY[node.transformId];
      if (!reducer) {
        throw new LoopError('UNALLOWLISTED_REDUCER', `Reduce node "${node.nodeId}" uses unallowlisted transformId "${node.transformId}"`);
      }
      if (node.implementationDigest !== reducer.digest) {
        throw new LoopError('DIGEST_MISMATCH', `Reduce node "${node.nodeId}" implementationDigest mismatch for "${node.transformId}"`);
      }
    } else if (node.kind === 'anchor') {
      if (!anchorMap.has(node.anchorId)) {
        throw new LoopError('UNKNOWN_ANCHOR', `Anchor node "${node.nodeId}" references undeclared anchorId "${node.anchorId}"`);
      }
      referencedAnchors.add(node.anchorId);
    } else if (node.kind === 'http' || node.kind === 'webhook' || node.kind === 'shell') {
      if (!VALID_EFFECTS.has(node.effect)) {
        throw new LoopError('INVALID_EFFECT', `Effect node "${node.nodeId}" requires effect in read-only|idempotency-key|single-send`);
      }
      if (!SHA256_RE.test(String(node.implementationDigest || ''))) {
        throw new LoopError('INVALID_DIGEST', `Effect node "${node.nodeId}" requires 64-hex implementationDigest`);
      }
      if (registries?.effects && registries.effects[node.operationId]) {
        const regEff = registries.effects[node.operationId];
        if (regEff.digest && regEff.digest !== node.implementationDigest) {
          throw new LoopError('DIGEST_MISMATCH', `Effect node "${node.nodeId}" digest mismatch for operation "${node.operationId}"`);
        }
      }
    }

    nodeMap.set(node.nodeId, node);
  }

  for (const spec of (manifest.anchors || [])) {
    if (!referencedAnchors.has(spec.anchorId)) {
      throw new LoopError('UNREACHABLE_ANCHOR', `Declared anchor "${spec.anchorId}" is not wired to any anchor node`);
    }
  }

  for (const [outKey, ref] of Object.entries(manifest.outputs || {})) {
    if (!ref || !nodeMap.has(ref.nodeId)) {
      throw new LoopError('INVALID_MANIFEST_OUTPUT', `Manifest output "${outKey}" references unknown node "${ref?.nodeId}"`);
    }
    const normRefPath = normalizeSafeRelativePath(ref.path);
    const nodeOuts = normalizedOutputsByNode.get(ref.nodeId) || [];
    if (!nodeOuts.some(o => o.path === normRefPath)) {
      throw new LoopError('INVALID_MANIFEST_OUTPUT', `Manifest output "${outKey}" path "${ref.path}" not declared on node "${ref.nodeId}"`);
    }
  }

  if (manifest.evidence?.mode === 'pr') {
    const checker = nodeMap.get(manifest.evidence.checkerNodeId);
    if (!checker || (checker.kind !== 'check' && checker.kind !== 'verify')) {
      throw new LoopError('INVALID_EVIDENCE_CONFIG', `evidence.checkerNodeId "${manifest.evidence.checkerNodeId}" must reference a check/verify node`);
    }
  }

  const nodeIds = graph.order;
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const idA = nodeIds[i];
      const idB = nodeIds[j];
      const ordered = graph.predecessors.get(idA).has(idB) || graph.predecessors.get(idB).has(idA);
      if (ordered) continue;

      const nodeA = nodeMap.get(idA);
      const nodeB = nodeMap.get(idB);
      const outsA = normalizedOutputsByNode.get(idA) || [];
      const outsB = normalizedOutputsByNode.get(idB) || [];

      for (const oA of outsA) {
        for (const oB of outsB) {
          const sameSharedNs =
            (oA.storage === 'git' && oB.storage === 'git')
            || (oA.storage === 'artifact' && oB.storage === 'artifact' && nodeA.workspace === 'shared' && nodeB.workspace === 'shared');
          if (sameSharedNs && pathsCollide(oA.path, oB.path)) {
            throw new LoopError(
              'OUTPUT_PATH_COLLISION',
              `Concurrent nodes "${idA}" ("${oA.path}") and "${idB}" ("${oB.path}") collide in shared namespace`,
              { details: { nodeA: idA, pathA: oA.path, nodeB: idB, pathB: oB.path } }
            );
          }
        }
      }
    }
  }

  if (manifest.defaults && typeof manifest.defaults === 'object' && Object.keys(manifest.defaults).length > 0) {
    const partialSchema = { ...(manifest.paramsSchema || { type: 'object' }) };
    delete partialSchema.required;
    const validateDefaults = ajv.compile(partialSchema);
    if (!validateDefaults(manifest.defaults)) {
      const detail = (validateDefaults.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ');
      throw new LoopError('INVALID_DEFAULTS', `Manifest defaults violate paramsSchema: ${detail}`);
    }
  }

  return {
    valid: true,
    order: graph.order,
    predecessors: graph.predecessors,
    descendants: graph.descendants,
    nodeMap,
    anchorMap,
    normalizedOutputsByNode,
  };
}

// ─── Dependency Version & Identity-Aware Fan-In ────────────────────────

export function computeDependencyVersion({ manifestHash, nodeId, upstreamAttempts = [], sourceSha = null }) {
  const canonicalUpstreams = [...upstreamAttempts]
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    .map(u => ({
      nodeId: u.nodeId,
      attemptId: u.attemptId,
      dependencyVersion: u.dependencyVersion || null,
      outputs: [...(u.outputs || [])]
        .sort((x, y) => x.path.localeCompare(y.path))
        .map(o => ({ path: o.path, sha256: o.sha256, bytes: o.bytes })),
      commitSha: u.commitSha || null,
    }));
  return sha256Hex(canonicalJson({
    manifestHash,
    nodeId,
    sourceSha: sourceSha || null,
    upstreams: canonicalUpstreams,
  }));
}

export function validateFanIn(run, node, expectedNodeIds, { loopStore = null, manifest = null, sourceSha = null } = {}) {
  const expected = Array.isArray(expectedNodeIds) ? expectedNodeIds : (node.dependsOn || []);
  const uniqueExpected = new Set(expected);
  if (uniqueExpected.size !== expected.length) {
    throw new LoopError('FAN_IN_SHORTFALL', `Duplicate upstream node ID in expectedNodeIds for "${node.nodeId}"`);
  }

  const selected = [];
  const manifestNodeMap = new Map((manifest?.nodes || []).map(n => [n.nodeId, n]));
  const verifiedMemo = new Map();
  const visiting = new Set();

  const verifyNodeAttemptRecursive = (depId, expectedAttemptId = null, requireExpectedAttemptId = false) => {
    const selectedAttemptId = run.selectedAttempts?.[depId];
    if (!selectedAttemptId) {
      throw new LoopError('FAN_IN_SHORTFALL', `Missing selected attempt for upstream "${depId}" before "${node.nodeId}"`);
    }
    if (requireExpectedAttemptId) {
      if (typeof expectedAttemptId !== 'string' || expectedAttemptId.length === 0) {
        throw new LoopError('FAN_IN_SHORTFALL', `Missing or empty ancestor attemptId for upstream "${depId}"`);
      }
      if (selectedAttemptId !== expectedAttemptId) {
        throw new LoopError('FAN_IN_SHORTFALL', `Stale non-selected ancestor "${depId}:${expectedAttemptId}" (selected is "${selectedAttemptId}")`);
      }
    } else if (expectedAttemptId !== null && selectedAttemptId !== expectedAttemptId) {
      throw new LoopError('FAN_IN_SHORTFALL', `Stale non-selected ancestor "${depId}:${expectedAttemptId}" (selected is "${selectedAttemptId}")`);
    }
    if (verifiedMemo.has(depId)) return verifiedMemo.get(depId);
    if (visiting.has(depId)) {
      throw new LoopError('FAN_IN_SHORTFALL', `Cycle detected in ancestor attempts at "${depId}"`);
    }
    visiting.add(depId);

    const attempts = run.nodeAttempts?.[depId] || [];
    const attempt = attempts.find(a => a.attemptId === selectedAttemptId);
    if (!attempt) {
      throw new LoopError('FAN_IN_SHORTFALL', `Selected attempt "${selectedAttemptId}" not found for upstream "${depId}"`);
    }
    if (attempt.runId !== run.runId) {
      throw new LoopError('FAN_IN_SHORTFALL', `Foreign runId "${attempt.runId}" on upstream "${depId}" (expected "${run.runId}")`);
    }
    if (attempt.nodeId !== depId) {
      throw new LoopError('FAN_IN_SHORTFALL', `Mismatched nodeId "${attempt.nodeId}" in slot "${depId}"`);
    }
    if (attempt.terminalStatus !== 'succeeded') {
      throw new LoopError('FAN_IN_SHORTFALL', `Upstream "${depId}" attempt "${selectedAttemptId}" has terminalStatus="${attempt.terminalStatus}" (must be "succeeded")`);
    }

    const depNodeDef = manifestNodeMap.get(depId);
    const declaredParentIds = [...new Set(depNodeDef?.dependsOn || [])].sort();
    const recordedParentIds = (attempt.inputs || []).map(i => i.nodeId).sort();
    if (depNodeDef && JSON.stringify(declaredParentIds) !== JSON.stringify(recordedParentIds)) {
      throw new LoopError('FAN_IN_SHORTFALL', `Upstream "${depId}" recorded inputs [${recordedParentIds}] do not match declared dependsOn [${declaredParentIds}]`);
    }

    const upstreamSourceSha = attempt.inputsSourceSha !== undefined ? attempt.inputsSourceSha : (sourceSha ?? run.provenance?.source?.baseSha ?? null);
    const depInputsResolved = (attempt.inputs || []).map(inp => {
      const parentAtt = verifyNodeAttemptRecursive(inp.nodeId, inp.attemptId, true);
      if (parentAtt.dependencyVersion !== inp.dependencyVersion) {
        throw new LoopError('FAN_IN_SHORTFALL', `Stale dependencyVersion on parent "${inp.nodeId}" for "${depId}"`);
      }
      return parentAtt;
    });

    const recomputedDepVer = computeDependencyVersion({
      manifestHash: run.pin.manifestHash,
      nodeId: depId,
      upstreamAttempts: depInputsResolved,
      sourceSha: upstreamSourceSha,
    });
    if (attempt.dependencyVersion !== recomputedDepVer) {
      throw new LoopError(
        'FAN_IN_SHORTFALL',
        `Dependency version mismatch on upstream "${depId}" (recorded ${attempt.dependencyVersion}, expected ${recomputedDepVer})`
      );
    }

    const declaredPaths = (depNodeDef?.outputs || []).map(o => normalizeSafeRelativePath(o.path));
    const outputMap = new Map((attempt.outputs || []).map(o => [normalizeSafeRelativePath(o.path), o]));
    for (const reqPath of declaredPaths) {
      const ref = outputMap.get(reqPath);
      if (!ref) {
        throw new LoopError('FAN_IN_SHORTFALL', `Upstream "${depId}" missing required output "${reqPath}"`);
      }
      if (loopStore && !loopStore.verifyFileRef(ref)) {
        throw new LoopError('FAN_IN_SHORTFALL', `Upstream "${depId}" output "${reqPath}" failed digest verification`);
      }
    }

    visiting.delete(depId);
    verifiedMemo.set(depId, attempt);
    return attempt;
  };

  for (const depId of [...uniqueExpected].sort()) {
    selected.push(verifyNodeAttemptRecursive(depId, null));
  }

  return selected;
}

// ─── Plain-Code Reduce Execution ───────────────────────────────────────

export function executeReduce(node, inputs, { loopStore, stagingDir, run, reducers = {} }) {
  const reducer = reducers?.[node.transformId] || REDUCER_REGISTRY[node.transformId];
  if (!reducer) {
    throw new LoopError('UNALLOWLISTED_REDUCER', `Unallowlisted reduce transform "${node.transformId}"`);
  }
  if (node.implementationDigest !== reducer.digest) {
    throw new LoopError('DIGEST_MISMATCH', `Reduce "${node.nodeId}" digest mismatch`);
  }

  const declaredPaths = new Set((node.outputs || []).map(o => normalizeSafeRelativePath(o.path)));
  const produced = reducer.execute({ node, inputs, run });
  const refs = [];

  const canonicalStaging = stagingDir ? (mkdirSync(stagingDir, { recursive: true }), realpathSync(stagingDir)) : null;

  for (const item of produced) {
    const normPath = normalizeSafeRelativePath(item.path);
    if (declaredPaths.size > 0 && !declaredPaths.has(normPath)) {
      throw new LoopError('UNDECLARED_WRITE', `Reduce "${node.nodeId}" attempted undeclared output "${normPath}"`);
    }
    if (canonicalStaging) {
      const target = pathResolve(canonicalStaging, normPath);
      if (!target.startsWith(canonicalStaging + sep)) {
        throw new LoopError('PATH_ESCAPE', `Reduce output escapes staging dir: "${normPath}"`);
      }
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new LoopError('SYMLINK_ESCAPE', `Reduce output target is a symlink: "${normPath}"`);
      }
      writeFileSync(target, item.content);
    }
    const ref = loopStore.writeArtifactBytes(normPath, item.content);
    refs.push(ref);
  }

  return refs;
}

// ─── Independent Fresh-Context Checker Resolution ──────────────────────

export function resolveChecker(node, roster, workerAssignments = [], { agentsMap = {}, priorSessionIds = new Set() } = {}) {
  const workerAgentIds = new Set();
  const workerInstanceIds = new Set();
  const workerProviders = new Set();
  const workerClasses = new Set();

  for (const wa of workerAssignments) {
    if (!wa) continue;
    if (wa.agentId) workerAgentIds.add(String(wa.agentId));
    if (wa.agentInstanceId) workerInstanceIds.add(String(wa.agentInstanceId));
    if (wa.provider) workerProviders.add(String(wa.provider));
    if (wa.modelClass) workerClasses.add(String(wa.modelClass));
    else if (wa.model) workerClasses.add(modelClass(wa.model) || String(wa.model).toLowerCase());
    const def = agentsMap[wa.agentId];
    if (Array.isArray(def?.aliases)) {
      for (const alias of def.aliases) workerAgentIds.add(String(alias));
    }
  }

  const selector = node?.selector || {};
  const candidates = [];

  for (const [id, def] of Object.entries(agentsMap)) {
    if (!def) continue;
    if (String(def.role || '').toLowerCase() === 'governor') continue;
    if (roster && !rosterAllowsAgentAnyRole(roster, id, def)) continue;
    if (selector.agentId && selector.agentId !== id) continue;
    if (selector.role && def.role !== selector.role) continue;
    const candClass = modelClass(def.model) || String(def.model || '').toLowerCase();
    if (selector.modelClass && candClass !== selector.modelClass.toLowerCase()) continue;

    const entry = buildModelQuantEntry(id, def);
    const aliases = Array.isArray(def.aliases) ? def.aliases.map(String) : [];

    if (workerAgentIds.has(id) || workerInstanceIds.has(entry.agentInstanceId) || aliases.some(a => workerAgentIds.has(a))) {
      continue;
    }

    if (node.modelSeparation === 'require-different-provider' && workerProviders.has(entry.provider)) {
      continue;
    }

    const diffProvider = !workerProviders.has(entry.provider);
    const diffClass = !workerClasses.has(entry.modelClass);
    candidates.push({ entry, diffProvider, diffClass });
  }

  if (candidates.length === 0) {
    throw new LoopError(
      'INDEPENDENCE_UNAVAILABLE',
      `No independent checker available for node "${node.nodeId}" (separation=${node.modelSeparation})`,
      { statusCode: 409 }
    );
  }

  candidates.sort((a, b) => {
    if (a.diffClass !== b.diffClass) return a.diffClass ? -1 : 1;
    if (a.diffProvider !== b.diffProvider) return a.diffProvider ? -1 : 1;
    return a.entry.agentId.localeCompare(b.entry.agentId);
  });

  let sessionId = randomUUID();
  while (priorSessionIds.has(sessionId)) {
    sessionId = randomUUID();
  }

  return {
    ...candidates[0].entry,
    sessionId,
    readOnly: true,
    freshSession: true,
  };
}

// ─── Exercised Anchor Subprocess Runner ────────────────────────────────

export async function runAnchor(spec, {
  nodeId,
  attemptId,
  runnerPath,
  subjectDir,
  subjectSha = null,
  args = [],
  timeoutMs = 15_000,
  signal = null,
  loopStore,
} = {}) {
  const startedAt = new Date().toISOString();
  if (!runnerPath || !existsSync(runnerPath)) {
    throw new LoopError('ANCHOR_RUNNER_MISSING', `Anchor runner not found: ${runnerPath}`);
  }
  const runnerBytes = readFileSync(runnerPath);
  const actualDigest = sha256Buffer(runnerBytes);
  if (actualDigest !== spec.implementationDigest) {
    throw new LoopError(
      'ANCHOR_DIGEST_MISMATCH',
      `Anchor "${spec.anchorId}" runner digest ${actualDigest} != pinned ${spec.implementationDigest}`
    );
  }

  const inputSha256 = sha256Hex(canonicalJson({
    anchorId: spec.anchorId,
    subjectSha,
    args: (args || []).map(String),
  }));

  const execRes = await new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath, ...(args || []).map(String)], {
      cwd: subjectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV || 'production' },
    });

    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let aborted = false;

    child.stdout.on('data', d => outChunks.push(d));
    child.stderr.on('data', d => errChunks.push(d));

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, Math.max(100, Number(timeoutMs) || 15_000));
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (signal) try { signal.removeEventListener('abort', onAbort); } catch {}
      resolve({
        exitCode: code,
        signal: sig || (timedOut ? 'TIMEOUT' : (aborted ? 'ABORTED' : null)),
        stdoutBuf: Buffer.concat(outChunks),
        stderrBuf: Buffer.concat(errChunks),
        timedOut,
        aborted,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (signal) try { signal.removeEventListener('abort', onAbort); } catch {}
      resolve({
        exitCode: null,
        signal: 'SPAWN_ERROR',
        stdoutBuf: Buffer.concat(outChunks),
        stderrBuf: Buffer.concat([...errChunks, Buffer.from(err.message + '\n', 'utf8')]),
        timedOut: false,
        aborted: false,
      });
    });
  });

  const endedAt = new Date().toISOString();
  const stdoutRef = loopStore.writeArtifactBytes(`anchors/${spec.anchorId}/${attemptId}.stdout`, execRes.stdoutBuf);
  const stderrRef = loopStore.writeArtifactBytes(`anchors/${spec.anchorId}/${attemptId}.stderr`, execRes.stderrBuf);

  let proof = null;
  let outcome = 'indeterminate';

  if (execRes.timedOut || execRes.aborted || execRes.signal !== null) {
    outcome = 'indeterminate';
  } else if (execRes.exitCode !== 0) {
    try { proof = JSON.parse(execRes.stdoutBuf.toString('utf8')); } catch { proof = null; }
    outcome = 'failed';
  } else {
    let parsed = null;
    try { parsed = JSON.parse(execRes.stdoutBuf.toString('utf8')); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object') {
      const validateProof = ajv.compile(spec.proofSchema || { type: 'object' });
      if (validateProof(parsed)) {
        proof = parsed;
        const assertionMap = new Map(
          (Array.isArray(parsed.assertions) ? parsed.assertions : []).map(a => [a?.id, a])
        );
        const missing = [];
        const failedIds = [];
        for (const reqId of spec.requiredAssertions) {
          const item = assertionMap.get(reqId);
          if (!item) missing.push(reqId);
          else if (item.passed !== true) failedIds.push(reqId);
        }
        if (missing.length > 0) outcome = 'indeterminate';
        else if (failedIds.length > 0) outcome = 'failed';
        else outcome = 'passed';
      } else {
        outcome = 'indeterminate';
      }
    } else {
      outcome = 'indeterminate';
    }
  }

  return {
    anchorId: spec.anchorId,
    nodeId,
    attemptId,
    subjectSha,
    inputSha256,
    runnerDigest: actualDigest,
    startedAt,
    endedAt,
    exitCode: execRes.exitCode,
    signal: execRes.signal,
    proof,
    stdout: stdoutRef,
    stderr: stderrRef,
    outcome,
  };
}

// ─── Runtime Workspace & Full-Commit Worktree Audit ────────────────────

function scanRelativeFiles(rootDir) {
  const found = [];
  if (!existsSync(rootDir)) return found;
  const canonicalRoot = realpathSync(rootDir);
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const full = join(dir, ent.name);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        throw new LoopError('SYMLINK_ESCAPE', `Symlink prohibited in Loop node workspace: "${relative(canonicalRoot, full)}"`);
      }
      if (lst.isDirectory()) walk(full);
      else if (lst.isFile()) {
        const real = realpathSync(full);
        if (!real.startsWith(canonicalRoot + sep)) {
          throw new LoopError('PATH_ESCAPE', `Workspace file escapes root: "${full}"`);
        }
        found.push(relative(canonicalRoot, real).replace(/\\/g, '/'));
      }
    }
  };
  walk(canonicalRoot);
  return found.sort();
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitIsAncestor(cwd, ancestorSha, descendantRef) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestorSha, descendantRef], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function auditWorktreeCommitAgainstDeclared(workingDir, workerBaseSha, declaredSet, nodeId, gitWriteSubtree = null) {
  // P1 #10: Parse raw -z output handling R/C records (which carry TWO NUL-separated paths: old + new)
  const deletedOrRenamedSources = new Set();
  const diffRawBuf = execFileSync('git', ['diff', '--raw', '-z', `${workerBaseSha}..HEAD`], {
    cwd: workingDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tokens = diffRawBuf.toString('utf8').split('\0');
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i++];
    if (!meta) continue;
    const fields = meta.replace(/^:/, '').split(/\s+/);
    const oldMode = fields[0] || '';
    const newMode = fields[1] || '';
    const status = fields[4] || '';
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const pathA = tokens[i++] || '';
    const pathB = isRenameOrCopy ? (tokens[i++] || '') : null;
    if ((status.startsWith('D') || status.startsWith('R')) && pathA) {
      deletedOrRenamedSources.add(normalizeSafeRelativePath(pathA));
    }
    const touchedPaths = pathB !== null ? [pathA, pathB] : [pathA];
    for (const relPath of touchedPaths) {
      if (!relPath) continue;
      if (oldMode === '120000' || newMode === '120000') {
        throw new LoopError('SYMLINK_ESCAPE', `Worker "${nodeId}" committed symlink "${relPath}"`);
      }
      const normRel = normalizeSafeRelativePath(relPath);
      if (!declaredSet.has(normRel)) {
        throw new LoopError('UNDECLARED_WRITE', `Worker "${nodeId}" committed undeclared path "${normRel}"`);
      }
      if (gitWriteSubtree && normRel !== gitWriteSubtree && !normRel.startsWith(`${gitWriteSubtree}/`)) {
        throw new LoopError('SUBTREE_VIOLATION', `Worker "${nodeId}" committed path "${normRel}" outside subdir subtree "${gitWriteSubtree}/"`);
      }
    }
  }
  // Merge-aware NUL-delimited history pass (no .trim() mangling filenames with leading/trailing spaces)
  const logRawBuf = execFileSync('git', ['log', '-m', '--format=', '--name-only', '-z', `${workerBaseSha}..HEAD`], {
    cwd: workingDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const rawPath of logRawBuf.toString('utf8').split('\0')) {
    if (!rawPath) continue;
    const normRel = normalizeSafeRelativePath(rawPath);
    if (!declaredSet.has(normRel)) {
      throw new LoopError('UNDECLARED_WRITE', `Worker "${nodeId}" touched undeclared path in history: "${normRel}"`);
    }
    if (gitWriteSubtree && normRel !== gitWriteSubtree && !normRel.startsWith(`${gitWriteSubtree}/`)) {
      throw new LoopError('SUBTREE_VIOLATION', `Worker "${nodeId}" touched path "${normRel}" in history outside subdir subtree "${gitWriteSubtree}/"`);
    }
  }
  return { deletedOrRenamedSources };
}

// ─── Loop Engine Factory ───────────────────────────────────────────────

export function createLoopEngine({
  loopStore,
  agentsMap = {},
  prStore = null,
  stateManager = null,
  councilService = null,
  poolArbiter = null,
  harnessRegistry = null,
  resolveVerifiedRuntime = null,
  spawnNativeProcess = null,
  dispatchVerbatim = null,
  executeEffect = null,
  effectRegistry = {},
  anchorRunners = {},
  reducers = {},
  resolveRunContext = null,
  engineBuild = 'synapse-phase2a',
} = {}) {
  if (!loopStore) throw new Error('createLoopEngine requires loopStore');

  const activeAbortControllers = new Map();
  const activeRunPromises = new Map();

  function publish(manifest, { baseVersion = 0 } = {}) {
    return loopStore.publishLoopVersion({
      manifest,
      baseVersion,
      validateManifestFn: (m) => validateLoopDAG(m, { anchors: anchorRunners, effects: effectRegistry, reducers }),
    });
  }

  function resolveAdmissionPins(manifest, rosterSnapshot = null) {
    const modelQuantRecord = {};
    for (const node of manifest.nodes) {
      if (node.kind !== 'agent') continue;
      const sel = node.selector || {};
      let chosenId = null;
      if (sel.agentId) {
        const explicitDef = agentsMap[sel.agentId];
        if (!explicitDef) {
          throw new LoopError('AGENT_NOT_FOUND', `Pinned agent "${sel.agentId}" for node "${node.nodeId}" not found`);
        }
        if (String(explicitDef.role || '').toLowerCase() === 'governor') {
          throw new LoopError('GOVERNOR_EXCLUDED', `Governor agent "${sel.agentId}" cannot be assigned to Loop node "${node.nodeId}"`);
        }
        if (rosterSnapshot && !rosterAllowsAgentAnyRole(rosterSnapshot, sel.agentId, explicitDef)) {
          throw new LoopError('ROSTER_VIOLATION', `Agent "${sel.agentId}" not allowed by project roster`);
        }
        chosenId = sel.agentId;
      } else {
        const eligible = Object.entries(agentsMap)
          .filter(([id, def]) => {
            if (!def || String(def.role || '').toLowerCase() === 'governor') return false;
            if (rosterSnapshot && !rosterAllowsAgentAnyRole(rosterSnapshot, id, def)) return false;
            if (sel.role && def.role !== sel.role) return false;
            if (sel.modelClass && (modelClass(def.model) || '').toLowerCase() !== sel.modelClass.toLowerCase()) return false;
            return true;
          })
          .sort(([a], [b]) => a.localeCompare(b));
        if (eligible.length === 0) {
          throw new LoopError('NO_ELIGIBLE_AGENT', `No eligible agent for node "${node.nodeId}"`);
        }
        chosenId = eligible[0][0];
      }
      modelQuantRecord[node.nodeId] = buildModelQuantEntry(chosenId, agentsMap[chosenId]);
    }
    return modelQuantRecord;
  }

  function startRun({
    loopId,
    loopVersion = null,
    params = null,
    ancestorDefaults = undefined,
    projectDefaults = undefined,
    rosterSnapshot = undefined,
    trigger = { kind: 'manual', principalId: 'operator', requestId: `req_${randomUUID().slice(0, 8)}` },
    source = null,
    scope = undefined,
    allowQueuedOverlap = false,
  } = {}) {
    const published = loopStore.getLoopVersion(loopId, loopVersion);
    if (!published) {
      throw new LoopError('LOOP_NOT_FOUND', `Loop "${loopId}" version ${loopVersion ?? 'latest'} not found`, { statusCode: 404 });
    }
    const manifest = published.manifest;

    const requestId = trigger?.kind === 'manual' ? (trigger.requestId || null) : null;
    const occurrenceKey = trigger?.kind === 'schedule' ? (trigger.occurrenceKey || null) : null;

    if (requestId) {
      const existing = loopStore.listRuns(loopId).find(r => r.provenance?.trigger?.requestId === requestId);
      if (existing) return { deduplicated: true, run: existing };
    }

    if (!allowQueuedOverlap && trigger?.kind === 'manual') {
      const active = loopStore.listActiveRuns(loopId);
      if (active.length > 0) {
        throw new LoopError('LOOP_ALREADY_ACTIVE', `Loop "${loopId}" already has an active run (${active[0].runId})`, { statusCode: 409 });
      }
    }

    // P1 #5 & #6: Single shared admission-time sub-project resolution & confinement
    // applied identically to BOTH manual AND scheduled triggers!
    const effectiveScope = scope !== undefined ? scope : (manifest.scope ?? null);
    const effectiveProjectId = effectiveScope?.projectId || null;
    let resolvedAncestorDefaults = ancestorDefaults !== undefined ? ancestorDefaults : [];
    let resolvedProjectDefaults = projectDefaults !== undefined ? projectDefaults : null;
    let resolvedRosterSnapshot = rosterSnapshot !== undefined ? rosterSnapshot : null;
    let resolvedGitWriteSubtree = effectiveScope?.gitWriteSubtree || null;

    if (stateManager && effectiveProjectId) {
      const boundProj = stateManager.getProject(effectiveProjectId);
      if (!boundProj) {
        throw new LoopError('PROJECT_NOT_FOUND', `Project "${effectiveProjectId}" not found for Loop admission`, { statusCode: 404 });
      }
      const dynamicSubtree = (boundProj.workspaceMode === 'subdir' && typeof stateManager.resolveEffectiveGitWriteSubtree === 'function')
        ? stateManager.resolveEffectiveGitWriteSubtree(effectiveProjectId)
        : (boundProj.gitWriteSubtree || null);
      assertSubdirGitConfinement(manifest, {
        id: effectiveProjectId,
        ...boundProj,
        gitWriteSubtree: dynamicSubtree,
      });
      if (ancestorDefaults === undefined || projectDefaults === undefined) {
        const pChain = stateManager.getProjectParamChain(effectiveProjectId);
        if (ancestorDefaults === undefined) resolvedAncestorDefaults = pChain.ancestorDefaults;
        if (projectDefaults === undefined) resolvedProjectDefaults = pChain.projectDefaults;
      }
      if (rosterSnapshot === undefined) {
        resolvedRosterSnapshot = stateManager.getEffectiveProjectRoster(effectiveProjectId).roster;
      }
      if (boundProj.workspaceMode === 'subdir' && dynamicSubtree) {
        resolvedGitWriteSubtree = normalizeSafeRelativePath(dynamicSubtree);
      }
    }

    const resolvedParams = resolveLoopParams(manifest, {
      ancestorDefaults: resolvedAncestorDefaults,
      projectDefaults: resolvedProjectDefaults,
      overrides: params,
    });

    const modelQuantRecord = resolveAdmissionPins(manifest, resolvedRosterSnapshot);
    const now = new Date().toISOString();
    const runId = `lrun_${Date.now()}_${randomUUID().slice(0, 8)}`;

    const persistedScope = effectiveScope
      ? {
          ...effectiveScope,
          ...(resolvedGitWriteSubtree ? { gitWriteSubtree: resolvedGitWriteSubtree } : {}),
        }
      : null;

    const run = {
      runId,
      pin: {
        loopId: published.loopId,
        loopVersion: published.loopVersion,
        manifestHash: published.manifestHash,
        params: resolvedParams,
        modelQuantRecord,
      },
      provenance: {
        engineBuild,
        scope: persistedScope,
        rosterSnapshot: resolvedRosterSnapshot ?? null,
        trigger,
        source: source ? {
          repoId: source.repoId || 'default',
          baseSha: source.baseSha,
          sourceRef: source.sourceRef,
          prId: source.prId || null,
          postIntegrationHeadSha: null,
        } : null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
      },
      phase: 'queued',
      nodeAttempts: {},
      selectedAttempts: {},
      anchors: [],
      verdict: null,
      reasonCode: null,
      _checkerNodeId: manifest.evidence?.mode === 'pr' ? manifest.evidence.checkerNodeId : null,
      _checkerReview: null,
      _claimGenerations: {},
    };

    // P1 #4: Mark adopted existing PR durably loopManaged=true BEFORE admitting the run,
    // failing closed if marking fails so no admitted run can ever adopt an unmarked PR.
    if (prStore && source?.prId) {
      const prProjId = (scope !== undefined ? scope?.projectId : manifest.scope?.projectId) || 'default';
      prStore.markLoopManaged(prProjId, source.prId, { loopId: published.loopId });
    }
    const admitted = loopStore.admitRun(run, { requestId, occurrenceKey });
    return admitted;
  }

  function selectAttemptFenced(runId, nodeId, attemptId, claimGen) {
    return loopStore.updateRunAtomic(runId, (r) => {
      if (r.phase === 'cancelling' || r.phase === 'terminal') {
        const att = (r.nodeAttempts[nodeId] || []).find(a => a.attemptId === attemptId);
        if (att) att.terminalStatus = 'fenced';
        return r;
      }
      const curGen = r._claimGenerations?.[nodeId] || 0;
      if (claimGen < curGen) {
        const att = (r.nodeAttempts[nodeId] || []).find(a => a.attemptId === attemptId);
        if (att) att.terminalStatus = 'fenced';
        return r;
      }
      r.selectedAttempts[nodeId] = attemptId;
      return r;
    });
  }

  async function integrateGitGroup(runId, gitNodesOrdered, { projectDir, checkFence, crashAfterFirstMerge = false }) {
    const run = loopStore.getRun(runId);
    const source = run.provenance?.source;
    if (!source?.baseSha || !source?.sourceRef) {
      throw new LoopError('MISSING_SOURCE_CONFIG', 'Git integration requires provenance.source.{baseSha, sourceRef}');
    }
    const expectedBaseSha = source.postIntegrationHeadSha || source.baseSha;
    const stagingBranch = `synapse/loop-stage/${runId}`;
    const stagingRef = `refs/heads/${stagingBranch}`;
    const fullSourceRef = source.sourceRef.startsWith('refs/') ? source.sourceRef : `refs/heads/${source.sourceRef}`;

    return withRepoIntegrationLock(projectDir, async () => {
      // P1 #9 & New P1: Only treat fullSourceRef as already-promoted if liveSourceSha EQUALS
      // the EXACT journaled stagingTipSha recorded before CAS (NEVER loose ancestry that could adopt an unrelated commit!).
      const liveSourceSha = runGit(projectDir, ['rev-parse', fullSourceRef]);
      const batchIntents = gitNodesOrdered.map(g => loopStore.getIntegrationIntent(runId, g.nodeId, g.attemptId));
      const journaledTipSha = batchIntents.length > 0 && batchIntents.every(i => i && (i.status === 'staging_complete' || i.status === 'promoted') && i.postIntegrationHeadSha)
        ? batchIntents[batchIntents.length - 1].postIntegrationHeadSha
        : null;
      if (journaledTipSha && liveSourceSha === journaledTipSha) {
        for (const g of gitNodesOrdered) {
          if (g.worktreePath && existsSync(g.worktreePath)) {
            try { discardSubtaskWorktree({ projectDir, worktreePath: g.worktreePath, subtaskBranch: g.subtaskBranch }); } catch {}
          }
        }
        loopStore.commitPromotedBatchAtomic({
          runId,
          stagingRef,
          postIntegrationHeadSha: journaledTipSha,
          entries: gitNodesOrdered.map((g, idx) => ({
            nodeId: g.nodeId,
            attemptId: g.attemptId,
            preparedCommitSha: batchIntents[idx]?.preparedCommitSha || g.commitSha || null,
          })),
        });
        return journaledTipSha;
      }

      let stagingExists = false;
      try {
        runGit(projectDir, ['rev-parse', '--verify', stagingRef]);
        stagingExists = true;
      } catch {}
      if (!stagingExists) {
        runGit(projectDir, ['branch', stagingBranch, expectedBaseSha]);
      } else if (!gitIsAncestor(projectDir, expectedBaseSha, stagingRef)) {
        runGit(projectDir, ['branch', '-f', stagingBranch, expectedBaseSha]);
      }

      let latestPostHead = runGit(projectDir, ['rev-parse', stagingRef]);

      for (let idx = 0; idx < gitNodesOrdered.length; idx++) {
        const { nodeId, attemptId, worktreePath, subtaskBranch, commitSha } = gitNodesOrdered[idx];
        const existingIntent = loopStore.getIntegrationIntent(runId, nodeId, attemptId);

        const candidateSha = existingIntent?.preparedCommitSha || commitSha || null;
        if (candidateSha && gitIsAncestor(projectDir, candidateSha, stagingRef)) {
          latestPostHead = runGit(projectDir, ['rev-parse', stagingRef]);
          loopStore.recordIntegrationIntent({
            runId, nodeId, attemptId, stagingRef,
            preparedCommitSha: candidateSha,
            postIntegrationHeadSha: latestPostHead,
            status: 'integrated',
          });
          if (worktreePath && existsSync(worktreePath)) {
            try { discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch }); } catch {}
          }
          continue;
        }

        const res = await integrateSubtaskWorktree({
          projectDir,
          worktreePath,
          subtaskBranch,
          campaignBranch: stagingBranch,
          attemptId,
          commitMessage: `loop(${runId}): integrate ${nodeId} (${attemptId})`,
          checkFence,
          skipLock: true,
          onPreparedCommit: (prepSha) => {
            loopStore.recordIntegrationIntent({
              runId, nodeId, attemptId, stagingRef,
              preparedCommitSha: prepSha,
              status: 'prepared',
            });
          },
        });

        if (!res.ok) {
          if (res.fenced) throw new LoopError('ATTEMPT_FENCED', `Integration fenced for ${nodeId}`);
          if (res.conflict) throw new LoopError('INTEGRATION_CONFLICT', res.error || `Merge conflict integrating ${nodeId}`);
          throw new LoopError('INTEGRATION_FAILED', res.error || `Integration failed for ${nodeId}`);
        }

        latestPostHead = res.postIntegrationHeadSha;
        if (crashAfterFirstMerge && idx === 0) {
          throw new LoopError('SIMULATED_CRASH_POST_MERGE', 'Simulated crash after merge before receipt persistence');
        }

        loopStore.recordIntegrationIntent({
          runId, nodeId, attemptId, stagingRef,
          preparedCommitSha: res.preparedCommitSha || candidateSha,
          postIntegrationHeadSha: latestPostHead,
          status: 'integrated',
        });
      }

      // Journal exact stagingTipSha BEFORE CAS so post-CAS crash recovery verifies exact SHA equality!
      const promotedEntries = gitNodesOrdered.map(g => {
        const intent = loopStore.getIntegrationIntent(runId, g.nodeId, g.attemptId);
        const prepSha = intent?.preparedCommitSha || g.commitSha || null;
        loopStore.recordIntegrationIntent({
          runId, nodeId: g.nodeId, attemptId: g.attemptId, stagingRef,
          preparedCommitSha: prepSha,
          postIntegrationHeadSha: latestPostHead,
          status: 'staging_complete',
        });
        return { nodeId: g.nodeId, attemptId: g.attemptId, preparedCommitSha: prepSha };
      });

      try {
        runGit(projectDir, ['update-ref', fullSourceRef, latestPostHead, expectedBaseSha]);
      } catch (casErr) {
        throw new LoopError('STALE_SOURCE_SHA', `CAS advance of ${fullSourceRef} failed (expected ${expectedBaseSha} drifted): ${casErr.message}`);
      }

      // Atomically mark intents promoted AND persist run.provenance.source.postIntegrationHeadSha in ONE transaction!
      loopStore.commitPromotedBatchAtomic({
        runId,
        stagingRef,
        postIntegrationHeadSha: latestPostHead,
        entries: promotedEntries,
      });

      try {
        const curBranch = runGit(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (curBranch === stagingBranch) {
          const shortSource = fullSourceRef.replace(/^refs\/heads\//, '');
          runGit(projectDir, ['checkout', shortSource]);
        }
        runGit(projectDir, ['branch', '-D', stagingBranch]);
      } catch {}

      return latestPostHead;
    });
  }

  async function executeRun(runId, opts = {}) {
    if (activeRunPromises.has(runId)) {
      throw new LoopError('RUN_ALREADY_EXECUTING', `Run "${runId}" is already executing`, { statusCode: 409 });
    }

    const executionOwnerToken = `${process.pid}:${randomUUID().slice(0, 12)}`;
    const claimRes = loopStore.claimRunExecution(runId, executionOwnerToken);
    if (!claimRes.found) throw new LoopError('RUN_NOT_FOUND', `Run "${runId}" not found`, { statusCode: 404 });
    if (claimRes.terminal) return claimRes.run;
    if (!claimRes.claimed) {
      throw new LoopError('RUN_ALREADY_EXECUTING', `Run "${runId}" is already claimed by owner "${claimRes.owner}"`, { statusCode: 409 });
    }
    const initialRun = claimRes.run;

    let projectDir, runsBaseDir, anchorArgsBuilder, simulateCrashAfterMerge, manifest, compiled;
    try {
      const resolvedCtx = typeof resolveRunContext === 'function' ? (resolveRunContext(initialRun) || {}) : {};
      projectDir = opts.projectDir ?? resolvedCtx.projectDir ?? null;
      runsBaseDir = opts.runsBaseDir ?? resolvedCtx.runsBaseDir ?? null;
      anchorArgsBuilder = opts.anchorArgsBuilder ?? resolvedCtx.anchorArgsBuilder ?? null;
      simulateCrashAfterMerge = Boolean(opts.simulateCrashAfterMerge);

      const published = loopStore.getLoopVersion(initialRun.pin.loopId, initialRun.pin.loopVersion);
      if (!published || published.manifestHash !== initialRun.pin.manifestHash) {
        throw new LoopError('MANIFEST_PIN_MISMATCH', 'Pinned LoopManifest no longer matches stored hash');
      }
      manifest = published.manifest;
      compiled = validateLoopDAG(manifest, { anchors: anchorRunners, effects: effectRegistry });
    } catch (setupErr) {
      loopStore.releaseRunExecution(runId, executionOwnerToken);
      throw setupErr;
    }

    const abortController = new AbortController();
    activeAbortControllers.set(runId, abortController);

    const runPromise = (async () => {
      const startState = loopStore.updateRunAtomic(runId, (r) => {
        if (r.phase === 'cancelling' || r.phase === 'terminal') return r;
        if (r.phase === 'queued') {
          r.phase = 'running';
          r.provenance.startedAt = r.provenance.startedAt || new Date().toISOString();
        }
        return r;
      });
      if (startState.phase === 'cancelling') {
        return loopStore.updateRunAtomic(runId, (r) => {
          r.phase = 'terminal'; r.verdict = 'cancelled'; r.reasonCode = 'CANCELLED';
          r.provenance.endedAt = new Date().toISOString();
          return r;
        });
      }

      const baseRunsDir = runsBaseDir || join(loopStore.synapseDir, 'runs');
      const scopeDirName = manifest.scope?.projectId || 'global';
      const completedNodes = new Set();
      const pendingGitWorktrees = new Map();
      const priorSessionIds = new Set();
      const completedWorkerAssignmentsByNode = new Map();

      const currentSnapshot = loopStore.getRun(runId);
      const allIntents = loopStore.listIntegrationIntents(runId);
      const intentsByAttempt = new Map(allIntents.map(i => [`${i.nodeId}:${i.attemptId}`, i]));

      // P1 #9: Reconcile postIntegrationHeadSha from latest promoted intent whenever stored value is missing or stale
      const latestPromoted = [...allIntents].reverse().find(i => i.status === 'promoted' && i.postIntegrationHeadSha);
      if (latestPromoted && currentSnapshot.provenance?.source && currentSnapshot.provenance.source.postIntegrationHeadSha !== latestPromoted.postIntegrationHeadSha) {
        loopStore.updateRunAtomic(runId, (r) => {
          if (r.provenance?.source && r.provenance.source.postIntegrationHeadSha !== latestPromoted.postIntegrationHeadSha) {
            r.provenance.source.postIntegrationHeadSha = latestPromoted.postIntegrationHeadSha;
          }
          return r;
        });
      }

      for (const nId of compiled.order) {
        const nodeDef = compiled.nodeMap.get(nId);
        for (const a of (currentSnapshot.nodeAttempts?.[nId] || [])) {
          if (a.sessionId) priorSessionIds.add(a.sessionId);
        }
        const selId = currentSnapshot.selectedAttempts?.[nId];
        if (selId) {
          const att = (currentSnapshot.nodeAttempts?.[nId] || []).find(a => a.attemptId === selId);
          if (att?.terminalStatus === 'succeeded') {
            completedNodes.add(nId);
            // P1 #3: Reconstruct contributing worker assignment directly from the persisted selected attempt!
            if (nodeDef.kind === 'agent') {
              const persistedAssignment = att.assignment || currentSnapshot.pin?.modelQuantRecord?.[nId] || null;
              if (persistedAssignment) {
                completedWorkerAssignmentsByNode.set(nId, persistedAssignment);
              }
            }
            if (nodeDef.workspace === 'worktree') {
              const intent = intentsByAttempt.get(`${nId}:${selId}`);
              if (!intent || intent.status !== 'promoted') {
                pendingGitWorktrees.set(nId, {
                  nodeId: nId,
                  attemptId: selId,
                  worktreePath: att._worktreePath || null,
                  subtaskBranch: att._subtaskBranch || null,
                  commitSha: att.commitSha || intent?.preparedCommitSha || null,
                });
              }
            }
          }
        }
      }

      const failOrFlagRun = (verdict, reasonCode) => {
        return loopStore.updateRunAtomic(runId, (r) => {
          if (r.phase === 'terminal') return r;
          if ((abortController.signal.aborted || r.phase === 'cancelling') && (verdict === 'passed' || verdict === 'completed_unverified')) {
            r.phase = 'terminal';
            r.verdict = 'cancelled';
            r.reasonCode = 'CANCELLED';
          } else {
            r.phase = 'terminal';
            r.verdict = verdict;
            r.reasonCode = reasonCode;
          }
          r.provenance.endedAt = new Date().toISOString();
          return r;
        });
      };

      const flushPendingGitWorktrees = async (targetIds, barrierNode = null) => {
        if (targetIds.length === 0) return;
        const orderedIds = [...targetIds].sort((a, b) => compiled.order.indexOf(a) - compiled.order.indexOf(b));
        const runForBarrier = loopStore.getRun(runId);
        if (barrierNode) {
          validateFanIn(runForBarrier, barrierNode, orderedIds, {
            loopStore,
            manifest,
            sourceSha: runForBarrier.provenance?.source?.baseSha || null,
          });
        }
        const gitBatch = orderedIds.map(id => pendingGitWorktrees.get(id)).filter(Boolean);
        await integrateGitGroup(runId, gitBatch, {
          projectDir,
          checkFence: () => !abortController.signal.aborted && loopStore.getRun(runId).phase === 'running',
          crashAfterFirstMerge: simulateCrashAfterMerge,
        });
        for (const id of orderedIds) pendingGitWorktrees.delete(id);
      };

      try {
        while (completedNodes.size < compiled.order.length) {
          const snap = loopStore.getRun(runId);
          if (abortController.signal.aborted || snap.phase === 'cancelling') {
            return failOrFlagRun('cancelled', 'CANCELLED');
          }

          const ready = compiled.order.filter(id =>
            !completedNodes.has(id)
            && (compiled.nodeMap.get(id).dependsOn || []).every(d => completedNodes.has(d))
          );

          if (ready.length === 0) {
            return failOrFlagRun('flagged', 'FAN_IN_SHORTFALL');
          }

          const neededGitIds = [];
          for (const id of ready) {
            const node = compiled.nodeMap.get(id);
            for (const dep of (node.dependsOn || [])) {
              if (pendingGitWorktrees.has(dep) && !neededGitIds.includes(dep)) {
                neededGitIds.push(dep);
              }
            }
          }
          if (neededGitIds.length > 0) {
            await flushPendingGitWorktrees(neededGitIds, compiled.nodeMap.get(ready[0]));
          }

          const executeSingleNode = async (nodeId) => {
            const node = compiled.nodeMap.get(nodeId);
            const runSnap = loopStore.getRun(runId);

            let upstreamAttempts = [];
            if ((node.dependsOn || []).length > 0) {
              upstreamAttempts = validateFanIn(runSnap, node, node.dependsOn, {
                loopStore,
                manifest,
                sourceSha: runSnap.provenance?.source?.baseSha || null,
              });
            }

            const currentSourceSha = runSnap.provenance?.source?.postIntegrationHeadSha
              || runSnap.provenance?.source?.baseSha
              || null;
            const depVer = computeDependencyVersion({
              manifestHash: runSnap.pin.manifestHash,
              nodeId,
              upstreamAttempts,
              sourceSha: currentSourceSha,
            });

            let promptBytes = null;
            let promptSha256 = null;
            if (node.kind === 'agent' || node.kind === 'check' || node.kind === 'verify') {
              promptBytes = renderLoopPrompt(node.prompt, runSnap.pin.params);
              const promptRef = loopStore.writeArtifactBytes(`prompts/${runId}/${nodeId}.txt`, promptBytes);
              promptSha256 = promptRef.sha256;
            }

            let lastErr = null;
            for (let ordinal = 1; ordinal <= 2; ordinal++) {
              if (abortController.signal.aborted || loopStore.getRun(runId).phase === 'cancelling') {
                throw new LoopError('CANCELLED', 'Run cancelled');
              }

              const attemptId = `att_${nodeId}_${ordinal}_${randomUUID().slice(0, 6)}`;
              let claimGen = 0;
              loopStore.updateRunAtomic(runId, (r) => {
                r._claimGenerations = r._claimGenerations || {};
                claimGen = (r._claimGenerations[nodeId] || 0) + 1;
                r._claimGenerations[nodeId] = claimGen;
                r.nodeAttempts[nodeId] = r.nodeAttempts[nodeId] || [];
                r.nodeAttempts[nodeId].push({
                  nodeId,
                  attemptId,
                  ordinal,
                  runId,
                  kind: node.kind,
                  fenceToken: claimGen,
                  dependencyVersion: depVer,
                  inputsSourceSha: currentSourceSha,
                  terminalStatus: null,
                  startedAt: new Date().toISOString(),
                  endedAt: null,
                  inputs: upstreamAttempts.map(u => ({
                    nodeId: u.nodeId,
                    attemptId: u.attemptId,
                    dependencyVersion: u.dependencyVersion,
                  })),
                  outputs: [],
                  ...(promptSha256 ? { promptSha256 } : {}),
                });
                return r;
              });

              const updateAttempt = (extra) => {
                loopStore.updateRunAtomic(runId, (r) => {
                  const att = (r.nodeAttempts[nodeId] || []).find(a => a.attemptId === attemptId);
                  if (att) Object.assign(att, extra);
                  return r;
                });
              };
              const finishAttempt = (status, extra = {}) => updateAttempt({
                terminalStatus: status, endedAt: new Date().toISOString(), ...extra,
              });

              try {
                if (node.kind === 'agent' || node.kind === 'check' || node.kind === 'verify') {
                  if (typeof dispatchVerbatim !== 'function') {
                    throw new LoopError('NO_DISPATCH_ADAPTER', 'No verbatim provider dispatch adapter configured');
                  }
                  let assignment;
                  let sessionId = null;
                  let readOnly = node.workspace === 'read-only';

                  if (node.kind === 'agent') {
                    assignment = runSnap.pin.modelQuantRecord[nodeId];
                    if (!assignment) throw new LoopError('PIN_MISSING', `No pinned assignment for agent node "${nodeId}"`);
                    const liveDef = agentsMap[assignment.agentId];
                    if (liveDef && (liveDef.provider !== assignment.provider || liveDef.model !== assignment.model)) {
                      throw new LoopError('PIN_VIOLATED', `Agent "${assignment.agentId}" drifted from pinned ${assignment.provider}/${assignment.model}`);
                    }
                    sessionId = randomUUID();
                    priorSessionIds.add(sessionId);
                  } else {
                    const predSet = compiled.predecessors.get(nodeId) || new Set();
                    const contributingWorkers = [...completedWorkerAssignmentsByNode.entries()]
                      .filter(([wNodeId]) => predSet.has(wNodeId))
                      .map(([, wa]) => wa);
                    const checker = resolveChecker(node, runSnap.provenance?.rosterSnapshot, contributingWorkers, {
                      agentsMap,
                      priorSessionIds,
                    });
                    assignment = checker;
                    sessionId = checker.sessionId;
                    priorSessionIds.add(sessionId);
                    readOnly = true;
                    loopStore.updateRunAtomic(runId, (r) => {
                      r.pin.modelQuantRecord[nodeId] = {
                        agentId: checker.agentId,
                        agentInstanceId: checker.agentInstanceId,
                        provider: checker.provider,
                        model: checker.model,
                        modelClass: checker.modelClass,
                        quant: checker.quant,
                      };
                      return r;
                    });
                  }

                  const agent = agentsMap[assignment.agentId];
                  updateAttempt({
                    assignment: {
                      agentId: assignment.agentId,
                      agentInstanceId: assignment.agentInstanceId || assignment.agentId,
                      provider: assignment.provider,
                      model: assignment.model,
                      quant: assignment.quant ?? null,
                      harness: agent?.harness ?? agent?.harnessId ?? null,
                    },
                  });
                  let workingDir;
                  let worktreeObj = null;
                  const workerBaseSha = currentSourceSha || 'HEAD';
                  if (node.workspace === 'worktree') {
                    if (!projectDir) {
                      throw new LoopError('WORKTREE_UNAVAILABLE', `Worktree workspace requested for "${nodeId}" without projectDir`);
                    }
                    worktreeObj = createSubtaskWorktree({
                      projectDir,
                      subtaskId: `${runId}-${nodeId}`,
                      attemptId,
                      baseBranch: workerBaseSha,
                    });
                    workingDir = worktreeObj.worktreePath;
                  } else if (node.workspace === 'node-dir') {
                    workingDir = join(baseRunsDir, scopeDirName, runId, nodeId, attemptId);
                    mkdirSync(workingDir, { recursive: true });
                  } else if (node.workspace === 'shared') {
                    workingDir = join(baseRunsDir, scopeDirName, runId, 'shared');
                    mkdirSync(workingDir, { recursive: true });
                  } else {
                    if (currentSourceSha) {
                      if (!projectDir || !existsSync(join(projectDir, '.git'))) {
                        throw new LoopError('CHECKER_REPO_MISSING', `Read-only checker "${nodeId}" requires Git repo for pinned SHA ${currentSourceSha}`);
                      }
                      workingDir = mkdtempSync(join(tmpdir(), `synapse-checker-${nodeId}-`));
                      runGit(projectDir, ['worktree', 'add', '--detach', workingDir, currentSourceSha]);
                    } else {
                      workingDir = projectDir || join(baseRunsDir, scopeDirName, runId, 'readonly');
                    }
                  }

                  if (worktreeObj || (node.workspace === 'read-only' && currentSourceSha)) {
                    updateAttempt({ _worktreePath: workingDir });
                  }

                  const beforeFiles = (node.workspace === 'shared') ? new Set(scanRelativeFiles(workingDir)) : new Set();

                  let dispatchRes;
                  const cleanupIsolatedChecker = Boolean(node.workspace === 'read-only' && currentSourceSha && projectDir && workingDir !== projectDir);
                  try {
                    let nativeHandled = false;
                    if (node.kind === 'agent' && node.nativeDelegation && typeof node.nativeDelegation === 'object' && node.workspace === 'worktree' && projectDir) {
                      const liveDef = agentsMap[assignment.agentId];
                      const { executeNativeDelegation } = await import('./orchestrator/native-delegation.js');
                      const resolvedHarnessReg = harnessRegistry || await import('./harnesses/registry.js');
                      const nativeRes = await executeNativeDelegation(
                        {
                          request: {
                            mode: node.nativeDelegation.mode,
                            maxWorkers: node.nativeDelegation.maxWorkers,
                            prompt: promptBytes.toString('utf8'),
                            subtaskId: `${runId}-${nodeId}`,
                            projectId: runSnap.provenance?.scope?.projectId || null,
                          },
                          attempt: { attemptId, subtaskId: `${runId}-${nodeId}`, agentId: assignment.agentId, projectId: runSnap.provenance?.scope?.projectId || null },
                          signal: abortController.signal,
                        },
                        {
                          poolArbiter,
                          spawnNativeProcess,
                          projectDir,
                          targetBranch: workerBaseSha,
                          integrate: false,
                          checkFence: () => loopStore.getRun(runId)?.phase === 'running',
                          resolveAgent: () => liveDef ? { id: assignment.agentId, ...liveDef } : null,
                          harnessRegistry: resolvedHarnessReg,
                          resolveVerifiedRuntime,
                          runContext: {
                            runKind: 'loop_node',
                            nodeKind: node.kind,
                            isLeaf: true,
                            staticSchedulerProvenance: true,
                            loopId: manifest.loopId,
                            nodeId,
                            delegationDepth: 0,
                            fromPromptText: false,
                            gitWriteSubtree: runSnap.provenance?.scope?.gitWriteSubtree || null,
                          },
                          projectRoster: runSnap.provenance?.rosterSnapshot || null,
                          projectPolicy: (() => {
                            // P1 #6: Resolve project from top-level projectId OR provenance.scope.projectId and FAIL CLOSED if missing!
                            const sp = runSnap.projectId || runSnap.provenance?.scope?.projectId || null;
                            const pc = sp && stateManager?.getProject ? stateManager.getProject(sp) : null;
                            return pc
                              ? { allowNativeDelegation: pc.allowNativeDelegation !== false }
                              : { allowNativeDelegation: false };
                          })(),
                        }
                      );
                      if (nativeRes.kind === 'succeeded') {
                        dispatchRes = { text: `native_delegation:${nativeRes.nativeHeadSha}`, nativeDelegation: nativeRes };
                        nativeHandled = true;
                      } else if (nativeRes.kind === 'stopped') {
                        throw new LoopError(nativeRes.code || 'NATIVE_DELEGATION_STOPPED', nativeRes.message || `Native delegation stopped (${nativeRes.code})`);
                      }
                      // kind === 'fallback' falls through cleanly to standard Synapse dispatchVerbatim
                    }
                    if (!nativeHandled) {
                      dispatchRes = await dispatchVerbatim({
                        runId,
                        nodeId,
                        attemptId,
                        ordinal,
                        assignment,
                        promptBytes: Buffer.from(promptBytes),
                        promptSha256,
                        workingDir,
                        sessionId,
                        readOnly,
                        timeoutMs: node.timeoutMs,
                        signal: abortController.signal,
                        inputs: upstreamAttempts,
                        sourceSha: currentSourceSha,
                      });
                    }
                  } finally {
                    if (cleanupIsolatedChecker) {
                      try { runGit(projectDir, ['worktree', 'remove', '--force', workingDir]); } catch {}
                      try { rmSync(workingDir, { recursive: true, force: true }); } catch {}
                    }
                  }

                  const declaredOuts = (node.outputs || []).map(o => ({
                    path: normalizeSafeRelativePath(o.path),
                    storage: o.storage,
                  }));
                  const declaredSet = new Set(declaredOuts.map(o => o.path));
                  const recordedRefs = [];
                  let commitSha = null;

                  if (node.workspace === 'worktree') {
                    try {
                      // P1 #10: Parse NUL-delimited status --porcelain -z -uall so R/C renames (2 paths) and special filenames are handled safely
                      const statusRaw = execFileSync('git', ['status', '--porcelain', '-z', '-uall'], {
                        cwd: workingDir,
                        stdio: ['ignore', 'pipe', 'pipe'],
                      }).toString('utf8');
                      const statusTokens = statusRaw.split('\0');
                      const touched = [];
                      for (let si = 0; si < statusTokens.length; si++) {
                        const entry = statusTokens[si];
                        if (!entry || entry.length < 4) continue;
                        const xy = entry.slice(0, 2);
                        const path1 = entry.slice(3);
                        touched.push(path1);
                        if (xy.includes('R') || xy.includes('C')) {
                          const path2 = statusTokens[++si];
                          if (path2) touched.push(path2);
                        }
                      }
                      for (const rel of touched) {
                        const full = join(workingDir, rel);
                        if (existsSync(full) && lstatSync(full).isSymbolicLink()) {
                          throw new LoopError('SYMLINK_ESCAPE', `Worker "${nodeId}" created symlink "${rel}"`);
                        }
                        const normRel = normalizeSafeRelativePath(rel);
                        if (!declaredSet.has(normRel)) {
                          throw new LoopError('UNDECLARED_WRITE', `Worker "${nodeId}" wrote undeclared path "${normRel}"`);
                        }
                        const runSubtree = runSnap.provenance?.scope?.gitWriteSubtree || null;
                        if (runSubtree && normRel !== runSubtree && !normRel.startsWith(`${runSubtree}/`)) {
                          throw new LoopError('SUBTREE_VIOLATION', `Worker "${nodeId}" wrote path "${normRel}" outside subdir subtree "${runSubtree}/"`);
                        }
                      }
                      runGit(workingDir, ['add', '-A']);
                      let hasStaged = false;
                      try {
                        execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: workingDir, stdio: 'ignore' });
                      } catch {
                        hasStaged = true;
                      }
                      if (hasStaged) {
                        runGit(workingDir, ['commit', '-m', `loop(${runId}): ${nodeId} ${attemptId}`]);
                      }
                      const auditRes = auditWorktreeCommitAgainstDeclared(
                        workingDir,
                        workerBaseSha,
                        declaredSet,
                        nodeId,
                        runSnap.provenance?.scope?.gitWriteSubtree || null
                      );

                      for (const o of declaredOuts) {
                        const abs = join(workingDir, o.path);
                        if (!existsSync(abs)) {
                          if (auditRes.deletedOrRenamedSources.has(o.path)) {
                            recordedRefs.push({ ...loopStore.writeArtifactBytes(o.path, Buffer.alloc(0)), deleted: true });
                            continue;
                          }
                          throw new LoopError('MISSING_OUTPUT', `Worker "${nodeId}" did not create declared output "${o.path}"`);
                        }
                        if (lstatSync(abs).isSymbolicLink()) {
                          throw new LoopError('SYMLINK_ESCAPE', `Worker "${nodeId}" declared output is a symlink: "${o.path}"`);
                        }
                        recordedRefs.push(loopStore.writeArtifactBytes(o.path, readFileSync(abs)));
                      }
                      commitSha = runGit(workingDir, ['rev-parse', 'HEAD']);
                    } catch (wtAuditErr) {
                      discardSubtaskWorktree({ projectDir, worktreePath: workingDir, subtaskBranch: worktreeObj.subtaskBranch });
                      throw wtAuditErr;
                    }

                    pendingGitWorktrees.set(nodeId, {
                      nodeId,
                      attemptId,
                      worktreePath: workingDir,
                      subtaskBranch: worktreeObj.subtaskBranch,
                      commitSha,
                    });
                    loopStore.recordIntegrationIntent({
                      runId, nodeId, attemptId,
                      stagingRef: `refs/heads/synapse/loop-stage/${runId}`,
                      preparedCommitSha: commitSha,
                      status: 'pending_integration',
                    });
                  } else if (node.workspace === 'node-dir' || node.workspace === 'shared') {
                    const afterFiles = scanRelativeFiles(workingDir);
                    const written = node.workspace === 'shared'
                      ? afterFiles.filter(f => !beforeFiles.has(f))
                      : afterFiles;
                    for (const rel of written) {
                      if (!declaredSet.has(rel)) {
                        throw new LoopError('UNDECLARED_WRITE', `Node "${nodeId}" wrote undeclared file "${rel}"`);
                      }
                    }
                    for (const o of declaredOuts) {
                      const abs = join(workingDir, o.path);
                      if (!existsSync(abs)) {
                        throw new LoopError('MISSING_OUTPUT', `Node "${nodeId}" missing declared output "${o.path}"`);
                      }
                      recordedRefs.push(loopStore.writeArtifactBytes(o.path, readFileSync(abs)));
                    }
                  } else if (node.workspace === 'read-only') {
                    const reportObj = dispatchRes?.review || dispatchRes?.json || dispatchRes;
                    const reportPath = declaredOuts[0]?.path || `${nodeId}-report.json`;
                    const reportBuf = Buffer.from(JSON.stringify(reportObj, null, 2) + '\n', 'utf8');
                    const reportRef = loopStore.writeArtifactBytes(reportPath, reportBuf);
                    recordedRefs.push(reportRef);

                    if (node.kind === 'check' || node.kind === 'verify') {
                      const disposition = reportObj?.disposition;
                      const reviewedSourceSha = reportObj?.reviewedSourceSha;
                      if (disposition !== 'approve') {
                        finishAttempt('failed', { sessionId, outputs: recordedRefs, errorCode: 'CHECKER_REJECTED', checkerVerdict: 'rejected' });
                        throw new LoopError('CHECKER_REJECTED', `Checker "${nodeId}" returned disposition="${disposition}"`, { statusCode: 409 });
                      }
                      const requireExplicitSha = Boolean(currentSourceSha) || (manifest.evidence?.mode === 'pr' && nodeId === manifest.evidence.checkerNodeId);
                      if (requireExplicitSha) {
                        if (!currentSourceSha || typeof reviewedSourceSha !== 'string' || reviewedSourceSha !== currentSourceSha) {
                          finishAttempt('failed', { sessionId, outputs: recordedRefs, errorCode: 'REVIEW_SHA_MISMATCH', checkerVerdict: 'sha_mismatch' });
                          throw new LoopError('REVIEW_SHA_MISMATCH', `Checker "${nodeId}" reviewedSourceSha "${reviewedSourceSha}" != "${currentSourceSha}"`);
                        }
                      }
                      updateAttempt({ checkerVerdict: 'approve' });
                      if (manifest.evidence?.mode === 'pr' && nodeId === manifest.evidence.checkerNodeId) {
                        loopStore.updateRunAtomic(runId, (r) => {
                          r._checkerReview = {
                            nodeId,
                            attemptId,
                            sessionId,
                            agentId: assignment.agentId,
                            agentInstanceId: assignment.agentInstanceId,
                            provider: assignment.provider,
                            model: assignment.model,
                            reviewedSourceSha,
                            disposition: 'approve',
                            report: reportRef,
                          };
                          return r;
                        });
                      }
                    }
                  }

                  finishAttempt('succeeded', {
                    sessionId,
                    outputs: recordedRefs,
                    ...(commitSha ? { commitSha } : {}),
                    ...(worktreeObj ? { _worktreePath: worktreeObj.worktreePath, _subtaskBranch: worktreeObj.subtaskBranch } : {}),
                  });
                  selectAttemptFenced(runId, nodeId, attemptId, claimGen);
                  if (node.kind === 'agent') {
                    completedWorkerAssignmentsByNode.set(nodeId, assignment);
                  }
                  return;
                }

                if (node.kind === 'reduce') {
                  const stagingDir = join(baseRunsDir, scopeDirName, runId, nodeId, attemptId);
                  const refs = executeReduce(node, upstreamAttempts, {
                    loopStore,
                    stagingDir,
                    run: loopStore.getRun(runId),
                    reducers,
                  });
                  finishAttempt('succeeded', { outputs: refs });
                  selectAttemptFenced(runId, nodeId, attemptId, claimGen);
                  return;
                }

                if (node.kind === 'anchor') {
                  const spec = compiled.anchorMap.get(node.anchorId);
                  const reg = anchorRunners[spec.runnerId];
                  if (!reg?.runnerPath) {
                    throw new LoopError('ANCHOR_RUNNER_MISSING', `No runner registered for "${spec.runnerId}"`);
                  }

                  let anchorSubjectDir = projectDir || baseRunsDir;
                  let isolatedAnchorDir = null;
                  if (currentSourceSha) {
                    if (!projectDir || !existsSync(join(projectDir, '.git'))) {
                      throw new LoopError('ANCHOR_REPO_MISSING', `Anchor "${spec.anchorId}" cannot verify pinned SHA ${currentSourceSha} without a Git repository`);
                    }
                    isolatedAnchorDir = mkdtempSync(join(tmpdir(), `synapse-anchor-${nodeId}-`));
                    runGit(projectDir, ['worktree', 'add', '--detach', isolatedAnchorDir, currentSourceSha]);
                    anchorSubjectDir = isolatedAnchorDir;
                  }

                  let anchorRes;
                  try {
                    const anchorArgs = typeof anchorArgsBuilder === 'function'
                      ? anchorArgsBuilder({ spec, node, run: loopStore.getRun(runId), projectDir: anchorSubjectDir, subjectDir: anchorSubjectDir })
                      : (reg.defaultArgs || []);

                    anchorRes = await runAnchor(spec, {
                      nodeId,
                      attemptId,
                      runnerPath: reg.runnerPath,
                      subjectDir: anchorSubjectDir,
                      subjectSha: currentSourceSha,
                      args: anchorArgs,
                      timeoutMs: node.timeoutMs,
                      signal: abortController.signal,
                      loopStore,
                    });
                  } finally {
                    if (isolatedAnchorDir) {
                      try { runGit(projectDir, ['worktree', 'remove', '--force', isolatedAnchorDir]); } catch {}
                      try { rmSync(isolatedAnchorDir, { recursive: true, force: true }); } catch {}
                    }
                  }

                  loopStore.updateRunAtomic(runId, (r) => {
                    r.anchors.push(anchorRes);
                    return r;
                  });

                  const emitCouncilLoopAnchor = (verdict) => {
                    const cSessId = runSnap.params?.councilSessionId || runSnap.provenance?.councilSessionId || null;
                    const cSynthDigest = runSnap.params?.councilSynthesisDigest || runSnap.provenance?.councilSynthesisDigest || null;
                    const cProjId = runSnap.projectId || runSnap.provenance?.scope?.projectId || null;
                    const aDigest = anchorRes.stdout?.sha256 || anchorRes.digest || null;
                    if (councilService?.recordAnchorOutcome && cProjId && cSessId && cSynthDigest && aDigest) {
                      try {
                        councilService.recordAnchorOutcome({
                          projectId: cProjId,
                          sessionId: cSessId,
                          synthesisDigest: cSynthDigest,
                          runKind: 'loop',
                          runId,
                          attemptId,
                          selectedAttemptId: attemptId,
                          anchorId: spec.anchorId,
                          evidenceRef: `loop:${runId}:anchor:${spec.anchorId}:${attemptId}`,
                          artifactDigest: aDigest,
                          verdict,
                        });
                      } catch {
                        // Non-blocking: anchor proof already persisted in LoopStore
                      }
                    }
                  };

                  if (anchorRes.outcome === 'passed') {
                    finishAttempt('succeeded', { outputs: [anchorRes.stdout] });
                    selectAttemptFenced(runId, nodeId, attemptId, claimGen);
                    emitCouncilLoopAnchor('pass');
                    return;
                  }
                  if (anchorRes.outcome === 'failed') {
                    finishAttempt('failed', { outputs: [anchorRes.stdout, anchorRes.stderr], errorCode: 'ANCHOR_ASSERTION_FAILED' });
                    emitCouncilLoopAnchor('fail');
                    throw new LoopError('ANCHOR_ASSERTION_FAILED', `Anchor "${spec.anchorId}" failed assertions (exit=${anchorRes.exitCode})`);
                  }
                  finishAttempt('failed', { outputs: [anchorRes.stdout, anchorRes.stderr], errorCode: 'ANCHOR_INDETERMINATE' });
                  throw new LoopError('ANCHOR_INDETERMINATE', `Anchor "${spec.anchorId}" outcome indeterminate (signal=${anchorRes.signal})`);
                }

                if (node.kind === 'http' || node.kind === 'webhook' || node.kind === 'shell') {
                  if (typeof executeEffect !== 'function') {
                    throw new LoopError('NO_EFFECT_ADAPTER', `No effect adapter configured for "${node.operationId}"`);
                  }
                  if (effectRegistry[node.operationId]?.digest && effectRegistry[node.operationId].digest !== node.implementationDigest) {
                    throw new LoopError('DIGEST_MISMATCH', `Effect "${node.operationId}" digest mismatch`);
                  }
                  const requestDigest = sha256Hex(canonicalJson({
                    operationId: node.operationId,
                    config: node.config || {},
                    params: runSnap.pin.params,
                    inputs: upstreamAttempts.map(u => ({ nodeId: u.nodeId, attemptId: u.attemptId })),
                  }));
                  const sideEffectKey = sha256Hex(canonicalJson({
                    runId,
                    nodeId,
                    operationId: node.operationId,
                    requestDigest,
                  }));

                  const { existed, receipt } = loopStore.reserveEffectReceipt({
                    sideEffectKey,
                    runId,
                    nodeId,
                    operationId: node.operationId,
                    requestDigest,
                  });

                  loopStore.updateRunAtomic(runId, (r) => {
                    const att = (r.nodeAttempts[nodeId] || []).find(a => a.attemptId === attemptId);
                    if (att) att.sideEffectKey = sideEffectKey;
                    return r;
                  });

                  if (existed && receipt.status === 'committed') {
                    const outRef = loopStore.writeArtifactBytes(
                      (node.outputs?.[0]?.path) || `${nodeId}-result.json`,
                      Buffer.from(JSON.stringify(receipt.response ?? { ok: true }), 'utf8')
                    );
                    finishAttempt('succeeded', { sideEffectKey, outputs: [outRef] });
                    selectAttemptFenced(runId, nodeId, attemptId, claimGen);
                    return;
                  }

                  if (node.effect === 'single-send' && existed && (receipt.status === 'reserved' || receipt.status === 'ambiguous')) {
                    loopStore.updateEffectReceipt(sideEffectKey, 'ambiguous', { error: 'Prior reservation unresolved (crash-safe replay block)' });
                    finishAttempt('failed', { sideEffectKey, errorCode: 'EFFECT_OUTCOME_UNKNOWN' });
                    throw new LoopError('EFFECT_OUTCOME_UNKNOWN', `Single-send effect "${nodeId}" has unresolved prior reservation (${receipt.status}) — blocking replay`);
                  }
                  if (node.effect === 'single-send' && existed && receipt.status === 'absent') {
                    loopStore.updateEffectReceipt(sideEffectKey, 'reserved', null);
                  }

                  try {
                    const effRes = await executeEffect({
                      runId,
                      nodeId,
                      attemptId,
                      ordinal,
                      operationId: node.operationId,
                      effect: node.effect,
                      sideEffectKey,
                      requestDigest,
                      config: node.config || {},
                      signal: abortController.signal,
                    });
                    loopStore.updateEffectReceipt(sideEffectKey, 'committed', effRes ?? { ok: true });
                    const outRef = loopStore.writeArtifactBytes(
                      (node.outputs?.[0]?.path) || `${nodeId}-result.json`,
                      Buffer.from(JSON.stringify(effRes ?? { ok: true }), 'utf8')
                    );
                    finishAttempt('succeeded', { sideEffectKey, outputs: [outRef] });
                    selectAttemptFenced(runId, nodeId, attemptId, claimGen);
                    return;
                  } catch (effErr) {
                    const provenAbsent = effErr?.dispatchProvenAbsent === true;
                    if (node.effect === 'single-send') {
                      if (provenAbsent) {
                        loopStore.updateEffectReceipt(sideEffectKey, 'absent', { error: effErr.message });
                        finishAttempt('failed', { sideEffectKey, errorCode: 'EFFECT_ABSENT' });
                        throw effErr;
                      }
                      loopStore.updateEffectReceipt(sideEffectKey, 'ambiguous', { error: effErr.message });
                      finishAttempt('failed', { sideEffectKey, errorCode: 'EFFECT_OUTCOME_UNKNOWN' });
                      throw new LoopError('EFFECT_OUTCOME_UNKNOWN', `Single-send effect "${nodeId}" outcome unknown: ${effErr.message}`);
                    }
                    if (node.effect === 'idempotency-key' && effErr?.simulatedCrashBeforeReceipt) {
                      finishAttempt('failed', { sideEffectKey, errorCode: 'CRASH_BEFORE_RECEIPT' });
                      throw effErr;
                    }
                    finishAttempt('failed', { sideEffectKey, errorCode: effErr.code || 'EFFECT_FAILED' });
                    throw effErr;
                  }
                }
              } catch (attemptErr) {
                lastErr = attemptErr;
                const postSnap = loopStore.getRun(runId);
                const att = (postSnap.nodeAttempts?.[nodeId] || []).find(a => a.attemptId === attemptId);
                if (att && !att.terminalStatus) {
                  const errorCode = attemptErr.code || 'EXECUTION_ERROR';
                  const evictionReason = errorCode === 'POOL_EVICTED' || errorCode === 'pool_eviction_tripped'
                    ? errorCode : classifyExitSignal(attemptErr).isExit143 ? 'exit_143' : null;
                  finishAttempt('failed', { errorCode, ...(evictionReason ? { evictionReason } : {}) });
                }

                const nonRetryable = new Set([
                  'FAN_IN_SHORTFALL',
                  'INDEPENDENCE_UNAVAILABLE',
                  'CHECKER_REJECTED',
                  'REVIEW_SHA_MISMATCH',
                  'ANCHOR_ASSERTION_FAILED',
                  'ANCHOR_INDETERMINATE',
                  'ANCHOR_DIGEST_MISMATCH',
                  'EFFECT_OUTCOME_UNKNOWN',
                  'UNDECLARED_WRITE',
                  'SYMLINK_ESCAPE',
                  'PATH_ESCAPE',
                  'PIN_VIOLATED',
                  'INTEGRATION_CONFLICT',
                  'STALE_SOURCE_SHA',
                  'SIMULATED_CRASH_POST_MERGE',
                  'CANCELLED',
                  'DIGEST_MISMATCH',
                ]);
                if (nonRetryable.has(attemptErr.code) || ordinal === 2) {
                  throw attemptErr;
                }
              }
            }
            throw lastErr;
          };

          let batchFirstErr = null;
          const results = await Promise.allSettled(ready.map(async (id) => {
            try {
              await executeSingleNode(id);
              completedNodes.add(id);
            } catch (e) {
              if (!batchFirstErr) {
                batchFirstErr = e;
                abortController.abort();
              }
              throw e;
            }
          }));

          const rejected = results.find(r => r.status === 'rejected');
          if (rejected) {
            throw batchFirstErr || rejected.reason;
          }
        }

        if (pendingGitWorktrees.size > 0) {
          await flushPendingGitWorktrees([...pendingGitWorktrees.keys()], null);
        }

        const finalSnap = loopStore.getRun(runId);
        if (abortController.signal.aborted || finalSnap.phase === 'cancelling') {
          return failOrFlagRun('cancelled', 'CANCELLED');
        }

        const declaredAnchors = manifest.anchors || [];
        if (declaredAnchors.length === 0) {
          return failOrFlagRun('completed_unverified', 'NO_ANCHORS_DECLARED');
        }

        const passedAnchorIds = new Set(
          (finalSnap.anchors || [])
            .filter(a => a.outcome === 'passed' && finalSnap.selectedAttempts?.[a.nodeId] === a.attemptId)
            .map(a => a.anchorId)
        );
        for (const spec of declaredAnchors) {
          if (!passedAnchorIds.has(spec.anchorId)) {
            return failOrFlagRun('flagged', 'MISSING_ANCHOR_PROOF');
          }
        }

        if (manifest.evidence?.mode === 'pr') {
          return loopStore.updateRunAtomic(runId, (r) => {
            if (abortController.signal.aborted || r.phase === 'cancelling') {
              r.phase = 'terminal'; r.verdict = 'cancelled'; r.reasonCode = 'CANCELLED';
              r.provenance.endedAt = new Date().toISOString();
              return r;
            }
            r.phase = 'awaiting_approval';
            r.provenance.executionEndedAt = new Date().toISOString();
            r.verdict = null;
            r.reasonCode = null;
            return r;
          });
        }

        return failOrFlagRun('passed', null);
      } catch (err) {
        if (err.code === 'SIMULATED_CRASH_POST_MERGE') {
          throw err;
        }
        for (const wt of pendingGitWorktrees.values()) {
          if (projectDir && wt.worktreePath && existsSync(wt.worktreePath)) {
            try { discardSubtaskWorktree({ projectDir, worktreePath: wt.worktreePath, subtaskBranch: wt.subtaskBranch }); } catch {}
          }
        }
        const definitiveFailCodes = new Set([
          'ANCHOR_ASSERTION_FAILED',
          'CHECKER_REJECTED',
          'INTEGRATION_CONFLICT',
          'UNDECLARED_WRITE',
          'SYMLINK_ESCAPE',
          'PATH_ESCAPE',
        ]);
        if (err.code === 'CANCELLED') {
          return failOrFlagRun('cancelled', 'CANCELLED');
        }
        if (definitiveFailCodes.has(err.code)) {
          return failOrFlagRun('failed', err.code);
        }
        return failOrFlagRun('flagged', err.code || 'RETRY_EXHAUSTED');
      } finally {
        activeAbortControllers.delete(runId);
        activeRunPromises.delete(runId);
        try { loopStore.releaseRunExecution(runId, executionOwnerToken); } catch {}
      }
    })();

    activeRunPromises.set(runId, runPromise);
    return runPromise;
  }

  async function cancelRun(runId) {
    const run = loopStore.getRun(runId);
    if (!run) throw new LoopError('RUN_NOT_FOUND', `Run "${runId}" not found`, { statusCode: 404 });
    if (run.phase === 'terminal') return run;

    loopStore.updateRunAtomic(runId, (r) => {
      if (r.phase !== 'terminal') r.phase = 'cancelling';
      return r;
    });

    const ac = activeAbortControllers.get(runId);
    if (ac) ac.abort();

    const p = activeRunPromises.get(runId);
    if (p) {
      try { await p; } catch {}
    }

    return loopStore.updateRunAtomic(runId, (r) => {
      if (r.phase !== 'terminal') {
        r.phase = 'terminal';
        r.verdict = 'cancelled';
        r.reasonCode = 'CANCELLED';
        r.provenance.endedAt = new Date().toISOString();
      }
      return r;
    });
  }

  return {
    publish,
    startRun,
    executeRun,
    cancelRun,
    selectAttemptFenced,
    integrateGitGroup,
  };
}
