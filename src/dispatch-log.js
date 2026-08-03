// dispatch-log.js — Dispatch decision audit trail with SQLite persistence:
// Captures routing decisions with candidate list, applied constraints,
// computed weights, and selected agent. All records retained (no eviction).
//
// Usage:
//   const dispatchLog = new DispatchLog({ dbPath: '/tmp/dispatch.db' });
//   dispatchLog.append({ id, timestamp, taskCategory, candidates, constraintsApplied, weights, roll, selectedAgent, selectionReason });
//   const records = dispatchLog.query();
//   const filtered = dispatchLog.query({ taskCategory: 'implementation' });

import { createLogger } from './logger.js';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import Database from './persistence/sqlite-provider.js';
import { mkdirSync, existsSync, readFileSync, renameSync } from 'fs';
import { dirname } from 'path';
import { createDatabaseWithRecovery } from './orchestrator/db-recovery.js';

const log = createLogger('dispatch-log');
const CB_TRANSITIONS_TABLE = 'cb_transitions';
const CB_TRANSITIONS_COLUMNS = [
  'timestamp',
  'provider',
  'prev_state',
  'new_state',
  'failure_count',
  'trigger_context',
];
const CB_TRANSITIONS_INDEXES = [
  'idx_cb_transitions_timestamp_desc',
  'idx_cb_transitions_provider',
];

/**
 * DispatchLog — SQLite-backed audit trail of routing decisions.
 * @param {Object} [options] - Configuration
 * @param {string} [options.dbPath] - Path to SQLite database file (required)
 * @param {string} [options.legacyJsonlPath] - Path to legacy JSONL file for migration (optional)
 */
export class DispatchLog {
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this.legacyJsonlPath = options.legacyJsonlPath || null;
    this._emitter = new EventEmitter();

