/**
 * timeline-schema.js — Unified Operational Timeline schema definition and validator.
 *
 * Every timeline event conforms to this envelope:
 *   {
 *     id:              string        — stable, prefixed identifier
 *     type:            EVENT_TYPE    — one of the canonical type constants below
 *     timestamp:       string        — ISO 8601 UTC timestamp
 *     summary:         string        — human-readable one-liner
 *     correlationKeys: {            — correlation key bag (all optional)
 *       campaignId?:   string|null
 *       taskId?:       string|null
 *       dispatchId?:   string|null
 *       traceId?:      string|null
 *       agentId?:      string|null
 *       provider?:     string|null
 *     }
 *     data:            Object        — type-specific payload
 *   }
 *
 * Per-type required data fields:
 *   dispatch:                        selectedAgent, candidates, weights
 *   circuit_breaker:                 provider, previousState, newState
 *   anomaly_alert:                   agentId, taskCategory, severity
 *   guardrail_outcome:               agentId, outcome
 *   operator_action:                 action, operatorId, status
 *   operator_replay:                 operatorId, actionType, sourceDispatchId, status
 *   operator_steer:                  operatorId, actionType, sourceDispatchId, status
 *   task_rejected:                   taskId, reviewerId, findingsCount
 *   task_rework_start:               taskId, parentCorrelationId
 *   task_resolution:                 taskId, parentCorrelationId, rootCorrelationId
*   error_constraint_recommendation:               agentId, errorCategory, patternId, triggeringDispatchIds, threshold, windowSeconds
 *   error_constraint_dismissed:      constraintId, agentId, errorCategory, operatorId
 *   error_constraint_expired:        constraintId, agentId, errorCategory, createdAt, expiresAt
 *   error_propagation:     failedNodeId, errorChain (JSON), impactSummary
 *   deliberation_request:            sessionId, requesterId, taskId, taskCategory
 *   deliberation_feedback:           sessionId, reviewerId, feedbackText, approved
 *   deliberation_revision:           sessionId, executorId, revisionText
 */

/** Canonical event type identifiers */
export const EVENT_TYPES = {
  DISPATCH: 'dispatch',
  CIRCUIT_BREAKER: 'circuit_breaker',
  ANOMALY_ALERT: 'anomaly_alert',
  GUARDRAIL_OUTCOME: 'guardrail_outcome',
  OPERATOR_ACTION: 'operator_action',
  OPERATOR_REPLAY: 'operator_replay',
  OPERATOR_STEER: 'operator_steer',
  TASK_REJECTED: 'task_rejected',
  TASK_REWORK_START: 'task_rework_start',
  TASK_RESOLUTION: 'task_resolution',
  ROUTING_PROPOSAL: 'routing_proposal',
  COST_DISPATCH: 'cost_dispatch',
  SLA_BREACH: 'sla_breach',
  SLA_RESOLVED: 'sla_resolved',
  ERROR_PATTERN_CONSTRAINT: 'error_pattern_constraint',
  ERROR_CONSTRAINT_RECOMMENDATION: 'error_constraint_recommendation',
  ERROR_CONSTRAINT_DISMISSED: 'error_constraint_dismissed',
  ERROR_CONSTRAINT_EXPIRED: 'error_constraint_expired',
  ERROR_PROPAGATION: 'error_propagation',
  DELIBERATION_REQUEST: 'deliberation_request',
  DELIBERATION_FEEDBACK: 'deliberation_feedback',
  DELIBERATION_REVISION: 'deliberation_revision',
  ARGUMENT_SUBMITTED: 'argument_submitted',
  CHALLENGE_RAISED: 'challenge_raised',
  SYNTHESIS_PRODUCED: 'synthesis_produced',
  REVISION_COMPLETED: 'revision_completed',
  TOOL_INVOCATION_START: 'tool_invocation_start',
  TOOL_INVOCATION_SUCCESS: 'tool_invocation_success',
  TOOL_INVOCATION_ERROR: 'tool_invocation_error',
  NATIVE_TOOL_INVOCATION: 'native_tool_invocation',
  TOOL_INVOCATION: 'tool_invocation',
  MILESTONE_APPROVAL: 'milestone_approval',
};

