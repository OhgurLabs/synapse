import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';
import { createDatabaseWithRecovery } from './db-recovery.js';

const log = createLogger('shared-state-store');

/**
 * VersionConflictError — thrown when an optimistic locking check fails.
 *
 * The caller supplied an expectedVersion that does not match the current
 * version stored in the database, indicating a concurrent write occurred.
 */
export class VersionConflictError extends Error {
  constructor(key, expectedVersion, actualVersion) {
    super(
      `Version conflict on key "${key}": expected ${expectedVersion}, actual ${actualVersion}`
    );
    this.name = 'VersionConflictError';
    this.key = key;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * SharedStateStore — SQLite persistence layer for cross-agent shared state.
 *
 * Schema: shared_state table
 * ──────────────────────────────────────────────────────────────────────
 *  Column      Type              Notes
 *  ──────────  ────────────────  ─────────────────────────────────────
 *  key         TEXT PRIMARY KEY  Unique state identifier
 *  value       TEXT NOT NULL     JSON-serialised payload
 *  version     INTEGER NOT NULL  Monotonically increasing; starts at 1
 *  created_at  TEXT NOT NULL     ISO-8601 timestamp of first insert
 *  updated_at  TEXT NOT NULL     ISO-8601 timestamp of last mutation
 *  agent_id    TEXT NOT NULL     Agent that performed the last write
 *  metadata    TEXT NOT NULL     JSON object for arbitrary annotations
 *                                (DEFAULT '{}')
 * ──────────────────────────────────────────────────────────────────────
 *
 * Versioning strategy — optimistic locking with version increment:
 *
 *   1. Every key starts at version 1 on first insert.
 *   2. Every successful update increments the version by exactly 1.
 *   3. Callers MAY supply an `expectedVersion` on set/delete.
 *      - If supplied and it does not match the current stored version,
 *        a VersionConflictError is thrown and no write occurs.
 *      - If omitted the write proceeds unconditionally (last-write-wins).
 *   4. Reads always return the current version alongside the value so
 *      callers can perform compare-and-swap cycles.
 *
 * Crash recovery: WAL journal mode + FULL synchronous ensures committed
 * writes survive process crashes.  Uncommitted transactions are rolled
 * back automatically by SQLite on next open.
 */
export class SharedStateStore {
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
    this._initTables();
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

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_state (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL DEFAULT '{}',
        version     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_shared_state_agent
        ON shared_state(agent_id);

      CREATE INDEX IF NOT EXISTS idx_shared_state_updated
        ON shared_state(updated_at);

      CREATE TABLE IF NOT EXISTS pub_sub_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pub_sub_channel_sequence
        ON pub_sub_messages(channel, sequence);

      CREATE INDEX IF NOT EXISTS idx_pub_sub_channel_created_at
        ON pub_sub_messages(channel, created_at);
    `);

    // Clean databases get a second line of defence against duplicate channel
    // sequences. Legacy databases may already contain duplicates; do not make
    // startup fail in that case. The IMMEDIATE publish transaction below still
    // prevents any new duplicate allocation across processes.
    try {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pub_sub_channel_sequence_unique
          ON pub_sub_messages(channel, sequence)
      `);
    } catch (err) {
      log.warn({ err: err.message }, 'Legacy duplicate pub/sub sequences prevent unique index creation');
    }
  }

