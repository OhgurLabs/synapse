// timeline-event-mappers.js — source-specific readers/mappers for timeline events
// Transforms dispatch_decisions, cb_transitions, anomaly alerts, and guardrail outcomes
// into normalized envelopes conforming to the unified Operational Timeline schema.

import { loadAlertHistory } from './alert-history-store.js';

function toIso(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return value;
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return (typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function summarizeContent(value, maxLength = 240) {
  if (value === null || value === undefined) return '';

  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    text = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return item.issue || item.summary || item.message || JSON.stringify(item);
        }
        return String(item);
      })
      .filter(Boolean)
      .join('; ');
  } else if (typeof value === 'object') {
    text = value.summary || value.message || value.content || JSON.stringify(value);
  } else {
    text = String(value);
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function inferFeedbackPhase(payload, status) {
  if (typeof payload?.phase === 'string' && payload.phase.trim()) {
    return payload.phase;
  }
  switch (status) {
    case 'approved':
    case 'commented':
    case 'max_iterations_reached':
    case 'revision_accepted':
      return 'review';
    default:
      return 'challenge';
  }
}

/**
 * Map a dispatch_decisions row into a normalized timeline event.
 * @param {Object} row - Raw dispatch record from SQLite
 * @returns {{ id: string, type: 'dispatch', timestamp: string, summary: string, data: Object }}
 */
export function mapDispatchEvent(row) {
  // Parse data blob — stored as JSON string in the column; may be pre-parsed in tests
  let blob = {};
  if (row.data) {
    if (typeof row.data === 'string') {
      try {
        blob = JSON.parse(row.data);
      } catch {
        blob = {};
      }
    } else if (typeof row.data === 'object') {
      blob = row.data;
    }
  }

  const rawId = row?.id ?? null;
  let id = rawId;
  if (!id) {
    const fallback = `${row?.selectedAgent || 'unknown'}-${toIso(row?.timestamp) || 'unknown'}`;
    id = `dispatch-${fallback}`;
  } else if (!id.startsWith('dispatch-')) {
    id = `dispatch-${id}`;
  }

  const timestamp = toIso(row?.timestamp) || new Date().toISOString();
  const selectedAgent = row.selectedAgent || null;
  const provider = row.provider || blob.provider || null;
  const selectionReason = row.selectionReason || null;

  const summary = selectedAgent
    ? `Dispatched to ${selectedAgent}${selectionReason ? ` (${selectionReason})` : ''}`
    : 'Dispatch decision recorded';

  const candidates = row.candidates !== undefined ? ensureArray(row.candidates) : ensureArray(blob.candidates);
  const weights = row.weights !== undefined ? ensureArray(row.weights) : ensureArray(blob.weights);
  const constraintsApplied = row.constraintsApplied !== undefined
    ? ensureArray(row.constraintsApplied)
    : ensureArray(blob.constraintsApplied);
  const roll = row.roll !== undefined ? row.roll : blob.roll;
  const secondarySelection = row.secondary_selection !== undefined
    ? row.secondary_selection
    : blob.secondary_selection;

  // Raw dispatch ID before prefixing — used as dispatchId correlation key
  const dispatchId = rawId || null;

  // Steer/parent linkage — present when this dispatch was created via operator steer override
  const parentDispatchId = row.parentDispatchId || blob.parentDispatchId || null;
  const steerMeta = row.steer || blob.steer || null;

  return {
    id,
    type: 'dispatch',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: row.campaignId || null,
      taskId: row.taskId || null,
      dispatchId,
      parentDispatchId,
      traceId: row.traceId || null,
      agentId: selectedAgent,
      provider,
    },
    data: {
      selectedAgent,
      taskCategory: row.taskCategory || null,
      campaignId: row.campaignId || null,
      taskId: row.taskId || null,
      traceId: row.traceId || null,
      provider,
      selectionReason,
      candidates,
      weights,
      constraintsApplied,
      roll: roll !== undefined ? roll : null,
      secondary_selection: secondarySelection !== undefined ? secondarySelection : null,
      parentDispatchId,
      steer: steerMeta,
    },
  };
}

/**
 * Map a cb_transitions row into a normalized timeline event.
 * @param {Object} row - Raw circuit breaker transition record from SQLite
 * @returns {{ id: string, type: 'circuit_breaker', timestamp: string, summary: string, data: Object }}
 */
export function mapCbTransitionEvent(row) {
  const provider = row?.provider || 'unknown';
  const previousState = row?.previousState || row?.previous_state || row?.prev_state || 'unknown';
  const newState = row?.newState || row?.state || row?.new_state || 'unknown';
  const summary = `${provider} transitioned ${previousState} → ${newState}`;

  const rawId = row?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    const fallback = `${provider}-${toIso(row?.timestamp) || 'unknown'}`;
    eventId = `cb-transition-${fallback}`;
  } else if (!eventId.startsWith('cb-transition-')) {
    eventId = `cb-transition-${eventId}`;
  }

  const agentId = row?.agentId || null;

  return {
    id: eventId,
    type: 'circuit_breaker',
    timestamp: toIso(row?.timestamp) || new Date().toISOString(),
    summary,
    correlationKeys: {
      campaignId: row?.campaignId || null,
      taskId: row?.taskId || null,
      dispatchId: row?.dispatchId || null,
      traceId: row?.traceId || null,
      agentId,
      provider,
    },
    data: {
      provider,
      agentId,
      previousState,
      newState,
      failureCount: row?.failureCount !== undefined ? row.failureCount : (row?.failure_count || 0),
      campaignId: row?.campaignId || null,
      taskId: row?.taskId || null,
      traceId: row?.traceId || null,
    },
  };
}

