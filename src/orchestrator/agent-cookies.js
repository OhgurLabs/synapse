/**
 * Agent Cookies — Punch-in/punch-out tracking for agent work assignments.
 *
 * "Cookies on the table" model: the subtask (cookie) records who picked it up,
 * when, and what process is behind it. The agentCookies Map is a hot cache
 * rebuilt from subtask state every heartbeat via reconcile().
 *
 * Replaces: busyAgents Set, activePickups counter, standalone stuck-subtask timeout,
 * claimedUntil lease timeout, and the broken busyAgents self-heal.
 *
 * Source of truth chain:
 *   1. Subtask state (tasks.json) — persisted, survives restart
 *   2. Sandbox process map — OS-level liveness (pid → alive/dead)
 *   3. Provider timeout — stuck detection
 *
 * The cache (this Map) is updated inline on dispatch/completion for fast O(1) checks,
 * and reconciled from source of truth every heartbeat (30s) to catch any drift.
 */

import { createLogger } from '../logger.js';
import { getAgentCostTier } from '../tasks.js';

const log = createLogger('agent-cookies');

/**
 * @typedef {Object} Cookie
 * @property {'executing'|'planning'} type
 * @property {string|null} projectId
 * @property {string|null} taskId
 * @property {string|null} subtaskId
 * @property {number} since - timestamp ms
 * @property {number|null} pid - sandbox process pid (if known)
 * @property {'preparing'|'dispatching'|'running'} phase - dispatch lifecycle phase
 */

/**
 * Create the agent cookies system.
 *
 * @param {Object} deps
 * @param {Object} deps.taskManager
 * @param {Object} deps.stateManager
 * @param {Object} deps.sandbox - ProcessSandbox instance
 * @param {Object} deps.agents - agent map { id: agentObj }
 * @param {Object} deps.config
 * @returns {Object} cookies API
 */
