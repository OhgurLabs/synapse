import { createServer } from 'http';
import { readFileSync, writeFileSync, chmodSync, existsSync, createReadStream, statSync } from 'fs';
import { join, dirname, extname, basename, resolve, sep } from 'path';
import { execFile } from 'child_process';
import { createHash as _createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { performance } from 'perf_hooks';
import { createLogger } from '../logger.js';
import { computeRoutingWeights, ROUTING_MATRIX, validateSteerTarget } from '../router.js';
import {
  evaluateMergePolicy,
  MERGE_REASONS_ALLOWED_WITHOUT_FORCE,
  MERGE_REASONS_REQUIRING_FORCE,
} from './pr-merge-dispatcher.js';
import { registerPersonaHash, setAgentPaused, isAgentPaused, loadAgentsConfig as _loadAgentsConfig, getEffectiveRoles } from './agents.js';
// BYOH Phase 1+: descriptor registry for create-flow exposure.
import { DESCRIPTORS, getDescriptor, detectAllHarnesses, HARNESSES } from '../harnesses/registry.js';
import { scanHarnessConfigs } from '../harnesses/config-scan.js';
import { queryHarnessModels } from '../harnesses/model-query.js';
import { ONBOARDING_TEMPLATES } from './onboarding-templates.js';
import { detectConstraintConflict } from '../constraint-conflict.js';
import { validateConstraintInput } from '../campaigns.js';
import ConnectionRegistry from './registry.js';
import { restoreSnapshot } from '../snapshot-restore.js';
import { collectSnapshot, listSnapshots } from '../snapshots.js';
import { mergeCampaignBranch, rollbackLastMerge, commitPaths } from './git-branches.js';
import { createMcpServer } from './mcp-server.js';
import { aggregateHealthData, setWss } from './health-aggregator.js';
import { TRANSIENT_CATEGORIES, PERSISTENT_CATEGORIES, classifyError } from './error-classifier.js';
import { saveSettingsOverride } from './settings-overrides-store.js';
import { runValidation } from './agent-validator.js';
import { loadOpenApiSpec } from './openapi-spec.js';
import { VALID_EVENT_TYPES, extractCorrelationKeys } from './timeline-schema.js';
import { decodeCursor, encodeCursor } from './timeline-ingest.js';
import { buildCausalSubgraph } from './causal-graph-traversal.js';
import { computeProviderDeltas, generateRecommendations } from './routing-analytics.js';
import { generateMetricsText } from './metrics.js';
import { recordIntent, getPending } from './mock-control.js';
import { createPolicyEngine } from './policy.js';
import { AnalyticsSignalsStore } from './analytics-signals-store.js';
import ssrfConfigStore from '../ssrf-config-store.js';
import { loadAlertHistory } from './alert-history-store.js';
import { buildCampaignTraceTree, buildErrorChain } from './trace-builder.js';
import { TERMINAL_TASK_STATUSES } from '../tasks.js';
import { computeAgentMetricsForWindow, computeModelMetricsForWindow, computeReviewerAccuracyForWindow } from './analytics-signal-computer.js';
import { stateDbExists } from './state-db.js';
import {
  mapDispatchEvent,
  mapCbTransitionEvent,
  mapAnomalyAlertEvent,
  mapGuardrailEvent,
  mapOperatorActionEvent,
} from './timeline-event-mappers.js';
import { VersionConflictError } from './shared-state-store.js';
import { computeCampaignFunnelMetrics } from './campaign-funnel-metrics.js';
import { createExportQueryEngine } from './export-query-engine.js';
let ChaosMetricsStore;
try {
  ({ ChaosMetricsStore } = await import('../../test/chaos/chaos-metrics-store.js'));
} catch {
  ChaosMetricsStore = null;
}
import { createCSVExporter } from './exporters/csv-exporter.js';
import { createJSONExporter } from './exporters/json-exporter.js';
import { createPDFExporter } from './exporters/pdf-exporter.js';
import { createExportJobQueue } from './export-job-queue.js';
import { TemplateRegistry, initializeReportTemplates, TemplateValidationError } from './report-templates.js';
import { generatePdfReport } from './report-generator.js';
import { createWriteStream } from 'fs';
import { TemporalCorrelationDetector } from './pattern-detector.js';
import { availableClasses, rosterAllowsAgentAnyRole } from '../roster.js';
import { isValidTimezone } from '../scheduler.js';
import { listTimezones } from '../timezones.js';
import {
  AgentTemplateStore,
  AgentTemplateValidationError,
} from './agent-template-store.js';
const log = createLogger('api');

const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Central authorization policy for state-changing API routes.
 *
 * Route handlers may still perform more specific authorization checks, but a
 * new mutation cannot accidentally become available to read-only API keys just
 * because its author forgot to add one. MCP is excluded because its HTTP
 * endpoint performs protocol-specific authentication and authorization.
 */
export function mutationActionForRoute(method, path) {
  if (!MUTATING_HTTP_METHODS.has(method) || path === '/mcp') return null;
  if (/^\/api\/projects\/[^/]+\/campaigns\/[^/]+\/pause$/.test(path)) {
    return 'campaign_pause';
  }
  if (path === '/api/routing-recommendations') return 'routing_recommendation';
  return 'control_plane_mutation';
}

/** Explicit agent ids referenced by a roster input (legacy array or
 *  RosterSpec incl. role sub-lists) — for unknown-id validation. Classes are
 *  intentionally not validated: a class may match zero agents today and
 *  future agents later. */
function collectRosterAgentIds(v) {
  const ids = [];
  if (Array.isArray(v)) ids.push(...v);
  else if (v && typeof v === 'object') {
    if (Array.isArray(v.agents)) ids.push(...v.agents);
    for (const sub of Object.values(v.roles || {})) {
      if (Array.isArray(sub?.agents)) ids.push(...sub.agents);
    }
  }
  return ids.filter(x => typeof x === 'string');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Steering event types for WebSocket propagation
const STEERING_EVENT_TYPES = {
  replay: 'steering:replay',
  weight_override: 'steering:weight_override',
  circuit_breaker_hold: 'steering:circuit_breaker_hold',
  cb_reset: 'steering:cb_reset',
  alert_ack: 'steering:alert_ack',
};

/**
 * Transform a raw timeline-store event row into a unified envelope format.
 * Adapts snake_case database row format to the format expected by timeline-event-mappers.
 * @param {Object} row - Raw event row from TimelineStore.query()
 * @returns {{ id: string, type: string, timestamp: string, summary: string, correlationKeys: Object, data: Object }}
 */
function transformEventToEnvelope(row) {
  if (!row) return null;

  // Create an adapted row that merges DB columns with camelCase aliases for mapper compatibility
  // Timeline-store returns snake_case (event_ts, campaign_id, etc.) but mappers expect camelCase
  const adaptedRow = {
    ...row,
    // Map common correlation fields to camelCase for mapper compatibility
    timestamp: row.event_ts || row.timestamp,
    campaignId: row.campaign_id,
    dispatchId: row.dispatch_id,
    traceId: row.trace_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    // Type-specific field mapping for routing_events
    selectedAgent: row.selected_agent,
    selectionReason: row.selection_reason,
    taskCategory: row.data?.task_category || row.data?.taskCategory,
    // Type-specific field mapping for circuit_breaker_events
    previousState: row.previous_state,
    newState: row.new_state,
    failureCount: row.failure_count,
    // Type-specific field mapping for guardrail_events
    outcome: row.outcome,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    // Type-specific field mapping for anomaly_events
    severity: row.severity,
    anomalyType: row.anomaly_type,
    detail: row.detail,
    // Type-specific field mapping for operator_action_events
    actionType: row.action_type,
    operatorId: row.operator_id,
    sourceDispatchId: row.source_dispatch_id,
    targetDispatchId: row.target_dispatch_id,
    targetParams: row.target_params,
    status: row.status,
    // Pass through the parsed data blob (already parsed by timeline-store _formatEvent)
    data: row.data || {},
  };

  // Route to appropriate mapper based on event type
  try {
    switch (row.type) {
      case 'dispatch':
        return mapDispatchEvent(adaptedRow);

      case 'circuit_breaker':
        return mapCbTransitionEvent(adaptedRow);

      case 'anomaly_alert':
        return mapAnomalyAlertEvent(adaptedRow);

      case 'guardrail_outcome':
        return mapGuardrailEvent(adaptedRow);

      case 'operator_action':
      case 'operator_replay':
      case 'operator_steer':
        return mapOperatorActionEvent(adaptedRow);

      // Fallback for event types not yet supported by timeline-event-mappers
      // (review_rejection, routing_proposal, cost_dispatch)
      default: {
        const timestamp = row.event_ts || new Date().toISOString();
        return {
          id: row.id || `${row.type}-${timestamp}`,
          type: row.type,
          timestamp,
          summary: `${row.type}: ${row.agent_id || 'system'}`,
          correlationKeys: {
            campaignId: row.campaign_id || null,
            taskId: row.task_id || null,
            dispatchId: row.dispatch_id || null,
            traceId: row.trace_id || null,
            agentId: row.agent_id || null,
            provider: row.provider || null,
          },
          data: {
            ...row.data,
            // Include any type-specific fields from the row
            ...(row.task_id && { taskId: row.task_id }),
            ...(row.reviewer_id && { reviewerId: row.reviewer_id }),
            ...(row.cycle_number !== undefined && { cycleNumber: row.cycle_number }),
            ...(row.findings_count !== undefined && { findingsCount: row.findings_count }),
            ...(row.rework_status && { reworkStatus: row.rework_status }),
            ...(row.verdict && { verdict: row.verdict }),
            ...(row.proposal_id && { proposalId: row.proposal_id }),
            ...(row.source_type && { sourceType: row.source_type }),
            ...(row.state && { state: row.state }),
            ...(row.model && { model: row.model }),
            ...(row.input_tokens !== undefined && { inputTokens: row.input_tokens }),
            ...(row.output_tokens !== undefined && { outputTokens: row.output_tokens }),
            ...(row.cost_usd !== undefined && { costUsd: row.cost_usd }),
          },
        };
      }
    }
  } catch (err) {
    log.warn('Failed to transform event to envelope', { type: row.type, error: err.message });
    // Return a minimal envelope on error
    return {
      id: row.id || `event-${Date.now()}`,
      type: row.type || 'unknown',
      timestamp: row.event_ts || new Date().toISOString(),
      summary: `Event: ${row.type || 'unknown'}`,
      correlationKeys: {
        campaignId: row.campaign_id || null,
        taskId: row.task_id || null,
        dispatchId: row.dispatch_id || null,
        traceId: row.trace_id || null,
        agentId: row.agent_id || null,
        provider: row.provider || null,
      },
      data: row.data || row,
    };
  }
}


async function computeReviewerAccuracyAcrossProjects(stateManager, windowStart, windowEnd, reviewerId = null) {
  let projects = [];
  try {
    projects = typeof stateManager?.listProjects === 'function' ? stateManager.listProjects() : [];
  } catch (err) {
    log.warn('Failed to list projects for reviewer accuracy computation', { error: err.message });
    projects = [];
  }
  const merged = new Map();

  for (const project of projects) {
    const projectId = project?.id || null;
    const projectDir = project?.projectDir || (projectId ? stateManager?.getProject?.(projectId)?.projectDir : null);
    if (!projectDir || !stateDbExists(projectDir)) continue;

    const projectAccuracy = await computeReviewerAccuracyForWindow(
      projectDir,
      windowStart,
      windowEnd,
      reviewerId ? { reviewerId } : {}
    );

    for (const row of Object.values(projectAccuracy)) {
      const reviewerKey = row.reviewer_id;
      const existing = merged.get(reviewerKey) || {
        reviewer_id: reviewerKey,
        total_reviews: 0,
        overturned_count: 0,
      };
      existing.total_reviews += row.total_reviews || 0;
      existing.overturned_count += row.overturned_count || 0;
      merged.set(reviewerKey, existing);
    }
  }

  const reviewers = Array.from(merged.values()).map((row) => {
    const correctReviews = row.total_reviews - row.overturned_count;
    const accuracyPercentage = row.total_reviews > 0
      ? +(correctReviews / row.total_reviews * 100).toFixed(2)
      : 0;
    return {
      ...row,
      correct_reviews: correctReviews,
      accuracy_percentage: accuracyPercentage,
      window_start: windowStart,
      window_end: windowEnd,
      computed_at: new Date().toISOString(),
    };
  }).sort((a, b) => {
    const countDiff = b.total_reviews - a.total_reviews;
    if (countDiff !== 0) return countDiff;
    return String(a.reviewer_id).localeCompare(String(b.reviewer_id));
  });

  const totalReviews = reviewers.reduce((sum, row) => sum + row.total_reviews, 0);
  const totalOverturned = reviewers.reduce((sum, row) => sum + row.overturned_count, 0);
  const teamWideAccuracy = totalReviews > 0
    ? +(((totalReviews - totalOverturned) / totalReviews) * 100).toFixed(2)
    : null;

  return { reviewers, teamWideAccuracy };
}

/**
 * Compute dispatch aggregates per task category and agent.
 * @param {Array} dispatches - Array of dispatch records
 * @returns {Object} Aggregates keyed by task category
 */
function computeDispatchAggregates(dispatches) {
  const aggregates = {};

  for (const dispatch of dispatches) {
    const category = dispatch.taskCategory || 'unknown';
    const agentId = dispatch.selectedAgent || 'unknown';
    const outcome = dispatch.outcome;

    if (!aggregates[category]) {
      aggregates[category] = {
        totalDispatches: 0,
        successes: 0,
        failures: 0,
        partials: 0,
        knownOutcomes: 0,
        agents: {},
      };
    }

    const catAgg = aggregates[category];
    catAgg.totalDispatches += 1;

    // Count known outcomes (success, failure, partial)
    if (outcome === 'success') {
      catAgg.successes += 1;
      catAgg.knownOutcomes += 1;
    } else if (outcome === 'failure') {
      catAgg.failures += 1;
      catAgg.knownOutcomes += 1;
    } else if (outcome === 'partial') {
      catAgg.partials += 1;
      catAgg.knownOutcomes += 1;
    }

    // Per-agent aggregates
    if (!catAgg.agents[agentId]) {
      catAgg.agents[agentId] = {
        totalDispatches: 0,
        successes: 0,
        failures: 0,
        partials: 0,
        knownOutcomes: 0,
      };
    }

    const agentAgg = catAgg.agents[agentId];
    agentAgg.totalDispatches += 1;

    if (outcome === 'success') {
      agentAgg.successes += 1;
      agentAgg.knownOutcomes += 1;
    } else if (outcome === 'failure') {
      agentAgg.failures += 1;
      agentAgg.knownOutcomes += 1;
    } else if (outcome === 'partial') {
      agentAgg.partials += 1;
      agentAgg.knownOutcomes += 1;
    }
  }

  // Compute success rates
  for (const category of Object.keys(aggregates)) {
    const catAgg = aggregates[category];
    
    // Overall category success rate
    catAgg.successRate = catAgg.knownOutcomes > 0 
      ? catAgg.successes / catAgg.knownOutcomes 
      : null;

    // Per-agent success rates
    for (const agentId of Object.keys(catAgg.agents)) {
      const agentAgg = catAgg.agents[agentId];
      agentAgg.successRate = agentAgg.knownOutcomes > 0
        ? agentAgg.successes / agentAgg.knownOutcomes
        : null;
    }
  }

  return aggregates;
}


/**
 * Compute attribution metrics for a single weight override action.
 * Splits dispatches into pre/post windows around the override timestamp,
 * computes success rate deltas with per-agent breakdowns, and determines confidence.
 * @param {Object} dispatchLog - Dispatch log instance with query method
 * @param {Object} performanceStore - Performance store (not directly used but passed for API consistency)
 * @param {string} overrideTimestamp - ISO timestamp of the weight override action
 * @param {string} category - Task category to analyze
 * @param {number} windowMs - Total window size in milliseconds (default 86400000)
 * @param {number} minSampleSize - Minimum dispatches required for high confidence (default 10)
 * @returns {Object} Attribution metrics with preMetrics, postMetrics, delta, confidence, and agents
 */
function computeAttributionMetrics(dispatchLog, performanceStore, overrideTimestamp, category, windowMs = 86400000, minSampleSize = 10) {
  if (!dispatchLog || typeof dispatchLog.query !== 'function') {
    return null;
  }

  const overrideTime = new Date(overrideTimestamp).getTime();
  const preWindowStart = overrideTime - windowMs;
  const postWindowEnd = overrideTime + windowMs;

  const allDispatches = dispatchLog.query({ limit: 10000 }).decisions || [];
  
  const preDispatches = [];
  const postDispatches = [];

  for (const dispatch of allDispatches) {
    if (dispatch.taskCategory !== category) {
      continue;
    }

    const dispatchTime = new Date(dispatch.timestamp).getTime();

    if (dispatchTime < overrideTime && dispatchTime >= preWindowStart) {
      preDispatches.push(dispatch);
    } else if (dispatchTime >= overrideTime && dispatchTime < postWindowEnd) {
      postDispatches.push(dispatch);
    }
  }

  const preAggregates = computeDispatchAggregates(preDispatches);
  const postAggregates = computeDispatchAggregates(postDispatches);

  const preCat = preAggregates?.[category] || { totalDispatches: 0, successes: 0, knownOutcomes: 0, agents: {} };
  const postCat = postAggregates?.[category] || { totalDispatches: 0, successes: 0, knownOutcomes: 0, agents: {} };

  const preSuccessRate = preCat.knownOutcomes > 0 ? preCat.successes / preCat.knownOutcomes : 0;
  const postSuccessRate = postCat.knownOutcomes > 0 ? postCat.successes / postCat.knownOutcomes : 0;
  const delta = postSuccessRate - preSuccessRate;

  const confidence = (preCat.totalDispatches >= minSampleSize && postCat.totalDispatches >= minSampleSize) ? 'high' : 'low';

  const agents = [];
  const preAgents = preCat.agents || {};
  const postAgents = postCat.agents || {};
  const allAgentIds = new Set([...Object.keys(preAgents), ...Object.keys(postAgents)]);

  for (const agentId of allAgentIds) {
    const preAgent = preAgents[agentId] || { totalDispatches: 0, successes: 0, knownOutcomes: 0 };
    const postAgent = postAgents[agentId] || { totalDispatches: 0, successes: 0, knownOutcomes: 0 };

    const preAgentSuccessRate = preAgent.knownOutcomes > 0 ? preAgent.successes / preAgent.knownOutcomes : 0;
    const postAgentSuccessRate = postAgent.knownOutcomes > 0 ? postAgent.successes / postAgent.knownOutcomes : 0;
    const agentDelta = postAgentSuccessRate - preAgentSuccessRate;

    agents.push({
      agentId,
      preMetrics: {
        successRate: preAgentSuccessRate,
        dispatches: preAgent.totalDispatches,
      },
      postMetrics: {
        successRate: postAgentSuccessRate,
        dispatches: postAgent.totalDispatches,
      },
      delta: agentDelta,
    });
  }

  return {
    preMetrics: {
      successRate: preSuccessRate,
      dispatches: preCat.totalDispatches,
      successes: preCat.successes,
    },
    postMetrics: {
      successRate: postSuccessRate,
      dispatches: postCat.totalDispatches,
      successes: postCat.successes,
    },
    delta,
    confidence,
    agents,
  };
}

/**
 * Compute deltas between pre and post aggregates.
 * @param {Object} preAggregates - Pre-change aggregates
 * @param {Object} postAggregates - Post-change aggregates
 * @returns {Object} Deltas keyed by task category
 */
function computeDeltas(preAggregates, postAggregates) {
  const deltas = {};

  // Get all categories from both windows
  const allCategories = new Set([
    ...Object.keys(preAggregates || {}),
    ...Object.keys(postAggregates || {}),
  ]);

  for (const category of allCategories) {
    const preCat = preAggregates?.[category] || { agents: {} };
    const postCat = postAggregates?.[category] || { agents: {} };

    deltas[category] = {
      totalDispatchesDelta: (postCat.totalDispatches || 0) - (preCat.totalDispatches || 0),
      agents: {},
    };

    // Get all agents from both windows
    const allAgents = new Set([
      ...Object.keys(preCat.agents || {}),
      ...Object.keys(postCat.agents || {}),
    ]);

    for (const agentId of allAgents) {
      const preAgent = preCat.agents?.[agentId] || { successRate: null, totalDispatches: 0 };
      const postAgent = postCat.agents?.[agentId] || { successRate: null, totalDispatches: 0 };

      const preRate = preAgent.successRate ?? 0;
      const postRate = postAgent.successRate ?? 0;
      const delta = postRate - preRate;

      deltas[category].agents[agentId] = {
        successRateDelta: delta,
        successRateChange: delta > 0.01 ? 'improved' : delta < -0.01 ? 'degraded' : 'unchanged',
        preSuccessRate: preRate,
        postSuccessRate: postRate,
        preDispatches: preAgent.totalDispatches || 0,
        postDispatches: postAgent.totalDispatches || 0,
      };
    }
  }

  return deltas;
}

/**
 * API Contract: Per-Dispatch Rationale & Timeline Correlation
 *
 * This document defines the response shapes for rationale and timeline endpoints
 * used by the dashboard for per-dispatch rationale display with full event correlation.
 *
 * === ENDPOINTS ===
 *
 * 1. GET /api/campaigns/:campaignId/dispatches/:dispatchId/rationale
 *    Returns routing rationale with correlated guardrail and circuit-breaker context.
 *
 * 2. GET /api/dispatch-log/:id/decision
 *    Returns the raw dispatch decision record (existing endpoint, backward compatible).
 *
 * 3. GET /api/timeline?dispatchId=:dispatchId
 *    Returns correlated events for a dispatch with rationale summary and deep-link metadata.
 *
 * 4. GET /api/campaigns/:campaignId/timeline
 *    Returns campaign-scoped timeline with rationale summaries and deep-link metadata.
 *
 * === RESPONSE SHAPES ===
 *
 * --- Rationale Response (GET /api/campaigns/:campaignId/dispatches/:dispatchId/rationale) ---
 *
 * {
 *   // Core rationale fields (from dispatch-log)
 *   inputs: Object | null,           // Original task inputs that triggered dispatch
 *   guardrailContext: Object | null, // Guardrail evaluation context (correlated from timeline)
 *   chosenRoute: Object | null,      // Selected agent + candidate metadata
 *   fallbacks: Array<Object>,        // Alternative candidates not selected
 *
 *   // NEW: Dashboard-specific enrichment
 *   _dashboard: {                     // Internal metadata (not exposed to UI, for backend use)
 *     dispatchId: string,             // Unique dispatch identifier
 *     campaignId: string,             // Campaign identifier
 *     timestamp: string,              // ISO 8601 timestamp of dispatch decision
 *     traceId: string | null,         // Jaeger trace ID for distributed tracing
 *   }
 * }
 *
 * --- Guardrail Context Object ---
 *
 * {
 *   dispatchId: string,
 *   evaluatedAt: string,              // ISO 8601 timestamp
 *   outcomes: Array<{
 *     timestamp: string,              // ISO 8601
 *     agentId: string,
 *     outcome: 'pass' | 'block' | 'fail' | 'warn',
 *     ruleId: string,
 *     ruleName: string,
 *     score: number,
 *     detail: string
 *   }>,
 *   summary: {
 *     totalOutcomes: number,
 *     rulesEvaluated: Array<string>,
 *     anyBlocked: boolean
 *   }
 * }
 *
 * --- Chosen Route Object ---
 *
 * {
 *   agentId: string,
 *   provider: string,
 *   successRate: number | null,
 *   decayedRate: number | null,
 *   ... (rest of candidate metadata)
 * }
 *
 * --- Fallbacks Array ---
 *
 * Array of candidate objects (same shape as chosenRoute) representing
 * alternative agents that were considered but not selected.
 *
 * === TIMELINE RESPONSE SHAPES ===
 *
 * --- Unified Timeline Response (GET /api/timeline) ---
 *
 * {
 *   events: Array<{
 *     id: string,                     // Unique event identifier
 *     type: string,                   // Event type (dispatch, circuit_breaker, etc.)
 *     timestamp: string,              // ISO 8601
 *     summary: string,                // Human-readable summary
 *     correlationKeys: {              // Normalized correlation keys
 *       campaignId: string | null,
 *       taskId: string | null,
 *       dispatchId: string | null,
 *       traceId: string | null,
 *       agentId: string | null,
 *       provider: string | null
 *     },
 *     data: Object,                   // Event-specific payload
 *
 *     // NEW: Rationale summary for dispatch_decision events
 *     _rationaleSummary?: {           // Present only for dispatch_decision events
 *       selectedAgent: string,
 *       selectionReason: string,
 *       guardrailBlocked: boolean,
 *       fallbackCount: number
 *     },
 *
 *     // NEW: Deep-link metadata for dashboard navigation
 *     _deepLinks?: {                  // API endpoints for drill-down
 *       rationale: string,            // /api/campaigns/:campaignId/dispatches/:dispatchId/rationale
 *       decision: string,             // /api/dispatch-log/:id/decision
 *       causal: string,               // /api/timeline/causal/:eventId
 *       audit: string                 // /api/audit?correlationId=:id
 *     }
 *   }>,
 *   total: number,
 *   total_count: number,
 *   next_cursor: string | null,
 *   offset: number,
 *   limit: number,
 *   timestamp: string                 // ISO 8601, response generation time
 * }
 *
 * === CORRELATION KEYS ===
 *
 * All timeline events MUST include correlationKeys with at least:
 * - campaignId: Links event to a campaign
 * - dispatchId: Links event to a dispatch decision (for dispatch-related events)
 * - traceId: Links to distributed tracing (Jaeger)
 * - agentId: Links to the agent involved
 * - provider: Links to the provider involved
 *
 * These keys enable causal traversal and event grouping in the timeline UI.
 *
 * === DEEP-LINK METADATA ===
 *
 * The _deepLinks field provides pre-built URLs for dashboard navigation:
 * - rationale: Direct link to full routing rationale
 * - decision: Direct link to raw dispatch decision
 * - causal: Direct link to causal graph for the event
 * - audit: Direct link to operator actions affecting this event
 *
 * Format: Relative paths that can be appended to the API base URL.
 *
 * === BACKWARD COMPATIBILITY ===
 *
 * - Existing UI consumers that don't use _rationaleSummary or _deepLinks
 *   will continue to work unchanged.
 * - The _dashboard field is internal-only and should not be exposed to UI.
 * - All new fields are optional and prefixed with underscore to indicate
 *   internal/dashboard-specific usage.
 *
 * === IMPLEMENTATION NOTES ===
 *
 * 1. Rationale aggregation happens in dispatch-log.js via _transformToRationale()
 *    or getDispatchRationale() methods.
 *
 * 2. Timeline enrichment happens in timeline-event-mappers.js via map* functions.
 *
 * 3. Deep-link URLs should be constructed relative to the API base path
 *    to support deployment in subpaths.
 *
 * 4. Guardrail context lookup uses timelineStore.query() with dispatchId filter.
 *
 * 5. Circuit breaker events are correlated via provider and dispatchId keys.
 */

export const clientSubs = new WeakMap(); // ws → { project, channel, userId }
export const thinkingAgents = new Set(); // "projectId#channelId#agentName"
let wss = null;
let connectionRegistry = null;
const disconnectTimers = new Map(); // userId -> timeout
const validationLocks = new Map(); // agentId -> Promise (prevents concurrent validations)
const DISCONNECT_GRACE_MS = 60_000;
let subsystemsReady = false;
export function getWss() { return wss; }
export function setSubsystemsReady(value) { subsystemsReady = value; }
export function getSubsystemsReady() { return subsystemsReady; }

// ─── SSE Operator Stream ──────────────────────────────────────────
/**
 * SSE connection registry for /api/operator/stream
 * Tracks active SSE clients, their Last-Event-ID state, and handlers
 */
export class SseConnectionRegistry {
  constructor() {
    this.clients = new Map(); // socket → { id, lastEventId, handlers: Set }
    this.eventIdSequence = 0;
    this.lock = Symbol('sse-lock');
  }

  /**
   * Register a new SSE client connection
   * @param {import('http').ServerResponse} socket - The HTTP response socket
   * @param {string} userId - Optional user ID for filtering
   * @returns {string} The client ID
   */
  registerClient(socket, userId = null) {
    const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const client = {
      id: clientId,
      socket,
      userId,
      lastEventId: '0',
      handlers: new Set(),
      registeredAt: new Date().toISOString(),
    };
    this.clients.set(socket, client);
    log.debug('SSE client registered', { clientId, userId });
    return clientId;
  }

  /**
   * Unregister a client connection
   * @param {import('http').ServerResponse} socket - The HTTP response socket
   */
  unregisterClient(socket) {
    const client = this.clients.get(socket);
    if (client) {
      log.debug('SSE client unregistered', { clientId: client.id, userId: client.userId });
      this.clients.delete(socket);
    }
  }

  /**
   * Get client by socket
   * @param {import('http').ServerResponse} socket - The HTTP response socket
   * @returns {Object|null} Client object or null
   */
  getClient(socket) {
    return this.clients.get(socket) || null;
  }

  /**
   * Get all active clients
   * @returns {Array} Array of client objects
   */
  getAllClients() {
    return Array.from(this.clients.values());
  }

  /**
   * Get client count
   * @returns {number} Number of active SSE clients
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Get stats for monitoring
   * @returns {Object} Stats object
   */
  getStats() {
    return {
      clientCount: this.clients.size,
      totalEvents: this.eventIdSequence,
      lastEventId: this.eventIdSequence.toString(),
    };
  }

  /**
   * Increment and get next event ID
   * @returns {string} Next event ID
   */
  nextEventId() {
    this.eventIdSequence++;
    return this.eventIdSequence.toString();
  }

  /**
   * Find events to replay for a reconnecting client
   * @param {string} lastEventId - The client's last received event ID
   * @param {Object} timelineStore - Timeline store instance
   * @returns {Array} Array of events to replay
   */
  async getEventsForReplay(lastEventId, timelineStore) {
    if (!timelineStore || typeof timelineStore.query !== 'function') {
      return [];
    }
    try {
      const eventIdNum = parseInt(lastEventId, 10) || 0;
      // Query events with ID greater than the last received event
      // Timeline store uses timestamp-based IDs, so we query by time window
      const fromTime = new Date(eventIdNum * 1000).toISOString();
      const events = timelineStore.query({ 
        limit: 100,
        startTime: fromTime,
      });
      return events?.events || [];
    } catch (err) {
      log.warn('Failed to replay events for SSE client', { lastEventId, error: err.message });
      return [];
    }
  }

  /**
   * Broadcast an event to all registered SSE clients
   * @param {Object} event - Event object with type and data
   * @param {string} event.type - Event type (agent_state, task_update, audit_event, dispatch_decision)
   * @param {Object} event.data - Event payload
   * @param {string} [event.userId] - Optional user ID filter
   */
  broadcast(event) {
    const { type, data, userId } = event;
    const eventId = this.nextEventId();
    const timestamp = new Date().toISOString();
    
    // Format SSE message
    const sseData = {
      id: eventId,
      type,
      timestamp,
      data,
    };

    const message = `event: ${type}\ndata: ${JSON.stringify(sseData)}\n\n`;
    
    for (const [socket, client] of this.clients) {
      // Filter by userId if specified
      if (userId && client.userId !== userId) {
        continue;
      }
      
      try {
        if (socket.writable) {
          socket.write(message);
        }
      } catch (err) {
        log.warn('Failed to write SSE event to client', { 
          clientId: client.id, 
          eventType: type, 
          error: err.message 
        });
      }
    }

    log.debug('SSE event broadcast', { eventId, type, recipientCount: this.clients.size });
  }

  /**
   * Send keepalive ping to prevent proxy disconnection
   */
  sendKeepalive() {
    const keepalive = ': keepalive\n\n';
    for (const [socket] of this.clients) {
      try {
        if (socket.writable) {
          socket.write(keepalive);
        }
      } catch (err) {
        log.debug('Keepalive write failed', { error: err.message });
      }
    }
  }

  /**
   * Cleanup closed connections
   */
  cleanup() {
    const socketsToRemove = [];
    for (const [socket] of this.clients) {
      if (!socket.writable || socket.destroyed) {
        socketsToRemove.push(socket);
      }
    }
    for (const socket of socketsToRemove) {
      this.unregisterClient(socket);
    }
    if (socketsToRemove.length > 0) {
      log.debug('SSE cleanup', { removed: socketsToRemove.length });
    }
  }
}

// Global SSE registry instance
export const sseRegistry = new SseConnectionRegistry();

/**
 * Format an event for SSE transmission
 * @param {Object} event - Event object
 * @returns {string} Formatted SSE message
 */
function formatSseEvent(event) {
  const eventId = sseRegistry.nextEventId();
  const sseData = {
    id: eventId,
    type: event.type,
    timestamp: event.timestamp || new Date().toISOString(),
    data: event.data,
  };
  return `event: ${event.type}\ndata: ${JSON.stringify(sseData)}\n\n`;
}

/**
 * Transform timeline store row into SSE-compatible event
 * @param {Object} row - Timeline store row
 * @returns {Object} SSE event
 */
function transformTimelineEventToSse(row) {
  const envelope = transformEventToEnvelope(row);
  if (!envelope) return null;

  return {
    type: 'audit_event',
    data: {
      ...envelope,
      source: 'timeline',
    },
  };
}

/**
 * Transform agent health data into SSE event
 * @param {Object} healthData - Health aggregator data
 * @returns {Object} SSE event
 */
function transformHealthDataToSse(healthData) {
  return {
    type: 'agent_state',
    data: {
      agents: healthData.agents,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Transform circuit breaker state change into SSE event
 * @param {Object} cbData - Circuit breaker state data
 * @returns {Object} SSE event
 */
function transformCircuitBreakerEventToSse(cbData) {
  return {
    type: 'circuit_breaker',
    data: {
      agentId: cbData.agentId || cbData.provider || cbData.agent || 'unknown',
      previousState: cbData.previousState || cbData.oldState || 'closed',
      newState: cbData.newState || cbData.state || 'closed',
      reason: cbData.reason || cbData.cause || null,
      failureCount: cbData.failureCount || cbData.failure_count || 0,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Transform rate limit event into SSE event
 * @param {Object} rateLimitData - Rate limit data
 * @returns {Object} SSE event
 */
function transformRateLimitEventToSse(rateLimitData) {
  return {
    type: 'rate_limited',
    data: {
      agentId: rateLimitData.agentId || rateLimitData.agent || 'unknown',
      provider: rateLimitData.provider || null,
      until: rateLimitData.until || rateLimitData.cooldownUntil || null,
      reason: rateLimitData.reason || 'rate_limit',
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Transform dispatch decision into SSE event
 * @param {Object} decision - Dispatch decision data
 * @returns {Object} SSE event
 */
function transformDispatchDecisionToSse(decision) {
  return {
    type: 'dispatch_decision',
    data: {
      ...decision,
      timestamp: decision.timestamp || new Date().toISOString(),
    },
  };
}

/**
 * Transform task update into SSE event
 * @param {Object} taskUpdate - Task update data
 * @returns {Object} SSE event
 */
function transformTaskUpdateToSse(taskUpdate) {
  return {
    type: 'task_update',
    data: {
      ...taskUpdate,
      timestamp: taskUpdate.timestamp || new Date().toISOString(),
    },
  };
}

export function getConnectedUserCount() {
  if (connectionRegistry) return connectionRegistry.getStats().userCount;
  if (!wss) return 0;
  const users = new Set();
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const sub = clientSubs.get(client);
    if (sub?.userId) users.add(sub.userId);
  }
  return users.size;
}

export function broadcast(msg, options = {}) {
  if (!wss) return;
  const userId = options?.userId || null;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (userId) {
      const sub = clientSubs.get(client);
      if (!sub || sub.userId !== userId) continue;
    }
    client.send(data);
  }
}

export function broadcastToChannel(projectId, channelId, msg, options = {}) {
  if (!wss) return;
  const userId = typeof options === 'string' ? options : (options?.userId || null);
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const sub = clientSubs.get(client);
    if (sub && sub.project === projectId && sub.channel === channelId && (!userId || sub.userId === userId)) {
      client.send(data);
    }
  }
}

export function sendThinkingState(ws, projectId, channelId) {
  for (const key of thinkingAgents) {
    const [proj, chan, agent] = key.split('#');
    if (proj === projectId && chan === channelId) {
      ws.send(JSON.stringify({ type: 'status', speaker: agent, status: 'thinking' }));
    }
  }
}

export function emitConstraintBatched(projectId, campaignId, constraint, reason, expectedApplicationTime) {
  broadcast({
    type: 'constraint_batched',
    projectId,
    campaignId,
    constraint,
    batchReason: reason,
    expectedApplicationTime,
  });
}

export function emitConstraintApplied(projectId, campaignId, constraint) {
  broadcast({
    type: 'constraint_applied',
    projectId,
    campaignId,
    constraint,
    appliedAt: new Date().toISOString(),
  });
}

// Helpers to reduce route handler boilerplate
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const DEFAULT_PUBLIC_ERRORS = Object.freeze({
  400: 'Request could not be completed',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Resource not found',
  409: 'Request conflict',
  422: 'Invalid request',
  429: 'Too many requests',
  501: 'Operation not implemented',
  502: 'Upstream service error',
  503: 'Service unavailable',
  504: 'Upstream service timed out',
});

/**
 * Log the operational error while returning a fixed, non-sensitive message.
 * Callers may choose a route-specific public message, but must never pass an
 * exception message as that value.
 */
function respondApiError(res, err, {
  status = 500,
  message = DEFAULT_PUBLIC_ERRORS[status] || 'Internal server error',
  context = {},
  response = {},
} = {}) {
  const logContext = {
    ...context,
    status,
    error: err?.message || String(err),
    code: err?.code,
  };
  if (status >= 500) log.error('API request failed', logContext);
  else log.warn('API request rejected', logContext);
  const defaultMessage = DEFAULT_PUBLIC_ERRORS[status] || 'Internal server error';
  const safeMessage = err?.message && String(message).includes(err.message)
    ? defaultMessage
    : message;
  json(res, { ...response, error: safeMessage }, status);
}

function toPublicClassifiedError(classified) {
  return {
    category: classified?.category || 'unknown',
    message: 'Agent dispatch failed',
    suggestedFix: 'Review the orchestrator logs for operational details.',
  };
}

function toPublicRegistryError(error) {
  return {
    id: error.id,
    category: error.category,
    agentId: error.agentId,
    timestamp: error.timestamp,
    message: 'Agent operation failed',
    suggestedFix: 'Review the orchestrator logs for operational details.',
  };
}

export function applySecurityHeaders(res, nonce, secure = false) {
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// Nested fields that dominate a task's serialized size. On a real project these
// were 95% of a 7 MB task-list response, while the list views that fetch it use
// only scalars like title and status. `?view=summary` drops them and returns
// counts instead; the per-task detail route still serves the full record.
const TASK_HEAVY_FIELDS = ['subtasks', 'gitBaseline', 'plan', 'reviewFindings'];

// Terminal states. 'completed' is not in TASK_TRANSITIONS but appears in older
// records and the UI still tests for it, so it is treated as finished too.
const TASK_FINISHED_STATUSES = new Set(['done', 'completed', 'cancelled']);

function summarizeTask(task) {
  const out = {};
  for (const [k, v] of Object.entries(task)) {
    if (!TASK_HEAVY_FIELDS.includes(k)) out[k] = v;
  }
  const subs = Array.isArray(task.subtasks) ? task.subtasks : [];
  out.subtaskCount = subs.length;
  out.subtasksDone = subs.filter(s => s && s.status === 'done').length;
  out.reviewFindingCount = Array.isArray(task.reviewFindings) ? task.reviewFindings.length : 0;
  return out;
}

function getAuditContext(req, payload) {
  const p = payload || {};
  return {
    source: req.headers['x-audit-source'] || p.source || null,
    reason: req.headers['x-audit-reason'] || p.reason || null,
    correlationId: req.headers['x-correlation-id'] || p.correlationId || null,
    traceId: req.headers['x-trace-id'] || p.traceId || null,
    dispatchId: req.headers['x-dispatch-id'] || p.dispatchId || null,
  };
}

// Cap request bodies so an unauthenticated client can't stream an unbounded
// payload into process memory (OOM DoS). On overflow the socket is destroyed
// and the promise resolves to '' — callers' existing JSON.parse try/catch
// turns that into a 400.
const MAX_BODY_BYTES = 1024 * 1024;

// Auth tokens are accepted as ?token= query params (dashboard bootstrap, WS,
// health) — any log line containing a raw URL would persist the master token
// in cleartext (and syslog-forwarder may ship it off-VLAN). Redact credential
// query params before logging.
export function redactUrlForLog(url) {
  return String(url).replace(/([?&](?:token|key|secret|credential|password|apikey|api_key)=)[^&#]*/gi, '$1[REDACTED]');
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let received = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = c => {
      received += c.length;
      if (received > MAX_BODY_BYTES) {
        finish(resolve, '');
        req.destroy();
        return;
      }
      body += c;
    };
    const onEnd = () => finish(resolve, body);
    const onError = err => finish(reject, err || new Error('request body stream failed'));
    const onAborted = () => finish(reject, new Error('request body stream aborted'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function handleBody(req, res, handler) {
  return readBody(req).then(handler).catch(err => {
    log.error('HTTP request handler failed', {
      method: req.method,
      url: redactUrlForLog(req.url),
      error: err?.message || String(err),
    });
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      json(res, { error: 'Internal server error' }, 500);
    }
  });
}

function broadcastAgents(agents) {
  // A notification must never fail the operation that triggered it.
  //
  // All seven call sites run AFTER the write has already been persisted and
  // BEFORE the 200 is sent, unguarded. So anything that threw in here -- a
  // websocket problem, or loadAgentsConfig failing to read agents.json --
  // turned a SUCCESSFUL config update into a 400 carrying the internal error
  // message, and the client would retry a change that had already applied.
  //
  // Observed: agents.js:338 dereferences `config.server` where config falls
  // back to the module-level _cachedConfig set by initAgents(). Any caller that
  // builds an API server without initialising the agents module gets null there
  // and every agent-config PUT/rollback 400s with
  // "Cannot read properties of null (reading 'server')" -- while the config on
  // disk is already updated.
  //
  // The events.emit() call immediately after each of these sites is ALREADY
  // guarded with .catch + log.warn for exactly this reason; the synchronous
  // broadcast just never got the same treatment. Guarding inside the function
  // covers all seven sites at once.
  try {
    broadcastAgentsUnsafe(agents);
  } catch (err) {
    log.warn('Failed to broadcast agent update; the write itself succeeded', {
      error: err.message,
    });
  }
}

function broadcastAgentsUnsafe(agents) {
  // Module-scope helper — uses the module-level import alias since the
  // destructured `loadAgentsConfig` from deps lives only inside
  // createHandleApi/createApiServer's closures and is not visible here.
  const agentConfig = _loadAgentsConfig();
  const configMap = {};
  for (const a of agentConfig.agents) configMap[a.id] = a;
  // `status` mirrors /api/health: paused-flag overlays the underlying
  // lifecycle `_status`. The client uses this to render strip badges
  // and must agree with the next /api/health tick to avoid flicker.
  broadcast({ type: 'agents_updated', agents: Object.entries(agents).map(([k, v]) => ({
    id: k, name: v.name, color: v.color, model: v.model,
    displayModel: configMap[k]?.displayModel || null,
    role: v.role || null,
    status: isAgentPaused(k) ? 'paused' : (v._status || 'active'),
    provider: v.provider,
    timeout: v._timeout || null, sandboxLimits: v._sandboxLimits || null,
  })) });
}

/**
 * Build rationale summary for a dispatch_decision timeline event.
 * Used to optimize dashboard rendering by providing pre-computed summary data.
 *
 * @param {Object} event - Timeline event (dispatch_decision type)
 * @param {Object} rationale - Rationale object from dispatch-log
 * @returns {Object|null} Rationale summary or null if not applicable
 */
function buildRationaleSummary(event, rationale) {
  if (!event || event.type !== 'dispatch' && event.type !== 'dispatch_decision') {
    return null;
  }

  if (!rationale) {
    const data = event.data || {};
    return {
      selectedAgent: data.selectedAgent || data.agent || 'unknown',
      selectionReason: data.selectionReason || data.reason || 'N/A',
      guardrailBlocked: false,
      circuitBreakerOpen: false,
      fallbackCount: 0,
    };
  }

  const data = event.data || {};
  const guardrailBlocked = rationale.guardrailContext?.summary?.anyBlocked || false;
  const circuitBreakerOpen = rationale.circuitBreakerContext?.summary?.anyOpen || false;
  const fallbackCount = rationale.fallbacks?.length || 0;

  return {
    selectedAgent: rationale.chosenRoute?.agentId || data.selectedAgent || data.agent || 'unknown',
    selectionReason: data.selectionReason || data.reason || 'N/A',
    guardrailBlocked,
    circuitBreakerOpen,
    fallbackCount,
  };
}

/**
 * Build deep-link metadata for timeline events.
 * Provides pre-built API endpoints for dashboard drill-down navigation.
 *
 * @param {Object} event - Timeline event
 * @param {Object} correlationKeys - Normalized correlation keys
 * @returns {Object} Deep links object
 */
function buildDeepLinks(event, correlationKeys) {
  const links = {};

  // Rationale link: requires campaignId and dispatchId
  if (correlationKeys.campaignId && correlationKeys.dispatchId) {
    links.rationale = `/api/campaigns/${encodeURIComponent(correlationKeys.campaignId)}/dispatches/${encodeURIComponent(correlationKeys.dispatchId)}/rationale`;
  }

  // Decision link: requires dispatchId
  if (correlationKeys.dispatchId) {
    links.decision = `/api/dispatch-log/${encodeURIComponent(correlationKeys.dispatchId)}/decision`;
  }

  // Causal link: requires event id
  if (event && event.id) {
    links.causal = `/api/timeline/causal/${encodeURIComponent(event.id)}`;
  }

  // Audit link: requires correlationId (use event id or dispatchId)
  const correlationId = event.id || correlationKeys.dispatchId;
  if (correlationId) {
    links.audit = `/api/audit?correlationId=${encodeURIComponent(correlationId)}`;
  }

  return Object.keys(links).length > 0 ? links : null;
}

// ─── Login Page HTML ──────────────────────────────────────────────
function loginPageHtml(hasPassword, nonce) {
  const placeholder = hasPassword ? 'Password or token' : 'Auth token';
  const hint = hasPassword
    ? 'Enter your password or machine token to continue.'
    : 'Enter the auth token from .synapse/auth.json or set SYNAPSE_PASSWORD for easy login.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Synapse — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f0f0f; color: #e0e0e0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh;
  }
  .login-card {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 2.5rem; width: 100%; max-width: 380px;
  }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem; color: #fff; }
  .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.8rem; color: #aaa; margin-bottom: 0.4rem; }
  input[type="password"], input[type="text"] {
    width: 100%; padding: 0.7rem 0.9rem; font-size: 1rem;
    background: #141414; border: 1px solid #333; border-radius: 8px;
    color: #e0e0e0; outline: none; transition: border-color 0.15s;
  }
  input:focus { border-color: #60a5fa; }
  .error { color: #ef4444; font-size: 0.8rem; margin-top: 0.5rem; display: none; }
  button {
    width: 100%; padding: 0.7rem; font-size: 0.95rem; font-weight: 500;
    background: #2563eb; color: #fff; border: none; border-radius: 8px;
    cursor: pointer; margin-top: 1.2rem; transition: background 0.15s;
  }
  button:hover { background: #1d4ed8; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .hint { color: #666; font-size: 0.75rem; margin-top: 1rem; line-height: 1.4; }
  .toggle { color: #60a5fa; cursor: pointer; font-size: 0.8rem; margin-top: 0.4rem; display: inline-block; }
</style>
</head>
<body>
<div class="login-card">
  <h1>Synapse</h1>
  <p class="subtitle">Multi-agent workspace</p>
  <form id="loginForm">
    <label for="credential">${placeholder}</label>
    <input type="password" id="credential" name="credential" placeholder="${placeholder}" autocomplete="current-password" autofocus>
    <span class="toggle" id="toggleVis">Show</span>
    <div class="error" id="error"></div>
    <button type="submit">Sign in</button>
  </form>
  <p class="hint">${hint}</p>
</div>
<script nonce="${nonce}">
const form = document.getElementById('loginForm');
const input = document.getElementById('credential');
const error = document.getElementById('error');
const toggle = document.getElementById('toggleVis');
toggle.addEventListener('click', () => {
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  toggle.textContent = isPass ? 'Hide' : 'Show';
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.style.display = 'none';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: input.value }),
    });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/';
    } else {
      error.textContent = data.error || 'Login failed';
      error.style.display = 'block';
    }
  } catch (err) {
    error.textContent = 'Connection error';
    error.style.display = 'block';
  }
  btn.disabled = false;
});
</script>
</body>
</html>`;
}

/**
 * Derive three-state agent status based on circuit breaker, errors, and cooldown state
 * @param {object} options - Status determination options
 * @param {string} options.circuitBreakerState - Circuit breaker state (closed/half-open/open)
 * @param {boolean} options.agentUnavailable - Whether agent is unavailable/failed
 * @param {boolean} options.hasPersistentError - Whether agent has a persistent error
 * @param {boolean} options.isRateLimited - Whether agent is rate-limited/on cooldown
 * @param {boolean} options.isHalfOpen - Whether circuit breaker is half-open
 * @returns {string} Status: 'healthy', 'degraded', or 'down'
 */
function deriveAgentStatus({ circuitBreakerState, agentUnavailable, hasPersistentError, isRateLimited, isHalfOpen }) {
  if (circuitBreakerState === 'open' || agentUnavailable) {
    return 'down';
  }
  if (isHalfOpen || hasPersistentError || isRateLimited) {
    return 'degraded';
  }
  return 'healthy';
}

const VALID_OUTCOME_FILTERS = new Set(['success', 'failure', 'partial', 'null']);

function normalizeOutcomeFilters(rawValues = []) {
  const values = [];
  for (const raw of rawValues) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const parts = raw.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
    values.push(...parts);
  }
  const unique = [...new Set(values)].filter(value => VALID_OUTCOME_FILTERS.has(value));
  return unique.length > 0 ? new Set(unique) : null;
}

function queryRoutingOutcomesWindow(dispatchLog, {
  startTime,
  endTime,
  taskCategory,
  outcomeFilters,
}) {
  const rows = dispatchLog.getOutcomesByWindow(startTime, endTime);
  const filteredRows = taskCategory
    ? rows.filter(row => row.taskCategory === taskCategory)
    : rows;

  if (!outcomeFilters || outcomeFilters.size === 0) {
    return filteredRows;
  }

  return filteredRows
    .map((row) => {
      const successes = outcomeFilters.has('success') ? row.successes : 0;
      const failures = outcomeFilters.has('failure') ? row.failures : 0;
      const partials = outcomeFilters.has('partial') ? row.partials : 0;
      const nullOutcomes = outcomeFilters.has('null') ? row.nullOutcomes : 0;
      const dispatches = successes + failures + partials + nullOutcomes;
      const knownOutcomes = successes + failures + partials;
      const successRate = knownOutcomes > 0 ? successes / knownOutcomes : null;
      return {
        taskCategory: row.taskCategory,
        agentId: row.agentId,
        dispatches,
        successes,
        failures,
        partials,
        nullOutcomes,
        successRate,
      };
    })
    .filter(row => row.dispatches > 0);
}

function queryRoutingOutcomesForWindows(dispatchLog, {
  window1Start,
  window1End,
  window2Start,
  window2End,
  taskCategory,
  outcomes,
}) {
  const outcomeFilters = normalizeOutcomeFilters(outcomes);
  return {
    window1Outcomes: queryRoutingOutcomesWindow(dispatchLog, {
      startTime: window1Start,
      endTime: window1End,
      taskCategory,
      outcomeFilters,
    }),
    window2Outcomes: queryRoutingOutcomesWindow(dispatchLog, {
      startTime: window2Start,
      endTime: window2End,
      taskCategory,
      outcomeFilters,
    }),
  };
}

export function createHandleApi(deps) {
  const {
    PORT, stateManager, agents, loadAgentsConfig, saveAgentsConfig,
    addAgent, removeAgent, probeAgent, retryIntroduce, resolvePermissions, PROVIDERS,
    config, fallbackStates, isAgentCoolingDown, agentCooldowns,
    turnQueues, taskManager, campaignManager, checkpointManager,
    handleUserMessage, queueTurn,
    scheduleManager, triggerManager,
    prefsManager, agendaManager, getSessionMessageCount,
    strategistDecomposeCampaign, strategistInject, strategistEvaluate, strategistTick,
    addMessage, SERVER_START_TIME, auth, webhookDispatcher,
    getCloudBudgetStatus, getPaceGateStatus, setPaceOverride, getVectorStore, sandbox, rateLimiter, credentialVault,
    events, telemetryStore, WS_EVENT_MAP,
    circuitBreaker, circuitBreakerHistoryStore, alertMonitor, performanceStore, anomalyDetector, dispatchLog, snapshotManager, timelineStore,
    agentConfigStore, agentConfigSchema, errorRegistry, operatorAuditStore, operatorActionStore,
    weightOverrides, providerCostStore, categoryCostConfigStore, slaMonitor,
    errorPatternConstraintStore,
    recordIntent, getPending,
    vaultWriter,
    prStore,                                          // BYOH PR workflow Phase 1
    sharedStateStore,
    scheduledReportStore,
    mcpConnectionManager,
    toolRegistry,
    toolDistributionService,
    agentCookies,
    approvalAuditTrail,
  } = deps;

  const agentTemplateStore = deps.agentTemplateStore || new AgentTemplateStore(
    join(stateManager.synapseDir || stateManager.baseDir || '.synapse', 'agent-templates.json')
  );

  // A user who just created or reconfigured a project should see agents move
  // within seconds — not after the strategist's periodic tick (~5 minutes of
  // dead air right after the onboarding wizard, measured live). Fire-and-
  // forget with a short settle delay; strategistTick is single-flight
  // guarded, so overlapping kicks are safe no-ops.
  const kickStrategist = (reason) => {
    if (typeof strategistTick !== 'function') return;
    setTimeout(() => {
      Promise.resolve(strategistTick()).catch(err =>
        log.warn('Strategist kick failed', { reason, error: err.message }));
    }, 1500);
  };

  const policyEngine = createPolicyEngine({ config, operatorAuditStore });

  // ─── MCP Server ─────────────────────────────────────────────────
  const mcpServer = createMcpServer({
    credentialVault, stateManager, campaignManager, taskManager,
    addMessage, agents, config, auth,
    mergeCampaignBranch, rollbackLastMerge,
    // chat.send routes through the real dispatch pipeline so agents respond
    // to MCP messages the same way they respond to typed UI messages.
    queueTurn, handleUserMessage,
  });

  // Initialize export job queue for background export processing
  let exportJobQueue = deps.exportJobQueue || null;
  if (!exportJobQueue) {
    try {
      exportJobQueue = createExportJobQueue();
      log.info('Export job queue initialized for API');
    } catch (err) {
      log.warn('Failed to initialize export job queue, async exports will be disabled', { error: err.message });
    }
  }

  // Initialize template registry for report generation
  let templateRegistry = deps.templateRegistry || null;
  if (!templateRegistry) {
    try {
      templateRegistry = new TemplateRegistry();
      initializeReportTemplates(templateRegistry);
      log.info('Template registry initialized for API', { templates: templateRegistry.list().map(t => t.id) });
    } catch (err) {
      log.warn('Failed to initialize template registry, template-based reports will be disabled', { error: err.message });
    }
  }

  // Initialize analytics signals store for dashboard API
  // Use provided store from deps (for testing) or create new one
  let analyticsSignalsStore = deps.analyticsSignalsStore || null;
  if (!analyticsSignalsStore && config?.timeline?.dbPath && config?.server?.projectDir) {
    try {
      const timelineDbPath = config.timeline.dbPath.startsWith('/')
        ? config.timeline.dbPath
        : join(config.server.projectDir, config.timeline.dbPath);
      analyticsSignalsStore = new AnalyticsSignalsStore({ dbPath: timelineDbPath });
      log.info('Analytics signals store initialized for API', { dbPath: timelineDbPath });
    } catch (err) {
      log.warn('Failed to initialize analytics signals store for API, /api/analytics will return 503', { error: err.message });
    }
  }

  return function handleApi(req, res) {
    // Rate limit check (before auth — health exempt inside checkRequest)
    if (rateLimiter && !rateLimiter.checkRequest(req, res)) return true; // consumed — 429 sent
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;
    // Auth check (all routes except health and MCP — MCP handles its own auth)
    if (path !== '/mcp' && !auth.checkRequest(req, res)) return true; // consumed — 401 sent
    const authResult = auth.isAuthenticated ? auth.isAuthenticated(req) : { authenticated: false, userId: null };
    const requestUserId = authResult?.userId || null;
    // Role carried by the credential itself (API keys) — undefined for
    // master-token/session auth, which default to operator downstream.
    const requestUserRole = authResult?.role || undefined;

    // Default-deny mutations for scoped credentials. This is intentionally
    // centralized: endpoint-local checks remain useful for action-specific
    // policy, but are no longer the only barrier protecting a new route.
    const mutationAction = mutationActionForRoute(req.method, path);
    if (mutationAction && !policyEngine.authorize(req, requestUserId, {
      action: mutationAction,
      roleHint: requestUserRole,
    })) {
      json(res, { error: 'Forbidden: operator role required' }, 403);
      return true;
    }

    // ─── RBAC Helper: Check if user has required role for action ───────────────
    function requireOperatorRole(action = null, additionalContext = {}) {
      if (!policyEngine.authorize(req, requestUserId, { action, roleHint: requestUserRole, ...additionalContext })) {
        json(res, { error: 'Forbidden: operator role required' }, 403);
        return false;
      }
      return true;
    }

    function getIdempotencyKey(req, payload) {
      const headerKey = req.headers['idempotency-key']
        || req.headers['x-idempotency-key']
        || req.headers['x-action-id'];
      const headerValue = Array.isArray(headerKey) ? headerKey[0] : headerKey;
      const bodyValue = payload?.actionId || payload?.idempotencyKey || payload?.action_id || payload?.idempotency_key;
      const candidate = typeof bodyValue === 'string' && bodyValue.trim()
        ? bodyValue.trim()
        : (typeof headerValue === 'string' && headerValue.trim() ? headerValue.trim() : null);
      return candidate || null;
    }

    function getIdempotentResult(actionId) {
      if (!operatorActionStore || !actionId) return null;
      if (typeof operatorActionStore.get !== 'function') return null;
      return operatorActionStore.get(actionId);
    }

    function respondIdempotent(record) {
      if (!record) return false;
      const body = record.responseBody || { ok: true, idempotent: true };
      const status = record.responseStatus || 200;
      json(res, body, status);
      return true;
    }

    function recordIdempotentResult(actionId, actionType, responseStatus, responseBody, metadata = {}) {
      if (!operatorActionStore || typeof operatorActionStore.record !== 'function' || !actionId) return null;
      try {
        return operatorActionStore.record(actionId, actionType, {
          dispatchId: metadata.dispatchId || null,
          traceId: metadata.traceId || null,
          payload: metadata.payload || null,
          responseStatus,
          responseBody,
        });
      } catch (err) {
        log.warn('Failed to record idempotent operator action', { actionId, actionType, error: err.message });
        return null;
      }
    }

    function resolveCorrelationKeysFromId(correlationId) {
      const resolved = {
        campaignId: null,
        taskId: null,
        dispatchId: null,
        traceId: null,
        agentId: null,
        provider: null,
      };
      if (!correlationId) return resolved;

      if (dispatchLog && typeof dispatchLog.getById === 'function') {
        const record = dispatchLog.getById(correlationId);
        if (record) {
          resolved.dispatchId = record.id || correlationId;
          resolved.traceId = record.traceId || null;
          resolved.campaignId = record.campaignId || null;
          resolved.agentId = record.selectedAgent || null;
          resolved.provider = record.provider || record.selectedProvider || null;
          return resolved;
        }
      }

      if (timelineStore && typeof timelineStore.query === 'function') {
        try {
          const byDispatch = timelineStore.query({ dispatchId: correlationId, limit: 1 });
          const event = byDispatch?.events?.[0];
          if (event) {
            return { ...resolved, ...extractCorrelationKeys(event) };
          }
        } catch (err) {
          log.debug('Failed to resolve correlation from dispatchId', { correlationId, error: err.message });
        }

        try {
          const byTrace = timelineStore.query({ traceId: correlationId, limit: 5 });
          const event = byTrace?.events?.find(Boolean);
          if (event) {
            return { ...resolved, ...extractCorrelationKeys(event) };
          }
        } catch (err) {
          log.debug('Failed to resolve correlation from traceId', { correlationId, error: err.message });
        }
      }

      return resolved;
    }

    function findActiveAlertSnapshot({ alertKey, condition, agentId, taskCategory } = {}) {
      const candidates = [];
      if (anomalyDetector && typeof anomalyDetector.getActiveAlerts === 'function') {
        candidates.push(...(anomalyDetector.getActiveAlerts() || []));
      }
      if (alertMonitor && typeof alertMonitor.getActiveAlerts === 'function') {
        candidates.push(...(alertMonitor.getActiveAlerts() || []));
      }
      if (candidates.length === 0) return null;

      const matches = (entry) => {
        if (!entry) return false;
        if (alertKey) {
          if (entry.condition === 'agent-anomaly' && entry.agentId && entry.taskCategory) {
            const derivedKey = `agent-anomaly:${entry.agentId}:${entry.taskCategory}`;
            if (derivedKey === alertKey) return true;
          }
          if (entry.alertKey && entry.alertKey === alertKey) return true;
        }
        if (condition && entry.condition !== condition) return false;
        if (agentId && entry.agentId !== agentId) return false;
        if (taskCategory && entry.taskCategory !== taskCategory) return false;
        return !!(condition || agentId || taskCategory);
      };

      return candidates.find(matches) || null;
    }

    function emitOperatorActionTimelineEvent(actionType, payload = {}) {
      if (!actionType) return null;
      const eventPayload = {
        idempotencyKey: payload.idempotencyKey || null,
        actionType,
        action: actionType,
        operatorId: payload.operatorId || 'system',
        status: payload.status || 'completed',
        sourceDispatchId: payload.sourceDispatchId || null,
        targetDispatchId: payload.targetDispatchId || null,
        targetParams: payload.targetParams || null,
        campaignId: payload.campaignId || null,
        dispatchId: payload.dispatchId || null,
        traceId: payload.traceId || null,
        agentId: payload.agentId || null,
        provider: payload.provider || null,
        correlationId: payload.correlationId || null,
        data: {
          action: actionType,
          operatorId: payload.operatorId || 'system',
          status: payload.status || 'completed',
          correlationId: payload.correlationId || null,
          ...payload.data,
        },
      };

      if (timelineStore && typeof timelineStore.appendOperatorActionEvent === 'function') {
        return timelineStore.appendOperatorActionEvent(eventPayload);
      }
      if (events && typeof events.emit === 'function') {
        events.emit('operator:action', eventPayload).catch(err => {
          log.warn('Event listener failed', { event: 'operator:action', error: err.message });
        });
        return eventPayload;
      }
      if (timelineStore && typeof timelineStore.ingest === 'function') {
        return timelineStore.ingest('operator_action', {
          action: actionType,
          actionType,
          operatorId: eventPayload.operatorId,
          status: eventPayload.status,
          sourceDispatchId: eventPayload.sourceDispatchId,
          targetDispatchId: eventPayload.targetDispatchId,
          dispatchId: eventPayload.dispatchId,
          traceId: eventPayload.traceId,
          campaignId: eventPayload.campaignId,
          agentId: eventPayload.agentId,
          provider: eventPayload.provider,
          correlationId: eventPayload.correlationId,
          ...eventPayload.data,
        }, {
          campaignId: eventPayload.campaignId,
          dispatchId: eventPayload.dispatchId,
          traceId: eventPayload.traceId,
          agentId: eventPayload.agentId,
          provider: eventPayload.provider,
        });
      }
      return null;
    }

    // --- Agent routes ---
    if (path === '/api/agents' && req.method === 'GET') {
      const agentConfig = loadAgentsConfig();
      const configMap = {};
      for (const a of agentConfig.agents) configMap[a.id] = a;
      json(res, Object.entries(agents).map(([k, v]) => ({
        id: k, name: v.name, color: v.color, model: v.model,
        displayModel: configMap[k]?.displayModel || null,
        provider: v.provider || configMap[k]?.provider || null,
        role: v.role || null, status: v._status || 'active',
        // lastValidationError lets the badge title explain *why* an agent is
        // failed on first paint, before /api/health refresh fires.
        lastValidationError: v.lastValidationError || null,
        permissions: resolvePermissions(k), skills: v.skills || [],
        personaFile: configMap[k]?.personaFile || null, hasPersona: !!v.persona,
        timeout: v._timeout || null, sandboxLimits: v._sandboxLimits || null,
      })));
      return true;
    }
    // ─── GET /api/agent-classes — model-tier classes derived from the live
    // roster (for the project roster picker). Class = normalized model
    // identity (src/roster.js modelClass): opus-5, gpt-5.6-sol, qwen3.5-27b.
    if (path === '/api/agent-classes' && req.method === 'GET') {
      json(res, availableClasses(agents));
      return true;
    }
    if (path === '/api/agents' && req.method === 'POST') {
      if (!requireOperatorRole('agent_create')) return true;
      handleBody(req, res, body => {
        try {
          json(res, addAgent(JSON.parse(body)), 201);
          broadcastAgents(agents);
          if (events && typeof events.emit === 'function') {
            events.emit('agents:updated', { action: 'created', agentIds: Object.keys(agents) }).catch(err => {
              log.warn('Event listener failed', { event: 'agents:updated', action: 'created', error: err.message });
            });
          }
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }
    const agentDeleteMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (agentDeleteMatch && req.method === 'DELETE') {
      if (!requireOperatorRole('agent_delete', { resourceId: agentDeleteMatch[1] })) return true;
      try {
        removeAgent(agentDeleteMatch[1]);
        json(res, { ok: true });
        broadcastAgents(agents);
        if (events && typeof events.emit === 'function') {
          events.emit('agents:updated', { action: 'deleted', agentId: agentDeleteMatch[1] }).catch(err => {
            log.warn('Event listener failed', { event: 'agents:updated', action: 'deleted', error: err.message });
          });
        }
      } catch (e) { respondApiError(res, e, { status: 400 }); }
      return true;
    }
    const agentConfigMatch = path.match(/^\/api\/agents\/([^/]+)\/config$/);

    if (path === '/api/agent-templates' && req.method === 'GET') {
      try {
        json(res, agentTemplateStore.list());
      } catch (err) {
        log.error('Failed to read agent templates', { error: err.message, code: err.code });
        json(res, { error: 'Agent template store is unavailable' }, 500);
      }
      return true;
    }
    if (path === '/api/agent-templates' && req.method === 'POST') {
      handleBody(req, res, body => {
        try {
          const tpl = JSON.parse(body);
          const saved = agentTemplateStore.save(tpl);
          log.info('Agent template saved', { name: saved.name, operator: requestUserId });
          json(res, saved, 201);
        } catch (err) {
          if (err instanceof SyntaxError || err instanceof AgentTemplateValidationError) {
            json(res, {
              error: 'Invalid agent template',
              ...(err instanceof AgentTemplateValidationError ? { details: err.details } : {}),
            }, 400);
            return;
          }
          log.error('Failed to save agent template', { error: err.message, code: err.code });
          json(res, { error: 'Agent template store is unavailable' }, 500);
        }
      });
      return true;
    }
    const tplDeleteMatch = path.match(/^\/api\/agent-templates\/([^/]+)$/);
    if (tplDeleteMatch && req.method === 'DELETE') {
      const tplId = decodeURIComponent(tplDeleteMatch[1]);
      try {
        if (!agentTemplateStore.delete(tplId)) {
          json(res, { error: 'Template not found' }, 404);
          return true;
        }
        json(res, { ok: true });
      } catch (err) {
        log.error('Failed to delete agent template', { error: err.message, code: err.code });
        json(res, { error: 'Agent template store is unavailable' }, 500);
      }
      return true;
    }
    if (agentConfigMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(agentConfigMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }
      const agent = agents[agentId];
      const metadata = agentConfigStore.getAgentConfigMetadata(agentId);
      const agentCfg = agentConfigStore.buildConfig(agentId, agent);
      json(res, { ...agentCfg, ...metadata });
      return true;
    }
    if (agentConfigMatch && req.method === 'PUT') {
      const agentId = decodeURIComponent(agentConfigMatch[1]);
      if (!requireOperatorRole('agent_config_update', { resourceId: agentId })) return true;
      handleBody(req, res, body => {
        try {
          const patch = JSON.parse(body);

          // Check if agent exists
          if (!agents[agentId]) {
            json(res, { error: `Agent "${agentId}" not found` }, 404);
            return;
          }

          // Load roles config for validation
          const agentsCfg = loadAgentsConfig();
          const rolesConfig = agentsCfg.roles || {};

          // Validate the patch using agent-config-schema
          const validation = agentConfigSchema.validateAgentConfig(patch, agents[agentId], rolesConfig);

          if (!validation.valid) {
            json(res, {
              error: 'Invalid configuration',
              details: validation.errors
            }, 400);
            return;
          }

          // Capture pre-update lifecycle state — if the agent was failed
          // and the operator just edited config (e.g. fixed a bad cliPath),
          // a re-introduction should fire so they don't have to delete and
          // recreate just to test their fix.
          const wasFailed = agents[agentId]._status === 'failed';

          // Apply the validated patch using agent-config-store
          const result = agentConfigStore.updateAgentConfig(agentId, patch);

          if (!result.ok) {
            json(res, { error: result.error }, 400);
            return;
          }

          // Broadcast update to connected clients
          broadcastAgents(agents);
          if (events && typeof events.emit === 'function') {
            events.emit('agents:updated', { action: 'config_updated', agentId }).catch(err => {
              log.warn('Event listener failed', { event: 'agents:updated', action: 'config_updated', error: err.message });
            });
          }

          // Implicit retry: failed agent + config patched → fire-and-forget
          // re-introduction. Result lands in System/#general via the existing
          // _onAgentIntroduced wiring; the badge transitions back through
          // registered → active|failed.
          if (wasFailed && retryIntroduce) {
            try { retryIntroduce(agentId); }
            catch (e) { log.warn('Retry introduction failed to dispatch', { agentId, error: e.message }); }
          }

          json(res, result.config, 200);
        } catch (e) {
          respondApiError(res, e, { status: 400 });
        }
      });
      return true;
    }
    const agentRollbackMatch = path.match(/^\/api\/agents\/([^/]+)\/config\/rollback$/);
    if (agentRollbackMatch && req.method === 'PUT') {
      const agentId = decodeURIComponent(agentRollbackMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }

      const result = agentConfigStore.rollbackAgentConfig(agentId);
      if (!result.ok) {
        // Agent existence was already checked above; any store failure means
        // no backup is available — return 409 as specified.
        json(res, { error: result.error }, 409);
        return true;
      }

      broadcastAgents(agents);
      if (events && typeof events.emit === 'function') {
        events.emit('agents:updated', { action: 'config_rolled_back', agentId }).catch(err => {
          log.warn('Event listener failed', { event: 'agents:updated', action: 'config_rolled_back', error: err.message });
        });
      }
      json(res, result.config, 200);
      return true;
    }
    const agentHistoryMatch = path.match(/^\/api\/agents\/([^/]+)\/config\/history$/);
    if (agentHistoryMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(agentHistoryMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }

      const history = agentConfigStore.getConfigHistory(agentId);
      json(res, history);
      return true;
    }
    const agentProbeMatch = path.match(/^\/api\/agents\/([^/]+)\/probe$/);
    if (agentProbeMatch && req.method === 'POST') {
      const agentId = agentProbeMatch[1];
      if (!agents[agentId]) { json(res, { error: `Agent "${agentId}" not found` }, 404); return true; }
      agents[agentId]._status = 'probing';
      saveAgentsConfig();
      probeAgent(agentId).then(result => {
        agents[agentId]._status = result.ok ? 'active' : 'failed';
        saveAgentsConfig();
        json(res, { id: agentId, status: agents[agentId]._status, probeResponse: result.response });
        broadcastAgents(agents);
      }).catch(err => {
        agents[agentId]._status = 'failed';
        saveAgentsConfig();
        respondApiError(res, err);
      });
      return true;
    }
    // ─── Onboarding test dispatch ─────────────────────────────────
    // The onboarding wizard's "test" step POSTs here to verify a real
    // end-to-end dispatch. Backed by agent.send (the same path probeAgent
    // uses) against the first active, unpaused agent. Response shape is
    // what ui/public/js/onboarding.js runTest() consumes.
    if (path === '/api/onboarding/test-dispatch' && req.method === 'POST') {
      handleBody(req, res, async body => {
        const timestamp = new Date().toISOString();
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; } catch { /* fall through to default prompt */ }
        const prompt = (typeof payload.prompt === 'string' && payload.prompt.trim())
          ? payload.prompt.slice(0, 2000)
          : 'Hello! This is a test dispatch to verify the agent is working correctly. Reply briefly.';

        // Auto-selection prefers agents WITHOUT a stored validation failure —
        // dispatching the test to an agent the wizard just marked broken
        // hands the user a guaranteed confusing failure. Explicit choice is
        // honored regardless (the operator may be retrying a fixed agent).
        const candidates = Object.entries(agents)
          .filter(([id, a]) =>
            !isAgentPaused(id) && (a._status === 'active' || a._status === 'idle' || !a._status))
          .sort(([, a], [, b]) => (a.lastValidationError ? 1 : 0) - (b.lastValidationError ? 1 : 0));
        if (candidates.length === 0) {
          json(res, { success: false, error: 'No active agents available for a test dispatch', classifiedError: null, timestamp }, 503);
          return;
        }
        // Optional operator-chosen agent (wizard dropdown); must be an
        // active candidate, otherwise fall through to first-available.
        let selected = null;
        if (typeof payload.agentId === 'string' && payload.agentId) {
          selected = candidates.find(([id]) => id === payload.agentId) || null;
          if (!selected) {
            json(res, { success: false, error: `Agent "${payload.agentId}" is not an active, unpaused agent`, classifiedError: null, timestamp }, 400);
            return;
          }
        }
        // Prefer a FREE agent for the synthetic test; an agent already
        // executing a real task must not be interrupted (and per-agent
        // exclusivity would reject the spawn anyway).
        const isBusyWithRealWork = ([id]) => {
          const cookie = agentCookies.get?.(id);
          return !!(cookie && cookie.type === 'executing' && cookie.taskId);
        };
        const freeCandidates = candidates.filter(c => !isBusyWithRealWork(c));
        // Single-agent installs hit this constantly: the wizard's First
        // Project step starts a real build immediately, so by the time the
        // user reaches Test Dispatch the only agent is busy BUILDING. A live
        // dispatch executing a real task is STRONGER proof that routing and
        // dispatch work than any synthetic hello — report it as success
        // instead of a guaranteed-confusing "already has an active process".
        if (!selected && freeCandidates.length === 0) {
          const [busyId, busyAgent] = candidates.find(isBusyWithRealWork) || candidates[0];
          const cookie = agentCookies.get?.(busyId);
          json(res, {
            success: true,
            dispatchId: `livedisp_${randomUUID()}`,
            selectedAgent: busyId,
            routingDecision: `Agent "${busyId}" (provider: ${busyAgent.provider || 'unknown'}) is already executing a real task — live dispatch observed`,
            response: `Your agent is already hard at work on ${cookie?.projectId ? `project "${cookie.projectId}"` : 'a real task'} — a live dispatch through the full routing pipeline. That is stronger proof than a synthetic test message, so this step passes on the real thing.`,
            liveDispatch: true,
            duration: 0,
            timestamp,
          });
          return;
        }
        const [agentId, agent] = selected || freeCandidates[0];
        const routingDecision = selected
          ? `Operator-selected agent "${agentId}" (provider: ${agent.provider || 'unknown'})`
          : `Selected first active unpaused agent "${agentId}" (provider: ${agent.provider || 'unknown'})`;
        const dispatchId = `testdisp_${randomUUID()}`;
        const started = performance.now();
        try {
          // Same cold-start grace as probeAgent (#110): first dispatch on a
          // freshly booted server races cold harness caches.
          const testDispatchMs = process.uptime() < 120 ? 120_000 : 60_000;
          const response = await Promise.race([
            agent.send(prompt, undefined, { maxTurns: 1, probe: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Test dispatch timed out after ${testDispatchMs / 1000}s`)), testDispatchMs)),
          ]);
          const duration = Math.round(performance.now() - started);
          // Harnesses return ResponseObject ({text, tokens…}), not bare
          // strings — coerce before judging emptiness (same fix as probeAgent;
          // the typeof gate called every successful dispatch "empty").
          const responseText = typeof response === 'string' ? response
            : (response?.text != null ? String(response.text) : String(response ?? ''));
          if (responseText.trim()) {
            json(res, { success: true, dispatchId, selectedAgent: agentId, routingDecision, response: responseText.slice(0, 1000), duration, timestamp });
          } else {
            json(res, {
              success: false, error: 'Agent returned an empty response',
              classifiedError: classifyError(new Error('Empty response'), { name: agentId, provider: agent.provider }, {
                command: agent.command || agent.provider,
              }),
              timestamp,
            }, 502);
          }
        } catch (err) {
          json(res, {
            success: false, error: 'Agent dispatch failed',
            classifiedError: toPublicClassifiedError(classifyError(err, { name: agentId, provider: agent.provider }, {
              command: err.command || agent.command || agent.provider,
              exitCode: err.exitCode ?? err.code,
              stderr: err.stderr,
            })),
            timestamp,
          }, 502);
        }
      });
      return true;
    }
    const agentValidateMatch = path.match(/^\/api\/agents\/([^/]+)\/validate$/);
    if (agentValidateMatch && req.method === 'POST') {
      const agentId = agentValidateMatch[1];

      // Check if agent exists
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }

      // Check if validation already in progress
      if (validationLocks.has(agentId)) {
        json(res, { error: 'Validation already in progress for this agent' }, 409);
        return true;
      }

      // Validation long-polls: a local-model canary can hold this response
      // open for minutes (probeTimeoutMs is configurable up to 300s). The
      // server-wide 120s socket timeout destroyed the socket mid-canary;
      // the browser then retried the POST on a fresh connection, hit the
      // validation lock above, and the wizard painted a 409 error over a
      // validation that went on to PASS. Exempt this route like the
      // streaming endpoints do.
      res.setTimeout(0);
      req.socket.setTimeout(0);

      // Parse and validate request body
      handleBody(req, res, body => {
        let skipCanary = false;

        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed === 'object') {
              if ('skipCanary' in parsed) {
                if (typeof parsed.skipCanary !== 'boolean') {
                  json(res, { error: 'skipCanary must be a boolean' }, 400);
                  return;
                }
                skipCanary = parsed.skipCanary;
              }
            } else {
              json(res, { error: 'Request body must be an object' }, 400);
              return;
            }
          } catch (e) {
            json(res, { error: 'Invalid JSON in request body' }, 400);
            return;
          }
        }

        // Start validation and add lock
        const validationPromise = runValidation(agentId, agents, { probeAgent, createLogger }, { skipCanary })
          .then(result => {
            // Remove lock
            validationLocks.delete(agentId);

            // Persist the outcome on the agent so downstream consumers
            // (test-dispatch auto-selection, agent badges) can prefer
            // known-good agents without re-validating.
            const failedStep = (result.steps || []).find(s => s.status === 'fail');
            agents[agentId].lastValidationError = result.overallStatus === 'fail'
              ? ((failedStep && failedStep.message) || 'Validation failed')
              : null;
            // A passing validation is a REAL end-to-end dispatch — it heals a
            // 'failed' status left by a lost introduction race (introduction
            // and wizard validation can collide on per-agent exclusivity
            // right after creation). A failing one marks the agent failed.
            if (result.overallStatus === 'pass' && agents[agentId]._status === 'failed') {
              agents[agentId]._status = 'active';
              saveAgentsConfig();
            } else if (result.overallStatus === 'fail' && agents[agentId]._status === 'active') {
              agents[agentId]._status = 'failed';
              saveAgentsConfig();
            }

            // Broadcast validation complete event
            broadcast({ type: 'validation:complete', ...result });

            // Emit event for SSE subscribers (if events object is available)
            if (events) {
              events.emit('agent:validation_complete', result);
            }

            // Return result
            json(res, result);
          })
          .catch(err => {
            // Remove lock on error
            validationLocks.delete(agentId);

            log.error('Validation failed', { agentId, error: err.message });
            respondApiError(res, err);
          });

        validationLocks.set(agentId, validationPromise);
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });

      return true;
    }

    // ─── GET /api/agents/:id/quality-metrics ─────────────────────
    const agentQualityMatch = path.match(/^\/api\/agents\/([^/]+)\/quality-metrics$/);
    if (agentQualityMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(agentQualityMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }
      const windowDays = parseInt(url.searchParams.get('days') || '30', 10);
      const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      let totalAssigned = 0;
      let totalDone = 0;
      let retryFree = 0;
      let passVerdicts = 0;
      let totalVerdicts = 0;
      if (stateManager && taskManager) {
        for (const proj of stateManager.listProjects()) {
          const pid = proj.id;
          let tasks;
          try { tasks = taskManager.listTasks(pid); } catch { tasks = []; }
          for (const task of tasks) {
            for (const st of (task.subtasks || [])) {
              // Only count subtasks within the window that are done
              const inWindow = (st.completedAt && st.completedAt >= cutoff) ||
                               (!st.completedAt && st.startedAt && st.startedAt >= cutoff);
              if (!inWindow) continue;
              if (st.status !== 'done') continue;
              if (st.assignee !== agentId) continue;
              totalAssigned++;
              totalDone++;
              if ((st.retryCount || 0) === 0) retryFree++;
              // Check for reviewer verdict in result text
              if (st.suggestedRole === 'reviewer' && st.result) {
                const verdictMatch = st.result.match(/\b(PASS|FAIL)\b/i);
                if (verdictMatch) {
                  totalVerdicts++;
                  if (verdictMatch[1].toUpperCase() === 'PASS') passVerdicts++;
                }
              }
            }
          }
        }
      }
      const MIN_SAMPLE = 5;
      if (totalAssigned < MIN_SAMPLE) {
        json(res, { agentId, score: null, sampleSize: totalAssigned, reason: 'insufficient_data', windowDays });
        return true;
      }
      const rawPassRate = totalDone / totalAssigned;
      const retryFreeRate = retryFree / totalAssigned;
      const reviewerPassRate = totalVerdicts > 0 ? passVerdicts / totalVerdicts : rawPassRate;
      const score = 0.4 * rawPassRate + 0.3 * retryFreeRate + 0.3 * reviewerPassRate;
      json(res, {
        agentId, score: Math.round(score * 1000) / 1000,
        rawPassRate: Math.round(rawPassRate * 1000) / 1000,
        retryFreeRate: Math.round(retryFreeRate * 1000) / 1000,
        reviewerPassRate: Math.round(reviewerPassRate * 1000) / 1000,
        totalAssigned, totalDone, retryFree, passVerdicts, totalVerdicts,
        windowDays, sampleSize: totalAssigned,
      });
      return true;
    }

    // ─── GET /api/agents/:id/recent-decisions ────────────────────
    const agentDecisionsMatch = path.match(/^\/api\/agents\/([^/]+)\/recent-decisions$/);
    if (agentDecisionsMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(agentDecisionsMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }

      // Parse query parameters
      const limit = parseInt(url.searchParams.get('limit') || '5', 10);
      const effectiveLimit = Math.min(Math.max(limit, 1), 20);

      // Query dispatch log for recent decisions by this agent
      let decisions = [];
      if (dispatchLog && typeof dispatchLog.query === 'function') {
        try {
          const result = dispatchLog.query({
            agentId: agentId,
            limit: effectiveLimit,
            orderBy: 'timestamp',
            order: 'DESC',
          });
          decisions = (result.decisions || []).map(d => ({
            id: d.id,
            timestamp: d.timestamp,
            taskCategory: d.taskCategory,
            campaignId: d.campaignId,
            selectedAgent: d.selectedAgent,
            selectionReason: d.selectionReason || '',
            traceId: d.traceId || null,
            outcome: d.outcome || null,
            candidates: d.candidates || [],
          }));
        } catch (err) {
          log.warn('Failed to fetch recent decisions for agent', { agentId, error: err.message });
        }
      }

      json(res, {
        agentId,
        decisions,
        total: decisions.length,
      });
      return true;
    }

    // ─── POST /api/agents/:id/pause ──────────────────────────────
    const agentPauseMatch = path.match(/^\/api\/agents\/([^/]+)\/pause$/);
    if (agentPauseMatch && req.method === 'POST') {
      if (agentPauseMatch[1] === 'all') { /* handled by /api/agents/all/pause route below */ }
      else {
      if (!requireOperatorRole('agent_pause', { action: 'agent_pause' })) return true;
      const agentId = decodeURIComponent(agentPauseMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }

      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          const reason = auditReason || `Paused by operator ${operatorId}`;
          setAgentPaused(agentId, true, reason);

          operatorAuditStore.append({
            action: 'agent_pause',
            agentId,
            projectId: null,
            campaignId: null,
            operatorId,
            status: 'success',
            decision: 'allow',
            source,
            reason,
            correlationId,
            dispatchId,
            traceId,
          });

          broadcast({ type: 'agent_state_changed', agentId, paused: true, reason });

          json(res, { ok: true, agentId, paused: true, reason });
        } catch (err) {
          log.error('Agent pause failed', { agentId, error: err.message });
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
      }
    }

    // ─── POST /api/agents/:id/resume ─────────────────────────────
    const agentResumeMatch = path.match(/^\/api\/agents\/([^/]+)\/resume$/);
    if (agentResumeMatch && req.method === 'POST') {
      if (agentResumeMatch[1] === 'all') { /* handled below */ }
      else {
      if (!requireOperatorRole('agent_resume', { action: 'agent_resume' })) return true;
      const agentId = decodeURIComponent(agentResumeMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }

      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          const reason = auditReason || `Resumed by operator ${operatorId}`;
          setAgentPaused(agentId, false, reason);

          operatorAuditStore.append({
            action: 'agent_resume',
            agentId,
            projectId: null,
            campaignId: null,
            operatorId,
            status: 'success',
            decision: 'allow',
            source,
            reason,
            correlationId,
            dispatchId,
            traceId,
          });

          broadcast({ type: 'agent_state_changed', agentId, paused: false, reason });

          json(res, { ok: true, agentId, paused: false, reason });
        } catch (err) {
          log.error('Agent resume failed', { agentId, error: err.message });
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
      }
    }

    // ─── POST /api/agents/:id/deactivate ──────────────────────────
    const agentDeactMatch = path.match(/^\/api\/agents\/([^/]+)\/deactivate$/);
    if (agentDeactMatch && req.method === 'POST') {
      const agentId = decodeURIComponent(agentDeactMatch[1]);
      if (!requireOperatorRole('agent_deactivate', { resourceId: agentId })) return true;
      const agent = agents[agentId];
      if (!agent) { json(res, { error: 'Agent not found' }, 404); return true; }
      agent._status = 'inactive';
      // Persist — without this the status silently reverted to active on the
      // next restart (agents.json round-trips _status via the status field).
      saveAgentsConfig();
      broadcast({ type: 'agent_state_changed', agentId, status: 'inactive', reason: 'Operator deactivated' });
      log.info('Agent deactivated', { agentId, operator: requestUserId });
      json(res, { ok: true, agentId, status: 'inactive' });
      return true;
    }

    // ─── POST /api/agents/:id/activate ────────────────────────────
    const agentActMatch = path.match(/^\/api\/agents\/([^/]+)\/activate$/);
    if (agentActMatch && req.method === 'POST') {
      const agentId = decodeURIComponent(agentActMatch[1]);
      if (!requireOperatorRole('agent_activate', { resourceId: agentId })) return true;
      const agent = agents[agentId];
      if (!agent) { json(res, { error: 'Agent not found' }, 404); return true; }
      agent._status = 'idle';
      saveAgentsConfig();
      broadcast({ type: 'agent_state_changed', agentId, status: 'idle', reason: 'Operator activated' });
      log.info('Agent activated', { agentId, operator: requestUserId });
      json(res, { ok: true, agentId, status: 'idle' });
      return true;
    }

    // ─── POST /api/tasks/:id/cancel ──────────────────────────────
    const taskCancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (taskCancelMatch && req.method === 'POST') {
      if (!requireOperatorRole('task_cancel', { action: 'task_cancel' })) return true;
      const taskId = decodeURIComponent(taskCancelMatch[1]);

      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';
          const reason = payload?.reason || payload?.reasonText || `Cancelled by operator ${operatorId}`;

          if (!reason || reason.length < 10) {
            json(res, { error: 'Reason required (minimum 10 characters)' }, 400);
            return;
          }

          let projectId = payload?.projectId || payload?.project_id || null;
          let task = null;

          if (projectId) {
            if (!taskManager || typeof taskManager.getTask !== 'function') {
              json(res, { error: 'TaskManager not available' }, 503);
              return;
            }
            task = taskManager.getTask(projectId, taskId);
            if (!task) {
              json(res, { error: `Task "${taskId}" not found in project "${projectId}"` }, 404);
              return;
            }
          } else {
            json(res, { error: 'projectId required' }, 400);
            return;
          }

          if (TERMINAL_TASK_STATUSES.has(task.status)) {
            json(res, { error: `Task is already in terminal state: ${task.status}` }, 400);
            return;
          }

          const updatedTask = taskManager.updateTaskStatus(
            projectId,
            taskId,
            'cancelled',
            'operator',
            reason
          );

          operatorAuditStore.append({
            action: 'task_cancel',
            agentId: null,
            projectId,
            campaignId: task.campaignId || null,
            operatorId,
            status: 'success',
            decision: 'allow',
            source,
            reason,
            correlationId,
            dispatchId,
            traceId,
            taskId,
            previousStatus: task.status,
          });

          broadcast({
            type: 'task_cancelled',
            projectId,
            taskId,
            reason,
            operatorId,
          });

          json(res, {
            ok: true,
            taskId,
            projectId,
            cancelled: true,
            reason,
            task: updatedTask,
          });
        } catch (err) {
          log.error('Task cancel failed', { taskId, error: err.message });
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
    }

    // ─── GET /api/projects/:projectId/tasks/:taskId/tool-invocations ─────────────────────
    // Task conversation — messages threaded under the task's threadId. This
    // backs the "💬 View Conversation" panel (ui/public/js/conversation.js),
    // whose only endpoint previously did not exist: the button always landed
    // on the 404 "no conversation" branch.
    const taskConversationMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/conversation$/);
    if (taskConversationMatch && req.method === 'GET') {
      const projectId = decodeURIComponent(taskConversationMatch[1]);
      const taskId = decodeURIComponent(taskConversationMatch[2]);
      const task = taskManager.getTask(projectId, taskId);
      if (!task) { json(res, { error: 'Task not found' }, 404); return true; }
      if (!task.threadId) { json(res, { error: 'Task has no conversation thread' }, 404); return true; }
      const channelId = task.channel || 'general';
      const messages = stateManager.getThreadMessages(projectId, channelId, task.threadId);
      const participants = [...new Set(messages.map(m => m.speaker).filter(Boolean))];
      json(res, {
        taskId,
        threadId: task.threadId,
        channel: channelId,
        messages,
        participants,
        metadata: { turnCount: messages.length },
      });
      return true;
    }

    const toolInvocationsMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/tool-invocations$/);
    if (toolInvocationsMatch && req.method === 'GET') {
      const projectId = decodeURIComponent(toolInvocationsMatch[1]);
      const taskId = decodeURIComponent(toolInvocationsMatch[2]);

      if (!projectId || !taskId) {
        json(res, { error: 'project_id and task_id must be non-empty strings' }, 400);
        return true;
      }

      if (!timelineStore || typeof timelineStore.queryToolInvocationsByTaskId !== 'function') {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      try {
        const invocations = timelineStore.queryToolInvocationsByTaskId(taskId);
        
        json(res, {
          ok: true,
          projectId,
          taskId,
          count: invocations.length,
          invocations,
        });
      } catch (err) {
        log.error('Failed to query tool invocations', { taskId, error: err.message });
        json(res, { error: 'Failed to query tool invocations' }, 500);
      }
      return true;
    }

    // ─── PUT /api/agents/:id/persona ─────────────────────────────
    const agentPersonaMatch = path.match(/^\/api\/agents\/([^/]+)\/persona$/);
    if (agentPersonaMatch && req.method === 'PUT') {
      if (!requireOperatorRole()) return true;
      const agentId = decodeURIComponent(agentPersonaMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }
      handleBody(req, res, body => {
        let content, commitMessage;
        try {
          const parsed = JSON.parse(body);
          content = parsed.content;
          commitMessage = parsed.commitMessage || `autoresearch: update ${agentId} persona`;
          if (typeof content !== 'string' || !content.trim()) {
            json(res, { error: 'content must be a non-empty string' }, 400);
            return;
          }
        } catch (e) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }
        const personaPath = join(process.cwd(), '.synapse', 'agents', agentId, 'persona.md');
        try {
          // Governance may have locked the file 444 — temporarily unlock for write
          if (existsSync(personaPath)) chmodSync(personaPath, 0o644);
          writeFileSync(personaPath, content, 'utf-8');
        } catch (e) {
          respondApiError(res, e, { message: 'Failed to write persona file' });
          return;
        }
        // Git add
        execFile('git', ['-C', process.cwd(), 'add', join('.synapse', 'agents', agentId, 'persona.md')], (addErr) => {
          if (addErr) {
            respondApiError(res, addErr, { message: 'Failed to stage persona file' });
            return;
          }
          // Git commit
          execFile('git', ['-C', process.cwd(), 'commit', '-m', commitMessage], (commitErr, _stdout, _stderr) => {
            if (commitErr) {
              // Exit code 1 with "nothing to commit" is not a real error
              if (_stdout.includes('nothing to commit') || _stderr.includes('nothing to commit') ||
                  _stdout.includes('nothing added') || _stderr.includes('nothing added')) {
                // Content unchanged — still update live agent and sync hash
                agents[agentId].persona = content.trim();
                registerPersonaHash(agentId, content.trim());
                json(res, { ok: true, agentId, committed: false, reason: 'no_change' });
                return;
              }
              respondApiError(res, commitErr, { message: 'Failed to commit persona file' });
              return;
            }
            // Update live agent persona and sync integrity hash
            agents[agentId].persona = content.trim();
            registerPersonaHash(agentId, content.trim());
            const hash = _createHash('sha256').update(content.trim()).digest('hex');
            json(res, { ok: true, agentId, committed: true, hash });
          });
        });
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    if (path === '/api/roles' && req.method === 'GET') {
      // Effective roles = code defaults merged with agents.json overrides.
      // Serving the raw file section returned {} on fresh installs and left
      // the agent-settings Role dropdown empty.
      json(res, getEffectiveRoles());
      return true;
    }

    // Persist an operator settings tune so it survives restart (R2: PATCHes
    // previously mutated in-memory config only). Best-effort — a failed write
    // must not fail the PATCH, but it is logged.
    function persistSettingsSection(section, patch) {
      if (!patch || Object.keys(patch).length === 0) return;
      try {
        saveSettingsOverride(stateManager.synapseDir || '.synapse', section, patch);
      } catch (e) {
        log.warn('Failed to persist settings override — change is live but will revert on restart', { section, error: e.message });
      }
    }

    // ─── API keys (external-harness access) ─────────────────────
    // Scoped bearer keys (syn_*) let external harnesses — Hermes, OpenClaw,
    // scripts — drive the same REST surface the UI uses. Managed here,
    // consumed by the auth layer.
    if (path === '/api/keys' && req.method === 'GET') {
      if (!requireOperatorRole('api_keys_read')) return true;
      if (!auth.apiKeys) { json(res, { error: 'API keys unavailable' }, 503); return true; }
      json(res, auth.apiKeys.list());
      return true;
    }
    if (path === '/api/keys' && req.method === 'POST') {
      if (!requireOperatorRole('api_key_create')) return true;
      if (!auth.apiKeys) { json(res, { error: 'API keys unavailable' }, 503); return true; }
      handleBody(req, res, body => {
        try {
          const { name, role } = JSON.parse(body);
          const { key, record } = auth.apiKeys.create(name, role || 'operator');
          log.info('API key issued', { name: record.name, role: record.role, operator: requestUserId });
          // `key` appears in this response ONLY — never persisted, never
          // logged, never listable again.
          json(res, { key, record }, 201);
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }
    const apiKeyDeleteMatch = path.match(/^\/api\/keys\/([^/]+)$/);
    if (apiKeyDeleteMatch && req.method === 'DELETE') {
      if (!requireOperatorRole('api_key_revoke')) return true;
      if (!auth.apiKeys) { json(res, { error: 'API keys unavailable' }, 503); return true; }
      const ok = auth.apiKeys.revoke(decodeURIComponent(apiKeyDeleteMatch[1]));
      json(res, ok ? { ok: true } : { error: 'Key not found' }, ok ? 200 : 404);
      return true;
    }

    if (path === '/api/settings/pace' && req.method === 'GET') {
      const paceStatus = getPaceGateStatus ? getPaceGateStatus() : {};
      const defaults = {};
      if (config.pace) {
        for (const [prov, val] of Object.entries(config.pace.maxPerProvider || {})) {
          defaults[prov] = val;
        }
      }
      json(res, { pace: paceStatus, defaults, windowMs: config.pace?.windowMs || 3600000, localProviders: [...(config.pace?.localProviders || [])] });
      return true;
    }

    if (path === '/api/settings/pace' && req.method === 'PATCH') {
      if (!requireOperatorRole('settings_pace')) return true;
      handleBody(req, res, body => {
        try {
          const { provider, maxPerWindow } = JSON.parse(body);
          if (!provider || typeof provider !== 'string') { json(res, { error: 'provider required' }, 400); return; }
          if (maxPerWindow !== null && maxPerWindow !== undefined && (typeof maxPerWindow !== 'number' || maxPerWindow < 0)) {
            json(res, { error: 'maxPerWindow must be a non-negative number or null' }, 400); return;
          }
          if (!setPaceOverride) { json(res, { error: 'Pace override not available' }, 503); return; }
          setPaceOverride(provider, maxPerWindow);
          persistSettingsSection('pace', { [provider]: maxPerWindow ?? null });
          log.info('Pace override applied', { provider, maxPerWindow, operator: requestUserId });
          json(res, { ok: true, provider, maxPerWindow });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // ─── Settings: Routing ──────────────────────────────────────
    if (path === '/api/settings/routing' && req.method === 'GET') {
      const r = config.agents?.circuitBreaker ? config.router : (config.router || {});
      // sensitivityThreshold intentionally not exposed — it is not PATCHable
      // and had no UI; costWeight IS both (routing tab row).
      json(res, { enabled: r.enabled, localFirst: r.localFirst, floorWeight: r.floorWeight, costWeight: r.cost_weight });
      return true;
    }
    if (path === '/api/settings/routing' && req.method === 'PATCH') {
      if (!requireOperatorRole('settings_routing')) return true;
      handleBody(req, res, body => {
        try {
          const patch = JSON.parse(body);
          const r = config.router || {};
          // Server-side validation — the UI constrains these ranges but the
          // API must not trust it (a floorWeight of 5 would make the routing
          // floor 500% and break weight normalization).
          if ('enabled' in patch && typeof patch.enabled !== 'boolean') { json(res, { error: 'enabled must be a boolean' }, 400); return; }
          if ('localFirst' in patch && typeof patch.localFirst !== 'boolean') { json(res, { error: 'localFirst must be a boolean' }, 400); return; }
          if ('floorWeight' in patch && (!Number.isFinite(patch.floorWeight) || patch.floorWeight < 0 || patch.floorWeight > 0.5)) {
            json(res, { error: 'floorWeight must be a number between 0 and 0.5' }, 400); return;
          }
          if ('costWeight' in patch && (!Number.isFinite(patch.costWeight) || patch.costWeight < 0 || patch.costWeight > 1)) {
            json(res, { error: 'costWeight must be a number between 0 and 1' }, 400); return;
          }
          const persisted = {};
          if ('enabled' in patch) { r.enabled = patch.enabled; config.router.enabled = patch.enabled; persisted.enabled = patch.enabled; }
          if ('localFirst' in patch) { r.localFirst = patch.localFirst; config.router.localFirst = patch.localFirst; persisted.localFirst = patch.localFirst; }
          if ('floorWeight' in patch) { r.floorWeight = patch.floorWeight; config.router.floorWeight = patch.floorWeight; persisted.floorWeight = patch.floorWeight; }
          if ('costWeight' in patch) { r.cost_weight = patch.costWeight; config.router.cost_weight = patch.costWeight; persisted.cost_weight = patch.costWeight; }
          persistSettingsSection('router', persisted);
          log.info('Routing settings updated', { patch, operator: requestUserId });
          json(res, { ok: true });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // ─── Settings: Circuit Breaker ──────────────────────────────
    if (path === '/api/settings/circuitbreaker' && req.method === 'GET') {
      const cb = config.agents?.circuitBreaker || {};
      json(res, { failureThreshold: cb.failureThreshold, cooldownMs: cb.cooldownMs, maxFailureAgeMs: cb.maxFailureAgeMs });
      return true;
    }
    if (path === '/api/settings/circuitbreaker' && req.method === 'PATCH') {
      if (!requireOperatorRole('settings_cb')) return true;
      handleBody(req, res, body => {
        try {
          const patch = JSON.parse(body);
          const cb = config.agents.circuitBreaker;
          // Reject invalid values instead of silently skipping them — the old
          // guard pattern returned ok:true (and a success toast) while
          // applying nothing.
          if ('failureThreshold' in patch && (!Number.isInteger(patch.failureThreshold) || patch.failureThreshold < 1)) {
            json(res, { error: 'failureThreshold must be an integer >= 1' }, 400); return;
          }
          if ('cooldownMs' in patch && (!Number.isFinite(patch.cooldownMs) || patch.cooldownMs < 1000)) {
            json(res, { error: 'cooldownMs must be a number >= 1000' }, 400); return;
          }
          if ('maxFailureAgeMs' in patch && (!Number.isFinite(patch.maxFailureAgeMs) || patch.maxFailureAgeMs < 0)) {
            json(res, { error: 'maxFailureAgeMs must be a non-negative number' }, 400); return;
          }
          const persisted = {};
          if ('failureThreshold' in patch) { cb.failureThreshold = patch.failureThreshold; persisted.failureThreshold = patch.failureThreshold; }
          if ('cooldownMs' in patch) { cb.cooldownMs = patch.cooldownMs; persisted.cooldownMs = patch.cooldownMs; }
          if ('maxFailureAgeMs' in patch) { cb.maxFailureAgeMs = patch.maxFailureAgeMs; persisted.maxFailureAgeMs = patch.maxFailureAgeMs; }
          // Propagate to the LIVE breaker — it snapshotted these into instance
          // fields at construction, so mutating config alone changed nothing
          // until restart while the UI toasted "saved".
          if (circuitBreaker?.updateSettings) circuitBreaker.updateSettings(persisted);
          persistSettingsSection('circuitBreaker', persisted);
          log.info('Circuit breaker settings updated', { patch, operator: requestUserId });
          json(res, { ok: true });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // ─── Settings: Tasks ────────────────────────────────────────
    if (path === '/api/settings/timezone' && req.method === 'GET') {
      const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const effective = config.time?.timezone || hostZone;
      // Selectable list comes from the host's tzdata (the same tables Ubuntu's
      // own picker uses), so it stays current with the OS package and carries
      // country codes. `source` tells the client which list it got — a
      // silently degraded fallback is how a worse list ships unnoticed.
      const { source: zoneSource, zones } = listTimezones();
      json(res, {
        timezone: config.time?.timezone || null,   // null = following the host
        hostTimezone: hostZone,
        effective,
        zoneSource,
        zones,
        // Rendered so the operator can SEE what the setting means right now
        // rather than having to reason about offsets.
        nowInEffective: new Date().toLocaleString('en-US', { timeZone: effective, timeZoneName: 'short' }),
      });
      return true;
    }
    if (path === '/api/settings/timezone' && req.method === 'PATCH') {
      if (!requireOperatorRole('settings_timezone')) return true;
      handleBody(req, res, body => {
        try {
          const patch = JSON.parse(body);
          if (!('timezone' in patch)) { json(res, { error: 'patch must include timezone' }, 400); return; }
          const tz = patch.timezone;
          // null/'' explicitly means "follow the host zone".
          if (tz !== null && tz !== '') {
            if (typeof tz !== 'string' || !isValidTimezone(tz)) {
              json(res, { error: `invalid timezone: ${tz} (expected an IANA name like America/Los_Angeles, or null to follow the host)` }, 400);
              return;
            }
          }
          const value = tz === '' ? null : tz;
          config.time.timezone = value;
          persistSettingsSection('time', { timezone: value });
          log.info('Timezone setting updated', { timezone: value, operator: requestUserId });
          const effective = value || Intl.DateTimeFormat().resolvedOptions().timeZone;
          json(res, {
            ok: true, timezone: value, effective,
            nowInEffective: new Date().toLocaleString('en-US', { timeZone: effective, timeZoneName: 'short' }),
          });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }
    if (path === '/api/settings/tasks' && req.method === 'GET') {
      const t = config.tasks || {};
      // heartbeatIntervalMs/agentIdlePollMs deliberately not exposed: they are
      // captured at startup and not PATCHable — advertising them here implied
      // an editability that never existed.
      json(res, { pickupSlots: t.pickupSlots, stuckSubtaskTimeoutMs: t.stuckSubtaskTimeoutMs, maxRequeues: t.maxRequeues });
      return true;
    }
    if (path === '/api/settings/tasks' && req.method === 'PATCH') {
      if (!requireOperatorRole('settings_tasks')) return true;
      handleBody(req, res, body => {
        try {
          const patch = JSON.parse(body);
          const t = config.tasks;
          if ('pickupSlots' in patch && (!Number.isInteger(patch.pickupSlots) || patch.pickupSlots < 1 || patch.pickupSlots > 20)) {
            json(res, { error: 'pickupSlots must be an integer 1–20' }, 400); return;
          }
          if ('stuckSubtaskTimeoutMs' in patch && (!Number.isFinite(patch.stuckSubtaskTimeoutMs) || patch.stuckSubtaskTimeoutMs < 60000)) {
            json(res, { error: 'stuckSubtaskTimeoutMs must be a number >= 60000' }, 400); return;
          }
          if ('maxRequeues' in patch && (!Number.isInteger(patch.maxRequeues) || patch.maxRequeues < 0 || patch.maxRequeues > 10)) {
            json(res, { error: 'maxRequeues must be an integer 0–10' }, 400); return;
          }
          const persisted = {};
          if ('pickupSlots' in patch) { t.pickupSlots = patch.pickupSlots; persisted.pickupSlots = patch.pickupSlots; }
          if ('stuckSubtaskTimeoutMs' in patch) { t.stuckSubtaskTimeoutMs = patch.stuckSubtaskTimeoutMs; persisted.stuckSubtaskTimeoutMs = patch.stuckSubtaskTimeoutMs; }
          if ('maxRequeues' in patch) { t.maxRequeues = patch.maxRequeues; persisted.maxRequeues = patch.maxRequeues; }
          persistSettingsSection('tasks', persisted);
          log.info('Task settings updated', { patch, operator: requestUserId });
          json(res, { ok: true });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // ─── Settings: Project Mode ─────────────────────────────────
    const projModeMatch = path.match(/^\/api\/projects\/([^/]+)\/mode$/);
    if (projModeMatch && req.method === 'PATCH') {
      const projId = decodeURIComponent(projModeMatch[1]);
      if (!requireOperatorRole('settings_project_mode', { resourceId: projId })) return true;
      handleBody(req, res, body => {
        try {
          const { mode } = JSON.parse(body);
          if (!['continuous', 'static', 'oneshot'].includes(mode)) { json(res, { error: 'mode must be continuous, static, or oneshot' }, 400); return; }
          const projConfig = stateManager.projects.get(projId);
          if (!projConfig) { json(res, { error: 'Project not found' }, 404); return; }
          projConfig.mode = mode;
          stateManager._saveProjectConfig(projId);
          log.info('Project mode updated', { projId, mode, operator: requestUserId });
          kickStrategist(`mode route: ${projId} → ${mode}`);
          json(res, { ok: true, projectId: projId, mode });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    if (path === '/api/agents/all/pause' && req.method === 'POST') {
      if (!requireOperatorRole('agents_all_pause')) return true;
      handleBody(req, res, async body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const reason = payload.reason || 'Operator initiated all-pause';
          const results = [];
          for (const [agentId, agent] of Object.entries(agents)) {
            // Pause is the user's "stop work everywhere" gate. Apply it to
            // any agent that's still in the pool — only skip 'inactive'
            // (already removed). Use setAgentPaused so the paused flag
            // overlays the underlying _status (matches single-agent /pause
            // path); previously a direct `_status = 'paused'` write here
            // erased 'failed' state so resume couldn't restore it.
            if (agent._status === 'inactive') continue;
            if (isAgentPaused(agentId)) continue;
            try {
              setAgentPaused(agentId, true, reason);
              results.push({ agentId, paused: true });
            } catch (e) {
              log.warn('Failed to pause agent during all-pause', { agentId, error: e.message });
              results.push({ agentId, paused: false, error: 'Agent pause failed' });
            }
          }
          broadcastAgents(agents);
          log.info('All agents paused', { operator: requestUserId, reason, count: results.filter(r => r.paused).length });
          json(res, { ok: true, results });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    if (path === '/api/agents/all/resume' && req.method === 'POST') {
      if (!requireOperatorRole('agents_all_resume')) return true;
      const results = [];
      for (const [agentId, agent] of Object.entries(agents)) {
        if (!isAgentPaused(agentId)) continue;
        try {
          // Clearing the paused flag reveals the underlying _status —
          // a failed agent stays failed, an active agent returns to idle.
          // Previously this set `_status = 'idle'` directly, masking
          // lifecycle state.
          setAgentPaused(agentId, false);
          results.push({ agentId, resumed: true });
        } catch (e) {
          log.warn('Failed to resume agent during all-resume', { agentId, error: e.message });
          results.push({ agentId, resumed: false, error: 'Agent resume failed' });
        }
      }
      broadcastAgents(agents);
      log.info('All agents resumed', { operator: requestUserId, count: results.filter(r => r.resumed).length });
      json(res, { ok: true, results });
      return true;
    }
    if (path === '/api/providers' && req.method === 'GET') {
      // Beta: surface only the harness drivers we've actually wired up. The
      // wrapper-HTTP path (LlamaAgent, GlmAgent) stays in PROVIDERS so
      // existing agents.json entries keep dispatching, but it's not exposed
      // for new agent creation. opencode/aider/goose/plandex/amp/droid are
      // not in this list yet because their agent classes don't exist —
      // adding them later is one PROVIDERS entry plus one line here.
      // BYOH Phase 1+: CREATABLE now includes the existing 4 hardcoded
      // providers PLUS any descriptor in the registry whose
      // identity.mode === 'routable'. Adding a new harness via descriptor
      // automatically exposes it in the create flow. Phase 3 will derive
      // CREATABLE entirely from descriptors after the bespoke 4 migrate.
      const CREATABLE = new Set([
        'claude', 'codex', 'gemini', 'opencode',
        ...DESCRIPTORS
          .filter(d => d.identity?.mode === 'routable')
          .flatMap(d => d.identity?.providers || [d.id]),
      ]);
      // Display-name overrides for provider keys whose internal id misleads.
      // 'ollama'/'llama' are legacy keys for ANY local OpenAI-compatible
      // server (Ollama daemon, llama.cpp, vLLM, LM Studio) reached over the
      // plain /v1 protocol — the serving stack is the user's choice, so the
      // label names the connection type, not one daemon. The internal key
      // stays 'ollama' (load-bearing: routing/governance/GPU caps — see
      // vault/design/byoh-deollama-core-logic-plan.md for the real rename).
      const PROVIDER_DISPLAY = {
        ollama: 'OpenAI-compatible server',
        llama: 'OpenAI-compatible server',
      };
      json(res, Object.keys(PROVIDERS)
        .filter(p => CREATABLE.has(p))
        .map(p => {
          const desc = getDescriptor(p);
          const d = config.agents.defaults[p] || (desc ? { model: desc.defaultModels?.[0], color: '#888' } : null);
          return { id: p, defaultModel: d?.model, defaultColor: d?.color, label: PROVIDER_DISPLAY[p] || desc?.label || p };
        }));
      return true;
    }

    const providerPauseMatch = path.match(/^\/api\/providers\/([^/]+)\/pause$/);
    if (providerPauseMatch && req.method === 'POST') {
      const providerId = decodeURIComponent(providerPauseMatch[1]);
      if (!requireOperatorRole('provider_pause', { resourceId: providerId })) return true;
      handleBody(req, res, async body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const { campaignId: targetCampaignId } = payload;

          // If campaignManager is not available (e.g. mock mode, or orchestrator not fully initialized)
          // then record the intent via mock control and return a 202 Accepted.
          if (!campaignManager || typeof campaignManager.addConstraint !== 'function') {
            const { intentId } = recordIntent('provider_pause', {
              providerId,
              targetCampaignId,
              operatorId: requestUserId || 'system',
              source,
              reason: auditReason,
              correlationId,
              dispatchId,
              traceId,
            });
            json(res, { ok: true, mock: true, intentId, message: 'Campaign manager unavailable, provider pause intent recorded.' }, 202);
            return;
          }

          if (!PROVIDERS[providerId]) {
            json(res, { error: `Provider "${providerId}" not found` }, 404);
            return;
          }

          const agentsToExclude = Object.values(agents)
            .filter(agent => agent.provider === providerId)
            .map(agent => agent.id);

          if (agentsToExclude.length === 0) {
            json(res, { ok: true, message: `No agents found for provider "${providerId}", nothing to pause.` });
            return;
          }

          const operatorId = requestUserId || 'system';
          const affectedCampaigns = [];
          const constraintIds = [];

          let campaignsToList = [];
          if (targetCampaignId) {
            const campaign = campaignManager.getCampaign(null, targetCampaignId);
            if (campaign) {
              campaignsToList.push(campaign);
            } else {
              json(res, { error: `Campaign "${targetCampaignId}" not found` }, 404);
              return;
            }
          } else {
            campaignsToList = campaignManager.listCampaigns(null, 'active');
          }

          for (const campaign of campaignsToList) {
            const constraint = await campaignManager.addConstraint(
              campaign.projectId,
              campaign.id,
              {
                type: 'exclude_agents',
                value: agentsToExclude,
                reason: auditReason || `Provider "${providerId}" paused by operator`,
                source: 'operator_action',
                provider: providerId, // Store provider for easy removal
              },
              operatorId,
              agents,
            );
            constraintIds.push(constraint.id);
            affectedCampaigns.push({ projectId: campaign.projectId, campaignId: campaign.id });
          }

          operatorAuditStore.append({
            action: 'provider_pause',
            providerId,
            operatorId,
            status: 'success',
            decision: 'allow',
            details: `Paused provider "${providerId}" for ${agentsToExclude.length} agents across ${affectedCampaigns.length} campaigns.`,
            affectedCampaigns,
            constraintIds,
            source,
            reason: auditReason,
            correlationId,
            dispatchId,
            traceId,
          });

          broadcast({
            type: 'provider_status_updated',
            providerId,
            status: 'paused',
            by: operatorId,
            affectedCampaigns,
            constraintIds,
          });

          json(res, { ok: true, providerId, status: 'paused', affectedCampaigns, constraintIds });
        } catch (e) {
          log.error('Provider pause failed', { providerId, error: e.message });
          operatorAuditStore.append({
            action: 'provider_pause',
            providerId,
            operatorId: requestUserId || 'system',
            status: 'failure',
            decision: 'deny',
            details: e.message,
          });
          respondApiError(res, e, { status: 400 });
        }
      });
      return true;
    }

    const providerResumeMatch = path.match(/^\/api\/providers\/([^/]+)\/resume$/);
    if (providerResumeMatch && req.method === 'POST') {
      const providerId = decodeURIComponent(providerResumeMatch[1]);
      if (!requireOperatorRole('provider_resume', { resourceId: providerId })) return true;
      handleBody(req, res, async body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const { campaignId: targetCampaignId } = payload;

          // If campaignManager is not available (e.g. mock mode, or orchestrator not fully initialized)
          // then record the intent via mock control and return a 202 Accepted.
          if (!campaignManager || typeof campaignManager.removeConstraint !== 'function') {
            const { intentId } = recordIntent('provider_resume', {
              providerId,
              targetCampaignId,
              operatorId: requestUserId || 'system',
              source,
              reason: auditReason,
              correlationId,
              dispatchId,
              traceId,
            });
            json(res, { ok: true, mock: true, intentId, message: 'Campaign manager unavailable, provider resume intent recorded.' }, 202);
            return;
          }

          if (!PROVIDERS[providerId]) {
            json(res, { error: `Provider "${providerId}" not found` }, 404);
            return;
          }

          const operatorId = requestUserId || 'system';
          const affectedCampaigns = [];
          const removedConstraintIds = [];

          let campaignsToList = [];
          if (targetCampaignId) {
            const campaign = campaignManager.getCampaign(null, targetCampaignId);
            if (campaign) {
              campaignsToList.push(campaign);
            } else {
              json(res, { error: `Campaign "${targetCampaignId}" not found` }, 404);
              return;
            }
          } else {
            campaignsToList = campaignManager.listCampaigns(null, 'active');
          }

          for (const campaign of campaignsToList) {
            const constraints = campaignManager.getActiveConstraints(campaign.projectId, campaign.id);
            const providerConstraints = constraints.filter(c =>
              c.type === 'exclude_agents' && c.source === 'operator_action' && c.provider === providerId
            );

            for (const constraint of providerConstraints) {
              await campaignManager.removeConstraint(campaign.projectId, campaign.id, constraint.id, operatorId);
              removedConstraintIds.push(constraint.id);
            }
            if (providerConstraints.length > 0) {
              affectedCampaigns.push({ projectId: campaign.projectId, campaignId: campaign.id });
            }
          }

          operatorAuditStore.append({
            action: 'provider_resume',
            providerId,
            operatorId,
            status: 'success',
            decision: 'allow',
            details: `Resumed provider "${providerId}" by removing ${removedConstraintIds.length} constraints across ${affectedCampaigns.length} campaigns.`,
            affectedCampaigns,
            removedConstraintIds,
            source,
            reason: auditReason,
            correlationId,
            dispatchId,
            traceId,
          });

          broadcast({
            type: 'provider_status_updated',
            providerId,
            status: 'active',
            by: operatorId,
            affectedCampaigns,
          });

          json(res, { ok: true, providerId, status: 'active', affectedCampaigns, removedConstraintIds });
        } catch (e) {
          log.error('Provider resume failed', { providerId, error: e.message });
          operatorAuditStore.append({
            action: 'provider_resume',
            providerId,
            operatorId: requestUserId || 'system',
            status: 'failure',
            decision: 'deny',
            details: e.message,
          });
          respondApiError(res, e, { status: 400 });
        }
      });
      return true;
    }

    // ─── POST /api/providers/:name/failover ─────────────────────
    const providerFailoverMatch = path.match(/^\/api\/providers\/([^/]+)\/failover$/);
    if (providerFailoverMatch && req.method === 'POST') {
      if (!requireOperatorRole('provider_failover', { action: 'provider_failover' })) return true;
      const providerName = decodeURIComponent(providerFailoverMatch[1]);

      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          // Validate provider exists
          if (!PROVIDERS[providerName]) {
            json(res, { error: `Provider "${providerName}" not found` }, 404);
            return;
          }

          // Find agents using this provider
          const affectedAgents = Object.values(agents).filter(agent => agent.provider === providerName);
          if (affectedAgents.length === 0) {
            json(res, { error: `No agents found using provider "${providerName}"` }, 400);
            return;
          }

          // Get next fallback provider from circuit breaker
          let nextProvider = null;
          if (circuitBreaker && typeof circuitBreaker.getNextFallbackProvider === 'function') {
            nextProvider = circuitBreaker.getNextFallbackProvider(providerName);
          }

          if (!nextProvider) {
            json(res, {
              error: `No fallback provider available for "${providerName}"`,
              details: 'All fallback providers may be unavailable or no fallback chain configured'
            }, 400);
            return;
          }

          // Update each agent's provider in memory
          const agentIds = [];
          for (const agent of affectedAgents) {
            const agentId = Object.keys(agents).find(id => agents[id] === agent);
            if (agentId) {
              agent.provider = nextProvider;
              agentIds.push(agentId);
            }
          }

          // Persist changes to agents.json
          if (saveAgentsConfig && config) {
            try {
              saveAgentsConfig(config);
              log.info('Provider failover persisted to agents.json', {
                from: providerName,
                to: nextProvider,
                agentIds
              });
            } catch (err) {
              log.error('Failed to persist provider failover', { error: err.message });
              // Continue anyway — in-memory state is updated
            }
          }

          // Record operator audit event
          operatorAuditStore.append({
            action: 'provider_failover',
            providerId: providerName,
            operatorId,
            status: 'success',
            decision: 'allow',
            details: `Forced failover from "${providerName}" to "${nextProvider}" for ${agentIds.length} agents`,
            source,
            reason: auditReason || `Forced provider failover by operator ${operatorId}`,
            correlationId,
            dispatchId,
            traceId,
            data: {
              fromProvider: providerName,
              toProvider: nextProvider,
              agentIds,
            },
          });

          // Emit timeline event
          emitOperatorActionTimelineEvent('provider_failover', {
            idempotencyKey: getIdempotencyKey(req, payload),
            operatorId,
            status: 'completed',
            correlationId,
            dispatchId,
            traceId,
            provider: providerName,
            data: {
              action: 'provider_failover',
              fromProvider: providerName,
              toProvider: nextProvider,
              agentIds,
              affectedAgentCount: agentIds.length,
            },
          });

          // Broadcast to WebSocket clients
          broadcast({
            type: 'provider_failover',
            fromProvider: providerName,
            toProvider: nextProvider,
            agentIds,
            by: operatorId,
            reason: auditReason,
            timestamp: new Date().toISOString(),
          });

          json(res, {
            ok: true,
            fromProvider: providerName,
            toProvider: nextProvider,
            agentIds,
            affectedAgentCount: agentIds.length,
          });
        } catch (err) {
          log.error('Provider failover failed', { provider: providerName, error: err.message });
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
    }

    // ─── POST /api/routing/weights ───────────────────────────────
    if (path === '/api/routing/weights' && req.method === 'POST') {
      if (!requireOperatorRole('routing_weight_override', { action: 'routing_weight_override' })) return true;

      if (!weightOverrides) {
        json(res, { error: 'Weight overrides not available' }, 500);
        return true;
      }

      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          // Validate weights payload
          const weights = payload.weights;
          if (!weights || typeof weights !== 'object' || Object.keys(weights).length === 0) {
            json(res, { error: 'weights field required: must be a non-empty object mapping provider names to weights' }, 400);
            return;
          }

          // Validate provider names
          const invalidProviders = Object.keys(weights).filter(provider => !PROVIDERS[provider]);
          if (invalidProviders.length > 0) {
            json(res, {
              error: `Invalid provider names: ${invalidProviders.join(', ')}`,
              validProviders: Object.keys(PROVIDERS),
            }, 400);
            return;
          }

          // Validate weight values (numbers between 0 and 1)
          const values = Object.values(weights);
          const invalidValues = values.filter(w => typeof w !== 'number' || w < 0 || w > 1);
          if (invalidValues.length > 0) {
            json(res, { error: 'All weight values must be numbers between 0 and 1' }, 400);
            return;
          }

          // Validate sum equals approximately 1.0
          const sum = values.reduce((acc, w) => acc + w, 0);
          if (Math.abs(sum - 1.0) > 0.01) {
            json(res, {
              error: `Weight values must sum to 1.0 (got ${sum.toFixed(4)})`,
              hint: 'Adjust weights so they sum to exactly 1.0',
            }, 400);
            return;
          }

          // Apply the weight override
          const metadata = {
            reason: auditReason || `Manual routing weight override by operator ${operatorId}`,
            appliedBy: operatorId,
            source: source || 'api',
            correlationId,
            dispatchId,
            traceId,
          };

          // Add optional TTL if provided
          if (payload.ttlMs && typeof payload.ttlMs === 'number') {
            metadata.ttlMs = payload.ttlMs;
          } else if (payload.ttlMinutes && typeof payload.ttlMinutes === 'number') {
            metadata.ttlMinutes = payload.ttlMinutes;
          }

          weightOverrides.apply(weights, metadata).then(override => {
            // Record operator audit event
            operatorAuditStore.append({
              action: 'routing_weight_override',
              operatorId,
              status: 'success',
              decision: 'allow',
              details: `Applied routing weight override: ${Object.entries(weights).map(([p, w]) => `${p}=${w.toFixed(2)}`).join(', ')}`,
              source,
              reason: metadata.reason,
              correlationId,
              dispatchId,
              traceId,
              data: {
                weights,
                overrideId: override.id,
                appliedAt: override.appliedAt,
                expiresAt: override.expiresAt || null,
              },
            });

            // Emit timeline event
            emitOperatorActionTimelineEvent('routing_weight_override', {
              idempotencyKey: getIdempotencyKey(req, payload),
              operatorId,
              status: 'completed',
              correlationId,
              dispatchId,
              traceId,
              data: {
                action: 'routing_weight_override',
                weights,
                overrideId: override.id,
                appliedAt: override.appliedAt,
                expiresAt: override.expiresAt || null,
              },
            });

            // Broadcast to WebSocket clients
            broadcast({
              type: 'routing_weights_updated',
              weights,
              overrideId: override.id,
              appliedAt: override.appliedAt,
              appliedBy: operatorId,
              reason: metadata.reason,
              expiresAt: override.expiresAt || null,
              timestamp: new Date().toISOString(),
            });

            json(res, {
              ok: true,
              weights,
              overrideId: override.id,
              appliedAt: override.appliedAt,
              appliedBy: operatorId,
              expiresAt: override.expiresAt || null,
            });
          }).catch(err => {
            log.error('Failed to apply routing weight override', { error: err.message, weights });
            operatorAuditStore.append({
              action: 'routing_weight_override',
              operatorId,
              status: 'failure',
              decision: 'deny',
              details: `Failed to apply routing weight override: ${err.message}`,
              source,
              reason: metadata.reason,
              correlationId,
              dispatchId,
              traceId,
              data: { weights, error: err.message },
            });
            respondApiError(res, err, { status: 400, message: 'Failed to apply routing weights' });
          });
        } catch (err) {
          log.error('Routing weight override request failed', { error: err.message });
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
    }

    // --- Project routes ---
    if (path === '/api/projects' && req.method === 'GET') {
      json(res, stateManager.listProjects());
      return true;
    }
    if (path === '/api/projects' && req.method === 'POST') {
      handleBody(req, res, body => {
        try {
          const parsed = JSON.parse(body);
          const { id, displayName, projectDir, channels, mode, firstBuildHold, agents: rosterInput } = parsed;
          if (!id) { json(res, { error: 'id required' }, 400); return; }
          // Roster choice is REQUIRED at creation (operator ruling
          // 2026-08-01): without it the project defaults to ALL agents and
          // any idle agent may claim its work before a later pin lands.
          // Pass null to explicitly mean "all agents".
          if (!('agents' in parsed)) {
            json(res, { error: 'agents roster is required at project creation: pass an agent-id array, a {agents,classes,roles} spec, or null for all agents' }, 400);
            return;
          }
          const unknownRosterIds = collectRosterAgentIds(rosterInput).filter(a => !agents[a]);
          if (unknownRosterIds.length > 0) {
            json(res, { error: `Unknown agent id(s): ${unknownRosterIds.join(', ')}` }, 400);
            return;
          }
          const proj = stateManager.createProject(id, { displayName, projectDir, channels, mode, firstBuildHold, agents: rosterInput });
          json(res, proj, 201);
          broadcast(
            { type: 'project_created', project: stateManager.getProject(id) ? { id, ...proj } : proj },
            requestUserId ? { userId: requestUserId } : {}
          );
          if (events && typeof events.emit === 'function') {
            events.emit('project:created', { projectId: id, displayName, projectDir, mode }).catch(err => {
              log.warn('Event listener failed', { event: 'project:created', projectId: id, error: err.message });
            });
          }
          kickStrategist(`project created: ${id}`);
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // --- Global agent priority (general settings, #105) ---
    // The operator's one-time default rank; per-project agentPriority
    // overrides it (getEffectiveAgentPriority). Lives in the global
    // .synapse/config.json.
    if (path === '/api/settings/agent-priority' && req.method === 'GET') {
      json(res, { agentPriority: stateManager.getGlobalAgentPriority() });
      return true;
    }
    if (path === '/api/settings/agent-priority' && req.method === 'PATCH') {
      if (!requireOperatorRole('global_agent_priority_update')) return true;
      handleBody(req, res, body => {
        try {
          const { agentPriority } = JSON.parse(body);
          if (agentPriority === undefined) {
            json(res, { error: 'body must include agentPriority ({ ranks, strict } or null to clear)' }, 400);
            return;
          }
          if (agentPriority !== null) {
            const rankIds = Array.isArray(agentPriority?.ranks) ? agentPriority.ranks : [];
            const unknown = rankIds.filter(a => typeof a !== 'string' || !agents[a]);
            if (unknown.length > 0) {
              json(res, { error: `agentPriority.ranks contains unknown agent id(s): ${unknown.map(String).join(', ')}` }, 400);
              return;
            }
          }
          const updated = stateManager.setGlobalAgentPriority(agentPriority);
          // COMMIT the write: .synapse/config.json is governance-protected.
          // An uncommitted operator edit differs from the task-start snapshot
          // without being committed-clean, so the per-task integrity check
          // would git-revert it — the exact 2026-06-15 silent-undo class that
          // saveAgentsConfig commits to avoid. Best-effort: non-git installs
          // skip (commitPaths returns false) and the edit persists on disk
          // (untracked installs have no git-revert arm to fear).
          try {
            commitPaths(config.server.projectDir, [join('.synapse', 'config.json')],
              'synapse: operator global agent-priority update via API');
          } catch (commitErr) {
            log.warn('global agent-priority saved but commit failed (edit persists on disk)', { error: commitErr.message });
          }
          broadcast(
            { type: 'settings_updated', agentPriority: updated },
            requestUserId ? { userId: requestUserId } : {}
          );
          json(res, { agentPriority: updated });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // --- Project PATCH (allocation, repoConfig, vision) ---
    const projPatchMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projPatchMatch && req.method === 'PATCH') {
      const projId = projPatchMatch[1];
      // Gate added for parity with /api/projects/:id/mode — this route sets
      // allocation, vision, and repoConfig (incl. github push mode), the
      // highest-privilege project surface.
      if (!requireOperatorRole('project_patch', { projectId: projId })) return true;
      handleBody(req, res, body => {
        try {
          const patch = JSON.parse(body);
          const { allocation, repoConfig, contextConfig, vision, mode, agents: projectAgents, systemInstructions, agentPriority, reviewDeveloperFallback } = patch;
          if (allocation === undefined && repoConfig === undefined && contextConfig === undefined && vision === undefined && mode === undefined && projectAgents === undefined && systemInstructions === undefined && agentPriority === undefined && reviewDeveloperFallback === undefined) {
            json(res, { error: 'patch must include allocation, repoConfig, contextConfig, vision, mode, agents, systemInstructions, agentPriority, or reviewDeveloperFallback' }, 400);
            return;
          }
          const response = {};
          if (projectAgents !== undefined) {
            // Per-project agent roster: null/[] = all agents; legacy id array
            // or full RosterSpec ({ agents, classes, roles }). Unknown agent
            // ids rejected — a typo would silently starve the project.
            const unknown = collectRosterAgentIds(projectAgents).filter(a => !agents[a]);
            if (unknown.length > 0) {
              json(res, { error: `Unknown agent id(s): ${unknown.join(', ')}` }, 400);
              return;
            }
            const updatedAgents = stateManager.setProjectAgents(projId, projectAgents);
            response.agents = updatedAgents.agents;
            // #105 follow-up: a roster edit can ORPHAN entries of this
            // project's priority rank. Non-strict orphans are inert (never
            // match); a STRICT rank whose ranked agents are all off-roster
            // makes the project's work defer indefinitely. The roster is the
            // primary surface, so the edit is ACCEPTED — but the response
            // warns, naming the orphans, and flags the strict stall loudly.
            // (No auto-pruning: silently rewriting the operator's rank config
            // would trade a visible warning for an invisible behavior change.)
            const projPriority = stateManager.getProjectAgentPriority?.(projId);
            if (projPriority) {
              const newSpec = stateManager.getProject(projId)?.agents;
              const orphaned = projPriority.ranks.filter(rid =>
                newSpec && !rosterAllowsAgentAnyRole(newSpec, rid, agents[rid]));
              if (orphaned.length > 0) {
                const allOrphaned = orphaned.length === projPriority.ranks.length;
                response.agentPriorityWarning = {
                  orphanedRanks: orphaned,
                  strict: projPriority.strict,
                  detail: projPriority.strict && allOrphaned
                    ? `STRICT priority rank is fully off-roster (${orphaned.join(', ')}) — this project's work will DEFER until the rank or roster is fixed.`
                    : `Priority rank entries no longer on the roster: ${orphaned.join(', ')} (inert until re-added or re-ranked).`,
                };
                log.warn('Roster edit orphaned priority rank entries', {
                  projectId: projId, orphaned, strict: projPriority.strict, allOrphaned,
                });
              }
            }
            broadcast(
              { type: 'project_updated', projectId: projId, agents: updatedAgents.agents },
              requestUserId ? { userId: requestUserId } : {}
            );
          }
          if (mode !== undefined) {
            // 'continuous' = strategist builds campaigns from the vision;
            // 'static' = manual campaigns only. setProjectMode validates.
            const updatedMode = stateManager.setProjectMode(projId, mode);
            response.mode = updatedMode.mode;
            broadcast(
              { type: 'project_updated', projectId: projId, mode: updatedMode.mode },
              requestUserId ? { userId: requestUserId } : {}
            );
            kickStrategist(`mode change: ${projId} → ${updatedMode.mode}`);
          }
          if (allocation !== undefined) {
            // No Number() coercion: JSON.stringify turns a NaN (blank UI
            // field) into null, and Number(null) is 0 — which would silently
            // zero the project's allocation instead of erroring.
            if (typeof allocation !== 'number') {
              json(res, { error: 'allocation must be a number 0–100' }, 400);
              return;
            }
            const priorAllocation = stateManager.getProject?.(projId)?.allocation;
            const updated = stateManager.setProjectAllocation(projId, allocation);
            response.allocation = updated.allocation;
            broadcast(
              { type: 'project_updated', projectId: projId, allocation: updated.allocation },
              requestUserId ? { userId: requestUserId } : {}
            );
            // Un-pausing a project (0 → >0) must not wait for the next
            // strategist tick — a paused project whose vision was set while
            // Off sat in dead air for up to a full tick interval after the
            // operator hit 100% (settings-pass finding F7; same dead-air
            // class as the post-wizard kick, b83c0aa7).
            if (allocation > 0 && (priorAllocation === 0 || priorAllocation === undefined)) {
              kickStrategist(`allocation unpaused: ${projId} → ${allocation}%`);
            }
          }
          if (repoConfig !== undefined) {
            const updatedRepo = stateManager.setProjectRepoConfig(projId, repoConfig);
            response.repoConfig = updatedRepo;
            broadcast(
              { type: 'project_updated', projectId: projId, repoConfig: updatedRepo },
              requestUserId ? { userId: requestUserId } : {}
            );
          }
          if (contextConfig !== undefined) {
            // Which context layers this project uses (vault / memory / resume).
            //
            // Same gate as the rest of this route: requireOperatorRole above.
            // That is the boundary the design asks for -- an EXTERNAL caller
            // holding an operator-roled API key may set this (the operator's
            // UI, or an external agent driving the REST API), while an agent
            // Synapse itself dispatched cannot, because it holds no Synapse
            // credential at all: keys live in a file-backed store (auth.js:103)
            // rather than the environment, and sandbox.js's first env-deny
            // pattern is /^SYNAPSE_AUTH/i.
            //
            // Without this branch the field was unreachable except by
            // hand-editing .synapse/projects/<id>/config.json -- declared but
            // unsettable, which is the same primed-but-never-fired shape the
            // rest of this audit kept finding.
            const updatedCtx = stateManager.setProjectContextConfig(projId, contextConfig);
            response.contextConfig = updatedCtx;
            broadcast(
              { type: 'project_updated', projectId: projId, contextConfig: updatedCtx },
              requestUserId ? { userId: requestUserId } : {}
            );
          }
          if (systemInstructions !== undefined) {
            // Project-wide prompt instructions (context.js injects them for
            // every agent on the project). Same requireOperatorRole gate as
            // the rest of this route; the field was readable-but-unsettable
            // (#86, same primed-but-never-fired shape as contextConfig was).
            // null / '' clears; setter enforces string + 4000-char cap.
            const updatedInstructions = stateManager.setProjectSystemInstructions(projId, systemInstructions);
            response.systemInstructions = updatedInstructions;
            broadcast(
              { type: 'project_updated', projectId: projId, systemInstructions: updatedInstructions },
              requestUserId ? { userId: requestUserId } : {}
            );
          }
          if (agentPriority !== undefined) {
            // #105 per-project agent priority (vault/design/project-agent-priority.md):
            // ordered ranks + strict, overriding the global default. null clears
            // (falls back to global, NOT legacy — see getEffectiveAgentPriority).
            // Unknown ids rejected like the roster branch above: a typo'd rank
            // silently never matching would be invisible. Roster-subset check
            // uses the CURRENT roster; later roster edits can strand a strict
            // rank (recorded ledger follow-up, not silently prevented here).
            if (agentPriority !== null) {
              const rankIds = Array.isArray(agentPriority?.ranks) ? agentPriority.ranks : [];
              const unknown = rankIds.filter(a => typeof a !== 'string' || !agents[a]);
              if (unknown.length > 0) {
                json(res, { error: `agentPriority.ranks contains unknown agent id(s): ${unknown.map(String).join(', ')}` }, 400);
                return;
              }
              const rosterSpec = stateManager.getProject(projId)?.agents;
              if (rosterSpec) {
                const offRoster = rankIds.filter(a => !rosterAllowsAgentAnyRole(rosterSpec, a, agents[a]));
                if (offRoster.length > 0) {
                  json(res, { error: `agentPriority.ranks contains agent(s) not on the project roster: ${offRoster.join(', ')}` }, 400);
                  return;
                }
              }
            }
            const updatedPriority = stateManager.setProjectAgentPriority(projId, agentPriority);
            response.agentPriority = updatedPriority;
            broadcast(
              { type: 'project_updated', projectId: projId, agentPriority: updatedPriority },
              requestUserId ? { userId: requestUserId } : {}
            );
          }
          if (reviewDeveloperFallback !== undefined) {
            // Operator ruling 2026-08-15: developers never review unless the
            // project opts in; then only when no reviewer/architect is available.
            if (reviewDeveloperFallback !== null && typeof reviewDeveloperFallback !== 'boolean') {
              json(res, { error: 'reviewDeveloperFallback must be a boolean or null' }, 400);
              return;
            }
            const updatedFallback = stateManager.setProjectReviewDeveloperFallback(projId, reviewDeveloperFallback);
            response.reviewDeveloperFallback = updatedFallback;
            broadcast(
              { type: 'project_updated', projectId: projId, reviewDeveloperFallback: updatedFallback },
              requestUserId ? { userId: requestUserId } : {}
            );
          }
          if (vision !== undefined) {
            if (typeof vision !== 'string') {
              json(res, { error: 'vision must be a string' }, 400);
              return;
            }
            stateManager.setProjectVision(projId, vision, { source: 'user' });
            response.vision = vision;
            broadcast(
              { type: 'project_updated', projectId: projId, vision },
              requestUserId ? { userId: requestUserId } : {}
            );
            kickStrategist(`vision set: ${projId}`);
          }
          json(res, response);
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // --- Channel routes ---
    const chListMatch = path.match(/^\/api\/projects\/([^/]+)\/channels$/);
    if (chListMatch && req.method === 'GET') {
      json(res, stateManager.listChannels(chListMatch[1]));
      return true;
    }
    if (chListMatch && req.method === 'POST') {
      handleBody(req, res, body => {
        try {
          const { id: channelId } = JSON.parse(body);
          if (!channelId) { json(res, { error: 'id required' }, 400); return; }
          stateManager.createChannel(chListMatch[1], channelId);
          json(res, { ok: true }, 201);
          broadcast(
            { type: 'channel_created', project: chListMatch[1], channel: channelId },
            requestUserId ? { userId: requestUserId } : {}
          );
          if (events && typeof events.emit === 'function') {
            events.emit('channel:created', { projectId: chListMatch[1], channelId }).catch(err => {
              log.warn('Event listener failed', { event: 'channel:created', projectId: chListMatch[1], channelId, error: err.message });
            });
          }
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }
    const chDeleteMatch = path.match(/^\/api\/projects\/([^/]+)\/channels\/([^/]+)$/);
    if (chDeleteMatch && req.method === 'DELETE') {
      try {
        const deleted = stateManager.deleteChannel(chDeleteMatch[1], chDeleteMatch[2]);
        if (deleted) {
          json(res, { ok: true });
          broadcast(
            { type: 'channels_updated', project: chDeleteMatch[1], channels: stateManager.listChannels(chDeleteMatch[1]) },
            requestUserId ? { userId: requestUserId } : {}
          );
        } else { json(res, { error: 'Channel not found' }, 404); }
      } catch (e) { respondApiError(res, e, { status: 400 }); }
      return true;
    }

    // --- Messages & threads ---
    const msgMatch = path.match(/^\/api\/projects\/([^/]+)\/channels\/([^/]+)\/messages$/);
    if (msgMatch && req.method === 'GET') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || config.orchestrator.apiDefaultLimit, 1), 500);
      const threadId = url.searchParams.get('threadId');
      json(res, threadId
        ? stateManager.getThreadMessages(msgMatch[1], msgMatch[2], threadId, limit)
        : stateManager.getMessages(msgMatch[1], msgMatch[2], limit));
      return true;
    }
    const threadsMatch = path.match(/^\/api\/projects\/([^/]+)\/threads$/);
    if (threadsMatch && req.method === 'GET') {
      const channelFilter = url.searchParams.get('channel');
      const data = stateManager.loadThreads(threadsMatch[1]);
      let threads = Object.values(data.threads);
      if (channelFilter) threads = threads.filter(t => t.channel === channelFilter);
      json(res, threads);
      return true;
    }

    // --- SSE Operator Stream ---
    if (path === '/api/operator/stream' && req.method === 'GET') {
      // Handle Last-Event-ID for replay on reconnect
      const lastEventId = req.headers['last-event-id'] || '0';
      
      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });

      // Register this SSE client
      const clientId = sseRegistry.registerClient(res, requestUserId);
      log.info('SSE operator stream connected', { clientId, userId: requestUserId, lastEventId });

      // Handle client disconnect
      res.on('close', () => {
        sseRegistry.unregisterClient(res);
        log.info('SSE operator stream disconnected', { clientId });
      });

      // Replay missed events if reconnecting
      if (lastEventId !== '0' && lastEventId !== 'undefined') {
        const replayPromise = sseRegistry.getEventsForReplay(lastEventId, timelineStore)
          .then(replayEvents => {
            for (const event of replayEvents) {
              const sseEvent = transformTimelineEventToSse(event);
              if (sseEvent) {
                res.write(formatSseEvent(sseEvent));
              }
            }
            log.debug('SSE events replayed', { clientId, count: replayEvents.length });
          })
          .catch(err => {
            log.warn('SSE replay failed', { clientId, error: err.message });
          });
      }

      // Subscribe to relevant events
      const subscriptions = [];

      // Subscribe to health:agents_updated from health-aggregator
      if (deps.events) {
        const healthHandler = (data) => {
          const sseEvent = transformHealthDataToSse(data);
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        deps.events.on('health:agents_updated', healthHandler);
        subscriptions.push(() => deps.events.off('health:agents_updated', healthHandler));
      }

      // Subscribe to circuit breaker state changes
      if (deps.events) {
        const cbHandler = (data) => {
          const sseEvent = transformCircuitBreakerEventToSse(data);
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        deps.events.on('circuit_breaker:open', cbHandler);
        deps.events.on('circuit_breaker:half_open', cbHandler);
        deps.events.on('circuit_breaker:closed', cbHandler);
        subscriptions.push(() => {
          deps.events.off('circuit_breaker:open', cbHandler);
          deps.events.off('circuit_breaker:half_open', cbHandler);
          deps.events.off('circuit_breaker:closed', cbHandler);
        });
      }

      // Subscribe to rate limit events
      if (deps.events) {
        const rateLimitHandler = (data) => {
          const sseEvent = transformRateLimitEventToSse(data);
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        deps.events.on('rate_limited', rateLimitHandler);
        subscriptions.push(() => deps.events.off('rate_limited', rateLimitHandler));
      }

      // Subscribe to operator actions
      if (deps.events) {
        const operatorHandler = (data) => {
          const sseEvent = transformTimelineEventToSse({
            ...data,
            type: 'operator_action',
          });
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        deps.events.on('operator:action', operatorHandler);
        subscriptions.push(() => deps.events.off('operator:action', operatorHandler));
      }

      // Subscribe to dispatch decisions
      if (deps.events) {
        const dispatchHandler = (data) => {
          const sseEvent = transformDispatchDecisionToSse(data);
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        deps.events.on('dispatch:decision', dispatchHandler);
        subscriptions.push(() => deps.events.off('dispatch:decision', dispatchHandler));
      }

      // Subscribe to task updates
      if (deps.events) {
        const taskHandler = (data) => {
          const sseEvent = transformTaskUpdateToSse(data);
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        deps.events.on('task:updated', taskHandler);
        subscriptions.push(() => deps.events.off('task:updated', taskHandler));
      }

      // Subscribe to steering events (specific types, not wildcards)
      if (deps.events) {
        const steeringHandler = (data) => {
          const sseEvent = transformTimelineEventToSse({
            ...data,
            type: 'operator_action',
          });
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        // Subscribe to specific steering event types
        deps.events.on('steering:replay', steeringHandler);
        deps.events.on('steering:weight_override', steeringHandler);
        deps.events.on('steering:circuit_breaker_hold', steeringHandler);
        deps.events.on('steering:cb_reset', steeringHandler);
        deps.events.on('steering:alert_ack', steeringHandler);
        subscriptions.push(() => {
          deps.events.off('steering:replay', steeringHandler);
          deps.events.off('steering:weight_override', steeringHandler);
          deps.events.off('steering:circuit_breaker_hold', steeringHandler);
          deps.events.off('steering:cb_reset', steeringHandler);
          deps.events.off('steering:alert_ack', steeringHandler);
        });
      }

      // Subscribe to timeline insertions for audit events
      if (timelineStore && typeof timelineStore.on === 'function') {
        const timelineHandler = (event) => {
          const sseEvent = transformTimelineEventToSse(event);
          if (sseEvent) {
            sseRegistry.broadcast(sseEvent);
          }
        };
        timelineStore.on('insert', timelineHandler);
        subscriptions.push(() => timelineStore.off('insert', timelineHandler));
      }

      // Send initial connection event
      res.write(`event: connected\ndata: {"clientId":"${clientId}","timestamp":"${new Date().toISOString()}"}\n\n`);

      // Set up keepalive interval (every 15 seconds to prevent proxy disconnection)
      const keepaliveInterval = setInterval(() => {
        sseRegistry.sendKeepalive();
      }, 15000);

      // Log connection stats periodically
      const statsInterval = setInterval(() => {
        const stats = sseRegistry.getStats();
        log.debug('SSE connection stats', { ...stats, clientId });
      }, 60000);

      // Cleanup on response close
      res.on('close', () => {
        clearInterval(keepaliveInterval);
        clearInterval(statsInterval);
        for (const unsubscribe of subscriptions) {
          try { unsubscribe(); } catch (err) { /* ignore */ }
        }
      });

      log.info('SSE operator stream ready', { clientId, lastEventId });
      return true; // Request handled
    }

    // --- Vault Health ---
    if (path.startsWith('/api/vault/health') && req.method === 'GET') {
      if (!vaultWriter) {
        json(res, { enabled: false });
        return true;
      }
      const projects = stateManager.listProjects();
      const result = { enabled: true, projects: {} };
      for (const p of projects) {
        const pid = p.id || p;
        result.projects[pid] = vaultWriter.getHealth(pid);
      }
      json(res, result);
      return true;
    }

    // --- Vault Impact ---
    if (path === '/api/vault/impact' && req.method === 'GET') {
      const projects = stateManager.listProjects();
      const impact = { withVault: { total: 0, passed: 0, failed: 0 }, withoutVault: { total: 0, passed: 0, failed: 0 } };
      for (const p of projects) {
        const pid = p.id || p;
        const data = taskManager.load(pid);
        if (!data?.tasks) continue;
        for (const task of data.tasks) {
          if (!task.subtasks) continue;
          for (const st of task.subtasks) {
            if (st.status !== 'done' && st.status !== 'failed') continue;
            // Only count subtasks that went through review (suggestedRole=implementer with a review verdict on the parent task)
            const bucket = st.meta?.vaultInjected ? impact.withVault : impact.withoutVault;
            bucket.total++;
            // A subtask "passed" if it completed without being part of a fix cycle
            if (st.status === 'done' && (st.retryCount || 0) === 0) bucket.passed++;
            else bucket.failed++;
          }
        }
      }
      const withRate = impact.withVault.total > 0 ? Math.round(impact.withVault.passed / impact.withVault.total * 100) : null;
      const withoutRate = impact.withoutVault.total > 0 ? Math.round(impact.withoutVault.passed / impact.withoutVault.total * 100) : null;
      json(res, { ...impact, withVaultPassRate: withRate, withoutVaultPassRate: withoutRate });
      return true;
    }

    // --- MCP Server Endpoint (Streamable HTTP) ---
    if (path === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      if (req.method === 'DELETE') {
        const sid = req.headers['mcp-session-id'];
        if (sid) mcpServer.sessionDelete?.(sid);
        res.writeHead(204);
        res.end();
        return true;
      }
      mcpServer.handleRequest(req, res);
      return true;
    }

    // --- Health ---
    if (path === '/api/health' && req.method === 'GET') {
      // Use centralized health aggregator for consistent health data
      const healthData = aggregateHealthData({
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
      });

      // Add legacy fields for backward compatibility and additional features
      const agentStatusesWithProvider = {};
      for (const [name, agent] of Object.entries(agents)) {
        const paused = isAgentPaused(name);
        agentStatusesWithProvider[name] = {
          ...healthData.agents[name],
          // Overlay the pause flag on BOTH status fields — the UI's
          // Pause All/Resume All sync and the ready-counter read `status`,
          // and only `_status` carried the overlay, so the header button
          // never flipped and "X ready" went stale after pause/resume
          // (settings-pass finding F8).
          status: paused ? 'paused' : (healthData.agents[name]?.status ?? agent._status ?? 'active'),
          _status: paused ? 'paused' : (agent._status || 'active'),
          provider: agent.provider,
          role: agent.role || null,
          // Surface intro/validation failure detail so the badge title can
          // tell the user *why* an agent is failed instead of just "failed".
          lastValidationError: agent.lastValidationError || null,
        };
      }
      healthData.agents = agentStatusesWithProvider;

      // Add pace gate status if available
      if (getPaceGateStatus) {
        healthData.pace = getPaceGateStatus();
      }

      // Add anomaly alerts if available
      if (anomalyDetector) {
        healthData.anomalyAlerts = anomalyDetector.getActiveAlerts();
      }

      // Add task metrics if available
      if (taskManager && stateManager) {
        let activeTasks = 0;
        for (const proj of stateManager.listProjects()) {
          const pid = proj.id || proj;
          const tasks = taskManager.listTasks(pid);
          activeTasks += tasks.filter(t => ['planning', 'executing', 'reviewing'].includes(t.status)).length;
        }
        healthData.metrics.activeTasks = activeTasks;
        healthData.metrics.queueDepth = [...turnQueues.values()].reduce((sum, q) => sum + (q.length || 0), 0);
      }

      // Add tracing configuration
      if (config?.tracing) {
        healthData.tracing = {
          enabled: config.tracing.enabled,
          endpoint: config.tracing.endpoint,
        };
      }

      // Rename circuitBreakers to circuitBreaker for backward compatibility
      healthData.circuitBreaker = healthData.circuitBreakers;
      delete healthData.circuitBreakers;

      json(res, healthData);
      return true;
    }

    // --- Harness detection (first-agent onboarding) ---
    // Which coding-agent CLIs are installed on this host, straight from the
    // registry's binaries/knownPaths. Enriched with each harness's providers
    // and suggested models so the wizard can guide first-agent creation.
    if (path === '/api/onboarding/project-templates' && req.method === 'GET') {
      json(res, { templates: ONBOARDING_TEMPLATES });
      return true;
    }

    // Live model list for one harness — asks the harness itself when it has
    // a list command (opencode models / pi --list-models); otherwise serves
    // the descriptor's static defaults. Source is reported so the UI can be
    // honest about which it is showing.
    const harnessModelsMatch = path.match(/^\/api\/harnesses\/([^/]+)\/models$/);
    if (harnessModelsMatch && req.method === 'GET') {
      const hid = decodeURIComponent(harnessModelsMatch[1]);
      try {
        const queried = queryHarnessModels(hid);
        if (queried) { json(res, queried); return true; }
        const cat = HARNESSES.find(h => h.id === hid);
        const desc = getDescriptor(hid);
        const statics = (desc?.defaultModels?.length ? desc.defaultModels : cat?.defaultModels) || [];
        json(res, { models: statics, source: 'static' });
      } catch (err) {
        respondApiError(res, err);
      }
      return true;
    }

    if (path === '/api/harnesses/detected' && req.method === 'GET') {
      try {
        // Scan each harness's OWN config files (models/providers/auth
        // presence — never secret values) so onboarding can offer agents
        // built from the exact identifiers the harness resolves, instead
        // of asking the user to hand-type model strings.
        const scan = scanHarnessConfigs();
        // Detection-catalog ids differ from provider ids for two harnesses
        // (stub ids 'claudecode'/'gemini-cli' vs providers 'claude'/'gemini')
        // — without this alias their scans and offers silently never match.
        const CATALOG_ALIAS = { claudecode: 'claude', 'gemini-cli': 'gemini' };
        const detected = detectAllHarnesses().map(d => {
          const key = CATALOG_ALIAS[d.id] || d.id;
          const cat = HARNESSES.find(h => h.id === d.id) || {};
          const cfg = scan[key] || {};
          const offers = [];
          if (d.found) {
            const defaults = config.agents.defaults || {};
            if (key === 'claude' && cfg.authenticated) {
              offers.push({ provider: 'claude', model: defaults.claude?.model, why: 'authenticated' });
            } else if (key === 'codex' && cfg.authenticated) {
              offers.push({ provider: 'codex', model: cfg.configuredModels?.[0]?.model || defaults.codex?.model, why: cfg.configuredModels?.[0] ? 'from ~/.codex/config.toml' : 'authenticated' });
            } else if (key === 'gemini' && cfg.authenticated) {
              offers.push({ provider: 'gemini', model: defaults.gemini?.model, why: 'authenticated' });
            } else if (key === 'opencode') {
              for (const m of cfg.configuredModels || []) {
                offers.push({ provider: m.model.startsWith('zai') ? 'glm' : 'opencode', model: m.model, why: `from ${m.source}` });
              }
              if ((cfg.authenticatedProviders || []).includes('zai-coding-plan')
                  && !offers.some(o => o.model?.startsWith('zai'))) {
                offers.push({ provider: 'glm', model: defaults.glm?.model, why: 'zai-coding-plan authenticated' });
              }
            } else if (key === 'pi') {
              for (const m of cfg.configuredModels || []) {
                offers.push({ provider: 'pi', model: m.model, why: `from ${m.source}` });
              }
            } else if (key === 'omp' && cfg.ompInstalled) {
              for (const m of cfg.configuredModels || []) {
                offers.push({ provider: 'omp', model: m.model, why: 'oh-my-pi installed' });
              }
            }
          }
          return {
            ...d,
            providers: cat.providers || [],
            defaultModels: cat.defaultModels || [],
            authenticated: cfg.authenticated,
            authenticatedProviders: cfg.authenticatedProviders,
            ompInstalled: cfg.ompInstalled,
            offers: offers.filter(o => o.model),
          };
        });
        json(res, { harnesses: detected });
      } catch (err) {
        respondApiError(res, err);
      }
      return true;
    }

    // --- MCP Connections Health ---
    if (path === '/api/mcp/connections' && req.method === 'GET') {
      if (!mcpConnectionManager) {
        json(res, { error: 'MCP connection manager not initialized' }, 503);
        return true;
      }
      const connections = mcpConnectionManager.getStates();
      json(res, { connections });
      return true;
    }

    // --- MCP Manual Reconnect ---
    // Revives a server that exhausted its automatic reconnect budget
    // (status 'error' + open circuit) without restarting Synapse.
    {
      const reconnectMatch = path.match(/^\/api\/mcp\/connections\/([^/]+)\/reconnect$/);
      if (reconnectMatch && req.method === 'POST') {
        if (!requireOperatorRole('mcp_reconnect')) return true;
        if (!mcpConnectionManager) {
          json(res, { error: 'MCP connection manager not initialized' }, 503);
          return true;
        }
        const serverId = decodeURIComponent(reconnectMatch[1]);
        mcpConnectionManager.reconnect(serverId).then(() => {
          json(res, { ok: true, serverId, status: 'connected' });
        }).catch(err => {
          const notFound = /Server not found/.test(err.message);
          respondApiError(res, err, {
            status: notFound ? 404 : 502,
            message: notFound ? 'MCP server not found' : 'MCP server reconnect failed',
            response: { serverId },
          });
        });
        return true;
      }
    }

    // --- Tool Catalog ---
    if (path === '/api/tools' && req.method === 'GET') {
      if (!toolRegistry) {
        json(res, { error: 'Tool registry not initialized' }, 503);
        return true;
      }

      try {
        const filters = {};
        const source = url.searchParams.get('source');
        const approvalState = url.searchParams.get('approval_state');

        if (source) {
          filters.source = source;
        }
        if (approvalState) {
          filters.approval_state = approvalState;
        }

        const tools = toolRegistry.listTools(filters);
        json(res, { tools });
      } catch (err) {
        log.error('Failed to list tools', { error: err.message });
        json(res, { error: 'Failed to retrieve tool catalog' }, 500);
      }
      return true;
    }

    // --- Tool Details by Name ---
    if (path.startsWith('/api/tools/') && req.method === 'GET') {
      if (!toolRegistry) {
        json(res, { error: 'Tool registry not initialized' }, 503);
        return true;
      }

      const toolName = path.substring('/api/tools/'.length);
      if (!toolName) {
        json(res, { error: 'Tool name is required' }, 400);
        return true;
      }

      try {
        const tool = toolRegistry.getToolByName(toolName);
        if (!tool) {
          json(res, { error: `Tool not found: ${toolName}` }, 404);
          return true;
        }
        json(res, { tool });
      } catch (err) {
        log.error('Failed to get tool', { toolName, error: err.message });
        json(res, { error: 'Failed to retrieve tool' }, 500);
      }
      return true;
    }

    // --- Agent Tools (RBAC-filtered) ---
    if (path.startsWith('/api/agents/') && path.endsWith('/tools') && req.method === 'GET') {
      if (!toolDistributionService) {
        json(res, { error: 'Tool distribution service not initialized' }, 503);
        return true;
      }

      const agentId = path.substring('/api/agents/'.length, path.length - '/tools'.length);
      if (!agentId) {
        json(res, { error: 'Agent ID is required' }, 400);
        return true;
      }

      try {
        const toolsMap = toolDistributionService.getDistributedTools(agentId);
        if (!toolsMap || toolsMap.size === 0) {
          // Check if agent exists
          const agent = agents && agents[agentId];
          if (!agent) {
            json(res, { error: `Agent not found: ${agentId}` }, 404);
            return true;
          }
        }

        // Convert Map to array
        const tools = Array.from(toolsMap.values());
        json(res, { agentId, tools });
      } catch (err) {
        log.error('Failed to get agent tools', { agentId, error: err.message });
        json(res, { error: 'Failed to retrieve agent tools' }, 500);
      }
      return true;
    }

    // --- Tool Invocation ---
    // POST /api/tools/invoke - Invoke MCP tools on behalf of agents
    // Error codes:
    //   VALIDATION_FAILED (400) - Missing or invalid agentId/toolName/arguments
    //   TOOL_NOT_FOUND (404) - Tool not available for agent
    //   INVALID_SOURCE (502) - Tool source is invalid or malformed
    //   CONNECTION_ERROR (502) - Connection error during invocation
    //   SERVER_NOT_CONNECTED (503) - MCP server not connected
    //   CIRCUIT_OPEN (503) - Circuit breaker is open for this tool
    //   SERVICE_UNAVAILABLE (503) - Tool distribution service not available
    //   TIMEOUT (504) - Tool invocation timed out
    //   INVOCATION_FAILED (500) - Tool invocation failed (generic)
    //   INVOCATION_ERROR (500) - Unexpected error during invocation
    //   TOOL_ERROR (500) - Tool execution error
    //   INVALID_REQUEST (400) - Request parsing or processing failed
    //   NOT_IMPLEMENTED (501) - Native tool invocation not supported
    if (path === '/api/tools/invoke' && req.method === 'POST') {
      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { agentId, toolName, arguments: toolArgs } = payload;

          // Validate required fields
          if (!agentId || typeof agentId !== 'string') {
            json(res, {
              status: 'error',
              code: 'VALIDATION_FAILED',
              message: 'agentId is required and must be a string'
            }, 400);
            return;
          }

          if (!toolName || typeof toolName !== 'string') {
            json(res, {
              status: 'error',
              code: 'VALIDATION_FAILED',
              message: 'toolName is required and must be a string'
            }, 400);
            return;
          }

          // Normalize null/undefined arguments to empty object
          const args = (toolArgs == null) ? {} : toolArgs;

          log.debug({ agentId, toolName, args }, 'Tool invocation request');

          // Check if tool distribution service is available
          if (!toolDistributionService) {
            json(res, {
              status: 'error',
              code: 'SERVICE_UNAVAILABLE',
              message: 'Tool distribution service not available'
            }, 503);
            return;
          }

          // Check if tool is available for this agent
          const toolDef = toolDistributionService.getToolForAgent(agentId, toolName);
          if (!toolDef) {
            json(res, {
              status: 'error',
              code: 'TOOL_NOT_FOUND',
              message: `Tool not available for agent: ${toolName}`
            }, 404);
            return;
          }

          // Detect MCP tools by source metadata (format: "mcp:{serverName}")
          const source = toolDef.source;
          if (source && source.startsWith('mcp:')) {
            // Route MCP tools through ToolDistributionService.invokeTool
            // This handles permission checks, parameter validation, and invocation
            toolDistributionService.invokeTool(agentId, toolName, args)
              .then(result => {
                // Check if result is an error (can be returned, not thrown)
                if (result.status === 'error' || result.error) {
                  // Map error code to appropriate HTTP status
                  const errorCode = result.code || 'INVOCATION_FAILED';
                  let httpStatus = 500; // Default to internal server error

                  // Map specific error codes to HTTP status codes
                  //
                  // src/mcp/parameter-validator.js emits FIVE codes, not just
                  // VALIDATION_FAILED: MISSING_REQUIRED_PARAMS, TYPE_MISMATCH,
                  // FORMAT_ERROR and INVALID_TOOL_SCHEMA as well. Only the
                  // generic one was mapped, so a caller who omitted a required
                  // parameter got 500 "internal server error" for what is
                  // plainly a malformed request — inviting a retry that can
                  // never succeed, and charging the server for the client's
                  // mistake. The first three are all about the CALLER's
                  // arguments and belong in 4xx.
                  //
                  // INVALID_TOOL_SCHEMA deliberately stays 500: that one means
                  // the REGISTERED TOOL's schema is broken, which is a
                  // server-side configuration fault, not the caller's.
                  if (errorCode === 'VALIDATION_FAILED'
                    || errorCode === 'MISSING_REQUIRED_PARAMS'
                    || errorCode === 'TYPE_MISMATCH'
                    || errorCode === 'FORMAT_ERROR') {
                    httpStatus = 400; // Bad request
                  } else if (errorCode === 'TOOL_NOT_FOUND' || errorCode === 'TOOL_NOT_AVAILABLE') {
                    httpStatus = 404; // Not found
                  } else if (errorCode === 'CONNECTION_ERROR' || errorCode === 'INVALID_SOURCE') {
                    httpStatus = 502; // Bad gateway
                  } else if (errorCode === 'SERVER_NOT_CONNECTED' || errorCode === 'CIRCUIT_OPEN' || errorCode === 'SERVICE_UNAVAILABLE') {
                    httpStatus = 503; // Service unavailable
                  } else if (errorCode === 'TIMEOUT') {
                    httpStatus = 504; // Gateway timeout
                  } else if (errorCode === 'INVOCATION_FAILED' || errorCode === 'INVOCATION_ERROR' || errorCode === 'TOOL_ERROR') {
                    httpStatus = 500; // Internal server error
                  }

                  log.error({
                    agentId,
                    toolName,
                    errorCode,
                    httpStatus,
                    error: result.error
                  }, 'MCP tool invocation returned error');

                  json(res, {
                    status: 'error',
                    code: errorCode,
                    message: result.error || 'Tool invocation failed',
                    toolName,
                    agentId,
                    source,
                    fallbackTools: result.fallbackTools || undefined,
                    timestamp: new Date().toISOString()
                  }, httpStatus);
                  return;
                }

                // Normalize successful result format to match native tool interface
                const normalizedResult = {
                  status: 'success',
                  toolName,
                  agentId,
                  source,
                  result: result.content || result.result || null,
                  timestamp: new Date().toISOString()
                };

                log.info({ agentId, toolName, status: 'success' }, 'MCP tool invocation complete');
                json(res, normalizedResult, 200);
              })
              .catch(err => {
                // Handle thrown exceptions (e.g., from parameter validation errors)
                log.error({
                  agentId,
                  toolName,
                  error: err.message,
                  stack: err.stack
                }, 'MCP tool invocation threw exception');

                // Map error to appropriate code and HTTP status
                let errorCode = 'INVOCATION_FAILED';
                let httpStatus = 500;

                if (err.message.includes('TOOL_NOT_AVAILABLE')) {
                  errorCode = 'TOOL_NOT_FOUND';
                  httpStatus = 404;
                } else if (err.message.includes('SERVER_NOT_CONNECTED')) {
                  errorCode = 'SERVER_NOT_CONNECTED';
                  httpStatus = 503;
                } else if (err.message.includes('CIRCUIT_OPEN')) {
                  errorCode = 'CIRCUIT_OPEN';
                  httpStatus = 503;
                } else if (err.message.includes('INVALID_SOURCE')) {
                  errorCode = 'INVALID_SOURCE';
                  httpStatus = 502;
                } else if (err.message.includes('VALIDATION_FAILED')) {
                  errorCode = 'VALIDATION_FAILED';
                  httpStatus = 400;
                }

                json(res, {
                  status: 'error',
                  code: errorCode,
                  message: ({
                    TOOL_NOT_FOUND: 'Tool not found',
                    SERVER_NOT_CONNECTED: 'Tool server is not connected',
                    CIRCUIT_OPEN: 'Tool server is temporarily unavailable',
                    INVALID_SOURCE: 'Tool source is invalid',
                    VALIDATION_FAILED: 'Tool parameters are invalid',
                  })[errorCode] || 'Tool invocation failed',
                  toolName,
                  agentId,
                  source,
                  timestamp: new Date().toISOString()
                }, httpStatus);
              });
          } else {
            // Native tools or unknown source - return appropriate error
            if (source === 'native') {
              json(res, {
                status: 'error',
                code: 'NOT_IMPLEMENTED',
                message: 'Native tool invocation through API is not yet implemented'
              }, 501);
            } else {
              json(res, {
                status: 'error',
                code: 'INVALID_SOURCE',
                message: `Invalid tool source: ${source}`
              }, 400);
            }
          }
        } catch (err) {
          // Catch-all for request parsing or processing errors
          log.error({
            toolInvocation: true,
            error: err.message,
            stack: err.stack,
            errorType: err.constructor.name
          }, 'Tool invocation request processing failed');

          // Determine appropriate error code
          let errorCode = 'INVALID_REQUEST';
          let httpStatus = 400;

          if (err instanceof SyntaxError) {
            errorCode = 'INVALID_JSON';
            httpStatus = 400;
          } else if (err instanceof TypeError) {
            errorCode = 'TYPE_ERROR';
            httpStatus = 400;
          }

          json(res, {
            status: 'error',
            code: errorCode,
            message: 'Request processing failed',
            timestamp: new Date().toISOString()
          }, httpStatus);
        }
      }).catch(err => {
        // Catch errors from readBody itself
        log.error({
          toolInvocation: true,
          error: err.message,
          stack: err.stack
        }, 'Failed to read tool invocation request body');

        json(res, {
          status: 'error',
          code: 'REQUEST_READ_FAILED',
          message: 'Failed to read request body',
          timestamp: new Date().toISOString()
        }, 400);
      });
      return true;
    }

    // --- POST /api/tools/approve-all ---
    if (path === '/api/tools/approve-all' && req.method === 'POST') {
      if (!toolRegistry) {
        json(res, { error: 'Tool registry not available' }, 503);
        return true;
      }
      const result = toolRegistry.approveAll();
      if (toolDistributionService) {
        toolDistributionService.distributeToAllAgents().catch(err => {
          log.warn('Tool redistribution after approval failed', { error: err.message });
        });
      }
      log.info('All pending tools approved', { count: result.approved });
      json(res, { ok: true, ...result });
      return true;
    }

    // --- POST /api/tools/distribute ---
    if (path === '/api/tools/distribute' && req.method === 'POST') {
      if (!toolDistributionService) {
        json(res, { error: 'Tool distribution service not available' }, 503);
        return true;
      }
      toolDistributionService.distributeToAllAgents().then(() => {
        json(res, { ok: true, message: 'Tools distributed to all agents' });
      }).catch(err => {
        respondApiError(res, err);
      });
      return true;
    }

    // --- PATCH /api/tools/:name/approval ---
    const toolApprovalMatch = path.match(/^\/api\/tools\/([^/]+)\/approval$/);
    if (toolApprovalMatch && req.method === 'PATCH') {
      if (!toolRegistry) {
        json(res, { error: 'Tool registry not available' }, 503);
        return true;
      }
      handleBody(req, res, body => {
        try {
          const { state } = JSON.parse(body);
          if (!['pending', 'approved', 'denied'].includes(state)) {
            json(res, { error: 'state must be pending, approved, or denied' }, 400);
            return;
          }
          const toolName = decodeURIComponent(toolApprovalMatch[1]);
          const result = toolRegistry.setApprovalState(toolName, state);
          json(res, { ok: true, ...result });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // --- Budget ---
    if (path === '/api/budget' && req.method === 'GET') {
      const { timelineStore, config } = deps;
      
      if (!timelineStore || typeof timelineStore.getCostSummary !== 'function') {
        json(res, { error: 'TimelineStore not available' }, 503);
        return true;
      }

      const budgetWindowDays = parseInt(url.searchParams.get('days'), 10) || 30;
      const configuredBudget = config?.budget?.maxMonthlyCost || process.env.MAX_MONTHLY_COST || 1000;

      const now = new Date();
      const since = new Date(now.getTime() - budgetWindowDays * 24 * 60 * 60 * 1000).toISOString();
      const until = now.toISOString();

      try {
        const summary = timelineStore.getCostSummary({ since, until });
        
        const byProvider = summary.byProvider.map(p => ({
          provider: p.provider,
          costUsd: p.totalCostUsd,
          inputTokens: p.totalInputTokens,
          outputTokens: p.totalOutputTokens,
          dispatchCount: p.eventCount,
        }));

        const used = summary.totalCostUsd || 0;
        const remaining = Math.max(0, configuredBudget - used);

        json(res, {
          used,
          max: configuredBudget,
          remaining,
          byProvider,
          windowDays: budgetWindowDays,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to compute budget data', { error: err.message });
        json(res, { 
          used: 0, 
          max: configuredBudget, 
          remaining: configuredBudget,
          byProvider: [],
          error: 'Failed to compute budget data' 
        }, 500);
      }
      return true;
    }

    // --- GET /api/metrics/agents?window={1h|24h|7d|30d} ---
    if (path === '/api/metrics/agents' && req.method === 'GET') {
      // Validate the REQUEST before checking backend availability. A malformed
      // window is a client error regardless of store state; answering 503 to
      // `?window=bogus` invites a retry that can never succeed.
      //
      // searchParams.get() distinguishes ABSENT (null) from explicitly BLANK
      // ('') and the two are not the same request. Absent defaults to 24h —
      // scripts/smoke-test.js calls this endpoint with no window at all. Blank
      // is a malformed value: defaulting it would hand back 24h of data the
      // caller never asked for, with no signal that anything was wrong.
      const rawWindow = url.searchParams.get('window');
      const windowParam = rawWindow === null ? '24h' : rawWindow;
      const validWindows = new Set(['1h', '24h', '7d', '30d']);

      if (!validWindows.has(windowParam)) {
        json(res, {
          error: `Invalid window parameter. Must be one of: 1h, 24h, 7d, 30d`,
          validValues: ['1h', '24h', '7d', '30d']
        }, 400);
        return true;
      }

      if (!timelineStore || !timelineStore.db) {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      // Convert window to time range
      const now = new Date();
      let windowStart;
      switch (windowParam) {
        case '1h':
          windowStart = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case '24h':
          windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      }

      const windowEnd = now;

      handleBody(req, res, body => {
        Promise.all([
          computeAgentMetricsForWindow(timelineStore, windowStart.toISOString(), windowEnd.toISOString()),
          performanceStore ? performanceStore.getAllAgentStats() : [],
        ]).then(([metrics, allAgentStats]) => {
          const agentStatsMap = new Map();
          if (allAgentStats && Array.isArray(allAgentStats)) {
            for (const stat of allAgentStats) {
              if (stat.agentId) {
                agentStatsMap.set(stat.agentId, stat);
              }
            }
          }

          const agentsArray = Object.values(metrics).map(m => {
            const agentStat = agentStatsMap.get(m.agent_id);
            const successRate = m.success_rate !== null ? m.success_rate : 
              (agentStat && agentStat.totalDispatches > 0 ? agentStat.successCount / agentStat.totalDispatches : 0);
            
            const trendData = agentStat && agentStat.dispatchHistory 
              ? agentStat.dispatchHistory.slice(-20).map((entry, idx) => ({
                  timestamp: entry.timestamp,
                  success: entry.success ? 1 : 0,
                  idx,
                }))
              : [];

            return {
              agentId: m.agent_id,
              successRate: successRate,
              dispatchCount: m.dispatch_count,
              p50: m.p50_latency,
              p95: m.p95_latency,
              // p99 is computed by computeAgentMetricsForWindow() alongside
              // p50/p95 and was the only one not forwarded.
              p99: m.p99_latency,
              trendData,
            };
          });

          json(res, {
            window: windowParam,
            window_start: windowStart.toISOString(),
            window_end: windowEnd.toISOString(),
            agents: agentsArray,
            computed_at: new Date().toISOString(),
          });
        })
          .catch(err => {
            log.error('Failed to compute agent metrics', { windowParam, error: err.message });
            json(res, { 
              error: 'Failed to compute agent metrics',
            }, 500);
          });
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- GET /api/metrics/models?window={1h|24h|7d|30d} ---
    if (path === '/api/metrics/models' && req.method === 'GET') {
      // Request validation precedes the availability check, and absent is
      // distinguished from blank — see the matching comment on
      // /api/metrics/agents.
      const rawWindow = url.searchParams.get('window');
      const windowParam = rawWindow === null ? '24h' : rawWindow;
      const validWindows = new Set(['1h', '24h', '7d', '30d']);

      if (!validWindows.has(windowParam)) {
        json(res, {
          error: `Invalid window parameter. Must be one of: 1h, 24h, 7d, 30d`,
          validValues: ['1h', '24h', '7d', '30d']
        }, 400);
        return true;
      }

      if (!timelineStore || !timelineStore.db) {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      // Convert window to time range
      const now = new Date();
      let windowStart;
      switch (windowParam) {
        case '1h':
          windowStart = new Date(now.getTime() - 60 * 60 * 1000);
          break;
        case '24h':
          windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;
        case '7d':
          windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      }

      const windowEnd = now;

      handleBody(req, res, body => {
        computeModelMetricsForWindow(timelineStore, windowStart.toISOString(), windowEnd.toISOString())
          .then(result => {
            const { metrics, byCategory } = result;

            // Group metrics by model (extract model name from agent stats or use provider as fallback)
            const modelStats = {};
            
            for (const m of Object.values(metrics)) {
              // Use provider as the model identifier since we're grouping by model backing
              const model = m.provider;
              
              if (!modelStats[model]) {
                modelStats[model] = {
                  model: model,
                  categories: {},
                  totalDispatches: 0,
                  totalSuccesses: 0,
                  totalDurations: [],
                };
              }

              const catStats = modelStats[model].categories[m.taskCategory] || {
                category: m.taskCategory,
                dispatchCount: 0,
                successes: 0,
                durations: [],
              };
              
              catStats.dispatchCount += m.dispatch_count;
              if (m.success_rate !== null && m.dispatch_count > 0) {
                catStats.successes += Math.round(m.dispatch_count * m.success_rate);
              }
              if (m.p50_latency) {
                // Use p50 as representative latency for this data point
                catStats.durations.push(m.p50_latency);
              }
              
              modelStats[model].categories[m.taskCategory] = catStats;
              modelStats[model].totalDispatches += m.dispatch_count;
              if (m.success_rate !== null && m.dispatch_count > 0) {
                modelStats[model].totalSuccesses += Math.round(m.dispatch_count * m.success_rate);
              }
              if (m.p50_latency) {
                modelStats[model].totalDurations.push(m.p50_latency);
              }
            }

            // Build final response structure
            const modelsArray = [];
            for (const [model, stats] of Object.entries(modelStats)) {
              const categoriesArray = Object.values(stats.categories).map(cat => {
                const avgLatency = cat.durations.length > 0 
                  ? cat.durations.reduce((a, b) => a + b, 0) / cat.durations.length 
                  : null;
                
                return {
                  category: cat.category,
                  successRate: cat.dispatchCount > 0 
                    ? +(cat.successes / cat.dispatchCount).toFixed(4) 
                    : null,
                  dispatchCount: cat.dispatchCount,
                  avgLatency: avgLatency,
                };
              });

              const overallSuccessRate = stats.totalDispatches > 0
                ? +(stats.totalSuccesses / stats.totalDispatches).toFixed(4)
                : null;
              
              const overallAvgLatency = stats.totalDurations.length > 0
                ? stats.totalDurations.reduce((a, b) => a + b, 0) / stats.totalDurations.length
                : null;

              modelsArray.push({
                model: model,
                categories: categoriesArray,
                overallStats: {
                  successRate: overallSuccessRate,
                  dispatchCount: stats.totalDispatches,
                  avgLatency: overallAvgLatency,
                },
              });
            }

            json(res, {
              window: windowParam,
              window_start: windowStart.toISOString(),
              window_end: windowEnd.toISOString(),
              models: modelsArray,
              // computeModelMetricsForWindow() returns { metrics, byCategory }.
              // Only `metrics` used to be destructured, so the per-category
              // breakdown it builds was computed and then dropped at this
              // boundary. `models[].categories[]` is a DIFFERENT shape
              // (camelCase, no provider, no percentiles) and is not a
              // substitute. Forwarded additively; `models` is unchanged.
              metrics: Object.values(metrics),
              byCategory,
              computed_at: new Date().toISOString(),
            });
          })
          .catch(err => {
            log.error('Failed to compute model metrics', { windowParam, error: err.message });
            json(res, { 
              error: 'Failed to compute model metrics',
            }, 500);
          });
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }


    // --- GET /api/metrics/reviewer-accuracy?window={1h|24h|7d|30d}&reviewer_id=&start_date=&end_date= ---
    if (path === '/api/metrics/reviewer-accuracy' && req.method === 'GET') {
      const windowParam = url.searchParams.get('window') || '24h';
      const reviewerId = url.searchParams.get('reviewer_id') || null;
      const startDateParam = url.searchParams.get('start_date') || null;
      const endDateParam = url.searchParams.get('end_date') || null;

      const validWindows = new Set(['1h', '24h', '7d', '30d', 'custom']);

      if (!validWindows.has(windowParam)) {
        json(res, {
          error: 'Invalid window parameter. Must be one of: 1h, 24h, 7d, 30d, custom',
          validValues: ['1h', '24h', '7d', '30d', 'custom']
        }, 400);
        return true;
      }

      const now = new Date();
      let windowStart, windowEnd;

      if (windowParam === 'custom') {
        if (!startDateParam || !endDateParam) {
          json(res, {
            error: 'start_date and end_date are required when window=custom',
            example: '/api/metrics/reviewer-accuracy?window=custom&start_date=2026-01-01T00:00:00Z&end_date=2026-01-31T23:59:59Z'
          }, 400);
          return true;
        }

        windowStart = new Date(startDateParam);
        windowEnd = new Date(endDateParam);

        if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime())) {
          json(res, {
            error: 'Invalid date format for start_date or end_date. Use ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ)'
          }, 400);
          return true;
        }

        if (windowStart >= windowEnd) {
          json(res, {
            error: 'start_date must be before end_date'
          }, 400);
          return true;
        }
      } else {
        switch (windowParam) {
          case '1h':
            windowStart = new Date(now.getTime() - 60 * 60 * 1000);
            break;
          case '24h':
            windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            break;
          case '7d':
            windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
          case '30d':
            windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
          default:
            windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        }
        windowEnd = now;
      }

      computeReviewerAccuracyAcrossProjects(
        stateManager,
        windowStart.toISOString(),
        windowEnd.toISOString(),
        reviewerId
      ).then(({ reviewers: reviewersArray, teamWideAccuracy }) => {
        json(res, {
          window: windowParam,
          window_start: windowStart.toISOString(),
          window_end: windowEnd.toISOString(),
          reviewer_filter: reviewerId,
          reviewers: reviewersArray,
          team_wide_accuracy: teamWideAccuracy,
          computed_at: new Date().toISOString(),
        });
      }).catch(err => {
        log.error('Failed to compute reviewer accuracy', {
          windowParam,
          reviewerId,
          error: err.message,
          stack: err.stack
        });
        json(res, {
          error: 'Failed to compute reviewer accuracy'
        }, 500);
      });
      return true;
    }

    // --- GET /api/metrics/weight-history?agent=&category=&window={1h|24h|7d|30d} ---
    if (path === '/api/metrics/weight-history' && req.method === 'GET') {
      if (!timelineStore || !timelineStore.db) {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      const agentId = url.searchParams.get('agent') || null;
      const taskCategory = url.searchParams.get('category') || null;
      const provider = url.searchParams.get('provider') || null;
      const windowParam = url.searchParams.get('window') || '24h';
      const validWindows = new Set(['1h', '24h', '7d', '30d']);
      
      if (!validWindows.has(windowParam)) {
        json(res, { 
          error: `Invalid window parameter. Must be one of: 1h, 24h, 7d, 30d`,
          validValues: ['1h', '24h', '7d', '30d']
        }, 400);
        return true;
      }

      try {
        const history = timelineStore.getWeightHistory({
          agentId,
          taskCategory,
          provider,
          window: windowParam,
          limit: 1000,
        });

        // Transform to expected format: {timestamp, agent_id, weight, reason}[]
        const timeSeries = history.map(entry => ({
          timestamp: entry.snapshot_ts,
          agent_id: entry.agent_id,
          weight: entry.weight,
          reason: entry.weight_reason || null,
          provider: entry.provider,
          task_category: entry.task_category,
        }));

        json(res, {
          window: windowParam,
          window_start: history.length > 0 ? history[0].snapshot_ts : null,
          window_end: history.length > 0 ? history[history.length - 1].snapshot_ts : null,
          agent_id: agentId,
          task_category: taskCategory,
          provider: provider,
          data_points: timeSeries.length,
          time_series: timeSeries,
          computed_at: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to fetch weight history', { 
          agentId, 
          taskCategory, 
          windowParam, 
          error: err.message 
        });
        json(res, { 
          error: 'Failed to fetch weight history',
        }, 500);
      }
      return true;
    }

    // --- OpenAPI Specification ---
    if (path === '/api/openapi.json' && req.method === 'GET') {
      const spec = loadOpenApiSpec();
      if (!spec) {
        json(res, { error: 'OpenAPI specification not available' }, 404);
        return true;
      }
      json(res, spec);
      return true;
    }

    // --- GET /api/chaos/metrics ---
    if (path === '/api/chaos/metrics' && req.method === 'GET') {
      try {
        const dbPath = resolve(PROJECT_ROOT, 'test/chaos/chaos-metrics.sqlite');
        if (!ChaosMetricsStore || !existsSync(dbPath)) {
          json(res, { error: 'Chaos metrics store not found', dbPath }, 404);
          return true;
        }

        const store = new ChaosMetricsStore({ dbPath });

        // Parse query parameters for historical data filtering
        const startTime = url.searchParams.get('startTime');
        const endTime = url.searchParams.get('endTime');
        const faultType = url.searchParams.get('faultType');
        const iterationStart = url.searchParams.get('iterationStart');
        const iterationEnd = url.searchParams.get('iterationEnd');
        const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : null;

        // If no query parameters provided, return latest run aggregate (backward compatible)
        const hasFilters = startTime || endTime || faultType || iterationStart || iterationEnd || limit;

        if (!hasFilters) {
          const aggregate = store.getLatestRunAggregate();
          store.close();

          if (!aggregate) {
            json(res, { error: 'No chaos test runs found' }, 404);
            return true;
          }

          json(res, {
            timestamp: aggregate.timestamp,
            pass_rate: aggregate.passRate,
            cascade_failure_rate: aggregate.cascadeFailureRate,
            state_corruption_recovery_rate: aggregate.stateCorruptionRecoveryRate,
            total_runs: aggregate.totalRuns,
            passed_runs: aggregate.passedRuns,
            failed_runs: aggregate.failedRuns,
            recovery_times_by_fault_type: aggregate.recoveryTimesByFaultType,
          });
          return true;
        }

        // Build filters for queryRuns
        const queryFilters = {};
        if (startTime) queryFilters.startTime = startTime;
        if (endTime) queryFilters.endTime = endTime;
        if (faultType) queryFilters.faultType = faultType;
        if (iterationStart) queryFilters.iterationStart = parseInt(iterationStart, 10);
        if (iterationEnd) queryFilters.iterationEnd = parseInt(iterationEnd, 10);
        if (limit) queryFilters.limit = limit;

        // Get individual runs with filters
        const runs = store.queryRuns(queryFilters);

        // Compute aggregate stats from the filtered runs so aggregates
        // are consistent with faultType / iteration range filters.
        const computeAggregateFromRuns = (filteredRuns) => {
          const total = filteredRuns.length;
          if (total === 0) {
            return {
              totalRuns: 0, passedRuns: 0, failedRuns: 0,
              passRate: 0, cascadeFailureRate: 0, stateCorruptionRecoveryRate: 1.0,
              recoveryTimes: { mean: 0, min: 0, max: 0 }
            };
          }
          const passed = filteredRuns.filter(r => r.passed).length;
          const cascades = filteredRuns.filter(r => r.cascadeDetected).length;
          const integrityOk = filteredRuns.filter(r => r.stateIntegrityOk).length;
          const recoveries = filteredRuns.map(r => r.recoveryTimeMs);
          const sum = recoveries.reduce((a, b) => a + b, 0);
          return {
            totalRuns: total,
            passedRuns: passed,
            failedRuns: total - passed,
            passRate: passed / total,
            cascadeFailureRate: cascades / total,
            stateCorruptionRecoveryRate: integrityOk / total,
            recoveryTimes: {
              mean: sum / total,
              min: Math.min(...recoveries),
              max: Math.max(...recoveries)
            }
          };
        };

        const aggregateStats = computeAggregateFromRuns(runs);

        // Group by fault type from the filtered runs
        const faultTypeGroups = {};
        for (const run of runs) {
          if (!faultTypeGroups[run.faultType]) faultTypeGroups[run.faultType] = [];
          faultTypeGroups[run.faultType].push(run);
        }

        const statsByFaultType = {};
        const recoveryTimesByFaultType = {};
        for (const [ftKey, ftRuns] of Object.entries(faultTypeGroups)) {
          const ftAgg = computeAggregateFromRuns(ftRuns);
          statsByFaultType[ftKey] = {
            totalRuns: ftAgg.totalRuns,
            passedRuns: ftAgg.passedRuns,
            failedRuns: ftAgg.failedRuns,
            passRate: ftAgg.passRate,
            recoveryTimes: ftAgg.recoveryTimes
          };

          // p95 recovery time
          const sorted = ftRuns.map(r => r.recoveryTimeMs).sort((a, b) => a - b);
          const p95Idx = Math.ceil(sorted.length * 0.95) - 1;
          recoveryTimesByFaultType[ftKey] = {
            mean: ftAgg.recoveryTimes.mean,
            p95: sorted[p95Idx],
            max: ftAgg.recoveryTimes.max
          };
        }

        store.close();

        // Return comprehensive filtered results
        json(res, {
          filters: {
            startTime,
            endTime,
            faultType,
            iterationStart,
            iterationEnd,
            limit
          },
          aggregate: {
            total_runs: aggregateStats.totalRuns,
            passed_runs: aggregateStats.passedRuns,
            failed_runs: aggregateStats.failedRuns,
            pass_rate: aggregateStats.passRate,
            cascade_failure_rate: aggregateStats.cascadeFailureRate,
            state_corruption_recovery_rate: aggregateStats.stateCorruptionRecoveryRate,
            recovery_times: aggregateStats.recoveryTimes
          },
          by_fault_type: statsByFaultType,
          recovery_times_by_fault_type: recoveryTimesByFaultType,
          runs: runs.slice(0, limit || runs.length) // Apply limit to returned runs
        });
      } catch (err) {
        log.error('Failed to fetch chaos metrics', { error: err.message, stack: err.stack });
        respondApiError(res, err, { message: 'Failed to fetch chaos metrics' });
      }
      return true;
    }

    // --- GET /api/chaos/metrics/progress ---
    if (path === '/api/chaos/metrics/progress' && req.method === 'GET') {
      try {
        const dbPath = resolve(PROJECT_ROOT, 'test/chaos/chaos-metrics.sqlite');
        const progressPath = resolve(PROJECT_ROOT, 'test/chaos/chaos-progress.json');

        // Check if chaos metrics store exists
        if (!ChaosMetricsStore || !existsSync(dbPath)) {
          json(res, {
            error: 'Chaos metrics store not found',
            status: 'not_started',
            dbPath
          }, 404);
          return true;
        }

        const store = new ChaosMetricsStore({ dbPath });

        // Try to read live progress state file (created by chaos-runner.js)
        let liveProgress = null;
        if (existsSync(progressPath)) {
          try {
            const progressData = readFileSync(progressPath, 'utf-8');
            liveProgress = JSON.parse(progressData);
          } catch (parseErr) {
            log.warn('Failed to parse chaos progress file', { error: parseErr.message });
          }
        }

        // Query database for current run statistics
        const maxIteration = store.getMaxIteration();
        const lastPassingIteration = store.getLastPassingIteration();

        // If we have live progress, use it; otherwise derive from DB
        // Prefer live progress fields when present; use nullish coalescing so "0" is respected.
        const liveCurrentIteration = liveProgress?.currentIteration;
        const liveTargetIterations = liveProgress?.targetIterations ?? liveProgress?.totalIterations;
        const liveStartIteration = liveProgress?.startIteration;
        const liveSuiteStartTime = liveProgress?.suiteStartTime;
        const liveIsRunning = liveProgress?.isRunning;

        let currentIteration = liveCurrentIteration ?? maxIteration;
        let targetIterations = liveTargetIterations ?? 100;
        let startIteration = liveStartIteration ?? 1;
        let suiteStartTime = liveSuiteStartTime ?? null;
        let isRunning = liveIsRunning ?? false;

        // Get statistics for the current run (from startIteration to current)
        const currentRunStats = store.getAggregateStats({});

        // Calculate pass/fail counts
        const totalPassed = currentRunStats.passedRuns || 0;
        const totalFailed = currentRunStats.failedRuns || 0;
        const totalRuns = currentRunStats.totalRuns || 0;
        const passRate = totalRuns > 0 ? (totalPassed / totalRuns) : 0;

        // Get recent failures (last 10)
        const recentFailures = store.queryRuns({
          passed: false,
          limit: 10
        }).map(run => ({
          iteration: run.iteration,
          scenarioName: run.scenarioName,
          faultType: run.faultType,
          timestamp: run.timestamp,
          recoveryTimeMs: run.recoveryTimeMs
        }));

        // Calculate ETA
        let etaMs = null;
        let avgIterationMs = null;
        let estimatedCompletionTime = null;

        if (isRunning && suiteStartTime && currentIteration > startIteration) {
          const elapsed = Date.now() - new Date(suiteStartTime).getTime();
          const completedIterations = currentIteration - startIteration + 1;
          avgIterationMs = completedIterations > 0 ? elapsed / completedIterations : null;

          if (avgIterationMs !== null) {
            const remainingIterations = targetIterations - currentIteration;
            etaMs = Math.round(avgIterationMs * remainingIterations);
            estimatedCompletionTime = new Date(Date.now() + etaMs).toISOString();
          }
        }

        // Determine status
        let status = 'unknown';
        if (isRunning) {
          status = 'running';
        } else if (currentIteration >= targetIterations) {
          status = 'completed';
        } else if (currentIteration > 0) {
          status = 'paused';
        } else {
          status = 'not_started';
        }

        const totalIterationsWindow = Math.max(1, targetIterations - startIteration + 1);

        const response = {
          status,
          is_running: isRunning,
          current_iteration: currentIteration,
          target_iterations: targetIterations,
          start_iteration: startIteration,
          completed_iterations: currentIteration - startIteration + 1,
          remaining_iterations: Math.max(0, targetIterations - currentIteration),
          progress_percentage: targetIterations > 0
            ? Math.round(((currentIteration - startIteration + 1) / totalIterationsWindow) * 100)
            : 0,
          suite_start_time: suiteStartTime,
          last_passing_iteration: lastPassingIteration,
          statistics: {
            total_runs: totalRuns,
            passed_runs: totalPassed,
            failed_runs: totalFailed,
            pass_rate: passRate,
            cascade_failure_rate: currentRunStats.cascadeFailureRate || 0,
            state_corruption_recovery_rate: currentRunStats.stateCorruptionRecoveryRate || 1.0
          },
          recent_failures: recentFailures,
          eta: {
            eta_ms: etaMs,
            avg_iteration_ms: avgIterationMs,
            estimated_completion_time: estimatedCompletionTime
          },
          timestamp: new Date().toISOString()
        };

        store.close();
        json(res, response);
      } catch (err) {
        log.error('Failed to fetch chaos progress', { error: err.message, stack: err.stack });
        respondApiError(res, err, { message: 'Failed to fetch chaos progress' });
      }
      return true;
    }

    // --- Chaos metrics export ---
    if (path === '/api/chaos/metrics/export' && req.method === 'GET') {
      try {
        const dbPath = resolve(PROJECT_ROOT, 'test/chaos/chaos-metrics.sqlite');
        if (!ChaosMetricsStore || !existsSync(dbPath)) {
          json(res, { error: 'Chaos metrics store not found', dbPath }, 404);
          return true;
        }

        const format = url.searchParams.get('format') || 'json';
        const startTime = url.searchParams.get('startTime');
        const endTime = url.searchParams.get('endTime');
        const faultType = url.searchParams.get('faultType');
        const iterationStart = url.searchParams.get('iterationStart');
        const iterationEnd = url.searchParams.get('iterationEnd');

        const options = {};
        if (startTime) options.startTime = startTime;
        if (endTime) options.endTime = endTime;
        if (faultType) options.faultType = faultType;
        if (iterationStart) options.iterationStart = parseInt(iterationStart, 10);
        if (iterationEnd) options.iterationEnd = parseInt(iterationEnd, 10);

        const store = new ChaosMetricsStore({ dbPath });
        let content;
        let contentType;
        let filename;

        if (format === 'csv') {
          content = store.exportToCSV(options);
          contentType = 'text/csv';
          filename = `chaos-metrics-${Date.now()}.csv`;
        } else {
          content = store.exportToJSON(options);
          contentType = 'application/json';
          filename = `chaos-metrics-${Date.now()}.json`;
        }

        store.close();

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`
        });
        res.end(content);
      } catch (err) {
        log.error('Failed to export chaos metrics', { error: err.message, stack: err.stack });
        respondApiError(res, err, { message: 'Failed to export chaos metrics' });
      }
      return true;
    }

    // --- Circuit breaker ---
    if (path === '/api/circuit-breakers' && req.method === 'GET') {
      if (!circuitBreaker) { json(res, { error: 'Circuit breaker not available' }, 500); return true; }
      const status = circuitBreaker.getStatus();
      const providers = {};
      const services = {};
      const agentsState = {};
      const providerDefaults = {
        failureThreshold: circuitBreaker._failureThreshold,
        cooldownMs: circuitBreaker._cooldownMs,
      };

      // Known infrastructure service names
      const SERVICE_NAMES = new Set(['tracing', 'audit', 'shared-state']);

      for (const [provider, entry] of Object.entries(status.providers || {})) {
        const thresholds = typeof circuitBreaker._getThresholds === 'function'
          ? circuitBreaker._getThresholds(provider)
          : providerDefaults;
        const cbEntry = {
          ...entry,
          config: {
            failureThreshold: thresholds.failureThreshold,
            cooldownMs: thresholds.cooldownMs,
          },
        };

        // Separate infrastructure services from LLM providers
        if (SERVICE_NAMES.has(provider)) {
          services[provider] = cbEntry;
        } else {
          providers[provider] = cbEntry;
        }
      }

      for (const [agentId, entry] of Object.entries(status.agents || {})) {
        const thresholds = typeof circuitBreaker._getAgentThresholds === 'function'
          ? circuitBreaker._getAgentThresholds(agentId)
          : providerDefaults;
        agentsState[agentId] = {
          ...entry,
          provider: agents[agentId]?.provider || null,
          config: {
            failureThreshold: thresholds.failureThreshold,
            cooldownMs: thresholds.cooldownMs,
          },
        };
      }

      json(res, { providers, services, agents: agentsState, timestamp: new Date().toISOString() });
      return true;
    }
    if (path === '/api/circuit-breaker' && req.method === 'GET') {
      if (!circuitBreaker) { json(res, { error: 'Circuit breaker not available' }, 500); return true; }
      const agentId = url.searchParams.get('agentId') || undefined;
      const provider = url.searchParams.get('provider') || undefined;
      if (agentId && provider) {
        json(res, { error: 'Provide either agentId or provider, not both' }, 400);
        return true;
      }
      if (agentId) {
        json(res, circuitBreaker.getStatus({ agentId }));
        return true;
      }
      if (provider) {
        json(res, circuitBreaker.getStatus({ provider }));
        return true;
      }
      json(res, circuitBreaker.getStatus());
      return true;
    }
     // ─── POST /api/circuit-breakers/:provider/reset ──────────────────────────
     const cbResetMatchPlural = path.match(/^\/api\/circuit-breakers\/([^/]+)\/reset$/);
     if (cbResetMatchPlural && req.method === 'POST') {
       if (!requireOperatorRole()) return true;
       if (!circuitBreaker) { json(res, { error: 'Circuit breaker not available' }, 500); return true; }
       const provider = decodeURIComponent(cbResetMatchPlural[1]);
       handleBody(req, res, (body) => {
         let payload = {};
         try {
           payload = body && body.trim() ? JSON.parse(body) : {};
         } catch {
           payload = {};
         }

         const actionId = getIdempotencyKey(req, payload);
         if (actionId && operatorActionStore) {
           const existing = getIdempotentResult(actionId);
           if (respondIdempotent(existing)) return;
         }

         const { source, reason: auditReason, correlationId: bodyCorrelationId, traceId, dispatchId } = getAuditContext(req, payload);
         const correlationId = bodyCorrelationId || typeof payload.correlationId === 'string' && payload.correlationId.trim()
           ? payload.correlationId.trim()
           : provider;
         const resolved = resolveCorrelationKeysFromId(correlationId);

         circuitBreaker.reset(provider);
         const state = 'closed';
         log.info('Circuit breaker reset via API', { provider });

         operatorAuditStore.append({
           action: 'cb_reset',
           providerId: provider,
           operatorId: requestUserId || 'system',
           status: 'success',
           decision: 'allow',
           details: `Circuit breaker for provider "${provider}" reset via API`,
           source,
           reason: auditReason,
           correlationId,
           dispatchId: dispatchId || resolved.dispatchId,
           traceId: traceId || resolved.traceId,
         });

         if (actionId) {
           emitOperatorActionTimelineEvent('cb_reset', {
             idempotencyKey: actionId,
             operatorId: requestUserId || 'system',
             status: 'completed',
             correlationId,
             campaignId: resolved.campaignId,
             dispatchId: resolved.dispatchId,
             traceId: resolved.traceId,
             agentId: resolved.agentId,
             provider,
             data: { action: 'cb_reset', provider, state },
           });

           // Broadcast steering action to WebSocket subscribers
           broadcast({
             type: 'steering:action',
             subtype: STEERING_EVENT_TYPES.cb_reset,
             actionType: 'cb_reset',
             correlationId,
             payloadSummary: {
               provider,
               state,
               operatorId: requestUserId || 'system',
             },
             serverTimestamp: new Date().toISOString(),
           });
         }

         const responseBody = { ok: true, provider, state, actionId: actionId || null, correlationId };
         if (actionId) {
           recordIdempotentResult(actionId, 'cb_reset', 200, responseBody, { dispatchId: resolved.dispatchId, traceId: resolved.traceId, payload });
         }
         json(res, responseBody, 200);
       });
       return true;
     }

     if (path === '/api/circuit-breaker/history' && req.method === 'GET') {
      if (!circuitBreakerHistoryStore) {
        json(res, { transitions: [], total: 0, timestamp: new Date().toISOString() });
        return true;
      }

      let limit = parseInt(url.searchParams.get('limit'), 10) || 100;
      if (limit < 1) limit = 100;
      if (limit > 500) limit = 500;

      const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
      const provider = url.searchParams.get('provider') || undefined;
      const agentId = url.searchParams.get('agentId') || undefined;
      const sinceRaw = url.searchParams.get('since') || undefined;
      let since;
      if (sinceRaw !== undefined) {
        const sinceDate = new Date(sinceRaw);
        if (isNaN(sinceDate.getTime())) {
          json(res, { error: 'since must be a valid ISO timestamp' }, 400);
          return true;
        }
        since = sinceDate.toISOString();
      }

      const { transitions, total } = circuitBreakerHistoryStore.query({
        provider,
        agentId,
        since,
        limit,
        offset,
      });

      json(res, { transitions, total, timestamp: new Date().toISOString() });
      return true;
    }

    // --- Alerts ---
    // Alert acknowledgements — identity key survives pattern-scan refires.
    function alertIdentityKey(a) {
      const cond = a.condition || a.name || a.title || a.type || 'alert';
      const anchor = a.projectId || a.evidence?.[0]?.entry || a.evidence?.[0]?.project || '';
      return `${a.type || 'system'}|${cond}|${anchor}`;
    }
    const ALERTS_ACK_PATH = '.synapse/alerts-acked.json';
    function loadAlertAcks() {
      try {
        const d = JSON.parse(readFileSync(ALERTS_ACK_PATH, 'utf-8'));
        return { keys: Array.isArray(d.keys) ? d.keys : [], watermark: d.watermark || null };
      } catch { return { keys: [], watermark: null }; }
    }
    function saveAlertAcks(acks) {
      // Cap stored keys so the file can't grow unbounded
      if (acks.keys.length > 5000) acks.keys = acks.keys.slice(-5000);
      writeFileSync(ALERTS_ACK_PATH, JSON.stringify(acks, null, 2));
    }

    // Mark a single alert read: body { key } (the _key field served by GET)
    if (path === '/api/alerts/ack' && req.method === 'POST') {
      if (!requireOperatorRole('alert_ack')) return true;
      handleBody(req, res, body => {
        try {
          const { key } = JSON.parse(body || '{}');
          if (!key || typeof key !== 'string') { json(res, { error: 'key is required' }, 400); return; }
          const acks = loadAlertAcks();
          if (!acks.keys.includes(key)) acks.keys.push(key);
          saveAlertAcks(acks);
          json(res, { ok: true });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }

    // Mark everything currently visible read: keys for known conditions
    // (suppresses refires) + a watermark for the long tail.
    if (path === '/api/alerts/ack-all' && req.method === 'POST') {
      if (!requireOperatorRole('alert_ack_all')) return true;
      try {
        const active = alertMonitor ? alertMonitor.getActiveAlerts() : [];
        const history = loadAlertHistory('.synapse/anomaly-alerts.jsonl');
        const acks = loadAlertAcks();
        const keySet = new Set(acks.keys);
        for (const a of [...active, ...history]) keySet.add(alertIdentityKey(a));
        acks.keys = [...keySet];
        acks.watermark = Date.now();
        saveAlertAcks(acks);
        json(res, { ok: true, acked: acks.keys.length });
      } catch (err) { respondApiError(res, err, { status: 400 }); }
      return true;
    }

    if (path === '/api/alerts' && req.method === 'GET') {
      try {
        // Get active alerts from alert monitor
        const activeAlerts = alertMonitor ? alertMonitor.getActiveAlerts() : [];

        // Load pattern findings from anomaly-alerts.jsonl
        const anomalyAlertsPath = '.synapse/anomaly-alerts.jsonl';
        const patternFindings = loadAlertHistory(anomalyAlertsPath);

        // Merge alerts: active alerts + pattern findings
        let allAlerts = [...activeAlerts, ...patternFindings];

        // Apply operator acknowledgements. Keys are identity-based (not
        // timestamp-based) because pattern scans re-fire the same condition
        // with a fresh firedAt on every sweep — an acked alert must stay
        // acked across refires. ?includeAcked=1 bypasses (audit view).
        const acks = loadAlertAcks();
        if (url.searchParams.get('includeAcked') !== '1') {
          const keySet = new Set(acks.keys || []);
          allAlerts = allAlerts.filter(a => {
            if (keySet.has(alertIdentityKey(a))) return false;
            if (acks.watermark) {
              const t = new Date(a.firedAt || a.timestamp || 0).getTime();
              if (t && t <= acks.watermark) return false;
            }
            return true;
          });
        }
        // Dedupe refires of the same condition — keep only the newest per key
        const seenKeys = new Map();
        for (const a of allAlerts) {
          const k = alertIdentityKey(a);
          const t = new Date(a.firedAt || a.timestamp || 0).getTime();
          const prev = seenKeys.get(k);
          if (!prev || t > prev._t) seenKeys.set(k, Object.assign(a, { _t: t, _key: k }));
        }
        allAlerts = [...seenKeys.values()];
        for (const a of allAlerts) delete a._t;
        
        // Filter by type if specified in query params
        const typeFilter = url.searchParams.get('type');
        if (typeFilter) {
          const validTypes = new Set(['system', 'anomaly', 'cross-project-pattern']);
          if (!validTypes.has(typeFilter)) {
            json(res, { error: 'type must be one of: system, anomaly, cross-project-pattern' }, 400);
            return true;
          }
          // Filter alerts by type
          const filteredAlerts = allAlerts.filter(alert => {
            if (typeFilter === 'cross-project-pattern') {
              return alert.type === 'cross-project-pattern';
            } else if (typeFilter === 'anomaly') {
              return alert.condition && alert.condition.startsWith('agent-anomaly:');
            } else if (typeFilter === 'system') {
              // System alerts are those that don't match the other two categories
              return !alert.type && !alert.condition?.startsWith('agent-anomaly:');
            }
            return true;
          });
          
          // Sort by severity (critical first) then by timestamp (newest first)
          const severityOrder = { critical: 0, warning: 1, info: 2 };
          filteredAlerts.sort((a, b) => {
            const sevDiff = (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2);
            if (sevDiff !== 0) return sevDiff;
            const timeA = new Date(a.firedAt || a.timestamp || 0).getTime();
            const timeB = new Date(b.firedAt || b.timestamp || 0).getTime();
            return timeB - timeA;
          });
          
          json(res, filteredAlerts.slice(0, 500));
        } else {
          // No filter: sort all alerts by severity then timestamp
          const severityOrder = { critical: 0, warning: 1, info: 2 };
          allAlerts.sort((a, b) => {
            const sevDiff = (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2);
            if (sevDiff !== 0) return sevDiff;
            const timeA = new Date(a.firedAt || a.timestamp || 0).getTime();
            const timeB = new Date(b.firedAt || b.timestamp || 0).getTime();
            return timeB - timeA;
          });

          json(res, allAlerts.slice(0, 500));
        }
        
        return true;
      } catch (err) {
        log.error('Failed to load alerts', { error: err.message });
        json(res, alertMonitor ? alertMonitor.getActiveAlerts() : []);
        return true;
      }
    }
    // ─── SLA Breaches API ─────────────────────────────────────────
    if (path === '/api/sla/breaches' && req.method === 'GET') {
      if (!slaMonitor) {
        json(res, []);
        return true;
      }
      json(res, slaMonitor.getActiveBreaches());
      return true;
    }
    // ─── SLA Config API ───────────────────────────────────────────
    if (path === '/api/sla/config' && req.method === 'GET') {
      if (!slaMonitor) {
        json(res, {});
        return true;
      }
      json(res, slaMonitor.getConfig());
      return true;
    }
    if (path === '/api/anomaly-history' && req.method === 'GET') {
      if (!anomalyDetector) {
        json(res, []);
        return true;
      }
      // Parse query parameters
      const agentId = url.searchParams.get('agentId') || undefined;
      const category = url.searchParams.get('category') || undefined;
      const sinceRaw = url.searchParams.get('since') || undefined;
      const untilRaw = url.searchParams.get('until') || undefined;
      const limitRaw = url.searchParams.get('limit');
      const offsetRaw = url.searchParams.get('offset');

      // If no filters provided, use legacy behavior
      if (!agentId && !category && !sinceRaw && !untilRaw && !limitRaw && !offsetRaw) {
        json(res, anomalyDetector.getAlertHistory());
        return true;
      }

      let since;
      if (sinceRaw !== undefined) {
        const sinceDate = new Date(sinceRaw);
        if (isNaN(sinceDate.getTime())) {
          json(res, { error: 'since must be a valid ISO timestamp' }, 400);
          return true;
        }
        since = sinceDate.toISOString();
      }

      let until;
      if (untilRaw !== undefined) {
        const untilDate = new Date(untilRaw);
        if (isNaN(untilDate.getTime())) {
          json(res, { error: 'until must be a valid ISO timestamp' }, 400);
          return true;
        }
        until = untilDate.toISOString();
      }

      let limit;
      if (limitRaw !== null) {
        const parsedLimit = parseInt(limitRaw, 10);
        if (isNaN(parsedLimit)) {
          json(res, { error: 'limit must be an integer' }, 400);
          return true;
        }
        limit = Math.max(0, Math.min(500, parsedLimit));
      }

      let offset;
      if (offsetRaw !== null) {
        const parsedOffset = parseInt(offsetRaw, 10);
        if (isNaN(parsedOffset)) {
          json(res, { error: 'offset must be an integer' }, 400);
          return true;
        }
        offset = Math.max(0, parsedOffset);
      }

      const filters = {};
      if (agentId) filters.agentId = agentId;
      if (category) filters.category = category;
      if (since) filters.since = since;
      if (until) filters.until = until;
      if (limit !== undefined) filters.limit = limit;
      if (offset !== undefined) filters.offset = offset;

      const result = anomalyDetector.getAlertHistoryFiltered(filters);
      json(res, result);
      return true;
    }

    // --- Analytics Pipeline Manual Trigger ---
    if (path === '/api/analytics-pipeline/run' && req.method === 'POST') {
      if (!deps.analyticsPipeline) {
        json(res, { error: 'Analytics pipeline not available' }, 503);
        return true;
      }

      (async () => {
        try {
          const result = await deps.analyticsPipeline.runOnce();
          json(res, result);
        } catch (err) {
          log.error('Analytics pipeline manual trigger failed', { error: err.message });
          respondApiError(res, err, { message: 'Pipeline execution failed' });
        }
      })();
      return true;
    }

    const parseTimelineTypeFilter = (rawValue) => {
      if (!rawValue) return undefined;

      const typeMap = {
        dispatch: 'dispatch',
        routing: 'dispatch',
        'circuit-breaker': 'circuit_breaker',
        circuit_breaker: 'circuit_breaker',
        cb: 'circuit_breaker',
        anomaly: 'anomaly_alert',
        'anomaly-alert': 'anomaly_alert',
        anomaly_alert: 'anomaly_alert',
        guardrail: 'guardrail_outcome',
        'guardrail-outcome': 'guardrail_outcome',
        guardrail_outcome: 'guardrail_outcome',
        'operator-action': 'operator_action',
        operator_action: 'operator_action',
        'operator-replay': 'operator_replay',
        operator_replay: 'operator_replay',
        'operator-steer': 'operator_steer',
        operator_steer: 'operator_steer',
        deliberation: 'deliberation_request',
        deliberation_request: 'deliberation_request',
        delib_request: 'deliberation_request',
        deliberation_feedback: 'deliberation_feedback',
        delib_feedback: 'deliberation_feedback',
        deliberation_revision: 'deliberation_revision',
        delib_revision: 'deliberation_revision',
        argument_submitted: 'argument_submitted',
        challenge_raised: 'challenge_raised',
        synthesis_produced: 'synthesis_produced',
        revision_completed: 'revision_completed',
      };

      const normalized = rawValue
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(value => typeMap[value.toLowerCase()] || value.toLowerCase());

      if (!normalized.length || normalized.some(value => !VALID_EVENT_TYPES.has(value))) {
        return { error: `type must be one of ${[...VALID_EVENT_TYPES].join(', ')}` };
      }

      return normalized.length === 1 ? normalized[0] : normalized;
    };

    // --- Unified timeline ---
    if (path === '/api/timeline' && req.method === 'GET') {

      const limitRaw = url.searchParams.get('limit');
      const offsetRaw = url.searchParams.get('offset');
      const cursorRaw = url.searchParams.get('cursor') || undefined;
      const typeRaw = url.searchParams.get('type') || url.searchParams.get('event_type');
      const campaignIdRaw = url.searchParams.get('campaignId');
      const agentId = url.searchParams.get('agentId') || undefined;
      const provider = url.searchParams.get('provider') || undefined;
      const traceId = url.searchParams.get('traceId') || undefined;
      const dispatchIdRaw = url.searchParams.get('dispatchId');
      const sinceRaw = url.searchParams.get('since') || url.searchParams.get('start_time') || undefined;
      const untilRaw = url.searchParams.get('until') || url.searchParams.get('end_time') || undefined;

      let limit = limitRaw !== null ? parseInt(limitRaw, 10) : 100;
      if (Number.isNaN(limit)) {
        json(res, { error: 'limit must be an integer' }, 400);
        return true;
      }
      limit = Math.max(1, Math.min(limit, 500));

      let offset = offsetRaw !== null ? parseInt(offsetRaw, 10) : 0;
      if (Number.isNaN(offset)) {
        json(res, { error: 'offset must be an integer' }, 400);
        return true;
      }
      offset = Math.max(0, offset);

      // Cursor-based pagination: validate if provided
      let cursor;
      if (cursorRaw !== undefined) {
        const decoded = decodeCursor(cursorRaw);
        if (!decoded) {
          json(res, { error: 'cursor must be a valid base64-encoded pagination cursor' }, 400);
          return true;
        }
        cursor = cursorRaw;
      }

      let campaignId;
      if (campaignIdRaw !== null) {
        campaignId = campaignIdRaw.trim();
        if (!campaignId) {
          json(res, { error: 'campaignId must be a non-empty string' }, 400);
          return true;
        }
      }

      let dispatchId;
      if (dispatchIdRaw !== null) {
        dispatchId = dispatchIdRaw.trim();
        if (!dispatchId) {
          json(res, { error: 'dispatchId must be a non-empty string' }, 400);
          return true;
        }
      }

      const type = parseTimelineTypeFilter(typeRaw);
      if (type?.error) {
        json(res, { error: type.error }, 400);
        return true;
      }

      let since;
      if (sinceRaw !== undefined) {
        const sinceDate = new Date(sinceRaw);
        if (isNaN(sinceDate.getTime())) {
          json(res, { error: 'since must be a valid ISO timestamp' }, 400);
          return true;
        }
        since = sinceDate.toISOString();
      }

      let until;
      if (untilRaw !== undefined) {
        const untilDate = new Date(untilRaw);
        if (isNaN(untilDate.getTime())) {
          json(res, { error: 'until must be a valid ISO timestamp' }, 400);
          return true;
        }
        until = untilDate.toISOString();
      }

      const filters = {
        type,
        campaignId,
        dispatchId,
        agentId,
        provider,
        traceId,
        since,
        until,
        limit,
        ...(cursor ? { cursor } : { offset }),
      };

      // If timelineStore is available and has a query function, use it
      if (timelineStore && typeof timelineStore.query === 'function') {
        try {
          const result = timelineStore.query(filters);
          const { events: rawEvents = [], total = 0, total_count, next_cursor = null } = result;
          
          // Build a lookup of dispatch rationales by dispatchId for enrichment
          const dispatchIds = [...new Set(rawEvents
            .filter(e => e.type === 'dispatch' || e.type === 'dispatch_decision')
            .map(e => extractCorrelationKeys(e).dispatchId)
            .filter(Boolean)
          )];
          
          const rationaleCache = new Map();
          if (dispatchLog && dispatchIds.length > 0 && typeof dispatchLog.getDispatchRationale === 'function') {
            for (const dispatchId of dispatchIds) {
              try {
                rationaleCache.set(dispatchId, dispatchLog.getDispatchRationale(dispatchId, timelineStore));
              } catch (err) {
                log.warn(`Failed to fetch rationale for dispatch ${dispatchId}: ${err.message}`);
              }
            }
          }
          
          const events = rawEvents.map((event) => {
            const correlationKeys = extractCorrelationKeys(event);
            const rationale = correlationKeys.dispatchId 
              ? rationaleCache.get(correlationKeys.dispatchId) 
              : null;
            
            return {
              ...event,
              correlationKeys,
              summary: event.summary ?? event.data?.summary ?? 'Timeline event',
              // Dashboard enrichment: rationale summary for dispatch events
              _rationaleSummary: buildRationaleSummary(event, rationale),
              // Dashboard enrichment: deep-link metadata
              _deepLinks: buildDeepLinks(event, correlationKeys),
            };
          });

          json(res, {
            events,
            total,
            total_count: total_count ?? total,
            next_cursor,
            offset: cursor ? undefined : offset,
            limit,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          log.error('Failed to load unified timeline from timelineStore', { error: err.message });
          json(res, { error: 'Failed to load timeline' }, 500);
        }
        return true;
      }

      // If the timelineStore is not available or not properly configured,
      // return a service unavailable error.
      json(res, { error: 'Unified timeline store not available or misconfigured' }, 503);
      return true;


      return true;
    }

    // --- POST /api/audit/export ---
    if (path === '/api/audit/export' && req.method === 'POST') {
      if (!requireOperatorRole('audit_export')) return true;

      if (!timelineStore) {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      handleBody(req, res, async body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};

          // Validate format parameter
          const format = payload.format || 'json';
          const validFormats = new Set(['csv', 'json', 'pdf']);
          if (!validFormats.has(format)) {
            json(res, {
              error: `Invalid format. Must be one of: csv, json, pdf`,
              validValues: ['csv', 'json', 'pdf']
            }, 400);
            return;
          }

          // Validate dateRange.
          //
          // The template path below accepts BOTH spellings ("Support both
          // legacy dateRange format and new startDate/endDate format"), but
          // this one read dateRange only. A caller who filtered a CSV/JSON
          // export with startDate/endDate therefore got a SILENTLY UNFILTERED
          // export — wrong results, and more audit data disclosed than was
          // asked for. Accept both here too; dateRange wins when both appear.
          const dateRange = payload.dateRange || {};
          const rawFrom = dateRange.from ?? payload.startDate;
          const rawTo = dateRange.to ?? payload.endDate;
          let fromDate, toDate;

          if (rawFrom) {
            const parsedFrom = new Date(rawFrom);
            if (isNaN(parsedFrom.getTime())) {
              json(res, { error: 'dateRange.from must be a valid ISO timestamp' }, 400);
              return;
            }
            fromDate = parsedFrom.toISOString();
          }

          if (rawTo) {
            const parsedTo = new Date(rawTo);
            if (isNaN(parsedTo.getTime())) {
              json(res, { error: 'dateRange.to must be a valid ISO timestamp' }, 400);
              return;
            }
            toDate = parsedTo.toISOString();
          }

          // Inverted range would silently yield empty or wrong-window results
          // depending on the query engine; refuse instead of exporting a surprise.
          if (fromDate && toDate && Date.parse(fromDate) >= Date.parse(toDate)) {
            json(res, { error: 'dateRange.from must be before dateRange.to' }, 400);
            return;
          }

          // Validate scope
          const scope = payload.scope || { type: 'system' };
          const validScopeTypes = new Set(['system', 'project', 'campaign']);
          if (!validScopeTypes.has(scope.type)) {
            json(res, {
              error: `Invalid scope.type. Must be one of: system, project, campaign`,
              validValues: ['system', 'project', 'campaign']
            }, 400);
            return;
          }

          if (scope.type !== 'system' && !scope.id) {
            json(res, { error: 'scope.id is required when scope.type is not system' }, 400);
            return;
          }

        // Validate template parameter for PDF exports
          const template = payload.template || 'activity-summary';

          // Normalize template name: support both kebab-case (registry format) and underscore format
          const normalizedTemplate = template.replace(/_/g, '-');

          // Did the caller actually ask for a template-based report?
          //
          // `template` above defaults to 'activity-summary', so normalizedTemplate
          // is ALWAYS a non-empty string. The template branch below was gated on
          // `if (normalizedTemplate)`, which is therefore always true — every
          // export, including format 'csv' and 'json', was routed into template
          // report generation, which requires startDate/endDate and answered
          // 400 "Template validation failed: startDate is required" for the
          // documented `dateRange: null` system-wide export. The streaming
          // CSV/JSON exporters further down were unreachable in production
          // (templateRegistry self-initializes at :1666, so the 503 escape
          // never fires either).
          //
          // PDF keeps its default template so its behaviour is unchanged.
          const templateRequested = Boolean(payload.template) || format === 'pdf';

          if (format === 'pdf') {
            const validTemplates = new Set(['activity-summary', 'incident-timeline']);
            if (!validTemplates.has(normalizedTemplate)) {
              json(res, {
                error: `Invalid template. Must be one of: activity-summary, incident-timeline`,
                validValues: ['activity-summary', 'incident-timeline']
              }, 400);
              return;
            }
          }

          // Build filters for export query engine
          const exportFilters = {
            dateRange: { from: fromDate, to: toDate },
            scope: { type: scope.type, id: scope.id || null },
          };

          // Create export query engine
          const queryEngine = createExportQueryEngine({ timelineStore });

          // Get event count to determine sync vs async export
          const counts = await queryEngine.getCount(exportFilters);
          const totalEvents = Object.values(counts).reduce((sum, count) => sum + count, 0);

          log.info('Export request received', {
            format,
            template,
            scopeType: scope.type,
            scopeId: scope.id,
            totalEvents,
            dateRange: { from: fromDate, to: toDate },
          });

       // --- Template-based report generation (new path) ---
          // If template is specified, validate registry availability and template existence
          if (templateRequested) {
            // Check if templateRegistry is available
            if (!templateRegistry || typeof templateRegistry.invoke !== 'function') {
              log.warn('Template requested but registry unavailable', { template: normalizedTemplate });
              json(res, {
                error: 'Report template registry not available',
                template: normalizedTemplate
              }, 503);
              return;
            }

            // Check if requested template exists in registry
            if (!templateRegistry.get(normalizedTemplate)) {
              log.warn('Invalid template requested', {
                template: normalizedTemplate,
                availableTemplates: templateRegistry.list().map(t => t.id)
              });
              json(res, {
                error: `Unknown template: ${normalizedTemplate}`,
                template: normalizedTemplate,
                availableTemplates: templateRegistry.list().map(t => t.id)
              }, 400);
              return;
            }

            // Template is valid and available, proceed with generation
            const startTime = performance.now();

            try {
              // Validate date range (reject >90 days as per requirements)
              if (fromDate && toDate) {
                const diffMs = Date.parse(toDate) - Date.parse(fromDate);
                const diffDays = diffMs / (1000 * 60 * 60 * 24);
                if (diffDays > 90) {
                  json(res, {
                    error: 'Date range must be 90 days or less for template-based reports',
                    dateRange: { from: fromDate, to: toDate, days: Math.round(diffDays) }
                  }, 400);
                  return;
                }
              }

              // Build template parameters from payload
              // Support both legacy dateRange format and new startDate/endDate format
              const templateParams = {
                template: normalizedTemplate,
                startDate: payload.startDate || fromDate,
                endDate: payload.endDate || toDate,
                campaignId: payload.campaignId || (scope.type === 'campaign' ? scope.id : null),
                scope: scope.type !== 'system' ? `${scope.type}:${scope.id}` : 'system',
                format: format,
              };

              // Invoke template via TemplateRegistry
              const report = await templateRegistry.invoke(normalizedTemplate, templateParams, {
                timelineStore,
                campaignManager,
                taskManager,
              });

              const latencyMs = Math.round(performance.now() - startTime);

              log.info('Template-based report generated', {
                template: normalizedTemplate,
                latencyMs,
                eventCount: report.meta?.eventCount || 0,
                sections: report.sections?.length || 0,
              });

              // A template produces a FORMAT-NEUTRAL report; report-templates.js
              // describes it as input for "downstream formatters (JSON, CSV,
              // PDF)". That last step was never wired here, so
              // `format: 'pdf'` answered with a JSON report — even though
              // generatePdfReport() exists, is unit-tested, renders real PDF
              // bytes via renderActivitySummaryPDF/renderIncidentTimelinePDF,
              // and is already used by the scheduled-report path in
              // lifecycle.js. Render and stream it for PDF requests; every
              // other format keeps the JSON report exactly as before.
              if (format === 'pdf') {
                const pdfBuffer = await generatePdfReport(
                  timelineStore,
                  {
                    startDate: templateParams.startDate,
                    endDate: templateParams.endDate,
                    scope: templateParams.scope,
                  },
                  // report-generator.js keys its PDF renderers by the
                  // UNDERSCORE spelling ('activity_summary'), the opposite of
                  // the registry's kebab-case ids. Convert at the boundary
                  // rather than loosening either module's own validation.
                  normalizedTemplate.replace(/-/g, '_')
                );
                const pdfStamp = new Date().toISOString().replace(/[:.]/g, '-');
                res.writeHead(200, {
                  'Content-Type': 'application/pdf',
                  'Content-Disposition': `attachment; filename="${normalizedTemplate}-${pdfStamp}.pdf"`,
                  'Content-Length': pdfBuffer.length,
                });
                res.end(pdfBuffer);
                log.info('Template-based PDF streamed', {
                  template: normalizedTemplate,
                  bytes: pdfBuffer.length,
                  latencyMs,
                });
                return;
              }

              json(res, {
                ok: true,
                report,
                performance: {
                  latencyMs,
                  eventCount: report.meta?.eventCount || 0,
                },
                timestamp: new Date().toISOString(),
              });
              return;
            } catch (err) {
              if (err instanceof TemplateValidationError) {
                log.warn('Template validation failed', {
                  template: normalizedTemplate,
                  issues: err.issues,
                  error: err.message
                });
                // Include issues in the error message for better API usability
                const errorMessage = err.issues && err.issues.length > 0
                  ? `Template validation failed: ${err.issues.join(', ')}`
                  : 'Template validation failed';
                json(res, {
                  error: errorMessage,
                  issues: err.issues,
                }, 400);
                return;
              }

              const latencyMs = Math.round(performance.now() - startTime);
              log.error('Template-based report generation failed', {
                template: normalizedTemplate,
                error: err.message,
                stack: err.stack,
                latencyMs,
              });
              respondApiError(res, err, {
                message: 'Failed to generate template-based report',
                response: { template: normalizedTemplate },
              });
              return;
            }
          }

          // Threshold for async export (10K events)
          const ASYNC_THRESHOLD = 10000;

          // Large exports: create job and return 202 Accepted with jobId
          if (totalEvents >= ASYNC_THRESHOLD && exportJobQueue) {
            const job = exportJobQueue.createJob({
              format,
              template,
              filters: exportFilters,
              createdBy: requestUserId,
            });

            // Process export in background
            setImmediate(async () => {
              try {
                exportJobQueue.updateJobStatus(job.id, 'processing', { total: totalEvents });

                const filePath = exportJobQueue.getFilePath(job.id, format);
                const outputStream = createWriteStream(filePath);

                let exporter;
                if (format === 'csv') {
                  exporter = createCSVExporter({ outputStream, queryEngine, filters: exportFilters });
                } else if (format === 'json') {
                  exporter = createJSONExporter({ outputStream, queryEngine, filters: exportFilters });
                } else if (format === 'pdf') {
                  exporter = createPDFExporter({ outputStream, queryEngine, filters: exportFilters, template });
                }

                const result = await exporter.export();

                await new Promise((resolve, reject) => {
                  outputStream.on('finish', resolve);
                  outputStream.on('error', reject);
                  outputStream.end();
                });

                exportJobQueue.updateJobStatus(job.id, 'completed', {
                  file_path: filePath,
                  progress: totalEvents,
                });

                log.info('Background export completed', {
                  jobId: job.id,
                  format,
                  totalEvents,
                  filePath,
                });
              } catch (err) {
                exportJobQueue.updateJobStatus(job.id, 'failed', {
                  error: 'Export failed',
                });
                log.error('Background export failed', {
                  jobId: job.id,
                  error: err.message,
                  stack: err.stack,
                });
              }
            });

            // Return 202 Accepted with job ID
            json(res, {
              status: 'accepted',
              jobId: job.id,
              message: 'Export job created. Use GET /api/audit/export/status/:jobId to check progress.',
              totalEvents,
              estimatedSeconds: Math.ceil(totalEvents / 1000),
            }, 202);
            return;
          }

          // Small exports: process synchronously and stream directly
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

          try {
            if (format === 'csv') {
              res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="audit-export-${timestamp}.csv"`,
                'Transfer-Encoding': 'chunked',
              });

              const exporter = createCSVExporter({ outputStream: res, queryEngine, filters: exportFilters });
              await exporter.export();

            } else if (format === 'json') {
              res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="audit-export-${timestamp}.json"`,
                'Transfer-Encoding': 'chunked',
              });

              const exporter = createJSONExporter({ outputStream: res, queryEngine, filters: exportFilters });
              await exporter.export();

            } else if (format === 'pdf') {
              res.writeHead(200, {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="audit-export-${timestamp}.pdf"`,
                'Transfer-Encoding': 'chunked',
              });

              const exporter = createPDFExporter({ outputStream: res, queryEngine, filters: exportFilters, template });
              await exporter.export();
            }

            // The exporters write to outputStream but never end it — they do
            // not own the stream (the async job path hands them a file stream
            // it closes itself). Under 'Transfer-Encoding: chunked' the client
            // blocks forever waiting for the terminating chunk unless the
            // response is ended here. This path was unreachable until the
            // template gate above was fixed, so the omission never surfaced.
            res.end();

            log.info('Sync export completed', {
              format,
              template,
              scopeType: scope.type,
              scopeId: scope.id,
              totalEvents,
            });
          } catch (err) {
            log.error('Sync export failed', {
              error: err.message,
              stack: err.stack,
              format,
              scopeType: scope.type,
            });
            if (!res.headersSent) {
              respondApiError(res, err, { message: 'Export failed' });
            }
          }

        } catch (parseErr) {
          respondApiError(res, parseErr, { status: 400, message: 'Invalid JSON body' });
        }
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- GET /api/audit/export/status/:jobId ---
    const exportStatusMatch = path.match(/^\/api\/audit\/export\/status\/([^/]+)$/);
    if (exportStatusMatch && req.method === 'GET') {
      if (!requireOperatorRole('audit_export')) return true;

      const jobId = exportStatusMatch[1];

      if (!exportJobQueue) {
        json(res, { error: 'Export job queue not available' }, 503);
        return true;
      }

      try {
        const job = exportJobQueue.getJobStatus(jobId);

        if (!job) {
          json(res, { error: 'Job not found' }, 404);
          return true;
        }

        // Calculate progress percentage
        const progress = job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0;

        json(res, {
          jobId: job.id,
          status: job.status,
          format: job.format,
          template: job.template,
          progress,
          total: job.total,
          processed: job.progress,
          created_at: job.created_at,
          started_at: job.started_at,
          completed_at: job.completed_at,
          error: job.error ? 'Export failed' : null,
          download_url: job.status === 'completed' ? `/api/audit/export/download/${job.id}` : null,
        });
      } catch (err) {
        log.error('Failed to get job status', {
          jobId,
          error: err.message,
          stack: err.stack,
        });
        respondApiError(res, err, { message: 'Failed to get job status' });
      }

      return true;
    }

    // --- GET /api/audit/export/download/:id ---
    const exportDownloadMatch = path.match(/^\/api\/audit\/export\/download\/([^/]+)$/);
    if (exportDownloadMatch && req.method === 'GET') {
      if (!requireOperatorRole('audit_export')) return true;

      const downloadId = exportDownloadMatch[1];

      // 1) Try export job queue downloads first (async exports)
      if (exportJobQueue) {
        try {
          const job = exportJobQueue.getJobStatus(downloadId);

          if (job) {
            if (job.status !== 'completed') {
              json(res, {
                error: 'Export not completed yet',
                status: job.status,
                progress: job.total > 0 ? Math.round((job.progress / job.total) * 100) : 0,
              }, 400);
              return true;
            }

            if (!job.file_path || !existsSync(job.file_path)) {
              log.error('Export file not found', { jobId: downloadId, filePath: job.file_path });
              json(res, { error: 'Export file not found on disk' }, 404);
              return true;
            }

            const stats = statSync(job.file_path);

            let contentType;
            switch (job.format) {
              case 'csv':
                contentType = 'text/csv; charset=utf-8';
                break;
              case 'pdf':
                contentType = 'application/pdf';
                break;
              case 'json':
                contentType = 'application/json; charset=utf-8';
                break;
              default:
                contentType = 'application/octet-stream';
            }

            const filename = basename(job.file_path);

            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Content-Length': stats.size,
            });

            const fileStream = createReadStream(job.file_path);
            fileStream.on('error', (err) => {
              log.error('Error streaming export file', {
                jobId: downloadId,
                filePath: job.file_path,
                error: err.message,
              });
              if (!res.headersSent) {
                json(res, { error: 'Failed to stream export file' }, 500);
              }
            });

            fileStream.pipe(res);

            log.info('Export download started', {
              jobId: downloadId,
              format: job.format,
              fileSize: stats.size,
            });
            return true;
          }
        } catch (err) {
          log.error('Export job download failed', {
            jobId: downloadId,
            error: err.message,
            stack: err.stack,
          });
          if (!res.headersSent) {
            respondApiError(res, err, { message: 'Failed to download export' });
          }
          return true;
        }
      }

      // 2) Fallback to scheduled report downloads
      if (!deps.scheduledReportStore) {
        json(res, { error: 'Scheduled report store not available' }, 503);
        return true;
      }

      try {
        const report = deps.scheduledReportStore.getReport(downloadId);

        if (!report) {
          json(res, { error: 'Report not found' }, 404);
          return true;
        }

        const resolvedPath = resolve(report.file_path);
        const allowedDir = resolve(deps.scheduledReportStore.reportsDir);
        if (!resolvedPath.startsWith(allowedDir + sep) && resolvedPath !== allowedDir) {
          log.warn('Attempted download outside reports directory', { reportId: downloadId, filePath: report.file_path });
          json(res, { error: 'Access denied: invalid report path' }, 403);
          return true;
        }

        if (!existsSync(report.file_path)) {
          log.error('Report file not found on disk', {
            reportId: downloadId,
            filePath: report.file_path,
          });
          json(res, { error: 'Report file not found on disk' }, 404);
          return true;
        }

        const stats = statSync(report.file_path);

        let contentType;
        switch (report.format) {
          case 'csv':
            contentType = 'text/csv; charset=utf-8';
            break;
          case 'pdf':
            contentType = 'application/pdf';
            break;
          case 'json':
            contentType = 'application/json; charset=utf-8';
            break;
          default:
            contentType = 'application/octet-stream';
        }

        const filename = basename(report.file_path);

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': stats.size,
        });

        const fileStream = createReadStream(report.file_path);
        fileStream.on('error', (err) => {
          log.error('Error streaming scheduled report file', {
            reportId: downloadId,
            filePath: report.file_path,
            error: err.message,
          });
          if (!res.headersSent) {
            json(res, { error: 'Failed to stream report file' }, 500);
          } else {
            res.end();
          }
        });

        fileStream.pipe(res);

        log.info('Scheduled report download started', {
          reportId: downloadId,
          format: report.format,
          fileSize: stats.size,
          filename,
        });
      } catch (err) {
        log.error('Scheduled report download failed', {
          reportId: downloadId,
          error: err.message,
          stack: err.stack,
        });
        if (!res.headersSent) {
          respondApiError(res, err, { message: 'Failed to retrieve report' });
        }
      }

      return true;
    }

    // --- GET /api/audit/export/templates ---
    if (path === '/api/audit/export/templates' && req.method === 'GET') {
      if (!templateRegistry) {
        json(res, { error: 'Template registry not available' }, 503);
        return true;
      }

      try {
        const templates = templateRegistry.list();
        json(res, {
          ok: true,
          templates,
          count: templates.length,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to list templates', { error: err.message });
        respondApiError(res, err, { message: 'Failed to list templates' });
      }
      return true;
    }

    // --- POST /api/audit/export/schedule ---
    if (path === '/api/audit/export/schedule' && req.method === 'POST') {
      if (!requireOperatorRole('audit_schedule')) return true;
      
      if (!deps.scheduledReportStore) {
        json(res, { error: 'Scheduled report store not available' }, 503);
        return true;
      }

      handleBody(req, res, async body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          
          // Validate cronExpression
          const cronExpression = payload.cronExpression;
          if (!cronExpression || typeof cronExpression !== 'string' || cronExpression.trim() === '') {
            json(res, { error: 'cronExpression is required and must be a non-empty string' }, 400);
            return;
          }

          // Validate format
          const format = payload.format || 'json';
          const validFormats = new Set(['json', 'csv', 'pdf']);
          if (!validFormats.has(format)) {
            json(res, { 
              error: `Invalid format. Must be one of: json, csv, pdf`,
              validValues: ['json', 'csv', 'pdf']
            }, 400);
            return;
          }

         // Validate template
          const template = payload.template || 'activity-summary';
          
          // Normalize template name: support both kebab-case (registry format) and underscore format
          const normalizedTemplate = template.replace(/_/g, '-');
          
          const validTemplates = new Set(['activity-summary', 'incident-timeline']);
          if (!validTemplates.has(normalizedTemplate)) {
            json(res, {
              error: `Invalid template. Must be one of: activity-summary, incident-timeline`,
              validValues: ['activity-summary', 'incident-timeline']
            }, 400);
            return;
          }

          // Validate scope
          const scope = payload.scope || {};
          if (typeof scope !== 'object' || scope === null) {
            json(res, { error: 'scope must be an object' }, 400);
            return;
          }

          // Validate retention_count
          const retentionCount = typeof payload.retention_count === 'number' 
            ? Math.max(1, Math.min(payload.retention_count, 1000))
            : 10;

          try {
            const schedule = deps.scheduledReportStore.createSchedule({
              cronExpression: cronExpression.trim(),
              format,
              template: normalizedTemplate,
              scope,
              retention_count: retentionCount,
            });

            json(res, {
              ok: true,
              scheduleId: schedule.id,
              schedule,
            }, 201);
          } catch (err) {
            log.error('Failed to create schedule', { error: err.message, stack: err.stack });
            respondApiError(res, err, { message: 'Failed to create schedule' });
          }
        } catch (parseErr) {
          json(res, { error: 'Invalid JSON body' }, 400);
        }
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- GET /api/audit/export/schedules ---
    if (path === '/api/audit/export/schedules' && req.method === 'GET') {
      if (!requireOperatorRole('audit_schedule')) return true;
      
      if (!deps.scheduledReportStore) {
        json(res, { error: 'Scheduled report store not available' }, 503);
        return true;
      }

      try {
        const schedules = deps.scheduledReportStore.listSchedules();
        json(res, {
          ok: true,
          schedules,
          count: schedules.length,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to list schedules', { error: err.message });
        respondApiError(res, err, { message: 'Failed to list schedules' });
      }
      return true;
    }

    // --- DELETE /api/audit/export/schedule/:id ---
    if (path.startsWith('/api/audit/export/schedule/') && req.method === 'DELETE') {
      if (!requireOperatorRole('audit_schedule')) return true;
      
      if (!deps.scheduledReportStore) {
        json(res, { error: 'Scheduled report store not available' }, 503);
        return true;
      }

      const scheduleId = path.split('/').pop();
      
      try {
        const deleted = deps.scheduledReportStore.deleteSchedule(scheduleId);
        
        if (!deleted) {
          json(res, { error: 'Schedule not found' }, 404);
          return true;
        }

        json(res, {
          ok: true,
          scheduleId,
          message: 'Schedule deleted successfully',
        });
      } catch (err) {
        log.error('Failed to delete schedule', { scheduleId, error: err.message });
        respondApiError(res, err, { message: 'Failed to delete schedule' });
      }
      return true;
    }

    // --- Audit search ---
    if (path === '/api/audit/search' && req.method === 'GET') {
      if (!timelineStore || typeof timelineStore.search !== 'function') {
        json(res, { error: 'Timeline store not available or search not supported' }, 503);
        return true;
      }

      // Parse and validate free-text query
      const searchQuery = url.searchParams.get('q');
      if (searchQuery === null || searchQuery === undefined) {
        json(res, { error: 'query parameter q is required' }, 400);
        return true;
      }
      const trimmedQuery = searchQuery.trim();
      if (trimmedQuery === '') {
        json(res, { error: 'query parameter q must be a non-empty string' }, 400);
        return true;
      }

      // Parse and validate limit
      const searchLimitRaw = url.searchParams.get('limit');
      let searchLimit = searchLimitRaw !== null ? parseInt(searchLimitRaw, 10) : 50;
      if (Number.isNaN(searchLimit)) {
        json(res, { error: 'limit must be an integer' }, 400);
        return true;
      }
      searchLimit = Math.max(1, Math.min(searchLimit, 500));

      // Parse and validate offset
      const searchOffsetRaw = url.searchParams.get('offset');
      let searchOffset = searchOffsetRaw !== null ? parseInt(searchOffsetRaw, 10) : 0;
      if (Number.isNaN(searchOffset)) {
        json(res, { error: 'offset must be an integer' }, 400);
        return true;
      }
      searchOffset = Math.max(0, searchOffset);

      // Parse structured filters
      const searchAgent = url.searchParams.get('agent')?.trim() || undefined;
      const searchProject = url.searchParams.get('project')?.trim() || undefined;
      const searchType = url.searchParams.get('type')?.trim() || undefined;
      
      // Validate type if provided
      if (searchType && !VALID_EVENT_TYPES.has(searchType)) {
        json(res, { error: `type must be one of ${[...VALID_EVENT_TYPES].join(', ')}` }, 400);
        return true;
      }
      // The FTS index stores its own type vocabulary (timeline-store.js
      // backfill/triggers), which diverges from the schema names for three
      // types. Without this map, ?type=anomaly_alert validated fine and then
      // matched zero rows — forever. Granular tool_invocation_* variants are
      // deliberately NOT collapsed into 'tool_invocation': filtering for
      // errors must not silently return successes.
      const SEARCH_TYPE_TO_INDEX = {
        anomaly_alert: 'anomaly',
        guardrail_outcome: 'guardrail',
        cost_dispatch: 'cost',
      };
      const indexType = searchType ? (SEARCH_TYPE_TO_INDEX[searchType] || searchType) : undefined;

      // Parse date range filters
      const searchFromRaw = url.searchParams.get('from');
      const searchToRaw = url.searchParams.get('to');
      let searchSince;
      if (searchFromRaw) {
        const d = new Date(searchFromRaw);
        if (isNaN(d.getTime())) {
          json(res, { error: 'from must be a valid ISO timestamp' }, 400);
          return true;
        }
        searchSince = d.toISOString();
      }
      let searchUntil;
      if (searchToRaw) {
        const d = new Date(searchToRaw);
        if (isNaN(d.getTime())) {
          json(res, { error: 'to must be a valid ISO timestamp' }, 400);
          return true;
        }
        searchUntil = d.toISOString();
      }

      // Campaign ID filter (from query param)
      const searchCampaignId = url.searchParams.get('campaign')?.trim() || undefined;

      try {
        let searchCampaignIds;
        if (searchProject) {
          if (!stateManager.getProject(searchProject)) {
            json(res, { error: `Project "${searchProject}" not found` }, 404);
            return true;
          }
          searchCampaignIds = campaignManager.listCampaigns(searchProject).map(campaign => campaign.id);
          if (searchCampaignId) {
            searchCampaignIds = searchCampaignIds.includes(searchCampaignId) ? [searchCampaignId] : [];
          }
        }
        const searchFilters = {
          query: trimmedQuery,
          agentId: searchAgent,
          campaignId: searchProject ? undefined : searchCampaignId,
          campaignIds: searchCampaignIds,
          eventType: indexType,
          since: searchSince,
          until: searchUntil,
          limit: searchLimit,
          offset: searchOffset,
        };

        const { events: rawEvents = [], total = 0 } = timelineStore.search(searchFilters);

        const events = rawEvents.map((event) => {
          const correlationKeys = extractCorrelationKeys(event);
          
          return {
            ...event,
            correlationKeys,
            summary: event.summary ?? event.data?.summary ?? 'Timeline event',
            _rationaleSummary: buildRationaleSummary(event, null),
            _deepLinks: buildDeepLinks(event, correlationKeys),
          };
        });

        json(res, {
          events,
          total,
          query: trimmedQuery,
          offset: searchOffset,
          limit: searchLimit,
          hasMore: total > searchOffset + searchLimit,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to search audit events', { error: err.message, query: trimmedQuery });
        json(res, { error: 'Failed to search audit events' }, 500);
      }
      return true;
    }

    // --- Audit events ---
    if (path === '/api/audit/events' && req.method === 'GET') {
      if (!timelineStore || typeof timelineStore.query !== 'function') {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      // Parse and validate limit
      const auditLimitRaw = url.searchParams.get('limit');
      let auditLimit = auditLimitRaw !== null ? parseInt(auditLimitRaw, 10) : 50;
      if (Number.isNaN(auditLimit)) {
        json(res, { error: 'limit must be an integer' }, 400);
        return true;
      }
      auditLimit = Math.max(1, Math.min(auditLimit, 500));

      // Decode cursor → offset (cursor encodes { offset: N })
      const auditCursorRaw = url.searchParams.get('cursor');
      let auditOffset = 0;
      if (auditCursorRaw) {
        try {
          const decoded = JSON.parse(Buffer.from(auditCursorRaw, 'base64').toString('utf8'));
          if (typeof decoded.offset !== 'number' || decoded.offset < 0) throw new Error('invalid');
          auditOffset = decoded.offset;
        } catch {
          json(res, { error: 'cursor must be a valid pagination cursor' }, 400);
          return true;
        }
      }

      // Normalize type
      const auditTypeRaw = url.searchParams.get('type');
      const auditType = parseTimelineTypeFilter(auditTypeRaw);
      if (auditType?.error) {
        json(res, { error: auditType.error }, 400);
        return true;
      }

      // Validate from/to timestamps (mapped to since/until)
      const fromRaw = url.searchParams.get('from');
      const toRaw = url.searchParams.get('to');
      let auditSince;
      if (fromRaw) {
        const d = new Date(fromRaw);
        if (isNaN(d.getTime())) { json(res, { error: 'from must be a valid ISO timestamp' }, 400); return true; }
        auditSince = d.toISOString();
      }
      let auditUntil;
      if (toRaw) {
        const d = new Date(toRaw);
        if (isNaN(d.getTime())) { json(res, { error: 'to must be a valid ISO timestamp' }, 400); return true; }
        auditUntil = d.toISOString();
      }

      // Param mapping: agent→agentId, campaign→campaignId, project accepted (not filtered at DB level)
      const auditAgentId = url.searchParams.get('agent')?.trim() || undefined;
      const auditCampaignId = url.searchParams.get('campaign')?.trim() || undefined;
      const auditTraceId = url.searchParams.get('traceId')?.trim() || undefined;
      const auditDispatchId = url.searchParams.get('dispatchId')?.trim() || undefined;
      const auditSessionId = url.searchParams.get('sessionId')?.trim() || undefined;
      // project param accepted for future use; not yet filterable at DB level

      try {
        const auditFilters = {
          type: auditType,
          campaignId: auditCampaignId,
          dispatchId: auditDispatchId,
          agentId: auditAgentId,
          traceId: auditTraceId,
          sessionId: auditSessionId,
          since: auditSince,
          until: auditUntil,
          limit: auditLimit + 1,
          offset: auditOffset,
        };

        const { events: rawEvents = [], total = 0 } = timelineStore.query(auditFilters);
        const filteredEvents = auditSessionId
          ? rawEvents.filter(event => {
              const payload = event.data || event.payload || {};
              const eventSessionId =
                event.session_id
                || payload?.sessionId
                || payload?.session_id
                || null;
              return eventSessionId === auditSessionId;
            })
          : rawEvents;

        const hasMore = filteredEvents.length > auditLimit;
        const pageRaw = filteredEvents.slice(0, auditLimit);
        const totalForResponse = auditSessionId ? filteredEvents.length : total;
        const nextCursor = hasMore
          ? Buffer.from(JSON.stringify({ offset: auditOffset + auditLimit })).toString('base64')
          : null;

        const events = pageRaw.map(event => ({
          id: event.id,
          type: event.type,
          timestamp: event.event_ts,
          session_id: event.session_id || event.data?.sessionId || event.data?.session_id || null,
          summary: event.data?.summary ?? `${event.type ?? 'audit'} event`,
          correlationKeys: extractCorrelationKeys(event),
          data: event.data ?? {},
        }));

        json(res, { events, nextCursor, total: totalForResponse });
      } catch (err) {
        log.error('Failed to query audit events', { error: err.message });
        json(res, { error: 'Failed to query audit events' }, 500);
      }
      return true;
    }

    // --- Campaign-scoped timeline ---
    const campaignTimelineMatch = path.match(/^\/api\/campaigns\/([^/]+)\/timeline$/);
    if (campaignTimelineMatch && req.method === 'GET') {
      const campaignIdFromPath = decodeURIComponent(campaignTimelineMatch[1]);
      if (!campaignIdFromPath) {
        json(res, { error: 'campaign_id must be a non-empty string' }, 400);
        return true;
      }

      const limitRaw = url.searchParams.get('limit');
      const offsetRaw = url.searchParams.get('offset');
      const cursorRaw = url.searchParams.get('cursor') || undefined;
      const typeRaw = url.searchParams.get('type') || url.searchParams.get('event_type');
      const agentId = url.searchParams.get('agentId') || undefined;
      const provider = url.searchParams.get('provider') || undefined;
      const traceId = url.searchParams.get('traceId') || undefined;
      const dispatchIdRaw = url.searchParams.get('dispatchId');
      const sinceRaw = url.searchParams.get('since') || url.searchParams.get('start_time') || undefined;
      const untilRaw = url.searchParams.get('until') || url.searchParams.get('end_time') || undefined;

      let limit = limitRaw !== null ? parseInt(limitRaw, 10) : 100;
      if (Number.isNaN(limit)) {
        json(res, { error: 'limit must be an integer' }, 400);
        return true;
      }
      limit = Math.max(1, Math.min(limit, 500));

      let offset = offsetRaw !== null ? parseInt(offsetRaw, 10) : 0;
      if (Number.isNaN(offset)) {
        json(res, { error: 'offset must be an integer' }, 400);
        return true;
      }
      offset = Math.max(0, offset);

      // Cursor-based pagination: validate if provided
      let cursor;
      if (cursorRaw !== undefined) {
        const decoded = decodeCursor(cursorRaw);
        if (!decoded) {
          json(res, { error: 'cursor must be a valid base64-encoded pagination cursor' }, 400);
          return true;
        }
        cursor = cursorRaw;
      }

      // campaignId comes from the URL path, not query parameters
      const campaignId = campaignIdFromPath;

      let dispatchId;
      if (dispatchIdRaw !== null) {
        dispatchId = dispatchIdRaw.trim();
        if (!dispatchId) {
          json(res, { error: 'dispatchId must be a non-empty string' }, 400);
          return true;
        }
      }

      const type = parseTimelineTypeFilter(typeRaw);
      if (type?.error) {
        json(res, { error: type.error }, 400);
        return true;
      }

      let since;
      if (sinceRaw !== undefined) {
        const sinceDate = new Date(sinceRaw);
        if (isNaN(sinceDate.getTime())) {
          json(res, { error: 'since must be a valid ISO timestamp' }, 400);
          return true;
        }
        since = sinceDate.toISOString();
      }

      let until;
      if (untilRaw !== undefined) {
        const untilDate = new Date(untilRaw);
        if (isNaN(untilDate.getTime())) {
          json(res, { error: 'until must be a valid ISO timestamp' }, 400);
          return true;
        }
        until = untilDate.toISOString();
      }

      const filters = {
        type,
        campaignId: campaignIdFromPath,
        dispatchId,
        agentId,
        provider,
        traceId,
        since,
        until,
        limit,
        ...(cursor ? { cursor } : { offset }),
      };

      if (timelineStore && typeof timelineStore.query === 'function') {
        try {
          const result = timelineStore.query(filters);
          const { events: rawEvents = [], total = 0, total_count, next_cursor = null } = result;
          
          // Build a lookup of dispatch rationales by dispatchId for enrichment
          const dispatchIds = [...new Set(rawEvents
            .filter(e => e.type === 'dispatch' || e.type === 'dispatch_decision')
            .map(e => extractCorrelationKeys(e).dispatchId)
            .filter(Boolean)
          )];
          
          const rationaleCache = new Map();
          if (dispatchLog && dispatchIds.length > 0 && typeof dispatchLog.getDispatchRationale === 'function') {
            for (const dispatchId of dispatchIds) {
              try {
                rationaleCache.set(dispatchId, dispatchLog.getDispatchRationale(dispatchId, timelineStore));
              } catch (err) {
                log.warn(`Failed to fetch rationale for dispatch ${dispatchId}: ${err.message}`);
              }
            }
          }
          
          const events = rawEvents.map((event) => {
            const correlationKeys = extractCorrelationKeys(event);
            const rationale = correlationKeys.dispatchId 
              ? rationaleCache.get(correlationKeys.dispatchId) 
              : null;
            
            return {
              ...event,
              correlationKeys,
              summary: event.summary ?? event.data?.summary ?? 'Timeline event',
              _rationaleSummary: buildRationaleSummary(event, rationale),
              _deepLinks: buildDeepLinks(event, correlationKeys),
            };
          });

          json(res, {
            events,
            total,
            total_count: total_count ?? total,
            next_cursor,
            offset: cursor ? undefined : offset,
            limit,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          log.error('Failed to load campaign timeline from timelineStore', { error: err.message });
          json(res, { error: 'Failed to load timeline' }, 500);
        }
        return true;
      }

      json(res, { error: 'Unified timeline store not available or misconfigured' }, 503);
      return true;
    }

    // --- Dispatch-scoped timeline ---
    const dispatchTimelineMatch = path.match(/^\/api\/dispatches\/([^/]+)\/timeline$/);
    if (dispatchTimelineMatch && req.method === 'GET') {
      const dispatchIdFromPath = decodeURIComponent(dispatchTimelineMatch[1]);
      if (!dispatchIdFromPath) {
        json(res, { error: 'dispatch_id must be a non-empty string' }, 400);
        return true;
      }

      const limitRaw = url.searchParams.get('limit');
      const offsetRaw = url.searchParams.get('offset');
      const cursorRaw = url.searchParams.get('cursor') || undefined;
      const typeRaw = url.searchParams.get('type') || url.searchParams.get('event_type');
      const agentId = url.searchParams.get('agentId') || undefined;
      const provider = url.searchParams.get('provider') || undefined;
      const traceId = url.searchParams.get('traceId') || undefined;
      const campaignId = url.searchParams.get('campaignId') || undefined;
      const sinceRaw = url.searchParams.get('since') || url.searchParams.get('start_time') || undefined;
      const untilRaw = url.searchParams.get('until') || url.searchParams.get('end_time') || undefined;

      let limit = limitRaw !== null ? parseInt(limitRaw, 10) : 100;
      if (Number.isNaN(limit)) {
        json(res, { error: 'limit must be an integer' }, 400);
        return true;
      }
      limit = Math.max(1, Math.min(limit, 500));

      let offset = offsetRaw !== null ? parseInt(offsetRaw, 10) : 0;
      if (Number.isNaN(offset)) {
        json(res, { error: 'offset must be an integer' }, 400);
        return true;
      }
      offset = Math.max(0, offset);

      let cursor;
      if (cursorRaw !== undefined) {
        const decoded = decodeCursor(cursorRaw);
        if (!decoded) {
          json(res, { error: 'cursor must be a valid base64-encoded pagination cursor' }, 400);
          return true;
        }
        cursor = cursorRaw;
      }

      const type = parseTimelineTypeFilter(typeRaw);
      if (type?.error) {
        json(res, { error: type.error }, 400);
        return true;
      }

      let since;
      if (sinceRaw !== undefined) {
        const sinceDate = new Date(sinceRaw);
        if (isNaN(sinceDate.getTime())) {
          json(res, { error: 'since must be a valid ISO timestamp' }, 400);
          return true;
        }
        since = sinceDate.toISOString();
      }

      let until;
      if (untilRaw !== undefined) {
        const untilDate = new Date(untilRaw);
        if (isNaN(untilDate.getTime())) {
          json(res, { error: 'until must be a valid ISO timestamp' }, 400);
          return true;
        }
        until = untilDate.toISOString();
      }

      const filters = {
        type,
        campaignId,
        dispatchId: dispatchIdFromPath,
        agentId,
        provider,
        traceId,
        since,
        until,
        limit,
        ...(cursor ? { cursor } : { offset }),
      };

      if (timelineStore && typeof timelineStore.query === 'function') {
        try {
          const result = timelineStore.query(filters);
          const { events: rawEvents = [], total = 0, total_count, next_cursor = null } = result;
          
          // Build a lookup of dispatch rationales by dispatchId for enrichment
          const dispatchIds = [...new Set(rawEvents
            .filter(e => e.type === 'dispatch' || e.type === 'dispatch_decision')
            .map(e => extractCorrelationKeys(e).dispatchId)
            .filter(Boolean)
          )];
          
          const rationaleCache = new Map();
          if (dispatchLog && dispatchIds.length > 0 && typeof dispatchLog.getDispatchRationale === 'function') {
            for (const dispatchId of dispatchIds) {
              try {
                rationaleCache.set(dispatchId, dispatchLog.getDispatchRationale(dispatchId, timelineStore));
              } catch (err) {
                log.warn(`Failed to fetch rationale for dispatch ${dispatchId}: ${err.message}`);
              }
            }
          }
          
          const events = rawEvents.map((event) => {
            const correlationKeys = extractCorrelationKeys(event);
            const rationale = correlationKeys.dispatchId 
              ? rationaleCache.get(correlationKeys.dispatchId) 
              : null;
            
            return {
              ...event,
              correlationKeys,
              summary: event.summary ?? event.data?.summary ?? 'Timeline event',
              _rationaleSummary: buildRationaleSummary(event, rationale),
              _deepLinks: buildDeepLinks(event, correlationKeys),
            };
          });

          json(res, {
            events,
            total,
            total_count: total_count ?? total,
            next_cursor,
            offset: cursor ? undefined : offset,
            limit,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          log.error('Failed to load dispatch timeline from timelineStore', { error: err.message });
          json(res, { error: 'Failed to load timeline' }, 500);
        }
        return true;
      }

      json(res, { error: 'Unified timeline store not available or misconfigured' }, 503);
      return true;
    }

    // --- Routing Proposals ---
    if (path === '/api/routing-proposals' && req.method === 'GET') {
      if (!requireOperatorRole()) return true;

      const stateFilter = url.searchParams.get('state');
      const limitRaw = url.searchParams.get('limit');
      const afterEventId = url.searchParams.get('afterEventId');
      const offsetRaw = url.searchParams.get('offset');

      let limit = limitRaw !== null ? parseInt(limitRaw, 10) : 50;
      if (Number.isNaN(limit)) {
        json(res, { error: 'limit must be an integer' }, 400);
        return true;
      }
      limit = Math.max(1, Math.min(limit, 200));

      let offset = offsetRaw !== null ? parseInt(offsetRaw, 10) : 0;
      if (Number.isNaN(offset)) {
        json(res, { error: 'offset must be an integer' }, 400);
        return true;
      }
      offset = Math.max(0, offset);

      if (stateFilter && !['pending', 'approved', 'rejected'].includes(stateFilter)) {
        json(res, { error: 'state must be one of: pending, approved, rejected' }, 400);
        return true;
      }

      if (!timelineStore || typeof timelineStore.query !== 'function') {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      try {
        const filters = {
          type: 'routing_proposal',
          limit,
          ...(afterEventId ? { afterEventId } : { offset }),
        };

        if (stateFilter) {
          filters.state = stateFilter;
        }

        const result = timelineStore.query(filters);
        const { events: rawEvents = [], total = 0, next_cursor = null } = result;

        const proposals = rawEvents.map(event => ({
          id: event.id,
          type: event.type,
          timestamp: event.timestamp,
          summary: event.summary,
          correlationKeys: extractCorrelationKeys(event),
          data: event.data,
          state: event.data?.state || 'pending',
          proposalId: event.data?.proposalId,
          sourceType: event.data?.sourceType,
          sourceRecommendationId: event.data?.sourceRecommendationId,
          proposedWeights: event.data?.proposedWeights,
          currentWeights: event.data?.currentWeights,
          confidence: event.data?.confidence,
          rationale: event.data?.rationale,
          _deepLinks: buildDeepLinks(event, extractCorrelationKeys(event)),
        }));

        json(res, {
          proposals,
          total,
          next_cursor,
          offset: afterEventId ? undefined : offset,
          limit,
          filters: {
            state: stateFilter || null,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to query routing proposals', { error: err.message });
        json(res, { error: 'Failed to query routing proposals' }, 500);
      }
      return true;
    }

    const proposalDetailMatch = path.match(/^\/api\/routing-proposals\/([^/]+)$/);
    if (proposalDetailMatch && req.method === 'GET') {
      if (!requireOperatorRole()) return true;

      const proposalId = decodeURIComponent(proposalDetailMatch[1]);
      if (!proposalId || proposalId.trim() === '') {
        json(res, { error: 'proposalId must be a non-empty string' }, 400);
        return true;
      }

      if (!timelineStore || typeof timelineStore.query !== 'function') {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }

      try {
        const proposalEvent = timelineStore.query({
          type: 'routing_proposal',
          limit: 1,
        }).events?.find(e => e.data?.proposalId === proposalId || e.id === proposalId);

        if (!proposalEvent) {
          json(res, { error: 'Proposal not found' }, 404);
          return true;
        }

        const correlationId = proposalEvent.data?.correlationId || proposalEvent.id;
        // query() takes (projectId, opts) — passing an options object as the
        // first argument made _path() call join() with an object and throw
        // "The 'path' argument must be of type string". This endpoint has no
        // projectId in scope, which is exactly what queryByCorrelationId is
        // for: it walks the project list itself.
        const auditEntries = operatorAuditStore?.queryByCorrelationId
          ? operatorAuditStore.queryByCorrelationId(correlationId) || []
          : [];

        const proposal = {
          id: proposalEvent.id,
          type: proposalEvent.type,
          timestamp: proposalEvent.timestamp,
          summary: proposalEvent.summary,
          correlationKeys: extractCorrelationKeys(proposalEvent),
          data: proposalEvent.data,
          state: proposalEvent.data?.state || 'pending',
          proposalId: proposalEvent.data?.proposalId,
          sourceType: proposalEvent.data?.sourceType,
          sourceRecommendationId: proposalEvent.data?.sourceRecommendationId,
          proposedWeights: proposalEvent.data?.proposedWeights,
          currentWeights: proposalEvent.data?.currentWeights,
          confidence: proposalEvent.data?.confidence,
          rationale: proposalEvent.data?.rationale,
          auditTrail: auditEntries.map(entry => ({
            id: entry.id || entry.timestamp,
            timestamp: entry.timestamp || entry.event_ts,
            action: entry.action || entry.action_type,
            operatorId: entry.operatorId || null,
            reason: entry.reason || null,
            status: entry.status || null,
          })),
          _deepLinks: buildDeepLinks(proposalEvent, extractCorrelationKeys(proposalEvent)),
        };

        json(res, proposal);
      } catch (err) {
        log.error('Failed to fetch routing proposal detail', { proposalId, error: err.message });
        json(res, { error: 'Failed to fetch proposal details' }, 500);
      }
      return true;
    }

    // --- POST /api/routing-proposals/:proposalId/approve ---
    const proposalApproveMatch = path.match(/^\/api\/routing-proposals\/([^/]+)\/approve$/);
    if (proposalApproveMatch && req.method === 'POST') {
      if (!requireOperatorRole('routing_proposal_approve')) return true;
      if (!weightOverrides || !timelineStore || !operatorActionStore || !operatorAuditStore) {
        json(res, { error: 'Required services not available' }, 503);
        return true;
      }

      handleBody(req, res, async (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const actionId = getIdempotencyKey(req, payload);
        if (!actionId) {
          json(res, { error: 'idempotency key is required' }, 400);
          return;
        }

        const existing = getIdempotentResult(actionId);
        if (respondIdempotent(existing)) return;

        const proposalId = decodeURIComponent(proposalApproveMatch[1]);
        if (!proposalId || proposalId.trim() === '') {
          const responseBody = { error: 'proposalId is required', actionId };
          recordIdempotentResult(actionId, 'routing_proposal_approve', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        if (!timelineStore || typeof timelineStore.query !== 'function') {
          const responseBody = { error: 'Timeline store not available', actionId };
          recordIdempotentResult(actionId, 'routing_proposal_approve', 503, responseBody, { payload });
          json(res, responseBody, 503);
          return;
        }

        let proposalEvent = null;
        try {
          proposalEvent = timelineStore.query({
            type: 'routing_proposal',
            limit: 1,
          }).events?.find(e => e.data?.proposalId === proposalId || e.id === proposalId);
        } catch (err) {
          log.debug('Failed to query proposal', { proposalId, error: err.message });
        }

        if (!proposalEvent) {
          const responseBody = { error: 'Proposal not found', actionId, proposalId };
          recordIdempotentResult(actionId, 'routing_proposal_approve', 404, responseBody, { payload });
          json(res, responseBody, 404);
          return;
        }

        const currentState = proposalEvent.data?.state || 'pending';
        if (currentState !== 'pending') {
          const responseBody = { 
            error: `Cannot approve proposal in '${currentState}' state`, 
            actionId, 
            proposalId,
            currentState,
            requiredState: 'pending'
          };
          recordIdempotentResult(actionId, 'routing_proposal_approve', 409, responseBody, { payload });
          json(res, responseBody, 409);
          return;
        }

        const proposedWeights = proposalEvent.data?.proposedWeights;
        if (!proposedWeights || typeof proposedWeights !== 'object' || Object.keys(proposedWeights).length === 0) {
          const responseBody = { error: 'Proposal has no valid weights to apply', actionId, proposalId };
          recordIdempotentResult(actionId, 'routing_proposal_approve', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const ttlMs = typeof payload.ttlMs === 'number'
          ? payload.ttlMs
          : (typeof payload.ttlSeconds === 'number'
            ? payload.ttlSeconds * 1000
            : (typeof payload.ttlMinutes === 'number' ? payload.ttlMinutes * 60_000 : null));
        if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
          const responseBody = { error: 'ttlMs must be a positive number', actionId, proposalId };
          recordIdempotentResult(actionId, 'routing_proposal_approve', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const operatorId = requestUserId || 'system';
        const reason = payload.reason || 'operator approval';
        const correlationId = proposalEvent.data?.correlationId || proposalEvent.id;
        const resolved = resolveCorrelationKeysFromId(correlationId);

        let beforeOverride = null;
        if (weightOverrides && typeof weightOverrides.getActive === 'function') {
          try {
            beforeOverride = await weightOverrides.getActive();
          } catch (err) {
            log.debug('Failed to read current weight override before apply', { error: err.message });
          }
        }

        let override;
        try {
          override = await weightOverrides.apply(proposedWeights, {
            reason,
            appliedBy: operatorId,
            correlationId,
            ttlMs: ttlMs || Math.max(0, proposalEvent.data?.expiresAt 
              ? (new Date(proposalEvent.data.expiresAt).getTime() - Date.now()) 
              : null),
            expiresAt: proposalEvent.data?.expiresAt || (ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null),
            sourceProposalId: proposalId,
          });
        } catch (err) {
          const responseBody = { error: 'Failed to apply weight override from proposal', actionId, proposalId };
          log.error('Failed to apply weight override from proposal', { proposalId, error: err.message });
          recordIdempotentResult(actionId, 'routing_proposal_approve', 500, responseBody, { payload });
          json(res, responseBody, 500);
          return;
        }

        try {
          timelineStore.updateProposalState(proposalId, 'approved', {
            approvedAt: new Date().toISOString(),
            approvedBy: operatorId,
            approvalReason: reason,
          });
        } catch (err) {
          log.error('Failed to update proposal state to approved', { proposalId, error: err.message });
          const responseBody = { error: 'Failed to update proposal state', actionId, proposalId };
          recordIdempotentResult(actionId, 'routing_proposal_approve', 500, responseBody, { payload });
          json(res, responseBody, 500);
          return;
        }

        emitOperatorActionTimelineEvent('routing_proposal_approved', {
          idempotencyKey: actionId,
          operatorId,
          status: 'completed',
          correlationId,
          campaignId: resolved.campaignId,
          dispatchId: resolved.dispatchId,
          traceId: resolved.traceId,
          agentId: resolved.agentId,
          provider: resolved.provider,
        targetParams: {
            proposalId,
            weights: proposedWeights,
            expiresAt: override.expiresAt || null,
            ttlMs: ttlMs || null,
          },
          data: {
            action: 'routing_proposal_approved',
            proposalId,
            weights: proposedWeights,
            operatorId,
            reason,
            correlationChain: {
              originalCorrelationId: correlationId,
              sourceProposalId: proposalId,
            },
          },
        });

        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'routing_proposal_operator_approved',
            target: 'routing_proposal',
            beforeState: { state: currentState, proposal: proposalEvent.data },
            afterState: { state: 'approved', override },
            operatorId,
            action: 'routing_proposal_approved',
            resourceType: 'routing_proposal',
            resourceId: proposalId,
            correlationId,
            actionId,
            idempotencyKey: actionId,
            status: 'success',
            decision: 'allow',
            reason,
            payload: {
              proposalId,
              weights: proposedWeights,
              ttlMs: ttlMs || null,
              expiresAt: override.expiresAt || null,
              sourceProposalId: proposalId,
              originalCorrelationId: correlationId,
            },
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append(payload.projectId || 'default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        broadcast({
          type: 'steering:action',
          subtype: STEERING_EVENT_TYPES.weight_override,
          actionType: 'routing_proposal_approved',
          correlationId,
          payloadSummary: {
            proposalId,
            weights: proposedWeights,
            expiresAt: override.expiresAt || null,
            ttlMs: ttlMs || null,
            operatorId,
            reason,
          },
          serverTimestamp: new Date().toISOString(),
        });

        const responseBody = {
          ok: true,
          actionId,
          actionType: 'routing_proposal_approved',
          proposalId,
          correlationId,
          operatorId,
          override,
          expiresAt: override.expiresAt || null,
          ttlMs: ttlMs || null,
          state: 'approved',
          timestamp: new Date().toISOString(),
        };

        recordIdempotentResult(actionId, 'routing_proposal_approve', 200, responseBody, { 
          dispatchId: resolved.dispatchId, 
          traceId: resolved.traceId, 
          payload 
        });
        json(res, responseBody, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Causal Graph Traversal ---
    const causalGraphMatch = path.match(/^\/api\/timeline\/causal\/([^/]+)$/);
    if (causalGraphMatch && req.method === 'GET') {
      const correlationId = decodeURIComponent(causalGraphMatch[1]);
      if (!correlationId || correlationId.trim() === '') {
        json(res, { error: 'correlationId must be a non-empty string' }, 400);
        return true;
      }

      if (!timelineStore?.db) {
        json(res, { error: 'Timeline store not available or misconfigured' }, 503);
        return true;
      }

      try {
        const subgraph = buildCausalSubgraph(correlationId, timelineStore);
        json(res, {
          correlationId: subgraph.correlationId,
          rootEvent: subgraph.rootEvent,
          events: subgraph.events,
          edges: subgraph.edges,
          metadata: subgraph.metadata,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to build causal subgraph', { correlationId, error: err.message, stack: err.stack });
        respondApiError(res, err, { message: 'Failed to build causal subgraph' });
      }
      return true;
    }

    // --- POST /api/routing-proposals/:proposalId/reject ---
    const proposalRejectMatch = path.match(/^\/api\/routing-proposals\/([^/]+)\/reject$/);
    if (proposalRejectMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      if (!timelineStore || typeof timelineStore.query !== 'function') {
        json(res, { error: 'Timeline store not available' }, 503);
        return true;
      }
      if (!operatorAuditStore || typeof operatorAuditStore.append !== 'function') {
        json(res, { error: 'Operator audit store not available' }, 503);
        return true;
      }

      handleBody(req, res, async (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const actionId = getIdempotencyKey(req, payload);
        if (!actionId) {
          json(res, { error: 'idempotency key is required' }, 400);
          return;
        }

        const existing = getIdempotentResult(actionId);
        if (respondIdempotent(existing)) return;

        const proposalId = decodeURIComponent(proposalRejectMatch[1]);
        if (!proposalId || proposalId.trim() === '') {
          const responseBody = { error: 'proposalId must be a non-empty string', actionId };
          recordIdempotentResult(actionId, 'routing_proposal_reject', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const reason = typeof payload.reason === 'string' && payload.reason.trim()
          ? payload.reason.trim()
          : null;
        if (!reason) {
          const responseBody = { error: 'reason is required for rejection', actionId, proposalId };
          recordIdempotentResult(actionId, 'routing_proposal_reject', 400, responseBody, { payload, proposalId });
          json(res, responseBody, 400);
          return;
        }

        const proposalEvent = timelineStore.query({
          type: 'routing_proposal',
          limit: 1,
        }).events?.find(e => e.data?.proposalId === proposalId || e.id === proposalId);

        if (!proposalEvent) {
          const responseBody = { error: 'Proposal not found', actionId, proposalId };
          recordIdempotentResult(actionId, 'routing_proposal_reject', 404, responseBody, { payload, proposalId });
          json(res, responseBody, 404);
          return;
        }

        const currentState = proposalEvent.data?.state || 'pending';
        if (currentState !== 'pending') {
          const responseBody = {
            error: `Cannot reject proposal in '${currentState}' state`,
            actionId,
            proposalId,
            currentState,
            requiredState: 'pending',
          };
          recordIdempotentResult(actionId, 'routing_proposal_reject', 409, responseBody, { payload, proposalId });
          json(res, responseBody, 409);
          return;
        }

        const operatorId = requestUserId || 'system';
        const correlationId = proposalEvent.data?.correlationId || proposalEvent.id;
        const resolved = resolveCorrelationKeysFromId(correlationId);

        const now = new Date().toISOString();
        const updatedEvent = {
          ...proposalEvent,
          timestamp: now,
          data: {
            ...proposalEvent.data,
            state: 'rejected',
            rejectedAt: now,
            rejectedBy: operatorId,
            rejectionReason: reason,
          },
        };

        try {
          if (typeof timelineStore.append === 'function') {
            timelineStore.append('routing_proposal', updatedEvent.data, {
              campaignId: resolved.campaignId,
              dispatchId: resolved.dispatchId,
              traceId: resolved.traceId,
            });
          } else if (typeof timelineStore.ingest === 'function') {
            timelineStore.ingest('routing_proposal', updatedEvent.data, {
              campaignId: resolved.campaignId,
              dispatchId: resolved.dispatchId,
              traceId: resolved.traceId,
            });
          }
        } catch (err) {
          log.error('Failed to update proposal state in timeline', { proposalId, error: err.message });
          const responseBody = { error: 'Failed to update proposal state', actionId, proposalId };
          recordIdempotentResult(actionId, 'routing_proposal_reject', 500, responseBody, { payload, proposalId });
          json(res, responseBody, 500);
          return;
        }

        emitOperatorActionTimelineEvent('routing_proposal_rejected', {
          idempotencyKey: actionId,
          operatorId,
          status: 'completed',
          correlationId,
          campaignId: resolved.campaignId,
          dispatchId: resolved.dispatchId,
          traceId: resolved.traceId,
          agentId: resolved.agentId,
          provider: resolved.provider,
          targetParams: { proposalId, reason },
          data: {
            action: 'routing_proposal_rejected',
            proposalId,
            reason,
            state: 'rejected',
          },
        });

        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'routing_proposal_operator_rejected',
            target: `routing_proposal:${proposalId}`,
            beforeState: { state: currentState, proposal: proposalEvent.data },
            afterState: { state: 'rejected', proposalId, rejectedBy: operatorId, rejectionReason: reason },
            operatorId,
            action: 'routing_proposal_rejected',
            resourceType: 'routing_proposal',
            resourceId: proposalId,
            correlationId,
            actionId,
            idempotencyKey: actionId,
            status: 'success',
            decision: 'allow',
            payload: {
              proposalId,
              reason,
              currentState,
            },
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append(payload.projectId || 'default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        const responseBody = {
          ok: true,
          actionId,
          actionType: 'routing_proposal_rejected',
          proposalId,
          state: 'rejected',
          rejectedAt: now,
          rejectedBy: operatorId,
          reason,
          correlationId,
          timestamp: new Date().toISOString(),
        };

        recordIdempotentResult(actionId, 'routing_proposal_reject', 200, responseBody, {
          dispatchId: resolved.dispatchId,
          traceId: resolved.traceId,
          payload,
          proposalId,
        });
        json(res, responseBody, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- GET /api/error-constraints ---
    if (path === '/api/error-constraints' && req.method === 'GET') {
      if (!requireOperatorRole()) return true;
      if (!errorPatternConstraintStore) {
        json(res, { error: 'Error pattern constraint store not available' }, 503);
        return true;
      }

      try {
        const activeOnly = url.searchParams.get('activeOnly') !== 'false';
        const constraints = errorPatternConstraintStore.list({ activeOnly });
        json(res, { constraints, count: constraints.length, activeOnly });
      } catch (err) {
        log.error('Failed to list error pattern constraints', { error: err.message });
        json(res, { error: 'Failed to list constraints' }, 500);
      }
      return true;
    }

    // --- POST /api/error-constraints/:constraintId/dismiss ---
    const constraintDismissMatch = path.match(/^\/api\/error-constraints\/([^/]+)\/dismiss$/);
    if (constraintDismissMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      if (!errorPatternConstraintStore) {
        json(res, { error: 'Error pattern constraint store not available' }, 503);
        return true;
      }
      if (!timelineStore || !operatorAuditStore) {
        json(res, { error: 'Timeline or audit store not available' }, 503);
        return true;
      }

      handleBody(req, res, async (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const constraintId = decodeURIComponent(constraintDismissMatch[1]);
        if (!constraintId || constraintId.trim() === '') {
          json(res, { error: 'constraintId is required' }, 400);
          return;
        }

        const operatorId = requestUserId || 'system';
        const reason = payload.reason || 'operator dismissal';

        // Check if constraint exists
        let constraint;
        try {
          constraint = errorPatternConstraintStore.get(constraintId);
        } catch (err) {
          log.error('Failed to fetch constraint for dismissal', { constraintId, error: err.message });
          json(res, { error: 'Failed to fetch constraint' }, 500);
          return;
        }

        if (!constraint) {
          json(res, { error: 'Constraint not found' }, 404);
          return;
        }

        // Check if already dismissed
        if (constraint.dismissedAt) {
          json(res, { error: 'Constraint already dismissed', dismissedAt: constraint.dismissedAt, dismissedBy: constraint.dismissedBy }, 409);
          return;
        }

        // Remove (dismiss) the constraint
        let removed;
        try {
          removed = errorPatternConstraintStore.remove(constraintId, operatorId);
        } catch (err) {
          log.error('Failed to dismiss constraint', { constraintId, error: err.message });
          json(res, { error: 'Failed to dismiss constraint' }, 500);
          return;
        }

        if (!removed) {
          json(res, { error: 'Constraint not found or already dismissed' }, 404);
          return;
        }

        // Emit timeline event
        const correlationId = constraint.patternId;
        emitOperatorActionTimelineEvent('error_pattern_constraint_dismissed', {
          operatorId,
          status: 'completed',
          correlationId,
          data: {
            action: 'error_pattern_constraint_dismissed',
            constraintId,
            agentId: constraint.agentId,
            errorCategory: constraint.errorCategory,
            patternId: constraint.patternId,
            reason,
            dismissedBy: operatorId,
            dismissedAt: new Date().toISOString(),
          },
        });

        // Record in operator audit store
        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'error_pattern_constraint_dismissed',
            target: `error_pattern_constraint:${constraintId}`,
            beforeState: { constraint },
            afterState: { constraintId, dismissed: true, dismissedBy: operatorId, reason },
            operatorId,
            action: 'error_pattern_constraint_dismissed',
            resourceType: 'error_pattern_constraint',
            resourceId: constraintId,
            correlationId,
            status: 'success',
            decision: 'allow',
            details: `Dismissed error pattern constraint for agent ${constraint.agentId}${constraint.errorCategory ? ` (${constraint.errorCategory})` : ''}. Reason: ${reason}`,
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append('default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        // Fetch updated constraint state after dismissal
        const updatedConstraint = errorPatternConstraintStore.get(constraintId);

        json(res, {
          ok: true,
          constraintId,
          action: 'dismissed',
          dismissedBy: operatorId,
          reason,
          timestamp: new Date().toISOString(),
          constraint: updatedConstraint,
        }, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- POST /api/error-constraints/:constraintId/extend ---
    const constraintExtendMatch = path.match(/^\/api\/error-constraints\/([^/]+)\/extend$/);
    if (constraintExtendMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      if (!errorPatternConstraintStore) {
        json(res, { error: 'Error pattern constraint store not available' }, 503);
        return true;
      }
      if (!timelineStore || !operatorAuditStore) {
        json(res, { error: 'Timeline or audit store not available' }, 503);
        return true;
      }

      handleBody(req, res, async (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const constraintId = decodeURIComponent(constraintExtendMatch[1]);
        if (!constraintId || constraintId.trim() === '') {
          json(res, { error: 'constraintId is required' }, 400);
          return;
        }

        const operatorId = requestUserId || 'system';

        // Parse TTL from payload
        let ttlMs = null;
        if (typeof payload.ttlMs === 'number') {
          ttlMs = payload.ttlMs;
        } else if (typeof payload.ttlSeconds === 'number') {
          ttlMs = payload.ttlSeconds * 1000;
        } else if (typeof payload.ttlMinutes === 'number') {
          ttlMs = payload.ttlMinutes * 60000;
        }

        if (ttlMs === null || !Number.isFinite(ttlMs) || ttlMs <= 0) {
          json(res, { error: 'Valid ttlMs, ttlSeconds, or ttlMinutes is required' }, 400);
          return;
        }

        // Check if constraint exists
        let constraint;
        try {
          constraint = errorPatternConstraintStore.get(constraintId);
        } catch (err) {
          log.error('Failed to fetch constraint for extension', { constraintId, error: err.message });
          json(res, { error: 'Failed to fetch constraint' }, 500);
          return;
        }

        if (!constraint) {
          json(res, { error: 'Constraint not found' }, 404);
          return;
        }

        // Check if already dismissed
        if (constraint.dismissedAt) {
          json(res, { error: 'Cannot extend dismissed constraint', dismissedAt: constraint.dismissedAt }, 409);
          return;
        }

        // Calculate new expiration time
        const newExpiresAt = new Date(Date.now() + ttlMs).toISOString();
        const oldExpiresAt = constraint.expiresAt;

        // Update TTL
        let updated;
        try {
          updated = errorPatternConstraintStore.updateTTL(constraintId, newExpiresAt);
        } catch (err) {
          log.error('Failed to extend constraint TTL', { constraintId, error: err.message });
          json(res, { error: 'Failed to extend constraint' }, 500);
          return;
        }

        if (!updated) {
          json(res, { error: 'Constraint not found for extension' }, 404);
          return;
        }

        // Emit timeline event
        const correlationId = constraint.patternId;
        emitOperatorActionTimelineEvent('error_pattern_constraint_extended', {
          operatorId,
          status: 'completed',
          correlationId,
          data: {
            action: 'error_pattern_constraint_extended',
            constraintId,
            agentId: constraint.agentId,
            errorCategory: constraint.errorCategory,
            patternId: constraint.patternId,
            ttlMs,
            oldExpiresAt,
            newExpiresAt,
            extendedBy: operatorId,
          },
        });

        // Record in operator audit store
        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'error_pattern_constraint_extended',
            target: `error_pattern_constraint:${constraintId}`,
            beforeState: { constraint, expiresAt: oldExpiresAt },
            afterState: { constraintId, expiresAt: newExpiresAt, ttlMs },
            operatorId,
            action: 'error_pattern_constraint_extended',
            resourceType: 'error_pattern_constraint',
            resourceId: constraintId,
            correlationId,
            status: 'success',
            decision: 'allow',
            details: `Extended error pattern constraint TTL by ${ttlMs}ms for agent ${constraint.agentId}${constraint.errorCategory ? ` (${constraint.errorCategory})` : ''}. New expiry: ${newExpiresAt}`,
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append('default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        json(res, {
          ok: true,
          constraintId,
          action: 'extended',
          ttlMs,
          oldExpiresAt,
          newExpiresAt,
          extendedBy: operatorId,
          timestamp: new Date().toISOString(),
        }, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- POST /api/error-constraints/:constraintId/escalate ---
    const constraintEscalateMatch = path.match(/^\/api\/error-constraints\/([^/]+)\/escalate$/);
    if (constraintEscalateMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      if (!errorPatternConstraintStore) {
        json(res, { error: 'Error pattern constraint store not available' }, 503);
        return true;
      }
      if (!timelineStore || !operatorAuditStore) {
        json(res, { error: 'Timeline or audit store not available' }, 503);
        return true;
      }

      handleBody(req, res, async (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const constraintId = decodeURIComponent(constraintEscalateMatch[1]);
        if (!constraintId || constraintId.trim() === '') {
          json(res, { error: 'constraintId is required' }, 400);
          return;
        }

        const operatorId = requestUserId || 'system';
        const reason = payload.reason || 'operator escalation';

        // Check if constraint exists
        let constraint;
        try {
          constraint = errorPatternConstraintStore.get(constraintId);
        } catch (err) {
          log.error('Failed to fetch constraint for escalation', { constraintId, error: err.message });
          json(res, { error: 'Failed to fetch constraint' }, 500);
          return;
        }

        if (!constraint) {
          json(res, { error: 'Constraint not found' }, 404);
          return;
        }

        // Check if already dismissed
        if (constraint.dismissedAt) {
          json(res, { error: 'Cannot escalate dismissed constraint', dismissedAt: constraint.dismissedAt }, 409);
          return;
        }

        // Check if already escalated
        if (constraint.escalated) {
          json(res, { error: 'Constraint already escalated' }, 409);
          return;
        }

        // Escalate the constraint
        let escalated;
        try {
          escalated = errorPatternConstraintStore.escalate(constraintId);
        } catch (err) {
          log.error('Failed to escalate constraint', { constraintId, error: err.message });
          json(res, { error: 'Failed to escalate constraint' }, 500);
          return;
        }

        if (!escalated) {
          json(res, { error: 'Constraint not found for escalation' }, 404);
          return;
        }

        // Emit timeline event
        const correlationId = constraint.patternId;
        emitOperatorActionTimelineEvent('error_pattern_constraint_escalated', {
          operatorId,
          status: 'completed',
          correlationId,
          data: {
            action: 'error_pattern_constraint_escalated',
            constraintId,
            agentId: constraint.agentId,
            errorCategory: constraint.errorCategory,
            patternId: constraint.patternId,
            reason,
            escalatedBy: operatorId,
            escalatedAt: new Date().toISOString(),
          },
        });

        // Record in operator audit store
        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'error_pattern_constraint_escalated',
            target: `error_pattern_constraint:${constraintId}`,
            beforeState: { constraint, escalated: false },
            afterState: { constraintId, escalated: true, escalatedBy: operatorId, reason },
            operatorId,
            action: 'error_pattern_constraint_escalated',
            resourceType: 'error_pattern_constraint',
            resourceId: constraintId,
            correlationId,
            status: 'success',
            decision: 'allow',
            details: `Escalated error pattern constraint to hard exclude for agent ${constraint.agentId}${constraint.errorCategory ? ` (${constraint.errorCategory})` : ''}. Reason: ${reason}`,
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append('default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        json(res, {
          ok: true,
          constraintId,
          action: 'escalated',
          escalatedBy: operatorId,
          reason,
          timestamp: new Date().toISOString(),
        }, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Guard Actions: Replay by correlationId ---
    if (path === '/api/guard-actions/replay' && req.method === 'POST') {
      if (!requireOperatorRole('dispatch_replay')) return true;
      if (!dispatchLog || typeof dispatchLog.getById !== 'function' || typeof dispatchLog.append !== 'function') {
        json(res, { error: 'Dispatch log not available' }, 500);
        return true;
      }
      if (!operatorActionStore) {
        json(res, { error: 'Operator action store not available' }, 500);
        return true;
      }

      handleBody(req, res, async (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }
        if (payload && (typeof payload !== 'object' || Array.isArray(payload))) {
          json(res, { error: 'Request body must be a JSON object' }, 400);
          return;
        }

        const actionId = getIdempotencyKey(req, payload);
        if (!actionId) {
          json(res, { error: 'idempotency key is required' }, 400);
          return;
        }

        const existing = getIdempotentResult(actionId);
        if (respondIdempotent(existing)) return;

        const correlationId = typeof payload.correlationId === 'string' ? payload.correlationId.trim() : '';
        if (!correlationId) {
          const responseBody = { error: 'correlationId is required', actionId };
          recordIdempotentResult(actionId, 'replay', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const resolved = resolveCorrelationKeysFromId(correlationId);
        const sourceDispatchId = resolved.dispatchId;
        if (!sourceDispatchId) {
          const responseBody = { error: 'No dispatch found for correlationId', actionId, correlationId };
          recordIdempotentResult(actionId, 'replay', 404, responseBody, { payload });
          json(res, responseBody, 404);
          return;
        }

        const sourceRecord = dispatchLog.getById(sourceDispatchId);
        if (!sourceRecord) {
          const responseBody = { error: 'Dispatch not found', actionId, correlationId };
          recordIdempotentResult(actionId, 'replay', 404, responseBody, { payload });
          json(res, responseBody, 404);
          return;
        }

        const targetAgent = typeof payload.targetAgent === 'string' && payload.targetAgent.trim()
          ? payload.targetAgent.trim()
          : null;
        const targetProvider = typeof payload.targetProvider === 'string' && payload.targetProvider.trim()
          ? payload.targetProvider.trim()
          : null;

        if (targetAgent && !agents[targetAgent]) {
          const responseBody = { error: `Agent "${targetAgent}" not found`, actionId, correlationId };
          recordIdempotentResult(actionId, 'replay', 400, responseBody, { dispatchId: sourceDispatchId, payload });
          json(res, responseBody, 400);
          return;
        }

        if (targetProvider && !PROVIDERS[targetProvider]) {
          const responseBody = { error: `Provider "${targetProvider}" not found`, actionId, correlationId };
          recordIdempotentResult(actionId, 'replay', 400, responseBody, { dispatchId: sourceDispatchId, payload });
          json(res, responseBody, 400);
          return;
        }

        const reconstruction = {
          ...sourceRecord,
          id: null,
          timestamp: new Date().toISOString(),
          selectionReason: (targetAgent || targetProvider) ? 'operator_replay' : 'replay',
          inputs: sourceRecord.inputs || 'Replayed dispatch',
        };

        if (targetAgent) {
          reconstruction.selectedAgent = targetAgent;
        }
        if (targetProvider) {
          const matchingAgent = Object.entries(agents).find(
            ([_, agent]) => agent.provider === targetProvider
          );
          if (matchingAgent) {
            reconstruction.selectedAgent = matchingAgent[0];
          }
        }

        const persisted = await dispatchLog.append(reconstruction);
        const newDispatchId = persisted?.id || reconstruction.id;
        if (!newDispatchId) {
          const responseBody = { error: 'Failed to create replay dispatch', actionId, correlationId };
          recordIdempotentResult(actionId, 'replay', 500, responseBody, { dispatchId: sourceDispatchId, payload });
          json(res, responseBody, 500);
          return;
        }

        const operatorId = requestUserId || 'system';
        emitOperatorActionTimelineEvent('replay', {
          idempotencyKey: actionId,
          operatorId,
          status: 'completed',
          correlationId,
          sourceDispatchId,
          targetDispatchId: newDispatchId,
          campaignId: sourceRecord.campaignId || resolved.campaignId,
          dispatchId: newDispatchId,
          traceId: sourceRecord.traceId || resolved.traceId,
          agentId: reconstruction.selectedAgent || resolved.agentId,
          provider: resolved.provider,
          targetParams: { targetAgent, targetProvider },
          data: {
            action: 'replay',
            correlationId,
            originalDispatchId: sourceDispatchId,
            replayDispatchId: newDispatchId,
          },
        });

        // Broadcast steering action to WebSocket subscribers
        broadcast({
          type: 'steering:action',
          subtype: STEERING_EVENT_TYPES.replay,
          actionType: 'replay',
          correlationId,
          payloadSummary: {
            sourceDispatchId,
            targetDispatchId: newDispatchId,
            targetAgent,
            targetProvider,
            operatorId,
          },
          serverTimestamp: new Date().toISOString(),
        });

        if (operatorAuditStore?.append) {
          const replayRecord = (dispatchLog && typeof dispatchLog.getById === 'function')
            ? dispatchLog.getById(newDispatchId)
            : null;
          const auditEntry = {
            actorId: operatorId,
            actionType: 'dispatch_replay',
            target: correlationId || sourceDispatchId,
            beforeState: { sourceDispatch: sourceRecord },
            afterState: { replayDispatch: replayRecord || persisted || null },
            operatorId,
            action: 'dispatch_replay',
            resourceType: 'dispatch',
            resourceId: sourceDispatchId,
            correlationId,
            actionId,
            idempotencyKey: actionId,
            status: 'success',
            decision: 'allow',
            payload: {
              sourceDispatchId,
              replayDispatchId: newDispatchId,
              targetAgent,
              targetProvider,
            },
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append(payload.projectId || 'default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        const responseBody = {
          ok: true,
          actionId,
          actionType: 'replay',
          correlationId,
          sourceDispatchId,
          replayDispatchId: newDispatchId,
          operatorId,
          status: 'completed',
          replayTimestamp: new Date().toISOString(),
        };

        recordIdempotentResult(actionId, 'replay', 200, responseBody, { dispatchId: sourceDispatchId, traceId: resolved.traceId, payload });
        json(res, responseBody, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Guard Actions: Routing weight override with TTL ---
    if (path === '/api/guard-actions/weight-override' && req.method === 'POST') {
      if (!requireOperatorRole('weight_override')) return true;
      if (!weightOverrides) {
        json(res, { error: 'Weight overrides not available' }, 500);
        return true;
      }
      if (!operatorActionStore) {
        json(res, { error: 'Operator action store not available' }, 500);
        return true;
      }

      handleBody(req, res, async (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const actionId = getIdempotencyKey(req, payload);
        if (!actionId) {
          json(res, { error: 'idempotency key is required' }, 400);
          return;
        }

        const existing = getIdempotentResult(actionId);
        if (respondIdempotent(existing)) return;

        const correlationId = typeof payload.correlationId === 'string' ? payload.correlationId.trim() : '';
        if (!correlationId) {
          const responseBody = { error: 'correlationId is required', actionId };
          recordIdempotentResult(actionId, 'weight_override', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        if (!payload.weights || typeof payload.weights !== 'object' || Array.isArray(payload.weights)) {
          const responseBody = { error: 'weights must be a non-empty object', actionId, correlationId };
          recordIdempotentResult(actionId, 'weight_override', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const ttlMs = typeof payload.ttlMs === 'number'
          ? payload.ttlMs
          : (typeof payload.ttlSeconds === 'number'
            ? payload.ttlSeconds * 1000
            : (typeof payload.ttlMinutes === 'number' ? payload.ttlMinutes * 60_000 : null));
        if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
          const responseBody = { error: 'ttlMs must be a positive number', actionId, correlationId };
          recordIdempotentResult(actionId, 'weight_override', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }
        const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : (ttlMs ? new Date(Date.now() + ttlMs) : null);

        if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
          const responseBody = { error: 'ttlMs, ttlSeconds, ttlMinutes, or expiresAt is required', actionId, correlationId };
          recordIdempotentResult(actionId, 'weight_override', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const operatorId = requestUserId || 'system';
        const metadata = {
          reason: payload.reason || 'manual',
          appliedBy: operatorId,
          correlationId,
          ttlMs: ttlMs || Math.max(0, expiresAt.getTime() - Date.now()),
          expiresAt: expiresAt.toISOString(),
        };

        let beforeOverride = null;
        if (weightOverrides && typeof weightOverrides.getActive === 'function') {
          try {
            beforeOverride = await weightOverrides.getActive();
          } catch (err) {
            log.debug('Failed to read current weight override before apply', { error: err.message });
          }
        }

        let override;
        try {
          override = await weightOverrides.apply(payload.weights, metadata);
        } catch (err) {
          const responseBody = { error: 'Failed to apply weight override', actionId, correlationId };
          log.error('Failed to apply weight override', { correlationId, error: err.message });
          recordIdempotentResult(actionId, 'weight_override', 500, responseBody, { payload });
          json(res, responseBody, 500);
          return;
        }

        const resolved = resolveCorrelationKeysFromId(correlationId);
        emitOperatorActionTimelineEvent('weight_override', {
          idempotencyKey: actionId,
          operatorId,
          status: 'completed',
          correlationId,
          campaignId: resolved.campaignId,
          dispatchId: resolved.dispatchId,
          traceId: resolved.traceId,
          agentId: resolved.agentId,
          provider: resolved.provider,
          targetParams: {
            weights: payload.weights,
            expiresAt: override.expiresAt || metadata.expiresAt,
            ttlMs: metadata.ttlMs,
          },
          data: {
            action: 'weight_override',
            weights: payload.weights,
            expiresAt: override.expiresAt || metadata.expiresAt,
            ttlMs: metadata.ttlMs,
          },
        });

        // Broadcast steering action to WebSocket subscribers
        broadcast({
          type: 'steering:action',
          subtype: STEERING_EVENT_TYPES.weight_override,
          actionType: 'weight_override',
          correlationId,
          payloadSummary: {
            weights: payload.weights,
            expiresAt: override.expiresAt || metadata.expiresAt,
            ttlMs: metadata.ttlMs,
            operatorId,
          },
          serverTimestamp: new Date().toISOString(),
        });

        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'weight_override',
            target: 'routing_weights',
            beforeState: beforeOverride,
            afterState: override,
            operatorId,
            action: 'weight_override',
            resourceType: 'routing',
            resourceId: 'weights',
            correlationId,
            actionId,
            idempotencyKey: actionId,
            status: 'success',
            decision: 'allow',
            payload: {
              weights: payload.weights,
              expiresAt: override.expiresAt || metadata.expiresAt,
              ttlMs: metadata.ttlMs,
              reason: metadata.reason,
            },
          };
          if (operatorAuditStore.append.length >= 2) {
            // '_global', not 'default': routing weights are GLOBAL (this
            // entry's own resourceId says so), and the sibling
            // apply_routing_recommendation flow already buckets under
            // '_global' — which is also where the attribution endpoint
            // reads by default. The old 'default' fallback stranded manual
            // overrides where attribution never looked (#107).
            operatorAuditStore.append(payload.projectId || '_global', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        const responseBody = {
          ok: true,
          actionId,
          actionType: 'weight_override',
          correlationId,
          operatorId,
          override,
          expiresAt: override.expiresAt || metadata.expiresAt,
          ttlMs: metadata.ttlMs,
          timestamp: new Date().toISOString(),
        };

        recordIdempotentResult(actionId, 'weight_override', 200, responseBody, { dispatchId: resolved.dispatchId, traceId: resolved.traceId, payload });
        json(res, responseBody, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Guard Actions: Circuit breaker hold/reset ---
    if (path === '/api/guard-actions/circuit-breaker/hold' && req.method === 'POST') {
      if (!requireOperatorRole('circuit_breaker_hold')) return true;
      if (!circuitBreaker) {
        json(res, { error: 'Circuit breaker not available' }, 500);
        return true;
      }
      if (!operatorActionStore) {
        json(res, { error: 'Operator action store not available' }, 500);
        return true;
      }

      handleBody(req, res, (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const actionId = getIdempotencyKey(req, payload);
        if (!actionId) {
          json(res, { error: 'idempotency key is required' }, 400);
          return;
        }

        const existing = getIdempotentResult(actionId);
        if (respondIdempotent(existing)) return;

        const correlationId = typeof payload.correlationId === 'string' ? payload.correlationId.trim() : '';
        if (!correlationId) {
          const responseBody = { error: 'correlationId is required', actionId };
          recordIdempotentResult(actionId, 'circuit_breaker_hold', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const provider = typeof payload.provider === 'string' && payload.provider.trim()
          ? payload.provider.trim()
          : (typeof payload.providerId === 'string' && payload.providerId.trim() ? payload.providerId.trim() : '');
        if (!provider) {
          const responseBody = { error: 'provider is required', actionId, correlationId };
          recordIdempotentResult(actionId, 'circuit_breaker_hold', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        if (PROVIDERS && !PROVIDERS[provider]) {
          const responseBody = { error: `Provider "${provider}" not found`, actionId, correlationId };
          recordIdempotentResult(actionId, 'circuit_breaker_hold', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const resolved = resolveCorrelationKeysFromId(correlationId);
        const correlationKeys = { ...resolved, provider };
        const beforeState = circuitBreaker.getStatus(provider) || null;
        if (typeof circuitBreaker.hold === 'function') {
          circuitBreaker.hold(provider, { correlationKeys });
        } else if (typeof circuitBreaker.holdProvider === 'function') {
          circuitBreaker.holdProvider(provider, { correlationKeys });
        }

        const operatorId = requestUserId || 'system';
        const status = circuitBreaker.getStatus(provider) || null;

        emitOperatorActionTimelineEvent('circuit_breaker_hold', {
          idempotencyKey: actionId,
          operatorId,
          status: 'completed',
          correlationId,
          campaignId: resolved.campaignId,
          dispatchId: resolved.dispatchId,
          traceId: resolved.traceId,
          agentId: resolved.agentId,
          provider,
          data: {
            action: 'circuit_breaker_hold',
            provider,
            state: status,
          },
        });

        // Broadcast steering action to WebSocket subscribers
        broadcast({
          type: 'steering:action',
          subtype: STEERING_EVENT_TYPES.circuit_breaker_hold,
          actionType: 'circuit_breaker_hold',
          correlationId,
          payloadSummary: {
            provider,
            state: status,
            operatorId,
          },
          serverTimestamp: new Date().toISOString(),
        });

        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'circuit_breaker_hold',
            target: provider,
            beforeState,
            afterState: status,
            operatorId,
            action: 'circuit_breaker_hold',
            resourceType: 'circuit_breaker',
            resourceId: provider,
            correlationId,
            status: 'success',
            decision: 'allow',
            payload: {
              provider,
            },
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append(payload.projectId || 'default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        const responseBody = {
          ok: true,
          actionId,
          actionType: 'circuit_breaker_hold',
          correlationId,
          operatorId,
          provider,
          state: status,
          timestamp: new Date().toISOString(),
        };

        recordIdempotentResult(actionId, 'circuit_breaker_hold', 200, responseBody, { dispatchId: resolved.dispatchId, traceId: resolved.traceId, payload });
        json(res, responseBody, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    if (path === '/api/guard-actions/circuit-breaker/reset' && req.method === 'POST') {
      if (!requireOperatorRole('circuit_breaker_reset')) return true;
      if (!circuitBreaker) {
        json(res, { error: 'Circuit breaker not available' }, 500);
        return true;
      }
      if (!operatorActionStore) {
        json(res, { error: 'Operator action store not available' }, 500);
        return true;
      }

      handleBody(req, res, (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const actionId = getIdempotencyKey(req, payload);
        if (!actionId) {
          json(res, { error: 'idempotency key is required' }, 400);
          return;
        }

        const existing = getIdempotentResult(actionId);
        if (respondIdempotent(existing)) return;

        const correlationId = typeof payload.correlationId === 'string' ? payload.correlationId.trim() : '';
        if (!correlationId) {
          const responseBody = { error: 'correlationId is required', actionId };
          recordIdempotentResult(actionId, 'cb_reset', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const provider = typeof payload.provider === 'string' && payload.provider.trim()
          ? payload.provider.trim()
          : (typeof payload.providerId === 'string' && payload.providerId.trim() ? payload.providerId.trim() : '');
        if (!provider) {
          const responseBody = { error: 'provider is required', actionId, correlationId };
          recordIdempotentResult(actionId, 'cb_reset', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        if (PROVIDERS && !PROVIDERS[provider]) {
          const responseBody = { error: `Provider "${provider}" not found`, actionId, correlationId };
          recordIdempotentResult(actionId, 'cb_reset', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const beforeState = circuitBreaker.getStatus(provider) || null;
        circuitBreaker.reset(provider);
        const status = circuitBreaker.getStatus(provider) || null;
        const resolved = resolveCorrelationKeysFromId(correlationId);
        const operatorId = requestUserId || 'system';

        emitOperatorActionTimelineEvent('cb_reset', {
          idempotencyKey: actionId,
          operatorId,
          status: 'completed',
          correlationId,
          campaignId: resolved.campaignId,
          dispatchId: resolved.dispatchId,
          traceId: resolved.traceId,
          agentId: resolved.agentId,
          provider,
          data: {
            action: 'cb_reset',
            provider,
            state: status,
          },
        });

        // Broadcast steering action to WebSocket subscribers
        broadcast({
          type: 'steering:action',
          subtype: STEERING_EVENT_TYPES.cb_reset,
          actionType: 'cb_reset',
          correlationId,
          payloadSummary: {
            provider,
            state: status,
            operatorId,
          },
          serverTimestamp: new Date().toISOString(),
        });

        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'cb_reset',
            target: provider,
            beforeState,
            afterState: status,
            operatorId,
            action: 'cb_reset',
            resourceType: 'circuit_breaker',
            resourceId: provider,
            correlationId,
            status: 'success',
            decision: 'allow',
            payload: {
              provider,
            },
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append(payload.projectId || 'default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        const responseBody = {
          ok: true,
          actionId,
          actionType: 'cb_reset',
          correlationId,
          operatorId,
          provider,
          state: status,
          timestamp: new Date().toISOString(),
        };

        recordIdempotentResult(actionId, 'cb_reset', 200, responseBody, { dispatchId: resolved.dispatchId, traceId: resolved.traceId, payload });
        json(res, responseBody, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Guard Actions: Alert acknowledge ---
    if (path === '/api/guard-actions/alert-ack' && req.method === 'POST') {
      if (!requireOperatorRole('alert_ack')) return true;
      if (!alertMonitor && !anomalyDetector) {
        json(res, { error: 'Alert stores not available' }, 500);
        return true;
      }
      if (!operatorActionStore) {
        json(res, { error: 'Operator action store not available' }, 500);
        return true;
      }

      handleBody(req, res, (body) => {
        let payload = {};
        try {
          payload = body && body.trim() ? JSON.parse(body) : {};
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        const actionId = getIdempotencyKey(req, payload);
        if (!actionId) {
          json(res, { error: 'idempotency key is required' }, 400);
          return;
        }

        const existing = getIdempotentResult(actionId);
        if (respondIdempotent(existing)) return;

        const correlationId = typeof payload.correlationId === 'string' ? payload.correlationId.trim() : '';
        if (!correlationId) {
          const responseBody = { error: 'correlationId is required', actionId };
          recordIdempotentResult(actionId, 'alert_ack', 400, responseBody, { payload });
          json(res, responseBody, 400);
          return;
        }

        const operatorId = requestUserId || 'system';
        const ackParams = {
          alertKey: payload.alertKey || payload.alertId || payload.alert_id || null,
          condition: payload.condition || payload.alertCondition || null,
          agentId: payload.agentId || null,
          taskCategory: payload.taskCategory || payload.category || null,
          operatorId,
          correlationId,
        };

        const beforeAlert = findActiveAlertSnapshot({
          alertKey: ackParams.alertKey,
          condition: ackParams.condition,
          agentId: ackParams.agentId,
          taskCategory: ackParams.taskCategory,
        });

        let ackEntry = null;
        if (anomalyDetector && typeof anomalyDetector.acknowledgeAlert === 'function') {
          ackEntry = anomalyDetector.acknowledgeAlert(ackParams);
        }
        if (!ackEntry && alertMonitor && typeof alertMonitor.acknowledgeAlert === 'function') {
          ackEntry = alertMonitor.acknowledgeAlert(ackParams);
        }

        if (!ackEntry) {
          const responseBody = {
            ok: false,
            actionId,
            actionType: 'alert_ack',
            correlationId,
            status: 'failed',
            error: 'Alert not found',
            timestamp: new Date().toISOString(),
          };
          recordIdempotentResult(actionId, 'alert_ack', 404, responseBody, { payload });
          json(res, responseBody, 404);
          return;
        }

        const resolved = resolveCorrelationKeysFromId(correlationId);
        emitOperatorActionTimelineEvent('alert_ack', {
          idempotencyKey: actionId,
          operatorId,
          status: 'completed',
          correlationId,
          campaignId: resolved.campaignId,
          dispatchId: resolved.dispatchId,
          traceId: resolved.traceId,
          agentId: ackEntry.agentId || resolved.agentId,
          provider: resolved.provider,
          data: {
            action: 'alert_ack',
            alert: ackEntry,
          },
        });

        // Broadcast steering action to WebSocket subscribers
        broadcast({
          type: 'steering:action',
          subtype: STEERING_EVENT_TYPES.alert_ack,
          actionType: 'alert_ack',
          correlationId,
          payloadSummary: {
            alertKey: ackEntry.condition || ackEntry.agentId || 'alert',
            agentId: ackEntry.agentId,
            operatorId,
          },
          serverTimestamp: new Date().toISOString(),
        });

        if (operatorAuditStore?.append) {
          const auditEntry = {
            actorId: operatorId,
            actionType: 'alert_ack',
            target: ackEntry.condition || ackEntry.agentId || ackParams.alertKey || 'alert',
            beforeState: beforeAlert,
            afterState: ackEntry,
            operatorId,
            action: 'alert_ack',
            resourceType: 'alert',
            resourceId: ackEntry.condition || ackEntry.agentId || 'alert',
            correlationId,
            status: 'success',
            decision: 'allow',
            payload: {
              alert: ackEntry,
            },
          };
          if (operatorAuditStore.append.length >= 2) {
            operatorAuditStore.append(payload.projectId || 'default', auditEntry);
          } else {
            operatorAuditStore.append(auditEntry);
          }
        }

        const responseBody = {
          ok: true,
          actionId,
          actionType: 'alert_ack',
          correlationId,
          operatorId,
          acknowledgedAt: ackEntry.acknowledgedAt || new Date().toISOString(),
          alert: ackEntry,
          timestamp: new Date().toISOString(),
        };

        recordIdempotentResult(actionId, 'alert_ack', 200, responseBody, { dispatchId: resolved.dispatchId, traceId: resolved.traceId, payload });
        json(res, responseBody, 200);
      }).catch(() => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Timeline Operator Controls: Replay ---
    const replayMatch = path.match(/^\/api\/timeline\/replay\/([^/]+)$/);
    if (replayMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      if (!dispatchLog || typeof dispatchLog.getById !== 'function' || typeof dispatchLog.append !== 'function') {
        json(res, { error: 'Dispatch log not available' }, 500);
        return true;
      }
      // deps.dispatchReplayService has never been provided. The service was
      // built in 3b528ccb (2026-03-11), never wired into orchestrator.js, and
      // then deleted by 7c5b63b3 ("remove 28 dead code modules") — which could
      // not see this consumer, because it is reached through dependency
      // injection rather than an import. So this endpoint has answered every
      // request with a 500 and a TypeError about reading 'replayDispatch' of
      // undefined since the day it shipped.
      //
      // Answer honestly instead. 503 + a pointer beats a stack trace that
      // reads like a crash. Checked here, alongside the dispatchLog
      // precondition and BEFORE readBody, so a request that cannot succeed
      // writes no audit entry and reads no dispatch state.
      if (!deps.dispatchReplayService || typeof deps.dispatchReplayService.replayDispatch !== 'function') {
        json(res, {
          error: 'Dispatch replay is not configured',
          detail: 'No dispatch replay service is wired into this orchestrator. See task #47.',
        }, 503);
        return true;
      }
      const sourceDispatchId = decodeURIComponent(replayMatch[1]);
      if (!sourceDispatchId || sourceDispatchId.trim() === '') {
        json(res, { error: 'dispatch_id is required' }, 400);
        return true;
      }

      handleBody(req, res, async (body) => {
        try {
          let requestBody = {};
          if (body && typeof body === 'string' && body.trim()) {
            try {
              requestBody = JSON.parse(body);
            } catch (parseErr) {
              json(res, { error: 'Invalid JSON body' }, 400);
              return;
            }
          }
          const { source, reason: auditReason, correlationId: bodyCorrelationId, dispatchId: bodyDispatchId, traceId } = getAuditContext(req, requestBody);
          const targetAgent = (requestBody && typeof requestBody === 'object' ? requestBody.targetAgent : undefined) || null;
          const targetProvider = (requestBody && typeof requestBody === 'object' ? requestBody.targetProvider : undefined) || null;

          // Validate targetAgent if provided
          if (targetAgent && !agents[targetAgent]) {
            json(res, { error: `Agent "${targetAgent}" not found` }, 400);
            return;
          }

          // Validate targetProvider if provided
          if (targetProvider && !PROVIDERS[targetProvider]) {
            json(res, { error: `Provider "${targetProvider}" not found` }, 400);
            return;
          }

          // Use dispatch-replay-service for proper state reconstruction and replay
          const options = {
            operatorId: requestUserId || 'system',
            targetAgent: targetAgent || null,
            targetProvider: targetProvider || null,
            projectId: requestBody.projectId || 'default',
            channelId: requestBody.channelId || 'general',
            correlationId: bodyCorrelationId || sourceDispatchId, // Use sourceDispatchId as correlationId if not provided
            logOperatorAction: false, // dispatchReplayService logs to timeline, we log to auditStore separately
          };

          const beforeDispatchState = dispatchLog.getById(sourceDispatchId);

          const result = await deps.dispatchReplayService.replayDispatch(sourceDispatchId, options);
          let afterDispatchState = null;
          if (result.success && result.replayDispatchId) {
            afterDispatchState = dispatchLog.getById(result.replayDispatchId);
          }

          const status = result.success ? 'completed' : 'failed';
          if (operatorAuditStore) {
            operatorAuditStore.append({
              action: 'dispatch_replay',
              operatorId: requestUserId || 'system',
              resourceType: 'dispatch',
              resourceId: sourceDispatchId,
              status: status,
              decision: result.success ? 'allow' : 'deny',
              payload: {
                sourceDispatchId,
                replayDispatchId: result.replayDispatchId,
                targetAgent: options.targetAgent,
                targetProvider: options.targetProvider,
                beforeState: beforeDispatchState,
                afterState: afterDispatchState,
                error: result.error || null,
              },
              source,
              reason: auditReason,
              correlationId: bodyCorrelationId,
              dispatchId: bodyDispatchId,
              traceId,
            });
          }

          if (!result.success) {
            const statusCode = result.error?.includes('not found') ? 404 : 500;
            json(res, { error: result.error }, statusCode);
            return;
          }

          // Query correlated events for the new dispatch
          let correlatedEvents = [];
          if (timelineStore && typeof timelineStore.query === 'function') {
            try {
              const timelineResult = timelineStore.query({
                dispatchId: result.replayDispatchId,
                campaignId: result.reconstructedState?.campaignId,
                limit: 100,
              });
              correlatedEvents = (timelineResult.events || []).map((event) => ({
                ...event,
                correlationKeys: extractCorrelationKeys(event),
                summary: event.summary ?? event.data?.summary ?? 'Timeline event',
              }));
            } catch (err) {
              log.warn('Failed to query correlated events for replay', { error: err.message });
            }
          }

          json(res, {
            ok: true,
            sourceDispatchId: result.originalDispatchId,
            newDispatchId: result.replayDispatchId,
            replayTimestamp: new Date().toISOString(),
            selectedAgent: result.reconstructedState?.selectedAgent,
            selectionReason: result.reconstructedState?.selectionReason,
            events: correlatedEvents,
            eventCount: correlatedEvents.length,
          });
        } catch (err) {
          log.error('Replay failed', { sourceDispatchId, error: err.message });
          respondApiError(res, err);
        }
      }).catch((err) => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Timeline Operator Controls: Steer ---
    const steerMatch = path.match(/^\/api\/timeline\/steer\/([^/]+)$/);
    if (steerMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      if (!dispatchLog || typeof dispatchLog.getById !== 'function' || typeof dispatchLog.append !== 'function') {
        json(res, { error: 'Dispatch log not available' }, 500);
        return true;
      }
      const sourceDispatchId = decodeURIComponent(steerMatch[1]);
      if (!sourceDispatchId || sourceDispatchId.trim() === '') {
        json(res, { error: 'dispatch_id is required' }, 400);
        return true;
      }

      handleBody(req, res, async (body) => {
        try {
          let requestBody = {};
          if (body && typeof body === 'string' && body.trim()) {
            try {
              requestBody = JSON.parse(body);
            } catch (parseErr) {
              json(res, { error: 'Invalid JSON body' }, 400);
              return;
            }
          }
          if (requestBody && (typeof requestBody !== 'object' || Array.isArray(requestBody))) {
            json(res, { error: 'Request body must be a JSON object' }, 400);
            return;
          }

          const rawTargetAgent = requestBody?.targetAgent;
          const rawTargetProvider = requestBody?.targetProvider;
          const hasTargetAgent = Object.prototype.hasOwnProperty.call(requestBody, 'targetAgent');
          const hasTargetProvider = Object.prototype.hasOwnProperty.call(requestBody, 'targetProvider');

          let targetAgent = null;
          if (hasTargetAgent && rawTargetAgent !== null && rawTargetAgent !== undefined) {
            if (typeof rawTargetAgent !== 'string') {
              json(res, { error: 'targetAgent must be a string' }, 400);
              return;
            }
            const trimmed = rawTargetAgent.trim();
            if (!trimmed) {
              json(res, { error: 'targetAgent must be a non-empty string' }, 400);
              return;
            }
            targetAgent = trimmed;
          }

          let targetProvider = null;
          if (hasTargetProvider && rawTargetProvider !== null && rawTargetProvider !== undefined) {
            if (typeof rawTargetProvider !== 'string') {
              json(res, { error: 'targetProvider must be a string' }, 400);
              return;
            }
            const trimmed = rawTargetProvider.trim();
            if (!trimmed) {
              json(res, { error: 'targetProvider must be a non-empty string' }, 400);
              return;
            }
            targetProvider = trimmed;
          }

          // Validate required fields
          if (!targetAgent && !targetProvider) {
            json(res, { error: 'Either targetAgent or targetProvider is required' }, 400);
            return;
          }

          // Validate targetAgent if provided
          if (targetAgent && !agents[targetAgent]) {
            json(res, { error: `Agent "${targetAgent}" not found` }, 400);
            return;
          }

          // Validate targetProvider if provided
          if (targetProvider && !PROVIDERS[targetProvider]) {
            json(res, { error: `Provider "${targetProvider}" not found` }, 400);
            return;
          }

          // Check if source dispatch exists
          const sourceRecord = dispatchLog.getById(sourceDispatchId);
          if (!sourceRecord) {
            json(res, { error: 'Dispatch not found' }, 404);
            return;
          }

          if (targetAgent && targetProvider) {
            const agentProvider = agents[targetAgent]?.provider;
            if (agentProvider && agentProvider !== targetProvider) {
              json(res, { error: `Agent "${targetAgent}" is not backed by provider "${targetProvider}"` }, 400);
              return;
            }
          }

          // Determine target agent
          let finalTargetAgent = targetAgent;
          if (!finalTargetAgent && targetProvider) {
            const matchingAgent = Object.entries(agents).find(
              ([_, agent]) => agent.provider === targetProvider
            );
            if (matchingAgent) {
              finalTargetAgent = matchingAgent[0];
            } else {
              json(res, { error: `No agent found for provider "${targetProvider}"` }, 400);
              return;
            }
          }

          // Create steered dispatch record
          const steeredDispatch = {
            ...sourceRecord,
            id: null,
            timestamp: new Date().toISOString(),
            selectedAgent: finalTargetAgent,
            selectionReason: 'operator_steer',
            inputs: sourceRecord.inputs || 'Steered dispatch',
            originalDispatchId: sourceDispatchId,
            steerOverrides: {
              targetAgent: targetAgent || null,
              targetProvider: targetProvider || null,
            },
          };

          // Persist steered dispatch
          const persisted = await dispatchLog.append(steeredDispatch);
          const newDispatchId = persisted?.id || steeredDispatch.id;

          if (!newDispatchId) {
            json(res, { error: 'Failed to create steered dispatch' }, 500);
            return;
          }

          // Emit operator_action event to timeline
          if (timelineStore && typeof timelineStore.ingest === 'function') {
            const operatorEvent = timelineStore.ingest('operator_action', {
              action: 'steer',
              sourceDispatchId,
              targetDispatchId: newDispatchId,
              operatorId: requestUserId || 'system',
              status: 'success',
              timestamp: new Date().toISOString(),
              overrides: {
                targetAgent: targetAgent || null,
                targetProvider: targetProvider || null,
              },
            }, {
              campaignId: sourceRecord.campaignId,
              dispatchId: newDispatchId,
              traceId: sourceRecord.traceId,
            });
            if (operatorEvent && operatorEvent.id) {
              steeredDispatch.timelineEventId = operatorEvent.id;
            }
          }

          // Query correlated events for the steered dispatch
          let correlatedEvents = [];
          if (timelineStore && typeof timelineStore.query === 'function') {
            try {
              const timelineResult = timelineStore.query({
                dispatchId: newDispatchId,
                campaignId: sourceRecord.campaignId,
                limit: 100,
              });
              correlatedEvents = (timelineResult.events || []).map((event) => ({
                ...event,
                correlationKeys: extractCorrelationKeys(event),
                summary: event.summary ?? event.data?.summary ?? 'Timeline event',
              }));
            } catch (err) {
              log.warn('Failed to query correlated events for steer', { error: err.message });
            }
          }

          json(res, {
            ok: true,
            sourceDispatchId,
            newDispatchId,
            steerTimestamp: new Date().toISOString(),
            selectedAgent: finalTargetAgent,
            selectionReason: 'operator_steer',
            events: correlatedEvents,
            eventCount: correlatedEvents.length,
          });
        } catch (err) {
          log.error('Steer failed', { sourceDispatchId, error: err.message });
          respondApiError(res, err);
        }
      }).catch((err) => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Prometheus metrics scrape endpoint ---
    if (path === '/metrics' && req.method === 'GET') {
      generateMetricsText({ performanceStore, circuitBreaker, campaignManager, sandbox, stateManager, timelineStore })
        .then((text) => {
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(text);
        })
        .catch((err) => {
          log.error('Failed to generate metrics', { error: err.message });
          res.writeHead(500);
          res.end('Internal Server Error');
        });
      return true;
    }

    // --- Agent performance stats ---
    if (path === '/metrics/agent-stats' && req.method === 'GET') {
      if (!performanceStore) {
        json(res, { error: 'Performance store not available' }, 500);
        return true;
      }
      const agentFilter = url.searchParams.get('agent');
      const categoryFilter = url.searchParams.get('category');
      let stats;
      if (agentFilter) {
        stats = performanceStore.getAgentStats(agentFilter, categoryFilter);
      } else if (categoryFilter) {
        stats = performanceStore.getStatsByCategory(categoryFilter);
      } else {
        stats = performanceStore.getAllAgentStats();
      }
      const mappedStats = (Array.isArray(stats) ? stats : [stats]).map(s => ({
        agent_id: s.agentId,
        task_category: s.taskCategory,
        success_rate: s.successRate,
        failure_rate: s.failureRate,
        total_attempts: s.totalDispatches,
        avg_duration_ms: s.avgDurationMs,
      }));
      json(res, {
        stats: mappedStats,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    // --- Correlation metrics ---
    if (path === '/api/metrics/correlation' && req.method === 'GET') {
      if (!timelineStore || !timelineStore.getCorrelationMetrics) {
        json(res, { error: 'Correlation metrics not available' }, 503);
        return true;
      }
      const correlationMetrics = timelineStore.getCorrelationMetrics();
      if (!correlationMetrics || typeof correlationMetrics.getSnapshot !== 'function') {
        json(res, { error: 'Correlation metrics instance unavailable' }, 503);
        return true;
      }
      const snapshot = correlationMetrics.getSnapshot();
      const total = snapshot.totalIngested || 0;
      const correlated = snapshot.success + snapshot.fallback;
      const correlationRate = total > 0 ? correlated / total : null;
      const missingIdRate = total > 0 ? (snapshot.failures || 0) / total : null;
      const fallbackRate = total > 0 ? snapshot.fallback / total : null;
      json(res, {
        totalIngested: snapshot.totalIngested,
        success: snapshot.success,
        fallback: snapshot.fallback,
        failures: snapshot.failures,
        outOfWindow: snapshot.outOfWindow,
        correlationRate: correlationRate,
        missingIdRate: missingIdRate,
        fallbackRate: fallbackRate,
        failuresByReason: snapshot.failuresByReason,
        startedAt: snapshot.startedAt,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    // --- Routing weights (computed from performance data) ---
    if (path === '/api/routing-weights' && req.method === 'GET') {
      if (!performanceStore) {
        json(res, { error: 'Performance store not available' }, 500);
        return true;
      }

      (async () => {
         // Load active weight override
         const activeOverride = weightOverrides ? await weightOverrides.getActive() : null;
         const overrideWeights = activeOverride?.weights && typeof activeOverride.weights === 'object'
           ? activeOverride.weights
           : {};
         
         // Load cost data
         let provider_costs = {};
         let category_cost_config = {};
         if (providerCostStore) {
           try {
             provider_costs = await providerCostStore.getCosts();
           } catch (err) {
             log.warn('Failed to load provider costs', { error: err.message });
           }
         }
         if (categoryCostConfigStore) {
           try {
             category_cost_config = await categoryCostConfigStore.getAll();
           } catch (err) {
             log.warn('Failed to load category cost config', { error: err.message });
           }
         }
         
         const seenProviders = new Set();
         const overriddenProviders = new Set();

        const categoryFilter = url.searchParams.get('category');
        const rawStats = categoryFilter
          ? performanceStore.getStatsByCategory(categoryFilter)
          : performanceStore.getAllAgentStats();

        // Group by task category
        const byCategory = {};
        for (const s of rawStats) {
          if (!byCategory[s.taskCategory]) byCategory[s.taskCategory] = [];
          byCategory[s.taskCategory].push(s);
        }

        const statsOut = [];
        for (const [category, categoryStats] of Object.entries(byCategory)) {
          // Build candidateStats with 5-sample threshold (mirrors weightedPerformanceSelect)
          const candidates = categoryStats.map(s => ({
            id: s.agentId,
            totalDispatches: s.totalDispatches,
            successRate: s.totalDispatches >= 5 ? s.successRate : null,
          }));

          // Get cost config for this category
          const categoryConfig = category_cost_config[category] || {};
          const costCoefficient = categoryConfig.costCoefficient ?? 0;

          // Build agent-to-cost mapping from provider costs
          const costMap = {};
          for (const candidate of candidates) {
            const agent = agents[candidate.id];
            const provider = agent?.provider;
            if (provider && provider_costs[provider] !== undefined) {
              costMap[candidate.id] = provider_costs[provider];
            }
          }

          const weights = computeRoutingWeights(candidates, { costCoefficient, costMap });

          // Merge weight results with raw stats and apply overrides
          // weight_reason values: 'insufficient_data_fallback' (<5 dispatches in category), 'confidence_adjusted' (5-19 dispatches), 'weighted_selection' (>=20 dispatches), 'single_candidate' (only one agent in category)
          for (const w of weights) {
            const raw = categoryStats.find(s => s.agentId === w.id);
            const agent = agents[w.id];
            const provider = agent?.provider;
            const hasOverride = !!(provider && Object.prototype.hasOwnProperty.call(overrideWeights, provider));
            const effectiveWeight = hasOverride ? overrideWeights[provider] : w.weight;
            if (provider) seenProviders.add(provider);
            if (hasOverride) overriddenProviders.add(provider);

            statsOut.push({
              agent_id: w.id,
              task_category: category,
              provider: provider || null,
              success_rate: w.successRate,
              total_dispatches: raw ? raw.totalDispatches : 0,
              computed_weight: w.weight,
              effective_weight: effectiveWeight,
              is_overridden: hasOverride,
              weight_source: hasOverride ? 'overridden' : 'computed',
              weight_reason: w.reason,
              provider_cost: w.provider_cost ?? null,
              cost_weight: w.cost_weight ?? null,
              cost_coefficient: costCoefficient > 0 ? costCoefficient : null,
            });
          }
        }

        const responseData = {
       stats: statsOut,
       timestamp: new Date().toISOString(),
       floor_weight: config.router.floorWeight,
       sensitivity_threshold: config.router.sensitivityThreshold,
       weight_sources: {
         overridden_providers: [...overriddenProviders],
         computed_providers: [...seenProviders].filter(provider => !overriddenProviders.has(provider)),
       },
       provider_costs,
       category_cost_config,
     };

        // Add override metadata if active
        if (activeOverride) {
          responseData.active_override = {
            weights: activeOverride.weights,
            applied_at: activeOverride.appliedAt,
            applied_by: activeOverride.appliedBy,
            reason: activeOverride.reason,
            recommendation_id: activeOverride.recommendationId,
          };
        }

        json(res, responseData);
      })().catch(err => {
        log.error('Failed to compute routing weights', { error: err.message });
        json(res, { error: 'Failed to compute routing weights' }, 500);
      });
       return true;
    }

    // --- Campaign Funnel Metrics: GET /api/metrics/campaign-funnel ---
    if (path === '/api/metrics/campaign-funnel' && req.method === 'GET') {
      if (!performanceStore) {
        json(res, { error: 'Performance store not available' }, 500);
        return true;
      }

      const windowParam = url.searchParams.get('window') || '30d';
      const validWindows = ['1h', '24h', '7d', '30d'];
      if (!validWindows.includes(windowParam)) {
        json(res, { error: `Invalid window. Must be one of: ${validWindows.join(', ')}` }, 400);
        return true;
      }

      (async () => {
        try {
          const baseDir = config.server.projectDir || process.cwd();
          const metrics = await computeCampaignFunnelMetrics(baseDir, { window: windowParam });
          json(res, metrics);
        } catch (err) {
          log.error('Failed to compute campaign funnel metrics', { error: err.message });
          respondApiError(res, err, { message: 'Failed to compute campaign funnel metrics' });
        }
      })().catch(err => {
        log.error('Campaign funnel metrics request failed', { error: err.message });
        json(res, { error: 'Request failed' }, 500);
      });
       return true;
    }

    // --- Provider Costs: GET ---
    if (path === '/api/provider-costs' && req.method === 'GET') {
      if (!requireOperatorRole()) return true;
      if (!providerCostStore) {
        json(res, { error: 'Provider cost store not available' }, 500);
        return true;
      }
      (async () => {
        try {
          const costs = await providerCostStore.getCosts();
          json(res, costs);
        } catch (err) {
          log.error('Failed to retrieve provider costs', { error: err.message });
          json(res, { error: 'Failed to retrieve provider costs' }, 500);
        }
      })();
      return true;
    }

    // --- Provider Costs: PUT ---
    if (path === '/api/provider-costs' && req.method === 'PUT') {
      if (!requireOperatorRole()) return true;
      if (!providerCostStore) {
        json(res, { error: 'Provider cost store not available' }, 500);
        return true;
      }
      handleBody(req, res, body => {
        try {
          const costs = body && body.trim() ? JSON.parse(body) : {};

          // Validate input
          if (!costs || typeof costs !== 'object') {
            json(res, { error: 'Invalid costs: must be an object' }, 400);
            return;
          }

          if (Object.keys(costs).length === 0) {
            json(res, { error: 'Invalid costs: must contain at least one provider' }, 400);
            return;
          }

          // Validate all values are positive numbers
          for (const [provider, cost] of Object.entries(costs)) {
            if (typeof provider !== 'string' || provider.trim() === '') {
              json(res, { error: `Invalid provider name: "${provider}"` }, 400);
              return;
            }
            if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || Number.isNaN(cost)) {
              json(res, { error: `Invalid cost for provider "${provider}": ${cost} (must be a positive number)` }, 400);
              return;
            }
          }

          (async () => {
            try {
              const updated = await providerCostStore.setCosts(costs);
              json(res, updated);
            } catch (err) {
              log.error('Failed to set provider costs', { error: err.message });
              respondApiError(res, err, { status: 400, message: 'Failed to set provider costs' });
            }
          })();
        } catch (e) {
          json(res, { error: 'Invalid JSON body' }, 400);
        }
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Category Cost Config: GET ---
    if (path === '/api/category-cost-config' && req.method === 'GET') {
      if (!requireOperatorRole()) return true;
      if (!categoryCostConfigStore) {
        json(res, { error: 'Category cost config store not available' }, 500);
        return true;
      }
      (async () => {
        try {
          const config = await categoryCostConfigStore.getAll();
          json(res, config);
        } catch (err) {
          log.error('Failed to retrieve category cost config', { error: err.message });
          json(res, { error: 'Failed to retrieve category cost config' }, 500);
        }
      })();
      return true;
    }

    // --- Category Cost Config: PUT ---
    if (path === '/api/category-cost-config' && req.method === 'PUT') {
      if (!requireOperatorRole()) return true;
      if (!categoryCostConfigStore) {
        json(res, { error: 'Category cost config store not available' }, 500);
        return true;
      }
      handleBody(req, res, body => {
        try {
          const configMap = body && body.trim() ? JSON.parse(body) : {};

          // Validate input
          if (!configMap || typeof configMap !== 'object') {
            json(res, { error: 'Invalid config: must be an object' }, 400);
            return;
          }

          if (Object.keys(configMap).length === 0) {
            json(res, { error: 'Invalid config: must contain at least one category' }, 400);
            return;
          }

          // Validate all entries
          const validated = {};
          for (const [category, config] of Object.entries(configMap)) {
            if (!category || typeof category !== 'string' || category.trim() === '') {
              json(res, { error: `Invalid category name` }, 400);
              return;
            }
            if (!config || typeof config !== 'object' || !('costCoefficient' in config)) {
              json(res, { error: `Invalid config for category "${category}": must include costCoefficient` }, 400);
              return;
            }

            const coefficient = config.costCoefficient;
            if (typeof coefficient !== 'number' || Number.isNaN(coefficient)) {
              json(res, { error: `Invalid costCoefficient for category "${category}": must be a number` }, 400);
              return;
            }

            if (!Number.isFinite(coefficient)) {
              json(res, { error: `Invalid costCoefficient for category "${category}": must be a finite number` }, 400);
              return;
            }

            // Clamp to valid range [0.0, 1.0]
            const clamped = Math.max(0.0, Math.min(1.0, coefficient));
            validated[category] = { costCoefficient: clamped };

            if (clamped !== coefficient) {
              log.info('Clamped costCoefficient during API update', { category, original: coefficient, clamped });
            }
          }

          (async () => {
            try {
              const updated = await categoryCostConfigStore.setAll(validated);
              json(res, updated);
            } catch (err) {
              log.error('Failed to set category cost config', { error: err.message });
              respondApiError(res, err, { status: 400, message: 'Failed to set category cost config' });
            }
          })();
        } catch (e) {
          json(res, { error: 'Invalid JSON body' }, 400);
        }
      }).catch(err => {
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- SSRF Policy: GET (operator+ readable) ---
    if (path === '/api/ssrf-policy' && req.method === 'GET') {
      if (!requireOperatorRole()) return true;
      try {
        const policy = ssrfConfigStore.getPolicy();
        json(res, policy);
      } catch (err) {
        log.error('Failed to retrieve SSRF policy', { error: err.message });
        json(res, { error: 'Failed to retrieve SSRF policy' }, 500);
      }
      return true;
    }

    // --- SSRF Policy: PATCH ---
    // Synapse is single-tenant local-first. The operator is the admin — same
    // pattern as pfSense / Home Assistant / Plex. Earlier code gated this
    // endpoint on a separate "admin" role tier that was never defined in
    // config.auth.roles (only OPERATOR + VIEWER exist), so the gate was
    // unreachable from any logged-in user. Aligned with the other 75
    // role-checked endpoints which all use requireOperatorRole().
    if (path === '/api/ssrf-policy' && req.method === 'PATCH') {
      if (!requireOperatorRole('ssrf_policy_update')) return true;

      handleBody(req, res, async body => {
        try {
          const updates = body && body.trim() ? JSON.parse(body) : {};

          // Validate update fields
          if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') {
            json(res, { error: 'Invalid enabled field: must be boolean' }, 400);
            return;
          }
          if (updates.blockPrivateRanges !== undefined && typeof updates.blockPrivateRanges !== 'boolean') {
            json(res, { error: 'Invalid blockPrivateRanges field: must be boolean' }, 400);
            return;
          }
          if (updates.allowlist !== undefined && !Array.isArray(updates.allowlist)) {
            json(res, { error: 'Invalid allowlist field: must be array' }, 400);
            return;
          }
          if (updates.denylist !== undefined && !Array.isArray(updates.denylist)) {
            json(res, { error: 'Invalid denylist field: must be array' }, 400);
            return;
          }

          // Persist updates. Must be awaited — update() returns a Promise and
          // an unawaited rejection (e.g. atomic write failure) crashes Node.
          await ssrfConfigStore.update(updates);
          const updatedPolicy = ssrfConfigStore.getPolicy();

          log.info('SSRF policy updated', {
            updatedBy: requestUserId,
            updates,
            enabled: updatedPolicy.enabled,
            allowlistCount: updatedPolicy.allowlist?.length || 0,
            denylistCount: updatedPolicy.denylist?.length || 0
          });

          json(res, updatedPolicy);
        } catch (err) {
          log.error('Failed to update SSRF policy', { error: err.message });
          respondApiError(res, err, { message: 'Failed to update SSRF policy' });
        }
      }).catch(err => {
        log.error('Failed to read PATCH body for SSRF policy', { error: err.message });
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // --- Routing analytics (provider deltas + recommendations) ---
    if (path === '/api/routing-analytics' && req.method === 'GET') {
      const since = url.searchParams.get('since') || undefined;
      const campaignId = url.searchParams.get('campaignId') || undefined;

      try {
        const deltaResult = computeProviderDeltas(dispatchLog, performanceStore, {
          since,
          campaignId,
          agents,
        }) || {};
        const { providers = [], deltas = [] } = deltaResult;
        const recommendations = generateRecommendations(deltaResult) || [];

        // Log recommendations to audit trail
        if (operatorAuditStore && recommendations.length > 0) {
          const auditProjectId = '_global';
          for (const rec of recommendations) {
            const auditEntry = {
              operatorId: 'system',
              action: 'routing_recommendation',
              campaignId: campaignId || null,
              resourceType: 'routing',
              resourceId: rec.id,
              status: 'generated',
              decision: 'allow',
              payload: {
                recommendationId: rec.id,
                recommendation: {
                  id: rec.id,
                  type: rec.type,
                  message: rec.message,
                  confidence: rec.confidence,
                  confidenceScore: rec.confidenceScore,
                  rationale: rec.rationale,
                  old_weights: rec.old_weights,
                  new_weights: rec.new_weights,
                  context: rec.context,
                },
              },
            };
            try {
              if (operatorAuditStore.append && operatorAuditStore.append.length >= 2) {
                operatorAuditStore.append(auditProjectId, auditEntry);
              } else if (operatorAuditStore.append) {
                operatorAuditStore.append(auditEntry);
              } else if (operatorAuditStore.record) {
                operatorAuditStore.record({ ...auditEntry, projectId: auditProjectId });
              }
            } catch (auditErr) {
              log.warn('Failed to log routing recommendation to audit trail', {
                recommendationId: rec.id,
                error: auditErr.message,
              });
            }
          }
        }

        json(res, {
          providers,
          deltas,
          recommendations,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to compute routing analytics', { error: err.message });
        json(res, { error: 'Failed to compute routing analytics' }, 500);
      }
      return true;
    }

    // --- Weight Impact Analytics (GET /api/analytics/weight-impact) ---
    if (path === '/api/analytics/weight-impact' && req.method === 'GET') {
      const eventId = url.searchParams.get('eventId') || undefined;
      const weightChangeTimestampParam = url.searchParams.get('weightChangeTimestamp') || undefined;

      if (!dispatchLog || typeof dispatchLog.query !== 'function') {
        json(res, { error: 'Dispatch log not available' }, 503);
        return true;
      }

      try {
        // Get weight change event timestamp from query param or eventId lookup
        let weightChangeTimestamp = weightChangeTimestampParam || null;
        if (!weightChangeTimestamp && eventId) {
          // Try to find the weight change event in operator audit store
          const auditEvents = operatorAuditStore?.query?.() || [];
          const weightEvent = auditEvents.find(e => 
            e.eventId === eventId || 
            e.payload?.recommendationId === eventId ||
            e.id === eventId ||
            // Also check for custom event IDs that might be passed
            (eventId.startsWith('evt_') && e.payload?.eventId === eventId)
          );
          if (weightEvent && weightEvent.timestamp) {
            weightChangeTimestamp = weightEvent.timestamp;
          }
        }

        // Query dispatches from dispatch log
        const allDispatches = dispatchLog.query({ limit: 10000 }).decisions || [];

        // Filter and separate into pre/post windows
        const preDispatches = [];
        const postDispatches = [];

        for (const dispatch of allDispatches) {
          const dispatchTime = new Date(dispatch.timestamp).getTime();
          const weightChangeTime = weightChangeTimestamp ? new Date(weightChangeTimestamp).getTime() : null;

          if (weightChangeTime === null) {
            // No weight change event, treat all as pre-window
            preDispatches.push(dispatch);
          } else if (dispatchTime < weightChangeTime) {
            preDispatches.push(dispatch);
          } else {
            postDispatches.push(dispatch);
          }
        }

        // Compute aggregates per category and agent for pre window
        const preAggregates = computeDispatchAggregates(preDispatches);

        // Compute aggregates per category and agent for post window
        const postAggregates = computeDispatchAggregates(postDispatches);

        // Compute deltas
        const deltas = computeDeltas(preAggregates, postAggregates);

        json(res, {
          eventId: eventId || null,
          weightChangeTimestamp: weightChangeTimestamp || null,
          pre: {
            totalDispatches: preDispatches.length,
            categories: preAggregates,
          },
          post: {
            totalDispatches: postDispatches.length,
            categories: postAggregates,
          },
          deltas,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to compute weight impact analytics', { error: err.message });
        json(res, { error: 'Failed to compute weight impact analytics' }, 500);
      }
      return true;
    }

    // --- Attribution Analytics (GET /api/analytics/attribution) ---
    if (path === '/api/analytics/attribution' && req.method === 'GET') {
      const category = url.searchParams.get('category');
      const projectId = url.searchParams.get('projectId') || '_global';

      if (!category) {
        json(res, { error: 'category query parameter required' }, 400);
        return true;
      }

      if (!dispatchLog || typeof dispatchLog.query !== 'function') {
        json(res, { error: 'Dispatch log not available' }, 503);
        return true;
      }

      if (!operatorAuditStore || typeof operatorAuditStore.query !== 'function') {
        json(res, { error: 'Operator audit store not available' }, 503);
        return true;
      }

      try {
        // Explicit-but-invalid windowMs is a 400, not a silent 24h default —
        // a garbage window answered with default-window data misleads.
        const windowMsRaw = url.searchParams.get('windowMs');
        const windowMs = windowMsRaw === null ? 86400000 : parseInt(windowMsRaw, 10);
        if (windowMsRaw !== null && (!Number.isInteger(windowMs) || windowMs <= 0 || String(windowMs) !== windowMsRaw.trim())) {
          json(res, { error: 'windowMs must be a positive integer (milliseconds)' }, 400);
          return true;
        }
        const minSampleSize = parseInt(url.searchParams.get('minSampleSize'), 10) || 10;

        // Find all weight override actions for the project from audit log
        const auditEntries = operatorAuditStore.query(projectId, { limit: 1000 }) || [];
        // BOTH operator paths that change weights are attributable: the manual
        // weight-override endpoint audits actionType 'weight_override', and
        // the recommendation-apply flow audits 'apply_routing_recommendation'.
        // The filter had drifted to ONLY the latter, silently excluding
        // manual overrides from the very feature named for them (#107 —
        // the failing suite was RIGHT; compute needs only entry.timestamp,
        // so both payload shapes are safe).
        const ATTRIBUTABLE = new Set(['weight_override', 'apply_routing_recommendation']);
        const weightOverrides = auditEntries.filter(e =>
          ATTRIBUTABLE.has(e.actionType) || ATTRIBUTABLE.has(e.action)
        );

        if (weightOverrides.length === 0) {
          json(res, {
            category,
            overrides: [],
            summary: {
              bestDelta: 0,
              provenImprovement: false,
              message: 'No weight overrides found for this project',
            },
            timestamp: new Date().toISOString(),
          });
          return true;
        }

        // Compute attribution metrics for each override
        const overrideMetrics = [];
        for (const override of weightOverrides) {
          const overrideTimestamp = override.timestamp;
          if (!overrideTimestamp) continue;

          const metrics = computeAttributionMetrics(
            dispatchLog,
            performanceStore,
            overrideTimestamp,
            category,
            windowMs,
            minSampleSize
          );

          if (metrics) {
            overrideMetrics.push({
              timestamp: overrideTimestamp,
              actionId: override.actionId || null, // idempotency correlation, carried by manual overrides
              reason: override.reason || 'manual',
              operatorId: override.operatorId || 'system',
              beforeState: override.beforeState || null,
              afterState: override.afterState || null,
              preMetrics: metrics.preMetrics,
              postMetrics: metrics.postMetrics,
              delta: metrics.delta,
              confidence: metrics.confidence,
              agents: metrics.agents,
            });
          }
        }

        // Sort by delta descending (best improvement first)
        overrideMetrics.sort((a, b) => b.delta - a.delta);

        // Compute summary
        const bestDelta = overrideMetrics.length > 0 ? overrideMetrics[0].delta : 0;
        const provenImprovement = bestDelta > 0.05; // 5 percentage point threshold

        json(res, {
          category,
          overrides: overrideMetrics,
          summary: {
            bestDelta,
            provenImprovement,
            totalOverrides: overrideMetrics.length,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to compute attribution analytics', { error: err.message });
        json(res, { error: 'Failed to compute attribution analytics' }, 500);
      }
      return true;
    }

    // --- Cost Analytics (GET /api/costs) ---
    if (path === '/api/costs' && req.method === 'GET') {
      const { timelineStore } = deps;
      
      if (!timelineStore || typeof timelineStore.getCostSummary !== 'function') {
        json(res, { error: 'TimelineStore not available' }, 503);
        return true;
      }

      const windowHours = parseInt(url.searchParams.get('window'), 10) || 24;
      const groupBy = url.searchParams.get('groupBy') || 'provider';
      const campaignIdFilter = url.searchParams.get('campaignId') || null;
      const agentIdFilter = url.searchParams.get('agentId') || null;

      const now = new Date();
      const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();
      const until = now.toISOString();

      try {
        const summary = timelineStore.getCostSummary({ since, until });

        let series = [];
        let totalsByProvider = {};

        if (groupBy === 'agent') {
          let filteredByAgent = summary.byAgent;
          if (agentIdFilter) {
            filteredByAgent = filteredByAgent.filter(a => a.agentId === agentIdFilter);
          }
          if (campaignIdFilter) {
            filteredByAgent = filteredByAgent.filter(a => 
              summary.byCampaign.some(c => c.campaignId === campaignIdFilter && c.totalCostUsd > 0)
            );
          }

          for (const agent of filteredByAgent) {
            series.push({
              label: agent.agentId,
              datapoints: [{ timestamp: since, costUsd: agent.totalCostUsd }]
            });
          }
        } else if (groupBy === 'campaign') {
          let filteredByCampaign = summary.byCampaign;
          if (campaignIdFilter) {
            filteredByCampaign = filteredByCampaign.filter(c => c.campaignId === campaignIdFilter);
          }
          if (agentIdFilter) {
            filteredByCampaign = filteredByCampaign.filter(c => 
              summary.byAgent.some(a => a.agentId === agentIdFilter && a.totalCostUsd > 0)
            );
          }

          for (const campaign of filteredByCampaign) {
            series.push({
              label: campaign.campaignId,
              datapoints: [{ timestamp: since, costUsd: campaign.totalCostUsd }]
            });
          }
        } else if (groupBy === 'provider') {
          let filteredByProvider = summary.byProvider;
          if (campaignIdFilter) {
            filteredByProvider = filteredByProvider.filter(p => 
              summary.byCampaign.some(c => c.campaignId === campaignIdFilter && c.totalCostUsd > 0)
            );
          }
          if (agentIdFilter) {
            filteredByProvider = filteredByProvider.filter(p => 
              summary.byAgent.some(a => a.agentId === agentIdFilter && a.totalCostUsd > 0)
            );
          }

          for (const provider of filteredByProvider) {
            series.push({
              label: provider.provider,
              datapoints: [{ timestamp: since, costUsd: provider.totalCostUsd }]
            });
            totalsByProvider[provider.provider] = provider.totalCostUsd;
          }
        }

        json(res, {
          window: windowHours,
          groupBy,
          series,
          totals: {
            totalCostUsd: summary.totalCostUsd,
            byProvider: totalsByProvider
          },
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        log.error('Failed to compute cost analytics', { error: err.message });
        json(res, { 
          window: windowHours, 
          groupBy, 
          series: [], 
          totals: { totalCostUsd: 0, byProvider: {} },
          error: 'Failed to compute cost analytics' 
        }, 500);
      }
      return true;
    }

    // --- Analytics dashboard API (unified signals + dispatch log metrics) ---
    if (path === '/api/analytics' && req.method === 'GET') {
      if (!analyticsSignalsStore) {
        json(res, { error: 'Analytics signals store not available' }, 503);
        return true;
      }

      try {
        const since = url.searchParams.get('since') || undefined;
        const campaignId = url.searchParams.get('campaignId') || undefined;

        // Get analytics signals (pre-computed metrics from pipeline)
        const signals = analyticsSignalsStore.getAllLatestSignals();
        const freshness = analyticsSignalsStore.getFreshnessStatus();

        // Get dispatch log metrics (real-time aggregates)
        let dispatchMetrics = { providers: [] };
        const canComputeDeltas = dispatchLog && typeof dispatchLog.query === 'function'
          && performanceStore && typeof performanceStore.getAllAgentStats === 'function';

        if (canComputeDeltas) {
          try {
            const deltaResult = computeProviderDeltas(dispatchLog, performanceStore, {
              since,
              campaignId,
              agents,
            }) || {};
            dispatchMetrics = deltaResult;
          } catch (err) {
            log.warn('Failed to compute provider deltas for analytics dashboard', { error: err.message });
          }
        }

        // Merge signals and dispatch metrics
        const providerMap = new Map();

        // First, add all providers from dispatch log
        for (const provider of dispatchMetrics.providers || []) {
          providerMap.set(provider.provider, {
            provider: provider.provider,
            successRate: provider.successRate,
            p50LatencyMs: provider.p50LatencyMs,
            p95LatencyMs: provider.p95LatencyMs,
            p99LatencyMs: provider.p99LatencyMs,
            guardrailViolationRate: 0, // Will be overridden by signals if available
            totalDispatches: provider.totalDispatches,
            routingWeight: null, // Will be overridden by signals if available
          });
        }

        // Then, merge in analytics signals (which may have additional providers or override metrics)
        for (const [providerName, signal] of Object.entries(signals)) {
          const existing = providerMap.get(providerName);
          if (existing) {
            // Merge: prefer signals for p50/p95 (pre-computed), dispatch log for p99 (real-time), success rate, and dispatches
            providerMap.set(providerName, {
              ...existing,
              p50LatencyMs: signal.p50LatencyMs ?? existing.p50LatencyMs,
              p95LatencyMs: signal.p95LatencyMs ?? existing.p95LatencyMs,
              // p99 stays from dispatch log (existing.p99LatencyMs) as signals don't store p99
              guardrailViolationRate: signal.guardrailViolationRate ?? 0,
              routingWeight: signal.routingWeight ?? null,
            });
          } else {
            // Provider only in signals (no recent dispatches)
            providerMap.set(providerName, {
              provider: providerName,
              successRate: signal.successRate,
              p50LatencyMs: signal.p50LatencyMs,
              p95LatencyMs: signal.p95LatencyMs,
              p99LatencyMs: null, // Not stored in signals table, only computed from live data
              guardrailViolationRate: signal.guardrailViolationRate ?? 0,
              totalDispatches: 0, // No recent dispatches in this time window
              routingWeight: signal.routingWeight ?? null,
            });
          }
        }

        // Build final response
        const providers = Array.from(providerMap.values());

        // Add last pipeline run timestamp from freshness data
        const lastPipelineRun = freshness.fresh.length > 0 || freshness.stale.length > 0
          ? [...freshness.fresh, ...freshness.stale].reduce((latest, p) => {
              return !latest || new Date(p.generatedAt) > new Date(latest) ? p.generatedAt : latest;
            }, null)
          : null;

        json(res, {
          providers,
          freshness: {
            fresh: freshness.fresh,
            stale: freshness.stale,
            hasStaleSignals: freshness.hasStaleSignals,
            stalenessThresholdMs: freshness.stalenessThresholdMs,
            lastPipelineRun,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to compute analytics dashboard data', { error: err.message, stack: err.stack });
        json(res, { error: 'Failed to compute analytics dashboard data' }, 500);
      }
      return true;
    }

    // --- Routing recommendation persist (POST) ---
    if (path === '/api/routing-recommendations' && req.method === 'POST') {
      (async () => {
        const body = await readBody(req);
        const { recommendations, projectId } = JSON.parse(body);

        if (!recommendations || !Array.isArray(recommendations)) {
          json(res, { success: false, error: 'recommendations array required' }, 400);
          return;
        }

        const auditProjectId = projectId || '_global';
        const persistedRecommendations = [];

        for (const rec of recommendations) {
          const auditEntry = {
            action: 'routing_recommendation',
            timestamp: new Date().toISOString(),
            projectId: auditProjectId,
            status: 'success',
            decision: 'allow',
            data: {
              recommendationId: rec.recommendationId || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              providersAnalyzed: rec.providersAnalyzed || [],
              deltas: rec.deltas || {},
              confidence: rec.confidence || 0,
              oldWeights: rec.oldWeights || {},
              newWeights: rec.newWeights || {},
              rationale: rec.rationale || '',
            },
          };

          if (operatorAuditStore?.append) {
            if (operatorAuditStore.append.length >= 2) {
              operatorAuditStore.append(auditProjectId, auditEntry);
            } else {
              operatorAuditStore.append(auditEntry);
            }
          } else if (operatorAuditStore?.record) {
            operatorAuditStore.record({ ...auditEntry, projectId: auditProjectId });
          }

          persistedRecommendations.push({
            recommendationId: auditEntry.data.recommendationId,
            timestamp: auditEntry.timestamp,
            projectId: auditProjectId,
            action: auditEntry.action,
          });
        }

        json(res, {
          success: true,
          message: `Persisted ${persistedRecommendations.length} recommendation(s)`,
          recommendations: persistedRecommendations,
        });
      })().catch(err => {
        log.error('POST /api/routing-recommendations error:', err);
        respondApiError(res, err, { response: { success: false } });
      });
      return true;
    }

    // --- Routing recommendation audit history ---
    if (path === '/api/routing-recommendations' && req.method === 'GET') {
      if (!operatorAuditStore || typeof operatorAuditStore.query !== 'function') {
        json(res, { error: 'Operator audit store not available' }, 500);
        return true;
      }

      const projectId = url.searchParams.get('projectId')
        || url.searchParams.get('project')
        || '_global';

      const limitRaw = url.searchParams.get('limit');
      let limit = limitRaw !== null ? parseInt(limitRaw, 10) : 100;
      if (Number.isNaN(limit)) {
        json(res, { error: 'limit must be an integer' }, 400);
        return true;
      }
      limit = Math.max(1, Math.min(limit, 500));

      const afterRaw = url.searchParams.get('after');
      let afterEventId;
      if (afterRaw !== null) {
        const parsedAfter = parseInt(afterRaw, 10);
        if (Number.isNaN(parsedAfter)) {
          json(res, { error: 'after must be a numeric eventId' }, 400);
          return true;
        }
        afterEventId = parsedAfter;
      }

      const resolveRecommendationId = (entry) => {
        if (!entry) return null;
        return entry.resourceId
          || entry?.payload?.recommendationId
          || entry?.payload?.recommendation?.id
          || entry?.payload?.id
          || null;
      };

      try {
        const queryLimit = Math.min(Math.max(limit * (afterEventId != null ? 10 : 3), limit), 5000);
        const rawEntries = operatorAuditStore.query(projectId, {
          limit: queryLimit,
          afterEventId,
        }) || [];

        const allowedActions = new Set(['routing_recommendation', 'apply_routing_recommendation']);
        const filtered = rawEntries.filter(entry => allowedActions.has(entry?.action));

        const recommendationById = new Map();
        for (const entry of filtered) {
          if (entry?.action !== 'routing_recommendation') continue;
          const recId = resolveRecommendationId(entry);
          if (recId && !recommendationById.has(recId)) {
            recommendationById.set(recId, entry);
          }
        }

        const withLinks = filtered.map(entry => {
          const recommendationId = resolveRecommendationId(entry);
          if (entry?.action !== 'apply_routing_recommendation') {
            return { ...entry, recommendationId };
          }
          const linked = recommendationId ? recommendationById.get(recommendationId) : null;
          return {
            ...entry,
            recommendationId,
            linkedRecommendation: linked
              ? {
                eventId: linked.eventId || null,
                timestamp: linked.timestamp || null,
                action: linked.action || null,
                recommendationId: resolveRecommendationId(linked),
              }
              : null,
          };
        });

        withLinks.sort((a, b) => (a?.eventId || 0) - (b?.eventId || 0));
        const entries = afterEventId != null
          ? withLinks.slice(0, limit)
          : withLinks.slice(-limit);
        const nextAfterEventId = entries.length > 0 ? entries[entries.length - 1].eventId : null;

        json(res, {
          projectId,
          afterEventId: afterEventId ?? null,
          nextAfterEventId,
          entries,
          total: entries.length,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to query routing recommendations', { error: err.message });
        json(res, { error: 'Failed to query routing recommendations' }, 500);
      }
      return true;
    }

    // --- GET /api/audit ---
    if (path === '/api/audit' && req.method === 'GET') {
      if (!operatorAuditStore || typeof operatorAuditStore.query !== 'function') {
        json(res, { error: 'Operator audit store not available' }, 500);
        return true;
      }

      const correlationId = url.searchParams.get('correlationId');
      if (!correlationId) {
        json(res, { error: 'correlationId query parameter is required' }, 400);
        return true;
      }

      const projectId = url.searchParams.get('projectId') || url.searchParams.get('project') || 'default';
      
      try {
        // Query by correlationId if available in store, else filter in memory
        let entries = [];
        if (typeof operatorAuditStore.queryByCorrelationId === 'function') {
          entries = operatorAuditStore.queryByCorrelationId(correlationId, [projectId]) || [];
        } else {
          entries = (operatorAuditStore.query(projectId, { limit: 1000 }) || [])
            .filter(e => e.correlationId === correlationId);
        }

        json(res, {
          projectId,
          correlationId,
          entries,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to query audit by correlationId', { error: err.message });
        json(res, { error: 'Failed to query audit by correlationId' }, 500);
      }
      return true;
    }

    // --- GET /api/audit/trace/:campaignId ---
    const traceMatch = path.match(/^\/api\/audit\/trace\/(.+)$/);
    if (traceMatch && req.method === 'GET') {
      if (!requireOperatorRole('campaign_read', { action: 'view_trace' })) return true;
      
      const campaignId = decodeURIComponent(traceMatch[1]);
      
      if (!timelineStore || typeof timelineStore.query !== 'function') {
        json(res, { error: 'TimelineStore not available' }, 503);
        return true;
      }

      if (!campaignManager || typeof campaignManager.getCampaign !== 'function') {
        json(res, { error: 'CampaignManager not available' }, 503);
        return true;
      }

      if (!taskManager || typeof taskManager.getTask !== 'function') {
        json(res, { error: 'TaskManager not available' }, 503);
        return true;
      }

      // Parse query parameters
      const depthRaw = url.searchParams.get('depth');
      const depth = depthRaw !== null ? parseInt(depthRaw, 10) : Infinity;
      
      const includeEventsRaw = url.searchParams.get('includeEvents');
      const includeEvents = includeEventsRaw === 'false' ? false : true;
      
      const status = url.searchParams.get('status') || null;

      // Validate depth parameter
      if (depthRaw !== null && (Number.isNaN(depth) || depth < 1 || depth > 10)) {
        json(res, { error: 'depth must be an integer between 1 and 10' }, 400);
        return true;
      }

      // Get project ID from campaign
      const campaigns = campaignManager.listCampaigns();
      const campaignData = campaigns.find(c => c.id === campaignId);
      
      if (!campaignData) {
        json(res, { error: `Campaign not found: ${campaignId}` }, 404);
        return true;
      }

      const projectId = campaignData.project || 'default';

      // Build trace tree with latency measurement (async operation)
      const startTime = performance.now();
      
      buildCampaignTraceTree(
        campaignId,
        timelineStore,
        campaignManager,
        taskManager,
        projectId,
        { depth, includeEvents, status }
      )
      .then(traceTree => {
        const latencyMs = performance.now() - startTime;
        log.info('Trace tree reconstructed', { 
          campaignId, 
          latencyMs: latencyMs.toFixed(2),
          includeEvents,
          statusFilter: status,
          milestoneCount: traceTree.milestones?.length || 0,
        });
        
        if (latencyMs > 500) {
          log.warn('Trace reconstruction exceeded SLA', { campaignId, latencyMs: latencyMs.toFixed(2) });
        }
        
        json(res, traceTree);
      })
      .catch(err => {
        const latencyMs = performance.now() - startTime;
        log.error('Failed to build trace tree', { campaignId, error: err.message, latencyMs: latencyMs.toFixed(2) });
        
        if (err.message.includes('not found')) {
          respondApiError(res, err, { status: 404 });
        } else {
          json(res, { error: 'Failed to build trace tree' }, 500);
        }
      });
      
      return true;
    }

    // --- GET /api/audit/trace/:campaignId/errors ---
    const traceErrorsMatch = path.match(/^\/api\/audit\/trace\/(.+)\/errors$/);
    if (traceErrorsMatch && req.method === 'GET') {
      if (!requireOperatorRole('campaign_read', { action: 'view_error_chains' })) return true;
      
      const campaignId = decodeURIComponent(traceErrorsMatch[1]);
      
      if (!timelineStore || typeof timelineStore.getErrorChainsByCampaign !== 'function') {
        json(res, { error: 'TimelineStore not available' }, 503);
        return true;
      }

      // Validate campaign exists before querying errors
      const campaigns = campaignManager.listCampaigns();
      const campaignData = campaigns.find(c => c.id === campaignId);
      
      if (!campaignData) {
        json(res, { error: `Campaign not found: ${campaignId}` }, 404);
        return true;
      }

      // Build error chains with latency measurement
      const startTime = performance.now();
      const errorChains = buildErrorChain(campaignId, timelineStore);
      const totalLatencyMs = performance.now() - startTime;

      log.info('Error chains built', { 
        campaignId, 
        totalLatencyMs: totalLatencyMs.toFixed(2),
        errorCount: errorChains.length,
      });

      json(res, {
        campaignId,
        totalErrors: errorChains.length,
        timestamp: new Date().toISOString(),
        errorChains,
      });

      return true;
    }

    // --- GET /api/traces ---
    if (path === '/api/traces' && req.method === 'GET') {
      if (!timelineStore || typeof timelineStore.query !== 'function') {
        json(res, { error: 'TimelineStore not available' }, 503);
        return true;
      }

      // Parse and validate query parameters
      const campaignId = url.searchParams.get('campaignId') || undefined;
      const taskId = url.searchParams.get('taskId') || undefined;
      const agentId = url.searchParams.get('agentId') || undefined;
      const fromRaw = url.searchParams.get('from');
      const toRaw = url.searchParams.get('to');

      // Validate and parse time range
      let since;
      if (fromRaw !== null) {
        const fromDate = new Date(fromRaw);
        if (Number.isNaN(fromDate.getTime())) {
          json(res, { error: 'from must be a valid ISO timestamp' }, 400);
          return true;
        }
        since = fromDate.toISOString();
      }

      let until;
      if (toRaw !== null) {
        const toDate = new Date(toRaw);
        if (Number.isNaN(toDate.getTime())) {
          json(res, { error: 'to must be a valid ISO timestamp' }, 400);
          return true;
        }
        until = toDate.toISOString();
      }

      try {
        // Query timeline events with filters
        const filters = {
          campaignId,
          taskId,
          agentId,
          since,
          until,
          limit: 1000, // High limit to get all events for grouping
        };

        const { events = [] } = timelineStore.query(filters);

        // Group events by traceId
        const traceMap = new Map();

        for (const event of events) {
          const traceId = event.trace_id;
          if (!traceId) continue; // Skip events without traceId

          if (!traceMap.has(traceId)) {
            traceMap.set(traceId, {
              traceId,
              eventCount: 0,
              events: [],
            });
          }

          const trace = traceMap.get(traceId);
          trace.eventCount++;
          trace.events.push(event);
        }

        // Build trace listing with event counts and time ranges
        const traces = Array.from(traceMap.values()).map(trace => {
          // Sort events by timestamp
          trace.events.sort((a, b) => Date.parse(a.event_ts) - Date.parse(b.event_ts));

          // Calculate time range
          const firstEvent = trace.events[0];
          const lastEvent = trace.events[trace.events.length - 1];

          return {
            traceId: trace.traceId,
            eventCount: trace.eventCount,
            startTime: firstEvent.event_ts,
            endTime: lastEvent.event_ts,
            campaignId: firstEvent.campaign_id,
            taskId: firstEvent.task_id,
            agentId: firstEvent.agent_id,
          };
        });

        // Sort traces by startTime descending (most recent first)
        traces.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));

        json(res, {
          traces,
          total: traces.length,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to query traces', { error: err.message });
        json(res, { error: 'Failed to query traces' }, 500);
      }

      return true;
    }

    // --- GET /api/operator-audit ---
    if (path === '/api/operator-audit' && req.method === 'GET') {
      if (!operatorAuditStore || typeof operatorAuditStore.query !== 'function') {
        json(res, { error: 'Operator audit store not available' }, 500);
        return true;
      }

      const projectId = url.searchParams.get('projectId') || url.searchParams.get('project') || null;
      const limitRaw = url.searchParams.get('limit');
      const afterRaw = url.searchParams.get('afterEventId');
      const action = url.searchParams.get('action');
      const decision = url.searchParams.get('decision');

      let limit = limitRaw !== null ? parseInt(limitRaw, 10) : 100;
      if (Number.isNaN(limit) || limit < 1 || limit > 500) {
        json(res, { error: 'limit must be an integer between 1 and 500' }, 400);
        return true;
      }

      let afterEventId;
      if (afterRaw !== null) {
        const parsedAfter = parseInt(afterRaw, 10);
        if (Number.isNaN(parsedAfter)) {
          json(res, { error: 'afterEventId must be a numeric eventId' }, 400);
          return true;
        }
        afterEventId = parsedAfter;
      }

      // Validate decision parameter if provided
      if (decision !== null && decision !== 'allow' && decision !== 'deny') {
        json(res, { error: 'decision must be either "allow" or "deny"' }, 400);
        return true;
      }

      try {
        // Query with higher limit to compute accurate total before pagination
        const queryLimit = Math.max(limit * 2, 100);
        const queryOptions = {
          limit: queryLimit,
          afterEventId,
          ...(action && { action }),
          ...(decision && { decision }),
        };
        // When no projectId is specified, query across all projects
        const allEntries = projectId
          ? (operatorAuditStore.query(projectId, queryOptions) || [])
          : (operatorAuditStore.queryAll(queryOptions) || []);

        // Paginate to requested limit
        const entries = allEntries.slice(0, limit);
        const nextAfterEventId = entries.length > 0 ? entries[entries.length - 1].eventId : null;

        json(res, {
          projectId,
          afterEventId: afterEventId ?? null,
          nextAfterEventId,
          entries,
          total: allEntries.length,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to query operator audit log', { error: err.message });
        json(res, { error: 'Failed to query operator audit log' }, 500);
      }
      return true;
    }

    // --- GET /api/pattern-findings ---
    if (path === '/api/pattern-findings' && req.method === 'GET') {
      if (!operatorAuditStore || typeof operatorAuditStore.queryAll !== 'function') {
        json(res, { error: 'Operator audit store not available' }, 500);
        return true;
      }

      const typeRaw = url.searchParams.get('type');
      const limitRaw = url.searchParams.get('limit');
      const afterEventIdRaw = url.searchParams.get('afterEventId');

      // Validate type parameter if provided
      const validTypes = new Set(['cross-project-pattern']);
      let typeFilter = null;
      if (typeRaw !== null && typeRaw !== '') {
        if (!validTypes.has(typeRaw)) {
          json(res, { error: 'type must be one of: cross-project-pattern' }, 400);
          return true;
        }
        typeFilter = typeRaw;
      }

      // Validate limit parameter
      let limit = limitRaw !== null ? parseInt(limitRaw, 10) : 100;
      if (limitRaw !== null && (Number.isNaN(limit) || limit < 1 || limit > 500)) {
        json(res, { error: 'limit must be an integer between 1 and 500' }, 400);
        return true;
      }

      // Validate afterEventId parameter
      let afterEventId;
      if (afterEventIdRaw !== null && afterEventIdRaw !== '') {
        const parsedAfter = parseInt(afterEventIdRaw, 10);
        if (Number.isNaN(parsedAfter)) {
          json(res, { error: 'afterEventId must be a numeric eventId' }, 400);
          return true;
        }
        afterEventId = parsedAfter;
      }

      try {
        // Query with higher limit to compute accurate total before pagination
        const queryLimit = Math.max(limit * 2, 100);
        const queryOptions = {
          limit: queryLimit,
          ...(afterEventId !== undefined && { afterEventId }),
        };

        // Filter by type if specified
        if (typeFilter) {
          queryOptions.action = typeFilter;
        }

        const allEntries = (operatorAuditStore.queryAll(queryOptions) || []);

        // If type filter was applied at store level, we're done. Otherwise, filter in-memory.
        const entries = allEntries.slice(0, limit);
        const nextAfterEventId = entries.length > 0 ? entries[entries.length - 1].eventId : null;

        json(res, {
          type: typeFilter,
          afterEventId: afterEventIdRaw ?? null,
          nextAfterEventId,
          entries,
          total: allEntries.length,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to query pattern findings', { error: err.message });
        json(res, { error: 'Failed to query pattern findings' }, 500);
      }
      return true;
    }

    // --- Apply routing weight override ---
    if ((path === '/api/routing-analytics/apply' || path === '/api/routing/apply-weights') && req.method === 'POST') {
      if (!weightOverrides) {
        json(res, { error: 'Weight overrides not available' }, 500);
        return true;
      }

      handleBody(req, res, async body => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        // Validate payload structure
        if (!payload || !payload.weights) {
          json(res, { error: 'Missing required field: weights' }, 400);
          return;
        }

        // Extract metadata
        const operatorId = requestUserId || 'system';
        const recommendationId = typeof payload.recommendationId === 'string' && payload.recommendationId.trim()
          ? payload.recommendationId.trim()
          : null;
        const auditProjectId = typeof payload.projectId === 'string' && payload.projectId.trim()
          ? payload.projectId.trim()
          : '_global';
        const metadata = {
          reason: payload.reason || 'manual',
          appliedBy: operatorId,
          recommendation: payload.recommendation || null,
          recommendationId,
          campaignId: payload.campaignId || null,
        };

        try {
          const activeBefore = await weightOverrides.getActive();
          const beforeWeights = activeBefore?.weights || null;
          let linkedRecommendationAuditRecord = null;

          if (recommendationId && operatorAuditStore?.query) {
            const recommendationEvents = operatorAuditStore.query(auditProjectId, { limit: 500 }) || [];
            linkedRecommendationAuditRecord = [...recommendationEvents].reverse().find(entry =>
              entry?.action === 'routing_recommendation'
              && (
                entry?.resourceId === recommendationId
                || entry?.payload?.recommendationId === recommendationId
                || entry?.payload?.recommendation?.id === recommendationId
                || entry?.payload?.id === recommendationId
              )
            ) || null;
          }

          // Apply the override
          const override = await weightOverrides.apply(payload.weights, metadata);

          // Log the action
          log.info('Routing weight override applied', {
            weights: payload.weights,
            appliedBy: metadata.appliedBy,
            reason: metadata.reason,
            recommendationId,
          });

          // Audit the operator action
          if (operatorAuditStore) {
            const auditEntry = {
              operatorId,
              action: 'apply_routing_recommendation',
              campaignId: payload.campaignId || null,
              resourceType: 'routing',
              resourceId: 'global',
              status: 'applied',
              decision: 'allow',
              beforeState: { weights: beforeWeights },
              afterState: { weights: payload.weights },
              payload: {
                recommendationId,
                linkedRecommendation: linkedRecommendationAuditRecord
                  ? {
                    eventId: linkedRecommendationAuditRecord.eventId || null,
                    action: linkedRecommendationAuditRecord.action || null,
                    timestamp: linkedRecommendationAuditRecord.timestamp || null,
                  }
                  : null,
                beforeWeights,
                afterWeights: payload.weights,
                reason: metadata.reason,
                operatorId,
                recommendation: metadata.recommendation,
              },
              timestamp: override.appliedAt, // Use the override's appliedAt timestamp for consistency
            };

            if (typeof operatorAuditStore.append === 'function') {
              if (operatorAuditStore.append.length >= 2) {
                operatorAuditStore.append(auditProjectId, auditEntry);
              } else {
                operatorAuditStore.append(auditEntry);
              }
            } else if (typeof operatorAuditStore.record === 'function') {
              operatorAuditStore.record({
                ...auditEntry,
                projectId: auditProjectId,
              });
            }
          }

          // Create timeline event for routing weight application
          if (timelineStore && typeof timelineStore.appendOperatorActionEvent === 'function') {
            try {
              // Compute weight deltas per provider
              const weightDeltas = {};
              const allProviders = new Set([
                ...Object.keys(beforeWeights || {}),
                ...Object.keys(payload.weights || {}),
              ]);

              for (const provider of allProviders) {
                const before = beforeWeights?.[provider] ?? null;
                const after = payload.weights?.[provider] ?? null;
                weightDeltas[provider] = {
                  before,
                  after,
                  delta: (after !== null && before !== null) ? (after - before) : null,
                  changed: before !== after,
                };
              }

              // Gather current performance metrics for context
              const performanceMetrics = {};
              if (performanceStore) {
                try {
                  const rawStats = performanceStore.getAllAgentStats ? performanceStore.getAllAgentStats() : [];
                  const providerStats = {};

                  for (const stat of rawStats) {
                    const agent = agents[stat.agentId];
                    if (agent?.provider && allProviders.has(agent.provider)) {
                      if (!providerStats[agent.provider]) {
                        providerStats[agent.provider] = {
                          totalDispatches: 0,
                          successfulDispatches: 0,
                          categories: new Set(),
                        };
                      }
                      providerStats[agent.provider].totalDispatches += stat.totalDispatches || 0;
                      providerStats[agent.provider].successfulDispatches += Math.round((stat.successRate || 0) * (stat.totalDispatches || 0));
                      providerStats[agent.provider].categories.add(stat.taskCategory);
                    }
                  }

                  for (const [provider, stats] of Object.entries(providerStats)) {
                    performanceMetrics[provider] = {
                      totalDispatches: stats.totalDispatches,
                      successRate: stats.totalDispatches > 0 ? stats.successfulDispatches / stats.totalDispatches : null,
                      categories: [...stats.categories],
                    };
                  }
                } catch (perfErr) {
                  log.warn('Failed to gather performance metrics for timeline event', { error: perfErr.message });
                }
              }

              const timelineEvent = {
                actionType: 'routing.weights.applied',
                operatorId,
                status: 'applied',
                campaignId: payload.campaignId || null,
                eventTs: new Date().toISOString(),
                data: {
                  recommendationId,
                  beforeWeights,
                  afterWeights: payload.weights,
                  weightDeltas,
                  performanceMetrics,
                  reason: metadata.reason,
                  appliedBy: operatorId,
                  linkedRecommendationEventId: linkedRecommendationAuditRecord?.eventId || null,
                  recommendation: metadata.recommendation,
                },
              };

              timelineStore.appendOperatorActionEvent(timelineEvent);
              log.info('Timeline event created for routing weight application', {
                actionType: 'routing.weights.applied',
                recommendationId,
              });
            } catch (timelineErr) {
              log.error('Failed to create timeline event for routing weight application', {
                error: timelineErr.message,
                stack: timelineErr.stack,
              });
            }
          }

          json(res, {
            success: true,
            override,
            recommendationId,
            linkedRecommendationEventId: linkedRecommendationAuditRecord?.eventId || null,
            beforeWeights,
            afterWeights: payload.weights,
            message: 'Routing weight override applied successfully',
          });
        } catch (err) {
          log.error('Failed to apply routing weight override', { error: err.message });
          respondApiError(res, err, { status: 400, message: 'Failed to apply routing weight override' });
        }
      }).catch(err => {
        log.error('Failed to read request body', { error: err.message });
        json(res, { error: 'Failed to read request body' }, 500);
      });
      return true;
    }

    // --- Rollback routing weight override ---
    if (path === '/api/routing/rollback' && req.method === 'POST') {
      if (!weightOverrides) {
        json(res, { error: 'Weight overrides not available' }, 500);
        return true;
      }

      handleBody(req, res, async body => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (err) {
          json(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        // Validate payload structure
        if (!payload || (!payload.eventId && !payload.timestamp)) {
          json(res, { error: 'Missing required field: eventId or timestamp' }, 400);
          return;
        }

        // Extract metadata
        const operatorId = requestUserId || 'system';
        const auditProjectId = typeof payload.projectId === 'string' && payload.projectId.trim()
          ? payload.projectId.trim()
          : '_global';
        const reason = payload.reason || 'manual_rollback';

        // RBAC policy check
        if (policyEngine && policyEngine.enforce) {
          try {
            const policyResult = policyEngine.enforce({
              action: 'routing:rollback',
              resource: 'routing_weights',
              operatorId,
              projectId: auditProjectId,
            });
            if (!policyResult.allowed) {
              log.warn('Rollback denied by policy', {
                operatorId,
                reason: policyResult.reason,
                eventId: payload.eventId,
              });
              if (operatorAuditStore && operatorAuditStore.record) {
                operatorAuditStore.record({
                  operatorId,
                  action: 'routing:rollback',
                  resource: 'routing_weights',
                  status: 'denied',
                  decision: 'deny',
                  reason: policyResult.reason,
                  timestamp: new Date().toISOString(),
                });
              }
              json(res, { error: 'Unauthorized: insufficient permissions for routing rollback' }, 403);
              return;
            }
          } catch (err) {
            log.error('Policy engine error during rollback check', { error: err.message });
          }
        }

        try {
          // Look up the snapshot to rollback to
          let snapshot = null;
          if (payload.eventId) {
            snapshot = await weightOverrides.getSnapshotById(payload.eventId);
          } else if (payload.timestamp) {
            const history = await weightOverrides.getHistory();
            const targetTime = new Date(payload.timestamp).getTime();
            const closest = history.reduce((closest, entry) => {
              const entryTime = new Date(entry.storedAt).getTime();
              if (!closest || Math.abs(entryTime - targetTime) < Math.abs(new Date(closest.storedAt).getTime() - targetTime)) {
                return entry;
              }
              return closest;
            }, null);
            snapshot = closest;
          }

          if (!snapshot) {
            json(res, { error: 'Snapshot not found' }, 404);
            return;
          }

          // Get current weights before rollback
          const activeBefore = await weightOverrides.getActive();
          const beforeWeights = activeBefore?.weights || null;

          // Apply the rollback (restore old weights)
          await weightOverrides.apply(snapshot.weights, {
            reason: `rollback_to_${snapshot.id.substring(0, 12)}`,
            appliedBy: operatorId,
            rollbackSource: snapshot.id,
            originalAppliedAt: snapshot.appliedAt,
          });

          // Get weights after rollback
          const activeAfter = await weightOverrides.getActive();
          const afterWeights = activeAfter?.weights || null;

          log.info('Routing weight rollback completed', {
            snapshotId: snapshot.id,
            operatorId,
            reason,
            beforeWeights,
            afterWeights,
          });

          // Record to operator audit store
          if (operatorAuditStore && operatorAuditStore.record) {
            operatorAuditStore.record({
              operatorId,
              action: 'rollback_routing_weights',
              resource: 'routing_weights',
              status: 'completed',
              decision: 'allow',
              payload: {
                snapshotId: snapshot.id,
                reason,
                beforeWeights,
                afterWeights,
              },
              timestamp: new Date().toISOString(),
            });
          }

          json(res, {
            success: true,
            message: 'Routing weights rolled back successfully',
            snapshotId: snapshot.id,
            beforeWeights,
            afterWeights,
            rolledBackAt: new Date().toISOString(),
            operatorId,
          });
        } catch (err) {
          log.error('Failed to rollback routing weights', { error: err.message });
          respondApiError(res, err, { status: 400, message: 'Failed to rollback routing weights' });
        }
      }).catch(err => {
        log.error('Failed to read request body', { error: err.message });
        json(res, { error: 'Failed to read request body' }, 500);
      });
      return true;
    }

    // --- Routing outcomes (per-category success rate comparison across two time windows) ---
    if (path === '/api/routing-outcomes' && req.method === 'GET') {
      if (!dispatchLog) {
        json(res, { error: 'Routing outcomes not available' }, 500);
        return true;
      }

      // Parse window parameters
      const window1Start = url.searchParams.get('window1_start') || undefined;
      const window1End = url.searchParams.get('window1_end') || undefined;
      const window2Start = url.searchParams.get('window2_start') || undefined;
      const window2End = url.searchParams.get('window2_end') || undefined;
      const taskCategoryFilter = url.searchParams.get('taskCategory') || undefined;
      const outcomeFilters = url.searchParams.getAll('outcome');

      // Default to last 24h vs previous 24h if no params provided
      const now = new Date();
      const defaultWindow2End = now.toISOString();
      const defaultWindow2Start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const defaultWindow1End = defaultWindow2Start;
      const defaultWindow1Start = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

      const w1Start = window1Start || defaultWindow1Start;
      const w1End = window1End || defaultWindow1End;
      const w2Start = window2Start || defaultWindow2Start;
      const w2End = window2End || defaultWindow2End;

      try {
        // Query outcomes for both windows (optionally filtered by category/outcome).
        const { window1Outcomes, window2Outcomes } = queryRoutingOutcomesForWindows(dispatchLog, {
          window1Start: w1Start,
          window1End: w1End,
          window2Start: w2Start,
          window2End: w2End,
          taskCategory: taskCategoryFilter,
          outcomes: outcomeFilters,
        });

        // Group by task category
        const byCategory = (outcomes) => {
          const groups = {};
          for (const o of outcomes) {
            if (!groups[o.taskCategory]) {
              groups[o.taskCategory] = {
                taskCategory: o.taskCategory,
                dispatches: 0,
                successes: 0,
                failures: 0,
                partials: 0,
                knownOutcomes: 0,
                agents: {},
              };
            }
            const cat = groups[o.taskCategory];
            cat.dispatches += o.dispatches;
            cat.successes += o.successes;
            cat.failures += o.failures;
            cat.partials += o.partials;
            cat.knownOutcomes += (o.successes + o.failures + o.partials);

            // Per-agent breakdown
            if (!cat.agents[o.agentId]) {
              cat.agents[o.agentId] = {
                agentId: o.agentId,
                dispatches: 0,
                successes: 0,
                failures: 0,
                partials: 0,
                knownOutcomes: 0,
              };
            }
            const agent = cat.agents[o.agentId];
            agent.dispatches += o.dispatches;
            agent.successes += o.successes;
            agent.failures += o.failures;
            agent.partials += o.partials;
            agent.knownOutcomes += (o.successes + o.failures + o.partials);
          }
          return groups;
        };

        const cat1 = byCategory(window1Outcomes);
        const cat2 = byCategory(window2Outcomes);

        // Compute aggregates and deltas
        const computeRate = (successes, known) => known > 0 ? successes / known : null;

        const categories = [];
        const allCategories = new Set([...Object.keys(cat1), ...Object.keys(cat2)]);

        for (const category of allCategories) {
          const c1 = cat1[category];
          const c2 = cat2[category];

          // Skip categories absent from both windows
          if (!c1 && !c2) continue;

          // Omit categories absent from one window (per spec)
          if (!c1 || !c2) continue;

          const w1SuccessRate = computeRate(c1.successes, c1.knownOutcomes);
          const w2SuccessRate = computeRate(c2.successes, c2.knownOutcomes);

          // Build per-agent deltas
          const agentIds = new Set([...Object.keys(c1.agents), ...Object.keys(c2.agents)]);
          const agents = [];

          for (const agentId of agentIds) {
            const a1 = c1.agents[agentId];
            const a2 = c2.agents[agentId];

            if (!a1 || !a2) continue;

            const a1SuccessRate = computeRate(a1.successes, a1.knownOutcomes);
            const a2SuccessRate = computeRate(a2.successes, a2.knownOutcomes);

            agents.push({
              agentId,
              window1: {
                dispatches: a1.dispatches,
                successRate: a1SuccessRate,
                successes: a1.successes,
                failures: a1.failures,
                partials: a1.partials,
              },
              window2: {
                dispatches: a2.dispatches,
                successRate: a2SuccessRate,
                successes: a2.successes,
                failures: a2.failures,
                partials: a2.partials,
              },
              delta: {
                dispatches: a2.dispatches - a1.dispatches,
                successRate: a2SuccessRate !== null && a1SuccessRate !== null
                  ? a2SuccessRate - a1SuccessRate
                  : null,
              },
            });
          }

          categories.push({
            taskCategory: category,
            window1: {
              dispatches: c1.dispatches,
              successRate: w1SuccessRate,
              successes: c1.successes,
              failures: c1.failures,
              partials: c1.partials,
            },
            window2: {
              dispatches: c2.dispatches,
              successRate: w2SuccessRate,
              successes: c2.successes,
              failures: c2.failures,
              partials: c2.partials,
            },
            delta: {
              dispatches: c2.dispatches - c1.dispatches,
              successRate: w2SuccessRate !== null && w1SuccessRate !== null
                ? w2SuccessRate - w1SuccessRate
                : null,
            },
            agents,
          });
        }

        categories.sort((a, b) => a.taskCategory.localeCompare(b.taskCategory));

        json(res, {
          windows: {
            window1: { start: w1Start, end: w1End },
            window2: { start: w2Start, end: w2End },
          },
          categories,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error('Failed to compute routing outcomes', { error: err.message });
        json(res, { error: 'Failed to compute routing outcomes' }, 500);
      }
      return true;
    }

    // --- Dispatch log (routing decision audit trail) ---
    if (path === '/api/dispatch-log' && req.method === 'GET') {
      if (!dispatchLog) {
        json(res, { decisions: [], total: 0, timestamp: new Date().toISOString() });
        return true;
      }

      // Parse query parameters
      let limit = parseInt(url.searchParams.get('limit'), 10) || 100;
      if (limit < 1) limit = 100;
      if (limit > 500) limit = 500;

      const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
      const campaignId = url.searchParams.get('campaignId') || undefined;
      const category = url.searchParams.get('category') || undefined;
      const agentId = url.searchParams.get('agentId') || url.searchParams.get('agent') || undefined;
      const since = url.searchParams.get('since') || undefined;

      // Query dispatch log with filters
      const result = dispatchLog.query({
        limit,
        offset,
        campaignId,
        taskCategory: category,
        agentId,
        startTime: since,
      });

      json(res, {
        decisions: result.decisions,
        total: result.total,
        offset,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    // --- Single dispatch decision audit record (routing rationale) ---
    const dispatchDecisionMatch = path.match(/^\/api\/dispatch-log\/([^/]+)\/decision$/);
    if (dispatchDecisionMatch && req.method === 'GET') {
      if (!dispatchLog) {
        json(res, { error: 'Dispatch log not available' }, 500);
        return true;
      }

      const id = dispatchDecisionMatch[1];
      if (!id || id.trim() === '') {
        json(res, { error: 'Invalid dispatch ID' }, 400);
        return true;
      }

      const record = dispatchLog.getById(id);
      if (!record) {
        json(res, { error: 'Dispatch record not found' }, 404);
        return true;
      }

      json(res, record);
      return true;
    }

    // --- Single dispatch record detail (alias for dispatch-detail) ---
    const dispatchLogIdMatch = path.match(/^\/api\/dispatch-log\/([^/]+)$/);
    if (dispatchLogIdMatch && req.method === 'GET') {
      if (!dispatchLog) {
        json(res, { error: 'Dispatch log not available' }, 500);
        return true;
      }

      const id = dispatchLogIdMatch[1];
      if (!id || id.trim() === '') {
        json(res, { error: 'Invalid dispatch ID' }, 400);
        return true;
      }

      const record = dispatchLog.getById(id);
      if (!record) {
        json(res, { error: 'Dispatch record not found' }, 404);
        return true;
      }

      json(res, record);
      return true;
    }

    // --- Single dispatch record detail ---
    const dispatchDetailMatch = path.match(/^\/api\/dispatch-detail\/([^/]+)$/);
    if (dispatchDetailMatch && req.method === 'GET') {
      if (!dispatchLog) {
        json(res, { error: 'Dispatch log not available' }, 500);
        return true;
      }

      const id = dispatchDetailMatch[1];
      if (!id || id.trim() === '') {
        json(res, { error: 'Invalid dispatch ID' }, 400);
        return true;
      }

      const record = dispatchLog.getById(id);
      if (!record) {
        json(res, { error: 'Dispatch record not found' }, 404);
        return true;
      }

      json(res, record);
      return true;
    }

    // --- Telemetry polling fallback ---
    if (path === '/api/telemetry/recent' && req.method === 'GET') {
      const project = url.searchParams.get('project');
      if (!project) { json(res, { error: 'project query parameter is required' }, 400); return true; }
      if (!telemetryStore) { json(res, { error: 'Telemetry store not available' }, 500); return true; }
      const afterParam = url.searchParams.get('after');
      let limit = parseInt(url.searchParams.get('limit'), 10) || 50;
      if (limit > 200) limit = 200;
      if (limit < 1) limit = 50;
      let results;
      if (afterParam) {
        const afterId = parseInt(afterParam, 10);
        if (isNaN(afterId)) { json(res, { error: 'after must be a numeric eventId' }, 400); return true; }
        results = telemetryStore.getEventsAfter(project, afterId);
        results = results.slice(0, limit);
      } else {
        results = telemetryStore.getRecent(project, limit);
      }
      results.sort((a, b) => a.eventId - b.eventId);
      json(res, results);
      return true;
    }

    // --- Preferences & agenda ---
    if (path === '/api/preferences' && req.method === 'GET') {
      const projectId = url.searchParams.get('project');
      json(res, { preferences: prefsManager.getAll(projectId), schema: prefsManager.getSchema() });
      return true;
    }
    const agendaMatch = path.match(/^\/api\/projects\/([^/]+)\/agenda$/);
    if (agendaMatch && req.method === 'GET') {
      json(res, agendaManager.get(agendaMatch[1]));
      return true;
    }

    // --- Channel status ---
    const statusMatch = path.match(/^\/api\/projects\/([^/]+)\/channels\/([^/]+)\/status$/);
    if (statusMatch && req.method === 'GET') {
      const [, proj, chan] = statusMatch;
      const thinking = [];
      for (const k of thinkingAgents) {
        const [p, c, a] = k.split('#');
        if (p === proj && c === chan) thinking.push(a);
      }
      const cooldowns = {};
      for (const [name] of Object.entries(agents)) {
        if (isAgentCoolingDown(name)) {
          const entry = agentCooldowns.get(name);
          cooldowns[name] = { until: new Date(entry?.until ?? 0).toISOString(), remainMs: (entry?.until ?? 0) - Date.now(), reason: entry?.reason };
        }
      }
      const hasQueuedTurn = [...turnQueues.keys()].some((k) => k === `${proj}#${chan}` || k.endsWith(`#${proj}#${chan}`));
      json(res, {
        state: thinking.length > 0 || hasQueuedTurn ? 'deliberating' : 'idle',
        phase: thinking.length > 0 ? 'processing' : null,
        thinkingAgents: thinking, hasQueuedTurn,
        agentCooldowns: cooldowns, capabilities: { lifecycle_control: false, events: false },
      });
      return true;
    }

    // --- Task routes ---
    // Bulk task listing across every project, keyed by projectId.
    //
    // The dashboard's task panel polls every 30s. With only the per-project
    // route available it looped over projects and issued ONE REQUEST PER
    // PROJECT, so request volume grew linearly with project count against a
    // 120/min budget that is SHARED by every browser tab and API client using
    // the same token (rate-limiter keys on the token prefix, not the tab).
    // Two dashboards open on a busy install could sit near the limit doing
    // nothing. This collapses a poll to one request regardless of scale.
    //
    // The summary projection is the DEFAULT here, unlike the per-project route
    // where it is opt-in via ?view=summary. A bulk route that returns full task
    // objects by default is precisely how the old /api/tasks came to ship a
    // 7.3MB response (task #38). Callers needing heavy fields (subtasks,
    // reviewFindings, plan, gitBaseline) should fetch the single task they are
    // actually displaying via /api/projects/:id/tasks/:taskId.
    if (path === '/api/tasks' && req.method === 'GET') {
      const statusParam = url.searchParams.get('status');
      const wantFull = url.searchParams.get('view') === 'full';

      // Per-project row cap.
      //
      // The summary projection bounds how big each TASK is; it does nothing
      // about how MANY there are. Tasks accumulate for the life of a project
      // and are never pruned, so without a cap this response grows without
      // limit — and ?view=full reintroduces task #38's 7.3MB failure at
      // aggregate scale, across every project at once.
      //
      // The default is deliberately generous rather than apiDefaultLimit (50).
      // The dashboard polls ?status=active, and a busy project can legitimately
      // have more than 50 in flight; defaulting to 50 would silently hide
      // running work from the operator, which is a worse bug than the one being
      // fixed. 500/project bounds the pathological case while leaving real
      // usage untouched.
      //
      // Capping PER PROJECT, not globally: a global budget would be consumed by
      // whichever projects listProjects() happens to return first, so the tasks
      // you see would depend on project ordering.
      const BULK_TASK_LIMIT_DEFAULT = 500;
      const BULK_TASK_LIMIT_MAX = 2000;
      const limit = Math.min(
        Math.max(parseInt(url.searchParams.get('limit'), 10) || BULK_TASK_LIMIT_DEFAULT, 1),
        BULK_TASK_LIMIT_MAX,
      );

      const byProject = {};
      let total = 0;
      let returned = 0;
      for (const proj of stateManager.listProjects()) {
        // 'active' is a UI pseudo-status meaning "not finished" — same
        // treatment as the per-project route, kept identical on purpose.
        const tasks = statusParam === 'active'
          ? taskManager.listTasks(proj.id).filter(t => !TASK_FINISHED_STATUSES.has(t.status))
          : taskManager.listTasks(proj.id, null, statusParam);
        total += tasks.length;
        const capped = tasks.length > limit ? tasks.slice(0, limit) : tasks;
        returned += capped.length;
        byProject[proj.id] = wantFull ? capped : capped.map(summarizeTask);
      }

      // Truncation is reported in HEADERS, not the body: the body is a bare
      // {projectId: [...]} map and the dashboard walks its own project list
      // against it with hasOwnProperty, so any envelope or extra key would
      // either be ignored or collide with a project literally named for it.
      // A cap that does not announce itself reads as "there is no more work",
      // which is exactly the wrong thing to tell an operator.
      res.setHeader('X-Tasks-Total', String(total));
      res.setHeader('X-Tasks-Returned', String(returned));
      res.setHeader('X-Tasks-Truncated', returned < total ? 'true' : 'false');
      res.setHeader('X-Tasks-Limit', String(limit));
      if (returned < total) {
        log.warn('Bulk task listing truncated', { total, returned, limit });
      }

      json(res, byProject);
      return true;
    }

    const tasksMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (tasksMatch && req.method === 'GET') {
      const projId = decodeURIComponent(tasksMatch[1]);
      // listTasks(projectId, userId, statusFilter) — the status was previously
      // passed in the userId slot, which silently disabled filtering entirely
      // (every ?status= value, valid or not, returned the full list).
      //
      // 'active' is a UI pseudo-status, not a real one: the task panel wants
      // in-flight work, i.e. anything not finished. Passing it through as a
      // literal status would match nothing.
      const statusParam = url.searchParams.get('status');
      const tasks = statusParam === 'active'
        ? taskManager.listTasks(projId).filter(t => !TASK_FINISHED_STATUSES.has(t.status))
        : taskManager.listTasks(projId, null, statusParam);
      json(res, url.searchParams.get('view') === 'summary' ? tasks.map(summarizeTask) : tasks);
      return true;
    }
    const taskDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskDetailMatch && req.method === 'GET') {
      const task = taskManager.getTask(decodeURIComponent(taskDetailMatch[1]), decodeURIComponent(taskDetailMatch[2]));
      json(res, task || { error: 'Task not found' }, task ? 200 : 404);
      return true;
    }
    const taskPauseMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/pause$/);
    if (taskPauseMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      const [projId, taskId] = [decodeURIComponent(taskPauseMatch[1]), decodeURIComponent(taskPauseMatch[2])];
      const task = taskManager.getTask(projId, taskId);
      if (!task) { json(res, { error: 'Not found' }, 404); return true; }
      if (task.type !== 'daemon') { json(res, { error: 'Not a daemon task' }, 400); return true; }

      handleBody(req, res, body => {
        const payload = (body && body.trim()) ? JSON.parse(body) : {};
        const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
        const operatorId = requestUserId || 'system';

        taskManager.pauseDaemon(projId, taskId, auditReason || 'Paused via API');
        addMessage(projId, task.channel, 'System', `Daemon paused: "${task.title}"`, 'system');

        operatorAuditStore.append({
          action: 'task_pause',
          projectId: projId,
          taskId,
          operatorId,
          status: 'success',
          decision: 'allow',
          details: `Paused daemon task "${task.title}" via API`,
          source,
          reason: auditReason,
          correlationId,
          dispatchId,
          traceId,
        });

        json(res, { ok: true, status: 'paused' });
      });
      return true;
    }
    const taskResumeMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/resume$/);
    if (taskResumeMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      const [projId, taskId] = [decodeURIComponent(taskResumeMatch[1]), decodeURIComponent(taskResumeMatch[2])];
      const task = taskManager.getTask(projId, taskId);
      if (!task) { json(res, { error: 'Not found' }, 404); return true; }
      if (task.type !== 'daemon') { json(res, { error: 'Not a daemon task' }, 400); return true; }

      handleBody(req, res, body => {
        const payload = (body && body.trim()) ? JSON.parse(body) : {};
        const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
        const operatorId = requestUserId || 'system';

        taskManager.resumeDaemon(projId, taskId);
        addMessage(projId, task.channel, 'System', `Daemon resumed: "${task.title}"`, 'system');

        operatorAuditStore.append({
          action: 'task_resume',
          projectId: projId,
          taskId,
          operatorId,
          status: 'success',
          decision: 'allow',
          details: `Resumed daemon task "${task.title}" via API`,
          source,
          reason: auditReason,
          correlationId,
          dispatchId,
          traceId,
        });

        json(res, { ok: true, status: 'resumed' });
      });
      return true;
    }
    // --- Task status override (manual) ---
    const taskStatusMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/status$/);
    if (taskStatusMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      const [projId, taskId] = [decodeURIComponent(taskStatusMatch[1]), decodeURIComponent(taskStatusMatch[2])];
      handleBody(req, res, body => {
        try {
          const { status, reason } = JSON.parse(body);
          if (!status) { json(res, { error: 'status required' }, 400); return; }
          const normalizedStatus = status === 'completed' ? 'done' : status;
          const task = taskManager.getTask(projId, taskId);
          if (!task) { json(res, { error: 'Task not found' }, 404); return; }
          const updated = taskManager.updateTaskStatus(projId, taskId, normalizedStatus, 'operator', reason || `Manual override → ${normalizedStatus}`);
          addMessage(projId, task.channel, 'System',
            `Task "${task.title}" manually set to **${normalizedStatus}**${reason ? `: ${reason}` : ''}`, 'system');
          // Trigger strategist evaluation for campaign progression on terminal states
          if (['done', 'failed', 'cancelled'].includes(normalizedStatus)) {
            const campaign = campaignManager.findCampaignByTask(projId, taskId);
            if (campaign && campaign.status === 'active' && strategistEvaluate) {
              strategistEvaluate(projId, campaign.id).catch(err =>
                log.error('Strategist evaluation failed after manual status override', { projectId: projId, campaignId: campaign.id, error: err.message }));
            }
          }
          json(res, { ok: true, task: updated });
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // --- Webhook routes ---
    const webhookListMatch = path.match(/^\/api\/projects\/([^/]+)\/webhooks$/);
    if (webhookListMatch && req.method === 'GET') {
      const projId = decodeURIComponent(webhookListMatch[1]);
      json(res, webhookDispatcher.store.list(projId));
      return true;
    }
    if (webhookListMatch && req.method === 'POST') {
      const projId = decodeURIComponent(webhookListMatch[1]);
      if (!requireOperatorRole('webhook_create', { projectId: projId })) return true;
      handleBody(req, res, body => {
        try {
          const { url: whUrl, events, description } = JSON.parse(body);
          const hook = webhookDispatcher.store.create(projId, { url: whUrl, events, description });
          json(res, hook, 201);
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }
    const webhookDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/webhooks\/([^/]+)$/);
    if (webhookDetailMatch && req.method === 'DELETE') {
      const [projId, whId] = [decodeURIComponent(webhookDetailMatch[1]), decodeURIComponent(webhookDetailMatch[2])];
      if (!requireOperatorRole('webhook_delete', { projectId: projId })) return true;
      const deleted = webhookDispatcher.store.remove(projId, whId);
      json(res, deleted ? { ok: true } : { error: 'Webhook not found' }, deleted ? 200 : 404);
      return true;
    }
    const webhookTestMatch = path.match(/^\/api\/projects\/([^/]+)\/webhooks\/([^/]+)\/test$/);
    if (webhookTestMatch && req.method === 'POST') {
      const [projId, whId] = [decodeURIComponent(webhookTestMatch[1]), decodeURIComponent(webhookTestMatch[2])];
      webhookDispatcher.testWebhook(projId, whId).then(result => {
        json(res, result);
      }).catch(err => { respondApiError(res, err); });
      return true;
    }

    // --- Inbound webhook (external systems → EventBus) ---
    if (path === '/api/webhooks/inbound' && req.method === 'POST') {
      const { events: eventBus } = deps;
      if (!eventBus) { json(res, { error: 'EventBus not available' }, 500); return true; }
      handleBody(req, res, body => {
        try {
          const { event, project, data } = JSON.parse(body);
          if (!event) { json(res, { error: 'event required' }, 400); return; }
          if (!project) { json(res, { error: 'project required' }, 400); return; }
          eventBus.emit(event, { projectId: project, ...data }).catch(err =>
            log.error('Inbound webhook event emission failed', { event, project, error: err.message })
          );
          json(res, { ok: true, event, project }, 202);
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }

    // --- Telemetry SSE stream ---
    if (path === '/api/telemetry/stream' && req.method === 'GET') {
      const projectId = url.searchParams.get('project');
      if (!projectId) {
        json(res, { error: 'project query parameter required' }, 400);
        return true;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.flushHeaders(); // Send headers immediately so clients can detect the open connection

      // Disable timeouts for this long-lived connection
      res.setTimeout(0);
      req.socket.setTimeout(0);

      const taskIdFilter = url.searchParams.get('taskId');
      const agentIdFilter = url.searchParams.get('agentId');

      // Replay missed events if Last-Event-ID is present
      const lastEventId = req.headers['last-event-id'];
      if (lastEventId) {
        const afterId = parseInt(lastEventId, 10);
        if (!isNaN(afterId)) {
          const missed = telemetryStore.getEventsAfter(projectId, afterId);
          for (const evt of missed) {
            if (taskIdFilter && evt.taskId !== taskIdFilter) continue;
            if (agentIdFilter && evt.agentId !== agentIdFilter) continue;
            res.write(`id: ${evt.eventId}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt)}\n\n`);
          }
        }
      }

      // Subscribe to all WS_EVENT_MAP events on EventBus (per-connection handlers)
      let closed = false;
      const handlers = [];

      for (const eventName of Object.keys(WS_EVENT_MAP)) {
        const handler = (data) => {
          if (closed) return;
          const evtProjectId = data.projectId || data.project;
          if (evtProjectId !== projectId) return;
          if (taskIdFilter && (data.taskId || null) !== taskIdFilter) return;
          if (agentIdFilter && (data.agentId || data.agent || data.assignedTo || null) !== agentIdFilter) return;

          const eventId = data.eventId || Date.now();
          try {
            res.write(`id: ${eventId}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch { /* connection already closed */ }
        };
        events.on(eventName, handler);
        handlers.push({ eventName, handler });
      }

      // Keepalive comment every 15s to prevent connection timeout
      const keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          res.write(': keepalive\n\n');
        } catch { /* connection already closed */ }
      }, 15000);

      // Cleanup all subscriptions and timer on disconnect
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepaliveTimer);
        for (const { eventName, handler } of handlers) {
          events.off(eventName, handler);
        }
      };
      req.on('close', cleanup);

      return true;
    }

    // --- Steering SSE stream ---
    if (path === '/api/steering/stream' && req.method === 'GET') {
      const { events, timelineStore } = deps;
      if (!events) {
        json(res, { error: 'EventBus not available' }, 500);
        return true;
      }
      if (!timelineStore) {
        json(res, { error: 'TimelineStore not available' }, 500);
        return true;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.flushHeaders(); // Send headers immediately so clients can detect the open connection

      // Disable timeouts for this long-lived connection
      res.setTimeout(0);
      req.socket.setTimeout(0);

      // Optional filters
      const actionTypeFilter = url.searchParams.get('actionType');
      const correlationIdFilter = url.searchParams.get('correlationId');

      // Replay missed events if Last-Event-ID is present
      const lastEventId = req.headers['last-event-id'];
      if (lastEventId) {
        try {
          // Query recent operator_action events and filter for those after lastEventId
          const result = timelineStore.query({
            type: 'operator_action',
            limit: 100,
          });

          for (const evt of result.events) {
            // Skip events at or before the Last-Event-ID timestamp
            const evtTs = evt.event_ts || evt.created_at;
            if (evtTs && evtTs <= lastEventId) continue;

            // Apply filters
            if (actionTypeFilter && evt.row?.action_type !== actionTypeFilter) continue;
            if (correlationIdFilter) {
              const matchesCorrelation =
                evt.dispatch_id === correlationIdFilter ||
                evt.trace_id === correlationIdFilter ||
                evt.campaign_id === correlationIdFilter;
              if (!matchesCorrelation) continue;
            }

            const eventId = evtTs;
            const eventData = {
              id: evt.id,
              actionType: evt.row?.action_type,
              operatorId: evt.row?.operator_id,
              status: evt.row?.status,
              correlationId: evt.dispatch_id || evt.trace_id || evt.campaign_id,
              campaignId: evt.campaign_id,
              dispatchId: evt.dispatch_id,
              traceId: evt.trace_id,
              agentId: evt.agent_id,
              provider: evt.provider,
              sourceDispatchId: evt.row?.source_dispatch_id,
              targetDispatchId: evt.row?.target_dispatch_id,
              targetParams: evt.row?.target_params ? JSON.parse(evt.row.target_params) : null,
              data: evt.data,
              timestamp: evt.event_ts,
            };
            res.write(`id: ${eventId}\nevent: steering:action\ndata: ${JSON.stringify(eventData)}\n\n`);
          }
        } catch (err) {
          log.error('Failed to replay steering events', { lastEventId, error: err.message });
        }
      }

      // Subscribe to operator:action events
      let closed = false;
      const handler = (data) => {
        if (closed) return;

        // Apply filters
        if (actionTypeFilter && data.actionType !== actionTypeFilter && data.action !== actionTypeFilter) return;
        if (correlationIdFilter) {
          const matchesCorrelation =
            data.correlationId === correlationIdFilter ||
            data.dispatchId === correlationIdFilter ||
            data.traceId === correlationIdFilter ||
            data.campaignId === correlationIdFilter;
          if (!matchesCorrelation) return;
        }

        const eventId = data.eventTs || data.timestamp || new Date().toISOString();
        const eventData = {
          id: data.id || data.idempotencyKey,
          actionType: data.actionType || data.action,
          operatorId: data.operatorId,
          status: data.status,
          correlationId: data.correlationId || data.dispatchId || data.traceId || data.campaignId,
          campaignId: data.campaignId,
          dispatchId: data.dispatchId,
          traceId: data.traceId,
          agentId: data.agentId,
          provider: data.provider,
          sourceDispatchId: data.sourceDispatchId,
          targetDispatchId: data.targetDispatchId,
          targetParams: data.targetParams,
          data: data.data,
          timestamp: eventId,
        };

        try {
          res.write(`id: ${eventId}\nevent: steering:action\ndata: ${JSON.stringify(eventData)}\n\n`);
        } catch { /* connection already closed */ }
      };

      events.on('operator:action', handler);

      // Keepalive comment every 15s to prevent connection timeout
      const keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          res.write(': keepalive\n\n');
        } catch { /* connection already closed */ }
      }, 15000);

      // Cleanup all subscriptions and timer on disconnect
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepaliveTimer);
        events.off('operator:action', handler);
      };
      req.on('close', cleanup);

      return true;
    }

    // --- Agent Errors API ---
    const agentErrorsMatch = path.match(/^\/api\/agents\/([^/]+)\/errors$/);
    if (agentErrorsMatch && req.method === 'GET') {
      if (!errorRegistry) {
        json(res, { error: 'Error registry not available' }, 500);
        return true;
      }

      const agentId = decodeURIComponent(agentErrorsMatch[1]);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), 500);
      const offset = Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0);
      const categories = url.searchParams.get('categories')?.split(',') || [];

      const result = errorRegistry.getForAgent(agentId, {
        limit,
        offset,
        categories: categories.length > 0 ? categories : undefined,
      });

      const errors = result.errors.map(toPublicRegistryError);

      json(res, {
        agentId,
        errors,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
      return true;
    }

    // --- Agent Health Card API ---
    const agentHealthCardMatch = path.match(/^\/api\/agents\/([^/]+)\/health-card$/);
    if (agentHealthCardMatch && req.method === 'GET') {
      if (!errorRegistry) {
        json(res, { error: 'Error registry not available' }, 500);
        return true;
      }

      const agentId = decodeURIComponent(agentHealthCardMatch[1]);
      if (!agents[agentId]) {
        json(res, { error: `Agent "${agentId}" not found` }, 404);
        return true;
      }

      const agent = agents[agentId];
      const errorData = errorRegistry.getForAgent(agentId, { limit: 1 });
      const lastError = errorData.errors.length > 0 ? errorData.errors[0] : null;

      const cbStatus = circuitBreaker?.getStatus() || {};
      const providerCbStatus = cbStatus[agent.provider] || { state: 'closed', failures: 0, recoveryAt: null };
      const cooldownEntry = agentCooldowns?.get(agentId);
      const isCoolingDown = isAgentCoolingDown?.(agentId);

      const status = deriveAgentStatus({
        circuitBreakerState: providerCbStatus.state,
        agentUnavailable: agent._status === 'failed',
        hasPersistentError: lastError && PERSISTENT_CATEGORIES.has(lastError.category),
        isRateLimited: isCoolingDown,
        isHalfOpen: providerCbStatus.state === 'half-open',
      });

      const healthCard = {
        agentId,
        name: agent.name,
        status,
        lastError: lastError ? {
          id: lastError.id,
          category: lastError.category,
          message: lastError.message,
          suggestedFix: lastError.suggestedFix,
          timestamp: lastError.timestamp,
          isTransient: TRANSIENT_CATEGORIES.has(lastError.category),
        } : null,
        circuitBreaker: {
          state: providerCbStatus.state,
          failures: providerCbStatus.failures,
          recoveryAt: providerCbStatus.recoveryAt,
          cooldownRemainingMs: providerCbStatus.recoveryAt
            ? Math.max(0, new Date(providerCbStatus.recoveryAt).getTime() - Date.now())
            : null,
        },
        cooldown: isCoolingDown ? {
          until: cooldownEntry?.until ? new Date(cooldownEntry.until).toISOString() : null,
          remainMs: cooldownEntry?.until ? Math.max(0, cooldownEntry.until - Date.now()) : null,
          reason: cooldownEntry?.reason || null,
          confidence: cooldownEntry?.confidence || 'hard',
          source: cooldownEntry?.source || null,
        } : null,
      };

      json(res, healthCard);
      return true;
    }

    // --- Bulk Health Cards API ---
    if (path === '/api/health-cards' && req.method === 'GET') {
      if (!errorRegistry) {
        json(res, { error: 'Error registry not available' }, 500);
        return true;
      }

      const healthCards = {};
      const cbStatus = circuitBreaker?.getStatus() || {};

      // Build a map of agentId → { taskId, title, campaignId } for active assignments
      const agentCurrentTasks = new Map();
      if (taskManager) {
        try {
          const projectIds = stateManager ? stateManager.listProjects().map(p => p.id || p) : [];
          for (const projectId of projectIds) {
            try {
              const tasks = taskManager.listTasks(projectId);
              for (const task of tasks) {
                if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
                const activeSubtask = task.subtasks?.find(st => 
                  st.status === 'claimed' || st.status === 'executing'
                );
                if (activeSubtask && activeSubtask.assignee) {
                  agentCurrentTasks.set(activeSubtask.assignee, {
                    id: task.id,
                    title: task.title,
                    campaignId: task.campaignId || null,
                  });
                }
              }
            } catch (err) {
              log.warn('Failed to load tasks for project', { projectId, error: err.message });
            }
          }
        } catch (err) {
          log.warn('Failed to build agent task map', { error: err.message });
        }
      }

      for (const [agentId, agent] of Object.entries(agents)) {
        const errorData = errorRegistry.getForAgent(agentId, { limit: 1 });
        const lastError = errorData.errors.length > 0 ? errorData.errors[0] : null;

        const providerCbStatus = cbStatus[agent.provider] || { state: 'closed', failures: 0, recoveryAt: null };
        const isCoolingDown = isAgentCoolingDown?.(agentId);
        const cooldownEntry = agentCooldowns?.get(agentId);

        const status = deriveAgentStatus({
          circuitBreakerState: providerCbStatus.state,
          agentUnavailable: agent._status === 'failed',
          hasPersistentError: lastError && PERSISTENT_CATEGORIES.has(lastError.category),
          isRateLimited: isCoolingDown,
          isHalfOpen: providerCbStatus.state === 'half-open',
        });

        const currentTask = agentCurrentTasks.get(agentId) || null;

        healthCards[agentId] = {
          agentId,
          name: agent.name,
          role: agent.role || null,
          status,
          paused: agent.paused || false,
          currentTask: currentTask ? {
            id: currentTask.id,
            title: currentTask.title,
            campaignId: currentTask.campaignId,
          } : null,
          canCancel: !!currentTask,
          lastError: lastError ? {
            id: lastError.id,
            category: lastError.category,
            message: lastError.message,
            suggestedFix: lastError.suggestedFix,
            timestamp: lastError.timestamp,
            isTransient: TRANSIENT_CATEGORIES.has(lastError.category),
          } : null,
          circuitBreaker: {
            state: providerCbStatus.state,
            failures: providerCbStatus.failures,
            recoveryAt: providerCbStatus.recoveryAt,
            cooldownRemainingMs: providerCbStatus.recoveryAt
              ? Math.max(0, new Date(providerCbStatus.recoveryAt).getTime() - Date.now())
              : null,
          },
          cooldown: isCoolingDown ? {
            until: cooldownEntry?.until ? new Date(cooldownEntry.until).toISOString() : null,
            remainMs: cooldownEntry?.until ? Math.max(0, cooldownEntry.until - Date.now()) : null,
            reason: cooldownEntry?.reason || null,
          } : null,
        };
      }

      json(res, healthCards);
      return true;
    }

    // --- Error Stream SSE ---
    if (path === '/api/errors/stream' && req.method === 'GET') {
      if (!errorRegistry) {
        json(res, { error: 'Error registry not available' }, 500);
        return true;
      }

      // Parse query parameters
      const agentIdFilter = url.searchParams.get('agentId');
      const categoryFilter = url.searchParams.get('category');
      const lastEventId = url.searchParams.get('lastEventId');

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      });
      res.flushHeaders();

      // Disable timeouts for this long-lived connection
      res.setTimeout(0);
      req.socket.setTimeout(0);

      let closed = false;

      // Replay missed errors if lastEventId is provided
      if (lastEventId) {
        const allAgents = agentIdFilter ? [agentIdFilter] : [...errorRegistry.agentErrors.keys()];
        for (const aid of allAgents) {
          const errors = errorRegistry.getForAgent(aid, { limit: 1000 });
          let started = !lastEventId;
          for (const err of errors.errors) {
            if (started) {
              if (categoryFilter && err.category !== categoryFilter) continue;
              res.write(`id: ${err.id}\nevent: error\ndata: ${JSON.stringify(toPublicRegistryError(err))}\n\n`);
            } else if (err.id === lastEventId) {
              started = true;
            }
          }
        }
      }

      // Subscribe to error registry events
      const unsubscribe = errorRegistry.subscribe((error) => {
        if (closed) return;
        if (agentIdFilter && error.agentId !== agentIdFilter) return;
        if (categoryFilter && error.category !== categoryFilter) return;

        try {
          res.write(`id: ${error.id}\nevent: error\ndata: ${JSON.stringify(toPublicRegistryError(error))}\n\n`);
        } catch {
          // Connection already closed
        }
      });

      // Keepalive comment every 15s to prevent connection timeout
      const keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          res.write(': keepalive\n\n');
        } catch {
          // Connection already closed
        }
      }, 15000);

      // Cleanup on disconnect
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepaliveTimer);
        unsubscribe();
      };

      req.on('close', cleanup);
      req.on('error', cleanup);

      return true;
    }

    // --- Test-only Error Injection Endpoint ---
    if (path === '/api/test/inject-error' && req.method === 'POST') {
      if (process.env.NODE_ENV !== 'test') {
        json(res, { error: 'Test endpoint only available in test mode' }, 403);
        return true;
      }
      if (!errorRegistry) {
        json(res, { error: 'Error registry not available' }, 500);
        return true;
      }

      handleBody(req, res, body => {
        try {
          const errorData = JSON.parse(body);
          const recordedError = errorRegistry.record(errorData);
          json(res, { ok: true, error: recordedError }, 201);
        } catch (e) {
          respondApiError(res, e, { status: 400 });
        }
      });
      return true;
    }


    const campaignDispatchRationaleMatch = path.match(/^\/api\/campaigns\/([^/]+)\/dispatches\/([^/]+)\/rationale$/);
    if (campaignDispatchRationaleMatch && req.method === 'GET') {
      if (!dispatchLog) {
        json(res, { error: 'Dispatch log not available' }, 500);
        return true;
      }

      const campaignId = decodeURIComponent(campaignDispatchRationaleMatch[1]);
      const dispatchId = decodeURIComponent(campaignDispatchRationaleMatch[2]);

      if (!campaignId || campaignId.trim() === '' || !dispatchId || dispatchId.trim() === '') {
        json(res, { error: 'Invalid campaign ID or dispatch ID' }, 400);
        return true;
      }

      try {
        const record = dispatchLog.getById(dispatchId);

        if (!record) {
          json(res, { error: 'Dispatch record not found' }, 404);
          return true;
        }

        if (record.campaignId !== campaignId) {
          json(res, { error: 'Dispatch record does not belong to the specified campaign' }, 404);
          return true;
        }

        let rationale = null;

        // Prefer the public helper when available (production DispatchLog exposes getDispatchRationale)
        if (typeof dispatchLog.getDispatchRationale === 'function') {
          rationale = dispatchLog.getDispatchRationale(dispatchId, timelineStore);
        } else if (typeof dispatchLog._transformToRationale === 'function') {
          rationale = dispatchLog._transformToRationale(record, timelineStore);
        } else {
          // Minimal fallback for lightweight mocks
          rationale = {
            inputs: record.inputs ?? null,
            guardrailContext: record.guardrailContext ?? null,
            chosenRoute: record.chosenRoute ?? null,
            fallbacks: record.fallbacks ?? [],
          };
        }

        json(res, rationale);
      } catch (e) {
        log.error(`Failed to retrieve dispatch rationale for ${dispatchId}: ${e.message}`);
        json(res, { error: 'Internal server error' }, 500);
      }
      return true;
    }

    // --- Campaign routes ---
    const campaignsMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns$/);
    if (campaignsMatch && req.method === 'GET') {
      const projId = decodeURIComponent(campaignsMatch[1]);
      const campaigns = campaignManager.listCampaigns(projId, url.searchParams.get("status"));
      log.info("Campaigns API", { projectId: projId, statusFilter: url.searchParams.get("status"), count: campaigns.length });
      json(res, campaigns);
      return true;
    }
    const campaignDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)$/);
    if (campaignDetailMatch && req.method === 'GET') {
      const projId = decodeURIComponent(campaignDetailMatch[1]);
      const campId = decodeURIComponent(campaignDetailMatch[2]);
      let campaign = campaignManager.getCampaign(projId, campId);
      if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
      if (['completed', 'failed'].includes(campaign.status) && !campaign.closeoutSummary) {
        campaign.closeoutSummary = campaignManager.generateCloseoutSummary(projId, campId, taskManager, deps.learningsManager || null);
      }
      json(res, campaign, 200);
      return true;
    }
    if (campaignDetailMatch && req.method === 'DELETE') {
      try {
        const projId = decodeURIComponent(campaignDetailMatch[1]);
        const campId = decodeURIComponent(campaignDetailMatch[2]);
        if (snapshotManager) {
          try { snapshotManager.createSnapshot(projId, { reason: `pre-campaign-delete: ${campId}` }); } catch (e) { log.warn('Auto-snapshot before delete failed', { error: e.message }); }
        }
        const deleted = campaignManager.deleteCampaign(projId, campId);
        json(res, deleted ? { ok: true } : { error: 'Campaign not found' }, deleted ? 200 : 404);
      } catch (err) { respondApiError(res, err, { status: 400 }); }
      return true;
    }
    if (campaignsMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignsMatch[1]);
      handleBody(req, res, body => {
        try {
          const { title, description, doneCriteria, contingency, priority, type, outputMode, domain, campaignReferences, projectIds } = JSON.parse(body);
          if (!title) { json(res, { error: 'title required' }, 400); return; }
          // Work must run in an explicitly named, contained project. The
          // sealed `default` chat surface (no working dir, no allocation)
          // cannot host campaigns — the UI uses needsProject to prompt the
          // user to create one. This is the structural guard that prevents
          // the Iter4 control-plane self-destruct from ever recurring.
          if (!stateManager.isProjectWorkable(projId)) {
            json(res, {
              error: `"${projId}" is a chat surface, not a project. Create a named project to run work.`,
              code: 'PROJECT_NOT_WORKABLE',
              needsProject: true,
            }, 409);
            return;
          }
          if (type === 'socratic' && (!domain || typeof domain !== 'string' || domain.trim() === '')) {
            json(res, { error: 'domain required for socratic campaigns' }, 400);
            return;
          }
          if (campaignReferences !== undefined && !Array.isArray(campaignReferences)) {
            json(res, { error: 'campaignReferences must be an array' }, 400);
            return;
          }
          if (projectIds !== undefined && !Array.isArray(projectIds)) {
            json(res, { error: 'projectIds must be an array' }, 400);
            return;
          }
          const campaign = campaignManager.createCampaign(projId, { title, description, doneCriteria, contingency, priority, type, outputMode, domain, campaignReferences, projectIds });
          // Decomposition triggers automatically via campaign:created event
          // Path-less brief nudge (#110): briefs that mention files/dirs/docs
          // without naming a concrete path send agents tree-hunting (observed
          // in the 08-10 soak). Warn-don't-block, same idiom as the roster
          // orphan warning — the campaign is ACCEPTED either way.
          const briefText = `${description || ''} ${doneCriteria || ''}`;
          const mentionsFiles = /\b(file|folder|director(y|ies)|doc|report|script|module|readme|config)\b/i.test(briefText);
          const hasPathToken = /(^|[\s"'`(])(\.{0,2}\/)?[\w.-]+\/[\w./-]+|\b[\w-]+\.(md|js|ts|py|sh|json|ya?ml|txt|html|css)\b/.test(briefText);
          const briefWarnings = (mentionsFiles && !hasPathToken)
            ? ['Brief references files but names no concrete path — agents will spend turns locating targets. Consider naming exact paths (e.g. src/module.js, docs/report.md) in the description or done criteria.']
            : null;
          // Response-only decoration — never mutate the stored campaign object.
          json(res, briefWarnings ? { ...campaign, _warnings: briefWarnings } : campaign, 201);
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }
    const campaignQuestionsMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/questions$/);
    if (campaignQuestionsMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignQuestionsMatch[1]);
      const campId = decodeURIComponent(campaignQuestionsMatch[2]);
      handleBody(req, res, body => {
        try {
          const payload = JSON.parse(body);
          if (!payload || !Array.isArray(payload.questions)) {
            json(res, { error: 'request body must contain "questions" array' }, 400);
            return;
          }
          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) {
            json(res, { error: 'Campaign not found' }, 404);
            return;
          }
          if (campaign.type !== 'socratic') {
            json(res, { error: `Cannot add questions to non-socratic campaign (type: ${campaign.type})` }, 400);
            return;
          }
          const result = campaignManager.setQuestions(projId, campId, payload.questions);
          if (result.errors && result.errors.length > 0) {
            json(res, { error: 'Question validation failed', details: result.errors }, 400);
            return;
          }
          json(res, { ok: true, questionCount: result.campaign.questionCount, campaign: result.campaign }, 200);
        } catch (err) {
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
    }
    const campaignInjectMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/inject$/);
    if (campaignInjectMatch && req.method === 'POST') {
      handleBody(req, res, body => {
        try {
          const { idea } = JSON.parse(body);
          if (!idea) { json(res, { error: 'idea required' }, 400); return; }
          strategistInject(decodeURIComponent(campaignInjectMatch[1]), decodeURIComponent(campaignInjectMatch[2]), idea)
            .catch(err => log.error('campaign inject failed', { error: err.message }));
          json(res, { ok: true, status: 'evaluating' }, 202);
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }
    // ─── POST /api/projects/:id/campaigns/:id/approve-cycle ─────
    const campaignApproveCycleMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/approve-cycle$/);
    if (campaignApproveCycleMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignApproveCycleMatch[1]);
      const campId = decodeURIComponent(campaignApproveCycleMatch[2]);
      if (!requireOperatorRole('campaign_approve_cycle', { projectId: projId, campaignId: campId })) return true;
      try {
        campaignManager.approveCycle(projId, campId);
        json(res, { ok: true, status: 'approved — next strategistTick will resume' });
      } catch (err) { respondApiError(res, err, { status: 400 }); }
      return true;
    }

    // ─── BYOH PR Workflow API (Phase 1) ───────────────────────────────────
    // Plan: ~/.claude/plans/synapse-pr-workflow.md. Lifecycle hook + chat-
    // execute hook + UI come in subsequent phases; this is the surface that
    // future phases dispatch against.

    // GET /api/projects/:projectId/prs — list PRs (cheap, reads index.json)
    // Optional query: ?status=open OR ?status=open,changes-requested,approved
    const prsListMatch = path.match(/^\/api\/projects\/([^/]+)\/prs$/);
    if (prsListMatch && req.method === 'GET' && prStore) {
      const projId = decodeURIComponent(prsListMatch[1]);
      const statusFilter = reqUrl.searchParams.get('status');
      const filter = statusFilter ? { status: statusFilter.split(',') } : {};
      try {
        json(res, { prs: prStore.listPRs(projId, filter) });
      } catch (err) {
        respondApiError(res, err);
      }
      return true;
    }

    // GET /api/projects/:projectId/prs/:prId — single PR detail
    const prsDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/prs\/([^/]+)$/);
    if (prsDetailMatch && req.method === 'GET' && prStore) {
      const projId = decodeURIComponent(prsDetailMatch[1]);
      const prId = decodeURIComponent(prsDetailMatch[2]);
      const pr = prStore.getPR(projId, prId);
      if (!pr) { json(res, { error: 'PR not found' }, 404); return true; }
      json(res, pr);
      return true;
    }

    // POST /api/projects/:projectId/prs — open a new PR (operator OR system)
    // Body: { sourceBranch, targetBranch, author, authorRole, taskIds?, campaignId?, title?, description?, operatorPinned? }
    if (prsListMatch && req.method === 'POST' && prStore) {
      const projId = decodeURIComponent(prsListMatch[1]);
      handleBody(req, res, body => {
        try {
          const payload = body && body.trim() ? JSON.parse(body) : {};
          const repoCfg = stateManager?.getProjectRepoConfig?.(projId);
          const pr = prStore.openPR({
            projectId: projId,
            sourceBranch: payload.sourceBranch,
            targetBranch: payload.targetBranch || repoCfg?.defaultBranch || 'main',
            author: payload.author,
            authorRole: payload.authorRole,
            taskIds: payload.taskIds,
            campaignId: payload.campaignId,
            title: payload.title,
            description: payload.description,
            repoConfig: repoCfg,
            operatorPinned: payload.operatorPinned === true,
          });
          json(res, pr, 201);
        } catch (err) {
          respondApiError(res, err, { status: 400 });
        }
      }).catch(err => respondApiError(res, err));
      return true;
    }

    // POST /api/projects/:projectId/prs/:prId/review — add a review
    // Body: { reviewer, status, approvedSourceSha?, findings?, summary? }
    const prsReviewMatch = path.match(/^\/api\/projects\/([^/]+)\/prs\/([^/]+)\/review$/);
    if (prsReviewMatch && req.method === 'POST' && prStore) {
      const projId = decodeURIComponent(prsReviewMatch[1]);
      const prId = decodeURIComponent(prsReviewMatch[2]);
      handleBody(req, res, body => {
        try {
          const payload = body && body.trim() ? JSON.parse(body) : {};
          const updated = prStore.addReview(projId, prId, payload);
          json(res, updated);
        } catch (err) {
          respondApiError(res, err, { status: 400 });
        }
      }).catch(err => respondApiError(res, err));
      return true;
    }

    // POST /api/projects/:projectId/prs/:prId/merge — operator/external merge.
    //
    // R2 Change 6 (alice R1 catch): defensive re-evaluation of policy before
    // markMerged. The endpoint cannot just trust pr.status === 'approved' —
    // an external system calling here could be bypassing blockAutoMerge if
    // the only thing routing them to the endpoint was autoMergePolicy='external'.
    //
    // R2 Change 6 decision table (reviewer R2 explicit ask):
    //   - MERGE_REASONS_ALLOWED_WITHOUT_FORCE: this endpoint is the canonical
    //     exit path — operator/external merge proceeds without `force`.
    //   - MERGE_REASONS_REQUIRING_FORCE: an active safety gate is firing;
    //     endpoint refuses 403 unless body.force === true + operator role.
    //
    // R2 Change 7 (dan + alice R1 catch): record the calling identity in
    // pr.operatorActions via recordOperatorAction. Distinguishes ordinary
    // operator merges from force-merges in the audit trail.
    //
    // Body: { mergeCommit, currentSourceSha, force?, reason? }
    const prsMergeMatch = path.match(/^\/api\/projects\/([^/]+)\/prs\/([^/]+)\/merge$/);
    if (prsMergeMatch && req.method === 'POST' && prStore) {
      if (!requireOperatorRole('pr_merge', { action: 'pr_merge' })) return true;
      const projId = decodeURIComponent(prsMergeMatch[1]);
      const prId = decodeURIComponent(prsMergeMatch[2]);
      handleBody(req, res, body => {
        try {
          const payload = body && body.trim() ? JSON.parse(body) : {};
          const force = payload.force === true;

          // Defensive re-evaluation (R2 Change 6 — alice bypass-path catch)
          const pr = prStore.getPR(projId, prId);
          if (!pr) { json(res, { error: `PR ${prId} not found` }, 404); return; }
          const repoConfig = stateManager?.getProjectRepoConfig?.(projId) || {};
          // R3 Change: pass projectDir for the resolveAutoMergeBlock
          // path-containment check (computed default + stored override).
          const projectDir = stateManager?.getProject?.(projId)?.projectDir || null;
          const decision = evaluateMergePolicy(pr, repoConfig, projectDir);
          if (decision.action !== 'merge') {
            if (MERGE_REASONS_REQUIRING_FORCE.includes(decision.reason) && !force) {
              json(res, {
                error: `Merge refused: ${decision.reason}. ` +
                       `This reason requires explicit { "force": true } in the request body. ` +
                       `Operator review the active safety gate before forcing.`,
                reason: decision.reason,
              }, 403);
              return;
            }
            // Otherwise (allowed-without-force OR force-flag set): proceed.
            // The endpoint is the canonical exit for operator/external merges.
          }

          const updated = prStore.markMerged(projId, prId, {
            mergeCommit: payload.mergeCommit,
            currentSourceSha: payload.currentSourceSha,
          });

          // Audit trail (R2 Change 7 — dan + alice R1 ask)
          const operatorId = requestUserId || 'external-api';
          const userAgent = req.headers['user-agent'] || null;
          try {
            prStore.recordOperatorAction(projId, prId,
              force ? 'force-merge' : 'merge',
              { by: operatorId, note: userAgent });
          } catch (auditErr) {
            log.warn('Merge audit write failed (non-blocking)', { prId, error: auditErr.message });
          }

          json(res, updated);
        } catch (err) {
          // 409 for SHA mismatch (approval-integrity invariant from Codex R2)
          const status = /approved SHA/.test(err.message) ? 409 : 400;
          respondApiError(res, err, { status });
        }
      }).catch(err => respondApiError(res, err));
      return true;
    }

    // POST /api/projects/:projectId/prs/:prId/close — close without merging
    const prsCloseMatch = path.match(/^\/api\/projects\/([^/]+)\/prs\/([^/]+)\/close$/);
    if (prsCloseMatch && req.method === 'POST' && prStore) {
      if (!requireOperatorRole('pr_close', { action: 'pr_close' })) return true;
      const projId = decodeURIComponent(prsCloseMatch[1]);
      const prId = decodeURIComponent(prsCloseMatch[2]);
      handleBody(req, res, body => {
        try {
          const payload = body && body.trim() ? JSON.parse(body) : {};
          const updated = prStore.closePR(projId, prId, { reason: payload.reason });
          json(res, updated);
        } catch (err) {
          respondApiError(res, err, { status: 400 });
        }
      }).catch(err => respondApiError(res, err));
      return true;
    }

    // ─── End BYOH PR Workflow API (Phase 1) ──────────────────────────────

    // ─── POST /api/projects/:id/campaigns/:id/merge (Phase 6) ─────
    const campaignMergeMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/merge$/);
    if (campaignMergeMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignMergeMatch[1]);
      const campId = decodeURIComponent(campaignMergeMatch[2]);
      if (!requireOperatorRole('campaign_merge', { projectId: projId, campaignId: campId })) return true;
      try {
        const campaign = campaignManager.getCampaign(projId, campId);
        if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
        if (!campaign.branch) { json(res, { error: 'Campaign has no branch to merge' }, 400); return true; }
        const projectDir = stateManager.getProject(projId)?.projectDir;
        if (!projectDir) { json(res, { error: 'Project directory not found' }, 400); return true; }
        const repoConfig = stateManager.getProjectRepoConfig?.(projId);
        const result = mergeCampaignBranch(projectDir, campId, campaign.title, repoConfig);
        if (!result.success) { json(res, { error: result.error }, 400); return true; }
        campaignManager.updateCampaignStatus(projId, campId, 'completed', 'Merged via approval gate');
        json(res, { ok: true, merged: true, branch: campaign.branch });
      } catch (err) { respondApiError(res, err, { status: 400 }); }
      return true;
    }

    // ─── POST /api/projects/:id/campaigns/:id/complete ─────
    const campaignCompleteMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/complete$/);
    if (campaignCompleteMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignCompleteMatch[1]);
      const campId = decodeURIComponent(campaignCompleteMatch[2]);
      if (!requireOperatorRole('campaign_complete', { projectId: projId, campaignId: campId })) return true;
      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return; }
          campaignManager.updateCampaignStatus(projId, campId, 'completed', payload.reason || 'Completed via operator', requestUserId || null, taskManager);
          json(res, { ok: true, status: 'completed', reason: payload.reason || 'Completed' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }

    // ─── POST /api/projects/:id/campaigns/:id/reject (Phase 6) ─────
    const campaignRejectMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/reject$/);
    if (campaignRejectMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignRejectMatch[1]);
      const campId = decodeURIComponent(campaignRejectMatch[2]);
      if (!requireOperatorRole('campaign_reject', { projectId: projId, campaignId: campId })) return true;
      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return; }
          // Pass taskManager so non-terminal child tasks are cascade-cancelled (queued+planning).
          // Executing tasks are left to finish naturally and preserve their output.
          campaignManager.updateCampaignStatus(projId, campId, 'failed', payload.reason || 'Rejected via approval gate', requestUserId || null, taskManager);
          json(res, { ok: true, status: 'failed', reason: payload.reason || 'Rejected' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }

    // ─── POST /api/projects/:id/campaigns/:id/rollback (Phase 6) ─────
    const campaignRollbackMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/rollback$/);
    if (campaignRollbackMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignRollbackMatch[1]);
      const campId = decodeURIComponent(campaignRollbackMatch[2]);
      if (!requireOperatorRole('campaign_rollback', { projectId: projId, campaignId: campId })) return true;
      try {
        const projectDir = stateManager.getProject(projId)?.projectDir;
        if (!projectDir) { json(res, { error: 'Project directory not found' }, 400); return true; }
        const result = rollbackLastMerge(projectDir);
        if (!result.success) { json(res, { error: result.error }, 400); return true; }
        campaignManager.updateCampaignStatus(projId, campId, 'failed', 'Rolled back via API', requestUserId || null, taskManager);
        json(res, { ok: true, rolledBack: true });
      } catch (err) { respondApiError(res, err, { status: 400 }); }
      return true;
    }

    // ─── PATCH /api/projects/:id/campaigns/:id/priority ─────
    const campaignPriorityMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/priority$/);
    if (campaignPriorityMatch && req.method === 'PATCH') {
      const projId = decodeURIComponent(campaignPriorityMatch[1]);
      const campId = decodeURIComponent(campaignPriorityMatch[2]);
      if (!requireOperatorRole('campaign_priority', { projectId: projId, campaignId: campId })) return true;
      handleBody(req, res, body => {
        try {
          const { priority } = JSON.parse(body);
          const VALID_PRIORITIES = ['critical', 'high', 'elevated', 'normal', null];
          if (!VALID_PRIORITIES.includes(priority)) {
            json(res, { error: `Invalid priority "${priority}". Must be one of: ${VALID_PRIORITIES.filter(p => p !== null).join(', ')}, or null.` }, 400);
            return;
          }
          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return; }
          campaignManager.patchCampaign(projId, campId, { priority: priority || 'normal' });
          log.info('Campaign priority updated', { projectId: projId, campaignId: campId, priority, operator: requestUserId });
          json(res, { ok: true, campaignId: campId, priority: priority || 'normal' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }

    // ─── PATCH /api/projects/:id/campaigns/:id/milestones/:mid/priority ─────
    const milestonePriorityMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/milestones\/([^/]+)\/priority$/);
    if (milestonePriorityMatch && req.method === 'PATCH') {
      const projId = decodeURIComponent(milestonePriorityMatch[1]);
      const campId = decodeURIComponent(milestonePriorityMatch[2]);
      const msId = decodeURIComponent(milestonePriorityMatch[3]);
      if (!requireOperatorRole('campaign_priority', { projectId: projId, campaignId: campId, milestoneId: msId })) return true;
      handleBody(req, res, body => {
        try {
          const { priority } = JSON.parse(body);
          const VALID_PRIORITIES = ['critical', 'high', 'elevated', 'normal', null];
          if (!VALID_PRIORITIES.includes(priority)) {
            json(res, { error: `Invalid priority "${priority}". Must be one of: ${VALID_PRIORITIES.filter(p => p !== null).join(', ')}, or null.` }, 400);
            return;
          }
          campaignManager.setMilestonePriority(projId, campId, msId, priority);
          log.info('Milestone priority updated', { projectId: projId, campaignId: campId, milestoneId: msId, priority, operator: requestUserId });
          json(res, { ok: true, campaignId: campId, milestoneId: msId, priority });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }

    const campaignPauseMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/pause$/);
    if (campaignPauseMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignPauseMatch[1]);
      const campId = decodeURIComponent(campaignPauseMatch[2]);
      if (!requireOperatorRole('campaign_pause', { projectId: projId, campaignId: campId })) return true;

      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) {
            operatorAuditStore.append({
              action: 'campaign_pause',
              projectId: projId,
              campaignId: campId,
              operatorId,
              status: 'failure',
              decision: 'deny',
              source,
              reason: 'Campaign not found',
              correlationId,
              dispatchId,
              traceId,
            });
            json(res, { error: 'Campaign not found' }, 404);
            return;
          }
          if (snapshotManager && campaign) {
            try { snapshotManager.createSnapshot(projId, { reason: `pre-campaign-transition: ${campaign.status}→paused` }); } catch (e) { log.warn('Auto-snapshot before pause failed', { error: e.message }); }
          }
          campaignManager.updateCampaignStatus(projId, campId, 'paused', auditReason || 'Paused via API');
          operatorAuditStore.append({
            action: 'campaign_pause',
            projectId: projId,
            campaignId: campId,
            operatorId,
            status: 'success',
            decision: 'allow',
            source,
            reason: auditReason,
            correlationId,
            dispatchId,
            traceId,
          });
          json(res, { ok: true, status: 'paused' });
        } catch (err) {
          log.error('Campaign pause failed', { projectId: projId, campaignId: campId, error: err.message });
          operatorAuditStore.append({
            action: 'campaign_pause',
            projectId: projId,
            campaignId: campId,
            operatorId: requestUserId || 'system',
            status: 'failure',
            decision: 'deny',
            details: err.message,
          });
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
    }
    // Operator ack of a recovery-scan 'needs_review' flag (campaign-recovery.js).
    const recoveryAckMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/recovery-status$/);
    if (recoveryAckMatch && req.method === 'DELETE') {
      const projId = decodeURIComponent(recoveryAckMatch[1]);
      const campId = decodeURIComponent(recoveryAckMatch[2]);
      if (!requireOperatorRole('campaign_recovery_ack', { projectId: projId, campaignId: campId })) return true;
      try {
        const campaign = campaignManager.getCampaign(projId, campId);
        if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
        campaignManager.clearRecoveryStatus(projId, campId);
        operatorAuditStore.append({
          action: 'campaign_recovery_ack',
          projectId: projId,
          campaignId: campId,
          operatorId: requestUserId || 'system',
          status: 'success',
          decision: 'allow',
          details: `Cleared recoveryStatus '${campaign.recoveryStatus || 'none'}'`,
        });
        json(res, { ok: true });
      } catch (err) {
        respondApiError(res, err, { status: 400 });
      }
      return true;
    }

    const campaignResumeMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/resume$/);
    if (campaignResumeMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignResumeMatch[1]);
      const campId = decodeURIComponent(campaignResumeMatch[2]);
      if (!requireOperatorRole('campaign_resume', { projectId: projId, campaignId: campId })) return true;

      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) {
            json(res, { error: 'Campaign not found' }, 404);
            return;
          }
          if (snapshotManager && campaign) {
            try { snapshotManager.createSnapshot(projId, { reason: `pre-campaign-transition: ${campaign.status}→active` }); } catch (e) { log.warn('Auto-snapshot before resume failed', { error: e.message }); }
          }
          campaignManager.updateCampaignStatus(projId, campId, 'active', auditReason || 'Resumed via API');
          // An operator resume is the review decision — clear the recovery
          // flag set by campaign-recovery.js, else "needs review" sticks forever.
          if (campaign.recoveryStatus) {
            try { campaignManager.clearRecoveryStatus(projId, campId); } catch (e) { log.warn('Failed to clear recoveryStatus on resume', { error: e.message }); }
          }
          strategistEvaluate(projId, campId).catch(err => log.error('Strategist evaluation failed after API resume', { projectId: projId, campaignId: campId, error: err.message }));
          operatorAuditStore.append({
            action: 'campaign_resume',
            projectId: projId,
            campaignId: campId,
            operatorId,
            status: 'success',
            decision: 'allow',
            source,
            reason: auditReason,
            correlationId,
            dispatchId,
            traceId,
          });
          json(res, { ok: true, status: 'active' });
        } catch (err) {
          log.error('Campaign resume failed', { projectId: projId, campaignId: campId, error: err.message });
          operatorAuditStore.append({
            action: 'campaign_resume',
            projectId: projId,
            campaignId: campId,
            operatorId: requestUserId || 'system',
            status: 'failure',
            decision: 'deny',
            details: err.message,
          });
          respondApiError(res, err, { status: 400 });
        }
      });
      return true;
    }
    const campaignRerouteMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/reroute$/);
    if (campaignRerouteMatch && req.method === 'POST') {
      const projId = decodeURIComponent(campaignRerouteMatch[1]);
      const campId = decodeURIComponent(campaignRerouteMatch[2]);
      if (!requireOperatorRole('dispatch_reroute', { projectId: projId, campaignId: campId })) return true;
      handleBody(req, res, async body => {
        let temporaryConstraintId = null;
        let taskId = 'unknown';
        let targetAgent = null;
        let originalAgent = null;
        let newAgent = null;
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const { taskId: rawTaskId, targetAgent: rawTargetAgent } = payload;
          taskId = typeof rawTaskId === 'string' ? rawTaskId.trim() : '';
          targetAgent = typeof rawTargetAgent === 'string' && rawTargetAgent.trim()
            ? rawTargetAgent.trim().toLowerCase()
            : null;

          if (!taskId) {
            json(res, { error: 'taskId required' }, 400);
            return;
          }

          // Check if core dispatcher components are available, otherwise record intent
          if (typeof handleUserMessage !== 'function' || typeof queueTurn !== 'function' || !campaignManager) {
            const operatorId = requestUserId || 'system';
            const intent = recordIntent('dispatch_reroute', {
              projectId: projId,
              campaignId: campId,
              taskId,
              targetAgent,
              operatorId,
              source,
              reason: auditReason,
              correlationId,
              dispatchId,
              traceId,
            });
            json(res, { ok: true, mock: true, intentId: intent.id, message: 'Dispatcher unavailable, reroute intent recorded.' }, 202);
            return;
          }

          if (!campaignManager || !taskManager) {
            json(res, { error: 'Campaign/task manager not available' }, 500);
            return;
          }
          if (!config?.router?.enabled) {
            json(res, { error: 'Router is disabled' }, 503);
            return;
          }

          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) {
            json(res, { error: 'Campaign not found' }, 404);
            return;
          }

          const task = taskManager.getTask(projId, taskId);
          if (!task) {
            json(res, { error: 'Task not found' }, 404);
            return;
          }
          if (task.campaignId !== campId) {
            json(res, { error: 'Task does not belong to campaign' }, 404);
            return;
          }

          if (targetAgent && !agents[targetAgent]) {
            json(res, { error: `Unknown targetAgent: ${targetAgent}` }, 400);
            return;
          }

          const activeSubtask = task.subtasks?.find(st => ['claimed', 'executing'].includes(st.status) && st.assignee);
          const latestAssignedSubtask = !activeSubtask
            ? [...(task.subtasks || [])]
              .filter(st => st.assignee)
              .sort((a, b) => new Date(b.updatedAt || b.startedAt || 0).getTime() - new Date(a.updatedAt || a.startedAt || 0).getTime())[0]
            : null;
          originalAgent = activeSubtask?.assignee || latestAssignedSubtask?.assignee || null;

          if (targetAgent && originalAgent && targetAgent === originalAgent) {
            json(res, { error: 'targetAgent must differ from original agent' }, 400);
            return;
          }

          const channelId = task.channel || campaign.channel || 'general';
          const reroutePrompt = targetAgent
            ? `@${targetAgent} take over rerouted task ${task.id}: ${task.title}\n\nDescription: ${task.description || task.title}\n${task.context ? `\nContext: ${task.context}` : ''}\n${task.doneCriteria ? `\nDone criteria: ${task.doneCriteria}` : ''}`
            : `[Operator reroute] Re-dispatch task ${task.id}: ${task.title}\n\nDescription: ${task.description || task.title}\n${task.context ? `\nContext: ${task.context}` : ''}\n${task.doneCriteria ? `\nDone criteria: ${task.doneCriteria}` : ''}\n\nSelect the best available non-excluded agent and continue execution.`;

          const threadMessages = task.threadId
            ? (stateManager.getThreadMessages(projId, channelId, task.threadId, 1) || [])
            : [];
          const replyTo = threadMessages.length > 0 ? threadMessages[threadMessages.length - 1].id : null;

          const rerouteStartedAt = new Date().toISOString();
          const operatorId = requestUserId || 'system';

          if (!targetAgent && originalAgent && typeof campaignManager.addConstraint === 'function' && typeof campaignManager.removeConstraint === 'function') {
            const temporaryConstraint = await campaignManager.addConstraint(
              projId,
              campId,
              {
                type: 'exclude_agents',
                value: [originalAgent],
                reason: auditReason || `Temporary reroute exclusion for task ${taskId}`,
              },
              operatorId,
              agents,
            );
            temporaryConstraintId = temporaryConstraint?.id || null;
          }

          await queueTurn(projId, channelId, operatorId, () =>
            handleUserMessage(
              reroutePrompt,
              projId,
              channelId,
              { replyTo, mode: null },
              'System',
              operatorId,
            )
          );

          let dispatch = null;
          if (dispatchLog?.query) {
            const decisions = dispatchLog.query({ campaignId: campId, limit: 25 })?.decisions || [];
            dispatch = decisions.find(d => d.timestamp >= rerouteStartedAt) || null;
          }

          newAgent = dispatch?.selectedAgent || targetAgent || null;
          broadcast({
            type: 'task_rerouted',
            timestamp: new Date().toISOString(),
            projectId: projId,
            campaignId: campId,
            taskId,
            originalAgent,
            targetAgent,
            selectedAgent: newAgent,
            dispatchId: dispatch?.id || null,
            traceId: dispatch?.traceId || null,
          });

          json(res, {
            ok: true,
            projectId: projId,
            campaignId: campId,
            taskId,
            originalAgent,
            targetAgent,
            selectedAgent: newAgent,
            dispatch,
          }, 200);

          operatorAuditStore.append({
            action: 'dispatch_reroute',
            projectId: projId,
            campaignId: campId,
            taskId,
            originalAgent,
            selectedAgent: newAgent,
            dispatchId: dispatch?.id || null,
            operatorId: requestUserId || 'system',
            status: 'success',
            decision: 'allow',
            details: `Task ${taskId} rerouted from ${originalAgent || 'N/A'} to ${newAgent || 'N/A'}`,
            source,
            reason: auditReason,
            correlationId,
            traceId,
          });
        } catch (err) {
          log.error('Campaign reroute failed', { projectId: projId, campaignId: campId, error: err.message });
          operatorAuditStore.append({
            action: 'dispatch_reroute',
            projectId: projId,
            campaignId: campId,
            taskId: taskId || 'unknown',
            operatorId: requestUserId || 'system',
            status: 'failure',
            decision: 'deny',
            details: err.message,
          });
          respondApiError(res, err, { status: 400 });
        } finally {
          if (temporaryConstraintId) {
            try {
              campaignManager.removeConstraint(projId, campId, temporaryConstraintId, requestUserId || 'system');
            } catch (cleanupErr) {
              log.warn('Failed to remove temporary reroute constraint', {
                projectId: projId,
                campaignId: campId,
                constraintId: temporaryConstraintId,
                error: cleanupErr.message,
              });
            }
          }
        }
      });
      return true;
    }

    // ─── Steer Override: POST /api/projects/:id/dispatches/:dispatchId/steer ───
    // Re-dispatch to a specific agent or provider, linked to the original dispatch.
    const steerOverrideMatch = path.match(/^\/api\/projects\/([^/]+)\/dispatches\/([^/]+)\/steer$/);
    if (steerOverrideMatch && req.method === 'POST') {
      if (!requireOperatorRole('dispatch_steer')) return true;
      const projId = decodeURIComponent(steerOverrideMatch[1]);
      const dispatchId = decodeURIComponent(steerOverrideMatch[2]);
      handleBody(req, res, async body => {
        let temporaryConstraintId = null;
        let campaignIdForCleanup = null;
        try {
          const parsed = (body && body.trim()) ? JSON.parse(body) : {};
          const targetAgent = typeof parsed.targetAgent === 'string' && parsed.targetAgent.trim()
            ? parsed.targetAgent.trim().toLowerCase()
            : null;
          const targetProvider = typeof parsed.targetProvider === 'string' && parsed.targetProvider.trim()
            ? parsed.targetProvider.trim().toLowerCase()
            : null;

          if (!targetAgent && !targetProvider) {
            json(res, { error: 'targetAgent or targetProvider required' }, 400);
            return;
          }

          // Check if core dispatcher components are available
          if (typeof handleUserMessage !== 'function' || typeof queueTurn !== 'function') {
            const operatorId = requestUserId || 'system';
            const intent = recordIntent('dispatch_steer', {
              projectId: projId,
              dispatchId,
              targetAgent,
              targetProvider,
              operatorId,
            });
            json(res, { ok: true, mock: true, intentId: intent.id, message: 'Dispatcher unavailable, steer intent recorded.' }, 202);
            return;
          }

          if (!config?.router?.enabled) {
            json(res, { error: 'Router is disabled' }, 503);
            return;
          }

          // Load original dispatch
          if (!dispatchLog?.getById) {
            json(res, { error: 'Dispatch log not available' }, 500);
            return;
          }
          const originalDispatch = dispatchLog.getById(dispatchId);
          if (!originalDispatch) {
            json(res, { error: 'Dispatch not found' }, 404);
            return;
          }

          // Validate target agent/provider against the original dispatch's task category
          const steerValidation = validateSteerTarget({
            targetAgent,
            targetProvider,
            taskCategory: originalDispatch.taskCategory || null,
            agentMap: agents,
            originalAgent: originalDispatch.selectedAgent || null,
          });
          if (!steerValidation.valid) {
            json(res, { error: steerValidation.error }, 400);
            return;
          }

          // Reconstruct prompt from original dispatch inputs
          const originalInputs = originalDispatch.inputs || '';
          const steerPrompt = targetAgent
            ? `@${targetAgent} [Operator steer override from dispatch ${dispatchId}] ${originalInputs}`
            : `[Operator steer override from dispatch ${dispatchId}] ${originalInputs}`;

          // Resolve channel from campaign or default
          const campId = originalDispatch.campaignId || null;
          let channelId = 'general';
          if (campId && campaignManager) {
            const campaign = campaignManager.getCampaign(projId, campId);
            if (campaign?.channel) channelId = campaign.channel;
          }

          const steerStartedAt = new Date().toISOString();
          const operatorId = requestUserId || 'system';

          // If targetProvider specified (not targetAgent), add a temporary require_provider constraint
          if (targetProvider && !targetAgent && campId && campaignManager
              && typeof campaignManager.addConstraint === 'function'
              && typeof campaignManager.removeConstraint === 'function') {
            campaignIdForCleanup = campId;
            const temporaryConstraint = await campaignManager.addConstraint(
              projId,
              campId,
              {
                type: 'require_provider',
                value: targetProvider,
                reason: `Temporary steer override to provider ${targetProvider} for dispatch ${dispatchId}`,
              },
              operatorId,
              agents,
            );
            temporaryConstraintId = temporaryConstraint?.id || null;
          }

          // Dispatch with steering metadata
          await queueTurn(projId, channelId, operatorId, () =>
            handleUserMessage(
              steerPrompt,
              projId,
              channelId,
              {
                replyTo: null,
                mode: null,
                steer: {
                  parentDispatchId: dispatchId,
                  operatorId,
                  targetAgent: targetAgent || null,
                  targetProvider: targetProvider || null,
                },
              },
              'System',
              operatorId,
            )
          );

          // Find the new dispatch created by the steer
          let newDispatch = null;
          if (dispatchLog?.query) {
            const filter = campId ? { campaignId: campId, limit: 25 } : { limit: 25 };
            const decisions = dispatchLog.query(filter)?.decisions || [];
            newDispatch = decisions.find(d => d.timestamp >= steerStartedAt) || null;
          }

          const newAgent = newDispatch?.selectedAgent || targetAgent || null;

          broadcast({
            type: 'dispatch_steered',
            timestamp: new Date().toISOString(),
            projectId: projId,
            parentDispatchId: dispatchId,
            originalAgent: originalDispatch.selectedAgent,
            targetAgent,
            targetProvider,
            selectedAgent: newAgent,
            newDispatchId: newDispatch?.id || null,
            traceId: newDispatch?.traceId || null,
          });

          json(res, {
            ok: true,
            projectId: projId,
            parentDispatchId: dispatchId,
            originalAgent: originalDispatch.selectedAgent,
            targetAgent,
            targetProvider,
            selectedAgent: newAgent,
            newDispatch,
          }, 200);

          operatorAuditStore.append({
            action: 'dispatch_steer',
            projectId: projId,
            campaignId: campId,
            parentDispatchId: dispatchId,
            originalAgent: originalDispatch.selectedAgent,
            targetAgent,
            targetProvider,
            selectedAgent: newAgent,
            newDispatchId: newDispatch?.id || null,
            operatorId,
            status: 'success',
            decision: 'allow',
            details: `Dispatch ${dispatchId} steered from ${originalDispatch.selectedAgent || 'N/A'} to ${newAgent || 'N/A'}`,
          });
        } catch (err) {
          log.error('Dispatch steer failed', { projectId: projId, dispatchId, error: err.message });
          operatorAuditStore.append({
            action: 'dispatch_steer',
            projectId: projId,
            dispatchId,
            operatorId: requestUserId || 'system',
            status: 'failure',
            decision: 'deny',
            details: err.message,
          });
          respondApiError(res, err, { status: 400 });
        } finally {
          if (temporaryConstraintId && campaignIdForCleanup && campaignManager) {
            try {
              campaignManager.removeConstraint(projId, campaignIdForCleanup, temporaryConstraintId, requestUserId || 'system');
            } catch (cleanupErr) {
              log.warn('Failed to remove temporary steer constraint', {
                projectId: projId,
                campaignId: campaignIdForCleanup,
                constraintId: temporaryConstraintId,
                error: cleanupErr.message,
              });
            }
          }
        }
      });
      return true;
    }

    // Campaign decompose — manual trigger
     // ─── POST /api/projects/:id/campaigns/:id/milestones ─────────
     const campaignMilestonesMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/milestones$/);
     if (campaignMilestonesMatch && req.method === 'POST') {
       if (!requireOperatorRole()) return true;
       const [projId, campId] = [decodeURIComponent(campaignMilestonesMatch[1]), decodeURIComponent(campaignMilestonesMatch[2])];
       const campaign = campaignManager.getCampaign(projId, campId);
       if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
       handleBody(req, res, body => {
         try {
           const { title, description, doneCriteria, contingency, blockedBy, order, requireApproval } = JSON.parse(body);
           if (!title) { json(res, { error: 'title required' }, 400); return; }
           const milestone = campaignManager.addMilestone(projId, campId,
             { title, description, doneCriteria, contingency, blockedBy: blockedBy || [], order, requireApproval },
             requestUserId || 'system');
           json(res, milestone, 201);
         } catch (err) { respondApiError(res, err, { status: 400 }); }
       });
       return true;
     }

     // ─── POST /api/approve ───
      // Simplified approve endpoint that mirrors CLI /approve command functionality
      // Accepts JSON body: { milestoneId, projectId?, reason }
      if (path === '/api/approve' && req.method === 'POST') {
        if (!requireOperatorRole('milestone_approve', { action: 'milestone_approve' })) return true;
        handleBody(req, res, body => {
          try {
            const parsed = JSON.parse(body);
            const { milestoneId, projectId: specifiedProjectId, reason } = parsed;

            if (!milestoneId) {
              json(res, { error: 'milestoneId is required' }, 400);
              return;
            }

            const targetProjectId = specifiedProjectId || null;
            const operatorId = requestUserId || 'system';

            let foundCampaign = null;
            let foundMilestone = null;
            let foundProjectId = null;

            if (targetProjectId) {
              const campaigns = campaignManager.listCampaigns(targetProjectId);
              for (const campaign of campaigns) {
                const milestone = campaign.milestones.find(m => m.id === milestoneId || m.id.includes(milestoneId));
                if (milestone) {
                  foundCampaign = campaign;
                  foundMilestone = milestone;
                  foundProjectId = targetProjectId;
                  break;
                }
              }
            }

            if (!foundCampaign) {
              const allProjects = stateManager.listProjects();
              for (const proj of allProjects) {
                const campaigns = campaignManager.listCampaigns(proj.id);
                for (const campaign of campaigns) {
                  const milestone = campaign.milestones.find(m => m.id === milestoneId || m.id.includes(milestoneId));
                  if (milestone) {
                    foundCampaign = campaign;
                    foundMilestone = milestone;
                    foundProjectId = proj.id;
                    break;
                  }
                }
                if (foundCampaign) break;
              }
            }

            if (!foundCampaign || !foundMilestone) {
              json(res, { error: `Milestone ${milestoneId} not found` }, 404);
              return;
            }

            if (foundMilestone.status !== 'waiting_approval') {
              json(res, { error: `Milestone ${milestoneId} is not waiting for approval (current status: ${foundMilestone.status})` }, 400);
              return;
            }

            const approvalReason = reason || `Approved via API by ${operatorId}`;
            campaignManager.approveMilestone(foundProjectId, foundCampaign.id, milestoneId, approvalReason, operatorId);

            operatorAuditStore.append({
              projectId: foundProjectId,
              campaignId: foundCampaign.id,
              milestoneId: milestoneId,
              timestamp: new Date().toISOString(),
              actorId: operatorId,
              actionType: 'milestone_approve',
              target: milestoneId,
              correlationId: foundCampaign.id,
              reason: approvalReason,
              source: 'rest',
              status: 'success',
              beforeState: { status: 'waiting_approval', approvalState: foundMilestone.approvalState },
              afterState: { status: 'waiting_approval', approvalState: 'approved', approverId: operatorId },
            });

            // Log to approval audit trail
            if (approvalAuditTrail) {
              approvalAuditTrail.logApproval({
                milestoneId: milestoneId,
                projectId: foundProjectId,
                campaignId: foundCampaign.id,
                operatorId: operatorId,
                reason: approvalReason,
                source: 'rest',
                webhookProvider: null,
                deliveryId: null,
                signatureValidated: false,
                signatureError: null,
                webhookData: {},
              });
            }

            strategistEvaluate(foundProjectId, foundCampaign.id).catch(err =>
              log.error('Strategist evaluation failed after /api/approve', { projectId: foundProjectId, milestoneId, campaignId: foundCampaign.id, error: err.message })
            );

            const updatedMilestone = foundCampaign.milestones.find(m => m.id === milestoneId);
            json(res, { ok: true, milestone: updatedMilestone, projectId: foundProjectId, campaignId: foundCampaign.id });
          } catch (err) {
            if (err.message === 'Invalid JSON') {
              json(res, { error: 'Invalid JSON in request body' }, 400);
            } else {
              log.error('Milestone approval failed', { milestoneId, error: err.message });
              operatorAuditStore.append({
                projectId: specifiedProjectId || null,
                milestoneId: milestoneId,
                timestamp: new Date().toISOString(),
                actorId: requestUserId || 'system',
                actionType: 'milestone_approve',
                target: milestoneId,
                reason: err.message,
                source: 'rest',
                status: 'failed',
              });
              respondApiError(res, err, { status: 400 });
            }
          }
        }).catch(err => {
          log.error('Failed to read request body for /api/approve', { error: err.message });
          json(res, { error: 'Failed to read request body' }, 400);
        });
        return true;
      }

      // ─── POST /api/projects/:id/campaigns/:id/milestones/:milestoneId/approve ───
      const milestoneApproveMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/milestones\/([^/]+)\/approve$/);
      if (milestoneApproveMatch && req.method === 'POST') {
        if (!requireOperatorRole()) return true;
        const [projId, campId, msId] = [decodeURIComponent(milestoneApproveMatch[1]), decodeURIComponent(milestoneApproveMatch[2]), decodeURIComponent(milestoneApproveMatch[3])];
        const campaign = campaignManager.getCampaign(projId, campId);
        if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
        handleBody(req, res, body => {
          try {
            let reason = null;
            if (body) {
              const parsed = JSON.parse(body);
              reason = parsed.reason || null;
            }
            const operatorId = requestUserId || 'system';
            const milestoneBefore = campaign.milestones.find(m => m.id === msId);
            campaignManager.approveMilestone(projId, campId, msId, reason, operatorId);
            
            // Log to operator audit store
            operatorAuditStore.append({
              projectId: projId,
              campaignId: campId,
              milestoneId: msId,
              timestamp: new Date().toISOString(),
              actorId: operatorId,
              actionType: 'milestone_approve',
              target: msId,
              correlationId: campId,
              reason: reason || `Approved via REST API by ${operatorId}`,
              source: 'rest',
              status: 'success',
              beforeState: { status: 'waiting_approval', approvalState: milestoneBefore?.approvalState },
              afterState: { status: 'waiting_approval', approvalState: 'approved', approverId: operatorId },
            });
            
            // Log to approval audit trail
            if (approvalAuditTrail) {
              approvalAuditTrail.logApproval({
                milestoneId: msId,
                projectId: projId,
                campaignId: campId,
                operatorId: operatorId,
                reason: reason || `Approved via REST API`,
                source: 'rest',
                webhookProvider: null,
                deliveryId: null,
                signatureValidated: false,
                signatureError: null,
                webhookData: {},
              });
            }
            
            strategistEvaluate(projId, campId).catch(err => log.error('Strategist evaluation failed after milestone approval', { projectId: projId, campaignId: campId, milestoneId: msId, error: err.message }));
            const milestone = campaign.milestones.find(m => m.id === msId);
            json(res, { ok: true, milestone });
          } catch (err) { respondApiError(res, err, { status: 400 }); }
        });
        return true;
      }

     // ─── POST /api/projects/:id/campaigns/:id/milestones/:milestoneId/reject ───
     const milestoneRejectMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/milestones\/([^/]+)\/reject$/);
     if (milestoneRejectMatch && req.method === 'POST') {
       if (!requireOperatorRole()) return true;
       const [projId, campId, msId] = [decodeURIComponent(milestoneRejectMatch[1]), decodeURIComponent(milestoneRejectMatch[2]), decodeURIComponent(milestoneRejectMatch[3])];
       const campaign = campaignManager.getCampaign(projId, campId);
       if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
       handleBody(req, res, body => {
         try {
           let reason = null;
           if (body) {
             const parsed = JSON.parse(body);
             reason = parsed.reason || null;
           }
           campaignManager.rejectMilestone(projId, campId, msId, reason, requestUserId || 'system');
           const milestone = campaign.milestones.find(m => m.id === msId);
           json(res, { ok: true, milestone });
         } catch (err) { respondApiError(res, err, { status: 400 }); }
       });
       return true;
     }

      // ─── POST /api/projects/:id/campaigns/:id/milestones/:milestoneId/request-approval ───
      const milestoneRequestApprovalMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/milestones\/([^/]+)\/request-approval$/);
      if (milestoneRequestApprovalMatch && req.method === 'POST') {
        if (!requireOperatorRole()) return true;
        const [projId, campId, msId] = [decodeURIComponent(milestoneRequestApprovalMatch[1]), decodeURIComponent(milestoneRequestApprovalMatch[2]), decodeURIComponent(milestoneRequestApprovalMatch[3])];
        const campaign = campaignManager.getCampaign(projId, campId);
        if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
        handleBody(req, res, body => {
          try {
            let reason = null;
            if (body) {
              const parsed = JSON.parse(body);
              reason = parsed.reason || null;
            }
            campaignManager.requestApproval(projId, campId, msId, reason, requestUserId || 'system');
            const milestone = campaign.milestones.find(m => m.id === msId);
            json(res, { ok: true, milestone });
          } catch (err) { respondApiError(res, err, { status: 400 }); }
        });
        return true;
      }

      // ─── POST /api/webhooks/approvals ───
      if (path === '/api/webhooks/approvals' && req.method === 'POST') {
        handleBody(req, res, async body => {
          // Lazy import to avoid top-level await
          const { parseApprovalPayload } = await import('./webhook-approval-handler.js');
        
          try {
            // Parse JSON body
            let payload;
            try {
              payload = JSON.parse(body);
            } catch {
              json(res, { error: 'Invalid JSON in request body' }, 400);
              return;
            }

            // Extract headers for signature verification
            const requestHeaders = {
              'X-Slack-Signature': req.headers['x-slack-signature'],
              'X-Slack-Request-Timestamp': req.headers['x-slack-request-timestamp'],
              'X-Signature': req.headers['x-signature'],
              'X-Delivery-ID': req.headers['x-delivery-id'],
              'User-Agent': req.headers['user-agent'],
            };

            // Get secrets from config
            const slackSigningSecret = config?.webhooks?.slackSigningSecret || null;
            const webhookSecret = config?.webhooks?.signingSecret || null;

            // Parse and validate payload using webhook-approval-handler
            const approvalData = parseApprovalPayload(payload, {
              slackSigningSecret,
              webhookSecret,
              requestHeaders,
            });

            const { milestoneId, projectId, decision, operatorId, reason, source, webhookProvider, deliveryId } = approvalData;

            // Validate project exists
            if (!stateManager.getProject(projectId)) {
              json(res, { error: `Project ${projectId} not found` }, 404);
              return;
            }

            // Find campaign and milestone
            let foundCampaign = null;
            let foundMilestone = null;
            const campaigns = campaignManager.listCampaigns(projectId, 'active');
            for (const campaign of campaigns) {
              const milestone = campaign.milestones.find(m => m.id === milestoneId);
              if (milestone) {
                foundCampaign = campaign;
                foundMilestone = milestone;
                break;
              }
            }

            if (!foundCampaign || !foundMilestone) {
              json(res, { error: `Milestone ${milestoneId} not found in project ${projectId}` }, 404);
              return;
            }

            // Validate milestone is waiting for approval
            if (foundMilestone.status !== 'waiting_approval') {
              json(res, { 
                error: `Milestone ${milestoneId} is not waiting for approval (current status: ${foundMilestone.status})` 
              }, 400);
              return;
            }

            // Validate approval state is pending
            if (foundMilestone.approvalState !== 'pending') {
              json(res, { 
                error: `Milestone ${milestoneId} approvalState is not 'pending' (current: ${foundMilestone.approvalState})` 
              }, 400);
              return;
            }

            // Execute approval or rejection based on decision
            let updatedMilestone;
            if (decision === 'approve') {
              campaignManager.approveMilestone(
                projectId, 
                foundCampaign.id, 
                milestoneId, 
                reason || `Approved via ${source} webhook`, 
                operatorId
              );
              updatedMilestone = foundCampaign.milestones.find(m => m.id === milestoneId);
            } else if (decision === 'reject') {
              campaignManager.rejectMilestone(
                projectId, 
                foundCampaign.id, 
                milestoneId, 
                reason || `Rejected via ${source} webhook`, 
                operatorId
              );
              updatedMilestone = foundCampaign.milestones.find(m => m.id === milestoneId);
            }

            // Log to operator audit store
            operatorAuditStore.append({
              projectId,
              campaignId: foundCampaign.id,
              milestoneId,
              timestamp: new Date().toISOString(),
              actorId: operatorId,
              actionType: decision === 'approve' ? 'milestone_approve' : 'milestone_reject',
              target: milestoneId,
              correlationId: foundCampaign.id,
              reason: reason || `Decision via ${source} webhook`,
              source: 'webhook',
              status: 'success',
              webhookProvider,
              deliveryId,
              beforeState: { status: 'waiting_approval', approvalState: 'pending' },
              afterState: { 
                status: updatedMilestone.status, 
                approvalState: updatedMilestone.approvalState, 
                approverId: operatorId 
              },
              webhookData: approvalData.webhookData || approvalData.slackData || {},
            });

            // Log to approval audit trail with webhook-specific metadata
            if (approvalAuditTrail) {
              const signatureValidated = !!(slackSigningSecret || webhookSecret);
              if (decision === 'approve') {
                approvalAuditTrail.logApproval({
                  milestoneId,
                  projectId,
                  campaignId: foundCampaign.id,
                  operatorId,
                  reason: reason || `Approved via ${source} webhook`,
                  source: 'webhook',
                  webhookProvider,
                  deliveryId,
                  signatureValidated,
                  signatureError: null,
                  webhookData: approvalData.webhookData || approvalData.slackData || {},
                });
              } else if (decision === 'reject') {
                approvalAuditTrail.logRejection({
                  milestoneId,
                  projectId,
                  campaignId: foundCampaign.id,
                  operatorId,
                  reason: reason || `Rejected via ${source} webhook`,
                  source: 'webhook',
                  webhookProvider,
                  deliveryId,
                  signatureValidated,
                  signatureError: null,
                  webhookData: approvalData.webhookData || approvalData.slackData || {},
                });
              }
            }

            // Trigger strategist evaluation to resume campaign
            if (strategistEvaluate) {
              strategistEvaluate(projectId, foundCampaign.id).catch(err =>
                log.error('Strategist evaluation failed after webhook approval', { 
                  projectId, 
                  milestoneId, 
                  campaignId: foundCampaign.id, 
                  error: err.message 
                })
              );
            }

            // Return success response
            json(res, {
              ok: true,
              milestone: updatedMilestone,
              projectId,
              campaignId: foundCampaign.id,
              decision,
              processedAt: new Date().toISOString(),
            });

          } catch (err) {
            // Determine error type and response code
            let statusCode = 400;
            let errorMessage = 'Webhook approval failed';

            if (err.message.includes('signature verification failed')) {
              statusCode = 401;
              errorMessage = 'Signature verification failed';
            } else if (err.message.includes('not found')) {
              statusCode = 404;
              errorMessage = 'Requested approval target not found';
            } else if (err.message.includes('Invalid')) {
              statusCode = 400;
              errorMessage = 'Invalid webhook approval request';
            }

            log.error('Webhook approval failed', { error: err.message, statusCode });
            
            // Log failed attempt to audit trail
            if (operatorAuditStore) {
              operatorAuditStore.append({
                timestamp: new Date().toISOString(),
                actorId: requestHeaders['User-Agent'] || 'webhook',
                actionType: 'webhook_approval_failed',
                target: null,
                correlationId: null,
                reason: errorMessage,
                source: 'webhook',
                status: 'failed',
                error: err.message,
              });
            }
            
            json(res, { error: errorMessage }, statusCode);
          }
        }).catch(err => {
          log.error('Failed to read webhook approval request body', { error: err.message });
          json(res, { error: 'Failed to read request body' }, 400);
        });
        return true;
      }

     const campaignDecomposeMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/decompose$/);
    if (campaignDecomposeMatch && req.method === 'POST') {
      const [projId, campId] = [decodeURIComponent(campaignDecomposeMatch[1]), decodeURIComponent(campaignDecomposeMatch[2])];
      const campaign = campaignManager.getCampaign(projId, campId);
      if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
      if (campaign.status !== 'active') { json(res, { error: 'Campaign must be active' }, 400); return true; }
      strategistDecomposeCampaign(projId, campId).catch(err => log.error('Manual decompose failed', { error: err.message }));
      json(res, { ok: true, status: 'decomposing' }, 202);
      return true;
    }

    // --- Campaign constraints ---
    const campaignConstraintsMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/constraints$/);
    if (campaignConstraintsMatch && req.method === 'GET') {
      const projId = decodeURIComponent(campaignConstraintsMatch[1]);
      const campId = decodeURIComponent(campaignConstraintsMatch[2]);
      const campaign = campaignManager.getCampaign(projId, campId);
      if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }
      const constraints = campaignManager.getActiveConstraints(projId, campId);
      json(res, { constraints, campaignId: campId });
      return true;
    }
    if (campaignConstraintsMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      const projId = decodeURIComponent(campaignConstraintsMatch[1]);
      const campId = decodeURIComponent(campaignConstraintsMatch[2]);
      handleBody(req, res, async body => {
        try {
          if (!body || !body.trim()) {
            json(res, { error: 'Request body is required' }, 400);
            return;
          }
          let parsed;
          try { parsed = JSON.parse(body); } catch {
            json(res, { error: 'Request body must be valid JSON' }, 400);
            return;
          }
          const campaign = campaignManager.getCampaign(projId, campId);
          if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return; }
          if (campaign.status !== 'active') {
            json(res, { error: `Campaign is ${campaign.status}, constraints can only be added to active campaigns` }, 400);
            return;
          }
          const dryRun = url.searchParams.get('dryRun') === 'true';
          // Validate BEFORE conflict detection. A malformed body is a 400, not a
          // 409: detectConstraintConflict() flattens an unrecognised or absent
          // `type` to {}, which is then dropped from the merged constraint set,
          // so it cannot conflict with anything -- yet every malformed POST came
          // back 409 because the conflict simulation ran first. addConstraint()
          // already validates in this order; only this handler had it inverted.
          //
          // The message is returned verbatim, NOT through respondApiError().
          // That helper redacts err.message down to "Request could not be
          // completed", which is right for internal faults but useless here:
          // these messages describe the CALLER'S OWN body ("Constraint 'value'
          // field is required"), leak nothing, and are the only way a client can
          // tell which field it got wrong.
          try {
            validateConstraintInput(parsed);
          } catch (validationErr) {
            json(res, { error: validationErr.message }, 400);
            return;
          }
          const activeConstraints = campaignManager.getActiveConstraints(projId, campId);
          const conflict = detectConstraintConflict(agents, activeConstraints, { ...parsed, id: 'proposed' });
          if (conflict) {
            json(res, conflict, 409);
            return;
          }
          if (dryRun) {
            json(res, { ok: true, dryRun: true });
            return;
          }
          // addConstraint is async. Without the await, `entry` was a pending
          // Promise: the 200 carried "constraint": {} (JSON.stringify of a
          // Promise), entry.id/type/createdAt were all undefined, and -- worse --
          // a rejection escaped this try/catch as an unhandled rejection, so a
          // failed write still answered 200. handleBody() awaits the handler and
          // routes a throw to its own 500, so making this callback async is safe.
          const entry = await campaignManager.addConstraint(projId, campId, parsed, requestUserId);
          const channel = campaign.channel || 'default';
          addMessage(projId, channel, 'System',
            `Constraint "${entry.type}" applied to campaign "${campaign.title}" by ${requestUserId || 'system'}.`,
            'system', { userId: requestUserId || 'default' });
          events.emit('campaign:constraint_applied', {
            projectId: projId,
            campaignId: campId,
            constraintId: entry.id,
            constraint: entry,
            appliedAt: entry.createdAt,
          }).catch(() => {});
          json(res, { ok: true, constraint: entry, appliedAt: entry.createdAt });
        } catch (err) {
          if (err.conflict) {
            json(res, err.conflict, 409);
          } else {
            const status = err.message.includes('not found') ? 404 : 400;
            respondApiError(res, err, { status });
          }
        }
      });
      return true;
    }

    // DELETE constraint
    const constraintDeleteMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/constraints\/([^/]+)$/);
    if (constraintDeleteMatch && req.method === 'DELETE') {
      if (!requireOperatorRole()) return true;
      const projId = decodeURIComponent(constraintDeleteMatch[1]);
      const campId = decodeURIComponent(constraintDeleteMatch[2]);
      const constraintId = decodeURIComponent(constraintDeleteMatch[3]);
      try {
        const campaign = campaignManager.getCampaign(projId, campId);
        if (!campaign) { json(res, { error: 'Campaign not found' }, 404); return true; }

        const deactivated = campaignManager.removeConstraint(projId, campId, constraintId, requestUserId);
        json(res, { ok: true, constraint: deactivated });

        // Emit event for real-time UI updates
        events.emit('campaign:constraint_removed', {
          projectId: projId,
          campaignId: campId,
          constraintId,
          constraint: deactivated,
          deactivatedAt: deactivated.deactivatedAt,
        }).catch(() => {});

      } catch (err) {
        const status = err.message.includes('not found') ? 404 : 400;
        respondApiError(res, err, { status });
      }
      return true;
    }

    // --- Campaign checkpoints ---
    const checkpointsMatch = path.match(/^\/api\/projects\/([^/]+)\/campaigns\/([^/]+)\/checkpoints$/);
    if (checkpointsMatch && req.method === 'GET') {
      const projId = decodeURIComponent(checkpointsMatch[1]);
      const campId = decodeURIComponent(checkpointsMatch[2]);

      if (!checkpointManager) {
        json(res, { error: 'Checkpoint manager not configured' }, 503);
        return true;
      }

      try {
        const checkpoints = checkpointManager.listCheckpoints(projId, campId);

        // Map to API response format with id, createdAt, milestoneProgress, and completedSubtasks
        const response = checkpoints.map(cp => ({
          id: cp.checkpointId,
          createdAt: cp.createdAt,
          milestoneProgress: cp.milestoneProgressMap || cp.milestoneProgress || {},
          // Handle both old format (completedSubtasks array) and new format (completedSubtaskIds array)
          completedSubtasks: cp.completedSubtaskIds || cp.completedSubtasks || [],
          // Include result summaries for state summary tooltip/modal
          resultSummaries: cp.resultSummaries || {},
        }));

        json(res, response);
      } catch (err) {
        respondApiError(res, err);
      }
      return true;
    }

    const checkpointReplayMatch = path.match(new RegExp('^/api/campaigns/([^/]+)/([^/]+)/replay/([^/]+)$'));
    if (checkpointReplayMatch && req.method === 'POST') {
      const projId = decodeURIComponent(checkpointReplayMatch[1]);
      const campId = decodeURIComponent(checkpointReplayMatch[2]);
      const checkpointId = decodeURIComponent(checkpointReplayMatch[3]);
      if (!requireOperatorRole('checkpoint_replay', { projectId: projId, campaignId: campId, resourceId: checkpointId })) return true;

      handleBody(req, res, body => {
        const payload = (body && body.trim()) ? JSON.parse(body) : {};
        const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
        const operatorId = requestUserId || 'system';

        if (!checkpointManager || typeof checkpointManager.replayFromCheckpoint !== 'function') {
          const { intentId } = recordIntent('checkpoint_replay', {
            projectId: projId,
            campaignId: campId,
            checkpointId: checkpointId,
            operatorId,
            source,
            reason: auditReason,
            correlationId,
            dispatchId,
            traceId,
          });
          json(res, { ok: true, mock: true, intentId, message: 'Checkpoint manager unavailable, replay intent recorded.' }, 202);
          return;
        }

        const campaign = campaignManager?.getCampaign ? campaignManager.getCampaign(projId, campId) : null;
        if (!campaign) {
          json(res, { error: 'Campaign not found' }, 404);
          return;
        }

        let checkpoint = null;
        try {
          if (typeof checkpointManager.loadCheckpoint === 'function') {
            checkpoint = checkpointManager.loadCheckpoint(projId, campId, checkpointId);
          } else if (typeof checkpointManager.listCheckpoints === 'function') {
            const checkpoints = checkpointManager.listCheckpoints(projId, campId);
            checkpoint = checkpoints.find(cp => cp.checkpointId === checkpointId) || null;
          }
        } catch (err) {
          respondApiError(res, err);
          return;
        }

        if (!checkpoint) {
          json(res, { error: `Checkpoint not found: ${checkpointId}` }, 404);
          return;
        }

        checkpointManager.replayFromCheckpoint(projId, campId, checkpointId, campaignManager, taskManager)
          .then(replayedCheckpoint => {
            const replayedAt = new Date().toISOString();
            const replayed = replayedCheckpoint || checkpoint;

            broadcast({
              type: 'checkpoint_replay',
              projectId: projId,
              campaignId: campId,
              checkpointId,
              replayedAt,
              checkpoint: {
                id: replayed.checkpointId || checkpointId,
                createdAt: replayed.createdAt || null,
                milestoneProgress: replayed.milestoneProgressMap || replayed.milestoneProgress || {},
                completedSubtasks: replayed.completedSubtaskIds || replayed.completedSubtasks || [],
              },
            });

            operatorAuditStore.append({
              action: 'checkpoint_replay',
              projectId: projId,
              campaignId: campId,
              checkpointId,
              replayedAt,
              operatorId,
              status: 'success',
              decision: 'allow',
              source,
              reason: auditReason,
              correlationId,
              dispatchId,
              traceId,
            });

            json(res, {
              ok: true,
              projectId: projId,
              campaignId: campId,
              checkpointId,
              replayedAt,
            });
          })
          .catch(err => {
            const msg = err?.message || 'Failed to replay checkpoint';
            let status = 500;
            if (msg.includes('not found')) status = 404;
            else if (msg.includes('not in a replayable state')) status = 400;

            operatorAuditStore.append({
              action: 'checkpoint_replay',
              projectId: projId,
              campaignId: campId,
              checkpointId,
              replayedAt: new Date().toISOString(), // Use current time for failure
              operatorId,
              status: 'failure',
              decision: 'deny',
              details: msg,
              source,
              reason: auditReason,
              correlationId,
              dispatchId,
              traceId,
            });
            json(res, { error: msg }, status);
          });
      });
      return true;
    }

    // --- Schedule routes ---
    const schedListMatch = path.match(/^\/api\/projects\/([^/]+)\/schedules$/);
    if (schedListMatch && req.method === 'GET') {
      const projId = decodeURIComponent(schedListMatch[1]);
      const status = url.searchParams.get('status');
      json(res, scheduleManager.listSchedules(projId, status));
      return true;
    }
    if (schedListMatch && req.method === 'POST') {
      const projId = decodeURIComponent(schedListMatch[1]);
      handleBody(req, res, body => {
        try {
          const opts = JSON.parse(body);
          const schedule = scheduleManager.createSchedule(projId, opts);
          json(res, schedule, 201);
        } catch (e) { respondApiError(res, e, { status: 400 }); }
      });
      return true;
    }
    const schedDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/schedules\/([^/]+)$/);
    if (schedDetailMatch && req.method === 'GET') {
      const schedule = scheduleManager.getSchedule(decodeURIComponent(schedDetailMatch[1]), decodeURIComponent(schedDetailMatch[2]));
      json(res, schedule || { error: 'Schedule not found' }, schedule ? 200 : 404);
      return true;
    }
    if (schedDetailMatch && req.method === 'DELETE') {
      const deleted = scheduleManager.deleteSchedule(decodeURIComponent(schedDetailMatch[1]), decodeURIComponent(schedDetailMatch[2]));
      json(res, deleted ? { ok: true } : { error: 'Schedule not found' }, deleted ? 200 : 404);
      return true;
    }
    const schedPauseMatch = path.match(/^\/api\/projects\/([^/]+)\/schedules\/([^/]+)\/pause$/);
    if (schedPauseMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      const [projId, schedId] = [decodeURIComponent(schedPauseMatch[1]), decodeURIComponent(schedPauseMatch[2])];
      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          scheduleManager.updateScheduleStatus(projId, schedId, 'paused', auditReason || 'Paused via API');

          operatorAuditStore.append({
            action: 'schedule_pause',
            projectId: projId,
            scheduleId: schedId,
            operatorId,
            status: 'success',
            decision: 'allow',
            source,
            reason: auditReason,
            correlationId,
            dispatchId,
            traceId,
          });
          json(res, { ok: true, status: 'paused' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }
    const schedResumeMatch = path.match(/^\/api\/projects\/([^/]+)\/schedules\/([^/]+)\/resume$/);
    if (schedResumeMatch && req.method === 'POST') {
      if (!requireOperatorRole()) return true;
      const [projId, schedId] = [decodeURIComponent(schedResumeMatch[1]), decodeURIComponent(schedResumeMatch[2])];
      handleBody(req, res, body => {
        try {
          const payload = (body && body.trim()) ? JSON.parse(body) : {};
          const { source, reason: auditReason, correlationId, dispatchId, traceId } = getAuditContext(req, payload);
          const operatorId = requestUserId || 'system';

          scheduleManager.updateScheduleStatus(projId, schedId, 'active', auditReason || 'Resumed via API');

          operatorAuditStore.append({
            action: 'schedule_resume',
            projectId: projId,
            scheduleId: schedId,
            operatorId,
            status: 'success',
            decision: 'allow',
            source,
            reason: auditReason,
            correlationId,
            dispatchId,
            traceId,
          });
          json(res, { ok: true, status: 'active' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
      });
      return true;
    }
    const schedTriggerMatch = path.match(/^\/api\/projects\/([^/]+)\/schedules\/([^/]+)\/trigger$/);
    if (schedTriggerMatch && req.method === 'POST') {
      const [projId, schedId] = [decodeURIComponent(schedTriggerMatch[1]), decodeURIComponent(schedTriggerMatch[2])];
      const schedule = scheduleManager.getSchedule(projId, schedId);
      if (!schedule) { json(res, { error: 'Schedule not found' }, 404); return true; }
      // Manual trigger — fire immediately regardless of nextFireAt
      const { schedulerLoop: sLoop } = deps;
      if (sLoop) {
        sLoop.fireSchedule(projId, schedule).then(() => {
          json(res, { ok: true, status: 'fired' });
        }).catch(err => respondApiError(res, err));
      } else {
        json(res, { error: 'Scheduler not available' }, 500);
      }
      return true;
    }

    // --- Trigger routes ---
    if (triggerManager) {
      const trigListMatch = path.match(/^\/api\/projects\/([^/]+)\/triggers$/);
      if (trigListMatch && req.method === 'GET') {
        const projId = decodeURIComponent(trigListMatch[1]);
        const status = url.searchParams.get('status');
        json(res, triggerManager.listTriggers(projId, status));
        return true;
      }
      if (trigListMatch && req.method === 'POST') {
        const projId = decodeURIComponent(trigListMatch[1]);
        handleBody(req, res, body => {
          try {
            const opts = JSON.parse(body);
            const trigger = triggerManager.createTrigger(projId, opts);
            // Auto-subscribe to external:* events so the trigger loop listens for them
            if (trigger.event.startsWith('external:') && deps.triggerLoop?.subscribe) {
              deps.triggerLoop.subscribe(trigger.event);
            }
            json(res, trigger, 201);
          } catch (e) { respondApiError(res, e, { status: 400 }); }
        });
        return true;
      }
      const trigDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/triggers\/([^/]+)$/);
      if (trigDetailMatch && req.method === 'GET') {
        const trigger = triggerManager.getTrigger(decodeURIComponent(trigDetailMatch[1]), decodeURIComponent(trigDetailMatch[2]));
        json(res, trigger || { error: 'Trigger not found' }, trigger ? 200 : 404);
        return true;
      }
      if (trigDetailMatch && req.method === 'DELETE') {
        const deleted = triggerManager.deleteTrigger(decodeURIComponent(trigDetailMatch[1]), decodeURIComponent(trigDetailMatch[2]));
        json(res, deleted ? { ok: true } : { error: 'Trigger not found' }, deleted ? 200 : 404);
        return true;
      }
      const trigPauseMatch = path.match(/^\/api\/projects\/([^/]+)\/triggers\/([^/]+)\/pause$/);
      if (trigPauseMatch && req.method === 'POST') {
        try {
          triggerManager.updateTriggerStatus(decodeURIComponent(trigPauseMatch[1]), decodeURIComponent(trigPauseMatch[2]), 'paused');
          json(res, { ok: true, status: 'paused' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
        return true;
      }
      const trigResumeMatch = path.match(/^\/api\/projects\/([^/]+)\/triggers\/([^/]+)\/resume$/);
      if (trigResumeMatch && req.method === 'POST') {
        try {
          triggerManager.updateTriggerStatus(decodeURIComponent(trigResumeMatch[1]), decodeURIComponent(trigResumeMatch[2]), 'active');
          json(res, { ok: true, status: 'active' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
        return true;
      }
    }

    // --- Workflow routes ---
    const { workflowManager } = deps;
    if (workflowManager) {
      const wfListMatch = path.match(/^\/api\/projects\/([^/]+)\/workflows$/);
      if (wfListMatch && req.method === 'GET') {
        const projId = decodeURIComponent(wfListMatch[1]);
        const status = url.searchParams.get('status');
        json(res, workflowManager.listWorkflows(projId, status));
        return true;
      }
      if (wfListMatch && req.method === 'POST') {
        const projId = decodeURIComponent(wfListMatch[1]);
        handleBody(req, res, body => {
          try {
            const opts = JSON.parse(body);
            const workflow = workflowManager.createWorkflow(projId, opts);
            json(res, workflow, 201);
          } catch (e) { respondApiError(res, e, { status: 400 }); }
        });
        return true;
      }
      const wfDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/workflows\/([^/]+)$/);
      if (wfDetailMatch && req.method === 'GET') {
        const wf = workflowManager.getWorkflow(decodeURIComponent(wfDetailMatch[1]), decodeURIComponent(wfDetailMatch[2]));
        json(res, wf || { error: 'Workflow not found' }, wf ? 200 : 404);
        return true;
      }
      if (wfDetailMatch && req.method === 'DELETE') {
        const deleted = workflowManager.deleteWorkflow(decodeURIComponent(wfDetailMatch[1]), decodeURIComponent(wfDetailMatch[2]));
        json(res, deleted ? { ok: true } : { error: 'Workflow not found' }, deleted ? 200 : 404);
        return true;
      }
      const wfRunMatch = path.match(/^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/run$/);
      if (wfRunMatch && req.method === 'POST') {
        try {
          const run = workflowManager.startRun(decodeURIComponent(wfRunMatch[1]), decodeURIComponent(wfRunMatch[2]), { type: 'api' });
          json(res, run, 201);
        } catch (err) { respondApiError(res, err, { status: 400 }); }
        return true;
      }
      const wfPauseMatch = path.match(/^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/pause$/);
      if (wfPauseMatch && req.method === 'POST') {
        try {
          workflowManager.updateWorkflowStatus(decodeURIComponent(wfPauseMatch[1]), decodeURIComponent(wfPauseMatch[2]), 'paused');
          json(res, { ok: true, status: 'paused' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
        return true;
      }
      const wfResumeMatch = path.match(/^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/resume$/);
      if (wfResumeMatch && req.method === 'POST') {
        try {
          workflowManager.updateWorkflowStatus(decodeURIComponent(wfResumeMatch[1]), decodeURIComponent(wfResumeMatch[2]), 'active');
          json(res, { ok: true, status: 'active' });
        } catch (err) { respondApiError(res, err, { status: 400 }); }
        return true;
      }
      const wfRunsMatch = path.match(/^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/runs$/);
      if (wfRunsMatch && req.method === 'GET') {
        const projId = decodeURIComponent(wfRunsMatch[1]);
        const wfId = decodeURIComponent(wfRunsMatch[2]);
        const status = url.searchParams.get('status');
        json(res, workflowManager.listRuns(projId, wfId, status));
        return true;
      }
      const wfRunDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)$/);
      if (wfRunDetailMatch && req.method === 'GET') {
        const run = workflowManager.getRun(decodeURIComponent(wfRunDetailMatch[1]), decodeURIComponent(wfRunDetailMatch[2]));
        json(res, run || { error: 'Run not found' }, run ? 200 : 404);
        return true;
      }
      const wfRunCancelMatch = path.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/cancel$/);
      if (wfRunCancelMatch && req.method === 'POST') {
        const cancelled = workflowManager.cancelRun(decodeURIComponent(wfRunCancelMatch[1]), decodeURIComponent(wfRunCancelMatch[2]));
        json(res, cancelled ? { ok: true, status: 'cancelled' } : { error: 'Run not found or not running' }, cancelled ? 200 : 404);
        return true;
      }
    }

    // --- Credential routes ---
    if (credentialVault) {
      const credListMatch = path.match(/^\/api\/projects\/([^/]+)\/credentials$/);
      if (credListMatch && req.method === 'GET') {
        const projId = decodeURIComponent(credListMatch[1]);
        json(res, credentialVault.list(projId));
        return true;
      }
      if (credListMatch && req.method === 'POST') {
        const projId = decodeURIComponent(credListMatch[1]);
        if (!requireOperatorRole('credential_create', { projectId: projId })) return true;
        handleBody(req, res, body => {
          try {
            const { name, value, description } = JSON.parse(body);
            if (!name) { json(res, { error: 'name required' }, 400); return; }
            if (!value) { json(res, { error: 'value required' }, 400); return; }
            const result = credentialVault.set(projId, name, value, description);
            json(res, result, 201);
          } catch (e) { respondApiError(res, e, { status: 400 }); }
        });
        return true;
      }
      const credDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/credentials\/([^/]+)$/);
      if (credDetailMatch && req.method === 'DELETE') {
        const projId = decodeURIComponent(credDetailMatch[1]);
        const name = decodeURIComponent(credDetailMatch[2]);
        if (!requireOperatorRole('credential_delete', { projectId: projId })) return true;
        const deleted = credentialVault.remove(projId, name);
        json(res, deleted ? { ok: true } : { error: 'Credential not found' }, deleted ? 200 : 404);
        return true;
      }
    }

    // --- Snapshot CRUD routes (snapshotManager) ---
    if (snapshotManager) {
      const snapListMatch = path.match(/^\/api\/projects\/([^/]+)\/snapshots$/);
      if (snapListMatch && req.method === 'GET') {
        const projId = decodeURIComponent(snapListMatch[1]);
        json(res, snapshotManager.listSnapshots(projId));
        return true;
      }
      if (snapListMatch && req.method === 'POST') {
        const projId = decodeURIComponent(snapListMatch[1]);
        handleBody(req, res, body => {
          try {
            const { reason } = JSON.parse(body);
            const metadata = snapshotManager.createSnapshot(projId, { reason });
            events.emit('snapshot:created', { projectId: projId, ...metadata });
            json(res, metadata, 201);
          } catch (e) { respondApiError(res, e, { status: 400 }); }
        });
        return true;
      }
      const snapDetailMatch = path.match(/^\/api\/projects\/([^/]+)\/snapshots\/([^/]+)$/);
      if (snapDetailMatch && req.method === 'GET') {
        const [projId, snapId] = [decodeURIComponent(snapDetailMatch[1]), decodeURIComponent(snapDetailMatch[2])];
        const envelope = snapshotManager.getSnapshot(projId, snapId);
        json(res, envelope || { error: 'Snapshot not found' }, envelope ? 200 : 404);
        return true;
      }
      if (snapDetailMatch && req.method === 'DELETE') {
        const [projId, snapId] = [decodeURIComponent(snapDetailMatch[1]), decodeURIComponent(snapDetailMatch[2])];
        const deleted = snapshotManager.deleteSnapshot(projId, snapId);
        json(res, deleted ? { ok: true } : { error: 'Snapshot not found' }, deleted ? 200 : 404);
        return true;
      }
      const snapRestoreMatch = path.match(/^\/api\/projects\/([^/]+)\/snapshots\/([^/]+)\/restore$/);
      if (snapRestoreMatch && req.method === 'POST') {
        const [projId, snapId] = [decodeURIComponent(snapRestoreMatch[1]), decodeURIComponent(snapRestoreMatch[2])];
        try {
          const result = snapshotManager.restoreSnapshot(projId, snapId);
          events.emit('snapshot:restored', { projectId: projId, snapshotId: snapId, ...result });
          json(res, result);
        } catch (e) {
          respondApiError(res, e, { status: 404 });
        }
        return true;
      }
    }

    // --- Snapshot routes (legacy export/restore) ---
    const snapshotExportMatch = path.match(/^\/api\/projects\/([^/]+)\/snapshot$/);
    if (snapshotExportMatch && req.method === 'GET') {
      const projId = decodeURIComponent(snapshotExportMatch[1]);
      const baseDir = join(stateManager.baseDir, '..');
      const persist = url.searchParams.get('persist') !== 'false'; // persist by default
      const result = collectSnapshot(projId, {
        stateManager, campaignManager, taskManager,
        workflowManager: deps.workflowManager,
        baseDir: persist ? baseDir : undefined,
      });
      if (!result) { json(res, { error: 'Project not found' }, 404); return true; }
      json(res, result.snapshot);
      return true;
    }

    const snapshotListMatch = path.match(/^\/api\/projects\/([^/]+)\/snapshots$/);
    if (snapshotListMatch && req.method === 'GET') {
      const projId = decodeURIComponent(snapshotListMatch[1]);
      const baseDir = join(stateManager.baseDir, '..');
      json(res, listSnapshots(baseDir, projId));
      return true;
    }

    const snapshotRestoreMatch = path.match(/^\/api\/projects\/([^/]+)\/snapshot\/restore$/);
    if (snapshotRestoreMatch && req.method === 'POST') {
      const projId = decodeURIComponent(snapshotRestoreMatch[1]);
      handleBody(req, res, body => {
        try {
          const payload = JSON.parse(body);
          const opts = {
            stateManager,
            projectId: projId,
            taskManager,
          };
          // If payload has a "filename" key and no "manifest", treat as file-based restore
          if (payload.filename && !payload.manifest) {
            opts.filename = payload.filename;
          } else {
            opts.snapshot = payload;
          }
          const result = restoreSnapshot(opts);
          json(res, result);
        } catch (err) {
          const status = err.code === 'VALIDATION_ERROR' ? 400
            : err.code === 'NOT_FOUND' ? 404
            : 500;
          respondApiError(res, err, { status });
        }
      });
      return true;
    }

    // ─── Pattern Detection API ───────────────────────────────────
    /**
     * GET /api/patterns
     * List recently detected cross-project patterns with filtering.
     * Requires authentication via auth.checkRequest().
     *
     * Query Parameters:
     *   - projectId: Filter patterns by project ID (optional)
     *   - startTime: Filter patterns detected after this ISO timestamp (optional)
     *   - endTime: Filter patterns detected before this ISO timestamp (optional)
     *   - eventType: Filter by event type (optional)
     *   - minConfidence: Minimum confidence threshold 0.0-1.0 (optional)
     *   - limit: Maximum number of patterns to return (default: 50, max: 200)
     *
     * Response Schema:
     * {
     *   patterns: [
     *     {
     *       patternId: string,
     *       detectedAt: string (ISO 8601),
     *       eventType: string,
     *       projectIds: string[],
     *       projectEventCounts: { [projectId]: number },
     *       confidence: number (0.0-1.0),
     *       windowMs: number,
     *       eventCount: number
     *     }
     *   ],
     *   total: number,
     *   filtered: number
     * }
     *
     * Example Request:
     *   GET /api/patterns?projectId=proj-123&minConfidence=0.7&limit=20
     *
     * Example Response:
     *   {
     *     "patterns": [
     *       {
     *         "patternId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
     *         "detectedAt": "2026-03-31T10:30:00.000Z",
     *         "eventType": "anomaly_alert",
     *         "projectIds": ["proj-123", "proj-456"],
     *         "projectEventCounts": { "proj-123": 5, "proj-456": 3 },
     *         "confidence": 0.85,
     *         "windowMs": 300000,
     *         "eventCount": 8
     *       }
     *     ],
     *     "total": 1,
     *     "filtered": 1
     *   }
     *
      * Error Responses:
      *   401: Unauthorized - authentication required
      *   503: Pattern detector not available
      */
     if (path === '/api/patterns' && req.method === 'GET') {
       if (!auth.checkRequest(req, res)) return true; // consumed — 401 sent

       const patternDetector = deps.patternDetector;
       if (!patternDetector) {
         json(res, { error: 'Pattern detector not available' }, 503);
         return true;
       }

      // Parse query parameters
      const projectIdFilter = url.searchParams.get('projectId');
      const startTime = url.searchParams.get('startTime');
      const endTime = url.searchParams.get('endTime');
      const eventTypeFilter = url.searchParams.get('eventType');
      const minConfidence = url.searchParams.get('minConfidence') !== null
        ? parseFloat(url.searchParams.get('minConfidence'))
        : null;
      const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Math.min(Math.max(limitParam, 1), 200);

      // Get all patterns from detector (stored in-memory or from last scan)
      // Pattern detector stores patterns internally; we access via getDetectedPatterns or similar
      let allPatterns = [];
      if (typeof patternDetector.getDetectedPatterns === 'function') {
        allPatterns = patternDetector.getDetectedPatterns() || [];
      } else if (patternDetector.eventBuffer && Array.isArray(patternDetector.eventBuffer)) {
        // Fallback: run detection on current event buffer
        allPatterns = patternDetector.detectPatterns(patternDetector.eventBuffer) || [];
      }

      // Apply filters
      const filteredPatterns = allPatterns.filter(pattern => {
        // Project filter: include pattern if any affected project matches
        if (projectIdFilter) {
          const affectedProjects = pattern.affectedProjects || pattern.projectIds || [];
          if (!affectedProjects.includes(projectIdFilter)) {
            return false;
          }
        }

        // Time range filter
        if (startTime) {
          const patternTime = new Date(pattern.detectedAt).getTime();
          const start = new Date(startTime).getTime();
          if (patternTime < start) return false;
        }

        if (endTime) {
          const patternTime = new Date(pattern.detectedAt).getTime();
          const end = new Date(endTime).getTime();
          if (patternTime > end) return false;
        }

        // Event type filter
        if (eventTypeFilter && pattern.eventType !== eventTypeFilter) {
          return false;
        }

        // Confidence filter
        if (minConfidence !== null && pattern.confidence < minConfidence) {
          return false;
        }

        return true;
      });

      // Transform patterns to include projectIds and per-project event counts
      const transformedPatterns = filteredPatterns.map(pattern => {
        const projectIds = pattern.affectedProjects || [];
        const events = pattern.events || [];

        // Compute per-project event counts
        const projectEventCounts = {};
        for (const projectId of projectIds) {
          projectEventCounts[projectId] = 0;
        }
        for (const event of events) {
          const eventProjectId = event.projectId || event.project;
          if (eventProjectId && projectEventCounts.hasOwnProperty(eventProjectId)) {
            projectEventCounts[eventProjectId]++;
          }
        }

        return {
          patternId: pattern.patternId,
          detectedAt: pattern.detectedAt,
          eventType: pattern.eventType,
          projectIds,
          projectEventCounts,
          confidence: pattern.confidence,
          windowMs: pattern.windowMs,
          eventCount: events.length,
        };
      });

      // Apply limit (most recent first)
      const sortedPatterns = transformedPatterns.sort((a, b) =>
        new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
      );
      const limitedPatterns = sortedPatterns.slice(0, limit);

      json(res, {
        patterns: limitedPatterns,
        total: allPatterns.length,
        filtered: filteredPatterns.length,
      });
      return true;
    }

    // ─── GET /api/patterns/:patternId ────────────────────────────
    /**
     * GET /api/patterns/:patternId
     * Get detailed view of a specific pattern with full event list and project attribution.
     *
     * Authentication: Required via auth.checkRequest() - returns 401 if unauthenticated.
     *
     * URL Parameters:
     *   - patternId: The unique pattern identifier (UUID format)
     *
     * Response Schema:
     * {
     *   patternId: string,
     *   detectedAt: string (ISO 8601),
     *   eventType: string,
     *   projectIds: string[],
     *   projectEventCounts: { [projectId]: number },
     *   confidence: number (0.0-1.0),
     *   windowMs: number,
     *   events: [
     *     {
     *       projectId: string,
     *       eventType: string,
     *       timestamp: string (ISO 8601),
     *       detail: string,
     *       ...original event fields
     *     }
     *   ]
     * }
     *
     * Example Request:
     *   GET /api/patterns/a1b2c3d4-e5f6-7890-abcd-ef1234567890
     *
     * Example Response:
     *   {
     *     "patternId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
     *     "detectedAt": "2026-03-31T10:30:00.000Z",
     *     "eventType": "anomaly_alert",
     *     "projectIds": ["proj-123", "proj-456"],
     *     "projectEventCounts": { "proj-123": 5, "proj-456": 3 },
     *     "confidence": 0.85,
     *     "windowMs": 300000,
     *     "events": [
     *       {
     *         "projectId": "proj-123",
     *         "eventType": "anomaly_alert",
     *         "timestamp": "2026-03-31T10:28:00.000Z",
     *         "detail": "High error rate detected"
     *       }
     *     ]
     *   }
     *
     * Error Responses:
     *   401: Unauthorized - authentication required
     *   404: Pattern not found
     *   503: Pattern detector not available
     */
    const patternDetailMatch = path.match(/^\/api\/patterns\/([^/]+)$/);
    if (patternDetailMatch && req.method === 'GET') {
      if (!auth.checkRequest(req, res)) return true; // consumed — 401 sent

      const patternId = decodeURIComponent(patternDetailMatch[1]);
      const patternDetector = deps.patternDetector;
      if (!patternDetector) {
        json(res, { error: 'Pattern detector not available' }, 503);
        return true;
      }

      // Get all patterns and find the requested one
      let allPatterns = [];
      if (typeof patternDetector.getDetectedPatterns === 'function') {
        allPatterns = patternDetector.getDetectedPatterns() || [];
      } else if (patternDetector.eventBuffer && Array.isArray(patternDetector.eventBuffer)) {
        allPatterns = patternDetector.detectPatterns(patternDetector.eventBuffer) || [];
      }

      const pattern = allPatterns.find(p => p.patternId === patternId);
      if (!pattern) {
        json(res, { error: `Pattern "${patternId}" not found` }, 404);
        return true;
      }

      // Compute per-project event counts
      const projectIds = pattern.affectedProjects || [];
      const events = pattern.events || [];
      const projectEventCounts = {};
      for (const projectId of projectIds) {
        projectEventCounts[projectId] = 0;
      }
      for (const event of events) {
        const eventProjectId = event.projectId || event.project;
        if (eventProjectId && projectEventCounts.hasOwnProperty(eventProjectId)) {
          projectEventCounts[eventProjectId]++;
        }
      }

      json(res, {
        patternId: pattern.patternId,
        detectedAt: pattern.detectedAt,
        eventType: pattern.eventType,
        projectIds,
        projectEventCounts,
        confidence: pattern.confidence,
        windowMs: pattern.windowMs,
        events,
      });
      return true;
    }

    // ─── POST /api/patterns/scan ─────────────────────────────────
    /**
     * POST /api/patterns/scan
     * Trigger on-demand correlation scan across all projects.
     * Requires operator role via requireOperatorRole().
     *
     * Request Body (optional):
     * {
     *   windowMs: number (optional, overrides default sliding window),
     *   minProjects: number (optional, overrides minimum project threshold)
     * }
     *
     * Response Schema (synchronous response with discovered patterns):
     * {
     *   ok: true,
     *   patterns: [
     *     {
     *       patternId: string,
     *       detectedAt: string (ISO 8601),
     *       eventType: string,
     *       projectIds: string[],
     *       projectEventCounts: { [projectId]: number },
     *       confidence: number,
     *       windowMs: number,
     *       eventCount: number
     *     }
     *   ],
     *   scanDurationMs: number
     * }
     *
     * Example Request:
     *   POST /api/patterns/scan
     *   Content-Type: application/json
     *   { "windowMs": 600000, "minProjects": 2 }
     *
     * Example Response:
     *   {
     *     "ok": true,
     *     "patterns": [
     *       {
     *         "patternId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
     *         "detectedAt": "2026-03-31T10:30:00.000Z",
     *         "eventType": "anomaly_alert",
     *         "projectIds": ["proj-123", "proj-456"],
     *         "projectEventCounts": { "proj-123": 5, "proj-456": 3 },
     *         "confidence": 0.85,
     *         "windowMs": 600000,
     *         "eventCount": 8
     *       }
     *     ],
     *     "scanDurationMs": 45
     *   }
     *
     * Error Responses:
     *   401: Unauthorized - authentication required
     *   403: Forbidden - operator role required
     *   400: Invalid request body
     *   503: Pattern detector not available
     */
    if (path === '/api/patterns/scan' && req.method === 'POST') {
      if (!requireOperatorRole('pattern_scan', { action: 'pattern_scan' })) return true;

      const patternDetector = deps.patternDetector;
      if (!patternDetector) {
        json(res, { error: 'Pattern detector not available' }, 503);
        return true;
      }

      // Read and parse optional request body
      handleBody(req, res, body => {
        let scanOptions = {};
        if (body && body.trim()) {
          try {
            const payload = JSON.parse(body);
            if (payload && typeof payload === 'object') {
              if (typeof payload.windowMs === 'number') {
                scanOptions.windowMs = payload.windowMs;
              }
              if (typeof payload.minProjects === 'number') {
                scanOptions.minProjects = payload.minProjects;
              }
            }
          } catch (err) {
            json(res, { error: 'Invalid JSON in request body' }, 400);
            return;
          }
        }

        // Get events to scan from timeline store
        let events = [];
        if (timelineStore && typeof timelineStore.query === 'function') {
          try {
            const result = timelineStore.query({ limit: 10000 });
            events = result.events || [];
          } catch (err) {
            log.warn('Failed to query events for pattern scan', { error: err.message });
          }
        }

        // Run pattern detection
        const startMs = Date.now();
        let detectedPatterns = [];
        if (Object.keys(scanOptions).length > 0) {
          // Create temporary detector with custom options
          const tempDetector = new TemporalCorrelationDetector(scanOptions);
          detectedPatterns = tempDetector.detectPatterns(events) || [];
        } else {
          // Use default detector configuration
          detectedPatterns = patternDetector.detectPatterns(events) || [];
        }
        const scanDurationMs = Date.now() - startMs;

        // Transform patterns to include projectIds and per-project event counts
        const transformedPatterns = detectedPatterns.map(pattern => {
          const projectIds = pattern.affectedProjects || [];
          const events = pattern.events || [];

          const projectEventCounts = {};
          for (const projectId of projectIds) {
            projectEventCounts[projectId] = 0;
          }
          for (const event of events) {
            const eventProjectId = event.projectId || event.project;
            if (eventProjectId && projectEventCounts.hasOwnProperty(eventProjectId)) {
              projectEventCounts[eventProjectId]++;
            }
          }

          return {
            patternId: pattern.patternId,
            detectedAt: pattern.detectedAt,
            eventType: pattern.eventType,
            projectIds,
            projectEventCounts,
            confidence: pattern.confidence,
            windowMs: pattern.windowMs,
            eventCount: events.length,
          };
        });

        json(res, {
          ok: true,
          patterns: transformedPatterns,
          scanDurationMs,
        });
      }).catch(err => {
        log.error('Pattern scan failed', { error: err.message });
        json(res, { error: 'Failed to read request body' }, 400);
      });
      return true;
    }

    // ─── GET /api/cross-project-patterns ────────────────────────
    if (path === '/api/cross-project-patterns' && req.method === 'GET') {
      const scanner = deps.crossProjectScanner;
      if (!scanner) { json(res, { error: 'Cross-project scanner not available' }, 503); return true; }
      json(res, { findings: scanner.getFindings() });
      return true;
    }

    // ─── POST /api/cross-project-patterns/scan ───────────────────
    if (path === '/api/cross-project-patterns/scan' && req.method === 'POST') {
      if (!requireOperatorRole('cross_project_scan')) return true;
      const scanner = deps.crossProjectScanner;
      if (!scanner) { json(res, { error: 'Cross-project scanner not available' }, 503); return true; }
      scanner.scan().catch(err => log.error('Manual cross-project scan failed', { error: err.message }));
      json(res, { ok: true, status: 'scan triggered' }, 202);
      return true;
    }

    // ─── GET /api/pattern-scan/status ───────────────────────────
    if (path === '/api/pattern-scan/status' && req.method === 'GET') {
      const status = deps.getPatternScanStatus();
      json(res, status);
      return true;
    }

    // ─── Shared State API ────────────────────────────────────────

    // GET /api/shared-state/:key
    const sharedStateGetMatch = path.match(/^\/api\/shared-state\/([^/]+)$/);
    if (sharedStateGetMatch && req.method === 'GET') {
      if (!sharedStateStore) {
        json(res, { error: 'Shared state store not available' }, 503);
        return true;
      }

      const key = decodeURIComponent(sharedStateGetMatch[1]);
      try {
        const entry = sharedStateStore.get(key);
        if (!entry) {
          json(res, { error: `Key "${key}" not found` }, 404);
          return true;
        }
        json(res, {
          key: entry.key,
          value: entry.value,
          version: entry.version,
        });
      } catch (err) {
        log.error('Failed to get shared state', { key, error: err.message });
        json(res, { error: 'Internal server error' }, 500);
      }
      return true;
    }

    // PUT /api/shared-state/:key
    const sharedStatePutMatch = path.match(/^\/api\/shared-state\/([^/]+)$/);
    if (sharedStatePutMatch && req.method === 'PUT') {
      if (!sharedStateStore) {
        json(res, { error: 'Shared state store not available' }, 503);
        return true;
      }

      const key = decodeURIComponent(sharedStatePutMatch[1]);
      handleBody(req, res, body => {
        try {
          const payload = JSON.parse(body);

          if (!payload || typeof payload !== 'object') {
            json(res, { error: 'Request body must be a JSON object' }, 400);
            return;
          }

          if (!('value' in payload)) {
            json(res, { error: 'Missing required field: value' }, 400);
            return;
          }

          const { value, version } = payload;
          const agentId = requestUserId || 'anonymous';

          const opts = {};
          if (version !== undefined && version !== null) {
            opts.expectedVersion = version;
          }

          const newVersion = sharedStateStore.set(key, value, agentId, opts);
          const entry = sharedStateStore.get(key);

          json(res, {
            key: entry.key,
            value: entry.value,
            version: entry.version,
          });
        } catch (err) {
          if (err instanceof VersionConflictError) {
            json(res, {
              error: 'Version conflict',
              message: 'The shared state version changed',
              expectedVersion: err.expectedVersion,
              actualVersion: err.actualVersion,
            }, 409);
            return;
          }

          if (err instanceof SyntaxError) {
            json(res, { error: 'Invalid JSON in request body' }, 400);
            return;
          }

          log.error('Failed to set shared state', { key, error: err.message });
          json(res, { error: 'Internal server error' }, 500);
        }
      });
      return true;
    }

    // DELETE /api/shared-state/:key
    const sharedStateDeleteMatch = path.match(/^\/api\/shared-state\/([^/]+)$/);
    if (sharedStateDeleteMatch && req.method === 'DELETE') {
      if (!sharedStateStore) {
        json(res, { error: 'Shared state store not available' }, 503);
        return true;
      }

      const key = decodeURIComponent(sharedStateDeleteMatch[1]);
      handleBody(req, res, body => {
        try {
          let version = undefined;

          // Allow optional version in body for optimistic locking
          if (body && body.trim()) {
            const payload = JSON.parse(body);
            if (payload && typeof payload === 'object' && 'version' in payload) {
              version = payload.version;
            }
          }

          const agentId = requestUserId || 'anonymous';
          const opts = {};
          if (version !== undefined && version !== null) {
            opts.expectedVersion = version;
          }

          const deleted = sharedStateStore.delete(key, agentId, opts);

          if (!deleted) {
            json(res, { error: `Key "${key}" not found` }, 404);
            return;
          }

          json(res, { ok: true, key });
        } catch (err) {
          if (err instanceof VersionConflictError) {
            json(res, {
              error: 'Version conflict',
              message: 'The shared state version changed',
              expectedVersion: err.expectedVersion,
              actualVersion: err.actualVersion,
            }, 409);
            return;
          }

          if (err instanceof SyntaxError) {
            json(res, { error: 'Invalid JSON in request body' }, 400);
            return;
          }

          log.error('Failed to delete shared state', { key, error: err.message });
          json(res, { error: 'Internal server error' }, 500);
        }
      });
      return true;
    }

    return false;
  };
}

/**
 * Invoke the synchronous API router behind a final exception boundary.
 * Route handlers perform path decoding after the URL has matched; malformed
 * percent-encoding throws URIError synchronously and must be a 400 response,
 * not an uncaught exception that terminates the HTTP process.
 */
export function handleApiRequestSafely(handleApi, req, res) {
  try {
    return handleApi(req, res);
  } catch (err) {
    const malformedPath = err instanceof URIError;
    log.error('Unhandled synchronous API request error', {
      method: req.method,
      url: redactUrlForLog(req.url),
      error: err.message,
      errorType: err.constructor?.name,
    });

    if (!res.headersSent && !res.writableEnded) {
      json(res, {
        error: malformedPath ? 'Malformed URL encoding' : 'Internal server error',
      }, malformedPath ? 400 : 500);
    } else if (!res.writableEnded) {
      res.destroy?.(err);
    }
    return true;
  }
}

export function createApiServer(deps) {
  const {
    stateManager, agents, config, PORT, auth,
    rateLimiter,
    handleUserMessage, queueTurn,
    parseMentions, classifyMessage, ROUTING_MATRIX,
    recoverTasks, startHeartbeat, startWatchdog, startStrategist, reindexEmbeddings,
    startRateLimitProbe, startFallbackCleanup, stopFallbackCleanup,
    checkpointManager, recoveryCheck, mcpConnectionManager,
    agentCookies, loadAgentsConfig,
  } = deps;


  const handleApi = createHandleApi({ ...deps, thinkingAgents,
    recordIntent: recordIntent, // Explicitly use the imported recordIntent
    getPending: getPending,     // Explicitly use the imported getPending
  });

  let server;

  async function startServer() {
    const htmlPath = join(__dirname, '..', 'ui', 'public', 'index.html');

    server = createServer((req, res) => { console.log('HTTP Request:', req.method, redactUrlForLog(req.url));
      const cspNonce = randomUUID();
      applySecurityHeaders(res, cspNonce, !!req.socket?.encrypted);
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

      // ─── Liveness probe ─────────────────────────────────────────
      if (reqUrl.pathname === '/health/live') {
        json(res, { status: 'ok' });
        return;
      }

      // ─── Readiness probe ────────────────────────────────────────
      if (reqUrl.pathname === '/health/ready') {
        if (!subsystemsReady) {
          json(res, { status: 'not ready', reason: 'Subsystems not initialized' }, 503);
          return;
        }
        json(res, { status: 'ready' }, 200);
        return;
      }

      // ─── Login page ────────────────────────────────────────────
      if (reqUrl.pathname === '/login') {
        // Already authenticated? Redirect to app
        if (!auth.isEnabled() || auth.isAuthenticated(req).authenticated) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginPageHtml(auth.hasPassword(), cspNonce));
        return;
      }

      // ─── Login API (public — handles its own auth) ─────────────
      if (reqUrl.pathname === '/api/auth/login' && req.method === 'POST') {
        // Login is handled before createHandleApi(), so it must be throttled
        // here. Use a separate, stricter bucket from ordinary API traffic.
        if (rateLimiter && !rateLimiter.checkRequest(req, res, {
          scope: 'login',
          maxRequests: config.rateLimit?.loginMaxRequests || 10,
        })) return;
        let body = '';
        let received = 0;
        const onLoginData = c => {
          received += c.length;
          if (received > MAX_BODY_BYTES) {
            req.removeListener('data', onLoginData);
            json(res, { error: 'Payload too large' }, 413);
            setImmediate(() => req.destroy());
            return;
          }
          body += c;
        };
        req.on('data', onLoginData);
        req.on('end', () => {
          if (received > MAX_BODY_BYTES) return;
          try {
            const { credential } = JSON.parse(body);
            if (auth.checkCredential(credential)) {
              auth.setSessionCookie(res);
              json(res, { ok: true });
              log.info('Login successful', { ip: req.socket.remoteAddress });
            } else {
              json(res, { error: 'Invalid credential' }, 401);
              log.warn('Login failed', { ip: req.socket.remoteAddress });
            }
          } catch {
            json(res, { error: 'Invalid request body' }, 400);
          }
        });
        return;
      }

      // ─── Logout ────────────────────────────────────────────────
      if (reqUrl.pathname === '/api/auth/logout' && req.method === 'POST') {
        auth.clearSessionCookie(res);
        json(res, { ok: true });
        return;
      }

      // ─── Session Check ─────────────────────────────────────────
      if (reqUrl.pathname === '/api/auth/me' && req.method === 'GET') {
        const authResult = auth.isAuthenticated(req);
        if (authResult.authenticated) {
          const roles = config?.auth?.roles || { OPERATOR: 'operator' };
          const userRoles = config?.auth?.userRoles || {};
          const userId = authResult.userId;
          const userRole = userRoles[userId] || roles.OPERATOR;
          json(res, { ok: true, userId, userRole });
        } else {
          json(res, { ok: false, error: 'Unauthorized' }, 401);
        }
        return;
      }

      // ─── Static UI assets (css/, js/, img/) ──────────────────
      if (reqUrl.pathname.startsWith('/css/') || reqUrl.pathname.startsWith('/js/') || reqUrl.pathname.startsWith('/img/')) {
        const MIME = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
        const assetPath = join(__dirname, '..', 'ui', 'public', reqUrl.pathname);
        if (existsSync(assetPath)) {
          const mime = MIME[extname(assetPath)] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
          res.end(readFileSync(assetPath));
          return;
        }
        // Also serve uPlot static assets from node_modules
        if (reqUrl.pathname === '/css/uPlot.min.css') {
          const uplotCssPath = join(__dirname, '..', '..', 'node_modules', 'uplot', 'dist', 'uPlot.min.css');
          if (existsSync(uplotCssPath)) {
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(readFileSync(uplotCssPath));
            return;
          }
        }
        if (reqUrl.pathname === '/js/uPlot.iife.min.js') {
          const uplotJsPath = join(__dirname, '..', '..', 'node_modules', 'uplot', 'dist', 'uPlot.iife.min.js');
          if (existsSync(uplotJsPath)) {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(readFileSync(uplotJsPath));
            return;
          }
        }
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // ─── Main UI ──────────────────────────────────────────────
      if (req.url === '/' || req.url?.startsWith('/index.html') || req.url?.startsWith('/?')) {
        const urlToken = reqUrl.searchParams.get('token');

        if (auth.isEnabled() && !auth.isAuthenticated(req).authenticated) {
          // Not authenticated — redirect to login
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }

        // If they came with ?token=, set a cookie so they don't need it next time
        if (auth.isEnabled() && urlToken && auth.validate(urlToken)) {
          auth.setSessionCookie(res);
          // Redirect to clean URL (strip token from URL bar)
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }

        let html = readFileSync(htmlPath, 'utf-8');
        html = html.replace('<script type="module">', `<script type="module" nonce="${cspNonce}">`);
        if (auth.isEnabled()) {
          // Never embed the token in the page: fetch and WebSocket upgrades
          // both authenticate via the HttpOnly session cookie, which XSS
          // cannot read. Token-authenticated arrivals get a cookie minted
          // here so subsequent requests carry it.
          const sessionResult = auth.validateSession(auth.getSessionCookie(req));
          if (!sessionResult.authenticated) auth.setSessionCookie(res);
          html = html.replace('</head>',
            `<meta name="synapse-session" content="true">\n</head>`);
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
      if (req.url.startsWith('/api/') || req.url === '/metrics' || req.url.startsWith('/metrics/') || req.url === '/mcp') {
        if (handleApiRequestSafely(handleApi, req, res)) return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    // Production hardening: timeouts prevent hung connections and resource leaks
    server.keepAliveTimeout = config.server.keepAliveTimeoutMs || 65000;  // slightly > typical LB 60s
    server.headersTimeout = config.server.headersTimeoutMs || 66000;      // must be > keepAliveTimeout
    server.requestTimeout = config.server.requestTimeoutMs || 30000;      // max time for request body
    server.timeout = config.server.socketTimeoutMs || 120000;             // overall socket timeout

    connectionRegistry = new ConnectionRegistry();
    for (const timeout of disconnectTimers.values()) clearTimeout(timeout);
    disconnectTimers.clear();

    wss = new WebSocketServer({
      noServer: true,
      pingInterval: 30000,
      pingTimeout: 10000,
    });
    setWss(wss);

    // Handle WebSocket upgrades for /ws path only (delta server handles /api/dashboard/*)
    server.prependListener('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '', 'http://localhost');
      // Only handle /ws and / paths; let external handler (delta server) handle other paths
      if (url.pathname !== '/ws' && url.pathname !== '/') {
        if (externalUpgradeHandler) {
          externalUpgradeHandler(req, socket, head);
        }
        return;
      }

      // Auth applies to every upgrade path we accept — a root-path ('/')
      // connection must not bypass the check the '/ws' path enforces.
      const authResult = auth.checkUpgrade(req);
      if (!authResult.authenticated || !authResult.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      req.userId = authResult.userId;

      // Handle upgrade
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws, req) => {
      const userId = req.userId || 'default';
      const existingCleanup = disconnectTimers.get(userId);
      if (existingCleanup) {
        clearTimeout(existingCleanup);
        disconnectTimers.delete(userId);
      }
      connectionRegistry.add(userId, ws);
      
      const projects = stateManager.listProjects();
      const defaultProject = stateManager.config.defaultProject || (projects[0]?.id);
      const defaultChannel = defaultProject
        ? (stateManager.getProject(defaultProject)?.defaultChannel || 'general')
        : 'general';

      const initAgentConfig = loadAgentsConfig();
      const initConfigMap = {};
      for (const a of initAgentConfig.agents) initConfigMap[a.id] = a;
      ws.send(JSON.stringify({
        type: 'init', projects,
        agents: Object.entries(agents).map(([k, v]) => ({
          id: k, name: v.name, color: v.color, model: v.model,
          displayModel: initConfigMap[k]?.displayModel || null,
          status: v._status, provider: v.provider,
        })),
        activeProject: defaultProject || null, activeChannel: defaultChannel,
        userId,
        userRole: config.auth.userRoles[userId] || config.auth.roles.OPERATOR,
        operatorName: config.operator?.name || 'operator',
      }));

      if (defaultProject) {
        clientSubs.set(ws, { project: defaultProject, channel: defaultChannel, userId });
        ws.send(JSON.stringify({ type: 'channel_history', messages: stateManager.getMessages(defaultProject, defaultChannel, config.orchestrator.defaultMessageLimit) }));
        sendThinkingState(ws, defaultProject, defaultChannel);
      }

      ws.on('message', async (data) => {
        try {
          const parsed = JSON.parse(data.toString());

          if (parsed.type === 'subscribe') {
            // Block #24 — clients can subscribe with a partial payload (e.g.
            // dashboard reconnect before it knows which channel to attach to).
            // Without a project + channel, _transcriptPath does
            // `join(undefined, ...)` and throws "path argument must be string".
            // Guard here: store whatever they sent for future filtering, but
            // only fetch channel_history when both fields are present.
            clientSubs.set(ws, { project: parsed.project, channel: parsed.channel, userId });
            if (parsed.project && parsed.channel) {
              ws.send(JSON.stringify({ type: 'channel_history', messages: stateManager.getMessages(parsed.project, parsed.channel, config.orchestrator.defaultMessageLimit) }));
              sendThinkingState(ws, parsed.project, parsed.channel);
            } else {
              ws.send(JSON.stringify({ type: 'channel_history', messages: [] }));
            }
          } else if (parsed.type === 'user_message' && parsed.content) {
            const sub = clientSubs.get(ws);
            const projectId = parsed.project || sub?.project;
            const channelId = parsed.channel || sub?.channel;
            if (!projectId || !channelId) return;
            if (typeof parsed.content !== 'string' || parsed.content.length > 50000) {
              ws.send(JSON.stringify({ type: 'error', message: 'Message too long (max 50KB)' }));
              return;
            }
            const wsThreadMeta = {
              replyTo: parsed.replyTo || null,
              replyToThreadId: parsed.replyToThreadId || null,
              mode: parsed.mode || null,
            };
            let speaker = config.operator?.name || 'operator';
            // Agent-originated messages (via the MCP back-channel) may carry a
            // speaker that names a registered agent — attribute to the agent,
            // not the operator. Unknown speaker values fall back to operator
            // so the field can't be used to impersonate arbitrary names.
            if (parsed.speaker && agents[parsed.speaker]) {
              speaker = agents[parsed.speaker].name || parsed.speaker;
            }
            queueTurn(projectId, channelId, userId, () =>
              handleUserMessage(parsed.content, projectId, channelId, wsThreadMeta, speaker, userId)
            );
          } else if (parsed.type === 'classify_preview' && parsed.content) {
            const mentioned = parseMentions(parsed.content, agents);
            const classification = classifyMessage(parsed.content, mentioned, agents);
            const route = ROUTING_MATRIX[classification.type];
            ws.send(JSON.stringify({
              type: 'classify_preview', classification: classification.type,
              confidence: classification.confidence,
              suggestedMode: route?.mode === 'execution' ? 'solo' : (route?.mode || 'solo'),
            }));
          } else if (parsed.type === 'create_project') {
            if (!parsed.id) return;
            stateManager.createProject(parsed.id, { displayName: parsed.displayName, projectDir: parsed.projectDir, mode: parsed.mode });
            broadcast(
              { type: 'project_created', project: { id: parsed.id, ...stateManager.getProject(parsed.id) } },
              { userId }
            );
          } else if (parsed.type === 'create_channel') {
            if (!parsed.project || !parsed.id) return;
            stateManager.createChannel(parsed.project, parsed.id);
            broadcast(
              { type: 'channel_created', project: parsed.project, channel: parsed.id },
              { userId }
            );
          }
        } catch (e) {
          // Include the message type + a stack snippet so future occurrences
          // are diagnosable. Previously this swallowed the failure with a
          // generic "path argument must be a string" with no clue what kind
          // of WS message triggered the path.join with undefined.
          let parsedType = '<unparsed>';
          try { parsedType = JSON.parse(data.toString())?.type || '<no-type>'; } catch {}
          const stack = (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : null);
          log.error('WebSocket message error', { error: e.message || String(e), messageType: parsedType, stack });
        }
      });

      ws.on('close', () => {
        clientSubs.delete(ws);
        connectionRegistry.remove(userId, ws);
        if (!connectionRegistry.hasConnections(userId)) {
          const timeout = setTimeout(() => {
            disconnectTimers.delete(userId);
          }, DISCONNECT_GRACE_MS);
          disconnectTimers.set(userId, timeout);
        }
      });
    });

    // Bridge EventBus operator:action events to WebSocket broadcasts
    // This ensures direct EventBus emissions also reach WebSocket clients (not just SSE)
    if (deps.events) {
      deps.events.on('operator:action', (data) => {
        if (!data) return;

        // Map actionType to steering event subtype
        const actionType = data.actionType || data.action_type;
        const subtype = STEERING_EVENT_TYPES[actionType] || `steering:${actionType}`;

        broadcast({
          type: 'steering:action',
          subtype,
          actionType,
          correlationId: data.correlationId || data.dispatchId || data.traceId,
          payloadSummary: {
            operatorId: data.operatorId || data.operator_id,
            campaignId: data.campaignId,
            dispatchId: data.dispatchId,
            provider: data.provider,
            agentId: data.agentId,
            sourceDispatchId: data.sourceDispatchId,
            targetDispatchId: data.targetDispatchId,
            status: data.status,
            ...(data.data || {}),
          },
          serverTimestamp: data.eventTs || new Date().toISOString(),
        });
      });

      // Bridge cost_updated events to WebSocket broadcasts for real-time dashboard updates
      if (deps.events) {
        deps.events.on('cost_updated', (data) => {
          if (!data) return;

          broadcast({
            type: 'cost_updated',
            agentId: data.agentId,
            provider: data.provider,
            costUsd: data.costUsd,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            campaignId: data.campaignId,
            timestamp: data.timestamp || new Date().toISOString(),
          });
        });
      }
    }

    server.listen(PORT, async () => {
      const projects = stateManager.listProjects();
      if (auth.isEnabled()) {
        log.info('server started', { url: `http://localhost:${PORT}`, auth: 'enabled', loginPage: '/login', password: auth.hasPassword() });
      } else {
        log.info('server started', { url: `http://localhost:${PORT}`, auth: 'disabled' });
      }
      log.info('projects loaded', { projects: projects.length > 0 ? projects.map(p => p.id) : [] });
      log.info('data directory', { path: stateManager.baseDir });

      // Initialize checkpoint directories for all projects
      if (checkpointManager) {
        for (const project of projects) {
          try {
            checkpointManager.init(project.id);
          } catch (err) {
            log.warn('Checkpoint directory init failed', { projectId: project.id, error: err.message });
          }
        }
      }

      // Run campaign recovery check
      if (recoveryCheck) {
        try {
          const recoveryResults = await recoveryCheck({
            stateManager,
            campaignManager: deps.campaignManager,
            eventBus: deps.events,
            config: {
              skipRecovery: config.recovery?.skipCampaignRecovery,
              campaignStaleMs: config.recovery?.campaignStaleMs,
              baseDir: stateManager.baseDir,
            },
          });
          log.info('Campaign recovery complete', {
            scanned: recoveryResults.scanned,
            recovered: recoveryResults.recovered.length,
            needsReview: recoveryResults.needsReview.length,
            skipped: recoveryResults.skipped,
            clean: recoveryResults.clean,
          });
        } catch (err) {
          log.error('Campaign recovery failed', { error: err.message });
        }
      }

      recoverTasks();
      startHeartbeat();
      startWatchdog();
      startStrategist();
      // if (startRateLimitProbe) startRateLimitProbe(); // DISABLED: probe causes SIGTERM burst — diagnose first
      if (startFallbackCleanup) startFallbackCleanup();
      if (deps.webhookDispatcher) deps.webhookDispatcher.start();
      if (deps.schedulerLoop) deps.schedulerLoop.start();
      if (deps.triggerLoop) deps.triggerLoop.start();
      if (deps.workflowLoop) deps.workflowLoop.start();
      reindexEmbeddings().catch(err => log.error('startup reindex failed', { error: err.message }));

      // Start error pattern constraint auto-expiry periodic check
      if (deps.errorPatternConstraintStore && deps.timelineStore) {
        const expiryCheckInterval = config.errorPatternConstraints?.expiryCheckIntervalMs || 60000; // Default: 1 minute
        const expiryCheckTimer = setInterval(() => {
          try {
            const expiredConstraints = deps.errorPatternConstraintStore.pruneExpired();
            if (expiredConstraints && expiredConstraints.length > 0) {
              log.info('Auto-expired error pattern constraints', {
                count: expiredConstraints.length,
                constraintIds: expiredConstraints.slice(0, 10).map(c => c.id),
              });

              // Emit ERROR_CONSTRAINT_EXPIRED timeline event for each expired constraint
              for (const constraint of expiredConstraints) {
                try {
                  deps.timelineStore.appendRoutingEvent({
                    id: `constraint-expired-${randomUUID()}`,
                    type: 'error_constraint_expired',
                    timestamp: new Date().toISOString(),
                    summary: `Error pattern constraint expired: ${constraint.errorCategory || 'unknown'} for agent ${constraint.agentId}`,
                    correlationKeys: {
                      agentId: constraint.agentId,
                    },
                    data: {
                      constraintId: constraint.id,
                      agentId: constraint.agentId,
                      errorCategory: constraint.errorCategory,
                      createdAt: constraint.createdAt,
                      expiresAt: constraint.expiresAt,
                    },
                  });
                } catch (tlErr) {
                  log.error('Failed to emit expiry timeline event', {
                    constraintId: constraint.id,
                    error: tlErr.message,
                  });
                }
              }
            }
          } catch (err) {
            log.error('Error pattern constraint auto-expiry check failed', { error: err.message });
          }
        }, expiryCheckInterval);

        // Store timer reference for cleanup on shutdown
        if (!server._errorPatternExpiryTimer) {
          server._errorPatternExpiryTimer = expiryCheckTimer;
        }

        log.info('Error pattern constraint auto-expiry check started', { intervalMs: expiryCheckInterval });
      }

      subsystemsReady = true;
    });

    return server;
  }

  let externalUpgradeHandler = null; return { setUpgradeHandler: (h) => { externalUpgradeHandler = h; },
    startServer,
    getServer: () => server,
    close: () => new Promise((resolve) => {
      // server.close() only reaps IDLE connections; the four long-lived SSE
      // streams (operator/telemetry, res.setTimeout(0)) kept it waiting
      // forever, stalling shutdown at 'API server close' before stores got
      // closed or last-shutdown.json written — and the shutdown runner's
      // single-run idempotency meant a second SIGTERM returned the same hung
      // promise, leaving SIGKILL as the only exit. Destroy everything, and
      // keep an unref'd fallback so shutdown can never wedge here.
      const fallback = setTimeout(() => resolve(), 5000);
      if (typeof fallback.unref === 'function') fallback.unref();
      server.close(() => { clearTimeout(fallback); resolve(); });
      server.closeAllConnections?.();
    })
  };
}

/**
 * Cursor-based pagination utilities for audit events API.
 * Encodes/decodes cursors as base64 JSON of { timestamp, id } for stable pagination.
 */
export { encodeCursor, decodeCursor };
