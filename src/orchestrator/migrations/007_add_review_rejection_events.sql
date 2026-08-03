-- Migration 007: Add review_rejection_events table for rejection->rework tracking
-- Version: 007
-- Description: Create review_rejection_events table with indexes for rejection tracking
-- Note: Schema must match timeline-store.js _initTables()

-- Create review_rejection_events table
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

-- Indexes for review_rejection_events
CREATE INDEX IF NOT EXISTS idx_review_rejection_event_ts ON review_rejection_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_review_rejection_campaign_id ON review_rejection_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_review_rejection_task_id ON review_rejection_events(task_id);
CREATE INDEX IF NOT EXISTS idx_review_rejection_cycle ON review_rejection_events(task_id, cycle_number DESC);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('007', datetime('now'), 'Add review_rejection_events table', 'sha256_review_rejection_v007');
