-- Migration 009: Add sla_events table for SLA breach and resolution tracking
-- Version: 009
-- Description: Create sla_events table with indexes for SLA monitoring by type, provider, project, and time window
-- Schema source: SLA thresholds, breach detection & webhook alerts milestone

-- Create sla_events table for SLA breach and resolution tracking
CREATE TABLE IF NOT EXISTS sla_events (
    id TEXT PRIMARY KEY,
    event_ts TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('SLA_BREACH', 'SLA_RESOLVED')),
    sla_type TEXT NOT NULL,
    threshold REAL NOT NULL,
    actual REAL NOT NULL,
    window_minutes INTEGER NOT NULL,
    provider TEXT,
    project_id TEXT,
    campaign_id TEXT,
    dispatch_id TEXT,
    trace_id TEXT,
    agent_id TEXT,
    breached_at TEXT,
    resolved_at TEXT,
    event_data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    parent_correlation_id TEXT,
    root_correlation_id TEXT
);

-- Single-column indexes for sla_events
CREATE INDEX IF NOT EXISTS idx_sla_events_event_ts ON sla_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_sla_events_sla_type ON sla_events(sla_type);
CREATE INDEX IF NOT EXISTS idx_sla_events_provider ON sla_events(provider);
CREATE INDEX IF NOT EXISTS idx_sla_events_project_id ON sla_events(project_id);
CREATE INDEX IF NOT EXISTS idx_sla_events_breached_at ON sla_events(breached_at);
CREATE INDEX IF NOT EXISTS idx_sla_events_resolved_at ON sla_events(resolved_at);
CREATE INDEX IF NOT EXISTS idx_sla_events_parent_correlation_id ON sla_events(parent_correlation_id);
CREATE INDEX IF NOT EXISTS idx_sla_events_root_correlation_id ON sla_events(root_correlation_id);

-- Composite indexes for efficient SLA monitoring queries
CREATE INDEX IF NOT EXISTS idx_sla_events_project_sla_ts ON sla_events(project_id, sla_type, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sla_events_provider_sla_ts ON sla_events(provider, sla_type, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sla_events_breach_unresolved ON sla_events(sla_type, breached_at, resolved_at) WHERE resolved_at IS NULL;

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('009', datetime('now'), 'Add sla_events table for SLA breach and resolution tracking', 'sha256_sla_events_v009');
