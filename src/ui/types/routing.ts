// src/ui/types/routing.ts

/**
 * Explains how routing weights were computed.
 */
export type SelectionReason =
  'provider_weight_override' |
  'insufficient_data_fallback' |
  'single_candidate' |
  'uniform_rates' |
  'confidence_adjusted' |
  'delta_proportional' |
  'weighted_selection';

/**
 * Per-weight reason emitted by computeRoutingWeights() in router.js.
 * These are distinct from top-level SelectionReason values.
 */
export type WeightReason =
  'insufficient_data_fallback' |
  'single_candidate' |
  'uniform_rates' |
  'delta_proportional';

/**
 * Agent considered for routing decision.
 */
export interface DispatchCandidate {
  agentId: string;
  provider: string;
  successRate: number | null;
  decayedRate: number | null;
}

/**
 * Constraint applied during candidate filtering.
 */
export interface DispatchConstraint {
  type: string;
  value: any;
  agentsRemoved: string[];
}

/**
 * Computed selection weight for each candidate.
 */
export interface RoutingWeight {
  id: string;
  weight: number;
  reason: SelectionReason;
  successRate: number | null;
  totalDispatches?: number;
}

/**
 * Complete routing decision record with all metadata.
 */
export interface DispatchDecision {
  id: string;
  timestamp: string; // ISO 8601
  traceId: string | null;
  taskCategory: string | null;
  campaignId: string | null;
  selectedAgent: string | null;
  selectionReason: string;
  outcome: 'success' | 'failure' | 'partial' | null;
  candidates: DispatchCandidate[];
  constraintsApplied: DispatchConstraint[];
  weights: RoutingWeight[];
  roll: number | null;
  secondary_selection?: any | null;
  inputs?: string | null;
}

/**
 * Response structure for /api/dispatch-log.
 */
export interface DispatchLogResponse {
  decisions: DispatchDecision[];
  total: number;
  offset: number;
  timestamp: string; // ISO 8601
}

/**
 * Per-agent, per-category routing weight statistics.
 */
export interface RoutingWeightStat {
  agent_id: string;
  task_category: string;
  provider: string | null;
  success_rate: number | null;
  total_dispatches: number;
  computed_weight: number;
  effective_weight: number;
  is_overridden: boolean;
  weight_source: 'overridden' | 'computed';
  weight_reason: WeightReason;
}

/**
 * Tracks which providers are using computed vs. overridden weights.
 */
export interface WeightSources {
  overridden_providers: string[];
  computed_providers: string[];
}

/**
 * Manual weight override metadata (optional).
 */
export interface ActiveOverride {
  weights: Record<string, number>;
  applied_at: string;
  applied_by: string;
  reason: string;
  recommendation_id: string;
}

/**
 * Response structure for /api/routing-weights.
 */
export interface RoutingWeightsResponse {
  stats: RoutingWeightStat[];
  timestamp: string; // ISO 8601
  floor_weight: number;
  sensitivity_threshold: number;
  weight_sources: WeightSources;
  active_override?: ActiveOverride;
}

/**
 * Generic API Error Interface
 */
export interface ApiError {
  message: string;
  statusCode?: number;
}

/**
 * Discriminated error types for typed error handling.
 */
export type ServiceErrorKind = 'network' | 'api' | 'abort' | 'parse' | 'unknown';

export interface ServiceError {
  kind: ServiceErrorKind;
  message: string;
  statusCode?: number;
}

/**
 * Generic async data state (mirrors routing-analytics.js loading/error/data pattern).
 * Idle: no fetch attempted yet.
 * Loading: fetch in progress.
 * Success: data available.
 * Error: fetch failed with a typed error.
 */
export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T; fetchedAt: number }
  | { status: 'error'; error: ServiceError; failedAt: number };

/**
 * === RATIONALE & TIMELINE CORRELATION TYPES ===
 * Defined for dashboard rationale display with full event correlation.
 */

/**
 * Guardrail outcome from timeline event.
 */
export interface GuardrailOutcome {
  timestamp: string; // ISO 8601
  agentId: string;
  outcome: 'pass' | 'block' | 'fail' | 'warn';
  ruleId: string;
  ruleName: string;
  score: number;
  detail: string;
}

/**
 * Guardrail evaluation context correlated to a dispatch.
 */