/** Set of all valid type strings for fast membership tests */
export const VALID_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));

/** Approval request statuses created by migration 014 approval gate infrastructure. */
export const MILESTONE_APPROVAL_STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'timeout',
]);

/** Milestone lifecycle/audit event types created by migration 014 milestone_events. */
export const MILESTONE_EVENT_TYPES = Object.freeze([
  'created',
  'paused_for_approval',
  'resumed',
  'completed',
  'failed',
  'skipped',
  'approval_requested',
  'approval_granted',
  'approval_rejected',
  'approval_timeout',
]);

/** Required top-level envelope fields */
const ENVELOPE_REQUIRED = ['id', 'type', 'timestamp', 'summary', 'data'];

/** Per-type required data fields */
const DATA_REQUIRED = {
  [EVENT_TYPES.DISPATCH]: ['selectedAgent', 'candidates', 'weights'],
  [EVENT_TYPES.CIRCUIT_BREAKER]: ['provider', 'previousState', 'newState'],
  [EVENT_TYPES.ANOMALY_ALERT]: ['agentId', 'taskCategory', 'severity'],
  [EVENT_TYPES.GUARDRAIL_OUTCOME]: ['agentId', 'outcome'],
  [EVENT_TYPES.OPERATOR_ACTION]: ['action', 'operatorId', 'status'],
  [EVENT_TYPES.OPERATOR_REPLAY]: ['operatorId', 'actionType', 'sourceDispatchId', 'status'],
  [EVENT_TYPES.OPERATOR_STEER]: ['operatorId', 'actionType', 'sourceDispatchId', 'status'],
  [EVENT_TYPES.TASK_REJECTED]: ['taskId', 'reviewerId', 'findingsCount'],
  [EVENT_TYPES.TASK_REWORK_START]: ['taskId', 'parentCorrelationId'],
  [EVENT_TYPES.TASK_RESOLUTION]: ['taskId', 'parentCorrelationId', 'rootCorrelationId'],
  [EVENT_TYPES.ROUTING_PROPOSAL]: ['proposalId', 'sourceType', 'sourceRecommendationId', 'proposedWeights', 'currentWeights', 'state', 'confidence', 'rationale'],
  [EVENT_TYPES.COST_DISPATCH]: ['provider', 'model', 'inputTokens', 'outputTokens', 'costUsd'],
  [EVENT_TYPES.SLA_BREACH]: ['slaType', 'threshold', 'actual', 'windowMinutes', 'provider', 'projectId', 'breachedAt'],
  [EVENT_TYPES.SLA_RESOLVED]: ['slaType', 'threshold', 'actual', 'windowMinutes', 'provider', 'projectId', 'breachedAt'],
  [EVENT_TYPES.ERROR_PATTERN_CONSTRAINT]: ['agentId', 'errorCategory', 'patternId', 'triggeringDispatchIds', 'parentCorrelationId', 'rootCorrelationId'],
  [EVENT_TYPES.ERROR_CONSTRAINT_RECOMMENDATION]: ['agentId', 'errorCategory', 'patternId', 'triggeringDispatchIds', 'threshold', 'windowSeconds'],
  [EVENT_TYPES.ERROR_CONSTRAINT_DISMISSED]: ['constraintId', 'agentId', 'errorCategory', 'operatorId'],
  [EVENT_TYPES.ERROR_CONSTRAINT_EXPIRED]: ['constraintId', 'agentId', 'errorCategory', 'createdAt', 'expiresAt'],
  [EVENT_TYPES.ERROR_PROPAGATION]: ['failedNodeId', 'errorChain', 'impactSummary'],
  [EVENT_TYPES.DELIBERATION_REQUEST]: ['sessionId', 'requesterId', 'taskId', 'taskCategory'],
  [EVENT_TYPES.DELIBERATION_FEEDBACK]: ['sessionId', 'reviewerId', 'feedbackText', 'approved'],
  [EVENT_TYPES.DELIBERATION_REVISION]: ['sessionId', 'executorId', 'revisionText'],
  [EVENT_TYPES.ARGUMENT_SUBMITTED]: ['sessionId', 'agentId', 'argumentContent'],
  [EVENT_TYPES.CHALLENGE_RAISED]: ['sessionId', 'agentId', 'challengeReason', 'targetArgumentId'],
  [EVENT_TYPES.SYNTHESIS_PRODUCED]: ['sessionId', 'agentId', 'synthesisContent'],
  [EVENT_TYPES.REVISION_COMPLETED]: ['sessionId', 'agentId', 'revisedContent'],
  [EVENT_TYPES.TOOL_INVOCATION_START]: ['toolName', 'serverSource', 'agentId', 'parameters'],
  [EVENT_TYPES.TOOL_INVOCATION_SUCCESS]: ['toolName', 'serverSource', 'agentId', 'result'],
  [EVENT_TYPES.TOOL_INVOCATION_ERROR]: ['toolName', 'serverSource', 'agentId', 'error'],
  [EVENT_TYPES.NATIVE_TOOL_INVOCATION]: ['toolName', 'status', 'elapsedMs', 'agentId'],
  [EVENT_TYPES.TOOL_INVOCATION]: ['toolName', 'status', 'elapsedMs', 'agentId'],
  [EVENT_TYPES.MILESTONE_APPROVAL]: ['milestoneId', 'operatorId', 'status'],
};

