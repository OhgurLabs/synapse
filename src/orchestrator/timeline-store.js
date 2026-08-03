import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';
import { invalidateCausalGraphCache } from './causal-graph-traversal.js';
import { createDatabaseWithRecovery } from './db-recovery.js';

const log = createLogger('timeline-store');

function toIsoTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return value;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function normalizeCorrelation(event = {}) {
  return {
    campaignId: event.campaignId ?? null,
    dispatchId: event.dispatchId ?? null,
    traceId: event.traceId ?? null,
    milestoneId: event.milestoneId ?? event.milestone_id ?? null,
    taskId: event.taskId ?? event.task_id ?? null,
    subtaskId: event.subtaskId ?? event.subtask_id ?? null,
    agentId: event.agentId ?? null,
    provider: event.provider ?? null,
  };
}

function serializePayload(value) {
  if (value === undefined) return '{}';
  return JSON.stringify(value);
}

function parsePayload(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value };
  }
}

/**
 * TimelineStore — SQLite persistence layer for unified operational timeline events.
 *
 * Persists events to several tables with common correlation fields:
 *   - routing_events: dispatch decisions
 *   - guardrail_events: guardrail outcomes
 *   - circuit_breaker_events: CB state transitions
 *   - anomaly_events: anomaly alerts/resolutions
 *   - operator_action_events: operator replay/steer actions
 *   - cost_events: agent dispatch cost and token counts
 *
 * All tables share: campaign_id, dispatch_id, trace_id, agent_id, provider, event_ts
 *
 * The `cost_events` table has the following schema:
 *   - id: TEXT PRIMARY KEY
 *   - idempotency_key: TEXT UNIQUE
 *   - event_ts: TEXT NOT NULL
 *   - campaign_id: TEXT
 *   - agent_id: TEXT
 *   - provider: TEXT
 *   - model: TEXT
 *   - input_tokens: INTEGER
 *   - output_tokens: INTEGER
 *   - cost_usd: REAL
 *   - dispatch_id: TEXT
 *   - trace_id: TEXT
 *   - task_id: TEXT
 *   - event_data: TEXT NOT NULL DEFAULT '{}'
 *   - created_at: TEXT NOT NULL
 *   - parent_correlation_id: TEXT
 *   - root_correlation_id: TEXT
 */
