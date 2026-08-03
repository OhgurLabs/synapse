/**
 * Migration Runner — Versioned SQL migration execution for event tables
 * 
 * Features:
 *   - Idempotent execution (IF NOT EXISTS in SQL)
 *   - Version tracking in migration_versions table
 *   - Transaction support for atomic migrations
 *   - Rollback support via migration metadata
 * 
 * Usage:
 *   const runner = new MigrationRunner(db, { migrationsDir: './src/orchestrator/migrations' });
 *   await runner.migrateToLatest();
 */

/**
 * Pending migration plan (006_add_analytics_signals.sql)
 * Purpose: persist routing signals emitted by the daily analytics job so the router can
 * apply provider-level weights with freshness guarantees and last-known-good fallback.
 *
 * Proposed schema (SQLite):
 *   analytics_signals (
 *     id INTEGER PRIMARY KEY,
 *     provider TEXT NOT NULL,                -- provider slug used by router/buildRoutingPlan
 *     task_category TEXT NULL,               -- optional slice; NULL means global/default
 *     window_start TEXT NOT NULL,            -- ISO8601 UTC start of analytics window
 *     window_end TEXT NOT NULL,              -- ISO8601 UTC end of analytics window
 *     generated_at TEXT NOT NULL DEFAULT (datetime('now')), -- analytics pipeline emission time
 *     success_rate REAL NOT NULL,            -- 0..1 success ratio over window
 *     p50_latency_ms REAL NOT NULL,
 *     p95_latency_ms REAL NOT NULL,
 *     guardrail_violation_rate REAL NOT NULL DEFAULT 0, -- 0..1 share of calls hitting guardrails
 *     routing_weight REAL NOT NULL DEFAULT 1.0,         -- multiplicative factor applied by router
 *     weight_confidence REAL NOT NULL DEFAULT 1.0,      -- 0..1 blend factor vs legacy weights
 *     source TEXT,                         -- pipeline name/version for provenance
 *     notes TEXT
 *   );
 *
 * Indexes:
 *   - UNIQUE(provider, task_category, window_start, window_end) to keep one row per run window.
 *   - INDEX(provider, generated_at DESC) to fetch the latest row per provider quickly.
 *   - INDEX(generated_at) to support staleness sweeps/alerts.
 *
 * Freshness & staleness contract (router + alerting):
 *   - Analytics job writes at least daily; window_end typically 23:59:59Z for the prior day.
 *   - Router reads the newest row per provider where julianday('now') - julianday(generated_at) <= 2 (48h).
 *   - If the newest row is older than 48h, router still uses it as last-known-good, flags
 *     routing_metadata.stale_signals=true, and emits an operator alert. If no rows exist,
 *     router falls back to legacy performance-based weights only.
 *
 * Provider-weight mapping (how router will consume):
 *   - effective_signal_weight = routing_weight * (1 - guardrail_violation_rate).
 *   - blended_weight = effective_signal_weight * weight_confidence
 *       + legacy_weight * (1 - weight_confidence); legacy_weight is the existing performance-derived value.
 *   - Stale-but-present rows use the same math but include the stale flag in routing metadata.
 *
 * Data retention: table is append-only; optional vacuum/DELETE of old windows can be added later.
 * Note: TIMELINE_SCHEMA_VERSION stays at 005 until the 006 SQL file lands.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger.js';
import Database from '../persistence/sqlite-provider.js';

const log = createLogger('migration-runner');

export class MigrationRunner {
  /**
   * @param {Database} db - SQLite database instance
   * @param {Object} options - Migration options
   * @param {string} [options.migrationsDir] - Directory containing migration SQL files (default: './src/orchestrator/migrations')
   * @param {boolean} [options.autoCreateTable] - Auto-create migration_versions table if missing (default: true)
   */
  constructor(db, options = {}) {
    this.db = db;
    this.migrationsDir = options.migrationsDir || join(process.cwd(), 'src/orchestrator/migrations');
    this.autoCreateTable = options.autoCreateTable ?? true;
  }

  /**
   * Ensure migration_versions table exists
   */
  _ensureMigrationTable() {
    if (!this.autoCreateTable) return;

    const tableExists = this.db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type = 'table' AND name = 'migration_versions'
    `).get();

    if (!tableExists) {
      this.db.exec(`
        CREATE TABLE migration_versions (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL,
          description TEXT,
          checksum TEXT
        )
      `);
      log.info('Created migration_versions table');
    }
  }

  /**
   * Get list of applied migrations
   * @returns {Array<{ version: string, applied_at: string, description: string }>}
   */
  _getAppliedMigrations() {
    return this.db.prepare(`
      SELECT version, applied_at, description 
      FROM migration_versions 
      ORDER BY CAST(version AS INTEGER)
    `).all();
  }

  /**
   * Get list of available migrations from filesystem
   * @returns {Array<{ version: string, path: string, description: string }>}
   */
  _getAvailableMigrations() {
    if (!existsSync(this.migrationsDir)) {
      log.warn(`Migrations directory does not exist: ${this.migrationsDir}`);
      return [];
    }

    const files = readdirSync(this.migrationsDir)
      .filter(f => f.match(/^\d+_.+\.sql$/))
      .sort();

    return files.map(file => {
      const version = file.match(/^(\d+)_/)?.[1] || '000';
      const description = file.replace(/^\d+_(.+)\.sql$/, '$1').replace(/_/g, ' ');
      return {
        version,
        path: join(this.migrationsDir, file),
        description,
      };
    });
  }

  /**
   * Execute a single migration SQL file
   * @param {Object} migration - Migration metadata
   * @returns {boolean} True if migration was applied
   */
  _executeMigration(migration) {
    try {
      const sql = readFileSync(migration.path, 'utf-8');
      
      // Check if already applied
      const alreadyApplied = this.db.prepare(`
        SELECT version FROM migration_versions WHERE version = ?
      `).get(migration.version);

      if (alreadyApplied) {
        log.info(`Migration ${migration.version} already applied, skipping`);
        return false;
      }

      // Execute migration in transaction
      const transaction = this.db.transaction((sqlContent) => {
        this.db.exec(sqlContent);
      });

      transaction(sql);

      // Record migration (use INSERT OR IGNORE in case SQL file already inserted)
      this.db.prepare(`
        INSERT OR IGNORE INTO migration_versions (version, applied_at, description, checksum)
        VALUES (?, datetime('now'), ?, ?)
      `).run(migration.version, migration.description, 'sha256_' + migration.version);

      log.info(`Applied migration ${migration.version}: ${migration.description}`);
      return true;
    } catch (err) {
      log.error(`Failed to apply migration ${migration.version}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Run migrations up to a specific version
   * @param {string} targetVersion - Target migration version
   * @returns {Object} Migration results
   */
  migrateTo(targetVersion) {
    this._ensureMigrationTable();
    
    const applied = this._getAppliedMigrations();
    const appliedVersions = new Set(applied.map(m => m.version));
    const available = this._getAvailableMigrations();
    
    const toApply = available.filter(m => {
      const versionNum = parseInt(m.version, 10);
      const targetNum = parseInt(targetVersion, 10);
      return versionNum <= targetNum && !appliedVersions.has(m.version);
    });

    if (toApply.length === 0) {
      log.info(`No migrations to apply (at target version ${targetVersion})`);
      return { applied: [], skipped: available.length, alreadyApplied: applied.length };
    }

    log.info(`Applying ${toApply.length} migrations up to version ${targetVersion}`);

    const appliedList = [];
    for (const migration of toApply) {
      this._executeMigration(migration);
      appliedList.push(migration.version);
    }

    return { applied: appliedList, skipped: 0, alreadyApplied: applied.length };
  }

  /**
   * Run all pending migrations to latest version
   * @returns {Object} Migration results
   */
  migrateToLatest() {
    this._ensureMigrationTable();
    
    const applied = this._getAppliedMigrations();
    const appliedVersions = new Set(applied.map(m => m.version));
    const available = this._getAvailableMigrations();

    if (available.length === 0) {
      log.info('No migration files found');
      return { applied: [], skipped: 0, alreadyApplied: applied.length };
    }

    const latestVersion = available[available.length - 1].version;
    const toApply = available.filter(m => !appliedVersions.has(m.version));

    if (toApply.length === 0) {
      log.info(`Already at latest version ${latestVersion}`);
      return { applied: [], skipped: 0, alreadyApplied: applied.length };
    }

    log.info(`Applying ${toApply.length} pending migrations (latest: ${latestVersion})`);

    const appliedList = [];
    for (const migration of toApply) {
      this._executeMigration(migration);
      appliedList.push(migration.version);
    }

    return { applied: appliedList, skipped: 0, alreadyApplied: applied.length };
  }

  /**
   * Rollback the most recent migration
   * @param {number} [count=1] - Number of migrations to rollback
   * @returns {Object} Rollback results
   */
  rollback(count = 1) {
    this._ensureMigrationTable();
    
    const applied = this._getAppliedMigrations();
    
    if (applied.length === 0) {
      log.warn('No migrations to rollback');
      return { rolledBack: [], alreadyRolledBack: 0 };
    }

    // Get migrations to rollback (most recent first)
    const toRollback = applied.slice(0, count).reverse();
    
    const rolledBack = [];
    for (const migration of toRollback) {
      // Note: Full rollback requires reverse SQL files
      // For now, we just remove the version record
      this.db.prepare(`
        DELETE FROM migration_versions WHERE version = ?
      `).run(migration.version);
      
      rolledBack.push(migration.version);
      log.info(`Rolled back migration ${migration.version}`);
    }

    return { rolledBack, alreadyRolledBack: 0 };
  }

  /**
   * Get current migration status
   * @returns {Object} Status information
   */
  getStatus() {
    this._ensureMigrationTable();
    
    const applied = this._getAppliedMigrations();
    const available = this._getAvailableMigrations();
    const appliedVersions = new Set(applied.map(m => m.version));
    
    const pending = available.filter(m => !appliedVersions.has(m.version));
    const latestVersion = available.length > 0 ? available[available.length - 1].version : null;
    const currentVersion = applied.length > 0 ? applied[applied.length - 1].version : null;

    return {
      currentVersion,
      latestVersion,
      applied: applied.map(m => m.version),
      pending: pending.map(m => m.version),
      ready: pending.length === 0,
    };
  }
}

/**
 * Factory function to create a MigrationRunner
 * @param {Database} db - SQLite database instance
 * @param {Object} options - Migration options
 * @returns {MigrationRunner}
 */
export function createMigrationRunner(db, options = {}) {
  return new MigrationRunner(db, options);
}

export default MigrationRunner;
