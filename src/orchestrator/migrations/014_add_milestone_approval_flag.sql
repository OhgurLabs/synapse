-- Migration 014: Add approval_requests table for milestone approval gate infrastructure
-- Version: 014
-- Description: Create approval_requests table for tracking milestone approval gates with requireApproval flag.
--              Supports pause/resume lifecycle, operator /approve command audit trail, and timeout scenarios.
--              Required for Approval Gate Infrastructure milestone.

-- Create approval_requests table for milestone approval tracking
CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    milestone_id TEXT NOT NULL,
    milestone_title TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    rejected_by TEXT,
    rejected_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'timeout')),
    timeout_at TEXT,
    operator_notes TEXT,
    trace_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    event_data TEXT NOT NULL DEFAULT '{}'
);

-- Indexes for efficient approval request queries
CREATE INDEX IF NOT EXISTS idx_approval_campaign_id ON approval_requests(campaign_id);
CREATE INDEX IF NOT EXISTS idx_approval_milestone_id ON approval_requests(milestone_id);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requested_at ON approval_requests(requested_at);
CREATE INDEX IF NOT EXISTS idx_approval_campaign_status ON approval_requests(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_timeout ON approval_requests(timeout_at) WHERE status = 'pending';

-- Create milestone_events table for audit trail of milestone state changes
CREATE TABLE IF NOT EXISTS milestone_events (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    milestone_id TEXT NOT NULL,
    event_ts TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'paused_for_approval', 'resumed', 'completed', 'failed', 'skipped', 'approval_requested', 'approval_granted', 'approval_rejected', 'approval_timeout')),
    previous_status TEXT,
    new_status TEXT,
    operator_id TEXT,
    reason TEXT,
    trace_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    event_data TEXT NOT NULL DEFAULT '{}'
);

-- Indexes for milestone event timeline queries
CREATE INDEX IF NOT EXISTS idx_milestone_event_ts ON milestone_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_milestone_campaign_id ON milestone_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_milestone_milestone_id ON milestone_events(milestone_id);
CREATE INDEX IF NOT EXISTS idx_milestone_campaign_ts ON milestone_events(campaign_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_milestone_event_type ON milestone_events(event_type);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('014', datetime('now'), 'Add approval_requests and milestone_events tables for approval gate infrastructure', 'sha256_approval_gates_v014');