/**
 * Map an anomaly alert JSONL entry into a normalized timeline event.
 * @param {Object} entry - Raw alert entry from JSONL history
 * @param {number} index - Entry index (used as fallback for stable ID)
 * @returns {{ id: string, type: 'anomaly_alert', timestamp: string, summary: string, data: Object }}
 */
export function mapAnomalyAlertEvent(entry, index = 0) {
  const timestamp = toIso(entry?.resolvedAt || entry?.firedAt) || new Date().toISOString();
  const agentId = entry?.agentId || 'unknown';
  const category = entry?.taskCategory || 'unknown';
  const severity = entry?.severity || 'info';

  const summary = `Anomaly alert: ${agentId} (${category}) - ${severity}`;

  const naturalKey = entry?.id
    || entry?.alertKey
    || entry?.key
    || (entry?.agentId && entry?.taskCategory ? `agent-anomaly:${entry.agentId}:${entry.taskCategory}` : null);

  return {
    id: naturalKey ? `anomaly-alert-${naturalKey}` : `anomaly-alert-${index}`,
    type: 'anomaly_alert',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: entry?.campaignId || null,
      taskId: entry?.taskId || null,
      dispatchId: entry?.dispatchId || null,
      traceId: entry?.traceId || null,
      agentId,
      provider: entry?.provider || null,
    },
    data: {
      ...entry,
      projectId: entry?.projectId || null,
      condition: entry?.condition || 'agent-anomaly',
      agentId,
      taskCategory: category,
      rollingSuccessRate: entry?.rollingSuccessRate || entry?.rollingRate || null,
      windowSize: entry?.windowSize || null,
      dispatchCount: entry?.dispatchCount || null,
      threshold: entry?.threshold || null,
      severity,
      detail: entry?.detail || null,
      firedAt: entry?.firedAt || null,
      resolvedAt: entry?.resolvedAt !== undefined ? entry.resolvedAt : undefined,
    },
  };
}

