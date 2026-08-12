import Database from '../persistence/sqlite-provider.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('operator-action-store');

/**
 * OperatorActionStore — SQLite-backed store for guard-action idempotency.
 * Records actionId (idempotency key) -> persisted response metadata.
 * Correlates actions to dispatchId/traceId for lineage and reuse.
 */
export class OperatorActionStore {
  /**
   * @param {Object} options
   * @param {string} options.dbPath - Path to the SQLite database
   * @param {number} [options.ttlMs] - Time-to-live for idempotency records (default 24h)
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000;

    this._ensureParentDir();
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initTable();
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

  _initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operator_actions (
        action_id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        dispatch_id TEXT,
        trace_id TEXT,
        payload TEXT,
        response_status INTEGER,
        response_body TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_operator_actions_dispatch_id ON operator_actions(dispatch_id);
      CREATE INDEX IF NOT EXISTS idx_operator_actions_trace_id ON operator_actions(trace_id);
      CREATE INDEX IF NOT EXISTS idx_operator_actions_expires_at ON operator_actions(expires_at);
    `);
  }

  _prepareStatements() {
    this._insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO operator_actions (
        action_id, action_type, dispatch_id, trace_id, payload, response_status, response_body, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._selectStmt = this.db.prepare(`
      SELECT * FROM operator_actions WHERE action_id = ?
    `);

    this._cleanupStmt = this.db.prepare(`
      DELETE FROM operator_actions WHERE expires_at < ?
    `);
  }

  /**
   * Record a new operator action and its result.
   * @param {string} actionId - Idempotency key
   * @param {string} actionType - Type of action (replay, weight_override, etc.)
   * @param {Object} metadata
   * @param {string} [metadata.dispatchId]
   * @param {string} [metadata.traceId]
   * @param {Object} [metadata.payload] - Original request payload
   * @param {number} [metadata.responseStatus] - HTTP status code
   * @param {Object} [metadata.responseBody] - Result of the action
   * @returns {Object} The recorded record
   */
  record(actionId, actionType, { dispatchId, traceId, payload, responseStatus, responseBody } = {}) {
    if (!actionId) {
      throw new Error('actionId is required for recording an operator action');
    }

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    const normalizedStatus = responseStatus ?? 200;

    // A transient server failure is not a completed idempotent action. Caching
    // it would make every retry with this key replay the same 5xx for the full
    // TTL instead of giving the operation a chance to recover.
    if (normalizedStatus >= 500) {
      log.debug('Skipping idempotency record for transient server failure', {
        actionId,
        actionType,
        responseStatus: normalizedStatus,
      });
      return null;
    }

    try {
      const result = this._insertStmt.run(
        actionId,
        actionType,
        dispatchId || null,
        traceId || null,
        payload ? JSON.stringify(payload) : null,
        normalizedStatus,
        responseBody ? JSON.stringify(responseBody) : null,
        createdAt,
        expiresAt
      );

      // changes === 0 means the key already existed (INSERT OR IGNORE did nothing)
      if (result.changes === 0) {
        log.debug('Idempotency key already recorded, returning existing record', { actionId });
        return this.get(actionId);
      }

      return {
        actionId,
        actionType,
        dispatchId,
        traceId,
        payload,
        responseStatus: normalizedStatus,
        responseBody,
        createdAt,
        expiresAt
      };
    } catch (err) {
      log.error('Failed to record operator action', { actionId, error: err.message });
      throw err;
    }
  }

  /**
   * Retrieve a previously recorded operator action by its idempotency key.
   * If found but expired, it returns null.
   * @param {string} actionId
   * @returns {Object|null}
   */
  get(actionId) {
    if (!actionId) return null;

    try {
      const row = this._selectStmt.get(actionId);
      if (!row) return null;

      const now = new Date().toISOString();
      if (row.expires_at < now) {
        log.debug('Action record expired', { actionId, expiresAt: row.expires_at });
        return null;
      }

      return {
        actionId: row.action_id,
        actionType: row.action_type,
        dispatchId: row.dispatch_id,
        traceId: row.trace_id,
        payload: row.payload ? JSON.parse(row.payload) : null,
        responseStatus: row.response_status,
        responseBody: row.response_body ? JSON.parse(row.response_body) : null,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      };
    } catch (err) {
      log.error('Failed to retrieve operator action', { actionId, error: err.message });
      return null;
    }
  }

  /**
   * Clean up expired records.
   */
  cleanup() {
    const now = new Date().toISOString();
    try {
      const result = this._cleanupStmt.run(now);
      if (result.changes > 0) {
        log.info('Cleaned up expired operator actions', { count: result.changes });
      }
      return result.changes;
    } catch (err) {
      log.error('Failed to clean up operator actions', { error: err.message });
      return 0;
    }
  }

  /**
   * Close the database connection.
   */
  close() {
    try {
      this.db.close();
      log.info('Operator action store closed', { dbPath: this.dbPath });
    } catch (err) {
      log.error('Failed to close operator action store', { error: err.message });
    }
  }
}

/**
 * Factory function for creating an OperatorActionStore.
 * @param {Object} options
 * @returns {OperatorActionStore}
 */
export function createOperatorActionStore(options = {}) {
  return new OperatorActionStore(options);
}

export default OperatorActionStore;