/** Known correlation key names */
export const CORRELATION_KEY_NAMES = [
  'campaignId',
  'taskId',
  'dispatchId',
  'traceId',
  'agentId',
  'provider',
];

// ============================================================================
// Database schema definitions + migration tracking
// ============================================================================

/** Timeline schema version (latest migration version, matches SQL string format) */
export const TIMELINE_SCHEMA_VERSION = '014';

/** Migration tracking table name (matches SQL in migration-runner.js and 001_create_event_tables.sql) */
export const TIMELINE_MIGRATIONS_TABLE = 'migration_versions';

/** Migration tracking table columns (SQLite, matches 001_create_event_tables.sql) */
export const TIMELINE_MIGRATIONS_COLUMNS = [
  'version',
  'applied_at',
  'description',
  'checksum',
];

/** Timeline events tables and expected columns/indexes (aligned with SQL migrations) */
export const TIMELINE_TABLES = Object.freeze({
  routing_events: {
    columns: [
      'id',
      'event_ts',
      'created_at',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'agent_id',
      'provider',
      'task_category',
      'selected_agent',
      'selection_reason',
      'outcome',
      'data',
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_routing_event_ts',
      'idx_routing_campaign_id',
      'idx_routing_dispatch_id',
      'idx_routing_trace_id',
      'idx_routing_agent_id',
      'idx_routing_provider',
      'idx_routing_campaign_ts',
      'idx_routing_agent_ts',
      'idx_routing_outcome',
      'idx_routing_parent_correlation_id',
      'idx_routing_root_correlation_id',
    ],
  },
  guardrail_events: {
    columns: [
      'id',
      'event_ts',
      'created_at',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'agent_id',
      'provider',
      'rule_id',
      'rule_name',
      'outcome',
      'score',
      'detail',
      'data',
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_guardrail_event_ts',
      'idx_guardrail_campaign_id',
      'idx_guardrail_dispatch_id',
      'idx_guardrail_agent_id',
      'idx_guardrail_provider',
      'idx_guardrail_rule_id',
      'idx_guardrail_outcome',
      'idx_guardrail_campaign_ts',
      'idx_guardrail_dispatch_ts',
      'idx_guardrail_parent_correlation_id',
      'idx_guardrail_root_correlation_id',
    ],
  },
  circuit_breaker_events: {
    columns: [
      'id',
      'event_ts',
      'created_at',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'agent_id',
      'provider',
      'state',
      'previous_state',
      'failure_count',
      'success_count',
      'last_failure_ts',
      'last_success_ts',
      'data',
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_cb_event_ts',
      'idx_cb_campaign_id',
      'idx_cb_dispatch_id',
      'idx_cb_agent_id',
      'idx_cb_provider',
      'idx_cb_state',
      'idx_cb_provider_state',
      'idx_cb_provider_ts',
      'idx_cb_campaign_provider_ts',
      'idx_cb_parent_correlation_id',
      'idx_cb_root_correlation_id',
    ],
  },
  anomaly_events: {
    columns: [
      'id',
      'event_ts',
      'created_at',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'agent_id',
      'provider',
      'task_category',
      'anomaly_type',
      'severity',
      'state',
      'threshold',
      'actual_value',
      'data',
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_anomaly_event_ts',
      'idx_anomaly_campaign_id',
      'idx_anomaly_dispatch_id',
      'idx_anomaly_agent_id',
      'idx_anomaly_provider',
      'idx_anomaly_anomaly_type',
      'idx_anomaly_severity',
      'idx_anomaly_state',
      'idx_anomaly_campaign_ts',
      'idx_anomaly_agent_severity',
      'idx_anomaly_parent_correlation_id',
      'idx_anomaly_root_correlation_id',
    ],
  },
  operator_action_events: {
    columns: [
      'id',
      'event_ts',
      'created_at',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'agent_id',
      'provider',
      'action_type',
      'operator_id',
      'source_dispatch_id',
      'target_dispatch_id',
      'target_params',
      'status',
      'data',
      'parent_correlation_id',
      'root_correlation_id',
      'idempotency_key',
    ],
    indexes: [
      'idx_operator_event_ts',
      'idx_operator_campaign_id',
      'idx_operator_dispatch_id',
      'idx_operator_source_dispatch_id',
      'idx_operator_target_dispatch_id',
      'idx_operator_action_type',
      'idx_operator_operator_id',
      'idx_operator_parent_correlation_id',
      'idx_operator_root_correlation_id',
      'idx_operator_idempotency_key',
    ],
  },
  cost_events: {
    columns: [
      'id',
      'idempotency_key',
      'event_ts',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'agent_id',
      'provider',
      'task_id',
      'model',
      'input_tokens',
      'output_tokens',
      'cost_usd',
      'event_data',
      'created_at',
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_cost_events_event_ts',
      'idx_cost_events_agent_id',
      'idx_cost_events_campaign_id',
      'idx_cost_events_provider',
      'idx_cost_events_dispatch_id',
      'idx_cost_events_trace_id',
      'idx_cost_events_parent_correlation_id',
      'idx_cost_events_root_correlation_id',
      'idx_cost_events_agent_ts',
      'idx_cost_events_campaign_ts',
      'idx_cost_events_provider_ts',
    ],
  },
  sla_events: {
    columns: [
      'id',
      'event_ts',
      'created_at',
      'campaign_id',
      'dispatch_id',
      'trace_id',
      'agent_id',
      'sla_type',
      'threshold',
      'actual',
      'window_minutes',
      'provider',
      'project_id',
      'breached_at',
      'resolved_at',
      'event_data',
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_sla_events_event_ts',
      'idx_sla_events_agent_id',
      'idx_sla_events_campaign_id',
      'idx_sla_events_provider',
      'idx_sla_events_dispatch_id',
      'idx_sla_events_trace_id',
      'idx_sla_events_sla_type',
      'idx_sla_events_project_id',
      'idx_sla_events_breached_at',
      'idx_sla_events_resolved_at',
      'idx_sla_events_parent_correlation_id',
      'idx_sla_events_root_correlation_id',
    ],
  },
  error_propagation_events: {
    columns: [
      'id',
      'event_ts',
      'created_at',
      'campaign_id',
      'milestone_id',
      'task_id',
      'subtask_id',
      'failed_node_id',
      'error_chain',
      'impact_summary',
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_error_prop_event_ts',
      'idx_error_prop_campaign_id',
      'idx_error_prop_milestone_id',
      'idx_error_prop_task_id',
      'idx_error_prop_subtask_id',
      'idx_error_prop_failed_node_id',
      'idx_error_prop_campaign_ts',
      'idx_error_prop_parent_correlation_id',
      'idx_error_prop_root_correlation_id',
    ],
  },
  audit_events: {
    columns: [
      'event_id',
      'trace_id',
      'agent_id',
      'event_ts',
      'created_at',
      'action_type',
      'input_summary',
      'output_summary',
      'outcome',
      'campaign_id',
      'task_id',
      'subtask_id',
      'event_data',
    ],
    indexes: [
      'idx_audit_event_ts',
      'idx_audit_agent_id',
      'idx_audit_agent_ts',
      'idx_audit_campaign_id',
      'idx_audit_campaign_ts',
      'idx_audit_trace_id',
      'idx_audit_action_type',
      'idx_audit_action_type_ts',
      'idx_audit_task_id',
      'idx_audit_subtask_id',
    ],
  },
  approval_requests: {
    columns: [
      'id',
      'campaign_id',
      'milestone_id',
      'milestone_title',
      'requested_by',
      'requested_at',
      'approved_by',
      'approved_at',
      'rejected_by',
      'rejected_at',
      'status',
      'timeout_at',
      'operator_notes',
      'trace_id',
      'created_at',
      'event_data',
    ],
    indexes: [
      'idx_approval_campaign_id',
      'idx_approval_milestone_id',
      'idx_approval_status',
      'idx_approval_requested_at',
      'idx_approval_campaign_status',
      'idx_approval_timeout',
    ],
  },
  milestone_events: {
    columns: [
      'id',
      'campaign_id',
      'milestone_id',
      'event_ts',
      'event_type',
      'previous_status',
      'new_status',
      'operator_id',
      'reason',
      'trace_id',
      'created_at',
      'event_data',
    ],
    indexes: [
      'idx_milestone_event_ts',
      'idx_milestone_campaign_id',
      'idx_milestone_milestone_id',
      'idx_milestone_campaign_ts',
      'idx_milestone_event_type',
    ],
  },
});

