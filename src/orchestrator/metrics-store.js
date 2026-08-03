import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import Database from '../persistence/sqlite-provider.js';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { createDatabaseWithRecovery } from './db-recovery.js';

const log = createLogger('metrics-store');

/**
 * MetricsStore — SQLite persistence layer for dispatch metrics collection.
 *
 * Schema: dispatch_metrics table
 * ──────────────────────────────────────────────────────────────────────
 *  Column          Type              Notes
 *  ──────────────  ────────────────  ─────────────────────────────────────
 *  id              TEXT              UUID primary key
 *  dispatch_id     TEXT NOT NULL     Unique dispatch identifier
 *  agent_id        TEXT NOT NULL     Agent that handled the dispatch
 *  campaign_id     TEXT              Campaign context (nullable)
 *  model           TEXT NOT NULL     LLM model used (e.g. claude-opus-4-6)
 *  input_tokens    INTEGER           Input token count
 *  output_tokens   INTEGER           Output token count
 *  latency_ms      REAL NOT NULL     Latency in milliseconds
 *  timestamp       TEXT NOT NULL     ISO-8601 timestamp of the dispatch
 *  created_at      TEXT NOT NULL     ISO-8601 timestamp of metric insertion
 *  cost            REAL              Computed cost in USD (nullable; null if pricing unknown)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Schema: metrics_rollups table
 * ──────────────────────────────────────────────────────────────────────
 *  Column                Type              Notes
 *  ────────────────────  ────────────────  ──────────────────────────────
 *  id                    TEXT              UUID primary key
 *  agent_id              TEXT NOT NULL     Agent identifier
 *  campaign_id           TEXT              Campaign identifier (nullable)
 *  model                 TEXT NOT NULL     Model identifier
 *  period                TEXT NOT NULL     Period type (hourly/daily)
 *  period_start          TEXT NOT NULL     Period start timestamp
 *  dispatch_count        INTEGER           Number of dispatches
 *  total_input_tokens    INTEGER           Sum of input tokens
 *  total_output_tokens   INTEGER           Sum of output tokens
 *  total_latency_ms      REAL              Sum of latency
 *  min_latency_ms        REAL              Minimum latency
 *  max_latency_ms        REAL              Maximum latency
 *  total_cost            REAL              Sum of dispatch costs in USD (nullable)
 * ──────────────────────────────────────────────────────────────────────
 *
 * Crash recovery: WAL journal mode + FULL synchronous ensures committed
 * writes survive process crashes. Uncommitted transactions are rolled
 * back automatically by SQLite on next open.
 */
