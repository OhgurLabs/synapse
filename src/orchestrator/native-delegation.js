/**
 * Declarative BYOH Native `/swarm` & `/teamwork` Delegation Gate & Execution Boundary
 * (Phase 3 Stage A — Pillar 2, hardened per GPT-6.2 Sol Round 1 review).
 *
 * Enforces all 4 Anti-Split-Brain Invariants:
 *  1. Leaf / 1-Level Exclusion
 *     - `/teamwork` ONLY on 1-node standalone `oneshot` or `verbatim` run outside campaigns
 *     - `/swarm` ONLY on executable leaf subtasks or static Loop `agent` nodes (with static scheduler provenance!)
 *     - Depth 0 only; recursion forbidden; prompt text NEVER activates native delegation
 *  2. Single-Branch Output Contract
 *     - Attempt-owned worktree via `createSubtaskWorktree`
 *     - Strict `verifyNativeWorktreeOutput` BEFORE `integrateSubtaskWorktree`
 *       (canonical `--git-common-dir` match, clean index/worktree, exact assigned branch,
 *        descended committed HEAD, full-range `PROTECTED_VAULT_PATH_RE` + POSIX subtree check,
 *        symmetric diff of pre/post refs catching creations, mutations, AND deletions)
 *     - Recheck `!signal.aborted`, persisted attempt fence, & verified HEAD under `withRepoIntegrationLock`
 *  3. Pre-Spawn `K`-Slot Pool Reservation & Quiescence Stop
 *     - `K = maxWorkers`; leader counted inside `K` if `leaderConsumesSlot`
 *     - Reserve exact `K` slots on `resolveAgentPoolKey(agent)` BEFORE spawn
 *     - Fail-closed pre-spawn refusal returns `{ kind: 'fallback', code }` (zero native spawn)
 *     - Runner-owned exit barrier (`quiescencePromise`) is REQUIRED once spawned;
 *       if barrier is missing or rejects, `K` slots stay held (fail-closed, no early release!)
 *     - Numeric `143` trips pool eviction IMMEDIATELY when observed (at most once) while
 *       still holding `K` slots until the exit barrier resolves; `exitCode: null` stays `local_signal_exempt`
 *  4. Role & Identity Integrity
 *     - Resolve agent, harness descriptor, verified runtime, project routing policy, and
 *       scheduler topology strictly from authoritative `deps` (NEVER trust caller `request` claims!)
 *     - Reject `governor` agents (both agent definition and project roster)
 *     - Run `assertGeminiTransport(agent, projectRoutingPolicy)` on EVERY native AND fallback dispatch
 *     - Decision 002: fallback route change requires a distinct canonical agent ID from the effective project roster
 *     - Native internal reviews have worker provenance; `isIndependentReviewEvidence` fails closed unless
 *       positive reviewer identity, distinct canonical backing provider, and trusted evidence are present.
 */

import { createHash, randomUUID } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from '../logger.js';
import { validateNativeDelegationMode } from '../harnesses/descriptor-schema.js';
import { assertGeminiTransport, loadRoutingPolicy } from '../agents/routing-policy.js';
import { resolveAgentPoolKey } from './execution-contract.js';
import {
  createSubtaskWorktree,
  discardSubtaskWorktree,
  integrateSubtaskWorktree,
  withRepoIntegrationLock,
  snapshotGitRefs,
  verifyNativeWorktreeOutput,
} from './git-worktrees.js';
import { isGovernorAgent, resolveBackingProviderKey } from './council.js';
import { rosterAllowsAgentAnyRole } from '../roster.js';

const log = createLogger('native-delegation');

export const NATIVE_DELEGATION_MODES = Object.freeze(['swarm', 'teamwork']);
const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * Compute authoritative host runtime build proof bound to the exact executable path on disk.
 */
export function buildHostVerifiedRuntime({
  executablePath,
  version,
  canBoundInnerSessions = false,
  canPropagateCancel = false,
  canScopeCredentials = false,
} = {}) {
  if (typeof executablePath !== 'string' || !executablePath.trim() || !existsSync(executablePath)) {
    return null;
  }
  const canonicalPath = realpathSync(executablePath);
  const bytes = readFileSync(canonicalPath);
  const executableSha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    executablePath: canonicalPath,
    version: String(version || ''),
    executableSha256,
    canBoundInnerSessions: canBoundInnerSessions === true,
    canPropagateCancel: canPropagateCancel === true,
    canScopeCredentials: canScopeCredentials === true,
    hostVerified: true,
  };
}

/**
 * Pure, side-effect-free eligibility gate (zero writes, zero slot reservations).
 *
 * Returns:
 *   { kind: 'eligible', plan: NativePlan } | { kind: 'refused', code: string, message: string }
 */
