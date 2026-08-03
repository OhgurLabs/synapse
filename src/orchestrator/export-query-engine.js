import { createLogger } from '../logger.js';

const log = createLogger('export-query-engine');

/**
 * ExportQueryEngine - Streaming query engine for audit export operations
 * 
 * Provides async generator-based streaming of events across all timeline tables
 * using LIMIT/OFFSET batching to minimize memory footprint during large exports.
 */
export class ExportQueryEngine {
  /**
   * @param {Object} options
   * @param {TimelineStore} options.timelineStore - TimelineStore instance for querying events
   * @param {number} [options.batchSize=1000] - Number of rows per batch
   */
  constructor(options = {}) {
    if (!options.timelineStore) {
      throw new TypeError('timelineStore option is required');
    }

    this.timelineStore = options.timelineStore;
    this.batchSize = options.batchSize || 1000;
  }

  /**
   * Query events across all tables with streaming support
   * @param {Object} filters - Query filters
   * @param {Object} [filters.dateRange] - Date range filter
   * @param {string} [filters.dateRange.from] - ISO timestamp lower bound
   * @param {string} [filters.dateRange.to] - ISO timestamp upper bound
   * @param {Object} [filters.scope] - Scope filter
   * @param {string} [filters.scope.type] - 'system', 'project', or 'campaign'
   * @param {string} [filters.scope.id] - ID for the scope
   * @param {string[]} [filters.types] - Event type filters (e.g., ['dispatch', 'guardrail'])
   * @param {string} [filters.campaignId] - Campaign ID filter
   * @param {string} [filters.agentId] - Agent ID filter
   * @param {string} [filters.provider] - Provider filter
   * @param {Function} [options.onProgress] - Optional progress callback(status)
   * @yields {Object[]} Batches of formatted events
   * @returns {AsyncGenerator<Object[]>} Async generator yielding event batches
   */
  async *queryEventsStream(filters = {}, options = {}) {
    const { dateRange, scope, types, campaignId, agentId, provider } = filters;
    const { onProgress } = options;

    // Resolve campaign ID from scope if not explicitly provided
    let resolvedCampaignId = campaignId;
    if (!resolvedCampaignId && scope) {
      if (scope.type === 'campaign' || scope.type === 'project') {
        resolvedCampaignId = scope.id;
      }
    }

    // Build date range parameters
    const fromDate = dateRange?.from ? new Date(dateRange.from).toISOString() : null;
    const toDate = dateRange?.to ? new Date(dateRange.to).toISOString() : null;

    // Map API type names to internal kind names
    const apiTypeToKind = {
      dispatch: 'routing',
      guardrail_outcome: 'guardrail',
      circuit_breaker: 'circuitBreaker',
      anomaly_alert: 'anomaly',
      operator_action: 'operatorAction',
      review_rejection: 'reviewRejection',
      routing_proposal: 'routingProposal',
      cost_dispatch: 'costDispatch',
      error_propagation: 'errorPropagation',
    };

    // Determine which types to query
    let typesToQuery = types;
    if (!typesToQuery || !Array.isArray(typesToQuery) || typesToQuery.length === 0) {
      // Default: query all types (use internal kind names)
      typesToQuery = ['routing', 'guardrail', 'circuitBreaker', 'anomaly', 'operatorAction', 'reviewRejection', 'routingProposal', 'costDispatch', 'errorPropagation'];
    } else {
      // Map API type names to internal kind names
      typesToQuery = typesToQuery.map(t => apiTypeToKind[t] || t);
    }

    // Track progress
    let totalProcessed = 0;
    const totalByType = await this._countEventsByFilters(
      typesToQuery, fromDate, toDate, resolvedCampaignId, agentId, provider
    );
    const totalEvents = Object.values(totalByType).reduce((sum, count) => sum + count, 0);

    // Query each type with streaming
    for (const kind of typesToQuery) {
      const count = totalByType[kind] || 0;
      if (count === 0) continue;

      log.debug('Streaming events', { kind, count, fromDate, toDate, campaignId: resolvedCampaignId });

      const batches = this._streamEventsByType(
        kind, fromDate, toDate, resolvedCampaignId, agentId, provider, onProgress
      );

      for await (const batch of batches) {
        totalProcessed += batch.length;
        if (onProgress && totalEvents > 0) {
          onProgress({
            kind,
            processed: totalProcessed,
            total: totalEvents,
            progress: Math.round((totalProcessed / totalEvents) * 100),
          });
        }
        yield batch;
      }
    }

    if (onProgress && totalEvents > 0) {
      onProgress({
        kind: 'complete',
        processed: totalProcessed,
        total: totalEvents,
        progress: 100,
      });
    }
  }