/**
 * Map a guardrail outcome entry into a normalized timeline event.
 * @param {Object} entry - Raw guardrail outcome record
 * @param {number} [index] - Entry index (used as fallback for stable ID)
 * @returns {{ id: string, type: 'guardrail_outcome', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapGuardrailEvent(entry, index = 0) {
  const agentId = entry?.agentId || 'unknown';
  const outcome = entry?.outcome || 'unknown'; // e.g. 'pass', 'fail', 'block'
  const ruleId = entry?.ruleId || entry?.rule || null;
  const ruleName = entry?.ruleName || ruleId || 'unknown-rule';
  const timestamp = toIso(entry?.timestamp || entry?.evaluatedAt) || new Date().toISOString();

  const summary = `Guardrail ${outcome}: ${agentId} (${ruleName})`;

  const rawId = entry?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    eventId = `guardrail-${agentId}-${index}`;
  } else if (!eventId.startsWith('guardrail-')) {
    eventId = `guardrail-${eventId}`;
  }

  return {
    id: eventId,
    type: 'guardrail_outcome',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: entry?.campaignId || null,
      taskId: entry?.taskId || null,
      dispatchId: entry?.dispatchId || null,
      traceId: entry?.traceId || null,
      agentId,
      provider: entry?.provider || null,
    },
    data: {
      agentId,
      outcome,
      ruleId,
      ruleName,
      score: entry?.score !== undefined ? entry.score : null,
      detail: entry?.detail || null,
      campaignId: entry?.campaignId || null,
      taskId: entry?.taskId || null,
      traceId: entry?.traceId || null,
    },
  };
}

/**
 * Map a generic operator action record into a normalized timeline event.
 * Detects action type and delegates to specific mapper.
 * @param {Object} row - Raw operator action record from operator_action_events table
 * @returns {{ id: string, type: string, timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapOperatorActionEvent(row) {
  const actionType = row?.action_type || row?.actionType || 'action';

  if (actionType === 'replay') {
    return mapOperatorReplayEvent(row);
  } else if (actionType === 'steer') {
    return mapOperatorSteerEvent(row);
  } else if (actionType === 'routing.weights.applied') {
    return mapOperatorRoutingWeightAppliedEvent(row);
  }

  // Generic fallback for other action types (weight_override, circuit_breaker_hold, cb_reset, alert_ack, etc.)
  const operatorId = row?.operator_id || row?.operatorId || 'unknown';
  const sourceDispatchId = row?.source_dispatch_id || row?.sourceDispatchId || null;
  const targetDispatchId = row?.target_dispatch_id || row?.targetDispatchId || null;
  const status = row?.status || 'unknown';
  const timestamp = toIso(row?.event_ts || row?.timestamp) || new Date().toISOString();

  const summary = `Operator ${operatorId} performed ${actionType}${status !== 'unknown' ? ` (${status})` : ''}`;

  const rawId = row?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    const fallback = `${operatorId}-${actionType}-${toIso(row?.event_ts || row?.timestamp) || 'unknown'}`;
    eventId = `operator-action-${fallback}`;
  } else if (!eventId.startsWith('operator-action-') && !eventId.startsWith('operator-')) {
    eventId = `operator-action-${eventId}`;
  }

  return {
    id: eventId,
    type: 'operator_action',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      dispatchId: row?.dispatch_id || row?.dispatchId || targetDispatchId,
      traceId: row?.trace_id || row?.traceId || null,
      agentId: row?.agent_id || row?.agentId || null,
      provider: row?.provider || null,
      sourceDispatchId,
      targetDispatchId,
    },
    data: {
      operatorId,
      actionType,
      sourceDispatchId,
      targetDispatchId,
      status,
      targetParams: row?.target_params || row?.targetParams || null,
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      traceId: row?.trace_id || row?.traceId || null,
      agentId: row?.agent_id || row?.agentId || null,
      provider: row?.provider || null,
    },
  };
}

/**
 * Map an operator replay action record into a normalized timeline event.
 * @param {Object} row - Raw operator action record from operator_action_events table
 * @returns {{ id: string, type: 'operator_replay', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapOperatorReplayEvent(row) {
  const operatorId = row?.operator_id || row?.operatorId || 'unknown';
  const sourceDispatchId = row?.source_dispatch_id || row?.sourceDispatchId || null;
  const targetDispatchId = row?.target_dispatch_id || row?.targetDispatchId || null;
  const status = row?.status || 'unknown';
  const timestamp = toIso(row?.event_ts || row?.timestamp) || new Date().toISOString();

  const summary = sourceDispatchId
    ? `Operator ${operatorId} replayed dispatch ${sourceDispatchId}${status !== 'unknown' ? ` (${status})` : ''}`
    : `Operator replay by ${operatorId}${status !== 'unknown' ? ` (${status})` : ''}`;

  const rawId = row?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    const fallback = `${operatorId}-${sourceDispatchId || 'unknown'}-${toIso(row?.event_ts || row?.timestamp) || 'unknown'}`;
    eventId = `operator-replay-${fallback}`;
  } else if (!eventId.startsWith('operator-replay-')) {
    eventId = `operator-replay-${eventId}`;
  }

  return {
    id: eventId,
    type: 'operator_replay',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      dispatchId: row?.dispatch_id || row?.dispatchId || targetDispatchId,
      traceId: row?.trace_id || row?.traceId || null,
      agentId: row?.agent_id || row?.agentId || null,
      provider: row?.provider || null,
      sourceDispatchId,
      targetDispatchId,
    },
    data: {
      operatorId,
      actionType: row?.action_type || row?.actionType || 'replay',
      sourceDispatchId,
      targetDispatchId,
      status,
      targetParams: row?.target_params || row?.targetParams || null,
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      traceId: row?.trace_id || row?.traceId || null,
      agentId: row?.agent_id || row?.agentId || null,
      provider: row?.provider || null,
    },
  };
}

/**
 * Map an operator steer action record into a normalized timeline event.
 * @param {Object} row - Raw operator action record from operator_action_events table
 * @returns {{ id: string, type: 'operator_steer', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapOperatorSteerEvent(row) {
  const operatorId = row?.operator_id || row?.operatorId || 'unknown';
  const sourceDispatchId = row?.source_dispatch_id || row?.sourceDispatchId || null;
  const targetDispatchId = row?.target_dispatch_id || row?.targetDispatchId || null;
  const status = row?.status || 'unknown';
  const targetAgent = row?.agent_id || row?.agentId || null;
  const targetProvider = row?.provider || null;
  const timestamp = toIso(row?.event_ts || row?.timestamp) || new Date().toISOString();

  const target = targetAgent && targetProvider
    ? `${targetAgent}/${targetProvider}`
    : targetAgent || targetProvider || 'alternative provider';

  const summary = sourceDispatchId
    ? `Operator ${operatorId} steered ${sourceDispatchId} to ${target}${status !== 'unknown' ? ` (${status})` : ''}`
    : `Operator steer by ${operatorId} to ${target}${status !== 'unknown' ? ` (${status})` : ''}`;

  const rawId = row?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    const fallback = `${operatorId}-${sourceDispatchId || 'unknown'}-${toIso(row?.event_ts || row?.timestamp) || 'unknown'}`;
    eventId = `operator-steer-${fallback}`;
  } else if (!eventId.startsWith('operator-steer-')) {
    eventId = `operator-steer-${eventId}`;
  }

  return {
    id: eventId,
    type: 'operator_steer',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      dispatchId: row?.dispatch_id || row?.dispatchId || targetDispatchId,
      traceId: row?.trace_id || row?.traceId || null,
      agentId: targetAgent,
      provider: targetProvider,
      sourceDispatchId,
      targetDispatchId,
    },
    data: {
      operatorId,
      actionType: row?.action_type || row?.actionType || 'steer',
      sourceDispatchId,
      targetDispatchId,
      status,
      targetParams: row?.target_params || row?.targetParams || null,
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      traceId: row?.trace_id || row?.traceId || null,
      agentId: targetAgent,
      provider: targetProvider,
    },
  };
}

/**
 * Map an operator routing weight applied action record into a normalized timeline event.
 * Captures before/after weight deltas and agent performance metrics.
 * @param {Object} row - Raw operator action record from operator_action_events table
 * @returns {{ id: string, type: 'routing_weights_applied', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapOperatorRoutingWeightAppliedEvent(row) {
  const operatorId = row?.operator_id || row?.operatorId || 'unknown';
  const sourceDispatchId = row?.source_dispatch_id || row?.sourceDispatchId || null;
  const targetDispatchId = row?.target_dispatch_id || row?.targetDispatchId || null;
  const status = row?.status || 'applied';
  const timestamp = toIso(row?.event_ts || row?.timestamp) || new Date().toISOString();

  // Extract weight deltas from event_data JSON
  let eventData = {};
  if (row.event_data) {
    if (typeof row.event_data === 'string') {
      try {
        eventData = JSON.parse(row.event_data);
      } catch {
        eventData = {};
      }
    } else if (typeof row.event_data === 'object') {
      eventData = row.event_data;
    }
  }

  const beforeWeights = eventData.before_weights || eventData.beforeWeights || {};
  const afterWeights = eventData.after_weights || eventData.afterWeights || {};
  const agentPerformanceDeltas = eventData.agent_performance_deltas || eventData.agentPerformanceDeltas || {};
  const successRates = eventData.success_rates || eventData.successRates || {};
  const dispatchCounts = eventData.dispatch_counts || eventData.dispatchCounts || {};

  // Build summary with weight change details
  const providerCount = Object.keys(afterWeights).length;
  const summary = providerCount > 0
    ? `Operator ${operatorId} applied routing weights for ${providerCount} provider(s)${status !== 'unknown' ? ` (${status})` : ''}`
    : `Operator ${operatorId} applied routing weights${status !== 'unknown' ? ` (${status})` : ''}`;

  const rawId = row?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    const fallback = `${operatorId}-routing.weights.applied-${toIso(row?.event_ts || row?.timestamp) || 'unknown'}`;
    eventId = `operator-routing-weight-${fallback}`;
  } else if (!eventId.startsWith('operator-routing-weight-')) {
    eventId = `operator-routing-weight-${eventId}`;
  }

  return {
    id: eventId,
    type: 'routing_weights_applied',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      dispatchId: row?.dispatch_id || row?.dispatchId || targetDispatchId,
      traceId: row?.trace_id || row?.traceId || null,
      agentId: eventData.agent_id || eventData.agentId || null,
      provider: Object.keys(afterWeights).length > 0 ? Object.keys(afterWeights)[0] : null,
      sourceDispatchId,
      targetDispatchId,
    },
    data: {
      operatorId,
      actionType: 'routing.weights.applied',
      sourceDispatchId,
      targetDispatchId,
      status,
      beforeWeights,
      afterWeights,
      weightDeltas: Object.keys(afterWeights).reduce((acc, provider) => {
        acc[provider] = afterWeights[provider] - (beforeWeights[provider] || 0);
        return acc;
      }, {}),
      agentPerformanceDeltas,
      successRates,
      dispatchCounts,
      campaignId: row?.campaign_id || row?.campaignId || null,
      taskId: row?.task_id || row?.taskId || null,
      traceId: row?.trace_id || row?.traceId || null,
    },
  };
}

/**
 * Read dispatch events from a DispatchLog instance.
 * @param {Object} dispatchLog - DispatchLog instance with query method
 * @param {Object} [filters] - Optional filters passed to dispatchLog.query
 * @returns {{ events: Array, total: number }}
 */
