BEGIN;

DROP INDEX IF EXISTS idx_anomaly_events_event_ts;
DROP INDEX IF EXISTS idx_anomaly_events_dispatch_id;
DROP INDEX IF EXISTS idx_anomaly_events_campaign_id;
DROP TABLE IF EXISTS anomaly_events;

DROP INDEX IF EXISTS idx_circuit_breaker_events_event_ts;
DROP INDEX IF EXISTS idx_circuit_breaker_events_dispatch_id;
DROP INDEX IF EXISTS idx_circuit_breaker_events_campaign_id;
DROP TABLE IF EXISTS circuit_breaker_events;

DROP INDEX IF EXISTS idx_guardrail_events_event_ts;
DROP INDEX IF EXISTS idx_guardrail_events_dispatch_id;
DROP INDEX IF EXISTS idx_guardrail_events_campaign_id;
DROP TABLE IF EXISTS guardrail_events;

DROP INDEX IF EXISTS idx_routing_events_event_ts;
DROP INDEX IF EXISTS idx_routing_events_dispatch_id;
DROP INDEX IF EXISTS idx_routing_events_campaign_id;
DROP TABLE IF EXISTS routing_events;

COMMIT;
