BEGIN;

CREATE TABLE IF NOT EXISTS routing_events (
  id TEXT PRIMARY KEY,
  event_ts TEXT NOT NULL,
  campaign_id TEXT,
  dispatch_id TEXT NOT NULL,
  trace_id TEXT,
  agent_id TEXT NOT NULL,
  provider TEXT,
  summary TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routing_events_campaign_id ON routing_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_routing_events_dispatch_id ON routing_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_routing_events_event_ts ON routing_events(event_ts);

CREATE TABLE IF NOT EXISTS guardrail_events (
  id TEXT PRIMARY KEY,
  event_ts TEXT NOT NULL,
  campaign_id TEXT,
  dispatch_id TEXT,
  trace_id TEXT,
  agent_id TEXT NOT NULL,
  provider TEXT,
  summary TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guardrail_events_campaign_id ON guardrail_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_dispatch_id ON guardrail_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_event_ts ON guardrail_events(event_ts);

CREATE TABLE IF NOT EXISTS circuit_breaker_events (
  id TEXT PRIMARY KEY,
  event_ts TEXT NOT NULL,
  campaign_id TEXT,
  dispatch_id TEXT,
  trace_id TEXT,
  agent_id TEXT,
  provider TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_events_campaign_id ON circuit_breaker_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_events_dispatch_id ON circuit_breaker_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_events_event_ts ON circuit_breaker_events(event_ts);

CREATE TABLE IF NOT EXISTS anomaly_events (
  id TEXT PRIMARY KEY,
  event_ts TEXT NOT NULL,
  campaign_id TEXT,
  dispatch_id TEXT,
  trace_id TEXT,
  agent_id TEXT NOT NULL,
  provider TEXT,
  summary TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anomaly_events_campaign_id ON anomaly_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_dispatch_id ON anomaly_events(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_event_ts ON anomaly_events(event_ts);

COMMIT;