export class TimelineStore {
  /**
   * @param {Object} options
   * @param {string} options.dbPath
   * @param {number} [options.retentionMs] - Max age of events in ms
   * @param {number} [options.maxSize] - Hard cap on event count
   * @param {number} [options.cleanupInterval] - Periodic cleanup interval
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this.retentionMs = options.retentionMs || 7 * 24 * 60 * 60 * 1000;
    this.maxSize = options.maxSize || 10_000;
    this.cleanupInterval = options.cleanupInterval || 60 * 60 * 1000;
    this._cleanupTimer = null;
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(100);

    this._ensureParentDir();

    // Use recovery-aware database creation
    this.db = createDatabaseWithRecovery(this.dbPath, {
      emitter: this._emitter,
      enableRecovery: true,
    });

    this.db.pragma('journal_mode = WAL');
    this.db.pragma(' synchronous = FULL');
    this._initTables();
    this._prepareStatements();
  }

  _ensureParentDir() {
    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        selected_agent TEXT,
        selection_reason TEXT,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS guardrail_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        outcome TEXT,
        rule_id TEXT,
        rule_name TEXT,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS circuit_breaker_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        previous_state TEXT,
        new_state TEXT,
        failure_count INTEGER,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS anomaly_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        severity TEXT,
        anomaly_type TEXT,
        detail TEXT,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS operator_action_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        action_type TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        source_dispatch_id TEXT,
        target_dispatch_id TEXT,
        target_params TEXT,
        status TEXT,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS review_rejection_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        reviewer_id TEXT,
        cycle_number INTEGER,
        findings_count INTEGER,
        rework_status TEXT,
        verdict TEXT,
        findings TEXT,
        rework_context TEXT,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS routing_proposal_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        proposal_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_recommendation_id TEXT,
        proposed_weights TEXT NOT NULL,
        current_weights TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        confidence REAL,
        rationale TEXT,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS cost_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd REAL,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS error_propagation_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        failed_node_id TEXT,
        error_chain TEXT NOT NULL DEFAULT '{}',
        impact_summary TEXT NOT NULL DEFAULT '{}',
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS tool_invocations (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        event_ts TEXT NOT NULL,
        campaign_id TEXT,
        dispatch_id TEXT,
        trace_id TEXT,
        milestone_id TEXT,
        task_id TEXT,
        subtask_id TEXT,
        agent_id TEXT,
        provider TEXT,
        tool_name TEXT NOT NULL,
        server_source TEXT NOT NULL,
        parameters TEXT,
        result TEXT,
        error TEXT,
        error_code TEXT,
        elapsed_ms INTEGER,
        status TEXT NOT NULL,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        parent_correlation_id TEXT,
        root_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS routing_weight_snapshots (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        snapshot_ts TEXT NOT NULL,
        campaign_id TEXT,
        agent_id TEXT,
        task_category TEXT,
        provider TEXT,
        weight REAL NOT NULL,
        effective_weight REAL NOT NULL,
        weight_reason TEXT,
        event_data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS audit_search_index USING fts5(
        id,
        campaign_id,
        dispatch_id,
        trace_id,
        milestone_id,
        task_id,
        subtask_id,
        agent_id,
        provider,
        event_type,
        event_data,
        summary,
        created_at,
        tokenize='unicode61'
      );
    `);

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_routing_events_campaign_id ON routing_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_events_dispatch_id ON routing_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_events_event_ts ON routing_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_routing_events_milestone_id ON routing_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_events_task_id ON routing_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_events_subtask_id ON routing_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_events_parent_correlation_id ON routing_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_events_root_correlation_id ON routing_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_campaign_id ON guardrail_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_dispatch_id ON guardrail_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_event_ts ON guardrail_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_milestone_id ON guardrail_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_task_id ON guardrail_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_subtask_id ON guardrail_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_parent_correlation_id ON guardrail_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_guardrail_events_root_correlation_id ON guardrail_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_campaign_id ON circuit_breaker_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_dispatch_id ON circuit_breaker_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_event_ts ON circuit_breaker_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_milestone_id ON circuit_breaker_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_task_id ON circuit_breaker_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_subtask_id ON circuit_breaker_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_parent_correlation_id ON circuit_breaker_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_cb_events_root_correlation_id ON circuit_breaker_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_campaign_id ON anomaly_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_dispatch_id ON anomaly_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_event_ts ON anomaly_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_milestone_id ON anomaly_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_task_id ON anomaly_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_subtask_id ON anomaly_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_parent_correlation_id ON anomaly_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_anomaly_events_root_correlation_id ON anomaly_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_event_ts ON operator_action_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_operator_campaign_id ON operator_action_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_dispatch_id ON operator_action_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_milestone_id ON operator_action_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_task_id ON operator_action_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_subtask_id ON operator_action_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_source_dispatch_id ON operator_action_events(source_dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_target_dispatch_id ON operator_action_events(target_dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_action_type ON operator_action_events(action_type)',
      'CREATE INDEX IF NOT EXISTS idx_operator_operator_id ON operator_action_events(operator_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_parent_correlation_id ON operator_action_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_operator_root_correlation_id ON operator_action_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_event_ts ON review_rejection_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_campaign_id ON review_rejection_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_dispatch_id ON review_rejection_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_milestone_id ON review_rejection_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_task_id ON review_rejection_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_subtask_id ON review_rejection_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_agent_id ON review_rejection_events(agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_reviewer_id ON review_rejection_events(reviewer_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_cycle_number ON review_rejection_events(cycle_number)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_rework_status ON review_rejection_events(rework_status)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_parent_correlation_id ON review_rejection_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_review_rejection_root_correlation_id ON review_rejection_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_event_ts ON routing_proposal_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_campaign_id ON routing_proposal_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_dispatch_id ON routing_proposal_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_milestone_id ON routing_proposal_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_task_id ON routing_proposal_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_subtask_id ON routing_proposal_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_proposal_id ON routing_proposal_events(proposal_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_state ON routing_proposal_events(state)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_agent_id ON routing_proposal_events(agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_parent_correlation_id ON routing_proposal_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_routing_proposal_root_correlation_id ON routing_proposal_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_event_ts ON cost_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_campaign_id ON cost_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_dispatch_id ON cost_events(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_milestone_id ON cost_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_task_id ON cost_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_subtask_id ON cost_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_agent_id ON cost_events(agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_model ON cost_events(model)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_parent_correlation_id ON cost_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_cost_events_root_correlation_id ON cost_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_event_ts ON error_propagation_events(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_campaign_id ON error_propagation_events(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_milestone_id ON error_propagation_events(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_task_id ON error_propagation_events(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_subtask_id ON error_propagation_events(subtask_id)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_failed_node_id ON error_propagation_events(failed_node_id)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_campaign_ts ON error_propagation_events(campaign_id, event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_parent_correlation_id ON error_propagation_events(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_error_prop_root_correlation_id ON error_propagation_events(root_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_weight_snapshot_ts ON routing_weight_snapshots(snapshot_ts)',
      'CREATE INDEX IF NOT EXISTS idx_weight_snapshot_agent_id ON routing_weight_snapshots(agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_weight_snapshot_task_category ON routing_weight_snapshots(task_category)',
      'CREATE INDEX IF NOT EXISTS idx_weight_snapshot_agent_category ON routing_weight_snapshots(agent_id, task_category)',
      'CREATE INDEX IF NOT EXISTS idx_weight_snapshot_ts_agent ON routing_weight_snapshots(snapshot_ts, agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_task_id ON tool_invocations(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_campaign_id ON tool_invocations(campaign_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_trace_id ON tool_invocations(trace_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_event_ts ON tool_invocations(event_ts)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool_name ON tool_invocations(tool_name)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_server_source ON tool_invocations(server_source)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_agent_id ON tool_invocations(agent_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_status ON tool_invocations(status)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_dispatch_id ON tool_invocations(dispatch_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_parent_correlation_id ON tool_invocations(parent_correlation_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_invocations_root_correlation_id ON tool_invocations(root_correlation_id)',
    ];

    for (const sql of indexes) {
      this.db.exec(sql);
    }

    // Create triggers to populate FTS index when events are inserted
    
  }

  _createFtsTriggers() {
    this.db.exec(`
      -- Trigger for routing_events
      CREATE TRIGGER IF NOT EXISTS rt_routing_events_insert AFTER INSERT ON routing_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'dispatch',
          NEW.event_data,
          NEW.selection_reason,
          NEW.created_at
        );
      END;

      -- Trigger for guardrail_events
      CREATE TRIGGER IF NOT EXISTS rt_guardrail_events_insert AFTER INSERT ON guardrail_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'guardrail',
          NEW.event_data,
          COALESCE(NEW.outcome || ' by ' || NEW.rule_name, ''),
          NEW.created_at
        );
      END;

      -- Trigger for circuit_breaker_events
      CREATE TRIGGER IF NOT EXISTS rt_circuit_breaker_events_insert AFTER INSERT ON circuit_breaker_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'circuit_breaker',
          NEW.event_data,
          COALESCE(NEW.previous_state || ' → ' || NEW.new_state, ''),
          NEW.created_at
        );
      END;

      -- Trigger for anomaly_events
      CREATE TRIGGER IF NOT EXISTS rt_anomaly_events_insert AFTER INSERT ON anomaly_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'anomaly',
          NEW.event_data,
          COALESCE(NEW.severity || '' || ': ' || NEW.anomaly_type || '' || ': ' || NEW.detail, ''),
          NEW.created_at
        );
      END;

      -- Trigger for operator_action_events
      CREATE TRIGGER IF NOT EXISTS rt_operator_action_events_insert AFTER INSERT ON operator_action_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'operator_action',
          NEW.event_data,
          COALESCE(NEW.action_type || '' || ' by ' || NEW.operator_id, ''),
          NEW.created_at
        );
      END;

      -- Trigger for review_rejection_events
      CREATE TRIGGER IF NOT EXISTS rt_review_rejection_events_insert AFTER INSERT ON review_rejection_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'review_rejection',
          NEW.event_data,
          COALESCE(NEW.verdict || '' || ' by ' || NEW.reviewer_id || '' || ' (' || COALESCE(NEW.findings_count, 0) || ' findings)', ''),
          NEW.created_at
        );
      END;

      -- Trigger for routing_proposal_events
      CREATE TRIGGER IF NOT EXISTS rt_routing_proposal_events_insert AFTER INSERT ON routing_proposal_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'routing_proposal',
          NEW.event_data,
          COALESCE(NEW.proposal_id || '' || ': ' || NEW.state || '' || COALESCE(' - ' || NEW.rationale, ''), ''),
          NEW.created_at
        );
      END;

      -- Trigger for cost_events
      CREATE TRIGGER IF NOT EXISTS rt_cost_events_insert AFTER INSERT ON cost_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'cost',
          NEW.event_data,
          COALESCE('$' || COALESCE(NEW.cost_usd, 0) || ' (' || COALESCE(NEW.input_tokens, 0) || ' in, ' || COALESCE(NEW.output_tokens, 0) || ' out)', ''),
          NEW.created_at
        );
      END;

      -- Trigger for error_propagation_events
      CREATE TRIGGER IF NOT EXISTS rt_error_propagation_events_insert AFTER INSERT ON error_propagation_events BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NULL,
          NULL,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NULL,
          NULL,
          'error_propagation',
          NEW.event_data,
          COALESCE('Error from ' || NEW.failed_node_id, ''),
          NEW.created_at
        );
      END;

      -- Trigger for routing_weight_snapshots
      CREATE TRIGGER IF NOT EXISTS rt_routing_weight_snapshots_insert AFTER INSERT ON routing_weight_snapshots BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NEW.agent_id,
          NEW.provider,
          'weight_snapshot',
          NEW.event_data,
          COALESCE('Weight: ' || NEW.weight || ' (' || NEW.task_category || ')', ''),
          NEW.created_at
        );
      END;

      -- Trigger for tool_invocations
      CREATE TRIGGER IF NOT EXISTS rt_tool_invocations_insert AFTER INSERT ON tool_invocations BEGIN
        INSERT INTO audit_search_index(id, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_type, event_data, summary, created_at)
        VALUES (
          NEW.id,
          NEW.campaign_id,
          NEW.dispatch_id,
          NEW.trace_id,
          NEW.milestone_id,
          NEW.task_id,
          NEW.subtask_id,
          NEW.agent_id,
          NEW.provider,
          'tool_invocation',
          NEW.event_data,
          COALESCE(NEW.status || ': ' || NEW.tool_name || ' on ' || NEW.server_source, ''),
          NEW.created_at
        );
      END;
    `);
  }

  _prepareStatements() {
    this._stmts = {
      routing: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO routing_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            selected_agent, selection_reason, event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM routing_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM routing_events WHERE idempotency_key = ?'),
        selectByDispatchId: this.db.prepare(`
          SELECT dispatch_id, parent_correlation_id, root_correlation_id
          FROM routing_events
          WHERE dispatch_id = ?
          ORDER BY event_ts ASC
          LIMIT 1
        `),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  selected_agent, selection_reason, event_data, created_at, parent_correlation_id, root_correlation_id
          FROM routing_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM routing_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM routing_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  selected_agent, selection_reason, event_data, created_at, parent_correlation_id, root_correlation_id
          FROM routing_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      guardrail: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO guardrail_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            outcome, rule_id, rule_name, event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM guardrail_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM guardrail_events WHERE idempotency_key = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  outcome, rule_id, rule_name, event_data, created_at
          FROM guardrail_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM guardrail_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM guardrail_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  outcome, rule_id, rule_name, event_data, created_at
          FROM guardrail_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      circuitBreaker: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO circuit_breaker_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            previous_state, new_state, failure_count, event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM circuit_breaker_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM circuit_breaker_events WHERE idempotency_key = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  previous_state, new_state, failure_count, event_data, created_at
          FROM circuit_breaker_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM circuit_breaker_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM circuit_breaker_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  previous_state, new_state, failure_count, event_data, created_at
          FROM circuit_breaker_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      anomaly: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO anomaly_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            severity, anomaly_type, detail, event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM anomaly_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM anomaly_events WHERE idempotency_key = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  severity, anomaly_type, detail, event_data, created_at
          FROM anomaly_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM anomaly_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM anomaly_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  severity, anomaly_type, detail, event_data, created_at
          FROM anomaly_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      operatorAction: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO operator_action_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            action_type, operator_id, source_dispatch_id, target_dispatch_id, target_params, status, event_data, created_at,
            parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM operator_action_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM operator_action_events WHERE idempotency_key = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  action_type, operator_id, source_dispatch_id, target_dispatch_id, target_params, status, event_data, created_at
          FROM operator_action_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM operator_action_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM operator_action_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  action_type, operator_id, source_dispatch_id, target_dispatch_id, target_params, status, event_data, created_at
          FROM operator_action_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      reviewRejection: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO review_rejection_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            reviewer_id, cycle_number, findings_count, rework_status, verdict, findings, rework_context,
            event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM review_rejection_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM review_rejection_events WHERE idempotency_key = ?'),
        selectByTaskId: this.db.prepare(`
          SELECT task_id, parent_correlation_id, root_correlation_id
          FROM review_rejection_events
          WHERE task_id = ?
          ORDER BY event_ts ASC
          LIMIT 1
        `),
  query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  reviewer_id, cycle_number, findings_count, rework_status, verdict, findings, rework_context,
                  event_data, created_at
            FROM review_rejection_events
            WHERE 1=1
              ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider'])}
            ORDER BY event_ts DESC
            LIMIT ? OFFSET ?
          `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM review_rejection_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM review_rejection_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  reviewer_id, cycle_number, findings_count, rework_status, verdict, findings, rework_context,
                  event_data, created_at
          FROM review_rejection_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      routingProposal: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO routing_proposal_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            proposal_id, source_type, source_recommendation_id, proposed_weights, current_weights, state, confidence, rationale,
            event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM routing_proposal_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM routing_proposal_events WHERE idempotency_key = ?'),
        selectByProposalId: this.db.prepare('SELECT * FROM routing_proposal_events WHERE proposal_id = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  proposal_id, source_type, source_recommendation_id, proposed_weights, current_weights, state, confidence, rationale,
                  event_data, created_at, parent_correlation_id, root_correlation_id
          FROM routing_proposal_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM routing_proposal_events'),
        updateState: this.db.prepare('UPDATE routing_proposal_events SET state = ?, event_data = ? WHERE proposal_id = ?'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM routing_proposal_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  proposal_id, source_type, source_recommendation_id, proposed_weights, current_weights, state, confidence, rationale,
                  event_data, created_at, parent_correlation_id, root_correlation_id
          FROM routing_proposal_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      costDispatch: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO cost_events (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            model, input_tokens, output_tokens, cost_usd, event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM cost_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM cost_events WHERE idempotency_key = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  model, input_tokens, output_tokens, cost_usd, event_data, created_at, parent_correlation_id, root_correlation_id
          FROM cost_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM cost_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM cost_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  model, input_tokens, output_tokens, cost_usd, event_data, created_at, parent_correlation_id, root_correlation_id
          FROM cost_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
      },
      errorPropagation: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO error_propagation_events (
            id, idempotency_key, event_ts, campaign_id, milestone_id, task_id, subtask_id, failed_node_id,
            error_chain, impact_summary, event_data, created_at, parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM error_propagation_events WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM error_propagation_events WHERE idempotency_key = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, milestone_id, task_id, subtask_id, failed_node_id,
                  error_chain, impact_summary, event_data, created_at, parent_correlation_id, root_correlation_id
          FROM error_propagation_events
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'milestone_id', 'task_id', 'subtask_id', 'failed_node_id', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM error_propagation_events'),
        countByDateScope: this.db.prepare(`
          SELECT COUNT(*) as count
          FROM error_propagation_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
        `),
        queryByDateScope: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, milestone_id, task_id, subtask_id, failed_node_id,
                  error_chain, impact_summary, event_data, created_at, parent_correlation_id, root_correlation_id
          FROM error_propagation_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR campaign_id = ?)
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        // Aggregation queries
        getCostByAgent: this.db.prepare(`
          SELECT
            COALESCE(agent_id, 'unknown') as agent_id,
            COUNT(*) as event_count,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost_usd
          FROM cost_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR agent_id = ?)
            AND (? IS NULL OR campaign_id = ?)
            AND (? IS NULL OR provider = ?)
          GROUP BY COALESCE(agent_id, 'unknown')
          ORDER BY total_cost_usd DESC
        `),
        getCostByCampaign: this.db.prepare(`
          SELECT
            COALESCE(campaign_id, 'unknown') as campaign_id,
            COUNT(*) as event_count,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost_usd
          FROM cost_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR agent_id = ?)
            AND (? IS NULL OR campaign_id = ?)
            AND (? IS NULL OR provider = ?)
          GROUP BY COALESCE(campaign_id, 'unknown')
          ORDER BY total_cost_usd DESC
        `),
        getCostByProvider: this.db.prepare(`
          SELECT
            COALESCE(provider, 'unknown') as provider,
            COALESCE(model, 'unknown') as model,
            COUNT(*) as event_count,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost_usd
          FROM cost_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR agent_id = ?)
            AND (? IS NULL OR campaign_id = ?)
            AND (? IS NULL OR provider = ?)
          GROUP BY COALESCE(provider, 'unknown'), COALESCE(model, 'unknown')
          ORDER BY total_cost_usd DESC
        `),
        getCostByModel: this.db.prepare(`
          SELECT
            COALESCE(model, 'unknown') as model,
            COUNT(*) as event_count,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost_usd
          FROM cost_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR agent_id = ?)
            AND (? IS NULL OR campaign_id = ?)
            AND (? IS NULL OR provider = ?)
          GROUP BY COALESCE(model, 'unknown')
          ORDER BY total_cost_usd DESC
        `),
        getCostSummary: this.db.prepare(`
          SELECT
            COUNT(*) as event_count,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cost_usd) as total_cost_usd
          FROM cost_events
          WHERE (? IS NULL OR event_ts >= ?)
            AND (? IS NULL OR event_ts <= ?)
            AND (? IS NULL OR agent_id = ?)
            AND (? IS NULL OR campaign_id = ?)
            AND (? IS NULL OR provider = ?)
        `),
      },
      weightSnapshot: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO routing_weight_snapshots (
            id, idempotency_key, snapshot_ts, campaign_id, agent_id, task_category, provider,
            weight, effective_weight, weight_reason, event_data, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM routing_weight_snapshots WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM routing_weight_snapshots WHERE idempotency_key = ?'),
        selectByTimeRange: this.db.prepare(`
          SELECT id, idempotency_key, snapshot_ts, campaign_id, agent_id, task_category, provider,
                 weight, effective_weight, weight_reason, event_data, created_at
          FROM routing_weight_snapshots
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'agent_id', 'task_category', 'snapshot_ts'])}
          ORDER BY snapshot_ts DESC
          LIMIT ? OFFSET ?
        `),
        getWeightHistory: this.db.prepare(`
          SELECT snapshot_ts, agent_id, task_category, provider,
                 weight, effective_weight, weight_reason, event_data
          FROM routing_weight_snapshots
          WHERE (? IS NULL OR snapshot_ts >= ?)
            AND (? IS NULL OR snapshot_ts <= ?)
            AND (? IS NULL OR agent_id = ?)
            AND (? IS NULL OR task_category = ?)
            AND (? IS NULL OR provider = ?)
          ORDER BY snapshot_ts ASC
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM routing_weight_snapshots'),
      },
      toolInvocations: {
        insert: this.db.prepare(`
          INSERT OR IGNORE INTO tool_invocations (
            id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
            tool_name, server_source, parameters, result, error, error_code, elapsed_ms, status, event_data, created_at,
            parent_correlation_id, root_correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        selectById: this.db.prepare('SELECT * FROM tool_invocations WHERE id = ?'),
        selectByIdempotency: this.db.prepare('SELECT * FROM tool_invocations WHERE idempotency_key = ?'),
        query: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  tool_name, server_source, parameters, result, error, error_code, elapsed_ms, status, event_data, created_at,
                  parent_correlation_id, root_correlation_id
          FROM tool_invocations
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'dispatch_id', 'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id', 'provider', 'event_ts'])}
          ORDER BY event_ts DESC
          LIMIT ? OFFSET ?
        `),
        queryByTaskId: this.db.prepare(`
          SELECT id, idempotency_key, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider,
                  tool_name, server_source, parameters, result, error, error_code, elapsed_ms, status, event_data, created_at,
                  parent_correlation_id, root_correlation_id
          FROM tool_invocations
          WHERE task_id = ?
          ORDER BY event_ts ASC
        `),
        count: this.db.prepare('SELECT COUNT(*) as count FROM tool_invocations'),
      },
      search: {
        // FTS5 search query with BM25 ranking across all event types (33 columns each)
        query: this.db.prepare(`
          SELECT event_type, id, score, event_ts, campaign_id, dispatch_id, trace_id, milestone_id, task_id, subtask_id, agent_id, provider, event_data, summary, created_at, selected_agent, outcome, rule_name, previous_state, new_state, failure_count, severity, anomaly_type, detail, action_type, operator_id, source_dispatch_id, verdict, proposal_id, proposal_state, model, cost_usd, failed_node_id
          FROM (
            SELECT 'dispatch' as event_type, r.id as id, bm25(audit_search_index) as score, r.event_ts as event_ts, r.campaign_id as campaign_id, r.dispatch_id as dispatch_id, r.trace_id as trace_id, r.milestone_id as milestone_id, r.task_id as task_id, r.subtask_id as subtask_id, r.agent_id as agent_id, r.provider as provider, r.event_data as event_data, r.selection_reason as summary, r.created_at as created_at, r.selected_agent as selected_agent, NULL as outcome, NULL as rule_name, NULL as previous_state, NULL as new_state, NULL as failure_count, NULL as severity, NULL as anomaly_type, NULL as detail, NULL as action_type, NULL as operator_id, NULL as source_dispatch_id, NULL as verdict, NULL as proposal_id, NULL as proposal_state, NULL as model, NULL as cost_usd, NULL as failed_node_id
            FROM routing_events r JOIN audit_search_index ON r.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'dispatch'
            UNION ALL
            SELECT 'guardrail' as event_type, g.id, bm25(audit_search_index) as score, g.event_ts, g.campaign_id, g.dispatch_id, g.trace_id, g.milestone_id, g.task_id, g.subtask_id, g.agent_id, g.provider, g.event_data, COALESCE(g.outcome || ' by ' || g.rule_name, '') as summary, g.created_at, NULL, g.outcome, g.rule_name, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
            FROM guardrail_events g JOIN audit_search_index ON g.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'guardrail'
            UNION ALL
            SELECT 'circuit_breaker' as event_type, cb.id, bm25(audit_search_index) as score, cb.event_ts, cb.campaign_id, cb.dispatch_id, cb.trace_id, cb.milestone_id, cb.task_id, cb.subtask_id, cb.agent_id, cb.provider, cb.event_data, COALESCE(cb.previous_state || ' → ' || cb.new_state, '') as summary, cb.created_at, NULL, NULL, NULL, cb.previous_state, cb.new_state, cb.failure_count, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
            FROM circuit_breaker_events cb JOIN audit_search_index ON cb.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'circuit_breaker'
            UNION ALL
            SELECT 'anomaly' as event_type, a.id, bm25(audit_search_index) as score, a.event_ts, a.campaign_id, a.dispatch_id, a.trace_id, a.milestone_id, a.task_id, a.subtask_id, a.agent_id, a.provider, a.event_data, COALESCE(a.severity || ': ' || a.anomaly_type || ': ' || a.detail, '') as summary, a.created_at, NULL, NULL, NULL, NULL, NULL, NULL, a.severity, a.anomaly_type, a.detail, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
            FROM anomaly_events a JOIN audit_search_index ON a.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'anomaly'
            UNION ALL
            SELECT 'operator_action' as event_type, o.id, bm25(audit_search_index) as score, o.event_ts, o.campaign_id, o.dispatch_id, o.trace_id, o.milestone_id, o.task_id, o.subtask_id, o.agent_id, o.provider, o.event_data, COALESCE(o.action_type || ' by ' || o.operator_id, '') as summary, o.created_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, o.action_type, o.operator_id, o.source_dispatch_id, NULL, NULL, NULL, NULL, NULL, NULL
            FROM operator_action_events o JOIN audit_search_index ON o.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'operator_action'
            UNION ALL
            SELECT 'review_rejection' as event_type, rr.id, bm25(audit_search_index) as score, rr.event_ts, rr.campaign_id, rr.dispatch_id, rr.trace_id, rr.milestone_id, rr.task_id, rr.subtask_id, rr.agent_id, rr.provider, rr.event_data, COALESCE(rr.verdict || ' by ' || rr.reviewer_id, '') as summary, rr.created_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, rr.verdict, NULL, NULL, NULL, NULL, NULL
            FROM review_rejection_events rr JOIN audit_search_index ON rr.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'review_rejection'
            UNION ALL
            SELECT 'routing_proposal' as event_type, rp.id, bm25(audit_search_index) as score, rp.event_ts, rp.campaign_id, rp.dispatch_id, rp.trace_id, rp.milestone_id, rp.task_id, rp.subtask_id, rp.agent_id, rp.provider, rp.event_data, COALESCE(rp.proposal_id || ': ' || rp.state, '') as summary, rp.created_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, rp.proposal_id, rp.state, NULL, NULL, NULL
            FROM routing_proposal_events rp JOIN audit_search_index ON rp.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'routing_proposal'
            UNION ALL
            SELECT 'cost' as event_type, c.id, bm25(audit_search_index) as score, c.event_ts, c.campaign_id, c.dispatch_id, c.trace_id, c.milestone_id, c.task_id, c.subtask_id, c.agent_id, c.provider, c.event_data, COALESCE('$' || c.cost_usd, '') as summary, c.created_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, c.model, c.cost_usd, NULL
            FROM cost_events c JOIN audit_search_index ON c.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'cost'
            UNION ALL
            SELECT 'error_propagation' as event_type, e.id, bm25(audit_search_index) as score, e.event_ts, e.campaign_id, NULL, NULL, e.milestone_id, e.task_id, e.subtask_id, NULL, NULL, e.event_data, COALESCE('Error from ' || e.failed_node_id, '') as summary, e.created_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, e.failed_node_id
            FROM error_propagation_events e JOIN audit_search_index ON e.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'error_propagation'
          ) event
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'agent_id', 'provider', 'event_type', 'event_ts'])}
          ORDER BY score DESC, event_ts DESC
          LIMIT ? OFFSET ?
        `),
        count: this.db.prepare(`
          SELECT COUNT(*) as total FROM (
            SELECT 'dispatch' as event_type, r.campaign_id, r.agent_id, r.provider, r.event_ts FROM routing_events r JOIN audit_search_index ON r.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'dispatch'
            UNION ALL
            SELECT 'guardrail' as event_type, g.campaign_id, g.agent_id, g.provider, g.event_ts FROM guardrail_events g JOIN audit_search_index ON g.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'guardrail'
            UNION ALL
            SELECT 'circuit_breaker' as event_type, cb.campaign_id, cb.agent_id, cb.provider, cb.event_ts FROM circuit_breaker_events cb JOIN audit_search_index ON cb.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'circuit_breaker'
            UNION ALL
            SELECT 'anomaly' as event_type, a.campaign_id, a.agent_id, a.provider, a.event_ts FROM anomaly_events a JOIN audit_search_index ON a.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'anomaly'
            UNION ALL
            SELECT 'operator_action' as event_type, o.campaign_id, o.agent_id, o.provider, o.event_ts FROM operator_action_events o JOIN audit_search_index ON o.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'operator_action'
            UNION ALL
            SELECT 'review_rejection' as event_type, rr.campaign_id, rr.agent_id, rr.provider, rr.event_ts FROM review_rejection_events rr JOIN audit_search_index ON rr.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'review_rejection'
            UNION ALL
            SELECT 'routing_proposal' as event_type, rp.campaign_id, rp.agent_id, rp.provider, rp.event_ts FROM routing_proposal_events rp JOIN audit_search_index ON rp.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'routing_proposal'
            UNION ALL
            SELECT 'cost' as event_type, c.campaign_id, c.agent_id, c.provider, c.event_ts FROM cost_events c JOIN audit_search_index ON c.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'cost'
            UNION ALL
            SELECT 'error_propagation' as event_type, e.campaign_id, NULL as agent_id, NULL as provider, e.event_ts FROM error_propagation_events e JOIN audit_search_index ON e.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'error_propagation'
          )
          WHERE 1=1
            ${this._buildWhereClause(['campaign_id', 'agent_id', 'provider', 'event_type', 'event_ts'])}
        `),
      },
    };
  }

  _buildWhereClause(fields) {
    const clauses = [];
    for (const field of fields) {
      // Each field is independently filtered: if param is NULL, skip that filter
      clauses.push(`(? IS NULL OR ${field} = ?)`);
    }
    return clauses.length > 0 ? 'AND ' + clauses.join(' AND ') : '';
  }

  _persist(kind, rowValues = []) {
    const stmt = this._stmts[kind];
    const result = stmt.insert.run(...rowValues);
    if (result.changes > 0) {
      const row = stmt.selectById.get(rowValues[0]);
      this._emitAuditEvent(row, kind);
      return row;
    }

    const idemKey = rowValues[1];
    if (idemKey) {
      const existingByIdempotency = stmt.selectByIdempotency.get(idemKey);
      if (existingByIdempotency) {
        this._emitAuditEvent(existingByIdempotency, kind);
        return existingByIdempotency;
      }
    }

    const row = stmt.selectById.get(rowValues[0]);
    if (row) {
      this._emitAuditEvent(row, kind);
    }
    return row || null;
  }

  _emitAuditEvent(row, kind) {
    if (!row) return;

    const eventType = this._mapKindToEventType(kind);
    const event = {
      id: row.id,
      event_ts: row.event_ts,
      campaign_id: row.campaign_id,
      dispatch_id: row.dispatch_id,
      trace_id: row.trace_id,
      milestone_id: row.milestone_id,
      task_id: row.task_id,
      subtask_id: row.subtask_id,
      agent_id: row.agent_id,
      provider: row.provider,
      type: eventType,
      color: this._getEventTypeColor(eventType),
      summary: this._generateEventSummary(row, eventType),
      data: parsePayload(row.event_data),
      created_at: row.created_at,
      parent_correlation_id: row.parent_correlation_id,
      root_correlation_id: row.root_correlation_id,
    };

    this._emitter.emit('insert', event);
  }

 _mapKindToEventType(kind) {
     const mapping = {
       routing: 'dispatch',
       guardrail: 'guardrail',
       circuitBreaker: 'circuit_breaker',
       anomaly: 'anomaly',
       operatorAction: 'operator_action',
       reviewRejection: 'review_rejection',
       routingProposal: 'routing_proposal',
       costDispatch: 'cost',
       errorPropagation: 'error_propagation',
       weightSnapshot: 'weight_snapshot',
       toolInvocations: 'tool_invocation',
     };
     return mapping[kind] || kind;
   }

_getEventTypeColor(eventType) {
     const colorMap = {
       dispatch: 'blue',
       guardrail: 'orange',
       circuit_breaker: 'red',
       anomaly: 'yellow',
       operator_action: 'purple',
       cost: 'green',
       review_rejection: 'gray',
       routing_proposal: 'gray',
       error_propagation: 'gray',
       weight_snapshot: 'cyan',
       tool_invocation_start: 'teal',
       tool_invocation_success: 'teal',
       tool_invocation_error: 'red',
       tool_invocation: 'teal',
     };
     return colorMap[eventType] || 'gray';
   }

  _generateEventSummary(row, eventType) {
    const data = parsePayload(row.event_data);
    
    switch (eventType) {
      case 'dispatch':
        return `Dispatched to ${row.selected_agent || 'unknown'}${row.selection_reason ? `: ${row.selection_reason}` : ''}`;
      
      case 'guardrail':
        return `${row.outcome || 'evaluated'} by ${row.rule_name || 'rule'}`;
      
      case 'circuit_breaker':
        return `State: ${row.previous_state} → ${row.new_state}${row.failure_count ? ` (failures: ${row.failure_count})` : ''}`;
      
      case 'anomaly':
        return `${row.severity || 'alert'}: ${row.anomaly_type || 'anomaly'}${row.detail ? ` - ${row.detail}` : ''}`;
      
      case 'operator_action':
        return `${row.action_type || 'action'} by ${row.operator_id || 'operator'}`;
      
      case 'cost':
        return `Cost: $${row.cost_usd?.toFixed(4) || 0} (${row.input_tokens || 0} in, ${row.output_tokens || 0} out)`;
      
      case 'review_rejection':
        return `Reviewer ${row.reviewer_id}: ${row.verdict || 'review'}${row.findings_count ? ` (${row.findings_count} findings)` : ''}`;
      
      case 'routing_proposal':
        return `Proposal ${row.proposal_id?.slice(0, 8)}: ${row.state}`;
      
      case 'error_propagation':
        return `Error propagated from ${row.failed_node_id || 'unknown'}`;
      
      case 'tool_invocation_start':
        return `Tool ${row.tool_name || 'unknown'} started on ${row.server_source || 'unknown'}`;
      
      case 'tool_invocation_success':
        return `Tool ${row.tool_name || 'unknown'} succeeded on ${row.server_source || 'unknown'} in ${row.elapsed_ms || 0}ms`;
      
      case 'tool_invocation_error':
        return `Tool ${row.tool_name || 'unknown'} failed on ${row.server_source || 'unknown'}: ${row.error || 'unknown error'}`;
      
      default:
        return `${eventType} event`;
    }
  }

  _resolveRootCorrelationId(dispatchId) {
    if (!dispatchId) return null;

    const visited = new Set();
    let current = dispatchId;
    let depth = 0;

    while (current && depth < 50) {
      if (visited.has(current)) break;
      visited.add(current);

      const row = this._stmts.routing.selectByDispatchId.get(current);
      if (!row) return current;

      if (row.root_correlation_id) return row.root_correlation_id;
      if (row.parent_correlation_id) {
        current = row.parent_correlation_id;
        depth += 1;
        continue;
      }

      return row.dispatch_id || current;
    }

    return current || dispatchId;
  }

  _extractParentDispatchId(event = {}) {
    return (
      event.parentDispatchId ??
      event.parent_dispatch_id ??
      event.data?.parentDispatchId ??
      event.data?.parent_dispatch_id ??
      event.data?.steer?.parentDispatchId ??
      event.data?.steer?.parent_dispatch_id ??
      null
    );
  }

  _extractSourceDispatchId(event = {}) {
    return (
      event.sourceDispatchId ??
      event.source_dispatch_id ??
      event.data?.sourceDispatchId ??
      event.data?.source_dispatch_id ??
      null
    );
  }

  _inferCausalIds(kind, event, correlation) {
    const explicitParent = event.parentCorrelationId ?? event.parent_correlation_id ?? null;
    const explicitRoot = event.rootCorrelationId ?? event.root_correlation_id ?? null;
    const parentDispatchId = this._extractParentDispatchId(event);
    const sourceDispatchId = this._extractSourceDispatchId(event);
    const dispatchId = correlation.dispatchId ?? event.dispatchId ?? event.data?.dispatchId ?? null;

    let parentCorrelationId = explicitParent;
    if (!parentCorrelationId) {
      if (kind === 'operatorAction') {
        parentCorrelationId = sourceDispatchId || parentDispatchId || null;
      } else if (kind === 'routing') {
        parentCorrelationId = parentDispatchId || null;
      } else {
        parentCorrelationId = dispatchId || parentDispatchId || sourceDispatchId || null;
      }
    }

    let rootCorrelationId = explicitRoot;
    if (!rootCorrelationId) {
      if (parentCorrelationId) {
        rootCorrelationId = this._resolveRootCorrelationId(parentCorrelationId) || parentCorrelationId;
      } else if (dispatchId) {
        rootCorrelationId = this._resolveRootCorrelationId(dispatchId) || dispatchId;
      } else if (sourceDispatchId) {
        rootCorrelationId = this._resolveRootCorrelationId(sourceDispatchId) || sourceDispatchId;
      } else if (parentDispatchId) {
        rootCorrelationId = this._resolveRootCorrelationId(parentDispatchId) || parentDispatchId;
      } else {
        rootCorrelationId = null;
      }
    }

    return { parentCorrelationId, rootCorrelationId };
  }

  _formatEvent(row, eventType) {
    if (!row) return null;

    const base = {
      id: row.id,
      event_ts: row.event_ts,
      campaign_id: row.campaign_id,
      dispatch_id: row.dispatch_id,
      trace_id: row.trace_id,
      milestone_id: row.milestone_id,
      task_id: row.task_id,
      subtask_id: row.subtask_id,
      agent_id: row.agent_id,
      provider: row.provider,
      created_at: row.created_at,
      parent_correlation_id: row.parent_correlation_id,
      root_correlation_id: row.root_correlation_id,
      data: parsePayload(row.event_data),
      row,
    };

    // Add review rejection specific fields
    if (eventType === 'review_rejection') {
      base.reviewer_id = row.reviewer_id;
      base.cycle_number = row.cycle_number;
      base.findings_count = row.findings_count;
      base.rework_status = row.rework_status;
      base.verdict = row.verdict;
      base.findings = row.findings ? parsePayload(row.findings) : null;
      base.rework_context = row.rework_context ? parsePayload(row.rework_context) : null;
    }

    // Add routing proposal specific fields
    if (eventType === 'routing_proposal' || eventType === 'routingProposal') {
      base.proposal_id = row.proposal_id;
      base.source_type = row.source_type;
      base.source_recommendation_id = row.source_recommendation_id;
      base.proposed_weights = row.proposed_weights ? parsePayload(row.proposed_weights) : null;
      base.current_weights = row.current_weights ? parsePayload(row.current_weights) : null;
      base.state = row.state;
      base.confidence = row.confidence;
      base.rationale = row.rationale;
    }

    // Add cost dispatch specific fields
    if (eventType === 'cost_dispatch' || eventType === 'costDispatch') {
      base.model = row.model;
      base.input_tokens = row.input_tokens;
      base.output_tokens = row.output_tokens;
      base.cost_usd = row.cost_usd;
    }

 // Add error propagation specific fields
     if (eventType === 'error_propagation' || eventType === 'errorPropagation') {
       base.failed_node_id = row.failed_node_id;
       base.failedNodeId = row.failed_node_id;
       base.error_chain = row.error_chain ? parsePayload(row.error_chain) : null;
       base.errorChain = row.error_chain ? parsePayload(row.error_chain) : null;
       base.impact_summary = row.impact_summary ? parsePayload(row.impact_summary) : null;
       base.impactSummary = row.impact_summary ? parsePayload(row.impact_summary) : null;
     }

     // Add tool invocation specific fields
     if (eventType === 'tool_invocation_start' || eventType === 'tool_invocation_success' || eventType === 'tool_invocation_error') {
       base.tool_name = row.tool_name;
       base.toolName = row.tool_name;
       base.server_source = row.server_source;
       base.serverSource = row.server_source;
       base.parameters = row.parameters ? parsePayload(row.parameters) : null;
       base.result = row.result ? parsePayload(row.result) : null;
       base.error = row.error;
       base.error_code = row.error_code;
       base.errorCode = row.error_code;
       base.elapsed_ms = row.elapsed_ms;
       base.elapsedMs = row.elapsed_ms;
       base.status = row.status;
     }

     return base;
   }

  appendRoutingEvent(event = {}) {
    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('routing', event, correlation);
    const row = [
      event.id || `route-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      event.selectedAgent ?? null,
      event.selectionReason ?? null,
      serializePayload(event.data ?? event),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('routing', row), 'routing');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendGuardrailEvent(event = {}) {
    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('guardrail', event, correlation);
    const row = [
      event.id || `guardrail-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      event.outcome ?? null,
      event.ruleId ?? null,
      event.ruleName ?? null,
      serializePayload(event.data ?? event),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('guardrail', row), 'guardrail');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendCircuitBreakerEvent(event = {}) {
    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('circuitBreaker', event, correlation);
    const row = [
      event.id || `cb-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      event.previousState ?? event.prevState ?? null,
      event.newState ?? event.state ?? null,
      Number.isFinite(event.failureCount) ? event.failureCount : null,
      serializePayload(event.data ?? event),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('circuitBreaker', row), 'circuit_breaker');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendAnomalyEvent(event = {}) {
    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('anomaly', event, correlation);
    const row = [
      event.id || `anomaly-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp || event.firedAt || event.resolvedAt),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      event.severity ?? null,
      event.anomalyType ?? event.type ?? null,
      event.detail ?? event.message ?? null,
      serializePayload(event.data ?? event),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('anomaly', row), 'anomaly');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendOperatorActionEvent(event = {}) {
    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('operatorAction', event, correlation);
    const row = [
      event.id || `operator-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      event.actionType ?? event.action_type ?? null,
      event.operatorId ?? event.operator_id ?? null,
      event.sourceDispatchId ?? event.source_dispatch_id ?? null,
      event.targetDispatchId ?? event.target_dispatch_id ?? null,
      event.targetParams ? serializePayload(event.targetParams) : null,
      event.status ?? null,
      serializePayload(event.data ?? event),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('operatorAction', row), 'operator_action');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendReviewRejectionEvent(event = {}) {
    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('reviewRejection', event, correlation);
    const row = [
      event.id || `review-rejection-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId ?? event.taskId ?? event.task_id ?? null,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      event.reviewerId ?? event.reviewer_id ?? null,
      Number.isFinite(event.cycleNumber) ? event.cycleNumber : (Number.isFinite(event.cycle_number) ? event.cycle_number : null),
      Number.isFinite(event.findingsCount) ? event.findingsCount : (Number.isFinite(event.findings_count) ? event.findings_count : null),
      event.reworkStatus ?? event.rework_status ?? null,
      event.verdict ?? null,
      event.findings ? serializePayload(event.findings) : null,
      event.reworkContext ? serializePayload(event.reworkContext) : null,
      serializePayload(event.data ?? event),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('reviewRejection', row), 'review_rejection');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendRoutingProposalEvent(event = {}) {
    const {
      proposalId,
      sourceType,
      sourceRecommendationId,
      proposedWeights,
      currentWeights,
      state = 'pending',
      confidence,
      rationale,
    } = event.data || {};

    if (!proposalId) {
      throw new TypeError('proposalId is required in event.data');
    }
    if (!sourceType || !['analytics', 'autoresearch'].includes(sourceType)) {
      throw new TypeError('sourceType is required and must be "analytics" or "autoresearch"');
    }
    if (!proposedWeights || typeof proposedWeights !== 'object') {
      throw new TypeError('proposedWeights is required and must be an object');
    }
    if (!currentWeights || typeof currentWeights !== 'object') {
      throw new TypeError('currentWeights is required and must be an object');
    }
    if (!['pending', 'approved', 'rejected'].includes(state)) {
      throw new TypeError('state must be "pending", "approved", or "rejected"');
    }

    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('routingProposal', event, correlation);

    // Ensure event_data includes all proposal fields including state
    const eventData = {
      ...(event.data ?? event),
      proposalId,
      sourceType,
      sourceRecommendationId: sourceRecommendationId ?? null,
      proposedWeights,
      currentWeights,
      state,
      confidence: confidence ?? null,
      rationale: rationale ?? null,
    };

    const row = [
      event.id || `routing-proposal-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      proposalId,
      sourceType,
      sourceRecommendationId ?? null,
      serializePayload(proposedWeights),
      serializePayload(currentWeights),
      state,
      confidence ?? null,
      rationale ?? null,
      serializePayload(eventData),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('routingProposal', row), 'routing_proposal');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendCostEvent(event = {}) {
    const correlation = normalizeCorrelation(event);
    const causal = this._inferCausalIds('costDispatch', event, correlation);
    const row = [
      event.id || `cost-${randomUUID()}`,
      event.idempotencyKey ?? event.id ?? null,
      toIsoTimestamp(event.eventTs || event.timestamp),
      correlation.campaignId,
      correlation.dispatchId,
      correlation.traceId,
      correlation.milestoneId,
      correlation.taskId ?? event.taskId ?? event.task_id ?? null,
      correlation.subtaskId,
      correlation.agentId,
      correlation.provider,
      event.model ?? null,
      Number.isFinite(event.inputTokens) ? event.inputTokens : (Number.isFinite(event.input_tokens) ? event.input_tokens : null),
      Number.isFinite(event.outputTokens) ? event.outputTokens : (Number.isFinite(event.output_tokens) ? event.output_tokens : null),
      event.costUsd ?? event.cost_usd ?? null,
      serializePayload(event.data ?? event),
      new Date().toISOString(),
      causal.parentCorrelationId,
      causal.rootCorrelationId,
    ];
    const result = this._formatEvent(this._persist('costDispatch', row), 'cost_dispatch');

    // Invalidate causal graph cache (if enabled)
    invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);

    return result;
  }

  appendErrorPropagationEvent(event = {}) {
     const correlation = normalizeCorrelation(event);
     const causal = this._inferCausalIds('errorPropagation', event, correlation);
     const row = [
       event.id || `error-prop-${randomUUID()}`,
       event.idempotencyKey ?? event.id ?? null,
       toIsoTimestamp(event.eventTs || event.timestamp),
       correlation.campaignId,
       correlation.milestoneId,
       correlation.taskId,
       correlation.subtaskId,
       event.failedNodeId ?? event.failed_node_id ?? null,
       serializePayload(event.errorChain ?? event.error_chain ?? []),
       serializePayload(event.impactSummary ?? event.impact_summary ?? {}),
       serializePayload(event.data ?? event),
       new Date().toISOString(),
       causal.parentCorrelationId,
       causal.rootCorrelationId,
     ];
     const result = this._formatEvent(this._persist('errorPropagation', row), 'error_propagation');
     return result;
   }

  appendToolInvocationStart(event = {}) {
     const correlation = normalizeCorrelation(event);
     const causal = this._inferCausalIds('toolInvocations', event, correlation);
     const row = [
       event.id || `tool-inv-start-${randomUUID()}`,
       event.idempotencyKey ?? event.id ?? null,
       toIsoTimestamp(event.eventTs || event.timestamp),
       correlation.campaignId,
       correlation.dispatchId,
       correlation.traceId,
       correlation.milestoneId,
       correlation.taskId,
       correlation.subtaskId,
       correlation.agentId,
       correlation.provider,
       event.toolName ?? event.tool_name ?? 'unknown',
       event.serverSource ?? event.server_source ?? 'unknown',
       serializePayload(event.parameters ?? {}),
       null,
       null,
       null,
       null,
       'start',
       serializePayload(event.data ?? event),
       new Date().toISOString(),
       causal.parentCorrelationId,
       causal.rootCorrelationId,
     ];
     const result = this._formatEvent(this._persist('toolInvocations', row), 'tool_invocation_start');
     invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);
     return result;
   }

  appendToolInvocationSuccess(event = {}) {
     const correlation = normalizeCorrelation(event);
     const causal = this._inferCausalIds('toolInvocations', event, correlation);
     const row = [
       event.id || `tool-inv-success-${randomUUID()}`,
       event.idempotencyKey ?? event.id ?? null,
       toIsoTimestamp(event.eventTs || event.timestamp),
       correlation.campaignId,
       correlation.dispatchId,
       correlation.traceId,
       correlation.milestoneId,
       correlation.taskId,
       correlation.subtaskId,
       correlation.agentId,
       correlation.provider,
       event.toolName ?? event.tool_name ?? 'unknown',
       event.serverSource ?? event.server_source ?? 'unknown',
       serializePayload(event.parameters ?? {}),
       serializePayload(event.result ?? {}),
       null,
       null,
       Number.isFinite(event.elapsedMs) ? event.elapsedMs : null,
       'success',
       serializePayload(event.data ?? event),
       new Date().toISOString(),
       causal.parentCorrelationId,
       causal.rootCorrelationId,
     ];
     const result = this._formatEvent(this._persist('toolInvocations', row), 'tool_invocation_success');
     invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);
     return result;
   }

  appendToolInvocationError(event = {}) {
     const correlation = normalizeCorrelation(event);
     const causal = this._inferCausalIds('toolInvocations', event, correlation);
     const row = [
       event.id || `tool-inv-error-${randomUUID()}`,
       event.idempotencyKey ?? event.id ?? null,
       toIsoTimestamp(event.eventTs || event.timestamp),
       correlation.campaignId,
       correlation.dispatchId,
       correlation.traceId,
       correlation.milestoneId,
       correlation.taskId,
       correlation.subtaskId,
       correlation.agentId,
       correlation.provider,
       event.toolName ?? event.tool_name ?? 'unknown',
       event.serverSource ?? event.server_source ?? 'unknown',
       serializePayload(event.parameters ?? {}),
       null,
       event.error ?? event.message ?? null,
       event.code ?? event.errorCode ?? event.error_code ?? null,
       Number.isFinite(event.elapsedMs) ? event.elapsedMs : null,
       'error',
       serializePayload(event.data ?? event),
       new Date().toISOString(),
       causal.parentCorrelationId,
       causal.rootCorrelationId,
     ];
     const result = this._formatEvent(this._persist('toolInvocations', row), 'tool_invocation_error');
     invalidateCausalGraphCache(correlation.dispatchId, causal.rootCorrelationId);
     return result;
   }

  /**
   * Snapshot an array of routing weight records into the routing_weight_snapshots table.
   *
   * @param {Array<Object>} weightRecords - Array of weight record objects, each containing:
   *   - agentId {string} - Agent identifier
   *   - taskCategory {string} - Task category for the weight
   *   - provider {string} - Provider backing this agent
   *   - weight {number} - Raw computed weight
   *   - effectiveWeight {number} - Weight after overrides/normalization
   *   - weightReason {string} - Human-readable reason for this weight value
   *   - campaignId {string} [optional] - Associated campaign
   *   - data {Object} [optional] - Additional metadata (overrides, performance stats, etc.)
   * @param {Object} [options={}] - Optional overrides
   *   - snapshotTs {string|Date} [optional] - Override snapshot timestamp (defaults to now)
   * @returns {Array<Object>} Array of persisted snapshot rows
   */
  snapshotRoutingWeights(weightRecords = [], options = {}) {
    if (!Array.isArray(weightRecords) || weightRecords.length === 0) {
      return [];
    }

    const snapshotTs = toIsoTimestamp(options.snapshotTs);
    const now = new Date().toISOString();
    const results = [];

    const insertMany = this.db.transaction((records) => {
      for (const record of records) {
        const id = `ws-${randomUUID()}`;
        const agentId = record.agentId ?? record.agent_id ?? null;
        const taskCategory = record.taskCategory ?? record.task_category ?? null;
        const idemKey = record.idempotencyKey ?? `${snapshotTs}:${agentId}:${taskCategory}`;
        const row = [
          id,
          idemKey,
          snapshotTs,
          record.campaignId ?? record.campaign_id ?? null,
          agentId,
          taskCategory,
          record.provider ?? null,
          Number.isFinite(record.weight) ? record.weight : 0,
          Number.isFinite(record.effectiveWeight ?? record.effective_weight)
            ? (record.effectiveWeight ?? record.effective_weight)
            : (Number.isFinite(record.weight) ? record.weight : 0),
          record.weightReason ?? record.weight_reason ?? null,
          serializePayload(record.data ?? {}),
          now,
        ];
        const persisted = this._persist('weightSnapshot', row);
        if (persisted) {
          results.push(persisted);
        }
      }
    });

    insertMany(weightRecords);
    return results;
  }

