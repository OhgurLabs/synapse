/**
 * Lean Cross-Platform Council Engine (Phase 3 Stage A — Pillar 1, hardened per GPT-6.2 Sol Round 1).
 *
 * Implements:
 * - 3 Modes: `counsel`, `open_dialog`, `convergence`
 * - Default `on_request` (chat `/debate` & `/deliberate`, HTTP, MCP); opt-in `auto`
 *   strictly on `research` projects (advisory `counsel`, excluding `oneshot`/verbatim)
 * - Strict Council-only rails: `maxRounds: 4`, `maxWallClockMs: 600_000` from admission
 *   (enforced atomically in SQLite at launch, settlement, and completion), hard `24_000`
 *   atomic token ceiling (strict integer usage validation, conservative charge on failed
 *   launched turns, immediate sibling abort on contract violation) — isolated from `oneshot`!
 * - Hard invariants:
 *   1. `governor`-role exclusion across agent defs AND project roster (at admission AND dispatch)
 *   2. >=2 distinct canonical backing vendors for `open_dialog` and `convergence`
 *      (`google-antigravity` & `gemini` -> `google`; unrecognized labels -> `unknown` excluded)
 *   3. `assertGeminiTransport(agent, loadRoutingPolicy(projectDir))` before EVERY dispatch
 *   4. Shared `SharedPoolArbiter` slot acquisition held until explicit exit barrier resolves
 *   5. Real observed outcomes only (operator verdicts + trusted LoopStore/PrStore Anchor proofs)
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { rosterAllowsAgentAnyRole } from '../roster.js';
import { resolveAgentPoolKey } from './execution-contract.js';
import { assertGeminiTransport, loadRoutingPolicy } from '../agents/routing-policy.js';
import { sha256Text } from './council-store.js';

const log = createLogger('council');

export const COUNCIL_MODES = Object.freeze(['counsel', 'open_dialog', 'convergence']);
export const OPERATOR_VERDICTS = Object.freeze(['adopted', 'rejected', 'partial']);
export const ANCHOR_VERDICTS = Object.freeze(['pass', 'fail']);
export const DEFAULT_MAX_ROUNDS = 4;
export const DEFAULT_MAX_WALL_CLOCK_MS = 600_000;
export const DEFAULT_MAX_TOKENS = 24_000;
export const DEFAULT_TURN_MAX_OUTPUT_TOKENS = 1200;
export const DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS = 1600;

const ALLOWED_REQUEST_KEYS = new Set(['requestId', 'subject', 'mode', 'maxTokens']);
const SHA256_RE = /^[a-f0-9]{64}$/i;

export class CouncilError extends Error {
  constructor(code, message, { statusCode = 400 } = {}) {
    super(message);
    this.name = 'CouncilError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Determine whether an agent carries the `governor` role in EITHER its own
 * definition (`role`, `roles`) or a roster entry.
 */
export function isGovernorAgent(agentDef) {
  if (!agentDef || typeof agentDef !== 'object') return false;
  if (String(agentDef.role || '').toLowerCase() === 'governor') return true;
  if (Array.isArray(agentDef.roles) && agentDef.roles.some(r => String(r || '').toLowerCase() === 'governor')) {
    return true;
  }
  return false;
}

/**
 * Resolve the canonical backing vendor key for cross-platform independence (P1 #5).
 * - `google-antigravity/...`, `antigravity`, `google/...`, `gemini*`, `gemini`, `google` -> `'google'`
 * - `openai-codex/...`, `openai/...`, `codex`, `openai` -> `'openai'`
 * - `xai-oauth/...`, `xai/...`, `grok`, `xai` -> `'xai'`
 * - `anthropic/...`, `claude-*`, `claude`, `anthropic` -> `'anthropic'`
 * - `golden/...`, `*.gguf`, `llama`, `ollama`, `local-llama` -> `'local-llama'`
 * - `zai-coding-plan/...`, `glm`, `zai` -> `'zai'`
 * - Anything unrecognized -> `'unknown'` (NEVER counted toward provider diversity!)
 */
export function resolveBackingProviderKey(agentDef) {
  const model = String(agentDef?.model || '').trim().toLowerCase();
  const provider = String(agentDef?.provider || '').trim().toLowerCase();
  if (
    model.startsWith('google-antigravity/')
    || model.startsWith('google/')
    || model.startsWith('gemini')
    || provider === 'antigravity'
    || provider === 'google-antigravity'
    || provider === 'gemini'
    || provider === 'google'
  ) {
    return 'google';
  }
  if (
    model.startsWith('openai-codex/')
    || model.startsWith('openai/')
    || model.startsWith('gpt-')
    || provider === 'codex'
    || provider === 'openai'
  ) {
    return 'openai';
  }
  if (
    model.startsWith('xai-oauth/')
    || model.startsWith('xai/')
    || model.startsWith('grok')
    || provider === 'grok'
    || provider === 'xai'
  ) {
    return 'xai';
  }
  if (
    model.startsWith('anthropic/')
    || model.startsWith('claude-')
    || provider === 'claude'
    || provider === 'anthropic'
  ) {
    return 'anthropic';
  }
  if (
    model.startsWith('golden/')
    || /\.gguf$/i.test(model)
    || provider === 'llama'
    || provider === 'ollama'
    || provider === 'local-llama'
  ) {
    return 'local-llama';
  }
  if (
    model.startsWith('zai-coding-plan/')
    || model.startsWith('glm')
    || provider === 'glm'
    || provider === 'zai'
  ) {
    return 'zai';
  }
  return 'unknown';
}

/**
 * Strictly validate reported usage object (P1 #2).
 * Accepts `{ input, output, total }` or `{ promptTokens, completionTokens, totalTokens }`.
 * Rejects `null`, booleans, strings, floats, NaN, negative integers, and `input + output !== total`.
 */
export function parseStrictUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return null;
  const input = rawUsage.input !== undefined ? rawUsage.input : rawUsage.promptTokens;
  const output = rawUsage.output !== undefined ? rawUsage.output : rawUsage.completionTokens;
  const total = rawUsage.total !== undefined ? rawUsage.total : rawUsage.totalTokens;
  if (!Number.isInteger(input) || !Number.isInteger(output) || !Number.isInteger(total)) return null;
  if (input < 0 || output < 0 || total < 0) return null;
  if (input + output !== total) return null;
  return { input, output, total };
}

/**
 * Estimate conservative upper-bound prompt input tokens (~2 UTF-8 bytes/token + overhead).
 */
export function estimateInputTokens(promptText) {
  // Worst-case BPE upper bound: 1 UTF-8 byte can yield at most 1 token (+ 128 framing overhead).
  const bytes = Buffer.byteLength(String(promptText || ''), 'utf8');
  return Math.max(64, bytes + 128);
}

/**
 * Parse chat `/debate` or `/deliberate` commands (spec §1):
 *   `/debate [--mode=<mode>] <topic|taskId>`     -> defaults to `open_dialog`
 *   `/deliberate [--mode=<mode>] <topic|taskId>` -> defaults to `convergence`
 */
export function parseCouncilCommand(text) {
  const raw = String(text || '').trim();
  const m = /^\/(debate|deliberate)(?:\s+([\s\S]+))?$/i.exec(raw);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const defaultMode = cmd === 'debate' ? 'open_dialog' : 'convergence';
  let rest = (m[2] || '').trim();
  let mode = defaultMode;
  const modeMatch = /^--mode=([a-z_]+)(?:\s+([\s\S]*))?$/i.exec(rest);
  if (modeMatch) {
    mode = modeMatch[1].toLowerCase();
    rest = (modeMatch[2] || '').trim();
  }
  return { command: cmd, mode, target: rest };
}

/**
 * Deterministic Convergence ledger reducer (spec §1):
 * - `agreed`     iff unanimous explicit `'agree'` across ALL admitted panel members
 * - `disputed`   on ANY explicit `'disagree'`
 * - `unresolved` otherwise (missing positions stay missing — never inferred!)
 */
