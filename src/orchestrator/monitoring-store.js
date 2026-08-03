import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import Database from '../persistence/sqlite-provider.js';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { createDatabaseWithRecovery } from './db-recovery.js';

const log = createLogger('monitoring-store');

/**
 * MonitoringStore — SQLite persistence layer for system monitoring metrics.
 *
 * Schema: monitoring_metrics table
 * ──────────────────────────────────────────────────────────────────────
 *  Column              Type              Notes
 *  ──────────────────  ────────────────  ─────────────────────────────────────
 *  id                  TEXT              UUID primary key
 *  timestamp_ms        INTEGER NOT NULL  Unix timestamp in milliseconds
 *  iso_timestamp       TEXT NOT NULL     ISO-8601 timestamp string
 *  agent_id            TEXT NOT NULL     Agent identifier (always 'monitoring-agent')
 *  system_cpu_usage    REAL              CPU usage percentage (0-100)
 *  system_memory_used  REAL              Memory used in megabytes
 *  system_memory_total REAL              Total memory in megabytes
 *  system_memory_usage REAL              Memory usage percentage (0-100)
 *  system_heap_used    REAL              Heap memory used in megabytes
 *  system_heap_total   REAL              Total heap memory in megabytes
 *  system_heap_usage   REAL              Heap memory usage percentage (0-100)
 *  system_uptime       REAL              Process uptime in seconds
 *  task_queue_depth    INTEGER           Total number of queued tasks
 *  task_queue_queued   INTEGER           Number of queued tasks
 *  task_queue_planning INTEGER           Number of tasks in planning
 *  task_queue_executing INTEGER          Number of executing tasks
 *  task_queue_reviewing INTEGER          Number of tasks in review
 *  task_queue_done     INTEGER           Number of completed tasks
 *  task_queue_failed   INTEGER           Number of failed tasks
 *  task_queue_cancelled INTEGER          Number of cancelled tasks
 *  agents_total        INTEGER           Total number of agents
 *  agents_idle         INTEGER           Number of idle agents
 *  agents_thinking     INTEGER           Number of thinking agents
 *  agents_rate_limited INTEGER           Number of rate-limited agents
 *  agents_paused       INTEGER           Number of paused agents
 *  errors_count        INTEGER           Total error count in current window
 *  errors_rate_percent REAL              Error rate as percentage
 *  errors_window_sec   INTEGER           Time window for error rate calculation
 *  perf_event_loop_lag REAL              Event loop lag in milliseconds
 *  perf_active_handles INTEGER           Number of active handles
 *  perf_active_requests INTEGER          Number of active requests
 *  alerts_warnings     TEXT              JSON array of warning messages
 *  alerts_critical     TEXT              JSON array of critical alert messages
 *  metadata_hostname   TEXT              System hostname
 *  metadata_platform   TEXT              Node.js platform
 *  metadata_node_version TEXT            Node.js version
 *  metadata_pid        INTEGER           Process ID
 *  created_at          TEXT NOT NULL     ISO-8601 timestamp of metric insertion
 * ──────────────────────────────────────────────────────────────────────
 *
 * Schema: monitoring_metrics_rollups table
 * ──────────────────────────────────────────────────────────────────────
 *  Column                Type              Notes
 *  ────────────────────  ────────────────  ──────────────────────────────
 *  id                    TEXT              UUID primary key
 *  period                TEXT NOT NULL     Period type (hourly/daily)
 *  period_start          TEXT NOT NULL     Period start timestamp
 *  period_end            TEXT NOT NULL     Period end timestamp
 *  sample_count          INTEGER           Number of metrics in rollup
 *  avg_cpu_usage         REAL              Average CPU usage
 *  max_cpu_usage         REAL              Maximum CPU usage
 *  avg_memory_usage      REAL              Average memory usage
 *  max_memory_usage      REAL              Maximum memory usage
 *  avg_queue_depth       REAL              Average task queue depth
 *  max_queue_depth       INTEGER           Maximum task queue depth
 *  avg_error_rate        REAL              Average error rate
 *  max_error_rate        REAL              Maximum error rate
 *  avg_event_loop_lag    REAL              Average event loop lag
 *  max_event_loop_lag    REAL              Maximum event loop lag
 * ──────────────────────────────────────────────────────────────────────
 *
 * Crash recovery: WAL journal mode + FULL synchronous ensures committed
 * writes survive process crashes. Uncommitted transactions are rolled
 * back automatically by SQLite on next open.
 */
