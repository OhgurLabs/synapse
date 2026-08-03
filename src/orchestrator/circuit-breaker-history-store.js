/**
 * Circuit Breaker History Store — SQLite-backed persistence for CB state transitions.
 * Stores all circuit breaker state transitions (closed→open, open→half-open, etc.)
 * with indexed columns for efficient querying by provider and timestamp.
 */

import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

const log = createLogger('cb-history-store');

export class CircuitBreakerHistoryStore {
  /**
   * @param {Object} options - Store configuration
   * @param {string} options.dbPath - Path to SQLite database file
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;

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

    // Create cb_transitions table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cb_transitions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        previous_state TEXT,
        data TEXT
      )
    `);

    // Ensure indexes exist for efficient queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_timestamp ON cb_transitions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_provider ON cb_transitions(provider);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_timestamp_provider ON cb_transitions(timestamp, provider);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_provider_timestamp ON cb_transitions(provider, timestamp);
    `);

    // Prepare statements for reuse
    this._insertStmt = this.db.prepare(`
      INSERT INTO cb_transitions (id, timestamp, provider, state, previous_state, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Record a circuit breaker state transition.
   * @param {Object} transition - Transition data
   * @param {string} transition.provider - Provider/agent ID
   * @param {string} transition.state - New state (closed, open, half_open)
   * @param {string} transition.previousState - Previous state
   * @param {Object} [transition.metadata] - Optional additional data
   * @returns {string} The ID of the recorded transition
   */
  record(transition) {
    const { provider, state, previousState, metadata } = transition;
    const id = `cb_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timestamp = new Date().toISOString();
    const data = metadata ? JSON.stringify(metadata) : null;

    try {
      this._insertStmt.run(id, timestamp, provider, state, previousState, data);
      return id;
    } catch (err) {
      log.error('Failed to record CB transition', { error: err.message });
      throw err;
    }
  }

  /**
   * Query CB transitions with optional filtering.
   * @param {Object} [filters] - Optional filters
   * @param {string} [filters.provider] - Filter by provider
   * @param {string} [filters.since] - Filter transitions after this ISO timestamp
   * @param {number} [filters.limit] - Maximum results (default 100, max 500)
   * @param {number} [filters.offset] - Results to skip (default 0)
   * @returns {{ transitions: Object[], total: number }} Query results
   */
  query(filters = {}) {
    const whereClauses = [];
    const params = [];

    // Build WHERE clause using indexed columns
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

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM cb_transitions ${whereClause}`;
    const total = this.db.prepare(countQuery).get(params).count;

    // Apply pagination
    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);

    // Fetch transitions sorted by timestamp DESC (most recent first)
    const query = `
      SELECT id, timestamp, provider, state, previous_state, data
      FROM cb_transitions
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(query).all(...params, limit, offset);

    // Reconstruct full transition objects
    const transitions = rows.map(row => {
      let data = null;
      if (row.data) {
        try {
          data = JSON.parse(row.data);
        } catch (err) {
          log.warn('Failed to parse transition data JSON, storing raw string', {
            id: row.id,
            error: err.message,
          });
          data = { _raw: row.data, _parseError: err.message };
        }
      }
      return {
        id: row.id,
        timestamp: row.timestamp,
        provider: row.provider,
        state: row.state,
        previousState: row.previous_state,
        data,
      };
    });

    return { transitions, total };
  }

  /**
   * Query CB transitions normalized for timeline rendering.
   * @param {Object} [filters] - Optional filters
   * @param {string} [filters.dispatchId] - Filter by dispatch id found in metadata JSON
   * @param {string} [filters.provider] - Filter by provider
   * @param {string} [filters.since] - Inclusive lower-bound ISO timestamp
   * @param {string} [filters.until] - Inclusive upper-bound ISO timestamp
   * @param {number} [filters.limit=100] - Maximum results (max 500)
   * @param {number} [filters.offset=0] - Results to skip
   * @returns {{ events: Object[], total: number }} Timeline events
   */
  queryForTimeline(filters = {}) {
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

    if (filters.until) {
      whereClauses.push('timestamp <= ?');
      params.push(filters.until);
    }

    const whereClause = whereClauses.length > 0
      ? 'WHERE ' + whereClauses.join(' AND ')
      : '';

    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);
    const dispatchIdFilter = filters.dispatchId || null;

    const baseSelect = `
      SELECT id, timestamp, provider, state, previous_state, data
      FROM cb_transitions
      ${whereClause}
      ORDER BY timestamp DESC
    `;

    // dispatchId lives in transition metadata (data JSON), so apply that filter post-read.
    const rows = dispatchIdFilter
      ? this.db.prepare(baseSelect).all(...params)
      : this.db.prepare(`${baseSelect}\nLIMIT ? OFFSET ?`).all(...params, limit, offset);

    const events = rows.map((row) => {
      let metadata = null;
      if (row.data) {
        try {
          metadata = JSON.parse(row.data);
        } catch (err) {
          log.warn('Failed to parse transition data JSON for timeline event, storing raw string', {
            id: row.id,
            error: err.message,
          });
          metadata = { _raw: row.data, _parseError: err.message };
        }
      }

      const provider = row.provider || 'unknown';
      const previousState = row.previous_state || 'unknown';
      const state = row.state || 'unknown';

      return {
        id: row.id,
        type: 'circuit-breaker',
        timestamp: row.timestamp,
        summary: `CB ${provider}: ${previousState} → ${state}`,
        data: {
          id: row.id,
          timestamp: row.timestamp,
          provider: row.provider,
          state: row.state,
          previousState: row.previous_state,
          data: metadata,
        },
      };
    }).filter((event) => {
      if (!dispatchIdFilter) return true;
      return event?.data?.data?.dispatchId === dispatchIdFilter;
    });

    if (!dispatchIdFilter) {
      const total = this.db.prepare(`SELECT COUNT(*) as count FROM cb_transitions ${whereClause}`).get(...params).count;
      return { events, total };
    }

    const paginatedEvents = events.slice(offset, offset + limit);
    return { events: paginatedEvents, total: events.length };
  }

  /**
   * Get recent transitions for a specific provider.
   * @param {string} provider - Provider/agent ID
   * @param {number} [limit=50] - Maximum results
   * @returns {Object[]} Array of recent transitions
   */
  getProviderHistory(provider, limit = 50) {
    const { transitions } = this.query({ provider, limit });
    return transitions;
  }

  /**
   * Close the database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Create a CircuitBreakerHistoryStore instance.
 * @param {Object} options - Store configuration
 * @param {string} options.dbPath - Path to SQLite database file
 * @returns {CircuitBreakerHistoryStore} Store instance
 */
export function createCircuitBreakerHistoryStore(options = {}) {
  const store = new CircuitBreakerHistoryStore(options);
  return {
    record: store.record.bind(store),
    query: store.query.bind(store),
    queryForTimeline: store.queryForTimeline.bind(store),
    getProviderHistory: store.getProviderHistory.bind(store),
    close: store.close.bind(store),
  };
}

export default CircuitBreakerHistoryStore;