export function evaluateNativeDelegationEligibility({
  mode,
  maxWorkers,
  runContext,
  agent,
  descriptor,
  verifiedRuntime = null,
  projectPolicy = null,
  projectRoster = null,
  routingPolicy = {},
} = {}) {
  const refuse = (code, message) => ({ kind: 'refused', code, message });

  if (!NATIVE_DELEGATION_MODES.includes(mode)) {
    return refuse('INVALID_MODE', `Unsupported native delegation mode "${mode}"`);
  }

  // Invariant 1: Explicit option only — prompt text NEVER activates native delegation!
  if (!runContext || typeof runContext !== 'object') {
    return refuse('UNKNOWN_TOPOLOGY', 'Persisted scheduler runContext is required');
  }
  if (runContext.fromPromptText === true) {
    return refuse('PROMPT_TRIGGER_FORBIDDEN', 'Verbatim prompt text can never activate native delegation');
  }
  if (runContext.delegationDepth !== 0) {
    return refuse('RECURSION_FORBIDDEN', `Native delegation requires delegationDepth=0 (got ${runContext.delegationDepth})`);
  }

  if (mode === 'teamwork') {
    const validKind = runContext.runKind === 'oneshot' || runContext.runKind === 'verbatim';
    if (!validKind || runContext.inCampaign !== false || runContext.executableNodeCount !== 1) {
      return refuse(
        'TEAMWORK_TOPOLOGY_FORBIDDEN',
        '/teamwork is permitted ONLY on a 1-node standalone oneshot/verbatim run outside every campaign'
      );
    }
  } else if (mode === 'swarm') {
    const isLeafSubtask = runContext.runKind === 'subtask' && runContext.isLeaf === true;
    const isLeafLoopAgent = runContext.runKind === 'loop_node'
      && runContext.nodeKind === 'agent'
      && runContext.isLeaf === true
      && runContext.staticSchedulerProvenance === true
      && typeof runContext.loopId === 'string' && runContext.loopId.trim().length > 0
      && typeof runContext.nodeId === 'string' && runContext.nodeId.trim().length > 0;
    if (!isLeafSubtask && !isLeafLoopAgent) {
      return refuse(
        'SWARM_TOPOLOGY_FORBIDDEN',
        '/swarm is permitted ONLY on executable leaf subtasks or static Loop agent nodes with scheduler provenance'
      );
    }
  }

  // Optional project policy opt-out
  if (projectPolicy && projectPolicy.allowNativeDelegation === false) {
    return refuse('PROJECT_POLICY_DENIED', 'Project policy disables native delegation');
  }

  // Invariant 4: Governor exclusion (agent def + roster) + Gemini Antigravity-only transport check!
  if (!agent || typeof agent !== 'object') {
    return refuse('AGENT_MISSING', 'Agent identity is required');
  }
  const canonicalAgentId = typeof agent.id === 'string' && agent.id.trim() ? agent.id.trim() : null;
  if (!canonicalAgentId) {
    return refuse('AGENT_MISSING', 'Canonical agent.id is required');
  }
  if (isGovernorAgent(agent)) {
    return refuse('GOVERNOR_EXCLUDED', `Governor agent "${canonicalAgentId}" cannot run native delegation`);
  }
  if (projectRoster) {
    if (projectRoster?.roles?.governor?.agents?.includes(canonicalAgentId)) {
      return refuse('GOVERNOR_EXCLUDED', `Roster governor agent "${canonicalAgentId}" cannot run native delegation`);
    }
    if (!rosterAllowsAgentAnyRole(projectRoster, canonicalAgentId, agent)) {
      return refuse('ROSTER_EXCLUDED', `Agent "${canonicalAgentId}" is not in the effective project roster`);
    }
  }
  try {
    assertGeminiTransport(agent, routingPolicy || {});
  } catch (err) {
    return refuse(err?.code || 'GEMINI_TRANSPORT_BLOCKED', err.message);
  }

  // Closed descriptor capability check (fail closed when null / missing / malformed)
  const rawModeSpec = descriptor?.capabilities?.nativeDelegation?.[mode] ?? null;
  if (!rawModeSpec) {
    return refuse('NATIVE_DELEGATION_UNAVAILABLE', `Harness "${descriptor?.id || 'unknown'}" has no build-verified nativeDelegation.${mode} capability`);
  }
  const validated = validateNativeDelegationMode(rawModeSpec, `nativeDelegation.${mode}`);
  if (!validated.ok || !validated.mode) {
    return refuse('INVALID_DESCRIPTOR_CAPABILITY', validated.errors.join('; '));
  }
  const modeSpec = validated.mode;

  // Verified runtime build proof & host enforcement check (bound to exact executable, zero drift!)
  if (!verifiedRuntime || typeof verifiedRuntime !== 'object') {
    return refuse('RUNTIME_UNVERIFIED', 'Verified runtime build proof is required');
  }
  if (typeof verifiedRuntime.executablePath !== 'string' || !verifiedRuntime.executablePath.trim()) {
    return refuse('RUNTIME_UNVERIFIED', 'Verified runtime proof must bind an exact executablePath');
  }
  if (
    verifiedRuntime.version !== modeSpec.verifiedBuild.version
    || verifiedRuntime.executableSha256 !== modeSpec.verifiedBuild.executableSha256
  ) {
    return refuse(
      'BUILD_DRIFT',
      `Runtime build (${verifiedRuntime.version}/${verifiedRuntime.executableSha256}) != verifiedBuild (${modeSpec.verifiedBuild.version}/${modeSpec.verifiedBuild.executableSha256})`
    );
  }
  // If the bound executable exists on disk, re-verify its sha256 directly to prevent forged build claims!
  if (existsSync(verifiedRuntime.executablePath)) {
    const actualSha = createHash('sha256').update(readFileSync(verifiedRuntime.executablePath)).digest('hex');
    if (actualSha !== modeSpec.verifiedBuild.executableSha256) {
      return refuse('BUILD_DRIFT', `Executable "${verifiedRuntime.executablePath}" sha256 drifted from verifiedBuild`);
    }
  } else if (verifiedRuntime.allowVirtualExecutableForTest !== true) {
    return refuse('RUNTIME_EXECUTABLE_MISSING', `Verified executable "${verifiedRuntime.executablePath}" does not exist on host`);
  }

  if (verifiedRuntime.canBoundInnerSessions !== true) {
    return refuse('ENFORCEMENT_MISSING_BOUND', 'Runtime cannot enforce hard concurrent inner session bound');
  }
  if (verifiedRuntime.canPropagateCancel !== true) {
    return refuse('ENFORCEMENT_MISSING_CANCEL', 'Runtime cannot enforce owned process-tree cancellation exit barrier');
  }
  if (verifiedRuntime.canScopeCredentials !== true) {
    return refuse('ENFORCEMENT_MISSING_CREDENTIALS', 'Runtime cannot enforce attempt-scoped single-identity credentials');
  }

  // Invariant 3: Validated slot math (`K = maxWorkers`, leader counted if billable!)
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
    return refuse('INVALID_MAX_WORKERS', `maxWorkers must be a positive integer (got ${maxWorkers})`);
  }
  if (maxWorkers > modeSpec.maxWorkers) {
    return refuse('MAX_WORKERS_EXCEEDS_DESCRIPTOR', `Requested maxWorkers (${maxWorkers}) exceeds descriptor ceiling (${modeSpec.maxWorkers})`);
  }
  const K = maxWorkers;
  const innerLimit = modeSpec.leaderConsumesSlot ? K - 1 : K;
  if (innerLimit < 1) {
    return refuse(
      'INSUFFICIENT_INNER_SLOTS',
      `leaderConsumesSlot=true with K=${K} leaves innerLimit=${innerLimit} (< 1); increase maxWorkers or use Synapse scheduling`
    );
  }

  const invocationArgv = modeSpec.invocation.argv.map(arg => arg.replace(/\{innerLimit\}/g, String(innerLimit)));
  const poolKey = resolveAgentPoolKey(agent);

  return {
    kind: 'eligible',
    plan: {
      mode,
      K,
      innerLimit,
      leaderConsumesSlot: modeSpec.leaderConsumesSlot,
      poolKey,
      agentId: canonicalAgentId,
      harnessId: descriptor.id,
      provider: agent.provider || 'unknown',
      backingProviderKey: resolveBackingProviderKey(agent),
      model: agent.model || 'unknown',
      executablePath: verifiedRuntime.executablePath,
      verifiedBuild: { ...modeSpec.verifiedBuild },
      invocationArgv,
      promptInput: 'stdin',
    },
  };
}