    // Ensure parent directory exists
    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }

    // Open/create SQLite database with recovery
    this.db = createDatabaseWithRecovery(this.dbPath, {
      emitter: this._emitter,
      enableRecovery: true,
    });

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    this._initDispatchDecisionsTable();
    this._initCbTransitionsTable();

    // In-memory Map index for O(1) lookup by dispatch id.
    // This cache is populated for records appended during this process.
    // For records that predate the current process (e.g., from prior runs),
    // getById() falls through to SQLite query via _getByIdStmt.
    this._idIndex = new Map();

    // Prepare statements for reuse
    this._insertStmt = this.db.prepare(`
      INSERT INTO dispatch_decisions (id, timestamp, taskCategory, campaignId, selectedAgent, selectionReason, traceId, data, replayed_from_id, is_replay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._countStmt = this.db.prepare('SELECT COUNT(*) as count FROM dispatch_decisions');
    this._clearStmt = this.db.prepare('DELETE FROM dispatch_decisions');
    this._getByIdStmt = this.db.prepare(`
      SELECT id, timestamp, taskCategory, campaignId, selectedAgent, selectionReason, traceId, outcome, data, replayed_from_id, is_replay
      FROM dispatch_decisions
      WHERE id = ?
    `);
    this._getReplayChainStmt = this.db.prepare(`
      SELECT id, timestamp, taskCategory, campaignId, selectedAgent, selectionReason, traceId, outcome, data, replayed_from_id, is_replay
      FROM dispatch_decisions
      WHERE replayed_from_id = ?
      ORDER BY timestamp ASC
    `);
    this._insertCbTransitionStmt = this.db.prepare(`
      INSERT INTO cb_transitions (
        timestamp,
        provider,
        prev_state,
        new_state,
        failure_count,
        trigger_context
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this._updateOutcomeStmt = this.db.prepare(`
      UPDATE dispatch_decisions
      SET outcome = ?
      WHERE id = ?
    `);

    // Migrate from legacy JSONL file if provided
    if (this.legacyJsonlPath) {
      this._migrateFromJsonl(this.legacyJsonlPath);
    }
  }

  _initDispatchDecisionsTable() {
    // Create table if it doesn't exist.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_decisions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        taskCategory TEXT,
        campaignId TEXT,
        selectedAgent TEXT,
        selectionReason TEXT,
        traceId TEXT,
        data TEXT NOT NULL
      )
    `);

    // Ensure traceId column exists for older databases.
    const columns = this.db.prepare("PRAGMA table_info('dispatch_decisions')").all();
    const hasTraceId = columns.some(column => column.name === 'traceId');
    if (!hasTraceId) {
      this.db.exec('ALTER TABLE dispatch_decisions ADD COLUMN traceId TEXT');
    }

    // Ensure outcome column exists for task result tracking.
    const hasOutcome = columns.some(column => column.name === 'outcome');
    if (!hasOutcome) {
      this.db.exec('ALTER TABLE dispatch_decisions ADD COLUMN outcome TEXT');
    }

    // Ensure replayed_from_id column exists for replay linkage.
    const hasReplayedFromId = columns.some(column => column.name === 'replayed_from_id');
    if (!hasReplayedFromId) {
      this.db.exec('ALTER TABLE dispatch_decisions ADD COLUMN replayed_from_id TEXT');
    }

    // Ensure is_replay column exists for replay identification.
    const hasIsReplay = columns.some(column => column.name === 'is_replay');
    if (!hasIsReplay) {
      this.db.exec('ALTER TABLE dispatch_decisions ADD COLUMN is_replay INTEGER NOT NULL DEFAULT 0');
    }

    // Create indexes for efficient queries.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON dispatch_decisions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_selectedAgent ON dispatch_decisions(selectedAgent);
      CREATE INDEX IF NOT EXISTS idx_taskCategory ON dispatch_decisions(taskCategory);
      CREATE INDEX IF NOT EXISTS idx_campaignId ON dispatch_decisions(campaignId);
      CREATE INDEX IF NOT EXISTS idx_campaignId_timestamp_desc ON dispatch_decisions(campaignId, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_traceId ON dispatch_decisions(traceId);
      CREATE INDEX IF NOT EXISTS idx_timestamp_desc_selectedAgent ON dispatch_decisions(timestamp DESC, selectedAgent);
      CREATE INDEX IF NOT EXISTS idx_selectedAgent_timestamp_desc ON dispatch_decisions(selectedAgent, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_outcome_timestamp ON dispatch_decisions(outcome, timestamp);
      CREATE INDEX IF NOT EXISTS idx_taskCategory_timestamp ON dispatch_decisions(taskCategory, timestamp);
      CREATE INDEX IF NOT EXISTS idx_replayed_from_id ON dispatch_decisions(replayed_from_id);
    `);
  }

  _initCbTransitionsTable() {
    const existingTable = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'cb_transitions'
    `).get();

    if (!existingTable) {
      this.db.exec(`
        CREATE TABLE cb_transitions (
          timestamp TEXT NOT NULL,
          provider TEXT NOT NULL,
          prev_state TEXT NOT NULL,
          new_state TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          trigger_context JSON NOT NULL DEFAULT '{}'
        )
      `);
    } else {
      const columns = this.db.prepare("PRAGMA table_info('cb_transitions')").all();
      const hasColumn = (name) => columns.some((column) => column.name === name);

      if (!hasColumn('timestamp')) {
        this.db.exec('ALTER TABLE cb_transitions ADD COLUMN timestamp TEXT');
      }
      if (!hasColumn('provider')) {
        this.db.exec('ALTER TABLE cb_transitions ADD COLUMN provider TEXT');
      }
      if (!hasColumn('prev_state')) {
        this.db.exec('ALTER TABLE cb_transitions ADD COLUMN prev_state TEXT');
      }
      if (!hasColumn('new_state')) {
        this.db.exec('ALTER TABLE cb_transitions ADD COLUMN new_state TEXT');
      }
      if (!hasColumn('failure_count')) {
        this.db.exec('ALTER TABLE cb_transitions ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0');
      }
      if (!hasColumn('trigger_context')) {
        this.db.exec("ALTER TABLE cb_transitions ADD COLUMN trigger_context JSON NOT NULL DEFAULT '{}'");
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_timestamp_desc
      ON cb_transitions(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_provider
      ON cb_transitions(provider);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_provider_timestamp_desc
      ON cb_transitions(provider, timestamp DESC);
    `);
  }

  _listTableColumns(tableName) {
    return this.db.prepare(`PRAGMA table_info('${tableName}')`).all();
  }

  _listIndexes(tableName) {
    return this.db.prepare(`PRAGMA index_list('${tableName}')`).all();
  }

  /**
   * Inspect cb_transitions schema readiness for future transition writes/reads.
   * @returns {{
   *   tableExists: boolean,
   *   columns: string[],
   *   indexes: string[],
   *   missingColumns: string[],
   *   missingIndexes: string[],
   *   ready: boolean
   * }}
   */
  getCbTransitionsSchemaStatus() {
    const tableExists = Boolean(this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(CB_TRANSITIONS_TABLE));

    if (!tableExists) {
      return {
        tableExists: false,
        columns: [],
        indexes: [],
        missingColumns: [...CB_TRANSITIONS_COLUMNS],
        missingIndexes: [...CB_TRANSITIONS_INDEXES],
        ready: false,
      };
    }

    const columns = this._listTableColumns(CB_TRANSITIONS_TABLE).map((column) => column.name);
    const indexes = this._listIndexes(CB_TRANSITIONS_TABLE).map((index) => index.name);
    const missingColumns = CB_TRANSITIONS_COLUMNS.filter((name) => !columns.includes(name));
    const missingIndexes = CB_TRANSITIONS_INDEXES.filter((name) => !indexes.includes(name));

    return {
      tableExists: true,
      columns,
      indexes,
      missingColumns,
      missingIndexes,
      ready: missingColumns.length === 0 && missingIndexes.length === 0,
    };
  }

  /**
   * Persist a single circuit breaker transition.
   * @param {Object} transition - Transition payload
   * @param {string} transition.provider - Provider/agent identifier
   * @param {string} transition.prevState - Previous state
   * @param {string} transition.newState - New state
   * @param {number} [transition.failureCount=0] - Failure count at transition time
   * @param {Object} [transition.triggerContext={}] - Trigger metadata (serialized to JSON)
   * @param {string} [transition.timestamp] - ISO timestamp (defaults to now)
   * @returns {Object} persisted transition row
   */
  appendCbTransition(transition = {}) {
    const status = this.getCbTransitionsSchemaStatus();
    if (!status.ready) {
      throw new Error(`cb_transitions schema not ready: missing columns [${status.missingColumns.join(', ')}], missing indexes [${status.missingIndexes.join(', ')}]`);
    }

    const row = {
      timestamp: transition.timestamp || new Date().toISOString(),
      provider: transition.provider || null,
      prev_state: transition.prevState || null,
      new_state: transition.newState || null,
      failure_count: Number.isFinite(transition.failureCount) ? transition.failureCount : 0,
      trigger_context: JSON.stringify(transition.triggerContext || {}),
    };

    if (!row.provider || !row.prev_state || !row.new_state) {
      throw new TypeError('provider, prevState, and newState are required for cb_transitions rows');
    }

    this._insertCbTransitionStmt.run(
      row.timestamp,
      row.provider,
      row.prev_state,
      row.new_state,
      row.failure_count,
      row.trigger_context
    );

    return {
      timestamp: row.timestamp,
      provider: row.provider,
      prevState: row.prev_state,
      newState: row.new_state,
      failureCount: row.failure_count,
      triggerContext: JSON.parse(row.trigger_context),
    };
  }

  /**
   * Query circuit breaker transitions (newest first).
   * @param {Object} [filters] - Optional filters
   * @param {string} [filters.provider] - Provider/agent identifier
   * @param {string} [filters.since] - Inclusive lower-bound ISO timestamp
   * @param {number} [filters.limit=100] - Max rows, capped at 500
   * @param {number} [filters.offset=0] - Pagination offset
   * @returns {{ transitions: Object[], total: number }}
   */
  queryCbTransitions(filters = {}) {
    const whereClauses = [];
    const params = [];

    if (filters.provider) {
      whereClauses.push('provider = ?');
      params.push(filters.provider);
    }

    if (filters.since) {
      whereClauses.push('timestamp >= ?');
      params.push(filters.since);
    }

    const whereClause = whereClauses.length > 0
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM cb_transitions ${whereClause}`).get(...params).count;
    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);
    const rows = this.db.prepare(`
      SELECT timestamp, provider, prev_state, new_state, failure_count, trigger_context
      FROM cb_transitions
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const transitions = rows.map((row) => {
      let triggerContext = {};
      try {
        triggerContext = row.trigger_context ? JSON.parse(row.trigger_context) : {};
      } catch (err) {
        log.warn(`Failed to parse cb_transitions.trigger_context JSON: ${err.message}`);
      }

      return {
        timestamp: row.timestamp,
        provider: row.provider,
        prevState: row.prev_state,
        newState: row.new_state,
        failureCount: row.failure_count,
        triggerContext,
      };
    });

    return { transitions, total };
  }

  /**
   * Get aggregated outcomes by window for attribution analysis.
   * @param {string} startTime - ISO timestamp for start of window
   * @param {string} endTime - ISO timestamp for end of window
   * @returns {Array} Array of aggregated outcome rows per agent
   */
  getOutcomesByWindow(startTime, endTime) {
    const rows = this.db.prepare(`
      SELECT 
        selectedAgent as agentId,
        COUNT(*) as dispatches,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures,
        SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partials
      FROM dispatch_decisions
      WHERE timestamp >= ? AND timestamp < ?
      GROUP BY selectedAgent
    `).all(startTime, endTime);

    // Compute success rate for each agent
    return rows.map(row => ({
      agentId: row.agentId,
      dispatches: row.dispatches || 0,
      successes: row.successes || 0,
      failures: row.failures || 0,
      partials: row.partials || 0,
      successRate: (row.dispatches > 0) ? (row.successes || 0) / row.dispatches : null,
    }));
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

            // Build data blob for SQLite storage
            const dataBlob = JSON.stringify({
              candidates: record.candidates || [],
              constraintsApplied: record.constraintsApplied || [],
              weights: record.weights || [],
              roll: record.roll !== undefined ? record.roll : null,
              secondary_selection: record.secondary_selection || null,
            });

            // Insert into SQLite
            this._insertStmt.run(
              record.id || `dispatch-${randomUUID()}`,
              record.timestamp || new Date().toISOString(),
              record.taskCategory || null,
              record.campaignId || null,
              record.selectedAgent || null,
              record.selectionReason || null,
              record.traceId || null,
              dataBlob
            );

            recordsImported++;
          } catch (err) {
            // Skip malformed lines with warning (matching orchestrator/dispatch-log.js:66)
            console.warn('Skipping malformed JSONL line:', line.substring(0, 50));
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
   * Append a dispatch record to the audit trail.
   * @param {Object} record - Dispatch audit record
   * @param {string} record.id - Unique identifier (auto-generated if not provided)
   * @param {string} record.timestamp - ISO timestamp
   * @param {string} record.taskCategory - Task category (e.g., 'implementation', 'research')
   * @param {string} record.campaignId - Campaign ID (optional)
   * @param {Object[]} record.candidates - Array of candidate agents { agentId, provider, successRate, decayedRate }
   * @param {Object[]} record.constraintsApplied - Array of applied constraints { type, value, agentsRemoved }
   * @param {Object[]} record.weights - Array of computed weights { agentId, weight, reason, successRate }
   * @param {number|null} record.roll - Random roll value used for selection
   * @param {string} record.selectedAgent - Selected agent ID
   * @param {string} record.selectionReason - Reason for selection
   * @param {string} record.traceId - Trace ID for distributed tracing (optional)
   * @param {string} record.inputs - Original message text or task description (optional)
   * @returns {Promise<Object>} The appended record
   */
  async append(record) {
    const auditRecord = {
      ...record, // Preserve all input fields (e.g., seq for tests)
      id: record.id || `dispatch-${randomUUID()}`,
      timestamp: record.timestamp || new Date().toISOString(),
      taskCategory: record.taskCategory || null,
      campaignId: record.campaignId || null,
      candidates: record.candidates || [],
      constraintsApplied: record.constraintsApplied || [],
      weights: record.weights || [],
      roll: record.roll !== undefined ? record.roll : null,
      selectedAgent: record.selectedAgent || null,
      selectionReason: record.selectionReason || null,
      traceId: record.traceId || null,
      secondary_selection: record.secondary_selection || null,
      inputs: record.inputs || null,
    };

    // Store structured fields in columns, rest in JSON data blob
    const dataBlob = JSON.stringify({
      candidates: auditRecord.candidates,
      constraintsApplied: auditRecord.constraintsApplied,
      weights: auditRecord.weights,
      roll: auditRecord.roll,
      secondary_selection: auditRecord.secondary_selection,
      inputs: auditRecord.inputs,
      // Preserve any extra fields from input record
      ...Object.fromEntries(
        Object.entries(record).filter(([key]) =>
          !['id', 'timestamp', 'taskCategory', 'campaignId', 'selectedAgent', 'selectionReason', 'traceId',
            'candidates', 'constraintsApplied', 'weights', 'roll', 'secondary_selection', 'inputs'].includes(key)
        )
      )
    });

    try {
      this._insertStmt.run(
        auditRecord.id,
        auditRecord.timestamp,
        auditRecord.taskCategory,
        auditRecord.campaignId,
        auditRecord.selectedAgent,
        auditRecord.selectionReason,
        auditRecord.traceId,
        dataBlob,
        record.replayed_from_id || null,
        record.is_replay ? 1 : 0
      );
    } catch (err) {
      log.error(`Failed to insert dispatch record: ${err.message}`);
      throw err;
    }

    // Populate in-memory index for O(1) lookup
    this._idIndex.set(auditRecord.id, auditRecord);

    return auditRecord;
  }

  /**
   * Update the outcome field of an existing dispatch decision.
   * @param {string} id - Dispatch decision ID
   * @param {string} outcome - Outcome value: 'success', 'failure', or 'partial'
   * @returns {boolean} True if a row was updated, false otherwise
   */
  updateOutcome(id, outcome) {
    if (!id) {
      log.warn('updateOutcome called with missing id');
      return false;
    }

    if (!outcome || !['success', 'failure', 'partial'].includes(outcome)) {
      log.warn(`updateOutcome called with invalid outcome: ${outcome}`);
      return false;
    }

    try {
      const result = this._updateOutcomeStmt.run(outcome, id);
      const updated = result.changes > 0;

      // Update in-memory cache if the record exists there
      if (updated && this._idIndex.has(id)) {
        const cached = this._idIndex.get(id);
        cached.outcome = outcome;
      }

      return updated;
    } catch (err) {
      log.error(`Failed to update outcome for dispatch ${id}: ${err.message}`);
      return false;
    }
  }

  /**
   * Query dispatch records with optional filtering.
   * @param {Object} [filters] - Optional filters
   * @param {string} [filters.taskCategory] - Filter by task category
   * @param {string} [filters.agentId] - Filter by selected agent ID
   * @param {string} [filters.campaignId] - Filter by campaign ID
   * @param {string} [filters.startTime] - Filter records after this ISO timestamp
   * @param {string} [filters.endTime] - Filter records before this ISO timestamp
   * @param {number} [filters.limit] - Maximum number of records to return (max 500)
   * @param {number} [filters.offset] - Number of records to skip (default 0)
   * @returns {{ decisions: Object[], total: number }} Object with decisions array and total count
   */
  query(filters = {}) {
    const whereClauses = [];
    const params = [];

    // Build WHERE clause
    if (filters.taskCategory) {
      whereClauses.push('taskCategory = ?');
      params.push(filters.taskCategory);
    }

    if (filters.agentId) {
      whereClauses.push('selectedAgent = ?');
      params.push(filters.agentId);
    }

    if (filters.campaignId) {
      whereClauses.push('campaignId = ?');
      params.push(filters.campaignId);
    }

    if (filters.startTime) {
      whereClauses.push('timestamp >= ?');
      params.push(filters.startTime);
    }

    if (filters.endTime) {
      whereClauses.push('timestamp <= ?');
      params.push(filters.endTime);
    }

    const whereClause = whereClauses.length > 0
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';

    // Get total count before pagination
    const countQuery = `SELECT COUNT(*) as count FROM dispatch_decisions ${whereClause}`;
    const total = this.db.prepare(countQuery).get(params).count;

    // Apply pagination
    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);

    // Fetch records (most recent first)
    const query = `
      SELECT id, timestamp, taskCategory, campaignId, selectedAgent, selectionReason, traceId, outcome, data, replayed_from_id, is_replay
      FROM dispatch_decisions
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(query).all(...params, limit, offset);

    // Reconstruct full records from columns + JSON data blob
    const decisions = rows.map(row => {
      const data = JSON.parse(row.data);
      return {
        id: row.id,
        timestamp: row.timestamp,
        taskCategory: row.taskCategory,
        campaignId: row.campaignId,
        selectedAgent: row.selectedAgent,
        selectionReason: row.selectionReason,
        traceId: row.traceId || null,
        outcome: row.outcome || null,
        replayed_from_id: row.replayed_from_id || null,
        is_replay: Boolean(row.is_replay),
        candidates: data.candidates || [],
        constraintsApplied: data.constraintsApplied || [],
        weights: data.weights || [],
        roll: data.roll !== undefined ? data.roll : null,
        secondary_selection: data.secondary_selection || null,
        inputs: data.inputs || null,
        // Spread any extra fields that were preserved
        ...Object.fromEntries(
          Object.entries(data).filter(([key]) =>
            !['candidates', 'constraintsApplied', 'weights', 'roll', 'secondary_selection', 'inputs'].includes(key)
          )
        )
      };
    });

    return { decisions, total };
  }

  /**
   * Query dispatch decisions normalized for timeline rendering.
   * @param {Object} [filters] - Optional filters
   * @param {string} [filters.dispatchId] - Filter by dispatch id
   * @param {string} [filters.agentId] - Filter by selected agent
   * @param {string} [filters.campaignId] - Filter by campaign id
   * @param {string} [filters.since] - Inclusive lower-bound ISO timestamp
   * @param {string} [filters.until] - Inclusive upper-bound ISO timestamp
   * @param {number} [filters.limit=100] - Max rows, capped at 500
   * @param {number} [filters.offset=0] - Pagination offset
   * @returns {{ events: Object[], total: number }}
   */
  queryForTimeline(filters = {}) {
    const whereClauses = [];
    const params = [];

    if (filters.dispatchId) {
      whereClauses.push('id = ?');
      params.push(filters.dispatchId);
    }

    if (filters.agentId) {
      whereClauses.push('selectedAgent = ?');
      params.push(filters.agentId);
    }

    if (filters.campaignId) {
      whereClauses.push('campaignId = ?');
      params.push(filters.campaignId);
    }

    if (filters.since) {
      whereClauses.push('timestamp >= ?');
      params.push(filters.since);
    }

    if (filters.until) {
      whereClauses.push('timestamp <= ?');
      params.push(filters.until);
    }

    const whereClause = whereClauses.length > 0
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';

    const total = this.db.prepare(`SELECT COUNT(*) as count FROM dispatch_decisions ${whereClause}`).get(...params).count;
    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);
    const rows = this.db.prepare(`
      SELECT id, timestamp, taskCategory, campaignId, selectedAgent, selectionReason, traceId, data, outcome
      FROM dispatch_decisions
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const events = rows.map((row) => {
      let data = {};
      try {
        data = row.data ? JSON.parse(row.data) : {};
      } catch (err) {
        log.warn(`Failed to parse dispatch_decisions.data JSON for timeline record ${row.id}: ${err.message}`);
      }

      const category = row.taskCategory || 'unknown';
      const agent = row.selectedAgent || 'unknown';
      const dispatchData = {
        id: row.id,
        timestamp: row.timestamp,
        taskCategory: row.taskCategory,
        campaignId: row.campaignId,
        selectedAgent: row.selectedAgent,
        selectionReason: row.selectionReason,
        traceId: row.traceId || null,
        outcome: row.outcome || null,
        candidates: data.candidates || [],
        constraintsApplied: data.constraintsApplied || [],
        weights: data.weights || [],
        roll: data.roll !== undefined ? data.roll : null,
        secondary_selection: data.secondary_selection || null,
        ...Object.fromEntries(
          Object.entries(data).filter(([key]) =>
            !['candidates', 'constraintsApplied', 'weights', 'roll', 'secondary_selection'].includes(key)
          )
        ),
      };

      return {
        id: row.id,
        type: 'dispatch',
        timestamp: row.timestamp,
        summary: `Dispatched ${category} to ${agent}`,
        data: dispatchData,
      };
    });

    return { events, total };
  }

  /**
   * Retrieve a single dispatch record by ID.
   * Performs O(1) lookup via internal Map index for records appended in this process.
   * Falls back to SQLite query for records that predate the current process.
   * @param {string} id - Unique dispatch record identifier
   * @returns {Object|null} The dispatch record, or null if not found
   */
  getById(id) {
    if (!id) {
      return null;
    }

    // Check in-memory index first (O(1) for records appended in this process)
    const cached = this._idIndex.get(id);
    if (cached) {
      return cached;
    }

    // Fallback to SQLite for records that predate this process
    const row = this._getByIdStmt.get(id);

    if (!row) {
      return null;
    }

    // Parse data blob with null-safe defaults
    let data;
    try {
      data = JSON.parse(row.data);
    } catch (err) {
      log.warn(`Failed to parse data blob for record ${id}: ${err.message}`);
      data = {};
    }

    // Reconstruct full record from columns + JSON data blob
    return {
      id: row.id,
      timestamp: row.timestamp,
      taskCategory: row.taskCategory,
      campaignId: row.campaignId,
      selectedAgent: row.selectedAgent,
      selectionReason: row.selectionReason,
      traceId: row.traceId || null,
      outcome: row.outcome || null,
      replayed_from_id: row.replayed_from_id || null,
      is_replay: Boolean(row.is_replay),
      candidates: data.candidates || [],
      constraintsApplied: data.constraintsApplied || [],
      weights: data.weights || [],
      roll: data.roll !== undefined ? data.roll : null,
      secondary_selection: data.secondary_selection || null,
      // Spread any extra fields that were preserved
      ...Object.fromEntries(
        Object.entries(data).filter(([key]) =>
          !['candidates', 'constraintsApplied', 'weights', 'roll', 'secondary_selection'].includes(key)
        )
      )
    };
  }

  /**
   * Get all dispatches that were replayed from a given dispatch ID.
   * @param {string} dispatchId - Original dispatch ID
   * @returns {Object[]} Array of replay dispatch records
   */
  getReplayChain(dispatchId) {
    if (!dispatchId) return [];

    const rows = this._getReplayChainStmt.all(dispatchId);
    return rows.map(row => {
      let data = {};
      try {
        data = row.data ? JSON.parse(row.data) : {};
      } catch (err) {
        log.warn(`Failed to parse data blob for replay chain record ${row.id}: ${err.message}`);
      }

      return {
        id: row.id,
        timestamp: row.timestamp,
        taskCategory: row.taskCategory,
        campaignId: row.campaignId,
        selectedAgent: row.selectedAgent,
        selectionReason: row.selectionReason,
        traceId: row.traceId || null,
        outcome: row.outcome || null,
        replayed_from_id: row.replayed_from_id || null,
        is_replay: Boolean(row.is_replay),
        candidates: data.candidates || [],
        constraintsApplied: data.constraintsApplied || [],
        weights: data.weights || [],
        roll: data.roll !== undefined ? data.roll : null,
        secondary_selection: data.secondary_selection || null,
      };
    });
  }

  /**
   * Transforms a raw dispatch record into the rationale format.
   * @param {Object} record - The raw dispatch record (output of getById).
   * @param {Object} [timelineStore] - Optional TimelineStore instance for guardrail lookup.
   * @returns {Object} The dispatch rationale object.
   */
  _transformToRationale(record, timelineStore = null) {
    if (!record) {
      return null;
    }

    const inputs = record.inputs || null;
    let guardrailContext = null;
    let circuitBreakerContext = null;

    // Look up guardrail outcomes correlated to this dispatch via dispatchId
    if (timelineStore && record.id) {
      try {
        const { events } = timelineStore.query({
          type: 'guardrail_outcome',
          dispatchId: record.id,
        });

        if (events && events.length > 0) {
          guardrailContext = {
            dispatchId: record.id,
            evaluatedAt: record.timestamp,
            outcomes: events.map((event) => ({
              timestamp: event.timestamp,
              agentId: event.correlationKeys.agentId,
              outcome: event.data.outcome,
              ruleId: event.data.ruleId,
              ruleName: event.data.ruleName,
              score: event.data.score,
              detail: event.data.detail,
            })),
            summary: {
              totalOutcomes: events.length,
              rulesEvaluated: [...new Set(events.map((e) => e.data.ruleName))],
              anyBlocked: events.some((e) => e.data.outcome === 'block' || e.data.outcome === 'fail'),
            },
          };
        }
      } catch (err) {
        log.warn(`Failed to lookup guardrail context for dispatch ${record.id}: ${err.message}`);
        guardrailContext = null;
      }

      // Look up circuit breaker transitions correlated to this dispatch
      try {
        const { events: cbEvents } = timelineStore.query({
          type: 'circuit_breaker',
          dispatchId: record.id,
        });

        if (cbEvents && cbEvents.length > 0) {
          circuitBreakerContext = {
            dispatchId: record.id,
            transitions: cbEvents.map((event) => ({
              timestamp: event.timestamp,
              provider: event.correlationKeys.provider || event.data.provider || 'unknown',
              previousState: event.data.previousState || event.data.prev_state || 'unknown',
              newState: event.data.newState || event.data.new_state || event.data.state || 'unknown',
              failureCount: event.data.failureCount ?? event.data.failure_count ?? 0,
              triggerContext: event.data.triggerContext || event.data.trigger_context || null,
            })),
            summary: {
              totalTransitions: cbEvents.length,
              providers: [...new Set(cbEvents.map((e) => e.correlationKeys.provider || e.data.provider).filter(Boolean))],
              anyOpen: cbEvents.some((e) => {
                const state = e.data.newState || e.data.new_state || e.data.state;
                return state === 'open';
              }),
            },
          };
        }
      } catch (err) {
        log.warn(`Failed to lookup circuit breaker context for dispatch ${record.id}: ${err.message}`);
        circuitBreakerContext = null;
      }
    }

    let chosenRoute = null;
    const fallbacks = [];

    if (record.selectedAgent) {
      chosenRoute = {
        agentId: record.selectedAgent,
        ...record.candidates.find((c) => c.agentId === record.selectedAgent),
      };

      for (const candidate of record.candidates) {
        if (candidate.agentId !== record.selectedAgent) {
          fallbacks.push(candidate);
        }
      }
    } else {
      fallbacks.push(...record.candidates);
    }

    return {
      inputs,
      guardrailContext,
      circuitBreakerContext,
      chosenRoute,
      fallbacks,
      _dashboard: {
        dispatchId: record.id || null,
        campaignId: record.campaignId || null,
        timestamp: record.timestamp || null,
        traceId: record.traceId || null,
      },
    };
  }

  /**
   * Retrieves a dispatch rationale by dispatch ID.
   * @param {string} dispatchId - Unique dispatch record identifier.
   * @param {Object} [timelineStore] - Optional TimelineStore instance for guardrail lookup.
   * @returns {Object|null} The dispatch rationale object, or null if not found.
   */
  getDispatchRationale(dispatchId, timelineStore = null) {
    const record = this.getById(dispatchId);
    if (!record) {
      return null;
    }
    return this._transformToRationale(record, timelineStore);
  }

  /**
   * Get the current number of records.
   * @returns {number}
   */
  getSize() {
    return this._countStmt.get().count;
  }

  /**
   * Capture an immutable snapshot of dispatch_decisions record count.
   * Intended for restart continuity validation.
   * @param {Object} [opts]
   * @param {string} [opts.label] - Optional snapshot label (e.g. "pre-restart")
   * @returns {{
   *   table: string,
   *   count: number,
   *   capturedAt: string,
   *   dbPath: string,
   *   label: string|null
   * }}
   */
  snapshotRecordCount(opts = {}) {
    const count = this.getSize();
    return {
      table: 'dispatch_decisions',
      count,
      capturedAt: new Date().toISOString(),
      dbPath: this.dbPath,
      label: opts.label || null,
    };
  }

  /**
   * Compare two record-count snapshots and describe any discrepancy.
   * @param {{
   *   table?: string,
   *   count: number,
   *   capturedAt?: string,
   *   dbPath?: string,
   *   label?: string|null
   * }} expectedSnapshot
   * @param {{
   *   table?: string,
   *   count: number,
   *   capturedAt?: string,
   *   dbPath?: string,
   *   label?: string|null
   * }} actualSnapshot
   * @returns {{
   *   isMatch: boolean,
   *   expected: number,
   *   actual: number,
   *   difference: number,
   *   table: string,
   *   expectedLabel: string|null,
   *   actualLabel: string|null,
   *   message: string
   * }}
   */
  compareRecordCounts(expectedSnapshot, actualSnapshot) {
    if (!expectedSnapshot || typeof expectedSnapshot.count !== 'number') {
      throw new TypeError('compareRecordCounts requires expectedSnapshot with numeric count');
    }
    if (!actualSnapshot || typeof actualSnapshot.count !== 'number') {
      throw new TypeError('compareRecordCounts requires actualSnapshot with numeric count');
    }

    const table = actualSnapshot.table || expectedSnapshot.table || 'dispatch_decisions';
    const expected = expectedSnapshot.count;
    const actual = actualSnapshot.count;
    const difference = actual - expected;
    const isMatch = difference === 0;
    const expectedLabel = expectedSnapshot.label || null;
    const actualLabel = actualSnapshot.label || null;
    const descriptor = difference > 0 ? 'extra' : 'missing';

    const message = isMatch
      ? `Record count validated for ${table}: ${actual} rows (no discrepancy)`
      : `Record count mismatch for ${table}: expected ${expected}, actual ${actual} (${Math.abs(difference)} ${descriptor} rows)`;

    return {
      isMatch,
      expected,
      actual,
      difference,
      table,
      expectedLabel,
      actualLabel,
      message,
    };
  }

  /**
   * Validate current dispatch_decisions count against a prior snapshot.
   * Useful after process restart to assert persistence continuity.
   * @param {{
   *   table?: string,
   *   count: number,
   *   capturedAt?: string,
   *   dbPath?: string,
   *   label?: string|null
   * }} expectedSnapshot
   * @param {Object} [opts]
   * @param {string} [opts.label] - Optional label for the current snapshot
   * @returns {{
   *   ok: boolean,
   *   expected: number,
   *   actual: number,
   *   difference: number,
   *   table: string,
   *   expectedLabel: string|null,
   *   actualLabel: string|null,
   *   currentSnapshot: {
   *     table: string,
   *     count: number,
   *     capturedAt: string,
   *     dbPath: string,
   *     label: string|null
   *   },
   *   message: string
   * }}
   */
  validateRecordCount(expectedSnapshot, opts = {}) {
    if (!expectedSnapshot || typeof expectedSnapshot.count !== 'number') {
      throw new TypeError('validateRecordCount requires expectedSnapshot with numeric count');
    }

    const currentSnapshot = this.snapshotRecordCount({ label: opts.label || 'validation-current' });
    const comparison = this.compareRecordCounts(expectedSnapshot, currentSnapshot);
    const ok = comparison.isMatch;

    return {
      ok,
      expected: comparison.expected,
      actual: comparison.actual,
      difference: comparison.difference,
      table: comparison.table,
      expectedLabel: comparison.expectedLabel,
      actualLabel: comparison.actualLabel,
      currentSnapshot,
      message: comparison.message,
    };
  }

  /**
   * Clear all records.
   * Also clears the in-memory index.
   */
  clear() {
    this._clearStmt.run();
    this._idIndex.clear();
  }

  /**
   * Query per-agent, per-category outcome counts within a time window.
   * Used by the /api/routing-outcomes endpoint to compute success rates.
   *
   * @param {string} [startTime] - Inclusive lower-bound ISO timestamp (omit for no lower bound)
   * @param {string} [endTime] - Inclusive upper-bound ISO timestamp (omit for no upper bound)
   * @returns {Array<{
   *   taskCategory: string,
   *   agentId: string,
   *   dispatches: number,
   *   successes: number,
   *   failures: number,
   *   partials: number,
   *   nullOutcomes: number,
   *   successRate: number|null
   * }>} One entry per (taskCategory, agentId) pair found in the window.
   *   successRate is null when no rows in the pair have a non-null outcome.
   */
  queryOutcomesByWindow(startTime, endTime) {
    const whereClauses = ['taskCategory IS NOT NULL', 'selectedAgent IS NOT NULL'];
    const params = [];

    if (startTime) {
      whereClauses.push('timestamp >= ?');
      params.push(startTime);
    }

    if (endTime) {
      whereClauses.push('timestamp <= ?');
      params.push(endTime);
    }

    const whereClause = 'WHERE ' + whereClauses.join(' AND ');

    const rows = this.db.prepare(`
      SELECT
        taskCategory,
        selectedAgent,
        COUNT(*) AS dispatches,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) AS partials,
        SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS nullOutcomes,
        SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS knownOutcomes
      FROM dispatch_decisions
      ${whereClause}
      GROUP BY taskCategory, selectedAgent
      ORDER BY taskCategory, selectedAgent
    `).all(...params);

    return rows.map(row => {
      const successRate = row.knownOutcomes > 0
        ? row.successes / row.knownOutcomes
        : null;

      return {
        taskCategory: row.taskCategory,
        agentId: row.selectedAgent,
        dispatches: row.dispatches,
        successes: row.successes,
        failures: row.failures,
        partials: row.partials,
        nullOutcomes: row.nullOutcomes,
        successRate,
      };
    });
  }

  // Backward-compatible alias for existing callers/tests.
  getOutcomesByWindow(startTime, endTime) {
    return this.queryOutcomesByWindow(startTime, endTime);
  }

  /**
   * Flush pending writes to disk immediately.
   * No-op for SQLite (writes are synchronous).
   * @returns {Promise<void>}
   */
  async flush() {
    // SQLite writes are synchronous and durable by default
    // This method exists only for API compatibility
    return Promise.resolve();
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
   * Call this when shutting down to ensure clean closure.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export function createDispatchLog(opts = {}) {
  const { config, dbPath, timelineStore } = opts;

  // If no dbPath provided, derive from config or use default
  const finalDbPath = dbPath || config?.dispatchLog?.dbPath || './data/dispatch.db';

  const dispatchLog = new DispatchLog({ dbPath: finalDbPath });

  return {
    append: dispatchLog.append.bind(dispatchLog),
    query: dispatchLog.query.bind(dispatchLog),
    queryForTimeline: dispatchLog.queryForTimeline.bind(dispatchLog),
    getById: dispatchLog.getById.bind(dispatchLog),
    getDispatchRationale: dispatchLog.getDispatchRationale.bind(dispatchLog, timelineStore),
    getSize: dispatchLog.getSize.bind(dispatchLog),
    snapshotRecordCount: dispatchLog.snapshotRecordCount.bind(dispatchLog),
    compareRecordCounts: dispatchLog.compareRecordCounts.bind(dispatchLog),
    validateRecordCount: dispatchLog.validateRecordCount.bind(dispatchLog),
    clear: dispatchLog.clear.bind(dispatchLog),
    flush: dispatchLog.flush.bind(dispatchLog),
    updateOutcome: dispatchLog.updateOutcome.bind(dispatchLog),
    getReplayChain: dispatchLog.getReplayChain.bind(dispatchLog),
    queryOutcomesByWindow: dispatchLog.queryOutcomesByWindow.bind(dispatchLog),
    getOutcomesByWindow: dispatchLog.getOutcomesByWindow.bind(dispatchLog),
  };
}

export default createDispatchLog;