  updateProposalState(proposalId, newState, metadata = {}) {
    if (!proposalId || typeof proposalId !== 'string' || proposalId.trim() === '') {
      throw new TypeError('proposalId must be a non-empty string');
    }
    if (!newState || typeof newState !== 'string' || newState.trim() === '') {
      throw new TypeError('newState must be a non-empty string');
    }
    if (!['pending', 'approved', 'rejected'].includes(newState)) {
      throw new TypeError('newState must be one of: pending, approved, rejected');
    }

    const proposal = this._stmts.routingProposal.selectByProposalId.get(proposalId);
    if (!proposal) {
      return null;
    }

    const currentEventData = parsePayload(proposal.event_data);
    const eventData = {
      ...currentEventData,
      ...metadata,
      state: newState,
      updatedAt: new Date().toISOString(),
    };

    const result = this._stmts.routingProposal.updateState.run(
      newState,
      serializePayload(eventData),
      proposalId
    );

    if (result.changes === 0) {
      throw new Error(`Failed to update proposal state: ${proposalId}`);
    }

    const updated = this._stmts.routingProposal.selectByProposalId.get(proposalId);
    return this._formatEvent(updated, 'routing_proposal');
  }

getProposalById(proposalId) {
     if (!proposalId || typeof proposalId !== 'string' || proposalId.trim() === '') {
       throw new TypeError('proposalId must be a non-empty string');
     }

     const proposal = this._stmts.routingProposal.selectByProposalId.get(proposalId);
     if (!proposal) {
       return null;
     }
     return this._formatEvent(proposal, 'routing_proposal');
   }