/** Ordered list of migrations for the timeline schema. */
export const TIMELINE_MIGRATIONS = Object.freeze([
  {
    version: '001',
    name: '001_create_event_tables',
    tables: [
      'routing_events',
      'guardrail_events',
      'circuit_breaker_events',
      'anomaly_events',
    ],
  },
  {
    version: '002',
    name: '002_add_event_indexes',
    indexes: [
      ...TIMELINE_TABLES.routing_events.indexes,
      ...TIMELINE_TABLES.guardrail_events.indexes,
      ...TIMELINE_TABLES.circuit_breaker_events.indexes,
      ...TIMELINE_TABLES.anomaly_events.indexes,
    ],
  },
  {
    version: '003',
    name: '003_add_operator_action_events',
    tables: ['operator_action_events'],
    indexes: [...TIMELINE_TABLES.operator_action_events.indexes],
  },
  {
    version: '004',
    name: '004_add_causal_correlation_columns',
    columns: [
      'parent_correlation_id',
      'root_correlation_id',
    ],
    indexes: [
      'idx_routing_parent_correlation_id',
      'idx_routing_root_correlation_id',
      'idx_guardrail_parent_correlation_id',
      'idx_guardrail_root_correlation_id',
      'idx_cb_parent_correlation_id',
      'idx_cb_root_correlation_id',
      'idx_anomaly_parent_correlation_id',
      'idx_anomaly_root_correlation_id',
      'idx_operator_parent_correlation_id',
      'idx_operator_root_correlation_id',
    ],
  },
  {
    version: '005',
    name: '005_add_idempotency_key_to_operator_actions',
    columns: ['idempotency_key'],
    indexes: ['idx_operator_idempotency_key'],
  },
  {
    version: '008',
    name: '008_add_cost_events',
    tables: ['cost_events'],
    indexes: [...TIMELINE_TABLES.cost_events.indexes],
  },
  {
    version: '009',
    name: '009_add_sla_events',
    tables: ['sla_events'],
    indexes: [...TIMELINE_TABLES.sla_events.indexes],
  },
  {
    version: '010',
    name: '010_add_error_propagation_events',
    tables: ['error_propagation_events'],
    indexes: [...TIMELINE_TABLES.error_propagation_events.indexes],
  },
  {
    version: '013',
    name: '013_add_audit_events',
    tables: ['audit_events'],
    indexes: [...TIMELINE_TABLES.audit_events.indexes],
  },
  {
    version: '014',
    name: '014_add_milestone_approval_flag',
    tables: ['approval_requests', 'milestone_events'],
    indexes: [
      ...TIMELINE_TABLES.approval_requests.indexes,
      ...TIMELINE_TABLES.milestone_events.indexes,
    ],
  },
]);

