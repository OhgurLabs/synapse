/**
 * Database recovery utilities for SQLite graceful degradation.
 *
 * Provides integrity checking, WAL checkpoint recovery, and fallback
 * strategies when database corruption is detected.
 *
 * @module orchestrator/db-recovery
 */

import Database from '../persistence/sqlite-provider.js';
import { renameSync, existsSync } from 'fs';
import { createLogger } from '../logger.js';
import { DatabaseCorruptionError } from './corruption-errors.js';

const log = createLogger('db-recovery');

/**
 * Check if a database is corrupt by running PRAGMA integrity_check.
 *
 * @param {Database} db - better-sqlite3 database instance
 * @returns {{ isCorrupt: boolean, errors: string[] }}
 */
function checkDatabaseIntegrity(db) {
  try {
    const result = db.pragma('integrity_check', { simple: true });
    // integrity_check returns array of error messages, or ['ok'] if healthy
    if (Array.isArray(result)) {
      const isOk = result.length === 1 && result[0] === 'ok';
      return {
        isCorrupt: !isOk,
        errors: isOk ? [] : result,
      };
    }
    // Single row result
    if (result === 'ok') {
      return { isCorrupt: false, errors: [] };
    }
    return { isCorrupt: true, errors: [String(result)] };
  } catch (err) {
    log.error({ err }, 'Failed to run integrity_check');
    return { isCorrupt: true, errors: [err.message] };
  }
}

/**
 * Attempt WAL checkpoint recovery to salvage a corrupt database.
 *
 * @param {Database} db - better-sqlite3 database instance
 * @returns {boolean} true if recovery succeeded
 */
function attemptWalRecovery(db) {
  try {
    log.info('Attempting WAL checkpoint recovery');
    db.pragma('wal_checkpoint(TRUNCATE)');

    // Check if recovery worked
    const { isCorrupt } = checkDatabaseIntegrity(db);
    if (!isCorrupt) {
      log.info('WAL checkpoint recovery succeeded');
      return true;
    }

    log.warn('WAL checkpoint recovery did not fix corruption');
    return false;
  } catch (err) {
    log.error({ err }, 'WAL checkpoint recovery failed');
    return false;
  }
}

/**
 * Create a SQLite database with automatic corruption detection and recovery.
 *
 * This function wraps the Database constructor with:
 * 1. Integrity checking on open
 * 2. WAL checkpoint recovery if corruption detected
 * 3. Fallback to empty state (new database) if recovery fails
 * 4. Comprehensive error logging and event emission
 *
 * @param {string} dbPath - Path to SQLite database file
 * @param {Object} [options] - Options
 * @param {boolean} [options.readonly] - Open in readonly mode (passed to Database constructor)
 * @param {EventEmitter} [options.emitter] - EventEmitter to emit corruption events
 * @param {boolean} [options.enableRecovery=true] - Enable automatic recovery (disable for testing)
 * @returns {Database} better-sqlite3 database instance
 * @throws {DatabaseCorruptionError} if corruption detected and recovery disabled
 */
export function createDatabaseWithRecovery(dbPath, options = {}) {
  const { readonly = false, emitter = null, enableRecovery = true } = options;

  let db;
  let corruptionDetected = false;
  let recoveryAttempted = false;
  let recoverySucceeded = false;

  try {
    // Attempt to open the database
    db = new Database(dbPath, { readonly });

    // Run integrity check on successful open
    const { isCorrupt, errors } = checkDatabaseIntegrity(db);

    if (isCorrupt) {
      corruptionDetected = true;
      const errorMsg = `Database corruption detected at ${dbPath}: ${errors.join(', ')}`;
      log.error({ dbPath, errors }, errorMsg);

      // Emit corruption event if emitter provided
      if (emitter) {
        emitter.emit('database:corruption-detected', {
          dbPath,
          corruptionType: 'integrity_check_failed',
          errors,
          timestamp: new Date().toISOString(),
        });
      }

      if (!enableRecovery) {
        db.close();
        throw new DatabaseCorruptionError(
          errorMsg,
          'integrity_check_failed',
          null,
          { dbPath, errors }
        );
      }

      // Attempt WAL checkpoint recovery
      recoveryAttempted = true;
      recoverySucceeded = attemptWalRecovery(db);

      if (!recoverySucceeded) {
        // Recovery failed - close corrupt database and create fresh one
        log.warn({ dbPath }, 'WAL recovery failed, creating fresh database');
        db.close();

        // Backup corrupt database
        const backupPath = `${dbPath}.corrupt.${Date.now()}`;
        try {
          if (existsSync(dbPath)) {
            renameSync(dbPath, backupPath);
            log.info({ dbPath, backupPath }, 'Moved corrupt database to backup');
          }
        } catch (backupErr) {
          log.error({ err: backupErr, dbPath }, 'Failed to backup corrupt database');
        }

        // Create fresh database
        db = new Database(dbPath, { readonly });
        log.info({ dbPath }, 'Created fresh database after corruption');

        // Log the corruption error (non-throwing)
        const dbError = new DatabaseCorruptionError(
          `Database corruption unrecoverable, initialized empty state: ${dbPath}`,
          'integrity_check_failed',
          null,
          { dbPath, errors, backupPath }
        );
        log.error({ err: dbError }, 'Database corruption required fresh initialization');
      }
    }

    return db;

  } catch (err) {
    // Handle construction/opening errors
    if (err instanceof DatabaseCorruptionError) {
      throw err;
    }

    log.error({ err, dbPath }, 'Failed to open database');

    // If the database can't even be opened, throw the original error
    // unless it's a corruption-related error
    if (err.message && err.message.includes('corrupt')) {
      const dbError = new DatabaseCorruptionError(
        `Database file corrupt or unreadable: ${dbPath}`,
        'disk_io_error',
        null,
        { dbPath, originalError: err.message }
      );

      if (emitter) {
        emitter.emit('database:corruption-detected', {
          dbPath,
          corruptionType: 'disk_io_error',
          error: err.message,
          timestamp: new Date().toISOString(),
        });
      }

      throw dbError;
    }

    throw err;
  }
}

/**
 * Helper to run integrity check on an existing database instance.
 *
 * @param {Database} db - better-sqlite3 database instance
 * @param {string} dbPath - Path to database (for logging)
 * @returns {{ isHealthy: boolean, errors: string[] }}
 */
export function sqliteIntegrityCheck(db, dbPath = 'unknown') {
  const { isCorrupt, errors } = checkDatabaseIntegrity(db);

  if (isCorrupt) {
    log.error({ dbPath, errors }, 'Database integrity check failed');
  }

  return {
    isHealthy: !isCorrupt,
    errors,
  };
}
