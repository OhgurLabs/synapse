-- Migration 006: Add analytics_signals table for routing signal persistence
-- Version: 006
-- Description: Create analytics_signals table to persist routing signals from daily analytics job

-- Create analytics_signals table
CREATE TABLE IF NOT EXISTS analytics_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  task_category TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  success_rate REAL NOT NULL,
  p50_latency_ms REAL NOT NULL,
  p95_latency_ms REAL NOT NULL,
  guardrail_violation_rate REAL NOT NULL DEFAULT 0,
  routing_weight REAL NOT NULL DEFAULT 1.0,
  weight_confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT,
  notes TEXT
);

-- Create unique constraint on provider, task_category, and window to prevent duplicate runs
-- Use COALESCE to treat NULL task_category as empty string, since SQLite treats NULLs as distinct in UNIQUE indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_signals_window
  ON analytics_signals(provider, COALESCE(task_category, ''), window_start, window_end);

-- Create index for fetching latest signal per provider (router query pattern)
CREATE INDEX IF NOT EXISTS idx_analytics_signals_provider_generated
  ON analytics_signals(provider, generated_at DESC);

-- Create index for staleness sweeps and alert monitoring
CREATE INDEX IF NOT EXISTS idx_analytics_signals_generated
  ON analytics_signals(generated_at);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('006', datetime('now'), 'Add analytics_signals table', 'sha256_analytics_signals_v006');
