/**
 * Phase 1A — Single Authoritative Execution Contract & Shared-Pool K-Slot Arbiter.
 *
 * Provides:
 *  1. Durable attemptId & monotonic fenceToken per subtask execution attempt
 *     with AbortController cancellation propagation, persisted ownership checks,
 *     optional disk persistence for fenceSeq + pool evictions across restarts,
 *     and atomic same-subtask replacement at full pool (K=1).
 *  2. SharedPoolArbiter + wrapAgentWithPoolArbiter: K-slot concurrency limiter
 *     enforced at the shared agent.send() dispatch boundary (covering lifecycle,
 *     strategist, PR review, chat execution, agent-interaction, etc.) with
 *     exit-143 pool eviction tripwire (strictly exempting structured exitCode=null
 *     and exit-null local signals per beta.18).
 *  3. reconcileOrphanedAttempts: crash-recovery sweep that reaps orphaned
 *     worktrees and reconciles dead executing subtasks while explicitly
 *     sparing daemon tasks (task.type === 'daemon', e.g. netwatch).
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';
import config from '../config.js';
import { quotaBucketKey } from './agent-interaction.js';
import { classifyExitSignal } from './execution-exit.js';

export { classifyExitSignal };

const log = createLogger('execution-contract');

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);
const ACTIVE_SUBTASK_STATUSES = new Set(['claimed', 'executing']);

/**
 * Resolve the shared credential/concurrency pool key for an agent or provider+model.
 * Strictly orthogonal to agentPriority rank routing and Local GPU Opt-In.
 */
export function resolveAgentPoolKey(agentOrProvider, model = null) {
  if (!agentOrProvider) return 'default';
  if (typeof agentOrProvider === 'object') {
    if (agentOrProvider.poolKey) return String(agentOrProvider.poolKey);
    const provider = String(agentOrProvider.provider || '').toLowerCase();
    const m = String(agentOrProvider.model || '').toLowerCase();
    if (provider === 'claude' || provider === 'anthropic') return 'anthropic-shared';
    if (provider === 'antigravity') return quotaBucketKey(provider, m);
    return provider || 'default';
  }
  const provider = String(agentOrProvider).toLowerCase();
  if (provider === 'claude' || provider === 'anthropic') return 'anthropic-shared';
  if (provider === 'antigravity') return quotaBucketKey(provider, String(model || '').toLowerCase());
  return provider || 'default';
}

/**
 * Normalize a subtask key from either a string or { projectId, taskId, subtaskId }.
 */
export function normalizeSubtaskKey(subtaskKeyOrObj, taskId = null, subtaskId = null) {
  if (typeof subtaskKeyOrObj === 'string') {
    if (taskId && subtaskId) return `${subtaskKeyOrObj}:${taskId}:${subtaskId}`;
    return subtaskKeyOrObj;
  }
  if (subtaskKeyOrObj && typeof subtaskKeyOrObj === 'object') {
    const p = subtaskKeyOrObj.projectId || '_proj';
    const t = subtaskKeyOrObj.taskId || '_task';
    const s = subtaskKeyOrObj.subtaskId || '_sub';
    return `${p}:${t}:${s}`;
  }
  return `${String(subtaskKeyOrObj || '_proj')}:${String(taskId || '_task')}:${String(subtaskId || '_sub')}`;
}

function atomicWriteJson(filePath, obj) {
  if (!filePath) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    log.warn('Failed to persist execution-contract state (non-fatal)', { filePath, error: err.message });
  }
}

/**
 * Shared-Pool K-Slot Arbiter.
 */
