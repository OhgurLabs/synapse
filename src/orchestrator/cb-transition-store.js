import Database from '../persistence/sqlite-provider.js';
import { mkdirSync, existsSync, readFileSync, appendFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('cb-transition-store');

/**
 * CbTransitionStore — SQLite-backed persistence for circuit breaker transitions.
 * Falls back to JSONL file if SQLite is unavailable or corrupted.
 */
export class CbTransitionStore {
  /**
   * @param {Object} [options] - Store configuration
   * @param {string} options.dbPath - Path to SQLite database file
   * @param {boolean} [options.disableJsonlFallback=false] - Disable JSONL fallback (testing only)
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this._disableJsonlFallback = options.disableJsonlFallback ?? false;
    this._usingJsonlFallback = false;
    this._jsonlPath = null;

    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }

    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this._initTable();
    } catch (err) {
      if (this._disableJsonlFallback) {
        log.error('SQLite initialization failed and JSONL fallback is disabled', {
          dbPath: this.dbPath,
          error: err.message,
        });
        throw new Error(`SQLite initialization failed: ${err.message}`, { cause: err });
      }

      log.warn('SQLite initialization failed, falling back to JSONL', {
        dbPath: this.dbPath,
        error: err.message,
      });
      this._initJsonlFallback();
    }

    if (!this._usingJsonlFallback) {
      this._insertStmt = this.db.prepare(`
        INSERT INTO cb_transitions (
          id,
          timestamp,
          provider,
          agentId,
          dispatchId,
          previousState,
          newState,
          failureCount
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this._appendTxn = this.db.transaction((row) => {
        this._insertStmt.run(
          row.id,
          row.timestamp,
          row.provider,
          row.agentId,
          row.dispatchId,
          row.previousState,
          row.newState,
          row.failureCount
        );
      });
    }
  }

  _initTable() {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS cb_transitions (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        provider TEXT NOT NULL,
        agentId TEXT,
        dispatchId TEXT,
        previousState TEXT NOT NULL,
        newState TEXT NOT NULL,
        failureCount INTEGER NOT NULL DEFAULT 0
      )
    `);

    this._ensureAgentIdColumn();
    this._ensureDispatchIdColumn();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_timestamp_desc
      ON cb_transitions(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_provider
      ON cb_transitions(provider);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_agentId
      ON cb_transitions(agentId);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_dispatchId
      ON cb_transitions(dispatchId);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_provider_timestamp_desc
      ON cb_transitions(provider, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_agentId_timestamp_desc
      ON cb_transitions(agentId, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_cb_transitions_dispatchId_timestamp_desc
      ON cb_transitions(dispatchId, timestamp DESC);
    `);
  }

  _ensureAgentIdColumn() {
    const columns = this.db.prepare(`PRAGMA table_info('cb_transitions')`).all();
    const hasAgentId = columns.some(col => col.name === 'agentId');
    if (!hasAgentId) {
      this.db.exec(`ALTER TABLE cb_transitions ADD COLUMN agentId TEXT`);
    }
  }

  _ensureDispatchIdColumn() {
    const columns = this.db.prepare(`PRAGMA table_info('cb_transitions')`).all();
    const hasDispatchId = columns.some(col => col.name === 'dispatchId');
    if (!hasDispatchId) {
      this.db.exec(`ALTER TABLE cb_transitions ADD COLUMN dispatchId TEXT`);
    }
  }

  _initJsonlFallback() {
    const extension = extname(this.dbPath);
    const baseName = extension === '.sqlite' || extension === '.db'
      ? join(dirname(this.dbPath), basename(this.dbPath, extension))
      : this.dbPath.replace(/\.sqlite$|\.db$/, '');
    this._jsonlPath = baseName + '.jsonl';

    log.info('Using JSONL fallback for circuit breaker transitions', {
      jsonlPath: this._jsonlPath,
      originalDbPath: this.dbPath,
    });

    this._jsonlTransitions = [];
    this._loadJsonl();
    this._usingJsonlFallback = true;
  }

  _loadJsonl() {
    if (!this._jsonlPath || !existsSync(this._jsonlPath)) {
      return;
    }

    try {
      const content = readFileSync(this._jsonlPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const transition = JSON.parse(line);
          if (!('agentId' in transition)) {
            transition.agentId = null;
          }
          if (!('dispatchId' in transition)) {
            transition.dispatchId = null;
          }
          this._jsonlTransitions.push(transition);
        } catch (err) {
          log.warn('Failed to parse JSONL entry, skipping', {
            jsonlPath: this._jsonlPath,
            line: line.substring(0, 100),
            error: err.message,
          });
        }
      }

      log.info('Loaded JSONL transitions', {
        jsonlPath: this._jsonlPath,
        count: this._jsonlTransitions.length,
      });
    } catch (err) {
      log.error('Failed to load JSONL file', {
        jsonlPath: this._jsonlPath,
        error: err.message,
      });
    }
  }

  _persistJsonl() {
    if (!this._jsonlPath) {
      return;
    }

    try {
      const content = this._jsonlTransitions
        .map(t => JSON.stringify(t))
        .join('\n') + '\n';
      writeFileSync(this._jsonlPath, content, 'utf-8');
    } catch (err) {
      log.error('Failed to persist JSONL file', {
        jsonlPath: this._jsonlPath,
        error: err.message,
      });
    }
  }

  /**
   * Append a single transition row.
   * @param {Object} transition - Transition payload
   * @param {string} transition.provider - Provider identifier
   * @param {string} transition.previousState - Previous circuit breaker state
   * @param {string} transition.newState - New circuit breaker state
   * @param {number} [transition.failureCount=0] - Failure count at transition time
   * @param {string|null} [transition.agentId] - Optional agent identifier
   * @param {string|null} [transition.dispatchId] - Optional dispatch identifier for timeline correlation
   * @param {string} [transition.timestamp] - ISO timestamp (defaults to now)
   * @param {string} [transition.id] - Optional transition ID
   * @returns {{
   *   id: string,
   *   timestamp: string,
   *   provider: string,
   *   agentId: string|null,
   *   dispatchId: string|null,
   *   previousState: string,
   *   newState: string,
   *   failureCount: number,
   * }}
   */
  append(transition = {}) {
    const row = {
      id: transition.id || `cb-transition-${randomUUID()}`,
      timestamp: transition.timestamp || new Date().toISOString(),
      provider: transition.provider || null,
      agentId: transition.agentId ?? null,
      dispatchId: transition.dispatchId ?? null,
      previousState: transition.previousState || null,
      newState: transition.newState || null,
      failureCount: Number.isFinite(transition.failureCount) ? transition.failureCount : 0,
    };

    if (!row.provider || !row.previousState || !row.newState) {
      throw new TypeError('provider, previousState, and newState are required');
    }

    if (this._usingJsonlFallback) {
      this._jsonlTransitions.push(row);
      this._persistJsonl();
    } else {
      this._appendTxn(row);
    }

    return row;
  }

  /**
   * Query persisted transitions ordered by newest first.
   * @param {Object} [filters] - Query filters
   * @param {string} [filters.provider] - Optional provider filter
   * @param {string} [filters.agentId] - Optional agentId filter (null for provider-level)
   * @param {string} [filters.dispatchId] - Optional dispatchId filter
   * @param {string} [filters.since] - Inclusive ISO timestamp lower bound
   * @param {number} [filters.limit=100] - Max result count (capped at 500)
   * @param {number} [filters.offset=0] - Pagination offset
   * @returns {{ transitions: Array<Object>, total: number }}
   */
  query(filters = {}) {
    let transitions;

    if (this._usingJsonlFallback) {
      transitions = [...this._jsonlTransitions];
    } else {
      const whereClauses = [];
      const params = [];

      if (filters.provider) {
        whereClauses.push('provider = ?');
        params.push(filters.provider);
      }

      if (filters.agentId !== undefined && filters.agentId !== null) {
        whereClauses.push('agentId = ?');
        params.push(filters.agentId);
      } else if (filters.agentId === null) {
        whereClauses.push('agentId IS NULL');
      }

      if (filters.dispatchId) {
        whereClauses.push('dispatchId = ?');
        params.push(filters.dispatchId);
      }

      if (filters.since) {
        whereClauses.push('timestamp >= ?');
        params.push(filters.since);
      }

      const whereClause = whereClauses.length
        ? `WHERE ${whereClauses.join(' AND ')}`
        : '';

      const total = this.db
        .prepare(`SELECT COUNT(*) AS count FROM cb_transitions ${whereClause}`)
        .get(...params).count;

      const offset = filters.offset ?? 0;
      const limit = Math.min(filters.limit ?? 100, 500);

      const rows = this.db.prepare(`
        SELECT id, timestamp, provider, agentId, dispatchId, previousState, newState, failureCount
        FROM cb_transitions
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);

      return { transitions: rows, total };
    }

    // Apply filters to JSONL data
    const filtered = transitions.filter(t => {
      if (filters.provider && t.provider !== filters.provider) {
        return false;
      }
      if (filters.agentId !== undefined && t.agentId !== filters.agentId) {
        return false;
      }
      if (filters.dispatchId && t.dispatchId !== filters.dispatchId) {
        return false;
      }
      if (filters.since && new Date(t.timestamp) < new Date(filters.since)) {
        return false;
      }
      return true;
    });

    // Sort by timestamp descending
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply pagination
    const offset = filters.offset ?? 0;
    const limit = Math.min(filters.limit ?? 100, 500);
    const paginated = filtered.slice(offset, offset + limit);

    return {
      transitions: paginated,
      total: filtered.length,
    };
  }

  /**
   * Query transition rows normalized for timeline rendering.
   * @param {Object} [filters] - Query filters
   * @param {string} [filters.provider] - Optional provider filter
   * @param {string} [filters.agentId] - Optional agentId filter
   * @param {string} [filters.dispatchId] - Optional dispatchId correlation filter
   * @param {string} [filters.since] - Inclusive ISO timestamp lower bound
   * @param {number} [filters.limit=100] - Max result count (capped at 500)
   * @param {number} [filters.offset=0] - Pagination offset
   * @returns {{ events: Array<Object>, total: number }}
   */
  queryForTimeline(filters = {}) {
    const { transitions, total } = this.query(filters);
    const events = transitions.map((row) => {
      const provider = row.provider || 'unknown';
      const previousState = row.previousState || 'unknown';
      const newState = row.newState || 'unknown';
      return {
        id: row.id,
        type: 'circuit_breaker',
        timestamp: row.timestamp,
        summary: `${provider} transitioned ${previousState} → ${newState}`,
        correlationKeys: {
          dispatchId: row.dispatchId || null,
          agentId: row.agentId || null,
          provider: row.provider || null,
        },
        data: {
          id: row.id,
          timestamp: row.timestamp,
          provider: row.provider,
          agentId: row.agentId,
          dispatchId: row.dispatchId || null,
          previousState: row.previousState,
          newState: row.newState,
          failureCount: row.failureCount,
        },
      };
    });
    return { events, total };
  }

  close() {
    if (this._usingJsonlFallback) {
      // Persist any in-memory transitions to JSONL
      this._persistJsonl();
    } else if (this.db) {
      this.db.close();
    }
    this.db = null;
  }

  /**
   * Verify the store is healthy and queryable.
   * @returns {{ healthy: boolean, error?: string, transitionCount: number, usingJsonlFallback: boolean }}
   */
  healthCheck() {
    try {
      if (this._usingJsonlFallback) {
        return {
          healthy: true,
          transitionCount: this._jsonlTransitions.length,
          usingJsonlFallback: true,
          warning: 'Using JSONL fallback mode',
        };
      }

      if (!this.db) {
        return { healthy: false, error: 'Database connection not initialized', transitionCount: 0, usingJsonlFallback: false };
      }

      // Test a simple query to verify DB is queryable
      const result = this.query({ limit: 1 });
      
      return {
        healthy: true,
        transitionCount: result.total,
        usingJsonlFallback: false,
      };
    } catch (err) {
      return {
        healthy: false,
        error: err.message,
        transitionCount: 0,
        usingJsonlFallback: this._usingJsonlFallback,
      };
    }
  }

  /**
   * Check if the store is using JSONL fallback mode.
   * @returns {boolean}
   */
  isUsingJsonlFallback() {
    return this._usingJsonlFallback;
  }

  /**
   * Get the JSONL fallback path if using fallback mode.
   * @returns {string|null}
   */
  getJsonlPath() {
    return this._jsonlPath;
  }
}

export function createCbTransitionStore(options = {}) {
  const store = new CbTransitionStore(options);
  return {
    append: store.append.bind(store),
    query: store.query.bind(store),
    queryForTimeline: store.queryForTimeline.bind(store),
    close: store.close.bind(store),
    healthCheck: store.healthCheck.bind(store),
    isUsingJsonlFallback: store.isUsingJsonlFallback.bind(store),
    getJsonlPath: store.getJsonlPath.bind(store),
  };
}

export default CbTransitionStore;