function cleanupAttemptWorktree({ projectDir, worktreePath, subtaskBranch }) {
  try {
    discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch });
  } catch {
    try {
      execFileSync('git', ['checkout', '-f', subtaskBranch], { cwd: worktreePath, stdio: 'ignore' });
    } catch {}
    try {
      discardSubtaskWorktree({ projectDir, worktreePath, subtaskBranch });
    } catch {}
  }
}

/**
 * Execute a native delegation attempt under all 4 Anti-Split-Brain Invariants.
 *
 * Authoritative boundary rule (P1 #6):
 *   Agent, harness descriptor, verified runtime, scheduler runContext, project roster,
 *   project policy, and routingPolicy MUST be resolved from authoritative `deps` —
 *   NEVER trusted from caller-supplied `request` claims!
 *
 * Returns:
 *   - { kind: 'succeeded', attemptId, nativeHeadSha, outputSha, integratedHeadSha? }
 *   - { kind: 'fallback', code, attemptId }   // BEFORE any native process starts
 *   - { kind: 'stopped', code, exitCode, attemptId }
 */
export async function executeNativeDelegation({ request, attempt, signal = null }, deps = {}) {
  const {
    poolArbiter,
    spawnNativeProcess,
    projectDir,
    targetBranch = 'main',
    campaignBranch = null,
    integrate = false,
    checkFence = null,
    loadRoutingPolicyFn = (dir) => loadRoutingPolicy(dir),
    // Authoritative resolvers / stores (NEVER overridden by request!)
    resolveAgent = null,
    agentsMap = null,
    agent: authoritativeAgent = null,
    resolveHarnessDescriptor = null,
    harnessRegistry = null,
    descriptor: authoritativeDescriptor = null,
    resolveVerifiedRuntime = null,
    verifiedRuntime: authoritativeRuntime = null,
    resolveRunContext = null,
    runContext: authoritativeRunContext = null,
    resolveProjectPolicy = null,
    projectPolicy: authoritativeProjectPolicy = null,
    resolveProjectRoster = null,
    projectRoster: authoritativeProjectRoster = null,
  } = deps;

  const attemptId = attempt?.attemptId || `natt_${randomUUID().slice(0, 10)}`;
  const subtaskId = attempt?.subtaskId || request?.subtaskId || 'native';
  const requestedAgentId = attempt?.agentId || request?.agentId || null;

  // Authoritative resolution ONLY — NEVER trust request.routingPolicy / request.agent / request.descriptor / request.verifiedRuntime / request.runContext!
  const routingPolicy = projectDir ? loadRoutingPolicyFn(projectDir) : {};
  const agent = typeof resolveAgent === 'function'
    ? resolveAgent(requestedAgentId)
    : (agentsMap && requestedAgentId ? agentsMap[requestedAgentId] : authoritativeAgent);
  const harnessKey = agent?.harness || agent?.provider || null;
  const descriptor = typeof resolveHarnessDescriptor === 'function'
    ? resolveHarnessDescriptor(harnessKey, agent)
    : (harnessRegistry?.getHarness && harnessKey ? harnessRegistry.getHarness(harnessKey) : authoritativeDescriptor);
  const verifiedRuntime = typeof resolveVerifiedRuntime === 'function'
    ? resolveVerifiedRuntime(descriptor, agent)
    : authoritativeRuntime;
  const runContext = typeof resolveRunContext === 'function'
    ? resolveRunContext({ attempt, request })
    : authoritativeRunContext;
  const projectPolicy = typeof resolveProjectPolicy === 'function'
    ? resolveProjectPolicy(attempt?.projectId || request?.projectId)
    : authoritativeProjectPolicy;
  const projectRoster = typeof resolveProjectRoster === 'function'
    ? resolveProjectRoster(attempt?.projectId || request?.projectId)
    : authoritativeProjectRoster;

  const elig = evaluateNativeDelegationEligibility({
    mode: request?.mode,
    maxWorkers: request?.maxWorkers,
    runContext,
    agent,
    descriptor,
    verifiedRuntime,
    projectPolicy,
    projectRoster,
    routingPolicy,
  });

  if (elig.kind !== 'eligible') {
    return { kind: 'fallback', code: elig.code, message: elig.message, attemptId };
  }
  const plan = elig.plan;

  if (!poolArbiter || typeof spawnNativeProcess !== 'function' || !projectDir || typeof checkFence !== 'function') {
    return { kind: 'fallback', code: 'NATIVE_DEPS_UNAVAILABLE', attemptId };
  }

  // Invariant 3: Pre-spawn K-slot atomic reservation on SharedPoolArbiter!
  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort(signal?.reason || 'external_abort');
  if (signal) {
    if (signal.aborted) return { kind: 'fallback', code: 'ALREADY_ABORTED', attemptId };
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const resv = poolArbiter.reserve(plan.poolKey, plan.K, attemptId, {
    onAbort: (reason) => abortController.abort(reason),
  });
  if (!resv.ok) {
    if (signal) try { signal.removeEventListener('abort', onExternalAbort); } catch {}
    return { kind: 'fallback', code: resv.reason || 'POOL_CAPACITY_DENIED', attemptId };
  }

  // Hold K slots until runner-owned exit barrier resolves cleanly!
  const heldRef = poolArbiter.getReservation(attemptId);
  if (heldRef) heldRef._holdUntilExit = true;

  let worktreeObj = null;
  let spawnStarted = false;
  let barrierSettledCleanly = false;
  let evictionTripped = false;
  let released = false;

  const releaseSlotsOnce = () => {
    if (released) return;
    released = true;
    poolArbiter.release(attemptId);
  };

  const tripEvictionOnce = (reason) => {
    if (evictionTripped) return;
    evictionTripped = true;
    poolArbiter.tripPoolEviction(plan.poolKey, {
      exitCode: 143,
      reason: reason || 'native delegation exit 143',
    });
  };

  try {
    // Invariant 2: Create attempt-owned worktree & snapshot pre-existing Git refs!
    const preRefsSnapshot = snapshotGitRefs(projectDir);
    worktreeObj = createSubtaskWorktree({
      projectDir,
      baseBranch: campaignBranch || targetBranch,
      subtaskId,
      attemptId,
      campaignBranch,
    });
    const pinnedBaseSha = worktreeObj.baseSha
      || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreeObj.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const assignedBranch = worktreeObj.subtaskBranch;

    // Spawn native process with exact verified executablePath + argv array + stdin prompt (NO shell!)
    spawnStarted = true;
    let procResult;
    try {
      procResult = await spawnNativeProcess({
        plan,
        attemptId,
        executablePath: plan.executablePath,
        worktreePath: worktreeObj.worktreePath,
        assignedBranch,
        baseSha: pinnedBaseSha,
        argv: plan.invocationArgv,
        promptStdin: String(request?.prompt ?? ''),
        scopedCredentials: {
          attemptId,
          agentId: plan.agentId,
          provider: plan.provider,
          model: plan.model,
          operatorCapable: false,
        },
        signal: abortController.signal,
        // Structured exit notification hook so numeric 143 trips eviction IMMEDIATELY
        // before waiting for descendant quiescence barrier!
        onExitCode: (code, reason) => {
          if (code === 143) tripEvictionOnce(reason);
        },
      });
    } catch (spawnErr) {
      if (spawnErr?.exitCode === 143) {
        tripEvictionOnce(spawnErr.message || 'native delegation exit 143');
      }
      // If the error carries an exit barrier, await it before releasing slots;
      // if no barrier or barrier rejects, keep K slots held (fail-closed)!
      if (spawnErr?.quiescencePromise && typeof spawnErr.quiescencePromise.then === 'function') {
        try {
          await spawnErr.quiescencePromise;
          barrierSettledCleanly = true;
        } catch {
          barrierSettledCleanly = false;
        }
      }
      if (worktreeObj && barrierSettledCleanly) {
        cleanupAttemptWorktree({ projectDir, worktreePath: worktreeObj.worktreePath, subtaskBranch: assignedBranch });
      }
      return {
        kind: 'stopped',
        code: spawnErr?.exitCode === 143 ? 'POOL_EVICTED' : (spawnErr?.code || 'NATIVE_SPAWN_FAILED'),
        exitCode: spawnErr?.exitCode ?? null,
        attemptId,
      };
    }

    const exitCode = procResult?.exitCode ?? null;

    // P1 #7: Observe numeric 143 IMMEDIATELY BEFORE awaiting exit barrier (while STILL holding K slots!)
    if (exitCode === 143) {
      tripEvictionOnce(procResult?.stderr || 'native delegation exit 143');
    }

    // P1 #7: Runner-owned exit barrier is REQUIRED once spawned!
    const barrier = procResult?.quiescencePromise;
    if (!barrier || typeof barrier.then !== 'function') {
      // Regression #2: Missing barrier -> keep K slots held AND quarantine worktree (do NOT delete while descendants may be active!)
      barrierSettledCleanly = false;
      return {
        kind: 'stopped',
        code: exitCode === 143 ? 'POOL_EVICTED' : 'MISSING_EXIT_BARRIER',
        exitCode,
        attemptId,
        worktreeQuarantined: true,
      };
    }

    try {
      await barrier;
      barrierSettledCleanly = true;
    } catch (barrierErr) {
      // Regression #2: Barrier rejected -> descendants may still be active; retain K slots AND quarantine worktree!
      barrierSettledCleanly = false;
      log.warn('Native delegation exit barrier rejected — retaining K pool slots and quarantining worktree', {
        attemptId,
        error: barrierErr?.message || String(barrierErr),
      });
      return {
        kind: 'stopped',
        code: exitCode === 143 ? 'POOL_EVICTED' : 'EXIT_BARRIER_FAILED',
        exitCode,
        attemptId,
        worktreeQuarantined: true,
      };
    }

    if (exitCode === 143) {
      cleanupAttemptWorktree({ projectDir, worktreePath: worktreeObj.worktreePath, subtaskBranch: assignedBranch });
      return { kind: 'stopped', code: 'POOL_EVICTED', exitCode: 143, attemptId };
    }

    if (exitCode === null || abortController.signal.aborted || signal?.aborted) {
      // Local signal / abort: NEVER trip pool eviction (`local_signal_exempt`)!
      cleanupAttemptWorktree({ projectDir, worktreePath: worktreeObj.worktreePath, subtaskBranch: assignedBranch });
      return {
        kind: 'stopped',
        code: (abortController.signal.aborted || signal?.aborted) ? 'CANCELLED' : 'LOCAL_SIGNAL',
        exitCode: null,
        attemptId,
      };
    }

    if (exitCode !== 0) {
      cleanupAttemptWorktree({ projectDir, worktreePath: worktreeObj.worktreePath, subtaskBranch: assignedBranch });
      return { kind: 'stopped', code: 'NATIVE_EXIT_NONZERO', exitCode, attemptId };
    }

    // Invariant 2: Strictly verify worktree BEFORE integrateSubtaskWorktree!
    const verified = verifyNativeWorktreeOutput({
      projectDir,
      worktreePath: worktreeObj.worktreePath,
      subtaskBranch: assignedBranch,
      baseSha: pinnedBaseSha,
      preRefsSnapshot,
      gitWriteSubtree: runContext?.gitWriteSubtree || null,
    });
    if (!verified.ok) {
      cleanupAttemptWorktree({ projectDir, worktreePath: worktreeObj.worktreePath, subtaskBranch: assignedBranch });
      return { kind: 'stopped', code: verified.code, message: verified.message, exitCode: 0, attemptId };
    }

    const nativeHeadSha = verified.headSha;
    const outputSha = createHash('sha256').update(String(procResult?.stdout ?? ''), 'utf8').digest('hex');

    // P1 #7: Recheck cancellation + persisted attempt fence + verified HEAD INSIDE integration lock!
    const lockedOut = await withRepoIntegrationLock(projectDir, async () => {
      if (abortController.signal.aborted || signal?.aborted) {
        return { ok: false, code: 'CANCELLED' };
      }
      const fenceOk = await checkFence();
      if (!fenceOk) {
        return { ok: false, code: 'STALE_ATTEMPT_FENCE' };
      }
      // P1 #7: Recheck cancellation AFTER async checkFence() await!
      if (abortController.signal.aborted || signal?.aborted) {
        return { ok: false, code: 'CANCELLED' };
      }
      const recheck = verifyNativeWorktreeOutput({
        projectDir,
        worktreePath: worktreeObj.worktreePath,
        subtaskBranch: assignedBranch,
        baseSha: pinnedBaseSha,
        preRefsSnapshot,
        gitWriteSubtree: runContext?.gitWriteSubtree || null,
      });
      if (!recheck.ok || recheck.headSha !== nativeHeadSha) {
        return { ok: false, code: 'HEAD_DRIFTED_BEFORE_INTEGRATION' };
      }
      if (integrate) {
        const integ = await integrateSubtaskWorktree({
          projectDir,
          targetBranch: campaignBranch || targetBranch,
          worktreePath: worktreeObj.worktreePath,
          subtaskBranch: assignedBranch,
          subtaskId,
          attemptId,
          skipLock: true,
        });
        if (!integ.ok) {
          return { ok: false, code: integ.reason || 'INTEGRATION_FAILED' };
        }
        return { ok: true, integratedHeadSha: integ.postIntegrationHeadSha };
      }
      return { ok: true, integratedHeadSha: null };
    });

    if (!lockedOut.ok) {
      cleanupAttemptWorktree({ projectDir, worktreePath: worktreeObj.worktreePath, subtaskBranch: assignedBranch });
      return { kind: 'stopped', code: lockedOut.code, exitCode: 0, attemptId };
    }

    return {
      kind: 'succeeded',
      attemptId,
      nativeHeadSha,
      outputSha,
      ...(lockedOut.integratedHeadSha ? { integratedHeadSha: lockedOut.integratedHeadSha } : {}),
    };
  } catch (err) {
    if (worktreeObj && (!spawnStarted || barrierSettledCleanly)) {
      try {
        cleanupAttemptWorktree({ projectDir, worktreePath: worktreeObj.worktreePath, subtaskBranch: worktreeObj.subtaskBranch });
      } catch {}
    }
    log.warn('Native delegation execution threw', { attemptId, error: err.message });
    return { kind: 'stopped', code: err?.code || 'NATIVE_EXECUTION_ERROR', exitCode: null, attemptId };
  } finally {
    if (signal) try { signal.removeEventListener('abort', onExternalAbort); } catch {}
    // Only release K slots if spawn never started OR the runner-owned exit barrier settled cleanly!
    if (!spawnStarted || barrierSettledCleanly) {
      releaseSlotsOnce();
    }
  }
}

/**
 * Decision 002 Handoff Selector (Invariant 4, hardened per P1 #10):
 * Fallback route changes MUST hand off to a DISTINCT canonical agent ID from the effective
 * project roster (never mutate an existing agent's model in-session), exclude governors
 * (both definition and roster), and pass `assertGeminiTransport`.
 */
/**
 * Production argv-only process-group native runner (P1 #1):
 * - Spawns exact verified `executablePath` + `argv` with `shell: false`, `detached: true`
 * - Delivers prompt strictly on stdin (never argv/shell)
 * - Scopes env to attempt-scoped single-identity credentials (zero operator tokens)
 * - Enforces process-group `-pid` SIGTERM -> grace -> SIGKILL cancellation boundary
 * - Emits `onExitCode` immediately on exit & returns explicit `quiescencePromise` settled ONLY on child close!
 */
function isProcessGroupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code !== 'ESRCH');
  }
}

