/**
 * Dashboard State Aggregator
 *
 * Aggregates state from WorkQueue, HandoffStore, CircuitBreaker, and AlertStore
 * into a unified dashboard snapshot. Supports delta computation for efficient
 * real-time updates.
 */

import { aggregateHealthData } from './health-aggregator.js';

const BACKPRESSURE_THRESHOLD = 0.8;

/**
 * Compute agent health score and status using circuit breaker, queue, and degradation data.
 *
 * @param {Object} agent - Agent config/state
 * @param {string} cbState - Circuit breaker state for the agent
 * @param {Object} queueMetrics - Queue metrics ({ depth, limit })
 * @param {Object} degradation - Degradation info from health aggregator
 * @returns {{ score: number, status: string }} Numeric score (0-100) and status
 */
function computeAgentHealthScore(agent, cbState, queueMetrics = {}, degradation = {}) {
  let score = 100;

  // Circuit breaker impact (0-60 point penalty)
  if (cbState === 'open') {
    score -= 60;
  } else if (cbState === 'half_open') {
    score -= 30;
  }

  // Queue depth / backpressure impact (0-30 point penalty)
  const depth = typeof queueMetrics.depth === 'number' ? queueMetrics.depth : 0;
  const limit = typeof queueMetrics.limit === 'number' ? queueMetrics.limit : 0;
  if (limit > 0) {
    const utilizationRatio = depth / limit;
    if (utilizationRatio > 0.8) {
      score -= 30;
    } else if (utilizationRatio > 0.5) {
      score -= 15;
    } else if (utilizationRatio > 0.3) {
      score -= 5;
    }
  }

  // Degradation warnings impact (0-20 point penalty)
  if (degradation && degradation.active) {
    const identifiers = [agent?.id, agent?.name, agent?.provider].filter(Boolean);
    let matches = 0;

    if (Array.isArray(degradation.details)) {
      matches = degradation.details.filter(detail => (
        typeof detail.service === 'string' &&
        identifiers.some(id => detail.service.includes(id))
      )).length;
    } else if (Array.isArray(degradation.warnings)) {
      matches = degradation.warnings.filter(warning => (
        typeof warning === 'string' &&
        identifiers.some(id => warning.includes(id))
      )).length;
    }

    if (matches > 0) {
      score -= Math.min(20, matches * 10);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let status = 'healthy';
  if (cbState === 'open') {
    status = 'critical';
  } else if (score >= 80) {
    status = 'healthy';
  } else if (score >= 50) {
    status = 'degraded';
  } else {
    status = 'critical';
  }

  return { score, status };
}

/**
 * Aggregate agent state from agents registry, circuit breaker, and work queue
 *
 * @param {Object} agents - Agent registry object (agentId -> agent config)
 * @param {CircuitBreaker} circuitBreaker - Circuit breaker instance
 * @param {WorkQueue} workQueue - Work queue instance
 * @param {Object} degradation - Degradation info from health aggregator
 * @returns {Array} Array of agent state objects
 */
function aggregateAgentState(agents, circuitBreaker, workQueue, degradation = {}) {
   if (!agents) {
     return [];
   }

   const agentList = Object.keys(agents).map(agentId => {
     const agent = agents[agentId];
     const cbState = circuitBreaker ? circuitBreaker.getStateProvider(agentId) : 'closed';
     // workQueue is a Map where keys are agentIds and values are Promise chains
     const queueDepth = workQueue && typeof workQueue.get === 'function' ? (workQueue.get(agentId) !== undefined ? 1 : 0) : 0;
     const perAgentLimit = 100; // Default limit
     const queueMetrics = { depth: queueDepth, limit: perAgentLimit };
    const healthScoreResult = computeAgentHealthScore(agent, cbState, queueMetrics, degradation);

    // Determine status based on queue depth and circuit breaker state
    let status = 'idle';
    if (cbState === 'open') {
      status = 'unavailable';
    } else if (queueDepth > 0) {
      status = 'processing';
    }

    // Map computed health score to categorical health status
    const health = healthScoreResult.status;

    return {
      id: agent.id || agentId,
      name: agent.name || agentId,
      provider: agent.provider || null,
      status,
      circuit_breaker_state: cbState,
      queue_depth: queueDepth,
      health,
      healthScore: healthScoreResult.score,
      last_heartbeat: Date.now(),
    };
  });

  return agentList;
}

/**
 * Aggregate queue state from work queue
 *
 * @param {Object} agents - Agent registry object (agentId -> agent config)
 * @param {WorkQueue} workQueue - Work queue instance
 * @returns {Array} Array of queue state objects
 */
function aggregateQueueState(agents, workQueue) {
  if (!workQueue) {
    return [];
  }

  const perAgentLimit = 100; // Default limit
  const agentIds = agents ? Object.keys(agents) : [];

  const queues = agentIds.map(agentId => {
    // workQueue is a Map where keys are agentIds and values are Promise chains
    const depth = workQueue && typeof workQueue.get === 'function' ? (workQueue.get(agentId) !== undefined ? 1 : 0) : 0;
    const backpressure = depth / perAgentLimit > BACKPRESSURE_THRESHOLD;

    return {
      agent_id: agentId,
      depth,
      limit: perAgentLimit,
      backpressure,
    };
  });

  return queues;
}

/**
 * Aggregate handoff state from handoff store
 *
 * @param {HandoffStore} handoffStore - Handoff store instance
 * @returns {Array} Array of handoff state objects
 */
function aggregateHandoffState(handoffStore) {
  if (!handoffStore) {
    return [];
  }

  // Query all possible handoff statuses
  const statuses = [
    'pending',
    'offered',
    'accepted',
    'transferring',
    'completed',
    'rejected',
    'rolled_back',
  ];

  const allHandoffs = [];

  for (const status of statuses) {
    try {
      const handoffs = handoffStore.listByStatus(status);
      if (handoffs) {
        allHandoffs.push(...handoffs);
      }
    } catch (error) {
      // Continue if a specific status query fails
      console.warn(`Failed to query handoffs with status ${status}:`, error.message);
    }
  }

  // Map to dashboard format with required fields
  // Note: handoff-store uses snake_case for database fields
  const handoffsData = allHandoffs.map(handoff => ({
    handoffId: handoff.handoff_id || handoff.handoffId,
    senderAgentId: handoff.sender_agent_id || handoff.senderAgentId,
    recipientAgentId: handoff.recipient_agent_id || handoff.recipientAgentId,
    taskId: handoff.task_id || handoff.taskId,
    traceId: handoff.trace_id || handoff.traceId,
    spanId: handoff.span_id || handoff.spanId,
    status: handoff.status,
    createdAt: handoff.created_at || handoff.createdAt,
    updatedAt: handoff.updated_at || handoff.updatedAt,
  }));

  return handoffsData;
}

/**
 * Aggregate alert state from alert store
 *
 * @param {AlertStore} alertStore - Alert store instance
 * @param {Object} options - Filter options for alerts
 * @returns {Array} Array of alert state objects
 */
function aggregateAlertState(alertStore, options = {}) {
  if (!alertStore) {
    return [];
  }

  try {
    // Use getAlerts method (primary) or getAll as fallback
    const alerts = alertStore.getAlerts ? alertStore.getAlerts(options) : [];

    // Map to dashboard format with required fields
    // Support both snake_case and camelCase field names
    const alertsData = alerts.map(alert => ({
      id: alert.id,
      ruleId: alert.rule_id || alert.ruleId,
      severity: alert.severity,
      message: alert.message,
      timestamp: alert.timestamp,
      state: alert.state,
      source: alert.source,
    }));

    return alertsData;
  } catch (error) {
    console.warn('Failed to aggregate alert state:', error.message);
    return [];
  }
}

/**
 * Aggregate trace state from trace store
 *
 * @param {TraceStore} traceStore - Trace store instance
 * @param {Object} options - Aggregation options
 * @param {number} options.limit - Maximum number of recent spans to include (default: 50)
 * @param {string} options.sinceISO - Only include spans started after this ISO timestamp
 * @returns {Array} Array of summarized trace objects
 */
function aggregateTraceState(traceStore, options = {}) {
  if (!traceStore) {
    return [];
  }

  try {
    const limit = options.limit || 50;
    const sinceISO = options.sinceISO || null;

    const spans = traceStore.getRecentSpans(limit, sinceISO);

    // Map to dashboard format with only essential fields
    // Omit result and metadata to avoid overwhelming the network
    const tracesData = spans.map(span => ({
      traceId: span.traceId,
      spanId: span.spanId,
      agentId: span.agentId,
      operation: span.operation,
      status: span.status,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
    }));

    return tracesData;
  } catch (error) {
    console.warn('Failed to aggregate trace state:', error.message);
    return [];
  }
}

/**
 * Aggregate channel state from PubSubChannelService
 *
 * @param {PubSubChannelService} pubSubChannelService - PubSub channel service instance
 * @returns {Array} Array of channel objects with normalized fields
 */
function aggregateChannelState(pubSubChannelService) {
  try {
    if (!pubSubChannelService || typeof pubSubChannelService.listChannels !== 'function') {
      return [];
    }

    const channels = pubSubChannelService.listChannels();

    // Transform to dashboard schema format
    return channels.map(channel => ({
      channelName: channel.channelName,
      subscriberCount: Array.isArray(channel.subscribers) ? channel.subscribers.length : 0,
      messageCount: channel.messageCount || 0,
      lastPublishedAt: channel.lastPublishedAt || null,
      messageFlowRate: channel.messageFlowRate || 0,
    }));
  } catch (error) {
    console.warn('Failed to aggregate channel state:', error.message);
    return [];
  }
}

/**
 * Aggregate complete dashboard state from all sources
 *
 * @param {Object} deps - Dependencies object
 * @param {Object} deps.agents - Agent registry
 * @param {WorkQueue} deps.workQueue - Work queue instance
 * @param {HandoffStore} deps.handoffStore - Handoff store instance
 * @param {AlertStore} deps.alertStore - Alert store instance
 * @param {CircuitBreaker} deps.circuitBreaker - Circuit breaker instance
  * @param {TraceStore} deps.traceStore - Trace store instance (optional)
  * @param {PubSubChannelService} deps.pubSubChannelService - PubSub channel service instance (optional)
  * @param {Set} deps.thinkingAgents - Agents currently thinking (optional)
  * @param {Object} options - Aggregation options
  * @param {Object} options.alertFilter - Filter options for alerts
  * @param {Object} options.traceOptions - Options for trace aggregation (limit, sinceISO)
  * @returns {Object} Complete dashboard state snapshot
  */
 export function aggregateDashboardState(deps, options = {}) {
   const {
     agents,
     workQueue,
     handoffStore,
     alertStore,
     circuitBreaker,
     traceStore,
     pubSubChannelService,
     thinkingAgents = new Set(),
   } = deps;

   const alertFilter = options.alertFilter || {};
   const traceOptions = options.traceOptions || {};

   // Aggregate health data from circuit breaker
   const health = aggregateHealthData({ agents, circuitBreaker, thinkingAgents });

  const snapshot = {
    timestamp: new Date().toISOString(),
    agents: aggregateAgentState(agents, circuitBreaker, workQueue, health.degradation),
    queues: aggregateQueueState(agents, workQueue),
    handoffs: aggregateHandoffState(handoffStore),
    channels: aggregateChannelState(pubSubChannelService),
    alerts: aggregateAlertState(alertStore, alertFilter),
    traces: aggregateTraceState(traceStore, traceOptions),
    health,
    degradation: health.degradation,
  };

  return snapshot;
}

/**
 * Compute delta between two snapshots
 * Returns only changed fields organized by entity type
 *
 * @param {Object} previousSnapshot - Previous state snapshot
 * @param {Object} currentSnapshot - Current state snapshot
 * @returns {Object} Delta object with changed fields only
 */
export function computeStateDelta(previousSnapshot, currentSnapshot) {
  if (!previousSnapshot || !currentSnapshot) {
    return currentSnapshot || {};
  }

  const delta = {
    timestamp: currentSnapshot.timestamp,
    agents: {
      updated: [],
      added: [],
      removed: [],
    },
    queues: {
      updated: [],
      added: [],
      removed: [],
    },
    handoffs: {
      updated: [],
      added: [],
      removed: [],
    },
    channels: {
      updated: [],
      added: [],
      removed: [],
    },
    alerts: {
      added: [],
    },
    traces: {
      added: [],
    },
    health: {
      degradation: null,
      active: null,
      openCircuits: null,
      transitions: [],
    },
  };

  // Compare agents
  const prevAgentsMap = new Map(
    (previousSnapshot.agents || []).map(a => [a.id, a])
  );
  const prevAgentsCopy = new Map(prevAgentsMap); // Copy for health transition detection

  for (const agent of currentSnapshot.agents || []) {
    const prevAgent = prevAgentsMap.get(agent.id);

    if (!prevAgent) {
      // New agent - include full object
      delta.agents.added.push(agent);
    } else {
      // Check for changes and include only changed fields
      const changes = compareAgentFields(prevAgent, agent);
      if (Object.keys(changes).length > 0) {
        delta.agents.updated.push({
          id: agent.id,
          ...changes,
        });
      }
    }

    prevAgentsMap.delete(agent.id);
  }

  // Removed agents - only include id
  for (const [agentId] of prevAgentsMap) {
    delta.agents.removed.push({ id: agentId });
  }

  // Detect health state transitions (healthy→degraded→critical)
  for (const agent of currentSnapshot.agents || []) {
    const prevAgent = prevAgentsCopy.get(agent.id);
    // Track transitions when health status changes for existing agents (not new/removed)
    // Include transitions from undefined/null health values
    if (prevAgent !== undefined && 'health' in agent && prevAgent.health !== agent.health) {
      delta.health.transitions.push({
        agentId: agent.id,
        from: prevAgent.health,
        to: agent.health,
        previousScore: prevAgent.healthScore,
        currentScore: agent.healthScore,
        timestamp: currentSnapshot.timestamp,
      });
    }
  }

  // Compare queues
  const prevQueuesMap = new Map(
    (previousSnapshot.queues || []).map(q => [q.agent_id, q])
  );

  for (const queue of currentSnapshot.queues || []) {
    const prevQueue = prevQueuesMap.get(queue.agent_id);

    if (!prevQueue) {
      // New queue - include full object
      delta.queues.added.push(queue);
    } else {
      // Check for changes and include only changed fields
      const changes = compareQueueFields(prevQueue, queue);
      if (Object.keys(changes).length > 0) {
        delta.queues.updated.push({
          agent_id: queue.agent_id,
          ...changes,
        });
      }
    }

    prevQueuesMap.delete(queue.agent_id);
  }

  // Removed queues - only include agent_id
  for (const [agentId] of prevQueuesMap) {
    delta.queues.removed.push({ agent_id: agentId });
  }

  // Compare handoffs
  const prevHandoffsMap = new Map(
    (previousSnapshot.handoffs || []).map(h => [h.handoffId, h])
  );

  for (const handoff of currentSnapshot.handoffs || []) {
    const prevHandoff = prevHandoffsMap.get(handoff.handoffId);

    if (!prevHandoff) {
      // New handoff - include full object
      delta.handoffs.added.push(handoff);
    } else {
      // Check for changes and include only changed fields
      const changes = compareHandoffFields(prevHandoff, handoff);
      if (Object.keys(changes).length > 0) {
        delta.handoffs.updated.push({
          handoffId: handoff.handoffId,
          ...changes,
        });
      }
    }

    prevHandoffsMap.delete(handoff.handoffId);
  }

  // Removed handoffs - only include handoffId
  for (const [handoffId] of prevHandoffsMap) {
    delta.handoffs.removed.push({ handoffId });
  }

  // Compare channels
  const prevChannelsMap = new Map(
    (previousSnapshot.channels || []).map(c => [c.channelName, c])
  );

  for (const channel of currentSnapshot.channels || []) {
    const prevChannel = prevChannelsMap.get(channel.channelName);

    if (!prevChannel) {
      // New channel - include full object
      delta.channels.added.push(channel);
    } else {
      // Check for changes and include only changed fields
      const changes = compareChannelFields(prevChannel, channel);
      if (Object.keys(changes).length > 0) {
        delta.channels.updated.push({
          channelName: channel.channelName,
          ...changes,
        });
      }
    }

    prevChannelsMap.delete(channel.channelName);
  }

  // Removed channels - only include channelName
  for (const [channelName] of prevChannelsMap) {
    delta.channels.removed.push({ channelName });
  }

  // Compare alerts (only include new alerts)
  const prevAlertsSet = new Set(
    (previousSnapshot.alerts || []).map(a => a.id)
  );

  for (const alert of currentSnapshot.alerts || []) {
    if (!prevAlertsSet.has(alert.id)) {
      // New alert - include full object
      delta.alerts.added.push(alert);
    }
  }

  // Compare traces (only include new spans)
  const prevTracesSet = new Set(
    (previousSnapshot.traces || []).map(t => t.spanId)
  );

  for (const trace of currentSnapshot.traces || []) {
    if (!prevTracesSet.has(trace.spanId)) {
      // New span - include full object
      delta.traces.added.push(trace);
    }
  }

  // Compare top-level health/degradation changes
  const prevDegradation = previousSnapshot.degradation || {};
  const currDegradation = currentSnapshot.degradation || {};

  if (prevDegradation.openCircuits !== currDegradation.openCircuits) {
    delta.health.openCircuits = currDegradation.openCircuits;
  }

  if (prevDegradation.active !== currDegradation.active) {
    delta.health.active = currDegradation.active;
  }

  const prevHealthStatus = prevDegradation.status || previousSnapshot.health?.status;
  const currHealthStatus = currDegradation.status || currentSnapshot.health?.status;

  if (prevHealthStatus !== currHealthStatus) {
    delta.health.degradation = currHealthStatus;
  }

  return delta;
}

/**
 * Compare agent fields and return only changed ones
 * @param {Object} prev - Previous agent state
 * @param {Object} curr - Current agent state
 * @returns {Object} Object with only changed fields
 */
function compareAgentFields(prev, curr) {
  const changes = {};

  if (prev.status !== curr.status) {
    changes.status = curr.status;
  }

  if (prev.circuit_breaker_state !== curr.circuit_breaker_state) {
    changes.circuit_breaker_state = curr.circuit_breaker_state;
  }

  if (prev.queue_depth !== curr.queue_depth) {
    changes.queue_depth = curr.queue_depth;
  }


  if (prev.name !== curr.name) {
    changes.name = curr.name;
  }

  if (prev.provider !== curr.provider) {
    changes.provider = curr.provider;
  }

  if (prev.health !== curr.health) {
    changes.health = curr.health;
  }

  if (prev.healthScore !== curr.healthScore) {
    changes.healthScore = curr.healthScore;
  }

  return changes;
}

/**
 * Compare queue fields and return only changed ones
 * @param {Object} prev - Previous queue state
 * @param {Object} curr - Current queue state
 * @returns {Object} Object with only changed fields
 */
function compareQueueFields(prev, curr) {
  const changes = {};

  if (prev.depth !== curr.depth) {
    changes.depth = curr.depth;
  }

  if (prev.backpressure !== curr.backpressure) {
    changes.backpressure = curr.backpressure;
  }

  if (prev.limit !== curr.limit) {
    changes.limit = curr.limit;
  }

  return changes;
}

/**
 * Compare handoff fields and return only changed ones
 * @param {Object} prev - Previous handoff state
 * @param {Object} curr - Current handoff state
 * @returns {Object} Object with only changed fields
 */
function compareHandoffFields(prev, curr) {
  const changes = {};

  if (prev.status !== curr.status) {
    changes.status = curr.status;
  }

  if (prev.updatedAt !== curr.updatedAt) {
    changes.updatedAt = curr.updatedAt;
  }

  if (prev.senderAgentId !== curr.senderAgentId) {
    changes.senderAgentId = curr.senderAgentId;
  }

  if (prev.recipientAgentId !== curr.recipientAgentId) {
    changes.recipientAgentId = curr.recipientAgentId;
  }

  if (prev.taskId !== curr.taskId) {
    changes.taskId = curr.taskId;
  }

  return changes;
}

/**
 * Compare channel fields and return only changed ones
 * @param {Object} prev - Previous channel state
 * @param {Object} curr - Current channel state
 * @returns {Object} Object with only changed fields
 */
function compareChannelFields(prev, curr) {
  const changes = {};

  if (prev.subscriberCount !== curr.subscriberCount) {
    changes.subscriberCount = curr.subscriberCount;
  }

  if (prev.messageCount !== curr.messageCount) {
    changes.messageCount = curr.messageCount;
  }

  if (prev.lastPublishedAt !== curr.lastPublishedAt) {
    changes.lastPublishedAt = curr.lastPublishedAt;
  }

  if (prev.messageFlowRate !== curr.messageFlowRate) {
    changes.messageFlowRate = curr.messageFlowRate;
  }

  return changes;
}

/**
 * Check if a delta has any changes
 *
 * @param {Object} delta - Delta object from computeStateDelta
 * @returns {boolean} True if delta contains changes
 */
export function hasChanges(delta) {
  if (!delta) {
    return false;
  }

  return Boolean(
    (delta.agents && (
      (delta.agents.updated && delta.agents.updated.length > 0) ||
      (delta.agents.added && delta.agents.added.length > 0) ||
      (delta.agents.removed && delta.agents.removed.length > 0)
    )) ||
    (delta.queues && (
      (delta.queues.updated && delta.queues.updated.length > 0) ||
      (delta.queues.added && delta.queues.added.length > 0) ||
      (delta.queues.removed && delta.queues.removed.length > 0)
    )) ||
    (delta.handoffs && (
      (delta.handoffs.updated && delta.handoffs.updated.length > 0) ||
      (delta.handoffs.added && delta.handoffs.added.length > 0) ||
      (delta.handoffs.removed && delta.handoffs.removed.length > 0)
    )) ||
    (delta.channels && (
      (delta.channels.updated && delta.channels.updated.length > 0) ||
      (delta.channels.added && delta.channels.added.length > 0) ||
      (delta.channels.removed && delta.channels.removed.length > 0)
    )) ||
    (delta.alerts && delta.alerts.added && delta.alerts.added.length > 0) ||
    (delta.traces && delta.traces.added && delta.traces.added.length > 0)
  );
}