export interface GuardrailContext {
  dispatchId: string;
  evaluatedAt: string; // ISO 8601
  outcomes: GuardrailOutcome[];
  summary: {
    totalOutcomes: number;
    rulesEvaluated: string[];
    anyBlocked: boolean;
  };
}

/**
 * Circuit breaker transition correlated to a dispatch.
 */
export interface CircuitBreakerTransition {
  timestamp: string; // ISO 8601
  provider: string;
  previousState: string;
  newState: string;
  failureCount: number;
  triggerContext: Record<string, any> | null;
}

/**
 * Circuit breaker evaluation context correlated to a dispatch.
 */
export interface CircuitBreakerContext {
  dispatchId: string;
  transitions: CircuitBreakerTransition[];
  summary: {
    totalTransitions: number;
    providers: string[];
    anyOpen: boolean;
  };
}

/**
 * Per-dispatch routing rationale with correlated context.
 * Response shape for GET /api/campaigns/:campaignId/dispatches/:dispatchId/rationale
 */
export interface DispatchRationale {
  // Core rationale fields
  inputs: Record<string, any> | null;
  guardrailContext: GuardrailContext | null;
  circuitBreakerContext: CircuitBreakerContext | null;
  chosenRoute: DispatchCandidate | null;
  fallbacks: DispatchCandidate[];

  // Dashboard-specific enrichment (internal use, not exposed to UI)
  _dashboard?: {
    dispatchId: string;
    campaignId: string;
    timestamp: string; // ISO 8601
    traceId: string | null;
  };
}

/**
 * Rationale summary for timeline events (dashboard optimization).
 * Present only for dispatch_decision events in timeline responses.
 */
export interface RationaleSummary {
  selectedAgent: string;
  selectionReason: string;
  guardrailBlocked: boolean;
  circuitBreakerOpen: boolean;
  fallbackCount: number;
}

/**
 * Deep-link metadata for dashboard navigation.
 * Provides pre-built URLs for drill-down into related data.
 */
export interface DeepLinks {
  rationale: string;     // /api/campaigns/:campaignId/dispatches/:dispatchId/rationale
  decision: string;      // /api/dispatch-log/:id/decision
  causal: string;        // /api/timeline/causal/:eventId
  audit: string;         // /api/audit?correlationId=:id
}

/**
 * Correlation keys for timeline events.
 * Used for causal traversal and event grouping.
 */
export interface EventCorrelationKeys {
  campaignId: string | null;
  taskId: string | null;
  dispatchId: string | null;
  traceId: string | null;
  agentId: string | null;
  provider: string | null;
}

/**
 * Normalized timeline event with rationale summary and deep-links.
 * Response shape for GET /api/timeline and related endpoints.
 */
export interface TimelineEvent {
  id: string;
  type: string;
  timestamp: string; // ISO 8601
  summary: string;
  correlationKeys: EventCorrelationKeys;
  data: Record<string, any>;

  // Dashboard-specific enrichment (optional, prefixed with _)
  _rationaleSummary?: RationaleSummary;
  _deepLinks?: DeepLinks;
}

/**
 * Unified timeline response with pagination.
 * Response shape for GET /api/timeline, /api/campaigns/:id/timeline, /api/dispatches/:id/timeline
 */
export interface TimelineResponse {
  events: TimelineEvent[];
  total: number;
  total_count: number;
  next_cursor: string | null;
  offset: number;
  limit: number;
  timestamp: string; // ISO 8601, response generation time
}

/**
 * Causal graph traversal response.
 * Response shape for GET /api/timeline/causal/:eventId
 */
export interface CausalGraphResponse {
  rootEvent: TimelineEvent;
  children: TimelineEvent[];
  edges: Array<{ from: string; to: string; relationship: string }>;
  metadata: {
    eventId: string;
    generatedAt: string; // ISO 8601
    traversalDepth: number;
  };
}

/**
 * Audit entry for operator actions.
 * Response shape for GET /api/audit?correlationId=:id
 */
export interface AuditEntry {
  id: string;
  actionType: string;
  actorId: string;
  timestamp: string; // ISO 8601
  target: string;
  beforeState: Record<string, any> | null;
  afterState: Record<string, any> | null;
  correlationId: string;
}