export function readDispatchEvents(dispatchLog, filters = {}) {
  const { decisions, total } = dispatchLog.query(filters);
  const events = decisions.map((row) => mapDispatchEvent(row));
  return { events, total };
}

/**
 * Read circuit breaker transition events from a CbTransitionStore instance.
 * @param {Object} cbTransitionStore - CbTransitionStore instance with query method
 * @param {Object} [filters] - Optional filters passed to cbTransitionStore.query
 * @returns {{ events: Array, total: number }}
 */
export function readCbTransitionEvents(cbTransitionStore, filters = {}) {
  const { transitions, total } = cbTransitionStore.query(filters);
  const events = transitions.map((row) => mapCbTransitionEvent(row));
  return { events, total };
}

/**
 * Read anomaly alert events from alert history.
 * @param {string|Array} source - Either file path string or array of alert entries
 * @param {Object} [filters] - Optional filters (agentId, category, since)
 * @returns {{ events: Array, total: number }}
 */
export function readAnomalyAlertEvents(source, filters = {}) {
  let alerts;

  if (Array.isArray(source)) {
    alerts = source;
  } else if (typeof source === 'string') {
    alerts = loadAlertHistory(source);
  } else {
    alerts = [];
  }

  // Apply in-memory filters
  let filtered = alerts;

  if (filters.agentId) {
    filtered = filtered.filter((entry) => entry.agentId === filters.agentId);
  }

  if (filters.category) {
    filtered = filtered.filter((entry) => entry.taskCategory === filters.category);
  }

  if (filters.since) {
    const sinceDate = new Date(filters.since);
    filtered = filtered.filter((entry) => {
      const entryTime = entry.resolvedAt || entry.firedAt;
      return entryTime && new Date(entryTime) >= sinceDate;
    });
  }

  const events = filtered.map((entry, index) => mapAnomalyAlertEvent(entry, index));
  return { events, total: events.length };
}