export class SharedPoolArbiter {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxConcurrentPoolSessions]
   * @param {Object<string, number>} [opts.poolLimits]
   * @param {number} [opts.evictionCooldownMs]
   * @param {(attemptId: string, reason: string) => void} [opts.onCancelAttempt]
   * @param {() => void} [opts.onStateChange]
   */
  constructor(opts = {}) {
    this.defaultLimit = opts.maxConcurrentPoolSessions
      ?? config.executionContract?.maxConcurrentPoolSessions
      ?? 4;
    this.poolLimits = { ...(opts.poolLimits || {}) };
    this.evictionCooldownMs = opts.evictionCooldownMs
      ?? config.executionContract?.evictionCooldownMs
      ?? 10 * 60 * 1000;
    this.onCancelAttempt = typeof opts.onCancelAttempt === 'function' ? opts.onCancelAttempt : null;
    this._onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : null;

    /** @type {Map<string, { attemptId: string, poolKey: string, slots: number, reservedAt: number, onAbort: Function|null }>} */
    this._reservationsByAttempt = new Map();
    /** @type {Map<string, Set<string>>} poolKey -> Set<attemptId> */
    this._attemptsByPool = new Map();
    /** @type {Map<string, { cooldownUntil: number, reason: string, trippedAt: number }>} */
    this._evictions = new Map();
  }

  getPoolLimit(poolKey) {
    if (poolKey && typeof this.poolLimits[poolKey] === 'number' && this.poolLimits[poolKey] > 0) {
      return this.poolLimits[poolKey];
    }
    return this.defaultLimit;
  }

  hasReservation(attemptId) {
    return Boolean(attemptId && this._reservationsByAttempt.has(attemptId));
  }

  getReservation(attemptId) {
    return this._reservationsByAttempt.get(attemptId) || null;
  }

  getUsedSlots(poolKey) {
    const set = this._attemptsByPool.get(poolKey);
    if (!set || set.size === 0) return 0;
    let total = 0;
    for (const attemptId of set) {
      const r = this._reservationsByAttempt.get(attemptId);
      if (r) total += r.slots;
    }
    return total;
  }

  isEvicted(poolKey, now = Date.now()) {
    const ev = this._evictions.get(poolKey);
    if (!ev) return null;
    if (now >= ev.cooldownUntil) {
      this._evictions.delete(poolKey);
      this._onStateChange?.();
      return null;
    }
    return ev;
  }

  exportEvictions(now = Date.now()) {
    const out = {};
    for (const [key, ev] of this._evictions.entries()) {
      if (now < ev.cooldownUntil) {
        out[key] = { ...ev };
      }
    }
    return out;
  }

  importEvictions(evictionsObj, now = Date.now()) {
    if (!evictionsObj || typeof evictionsObj !== 'object') return;
    for (const [key, ev] of Object.entries(evictionsObj)) {
      if (ev && typeof ev.cooldownUntil === 'number' && now < ev.cooldownUntil) {
        this._evictions.set(key, {
          cooldownUntil: ev.cooldownUntil,
          reason: String(ev.reason || 'persisted_eviction'),
          trippedAt: ev.trippedAt || now,
        });
      }
    }
  }

  /**
   * Atomically check and reserve `slots` on `poolKey` for `attemptId`.
   */
  reserve(poolKey, slots = 1, attemptId, { onAbort = null } = {}) {
    const key = String(poolKey || 'default');
    const requested = Math.max(1, Number(slots) || 1);
    const id = String(attemptId || `att_${Date.now()}_${randomUUID().slice(0, 8)}`);
    const limit = this.getPoolLimit(key);
    const now = Date.now();

    const activeEviction = this.isEvicted(key, now);
    if (activeEviction) {
      return {
        ok: false,
        reason: 'pool_eviction_tripped',
        poolKey: key,
        used: this.getUsedSlots(key),
        limit,
        cooldownUntil: activeEviction.cooldownUntil,
      };
    }

    const existing = this._reservationsByAttempt.get(id);
    if (existing && existing.poolKey === key) {
      const usedWithoutSelf = this.getUsedSlots(key) - existing.slots;
      if (usedWithoutSelf + requested > limit) {
        return {
          ok: false,
          reason: 'pool_capacity_exhausted',
          poolKey: key,
          used: this.getUsedSlots(key),
          limit,
          cooldownUntil: null,
        };
      }
      existing.slots = requested;
      if (onAbort) existing.onAbort = onAbort;
      return {
        ok: true,
        poolKey: key,
        used: usedWithoutSelf + requested,
        limit,
        cooldownUntil: null,
      };
    }

    const currentUsed = this.getUsedSlots(key);
    if (currentUsed + requested > limit) {
      return {
        ok: false,
        reason: 'pool_capacity_exhausted',
        poolKey: key,
        used: currentUsed,
        limit,
        cooldownUntil: null,
      };
    }

    if (existing) {
      this.release(id);
    }

    this._reservationsByAttempt.set(id, {
      attemptId: id,
      poolKey: key,
      slots: requested,
      reservedAt: now,
      onAbort: typeof onAbort === 'function' ? onAbort : null,
    });
    if (!this._attemptsByPool.has(key)) {
      this._attemptsByPool.set(key, new Set());
    }
    this._attemptsByPool.get(key).add(id);

    return {
      ok: true,
      poolKey: key,
      used: currentUsed + requested,
      limit,
      cooldownUntil: null,
    };
  }

  /**
   * Idempotently release any slots held by `attemptId`.
   */
  release(attemptId) {
    const r = this._reservationsByAttempt.get(attemptId);
    if (!r) return { released: false, slots: 0, poolKey: null };
    this._reservationsByAttempt.delete(attemptId);
    const poolSet = this._attemptsByPool.get(r.poolKey);
    if (poolSet) {
      poolSet.delete(attemptId);
      if (poolSet.size === 0) this._attemptsByPool.delete(r.poolKey);
    }
    return { released: true, slots: r.slots, poolKey: r.poolKey };
  }

  /**
   * Trip pool-wide eviction on `exit 143` (or explicit pool eviction signal).
   *
   * CRITICAL (beta.18 + Finding #4): structured `exitCode === null` or `exit null`
   * MUST NEVER trip pool eviction!
   */
  tripPoolEviction(poolKey, { cooldownMs = null, reason = 'exit 143', exitCode = undefined, error = null } = {}) {
    const key = String(poolKey || 'default');
    const classified = error
      ? classifyExitSignal(error)
      : classifyExitSignal(exitCode !== undefined ? { exitCode, message: reason } : { message: reason });

    if (exitCode === null || classified.isExitNull) {
      log.info('Skipping pool eviction tripwire for local signal (exit null exemption)', {
        poolKey: key, reason: String(reason || ''),
      });
      return {
        tripped: false,
        reason: 'local_signal_exempt',
        poolKey: key,
        cooldownUntil: null,
        cancelledAttempts: [],
      };
    }

    // If a structured non-143 exit code was passed (e.g. 1430 or 1), do not trip eviction
    if (typeof classified.exitCode === 'number' && classified.exitCode !== 143) {
      return {
        tripped: false,
        reason: 'non_eviction_exit_code',
        poolKey: key,
        cooldownUntil: null,
        cancelledAttempts: [],
      };
    }

    const now = Date.now();
    const duration = typeof cooldownMs === 'number' && cooldownMs > 0 ? cooldownMs : this.evictionCooldownMs;
    const cooldownUntil = now + duration;
    const reasonStr = String(reason || (error && error.message) || 'exit 143');
    this._evictions.set(key, {
      cooldownUntil,
      reason: reasonStr,
      trippedAt: now,
    });
    this._onStateChange?.();

    const poolSet = this._attemptsByPool.get(key);
    const activeIds = poolSet ? Array.from(poolSet) : [];
    const cancelledAttempts = [];

    for (const attemptId of activeIds) {
      const res = this._reservationsByAttempt.get(attemptId);
      const cancelMsg = `pool_eviction:${key}:${reasonStr}`;
      cancelledAttempts.push(attemptId);
      if (res?.onAbort) {
        try { res.onAbort(cancelMsg); } catch { /* ignore */ }
      }
      let deferredRelease = false;
      if (this.onCancelAttempt) {
        try {
          this.onCancelAttempt(attemptId, cancelMsg);
          const heldRes = this._reservationsByAttempt.get(attemptId);
          if (heldRes && heldRes._holdUntilExit) deferredRelease = true;
        } catch (err) {
          log.warn('Error in onCancelAttempt during pool eviction', { attemptId, error: err.message });
        }
      }
      if (!deferredRelease && !(this._reservationsByAttempt.get(attemptId)?._holdUntilExit)) this.release(attemptId);
    }

    log.warn('Pool eviction tripped — blocked new reservations and cancelled active pool attempts', {
      poolKey: key,
      cooldownUntil: new Date(cooldownUntil).toISOString(),
      cancelledCount: cancelledAttempts.length,
      reason: reasonStr,
    });

    return {
      tripped: true,
      poolKey: key,
      cooldownUntil,
      cancelledAttempts,
    };
  }

  getPoolStatus(poolKey) {
    const key = String(poolKey || 'default');
    const now = Date.now();
    const ev = this.isEvicted(key, now);
    return {
      poolKey: key,
      used: this.getUsedSlots(key),
      limit: this.getPoolLimit(key),
      evicted: Boolean(ev),
      cooldownUntil: ev ? ev.cooldownUntil : null,
      activeAttempts: Array.from(this._attemptsByPool.get(key) || []),
    };
  }
}