export function getTimelineMigrationPlan(currentVersion = '000') {
  const normalized = typeof currentVersion === 'string' ? currentVersion : String(currentVersion).padStart(3, '0');
  return TIMELINE_MIGRATIONS.filter((m) => m.version > normalized);
}

export function getTimelineTableDefinition(tableName) {
  return TIMELINE_TABLES[tableName] || null;
}

/**
 * Validate a single table schema against expected columns/indexes.
 *
 * @param {string} tableName
 * @param {string[]} actualColumns
 * @param {string[]} actualIndexes
 * @returns {{
 *   table: string,
 *   columns: string[],
 *   indexes: string[],
 *   missingColumns: string[],
 *   missingIndexes: string[],
 *   ready: boolean,
 * }}
 */
export function validateTimelineTableSchema(tableName, actualColumns = [], actualIndexes = []) {
  const def = getTimelineTableDefinition(tableName);
  if (!def) {
    return {
      table: tableName,
      columns: [],
      indexes: [],
      missingColumns: [],
      missingIndexes: [],
      ready: false,
    };
  }

  const columns = Array.isArray(actualColumns) ? actualColumns : [];
  const indexes = Array.isArray(actualIndexes) ? actualIndexes : [];
  const missingColumns = def.columns.filter((name) => !columns.includes(name));
  const missingIndexes = def.indexes.filter((name) => !indexes.includes(name));

  return {
    table: tableName,
    columns,
    indexes,
    missingColumns,
    missingIndexes,
    ready: missingColumns.length === 0 && missingIndexes.length === 0,
  };
}

