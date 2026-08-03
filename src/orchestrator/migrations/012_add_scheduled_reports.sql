-- Migration 012: Add scheduled reports tables for recurring compliance exports
-- Version: 012
-- Description: Create report_schedules and generated_reports tables for the scheduled report generation system.
--              report_schedules stores recurring export configurations (interval, format, template, scope, retention).
--              generated_reports tracks each generated file with metadata for retrieval and retention cleanup.

-- Create report_schedules table for recurring report configurations
CREATE TABLE IF NOT EXISTS report_schedules (
    id TEXT PRIMARY KEY,
    cron_expression TEXT NOT NULL,
    format TEXT NOT NULL DEFAULT 'csv',
    template TEXT NOT NULL DEFAULT 'activity_summary',
    scope TEXT,
    retention_count INTEGER NOT NULL DEFAULT 10,
    next_run TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1
);

-- Index for finding due schedules efficiently
CREATE INDEX IF NOT EXISTS idx_report_schedules_next_run ON report_schedules(next_run) WHERE enabled = 1;

-- Create generated_reports table for tracking produced report files
CREATE TABLE IF NOT EXISTS generated_reports (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    format TEXT NOT NULL,
    scope TEXT,
    FOREIGN KEY (schedule_id) REFERENCES report_schedules(id) ON DELETE CASCADE
);

-- Index for listing reports by schedule (used for retention cleanup)
CREATE INDEX IF NOT EXISTS idx_generated_reports_schedule_id ON generated_reports(schedule_id, generated_at DESC);

-- Index for looking up reports by ID (download endpoint)
CREATE INDEX IF NOT EXISTS idx_generated_reports_id ON generated_reports(id);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('012', datetime('now'), 'Add scheduled reports tables for recurring compliance exports', 'sha256_scheduled_reports_v012');
