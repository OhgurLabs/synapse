/**
 * persistence/sqlite-provider.js
 *
 * Single seam for this codebase's SQLite dependency. Every production module
 * that needs the persistence engine imports from here rather than directly
 * from better-sqlite3. That gives us ONE place to swap if the persistence
 * backend ever changes (a different SQLite distribution, a Postgres adapter,
 * an in-memory test double, a distributed-SQLite layer like LiteFS or Turso).
 *
 * Today this module is a thin wrapper:
 *   - `Database` is re-exported unchanged, so existing `new Database(path)`
 *     call sites continue to work without modification.
 *   - `openDatabase(path, opts)` is a small factory that applies the project's
 *     standard configuration (WAL journal for writers, busy_timeout) so each
 *     call site doesn't have to remember.
 *   - `PERSISTENCE_BACKEND` is a constant identifying the backend in use.
 *     Inspectable from diagnostics endpoints and useful as a future feature
 *     flag.
 *
 * Test files intentionally do NOT route through this module. Tests inspect
 * raw sqlite state to verify migrations, schema layout, page invariants —
 * coupling them to the engine is the point. Any cross-backend swap will
 * require those tests to be reconsidered alongside the swap.
 *
 * NEW CODE should prefer `openDatabase()` over constructing `new Database()`
 * directly, so this module remains the only place that touches the engine
 * constructor.
 */

import Database from 'better-sqlite3';

export { Database };

/**
 * Open a SQLite database with this project's standard configuration.
 *
 * @param {string} dbPath - filesystem path to the .sqlite file (will be created
 *   if it does not exist, unless `readonly` is true).
 * @param {Object} [options]
 * @param {boolean} [options.readonly=false] - open read-only.
 * @param {number} [options.timeout=5000] - busy timeout in ms when another
 *   writer holds the lock.
 * @param {boolean} [options.wal=true] - enable WAL journal mode for writers.
 *   Ignored when `readonly` is true. WAL is the right default for the
 *   orchestrator's mostly-single-writer workload.
 * @param {Function} [options.verbose] - optional statement logger.
 * @returns better-sqlite3 Database instance.
 */
export function openDatabase(dbPath, options = {}) {
  const { readonly = false, timeout = 5000, wal = true, verbose } = options;
  const db = new Database(dbPath, { readonly, timeout, verbose });
  if (!readonly && wal) {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

/**
 * Identifier of the persistence backend currently in use. Used by health
 * checks and diagnostics; future backends should set this to their own
 * identifier (e.g. 'postgres', 'litefs').
 */
export const PERSISTENCE_BACKEND = 'sqlite';

export default Database;
