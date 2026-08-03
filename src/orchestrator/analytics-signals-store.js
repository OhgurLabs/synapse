import Database from '../persistence/sqlite-provider.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';
import { createDatabaseWithRecovery } from './db-recovery.js';

const log = createLogger('analytics-signals-store');

/**
 * AnalyticsSignalsStore — SQLite-backed store for routing signals.
 *
 * Provides:
 * - Latest signal per provider (with 48h freshness check)
 * - Last-known-good fallback when signals are stale
 * - Freshness metadata for staleness detection
 *
 * Contract:
 * - Analytics job writes signals daily (window_end typically 23:59:59Z for prior day)
 * - Router reads newest row per provider where generated_at <= 48h
 * - If newest row is older than 48h, it's still returned as last-known-good but flagged as stale
 * - If no rows exist for a provider, returns null
 */
export class AnalyticsSignalsStore {
  /**
   * @param {Object} options
   * @param {string} options.dbPath - Path to the SQLite database (timeline db)
   * @param {number} [options.stalenessThresholdMs] - Threshold for stale signals (default 48h)
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this.stalenessThresholdMs = options.stalenessThresholdMs || 48 * 60 * 60 * 1000; // 48 hours
    this._emitter = new EventEmitter();

    this._ensureParentDir();

    // Use recovery-aware database creation
    this.db = createDatabaseWithRecovery(this.dbPath, {
      emitter: this._emitter,
      enableRecovery: true,
    });

    this.db.pragma('journal_mode = WAL');
    this._prepareStatements();
  }

  _ensureParentDir() {
    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _prepareStatements() {
    // Get latest signal for a specific provider (optionally filtered by task_category)
    this._getLatestStmt = this.db.prepare(`
      SELECT
        id,
        provider,
        task_category,
        window_start,
        window_end,
        generated_at,
        success_rate,
        p50_latency_ms,
        p95_latency_ms,
        guardrail_violation_rate,
        routing_weight,
        weight_confidence,
        source,
        notes,
        -- Calculate freshness in seconds (SQLite julianday returns fractional days)
        CAST((julianday('now') - julianday(generated_at)) * 86400 AS INTEGER) AS age_seconds
      FROM analytics_signals
      WHERE provider = ?
        AND (task_category = ? OR (task_category IS NULL AND ? IS NULL))
      ORDER BY generated_at DESC
      LIMIT 1
    `);

    // Get latest signals for all providers (global task_category only)
    this._getAllLatestStmt = this.db.prepare(`
      SELECT
        id,
        provider,
        task_category,
        window_start,
        window_end,
        generated_at,
        success_rate,
        p50_latency_ms,
        p95_latency_ms,
        guardrail_violation_rate,
        routing_weight,
        weight_confidence,
        source,
        notes,
        CAST((julianday('now') - julianday(generated_at)) * 86400 AS INTEGER) AS age_seconds
      FROM analytics_signals
      WHERE id IN (
        SELECT MAX(id)
        FROM analytics_signals
        WHERE task_category IS NULL
        GROUP BY provider
      )
    `);

    // Get recent signal snapshots for degradation detection
    this._getRecentSnapshotsStmt = this.db.prepare(`
      SELECT
        provider,
        task_category,
        window_start,
        window_end,
        generated_at,
        success_rate,
        dispatch_count,
        computed_at
      FROM (
        SELECT
          provider,
          task_category,
          window_start,
          window_end,
          generated_at,
          success_rate,
          json_extract(notes, '$.dispatchCount') AS dispatch_count,
          generated_at AS computed_at,
          ROW_NUMBER() OVER (PARTITION BY provider, task_category ORDER BY generated_at DESC) AS rn
        FROM analytics_signals
        WHERE task_category IS NULL
      ) ranked
      WHERE rn <= ?
      ORDER BY provider, generated_at ASC
    `);

    // Insert new signal
    this._insertStmt = this.db.prepare(`
      INSERT INTO analytics_signals (
        provider,
        task_category,
        window_start,
        window_end,
        generated_at,
        success_rate,
        p50_latency_ms,
        p95_latency_ms,
        guardrail_violation_rate,
        routing_weight,
        weight_confidence,
        source,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Get the latest signal for a provider, with staleness flag.
   * Returns last-known-good even if stale (older than 48h).
   *
   * @param {string} provider - Provider name (claude, codex, gemini, ollama, etc.)
   * @param {string|null} [taskCategory] - Optional task category filter (null for global)
   * @returns {Object|null} Signal object with is_stale flag, or null if no signal exists
   */
  getLatestSignal(provider, taskCategory = null) {
    if (!provider) {
      throw new Error('provider is required');
    }

    try {
      const row = this._getLatestStmt.get(provider, taskCategory, taskCategory);
      if (!row) {
        return null;
      }

      const ageMs = row.age_seconds * 1000;
      const isStale = ageMs > this.stalenessThresholdMs;

      return {
        id: row.id,
        provider: row.provider,
        taskCategory: row.task_category,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        generatedAt: row.generated_at,
        successRate: row.success_rate,
        p50LatencyMs: row.p50_latency_ms,
        p95LatencyMs: row.p95_latency_ms,
        guardrailViolationRate: row.guardrail_violation_rate,
        routingWeight: row.routing_weight,
        weightConfidence: row.weight_confidence,
        source: row.source,
        notes: row.notes,
        ageMs,
        isStale,
      };
    } catch (err) {
      log.error('Failed to retrieve latest signal', { provider, taskCategory, error: err.message });
      return null;
    }
  }

