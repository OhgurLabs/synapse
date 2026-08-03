/**
 * Shared agent eligibility checks used across planner/router/strategist paths.
 * The goal is to keep "available" semantics consistent everywhere.
 */

import { isAgentPaused } from './agents.js';

export function isAgentEligibleNow(agents, agentId, {
  isAgentCoolingDown,
  circuitBreaker,
  busyAgents = null,
} = {}) {
  const agent = agents?.[agentId];
  if (!agent) return false;

  // Missing status is treated as active for backward compatibility.
  if (agent._status && agent._status !== 'active') return false;
  if (isAgentPaused(agentId)) return false;
  if (typeof isAgentCoolingDown === 'function' && isAgentCoolingDown(agentId)) return false;
  if (busyAgents && busyAgents.has(agentId)) return false;
  if (circuitBreaker && !circuitBreaker.canRequest(agentId)) return false;
  return true;
}

export function filterEligibleAgentEntries(agents, options = {}) {
  return Object.entries(agents || {}).filter(([id]) => isAgentEligibleNow(agents, id, options));
}

