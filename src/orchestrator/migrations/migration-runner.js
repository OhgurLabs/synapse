/**
 * migration-runner.js — Versioned SQLite migration runner for the timeline event store.
 *
 * Applies SQL migration files from the migrations/ directory in version order.
 * Tracks applied migrations in a migration_versions table to ensure idempotency:
 * running the runner multiple times is safe and a no-op for already-applied versions.
 *
 * Usage:
 *   import { runMigrations, getMigrationStatus } from './migration-runner.js';
 *
 *   // Apply all pending migrations to an open better-sqlite3 db handle:
 *   const result = runMigrations(db);
 *   // => { applied: ['001', '002'], skipped: [], errors: [] }
 *
 *   // Or using a db path (opens and closes its own connection):
 *   const result = runMigrations(null, { dbPath: '/path/to/events.db' });
 */

import Database from '../../persistence/sqlite-provider.js';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { createLogger } from '../../logger.js';

const log = createLogger('migration-runner');

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Regex to match versioned SQL migration files like 001_some_name.sql */
const MIGRATION_FILE_RE = /^(\d{3})_[\w-]+\.sql$/;

/**
 * Discover all migration SQL files in the migrations directory, sorted by version.
 * Files with duplicate version prefixes are deduplicated (first one wins, alphabetically).
 *
 * @param {string} [dir] - Directory to scan (defaults to __dirname)
 * @returns {Array<{ version: string, filename: string, path: string }>}
 */
export function discoverMigrations(dir = __dirname) {
  let files;
  try {
    files = readdirSync(dir);
  } catch (err) {
    log.error('Failed to read migrations directory', { dir, error: err.message });
    throw err;
  }

  const seen = new Map();
  for (const f of files.sort()) {
    const match = MIGRATION_FILE_RE.exec(f);
    if (!match) continue;
    const version = match[1];
    if (!seen.has(version)) {
      seen.set(version, { version, filename: f, path: join(dir, f) });
    }
  }

  return [...seen.values()].sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Ensure the migration_versions tracking table exists.
 * @param {import('better-sqlite3').Database} db
 */
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_versions (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT,
      checksum    TEXT
    )
  `);
}

/**
 * Return the set of already-applied migration versions.
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>}
 */
function getAppliedVersions(db) {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT version FROM migration_versions').all();
  return new Set(rows.map(r => r.version));
}

/**
 * Apply a single SQL migration file to the database.
 * The SQL file is executed inside a transaction. If the file already inserts
 * into migration_versions (via INSERT OR IGNORE / INSERT OR REPLACE), that
 * is honoured. Otherwise the runner inserts the version record itself.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ version: string, filename: string, path: string }} migration
 */
function applyMigration(db, migration) {
  const sql = readFileSync(migration.path, 'utf-8');

  const runInTransaction = db.transaction(() => {
    db.exec(sql);

    // Ensure a row exists in migration_versions even if the SQL didn't insert one.
    db.prepare(`
      INSERT OR IGNORE INTO migration_versions (version, applied_at, description)
      VALUES (?, ?, ?)
    `).run(migration.version, new Date().toISOString(), migration.filename);
  });

  runInTransaction();
}

/**
 * Run all pending migrations against the provided database.
 *
 * @param {import('better-sqlite3').Database|null} db
 *   An open better-sqlite3 database handle. If null, a new connection is
 *   opened using options.dbPath and closed when done.
 * @param {object} [options]
 * @param {string} [options.dbPath]       - Path for a new db connection (used when db is null)
 * @param {string} [options.migrationsDir] - Override the directory to scan for SQL files
 * @returns {{ applied: string[], skipped: string[], errors: Array<{ version: string, error: string }> }}
 */
export function runMigrations(db = null, options = {}) {
  const ownConnection = db === null;
  let connection = db;

  if (ownConnection) {
    if (!options.dbPath) {
      throw new TypeError('Either a db handle or options.dbPath must be provided');
    }
    const dir = dirname(options.dbPath);
    mkdirSync(dir, { recursive: true });
    connection = new Database(options.dbPath);
    connection.pragma('journal_mode = WAL');
  }

  const migrationsDir = options.migrationsDir || __dirname;
  const migrations = discoverMigrations(migrationsDir);
  const appliedVersions = getAppliedVersions(connection);

  const result = { applied: [], skipped: [], errors: [] };

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      log.debug('Skipping already-applied migration', { version: migration.version });
      result.skipped.push(migration.version);
      continue;
    }

    try {
      log.info('Applying migration', { version: migration.version, file: migration.filename });
      applyMigration(connection, migration);
      result.applied.push(migration.version);
      log.info('Migration applied', { version: migration.version });
    } catch (err) {
      log.error('Migration failed', { version: migration.version, error: err.message });
      result.errors.push({ version: migration.version, error: err.message });
      // Stop on first error — do not apply subsequent migrations
      break;
    }
  }

  if (ownConnection) {
    connection.close();
  }

  return result;
}

/**
 * Return the current migration status without applying any changes.
 *
 * @param {import('better-sqlite3').Database|null} db
 * @param {object} [options]
 * @param {string} [options.dbPath]
 * @param {string} [options.migrationsDir]
 * @returns {{
 *   applied: string[],
 *   pending: string[],
 *   all: Array<{ version: string, filename: string, status: 'applied'|'pending' }>
 * }}
 */
export function getMigrationStatus(db = null, options = {}) {
  const ownConnection = db === null;
  let connection = db;

  if (ownConnection) {
    if (!options.dbPath) {
      throw new TypeError('Either a db handle or options.dbPath must be provided');
    }
    const dir = dirname(options.dbPath);
    mkdirSync(dir, { recursive: true });
    connection = new Database(options.dbPath);
  }

  try {
    const migrationsDir = options.migrationsDir || __dirname;
    const migrations = discoverMigrations(migrationsDir);
    const appliedVersions = getAppliedVersions(connection);

    const all = migrations.map(m => ({
      version: m.version,
      filename: m.filename,
      status: appliedVersions.has(m.version) ? 'applied' : 'pending',
    }));

    return {
      applied: all.filter(m => m.status === 'applied').map(m => m.version),
      pending: all.filter(m => m.status === 'pending').map(m => m.version),
      all,
    };
  } finally {
    if (ownConnection) {
      connection.close();
    }
  }
}

export default { runMigrations, getMigrationStatus, discoverMigrations };