/**
 * Shared dispatch boundary wrapper (Finding #2).
 * Wraps `agent.send(...)` so EVERY dispatch path (lifecycle, strategist,
 * pr-review-dispatcher, execution, agent-interaction, governance, session, etc.)
 * enforces SharedPoolArbiter K-slot limits, pool eviction gating, AbortSignal
 * propagation, and structured exit-143 eviction without double-counting when the
 * caller already holds an active `options.attemptId` reservation.
 */
export function wrapAgentWithPoolArbiter(agent, poolArbiter, { executionContract = null } = {}) {
  if (!agent || typeof agent.send !== 'function' || !poolArbiter) return agent;
  if (agent.send.__poolArbiterWrapped && agent.send.__poolArbiter === poolArbiter) {
    return agent;
  }

  const rawSend = agent.send.__rawSend || agent.send.bind(agent);

  const wrappedSend = async function poolGatedSend(message, workingDir = null, options = {}) {
    const opts = options && typeof options === 'object' ? { ...options } : {};
    const poolKey = opts.poolKey || resolveAgentPoolKey(agent);
    const callerAttemptId = opts.attemptId || null;
    const callerOwnsReservation = Boolean(callerAttemptId && poolArbiter.hasReservation(callerAttemptId));

    // Even if caller owns a reservation, refuse if pool is evicted
    const activeEviction = poolArbiter.isEvicted(poolKey);
    if (activeEviction) {
      const err = new Error(`Shared pool "${poolKey}" is in eviction cooldown until ${new Date(activeEviction.cooldownUntil).toISOString()}`);
      err.code = 'pool_eviction_tripped';
      err.poolKey = poolKey;
      err.cooldownUntil = activeEviction.cooldownUntil;
      throw err;
    }

    if (callerOwnsReservation) {
      return rawSend(message, workingDir, opts);
    }

    // Direct/non-subtask dispatch: reserve slot on shared pool arbiter
    const dispatchAttemptId = callerAttemptId || `disp_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const dispatchAbort = new AbortController();
    const externalSignal = opts.signal || null;
    const onExternalAbort = () => {
      if (!dispatchAbort.signal.aborted) {
        dispatchAbort.abort(externalSignal?.reason || new Error('caller_aborted'));
      }
    };
    if (externalSignal) {
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const res = poolArbiter.reserve(poolKey, opts.slots || 1, dispatchAttemptId, {
      onAbort: (reason) => {
        if (!dispatchAbort.signal.aborted) {
          dispatchAbort.abort(new Error(reason));
        }
      },
    });
    if (res.ok) {
      const rObj = poolArbiter.getReservation(dispatchAttemptId);
      if (rObj) rObj._holdUntilExit = true;
    }
    if (!res.ok) {
      if (externalSignal) {
        try { externalSignal.removeEventListener('abort', onExternalAbort); } catch {}
      }
      const err = new Error(`Shared pool "${poolKey}" refused dispatch (${res.reason}: ${res.used}/${res.limit})`);
      err.code = res.reason;
      err.poolKey = poolKey;
      err.used = res.used;
      err.limit = res.limit;
      err.cooldownUntil = res.cooldownUntil;
      throw err;
    }

    try {
      return await rawSend(message, workingDir, {
        ...opts,
        signal: dispatchAbort.signal,
        attemptId: dispatchAttemptId,
      });
    } catch (err) {
      // Only trip eviction if this dispatch is still the active holder and error is structured exit 143
      const exitInfo = classifyExitSignal(err);
      if (exitInfo.isExit143 && !dispatchAbort.signal.aborted && poolArbiter.hasReservation(dispatchAttemptId)) {
        poolArbiter.tripPoolEviction(poolKey, {
          reason: err?.message || 'exit 143',
          exitCode: 143,
          error: err,
        });
      }
      throw err;
    } finally {
      if (externalSignal) {
        try { externalSignal.removeEventListener('abort', onExternalAbort); } catch {}
      }
      poolArbiter.release(dispatchAttemptId);
      if (executionContract && !callerAttemptId) {
        // non-contract dispatch; nothing to deregister
      }
    }
  };

  wrappedSend.__poolArbiterWrapped = true;
  wrappedSend.__poolArbiter = poolArbiter;
  wrappedSend.__rawSend = rawSend;
  agent.send = wrappedSend;
  return agent;
}

export function installSharedPoolBoundary(agentsMap, poolArbiter, { executionContract = null } = {}) {
  if (!agentsMap || !poolArbiter) return agentsMap;
  for (const agent of Object.values(agentsMap)) {
    wrapAgentWithPoolArbiter(agent, poolArbiter, { executionContract });
  }
  return agentsMap;
}

/**
 * Single Authoritative Execution Contract.
 */
export class ExecutionContract {
  /**
   * @param {Object} [opts]
   * @param {SharedPoolArbiter} [opts.poolArbiter]
   * @param {number} [opts.leaseMs]
   * @param {string|null} [opts.statePath] - optional path for persisting fenceSeq & pool evictions across restarts
   */
  constructor(opts = {}) {
    this.leaseMs = opts.leaseMs ?? config.executionContract?.leaseMs ?? 12 * 60 * 1000;
    this.statePath = opts.statePath || null;
    this.poolArbiter = opts.poolArbiter || new SharedPoolArbiter();
    this._fenceSeq = 0;

    /** @type {Map<string, Object>} attemptId -> attempt record */
    this._attemptsById = new Map();
    /** @type {Map<string, Object>} subtaskKey -> active attempt record */
    this._activeBySubtaskKey = new Map();

    // Load persisted monotonic fenceSeq & active pool evictions if statePath exists
    this._loadState();

    // Wire poolArbiter callbacks
    const prevCancel = this.poolArbiter.onCancelAttempt;
    this.poolArbiter.onCancelAttempt = (attemptId, reason) => {
      if (prevCancel) prevCancel(attemptId, reason);
      this.cancelAttempt(attemptId, reason);
    };
    const prevStateChange = this.poolArbiter._onStateChange;
    this.poolArbiter._onStateChange = () => {
      if (prevStateChange) prevStateChange();
      this._persistState();
    };
  }

  _loadState() {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (typeof raw?.fenceSeq === 'number' && raw.fenceSeq > this._fenceSeq) {
        this._fenceSeq = raw.fenceSeq;
      }
      if (raw?.evictions) {
        this.poolArbiter.importEvictions(raw.evictions);
      }
    } catch (err) {
      log.warn('Failed to load persisted execution-contract state (starting fresh)', {
        statePath: this.statePath, error: err.message,
      });
    }
  }

  _persistState() {
    if (!this.statePath) return;
    atomicWriteJson(this.statePath, {
      fenceSeq: this._fenceSeq,
      evictions: this.poolArbiter.exportEvictions(),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Mint a new durable attemptId and monotonic fenceToken for a subtask.
   * Finding #10: atomic same-subtask replacement at full pool (K=1) releases the
   * superseded attempt's slot before reserving the replacement iff the replacement
   * can succeed; otherwise leaves the prior attempt undisturbed.
   */
  createAttempt({
    projectId = '_proj',
    taskId = '_task',
    subtaskId = '_sub',
    subKey = null,
    agentId = 'system',
    poolKey = null,
    slots = 1,
    worktreePath = null,
    branchName = null,
    reservePool = false,
  } = {}) {
    const key = subKey || normalizeSubtaskKey({ projectId, taskId, subtaskId });
    const requestedSlots = Math.max(1, Number(slots) || 1);
    const attemptId = `att_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const prior = this._activeBySubtaskKey.get(key);
    const priorIsActive = Boolean(prior && prior.status === 'active');

    let poolReservation = null;
    if (reservePool && poolKey && this.poolArbiter) {
      const targetKey = String(poolKey);
      const limit = this.poolArbiter.getPoolLimit(targetKey);
      const activeEviction = this.poolArbiter.isEvicted(targetKey);
      if (activeEviction) {
        return {
          ok: false,
          reason: 'pool_eviction_tripped',
          poolReservation: {
            ok: false,
            reason: 'pool_eviction_tripped',
            poolKey: targetKey,
            used: this.poolArbiter.getUsedSlots(targetKey),
            limit,
            cooldownUntil: activeEviction.cooldownUntil,
          },
          attemptId: null,
          fenceToken: null,
        };
      }

      // Compute effective pool usage accounting for prior attempt on the SAME subtask & pool
      const priorRes = (priorIsActive && !prior.processRunning) ? this.poolArbiter.getReservation(prior.attemptId) : null;
      const priorFreedSlots = (priorRes && priorRes.poolKey === targetKey) ? priorRes.slots : 0;
      const currentUsed = this.poolArbiter.getUsedSlots(targetKey);
      const effectiveUsed = Math.max(0, currentUsed - priorFreedSlots);

      if (effectiveUsed + requestedSlots > limit) {
        return {
          ok: false,
          reason: 'pool_capacity_exhausted',
          poolReservation: {
            ok: false,
            reason: 'pool_capacity_exhausted',
            poolKey: targetKey,
            used: currentUsed,
            limit,
            cooldownUntil: null,
          },
          attemptId: null,
          fenceToken: null,
        };
      }

      // Replacement fits! Cancel & release prior attempt BEFORE reserving the new slot atomically
      if (priorIsActive) {
        this.cancelAttempt(prior.attemptId, `superseded_by_${attemptId}`);
      }

      poolReservation = this.poolArbiter.reserve(targetKey, requestedSlots, attemptId);
      if (!poolReservation.ok) {
        return {
          ok: false,
          reason: poolReservation.reason,
          poolReservation,
          attemptId: null,
          fenceToken: null,
        };
      }
    } else if (priorIsActive) {
      // Non-reserved attempt still supersedes any prior active attempt on the same subtask
      this.cancelAttempt(prior.attemptId, `superseded_by_${attemptId}`);
    }

    const fenceToken = ++this._fenceSeq;
    const abortController = new AbortController();
    const record = {
      ok: true,
      attemptId,
      fenceToken,
      subtaskKey: key,
      projectId,
      taskId,
      subtaskId,
      agentId,
      poolKey: poolKey || null,
      slots: requestedSlots,
      worktreePath: worktreePath || null,
      branchName: branchName || null,
      startedAt: Date.now(),
      endedAt: null,
      status: 'active',
      processRunning: false,
      releasing: false,
      cancelReason: null,
      abortController,
      signal: abortController.signal,
      poolReservation,
    };

    this._attemptsById.set(attemptId, record);
    this._activeBySubtaskKey.set(key, record);
    this._persistState();
    return record;
  }

  /**
   * Update worktree metadata on an active attempt.
   */
  updateAttemptWorktree(attemptId, { worktreePath = null, branchName = null } = {}) {
    const attempt = this._attemptsById.get(attemptId);
    if (!attempt) return null;
    if (worktreePath !== null) attempt.worktreePath = worktreePath;
    if (branchName !== null) attempt.branchName = branchName;
    return attempt;
  }

  /**
   * Check whether (attemptId, fenceToken) is still the valid active owner of `subtaskKey`.
   * Finding #1: When `persistedSubtask` (or `{ task, subtask }` / `taskManager` context) is provided,
   * ALSO verifies that persisted ownership matches (attemptId, fenceToken, non-terminal status).
   */
  isFenceValid(subtaskKeyOrObj, attemptId, fenceToken = undefined, persistedSubtaskOrCtx = null) {
    if (!attemptId) return false;
    const key = normalizeSubtaskKey(subtaskKeyOrObj);
    const active = this._activeBySubtaskKey.get(key);
    if (!active) return false;
    if (active.status !== 'active') return false;
    if (active.abortController?.signal?.aborted) return false;
    if (active.attemptId !== attemptId) return false;
    if (fenceToken !== undefined && fenceToken !== null && active.fenceToken !== fenceToken) {
      return false;
    }

    if (persistedSubtaskOrCtx) {
      return this.verifyPersistedSubtaskRecord(persistedSubtaskOrCtx, {
        attemptId,
        fenceToken,
        agentId: active.agentId,
      });
    }
    return true;
  }

  /**
   * Verify persisted ownership on a subtask (or { task, subtask } / live taskManager lookup).
   */
  verifyPersistedSubtaskRecord(persistedSubtaskOrCtx, { attemptId, fenceToken = undefined, agentId = null } = {}) {
    if (!persistedSubtaskOrCtx || !attemptId) return false;
    let task = null;
    let st = persistedSubtaskOrCtx;

    if (persistedSubtaskOrCtx.taskManager && persistedSubtaskOrCtx.projectId && persistedSubtaskOrCtx.taskId && persistedSubtaskOrCtx.subtaskId) {
      task = persistedSubtaskOrCtx.taskManager.getTask(persistedSubtaskOrCtx.projectId, persistedSubtaskOrCtx.taskId);
      if (!task) return false;
      st = (task.subtasks || []).find(s => s.id === persistedSubtaskOrCtx.subtaskId) || null;
    } else if (persistedSubtaskOrCtx.subtask !== undefined || persistedSubtaskOrCtx.task !== undefined) {
      task = persistedSubtaskOrCtx.task || null;
      st = persistedSubtaskOrCtx.subtask || null;
    }

    if (task && TERMINAL_TASK_STATUSES.has(task.status)) return false;
    if (!st) return false;
    if (!ACTIVE_SUBTASK_STATUSES.has(st.status)) return false;
    if (st.claimedUntil && Date.parse(st.claimedUntil) <= Date.now()) return false;
    if (agentId && st.assignee && st.assignee !== agentId) return false;
    if (st.meta?.attemptId !== attemptId) return false;
    if (fenceToken !== undefined && fenceToken !== null && st.meta?.fenceToken !== fenceToken) {
      return false;
    }
    return true;
  }

  /**
   * Combined in-memory + persisted ownership gate (Finding #1).
   */
  verifyPersistedOwnership({ taskManager, projectId, taskId, subtaskId, attemptId, fenceToken = undefined, agentId = null }) {
    if (!this.isFenceValid({ projectId, taskId, subtaskId }, attemptId, fenceToken)) {
      return false;
    }
    if (!taskManager) return true;
    return this.verifyPersistedSubtaskRecord(
      { taskManager, projectId, taskId, subtaskId },
      { attemptId, fenceToken, agentId }
    );
  }

  getAttempt(attemptId) {
    return this._attemptsById.get(attemptId) || null;
  }

  getActiveAttempt(subtaskKeyOrObj) {
    const key = normalizeSubtaskKey(subtaskKeyOrObj);
    return this._activeBySubtaskKey.get(key) || null;
  }

  isAttemptLive(attemptId, { leaseMs = null, now = Date.now() } = {}) {
    if (!attemptId) return false;
    const att = this._attemptsById.get(attemptId);
    if (!att || att.status !== 'active') return false;
    if (att.abortController?.signal?.aborted) return false;
    const maxLease = leaseMs ?? this.leaseMs;
    if (maxLease && (now - att.startedAt) > maxLease) return false;
    return true;
  }

  /**
   * Cancel a specific attempt by attemptId, firing its AbortController and releasing pool slots.
   */
  cancelAttempt(attemptId, reason = 'cancelled') {
    const att = this._attemptsById.get(attemptId);
    if (!att) {
      this.poolArbiter?.release(attemptId);
      return false;
    }
    const wasActive = att.status === 'active';
    att.status = 'cancelled';
    att.cancelReason = String(reason || 'cancelled');
    att.endedAt = Date.now();

    const currentActive = this._activeBySubtaskKey.get(att.subtaskKey);
    if (currentActive && currentActive.attemptId === attemptId) {
      this._activeBySubtaskKey.delete(att.subtaskKey);
    }

    try {
      if (!att.abortController.signal.aborted) {
        att.abortController.abort(new Error(att.cancelReason));
      }
    } catch { /* ignore abort errors */ }

    // New P1 #3: If a child process is still actively exiting, hold the pool slot until
    // markProcessExited/finishAttempt runs in finally so a replacement cannot overlap the dying process.
    if (att.processRunning) {
      att.releasing = true;
    } else {
      this.poolArbiter?.release(attemptId);
    }
    return wasActive;
  }

  markProcessRunning(attemptId) {
    const att = this._attemptsById.get(attemptId);
    if (att) { att.processRunning = true; const r = this.poolArbiter?.getReservation(attemptId); if (r) r._holdUntilExit = true; }
  }

  markProcessExited(attemptId) {
    const att = this._attemptsById.get(attemptId);
    if (att) {
      att.processRunning = false;
      const r = this.poolArbiter?.getReservation(attemptId);
      if (r) r._holdUntilExit = false;
      if (att.releasing || att.status !== 'active') {
        att.releasing = false;
        this.poolArbiter?.release(attemptId);
      }
    }
  }

  getActiveAttemptIds() {
    const ids = new Set();
    for (const att of this._attemptsById.values()) {
      if (att.status === 'active' || att.processRunning || att.releasing) {
        ids.add(att.attemptId);
      }
    }
    return ids;
  }

  /**
   * Cancel any active attempt for the given subtask key.
   */
  cancelSubtaskAttempts(subtaskKeyOrObj, reason = 'subtask_cancelled') {
    const key = normalizeSubtaskKey(subtaskKeyOrObj);
    const active = this._activeBySubtaskKey.get(key);
    if (!active) return false;
    return this.cancelAttempt(active.attemptId, reason);
  }

  /**
   * Cancel all active attempts belonging to a task (used on operator task cancellation).
   */
  cancelTaskAttempts(projectId, taskId, reason = 'task_cancelled') {
    const cancelled = [];
    for (const att of Array.from(this._activeBySubtaskKey.values())) {
      if (att.projectId === projectId && att.taskId === taskId) {
        if (this.cancelAttempt(att.attemptId, reason)) {
          cancelled.push(att.attemptId);
        }
      }
    }
    return cancelled;
  }

  /**
   * Mark an attempt cleanly finished and release its pool reservation.
   */
  finishAttempt(attemptId, outcome = 'completed') {
    const att = this._attemptsById.get(attemptId);
    if (!att) {
      this.poolArbiter?.release(attemptId);
      return false;
    }
    if (att.status === 'active') {
      att.status = outcome;
      att.endedAt = Date.now();
    }
    const currentActive = this._activeBySubtaskKey.get(att.subtaskKey);
    if (currentActive && currentActive.attemptId === attemptId) {
      this._activeBySubtaskKey.delete(att.subtaskKey);
    }
    // Defer pool slot release if the underlying child process is still exiting!
    // markProcessExited(attemptId) releases the slot once the raw send promise settles.
    if (att.processRunning) {
      att.releasing = true;
    } else {
      att.releasing = false;
      this.poolArbiter?.release(attemptId);
    }
    return true;
  }
}