export function reduceConvergenceLedger(issues, positionRecords, admittedAgentIds) {
  const byIssue = new Map();
  for (const iss of (issues || [])) {
    if (!iss || !iss.issueId) continue;
    byIssue.set(String(iss.issueId), {
      issueId: String(iss.issueId),
      statement: String(iss.statement || iss.issueId),
      positions: new Map(), // agentId -> { agentId, turnId, position }
    });
  }

  for (const rec of (positionRecords || [])) {
    if (!rec || rec.issueId === undefined || rec.issueId === null || !rec.agentId) continue;
    // Regression #4: Use canonical string key for BOTH membership check and lookup!
    const issueKey = String(rec.issueId);
    if (!byIssue.has(issueKey)) continue;
    const pos = String(rec.position || '').toLowerCase();
    if (pos === 'agree' || pos === 'disagree' || pos === 'abstain') {
      byIssue.get(issueKey).positions.set(rec.agentId, {
        agentId: rec.agentId,
        turnId: rec.turnId || null,
        position: pos,
      });
    }
  }

  const admitted = [...new Set(admittedAgentIds || [])];
  const entries = [];
  for (const item of byIssue.values()) {
    const posList = [];
    let anyDisagree = false;
    let agreeCount = 0;
    for (const agentId of admitted) {
      const p = item.positions.get(agentId);
      if (p) {
        posList.push(p);
        if (p.position === 'disagree') anyDisagree = true;
        else if (p.position === 'agree') agreeCount++;
      }
    }
    let state = 'unresolved';
    if (anyDisagree) {
      state = 'disputed';
    } else if (admitted.length > 0 && agreeCount === admitted.length) {
      state = 'agreed';
    }
    entries.push({
      issueId: item.issueId,
      statement: item.statement,
      status: state,
      state,
      positions: posList,
      missingAgents: admitted.filter(id => !item.positions.has(id)),
    });
  }
  return entries;
}

/**
 * Validate closed `CouncilRequest` payload across HTTP & MCP (rejects unknown fields & >24k cap).
 */
export function validateClosedCouncilRequest(raw, { defaultMode = 'counsel', projectCap = DEFAULT_MAX_TOKENS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CouncilError('INVALID_REQUEST', 'Council request must be a JSON object', { statusCode: 400 });
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      throw new CouncilError('UNKNOWN_FIELD', `Unknown field "${key}" in CouncilRequest`, { statusCode: 400 });
    }
  }
  const requestId = typeof raw.requestId === 'string' && raw.requestId.trim() ? raw.requestId.trim() : null;
  if (!requestId || requestId.length > 128) {
    throw new CouncilError('INVALID_REQUEST_ID', 'requestId is required (non-empty string <= 128 chars)', { statusCode: 400 });
  }
  const mode = raw.mode !== undefined ? String(raw.mode) : defaultMode;
  if (!COUNCIL_MODES.includes(mode)) {
    throw new CouncilError('INVALID_MODE', `mode must be one of ${COUNCIL_MODES.join(', ')} (got "${mode}")`, { statusCode: 400 });
  }
  const subj = raw.subject;
  if (!subj || typeof subj !== 'object' || Array.isArray(subj)) {
    throw new CouncilError('INVALID_SUBJECT', 'subject must be { kind: "topic", text } or { kind: "task", taskId }', { statusCode: 400 });
  }
  const subjKeys = Object.keys(subj);
  let normalizedSubject;
  if (subj.kind === 'topic') {
    if (subjKeys.some(k => k !== 'kind' && k !== 'text') || typeof subj.text !== 'string' || !subj.text.trim()) {
      throw new CouncilError('INVALID_SUBJECT', 'topic subject requires non-empty text and no extra fields', { statusCode: 400 });
    }
    normalizedSubject = { kind: 'topic', text: subj.text.trim() };
  } else if (subj.kind === 'task') {
    if (subjKeys.some(k => k !== 'kind' && k !== 'taskId') || typeof subj.taskId !== 'string' || !subj.taskId.trim()) {
      throw new CouncilError('INVALID_SUBJECT', 'task subject requires non-empty taskId and no extra fields', { statusCode: 400 });
    }
    normalizedSubject = { kind: 'task', taskId: subj.taskId.trim() };
  } else {
    throw new CouncilError('INVALID_SUBJECT', `Unsupported subject.kind "${subj.kind}"`, { statusCode: 400 });
  }

  // Hard ceiling clamp: never exceed DEFAULT_MAX_TOKENS (24,000)
  const effectiveCap = Math.min(
    Number.isInteger(projectCap) && projectCap > 0 ? projectCap : DEFAULT_MAX_TOKENS,
    DEFAULT_MAX_TOKENS
  );
  let maxTokens = effectiveCap;
  if (raw.maxTokens !== undefined) {
    if (!Number.isInteger(raw.maxTokens) || raw.maxTokens <= 0) {
      throw new CouncilError('INVALID_MAX_TOKENS', 'maxTokens must be a positive integer', { statusCode: 400 });
    }
    if (raw.maxTokens > DEFAULT_MAX_TOKENS) {
      throw new CouncilError('MAX_TOKENS_EXCEEDED', `maxTokens (${raw.maxTokens}) exceeds hard Council ceiling (${DEFAULT_MAX_TOKENS})`, { statusCode: 400 });
    }
    maxTokens = Math.min(raw.maxTokens, effectiveCap);
  }

  return { requestId, mode, subject: normalizedSubject, maxTokens };
}