export function createDefaultNativeProcessRunner({ sigkillGraceMs = 3000, quiescenceTimeoutMs = 8000 } = {}) {
  return async function spawnNativeProcess({
    executablePath,
    worktreePath,
    argv = [],
    promptStdin = '',
    scopedCredentials = {},
    signal = null,
    onExitCode = null,
  }) {
    if (!executablePath || !existsSync(executablePath)) {
      const err = new Error(`Verified native executable not found: ${executablePath}`);
      err.code = 'RUNTIME_EXECUTABLE_MISSING';
      err.quiescencePromise = Promise.resolve();
      throw err;
    }

    // P1 #1: Attempt-scoped ephemeral HOME so host operator credentials (~/.config, ~/.codex, etc.) are NEVER discoverable!
    const isolatedHome = mkdtempSync(join(tmpdir(), 'synapse-native-home-'));
    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, '.config'),
      XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
      LANG: process.env.LANG || 'C.UTF-8',
      SYNAPSE_NATIVE_ATTEMPT_ID: String(scopedCredentials.attemptId || ''),
      SYNAPSE_NATIVE_AGENT_ID: String(scopedCredentials.agentId || ''),
      SYNAPSE_NATIVE_PROVIDER: String(scopedCredentials.provider || ''),
      SYNAPSE_NATIVE_MODEL: String(scopedCredentials.model || ''),
    };

    const child = spawn(executablePath, argv, {
      cwd: worktreePath,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    let killTimer = null;
    let killRequested = false;
    const killGroup = () => {
      if (!child.pid) return;
      if (!killRequested) {
        killRequested = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }, sigkillGraceMs);
        killTimer.unref?.();
      }
    };

    const onAbort = () => killGroup();
    if (signal) {
      if (signal.aborted) killGroup();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let resolveQuiescence;
    let rejectQuiescence;
    const quiescencePromise = new Promise((res, rej) => {
      resolveQuiescence = res;
      rejectQuiescence = rej;
    });
    // Prevent unhandledRejection noise if caller observes rejection later
    quiescencePromise.catch(() => {});

    // Reg #2: Wait for ENTIRE process group `-pid` to reach ESRCH before resolving quiescencePromise!
    // Never clear SIGKILL timer or clean isolatedHome while any descendant with redirected stdio is alive.
    const awaitProcessGroupExit = () => {
      const pgid = child.pid;
      const finishClean = () => {
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        if (signal) try { signal.removeEventListener('abort', onAbort); } catch {}
        try { rmSync(isolatedHome, { recursive: true, force: true }); } catch {}
        resolveQuiescence();
      };
      if (!pgid || !isProcessGroupAlive(pgid)) {
        finishClean();
        return;
      }
      // Direct child exited/closed, yet descendants in `-pgid` remain alive -> terminate group & poll until ESRCH!
      killGroup();
      const deadline = Date.now() + Math.max(quiescenceTimeoutMs, sigkillGraceMs + 1000);
      const poll = () => {
        if (!isProcessGroupAlive(pgid)) {
          finishClean();
          return;
        }
        if (Date.now() >= deadline) {
          try { process.kill(-pgid, 'SIGKILL'); } catch {}
          if (!isProcessGroupAlive(pgid)) {
            finishClean();
            return;
          }
          if (signal) try { signal.removeEventListener('abort', onAbort); } catch {}
          // Keep isolatedHome quarantined alongside worktree because descendants may still be active!
          rejectQuiescence(new Error(`Native process group -${pgid} failed to reach quiescence before timeout`));
          return;
        }
        setTimeout(poll, 25);
      };
      setTimeout(poll, 25);
    };

    const exitPromise = new Promise((resolveExit, rejectExit) => {
      let exitCode = null;
      let exitNotified = false;
      child.once('error', (err) => {
        awaitProcessGroupExit();
        err.quiescencePromise = quiescencePromise;
        rejectExit(err);
      });
      child.once('exit', (code) => {
        exitCode = typeof code === 'number' ? code : null;
        if (!exitNotified && typeof onExitCode === 'function') {
          exitNotified = true;
          try { onExitCode(exitCode, stderr); } catch {}
        }
      });
      child.once('close', (code) => {
        const finalCode = typeof code === 'number' ? code : exitCode;
        awaitProcessGroupExit();
        resolveExit({ exitCode: finalCode, stdout, stderr, quiescencePromise });
      });
    });

    try {
      child.stdin?.on('error', () => {});
      child.stdin?.end(String(promptStdin ?? ''), 'utf8');
    } catch {}

    return await exitPromise;
  };
}

