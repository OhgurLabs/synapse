-- Migration 003: Add operator_action_events table for operator replay/steer audit trail
-- Version: 003
-- Description: Create operator_action_events table with indexes for operator controls
-- Note: Schema must match timeline-store.js _initTables()

-- Create operator_action_events table for operator replay/steer actions
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

-- Indexes for operator_action_events
CREATE INDEX IF NOT EXISTS idx_operator_action_event_ts ON operator_action_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_operator_action_campaign_id ON operator_action_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_operator_action_dispatch_id ON operator_action_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_operator_action_operator_id ON operator_action_events(operator_id);
CREATE INDEX IF NOT EXISTS idx_operator_action_action_type ON operator_action_events(action_type);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('003', datetime('now'), 'Add operator_action_events table', 'sha256_operator_actions_v003');
