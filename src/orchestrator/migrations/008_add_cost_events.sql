-- Migration 008: Add cost_events table for per-dispatch token and cost tracking
-- Version: 008
-- Description: Create cost_events table with indexes for cost attribution
-- Note: Schema must match timeline-store.js _initTables()

-- Create cost_events table for per-dispatch cost tracking
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

-- Indexes for cost_events
CREATE INDEX IF NOT EXISTS idx_cost_events_event_ts ON cost_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_cost_events_agent_id ON cost_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_campaign_id ON cost_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_provider ON cost_events(provider);
CREATE INDEX IF NOT EXISTS idx_cost_events_dispatch_id ON cost_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_trace_id ON cost_events(trace_id);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('008', datetime('now'), 'Add cost_events table', 'sha256_cost_events_v008');