class MetricsStore {
  /**
   * @param {Object} options
   * @param {string} options.dbPath - Path to SQLite database file
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this._emitter = new EventEmitter();

    this._ensureParentDir();

    // Use recovery-aware database creation
    this.db = createDatabaseWithRecovery(this.dbPath, {
      emitter: this._emitter,
      enableRecovery: true,
    });

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');

    this._initializeSchema();
    this._prepareStatements();
  }

  _ensureParentDir() {
    if (this.dbPath === ':memory:') return;

    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _now() {
    return new Date().toISOString();
  }

  _initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_metrics (
        id TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        campaign_id TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Migration: add created_at column to existing tables
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(dispatch_metrics)").all();
      const hasCreatedAt = tableInfo.some(col => col.name === 'created_at');
      if (!hasCreatedAt) {
        this.db.exec(`ALTER TABLE dispatch_metrics ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`);
        log.info('Added created_at column to existing dispatch_metrics table');
      }
      const hasCost = tableInfo.some(col => col.name === 'cost');
      if (!hasCost) {
        this.db.exec(`ALTER TABLE dispatch_metrics ADD COLUMN cost REAL`);
        log.info('Added cost column to existing dispatch_metrics table');
      }
    } catch (err) {
      // Ignore errors if table doesn't exist yet
      if (!err.message.includes('no such table')) {
        log.warn({ err }, 'Error during schema migration');
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_dispatch_metrics_agent_id ON dispatch_metrics(agent_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_metrics_campaign_id ON dispatch_metrics(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_dispatch_metrics_timestamp ON dispatch_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_dispatch_metrics_agent_campaign ON dispatch_metrics(agent_id, campaign_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_rollups (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        campaign_id TEXT,
        model TEXT NOT NULL,
        period TEXT NOT NULL,
        period_start TEXT NOT NULL,
        dispatch_count INTEGER,
        total_input_tokens INTEGER,
        total_output_tokens INTEGER,
        total_latency_ms REAL,
        min_latency_ms REAL,
        max_latency_ms REAL,
        total_cost REAL,
        UNIQUE(agent_id, campaign_id, model, period, period_start)
      )
    `);

    // Migration: add total_cost column to existing metrics_rollups tables
    try {
      const rollupInfo = this.db.prepare("PRAGMA table_info(metrics_rollups)").all();
      const hasTotalCost = rollupInfo.some(col => col.name === 'total_cost');
      if (!hasTotalCost) {
        this.db.exec(`ALTER TABLE metrics_rollups ADD COLUMN total_cost REAL`);
        log.info('Added total_cost column to existing metrics_rollups table');
      }
    } catch (err) {
      if (!err.message.includes('no such table')) {
        log.warn({ err }, 'Error during metrics_rollups schema migration');
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rollups_agent_id ON metrics_rollups(agent_id);
      CREATE INDEX IF NOT EXISTS idx_rollups_campaign_id ON metrics_rollups(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_rollups_period_start ON metrics_rollups(period_start);
      CREATE INDEX IF NOT EXISTS idx_rollups_agent_campaign_model ON metrics_rollups(agent_id, campaign_id, model);
    `);
  }

  _prepareStatements() {
    this._insertMetricStatement = this.db.prepare(`
      INSERT INTO dispatch_metrics (id, dispatch_id, agent_id, campaign_id, model, input_tokens, output_tokens, latency_ms, timestamp, created_at, cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._queryMetricsStatement = this.db.prepare(`
      SELECT id, dispatch_id, agent_id, campaign_id, model, input_tokens, output_tokens, latency_ms, timestamp, created_at, cost
      FROM dispatch_metrics
      WHERE 1=1
      ORDER BY timestamp ASC
    `);

    this._insertRollupStatement = this.db.prepare(`
      INSERT INTO metrics_rollups (id, agent_id, campaign_id, model, period, period_start, dispatch_count, total_input_tokens, total_output_tokens, total_latency_ms, min_latency_ms, max_latency_ms, total_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, campaign_id, model, period, period_start)
      DO UPDATE SET
        dispatch_count = excluded.dispatch_count,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_latency_ms = excluded.total_latency_ms,
        min_latency_ms = excluded.min_latency_ms,
        max_latency_ms = excluded.max_latency_ms,
        total_cost = excluded.total_cost
    `);

    this._queryRollupsStatement = this.db.prepare(`
      SELECT id, agent_id, campaign_id, model, period, period_start, dispatch_count, total_input_tokens, total_output_tokens, total_latency_ms, min_latency_ms, max_latency_ms, total_cost
      FROM metrics_rollups
      WHERE 1=1
      ORDER BY period_start DESC
    `);
  }

  /**
   * Record a dispatch metric entry.
   *
   * @param {Object} metric
   * @param {string} metric.dispatchId - Unique dispatch identifier
   * @param {string} metric.agentId - Agent that handled the dispatch
   * @param {string} [metric.campaignId] - Campaign context (optional)
   * @param {string} metric.model - LLM model used
   * @param {number} [metric.inputTokens] - Input token count (defaults to 0)
   * @param {number} [metric.outputTokens] - Output token count (defaults to 0)
   * @param {number} metric.latencyMs - Latency in milliseconds
   * @param {string} [metric.timestamp] - ISO timestamp (defaults to now)
   * @param {number|null} [metric.cost] - Computed cost in USD (null if pricing unknown)
   */
  recordMetric({ dispatchId, agentId, campaignId, model, inputTokens, outputTokens, latencyMs, timestamp: customTimestamp, cost }) {
    // Validate required fields
    if (!dispatchId) {
      throw new TypeError('dispatchId is required');
    }
    if (!agentId) {
      throw new TypeError('agentId is required');
    }
    if (!model) {
      throw new TypeError('model is required');
    }
    if (latencyMs === undefined || latencyMs === null) {
      throw new TypeError('latencyMs is required');
    }

    const metricId = randomUUID();
    const timestamp = customTimestamp || this._now();
    const createdAt = this._now();

    this._insertMetricStatement.run(
      metricId,
      dispatchId,
      agentId,
      campaignId || null,
      model,
      inputTokens || 0,
      outputTokens || 0,
      latencyMs,
      timestamp,
      createdAt,
      cost !== undefined ? cost : null
    );

    log.info({
      dispatchId,
      agentId,
      campaignId,
      model,
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      latencyMs,
      cost: cost !== undefined ? cost : null
    }, 'dispatch metric recorded');
  }