/**
 * Production host verified runtime resolver (P1 #1):
 * Hashes the actual executable binary configured on the agent/descriptor on disk.
 */
export function createDefaultVerifiedRuntimeResolver() {
  return function resolveVerifiedRuntime(descriptor, agent) {
    const exePath = agent?.cliPath || descriptor?.cliPath || null;
    if (!exePath || typeof exePath !== 'string' || !existsSync(exePath)) return null;
    const modeSpec = descriptor?.capabilities?.nativeDelegation?.swarm
      || descriptor?.capabilities?.nativeDelegation?.teamwork
      || null;
    if (!modeSpec?.verifiedBuild?.version) return null;
    return buildHostVerifiedRuntime({
      executablePath: exePath,
      version: modeSpec.verifiedBuild.version,
      canBoundInnerSessions: modeSpec.canBoundInnerSessions === true,
      canPropagateCancel: modeSpec.canPropagateCancel === true,
      canScopeCredentials: modeSpec.canScopeCredentials === true,
    });
  };
}

export function selectFallbackAgent(failedAgent, candidates = [], { routingPolicy = {}, projectRoster = undefined, allowUnrestrictedRoster = false } = {}) {
  const failedId = typeof failedAgent?.id === 'string' && failedAgent.id.trim() ? failedAgent.id.trim() : null;
  if (!failedId) return null;
  // P1 #10: Fail closed when projectRoster is omitted OR null unless allowUnrestrictedRoster === true (strict boolean)!
  if ((projectRoster === undefined || projectRoster === null) && allowUnrestrictedRoster !== true) return null;
  for (const cand of candidates) {
    if (!cand || typeof cand !== 'object') continue;
    const candId = typeof cand.id === 'string' && cand.id.trim() ? cand.id.trim() : null;
    if (!candId || candId === failedId) continue;
    if (isGovernorAgent(cand)) continue;
    if (projectRoster) {
      if (projectRoster?.roles?.governor?.agents?.includes(candId)) continue;
      if (!rosterAllowsAgentAnyRole(projectRoster, candId, cand)) continue;
    }
    try {
      assertGeminiTransport(cand, routingPolicy || {});
    } catch {
      continue;
    }
    return cand;
  }
  return null;
}

