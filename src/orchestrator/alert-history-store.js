/**
 * Alert History Store — JSONL persistence for anomaly detector alert history.
 * Used by AnomalyDetector to persist resolved alerts across restarts.
 * Uses append + fsync pattern for durability.
 */

import { readFileSync, appendFileSync, openSync, readSync, fsyncSync, closeSync, mkdirSync, statSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';
import { checkAndRotate } from './alert-rotation.js';
import config from '../config.js';

const log = createLogger('alert-history-store');

/**
 * Load alert history from a JSONL file.
 * @param {string} filePath - path to the JSONL file
 * @returns {object[]} array of parsed alert objects, empty array if file missing/empty
 */
export function loadAlertHistory(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const alerts = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue; // Skip empty lines

      try {
        const alert = JSON.parse(line);
        alerts.push(alert);
      } catch (parseErr) {
        // Silently skip malformed lines
      }
    }

    return alerts;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File doesn't exist yet - return empty array
      return [];
    }
    // Re-throw other errors (EACCES, etc.)
    throw err;
  }
}

/**
 * Append a single alert entry to the JSONL file.
 * Creates parent directories if needed.
 * Uses appendFileSync + fsync for durability.
 * @param {string} filePath - path to the JSONL file
 * @param {object} entry - alert object to append
 */
export function appendAlertEntry(filePath, entry) {
  try {
    // Ensure parent directory exists
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });

    // Call rotation check if writing to the anomaly alerts log
    if (filePath.endsWith('anomaly-alerts.jsonl')) {
      checkAndRotate(filePath, config.anomalyAlerts, 0.95);
    }

    // Append the entry as a single JSON line with flag 'a'.
    //
    // Guard against a file that does NOT already end in a newline. Appending
    // blindly concatenates the new record onto the last existing one:
    //     {"condition":"a",...}
    //     {"condition":"b",...}{"condition":"c",...}   <- both now unparseable
    // and loadAlertHistory silently skips malformed lines, so that is TWO
    // alert records lost with no error anywhere. Reachable whenever a previous
    // write was truncated (crash mid-append), or the file was produced by
    // anything that omits the trailing terminator.
    //
    // Empty file: nothing to separate from, so no prefix — otherwise every log
    // would start with a blank line.
    let needsSeparator = false;
    try {
      const size = statSync(filePath).size;
      if (size > 0) {
        const fdCheck = openSync(filePath, 'r');
        try {
          const tail = Buffer.alloc(1);
          readSync(fdCheck, tail, 0, 1, size - 1);
          needsSeparator = tail[0] !== 0x0a; // '\n'
        } finally {
          closeSync(fdCheck);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // no file yet — nothing to separate
    }

    appendFileSync(filePath, (needsSeparator ? '\n' : '') + JSON.stringify(entry) + '\n', { flag: 'a' });

    // Open file, fsync to ensure durability, then close
    const fd = openSync(filePath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    log.warn('Failed to append alert entry to file', { filePath, error: err.message });
    throw err;
  }
}