export function mapDeliberationRequestEvent(record) {
  const payload = parsePayload(record?.payload);
  const sessionId = payload?.sessionId || 'unknown';
  const primaryAgentId = payload?.requesterId || payload?.primaryAgentId || record?.agentId || 'unknown';
  const reviewerId = payload?.reviewerId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();
  const argumentContent = payload?.requestText || payload?.argumentContent || payload?.content || '';
  const contentSummary = summarizeContent(argumentContent);
  const phase = payload?.phase || 'proposal';

  const summary = `Deliberation session ${sessionId} initiated: @${primaryAgentId} requesting review from @${reviewerId}`;

  return {
    id: `deliberation-request-${sessionId}-${toIso(record?.timestamp) || 'unknown'}`,
    type: 'deliberation_request',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      dispatchId: null,
      traceId: record?.traceId || null,
      agentId: primaryAgentId,
      provider: null,
    },
    data: {
      sessionId,
      phase,
      agentId: primaryAgentId,
      agentRole: 'requester',
      agentIdentity: {
        id: primaryAgentId,
        role: 'requester',
      },
      requesterId: primaryAgentId,
      taskId: payload?.taskId || record?.taskId || null,
      taskCategory: payload?.taskCategory || record?.taskCategory || null,
      reviewerId,
      argumentContent,
      contentSummary,
      requestText: argumentContent || null,
      iterationCount: payload?.iterationCount || 0,
      projectId: record?.projectId || null,
    },
  };
}

export function mapDeliberationFeedbackEvent(record) {
  const payload = parsePayload(record?.payload);
  const sessionId = payload?.sessionId || 'unknown';
  const reviewerId = payload?.reviewerId || record?.agentId || 'unknown';
  const status = payload?.status || 'unknown';
  const approved = status === 'approved' || status === 'revision_accepted';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();

  const feedbackText = payload?.feedbackSummary || payload?.feedbackContent || payload?.feedbackText || '';
  const contentSummary = summarizeContent(feedbackText);
  const phase = inferFeedbackPhase(payload, status);
  const summary = `Deliberation feedback from @${reviewerId}: ${status}${sessionId ? ` (session ${sessionId})` : ''}`;

  return {
    id: `deliberation-feedback-${sessionId}-${toIso(record?.timestamp) || 'unknown'}`,
    type: 'deliberation_feedback',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      dispatchId: null,
      traceId: record?.traceId || null,
      agentId: reviewerId,
      provider: null,
    },
    data: {
      sessionId,
      phase,
      agentId: reviewerId,
      agentRole: 'reviewer',
      agentIdentity: {
        id: reviewerId,
        role: 'reviewer',
      },
      reviewerId,
      feedbackText,
      contentSummary,
      approved,
      status,
      iterationCount: payload?.iterationCount || 0,
      findingsCount: payload?.findingsCount || null,
      feedbackContent: payload?.feedbackContent || null,
      unresolvedFindings: payload?.unresolvedFindings || null,
      maxIterations: payload?.maxIterations || null,
      projectId: record?.projectId || null,
    },
  };
}

export function mapDeliberationRevisionEvent(record) {
  const payload = parsePayload(record?.payload);
  const sessionId = payload?.sessionId || 'unknown';
  const executorId = payload?.executorId || record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();

  const revisionText = payload?.feedbackContent || payload?.revisionText || '';
  const contentSummary = summarizeContent(revisionText);
  const phase = payload?.phase || 'synthesis';
  const summary = `Revision started by @${executorId} for session ${sessionId}`;

  return {
    id: `deliberation-revision-${sessionId}-${toIso(record?.timestamp) || 'unknown'}`,
    type: 'deliberation_revision',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      dispatchId: null,
      traceId: record?.traceId || null,
      agentId: executorId,
      provider: null,
    },
    data: {
      sessionId,
      phase,
      agentId: executorId,
      agentRole: 'executor',
      agentIdentity: {
        id: executorId,
        role: 'executor',
      },
      executorId,
      revisionText,
      contentSummary,
      iterationCount: payload?.iterationCount || 0,
      findingsCount: payload?.findingsCount || null,
      fixSubtasksCount: payload?.fixSubtasksCount || null,
      feedbackContent: payload?.feedbackContent || null,
      projectId: record?.projectId || null,
    },
  };
}

export function mapArgumentSubmittedEvent(record) {
  const payload = parsePayload(record?.payload);
  const sessionId = payload?.sessionId || record?.sessionId || 'unknown';
  const agentId = payload?.agentId || record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();

  // Extract argument content - may be in payload.argumentContent or payload.content
  const argumentContent = payload?.argumentContent || payload?.content || '';
  const contentSummary = summarizeContent(argumentContent);

  // Extract reasoning context
  const reasoning = payload?.reasoning || null;
  const messageType = record?.messageType || payload?.messageType || null;
  const currentState = record?.currentState || payload?.currentState || null;
  const context = payload?.context || null;

  const summary = `Argument submitted by @${agentId} for session ${sessionId}`;

  return {
    id: `deliberation-argument-${sessionId}-${toIso(record?.timestamp) || 'unknown'}`,
    type: 'argument_submitted',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      dispatchId: null,
      traceId: record?.traceId || null,
      agentId: agentId,
      provider: null,
    },
    data: {
      sessionId,
      agentId,
      agentRole: 'participant',
      agentIdentity: {
        id: agentId,
        role: 'participant',
      },
      argumentContent,
      contentSummary,
      // Reasoning context fields
      reasoning,
      messageType,
      currentState,
      context,
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      traceId: record?.traceId || null,
      projectId: record?.projectId || null,
    },
  };
}