/**
 * Reconcile orphaned attempts across tasks on startup / heartbeat.
 * Explicitly skips `task.type === 'daemon'` (preserving netwatch!).
 */
export async function reconcileOrphanedAttempts({
  tasks = [],
  projectId = null,
  projectDir = null,
  executionContract = null,
  isAttemptLive = null,
  leaseMs = null,
  now = Date.now(),
  onReapWorktree = null,
  onReconcileSubtask = null,
} = {}) {
  let scannedTasks = 0;
  let skippedDaemonTasks = 0;
  const reconciled = [];
  const reapedWorktrees = [];

  for (const task of tasks) {
    if (!task) continue;
    // CRITICAL: explicitly skip daemon tasks (e.g. netwatch daemon monitor cycle)
    if (task.type === 'daemon') {
      skippedDaemonTasks++;
      continue;
    }
    if (task.status !== 'executing') continue;
    scannedTasks++;

    const projId = projectId || task.project || '_proj';
    for (const st of (task.subtasks || [])) {
      if (!st || (st.status !== 'executing' && st.status !== 'claimed')) continue;

      const attemptId = st.meta?.attemptId || null;
      const worktreePath = st.meta?.worktreePath || null;
      const subtaskBranch = st.meta?.subtaskBranch || null;

      let live = false;
      if (typeof isAttemptLive === 'function') {
        live = Boolean(await isAttemptLive(attemptId, st, task));
      } else if (executionContract) {
        live = executionContract.isAttemptLive(attemptId, { leaseMs, now });
      } else if (st.claimedUntil) {
        live = now <= Date.parse(st.claimedUntil);
      }

      if (live) continue;

      if (executionContract && attemptId) {
        executionContract.cancelAttempt(attemptId, 'orphaned_attempt_reconciled');
      }

      if ((worktreePath || subtaskBranch) && typeof onReapWorktree === 'function') {
        try {
          await onReapWorktree({
            projectId: projId,
            projectDir,
            taskId: task.id,
            subtaskId: st.id,
            attemptId,
            worktreePath,
            subtaskBranch,
          });
          reapedWorktrees.push({ taskId: task.id, subtaskId: st.id, attemptId, worktreePath, subtaskBranch });
        } catch (err) {
          log.warn('Failed to reap orphaned subtask worktree during reconciliation', {
            taskId: task.id, subtaskId: st.id, worktreePath, error: err.message,
          });
        }
      }

      if (typeof onReconcileSubtask === 'function') {
        await onReconcileSubtask({
          projectId: projId,
          taskId: task.id,
          subtaskId: st.id,
          attemptId,
          subtask: st,
          task,
        });
      }

      reconciled.push({
        projectId: projId,
        taskId: task.id,
        subtaskId: st.id,
        attemptId,
        worktreePath,
        subtaskBranch,
      });
    }
  }

  return {
    scannedTasks,
    skippedDaemonTasks,
    reconciled,
    reapedWorktrees,
  };
}