  /**
   * Query tool invocations by task_id
   * @param {string} taskId - Task ID to filter by
   * @returns {Array<Object>} Array of tool invocation records
   */
  queryToolInvocationsByTaskId(taskId) {
    if (!taskId || typeof taskId !== 'string' || taskId.trim() === '') {
      throw new TypeError('taskId must be a non-empty string');
    }

    const rows = this._stmts.toolInvocations.queryByTaskId.all(taskId);
    return rows.map(row => {
      const eventType = row.status === 'start' ? 'tool_invocation_start' : 
                       (row.status === 'success' ? 'tool_invocation_success' : 'tool_invocation_error');
      return this._formatEvent(row, eventType);
    });
  }

  /**
   * Query tool invocations with filters
   * @param {Object} filters - Query filters
   * @param {string} [filters.taskId] - Task ID
   * @param {string} [filters.campaignId] - Campaign ID
   * @param {string} [filters.traceId] - Trace ID
   * @param {string} [filters.toolName] - Tool name
   * @param {string} [filters.serverSource] - Server source
   * @param {string} [filters.status] - Status (start/success/error)
   * @param {string} [filters.since] - ISO timestamp lower bound
   * @param {string} [filters.until] - ISO timestamp upper bound
   * @param {number} [filters.limit] - Max results (default 100, max 500)
   * @param {number} [filters.offset] - Results to skip (default 0)
   * @returns {{ events: Object[], total: number }}
   */
  queryToolInvocations(filters = {}) {
    const limit = Math.min(filters.limit || 100, 500);
    const offset = filters.offset || 0;

    const rows = this._stmts.toolInvocations.query.all(
      filters.campaignId, filters.campaignId,
      filters.dispatchId, filters.dispatchId,
      filters.traceId, filters.traceId,
      filters.milestoneId, filters.milestoneId,
      filters.taskId, filters.taskId,
      filters.subtaskId, filters.subtaskId,
      filters.agentId, filters.agentId,
      filters.provider, filters.provider,
      filters.since || filters.until || null, filters.since || filters.until || null,
      limit, offset
    );

    const events = rows.map(row => {
      const eventType = row.status === 'start' ? 'tool_invocation_start' : 
                       (row.status === 'success' ? 'tool_invocation_success' : 'tool_invocation_error');
      return this._formatEvent(row, eventType);
    });

    // Apply time range filters in application code
    let filteredEvents = events;
    if (filters.since || filters.until) {
      filteredEvents = events.filter(e => {
        const ts = Date.parse(e.event_ts);
        if (filters.since && ts < Date.parse(filters.since)) return false;
        if (filters.until && ts > Date.parse(filters.until)) return false;
        return true;
      });
    }

    // Filter by toolName and serverSource in application code
    if (filters.toolName) {
      filteredEvents = filteredEvents.filter(e => e.tool_name === filters.toolName);
    }
    if (filters.serverSource) {
      filteredEvents = filteredEvents.filter(e => e.server_source === filters.serverSource);
    }
    if (filters.status) {
      filteredEvents = filteredEvents.filter(e => e.status === filters.status);
    }

    // Sort by event_ts ASC
    filteredEvents.sort((a, b) => Date.parse(a.event_ts) - Date.parse(b.event_ts));

    return {
      events: filteredEvents,
      total: filteredEvents.length,
    };
  }

