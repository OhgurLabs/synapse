// timeline-ingest.js — Ingestion and correlation pipeline for unified operational timeline.
//
// Accepts events from all sources (dispatch decisions, circuit-breaker transitions,
// anomaly alerts, guardrail outcomes) and stores them as normalized timeline records
// with correlation keys (campaignId, taskId, dispatchId, traceId, agentId, provider).
//
// Retention: events older than retentionMs are pruned on each ingest and during
// periodic cleanup intervals. A hard maxSize cap prevents unbounded growth.
//
// Usage:
//   const store = createTimelineStore({ retentionMs: 7 * 24 * 60 * 60 * 1000 });
//   store.startCleanup();
//   store.ingest('guardrail', payload, { campaignId, traceId, agentId, provider });
//   const { events, total } = store.query({ type: 'guardrail', agentId: 'alice' });
//   store.stopCleanup();

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { EVENT_TYPES, VALID_EVENT_TYPES, extractCorrelationKeys, validateTimelineEvent } from './timeline-schema.js';
import {
  mapDispatchEvent,
  mapCbTransitionEvent,
  mapAnomalyAlertEvent,
  mapGuardrailEvent,
  mapOperatorActionEvent,
  mapDeliberationRequestEvent,
  mapDeliberationFeedbackEvent,
  mapDeliberationRevisionEvent,
  mapArgumentSubmittedEvent,
  mapChallengeRaisedEvent,
  mapSynthesisProducedEvent,
  mapRevisionCompletedEvent,
  mapToolInvocationStartEvent,
  mapToolInvocationSuccessEvent,
  mapToolInvocationErrorEvent,
  mapToolInvocationEvent,
  mapNativeToolInvocationEvent,
} from './timeline-event-mappers.js';
import { validateDispatchWindow } from './dispatch-window-validator.js';
import { createCorrelationMetrics, FAILURE_REASONS } from './correlation-metrics.js';

const log = createLogger('timeline-ingest');

const DEFAULT_RETENTION_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_SIZE         = 10_000;
const DEFAULT_CLEANUP_INTERVAL = 60 * 60 * 1000;           // 1 hour

function normalizePositiveInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

/**
 * Supported timeline event types.
 * Extend this list when adding new sources.
 */
const TYPE_ALIASES = new Map([
  ['circuit-breaker', EVENT_TYPES.CIRCUIT_BREAKER],
  ['circuit_breaker', EVENT_TYPES.CIRCUIT_BREAKER],
  ['cb', EVENT_TYPES.CIRCUIT_BREAKER],
  ['anomaly', EVENT_TYPES.ANOMALY_ALERT],
  ['anomaly_alert', EVENT_TYPES.ANOMALY_ALERT],
  ['guardrail', EVENT_TYPES.GUARDRAIL_OUTCOME],
  ['guardrail_outcome', EVENT_TYPES.GUARDRAIL_OUTCOME],
  ['dispatch_decision', EVENT_TYPES.DISPATCH],
  ['dispatch', EVENT_TYPES.DISPATCH],
  ['error_pattern_constraint', EVENT_TYPES.ERROR_PATTERN_CONSTRAINT],
  ['error-pattern-constraint', EVENT_TYPES.ERROR_PATTERN_CONSTRAINT],
  ['deliberation', EVENT_TYPES.DELIBERATION_REQUEST],
  ['deliberation_request', EVENT_TYPES.DELIBERATION_REQUEST],
  ['delib_request', EVENT_TYPES.DELIBERATION_REQUEST],
  ['deliberation_feedback', EVENT_TYPES.DELIBERATION_FEEDBACK],
  ['delib_feedback', EVENT_TYPES.DELIBERATION_FEEDBACK],
  ['deliberation_challenge', EVENT_TYPES.DELIBERATION_FEEDBACK],
  ['deliberation_review', EVENT_TYPES.DELIBERATION_FEEDBACK],
  ['deliberation_revision', EVENT_TYPES.DELIBERATION_REVISION],
  ['delib_revision', EVENT_TYPES.DELIBERATION_REVISION],
  ['deliberation_synthesis', EVENT_TYPES.DELIBERATION_REVISION],
  ['argument_submitted', EVENT_TYPES.ARGUMENT_SUBMITTED],
  ['argument_submission', EVENT_TYPES.ARGUMENT_SUBMITTED],
  ['challenge_raised', EVENT_TYPES.CHALLENGE_RAISED],
  ['challenge_submission', EVENT_TYPES.CHALLENGE_RAISED],
  ['synthesis_produced', EVENT_TYPES.SYNTHESIS_PRODUCED],
  ['synthesis_production', EVENT_TYPES.SYNTHESIS_PRODUCED],
  ['revision_completed', EVENT_TYPES.REVISION_COMPLETED],
  ['revision_completion', EVENT_TYPES.REVISION_COMPLETED],
  ['tool_invocation_start', EVENT_TYPES.TOOL_INVOCATION_START],
  ['mcp:tool_invocation_start', EVENT_TYPES.TOOL_INVOCATION_START],
  ['tool_invocation_success', EVENT_TYPES.TOOL_INVOCATION_SUCCESS],
  ['mcp:tool_invocation_success', EVENT_TYPES.TOOL_INVOCATION_SUCCESS],
  ['tool_invocation_error', EVENT_TYPES.TOOL_INVOCATION_ERROR],
  ['mcp:tool_invocation_error', EVENT_TYPES.TOOL_INVOCATION_ERROR],
  ['native_tool_invocation', EVENT_TYPES.NATIVE_TOOL_INVOCATION],
  ['native:tool_invocation', EVENT_TYPES.NATIVE_TOOL_INVOCATION],
  ['tool_invocation', EVENT_TYPES.TOOL_INVOCATION],
]);