/**
 * Validate the full timeline schema for all tables.
 *
 * @param {Object} actualSchema - { [tableName]: { columns: string[], indexes: string[] } }
 * @returns {{
 *   tables: Record<string, ReturnType<typeof validateTimelineTableSchema>>,
 *   ready: boolean,
 * }}
 */
export function validateTimelineSchema(actualSchema = {}) {
  const tables = {};
  let ready = true;

  for (const tableName of Object.keys(TIMELINE_TABLES)) {
    const entry = actualSchema[tableName] || {};
    const status = validateTimelineTableSchema(tableName, entry.columns || [], entry.indexes || []);
    tables[tableName] = status;
    if (!status.ready) {
      ready = false;
    }
  }

  return { tables, ready };
}

/**
 * Validate a timeline event against the unified schema.
 *
 * @param {Object} event - Candidate timeline event
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTimelineEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { valid: false, errors: ['event must be a non-null object'] };
  }

  // Check envelope required fields
  for (const field of ENVELOPE_REQUIRED) {
    if (event[field] === undefined || event[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }

  // Validate id is a non-empty string
  if (event.id !== undefined && event.id !== null) {
    if (typeof event.id !== 'string' || event.id.trim() === '') {
      errors.push('id must be a non-empty string');
    }
  }

  // Validate type is a known value
  if (event.type !== undefined && event.type !== null) {
    if (!VALID_EVENT_TYPES.has(event.type)) {
      errors.push(`type must be one of: ${[...VALID_EVENT_TYPES].join(', ')}; got "${event.type}"`);
    }
  }

  // Validate timestamp is ISO 8601
  if (event.timestamp !== undefined && event.timestamp !== null) {
    const d = new Date(event.timestamp);
    if (Number.isNaN(d.getTime())) {
      errors.push('timestamp must be a valid ISO 8601 date string');
    }
  }

  // Validate summary is a string
  if (event.summary !== undefined && event.summary !== null && typeof event.summary !== 'string') {
    errors.push('summary must be a string');
  }

  // Validate correlationKeys shape if present
  if (event.correlationKeys !== undefined && event.correlationKeys !== null) {
    if (typeof event.correlationKeys !== 'object' || Array.isArray(event.correlationKeys)) {
      errors.push('correlationKeys must be a plain object');
    }
  }

  // Validate per-type required data fields (only when type and data are both present)
  const knownType = event.type && VALID_EVENT_TYPES.has(event.type);
  if (knownType && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    const required = DATA_REQUIRED[event.type];
    if (required) {
      for (const field of required) {
        if (event.data[field] === undefined) {
          errors.push(`data.${field} is required for type "${event.type}"`);
        }
      }
    }
  }

  if (event.type === EVENT_TYPES.MILESTONE_APPROVAL && event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    if (event.data.status !== undefined && !MILESTONE_APPROVAL_STATUSES.includes(event.data.status)) {
      errors.push(`data.status must be one of: ${MILESTONE_APPROVAL_STATUSES.join(', ')}; got "${event.data.status}"`);
    }
    if (event.data.eventType !== undefined && !MILESTONE_EVENT_TYPES.includes(event.data.eventType)) {
      errors.push(`data.eventType must be one of: ${MILESTONE_EVENT_TYPES.join(', ')}; got "${event.data.eventType}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extract a normalized correlationKeys bag from a timeline event.
 * Merges keys from the envelope-level correlationKeys object with fallbacks
 * from common data fields (envelope takes precedence).
 *
 * @param {Object} event - A timeline event (after mapping or from DB query)
 * @returns {{ campaignId, taskId, dispatchId, traceId, agentId, provider }}
 */
