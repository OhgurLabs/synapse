/**
 * Health aggregator module
 * Provides centralized health data aggregation and WebSocket event emission
 */

import { broadcast, getWss, getConnectedUserCount } from './api.js';
import { STATES } from './circuit-breaker.js';

// Debounce timer for health updates
let healthDebounceTimer = null;
const HEALTH_DEBOUNCE_MS = 500;

/**
  * Aggregate health data from all sources into a single snapshot.
  *
  * @param {Object} deps
  * @param {Object} deps.agents - Agent registry
  * @param {Set} deps.thinkingAgents - Agents currently thinking
  * @param {Map} deps.fallbackStates - Fallback state per agent
  * @param {Function} deps.isAgentCoolingDown - Check if agent is on cooldown
  * @param {Map} deps.agentCooldowns - Agent cooldown map
  * @param {number} deps.SERVER_START_TIME - Server start timestamp
  * @param {Function} deps.getSessionMessageCount - Get session message count
  * @param {Function} deps.getCloudBudgetStatus - Get cloud budget status
  * @param {Function} deps.getVectorStore - Get vector store stats
  * @param {Object} deps.stateManager - State manager
  * @param {Object} deps.sandbox - Sandbox instance
  * @param {Object} deps.agentCookies - Agent cookies (pickup slots)
  * @param {Object} deps.rateLimiter - Rate limiter
  * @param {Map} deps.turnQueues - Turn queues
  * @param {Object} deps.circuitBreaker - Circuit breaker
  * @param {Object} deps.alertMonitor - Alert monitor instance
  * @returns {Object} Complete health status object
  */
 export function aggregateHealthData(deps) {
   const {
     agents,
     thinkingAgents,
     fallbackStates,
     isAgentCoolingDown,
     agentCooldowns,
     SERVER_START_TIME,
     getSessionMessageCount,
     getCloudBudgetStatus,
     getVectorStore,
     stateManager,
     sandbox,
     agentCookies,
     rateLimiter,
     turnQueues,
     circuitBreaker,
     alertMonitor,
   } = deps;

  const uptimeMs = Date.now() - (SERVER_START_TIME || Date.now());
  const secs = Math.floor(uptimeMs / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;

  const agentStatuses = {};
  for (const [name, agent] of Object.entries(agents)) {
    let status = 'idle';
    for (const key of thinkingAgents) {
      if (key.endsWith(`#${name}`)) {
        status = 'thinking';
        break;
      }
    }
    const fbState = fallbackStates?.get(name);
    if (isAgentCoolingDown && isAgentCoolingDown(name)) {
      const entry = agentCooldowns?.get(name);
      const remainMs = Math.max(0, (entry?.until ?? 0) - Date.now());
      const remainMins = Math.ceil(remainMs / 60000);
      const rlHours = Math.floor(remainMins / 60);
      const rlMins = remainMins % 60;
      const remainLabel = rlHours > 0
        ? (rlMins > 0 ? `${rlHours}h ${rlMins}m` : `${rlHours}h`)
        : `${remainMins}m`;
      status = fbState?.active
        ? `fallback (${fbState.currentProvider}/${fbState.currentModel}, ${remainLabel})`
        : `rate_limited (${remainLabel})`;
    }
    agentStatuses[name] = { status, model: agent.model };
  }

  const mem = process.memoryUsage();
  const cloudBudget = getCloudBudgetStatus ? getCloudBudgetStatus() : null;

  let ragStats = null;
  if (getVectorStore && stateManager?.listProjects) {
    ragStats = {};
    for (const p of stateManager.listProjects()) {
      const pid = p.id || p;
      const store = getVectorStore(pid);
      if (store) {
        const alignment = store.checkAlignment();
        ragStats[pid] = {
          indexed: store.count(),
          aligned: alignment.aligned,
          missingSnippets: store.countMissingSnippets(),
        };
      }
    }
  }

  const circuitBreakerStates = circuitBreaker ? circuitBreaker.getStatus() : {};
  const activeAlerts = alertMonitor ? alertMonitor.getActiveAlerts() : [];

  // Analyze circuit breaker states for degradation warnings
  const degradationWarnings = [];
  const openCircuits = [];

  // Flatten circuit breaker status for backward compatibility and analyze for degradation
  let flattenedCircuitBreakers = {};

  if (circuitBreaker && circuitBreakerStates) {
    // Handle both old flat structure and new nested structure
    if (circuitBreakerStates.providers || circuitBreakerStates.agents) {
      // New nested structure - flatten it for backward compatibility
      if (circuitBreakerStates.providers) {
        for (const [serviceName, status] of Object.entries(circuitBreakerStates.providers)) {
          flattenedCircuitBreakers[serviceName] = status;

          if (status.state === STATES.OPEN) {
            openCircuits.push({
              service: serviceName,
              type: 'provider',
              state: status.state,
              failures: status.failures,
              recoveryAt: status.recoveryAt,
              held: status.held || false,
            });
            degradationWarnings.push(
              `Service ${serviceName} is unavailable (circuit breaker open, recovers at ${status.recoveryAt || 'unknown'})`
            );
          } else if (status.state === STATES.HALF_OPEN) {
            degradationWarnings.push(
              `Service ${serviceName} is recovering (circuit breaker half-open, testing recovery)`
            );
          }
        }
      }

      if (circuitBreakerStates.agents) {
        for (const [agentId, status] of Object.entries(circuitBreakerStates.agents)) {
          flattenedCircuitBreakers[agentId] = status;

          if (status.state === STATES.OPEN) {
            openCircuits.push({
              service: agentId,
              type: 'agent',
              state: status.state,
              failures: status.failures,
              recoveryAt: status.recoveryAt,
              held: status.held || false,
            });
            degradationWarnings.push(
              `Agent ${agentId} is unavailable (circuit breaker open, recovers at ${status.recoveryAt || 'unknown'})`
            );
          } else if (status.state === STATES.HALF_OPEN) {
            degradationWarnings.push(
              `Agent ${agentId} is recovering (circuit breaker half-open, testing recovery)`
            );
          }
        }
      }
    } else {
      // Old flat structure - use as-is and analyze for degradation
      flattenedCircuitBreakers = circuitBreakerStates;

      for (const [serviceName, status] of Object.entries(circuitBreakerStates)) {
        if (status && status.state === STATES.OPEN) {
          openCircuits.push({
            service: serviceName,
            type: 'unknown',
            state: status.state,
            failures: status.failures,
            recoveryAt: status.recoveryAt,
            held: status.held || false,
          });
          degradationWarnings.push(
            `Service ${serviceName} is unavailable (circuit breaker open, recovers at ${status.recoveryAt || 'unknown'})`
          );
        } else if (status && status.state === STATES.HALF_OPEN) {
          degradationWarnings.push(
            `Service ${serviceName} is recovering (circuit breaker half-open, testing recovery)`
          );
        }
      }
    }
  }

  const queueDepth = turnQueues ? turnQueues.size : 0;
  const activeTasks = [...thinkingAgents].length;

  return {
    uptime: { ms: uptimeMs, human: `${h}h ${m}m ${s}s` },
    agentCount: Object.keys(agents).length,
    connectedUsers: getConnectedUserCount(),
    websocketConnections: wss ? [...wss.clients].filter(c => c.readyState === 1).length : 0,
    agents: agentStatuses,
    sessionMessages: getSessionMessageCount ? getSessionMessageCount() : 0,
    cloudBudget,
    rag: ragStats,
    memory: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    sandbox: sandbox ? {
      enabled: true,
      activeProcesses: sandbox.activeCount,
      maxConcurrent: sandbox.maxConcurrent,
      processes: sandbox.getActiveProcesses ? sandbox.getActiveProcesses() : [],
    } : { enabled: false },
    pickupSlots: agentCookies?.getPickupSlotStats ? agentCookies.getPickupSlotStats() : null,
    rateLimit: rateLimiter ? rateLimiter.getStats() : { enabled: false },
    circuitBreakers: flattenedCircuitBreakers,
    degradation: {
      active: degradationWarnings.length > 0,
      openCircuits: openCircuits.length,
      warnings: degradationWarnings,
      details: openCircuits,
    },
    alerts: activeAlerts,
    metrics: {
      queueDepth,
      activeTasks,
      uptimeMs,
      memoryMb: Math.round(mem.rss / 1048576),
    },
  };
}

// Reference to wss for health aggregation
let wss = null;

/**
 * Set the WebSocketServer instance for health aggregation
 * @param {WebSocketServer} server - The WebSocketServer instance
 */
export function setWss(server) {
  wss = server;
}

/**
 * Wrapper for thinkingAgents.add() that emits WebSocket health event
 * @param {Set} thinkingAgents - The thinkingAgents Set from api.js
 * @param {string} key - The thinking key in format "projectId#channelId#agentName"
 */
export function setAgentThinking(thinkingAgents, key) {
  thinkingAgents.add(key);
  emitAgentsUpdated();
}

/**
 * Wrapper for thinkingAgents.delete() that emits WebSocket health event
 * @param {Set} thinkingAgents - The thinkingAgents Set from api.js
 * @param {string} key - The thinking key in format "projectId#channelId#agentName"
 */
export function setAgentIdle(thinkingAgents, key) {
  thinkingAgents.delete(key);
  emitAgentsUpdated();
}

/**
 * Emit health:agents_updated WebSocket event with debouncing
 */
function emitAgentsUpdated() {
  if (healthDebounceTimer) {
    clearTimeout(healthDebounceTimer);
  }
  healthDebounceTimer = setTimeout(() => {
    broadcast({ type: 'health:agents_updated' });
    healthDebounceTimer = null;
  }, HEALTH_DEBOUNCE_MS);
}

/**
 * Cancel pending debounced health update
 * Useful for cleanup or forcing immediate update
 */
export function cancelDebouncedHealthUpdate() {
  if (healthDebounceTimer) {
    clearTimeout(healthDebounceTimer);
    healthDebounceTimer = null;
  }
}

/**
 * Force immediate health update (flush debounce)
 */
export function flushHealthUpdate() {
  if (healthDebounceTimer) {
    clearTimeout(healthDebounceTimer);
    healthDebounceTimer = null;
  }
  broadcast({ type: 'health:agents_updated' });
}

// Debounce timer for circuit breaker updates
let circuitBreakerDebounceTimer = null;

/**
 * Set up circuit breaker event listeners for health monitoring
 * @param {Object} events - EventBus instance
 */
export function setCircuitBreakerListeners(events) {
  if (!events) return;

  const emitCircuitBreakerUpdated = () => {
    if (circuitBreakerDebounceTimer) {
      clearTimeout(circuitBreakerDebounceTimer);
    }
    circuitBreakerDebounceTimer = setTimeout(() => {
      broadcast({ type: 'health:circuit_breaker_updated' });
      circuitBreakerDebounceTimer = null;
    }, HEALTH_DEBOUNCE_MS);
  };

  events.on('circuit_breaker:open', emitCircuitBreakerUpdated);
  events.on('circuit_breaker:half_open', emitCircuitBreakerUpdated);
  events.on('circuit_breaker:closed', emitCircuitBreakerUpdated);
}

/**
 * Cancel pending debounced circuit breaker health update
 */
export function cancelDebouncedCircuitBreakerUpdate() {
  if (circuitBreakerDebounceTimer) {
    clearTimeout(circuitBreakerDebounceTimer);
    circuitBreakerDebounceTimer = null;
  }
}

// Debounce timer for alert updates
let alertDebounceTimer = null;

/**
 * Set up alert event listeners for health monitoring
 * @param {Object} events - EventBus instance
 */
export function setAlertListeners(events) {
  if (!events) return;

  const emitAlertsUpdated = () => {
    if (alertDebounceTimer) {
      clearTimeout(alertDebounceTimer);
    }
    alertDebounceTimer = setTimeout(() => {
      broadcast({ type: 'health:alerts_updated' });
      alertDebounceTimer = null;
    }, HEALTH_DEBOUNCE_MS);
  };

  events.on('alert:firing', emitAlertsUpdated);
  events.on('alert:resolved', emitAlertsUpdated);
}

/**
 * Cancel pending debounced alert health update
 */
export function cancelDebouncedAlertUpdate() {
  if (alertDebounceTimer) {
    clearTimeout(alertDebounceTimer);
    alertDebounceTimer = null;
  }
}

// Debounce timer for routing weights updates
let routingWeightsDebounceTimer = null;

/**
 * Emit health:routing_weights_updated WebSocket event with debouncing
 */
export function emitRoutingWeightsUpdated() {
  if (routingWeightsDebounceTimer) {
    clearTimeout(routingWeightsDebounceTimer);
  }
  routingWeightsDebounceTimer = setTimeout(() => {
    broadcast({ type: 'health:routing_weights_updated' });
    routingWeightsDebounceTimer = null;
  }, HEALTH_DEBOUNCE_MS);
}

/**
 * Cancel pending debounced routing weights health update
 */
export function cancelDebouncedRoutingWeightsUpdate() {
  if (routingWeightsDebounceTimer) {
    clearTimeout(routingWeightsDebounceTimer);
    routingWeightsDebounceTimer = null;
  }
}

// Debounce timer for rate limit updates
let rateLimitDebounceTimer = null;

/**
 * Emit rate_limited event for SSE streaming
 * @param {Object} data - Rate limit data including agentId, provider, until, reason
 */
export function emitRateLimited(data) {
  if (rateLimitDebounceTimer) {
    clearTimeout(rateLimitDebounceTimer);
  }
  rateLimitDebounceTimer = setTimeout(() => {
    broadcast({ type: 'rate_limited', ...data });
    rateLimitDebounceTimer = null;
  }, HEALTH_DEBOUNCE_MS);
}

/**
 * Cancel pending debounced rate limit update
 */
export function cancelDebouncedRateLimitUpdate() {
  if (rateLimitDebounceTimer) {
    clearTimeout(rateLimitDebounceTimer);
    rateLimitDebounceTimer = null;
  }
}

/**
 * Set up rate limit event listeners for health monitoring
 * @param {Object} events - EventBus instance
 */
export function setRateLimitListeners(events) {
  if (!events) return;

  const emitRateLimitedHandler = (data) => {
    emitRateLimited(data);
  };

  events.on('rate_limited', emitRateLimitedHandler);
}