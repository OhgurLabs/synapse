// src/orchestrator/log-rotation.js
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('log-rotation');

/**
 * Generate archive filename with timestamp.
 * @param {string} baseName - Base filename (e.g. 'anomaly-alerts').
 * @param {Date|string|number} timestamp - Date, ISO string, or epoch ms.
 * @returns {string} e.g. 'anomaly-alerts-20260401-143022.jsonl'
 */
export function formatArchiveName(baseName, timestamp) {
  const d = timestamp instanceof Date ? timestamp
    : typeof timestamp === 'number' ? new Date(timestamp)
    : new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${baseName}-${ts}.jsonl`;
}

/**
 * Check whether a file should be rotated based on size.
 */
function shouldRotateBySize(stats, sizeThresholdBytes) {
  return stats.size >= sizeThresholdBytes;
}

/**
 * Check whether a file should be rotated based on age.
 */
function shouldRotateByTime(stats, rotationIntervalMs) {
  return (Date.now() - stats.mtimeMs) >= rotationIntervalMs;
}

/**
 * Determine if rotation is needed based on strategy.
 */
function shouldRotate(stats, config) {
  const { strategy, sizeThresholdBytes, rotationIntervalMs } = config;
  if (strategy === 'size') return shouldRotateBySize(stats, sizeThresholdBytes);
  if (strategy === 'time') return shouldRotateByTime(stats, rotationIntervalMs);
  // 'both': rotate if EITHER threshold exceeded
  return shouldRotateBySize(stats, sizeThresholdBytes) || shouldRotateByTime(stats, rotationIntervalMs);
}

/**
 * Perform atomic rotation: rename current → archive, create fresh empty file.
 * On failure, attempts rollback so no data is lost.
 */
function performAtomicRotation(filePath, archivePath) {
  // Step 1: rename current file to archive (atomic on POSIX)
  fs.renameSync(filePath, archivePath);

  try {
    // Step 2: create fresh empty file
    fs.writeFileSync(filePath, '', 'utf-8');

    // Step 3: fsync for durability
    const fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (err) {
    // Rollback: restore archive back to original path
    try {
      fs.renameSync(archivePath, filePath);
    } catch (rollbackErr) {
      log.error('Rollback failed after rotation error', {
        archivePath,
        filePath,
        rotationError: err.message,
        rollbackError: rollbackErr.message,
      });
    }
    throw err;
  }
}

/**
 * Ensure the archive directory exists.
 */
function ensureArchiveDir(archiveDir) {
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }
}

/**
 * Build archive path from file path and config.
 */
function buildArchivePath(filePath, archiveDir, now) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const archiveName = formatArchiveName(baseName, now);
  return path.join(archiveDir, archiveName);
}

/**
 * Force immediate rotation of a log file regardless of thresholds.
 * @param {string} filePath - Path to the log file.
 * @param {object} config - Rotation configuration with archiveDir.
 * @returns {{ rotated: boolean, archivedFile: string|null, sizeBytes: number, timestamp: string, error: string|null }}
 */
export function rotateFileNow(filePath, config) {
  if (!fs.existsSync(filePath)) {
    return { rotated: false, archivedFile: null, sizeBytes: 0, timestamp: new Date().toISOString(), error: null };
  }

  const now = new Date();
  const archiveDir = config.archiveDir || '.synapse/archive';

  try {
    ensureArchiveDir(archiveDir);
    const stats = fs.statSync(filePath);
    const archivePath = buildArchivePath(filePath, archiveDir, now);

    performAtomicRotation(filePath, archivePath);

    const result = {
      rotated: true,
      archivedFile: archivePath,
      sizeBytes: stats.size,
      timestamp: now.toISOString(),
      error: null,
    };
    log.info('Log file rotated', result);
    return result;
  } catch (err) {
    log.error('Failed to rotate log file', { filePath, error: err.message });
    return { rotated: false, archivedFile: null, sizeBytes: 0, timestamp: now.toISOString(), error: err.message };
  }
}

/**
 * Check if rotation is needed and perform it if thresholds are exceeded.
 * @param {string} filePath - Path to the log file.
 * @param {object} config - Rotation configuration.
 * @returns {{ rotated: boolean, archivedFile: string|null, sizeBytes: number, timestamp: string, error: string|null }}
 */
export function rotateLogFile(filePath, config) {
  if (!fs.existsSync(filePath)) {
    return { rotated: false, archivedFile: null, sizeBytes: 0, timestamp: new Date().toISOString(), error: null };
  }

  try {
    const stats = fs.statSync(filePath);
    if (!shouldRotate(stats, config)) {
      return { rotated: false, archivedFile: null, sizeBytes: stats.size, timestamp: new Date().toISOString(), error: null };
    }
    return rotateFileNow(filePath, config);
  } catch (err) {
    log.error('Error checking rotation', { filePath, error: err.message });
    return { rotated: false, archivedFile: null, sizeBytes: 0, timestamp: new Date().toISOString(), error: err.message };
  }
}

/**
 * Get current file rotation status without performing rotation.
 * @param {string} filePath - Path to the log file.
 * @param {object} config - Rotation configuration.
 * @returns {{ exists: boolean, sizeBytes: number, lastModifiedMs: number, ageMs: number, exceedsSizeThreshold: boolean, exceedsTimeThreshold: boolean, shouldRotate: boolean, archiveCount: number }}
 */
export function getRotationStatus(filePath, config) {
  if (!fs.existsSync(filePath)) {
    return {
      exists: false, sizeBytes: 0, lastModifiedMs: 0, ageMs: 0,
      exceedsSizeThreshold: false, exceedsTimeThreshold: false,
      shouldRotate: false, archiveCount: 0,
    };
  }

  const stats = fs.statSync(filePath);
  const ageMs = Date.now() - stats.mtimeMs;
  const exceedsSizeThreshold = shouldRotateBySize(stats, config.sizeThresholdBytes);
  const exceedsTimeThreshold = shouldRotateByTime(stats, config.rotationIntervalMs);

  // Count existing archives
  const archiveDir = config.archiveDir || '.synapse/archive';
  let archiveCount = 0;
  if (fs.existsSync(archiveDir)) {
    const baseName = path.basename(filePath, path.extname(filePath));
    try {
      archiveCount = fs.readdirSync(archiveDir)
        .filter(f => f.startsWith(baseName + '-') && f.endsWith('.jsonl'))
        .length;
    } catch { /* ignore read errors */ }
  }

  return {
    exists: true,
    sizeBytes: stats.size,
    lastModifiedMs: stats.mtimeMs,
    ageMs,
    exceedsSizeThreshold,
    exceedsTimeThreshold,
    shouldRotate: shouldRotate(stats, config),
    archiveCount,
  };
}

/**
 * Remove old archives beyond the maxArchives retention limit.
 * Keeps the most recent archives.
 * @param {string} archiveDir - Directory containing archived files.
 * @param {object} config - Rotation configuration with maxArchives.
 * @returns {{ deleted: string[], retained: string[], error: string|null }}
 */
export function cleanupOldArchives(archiveDir, config) {
  const maxArchives = config.maxArchives || 10;

  if (!fs.existsSync(archiveDir)) {
    return { deleted: [], retained: [], error: null };
  }

  try {
    const files = fs.readdirSync(archiveDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort(); // Timestamp in name ensures chronological sort

    if (files.length <= maxArchives) {
      return { deleted: [], retained: files.map(f => path.join(archiveDir, f)), error: null };
    }

    const toDelete = files.slice(0, files.length - maxArchives);
    const toRetain = files.slice(files.length - maxArchives);
    const deleted = [];

    for (const f of toDelete) {
      const fullPath = path.join(archiveDir, f);
      try {
        fs.unlinkSync(fullPath);
        deleted.push(fullPath);
      } catch (err) {
        log.warn('Failed to delete old archive', { path: fullPath, error: err.message });
      }
    }

    const result = {
      deleted,
      retained: toRetain.map(f => path.join(archiveDir, f)),
      error: null,
    };
    if (deleted.length > 0) {
      log.info('Cleaned up old archives', { deleted: deleted.length, retained: toRetain.length });
    }
    return result;
  } catch (err) {
    log.error('Failed to clean up archives', { archiveDir, error: err.message });
    return { deleted: [], retained: [], error: err.message };
  }
}

/**
 * Create a scheduled rotation checker that periodically checks and rotates.
 * @param {string} filePath - Path to the log file.
 * @param {object} config - Rotation configuration.
 * @param {function} callback - Called with rotation result after each check.
 * @returns {{ start(): void, stop(): void, getStatus(): object }}
 */
export function createRotationScheduler(filePath, config, callback) {
  let timer = null;
  let lastCheckMs = null;
  const intervalMs = config.rotationIntervalMs || 86400000;

  function check() {
    lastCheckMs = Date.now();
    const result = rotateLogFile(filePath, config);
    if (result.rotated) {
      // Also clean up old archives after successful rotation
      cleanupOldArchives(config.archiveDir || '.synapse/archive', config);
    }
    if (callback) callback(result);
  }

  return {
    start() {
      if (timer) return;
      check(); // Run immediately on start
      timer = setInterval(check, intervalMs);
      // Allow the process to exit even if the timer is running
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    getStatus() {
      return {
        running: timer !== null,
        lastCheckMs,
        nextCheckMs: timer !== null && lastCheckMs !== null
          ? lastCheckMs + intervalMs
          : null,
      };
    },
  };
}