export function extractCorrelationKeys(event) {
  const data = (event?.data && typeof event.data === 'object') ? event.data : {};
  const ck = (event?.correlationKeys && typeof event.correlationKeys === 'object' && !Array.isArray(event.correlationKeys))
    ? event.correlationKeys
    : {};

  // Fallback to snake_case fields from DB query results
  return {
    campaignId: ck.campaignId !== undefined ? ck.campaignId : (data.campaignId ?? event.campaign_id ?? null),
    taskId: ck.taskId !== undefined ? ck.taskId : (data.taskId ?? event.task_id ?? null),
    dispatchId: ck.dispatchId !== undefined ? ck.dispatchId : (data.dispatchId ?? event.dispatch_id ?? null),
    traceId: ck.traceId !== undefined ? ck.traceId : (data.traceId ?? event.trace_id ?? null),
    agentId: ck.agentId !== undefined ? ck.agentId : (data.agentId ?? data.selectedAgent ?? event.agent_id ?? null),
    provider: ck.provider !== undefined ? ck.provider : (data.provider ?? event.provider ?? null),
  };
}

export default {
  EVENT_TYPES,
  VALID_EVENT_TYPES,
  MILESTONE_APPROVAL_STATUSES,
  MILESTONE_EVENT_TYPES,
  CORRELATION_KEY_NAMES,
  TIMELINE_SCHEMA_VERSION,
  TIMELINE_MIGRATIONS_TABLE,
  TIMELINE_MIGRATIONS_COLUMNS,
  TIMELINE_TABLES,
  TIMELINE_MIGRATIONS,
  getTimelineMigrationPlan,
  getTimelineTableDefinition,
  validateTimelineTableSchema,
  validateTimelineSchema,
  validateTimelineEvent,
  extractCorrelationKeys,
};
