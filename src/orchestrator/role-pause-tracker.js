// Role-pause tracker — detects when all agents for a role are unavailable
// (cooling down, circuit-broken, or busy) and tracks paused/resumed state.
import { createLogger } from '../logger.js';

const log = createLogger('role-pause-tracker');

/**
 * Create role-pause tracking functions.
 * @param {Object} opts
 * @param {Object} opts.agents - agent map (id → agent with .role)
 * @param {Function} opts.isAgentCoolingDown - (agentId) → boolean
 * @param {import('./circuit-breaker.js').CircuitBreaker} [opts.circuitBreaker] - optional circuit breaker
 * @returns {{ isRolePaused, getPausedRoles, markRolePaused, markRoleResumed }}
 */
export function createRolePauseTracker({ agents, isAgentCoolingDown, circuitBreaker = null }) {
  const pausedRoles = new Set();

  /**
   * Check if a role is effectively paused — all agents for that role are unavailable.
   * An agent is unavailable if it's cooling down, circuit-broken, or busy.
   * @param {string} role
   * @param {Set<string>} [busyAgents] - Set of agent IDs currently executing
   * @returns {boolean}
   */
  function isRolePaused(role, busyAgents = new Set()) {
    const roleAgents = Object.entries(agents)
      .filter(([, a]) => a.role === role)
      .map(([id]) => id);

    if (roleAgents.length === 0) return false; // no agents for this role — not "paused"

    return roleAgents.every(id => {
      if (isAgentCoolingDown(id)) return true;
      if (circuitBreaker && !circuitBreaker.canRequest(id)) return true;
      if (busyAgents.has(id)) return true;
      return false;
    });
  }

  /**
   * Get the set of currently-tracked paused roles.
   * @returns {Set<string>}
   */
  function getPausedRoles() {
    return pausedRoles;
  }

  /**
   * Mark a role as paused (adds to tracking set).
   * @param {string} role
   */
  function markRolePaused(role) {
    if (!pausedRoles.has(role)) {
      pausedRoles.add(role);
      log.info('Role paused', { event: 'role_paused', role });
    }
  }

  /**
   * Mark a role as resumed (removes from tracking set).
   * @param {string} role
   */
  function markRoleResumed(role) {
    pausedRoles.delete(role);
  }

  return { isRolePaused, getPausedRoles, markRolePaused, markRoleResumed };
}
