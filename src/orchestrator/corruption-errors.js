/**
 * Corruption-specific error types for state integrity validation.
 *
 * These errors are thrown when actual data corruption is detected during
 * read/validation operations, and include recovery hints to guide automated
 * or operator-driven recovery procedures.
 *
 * @module orchestrator/corruption-errors
 */

/**
 * CheckpointCorruptionError - thrown when checkpoint file corruption is detected.
 *
 * Indicates that a checkpoint JSONL file has been corrupted and cannot be safely
 * loaded. The corruptionType field specifies the nature of the corruption, and
 * recoveryHint provides guidance for automated or manual recovery.
 */
export class CheckpointCorruptionError extends Error {
  /**
   * @param {string} message - Error message describing the corruption
   * @param {string} corruptionType - Type of corruption (truncated, invalid_json, missing_field, checksum_mismatch)
   * @param {string} [recoveryHint] - Suggested recovery action (auto-generated if not provided)
   */
  constructor(message, corruptionType, recoveryHint = null) {
    super(message);
    this.name = 'CheckpointCorruptionError';
    this.corruptionType = corruptionType;
    this.recoveryHint = recoveryHint || this._getDefaultRecoveryHint(corruptionType);
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Get default recovery hint for a corruption type.
   * @private
   * @param {string} corruptionType - Type of corruption
   * @returns {string} Recovery hint
   */
  _getDefaultRecoveryHint(corruptionType) {
    const hints = {
      truncated: 'Attempt to load previous checkpoint (N-1)',
      invalid_json: 'Skip corrupted line, continue with next checkpoint',
      missing_field: 'Initialize missing field with default value',
      checksum_mismatch: 'Verify checkpoint file integrity, fallback to older checkpoint',
    };
    return hints[corruptionType] || 'Fallback to empty state and alert operator';
  }
}

/**
 * DatabaseCorruptionError - thrown when SQLite database corruption is detected.
 *
 * Indicates that a SQLite database file (e.g., shared-state, timeline-events) has
 * failed integrity checks or exhibits corruption. The corruptionType field specifies
 * the nature of the corruption, and recoveryHint provides guidance for recovery.
 */
export class DatabaseCorruptionError extends Error {
  /**
   * @param {string} message - Error message describing the corruption
   * @param {string} corruptionType - Type of corruption (integrity_check_failed, wal_corrupt, schema_mismatch, disk_io_error)
   * @param {string} [recoveryHint] - Suggested recovery action (auto-generated if not provided)
   * @param {Object} [metadata] - Additional metadata (database path, last operation, etc.)
   */
  constructor(message, corruptionType, recoveryHint = null, metadata = {}) {
    super(message);
    this.name = 'DatabaseCorruptionError';
    this.corruptionType = corruptionType;
    this.recoveryHint = recoveryHint || this._getDefaultRecoveryHint(corruptionType);
    this.metadata = metadata;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Get default recovery hint for a corruption type.
   * @private
   * @param {string} corruptionType - Type of corruption
   * @returns {string} Recovery hint
   */
  _getDefaultRecoveryHint(corruptionType) {
    const hints = {
      integrity_check_failed: 'Run PRAGMA integrity_check, attempt WAL checkpoint recovery, fallback to empty database',
      wal_corrupt: 'Delete WAL file and restart, may lose recent uncommitted writes',
      schema_mismatch: 'Run schema migration, reinitialize database if migration fails',
      disk_io_error: 'Check disk space and permissions, retry operation, alert operator if persistent',
    };
    return hints[corruptionType] || 'Backup corrupt database, initialize new database, alert operator';
  }
}

/**
 * ConfigCorruptionError - thrown when configuration file corruption is detected.
 *
 * Indicates that a configuration file (JSON) has been corrupted and cannot be safely
 * parsed or validated. The corruptionType field specifies the nature of the corruption,
 * and recoveryHint provides guidance for recovery.
 */
export class ConfigCorruptionError extends Error {
  /**
   * @param {string} message - Error message describing the corruption
   * @param {string} corruptionType - Type of corruption (invalid_json, schema_violation, missing_required_field)
   * @param {string} [recoveryHint] - Suggested recovery action (auto-generated if not provided)
   * @param {Object} [metadata] - Additional metadata (config path, field name, etc.)
   */
  constructor(message, corruptionType, recoveryHint = null, metadata = {}) {
    super(message);
    this.name = 'ConfigCorruptionError';
    this.corruptionType = corruptionType;
    this.recoveryHint = recoveryHint || this._getDefaultRecoveryHint(corruptionType);
    this.metadata = metadata;
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Get default recovery hint for a corruption type.
   * @private
   * @param {string} corruptionType - Type of corruption
   * @returns {string} Recovery hint
   */
  _getDefaultRecoveryHint(corruptionType) {
    const hints = {
      invalid_json: 'Restore from backup config, use default configuration',
      schema_violation: 'Apply schema migration, merge with default config template',
      missing_required_field: 'Use default value for missing field, continue with degraded config',
    };
    return hints[corruptionType] || 'Restore default configuration, alert operator for manual review';
  }
}