export function mapChallengeRaisedEvent(record) {
  const payload = parsePayload(record?.payload);
  const sessionId = payload?.sessionId || record?.sessionId || 'unknown';
  const agentId = payload?.agentId || record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();

  // Extract challenge content - may be in payload.challengeReason or payload.content
  const challengeReason = payload?.challengeReason || payload?.content || '';
  const contentSummary = summarizeContent(challengeReason);

  // Extract prior-argument references and reasoning context
  const targetArgumentId = payload?.targetArgumentId || null;
  const target = record?.target || payload?.target || null;
  const reasoning = record?.reasoning || payload?.reasoning || null;
  const messageType = record?.messageType || payload?.messageType || null;
  const currentState = record?.currentState || payload?.currentState || null;

  const summary = `Challenge raised by @${agentId} for session ${sessionId}: ${contentSummary}`;

  return {
    id: `deliberation-challenge-${sessionId}-${toIso(record?.timestamp) || 'unknown'}`,
    type: 'challenge_raised',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      dispatchId: null,
      traceId: record?.traceId || null,
      agentId: agentId,
      provider: null,
    },
    data: {
      sessionId,
      agentId,
      agentRole: 'challenger',
      agentIdentity: {
        id: agentId,
        role: 'challenger',
      },
      challengeReason,
      targetArgumentId,
      contentSummary,
      // Reasoning context and prior-argument references
      target,
      reasoning,
      messageType,
      currentState,
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      traceId: record?.traceId || null,
      projectId: record?.projectId || null,
    },
  };
}

export function mapSynthesisProducedEvent(record) {
  const payload = parsePayload(record?.payload);
  const sessionId = payload?.sessionId || record?.sessionId || 'unknown';
  const agentId = payload?.agentId || record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();

  // Extract synthesis content - may be in payload.synthesisContent or payload.content
  const synthesisContent = payload?.synthesisContent || payload?.content || '';
  const contentSummary = summarizeContent(synthesisContent);

  // Extract reasoning context and prior-argument references
  const synthesisSummary = record?.summary || payload?.summary || null;
  const supportingArguments = record?.supportingArguments || payload?.supportingArguments || null;
  const messageType = record?.messageType || payload?.messageType || null;
  const currentState = record?.currentState || payload?.currentState || null;

  const summary = `Synthesis produced by @${agentId} for session ${sessionId}`;

  return {
    id: `deliberation-synthesis-${sessionId}-${toIso(record?.timestamp) || 'unknown'}`,
    type: 'synthesis_produced',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      dispatchId: null,
      traceId: record?.traceId || null,
      agentId: agentId,
      provider: null,
    },
    data: {
      sessionId,
      agentId,
      agentRole: 'synthesizer',
      agentIdentity: {
        id: agentId,
        role: 'synthesizer',
      },
      synthesisContent,
      contentSummary,
      // Reasoning context and prior-argument references
      synthesisSummary,
      supportingArguments,
      messageType,
      currentState,
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      traceId: record?.traceId || null,
      projectId: record?.projectId || null,
    },
  };
}

export function mapRevisionCompletedEvent(record) {
  const payload = parsePayload(record?.payload);
  const sessionId = payload?.sessionId || record?.sessionId || 'unknown';
  const agentId = payload?.agentId || record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();

  // Extract revised content - may be in payload.revisedContent or payload.content
  const revisedContent = payload?.revisedContent || payload?.content || '';
  const contentSummary = summarizeContent(revisedContent);

  // Extract reasoning context
  const output = record?.output || payload?.output || null;
  const criteria = record?.criteria || payload?.criteria || null;
  const messageType = record?.messageType || payload?.messageType || null;
  const currentState = record?.currentState || payload?.currentState || null;

  const summary = `Revision completed by @${agentId} for session ${sessionId}`;

  return {
    id: `deliberation-revision-completed-${sessionId}-${toIso(record?.timestamp) || 'unknown'}`,
    type: 'revision_completed',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      dispatchId: null,
      traceId: record?.traceId || null,
      agentId: agentId,
      provider: null,
    },
    data: {
      sessionId,
      agentId,
      agentRole: 'reviser',
      agentIdentity: {
        id: agentId,
        role: 'reviser',
      },
      revisedContent,
      contentSummary,
      // Reasoning context
      output,
      criteria,
      messageType,
      currentState,
      campaignId: payload?.campaignId || record?.campaignId || null,
      taskId: payload?.taskId || record?.taskId || null,
      traceId: record?.traceId || null,
      projectId: record?.projectId || null,
    },
  };
}