export const TIMELINE_EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPES));

function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return value;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeType(value) {
  if (!value) return null;
  return TYPE_ALIASES.get(value) || value;
}

/**
 * Encode a cursor from the last event in a page.
 * Cursor is base64 of JSON `{ timestamp, seq }`.
 * @param {object} event – timeline event with timestamp and _seq
 * @returns {string} base64-encoded cursor
 */
function encodeCursor(event) {
  if (!event) return null;
  const ts = Date.parse(event.timestamp) || 0;
  const seq = event._seq || 0;
  return Buffer.from(JSON.stringify({ timestamp: ts, seq })).toString('base64');
}

/**
 * Decode a base64 cursor string into { timestamp, seq }.
 * @param {string} cursor – base64-encoded cursor
 * @returns {{ timestamp: number, seq: number } | null}
 */
function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (typeof parsed.timestamp !== 'number' || typeof parsed.seq !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * TimelineStore — in-memory correlation store for operational timeline events.
 * All events are keyed by correlation IDs for drill-down and filtering.
 */
export class TimelineStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.retentionMs]     – max age of events in ms (default 7 days)
   * @param {number} [opts.maxSize]         – hard cap on event count (default 10,000)
   * @param {number} [opts.cleanupInterval] – periodic cleanup interval in ms (default 1 hour)
   * @param {import('../dispatch-log.js').DispatchLog} [opts.dispatchLog] – dispatch log for window validation
   */
  constructor(opts = {}) {
    this._events = [];
    this._seq = 0;
    this._retentionMs = normalizePositiveInteger(opts.retentionMs, DEFAULT_RETENTION_MS);
    this._maxSize = normalizePositiveInteger(opts.maxSize, DEFAULT_MAX_SIZE);
    this._cleanupInterval = normalizePositiveInteger(opts.cleanupInterval, DEFAULT_CLEANUP_INTERVAL);
    this._cleanupTimer    = null;
    this._dispatchLog     = opts.dispatchLog || null;
    this._correlationMetrics = opts.correlationMetrics || createCorrelationMetrics();
  }

  /**
   * Return the CorrelationMetrics instance for monitoring.
   * @returns {import('./correlation-metrics.js').CorrelationMetrics}
   */
  getCorrelationMetrics() {
    return this._correlationMetrics;
  }

  /**
   * Set or replace the DispatchLog instance used for correlation fallback.
   * @param {Object} dispatchLog - DispatchLog instance with getById(id) method
   */
  setDispatchLog(dispatchLog) {
    this._dispatchLog = dispatchLog || null;
  }

  /**
   * Ingest a normalized event into the timeline store.
   *
   * @param {string} eventType     – one of TIMELINE_EVENT_TYPES
   * @param {object} payload       – source-specific data; may include timestamp, agentId, etc.
   * @param {object} correlationKeys – explicit correlation overrides:
   *   { campaignId, taskId, dispatchId, traceId, agentId, provider }
   * @returns {object} the stored event record
   */
  ingest(eventType, payload = {}, correlationKeys = {}) {
    const type = normalizeType(eventType);
    if (!type || !VALID_EVENT_TYPES.has(type)) {
      log.warn('Ignoring timeline event with invalid type', { eventType });
      return null;
    }

    const timestamp = toIso(payload.timestamp)
      || toIso(payload.firedAt)
      || toIso(payload.resolvedAt)
      || new Date().toISOString();

    // Merge correlation keys: explicit overrides win, then payload fields, then null
    const merged = {
      campaignId: correlationKeys.campaignId ?? payload.campaignId ?? null,
      taskId:     correlationKeys.taskId     ?? payload.taskId     ?? null,
      dispatchId: correlationKeys.dispatchId ?? payload.dispatchId ?? null,
      traceId:    correlationKeys.traceId    ?? payload.traceId    ?? null,
      agentId:    correlationKeys.agentId    ?? payload.agentId    ?? null,
      provider:   correlationKeys.provider   ?? payload.provider   ?? null,
    };

    // Fallback: if dispatchId is known but other keys are missing, resolve from dispatch log
    const fallbackResult = this._resolveCorrelationFallback(merged);
    this._recordCorrelationOutcome(merged, fallbackResult);

    const summary = payload.summary
      || payload.message
      || payload.detail
      || `${type.replace(/_/g, ' ')} event`;

    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload }
      : {};

    this._applyDispatchWindowValidation({ type, timestamp, correlationKeys: merged, data });

    const event = {
      id:             `tl-${type}-${randomUUID()}`,
      type,
      timestamp,
      summary,
      correlationKeys: merged,
      data,
      ingestedAt:     new Date().toISOString(),
      _seq:           ++this._seq,
    };

    this._events.push(event);
    this._prune();
    return event;
  }

  /**
   * Query timeline events with optional filters.
   *
   * @param {object} [filters]
   * @param {string}  [filters.type]       – event type filter
   * @param {string}  [filters.campaignId] – correlation key filter
   * @param {string}  [filters.agentId]    – correlation key filter
   * @param {string}  [filters.provider]   – correlation key filter
   * @param {string}  [filters.traceId]    – correlation key filter
   * @param {string}  [filters.since]      – ISO timestamp lower bound (inclusive)
   * @param {string}  [filters.until]      – ISO timestamp upper bound (inclusive)
   * @param {number}  [filters.limit]      – max results (default 100)
   * @param {number}  [filters.offset]     – results to skip (default 0)
   * @param {string}  [filters.cursor]     – base64-encoded cursor for cursor-based pagination
   * @returns {{ events: object[], total: number, total_count: number, next_cursor: string|null }}
   */
  query(filters = {}) {
    this._prune();

    let events = this._events;

    if (filters.type) {
      const normalized = normalizeType(filters.type);
      events = events.filter(e => e.type === normalized);
    }
    if (filters.campaignId) {
      events = events.filter(e => e.correlationKeys.campaignId === filters.campaignId);
    }
    if (filters.taskId) {
      events = events.filter(e => e.correlationKeys.taskId === filters.taskId);
    }
    if (filters.agentId) {
      events = events.filter(e => e.correlationKeys.agentId === filters.agentId);
    }
    if (filters.provider) {
      events = events.filter(e => e.correlationKeys.provider === filters.provider);
    }
    if (filters.traceId) {
      events = events.filter(e => e.correlationKeys.traceId === filters.traceId);
    }
    if (filters.dispatchId) {
      events = events.filter(e => e.correlationKeys.dispatchId === filters.dispatchId);
    }
    if (filters.since) {
      events = events.filter(e => e.timestamp >= filters.since);
    }
    if (filters.until) {
      events = events.filter(e => e.timestamp <= filters.until);
    }

    // Sort by timestamp DESC, then by insertion seq DESC for deterministic tie-breaking
    const sorted = [...events].sort((a, b) => {
      const ta = Date.parse(a.timestamp) || 0;
      const tb = Date.parse(b.timestamp) || 0;
      if (ta !== tb) return tb - ta;
      return (b._seq || 0) - (a._seq || 0);
    });

    const total_count = sorted.length;
    const limit = Math.max(1, Math.min(filters.limit || 100, 500));

    // Cursor-based pagination: when cursor is provided, skip past already-seen events
    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (!decoded) {
        return { events: [], total: total_count, total_count, next_cursor: null, error: 'invalid_cursor' };
      }

      // Since results are sorted DESC (newest first), the cursor marks the last event
      // seen on the previous page. We skip events until we pass the cursor position.
      // An event is "before" the cursor (already seen) if:
      //   - its timestamp > cursor.timestamp (newer, already shown), OR
      //   - its timestamp === cursor.timestamp AND its _seq >= cursor.seq (same time, higher or equal seq already shown)
      const cursorTs = decoded.timestamp;
      const cursorSeq = decoded.seq;

      let startIdx = 0;
      for (let i = 0; i < sorted.length; i++) {
        const eventTs = Date.parse(sorted[i].timestamp) || 0;
        const eventSeq = sorted[i]._seq || 0;
        if (eventTs < cursorTs || (eventTs === cursorTs && eventSeq < cursorSeq)) {
          startIdx = i;
          break;
        }
      }

      // If we never found an event past the cursor, return empty
      if (startIdx === 0 && sorted.length > 0) {
        const firstTs = Date.parse(sorted[0].timestamp) || 0;
        const firstSeq = sorted[0]._seq || 0;
        if (firstTs > cursorTs || (firstTs === cursorTs && firstSeq >= cursorSeq)) {
          // All events are at or before cursor position — check if any are past it
          let found = false;
          for (let i = 0; i < sorted.length; i++) {
            const eTs = Date.parse(sorted[i].timestamp) || 0;
            const eSeq = sorted[i]._seq || 0;
            if (eTs < cursorTs || (eTs === cursorTs && eSeq < cursorSeq)) {
              startIdx = i;
              found = true;
              break;
            }
          }
          if (!found) {
            return { events: [], total: total_count, total_count, next_cursor: null };
          }
        }
      }

      const page = sorted.slice(startIdx, startIdx + limit);
      const next_cursor = (startIdx + limit < sorted.length)
        ? encodeCursor(page[page.length - 1])
        : null;

      return { events: page, total: total_count, total_count, next_cursor };
    }

    // Offset-based pagination (fallback when no cursor is provided)
    const offset = Math.max(0, filters.offset || 0);
    const page = sorted.slice(offset, offset + limit);
    const next_cursor = (offset + limit < sorted.length)
      ? encodeCursor(page[page.length - 1])
      : null;

    return {
      events: page,
      total: total_count,
      total_count,
      next_cursor,
    };
  }

  /**
   * Return the count of currently stored events (before any filters).
   */
  size() {
    this._prune();
    return this._events.length;
  }

  /**
   * Ingest a fully normalized timeline event.
   * @param {object} event - normalized timeline event (schema-aligned)
   * @returns {object|null} stored event
   */
  ingestEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const type = normalizeType(event.type);
    if (!type || !VALID_EVENT_TYPES.has(type)) {
      log.warn('Ignoring timeline event with invalid type', { type: event?.type });
      return null;
    }

    const normalized = {
      ...event,
      id: event.id || `tl-${type}-${randomUUID()}`,
      type,
      timestamp: toIso(event.timestamp) || new Date().toISOString(),
      summary: event.summary || `${type.replace(/_/g, ' ')} event`,
      data: event.data || {},
    };
    normalized.correlationKeys = extractCorrelationKeys(normalized);

    // Fallback: if dispatchId is known but other keys are missing, resolve from dispatch log
    const fallbackResult = this._resolveCorrelationFallback(normalized.correlationKeys);
    this._recordCorrelationOutcome(normalized.correlationKeys, fallbackResult);

    this._applyDispatchWindowValidation({
      type,
      timestamp: normalized.timestamp,
      correlationKeys: normalized.correlationKeys,
      data: normalized.data,
    });

    const validation = validateTimelineEvent(normalized);
    if (!validation.valid) {
      log.warn('Timeline event failed schema validation', {
        type,
        errors: validation.errors,
        event: normalized, // Added for debugging
      });
      return null;
    }
    const stored = { ...normalized, ingestedAt: new Date().toISOString(), _seq: ++this._seq };
    this._events.push(stored);
    this._prune();
    return stored;
  }

  ingestDispatchDecision(record) {
    return this.ingestEvent(mapDispatchEvent(record));
  }

  ingestCbTransition(record) {
    return this.ingestEvent(mapCbTransitionEvent(record));
  }

  ingestAnomalyAlert(entry, index = 0) {
    return this.ingestEvent(mapAnomalyAlertEvent(entry, index));
  }

  ingestGuardrailOutcome(entry, index = 0) {
    return this.ingestEvent(mapGuardrailEvent(entry, index));
  }

  ingestOperatorAction(record) {
    return this.ingestEvent(mapOperatorActionEvent(record));
  }

  ingestDeliberationRequest(record) {
    return this.ingestEvent(mapDeliberationRequestEvent(record));
  }

  ingestDeliberationFeedback(record) {
    return this.ingestEvent(mapDeliberationFeedbackEvent(record));
  }

  ingestDeliberationRevision(record) {
    return this.ingestEvent(mapDeliberationRevisionEvent(record));
  }

  ingestArgumentSubmitted(record) {
    return this.ingestEvent(mapArgumentSubmittedEvent(record));
  }

  ingestChallengeRaised(record) {
    return this.ingestEvent(mapChallengeRaisedEvent(record));
  }

  ingestSynthesisProduced(record) {
    return this.ingestEvent(mapSynthesisProducedEvent(record));
  }

  ingestRevisionCompleted(record) {
    return this.ingestEvent(mapRevisionCompletedEvent(record));
  }

  ingestToolInvocationStart(record) {
    return this.ingestEvent(mapToolInvocationStartEvent(record));
  }

  ingestToolInvocationSuccess(record) {
    return this.ingestEvent(mapToolInvocationSuccessEvent(record));
  }

  ingestToolInvocationError(record) {
    return this.ingestEvent(mapToolInvocationErrorEvent(record));
  }

  ingestNativeToolInvocation(record) {
    return this.ingestEvent(mapNativeToolInvocationEvent(record));
  }

  ingestToolInvocation(record) {
    return this.ingestEvent(mapToolInvocationEvent(record));
  }

  /**
   * Validate event timestamp against dispatch window and annotate data when available.
   * @param {object} options
   * @param {string} options.type
   * @param {string} options.timestamp
   * @param {object} options.correlationKeys
   * @param {object} options.data
   * @returns {object|null} normalized validation result
   */
  _applyDispatchWindowValidation({ type, timestamp, correlationKeys, data }) {
    if (!this._dispatchLog) return null;
    if (!correlationKeys?.dispatchId) return null;
    if (typeof validateDispatchWindow !== 'function') return null;

    let result;
    try {
      result = validateDispatchWindow({
        dispatchLog: this._dispatchLog,
        dispatchId: correlationKeys.dispatchId,
        eventTimestamp: timestamp,
        eventType: type,
      });
    } catch (err) {
      log.warn('Dispatch window validation failed', {
        type,
        dispatchId: correlationKeys.dispatchId,
        timestamp,
        error: err.message,
      });
      return null;
    }

    if (result === null || result === undefined) return null;
    const normalized = typeof result === 'boolean' ? { valid: result } : result;

    if (normalized && normalized.valid === false) {
      log.warn('Timeline event outside dispatch window', {
        type,
        dispatchId: correlationKeys.dispatchId,
        timestamp,
        window: normalized,
      });
      if (this._correlationMetrics) {
        this._correlationMetrics.recordOutOfWindow();
      }
    }

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data.dispatchWindow = normalized;
    }

    return normalized;
  }

  /**
   * Attempt to backfill missing correlation keys by looking up the dispatch record.
   * Only triggers when dispatchId is present and at least one other key is null.
   *
   * @param {object} merged - Mutable correlation keys bag
   * @returns {'none'|'backfilled'|'not_found'|'error'} outcome of fallback attempt
   */
  _resolveCorrelationFallback(merged) {
    if (!this._dispatchLog || !merged.dispatchId) return 'none';

    // Check if any key besides dispatchId is missing
    const hasGap = merged.campaignId === null
      || merged.taskId === null
      || merged.traceId === null
      || merged.agentId === null
      || merged.provider === null;
    if (!hasGap) return 'none';

    let record;
    try {
      record = this._dispatchLog.getById(merged.dispatchId);
    } catch (err) {
      log.warn('Correlation fallback: failed to query dispatch log', { dispatchId: merged.dispatchId, error: err.message });
      return 'error';
    }

    if (!record) return 'not_found';

    let backfilled = false;
    if (merged.campaignId === null && record.campaignId) {
      merged.campaignId = record.campaignId;
      backfilled = true;
    }
    if (merged.taskId === null && record.taskId) {
      merged.taskId = record.taskId;
      backfilled = true;
    }
    if (merged.traceId === null && record.traceId) {
      merged.traceId = record.traceId;
      backfilled = true;
    }
    if (merged.agentId === null && record.selectedAgent) {
      merged.agentId = record.selectedAgent;
      backfilled = true;
    }
    if (merged.provider === null && record.provider) {
      merged.provider = record.provider;
      backfilled = true;
    }

    if (backfilled) {
      log.info('Correlation fallback: backfilled keys from dispatch log', { dispatchId: merged.dispatchId });
    }

    return backfilled ? 'backfilled' : 'none';
  }

  /**
   * Record correlation outcome to the metrics tracker based on fallback result.
   * @param {object} merged - Correlation keys after resolution
   * @param {'none'|'backfilled'|'not_found'|'error'} fallbackResult
   */
  _recordCorrelationOutcome(merged, fallbackResult) {
    if (!this._correlationMetrics) return;

    switch (fallbackResult) {
      case 'backfilled':
        this._correlationMetrics.recordFallback();
        break;
      case 'not_found':
        this._correlationMetrics.recordFailure(FAILURE_REASONS.DISPATCH_NOT_FOUND);
        break;
      case 'error':
        this._correlationMetrics.recordFailure(FAILURE_REASONS.LOOKUP_ERROR);
        break;
      default:
        // 'none' — either no fallback needed or no dispatchId at all
        if (!merged.dispatchId) {
          this._correlationMetrics.recordFailure(FAILURE_REASONS.MISSING_DISPATCH_ID);
        } else {
          this._correlationMetrics.recordSuccess();
        }
        break;
    }
  }

  /**
   * Remove events older than retentionMs and enforce maxSize cap.
   * Called automatically after each ingest; also runs on schedule if startCleanup() was called.
   */
  _prune() {
    const cutoff = Date.now() - this._retentionMs;
    this._events = this._events.filter(e => {
      const ts = Date.parse(e.timestamp) || 0;
      return ts >= cutoff;
    });

    // Hard cap: keep only the most recent maxSize events
    if (this._events.length > this._maxSize) {
      this._events = this._events.slice(-this._maxSize);
    }
  }

  /**
   * Start periodic cleanup timer. Safe to call multiple times.
   */
  startCleanup() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      const before = this._events.length;
      this._prune();
      const pruned = before - this._events.length;
      if (pruned > 0) {
        log.info('Timeline store pruned stale events', { pruned, remaining: this._events.length });
      }
    }, this._cleanupInterval);
    // Don't hold Node.js open for timer alone
    this._cleanupTimer.unref?.();
    log.info('Timeline store cleanup started', { retentionMs: this._retentionMs, cleanupInterval: this._cleanupInterval });
  }

  /**
   * Stop periodic cleanup timer.
   */
  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

