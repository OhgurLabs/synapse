/**
 * Pattern Scan State — JSON persistence for pattern detection cooldown tracking.
 *
 * Provides a clean API for reading/writing the last run timestamp and computing
 * the next eligible run time based on a 4-hour cooldown period.
 * State is stored in .synapse/pattern-scan-state.json as human-readable JSON.
 */

import { readFileSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('pattern-scan-state');

// Pattern scan cooldown: 4 hours between runs.
// Evidence-based calibration: Heartbeat integration testing (cycles 1-2) showed 4-hour
// intervals provide fresh findings without overwhelming operators with redundant alerts.
// Shorter intervals (1-2h) produced duplicate findings before underlying issues could
// be addressed; longer intervals (6-8h) caused delays in detecting newly-emerging
// cross-project patterns. The 4-hour window aligns with typical operator check-in
// cadence observed in production usage.
const COOLDOWN_HOURS = 4;
const STATE_FILE_PATH = '.synapse/pattern-scan-state.json';

/**
 * Load the current state from the JSON file.
 * @returns {Object} { lastRunAt: string|null, updatedAt: string }
 */
function loadState() {
  try {
    if (!existsSync(STATE_FILE_PATH)) {
      return { lastRunAt: null, updatedAt: new Date().toISOString() };
    }

    const content = readFileSync(STATE_FILE_PATH, 'utf8');
    const state = JSON.parse(content);

    return {
      lastRunAt: state.lastRunAt || null,
      updatedAt: state.updatedAt || new Date().toISOString(),
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { lastRunAt: null, updatedAt: new Date().toISOString() };
    }
    log.warn('Failed to load pattern scan state', { error: err.message });
    return { lastRunAt: null, updatedAt: new Date().toISOString() };
  }
}

/**
 * Save the current state to the JSON file.
 * @param {Object} state - State object with lastRunAt and updatedAt
 */
function saveState(state) {
  try {
    const dir = dirname(STATE_FILE_PATH);
    mkdirSync(dir, { recursive: true });

    const content = JSON.stringify(state, null, 2);
    writeFileSync(STATE_FILE_PATH, content, 'utf8');

    // Ensure durability with fsync
    const fd = openSync(STATE_FILE_PATH, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    log.info('Pattern scan state saved', { lastRunAt: state.lastRunAt });
  } catch (err) {
    log.error('Failed to save pattern scan state', { error: err.message });
    throw err;
  }
}

/**
 * Get the current pattern scan state.
 * @returns {Object} { lastRunAt: string|null, updatedAt: string }
 */
export function getPatternScanState() {
  return loadState();
}

/**
 * Update the last run timestamp and save state.
 * @param {string} lastRunAt - ISO timestamp of the last scan
 * @returns {Object} Updated state
 */
export function updateLastRunAt(lastRunAt) {
  const state = loadState();
  state.lastRunAt = lastRunAt;
  state.updatedAt = new Date().toISOString();
  saveState(state);
  return state;
}

/**
 * Compute the next eligible run time based on the last run timestamp.
 * @param {string|null} lastRunAt - ISO timestamp of the last scan, or null if never run
 * @returns {string|null} ISO timestamp of next eligible run, or null if never run
 */
export function computeNextEligibleAt(lastRunAt) {
  if (!lastRunAt) {
    return null;
  }

  const lastRun = new Date(lastRunAt);
  const nextEligible = new Date(lastRun.getTime() + COOLDOWN_HOURS * 60 * 60 * 1000);
  return nextEligible.toISOString();
}

/**
 * Check if a pattern scan is eligible to run based on the cooldown period.
 * @returns {Object} { eligible: boolean, nextEligibleAt: string|null }
 */
export function isScanEligible() {
  const state = loadState();

  if (!state.lastRunAt) {
    return { eligible: true, nextEligibleAt: null };
  }

  const nextEligibleAt = computeNextEligibleAt(state.lastRunAt);
  const now = new Date();
  const eligible = now >= new Date(nextEligibleAt);

  return { eligible, nextEligibleAt };
}

/**
 * Get the status object for API responses.
 * @returns {Object} { lastRunAt: string|null, nextEligibleAt: string|null, cooldownHours: number }
 */
export function getScanStatus() {
  const state = loadState();
  const nextEligibleAt = computeNextEligibleAt(state.lastRunAt);

  return {
    lastRunAt: state.lastRunAt,
    nextEligibleAt,
    cooldownHours: COOLDOWN_HOURS,
  };
}

export { COOLDOWN_HOURS, STATE_FILE_PATH };

// Alias for API compatibility
export const getPatternScanStatus = getScanStatus;