  /**
   * Get latest signals for all providers (global task_category only).
   * Returns a map of provider -> signal, with staleness flags.
   *
   * @returns {Object<string, Object>} Map of provider name to signal object
   */
  getAllLatestSignals() {
    try {
      const rows = this._getAllLatestStmt.all();
      const signals = {};

      for (const row of rows) {
        const ageMs = row.age_seconds * 1000;
        const isStale = ageMs > this.stalenessThresholdMs;

        signals[row.provider] = {
          id: row.id,
          provider: row.provider,
          taskCategory: row.task_category,
          windowStart: row.window_start,
          windowEnd: row.window_end,
          generatedAt: row.generated_at,
          successRate: row.success_rate,
          p50LatencyMs: row.p50_latency_ms,
          p95LatencyMs: row.p95_latency_ms,
          guardrailViolationRate: row.guardrail_violation_rate,
          routingWeight: row.routing_weight,
          weightConfidence: row.weight_confidence,
          source: row.source,
          notes: row.notes,
          ageMs,
          isStale,
        };
      }

      return signals;
    } catch (err) {
      log.error('Failed to retrieve all latest signals', { error: err.message });
      return {};
    }
  }

  /**
   * Write a new analytics signal.
   *
   * @param {Object} signal - Signal data
   * @param {string} signal.provider - Provider name
   * @param {string|null} [signal.taskCategory] - Task category (null for global)
   * @param {string} signal.windowStart - ISO8601 UTC window start
   * @param {string} signal.windowEnd - ISO8601 UTC window end
   * @param {string} [signal.generatedAt] - ISO8601 UTC generation time (defaults to now)
   * @param {number} signal.successRate - 0..1 success ratio
   * @param {number} signal.p50LatencyMs - P50 latency in ms
   * @param {number} signal.p95LatencyMs - P95 latency in ms
   * @param {number} [signal.guardrailViolationRate] - 0..1 guardrail hit rate (default 0)
   * @param {number} [signal.routingWeight] - Multiplicative routing weight (default 1.0)
   * @param {number} [signal.weightConfidence] - 0..1 blend factor (default 1.0)
   * @param {string} [signal.source] - Pipeline name/version
   * @param {string} [signal.notes] - Optional notes
   * @returns {Object} The written signal with id
   */
  writeSignal(signal) {
    if (!signal.provider || !signal.windowStart || !signal.windowEnd) {
      throw new Error('provider, windowStart, and windowEnd are required');
    }

    if (typeof signal.successRate !== 'number' || typeof signal.p50LatencyMs !== 'number' || typeof signal.p95LatencyMs !== 'number') {
      throw new Error('successRate, p50LatencyMs, and p95LatencyMs must be numbers');
    }

    try {
      const generatedAt = signal.generatedAt || new Date().toISOString();

      const result = this._insertStmt.run(
        signal.provider,
        signal.taskCategory || null,
        signal.windowStart,
        signal.windowEnd,
        generatedAt,
        signal.successRate,
        signal.p50LatencyMs,
        signal.p95LatencyMs,
        signal.guardrailViolationRate ?? 0,
        signal.routingWeight ?? 1.0,
        signal.weightConfidence ?? 1.0,
        signal.source || null,
        signal.notes || null
      );

      log.info('Wrote analytics signal', {
        provider: signal.provider,
        taskCategory: signal.taskCategory,
        windowStart: signal.windowStart,
        windowEnd: signal.windowEnd,
        successRate: signal.successRate,
        routingWeight: signal.routingWeight,
        id: result.lastInsertRowid,
      });

      return {
        id: result.lastInsertRowid,
        ...signal,
        generatedAt,
      };
    } catch (err) {
      // Check for UNIQUE constraint violation (duplicate window)
      if (err.message.includes('UNIQUE constraint failed')) {
        log.warn('Duplicate signal window detected, skipping', {
          provider: signal.provider,
          taskCategory: signal.taskCategory,
          windowStart: signal.windowStart,
          windowEnd: signal.windowEnd,
        });
        throw new Error(`Duplicate signal: provider=${signal.provider}, window=${signal.windowStart} to ${signal.windowEnd}`);
      }

      log.error('Failed to write analytics signal', { signal, error: err.message });
      throw err;
    }
  }

