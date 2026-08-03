import Database from '../../persistence/sqlite-provider.js';
import { mkdirSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../logger.js';

const log = createLogger('timeline-migrations');

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

const MIGRATION_FILE_RE = /^(\d{3,})_([\w-]+)\.(up|down)\.sql$/;

export function ensureSchemaMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function normalizeMigrationFiles(files, migrationsDir) {
  const byVersion = new Map();

  for (const filename of files) {
    const match = MIGRATION_FILE_RE.exec(filename);
    if (!match) {
      continue;
    }

    const [, version, name, direction] = match;
    const row = byVersion.get(version) || { version, name, upPath: null, downPath: null };
    if (!row.name) {
      row.name = name;
    }

    if (direction === 'up') {
      row.upPath = join(migrationsDir, filename);
    }
    if (direction === 'down') {
      row.downPath = join(migrationsDir, filename);
    }

    byVersion.set(version, row);
  }

  return [...byVersion.values()].sort((a, b) => a.version.localeCompare(b.version));
}

export function discoverMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  let files = [];
  try {
    files = readdirSync(migrationsDir).sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const migrations = normalizeMigrationFiles(files, migrationsDir);

  for (const migration of migrations) {
    if (!migration.upPath) {
      throw new Error(`Missing up migration for version ${migration.version}`);
    }
  }

  return migrations;
}

export function getAppliedMigrations(db) {
  ensureSchemaMigrationsTable(db);
  return db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .all();
}

function openDb(dbPath) {
  if (!dbPath) {
    throw new TypeError('dbPath is required when db handle is not provided');
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function applyUpMigration(db, migration) {
  const sql = readFileSync(migration.upPath, 'utf8');
  const now = new Date().toISOString();
  const isTransactionManaged = /\bBEGIN(?:\s+TRANSACTION)?\b/i.test(sql);

  if (isTransactionManaged) {
    db.exec(sql);
    db.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, now);
    return;
  }

  db.transaction(() => {
    db.exec(sql);
    db.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, now);
  })();
}

function applyDownMigration(db, migration) {
  if (!migration.downPath) {
    throw new Error(`Missing down migration for version ${migration.version}`);
  }

  const sql = readFileSync(migration.downPath, 'utf8');
  const isTransactionManaged = /\bBEGIN(?:\s+TRANSACTION)?\b/i.test(sql);

  if (isTransactionManaged) {
    db.exec(sql);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(migration.version);
    return;
  }

  db.transaction(() => {
    db.exec(sql);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(migration.version);
  })();
}

function resolveTargetVersion(version) {
  if (version == null) {
    return null;
  }

  const normalized = String(version).trim();
  if (!/^\d{3,}$/.test(normalized)) {
    throw new TypeError(`Invalid migration version: ${version}`);
  }
  return normalized;
}

function listUpCandidates(migrations, appliedSet, toVersion = null) {
  return migrations.filter((migration) => {
    if (appliedSet.has(migration.version)) {
      return false;
    }
    if (!toVersion) {
      return true;
    }
    return migration.version <= toVersion;
  });
}

function listDownCandidates(migrations, appliedSet, { toVersion = null, steps = 1 } = {}) {
  const applied = migrations.filter(m => appliedSet.has(m.version));
  if (!toVersion) {
    return applied.slice(-steps).reverse();
  }

  return applied
    .filter(m => m.version > toVersion)
    .sort((a, b) => b.version.localeCompare(a.version));
}

export function migrateUp(db = null, options = {}) {
  const ownDb = db == null;
  const connection = ownDb ? openDb(options.dbPath) : db;

  try {
    const migrationsDir = options.migrationsDir
      ? resolve(options.migrationsDir)
      : DEFAULT_MIGRATIONS_DIR;
    const migrations = discoverMigrations(migrationsDir);
    ensureSchemaMigrationsTable(connection);

    const applied = getAppliedMigrations(connection);
    const appliedSet = new Set(applied.map(row => row.version));
    const toVersion = resolveTargetVersion(options.toVersion);
    const candidates = listUpCandidates(migrations, appliedSet, toVersion);

    const result = {
      direction: 'up',
      applied: [],
      skipped: migrations.length - candidates.length,
    };

    for (const migration of candidates) {
      log.info('Applying migration', { version: migration.version, name: migration.name, direction: 'up' });
      applyUpMigration(connection, migration);
      result.applied.push(migration.version);
    }

    return result;
  } finally {
    if (ownDb) {
      connection.close();
    }
  }
}

export function migrateDown(db = null, options = {}) {
  const ownDb = db == null;
  const connection = ownDb ? openDb(options.dbPath) : db;

  try {
    const migrationsDir = options.migrationsDir
      ? resolve(options.migrationsDir)
      : DEFAULT_MIGRATIONS_DIR;
    const migrations = discoverMigrations(migrationsDir);
    ensureSchemaMigrationsTable(connection);

    const applied = getAppliedMigrations(connection);
    const appliedSet = new Set(applied.map(row => row.version));
    const toVersion = resolveTargetVersion(options.toVersion);
    const steps = Number.isInteger(options.steps) ? options.steps : Number.parseInt(options.steps || '1', 10);
    if (!toVersion && (!Number.isInteger(steps) || steps < 1)) {
      throw new TypeError('steps must be an integer >= 1 when toVersion is not provided');
    }

    const candidates = listDownCandidates(migrations, appliedSet, { toVersion, steps });
    const result = {
      direction: 'down',
      rolledBack: [],
      skipped: applied.length - candidates.length,
    };

    for (const migration of candidates) {
      log.info('Rolling back migration', { version: migration.version, name: migration.name, direction: 'down' });
      applyDownMigration(connection, migration);
      result.rolledBack.push(migration.version);
    }

    return result;
  } finally {
    if (ownDb) {
      connection.close();
    }
  }
}

export function getMigrationStatus(db = null, options = {}) {
  const ownDb = db == null;
  const connection = ownDb ? openDb(options.dbPath) : db;

  try {
    const migrationsDir = options.migrationsDir
      ? resolve(options.migrationsDir)
      : DEFAULT_MIGRATIONS_DIR;
    const migrations = discoverMigrations(migrationsDir);
    const applied = getAppliedMigrations(connection);
    const appliedSet = new Set(applied.map(row => row.version));

    const all = migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      hasDown: Boolean(migration.downPath),
      status: appliedSet.has(migration.version) ? 'applied' : 'pending',
    }));

    return {
      applied: all.filter(row => row.status === 'applied').map(row => row.version),
      pending: all.filter(row => row.status === 'pending').map(row => row.version),
      all,
    };
  } finally {
    if (ownDb) {
      connection.close();
    }
  }
}

export function runMigrations(db = null, options = {}) {
  const direction = options.direction || 'up';
  if (direction === 'up') {
    return migrateUp(db, options);
  }
  if (direction === 'down') {
    return migrateDown(db, options);
  }
  throw new TypeError(`Unsupported migration direction: ${direction}`);
}

export default {
  DEFAULT_MIGRATIONS_DIR,
  discoverMigrations,
  ensureSchemaMigrationsTable,
  getAppliedMigrations,
  getMigrationStatus,
  migrateDown,
  migrateUp,
  runMigrations,
};