class MonitoringStore {
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
      CREATE TABLE IF NOT EXISTS monitoring_metrics (
        id TEXT PRIMARY KEY,
        timestamp_ms INTEGER NOT NULL,
        iso_timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        system_cpu_usage REAL,
        system_memory_used REAL,
        system_memory_total REAL,
        system_memory_usage REAL,
        system_heap_used REAL,
        system_heap_total REAL,
        system_heap_usage REAL,
        system_uptime REAL,
        task_queue_depth INTEGER,
        task_queue_queued INTEGER,
        task_queue_planning INTEGER,
        task_queue_executing INTEGER,
        task_queue_reviewing INTEGER,
        task_queue_done INTEGER,
        task_queue_failed INTEGER,
        task_queue_cancelled INTEGER,
        agents_total INTEGER,
        agents_idle INTEGER,
        agents_thinking INTEGER,
        agents_rate_limited INTEGER,
        agents_paused INTEGER,
        errors_count INTEGER,
        errors_rate_percent REAL,
        errors_window_sec INTEGER,
        perf_event_loop_lag REAL,
        perf_active_handles INTEGER,
        perf_active_requests INTEGER,
        alerts_warnings TEXT,
        alerts_critical TEXT,
        metadata_hostname TEXT,
        metadata_platform TEXT,
        metadata_node_version TEXT,
        metadata_pid INTEGER,
        created_at TEXT NOT NULL
      )
    `);

    // Create indexes for efficient time-based queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_metrics_timestamp_ms ON monitoring_metrics(timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_monitoring_metrics_agent_id ON monitoring_metrics(agent_id);
      CREATE INDEX IF NOT EXISTS idx_monitoring_metrics_created_at ON monitoring_metrics(created_at);
    `);

    // Create rollup table for aggregated metrics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitoring_metrics_rollups (
        id TEXT PRIMARY KEY,
        period TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        avg_cpu_usage REAL,
        max_cpu_usage REAL,
        avg_memory_usage REAL,
        max_memory_usage REAL,
        avg_queue_depth REAL,
        max_queue_depth INTEGER,
        avg_error_rate REAL,
        max_error_rate REAL,
        avg_event_loop_lag REAL,
        max_event_loop_lag REAL,
        UNIQUE(period, period_start)
      )
    `);

    // Create indexes for rollup queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_rollups_period ON monitoring_metrics_rollups(period);
      CREATE INDEX IF NOT EXISTS idx_monitoring_rollups_period_start ON monitoring_metrics_rollups(period_start);
    `);
  }

  _prepareStatements() {
    // Insert statement for raw metrics
    this._insertMetricStatement = this.db.prepare(`
      INSERT INTO monitoring_metrics (
        id, timestamp_ms, iso_timestamp, agent_id,
        system_cpu_usage, system_memory_used, system_memory_total, system_memory_usage,
        system_heap_used, system_heap_total, system_heap_usage, system_uptime,
        task_queue_depth, task_queue_queued, task_queue_planning, task_queue_executing,
        task_queue_reviewing, task_queue_done, task_queue_failed, task_queue_cancelled,
        agents_total, agents_idle, agents_thinking, agents_rate_limited, agents_paused,
        errors_count, errors_rate_percent, errors_window_sec,
        perf_event_loop_lag, perf_active_handles, perf_active_requests,
        alerts_warnings, alerts_critical,
        metadata_hostname, metadata_platform, metadata_node_version, metadata_pid,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Query statement for time range
    this._queryMetricsStatement = this.db.prepare(`
      SELECT * FROM monitoring_metrics
      WHERE timestamp_ms >= ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms ASC
    `);

    // Query for latest metrics
    this._queryLatestStatement = this.db.prepare(`
      SELECT * FROM monitoring_metrics
      ORDER BY timestamp_ms DESC
      LIMIT 1
    `);

    // Query for metrics by agent
    this._queryByAgentStatement = this.db.prepare(`
      SELECT * FROM monitoring_metrics
      WHERE agent_id = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
      ORDER BY timestamp_ms ASC
    `);

    // Delete old metrics for cleanup
    this._deleteOldMetricsStatement = this.db.prepare(`
      DELETE FROM monitoring_metrics
      WHERE timestamp_ms < ?
    `);

    // Insert or replace rollup
    this._insertRollupStatement = this.db.prepare(`
      INSERT OR REPLACE INTO monitoring_metrics_rollups (
        id, period, period_start, period_end, sample_count,
        avg_cpu_usage, max_cpu_usage,
        avg_memory_usage, max_memory_usage,
        avg_queue_depth, max_queue_depth,
        avg_error_rate, max_error_rate,
        avg_event_loop_lag, max_event_loop_lag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Query rollups by period
    this._queryRollupsStatement = this.db.prepare(`
      SELECT * FROM monitoring_metrics_rollups
      WHERE period = ?
      ORDER BY period_start DESC
    `);
  }

  /**
   * Record a monitoring metric entry.
   *
   * @param {Object} metrics - Metric entry matching MetricEntry schema
   * @param {number} metrics.timestamp - Unix timestamp in milliseconds
   * @param {string} metrics.isoTimestamp - ISO 8601 timestamp string
   * @param {string} metrics.agentId - Agent identifier
   * @param {Object} metrics.system - System metrics
   * @param {Object} metrics.taskQueue - Task queue metrics
   * @param {Object} metrics.agents - Agent status metrics
   * @param {Object} metrics.errors - Error metrics
   * @param {Object} metrics.performance - Performance metrics
   * @param {Object} metrics.alerts - Alerts
   * @param {Object} metrics.metadata - Metadata
   */
  recordMetric(metrics) {
    const metricId = randomUUID();
    const createdAt = this._now();

    this._insertMetricStatement.run(
      metricId,
      metrics.timestamp,
      metrics.isoTimestamp,
      metrics.agentId,
      metrics.system.cpuUsagePercent || null,
      metrics.system.memoryUsedMB || null,
      metrics.system.memoryTotalMB || null,
      metrics.system.memoryUsagePercent || null,
      metrics.system.heapUsedMB || null,
      metrics.system.heapTotalMB || null,
      metrics.system.heapUsagePercent || null,
      metrics.system.uptimeSeconds || null,
      metrics.taskQueue.depth || null,
      metrics.taskQueue.byStatus?.queued || null,
      metrics.taskQueue.byStatus?.planning || null,
      metrics.taskQueue.byStatus?.executing || null,
      metrics.taskQueue.byStatus?.reviewing || null,
      metrics.taskQueue.byStatus?.done || null,
      metrics.taskQueue.byStatus?.failed || null,
      metrics.taskQueue.byStatus?.cancelled || null,
      metrics.agents.total || null,
      metrics.agents.idle || null,
      metrics.agents.thinking || null,
      metrics.agents.rateLimited || null,
      metrics.agents.paused || null,
      metrics.errors.count || null,
      metrics.errors.ratePercent || null,
      metrics.errors.windowSeconds || null,
      metrics.performance.eventLoopLagMs || null,
      metrics.performance.activeHandles || null,
      metrics.performance.activeRequests || null,
      metrics.alerts?.warnings ? JSON.stringify(metrics.alerts.warnings) : null,
      metrics.alerts?.critical ? JSON.stringify(metrics.alerts.critical) : null,
      metrics.metadata.hostname || null,
      metrics.metadata.platform || null,
      metrics.metadata.nodeVersion || null,
      metrics.metadata.pid || null,
      createdAt
    );

    log.debug({
      metricId,
      timestamp: metrics.isoTimestamp,
      cpuUsage: metrics.system.cpuUsagePercent,
      memoryUsage: metrics.system.memoryUsagePercent,
      queueDepth: metrics.taskQueue.depth,
    }, 'monitoring metric recorded');

    return metricId;
  }

  /**
   * Query metrics by time range.
   *
   * @param {Object} options
   * @param {number} options.startTime - Start timestamp (Unix ms)
   * @param {number} options.endTime - End timestamp (Unix ms)
   * @param {string} [options.agentId] - Optional filter by agent ID
   * @returns {Array<Object>} Array of metric objects
   */
  queryMetrics({ startTime, endTime, agentId = null } = {}) {
    if (!startTime || !endTime) {
      throw new TypeError('startTime and endTime are required');
    }

    let rows;
    if (agentId) {
      rows = this._queryByAgentStatement.all(agentId, startTime, endTime);
    } else {
      rows = this._queryMetricsStatement.all(startTime, endTime);
    }

    return rows.map(row => this._mapRowToMetric(row));
  }

  /**
   * Get the latest metric entry.
   *
   * @returns {Object|null} Latest metric entry or null if no metrics exist
   */
  getLatestMetric() {
    const row = this._queryLatestStatement.get();
    return row ? this._mapRowToMetric(row) : null;
  }

  /**
   * Delete metrics older than the specified timestamp.
   *
   * @param {number} cutoffTimestampMs - Cutoff timestamp (Unix ms)
   * @returns {number} Number of deleted metrics
   */
  deleteOldMetrics(cutoffTimestampMs) {
    const result = this._deleteOldMetricsStatement.run(cutoffTimestampMs);
    log.info({
      deletedCount: result.changes,
      cutoff: new Date(cutoffTimestampMs).toISOString(),
    }, 'old monitoring metrics deleted');
    return result.changes;
  }

  /**
   * Create or update a rollup aggregation.
   *
   * @param {Object} rollup
   * @param {string} rollup.period - 'hourly' or 'daily'
   * @param {string} rollup.periodStart - ISO timestamp
   * @param {string} rollup.periodEnd - ISO timestamp
   * @param {number} rollup.sampleCount - Number of metrics in rollup
   * @param {number} rollup.avgCpuUsage - Average CPU usage
   * @param {number} rollup.maxCpuUsage - Maximum CPU usage
   * @param {number} rollup.avgMemoryUsage - Average memory usage
   * @param {number} rollup.maxMemoryUsage - Maximum memory usage
   * @param {number} rollup.avgQueueDepth - Average queue depth
   * @param {number} rollup.maxQueueDepth - Maximum queue depth
   * @param {number} rollup.avgErrorRate - Average error rate
   * @param {number} rollup.maxErrorRate - Maximum error rate
   * @param {number} rollup.avgEventLoopLag - Average event loop lag
   * @param {number} rollup.maxEventLoopLag - Maximum event loop lag
   */
  createRollup({
    period,
    periodStart,
    periodEnd,
    sampleCount,
    avgCpuUsage,
    maxCpuUsage,
    avgMemoryUsage,
    maxMemoryUsage,
    avgQueueDepth,
    maxQueueDepth,
    avgErrorRate,
    maxErrorRate,
    avgEventLoopLag,
    maxEventLoopLag,
  }) {
    const rollupId = randomUUID();

    this._insertRollupStatement.run(
      rollupId,
      period,
      periodStart,
      periodEnd,
      sampleCount,
      avgCpuUsage,
      maxCpuUsage,
      avgMemoryUsage,
      maxMemoryUsage,
      avgQueueDepth,
      maxQueueDepth,
      avgErrorRate,
      maxErrorRate,
      avgEventLoopLag,
      maxEventLoopLag
    );

    log.debug({
      rollupId,
      period,
      periodStart,
      sampleCount,
    }, 'monitoring rollup created');

    return rollupId;
  }

  /**
   * Query rollups by period type.
   *
   * @param {string} period - 'hourly' or 'daily'
   * @returns {Array<Object>} Array of rollup objects
   */
  queryRollups(period) {
    const rows = this._queryRollupsStatement.all(period);
    return rows.map(row => ({
      id: row.id,
      period: row.period,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      sampleCount: row.sample_count,
      avgCpuUsage: row.avg_cpu_usage,
      maxCpuUsage: row.max_cpu_usage,
      avgMemoryUsage: row.avg_memory_usage,
      maxMemoryUsage: row.max_memory_usage,
      avgQueueDepth: row.avg_queue_depth,
      maxQueueDepth: row.max_queue_depth,
      avgErrorRate: row.avg_error_rate,
      maxErrorRate: row.max_error_rate,
      avgEventLoopLag: row.avg_event_loop_lag,
      maxEventLoopLag: row.max_event_loop_lag,
    }));
  }

  /**
   * Rollup hourly metrics from raw monitoring_metrics into monitoring_metrics_rollups.
   *
   * Aggregates all raw metrics older than `olderThanHours` hours into hourly rollups,
   * then deletes the consumed raw rows. All operations run in a transaction for atomicity.
   *
   * @param {number} [olderThanHours=1] - Only rollup metrics older than this many hours
   * @returns {Object} Stats about the rollup operation
   */
  rollupHourly(olderThanHours = 1) {
    const cutoffTime = Date.now() - olderThanHours * 60 * 60 * 1000;

    const doRollup = this.db.transaction(() => {
      // 1. Aggregate raw metrics into hourly buckets
      const aggregateQuery = `
        SELECT
          datetime(timestamp_ms / 1000, 'unixepoch', 'start of hour') as hour_bucket,
          datetime(timestamp_ms / 1000, 'unixepoch', '+1 hour', 'start of hour') as hour_end,
          COUNT(*) as sample_count,
          AVG(system_cpu_usage) as avg_cpu_usage,
          MAX(system_cpu_usage) as max_cpu_usage,
          AVG(system_memory_usage) as avg_memory_usage,
          MAX(system_memory_usage) as max_memory_usage,
          AVG(task_queue_depth) as avg_queue_depth,
          MAX(task_queue_depth) as max_queue_depth,
          AVG(errors_rate_percent) as avg_error_rate,
          MAX(errors_rate_percent) as max_error_rate,
          AVG(perf_event_loop_lag) as avg_event_loop_lag,
          MAX(perf_event_loop_lag) as max_event_loop_lag
        FROM monitoring_metrics
        WHERE timestamp_ms < ?
        GROUP BY hour_bucket
      `;

      const aggregatedRows = this.db.prepare(aggregateQuery).all(cutoffTime);

      // 2. Insert or update rollup rows
      let rollupsCreated = 0;
      for (const row of aggregatedRows) {
        this._insertRollupStatement.run(
          randomUUID(),
          'hourly',
          row.hour_bucket + 'Z',
          row.hour_end + 'Z',
          row.sample_count,
          row.avg_cpu_usage,
          row.max_cpu_usage,
          row.avg_memory_usage,
          row.max_memory_usage,
          row.avg_queue_depth,
          row.max_queue_depth,
          row.avg_error_rate,
          row.max_error_rate,
          row.avg_event_loop_lag,
          row.max_event_loop_lag
        );
        rollupsCreated++;
      }

      // 3. Delete consumed raw metrics
      const deleteResult = this._deleteOldMetricsStatement.run(cutoffTime);

      return {
        rollupsCreated,
        rawMetricsDeleted: deleteResult.changes
      };
    });

    const result = doRollup();
    log.info({
      olderThanHours,
      cutoffTime: new Date(cutoffTime).toISOString(),
      rollupsCreated: result.rollupsCreated,
      rawMetricsDeleted: result.rawMetricsDeleted
    }, 'hourly monitoring rollup completed');

    return result;
  }

  /**
   * Rollup daily metrics from hourly rollups into daily rollups.
   *
   * Aggregates all hourly rollups older than `olderThanHours` hours into daily rollups,
   * then deletes the consumed hourly rows. All operations run in a transaction for atomicity.
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
          date(period_start) as day_bucket,
          date(period_start, '+1 day') as day_end,
          SUM(sample_count) as sample_count,
          AVG(avg_cpu_usage) as avg_cpu_usage,
          MAX(max_cpu_usage) as max_cpu_usage,
          AVG(avg_memory_usage) as avg_memory_usage,
          MAX(max_memory_usage) as max_memory_usage,
          AVG(avg_queue_depth) as avg_queue_depth,
          MAX(max_queue_depth) as max_queue_depth,
          AVG(avg_error_rate) as avg_error_rate,
          MAX(max_error_rate) as max_error_rate,
          AVG(avg_event_loop_lag) as avg_event_loop_lag,
          MAX(max_event_loop_lag) as max_event_loop_lag
        FROM monitoring_metrics_rollups
        WHERE period = 'hourly' AND period_start < ?
        GROUP BY day_bucket
      `;

      const aggregatedRows = this.db.prepare(aggregateQuery).all(cutoffTime);

      // 2. Insert or update daily rollup rows
      let rollupsCreated = 0;
      for (const row of aggregatedRows) {
        this._insertRollupStatement.run(
          randomUUID(),
          'daily',
          row.day_bucket + 'T00:00:00.000Z',
          row.day_end + 'T00:00:00.000Z',
          row.sample_count,
          row.avg_cpu_usage,
          row.max_cpu_usage,
          row.avg_memory_usage,
          row.max_memory_usage,
          row.avg_queue_depth,
          row.max_queue_depth,
          row.avg_error_rate,
          row.max_error_rate,
          row.avg_event_loop_lag,
          row.max_event_loop_lag
        );
        rollupsCreated++;
      }

      // 3. Delete consumed hourly rollups
      const deleteResult = this.db.prepare(`
        DELETE FROM monitoring_metrics_rollups
        WHERE period = 'hourly' AND period_start < ?
      `).run(cutoffTime);

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
    }, 'daily monitoring rollup completed');

    return result;
  }

  /**
   * Map database row to metric object format.
   *
   * @private
   * @param {Object} row - Database row
   * @returns {Object} Metric object
   */
  _mapRowToMetric(row) {
    const metric = {
      id: row.id,
      timestamp: row.timestamp_ms,
      isoTimestamp: row.iso_timestamp,
      agentId: row.agent_id,
      system: {
        cpuUsagePercent: row.system_cpu_usage,
        memoryUsedMB: row.system_memory_used,
        memoryTotalMB: row.system_memory_total,
        memoryUsagePercent: row.system_memory_usage,
        heapUsedMB: row.system_heap_used,
        heapTotalMB: row.system_heap_total,
        heapUsagePercent: row.system_heap_usage,
        uptimeSeconds: row.system_uptime,
      },
      taskQueue: {
        depth: row.task_queue_depth,
        byStatus: {
          queued: row.task_queue_queued,
          planning: row.task_queue_planning,
          executing: row.task_queue_executing,
          reviewing: row.task_queue_reviewing,
          done: row.task_queue_done,
          failed: row.task_queue_failed,
          cancelled: row.task_queue_cancelled,
        },
      },
      agents: {
        total: row.agents_total,
        idle: row.agents_idle,
        thinking: row.agents_thinking,
        rateLimited: row.agents_rate_limited,
        paused: row.agents_paused,
      },
      errors: {
        count: row.errors_count,
        ratePercent: row.errors_rate_percent,
        windowSeconds: row.errors_window_sec,
      },
      performance: {
        eventLoopLagMs: row.perf_event_loop_lag,
        activeHandles: row.perf_active_handles,
        activeRequests: row.perf_active_requests,
      },
      alerts: {},
      metadata: {
        hostname: row.metadata_hostname,
        platform: row.metadata_platform,
        nodeVersion: row.metadata_node_version,
        pid: row.metadata_pid,
      },
      createdAt: row.created_at,
    };

    // Parse JSON fields
    if (row.alerts_warnings) {
      try {
        metric.alerts.warnings = JSON.parse(row.alerts_warnings);
      } catch (e) {
        metric.alerts.warnings = [];
      }
    } else {
      metric.alerts.warnings = [];
    }

    if (row.alerts_critical) {
      try {
        metric.alerts.critical = JSON.parse(row.alerts_critical);
      } catch (e) {
        metric.alerts.critical = [];
      }
    } else {
      metric.alerts.critical = [];
    }

    return metric;
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

export { MonitoringStore };