  /**
   * Get recent signal snapshots for degradation detection.
   * Returns the most recent N snapshots per provider (global task_category only).
   *
   * @param {number} limit - Number of recent snapshots to retrieve per provider
   * @returns {Object[]} Array of signal snapshots
   */
  getRecentSnapshots(limit = 5) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error('limit must be a positive number');
    }

    try {
      const rows = this._getRecentSnapshotsStmt.all(limit);
      return rows.map(row => ({
        provider: row.provider,
        category: row.task_category,
        taskCategory: row.task_category, // Alias for degradation-detector compatibility
        success_rate: row.success_rate,
        successRate: row.success_rate, // Alias for degradation-detector compatibility
        dispatch_count: row.dispatch_count,
        window_start: row.window_start,
        windowStart: row.window_start,
        window_end: row.window_end,
        windowEnd: row.window_end,
        computed_at: row.computed_at,
        computedAt: row.computed_at,
        generatedAt: row.computed_at, // Alias for degradation-detector compatibility
        agentId: row.provider, // Alias for degradation-detector compatibility
      }));
    } catch (err) {
      log.error('Failed to retrieve recent snapshots', { limit, error: err.message });
      return [];
    }
  }

  /**
   * Get freshness status for all providers.
   * Returns a summary of which providers have stale or missing signals.
   *
   * @returns {Object} Freshness status summary
   */
  getFreshnessStatus() {
    try {
      const signals = this.getAllLatestSignals();
      const staleProviders = [];
      const freshProviders = [];

      for (const [provider, signal] of Object.entries(signals)) {
        if (signal.isStale) {
          staleProviders.push({
            provider,
            ageMs: signal.ageMs,
            generatedAt: signal.generatedAt,
          });
        } else {
          freshProviders.push({
            provider,
            ageMs: signal.ageMs,
            generatedAt: signal.generatedAt,
          });
        }
      }

      return {
        fresh: freshProviders,
        stale: staleProviders,
        hasStaleSignals: staleProviders.length > 0,
        stalenessThresholdMs: this.stalenessThresholdMs,
      };
    } catch (err) {
      log.error('Failed to get freshness status', { error: err.message });
      return {
        fresh: [],
        stale: [],
        hasStaleSignals: false,
        stalenessThresholdMs: this.stalenessThresholdMs,
        error: err.message,
      };
    }
  }

  /**
   * Subscribe to corruption detection events.
   * @param {string} event - Event name ('database:corruption-detected')
   * @param {Function} handler - Event handler
   */
  on(event, handler) {
    this._emitter.on(event, handler);
  }

  /**
   * Close the database connection.
   */
  close() {
    try {
      this.db.close();
      log.info('Analytics signals store closed', { dbPath: this.dbPath });
    } catch (err) {
      log.error('Failed to close analytics signals store', { error: err.message });
    }
  }
}

/**
 * Factory function for creating an AnalyticsSignalsStore.
 * @param {Object} options
 * @returns {AnalyticsSignalsStore}
 */
export function createAnalyticsSignalsStore(options = {}) {
  return new AnalyticsSignalsStore(options);
}

export default AnalyticsSignalsStore;
