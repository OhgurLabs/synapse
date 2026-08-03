/**
 * Report Templates — architecture scaffold
 *
 * This module defines the template contract and shared utilities that turn
 * TimelineStore query results into structured report objects. Concrete
 * templates (e.g., activity-summary, incident-timeline) plug into this layer by
 * implementing the interface below. The goal is to keep data fetching,
 * validation, and trace reconstruction consistent across templates while
 * letting each template focus purely on aggregation logic.
 */

import { createLogger } from '../logger.js';
import { buildErrorChain } from './trace-builder.js';

const log = createLogger('report-templates');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed date range for exports (90 days safeguard). */
export const MAX_TEMPLATE_RANGE_DAYS = 90;

/** Default page size when walking TimelineStore.query() pagination. */
export const TEMPLATE_QUERY_PAGE_SIZE = 500;

/** Hard cap on events a template should process to protect latency/heap. */
export const TEMPLATE_MAX_EVENTS = 50_000;

// ---------------------------------------------------------------------------
// Type contracts (JSDoc to keep runtime JS compatible)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TemplateParam
 * @property {string} name - Canonical parameter name (e.g., "startDate").
 * @property {boolean} [required=false] - Whether caller must provide it.
 * @property {'string'|'number'|'boolean'|'enum'|'date'} [type='string'] - Basic type hint.
 * @property {Array<string>} [enumValues] - Allowed values when type==='enum'.
 * @property {string} [description] - Human readable description for GET /templates.
 * @property {any} [defaultValue] - Optional default applied during normalization.
 */

/**
 * @typedef {Object} TemplateMetadata
 * @property {string} id - Stable template identifier (kebab-case).
 * @property {string} name - Display name for operators.
 * @property {string} description - One-line description of the output.
 * @property {TemplateParam[]} requiredParams - Required parameters.
 * @property {TemplateParam[]} [optionalParams] - Optional parameters.
 * @property {string[]} [tags] - Optional feature tags (e.g., ['pdf', 'csv']).
 */

/**
 * @typedef {Object} ReportSection
 * @property {string} id - Unique section id (e.g., 'executive-summary').
 * @property {string} title - Section title for downstream formatters.
 * @property {string} [description] - Optional helper copy.
 * @property {Object|Array|string|number|null} data - Structured payload the
 *   formatter can render verbatim (no display logic here).
 */

/**
 * @typedef {Object} ReportOutput
 * @property {Object} summary - High-level metrics / rollups.
 * @property {Array<Object>} [breakdown] - Tabular per-entity slices (agents, campaigns, etc.).
 * @property {ReportSection[]} sections - Ordered, formatter-friendly sections.
 * @property {Object} meta - Template + query metadata (id, generatedAt, range, scope).
 */

/**
 * @typedef {Object} TemplateContext
 * @property {Array<Object>} events - Flattened events returned by TimelineStore.query().
 * @property {Object} timelineStore - TimelineStore instance (used for follow-up queries).
 * @property {Object} [campaignManager] - Optional campaign manager for lookups.
 * @property {Object} [taskManager] - Optional task manager for task detail hydration.
 * @property {Object} params - Normalized, validated template parameters.
 * @property {Array<Object>} [errorChains] - Optional error propagation chains from trace-builder.
 */

/**
 * @interface
 * @property {TemplateMetadata} metadata - Declarative template info for discovery.
 * @property {(params:Object)=>{params:Object, issues?:string[]}} validate -
 *   Validate + normalize caller-supplied params; throw TemplateValidationError on fatal issues.
 * @property {(context:TemplateContext)=>Promise<ReportOutput>|ReportOutput} generate -
 *   Build structured report sections from events + context.
 */