/**
 * Map an MCP tool invocation START record into a normalized timeline event.
 * @param {Object} record - Tool invocation record with toolName, serverSource, agentId, parameters
 * @returns {{ id: string, type: 'tool_invocation_start', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapToolInvocationStartEvent(record) {
  const toolName = record?.toolName || 'unknown';
  const serverSource = record?.serverSource || 'unknown';
  const agentId = record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();

  const paramsSummary = record?.parameters
    ? summarizeContent(JSON.stringify(record.parameters), 100)
    : '';

  const summary = `MCP Tool ${toolName} invocation started on ${serverSource} by @${agentId}`;

  const rawId = record?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    eventId = `mcp-tool-start-${toolName}-${agentId}-${toIso(record?.timestamp) || 'unknown'}`;
  } else if (!eventId.startsWith('mcp-tool-start-')) {
    eventId = `mcp-tool-start-${eventId}`;
  }

  return {
    id: eventId,
    type: 'tool_invocation_start',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: record?.campaignId || null,
      taskId: record?.taskId || null,
      subtaskId: record?.subtaskId || null,
      dispatchId: record?.dispatchId || null,
      traceId: record?.traceId || null,
      agentId,
      serverSource,
    },
    data: {
      toolName,
      serverSource,
      agentId,
      parameters: record?.parameters || null,
      paramsSummary,
      campaignId: record?.campaignId || null,
      taskId: record?.taskId || null,
      subtaskId: record?.subtaskId || null,
      traceId: record?.traceId || null,
      dispatchId: record?.dispatchId || null,
    },
  };
}

/**
 * Map an MCP tool invocation SUCCESS record into a normalized timeline event.
 * @param {Object} record - Tool invocation record with toolName, serverSource, agentId, result
 * @returns {{ id: string, type: 'tool_invocation_success', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapToolInvocationSuccessEvent(record) {
  const toolName = record?.toolName || 'unknown';
  const serverSource = record?.serverSource || 'unknown';
  const agentId = record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();
  const elapsedMs = record?.elapsedMs !== undefined ? record.elapsedMs : 0;

  const resultSummary = record?.result
    ? summarizeContent(typeof record.result === 'object' ? JSON.stringify(record.result) : record.result, 100)
    : '';

  const summary = `MCP Tool ${toolName} invocation succeeded on ${serverSource} by @${agentId} in ${elapsedMs}ms`;

  const rawId = record?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    eventId = `mcp-tool-success-${toolName}-${agentId}-${toIso(record?.timestamp) || 'unknown'}`;
  } else if (!eventId.startsWith('mcp-tool-success-')) {
    eventId = `mcp-tool-success-${eventId}`;
  }

  return {
    id: eventId,
    type: 'tool_invocation_success',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: record?.campaignId || null,
      taskId: record?.taskId || null,
      subtaskId: record?.subtaskId || null,
      dispatchId: record?.dispatchId || null,
      traceId: record?.traceId || null,
      agentId,
      serverSource,
    },
    data: {
      toolName,
      serverSource,
      agentId,
      result: record?.result || null,
      resultSummary,
      elapsedMs,
      campaignId: record?.campaignId || null,
      taskId: record?.taskId || null,
      subtaskId: record?.subtaskId || null,
      traceId: record?.traceId || null,
      dispatchId: record?.dispatchId || null,
    },
  };
}

/**
 * Map an MCP tool invocation ERROR record into a normalized timeline event.
 * @param {Object} record - Tool invocation record with toolName, serverSource, agentId, error
 * @returns {{ id: string, type: 'tool_invocation_error', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapToolInvocationErrorEvent(record) {
  const toolName = record?.toolName || 'unknown';
  const serverSource = record?.serverSource || 'unknown';
  const agentId = record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();
  const elapsedMs = record?.elapsedMs !== undefined ? record.elapsedMs : 0;

  const errorSummary = record?.error || record?.code
    ? `${record.code || 'ERROR'}: ${summarizeContent(record.error, 100) || ''}`
    : '';

  const summary = `MCP Tool ${toolName} invocation failed on ${serverSource} by @${agentId} in ${elapsedMs}ms${errorSummary ? `: ${errorSummary}` : ''}`;

  const rawId = record?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    eventId = `mcp-tool-error-${toolName}-${agentId}-${toIso(record?.timestamp) || 'unknown'}`;
  } else if (!eventId.startsWith('mcp-tool-error-')) {
    eventId = `mcp-tool-error-${eventId}`;
  }

  return {
    id: eventId,
    type: 'tool_invocation_error',
    timestamp,
    summary,
    correlationKeys: {
      campaignId: record?.campaignId || null,
      taskId: record?.taskId || null,
      subtaskId: record?.subtaskId || null,
      dispatchId: record?.dispatchId || null,
      traceId: record?.traceId || null,
      agentId,
      serverSource,
    },
    data: {
      toolName,
      serverSource,
      agentId,
      error: record?.error || null,
      code: record?.code || null,
      errorSummary,
      elapsedMs,
      campaignId: record?.campaignId || null,
      taskId: record?.taskId || null,
      subtaskId: record?.subtaskId || null,
      traceId: record?.traceId || null,
      dispatchId: record?.dispatchId || null,
    },
  };
}

/**
 * Map a tool invocation record into a normalized timeline event.
 * @param {Object} record - Tool invocation record with toolName, args, result, status, elapsedMs, timestamp
 * @returns {{ id: string, type: 'tool_invocation', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapToolInvocationEvent(record) {
  const toolName = record?.toolName || 'unknown';
  const status = record?.status || 'unknown';
  const elapsedMs = record?.elapsedMs !== undefined ? record.elapsedMs : 0;
  const agentId = record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();
  const taskId = record?.taskId || null;
  const subtaskId = record?.subtaskId || null;
  const traceId = record?.traceId || null;
  const campaignId = record?.campaignId || null;
  const provider = record?.provider || null;
  const dispatchId = record?.dispatchId || null;

  const argsSummary = record?.args
    ? summarizeContent(JSON.stringify(record.args), 100)
    : '';
  const resultSummary = record?.result
    ? summarizeContent(typeof record.result === 'object' ? JSON.stringify(record.result) : record.result, 100)
    : '';
  const errorSummary = record?.error || record?.code ? `${record.code || 'ERROR'}: ${record.error || ''}` : '';

  const statusLabel = status === 'success' ? 'succeeded' : status === 'error' ? 'failed' : status;
  const source = (record?.serverSource || record?.mcpServer) ? 'mcp' : 'native';
  const mcpServerLabel = record?.serverSource || record?.mcpServer || null;
  const summary = `${source === 'mcp' ? `MCP Tool (${mcpServerLabel})` : 'Tool'} ${toolName} ${statusLabel} in ${elapsedMs}ms by @${agentId}${errorSummary ? ` (${errorSummary})` : ''}`;

  const rawId = record?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    eventId = `tool-invocation-${toolName}-${agentId}-${toIso(record?.timestamp) || 'unknown'}`;
  } else if (!eventId.startsWith('tool-invocation-')) {
    eventId = `tool-invocation-${eventId}`;
  }

  const data = {
    toolName,
    status,
    elapsedMs,
    agentId,
    args: record?.args || null,
    result: record?.result || null,
    error: record?.error || null,
    code: record?.code || null,
    argsSummary,
    resultSummary,
    errorSummary,
    taskId,
    subtaskId,
    traceId,
    campaignId,
    provider,
    dispatchId,
    mcpServer: record?.mcpServer || null,
    serverSource: record?.serverSource || null,
    streaming: record?.streaming || false,
    source,
  };

  return {
    id: eventId,
    type: 'tool_invocation',
    timestamp,
    summary,
    correlationKeys: {
      campaignId,
      taskId,
      dispatchId,
      traceId,
      agentId,
      provider,
    },
    data,
  };
}

/**
 * Map a tool invocation record into a normalized timeline event.
 * @param {Object} record - Tool invocation record with toolName, args, result, status, elapsedMs, timestamp
 * @returns {{ id: string, type: 'native_tool_invocation', timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
export function mapNativeToolInvocationEvent(record) {
  const toolName = record?.toolName || 'unknown';
  const status = record?.status || 'unknown';
  const elapsedMs = record?.elapsedMs !== undefined ? record.elapsedMs : 0;
  const agentId = record?.agentId || 'unknown';
  const timestamp = toIso(record?.timestamp) || new Date().toISOString();
  const taskId = record?.taskId || null;
  const subtaskId = record?.subtaskId || null;
  const traceId = record?.traceId || null;
  const campaignId = record?.campaignId || null;
  const provider = record?.provider || null;
  const dispatchId = record?.dispatchId || null;

  const argsSummary = record?.args
    ? summarizeContent(JSON.stringify(record.args), 100)
    : '';
  const resultSummary = record?.result
    ? summarizeContent(typeof record.result === 'object' ? JSON.stringify(record.result) : record.result, 100)
    : '';
  const errorSummary = record?.error || record?.code ? `${record.code || 'ERROR'}: ${record.error || ''}` : '';

  const statusLabel = status === 'success' ? 'succeeded' : status === 'error' ? 'failed' : status;
  const source = 'native'; // Explicitly set as native
  const summary = `Native Tool ${toolName} ${statusLabel} in ${elapsedMs}ms by @${agentId}${errorSummary ? ` (${errorSummary})` : ''}`;

  const rawId = record?.id ?? null;
  let eventId = rawId;
  if (!eventId) {
    eventId = `native-tool-invocation-${toolName}-${agentId}-${toIso(record?.timestamp) || 'unknown'}`;
  } else if (!eventId.startsWith('native-tool-invocation-')) {
    eventId = `native-tool-invocation-${eventId}`;
  }

  const data = {
    toolName,
    status,
    elapsedMs,
    agentId,
    args: record?.args || null,
    result: record?.result || null,
    error: record?.error || null,
    code: record?.code || null,
    argsSummary,
    resultSummary,
    errorSummary,
    taskId,
    subtaskId,
    traceId,
    campaignId,
    provider,
    dispatchId,
    mcpServer: record?.mcpServer || null, // Will be null for native tools
    streaming: record?.streaming || false,
    source,
  };

  return {
    id: eventId,
    type: 'native_tool_invocation',
    timestamp,
    summary,
    correlationKeys: {
      campaignId,
      taskId,
      dispatchId,
      traceId,
      agentId,
      provider,
    },
    data,
  };
}

export default {
  mapDispatchEvent,
  mapCbTransitionEvent,
  mapAnomalyAlertEvent,
  mapGuardrailEvent,
  mapOperatorActionEvent,
  mapOperatorReplayEvent,
  mapOperatorSteerEvent,
  mapOperatorRoutingWeightAppliedEvent,
  mapDeliberationRequestEvent,
  mapDeliberationFeedbackEvent,
  mapDeliberationRevisionEvent,
  mapArgumentSubmittedEvent,
  mapChallengeRaisedEvent,
  mapSynthesisProducedEvent,
  mapRevisionCompletedEvent,
  mapToolInvocationStartEvent,
  mapToolInvocationSuccessEvent,
  mapToolInvocationErrorEvent,
  mapToolInvocationEvent,
  mapNativeToolInvocationEvent,
  readDispatchEvents,
  readCbTransitionEvents,
  readAnomalyAlertEvents,
};