/**
 * Invariant 4 (Review Integrity, strictly fail-closed per P1 #10):
 * Native internal reviews carry worker provenance and NEVER satisfy Synapse's
 * independent cross-provider review gate.
 * Requires explicit `provenance === 'synapse_independent_review'` (no caller `trusted: true` bypass),
 * distinct canonical `reviewerAgentId !== workerAgentId`, distinct recognized backing providers,
 * non-empty verdict, AND a valid 64-hex `evidenceDigest` (no arbitrary `reviewId` bypass)!
 */
export function isIndependentReviewEvidence(reviewRecord) {
  if (!reviewRecord || typeof reviewRecord !== 'object' || Array.isArray(reviewRecord)) return false;
  if (reviewRecord.provenance === 'native_internal' || reviewRecord.source === 'native_delegation') {
    return false;
  }
  if (reviewRecord.isWorkerSelfReview === true) return false;

  // P1 #10: Require explicit Synapse provenance only (NO caller `trusted: true` override!)
  if (reviewRecord.provenance !== 'synapse_independent_review') {
    return false;
  }

  const reviewerAgentId = typeof reviewRecord.reviewerAgentId === 'string' ? reviewRecord.reviewerAgentId.trim() : '';
  const workerAgentId = typeof reviewRecord.workerAgentId === 'string' ? reviewRecord.workerAgentId.trim() : '';
  if (!reviewerAgentId || !workerAgentId || reviewerAgentId === workerAgentId) {
    return false;
  }

  const reviewerProvider = resolveBackingProviderKey({
    provider: reviewRecord.reviewerProvider,
    model: reviewRecord.reviewerModel,
  });
  const workerProvider = resolveBackingProviderKey({
    provider: reviewRecord.workerProvider,
    model: reviewRecord.workerModel,
  });
  if (reviewerProvider === 'unknown' || workerProvider === 'unknown' || reviewerProvider === workerProvider) {
    return false;
  }

  const verdict = typeof reviewRecord.verdict === 'string' ? reviewRecord.verdict.trim() : '';
  // P1 #10: Require valid 64-hex evidenceDigest (NO arbitrary reviewId bypass!)
  const hasDigest = typeof reviewRecord.evidenceDigest === 'string' && SHA256_RE.test(reviewRecord.evidenceDigest);
  if (!verdict || !hasDigest) {
    return false;
  }

  return true;
}