export function createCouncilService({
  councilStore,
  stateManager = null,
  taskManager = null,
  loopStore = null,
  prStore = null,
  agentsMap = {},
  poolArbiter = null,
  dispatchTurn = null,
  projectDir = null,
  nowFn = () => Date.now(),
  setTimerFn = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimerFn = (t) => clearTimeout(t),
  loadRoutingPolicyFn = (dir) => loadRoutingPolicy(dir),
  turnMaxOutputTokens = DEFAULT_TURN_MAX_OUTPUT_TOKENS,
  synthesisMaxOutputTokens = DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
} = {}) {
  if (!councilStore) throw new Error('createCouncilService requires councilStore');

  /** @type {Map<string, AbortController>} */
  const activeAbortControllers = new Map();
  /** @type {Map<string, Promise<any>>} */
  const activeExecutions = new Map();

  function isOperator(identity) {
    const r = String(identity?.role || '').toLowerCase();
    return r === 'operator' || r === 'admin';
  }

  function assertProjectScope(identity, projectId) {
    if (!projectId) throw new CouncilError('PROJECT_REQUIRED', 'projectId is required', { statusCode: 400 });
    if (identity?.scopedProjectId && identity.scopedProjectId !== projectId) {
      throw new CouncilError('FORBIDDEN', `Token scoped to "${identity.scopedProjectId}" cannot access project "${projectId}"`, { statusCode: 403 });
    }
    if (stateManager && !stateManager.getProject(projectId)) {
      throw new CouncilError('PROJECT_NOT_FOUND', `Project "${projectId}" not found`, { statusCode: 404 });
    }
  }

  function resolveProjectDir(projectId) {
    const proj = stateManager?.getProject?.(projectId);
    return proj?.projectDir || projectDir || process.cwd();
  }

  function resolveProjectRosterSpec(projectId) {
    if (stateManager?.getEffectiveProjectRoster) {
      return stateManager.getEffectiveProjectRoster(projectId).roster;
    }
    if (stateManager?.getProject) {
      return stateManager.getProject(projectId)?.agents ?? null;
    }
    return null;
  }

  function isRosterGovernor(rosterSpec, agentId) {
    return Boolean(rosterSpec?.roles?.governor?.agents?.includes(agentId));
  }

  /**
   * Resolve eligible Council members from project effective roster + agentsMap.
   * Strictly excludes `governor` role in ALL sources (agent def AND roster roles).
   */
  function resolveEligibleMembers(projectId) {
    const rosterSpec = resolveProjectRosterSpec(projectId);
    const members = [];
    for (const [agentId, def] of Object.entries(agentsMap || {})) {
      if (!def || typeof def !== 'object') continue;
      if (isGovernorAgent(def)) continue;
      if (isRosterGovernor(rosterSpec, agentId)) continue;
      if (rosterSpec && !rosterAllowsAgentAnyRole(rosterSpec, agentId, def)) continue;
      members.push({
        agentId,
        harnessId: def.harness || def.descriptor?.id || def.provider || 'unknown',
        providerKey: resolveBackingProviderKey(def),
        model: String(def.model || 'unknown'),
      });
    }
    members.sort((a, b) => a.agentId.localeCompare(b.agentId));
    return members;
  }

  function countDistinctProviders(items) {
    const keys = new Set();
    for (const item of (items || [])) {
      const k = typeof item === 'string'
        ? item
        : (item?.resolvedProviderKey || item?.providerKey || item?.member?.providerKey || null);
      if (k && k !== 'unknown') keys.add(k);
    }
    return keys.size;
  }

  function buildSubjectSnapshot(projectId, subject) {
    if (subject.kind === 'topic') {
      const snapshotText = `Topic: ${subject.text}`;
      return {
        snapshotText,
        subjectSnapshotHash: sha256Text(JSON.stringify({ kind: 'topic', text: subject.text })),
      };
    }
    if (!taskManager?.getTask) {
      throw new CouncilError('TASK_NOT_FOUND', `Task "${subject.taskId}" not found in project "${projectId}"`, { statusCode: 404 });
    }
    const task = taskManager.getTask(projectId, subject.taskId);
    if (!task || (task.projectId && task.projectId !== projectId)) {
      throw new CouncilError('TASK_NOT_FOUND', `Task "${subject.taskId}" not found in project "${projectId}"`, { statusCode: 404 });
    }
    const snapObj = {
      kind: 'task',
      taskId: task.id,
      title: task.title || '',
      description: task.description || '',
      doneCriteria: task.doneCriteria || null,
    };
    const snapshotText = `Task ${task.id}: ${task.title || ''}\n${task.description || ''}${task.doneCriteria ? `\nDone criteria: ${task.doneCriteria}` : ''}`;
    return {
      snapshotText,
      subjectSnapshotHash: sha256Text(JSON.stringify(snapObj)),
    };
  }

  /**
   * Pre-launch authoritative eligibility + transport check (P1 #5).
   * Runs immediately before EVERY dispatch using CURRENT agentsMap + effective project roster!
   */
  function validateDispatchEligibility(projectId, member) {
    const agentDef = agentsMap[member.agentId];
    if (!agentDef) {
      throw new CouncilError('AGENT_UNAVAILABLE', `Agent "${member.agentId}" unavailable`, { statusCode: 503 });
    }
    if (isGovernorAgent(agentDef)) {
      throw new CouncilError('GOVERNOR_EXCLUDED', `Governor agent "${member.agentId}" prohibited in Council`, { statusCode: 403 });
    }
    const rosterSpec = resolveProjectRosterSpec(projectId);
    if (isRosterGovernor(rosterSpec, member.agentId)) {
      throw new CouncilError('GOVERNOR_EXCLUDED', `Roster governor "${member.agentId}" prohibited in Council`, { statusCode: 403 });
    }
    if (rosterSpec && !rosterAllowsAgentAnyRole(rosterSpec, member.agentId, agentDef)) {
      throw new CouncilError('ROSTER_EXCLUDED', `Agent "${member.agentId}" no longer allowed by project roster`, { statusCode: 403 });
    }
    const routingPolicy = loadRoutingPolicyFn(resolveProjectDir(projectId));
    assertGeminiTransport(agentDef, routingPolicy);
    return {
      agentDef,
      resolvedProviderKey: resolveBackingProviderKey(agentDef),
    };
  }

  /**
   * Default metered dispatch adapter — fresh session, tools disabled, hidden retries disabled,
   * enforceable output token limit, and exit-barrier propagation.
   */
  async function invokeMeteredDispatch({ agentDef, resolvedProviderKey, member, round, phase, promptText, maxOutputTokens, projectId, sessionId, turnId, attemptId, signal }) {
    if (typeof dispatchTurn === 'function') {
      const disp = await dispatchTurn({
        member: { ...member, providerKey: resolvedProviderKey },
        agent: agentDef,
        round,
        phase,
        promptText,
        maxOutputTokens,
        projectId,
        sessionId,
        turnId,
        attemptId,
        signal,
        freshSession: true,
        resumeSession: false,
        toolsDisabled: true,
        disableRetries: true,
      });
      return { ...disp, resolvedProviderKey };
    }

    if (typeof agentDef.send !== 'function') {
      throw new CouncilError('AGENT_UNAVAILABLE', `Agent "${member.agentId}" has no metered send() adapter`, { statusCode: 503 });
    }
    if (agentDef.supportsMeteredLimits !== true) {
      throw new CouncilError('UNMETERED_ADAPTER_REJECTED', `Agent "${member.agentId}" does not enforce metered output/tool/retry bounds`, { statusCode: 503 });
    }

    const res = await agentDef.send(promptText, resolveProjectDir(projectId), {
      freshSession: true,
      resumeSession: false,
      toolsDisabled: true,
      maxTurns: 1,
      disableRetries: true,
      maxOutputTokens,
      maxTotalTokens: estimateInputTokens(promptText) + maxOutputTokens,
      signal,
    });
    if (typeof res === 'string') {
      return { text: res, usage: null, resolvedProviderKey };
    }
    return {
      text: String(res?.text ?? ''),
      usage: res?.usage ?? null,
      issues: res?.issues,
      positions: res?.positions,
      exitBarrier: res?.exitBarrier || res?.quiescencePromise || null,
      resolvedProviderKey,
    };
  }

  /**
   * Execute one metered Council turn under:
   * - Atomic token reservation (with synthesis holdback when applicable)
   * - Wall-clock deadline check at reservation, launch, and atomic SQLite settlement
   * - SharedPoolArbiter 1-slot acquisition held through explicit exit barrier
   * - Full governor + roster + Gemini transport recheck immediately before launch
   * - Strict integer usage validation; conservative charge on failed launched turns
   * - Immediate sibling abort on budget/contract violation or transport block
   */
  async function runMeteredTurn({
    projectId,
    sessionId,
    round,
    phase,
    member,
    promptText,
    inputTurnIds = [],
    maxOutputTokens,
    holdbackTokens = 0,
    signal,
    onAbortSiblings = null,
    stoppedPaths,
  }) {
    const pathKey = `${member.agentId}:${member.providerKey}`;
    if (stoppedPaths.has(pathKey)) {
      return { ok: false, reasonCode: 'PATH_STOPPED_MISSING_USAGE' };
    }

    const inputBound = estimateInputTokens(promptText);
    const reservedTokens = inputBound + maxOutputTokens;
    const turnId = `cturn_${randomUUID().slice(0, 12)}`;
    const attemptId = `catt_${randomUUID().slice(0, 10)}`;
    const nowIso = new Date(nowFn()).toISOString();

    const turnObj = {
      id: turnId,
      sessionId,
      round,
      phase,
      member,
      resolvedProviderKey: null,
      attemptId,
      inputTurnIds: [...inputTurnIds],
      status: 'reserved',
      reservedTokens,
      usage: null,
      chargedTokens: null,
      text: null,
      startedAt: nowIso,
      endedAt: null,
      reasonCode: null,
    };

    const resv = councilStore.reserveTurnAtomic(projectId, sessionId, turnObj, {
      holdbackTokens,
      nowFn,
    });
    if (!resv.ok) {
      return { ok: false, reasonCode: resv.reasonCode };
    }

    const liveAgentDef = agentsMap[member.agentId];
    const poolKey = resolveAgentPoolKey(liveAgentDef || member);
    let poolAcquired = false;
    let dispatchLaunched = false;
    let exitBarrier = null;
    let barrierFailed = false;

    const turnAbort = new AbortController();
    const onParentAbort = () => turnAbort.abort(signal?.reason || 'session_aborted');
    if (signal) {
      if (signal.aborted) turnAbort.abort(signal.reason);
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    try {
      // Acquire 1 slot on SharedPoolArbiter if wired; wait/fail-closed on eviction or deadline!
      if (poolArbiter) {
        while (true) {
          if (turnAbort.signal.aborted) {
            councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
              status: 'cancelled', usage: null, chargedTokens: 0, endedAt: new Date(nowFn()).toISOString(), reasonCode: 'CANCELLED', nowFn,
            });
            return { ok: false, reasonCode: 'CANCELLED' };
          }
          const sessionSnap = councilStore.getSession(projectId, sessionId);
          if (!sessionSnap || nowFn() > Date.parse(sessionSnap.deadlineAt)) {
            councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
              status: 'cancelled', usage: null, chargedTokens: 0, endedAt: new Date(nowFn()).toISOString(), reasonCode: 'WALL_CLOCK_EXCEEDED', nowFn,
            });
            return { ok: false, reasonCode: 'WALL_CLOCK_EXCEEDED' };
          }
          const r = poolArbiter.reserve(poolKey, 1, attemptId, {
            onAbort: (msg) => turnAbort.abort(msg),
          });
          if (r.ok) {
            poolAcquired = true;
            const held = poolArbiter.getReservation(attemptId);
            if (held) held._holdUntilExit = true;
            break;
          }
          if (r.reason === 'pool_eviction_tripped') {
            councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
              status: 'failed', usage: null, chargedTokens: 0, endedAt: new Date(nowFn()).toISOString(), reasonCode: 'POOL_EVICTED', nowFn,
            });
            return { ok: false, reasonCode: 'POOL_EVICTED' };
          }
          await new Promise((resolveWait) => {
            const onWake = () => { clearTimerFn(t); resolveWait(); };
            const t = setTimerFn(() => {
              turnAbort.signal.removeEventListener('abort', onWake);
              resolveWait();
            }, 25);
            t?.ref?.();
            turnAbort.signal.addEventListener('abort', onWake, { once: true });
          });
        }
      }

      if (turnAbort.signal.aborted) {
        councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
          status: 'cancelled', usage: null, chargedTokens: 0, endedAt: new Date(nowFn()).toISOString(), reasonCode: 'CANCELLED', nowFn,
        });
        return { ok: false, reasonCode: 'CANCELLED' };
      }

      // Check deadline again immediately before launch!
      const preLaunchSnap = councilStore.getSession(projectId, sessionId);
      if (!preLaunchSnap || (preLaunchSnap.status !== 'running' && preLaunchSnap.status !== 'queued') || nowFn() > Date.parse(preLaunchSnap.deadlineAt)) {
        councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
          status: 'cancelled', usage: null, chargedTokens: 0, endedAt: new Date(nowFn()).toISOString(), reasonCode: 'WALL_CLOCK_EXCEEDED', nowFn,
        });
        return { ok: false, reasonCode: 'WALL_CLOCK_EXCEEDED' };
      }

      // Pre-launch authoritative eligibility & transport check (governor + roster + Gemini transport)
      const { agentDef, resolvedProviderKey } = validateDispatchEligibility(projectId, member);

      dispatchLaunched = true;
      const disp = await invokeMeteredDispatch({
        agentDef,
        resolvedProviderKey,
        member,
        round,
        phase,
        promptText,
        maxOutputTokens,
        projectId,
        sessionId,
        turnId,
        attemptId,
        signal: turnAbort.signal,
      });

      if (disp?.exitBarrier || disp?.quiescencePromise) {
        exitBarrier = disp.exitBarrier || disp.quiescencePromise;
      }

      const normUsage = parseStrictUsage(disp?.usage);

      if (!normUsage) {
        // Missing or malformed/non-integer/mismatched usage -> charge full reservation & STOP further dispatches via this path!
        stoppedPaths.add(pathKey);
        const settled = councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
          status: 'succeeded',
          usage: null,
          chargedTokens: reservedTokens,
          text: String(disp?.text ?? ''),
          endedAt: new Date(nowFn()).toISOString(),
          reasonCode: 'USAGE_MISSING',
          nowFn,
          resolvedProviderKey,
        });
        return {
          ok: !settled.fenced,
          turn: settled.turn,
          raw: disp,
          usageMissing: true,
          reasonCode: settled.fenced ? 'LATE_WRITE_FENCED' : 'USAGE_MISSING',
        };
      }

      if (normUsage.total > reservedTokens || normUsage.output > maxOutputTokens) {
        // Usage above reservation or output limit is a contract violation -> charge actual & abort siblings immediately!
        if (typeof onAbortSiblings === 'function') {
          onAbortSiblings('USAGE_EXCEEDED_RESERVATION');
        }
        const settled = councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
          status: 'failed',
          usage: normUsage,
          chargedTokens: normUsage.total,
          text: null,
          endedAt: new Date(nowFn()).toISOString(),
          reasonCode: 'USAGE_EXCEEDED_RESERVATION',
          nowFn,
          resolvedProviderKey,
        });
        return {
          ok: false,
          contractViolation: true,
          turn: settled.turn,
          reasonCode: 'USAGE_EXCEEDED_RESERVATION',
        };
      }

      const settled = councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
        status: 'succeeded',
        usage: normUsage,
        chargedTokens: normUsage.total,
        text: String(disp?.text ?? ''),
        endedAt: new Date(nowFn()).toISOString(),
        reasonCode: null,
        nowFn,
        resolvedProviderKey,
      });
      return {
        ok: !settled.fenced,
        turn: settled.turn,
        raw: disp,
        reasonCode: settled.fenced ? 'LATE_WRITE_FENCED' : null,
      };
    } catch (err) {
      if (err?.exitBarrier || err?.quiescencePromise) {
        exitBarrier = err.exitBarrier || err.quiescencePromise;
      }
      const code = err?.code === 'GEMINI_TRANSPORT_BLOCKED'
        ? 'GEMINI_TRANSPORT_BLOCKED'
        : (turnAbort.signal.aborted ? 'CANCELLED' : (err?.code || 'DISPATCH_FAILED'));
      if (code === 'GEMINI_TRANSPORT_BLOCKED' && typeof onAbortSiblings === 'function') {
        onAbortSiblings('GEMINI_TRANSPORT_BLOCKED');
      }
      // P1 #2: Charge conservative full reservation if provider dispatch was already launched!
      // Only pre-launch rejections (transport blocked, governor excluded, pre-launch abort) settle at 0.
      const conservativeCharge = dispatchLaunched ? reservedTokens : 0;
      councilStore.settleTurnAtomic(projectId, sessionId, turnId, {
        status: code === 'CANCELLED' ? 'cancelled' : 'failed',
        usage: null,
        chargedTokens: conservativeCharge,
        endedAt: new Date(nowFn()).toISOString(),
        reasonCode: code,
        nowFn,
      });
      return { ok: false, reasonCode: code, error: err };
    } finally {
      // Regression #1 + P1 #3: Keep parent abort listener attached UNTIL exitBarrier settles!
      // And if a launched turn was aborted or failed without a promise-like exitBarrier,
      // keep the pool slot held fail-closed so quiescence cannot be bypassed!
      try {
        if (exitBarrier && typeof exitBarrier.then === 'function') {
          try {
            await exitBarrier;
          } catch {
            barrierFailed = true;
          }
        } else if (dispatchLaunched && poolAcquired && turnAbort.signal.aborted) {
          barrierFailed = true;
        }
      } finally {
        if (signal) try { signal.removeEventListener('abort', onParentAbort); } catch {}
      }
      if (poolAcquired && poolArbiter && !barrierFailed) {
        poolArbiter.release(attemptId);
      }
    }
  }

  function finishSession(projectId, sessionId, { status, reasonCode = null, synthesis = null, ledger = null } = {}) {
    const res = councilStore.finishSessionAtomic(projectId, sessionId, {
      status,
      reasonCode,
      synthesis,
      ledger,
      nowFn,
    });
    return res.session;
  }

  function incrementRound(projectId, sessionId, nextRound) {
    if (nextRound > DEFAULT_MAX_ROUNDS) {
      throw new CouncilError('ROUND_LIMIT_EXCEEDED', `Council cannot exceed ${DEFAULT_MAX_ROUNDS} rounds`);
    }
    return councilStore.updateSessionAtomic(projectId, sessionId, (s) => {
      // P2 #1: Require active, unexpired session before advancing roundsStarted!
      if (s.status !== 'running') {
        throw new CouncilError('SESSION_NOT_ACTIVE', `Cannot advance round on non-running session (status=${s.status})`);
      }
      if (nowFn() > Date.parse(s.deadlineAt)) {
        throw new CouncilError('WALL_CLOCK_EXCEEDED', 'Cannot advance round after wall-clock deadline');
      }
      if (s.roundsStarted >= DEFAULT_MAX_ROUNDS) {
        throw new CouncilError('ROUND_LIMIT_EXCEEDED', `Council cannot exceed ${DEFAULT_MAX_ROUNDS} rounds`);
      }
      s.roundsStarted = nextRound;
      return s;
    });
  }

  async function executeSession(projectId, sessionId, snapshotText) {
    const abortController = new AbortController();
    activeAbortControllers.set(sessionId, abortController);
    const session0 = councilStore.getSession(projectId, sessionId);
    if (!session0) return null;

    // P2 #1: If session was already cancelled/terminal while queued, do NOT enter execution or advance rounds!
    if (session0.status !== 'queued' && session0.status !== 'running') {
      activeAbortControllers.delete(sessionId);
      activeExecutions.delete(sessionId);
      return session0;
    }

    const remainingMs = Math.max(0, Date.parse(session0.deadlineAt) - nowFn());
    let deadlineTripped = false;
    const deadlineTimer = setTimerFn(() => {
      deadlineTripped = true;
      abortController.abort('WALL_CLOCK_EXCEEDED');
      finishSession(projectId, sessionId, { status: 'limited', reasonCode: 'WALL_CLOCK_EXCEEDED' });
    }, remainingMs);

    const stoppedPaths = new Set();
    const onAbortSiblings = (reason) => {
      if (!abortController.signal.aborted) {
        abortController.abort(reason);
      }
    };

    try {
      const transitioned = councilStore.updateSessionAtomic(projectId, sessionId, (s) => {
        if (s.status === 'queued') {
          if (nowFn() > Date.parse(s.deadlineAt)) {
            s.status = 'limited';
            s.reasonCode = 'WALL_CLOCK_EXCEEDED';
            s.endedAt = new Date(nowFn()).toISOString();
            return s;
          }
          s.status = 'running';
        }
        return s;
      });
      if (transitioned.status !== 'running') {
        return transitioned;
      }

      const members = session0.members;
      const mode = session0.mode;
      const synthMember = members[0];
      const synthHoldback = estimateInputTokens(snapshotText) + synthesisMaxOutputTokens;

      const checkStop = () => {
        if (deadlineTripped || nowFn() > Date.parse(session0.deadlineAt)) {
          return 'WALL_CLOCK_EXCEEDED';
        }
        if (abortController.signal.aborted) {
          return typeof abortController.signal.reason === 'string' ? abortController.signal.reason : 'CANCELLED';
        }
        const snap = councilStore.getSession(projectId, sessionId);
        if (!snap || (snap.status !== 'running' && snap.status !== 'queued')) {
          return snap?.reasonCode || 'CANCELLED';
        }
        return null;
      };

      let synthesisRound = 1;
      let ledger = null;
      let synthesisInputTurns = [];

      if (mode === 'counsel') {
        const stopBefore = checkStop();
        if (stopBefore) {
          return finishSession(projectId, sessionId, { status: stopBefore === 'CANCELLED' ? 'cancelled' : 'limited', reasonCode: stopBefore });
        }
        incrementRound(projectId, sessionId, 1);
        const prompt = `[Council: counsel | Round 1]\nProvide your independent opinion.\n\n${snapshotText}`;
        const results = await Promise.all(members.map(m => runMeteredTurn({
          projectId, sessionId, round: 1, phase: 'opinion', member: m,
          promptText: prompt, inputTurnIds: [], maxOutputTokens: turnMaxOutputTokens,
          holdbackTokens: synthHoldback, signal: abortController.signal, onAbortSiblings, stoppedPaths,
        })));

        const transportBlocked = results.find(r => r.reasonCode === 'GEMINI_TRANSPORT_BLOCKED');
        if (transportBlocked) {
          return finishSession(projectId, sessionId, { status: 'failed', reasonCode: 'GEMINI_TRANSPORT_BLOCKED' });
        }
        const violation = results.find(r => r.contractViolation);
        if (violation) {
          return finishSession(projectId, sessionId, { status: 'limited', reasonCode: 'USAGE_EXCEEDED_RESERVATION' });
        }
        const budgetHit = results.find(r => r.reasonCode === 'TOKEN_BUDGET_EXCEEDED');
        const stopCode = checkStop();
        if (stopCode) {
          return finishSession(projectId, sessionId, { status: stopCode === 'CANCELLED' ? 'cancelled' : 'limited', reasonCode: stopCode });
        }
        const succeeded = results.filter(r => r.ok && r.turn).map(r => r.turn);
        if (succeeded.length === 0) {
          return finishSession(projectId, sessionId, {
            status: budgetHit ? 'limited' : 'failed',
            reasonCode: budgetHit ? 'TOKEN_BUDGET_EXCEEDED' : 'NO_OPINIONS_SUCCEEDED',
          });
        }
        synthesisRound = 1;
        synthesisInputTurns = succeeded;
      } else if (mode === 'open_dialog') {
        const transcriptRounds = [];
        for (let r = 1; r <= DEFAULT_MAX_ROUNDS; r++) {
          const stopCode = checkStop();
          if (stopCode) {
            return finishSession(projectId, sessionId, { status: stopCode === 'CANCELLED' ? 'cancelled' : 'limited', reasonCode: stopCode });
          }
          incrementRound(projectId, sessionId, r);
          const prevTurns = transcriptRounds.flat();
          const frozenTranscript = prevTurns.map(t => `[R${t.round} ${t.member.agentId} (${t.id})]: ${t.text}`).join('\n');
          const phase = r === 1 ? 'opinion' : 'reply';
          const prompt = r === 1
            ? `[Council: open_dialog | Round 1]\nState your independent position.\n\n${snapshotText}`
            : `[Council: open_dialog | Round ${r}]\nRespond to the frozen transcript through Round ${r - 1}.\n\n${snapshotText}\n\nTranscript:\n${frozenTranscript}`;

          const results = await Promise.all(members.map(m => runMeteredTurn({
            projectId, sessionId, round: r, phase, member: m,
            promptText: prompt, inputTurnIds: prevTurns.map(t => t.id),
            maxOutputTokens: turnMaxOutputTokens, holdbackTokens: synthHoldback,
            signal: abortController.signal, onAbortSiblings, stoppedPaths,
          })));

          if (results.find(x => x.reasonCode === 'GEMINI_TRANSPORT_BLOCKED')) {
            return finishSession(projectId, sessionId, { status: 'failed', reasonCode: 'GEMINI_TRANSPORT_BLOCKED' });
          }
          if (results.find(x => x.contractViolation)) {
            return finishSession(projectId, sessionId, { status: 'limited', reasonCode: 'USAGE_EXCEEDED_RESERVATION' });
          }
          const stopAfter = checkStop();
          if (stopAfter) {
            return finishSession(projectId, sessionId, { status: stopAfter === 'CANCELLED' ? 'cancelled' : 'limited', reasonCode: stopAfter });
          }
          const roundSucceeded = results.filter(x => x.ok && x.turn).map(x => x.turn);
          // P1 #5: Count distinct backing vendors from DISPATCH-TIME resolvedProviderKey!
          const roundProviders = countDistinctProviders(roundSucceeded);
          if (roundProviders < 2) {
            const budgetHit = results.some(x => x.reasonCode === 'TOKEN_BUDGET_EXCEEDED');
            if (r >= 2 && transcriptRounds.length >= 2) {
              break;
            }
            return finishSession(projectId, sessionId, {
              status: budgetHit ? 'limited' : 'failed',
              reasonCode: budgetHit ? 'TOKEN_BUDGET_EXCEEDED' : 'INSUFFICIENT_PROVIDER_DIVERSITY',
            });
          }
          transcriptRounds.push(roundSucceeded);
          const allDone = results.filter(x => x.ok).every(x => x.raw?.done === true);
          if (r >= 2 && allDone) break;
        }
        synthesisRound = transcriptRounds.length;
        synthesisInputTurns = transcriptRounds.flat();
      } else if (mode === 'convergence') {
        const phases = [
          { round: 1, phase: 'proposal', instr: 'Round 1 (Proposal): Propose your solution and list concrete issueIds.' },
          { round: 2, phase: 'critique', instr: 'Round 2 (Critique): Critique peer proposals referencing exact turn IDs.' },
          { round: 3, phase: 'revision', instr: 'Round 3 (Revision): Revise proposal to resolve critiques.' },
          { round: 4, phase: 'position', instr: 'Round 4 (Position): Emit explicit agree/disagree/abstain per issueId.' },
        ];
        const allTurns = [];
        let collectedIssues = [];
        const collectedPositions = [];

        for (const step of phases) {
          const stopCode = checkStop();
          if (stopCode) {
            return finishSession(projectId, sessionId, { status: stopCode === 'CANCELLED' ? 'cancelled' : 'limited', reasonCode: stopCode });
          }
          incrementRound(projectId, sessionId, step.round);
          const frozenTranscript = allTurns.map(t => `[R${t.round}/${t.phase} ${t.member.agentId} (${t.id})]: ${t.text}`).join('\n');
          const prompt = `[Council: convergence | ${step.instr}]\n\n${snapshotText}${frozenTranscript ? `\n\nTranscript:\n${frozenTranscript}` : ''}`;

          const results = await Promise.all(members.map(m => runMeteredTurn({
            projectId, sessionId, round: step.round, phase: step.phase, member: m,
            promptText: prompt, inputTurnIds: allTurns.map(t => t.id),
            maxOutputTokens: turnMaxOutputTokens, holdbackTokens: synthHoldback,
            signal: abortController.signal, onAbortSiblings, stoppedPaths,
          })));

          if (results.find(x => x.reasonCode === 'GEMINI_TRANSPORT_BLOCKED')) {
            return finishSession(projectId, sessionId, { status: 'failed', reasonCode: 'GEMINI_TRANSPORT_BLOCKED' });
          }
          if (results.find(x => x.contractViolation)) {
            return finishSession(projectId, sessionId, { status: 'limited', reasonCode: 'USAGE_EXCEEDED_RESERVATION' });
          }
          const stopAfter = checkStop();
          if (stopAfter) {
            return finishSession(projectId, sessionId, { status: stopAfter === 'CANCELLED' ? 'cancelled' : 'limited', reasonCode: stopAfter });
          }
          const roundSucceeded = results.filter(x => x.ok && x.turn);
          if (countDistinctProviders(roundSucceeded.map(x => x.turn)) < 2) {
            const budgetHit = results.some(x => x.reasonCode === 'TOKEN_BUDGET_EXCEEDED');
            return finishSession(projectId, sessionId, {
              status: budgetHit ? 'limited' : 'failed',
              reasonCode: budgetHit ? 'TOKEN_BUDGET_EXCEEDED' : 'INSUFFICIENT_PROVIDER_DIVERSITY',
            });
          }

          for (const res of roundSucceeded) {
            allTurns.push(res.turn);
            if (Array.isArray(res.raw?.issues)) {
              for (const iss of res.raw.issues) {
                if (iss?.issueId && !collectedIssues.some(x => x.issueId === iss.issueId)) {
                  collectedIssues.push({ issueId: String(iss.issueId), statement: String(iss.statement || iss.issueId) });
                }
              }
            }
            if (step.round === 4 && Array.isArray(res.raw?.positions)) {
              for (const pos of res.raw.positions) {
                if (pos?.issueId && pos?.position) {
                  collectedPositions.push({
                    issueId: String(pos.issueId),
                    agentId: res.turn.member.agentId,
                    turnId: res.turn.id,
                    position: String(pos.position),
                  });
                }
              }
            }
          }
        }
        if (collectedIssues.length === 0) {
          collectedIssues = [{ issueId: 'primary-proposal', statement: 'Primary revised proposal' }];
        }
        ledger = reduceConvergenceLedger(collectedIssues, collectedPositions, members.map(m => m.agentId));
        synthesisRound = 4;
        synthesisInputTurns = allTurns;
      }

      // ─── Final Synthesis Turn (reuses last round number, zero extra round) ─
      const stopBeforeSynth = checkStop();
      if (stopBeforeSynth) {
        return finishSession(projectId, sessionId, {
          status: stopBeforeSynth === 'CANCELLED' ? 'cancelled' : 'limited',
          reasonCode: stopBeforeSynth,
          ledger,
        });
      }

      const synthCandidate = members.find(m => !stoppedPaths.has(`${m.agentId}:${m.providerKey}`)) || synthMember;
      const citeIds = synthesisInputTurns.map(t => t.id);
      const synthPrompt = `[Council Synthesis | mode=${mode} | round=${synthesisRound}]\nSynthesize the completed turns, citing turn IDs [${citeIds.join(', ')}].\n\n${snapshotText}\n\nTurns:\n${synthesisInputTurns.map(t => `[${t.id} R${t.round}/${t.phase} ${t.member.agentId}]: ${t.text}`).join('\n')}${ledger ? `\n\nLedger:\n${JSON.stringify(ledger)}` : ''}`;

      const synthRes = await runMeteredTurn({
        projectId, sessionId, round: synthesisRound, phase: 'synthesis',
        member: synthCandidate, promptText: synthPrompt,
        inputTurnIds: citeIds, maxOutputTokens: synthesisMaxOutputTokens,
        holdbackTokens: 0, signal: abortController.signal, onAbortSiblings, stoppedPaths,
      });

      if (synthRes.reasonCode === 'GEMINI_TRANSPORT_BLOCKED') {
        return finishSession(projectId, sessionId, { status: 'failed', reasonCode: 'GEMINI_TRANSPORT_BLOCKED', ledger });
      }
      if (!synthRes.ok || !synthRes.turn) {
        const isLimit = ['TOKEN_BUDGET_EXCEEDED', 'WALL_CLOCK_EXCEEDED', 'USAGE_EXCEEDED_RESERVATION', 'LATE_WRITE_FENCED'].includes(synthRes.reasonCode);
        return finishSession(projectId, sessionId, {
          status: isLimit ? 'limited' : (synthRes.reasonCode === 'CANCELLED' ? 'cancelled' : 'failed'),
          reasonCode: synthRes.reasonCode === 'LATE_WRITE_FENCED' ? 'WALL_CLOCK_EXCEEDED' : (synthRes.reasonCode || 'SYNTHESIS_FAILED'),
          ledger,
        });
      }

      const synthText = synthRes.turn.text || '';
      const synthesis = {
        text: synthText,
        digest: sha256Text(synthText),
      };
      return finishSession(projectId, sessionId, {
        status: 'completed',
        reasonCode: null,
        synthesis,
        ledger,
      });
    } catch (err) {
      const code = err?.code === 'GEMINI_TRANSPORT_BLOCKED' ? 'GEMINI_TRANSPORT_BLOCKED' : (err?.code || 'COUNCIL_ERROR');
      const status = code === 'WALL_CLOCK_EXCEEDED' ? 'limited' : (code === 'SESSION_NOT_ACTIVE' ? 'cancelled' : 'failed');
      return finishSession(projectId, sessionId, { status, reasonCode: code });
    } finally {
      clearTimerFn(deadlineTimer);
      activeAbortControllers.delete(sessionId);
      activeExecutions.delete(sessionId);
    }
  }

  // ─── Public Service Methods ───────────────────────────────────────

  function startSession(identity, {
    projectId,
    request,
    trigger = 'http',
    defaultMode = 'counsel',
    researchRevKey = null,
    awaitCompletion = false,
  } = {}) {
    if (trigger !== 'research_auto' && !isOperator(identity)) {
      throw new CouncilError('FORBIDDEN', 'Forbidden: operator role required to start Council session', { statusCode: 403 });
    }
    assertProjectScope(identity, projectId);

    const projCfg = stateManager?.getProject?.(projectId);
    const projectCap = Math.min(
      Number.isInteger(projCfg?.councilMaxTokens) && projCfg.councilMaxTokens > 0
        ? projCfg.councilMaxTokens
        : DEFAULT_MAX_TOKENS,
      DEFAULT_MAX_TOKENS
    );

    const validated = validateClosedCouncilRequest(request, { defaultMode, projectCap });
    const { snapshotText, subjectSnapshotHash } = buildSubjectSnapshot(projectId, validated.subject);

    const members = resolveEligibleMembers(projectId);
    if (members.length === 0) {
      throw new CouncilError('NO_ELIGIBLE_MEMBERS', `No eligible non-governor members in project "${projectId}"`, { statusCode: 400 });
    }
    if ((validated.mode === 'open_dialog' || validated.mode === 'convergence') && countDistinctProviders(members) < 2) {
      throw new CouncilError(
        'INSUFFICIENT_PROVIDER_DIVERSITY',
        `Council mode "${validated.mode}" requires >=2 distinct backing providers (found ${countDistinctProviders(members)})`,
        { statusCode: 400 }
      );
    }

    const nowMs = nowFn();
    const createdAt = new Date(nowMs).toISOString();
    const deadlineAt = new Date(nowMs + DEFAULT_MAX_WALL_CLOCK_MS).toISOString();
    const session = {
      v: 1,
      id: `csess_${randomUUID().slice(0, 12)}`,
      projectId,
      requestId: validated.requestId,
      trigger,
      principalId: String(identity?.principalId || identity?.userId || identity?.name || 'operator'),
      subject: validated.subject,
      subjectSnapshotHash,
      mode: validated.mode,
      members,
      limits: {
        maxRounds: DEFAULT_MAX_ROUNDS,
        maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
        maxTokens: validated.maxTokens,
      },
      createdAt,
      deadlineAt,
      endedAt: null,
      status: 'queued',
      reasonCode: null,
      roundsStarted: 0,
      tokensCharged: 0,
      synthesis: null,
      ledger: null,
    };

    const admitted = councilStore.admitSession(session, { researchRevKey });
    if (admitted.conflict) {
      throw new CouncilError(
        'REQUEST_ID_CONFLICT',
        `requestId "${validated.requestId}" was already used with a different Council payload`,
        { statusCode: 409 }
      );
    }

    let executionPromise = activeExecutions.get(admitted.session.id) || null;
    if (!admitted.deduplicated) {
      executionPromise = Promise.resolve()
        .then(() => executeSession(projectId, admitted.session.id, snapshotText))
        .catch(err => {
          log.warn('Council execution failed', { projectId, sessionId: admitted.session.id, error: err.message });
          return councilStore.getSession(projectId, admitted.session.id);
        });
      activeExecutions.set(admitted.session.id, executionPromise);
    }

    const out = {
      sessionId: admitted.session.id,
      status: admitted.session.status,
      deduplicated: admitted.deduplicated,
      session: admitted.session,
      executionPromise,
    };
    if (awaitCompletion && executionPromise) {
      return executionPromise.then((finalSession) => ({
        ...out,
        status: finalSession?.status || out.status,
        session: finalSession || councilStore.getSession(projectId, admitted.session.id),
      }));
    }
    return out;
  }

  function getSessionDetail(identity, projectId, sessionId) {
    assertProjectScope(identity, projectId);
    const session = councilStore.getSession(projectId, sessionId);
    if (!session) {
      throw new CouncilError('SESSION_NOT_FOUND', `Council session "${sessionId}" not found`, { statusCode: 404 });
    }
    return {
      session,
      turns: councilStore.listTurns(projectId, sessionId),
      outcomes: councilStore.listOutcomes(projectId, sessionId),
    };
  }

  function listProjectSessions(identity, projectId, { limit = 50 } = {}) {
    assertProjectScope(identity, projectId);
    return {
      projectId,
      sessions: councilStore.listSessions(projectId, { limit }),
      metrics: councilStore.getOutcomeMetrics(projectId),
    };
  }

  function cancelSession(identity, projectId, sessionId) {
    if (!isOperator(identity)) {
      throw new CouncilError('FORBIDDEN', 'Forbidden: operator role required to cancel Council session', { statusCode: 403 });
    }
    assertProjectScope(identity, projectId);
    const session = councilStore.getSession(projectId, sessionId);
    if (!session) throw new CouncilError('SESSION_NOT_FOUND', `Council session "${sessionId}" not found`, { statusCode: 404 });
    const ac = activeAbortControllers.get(sessionId);
    if (ac) ac.abort('OPERATOR_CANCELLED');
    return finishSession(projectId, sessionId, { status: 'cancelled', reasonCode: 'OPERATOR_CANCELLED' });
  }

  /**
   * Research-auto trigger (spec §1):
   * Default every project to `on_request`. Enqueue ONE advisory `counsel` session per
   * `(projectId, taskId, revision)` ONLY when:
   * - project has `projectType === 'research'` AND `councilMode === 'auto'`
   * - task is NOT `oneshot` and NOT `isVerbatim`!
   */
  function maybeEnqueueResearchAuto({ projectId, task, revision = 1, awaitCompletion = false } = {}) {
    const proj = stateManager?.getProject?.(projectId);
    if (!proj) return { enqueued: false, reason: 'project_not_found' };
    if (proj.councilMode !== 'auto') return { enqueued: false, reason: 'council_on_request' };
    if (proj.projectType !== 'research') return { enqueued: false, reason: 'non_research_project' };
    if (!task || !task.id) return { enqueued: false, reason: 'missing_task' };
    if (proj.mode === 'oneshot' || task.type === 'oneshot' || task.isVerbatim === true) {
      return { enqueued: false, reason: 'oneshot_or_verbatim_excluded' };
    }
    const revKey = `${projectId}:${task.id}:rev${revision}`;
    const res = startSession(
      { principalId: 'system:research_auto', role: 'operator', scopedProjectId: projectId },
      {
        projectId,
        trigger: 'research_auto',
        defaultMode: 'counsel',
        researchRevKey: revKey,
        request: {
          requestId: `auto_${task.id}_r${revision}`,
          subject: { kind: 'task', taskId: task.id },
          mode: 'counsel',
        },
        awaitCompletion,
      }
    );
    if (awaitCompletion && typeof res?.then === 'function') {
      return res.then((resolved) => ({ enqueued: !resolved.deduplicated, ...resolved }));
    }
    return { enqueued: !res.deduplicated, ...res };
  }

  /**
   * Record real observed operator verdict (`adopted | rejected | partial`).
   * Strictly operator-only (agents & viewers rejected 403!).
   */
  function recordOperatorVerdict(identity, { projectId, sessionId, verdict, requestId, simulateCrashBeforeAck = false } = {}) {
    if (!isOperator(identity)) {
      throw new CouncilError('FORBIDDEN', 'Forbidden: operator role required to record Council verdict', { statusCode: 403 });
    }
    assertProjectScope(identity, projectId);
    if (!OPERATOR_VERDICTS.includes(verdict)) {
      throw new CouncilError('INVALID_VERDICT', `verdict must be one of ${OPERATOR_VERDICTS.join(', ')}`, { statusCode: 400 });
    }
    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw new CouncilError('INVALID_REQUEST_ID', 'requestId is required for verdict recording', { statusCode: 400 });
    }
    const session = councilStore.getSession(projectId, sessionId);
    if (!session) throw new CouncilError('SESSION_NOT_FOUND', `Council session "${sessionId}" not found`, { statusCode: 404 });
    if (!session.synthesis?.digest) {
      throw new CouncilError('NO_SYNTHESIS', `Council session "${sessionId}" has no synthesis digest to judge`, { statusCode: 409 });
    }
    const operatorId = String(identity.principalId || identity.userId || identity.name || 'operator');
    const dedupKey = `op:${projectId}:${sessionId}:${operatorId}:${requestId.trim()}`;
    return councilStore.recordOutcome(projectId, {
      sessionId,
      synthesisDigest: session.synthesis.digest,
      source: 'operator',
      operatorId,
      requestId: requestId.trim(),
      verdict,
    }, dedupKey, { simulateCrashBeforeAck });
  }

  /**
   * Record real executed Anchor result resolved strictly from trusted `LoopStore` or `PrStore` state (P1 #1).
   * Rejects presence-only stubs, omitted `selectedAttemptId`, stale/unselected attempts,
   * mismatched synthesis digest, missing/mismatched artifactDigest, or missing trusted store!
   */
  function recordAnchorOutcome({
    projectId,
    sessionId,
    synthesisDigest,
    runKind,
    runId,
    attemptId,
    selectedAttemptId,
    anchorId,
    evidenceRef,
    artifactDigest,
    verdict,
    simulateCrashBeforeAck = false,
  } = {}) {
    if (!projectId || !sessionId) throw new CouncilError('INVALID_OUTCOME', 'projectId and sessionId are required', { statusCode: 400 });
    if (runKind !== 'loop' && runKind !== 'pr') throw new CouncilError('INVALID_OUTCOME', 'runKind must be "loop" or "pr"', { statusCode: 400 });
    if (!ANCHOR_VERDICTS.includes(verdict)) throw new CouncilError('INVALID_VERDICT', 'Anchor verdict must be "pass" or "fail"', { statusCode: 400 });
    if (!runId || !attemptId || !selectedAttemptId || !anchorId || !evidenceRef || !artifactDigest) {
      throw new CouncilError('INVALID_OUTCOME', 'runId, attemptId, selectedAttemptId, anchorId, evidenceRef, and artifactDigest are required', { statusCode: 400 });
    }
    if (!SHA256_RE.test(String(artifactDigest))) {
      throw new CouncilError('INVALID_OUTCOME', 'artifactDigest must be a 64-hex SHA-256 digest', { statusCode: 400 });
    }
    if (selectedAttemptId !== attemptId) {
      throw new CouncilError('STALE_ATTEMPT', `Anchor attempt "${attemptId}" is stale (selected is "${selectedAttemptId}")`, { statusCode: 409 });
    }
    const session = councilStore.getSession(projectId, sessionId);
    if (!session) throw new CouncilError('SESSION_NOT_FOUND', `Council session "${sessionId}" not found`, { statusCode: 404 });
    if (!session.synthesis?.digest || synthesisDigest !== session.synthesis.digest) {
      throw new CouncilError('SYNTHESIS_DIGEST_MISMATCH', 'Anchor run does not pin this Council synthesis digest', { statusCode: 409 });
    }

    let trustedVerdict = verdict;
    let trustedArtifactDigest = artifactDigest;
    let trustedEvidenceRef = evidenceRef;

    if (runKind === 'loop') {
      if (!loopStore || typeof loopStore.getRun !== 'function') {
        throw new CouncilError('TRUSTED_STORE_UNAVAILABLE', 'Trusted LoopStore is required to verify Loop Anchor proof', { statusCode: 503 });
      }
      const run = loopStore.getRun(runId);
      const runProjectId = run?.projectId || run?.provenance?.scope?.projectId || null;
      if (!run || !runProjectId || runProjectId !== projectId) {
        throw new CouncilError('TRUSTED_RUN_NOT_FOUND', `Loop run "${runId}" not found in project "${projectId}"`, { statusCode: 404 });
      }
      const runSessionId = run.params?.councilSessionId || run.provenance?.councilSessionId || null;
      const runSynthDigest = run.params?.councilSynthesisDigest || run.provenance?.councilSynthesisDigest || null;
      if (runSessionId !== sessionId || runSynthDigest !== session.synthesis.digest) {
        throw new CouncilError('SYNTHESIS_DIGEST_MISMATCH', `Loop run "${runId}" does not authoritatively pin Council session "${sessionId}" synthesis digest`, { statusCode: 409 });
      }
      const anchorRec = (run.anchors || []).find(a => a.anchorId === anchorId && a.attemptId === attemptId);
      if (!anchorRec) {
        throw new CouncilError('TRUSTED_ANCHOR_NOT_FOUND', `Anchor "${anchorId}" attempt "${attemptId}" not found in Loop run "${runId}"`, { statusCode: 409 });
      }
      const authoritativeSelected = run.selectedAttempts?.[anchorRec.nodeId] || null;
      if (authoritativeSelected) {
        if (authoritativeSelected !== attemptId) {
          throw new CouncilError('STALE_ATTEMPT', `Anchor attempt "${attemptId}" is not the selected attempt ("${authoritativeSelected}") in LoopStore`, { statusCode: 409 });
        }
      } else if (anchorRec.outcome === 'failed') {
        // Failed Loop anchors are not selected as passed; verify this is the latest terminal failed anchor attempt for nodeId!
        const nodeAnchors = (run.anchors || []).filter(a => a.nodeId === anchorRec.nodeId && a.anchorId === anchorId);
        const latestAnchor = nodeAnchors[nodeAnchors.length - 1];
        if (!latestAnchor || latestAnchor.attemptId !== attemptId) {
          throw new CouncilError('STALE_ATTEMPT', `Failed Anchor attempt "${attemptId}" is stale in LoopStore`, { statusCode: 409 });
        }
      } else {
        throw new CouncilError('STALE_ATTEMPT', `Anchor attempt "${attemptId}" is not selected in LoopStore`, { statusCode: 409 });
      }
      const derivedVerdict = anchorRec.outcome === 'passed' ? 'pass' : (anchorRec.outcome === 'failed' ? 'fail' : null);
      if (!derivedVerdict || derivedVerdict !== verdict) {
        throw new CouncilError('VERDICT_MISMATCH', `Anchor outcome "${anchorRec.outcome}" does not match verdict "${verdict}"`, { statusCode: 409 });
      }
      const storeDigest = anchorRec.stdout?.sha256 || anchorRec.digest || anchorRec.artifactDigest || null;
      if (!storeDigest || !SHA256_RE.test(String(storeDigest)) || storeDigest !== artifactDigest) {
        throw new CouncilError('ARTIFACT_DIGEST_MISMATCH', 'Anchor artifactDigest does not match trusted LoopStore evidence digest', { statusCode: 409 });
      }
      trustedVerdict = derivedVerdict;
      trustedArtifactDigest = storeDigest;
      trustedEvidenceRef = anchorRec.evidenceRef || `loop:${runId}:anchor:${anchorId}:${attemptId}`;
    } else if (runKind === 'pr') {
      if (!prStore || typeof prStore.getPR !== 'function') {
        throw new CouncilError('TRUSTED_STORE_UNAVAILABLE', 'Trusted PrStore is required to verify PR Anchor proof', { statusCode: 503 });
      }
      const pr = prStore.getPR(projectId, runId);
      const proof = pr?.verificationProof || null;
      if (!pr || !proof) {
        throw new CouncilError('TRUSTED_RUN_NOT_FOUND', `PR "${runId}" or verificationProof not found in project "${projectId}"`, { statusCode: 404 });
      }
      if (proof.councilSessionId !== sessionId || proof.councilSynthesisDigest !== session.synthesis.digest) {
        throw new CouncilError('SYNTHESIS_DIGEST_MISMATCH', `PR "${runId}" verificationProof does not pin Council session "${sessionId}" synthesis digest`, { statusCode: 409 });
      }
      if (proof.anchorId !== anchorId || !proof.selectedAttemptId || proof.selectedAttemptId !== attemptId) {
        throw new CouncilError('STALE_ATTEMPT', `PR "${runId}" selectedAttemptId "${proof.selectedAttemptId}"/anchor "${proof.anchorId}" does not match attempt "${attemptId}"`, { statusCode: 409 });
      }
      // Regression #3: overallPass: false ALWAYS means 'fail' (verifyPass: true can NEVER override overallPass: false!)
      const derivedVerdict = proof.overallPass === false
        ? 'fail'
        : (proof.overallPass === true
          ? 'pass'
          : (proof.verifyPass === false ? 'fail' : (proof.verifyPass === true ? 'pass' : null)));
      if (!derivedVerdict || derivedVerdict !== verdict) {
        throw new CouncilError('VERDICT_MISMATCH', `PR verificationProof pass state does not match verdict "${verdict}"`, { statusCode: 409 });
      }
      const storeDigest = proof.artifactDigest || proof.evidencePacketSha256 || null;
      if (!storeDigest || !SHA256_RE.test(String(storeDigest)) || storeDigest !== artifactDigest) {
        throw new CouncilError('ARTIFACT_DIGEST_MISMATCH', 'PR artifactDigest does not match trusted PrStore verificationProof digest', { statusCode: 409 });
      }
      trustedVerdict = derivedVerdict;
      trustedArtifactDigest = storeDigest;
      trustedEvidenceRef = proof.evidenceRef || `pr:${runId}:anchor:${anchorId}:${attemptId}`;
    }

    const dedupKey = `anc:${projectId}:${sessionId}:${runKind}:${runId}:${attemptId}:${anchorId}`;
    return councilStore.recordOutcome(projectId, {
      sessionId,
      synthesisDigest: session.synthesis.digest,
      source: 'anchor',
      runKind,
      runId,
      attemptId,
      anchorId,
      evidenceRef: trustedEvidenceRef,
      artifactDigest: trustedArtifactDigest,
      verdict: trustedVerdict,
    }, dedupKey, { simulateCrashBeforeAck });
  }

  return {
    startSession,
    getSessionDetail,
    listProjectSessions,
    cancelSession,
    maybeEnqueueResearchAuto,
    recordOperatorVerdict,
    recordAnchorOutcome,
    resolveEligibleMembers,
  };
}