export function createAgentCookies(deps) {
  const { taskManager, stateManager, sandbox, agents, config } = deps;

  /** @type {Map<string, Cookie>} agentId → cookie */
  const cookies = new Map();

  // Pickup slots: limit how many agents can simultaneously seek/claim work.
  // Implements the "pickupSlots" config (default: 3).
  // Key: agentId → { since: timestamp, costTier: number }
  const pickupSlots = new Map();
  // Read live (not captured as a const) so a /api/settings/tasks PATCH to
  // pickupSlots takes effect without a restart.
  const maxPickupSlots = () => config.tasks?.pickupSlots ?? 3;

  // Crash circuit breaker: tracks how many times reconciliation has requeued
  // a subtask due to dead processes. If a subtask keeps crashing, fail it instead
  // of endlessly requeuing. Key: "taskId:subtaskId" → count.
  const requeueCounts = new Map();
  const MAX_REQUEUE_BY_RECONCILE = 3;

  // ─── Inline operations (hot path) ────────────────────────────

  /**
   * Check out a cookie — agent is picking up work.
   * Called inline at dispatch time for immediate mutual exclusion.
   */
  function checkout(agentId, { type = 'executing', projectId = null, taskId = null, subtaskId = null, pid = null } = {}) {
    cookies.set(agentId, {
      type,
      projectId,
      taskId,
      subtaskId,
      since: Date.now(),
      pid,
      phase: type === 'executing' ? 'preparing' : 'running',
    });
    log.info('Cookie checked out', { agentId, type, projectId, taskId, subtaskId });
  }

  /**
   * Mark the point immediately before agent.send(). This resets the short
   * process-spawn grace window after potentially slow pre-dispatch setup.
   */
  function markDispatchStarted(agentId) {
    const cookie = cookies.get(agentId);
    if (!cookie || cookie.type !== 'executing') return false;
    cookie.phase = 'dispatching';
    cookie.since = Date.now();
    return true;
  }

  /**
   * Refresh the preparing grace window while pre-dispatch setup is still making
   * progress (branch checkout, PR open, context build, etc.).
   *
   * Without this, a slow but live setup path can exceed preparingGraceMs and
   * reconcile will requeue the subtask while the original path is still running
   * → double-dispatch. Only acts when phase is still 'preparing'.
   *
   * @returns {boolean} true if the cookie was touched
   */
  function touchPreparing(agentId) {
    const cookie = cookies.get(agentId);
    if (!cookie || cookie.type !== 'executing' || cookie.phase !== 'preparing') return false;
    cookie.since = Date.now();
    return true;
  }

  /**
   * Return a cookie — agent is done with work.
   * Called in finally block after execution completes.
   */
  function checkin(agentId) {
    const cookie = cookies.get(agentId);
    if (cookie) {
      const durationMs = Date.now() - cookie.since;
      log.info('Cookie returned', { agentId, type: cookie.type, durationMs, taskId: cookie.taskId, subtaskId: cookie.subtaskId });
    }
    cookies.delete(agentId);
  }

  /**
   * Is this agent currently holding a cookie?
   * Compatible with old busyAgents.has(agentId) interface.
   */
  function has(agentId) {
    return cookies.has(agentId);
  }

  /**
   * Get the cookie details for an agent.
   * @returns {Cookie|undefined}
   */
  function get(agentId) {
    return cookies.get(agentId);
  }

  /**
   * Count agents busy for a specific provider.
   * Replaces: [...busyAgents].filter(id => agents[id]?.provider === p).length
   */
  function countByProvider(provider) {
    let count = 0;
    for (const [agentId] of cookies) {
      if ((agents[agentId]?.provider || agentId) === provider) count++;
    }
    return count;
  }

  /**
   * Get the number of checked-out cookies.
   * Compatible with old busyAgents.size interface.
   */
  function getSize() {
    return cookies.size;
  }

  // ─── Pickup slot operations ─────────────────────────────────

  /**
   * Try to acquire a pickup slot for an agent.
   * Returns true if slot acquired, false if no slots available.
   *
   * Priority: cheapest eligible agents get slots first.
   * Excludes: governors (they have special handling)
   *
   * @param {string} agentId - agent requesting slot
   * @returns {boolean} true if slot acquired
   */
  function tryAcquirePickupSlot(agentId) {
    log.debug('tryAcquirePickupSlot called', { agentId, maxSlots: maxPickupSlots(), currentSlots: pickupSlots.size });
    const agent = agents[agentId];
    if (!agent) return false;

    // Governors never pick up regular work
    if (agent.role === 'governor') {
      log.debug('Pickup slot: governor excluded', { agentId });
      return false;
    }

    // Check if already has a slot
    if (pickupSlots.has(agentId)) {
      return true; // already has slot
    }

    // Check if slot available
    if (pickupSlots.size >= maxPickupSlots()) {
      // No slots available - check if we should preempt a more expensive agent
      const agentCostTier = getAgentCostTier(agentId, agent.provider);
      const mostExpensiveSlot = getMostExpensivePickupSlot();

      if (mostExpensiveSlot && agentCostTier < mostExpensiveSlot.costTier) {
        // Preempt the more expensive agent's slot
        log.info('Pickup slot: preempting more expensive agent', {
          requestingAgent: agentId,
          requestingTier: agentCostTier,
          preemptedAgent: mostExpensiveSlot.agentId,
          preemptedTier: mostExpensiveSlot.costTier,
        });
        pickupSlots.delete(mostExpensiveSlot.agentId);
      } else {
        log.debug('Pickup slot: no slots available', {
          agentId,
          currentSlots: pickupSlots.size,
          maxSlots: maxPickupSlots(),
        });
        return false;
      }
    }

    // Acquire slot
    const costTier = getAgentCostTier(agentId, agent.provider);
    pickupSlots.set(agentId, {
      since: Date.now(),
      costTier,
    });
    log.info('Pickup slot acquired', { agentId, costTier, slotsInUse: pickupSlots.size });
    return true;
  }

  /**
   * Release a pickup slot for an agent.
   * Called when agent completes seeking (found work or gave up).
   *
   * @param {string} agentId - agent releasing slot
   */
  function releasePickupSlot(agentId) {
    if (pickupSlots.has(agentId)) {
      const slot = pickupSlots.get(agentId);
      const heldMs = Date.now() - slot.since;
      log.info('Pickup slot released', { agentId, costTier: slot.costTier, heldMs });
      pickupSlots.delete(agentId);
    }
  }

  /**
   * Check if an agent has a pickup slot.
   * @param {string} agentId
   * @returns {boolean}
   */
  function hasPickupSlot(agentId) {
    return pickupSlots.has(agentId);
  }

  /**
   * Get the most expensive pickup slot (for preemption).
   * @returns {{agentId: string, costTier: number}|null}
   */
  function getMostExpensivePickupSlot() {
    let mostExpensive = null;
    for (const [agentId, slot] of pickupSlots) {
      if (!mostExpensive || slot.costTier > mostExpensive.costTier) {
        mostExpensive = { agentId, costTier: slot.costTier };
      }
    }
    return mostExpensive;
  }

  /**
   * Get pickup slot stats for monitoring.
   * @returns {{total: number, available: number, slots: Array}}
   */
  function getPickupSlotStats() {
    const slots = [];
    for (const [agentId, slot] of pickupSlots) {
      slots.push({
        agentId,
        costTier: slot.costTier,
        heldMs: Date.now() - slot.since,
      });
    }
    return {
      total: maxPickupSlots(),
      available: maxPickupSlots() - pickupSlots.size,
      slots: slots.sort((a, b) => a.costTier - b.costTier),
    };
  }

  // ─── Reconciliation (heartbeat, every 30s) ───────────────────

  /**
   * Get provider-specific execution timeout for an agent.
   */
  function getProviderTimeout(agentId) {
    const provider = agents[agentId]?.provider || agentId;
    return config.tasks?.stuckSubtaskTimeoutMsByProvider?.[provider]
      ?? config.tasks?.stuckSubtaskTimeoutMs
      ?? 600_000; // 10min default
  }

  /**
   * Three-way reconciliation: subtask state × sandbox processes × timeouts.
   *
   * This is the core of the cookie model. Every 30 seconds:
   * 1. Scan all active subtasks — these are the checked-out cookies (source of truth)
   * 2. Cross-reference with sandbox — is the process behind each cookie alive?
   * 3. Check timeouts — has the cookie been held too long?
   *
   * Actions:
   * - Dead process + executing subtask → return cookie to table (requeue subtask)
   * - Stuck process + executing subtask → kill process + fail subtask
   * - Orphan process (no subtask) + not planning → kill process
   * - Cache entry with no backing subtask → clear stale cache entry
   *
   * @param {Function} [isAgentPlanningNow] - check if agent is in a planning session
   * @returns {{ cleared: number, orphansKilled: number, stuckKilled: number }}
   */
  function reconcile(isAgentPlanningNow = null) {
    const stats = { cleared: 0, orphansKilled: 0, stuckKilled: 0, processDeadRequeued: 0 };

    // Build process liveness map from sandbox
    const liveProcesses = new Map();
    if (sandbox) {
      for (const proc of sandbox.getActiveProcesses()) {
        if (proc.agent) liveProcesses.set(proc.agent.toLowerCase(), proc);
      }
    }

    // Scan subtask state — the source of truth
    const fresh = new Map();
    const projects = stateManager.listProjects();

    // requeueCounts pruning: track every live (non-terminal) subtask key this
    // pass; keys absent from the scan belong to finished/removed subtasks and
    // can be dropped. Without this the map grows forever (one entry per subtask
    // that ever crashed). If any project fails to load we skip pruning — absence
    // from a failed scan is not evidence of completion.
    const liveRequeueKeys = new Set();
    let anyProjectScanFailed = false;

    for (const proj of projects) {
      let tasks;
      try {
        tasks = taskManager.listTasks(proj.id);
      } catch {
        anyProjectScanFailed = true;
        continue;
      }

      for (const task of tasks) {
        for (const st of task.subtasks || []) {
          if (st && st.status !== 'done' && st.status !== 'failed') {
            liveRequeueKeys.add(`${task.id}:${st.id}`);
          }
        }
        if (!task.subtasks || !['executing', 'planning', 'reviewing'].includes(task.status)) continue;

        for (const st of task.subtasks) {
          if (!st.assignee) continue;
          if (st.status !== 'claimed' && st.status !== 'executing') continue;

          const agentId = st.assignee;
          const proc = liveProcesses.get(agentId.toLowerCase());
          const cachedCookie = cookies.get(agentId);
          const matchingCachedCookie = cachedCookie
            && cachedCookie.taskId === task.id
            && cachedCookie.subtaskId === st.id
            ? cachedCookie
            : null;
          // Use process runtime (not claim age) for stuck detection when process is alive.
          // After restarts, claimedAt may be hours old even though the process just spawned.
          const claimAge = Date.now() - new Date(st.claimedAt || st.updatedAt || Date.now()).getTime();
          const processAge = proc?.runningMs || claimAge;
          const cookieAge = proc ? Math.min(claimAge, processAge) : claimAge;
          // Verbatim one-shot subtasks (A/B parity mode) run effectively
          // uncapped: the dispatch timeout, sandbox lifetime, AND this stuck
          // detector must all agree, or the shortest one silently becomes a
          // run parameter (found live: reconcile killed a healthy 10-minute
          // build mid-run while dispatch allowed 24h).
          const providerTimeout = st.meta?.verbatim === true
            ? (config.tasks?.oneshotTimeoutMs ?? 86_400_000)
            : getProviderTimeout(agentId);

          const preProcessPhase = !proc && ['preparing', 'dispatching'].includes(matchingCachedCookie?.phase)
            ? matchingCachedCookie.phase
            : null;
          const noProcessAge = preProcessPhase
            ? Date.now() - matchingCachedCookie.since
            : cookieAge;
          // preparingGraceMs: config default 180s; never exceed provider timeout.
          const preparingGraceMs = Math.min(
            providerTimeout,
            config.tasks?.preparingGraceMs ?? 180_000,
          );
          const noProcessGraceMs = preProcessPhase === 'preparing'
            ? preparingGraceMs
            : 5_000;
          const effectiveCookieAge = preProcessPhase ? noProcessAge : cookieAge;

          // Step 1: Is the process behind this cookie alive?
          // Pre-dispatch git/audit setup can legitimately take longer than the
          // normal process-spawn window. Preserve its explicit preparing cookie
          // for up to two minutes; markDispatchStarted resets to the normal 5s
          // spawn grace immediately before agent.send().
          if (!proc && noProcessAge > noProcessGraceMs) {
            const requeueKey = `${task.id}:${st.id}`;
            const priorRequeues = requeueCounts.get(requeueKey) || 0;

            if (priorRequeues >= MAX_REQUEUE_BY_RECONCILE) {
              // Crash circuit breaker: subtask keeps dying, stop requeuing
              log.error('Reconcile: crash circuit breaker — subtask failed too many times, failing permanently', {
                agentId, taskId: task.id, subtaskId: st.id,
                projectId: proj.id, requeues: priorRequeues, cookieAgeMs: cookieAge,
              });
              try {
                taskManager.updateSubtask(proj.id, task.id, st.id, {
                  status: 'failed',
                  error: `Process died ${priorRequeues} times — crash circuit breaker tripped`,
                }, 'system');
              } catch (err) {
                log.warn('Reconcile: failed to fail crashed subtask', { taskId: task.id, subtaskId: st.id, error: err.message });
              }
              requeueCounts.delete(requeueKey);
              stats.stuckKilled++;
              continue;
            }

            // Process dead, cookie still checked out — return cookie to table
            requeueCounts.set(requeueKey, priorRequeues + 1);
            log.warn('Reconcile: process dead, returning cookie to table', {
              agentId, taskId: task.id, subtaskId: st.id,
              projectId: proj.id, cookieAgeMs: noProcessAge,
              requeueAttempt: priorRequeues + 1, maxRequeues: MAX_REQUEUE_BY_RECONCILE,
            });
            try {
              taskManager.updateSubtask(proj.id, task.id, st.id, {
                status: 'queued',
              }, 'system');
            } catch (err) {
              log.warn('Reconcile: failed to requeue subtask', { taskId: task.id, subtaskId: st.id, error: err.message });
            }
            stats.processDeadRequeued++;
            continue;
          }

          // Step 2: Is the cookie held too long? (stuck process)
          // proc may be undefined here (claim within the 5s spawn grace period) — never deref it directly.
          if (effectiveCookieAge > providerTimeout) {
            log.error('Reconcile: stuck process, killing + failing', {
              agentId, taskId: task.id, subtaskId: st.id,
              projectId: proj.id, cookieAgeMs: effectiveCookieAge, timeoutMs: providerTimeout, pid: proc?.pid ?? null,
            });
            // Kill process
            if (sandbox && proc) {
              try { sandbox.killProcess(proc.pid, 'stuck_cookie_timeout'); } catch { /* already dead */ }
            }
            // Fail subtask
            try {
              taskManager.updateSubtask(proj.id, task.id, st.id, {
                status: 'failed',
                error: `Process stuck (${Math.round(providerTimeout / 60000)}m timeout exceeded by ${Math.round((effectiveCookieAge - providerTimeout) / 60000)}m)`,
              }, 'system');
            } catch (err) {
              log.warn('Reconcile: failed to fail stuck subtask', { taskId: task.id, subtaskId: st.id, error: err.message });
            }
            stats.stuckKilled++;
            continue;
          }

          // Step 3: Legitimate work — agent keeps the cookie
          fresh.set(agentId, preProcessPhase ? { ...matchingCachedCookie } : {
            type: 'executing',
            projectId: proj.id,
            taskId: task.id,
            subtaskId: st.id,
            since: new Date(st.claimedAt || st.updatedAt || Date.now()).getTime(),
            pid: proc?.pid ?? null,
            phase: proc ? 'running' : 'dispatching',
          });
        }
      }
    }

    // Drop requeue counters for subtasks that no longer exist or reached a
    // terminal state — bounded memory, and stale counters can't poison a
    // future subtask that happens to reuse an id.
    if (!anyProjectScanFailed) {
      for (const key of requeueCounts.keys()) {
        if (!liveRequeueKeys.has(key)) requeueCounts.delete(key);
      }
    }

    // Check for planning agents (have process but no executing subtask)
    for (const [agentIdLower, proc] of liveProcesses) {
      // Find the original-case agentId
      const agentId = Object.keys(agents).find(id => id.toLowerCase() === agentIdLower) || agentIdLower;
      if (!fresh.has(agentId)) {
        if (isAgentPlanningNow && isAgentPlanningNow(agentId)) {
          // Planning — legitimate, give it a cookie
          fresh.set(agentId, {
            type: 'planning',
            projectId: null,
            taskId: proc.taskId || null,
            subtaskId: null,
            since: Date.now() - (proc.runningMs || 0),
            pid: proc.pid,
          });
        } else if (proc.kind === 'probe') {
          // Probe-class dispatch (validation canary / introduction / test
          // dispatch) — legitimately cookie-less and short-lived. The
          // reconciler was killing these mid-flight (orphan_no_cookie),
          // making wizard validation fail whenever the sweep landed during
          // a canary. Probe timeouts have their own cleanup (killByAgent).
          continue;
        } else {
          // Orphan process — no cookie, not planning
          log.warn('Reconcile: orphan process (no cookie, not planning), killing', {
            agentId, pid: proc.pid, runningMs: proc.runningMs,
          });
          if (sandbox) {
            try { sandbox.killProcess(proc.pid, 'orphan_no_cookie'); } catch { /* already dead */ }
          }
          stats.orphansKilled++;
        }
      }
    }

    // Log discrepancies between old cache and new state
    for (const [agentId] of cookies) {
      if (!fresh.has(agentId)) {
        log.warn('Reconcile: stale cache entry cleared', { agentId });
        stats.cleared++;
      }
    }

    // Replace cache atomically
    cookies.clear();
    for (const [k, v] of fresh) cookies.set(k, v);

    if (stats.cleared || stats.orphansKilled || stats.stuckKilled || stats.processDeadRequeued) {
      log.info('Reconcile complete', stats);
    }

    return stats;
  }

  // ─── Health/monitoring ───────────────────────────────────────

  /**
   * Snapshot for health endpoint / diagnostics.
   */
  function snapshot() {
    const result = {};
    for (const [agentId, cookie] of cookies) {
      result[agentId] = {
        type: cookie.type,
        taskId: cookie.taskId,
        subtaskId: cookie.subtaskId,
        since: cookie.since,
        holdingMs: Date.now() - cookie.since,
        pid: cookie.pid,
        phase: cookie.phase,
      };
    }
    return result;
  }

  return {
    // Inline operations (hot path)
    checkout,
    markDispatchStarted,
    touchPreparing,
    checkin,
    has,
    get,
    countByProvider,

    // Pickup slot operations
    tryAcquirePickupSlot,
    releasePickupSlot,
    hasPickupSlot,
    getPickupSlotStats,

    // Properties (compatible with old busyAgents interface)
    get size() { return getSize(); },

    // Reconciliation (heartbeat)
    reconcile,

    // Health/monitoring
    snapshot,

    // Direct Map access (for iteration patterns like [...agentCookies.keys()])
    keys: () => cookies.keys(),
    values: () => cookies.values(),
    entries: () => cookies.entries(),
    [Symbol.iterator]: () => cookies.keys(),
  };
}
