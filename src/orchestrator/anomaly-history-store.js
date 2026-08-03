/**
 * Anomaly History Store — SQLite persistence for anomaly detector alert history.
 * Used by AnomalyDetector to persist and query alert events (fired/resolved).
 *
 * Migrates from legacy JSONL format on first open.
 *
 * Usage:
 *   const store = new AnomalyHistoryStore({ dbPath: './data/anomaly-history.db' });
 *   await store.append({ type: 'fired', agentId: 'foo', ... });
 *   const results = store.query({ agentId: 'foo', since: '2026-01-01T00:00:00Z' });
 *   store.close();
 */

import { createLogger } from '../logger.js';
import { randomUUID } from 'crypto';
import Database from '../persistence/sqlite-provider.js';
import { mkdirSync, existsSync, readFileSync, renameSync } from 'fs';
import { dirname } from 'path';

const log = createLogger('anomaly-history-store');

export class AnomalyHistoryStore {
  /**
   * @param {Object} options - Configuration
   * @param {string} options.dbPath - Path to SQLite database file (required)
   * @param {string} [options.legacyJsonlPath] - Path to legacy JSONL file for migration (optional)
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this.legacyJsonlPath = options.legacyJsonlPath || null;

    // Ensure parent directory exists
    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }

    // Open/create SQLite database
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    this._initTable();

    // Prepare statements for reuse
    this._insertStmt = this.db.prepare(`
      INSERT INTO anomaly_history (id, timestamp, type, agentId, taskCategory, severity, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this._countStmt = this.db.prepare('SELECT COUNT(*) as count FROM anomaly_history');

    // Migrate from legacy JSONL file if provided
    if (this.legacyJsonlPath) {
      this._migrateFromJsonl(this.legacyJsonlPath);
    }
  }

  _initTable() {
    // Create table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS anomaly_history (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        agentId TEXT,
        taskCategory TEXT,
        severity TEXT,
        data TEXT NOT NULL
      )
    `);

    // Create indexes for efficient queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_anomaly_timestamp_desc
      ON anomaly_history(timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_anomaly_agent_timestamp
      ON anomaly_history(agentId, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_anomaly_type_timestamp
      ON anomaly_history(type, timestamp DESC);
    `);
  }

  /**
   * Migrate records from legacy JSONL file to SQLite database.
   * Runs only if the legacy file exists and the SQLite table is empty.
   * Malformed lines are skipped with warnings (not exceptions).
   * After successful migration, the JSONL file is renamed to .jsonl.migrated.
   * @private
   * @param {string} legacyJsonlPath - Path to the legacy JSONL file
   */
  _migrateFromJsonl(legacyJsonlPath) {
    // 1. Check if legacy file exists
    if (!existsSync(legacyJsonlPath)) {
      return; // No migration needed
    }

    // 2. Check if SQLite table is empty
    const currentCount = this._countStmt.get().count;
    if (currentCount > 0) {
      log.info(`Skipping migration: SQLite database already contains ${currentCount} records`);
      return; // Skip migration if table has data
    }

    log.info(`Starting migration from legacy JSONL file: ${legacyJsonlPath}`);

    let recordsImported = 0;
    let linesSkipped = 0;

    try {
      // 3. Read JSONL file
      const content = readFileSync(legacyJsonlPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      // 4. Parse and insert records in a transaction
      const insertMany = this.db.transaction((records) => {
        for (const line of records) {
          try {
            const record = JSON.parse(line);

            // Extract indexed fields
            const type = record.type || 'legacy';
            const agentId = record.agentId || null;
            const taskCategory = record.taskCategory || null;
            const severity = record.severity || null;

            // Determine timestamp from record
            const timestamp = record.firedAt || record.resolvedAt || record.timestamp || new Date().toISOString();

            // Store remaining fields as JSON data blob
            const dataBlob = JSON.stringify({
              projectId: record.projectId,
              condition: record.condition,
              rollingSuccessRate: record.rollingSuccessRate,
              rollingRate: record.rollingRate,
              windowSize: record.windowSize,
              dispatchCount: record.dispatchCount,
              threshold: record.threshold,
              detail: record.detail,
              firedAt: record.firedAt,
              resolvedAt: record.resolvedAt,
              // Preserve any extra fields
              ...Object.fromEntries(
                Object.entries(record).filter(([key]) =>
                  !['type', 'agentId', 'taskCategory', 'severity', 'firedAt', 'resolvedAt', 'timestamp'].includes(key)
                )
              )
            });

            // Insert into SQLite
            this._insertStmt.run(
              randomUUID(),
              timestamp,
              type,
              agentId,
              taskCategory,
              severity,
              dataBlob
            );

            recordsImported++;
          } catch (err) {
            // Skip malformed lines with warning
            log.warn('Skipping malformed JSONL line', { line: line.substring(0, 100), error: err.message });
            linesSkipped++;
          }
        }
      });

      // Execute transaction
      insertMany(lines);

      // 5. Rename legacy file to .migrated
      const migratedPath = `${legacyJsonlPath}.migrated`;
      renameSync(legacyJsonlPath, migratedPath);

      // 6. Log migration summary
      log.info(`Migration complete: ${recordsImported} records imported, ${linesSkipped} lines skipped`);
      log.info(`Legacy file renamed to: ${migratedPath}`);
    } catch (err) {
      log.error(`Migration failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Append an alert entry to the history.
   * @param {Object} entry - Alert entry
   * @param {string} entry.type - Entry type ('fired' or 'resolved')
   * @param {string} entry.agentId - Agent identifier
   * @param {string} entry.taskCategory - Task category
   * @param {string} [entry.severity] - Alert severity (e.g., 'critical', 'warning')
   * @param {string} [entry.firedAt] - ISO timestamp when alert fired
   * @param {string} [entry.resolvedAt] - ISO timestamp when alert resolved
   * @param {Object} [entry.*] - Additional fields stored in data blob
   * @returns {Object} The persisted entry with generated id
   */
  append(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('entry must be an object');
    }

    // Extract indexed fields
    const type = entry.type || 'unknown';
    const agentId = entry.agentId || null;
    const taskCategory = entry.taskCategory || null;
    const severity = entry.severity || null;

    // Determine timestamp: prefer explicit timestamp, then firedAt/resolvedAt based on type
    let timestamp;
    if (entry.timestamp) {
      timestamp = entry.timestamp;
    } else if (type === 'resolved' && entry.resolvedAt) {
      timestamp = entry.resolvedAt;
    } else if (entry.firedAt) {
      timestamp = entry.firedAt;
    } else {
      timestamp = new Date().toISOString();
    }

    // Store remaining fields as JSON data blob
    const dataBlob = JSON.stringify({
      projectId: entry.projectId,
      condition: entry.condition,
      rollingSuccessRate: entry.rollingSuccessRate,
      rollingRate: entry.rollingRate,
      windowSize: entry.windowSize,
      dispatchCount: entry.dispatchCount,
      threshold: entry.threshold,
      detail: entry.detail,
      firedAt: entry.firedAt,
      resolvedAt: entry.resolvedAt,
      // Preserve any extra fields
      ...Object.fromEntries(
        Object.entries(entry).filter(([key]) =>
          !['type', 'agentId', 'taskCategory', 'severity', 'timestamp', 'firedAt', 'resolvedAt'].includes(key)
        )
      )
    });

    const id = randomUUID();

    try {
      this._insertStmt.run(id, timestamp, type, agentId, taskCategory, severity, dataBlob);
    } catch (err) {
      log.error(`Failed to insert anomaly history entry: ${err.message}`);
      throw err;
    }

    // Return the persisted entry
    return {
      id,
      timestamp,
      type,
      agentId,
      taskCategory,
      severity,
      ...entry
    };
  }

  /**
   * Query alert history with optional filtering.
   * @param {Object} [filters] - Query filters
   * @param {string} [filters.agentId] - Filter by agent ID
   * @param {string} [filters.type] - Filter by type ('fired', 'resolved', 'legacy')
   * @param {string} [filters.taskCategory] - Filter by task category (alias for 'category')
   * @param {string} [filters.category] - Filter by task category
   * @param {string} [filters.dispatchId] - Filter by dispatchId stored in data blob
   * @param {string} [filters.since] - Filter entries after this ISO timestamp (inclusive)
   * @param {number} [filters.limit=100] - Max rows to return (capped at 500)
   * @param {number} [filters.offset=0] - Pagination offset
   * @returns {{ entries: Object[], total: number }} Query results with pagination metadata
   */
  query(filters = {}) {
    const whereClauses = [];
    const params = [];

    // Build WHERE clause
    if (filters.agentId) {
      whereClauses.push('agentId = ?');
      params.push(filters.agentId);
    }

    if (filters.type) {
      whereClauses.push('type = ?');
      params.push(filters.type);
    }

    // Support both 'category' and 'taskCategory' for flexibility
    const category = filters.category || filters.taskCategory;
    if (category) {
      whereClauses.push('taskCategory = ?');
      params.push(category);
    }

    if (filters.since) {
      whereClauses.push('timestamp >= ?');
      params.push(filters.since);
    }

    const whereClause = whereClauses.length > 0
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';

    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);
    const dispatchIdFilter = filters.dispatchId || null;

    const baseQuery = `
      SELECT id, timestamp, type, agentId, taskCategory, severity, data
      FROM anomaly_history
      ${whereClause}
      ORDER BY timestamp DESC
    `;

    const rows = dispatchIdFilter
      ? this.db.prepare(baseQuery).all(...params)
      : this.db.prepare(`${baseQuery}\nLIMIT ? OFFSET ?`).all(...params, limit, offset);

    // Reconstruct full records from columns + JSON data blob
    const entries = rows.map(row => {
      let data = {};
      try {
        data = JSON.parse(row.data);
      } catch (err) {
        log.warn(`Failed to parse data blob for anomaly history entry ${row.id}: ${err.message}`);
      }

      return {
        id: row.id,
        timestamp: row.timestamp,
        type: row.type,
        agentId: row.agentId,
        taskCategory: row.taskCategory,
        severity: row.severity,
        ...data
      };
    }).filter((entry) => {
      if (!dispatchIdFilter) return true;
      return entry.dispatchId === dispatchIdFilter;
    });

    if (!dispatchIdFilter) {
      const countQuery = `SELECT COUNT(*) as count FROM anomaly_history ${whereClause}`;
      const total = this.db.prepare(countQuery).get(...params).count;
      return { entries, total };
    }

    const paginatedEntries = entries.slice(offset, offset + limit);
    return { entries: paginatedEntries, total: entries.length };
  }

  /**
   * Query anomaly entries normalized for timeline rendering.
   * @param {Object} [filters] - Query filters
   * @param {string} [filters.agentId] - Filter by agent ID
   * @param {string} [filters.type] - Filter by type ('fired', 'resolved', 'legacy')
   * @param {string} [filters.category] - Filter by task category
   * @param {string} [filters.taskCategory] - Filter by task category
   * @param {string} [filters.dispatchId] - Filter by dispatchId from data blob
   * @param {string} [filters.since] - Inclusive lower-bound timestamp
   * @param {number} [filters.limit=100] - Max rows to return (capped at 500)
   * @param {number} [filters.offset=0] - Pagination offset
   * @returns {{ events: Object[], total: number }}
   */
  queryForTimeline(filters = {}) {
    const { entries, total } = this.query(filters);
    const events = entries.map((entry) => {
      const severity = entry.severity || 'info';
      const category = entry.taskCategory || 'unknown';
      const agentId = entry.agentId || 'unknown';
      return {
        id: `anomaly-alert-${entry.id}`,
        type: 'anomaly_alert',
        timestamp: entry.timestamp,
        summary: `Anomaly alert: ${agentId} (${category}) - ${severity}`,
        correlationKeys: {
          campaignId: entry.campaignId || null,
          taskId: entry.taskId || null,
          dispatchId: entry.dispatchId || null,
          traceId: entry.traceId || null,
          agentId: entry.agentId || null,
          provider: entry.provider || null,
        },
        data: {
          ...entry,
        },
      };
    });
    return { events, total };
  }

  /**
   * Get the current number of entries.
   * @returns {number}
   */
  getSize() {
    return this._countStmt.get().count;
  }

  /**
   * Close the database connection.
   * Call this when shutting down to ensure clean closure.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export default AnomalyHistoryStore;