  /**
   * Count events matching the filters for all types
   * @private
   */
  async _countEventsByFilters(types, fromDate, toDate, campaignId, agentId, provider) {
    const typeMap = {
      routing: 'dispatch',
      guardrail: 'guardrail_outcome',
      circuitBreaker: 'circuit_breaker',
      anomaly: 'anomaly_alert',
      operatorAction: 'operator_action',
      reviewRejection: 'review_rejection',
      routingProposal: 'routing_proposal',
      costDispatch: 'cost_dispatch',
      errorPropagation: 'error_propagation',
    };

    const counts = {};
    if (!types || !Array.isArray(types)) {
      // Default: count all types
      for (const kind of Object.keys(typeMap)) {
        counts[kind] = await this._countEventsForKind(
          kind, fromDate, toDate, campaignId, agentId, provider
        );
        counts[typeMap[kind]] = counts[kind];
      }
    } else {
      for (const kind of types) {
        counts[kind] = await this._countEventsForKind(
          kind, fromDate, toDate, campaignId, agentId, provider
        );
        const apiType = typeMap[kind];
        if (apiType) {
          counts[apiType] = counts[kind];
        }
      }
    }
    return counts;
  }

  /**
   * Count events for a specific kind with filters
   * @private
   */
  async _countEventsForKind(kind, fromDate, toDate, campaignId, agentId, provider) {
    try {
      const stmt = this.timelineStore._stmts[kind]?.countByDateScope;
      if (!stmt) {
        log.warn('No count statement for kind', { kind });
        return 0;
      }

      // countByDateScope expects 10 params for most tables (5 pairs for the pattern ? IS NULL OR field = ?)
      // For errorPropagation: campaign_id, event_ts (5 pairs)
      // For reviewRejection/costDispatch: campaign_id, event_ts (5 pairs)
      // For others: campaign_id, event_ts, agent_id, provider (8 pairs = 16 params, but we use 10 with nulls)
      
      let result;
      if (kind === 'errorPropagation') {
        // errorPropagation: campaign_id, event_ts (5 pairs)
        result = stmt.get(fromDate, fromDate, toDate, toDate, campaignId, campaignId);
      } else if (kind === 'reviewRejection' || kind === 'costDispatch') {
        // reviewRejection/costDispatch: campaign_id, event_ts (5 pairs)
        result = stmt.get(fromDate, fromDate, toDate, toDate, campaignId, campaignId);
      } else {
        // routing, guardrail, circuitBreaker, anomaly, operatorAction, routingProposal: 
        // campaign_id, event_ts (5 pairs - agent_id and provider not in WHERE clause)
        result = stmt.get(fromDate, fromDate, toDate, toDate, campaignId, campaignId);
      }

      return result?.count || 0;
    } catch (err) {
      log.warn('Failed to count events', { kind, error: err.message });
      return 0;
    }
  }

  /**
   * Stream events for a specific kind using LIMIT/OFFSET batching
   * @private
   */
  async *_streamEventsByType(
    kind, fromDate, toDate, campaignId, agentId, provider, onProgress
  ) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const rows = await this._queryEventsForKind(
        kind, fromDate, toDate, campaignId, agentId, provider, this.batchSize, offset
      );

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      // Format and enrich events
      const formatted = rows.map(row => this.timelineStore._formatEvent(row, kind));
      const enriched = formatted.map(e => ({
        ...e,
        export_type: kind,
      }));

      yield enriched;

      offset += rows.length;
      hasMore = rows.length >= this.batchSize;

