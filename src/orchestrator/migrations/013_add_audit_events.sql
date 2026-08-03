-- Migration 013: Add audit_events table for comprehensive agent action logging
-- Version: 013
-- Description: Create audit_events table for append-only audit log capturing every agent action
--              with trace correlation, time-range queries, and graceful degradation support.
--              Required for Distributed Tracing & Audit Infrastructure milestone.

-- Create audit_events table for comprehensive audit logging
CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY,
    trace_id TEXT,
    agent_id TEXT,
    event_ts TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    action_type TEXT NOT NULL CHECK (action_type IN ('dispatch', 'state_read', 'state_write', 'decision', 'handoff', 'error', 'escalation')),
    input_summary TEXT,
    output_summary TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'skipped')),
    campaign_id TEXT,
    task_id TEXT,
    subtask_id TEXT,
    event_data TEXT NOT NULL DEFAULT '{}'
);

-- Indexes aligned with TIMELINE_TABLES in timeline-schema.js
CREATE INDEX IF NOT EXISTS idx_audit_event_ts ON audit_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_agent_ts ON audit_events(agent_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_campaign_id ON audit_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_audit_campaign_ts ON audit_events(campaign_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trace_id ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_action_type ON audit_events(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_action_type_ts ON audit_events(action_type, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_task_id ON audit_events(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_subtask_id ON audit_events(subtask_id);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('013', datetime('now'), 'Add audit_events table for comprehensive agent action logging with trace correlation', 'sha256_audit_events_v013');
