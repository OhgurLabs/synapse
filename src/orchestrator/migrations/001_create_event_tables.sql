-- Migration 001: Create all event tables for unified operational timeline
-- Version: 001
-- Description: Create routing_events, guardrail_events, circuit_breaker_events, anomaly_events tables
-- Note: Schema must match timeline-store.js _initTables()

-- Create routing_events table for dispatch decisions
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

-- Create guardrail_events table for guardrail evaluation outcomes
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

-- Create circuit_breaker_events table for CB state transitions
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
    provider TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT NOT NULL,
    failure_count INTEGER,
    event_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    parent_correlation_id TEXT,
    root_correlation_id TEXT
);

-- Create anomaly_events table for anomaly alerts and resolutions
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

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('001', datetime('now'), 'Create all event tables', 'sha256_event_tables_v001');
