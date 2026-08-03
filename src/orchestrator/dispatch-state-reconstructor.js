/**
 * dispatch-state-reconstructor.js
 *
 * Reconstructs the full state of a dispatch from historical records
 * in dispatch-log and timeline-store.
 */

import { createLogger } from '../logger.js';

const log = createLogger('dispatch-state-reconstructor');

/**
 * Reconstruct dispatch state from stored records.
 *
 * @param {string} dispatchId - Original dispatch decision ID
 * @param {Object} deps
 * @param {Object} deps.dispatchLog - DispatchLog instance
 * @param {Object} deps.timelineStore - TimelineStore instance
 * @returns {Object|null} Reconstructed state or null if dispatch not found
 */
export function reconstructDispatchState(dispatchId, { dispatchLog, timelineStore }) {
  if (!dispatchId) return null;

  // 1. Try to get the primary record from dispatch-log
  const record = dispatchLog ? dispatchLog.getById(dispatchId) : null;

  // 2. Query all timeline events correlated to this dispatch
  let timelineEvents = [];
  if (timelineStore) {
    try {
      const result = timelineStore.query({
        dispatchId,
        limit: 100,
      });
      timelineEvents = result.events || [];
    } catch (err) {
      log.warn('Failed to query timeline events for dispatch reconstruction', {
        dispatchId,
        error: err.message,
      });
    }
  }

  if (!record && timelineEvents.length === 0) {
    return null;
  }

  // 3. Extract original message (inputs)
  let message = record?.inputs || null;
  if (!message) {
    const routingEvent = timelineEvents.find(e => e.type === 'dispatch');
    if (routingEvent) {
      message = routingEvent.data?.inputs || routingEvent.data?.message || null;
    }
  }

  // 4. Reconstruct routing plan and metadata
  // If we have a record, it's the authoritative source for the decision
  let routingPlan = record ? {
    mode: record.secondary_selection ? 'pair' : 'solo',
    type: record.taskCategory,
    primary: record.selectedAgent,
    secondary: record.secondary_selection?.candidates?.[0]?.agentId || null,
    participants: [record.selectedAgent],
    budget: { maxRounds: 2, maxResponses: 2 },
    confidence: 1.0,
    autoClassified: record.selectionReason !== 'explicit_mention',
    routing_metadata: {
      primary_selection: {
        category: record.taskCategory,
        weights: record.weights || [],
        reason: record.selectionReason,
        roll: record.roll,
      },
      secondary_selection: record.secondary_selection || null,
      constraint_applied: (record.constraintsApplied || []).map(c =>
        c.value ? `${c.type}:${c.value}` : c.type
      ),
    },
  } : null;

  // Fallback routingPlan reconstruction from timeline if record is missing
  if (!routingPlan && timelineEvents.length > 0) {
    const routingEvent = timelineEvents.find(e => e.type === 'dispatch');
    if (routingEvent) {
      const d = routingEvent.data || {};
      routingPlan = {
        mode: d.secondary_selection ? 'pair' : 'solo',
        type: d.taskCategory || 'unknown',
        primary: d.selectedAgent || d.agentId,
        secondary: d.secondary_selection?.candidates?.[0]?.agentId || null,
        participants: [d.selectedAgent || d.agentId].filter(Boolean),
        budget: { maxRounds: 2, maxResponses: 2 },
        confidence: d.confidence || 1.0,
        autoClassified: d.selectionReason !== 'explicit_mention',
        routing_metadata: {
          primary_selection: {
            category: d.taskCategory,
            weights: d.weights || [],
            reason: d.selectionReason,
            roll: d.roll,
          },
          secondary_selection: d.secondary_selection || null,
          constraint_applied: (d.constraintsApplied || []).map(c =>
            c.value ? `${c.type}:${c.value}` : c.type
          ),
        },
      };
      if (routingPlan.secondary) routingPlan.participants.push(routingPlan.secondary);
    }
  }

  if (routingPlan && routingPlan.secondary && !routingPlan.participants.includes(routingPlan.secondary)) {
    routingPlan.participants.push(routingPlan.secondary);
  }

  // 5. Build agent context (guardrails, circuit breakers, anomalies)
  const agentContext = {
    guardrails: timelineEvents.filter(e => e.type === 'guardrail_outcome').map(e => ({
      ruleId: e.data?.ruleId,
      ruleName: e.data?.ruleName,
      outcome: e.data?.outcome,
      score: e.data?.score,
      timestamp: e.event_ts
    })),
    circuitBreakers: timelineEvents.filter(e => e.type === 'circuit_breaker').map(e => ({
      provider: e.provider,
      prevState: e.data?.previousState,
      newState: e.data?.newState,
      timestamp: e.event_ts
    })),
    anomalies: timelineEvents.filter(e => e.type === 'anomaly_alert').map(e => ({
      type: e.data?.anomalyType,
      severity: e.data?.severity,
      message: e.data?.message || e.data?.detail,
      timestamp: e.event_ts
    }))
  };

  return {
    dispatchId: record?.id || dispatchId,
    timestamp: record?.timestamp || (timelineEvents.length > 0 ? timelineEvents[timelineEvents.length - 1].event_ts : null),
    message,
    campaignId: record?.campaignId || timelineEvents.find(e => e.campaign_id)?.campaign_id || null,
    traceId: record?.traceId || timelineEvents.find(e => e.trace_id)?.trace_id || null,
    outcome: record?.outcome || null,
    selectedAgent: record?.selectedAgent || routingPlan?.primary || null,
    selectionReason: record?.selectionReason || routingPlan?.routing_metadata?.primary_selection?.reason || null,
    candidates: record?.candidates || [],
    constraintsApplied: record?.constraintsApplied || [],
    weights: record?.weights || [],
    roll: record?.roll || null,
    routingPlan,
    timelineEvents,
    agentContext,
  };
}

export default {
  reconstructDispatchState
};