  /**
   * Export events across all tables with chunked streaming
   * @param {Object} filters
   * @param {Object} [filters.dateRange] - Date range filter
   * @param {string} [filters.dateRange.from] - ISO timestamp lower bound (event_ts >= from)
   * @param {string} [filters.dateRange.to] - ISO timestamp upper bound (event_ts <= to)
   * @param {Object} [filters.scope] - Scope filter
   * @param {string} [filters.scope.type] - 'system', 'project', or 'campaign'
   * @param {string} [filters.scope.id] - ID for the scope (campaign_id for project/campaign, null for system)
   * @param {number} [filters.chunkSize] - Number of rows per chunk (default 500)
   * @param {Function} callback - Callback function(chunk) invoked for each chunk of events
   * @returns {Promise<Object>} - Promise resolving to { total, chunks }
   */
  async exportEvents(filters = {}, callback) {
    const { dateRange, scope, chunkSize = 500 } = filters;
    
    if (!callback || typeof callback !== 'function') {
      throw new TypeError('callback function is required');
    }
    
    const fromDate = dateRange?.from ? new Date(dateRange.from).toISOString() : null;
    const toDate = dateRange?.to ? new Date(dateRange.to).toISOString() : null;
    const scopeType = scope?.type || 'system';
    const scopeId = scope?.id || null;
    
    let campaignIdFilter = null;
    if (scopeType === 'campaign' && scopeId) {
      campaignIdFilter = scopeId;
    } else if (scopeType === 'project' && scopeId) {
      campaignIdFilter = scopeId;
    }
    
    const totalByType = {};
    let total = 0;
    let offset = 0;
    let chunksProcessed = 0;
    
    const kinds = [
      { kind: 'routing', type: 'dispatch' },
      { kind: 'guardrail', type: 'guardrail_outcome' },
      { kind: 'circuitBreaker', type: 'circuit_breaker' },
      { kind: 'anomaly', type: 'anomaly_alert' },
      { kind: 'operatorAction', type: 'operator_action' },
      { kind: 'reviewRejection', type: 'review_rejection' },
      { kind: 'routingProposal', type: 'routing_proposal' },
      { kind: 'costDispatch', type: 'cost_dispatch' },
      { kind: 'errorPropagation', type: 'error_propagation' },
    ];
    
    for (const { kind, type } of kinds) {
      const count = await this._countEventsForExport(kind, fromDate, toDate, campaignIdFilter);
      totalByType[type] = count;
      total += count;
    }
    
    if (total === 0) {
      return { total: 0, chunks: 0 };
    }
    
    for (const { kind, type } of kinds) {
      const chunk = await this._exportEventsByType(kind, type, fromDate, toDate, campaignIdFilter, offset, chunkSize, callback);
      if (chunk.events.length > 0) {
        chunksProcessed++;
        offset += chunk.events.length;
      }
    }
    
    return { total, chunks: chunksProcessed };
  }
  
  async _countEventsForExport(kind, fromDate, toDate, campaignIdFilter) {
    const stmt = this._stmts[kind].countByDateScope;
    let count = 0;
    
    try {
      const result = stmt.get(
        fromDate, fromDate, toDate, toDate, campaignIdFilter
      );
      count = result?.count || 0;
    } catch (err) {
      log.warn('Failed to count events for export', { kind, error: err.message });
    }
    
    return count;
  }
  
  async _exportEventsByType(kind, type, fromDate, toDate, campaignIdFilter, baseOffset, chunkSize, callback) {
    const events = [];
    let localOffset = 0;
    
    while (true) {
      const rows = await this._queryEventsForExport(kind, fromDate, toDate, campaignIdFilter, chunkSize, localOffset);
      
      if (rows.length === 0) {
        break;
      }
      
      const formatted = rows.map(row => this._formatEvent(row, kind));
      const enriched = formatted.map(e => ({ ...e, type }));
      events.push(...enriched);
      
      if (rows.length < chunkSize) {
        break;
      }
      
      localOffset += chunkSize;
    }
    
    if (events.length > 0 && callback) {
      await callback(events);
    }
    
    return { events, count: events.length };
  }
  
  _queryEventsForExport(kind, fromDate, toDate, campaignIdFilter, limit, offset) {
    const stmt = this._stmts[kind].queryByDateScope;
    let queryParams;
    
    if (kind === 'errorPropagation') {
      queryParams = [
        fromDate, fromDate, toDate, toDate, campaignIdFilter, campaignIdFilter,
        limit, offset
      ];
    } else if (kind === 'reviewRejection' || kind === 'costDispatch') {
      queryParams = [
        fromDate, fromDate, toDate, toDate, campaignIdFilter, campaignIdFilter,
        limit, offset
      ];
    } else {
      queryParams = [
        fromDate, fromDate, toDate, toDate, campaignIdFilter, campaignIdFilter,
        null, null, null, null, null, null,
        limit, offset
      ];
    }
    
    const rows = stmt.all(...queryParams);
    return rows;
  }