  _prepareStatements() {
    this._stmtGet = this.db.prepare(
      'SELECT key, value, version, created_at, updated_at, agent_id, metadata FROM shared_state WHERE key = ?'
    );

    this._stmtInsert = this.db.prepare(`
      INSERT INTO shared_state (key, value, version, created_at, updated_at, agent_id, metadata)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `);

    this._stmtUpdate = this.db.prepare(`
      UPDATE shared_state
         SET value = ?, version = version + 1, updated_at = ?, agent_id = ?, metadata = ?
       WHERE key = ?
    `);

    this._stmtUpdateWithVersion = this.db.prepare(`
      UPDATE shared_state
         SET value = ?, version = version + 1, updated_at = ?, agent_id = ?, metadata = ?
       WHERE key = ? AND version = ?
    `);

    this._stmtDelete = this.db.prepare(
      'DELETE FROM shared_state WHERE key = ?'
    );

    this._stmtDeleteWithVersion = this.db.prepare(
      'DELETE FROM shared_state WHERE key = ? AND version = ?'
    );

    this._stmtListKeys = this.db.prepare(
      'SELECT key FROM shared_state ORDER BY key'
    );

    this._stmtListAll = this.db.prepare(
      'SELECT key, value, version, created_at, updated_at, agent_id, metadata FROM shared_state ORDER BY key'
    );

    // Pub/Sub channel statements
    this._stmtGetNextSequence = this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) as maxSeq
      FROM pub_sub_messages
      WHERE channel = ?
    `);

    this._stmtInsertPubSub = this.db.prepare(`
      INSERT INTO pub_sub_messages (channel, sender_id, payload, sequence, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this._publishToChannelTxn = this.db.transaction((channelName, senderId, payload, timestamp) => {
      const currentSeq = this._stmtGetNextSequence.get(channelName);
      const newSeq = currentSeq.maxSeq + 1;
      this._stmtInsertPubSub.run(
        channelName,
        senderId,
        JSON.stringify(payload),
        newSeq,
        timestamp
      );
      return newSeq;
    });

    this._stmtPollPubSub = this.db.prepare(`
      SELECT id, channel, sender_id as senderId, payload, sequence, created_at
      FROM pub_sub_messages
      WHERE channel = ? AND sequence > ?
      ORDER BY sequence ASC
    `);

    this._stmtGetRecentPubSub = this.db.prepare(`
      SELECT id, channel, sender_id as senderId, payload, sequence, created_at
      FROM pub_sub_messages
      WHERE channel = ?
      ORDER BY sequence DESC
      LIMIT ?
    `);

    this._stmtCountRecentPubSub = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM pub_sub_messages
      WHERE channel = ? AND created_at >= ?
    `);
  }

  // ── helpers ──────────────────────────────────────────────────────

  _now() {
    return new Date().toISOString();
  }

  _parseRow(row) {
    if (!row) return null;
    return {
      key: row.key,
      value: JSON.parse(row.value),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agentId: row.agent_id,
      metadata: JSON.parse(row.metadata),
    };
  }

  // ── public API ───────────────────────────────────────────────────

  /**
   * Retrieve a state entry by key.
   * @param {string} key
   * @returns {{ key, value, version, createdAt, updatedAt, agentId, metadata } | null}
   */
  get(key) {
    return this._parseRow(this._stmtGet.get(key));
  }

  /**
   * Create or update a state entry.
   *
   * @param {string}  key
   * @param {*}       value           - Any JSON-serialisable value
   * @param {string}  agentId         - Agent performing the write
   * @param {Object}  [opts]
   * @param {number}  [opts.expectedVersion] - If set, enables optimistic lock
   * @param {Object}  [opts.metadata]        - Arbitrary annotation object
   * @returns {number} The new version number after the write
   * @throws {VersionConflictError} if expectedVersion doesn't match
   */
  set(key, value, agentId, opts = {}) {
    const { expectedVersion, metadata } = opts;
    const now = this._now();
    const serialValue = JSON.stringify(value);
    const serialMeta = JSON.stringify(metadata ?? {});

    const existing = this._stmtGet.get(key);

    if (!existing) {
      // First write — insert.  If caller expected a specific version on a
      // non-existent key, that's a conflict (there is no prior version).
      if (expectedVersion !== undefined) {
        throw new VersionConflictError(key, expectedVersion, null);
      }
      this._stmtInsert.run(key, serialValue, now, now, agentId, serialMeta);
      log.info({ key, agentId, version: 1 }, 'shared state created');
      return 1;
    }

    // Existing key — optionally enforce version.
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new VersionConflictError(key, expectedVersion, existing.version);
    }

    if (expectedVersion !== undefined) {
      const result = this._stmtUpdateWithVersion.run(
        serialValue, now, agentId, serialMeta, key, expectedVersion
      );
      if (result.changes === 0) {
        // Race: version changed between our SELECT and UPDATE.
        const fresh = this._stmtGet.get(key);
        throw new VersionConflictError(key, expectedVersion, fresh?.version ?? null);
      }
    } else {
      this._stmtUpdate.run(serialValue, now, agentId, serialMeta, key);
    }

    const newVersion = existing.version + 1;
    log.info({ key, agentId, version: newVersion }, 'shared state updated');
    return newVersion;
  }

  /**
   * Delete a state entry.
   *
   * @param {string}  key
   * @param {string}  agentId         - Agent performing the delete
   * @param {Object}  [opts]
   * @param {number}  [opts.expectedVersion] - If set, enables optimistic lock
   * @returns {boolean} true if a row was deleted
   * @throws {VersionConflictError} if expectedVersion doesn't match
   */
  delete(key, agentId, opts = {}) {
    const { expectedVersion } = opts;

    if (expectedVersion !== undefined) {
      const existing = this._stmtGet.get(key);
      if (!existing) return false;
      if (existing.version !== expectedVersion) {
        throw new VersionConflictError(key, expectedVersion, existing.version);
      }
      const result = this._stmtDeleteWithVersion.run(key, expectedVersion);
      if (result.changes === 0) {
        const fresh = this._stmtGet.get(key);
        throw new VersionConflictError(key, expectedVersion, fresh?.version ?? null);
      }
      log.info({ key, agentId, version: expectedVersion }, 'shared state deleted');
      return true;
    }

    const result = this._stmtDelete.run(key);
    if (result.changes > 0) {
      log.info({ key, agentId }, 'shared state deleted');
      return true;
    }
    return false;
  }

  /**
   * List all keys in the store.
   * @returns {string[]}
   */
  listKeys() {
    return this._stmtListKeys.all().map(r => r.key);
  }

  /**
   * List all entries.
   * @returns {Array<{ key, value, version, createdAt, updatedAt, agentId, metadata }>}
   */
  listAll() {
    return this._stmtListAll.all().map(r => this._parseRow(r));
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
   * Publish a message to a pub/sub channel.
   *
   * @param {string} channelName - The channel to publish to
   * @param {string} senderId - The agent ID publishing the message
   * @param {*} payload - The message payload (will be JSON serialized)
   * @returns {number} The sequence number of the published message
   */
  publishToChannel(channelName, senderId, payload) {
    const timestamp = this._now();
    // IMMEDIATE obtains the SQLite write lock before reading MAX(sequence), so
    // independent Synapse processes cannot allocate the same channel sequence.
    const newSeq = this._publishToChannelTxn.immediate(channelName, senderId, payload, timestamp);

    log.info(
      { channelName, senderId, sequence: newSeq },
      'pub/sub message published'
    );

    return newSeq;
  }

  /**
   * Poll for messages on a channel after a given sequence number.
   *
   * @param {string} channelName - The channel name
   * @param {number} afterSeq - Return messages with sequence > this value (default: 0)
   * @returns {Array<{id, channel, senderId, payload, sequence, createdAt}>} Array of messages
   */
  pollChannel(channelName, afterSeq = 0) {
    const messages = this._stmtPollPubSub.all(channelName, afterSeq);

    return messages.map(msg => ({
      id: msg.id,
      channel: msg.channel,
      senderId: msg.senderId,
      payload: JSON.parse(msg.payload),
      sequence: msg.sequence,
      createdAt: msg.created_at
    }));
  }

  /**
   * Get the count of messages in a channel since a given timestamp.
   *
   * @param {string} channelName - The channel name
   * @param {string} sinceISO - ISO timestamp to count from (inclusive)
   * @returns {number} Count of messages
   */
  getMessageCountSince(channelName, sinceISO) {
    const result = this._stmtCountRecentPubSub.get(channelName, sinceISO);
    return result ? result.count : 0;
  }

  /**
   * Get the N most recent messages from a channel.

   *
   * @param {string} channelName - The channel name
   * @param {number} limit - The maximum number of recent messages to retrieve
   * @returns {Array<{id, channel, senderId, payload, sequence, createdAt}>} Array of messages
   */
  getRecentChannelMessages(channelName, limit) {
    const messages = this._stmtGetRecentPubSub.all(channelName, limit);

    return messages.map(msg => ({
      id: msg.id,
      channel: msg.channel,
      senderId: msg.senderId,
      payload: JSON.parse(msg.payload),
      sequence: msg.sequence,
      createdAt: msg.created_at
    }));
  }

  /**
   * Close the database connection.
   */
  close() {
    this.db.close();
  }
}