  /**
   * Query metrics with optional filters.
   *
   * @param {Object} [filters={}]
   * @param {string} [filters.agentId] - Filter by agent ID
   * @param {string} [filters.campaignId] - Filter by campaign ID
   * @param {string} [filters.startTime] - Filter by start time (ISO string)
   * @param {string} [filters.endTime] - Filter by end time (ISO string)
   * @returns {Array<Object>} Array of metric objects
   */
  queryMetrics({ agentId = null, campaignId = null, startTime = null, endTime = null } = {}) {
    const conditions = [];
    const params = [];

    if (agentId) {
      conditions.push('agent_id = ?');
      params.push(agentId);
    }

    if (campaignId) {
      conditions.push('campaign_id = ?');
      params.push(campaignId);
    }

    if (startTime) {
      conditions.push('timestamp >= ?');
      params.push(startTime);
    }

    if (endTime) {
      conditions.push('timestamp <= ?');
      params.push(endTime);
    }

    let sql = `
      SELECT id, dispatch_id, agent_id, campaign_id, model, input_tokens, output_tokens, latency_ms, timestamp, created_at, cost
      FROM dispatch_metrics
      WHERE 1=1
    `;

    if (conditions.length > 0) {
      sql += ' AND ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY timestamp ASC';

    const statement = this.db.prepare(sql);
    const rows = statement.all(...params);

    return rows.map(row => ({
      id: row.id,
      dispatchId: row.dispatch_id,
      agentId: row.agent_id,
      campaignId: row.campaign_id,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      timestamp: row.timestamp,
      createdAt: row.created_at,
      cost: row.cost
    }));
  }

  /**
   * Query rollup metrics with optional filters.
   *
   * @param {Object} [filters={}]
   * @param {string} [filters.agentId] - Filter by agent ID
   * @param {string} [filters.campaignId] - Filter by campaign ID
   * @param {string} [filters.model] - Filter by model
   * @param {string} [filters.period] - Filter by period (hourly/daily)
   * @returns {Array<Object>} Array of rollup objects
   */
  queryRollups({ agentId = null, campaignId = null, model = null, period = null } = {}) {
    const conditions = [];
    const params = [];

    if (agentId) {
      conditions.push('agent_id = ?');
      params.push(agentId);
    }

    if (campaignId) {
      conditions.push('campaign_id = ?');
      params.push(campaignId);
    }

    if (model) {
      conditions.push('model = ?');
      params.push(model);
    }

    if (period) {
      conditions.push('period = ?');
      params.push(period);
    }

    let sql = `
      SELECT id, agent_id, campaign_id, model, period, period_start, dispatch_count, total_input_tokens, total_output_tokens, total_latency_ms, min_latency_ms, max_latency_ms, total_cost
      FROM metrics_rollups
      WHERE 1=1
    `;

    if (conditions.length > 0) {
      sql += ' AND ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY period_start DESC';

    const statement = this.db.prepare(sql);
    const rows = statement.all(...params);

    return rows.map(row => ({
      id: row.id,
      agentId: row.agent_id,
      campaignId: row.campaign_id,
      model: row.model,
      period: row.period,
      periodStart: row.period_start,
      dispatchCount: row.dispatch_count,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalLatencyMs: row.total_latency_ms,
      minLatencyMs: row.min_latency_ms,
      maxLatencyMs: row.max_latency_ms,
      totalCost: row.total_cost
    }));
  }

  /**
   * Create a rollup aggregation.
   *
   * @param {Object} rollup
   * @param {string} rollup.agentId
   * @param {string} [rollup.campaignId]
   * @param {string} rollup.model
   * @param {string} rollup.period - 'hourly' or 'daily'
   * @param {string} rollup.periodStart - ISO timestamp
   * @param {number} rollup.dispatchCount
   * @param {number} rollup.totalInputTokens
   * @param {number} rollup.totalOutputTokens
   * @param {number} rollup.totalLatencyMs
   * @param {number} rollup.minLatencyMs
   * @param {number} rollup.maxLatencyMs
   * @param {number|null} [rollup.totalCost] - Sum of dispatch costs in USD (null if pricing unknown)
   */
  createRollup({ agentId, campaignId, model, period, periodStart, dispatchCount, totalInputTokens, totalOutputTokens, totalLatencyMs, minLatencyMs, maxLatencyMs, totalCost }) {
    const rollupId = randomUUID();

    this._insertRollupStatement.run(
      rollupId,
      agentId,
      campaignId || null,
      model,
      period,
      periodStart,
      dispatchCount,
      totalInputTokens,
      totalOutputTokens,
      totalLatencyMs,
      minLatencyMs,
      maxLatencyMs,
      totalCost !== undefined ? totalCost : null
    );
  }

  /**
   * Rollup hourly metrics from raw dispatch_metrics into metrics_rollups.
   *
   * Aggregates all raw metrics older than `olderThanHours` hours into hourly rollups,
   * then deletes the consumed raw rows. Uses INSERT OR REPLACE for idempotency.
   * All operations run in a transaction for atomicity.
   *
   * @param {number} [olderThanHours=1] - Only rollup metrics older than this many hours
   * @returns {Object} Stats about the rollup operation
   */
  rollupHourly(olderThanHours = 1) {
    const cutoffTime = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();

    const doRollup = this.db.transaction(() => {
      // 1. Aggregate raw metrics into hourly buckets
      const aggregateQuery = `
        SELECT
          agent_id,
          campaign_id,
          model,
          strftime('%Y-%m-%d %H:00:00', timestamp) as hour_bucket,
          COUNT(*) as dispatch_count,
          SUM(input_tokens) as total_input_tokens,
          SUM(output_tokens) as total_output_tokens,
          SUM(latency_ms) as total_latency_ms,
          MIN(latency_ms) as min_latency_ms,
          MAX(latency_ms) as max_latency_ms,
          SUM(cost) as total_cost
        FROM dispatch_metrics
        WHERE timestamp < ?
        GROUP BY agent_id, campaign_id, model, hour_bucket
      `;

      const aggregatedRows = this.db.prepare(aggregateQuery).all(cutoffTime);

      // 2. Insert or update rollup rows
      let rollupsCreated = 0;
      for (const row of aggregatedRows) {
        this._insertRollupStatement.run(
          randomUUID(),
          row.agent_id,
          row.campaign_id,
          row.model,
          'hourly',
          row.hour_bucket,
          row.dispatch_count,
          row.total_input_tokens,
          row.total_output_tokens,
          row.total_latency_ms,
          row.min_latency_ms,
          row.max_latency_ms,
          row.total_cost
        );
        rollupsCreated++;
      }

      // 3. Delete consumed raw metrics
      const deleteQuery = `DELETE FROM dispatch_metrics WHERE timestamp < ?`;
      const deleteResult = this.db.prepare(deleteQuery).run(cutoffTime);

      return {
        rollupsCreated,
        rawMetricsDeleted: deleteResult.changes
      };
    });

    const result = doRollup();
    log.info({
      olderThanHours,
      cutoffTime,
      rollupsCreated: result.rollupsCreated,
      rawMetricsDeleted: result.rawMetricsDeleted
    }, 'hourly rollup completed');

    return result;
  }

  /**
   * Rollup daily metrics from hourly rollups into daily rollups.
   *
   * Aggregates all hourly rollups older than `olderThanHours` hours into daily rollups,
   * then deletes the consumed hourly rows. Uses INSERT OR REPLACE for idempotency.
   * All operations run in a transaction for atomicity.
   *
   * @param {number} [olderThanHours=25] - Only rollup hourly metrics older than this many hours
   * @returns {Object} Stats about the rollup operation
   */
  rollupDaily(olderThanHours = 25) {
    const cutoffTime = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();

    const doRollup = this.db.transaction(() => {
      // 1. Aggregate hourly rollups into daily buckets
      const aggregateQuery = `
        SELECT
          agent_id,
          campaign_id,
          model,
          strftime('%Y-%m-%d', period_start) as day_bucket,
          SUM(dispatch_count) as dispatch_count,
          SUM(total_input_tokens) as total_input_tokens,
          SUM(total_output_tokens) as total_output_tokens,
          SUM(total_latency_ms) as total_latency_ms,
          MIN(min_latency_ms) as min_latency_ms,
          MAX(max_latency_ms) as max_latency_ms,
          SUM(total_cost) as total_cost
        FROM metrics_rollups
        WHERE period = 'hourly' AND period_start < ?
        GROUP BY agent_id, campaign_id, model, day_bucket
      `;

      const aggregatedRows = this.db.prepare(aggregateQuery).all(cutoffTime);

      // 2. Insert or update daily rollup rows
      let rollupsCreated = 0;
      for (const row of aggregatedRows) {
        this._insertRollupStatement.run(
          randomUUID(),
          row.agent_id,
          row.campaign_id,
          row.model,
          'daily',
          row.day_bucket,
          row.dispatch_count,
          row.total_input_tokens,
          row.total_output_tokens,
          row.total_latency_ms,
          row.min_latency_ms,
          row.max_latency_ms,
          row.total_cost
        );
        rollupsCreated++;
      }

      // 3. Delete consumed hourly rollups
      const deleteQuery = `DELETE FROM metrics_rollups WHERE period = 'hourly' AND period_start < ?`;
      const deleteResult = this.db.prepare(deleteQuery).run(cutoffTime);

      return {
        rollupsCreated,
        hourlyRollupsDeleted: deleteResult.changes
      };
    });

    const result = doRollup();
    log.info({
      olderThanHours,
      cutoffTime,
      rollupsCreated: result.rollupsCreated,
      hourlyRollupsDeleted: result.hourlyRollupsDeleted
    }, 'daily rollup completed');

    return result;
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
    this.db.close();
  }
}

export { MetricsStore };