  /**
   * Query events across all tables with filters
   * @param {Object} [filters]
   * @param {string} [filters.campaignId] - Campaign ID
   * @param {string} [filters.dispatchId] - Dispatch ID
   * @param {string} [filters.traceId] - Trace ID
   * @param {string} [filters.milestoneId] - Milestone ID
   * @param {string} [filters.taskId] - Task ID
   * @param {string} [filters.subtaskId] - Subtask ID
   * @param {string} [filters.agentId] - Agent ID
   * @param {string} [filters.provider] - Provider
   * @param {string} [filters.since] - ISO timestamp lower bound
   * @param {string} [filters.until] - ISO timestamp upper bound
   * @param {string} [filters.type] - Event type filter
   * @param {number} [filters.limit] - Max results (default 100, max 500)
   * @param {number} [filters.offset] - Results to skip (default 0)
   * @returns {{ events: Object[], total: number }}
   */
  query(filters = {}) {
      const events = [];
      const params = [];

      // Build filter params - match the order of fields in _buildWhereClause
      // Each field needs TWO params: one for IS NULL check, one for equality check
      const filterMap = {
        campaign_id: filters.campaignId,
        dispatch_id: filters.dispatchId,
        trace_id: filters.traceId,
        milestone_id: filters.milestoneId,
        task_id: filters.taskId,
        subtask_id: filters.subtaskId,
        agent_id: filters.agentId,
        provider: filters.provider,
        event_ts: null, // We'll handle time range separately
      };

      for (const value of Object.values(filterMap)) {
        // Push each value twice for the (? IS NULL OR field = ?) pattern
        params.push(value, value);
      }

      const limit = Math.min(filters.limit || 100, 500);
      const offset = filters.offset || 0;

      // Map API type names to internal type names (same mapping as countByType)
      const apiTypeToInternal = {
        dispatch: 'routing',
        guardrail_outcome: 'guardrail',
        circuit_breaker: 'circuit_breaker',
        anomaly_alert: 'anomaly',
        operator_action: 'operator_action',
        operator_replay: 'operator_action',
        operator_steer: 'operator_action',
        review_rejection: 'review_rejection',
        routing_proposal: 'routingProposal',
        cost_dispatch: 'costDispatch',
        error_propagation: 'errorPropagation',
      };

      // Normalize type filters to handle both API types and internal types
      let typeFilters = filters.type ? (Array.isArray(filters.type) ? filters.type : [filters.type]) : null;
      if (typeFilters) {
        typeFilters = typeFilters.map(t => apiTypeToInternal[t] || t);
      }

      if (!typeFilters || typeFilters.includes('routing')) {
        const routingEvents = this._queryType('routing', params, limit, offset);
        events.push(...routingEvents.map(e => ({ ...e, type: 'dispatch' })));
      }

      if (!typeFilters || typeFilters.includes('guardrail')) {
        const guardrailEvents = this._queryType('guardrail', params, limit, offset);
        events.push(...guardrailEvents.map(e => ({ ...e, type: 'guardrail_outcome' })));
      }

      if (!typeFilters || typeFilters.includes('circuit_breaker')) {
        const cbEvents = this._queryType('circuitBreaker', params, limit, offset);
        events.push(...cbEvents.map(e => ({ ...e, type: 'circuit_breaker' })));
      }

      if (!typeFilters || typeFilters.includes('anomaly')) {
        const anomalyEvents = this._queryType('anomaly', params, limit, offset);
        events.push(...anomalyEvents.map(e => ({ ...e, type: 'anomaly_alert' })));
      }

      if (!typeFilters || typeFilters.includes('operator_action')) {
        const operatorEvents = this._queryType('operatorAction', params, limit, offset);
        events.push(...operatorEvents.map(e => ({ ...e, type: 'operator_action' })));
      }

      if (!typeFilters || typeFilters.includes('review_rejection')) {
        const rejectionEvents = this._queryType('reviewRejection', params, limit, offset);
        events.push(...rejectionEvents.map(e => ({ ...e, type: 'review_rejection' })));
      }

      if (!typeFilters || typeFilters.includes('routingProposal')) {
        const proposalEvents = this._queryType('routingProposal', params, limit, offset);
        events.push(...proposalEvents.map(e => ({ ...e, type: 'routing_proposal' })));
      }

      if (!typeFilters || typeFilters.includes('costDispatch')) {
        const costEvents = this._queryType('costDispatch', params, limit, offset);
        events.push(...costEvents.map(e => ({ ...e, type: 'cost_dispatch' })));
      }

      if (!typeFilters || typeFilters.includes('errorPropagation')) {
        const errorEvents = this._queryType('errorPropagation', params, limit, offset);
        events.push(...errorEvents.map(e => ({ ...e, type: 'error_propagation' })));
      }

    // Apply time range filters (since/until) in application code
    let filteredEvents = events;
    if (filters.since || filters.until) {
      filteredEvents = events.filter(e => {
        const ts = Date.parse(e.event_ts);
        if (filters.since && ts < Date.parse(filters.since)) return false;
        if (filters.until && ts > Date.parse(filters.until)) return false;
        return true;
      });
    }

    // Sort by event_ts DESC
    filteredEvents.sort((a, b) => Date.parse(b.event_ts) - Date.parse(a.event_ts));

    const total = filteredEvents.length;

    return {
      events: filteredEvents.slice(offset, offset + limit),
      total,
    };
  }

  _queryType(kind, params, limit, offset) {
    const stmt = this._stmts[kind].query;
    // Determine how many WHERE fields each event type has:
    // - routing, guardrail, circuitBreaker, anomaly, operatorAction, routingProposal: 9 fields (18 params, includes event_ts)
    // - reviewRejection, costDispatch: 8 fields (16 params, no event_ts filter)
    // - errorPropagation: 6 fields (12 params, different fields: campaign_id, milestone_id, task_id, subtask_id, failed_node_id, event_ts)
    let queryParams;
    if (kind === 'errorPropagation') {
      queryParams = params.slice(0, 12);
    } else if (kind === 'reviewRejection' || kind === 'costDispatch') {
      queryParams = params.slice(0, 16);
    } else {
      queryParams = params;
    }
    const allParams = [...queryParams, limit, offset];
    const rows = stmt.all(...allParams);
    return rows.map(row => this._formatEvent(row, kind));
  }

 /**
    * Count events by type
    * @param {string} type - Event type
    * @returns {number}
    */
  countByType(type) {
    const typeMap = {
      dispatch: 'routing',
      guardrail_outcome: 'guardrail',
      circuit_breaker: 'circuitBreaker',
      anomaly_alert: 'anomaly',
      operator_action: 'operatorAction',
      operator_replay: 'operatorAction',
      operator_steer: 'operatorAction',
      review_rejection: 'reviewRejection',
      routing_proposal: 'routingProposal',
      cost_dispatch: 'costDispatch',
      error_propagation: 'errorPropagation',
      weight_snapshot: 'weightSnapshot',
    };

    const kind = typeMap[type] || (type === 'weightSnapshot' ? 'weightSnapshot' : null);
    if (!kind) return 0;

    const result = this._stmts[kind].count.get();
    return result.count;
  }

  /**
   * Get outcome analytics for routing events
   * @param {string} [startTime] - ISO timestamp lower bound
   * @param {string} [endTime] - ISO timestamp upper bound
   * @returns {Array<{ taskCategory: string, agentId: string, dispatches: number, successes: number, failures: number, partials: number, successRate: number|null }>}
   */
  getOutcomeAnalytics(startTime, endTime) {
    const whereClauses = ['task_category IS NOT NULL', 'selected_agent IS NOT NULL'];
    const params = [];

    if (startTime) {
      whereClauses.push('event_ts >= ?');
      params.push(startTime);
    }

    if (endTime) {
      whereClauses.push('event_ts <= ?');
      params.push(endTime);
    }

    const whereClause = 'WHERE ' + whereClauses.join(' AND ');

    const rows = this.db.prepare(`
      SELECT
        selected_agent as agentId,
        COUNT(*) as dispatches,
        SUM(CASE WHEN json_extract(event_data, '$.outcome') = 'success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN json_extract(event_data, '$.outcome') = 'failure' THEN 1 ELSE 0 END) as failures,
        SUM(CASE WHEN json_extract(event_data, '$.outcome') = 'partial' THEN 1 ELSE 0 END) as partials
      FROM routing_events
      ${whereClause}
      GROUP BY selected_agent
      ORDER BY dispatches DESC
    `).all(...params);

    return rows.map(row => ({
      agentId: row.agentId,
      dispatches: row.dispatches,
      successes: row.successes || 0,
      failures: row.failures || 0,
      partials: row.partials || 0,
      successRate: row.dispatches > 0 ? (row.successes || 0) / row.dispatches : null,
    }));
  }

  /**
   * Get guardrail block rate analytics
   * @param {string} [startTime] - ISO timestamp lower bound
   * @param {string} [endTime] - ISO timestamp upper bound
   * @returns {Array<{ ruleName: string, evaluations: number, blocks: number, blockRate: number|null }>}
   */
  getGuardrailAnalytics(startTime, endTime) {
    const whereClauses = [];
    const params = [];

    if (startTime) {
      whereClauses.push('event_ts >= ?');
      params.push(startTime);
    }

    if (endTime) {
      whereClauses.push('event_ts <= ?');
      params.push(endTime);
    }

    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const rows = this.db.prepare(`
      SELECT
        rule_name as ruleName,
        COUNT(*) as evaluations,
        SUM(CASE WHEN outcome IN ('block', 'fail') THEN 1 ELSE 0 END) as blocks
      FROM guardrail_events
      ${whereClause}
      GROUP BY rule_name
      ORDER BY evaluations DESC
    `).all(...params);

    return rows.map(row => ({
      ruleName: row.ruleName,
      evaluations: row.evaluations,
      blocks: row.blocks || 0,
      blockRate: row.evaluations > 0 ? (row.blocks || 0) / row.evaluations : null,
    }));
  }

  /**
   * Get cost breakdown by agent with optional time window and entity filtering
   * @param {Object} [options]
   * @param {string} [options.since] - ISO timestamp lower bound (event_ts >= since)
   * @param {string} [options.until] - ISO timestamp upper bound (event_ts <= until)
   * @param {string} [options.agentId] - Filter to a specific agent
   * @param {string} [options.campaignId] - Filter to a specific campaign
   * @param {string} [options.provider] - Filter to a specific provider
   * @returns {Array<{ agentId: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number }>}
   */
  getCostByAgent(options = {}) {
    const since = options.since || null;
    const until = options.until || null;
    const agentId = options.agentId || null;
    const campaignId = options.campaignId || null;
    const provider = options.provider || null;

    const rows = this._stmts.costDispatch.getCostByAgent.all(since, since, until, until, agentId, agentId, campaignId, campaignId, provider, provider);
    return rows.map(row => ({
      agentId: row.agent_id,
      eventCount: row.event_count || 0,
      totalInputTokens: row.total_input_tokens || 0,
      totalOutputTokens: row.total_output_tokens || 0,
      totalCostUsd: row.total_cost_usd || 0,
    }));
  }

  /**
   * Get cost breakdown by campaign with optional time window and entity filtering
   * @param {Object} [options]
   * @param {string} [options.since] - ISO timestamp lower bound (event_ts >= since)
   * @param {string} [options.until] - ISO timestamp upper bound (event_ts <= until)
   * @param {string} [options.agentId] - Filter to a specific agent
   * @param {string} [options.campaignId] - Filter to a specific campaign
   * @param {string} [options.provider] - Filter to a specific provider
   * @returns {Array<{ campaignId: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number }>}
   */
  getCostByCampaign(options = {}) {
    const since = options.since || null;
    const until = options.until || null;
    const agentId = options.agentId || null;
    const campaignId = options.campaignId || null;
    const provider = options.provider || null;

    const rows = this._stmts.costDispatch.getCostByCampaign.all(since, since, until, until, agentId, agentId, campaignId, campaignId, provider, provider);
    return rows.map(row => ({
      campaignId: row.campaign_id,
      eventCount: row.event_count || 0,
      totalInputTokens: row.total_input_tokens || 0,
      totalOutputTokens: row.total_output_tokens || 0,
      totalCostUsd: row.total_cost_usd || 0,
    }));
  }