export class IReportTemplate {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TemplateValidationError extends Error {
  constructor(message, issues = []) {
    const fullMessage = issues && issues.length > 0
      ? `${message}: ${issues.join('; ')}`
      : message;
    super(fullMessage);
    this.name = 'TemplateValidationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Param normalization & validation helpers
// ---------------------------------------------------------------------------

function toIso(dateLike) {
  if (!dateLike) return null;
  const parsed = new Date(dateLike);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function daysBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const diffMs = Date.parse(endIso) - Date.parse(startIso);
  return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * Normalize + validate common template parameters.
 * - Ensures ISO8601 strings
 * - Enforces max range (90 days)
 * - Supports optional scope/campaign filters for TimelineStore.query()
 *
 * @param {Object} rawParams
 * @param {TemplateParam[]} [required=[]]
 * @param {TemplateParam[]} [optional=[]]
 * @returns {{params:Object, issues:string[]}}
 */
export function validateTemplateParams(rawParams = {}, required = [], optional = []) {
  const issues = [];

  const startDate = toIso(rawParams.startDate || rawParams.start_time);
  const endDate = toIso(rawParams.endDate || rawParams.end_time || new Date().toISOString());

  if (!startDate) {
    issues.push('startDate is required and must be a valid date');
  }
  if (!endDate) {
    issues.push('endDate is required and must be a valid date');
  }

  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) {
    issues.push('startDate must be before endDate');
  }

  const rangeDays = daysBetween(startDate, endDate);
  if (rangeDays !== null && rangeDays > MAX_TEMPLATE_RANGE_DAYS) {
    issues.push(`Date range must be <= ${MAX_TEMPLATE_RANGE_DAYS} days`);
  }

  // Validate required/optional specs beyond dates
  const specs = [...required, ...optional];
  for (const spec of specs) {
    const value = rawParams[spec.name];
    if (spec.required && (value === undefined || value === null || value === '')) {
      issues.push(`${spec.name} is required`);
      continue;
    }

    if (value !== undefined && spec.type === 'enum' && spec.enumValues && !spec.enumValues.includes(value)) {
      issues.push(`${spec.name} must be one of: ${spec.enumValues.join(', ')}`);
    }
  }

  if (issues.length) {
    throw new TemplateValidationError('Invalid template parameters', issues);
  }

  const normalized = {
    startDate,
    endDate,
    scope: rawParams.scope || 'system',
    campaignId: rawParams.campaignId || rawParams.campaign_id || null,
    template: rawParams.template || null,
  };

  for (const spec of specs) {
    if (normalized[spec.name] === undefined && spec.defaultValue !== undefined) {
      normalized[spec.name] = spec.defaultValue;
    } else if (rawParams[spec.name] !== undefined && normalized[spec.name] === undefined) {
      normalized[spec.name] = rawParams[spec.name];
    }
  }

  return { params: normalized, issues: [] };
}

// ---------------------------------------------------------------------------
// TimelineStore helpers for templates
// ---------------------------------------------------------------------------

/**
 * Translate normalized params into TimelineStore.query() filters.
 * This keeps filtering logic consistent across templates and ensures we always
 * pass since/until for server-side pruning while letting query() apply its
 * per-table filtering internally.
 *
 * @param {Object} params - Normalized params from validateTemplateParams
 * @returns {Object} filters suitable for TimelineStore.query()
 */
export function buildTimelineFilters(params) {
  const filters = {
    since: params.startDate,
    until: params.endDate,
    limit: TEMPLATE_QUERY_PAGE_SIZE,
    offset: 0,
  };

  if (params.campaignId) filters.campaignId = params.campaignId;

  // Accept scope shorthand "campaign:abc", "agent:alice", "provider:openai"
  if (params.scope && params.scope !== 'system') {
    const parts = String(params.scope).split(':');
    if (parts.length === 2) {
      const [scopeType, scopeValue] = parts;
      const map = {
        campaign: 'campaignId',
        agent: 'agentId',
        provider: 'provider',
        dispatch: 'dispatchId',
        trace: 'traceId',
        task: 'taskId',
        subtask: 'subtaskId',
      };
      const key = map[scopeType];
      if (key) filters[key] = scopeValue;
    }
  }

  return filters;
}

/**
 * Fetch timeline events using TimelineStore.query() with pagination safeguards.
 * This is intentionally side-effect free; it leaves mutation/aggregation to
 * templates while guaranteeing consistent ordering and safety limits.
 *
 * @param {Object} timelineStore
 * @param {Object} filters - Output of buildTimelineFilters
 * @param {Object} [options]
 * @param {number} [options.maxEvents=TEMPLATE_MAX_EVENTS]
 * @returns {Array<Object>} events sorted newest → oldest
 */
export function fetchEventsForTemplate(timelineStore, filters, options = {}) {
  if (!timelineStore || typeof timelineStore.query !== 'function') {
    throw new Error('timelineStore with query() is required');
  }

  const maxEvents = options.maxEvents || TEMPLATE_MAX_EVENTS;
  const pageSize = filters.limit || TEMPLATE_QUERY_PAGE_SIZE;

  const events = [];
  const queryFilters = { ...filters };
  let hasMore = true;

  while (hasMore && events.length < maxEvents) {
    const result = timelineStore.query(queryFilters) || {};
    const page = result.events || [];
    events.push(...page);

    hasMore = page.length === pageSize;
    queryFilters.offset = (queryFilters.offset || 0) + pageSize;
  }

  if (events.length >= maxEvents) {
    log.warn('Template events truncated at maxEvents', { maxEvents, scope: filters.scope });
  }

  return events;
}

/**
 * Helper for templates that need failure propagation context. Uses the
 * existing trace-builder implementation to produce error chains while
 * shielding templates from its API surface.
 *
 * @param {string|null} campaignId
 * @param {Object} timelineStore
 * @returns {Array<Object>} error chains (may be empty)
 */
export function loadErrorChainsForTemplate(campaignId, timelineStore) {
  if (!campaignId) return [];
  try {
    return buildErrorChain(campaignId, timelineStore) || [];
  } catch (err) {
    log.warn('Failed to load error chains for template', { campaignId, error: err.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Base template helper
// ---------------------------------------------------------------------------

/**
 * Base class implementers can extend to get default param validation and
 * metadata wiring. Concrete templates should override generate(context).
 */
export class BaseReportTemplate {
  constructor(metadata) {
    if (!metadata || !metadata.id) {
      throw new Error('Template metadata with stable id is required');
    }
    this.metadata = {
      requiredParams: [],
      optionalParams: [],
      ...metadata,
    };
  }

  validate(params = {}) {
    return validateTemplateParams(
      params,
      this.metadata.requiredParams,
      this.metadata.optionalParams
    );
  }

  // eslint-disable-next-line class-methods-use-this
  async generate() {
    throw new Error('generate() must be implemented by template');
  }
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

/**
 * Central registry for report templates. Supports register/get/list operations.
 * Templates are registered at startup; the API layer calls list() for the
 * GET /api/audit/export/templates endpoint and get()+generate() for POST.
 */
export class TemplateRegistry {
  constructor() {
    this._templates = new Map();
  }

  /**
   * Register a template instance (must satisfy the IReportTemplate contract).
   * @param {BaseReportTemplate} template
   */
  register(template) {
    if (!template || !template.metadata || !template.metadata.id) {
      throw new Error('Template must have metadata.id');
    }
    if (typeof template.validate !== 'function' || typeof template.generate !== 'function') {
      throw new Error('Template must implement validate() and generate()');
    }
    this._templates.set(template.metadata.id, template);
    log.info('Template registered', { id: template.metadata.id });
  }

  /**
   * Retrieve a template by id.
   * @param {string} id
   * @returns {BaseReportTemplate|undefined}
   */
  get(id) {
    return this._templates.get(id);
  }

  /**
   * List metadata for all registered templates (used by GET /api/audit/export/templates).
   * @returns {TemplateMetadata[]}
   */
  list() {
    return Array.from(this._templates.values()).map(t => t.metadata);
  }

  /**
   * Validate params, fetch events, and run a template's generate() in one call.
   * This is the primary entry point used by the POST /api/audit/export handler.
   *
   * @param {string} templateId
   * @param {Object} rawParams - Caller-supplied parameters (startDate, endDate, etc.)
   * @param {Object} deps - { timelineStore, campaignManager?, taskManager? }
   * @returns {Promise<ReportOutput>}
   */
  async invoke(templateId, rawParams, deps = {}) {
    const template = this.get(templateId);
    if (!template) {
      throw new TemplateValidationError(`Unknown template: ${templateId}`);
    }

    const { timelineStore } = deps;
    if (!timelineStore) {
      throw new Error('timelineStore is required');
    }

    // 1. Validate + normalize params
    const { params } = template.validate(rawParams);

    // 2. Build filters and fetch events
    const filters = buildTimelineFilters(params);
    const events = fetchEventsForTemplate(timelineStore, filters);

    // 3. Optionally load error chains
    const errorChains = loadErrorChainsForTemplate(params.campaignId, timelineStore);

    // 4. Build context and delegate to template
    const context = {
      events,
      timelineStore,
      campaignManager: deps.campaignManager || null,
      taskManager: deps.taskManager || null,
      params,
      errorChains,
    };

    const startMs = Date.now();
    const report = await template.generate(context);
    const durationMs = Date.now() - startMs;

    log.info('Template report generated', { templateId, events: events.length, durationMs });
    return report;
  }
}

// ---------------------------------------------------------------------------
// Report output factory
// ---------------------------------------------------------------------------

/**
 * Lightweight helper to assemble the standard report envelope. Templates are
 * free to add additional keys, but the returned shape should remain stable for
 * downstream formatters (JSON, CSV, PDF).
 */
export function buildReportOutput({
  templateId,
  summary = {},
  breakdown = [],
  sections = [],
  meta = {},
}) {
  return {
    summary,
    breakdown,
    sections,
    meta: {
      templateId,
      generatedAt: new Date().toISOString(),
      ...meta,
    },
  };
}

// ---------------------------------------------------------------------------
// Template initialization
// ---------------------------------------------------------------------------

/**
 * Initialize and register all built-in report templates.
 * Call this at application startup to make templates available.
 *
 * @param {TemplateRegistry} registry
 * @returns {TemplateRegistry}
 */
export function initializeReportTemplates(registry) {
  // Register Activity Summary template
  registry.register(new ActivitySummaryTemplate());

  // Register Incident Timeline template
  registry.register(new IncidentTimelineTemplate());

  log.info('Report templates initialized', {
    registered: registry.list().map(t => t.id),
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Activity Summary Template
// ---------------------------------------------------------------------------

/**
 * Activity Summary Template — generates executive summary with:
 * - Total events, active agents, date range
 * - Per-agent breakdown (dispatches, success/failure rates from routing_events.outcome)
 * - Top errors from anomaly_events
 * - Decision audit trail excerpts (selected_agent, selection_reason from routing_events)
 */
export class ActivitySummaryTemplate extends BaseReportTemplate {
  constructor() {
    super({
      id: 'activity-summary',
      name: 'Activity Summary',
      description: 'Executive summary with per-agent activity breakdown and decision audit trail',
      requiredParams: [
        { name: 'startDate', type: 'date', required: true, description: 'Start of date range (ISO 8601)' },
        { name: 'endDate', type: 'date', required: true, description: 'End of date range (ISO 8601)' },
      ],
      optionalParams: [
        { name: 'campaignId', type: 'string', description: 'Filter to specific campaign' },
        { name: 'scope', type: 'string', description: 'Scope filter (system, campaign:xxx, agent:xxx)' },
        { name: 'limit', type: 'number', defaultValue: 50, description: 'Max decision trail entries' },
      ],
      tags: ['pdf', 'csv', 'json'],
    });
  }

  async generate(context) {
    const { events, params } = context;

    // Aggregate executive summary stats
    const summary = this.computeExecutiveSummary(events);

    // Compute per-agent breakdown with success/failure rates
    const agentBreakdown = this.computeAgentBreakdown(events);

    // Extract top errors from anomaly events
    const topErrors = this.computeTopErrors(events);

    // Extract decision audit trail excerpts
    const decisionTrail = this.computeDecisionTrail(events, params.limit);

    return buildReportOutput({
      templateId: this.metadata.id,
      summary,
      breakdown: agentBreakdown,
      sections: [
        {
          id: 'executive-summary',
          title: 'Executive Summary',
          data: summary,
        },
        {
          id: 'agent-breakdown',
          title: 'Per-Agent Activity Breakdown',
          data: agentBreakdown,
        },
        {
          id: 'top-errors',
          title: 'Top Errors',
          data: topErrors,
        },
        {
          id: 'decision-trail',
          title: 'Decision Audit Trail',
          description: 'Key routing decisions with selection reasoning',
          data: decisionTrail,
        },
      ],
      meta: {
        eventCount: events.length,
        dateRange: { start: params.startDate, end: params.endDate },
        scope: params.scope,
        campaignId: params.campaignId,
      },
    });
  }

  computeExecutiveSummary(events) {
    if (!events || events.length === 0) {
      return {
        totalEvents: 0,
        activeAgents: 0,
        dateRange: { start: null, end: null },
        eventTypes: {},
      };
    }

    const agentIds = new Set();
    const eventTypes = {};
    let earliest = null;
    let latest = null;

    for (const event of events) {
      // Track active agents - handle both normalized and raw field names
      const agentId = event.agentId || event.agent_id;
      const selectedAgent = event.selectedAgent || event.selected_agent;
      
      if (agentId) agentIds.add(agentId);
      if (selectedAgent) agentIds.add(selectedAgent);

      // Count event types
      const eventType = event.type || event.event_type || 'unknown';
      eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

      // Track date range
      const eventTs = event.event_ts || event.eventTs || event.timestamp;
      if (eventTs) {
        const ts = new Date(eventTs).getTime();
        if (!earliest || ts < earliest) earliest = eventTs;
        if (!latest || ts > latest) latest = eventTs;
      }
    }

    return {
      totalEvents: events.length,
      activeAgents: agentIds.size,
      agents: Array.from(agentIds),
      dateRange: {
        start: earliest,
        end: latest,
        durationHours: earliest && latest
          ? (new Date(latest).getTime() - new Date(earliest).getTime()) / (1000 * 60 * 60)
          : 0,
      },
      eventTypes,
    };
  }

  computeAgentBreakdown(events) {
    const agentStats = new Map();

    for (const event of events) {
      // Handle both normalized and raw field names
      const agentId = event.selectedAgent || event.selected_agent || event.agentId || event.agent_id;
      if (!agentId) continue;

      if (!agentStats.has(agentId)) {
        agentStats.set(agentId, {
          agentId,
          dispatches: 0,
          successes: 0,
          failures: 0,
          partials: 0,
          other: 0,
        });
      }

      const stats = agentStats.get(agentId);
      stats.dispatches++;

      // Extract outcome from event_data JSON or direct outcome field
      let outcome = null;
      if (event.outcome) {
        outcome = event.outcome;
      } else if (event.event_data) {
        try {
          const eventData = typeof event.event_data === 'string'
            ? JSON.parse(event.event_data)
            : event.event_data;
          outcome = eventData.outcome || null;
        } catch {
          // Ignore parse errors
        }
      } else if (event.data) {
        try {
          const eventData = typeof event.data === 'string'
            ? JSON.parse(event.data)
            : event.data;
          outcome = eventData.outcome || null;
        } catch {
          // Ignore parse errors
        }
      }

      if (outcome === 'success') {
        stats.successes++;
      } else if (outcome === 'failure') {
        stats.failures++;
      } else if (outcome === 'partial') {
        stats.partials++;
      } else {
        stats.other++;
      }
    }

    const breakdown = Array.from(agentStats.values()).map(stats => ({
      agentId: stats.agentId,
      dispatches: stats.dispatches,
      outcomes: {
        success: stats.successes,
        failure: stats.failures,
        partial: stats.partials,
        other: stats.other,
      },
      successRate: stats.dispatches > 0 ? stats.successes / stats.dispatches : null,
      failureRate: stats.dispatches > 0 ? stats.failures / stats.dispatches : null,
    }));

    // Sort by dispatches descending
    breakdown.sort((a, b) => b.dispatches - a.dispatches);

    return breakdown;
  }

  computeTopErrors(events, limit = 10) {
    const anomalyEvents = events.filter(e => {
      const type = e.type || e.event_type;
      return type === 'anomaly' || type === 'anomaly_alert' || type === 'anomaly_events';
    });

    // Group by anomaly type and severity
    const errorGroups = new Map();

    for (const event of anomalyEvents) {
      const anomalyType = event.anomaly_type || event.type || 'unknown';
      const severity = event.severity || 'unknown';
      const key = `${anomalyType}:${severity}`;

      if (!errorGroups.has(key)) {
        errorGroups.set(key, {
          anomalyType,
          severity,
          count: 0,
          events: [],
        });
      }

      const group = errorGroups.get(key);
      group.count++;
      group.events.push({
        timestamp: event.event_ts || event.eventTs,
        campaignId: event.campaign_id || event.campaignId,
        detail: event.detail || event.event_data,
      });
    }

    const topErrors = Array.from(errorGroups.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map(group => ({
        anomalyType: group.anomalyType,
        severity: group.severity,
        count: group.count,
        recentEvents: group.events.slice(0, 3),
      }));

    return topErrors;
  }

  computeDecisionTrail(events, limit = 50) {
    const routingEvents = events.filter(e => {
      const type = e.type || e.event_type;
      return type === 'dispatch' || type === 'routing' || type === 'routing_events';
    });

    // Sort by timestamp descending (most recent first)
    routingEvents.sort((a, b) => {
      const tsA = new Date(a.event_ts || a.eventTs || 0).getTime();
      const tsB = new Date(b.event_ts || b.eventTs || 0).getTime();
      return tsB - tsA;
    });

    const trail = routingEvents.slice(0, limit).map(event => {
      // Handle both normalized and raw field names
      const eventData = event.data || event.event_data || {};
      const selectionReason = eventData.rationale || eventData.reason || 
        event.selection_reason || event.selectionReason || 
        (typeof eventData === 'object' ? JSON.stringify(eventData) : eventData);

      // Extract selected_agent from row or data field
      const selectedAgent = event.selected_agent || event.selectedAgent || 
        (event.data && typeof event.data === 'object' ? event.data.selectedAgent : null) ||
        (event.row && event.row.selected_agent ? event.row.selected_agent : null);

      return {
        timestamp: event.event_ts || event.eventTs,
        dispatchId: event.dispatch_id || event.dispatchId,
        traceId: event.trace_id || event.traceId,
        campaignId: event.campaign_id || event.campaignId,
        selectedAgent: selectedAgent,
        selectionReason: selectionReason,
        outcome: event.outcome || (typeof eventData === 'object' ? eventData.outcome : null),
      };
    });

    return trail;
  }
}


// ---------------------------------------------------------------------------
// Incident Timeline Template
// ---------------------------------------------------------------------------

/**
 * Incident Timeline Template — filters to error/failure events and produces
 * chronological incident narrative with:
 * - Error propagation events (from error_propagation_events table)
 * - Failure chains reconstructed via buildErrorChain()
 * - Agent reasoning joined from routing_events/anomaly_events via trace_id
 * - Chronological incident timeline with affected campaigns and propagation paths
 */
export class IncidentTimelineTemplate extends BaseReportTemplate {
  constructor() {
    super({
      id: 'incident-timeline',
      name: 'Incident Timeline',
      description: 'Chronological error/failure timeline with trace-linked failure chains and agent reasoning',
      requiredParams: [
        { name: 'startDate', type: 'date', required: true, description: 'Start of date range (ISO 8601)' },
        { name: 'endDate', type: 'date', required: true, description: 'End of date range (ISO 8601)' },
      ],
      optionalParams: [
        { name: 'campaignId', type: 'string', description: 'Filter to specific campaign' },
        { name: 'scope', type: 'string', description: 'Scope filter (system, campaign:xxx, agent:xxx)' },
        { name: 'limit', type: 'number', defaultValue: 100, description: 'Max incident events' },
      ],
      tags: ['pdf', 'csv', 'json'],
    });
  }

  async generate(context) {
    const { events, params, timelineStore, errorChains } = context;

    // Filter events to error_propagation type
    const errorPropagationEvents = this.filterErrorPropagationEvents(events);

    // Get error chains (pre-loaded from context or build from events)
    const chains = errorChains && errorChains.length > 0
      ? errorChains
      : this.buildErrorChainsFromEvents(errorPropagationEvents);

    // Build incident records by joining with routing/anomaly events via trace_id
    const incidents = await this.buildIncidents(
      errorPropagationEvents,
      chains,
      events,
      timelineStore,
      params
    );

    // Extract affected campaigns
    const affectedCampaigns = this.extractAffectedCampaigns(incidents);

    // Build chronological timeline
    const timelineEvents = this.buildChronologicalTimeline(incidents, params.limit);

    // Compute summary stats
    const summary = {
      totalErrors: incidents.length,
      totalErrorChains: chains.length,
      affectedCampaigns: affectedCampaigns.length,
      dateRange: {
        start: params.startDate,
        end: params.endDate,
      },
      severityBreakdown: this.computeSeverityBreakdown(incidents),
    };

    return buildReportOutput({
      templateId: this.metadata.id,
      summary,
      breakdown: affectedCampaigns,
      sections: [
        {
          id: 'summary',
          title: 'Incident Summary',
          data: summary,
        },
        {
          id: 'affected-campaigns',
          title: 'Affected Campaigns',
          data: affectedCampaigns,
        },
        {
          id: 'incident-timeline',
          title: 'Chronological Incident Timeline',
          description: 'Error events with propagation chains and agent reasoning',
          data: timelineEvents,
        },
        {
          id: 'incidents',
          title: 'Detailed Incidents',
          description: 'Full incident records with failure chains',
          data: incidents,
        },
      ],
      meta: {
        eventCount: events.length,
        errorCount: incidents.length,
        dateRange: { start: params.startDate, end: params.endDate },
        scope: params.scope,
        campaignId: params.campaignId,
      },
    });
  }

  /**
   * Filter events to error_propagation type
   */
  filterErrorPropagationEvents(events) {
    return events.filter(e => {
      const type = e.type || e.event_type;
      return type === 'error_propagation' || type === 'error_propagation_events';
    });
  }

  /**
   * Build error chains from error_propagation_events using the buildErrorChain helper
   */
  buildErrorChainsFromEvents(errorPropagationEvents) {
    const chains = [];

    for (const event of errorPropagationEvents) {
      const errorChainData = this.parseErrorChain(event.error_chain);
      if (!errorChainData) continue;

      const propagationChain = this.buildPropagationPath(errorChainData.errorChain || []);

      chains.push({
        errorId: event.id,
        failedNodeId: event.failed_node_id,
        failedNodeType: this.extractNodeType(event.failed_node_id),
        failureTimestamp: event.event_ts,
        impactSummary: this.parseImpactSummary(event.impact_summary),
        propagationChain,
        errorPath: propagationChain.map(node => node.nodeId),
      });
    }

    return chains;
  }

  /**
   * Build propagation path from error chain data
   */
  buildPropagationPath(errorChain) {
    if (!errorChain || !Array.isArray(errorChain)) {
      return [];
    }

    // Sort by depth to ensure proper ordering (deepest first)
    const sortedChain = [...errorChain].sort((a, b) => {
      const depthA = this.getNodeTypeDepth(a.nodeType);
      const depthB = this.getNodeTypeDepth(b.nodeType);
      return depthB - depthA; // Descending order: subtask > task > milestone > campaign
    });

    return sortedChain.map(entry => ({
      nodeId: entry.nodeId,
      nodeType: entry.nodeType,
      status: entry.status,
      timestamp: entry.timestamp || new Date().toISOString(),
      error: entry.error || null,
    }));
  }

  /**
   * Get numeric depth for node type (higher = deeper in hierarchy)
   */
  getNodeTypeDepth(nodeType) {
    switch (nodeType) {
      case 'subtask': return 3;
      case 'task': return 2;
      case 'milestone': return 1;
      case 'campaign': return 0;
      default: return -1;
    }
  }

  /**
   * Extract node type from node ID
   */
  extractNodeType(nodeId) {
    if (!nodeId) return 'unknown';

    if (nodeId.startsWith('campaign_')) return 'campaign';
    if (nodeId.startsWith('ms_')) return 'milestone';
    if (nodeId.startsWith('task_')) return 'task';
    if (nodeId.startsWith('st_')) return 'subtask';

    return 'unknown';
  }

  /**
   * Parse error_chain JSON field
   */
  parseErrorChain(errorChain) {
    if (!errorChain) return null;

    try {
      return typeof errorChain === 'string' ? JSON.parse(errorChain) : errorChain;
    } catch {
      return null;
    }
  }

  /**
   * Parse impact_summary JSON field
   */
  parseImpactSummary(impactSummary) {
    if (!impactSummary) return {};

    try {
      return typeof impactSummary === 'string' ? JSON.parse(impactSummary) : impactSummary;
    } catch {
      return {};
    }
  }

  /**
   * Build incident records by joining error events with routing/anomaly events via trace_id
   */
  async buildIncidents(errorPropagationEvents, errorChains, allEvents, timelineStore, params) {
    const incidents = [];

    for (const errorEvent of errorPropagationEvents) {
      // traceId may be at top level or nested in data field
      const traceId = errorEvent.trace_id || errorEvent.traceId || 
                      (errorEvent.data && typeof errorEvent.data === 'object' ? errorEvent.data.traceId : null);
      const campaignId = errorEvent.campaign_id || errorEvent.campaignId ||
                         (errorEvent.data && typeof errorEvent.data === 'object' ? errorEvent.data.campaignId : null);
      const failedNodeId = errorEvent.failed_node_id || errorEvent.failedNodeId ||
                           (errorEvent.data && typeof errorEvent.data === 'object' ? errorEvent.data.failedNodeId : null);

      // Find corresponding error chain
      const errorChain = errorChains.find(
        chain => chain.failedNodeId === failedNodeId
      );

      // Find related routing events via trace_id for agent reasoning
      const agentReasoning = this.findAgentReasoningByTrace(traceId, allEvents);

      // Build incident record
      const incident = {
        errorId: errorEvent.id,
        failureTimestamp: errorEvent.event_ts || errorEvent.eventTs,
        failedNodeId,
        failedNodeType: this.extractNodeType(failedNodeId),
        campaignId,
        milestoneId: errorEvent.milestone_id || errorEvent.milestoneId,
        taskId: errorEvent.task_id || errorEvent.taskId,
        subtaskId: errorEvent.subtask_id || errorEvent.subtaskId,
        traceId,
        propagationChain: errorChain ? errorChain.propagationChain : [],
        errorPath: errorChain ? errorChain.errorPath : [failedNodeId],
        impactSummary: this.parseImpactSummary(errorEvent.impact_summary),
        agentReasoning,
        affectedCampaigns: this.extractCampaignsFromChain(errorChain),
      };

      incidents.push(incident);
    }

    // Sort by timestamp descending (most recent first)
    incidents.sort((a, b) => {
      const tsA = new Date(a.failureTimestamp || 0).getTime();
      const tsB = new Date(b.failureTimestamp || 0).getTime();
      return tsB - tsA;
    });

    return incidents;
  }

  /**
   * Find agent reasoning from routing_events and anomaly_events via trace_id
   */
  findAgentReasoningByTrace(traceId, allEvents) {
    if (!traceId) return [];

    const reasoning = [];

    // Find routing events with same trace_id
    const routingEvents = allEvents.filter(e => {
      const type = e.type || e.event_type;
      const eventTraceId = e.trace_id || e.traceId;
      return (type === 'dispatch' || type === 'routing' || type === 'routing_events')
        && eventTraceId === traceId;
    });

    for (const event of routingEvents) {
      reasoning.push({
        type: 'routing',
        timestamp: event.event_ts || event.eventTs,
        agentId: event.selected_agent || event.selectedAgent || event.agent_id || event.agentId,
        reason: event.selection_reason || event.selectionReason,
        outcome: event.outcome,
        dispatchId: event.dispatch_id || event.dispatchId,
      });
    }

    // Find anomaly events with same trace_id
    const anomalyEvents = allEvents.filter(e => {
      const type = e.type || e.event_type;
      const eventTraceId = e.trace_id || e.traceId;
      return (type === 'anomaly' || type === 'anomaly_alert' || type === 'anomaly_events')
        && eventTraceId === traceId;
    });

    for (const event of anomalyEvents) {
      reasoning.push({
        type: 'anomaly',
        timestamp: event.event_ts || event.eventTs,
        agentId: event.agent_id || event.agentId,
        severity: event.severity,
        anomalyType: event.anomaly_type || event.anomalyType,
        detail: event.detail,
      });
    }

    // Sort by timestamp
    reasoning.sort((a, b) => {
      const tsA = new Date(a.timestamp || 0).getTime();
      const tsB = new Date(b.timestamp || 0).getTime();
      return tsA - tsB;
    });

    return reasoning;
  }

  /**
   * Extract campaigns from error chain
   */
  extractCampaignsFromChain(errorChain) {
    if (!errorChain || !errorChain.propagationChain) return [];

    const campaigns = new Set();

    for (const node of errorChain.propagationChain) {
      if (node.nodeType === 'campaign') {
        campaigns.add(node.nodeId);
      }
    }

    return Array.from(campaigns);
  }

  /**
   * Extract all affected campaigns from incidents
   */
  extractAffectedCampaigns(incidents) {
    const campaignMap = new Map();

    for (const incident of incidents) {
      const campaignId = incident.campaignId;
      if (!campaignId) continue;

      if (!campaignMap.has(campaignId)) {
        campaignMap.set(campaignId, {
          campaignId,
          incidentCount: 0,
          firstFailure: null,
          lastFailure: null,
          failedNodes: new Set(),
        });
      }

      const campaign = campaignMap.get(campaignId);
      campaign.incidentCount++;

      const timestamp = new Date(incident.failureTimestamp).getTime();
      if (!campaign.firstFailure || timestamp < new Date(campaign.firstFailure).getTime()) {
        campaign.firstFailure = incident.failureTimestamp;
      }
      if (!campaign.lastFailure || timestamp > new Date(campaign.lastFailure).getTime()) {
        campaign.lastFailure = incident.failureTimestamp;
      }

      campaign.failedNodes.add(incident.failedNodeId);
    }

    // Convert to array and transform Sets
    const campaigns = Array.from(campaignMap.values()).map(c => {
      const failedNodesArray = Array.from(c.failedNodes);
      return {
        ...c,
        failedNodes: failedNodesArray,
        failedNodeCount: failedNodesArray.length,
      };
    });

    // Sort by incident count descending
    campaigns.sort((a, b) => b.incidentCount - a.incidentCount);

    return campaigns;
  }

  /**
   * Build chronological timeline of incidents
   */
  buildChronologicalTimeline(incidents, limit = 100) {
    // Incidents are already sorted by timestamp descending
    return incidents.slice(0, limit).map(incident => ({
      timestamp: incident.failureTimestamp,
      errorId: incident.errorId,
      failedNodeId: incident.failedNodeId,
      failedNodeType: incident.failedNodeType,
      campaignId: incident.campaignId,
      propagationDepth: incident.propagationChain.length,
      hasAgentReasoning: incident.agentReasoning.length > 0,
      summary: this.buildIncidentSummary(incident),
    }));
  }

  /**
   * Build human-readable incident summary
   */
  buildIncidentSummary(incident) {
    const nodeType = incident.failedNodeType || 'node';
    const nodeId = incident.failedNodeId || 'unknown';
    const chainDepth = incident.propagationChain.length;
    const reasoningCount = incident.agentReasoning.length;

    let summary = `${nodeType} ${nodeId} failed`;

    if (chainDepth > 0) {
      summary += ` (propagated through ${chainDepth} levels)`;
    }

    if (reasoningCount > 0) {
      summary += ` with ${reasoningCount} agent decision${reasoningCount > 1 ? 's' : ''}`;
    }

    return summary;
  }

  /**
   * Compute severity breakdown from incidents
   */
  computeSeverityBreakdown(incidents) {
    const breakdown = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
    };

    for (const incident of incidents) {
      // Check impact summary for severity
      const severity = incident.impactSummary?.severity || 'unknown';
      const severityKey = severity.toLowerCase();

      if (breakdown[severityKey] !== undefined) {
        breakdown[severityKey]++;
      } else {
        breakdown.unknown++;
      }
    }

    return breakdown;
  }
}