/**
 * Factory — creates and optionally starts a TimelineStore.
 *
 * @param {object} [opts] – same as TimelineStore constructor opts
 * @param {boolean} [opts.autoStart=false] – call startCleanup() immediately
 * @returns {TimelineStore}
 */
export function createTimelineStore(opts = {}) {
  const { autoStart = false, ...storeOpts } = opts;
  const store = new TimelineStore(storeOpts);
  if (autoStart) store.startCleanup();
  return store;
}

/**
 * Wire EventBus hooks to persist timeline events.
 * @param {object} options
 * @param {import('../events.js').EventBus} options.events
 * @param {TimelineStore} options.timelineStore - In-memory timeline store
 * @param {Object} options.sqliteTimelineStore - SQLite timeline store for persistence (optional)
 * @returns {() => void} unsubscribe function
 */
export function bindTimelineIngest({ events, timelineStore, sqliteTimelineStore }) {
  if (!events || !timelineStore) return () => {};

  const unsubscribers = [];

  // Dispatch decisions (emitted by dispatch system)
  unsubscribers.push(events.on('dispatch:decision', (record) => {
    timelineStore.ingestDispatchDecision(record);
  }));

  // Circuit breaker transitions
  for (const name of ['circuit_breaker:open', 'circuit_breaker:half_open', 'circuit_breaker:closed']) {
    unsubscribers.push(events.on(name, (payload) => {
      timelineStore.ingestCbTransition(payload);
    }));
  }

  // Anomaly alerts
  unsubscribers.push(events.on('alert:firing', (payload) => {
    timelineStore.ingestAnomalyAlert(payload);
  }));
  unsubscribers.push(events.on('alert:resolved', (payload) => {
    timelineStore.ingestAnomalyAlert(payload);
  }));

  // Guardrail outcomes
  unsubscribers.push(events.on('guardrail:outcome', (payload) => {
    timelineStore.ingestGuardrailOutcome(payload);
  }));

  // Operator actions (guard actions: replay, weight override, CB hold/reset, alert ack)
  unsubscribers.push(events.on('operator:action', (payload) => {
    timelineStore.ingestOperatorAction(payload);
  }));

  // Deliberation review-and-revise workflow events
  unsubscribers.push(events.on('review_requested', (payload) => {
    timelineStore.ingestDeliberationRequest(payload);
  }));
  unsubscribers.push(events.on('feedback_received', (payload) => {
    timelineStore.ingestDeliberationFeedback(payload);
  }));
  unsubscribers.push(events.on('revision_started', (payload) => {
    timelineStore.ingestDeliberationRevision(payload);
  }));
  unsubscribers.push(events.on('revision_accepted', (payload) => {
    timelineStore.ingestDeliberationFeedback(payload);
  }));
  unsubscribers.push(events.on('max_iterations_reached', (payload) => {
    timelineStore.ingestDeliberationFeedback(payload);
  }));
  unsubscribers.push(events.on('deliberation:argument_submitted', (payload) => {
    timelineStore.ingestArgumentSubmitted(payload);
  }));
  unsubscribers.push(events.on('deliberation:challenge_raised', (payload) => {
    timelineStore.ingestChallengeRaised(payload);
  }));
  unsubscribers.push(events.on('deliberation:synthesis_produced', (payload) => {
    timelineStore.ingestSynthesisProduced(payload);
  }));
  unsubscribers.push(events.on('deliberation:revision_completed', (payload) => {
     timelineStore.ingestRevisionCompleted(payload);
   }));

   // Additional deliberation session lifecycle events
   unsubscribers.push(events.on('deliberation:session_initiated', (payload) => {
     timelineStore.ingestDeliberationRequest(payload);
   }));
   unsubscribers.push(events.on('deliberation:session_created', (payload) => {
     timelineStore.ingestDeliberationRequest(payload);
   }));
   unsubscribers.push(events.on('deliberation:session_timeout', (payload) => {
     timelineStore.ingestDeliberationFeedback(payload);
   }));
   unsubscribers.push(events.on('deliberation:session_completed', (payload) => {
     timelineStore.ingestRevisionCompleted(payload);
   }));
   unsubscribers.push(events.on('deliberation:phase_changed', (payload) => {
     timelineStore.ingestDeliberationFeedback(payload);
   }));
   unsubscribers.push(events.on('deliberation:message_added', (payload) => {
     timelineStore.ingestArgumentSubmitted(payload);
   }));
   unsubscribers.push(events.on('deliberation:review_requested', (payload) => {
     timelineStore.ingestDeliberationRequest(payload);
   }));
   unsubscribers.push(events.on('deliberation:feedback_received', (payload) => {
     timelineStore.ingestDeliberationFeedback(payload);
   }));

 // Native Tool Invocation events
    unsubscribers.push(events.on('native_tool_invocation', (payload) => {
      timelineStore.ingestNativeToolInvocation(payload);
    }));

   return () => {
    for (const un of unsubscribers) {
      if (typeof un === 'function') un();
    }
  };
}

export { encodeCursor, decodeCursor };
export default createTimelineStore;
