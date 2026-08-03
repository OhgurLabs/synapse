// src/orchestrator/alert-rotation.js
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('alert-rotation');

/**
 * Check if the alert log file exceeds the size threshold and rotate if necessary.
 * @param {string} filePath - Path to the alert log file.
 * @param {object} config - Configuration object containing maxSizeBytes and archiveDir.
 * @param {number} [threshold=1.0] - Threshold multiplier for maxSizeBytes (default 1.0).
 * @returns {object|null} Rotation record if rotated, null otherwise.
 */
export function checkAndRotate(filePath, config, threshold = 1.0) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.size >= config.maxSizeBytes * threshold) {
      return rotateNow(filePath, config);
    }
  } catch (err) {
    log.error('Error during rotation check', { filePath, error: err.message });
  }

  return null;
}

/**
 * Perform the actual rotation of the alert log file.
 * @param {string} filePath - Path to the alert log file.
 * @param {object} config - Configuration object containing archiveDir.
 * @returns {object} Rotation record.
 */
export function rotateNow(filePath, config) {
  const now = new Date();
  // Format timestamp as YYYY-MM-DDTHH:mm:ssZ to match requirement
  const timestamp = now.toISOString().split('.')[0] + 'Z';
  const baseName = path.basename(filePath, path.extname(filePath));
  const ext = path.extname(filePath);
  const archiveName = `${baseName}.${timestamp}${ext}`;
  const archivePath = path.join(config.archiveDir, archiveName);

  try {
    // Ensure archive directory exists
    if (!fs.existsSync(config.archiveDir)) {
      fs.mkdirSync(config.archiveDir, { recursive: true });
    }

    let sizeBytes = 0;
    if (fs.existsSync(filePath)) {
      sizeBytes = fs.statSync(filePath).size;
      // Atomic rename to archive
      fs.renameSync(filePath, archivePath);
    }

    // Create fresh empty file
    fs.writeFileSync(filePath, '');

    const record = {
      rotated: true,
      archivedFile: archivePath,
      sizeBytes,
      timestamp
    };

    log.info('Alert log rotated', record);
    return record;
  } catch (err) {
    log.error('Failed to rotate alert log', { filePath, error: err.message });
    throw err;
  }
}