      if (onProgress && offset % 5000 === 0) {
        onProgress({
          kind,
          offset,
          batchSize: rows.length,
        });
      }
    }
  }

  /**
   * Query events for a specific kind with filters
   * @private
   */
  async _queryEventsForKind(kind, fromDate, toDate, campaignId, agentId, provider, limit, offset) {
    try {
      const stmt = this.timelineStore._stmts[kind]?.queryByDateScope;
      if (!stmt) {
        log.warn('No query statement for kind', { kind });
        return [];
      }

      // queryByDateScope expects 8 params for most tables (4 pairs + limit + offset)
      // For errorPropagation: campaign_id, event_ts (4 pairs)
      // For reviewRejection/costDispatch: campaign_id, event_ts (4 pairs)
      // For others: campaign_id, event_ts (4 pairs - agent_id and provider not in WHERE clause)
      
      const queryParams = [
        fromDate, fromDate,
        toDate, toDate,
        campaignId, campaignId,
        limit, offset
      ];

      const rows = stmt.all(...queryParams);
      return rows;
    } catch (err) {
      log.warn('Failed to query events', { kind, error: err.message });
      return [];
    }
  }

  /**
   * Get total count of events matching filters (non-streaming)
   * @param {Object} filters
   * @returns {Promise<Object>} Counts by type
   */
  async getCount(filters = {}) {
    const { dateRange, scope, types, campaignId, agentId, provider } = filters;

    let resolvedCampaignId = campaignId;
    if (!resolvedCampaignId && scope) {
      if (scope.type === 'campaign' || scope.type === 'project') {
        resolvedCampaignId = scope.id;
      }
    }

    const fromDate = dateRange?.from ? new Date(dateRange.from).toISOString() : null;
    const toDate = dateRange?.to ? new Date(dateRange.to).toISOString() : null;

    return await this._countEventsByFilters(
      types, fromDate, toDate, resolvedCampaignId, agentId, provider
    );
  }

  /**
   * Export all events to an array (legacy method, not memory-efficient for large datasets)
   * @deprecated Use queryEventsStream() instead for large exports
   * @param {Object} filters
   * @returns {Promise<Object[]>} All matching events
   */
  async exportAll(filters = {}) {
    const events = [];
    for await (const batch of this.queryEventsStream(filters)) {
      events.push(...batch);
    }
    return events;
  }

  /**
   * Verify query plan uses indexes for export queries
   * @param {Object} filters
   * @returns {Object} Query plan analysis
   */
  analyzeQueryPlan(filters = {}) {
    const { dateRange, scope, campaignId, agentId, provider } = filters;

    let resolvedCampaignId = campaignId;
    if (!resolvedCampaignId && scope) {
      if (scope.type === 'campaign' || scope.type === 'project') {
        resolvedCampaignId = scope.id;
      }
    }

    const fromDate = dateRange?.from ? new Date(dateRange.from).toISOString() : null;
    const toDate = dateRange?.to ? new Date(dateRange.to).toISOString() : null;

    const plans = {};
    const kinds = ['routing', 'guardrail', 'circuitBreaker', 'anomaly', 'operatorAction', 'reviewRejection', 'routingProposal', 'costDispatch', 'errorPropagation'];

    // Build query templates for each kind
    const queryTemplates = {
      routing: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                selected_agent, selection_reason, event_data, created_at, parent_correlation_id, root_correlation_id
        FROM routing_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      guardrail: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                outcome, rule_id, rule_name, event_data, created_at
        FROM guardrail_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      circuitBreaker: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                previous_state, new_state, failure_count, event_data, created_at
        FROM circuit_breaker_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      anomaly: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                severity, anomaly_type, detail, event_data, created_at
        FROM anomaly_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      operatorAction: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                action_type, operator_id, source_dispatch_id, target_dispatch_id, target_params, status, event_data, created_at
        FROM operator_action_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      reviewRejection: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                reviewer_id, cycle_number, findings_count, rework_status, verdict, findings, rework_context,
                event_data, created_at
        FROM review_rejection_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      routingProposal: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                proposal_id, source_type, source_recommendation_id, proposed_weights, current_weights, state, confidence, rationale,
                event_data, created_at, parent_correlation_id, root_correlation_id
        FROM routing_proposal_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      costDispatch: `
        SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                model, input_tokens, output_tokens, cost_usd, event_data, created_at, parent_correlation_id, root_correlation_id
        FROM cost_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
      errorPropagation: `
        SELECT id, idempotency_key, event_ts, campaign_id, milestone_id, task_id, subtask_id, failed_node_id,
                error_chain, impact_summary, event_data, created_at, parent_correlation_id, root_correlation_id
        FROM error_propagation_events
        WHERE (? IS NULL OR event_ts >= ?)
          AND (? IS NULL OR event_ts <= ?)
          AND (? IS NULL OR campaign_id = ?)
        ORDER BY event_ts DESC
        LIMIT ? OFFSET ?
      `,
    };

    for (const kind of kinds) {
      try {
        const sql = queryTemplates[kind];
        if (!sql) {
          plans[kind] = 'No template available';
          continue;
        }

        const planSql = `EXPLAIN QUERY PLAN ${sql}`;

        // queryByDateScope expects 8 params (4 pairs + limit + offset)
        const queryParams = [
          fromDate, fromDate,
          toDate, toDate,
          resolvedCampaignId, resolvedCampaignId,
          1000, 0
        ];

        const plan = this.timelineStore.db.prepare(planSql).all(...queryParams);
        plans[kind] = plan.map(p => p.detail).join(' | ');
      } catch (err) {
        plans[kind] = `Error: ${err.message}`;
      }
    }

    return {
      filters: {
        fromDate,
        toDate,
        campaignId: resolvedCampaignId,
        agentId,
        provider,
      },
      queryPlans: plans,
    };
  }
}

/**
 * Create an ExportQueryEngine instance
 * @param {Object} options
 * @param {TimelineStore} options.timelineStore
 * @param {number} [options.batchSize=1000]
 * @returns {ExportQueryEngine}
 */
export function createExportQueryEngine(options) {
  return new ExportQueryEngine(options);
}

export default ExportQueryEngine;