  /**
   * Get cost breakdown by provider with nested model sub-breakdowns and optional time window and entity filtering.
   * NULL provider/model values are grouped as 'unknown'.
   * @param {Object} [options]
   * @param {string} [options.since] - ISO timestamp lower bound (event_ts >= since)
   * @param {string} [options.until] - ISO timestamp upper bound (event_ts <= until)
   * @param {string} [options.agentId] - Filter to a specific agent
   * @param {string} [options.campaignId] - Filter to a specific campaign
   * @param {string} [options.provider] - Filter to a specific provider
   * @returns {Array<{ provider: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number, models: Array<{ model: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number }> }>}
   */
  getCostByProvider(options = {}) {
    const since = options.since || null;
    const until = options.until || null;
    const agentId = options.agentId || null;
    const campaignId = options.campaignId || null;
    const provider = options.provider || null;

    const rows = this._stmts.costDispatch.getCostByProvider.all(since, since, until, until, agentId, agentId, campaignId, campaignId, provider, provider);

    // Post-process flat provider+model rows into nested provider → models structure
    const providerMap = new Map();
    for (const row of rows) {
      const provider = row.provider; // Already COALESCE'd to 'unknown'
      const model = row.model;       // Already COALESCE'd to 'unknown'
      const eventCount = row.event_count || 0;
      const totalInputTokens = row.total_input_tokens || 0;
      const totalOutputTokens = row.total_output_tokens || 0;
      const totalCostUsd = row.total_cost_usd || 0;

      if (!providerMap.has(provider)) {
        providerMap.set(provider, {
          provider,
          eventCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostUsd: 0,
          models: [],
        });
      }

      const providerEntry = providerMap.get(provider);
      providerEntry.eventCount += eventCount;
      providerEntry.totalInputTokens += totalInputTokens;
      providerEntry.totalOutputTokens += totalOutputTokens;
      providerEntry.totalCostUsd += totalCostUsd;
      providerEntry.models.push({ model, eventCount, totalInputTokens, totalOutputTokens, totalCostUsd });
    }

    // Sort providers by total cost descending; models within each provider are already sorted by the SQL
    return Array.from(providerMap.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  }

/**
    * Get cost breakdown by model with optional time window and entity filtering.
    * NULL model values are grouped as 'unknown'.
    * @param {Object} [options]
    * @param {string} [options.since] - ISO timestamp lower bound (event_ts >= since)
    * @param {string} [options.until] - ISO timestamp upper bound (event_ts <= until)
    * @param {string} [options.agentId] - Filter to a specific agent
    * @param {string} [options.campaignId] - Filter to a specific campaign
    * @param {string} [options.provider] - Filter to a specific provider
    * @returns {Array<{ model: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number }>}
    */
  getCostByModel(options = {}) {
    const since = options.since || null;
    const until = options.until || null;
    const agentId = options.agentId || null;
    const campaignId = options.campaignId || null;
    const provider = options.provider || null;

    const rows = this._stmts.costDispatch.getCostByModel.all(since, since, until, until, agentId, agentId, campaignId, campaignId, provider, provider);
    return rows.map(row => ({
      model: row.model,
      eventCount: row.event_count || 0,
      totalInputTokens: row.total_input_tokens || 0,
      totalOutputTokens: row.total_output_tokens || 0,
      totalCostUsd: row.total_cost_usd || 0,
    }));
  }

/**
    * Format error propagation event from database row
    * @param {Object} row - Database row
    * @returns {Object|null}
    */
  _formatErrorPropagationEvent(row) {
    if (!row) return null;

    const base = {
      id: row.id,
      event_ts: row.event_ts,
      campaign_id: row.campaign_id,
      milestone_id: row.milestone_id,
      task_id: row.task_id,
      subtask_id: row.subtask_id,
      failed_node_id: row.failed_node_id,
      error_chain: parsePayload(row.error_chain),
      impact_summary: parsePayload(row.impact_summary),
      created_at: row.created_at,
      parent_correlation_id: row.parent_correlation_id,
      root_correlation_id: row.root_correlation_id,
      data: parsePayload(row.event_data),
      row,
    };

    return base;
  }

   /**
    * Get error chains by campaign
    * @param {string} campaignId - Campaign ID to filter by
    * @returns {Array<{ id, event_ts, campaign_id, milestone_id, task_id, subtask_id, failed_node_id, error_chain, impact_summary, created_at }>}
    */
  getErrorChainsByCampaign(campaignId) {
    if (!campaignId || typeof campaignId !== 'string') {
      return [];
    }

    const rows = this._stmts.errorPropagation.query.all(
      campaignId, campaignId,  // campaign_id
      null, null,              // milestone_id
      null, null,              // task_id
      null, null,              // subtask_id
      null, null,              // failed_node_id
      null, null,              // event_ts
      500, 0                   // limit, offset
    );
    return rows.map(row => this._formatErrorPropagationEvent(row));
  }

  /**
   * Get routing weight history for time-series visualization
   * @param {Object} [options]
   * @param {string} [options.since] - ISO timestamp lower bound (snapshot_ts >= since)
   * @param {string} [options.until] - ISO timestamp upper bound (snapshot_ts <= until)
   * @param {string} [options.agentId] - Filter to a specific agent
   * @param {string} [options.taskCategory] - Filter to a specific task category
   * @param {string} [options.provider] - Filter to a specific provider
   * @param {string} [options.window] - Time window shortcut (1h, 24h, 7d, 30d) - overrides since/until
   * @returns {Array<{ timestamp: string, agentId: string, taskCategory: string, provider: string, weight: number, effectiveWeight: number, reason: string, metadata: Object }>}
   */
  getWeightHistory(options = {}) {
    let since = options.since || null;
    let until = options.until || null;
    const agentId = options.agentId || null;
    const taskCategory = options.taskCategory || null;
    const provider = options.provider || null;

    // Convert window parameter to time range
    if (options.window) {
      const now = new Date();
      let windowStart;
      switch (options.window) {
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
      since = windowStart.toISOString();
      until = null; // Window is from windowStart to now
    }

    const rows = this._stmts.weightSnapshot.getWeightHistory.all(
      since, since,
      until, until,
      agentId, agentId,
      taskCategory, taskCategory,
      provider, provider
    );

    return rows.map(row => ({
      timestamp: row.snapshot_ts,
      agentId: row.agent_id,
      taskCategory: row.task_category,
      provider: row.provider,
      weight: row.weight,
      effectiveWeight: row.effective_weight,
      reason: row.weight_reason,
      metadata: parsePayload(row.event_data),
    }));
  }

  /**
    * Get overall cost summary with optional time window filtering
    * @param {Object} [options]
    * @param {string} [options.since] - ISO timestamp lower bound (event_ts >= since)
    * @param {string} [options.until] - ISO timestamp upper bound (event_ts <= until)
    * @returns {{ totalCostUsd: number, totalInputTokens: number, totalOutputTokens: number, totalDispatches: number, byAgent: Array<{ agentId: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number }>, byCampaign: Array<{ campaignId: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number }>, byProvider: Array<{ provider: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number, models: Array<{ model: string, eventCount: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number }> }> }}
    */
  getCostSummary(options = {}) {
    const since = options.since || null;
    const until = options.until || null;
    const agentId = options.agentId || null;
    const campaignId = options.campaignId || null;
    const provider = options.provider || null;

    const filterOpts = { since, until, agentId, campaignId, provider };

    // Call the three aggregation methods
    const byAgent = this.getCostByAgent(filterOpts);
    const byCampaign = this.getCostByCampaign(filterOpts);
    const byProvider = this.getCostByProvider(filterOpts);

    // Compute aggregate totals from breakdown arrays
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDispatches = 0;

    for (const entry of byAgent) {
      totalCostUsd += entry.totalCostUsd || 0;
      totalInputTokens += entry.totalInputTokens || 0;
      totalOutputTokens += entry.totalOutputTokens || 0;
      totalDispatches += entry.eventCount || 0;
    }

    return {
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      totalDispatches,
      byAgent,
      byCampaign,
      byProvider,
    };
  }

/**
    * Prune events older than retentionMs
    */
  _prune() {
    const cutoff = new Date(Date.now() - this.retentionMs).toISOString();

    // [table, timestampColumn] — every event table MUST appear here or it grows
    // without bound. routing_weight_snapshots keys on snapshot_ts, not event_ts.
    const tables = [
      ['routing_events', 'event_ts'],
      ['guardrail_events', 'event_ts'],
      ['circuit_breaker_events', 'event_ts'],
      ['anomaly_events', 'event_ts'],
      ['operator_action_events', 'event_ts'],
      ['review_rejection_events', 'event_ts'],
      ['routing_proposal_events', 'event_ts'],
      ['cost_events', 'event_ts'],
      ['error_propagation_events', 'event_ts'],
      ['tool_invocations', 'event_ts'],
      ['routing_weight_snapshots', 'snapshot_ts'],
    ];

    // Delete old events
    for (const [table, tsCol] of tables) {
      this.db.prepare(`DELETE FROM ${table} WHERE ${tsCol} < ?`).run(cutoff);
    }

    // Enforce maxSize cap
    for (const [table, tsCol] of tables) {
      const count = this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
      if (count > this.maxSize) {
        const deleteCount = count - this.maxSize;
        this.db.prepare(`
          DELETE FROM ${table} WHERE id IN (
            SELECT id FROM ${table} ORDER BY ${tsCol} ASC LIMIT ?
          )
        `).run(deleteCount);
      }
    }
  }

  /**
   * Start periodic cleanup timer
   */
  startCleanup() {
    if (this._cleanupTimer) return;

    this._cleanupTimer = setInterval(() => {
      const before = this._countTotal();
      this._prune();
      const after = this._countTotal();
      const pruned = before - after;
      if (pruned > 0) {
        log.info('Timeline store pruned stale events', { pruned, remaining: after });
      }
    }, this.cleanupInterval);

    this._cleanupTimer.unref?.();
    log.info('Timeline store cleanup started', { retentionMs: this.retentionMs });
  }

  /**
   * Stop periodic cleanup timer
   */
  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  _countTotal() {
    let total = 0;
    const tables = ['routing_events', 'guardrail_events', 'circuit_breaker_events', 'anomaly_events', 'operator_action_events', 'review_rejection_events', 'routing_proposal_events', 'cost_events', 'error_propagation_events'];
    for (const table of tables) {
      const result = this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
      total += result.count;
    }
    return total;
  }

  clear() {
    try {
      // Clear all event tables
      const tables = [
        'routing_events',
        'guardrail_events',
        'circuit_breaker_events',
        'anomaly_events',
        'operator_action_events',
        'review_rejection_events',
        'routing_proposal_events',
        'cost_events',
        'error_propagation_events',
      ];
      for (const table of tables) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      log.info('Cleared timeline store');
    } catch (err) {
      log.error('Failed to clear timeline store', { error: err.message });
    }
  }

  close() {
    if (this._cleanupTimer) {
      this.stopCleanup();
    }
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      log.warn('Failed to close timeline store database cleanly', {
        dbPath: this.dbPath,
        error: err.message,
      });
    }
  }

  /**
   * Get the internal EventEmitter for subscribing to insert events
   * @returns {EventEmitter}
   */
  getEmitter() {
    return this._emitter;
  }

  /**
   * Subscribe to timeline insert events (EventEmitter-compatible interface)
   * @param {string} event - Event name ('insert')
   * @param {Function} handler - Event handler function
   */
  on(event, handler) {
    if (event === 'insert') {
      this._emitter.on('insert', handler);
    }
    return this;
  }

  /**
   * Unsubscribe from timeline insert events (EventEmitter-compatible interface)
   * @param {string} event - Event name ('insert')
   * @param {Function} handler - Event handler function to remove
   */
  off(event, handler) {
    if (event === 'insert') {
      this._emitter.off('insert', handler);
    }
    return this;
  }

  /**
     * Full-text search across audit events using FTS5 BM25 ranking
     * Joins with all 9 event tables to get full row data
     * @param {Object} options
     * @param {string} options.query - Search query string (FTS5 MATCH syntax)
     * @param {string} [options.campaignId] - Filter by campaign ID
     * @param {string} [options.agentId] - Filter by agent ID
     * @param {string} [options.provider] - Filter by provider
     * @param {string} [options.eventType] - Filter by event type
     * @param {string} [options.since] - ISO timestamp lower bound (event_ts)
     * @param {string} [options.until] - ISO timestamp upper bound (event_ts)
     * @param {number} [options.limit] - Max results (default 50, max 500)
     * @param {number} [options.offset] - Results to skip (default 0)
     * @returns {{ events: Object[], total: number }}
     */
  search(options = {}) {
    const {
      query,
      campaignId,
      agentId,
      provider,
      eventType,
      since,
      until,
      limit = 50,
      offset = 0,
    } = options;

    if (!query || typeof query !== 'string' || query.trim() === '') {
      throw new TypeError('query is required and must be a non-empty string');
    }

    const searchLimit = Math.min(limit, 500);

    // Sanitize FTS5 MATCH query to prevent syntax injection
    const sanitizedQuery = this._sanitizeFtsQuery(query);

    // Build WHERE clause for filters
    const whereClauses = ['audit_search_index.id = event_rowid'];
    const params = [];

    if (campaignId) {
      whereClauses.push('event.campaign_id = ?');
      params.push(campaignId);
    }

    if (agentId) {
      whereClauses.push('event.agent_id = ?');
      params.push(agentId);
    }

    if (provider) {
      whereClauses.push('event.provider = ?');
      params.push(provider);
    }

    if (eventType) {
      whereClauses.push('event.event_type = ?');
      params.push(eventType);
    }

    if (since) {
      whereClauses.push('event.event_ts >= ?');
      params.push(since);
    }

    if (until) {
      whereClauses.push('event.event_ts <= ?');
      params.push(until);
    }

    const whereClause = 'WHERE ' + whereClauses.join(' AND ');

    // Use a unified view approach: query FTS, then join to get data from correct table
    // First, get matching FTS results with their event types
    const ftsSql = `
      SELECT id, event_type, bm25(audit_search_index) as score
      FROM audit_search_index
      WHERE audit_search_index MATCH ?
    `;
    
    const ftsParams = [sanitizedQuery];
    if (campaignId) {
      ftsParams.push(campaignId);
    }
    if (agentId) {
      ftsParams.push(agentId);
    }
    if (provider) {
      ftsParams.push(provider);
    }
    if (eventType) {
      ftsParams.push(eventType);
    }

    const ftsResults = this.db.prepare(ftsSql).all(...ftsParams);
    
    if (ftsResults.length === 0) {
      return { events: [], total: 0 };
    }

    // Build a query that unions all event tables with FTS ranking
    // We use a subquery to get only the matching event_ids and their scores
    const searchSql = `
      SELECT 
        event_type,
        id,
        score,
        event_ts,
        campaign_id,
        dispatch_id,
        trace_id,
        milestone_id,
        task_id,
        subtask_id,
        agent_id,
        provider,
        event_data,
        summary,
        created_at,
        selected_agent,
        outcome,
        rule_name,
        previous_state,
        new_state,
        failure_count,
        severity,
        anomaly_type,
        detail,
        action_type,
        operator_id,
        source_dispatch_id,
        verdict,
        proposal_id,
        proposal_state,
        model,
        cost_usd,
        failed_node_id
      FROM (
        -- Routing events (dispatch)
        SELECT 
          'dispatch' as event_type,
          r.id,
          bm25(audit_search_index) as score,
          r.event_ts,
          r.campaign_id,
          r.dispatch_id,
          r.trace_id,
          r.milestone_id,
          r.task_id,
          r.subtask_id,
          r.agent_id,
          r.provider,
          r.event_data,
          r.selection_reason as summary,
          r.created_at,
          r.selected_agent,
          NULL as outcome,
          NULL as rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          NULL as verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          NULL as model,
          NULL as cost_usd,
          NULL as failed_node_id
        FROM routing_events r
        JOIN audit_search_index ON r.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'dispatch'
        
        UNION ALL
        
        -- Guardrail events
        SELECT 
          'guardrail' as event_type,
          g.id,
          bm25(audit_search_index) as score,
          g.event_ts,
          g.campaign_id,
          g.dispatch_id,
          g.trace_id,
          g.milestone_id,
          g.task_id,
          g.subtask_id,
          g.agent_id,
          g.provider,
          g.event_data,
          COALESCE(g.outcome || ' by ' || g.rule_name, '') as summary,
          g.created_at,
          NULL as selected_agent,
          g.outcome,
          g.rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          NULL as verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          NULL as model,
          NULL as cost_usd,
          NULL as failed_node_id
        FROM guardrail_events g
        JOIN audit_search_index ON g.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'guardrail'
        
        UNION ALL
        
        -- Circuit breaker events
        SELECT 
          'circuit_breaker' as event_type,
          cb.id,
          bm25(audit_search_index) as score,
          cb.event_ts,
          cb.campaign_id,
          cb.dispatch_id,
          cb.trace_id,
          cb.milestone_id,
          cb.task_id,
          cb.subtask_id,
          cb.agent_id,
          cb.provider,
          cb.event_data,
          COALESCE(cb.previous_state || ' → ' || cb.new_state, '') as summary,
          cb.created_at,
          NULL as selected_agent,
          NULL as outcome,
          NULL as rule_name,
          cb.previous_state,
          cb.new_state,
          cb.failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          NULL as verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          NULL as model,
          NULL as cost_usd,
          NULL as failed_node_id
        FROM circuit_breaker_events cb
        JOIN audit_search_index ON cb.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'circuit_breaker'
        
        UNION ALL
        
        -- Anomaly events
        SELECT 
          'anomaly' as event_type,
          a.id,
          bm25(audit_search_index) as score,
          a.event_ts,
          a.campaign_id,
          a.dispatch_id,
          a.trace_id,
          a.milestone_id,
          a.task_id,
          a.subtask_id,
          a.agent_id,
          a.provider,
          a.event_data,
          COALESCE(a.severity || ': ' || a.anomaly_type || '' || ': ' || a.detail, '') as summary,
          a.created_at,
          NULL as selected_agent,
          NULL as outcome,
          NULL as rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          a.severity,
          a.anomaly_type,
          a.detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          NULL as verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          NULL as model,
          NULL as cost_usd,
          NULL as failed_node_id
        FROM anomaly_events a
        JOIN audit_search_index ON a.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'anomaly'
        
        UNION ALL
        
        -- Operator action events
        SELECT 
          'operator_action' as event_type,
          o.id,
          bm25(audit_search_index) as score,
          o.event_ts,
          o.campaign_id,
          o.dispatch_id,
          o.trace_id,
          o.milestone_id,
          o.task_id,
          o.subtask_id,
          o.agent_id,
          o.provider,
          o.event_data,
          COALESCE(o.action_type || ' by ' || o.operator_id, '') as summary,
          o.created_at,
          NULL as selected_agent,
          NULL as outcome,
          NULL as rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          o.action_type,
          o.operator_id,
          o.source_dispatch_id,
          NULL as verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          NULL as model,
          NULL as cost_usd,
          NULL as failed_node_id
        FROM operator_action_events o
        JOIN audit_search_index ON o.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'operator_action'
        
        UNION ALL
        
        -- Review rejection events
        SELECT 
          'review_rejection' as event_type,
          rr.id,
          bm25(audit_search_index) as score,
          rr.event_ts,
          rr.campaign_id,
          rr.dispatch_id,
          rr.trace_id,
          rr.milestone_id,
          rr.task_id,
          rr.subtask_id,
          rr.agent_id,
          rr.provider,
          rr.event_data,
          COALESCE(rr.verdict || ' by ' || rr.reviewer_id, '') as summary,
          rr.created_at,
          NULL as selected_agent,
          NULL as outcome,
          NULL as rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          rr.verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          NULL as model,
          NULL as cost_usd,
          NULL as failed_node_id
        FROM review_rejection_events rr
        JOIN audit_search_index ON rr.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'review_rejection'
        
        UNION ALL
        
        -- Routing proposal events
        SELECT 
          'routing_proposal' as event_type,
          rp.id,
          bm25(audit_search_index) as score,
          rp.event_ts,
          rp.campaign_id,
          rp.dispatch_id,
          rp.trace_id,
          rp.milestone_id,
          rp.task_id,
          rp.subtask_id,
          rp.agent_id,
          rp.provider,
          rp.event_data,
          COALESCE(rp.proposal_id || ': ' || rp.state, '') as summary,
          rp.created_at,
          NULL as selected_agent,
          NULL as outcome,
          NULL as rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          NULL as verdict,
          rp.proposal_id,
          rp.state,
          NULL as model,
          NULL as cost_usd,
          NULL as failed_node_id
        FROM routing_proposal_events rp
        JOIN audit_search_index ON rp.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'routing_proposal'
        
        UNION ALL
        
        -- Cost events
        SELECT 
          'cost' as event_type,
          c.id,
          bm25(audit_search_index) as score,
          c.event_ts,
          c.campaign_id,
          c.dispatch_id,
          c.trace_id,
          c.milestone_id,
          c.task_id,
          c.subtask_id,
          c.agent_id,
          c.provider,
          c.event_data,
          COALESCE('$' || COALESCE(c.cost_usd, 0), '') as summary,
          c.created_at,
          NULL as selected_agent,
          NULL as outcome,
          NULL as rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          NULL as verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          c.model,
          c.cost_usd,
          NULL as failed_node_id
        FROM cost_events c
        JOIN audit_search_index ON c.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'cost'
        
        UNION ALL
        
        -- Error propagation events
        SELECT 
          'error_propagation' as event_type,
          e.id,
          bm25(audit_search_index) as score,
          e.event_ts,
          e.campaign_id,
          NULL as dispatch_id,
          NULL as trace_id,
          e.milestone_id,
          e.task_id,
          e.subtask_id,
          NULL as agent_id,
          NULL as provider,
          e.event_data,
          COALESCE('Error from ' || e.failed_node_id, '') as summary,
          e.created_at,
          NULL as selected_agent,
          NULL as outcome,
          NULL as rule_name,
          NULL as previous_state,
          NULL as new_state,
          NULL as failure_count,
          NULL as severity,
          NULL as anomaly_type,
          NULL as detail,
          NULL as action_type,
          NULL as operator_id,
          NULL as source_dispatch_id,
          NULL as verdict,
          NULL as proposal_id,
          NULL as proposal_state,
          NULL as model,
          NULL as cost_usd,
          e.failed_node_id
        FROM error_propagation_events e
        JOIN audit_search_index ON e.id = audit_search_index.id
        WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'error_propagation'
      ) event
      WHERE 1=1
        ${whereClause}
      ORDER BY score DESC, event_ts DESC
      LIMIT ? OFFSET ?
    `;

    // Build params array (repeat query for each UNION branch)
    const unionParams = Array(9).fill(sanitizedQuery);
    const allParams = [...unionParams, ...params, searchLimit, offset];

    const searchResults = this.db.prepare(searchSql).all(...allParams);

    // Get total count
    const totalSql = `
      SELECT COUNT(*) as total FROM (
        SELECT 1 from routing_events r JOIN audit_search_index ON r.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'dispatch'
        UNION ALL
        SELECT 1 from guardrail_events g JOIN audit_search_index ON g.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'guardrail'
        UNION ALL
        SELECT 1 from circuit_breaker_events cb JOIN audit_search_index ON cb.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'circuit_breaker'
        UNION ALL
        SELECT 1 from anomaly_events a JOIN audit_search_index ON a.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'anomaly'
        UNION ALL
        SELECT 1 from operator_action_events o JOIN audit_search_index ON o.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'operator_action'
        UNION ALL
        SELECT 1 from review_rejection_events rr JOIN audit_search_index ON rr.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'review_rejection'
        UNION ALL
        SELECT 1 from routing_proposal_events rp JOIN audit_search_index ON rp.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'routing_proposal'
        UNION ALL
        SELECT 1 from cost_events c JOIN audit_search_index ON c.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'cost'
        UNION ALL
        SELECT 1 from error_propagation_events e JOIN audit_search_index ON e.id = audit_search_index.id WHERE audit_search_index MATCH ? AND audit_search_index.event_type = 'error_propagation'
      )
      ${whereClause}
    `;
    
    const totalParams = [...unionParams, ...params];
    const totalResult = this.db.prepare(totalSql).get(...totalParams);
    const total = totalResult ? totalResult.total : 0;

    // Format results
    const events = searchResults.map(row => {
      const eventType = this._mapKindToEventType(row.event_type);
      
      const baseEvent = {
        id: row.id,
        event_ts: row.event_ts,
        campaign_id: row.campaign_id,
        dispatch_id: row.dispatch_id,
        trace_id: row.trace_id,
        milestone_id: row.milestone_id,
        task_id: row.task_id,
        subtask_id: row.subtask_id,
        agent_id: row.agent_id,
        provider: row.provider,
        type: eventType,
        color: this._getEventTypeColor(eventType),
        summary: row.summary || this._generateEventSummaryFromFts(row),
        data: parsePayload(row.event_data),
        created_at: row.created_at,
        parent_correlation_id: null,
        root_correlation_id: null,
        _score: row.score,
      };

      // Add type-specific fields
      if (row.selected_agent !== null) baseEvent.selected_agent = row.selected_agent;
      if (row.outcome !== null) baseEvent.outcome = row.outcome;
      if (row.rule_name !== null) baseEvent.rule_name = row.rule_name;
      if (row.previous_state !== null) baseEvent.previous_state = row.previous_state;
      if (row.new_state !== null) baseEvent.new_state = row.new_state;
      if (row.failure_count !== null) baseEvent.failure_count = row.failure_count;
      if (row.severity !== null) baseEvent.severity = row.severity;
      if (row.anomaly_type !== null) baseEvent.anomaly_type = row.anomaly_type;
      if (row.detail !== null) baseEvent.detail = row.detail;
      if (row.action_type !== null) baseEvent.action_type = row.action_type;
      if (row.operator_id !== null) baseEvent.operator_id = row.operator_id;
      if (row.source_dispatch_id !== null) baseEvent.source_dispatch_id = row.source_dispatch_id;
      if (row.verdict !== null) baseEvent.verdict = row.verdict;
      if (row.proposal_id !== null) baseEvent.proposal_id = row.proposal_id;
      if (row.proposal_state !== null) baseEvent.state = row.proposal_state;
      if (row.model !== null) baseEvent.model = row.model;
      if (row.cost_usd !== null) baseEvent.cost_usd = row.cost_usd;
      if (row.failed_node_id !== null) baseEvent.failed_node_id = row.failed_node_id;

      // Try to extract correlation IDs from event_data
      try {
        const data = parsePayload(row.event_data);
        if (data?.parentDispatchId || data?.parent_dispatch_id) {
          baseEvent.parent_correlation_id = data.parentDispatchId || data.parent_dispatch_id;
        }
        if (data?.rootDispatchId || data?.root_dispatch_id) {
          baseEvent.root_correlation_id = data.rootDispatchId || data.root_dispatch_id;
        }
      } catch {}

      return baseEvent;
    });

    return { events, total };
  }

  /**
     * Sanitize FTS5 MATCH query to prevent syntax injection
     * @param {string} query - Raw query string
     * @returns {string} Sanitized query
     */
  _sanitizeFtsQuery(query) {
    let sanitized = query;
    
    // Remove characters that could be used for SQL/FTS injection
    // Allow: alphanumeric, spaces, quotes for phrases, AND/OR/NOT operators, *, +, -
    sanitized = sanitized.replace(/[<>=\(\);{}[\]\\]/g, '');
    
    // Convert to lowercase for consistent matching
    sanitized = sanitized.toLowerCase();
    
    // Ensure phrase boundaries are balanced
    const quoteCount = (sanitized.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      sanitized += '"';
    }
    
    return sanitized;
  }

  /**
    * Generate summary from FTS row when summary field is empty
    * @param {Object} row - FTS row
    * @returns {string}
    */
  _generateEventSummaryFromFts(row) {
    const eventType = row.event_type;
    const data = parsePayload(row.event_data);

    switch (eventType) {
      case 'dispatch':
        return `Dispatched${row.agent_id ? ` to ${row.agent_id}` : ''}`;
      case 'guardrail':
        return 'Guardrail evaluation';
      case 'circuit_breaker':
        return 'Circuit breaker event';
      case 'anomaly':
        return 'Anomaly detected';
      case 'operator_action':
        return 'Operator action';
      case 'cost':
        return 'Cost event';
      case 'review_rejection':
        return 'Review rejection';
      case 'routing_proposal':
        return 'Routing proposal';
      case 'error_propagation':
        return 'Error propagation';
      case 'weight_snapshot':
        return 'Weight snapshot';
      default:
        return `${eventType} event`;
    }
  }

  /**
    * Subscribe to timeline insert events
    * @param {Function} handler - Event handler function
    */
  onInsert(handler) {
    this._emitter.on('insert', handler);
    return this;
  }

  /**
   * Unsubscribe from timeline insert events
   * @param {Function} handler - Event handler function to remove
   */
  offInsert(handler) {
    this._emitter.off('insert', handler);
    return this;
  }
}

export function createTimelineStore(options = {}) {
  return new TimelineStore(options);
}

export default createTimelineStore;
