-- Migration 002: Add indexes for event tables
-- Version: 002
-- Description: Add indexes for correlation fields and common query patterns

-- Indexes for routing_events
CREATE INDEX IF NOT EXISTS idx_routing_event_ts ON routing_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_routing_campaign_id ON routing_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_routing_dispatch_id ON routing_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_routing_trace_id ON routing_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_routing_agent_id ON routing_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_routing_provider ON routing_events(provider);
CREATE INDEX IF NOT EXISTS idx_routing_campaign_ts ON routing_events(campaign_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_routing_agent_ts ON routing_events(agent_id, event_ts DESC);
-- NOTE: routing_events does not have an 'outcome' column (it stores dispatch
-- decisions: selection_reason, agent_id, event_data). The idx_routing_outcome
-- index referenced a column that never existed in the routing_events table
-- definition (migration 001). Every boot fired "Migration failed — no such
-- column: outcome" and the migration runner aborted before applying later
-- migrations. Index removed; if outcome-style filtering on routing decisions
-- is needed later, query the event_data JSON column or add a dedicated column
-- in a new migration first.

-- Indexes for guardrail_events
CREATE INDEX IF NOT EXISTS idx_guardrail_event_ts ON guardrail_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_guardrail_campaign_id ON guardrail_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_dispatch_id ON guardrail_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_agent_id ON guardrail_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_provider ON guardrail_events(provider);
CREATE INDEX IF NOT EXISTS idx_guardrail_rule_id ON guardrail_events(rule_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_outcome ON guardrail_events(outcome);
CREATE INDEX IF NOT EXISTS idx_guardrail_campaign_ts ON guardrail_events(campaign_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_guardrail_dispatch_ts ON guardrail_events(dispatch_id, event_ts DESC);

-- Indexes for circuit_breaker_events
CREATE INDEX IF NOT EXISTS idx_cb_event_ts ON circuit_breaker_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_cb_campaign_id ON circuit_breaker_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_cb_dispatch_id ON circuit_breaker_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_cb_agent_id ON circuit_breaker_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_cb_provider ON circuit_breaker_events(provider);
-- circuit_breaker_events column is `new_state` (with `previous_state` for the
-- prior-state column), not bare `state`. Original index referenced a column
-- that doesn't exist on this table.
CREATE INDEX IF NOT EXISTS idx_cb_new_state ON circuit_breaker_events(new_state);
CREATE INDEX IF NOT EXISTS idx_cb_provider_new_state ON circuit_breaker_events(provider, new_state);
CREATE INDEX IF NOT EXISTS idx_cb_provider_ts ON circuit_breaker_events(provider, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_cb_campaign_provider_ts ON circuit_breaker_events(campaign_id, provider, event_ts DESC);

-- Indexes for anomaly_events
CREATE INDEX IF NOT EXISTS idx_anomaly_event_ts ON anomaly_events(event_ts);
CREATE INDEX IF NOT EXISTS idx_anomaly_campaign_id ON anomaly_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_dispatch_id ON anomaly_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_agent_id ON anomaly_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_provider ON anomaly_events(provider);
CREATE INDEX IF NOT EXISTS idx_anomaly_anomaly_type ON anomaly_events(anomaly_type);
CREATE INDEX IF NOT EXISTS idx_anomaly_severity ON anomaly_events(severity);
-- NOTE: anomaly_events has no `state` column (only severity, anomaly_type,
-- detail). Original index referenced a column that doesn't exist.
-- Index removed; severity + anomaly_type are already indexed individually.
CREATE INDEX IF NOT EXISTS idx_anomaly_campaign_ts ON anomaly_events(campaign_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_anomaly_agent_severity ON anomaly_events(agent_id, severity);

-- Update migration version
INSERT OR REPLACE INTO migration_versions (version, applied_at, description, checksum)
VALUES ('002', datetime('now'), 'Add indexes for event tables', 'sha256_indexes_v002');