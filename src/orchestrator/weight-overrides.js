// weight-overrides.js — Persistence layer for manual routing weight overrides
//
// Allows operators to apply auto-tuning recommendations or manual weight adjustments.
// Overrides are persisted to `.synapse/projects/_routing-weight-overrides.json`.
//
// Usage:
//   const overrides = new WeightOverrides('/path/to/.synapse/projects');
//   await overrides.apply({ provider1: 0.6, provider2: 0.4 }, { reason: 'manual', appliedBy: 'user' });
//   const active = await overrides.getActive();
//   await overrides.clear();

import { readFile, writeFile, mkdir, unlink, access, constants } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { createLogger } from '../logger.js';

const log = createLogger('weight-overrides');

const HISTORY_FILE = '_routing-weight-history.json';

/**
 * WeightOverrides — Manages persistent routing weight overrides.
 */
export class WeightOverrides {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.filePath = join(baseDir, '_routing-weight-overrides.json');
  }

  /**
   * Apply a new weight override.
   * @param {Object} weights - Provider weights mapping (e.g., { claude: 0.6, codex: 0.4 })
   * @param {Object} metadata - Context about the override (reason, appliedBy, etc.)
   * @returns {Promise<Object>} The applied override record
   */
  async apply(weights, metadata = {}) {
    // Validate weights
    if (!weights || typeof weights !== 'object' || Object.keys(weights).length === 0) {
      throw new Error('Invalid weights: must be a non-empty object');
    }

    const providers = Object.keys(weights);
    const values = Object.values(weights);

    // Check all weights are numbers between 0 and 1
    if (values.some(w => typeof w !== 'number' || w < 0 || w > 1)) {
      throw new Error('Invalid weights: all values must be numbers between 0 and 1');
    }

    // Check weights sum to approximately 1.0 (allow small floating-point error)
    const sum = values.reduce((acc, w) => acc + w, 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      throw new Error(`Invalid weights: sum is ${sum.toFixed(4)}, expected 1.0`);
    }

    const now = new Date();
    const expiresAt = resolveExpiry(metadata, now);

    // Store snapshot of current weights before applying new ones
    let previousSnapshot = null;
    try {
      const currentActive = await this.getActive();
      if (currentActive) {
        previousSnapshot = await this._storeSnapshot(currentActive, {
          reason: 'auto_backup',
          appliedBy: 'system',
        });
      }
    } catch (err) {
      log.warn('Failed to store previous snapshot', { error: err.message });
    }

    const override = {
      id: `weight_override_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      weights,
      appliedAt: now.toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      ...(metadata.ttlMs ? { ttlMs: metadata.ttlMs } : {}),
      ...metadata,
    };

    // Ensure directory exists
    await mkdir(this.baseDir, { recursive: true });

    // Write override to file
    await writeFile(this.filePath, JSON.stringify(override, null, 2), 'utf8');

    log.info('Applied routing weight override', {
      providers,
      weights,
      reason: metadata.reason,
      appliedBy: metadata.appliedBy,
    });

    return override;
  }

  /**
   * Get the currently active weight override, if any.
   * @returns {Promise<Object|null>} The active override or null
   */
  async getActive() {
    if (!existsSync(this.filePath)) {
      return null;
    }

    try {
      const data = await readFile(this.filePath, 'utf8');
      const override = JSON.parse(data);

      // Validate structure
      if (!override.weights || typeof override.weights !== 'object') {
        log.warn('Invalid override file structure, ignoring', { filePath: this.filePath });
        return null;
      }

      if (override.expiresAt) {
        const expiresAt = new Date(override.expiresAt);
        if (!Number.isNaN(expiresAt.getTime()) && Date.now() >= expiresAt.getTime()) {
          await this.clear();
          return null;
        }
      }

      return override;
    } catch (err) {
      log.error('Failed to read weight override file', { error: err.message, filePath: this.filePath });
      return null;
    }
  }

  /**
   * Clear the active weight override (delete the file).
   * @returns {Promise<void>}
   */
  async clear() {
    if (!existsSync(this.filePath)) {
      return;
    }

    const { unlink } = await import('fs/promises');
    await unlink(this.filePath);
    log.info('Cleared routing weight override', { filePath: this.filePath });
  }

  /**
   * Check if an active override exists.
   * @returns {Promise<boolean>}
   */
  async hasActive() {
    const override = await this.getActive();
    return override !== null;
  }

  /**
   * Get historical weight snapshots.
   * @returns {Promise<Array>} Array of historical snapshots
   */
  async getHistory() {
    const historyPath = join(this.baseDir, HISTORY_FILE);
    
    if (!existsSync(historyPath)) {
      return [];
    }

    try {
      const data = await readFile(historyPath, 'utf8');
      const history = JSON.parse(data);
      return Array.isArray(history) ? history : [];
    } catch (err) {
      log.error('Failed to read weight history', { error: err.message, historyPath });
      return [];
    }
  }

  /**
   * Get a specific snapshot by ID.
   * @param {string} snapshotId - The snapshot ID to retrieve
   * @returns {Promise<Object|null>} The snapshot or null if not found
   */
  async getSnapshotById(snapshotId) {
    const history = await this.getHistory();
    return history.find(s => s.id === snapshotId) || null;
  }

  /**
   * Store a snapshot of the current weights.
   * @private
   * @param {Object} currentOverride - The current override to snapshot
   * @param {Object} metadata - Additional metadata for the snapshot
   * @returns {Promise<Object>} The stored snapshot
   */
  async _storeSnapshot(currentOverride, metadata = {}) {
    const historyPath = join(this.baseDir, HISTORY_FILE);
    let history = [];

    try {
      if (existsSync(historyPath)) {
        const data = await readFile(historyPath, 'utf8');
        history = JSON.parse(data);
        if (!Array.isArray(history)) {
          history = [];
        }
      }
    } catch (err) {
      log.warn('Failed to read existing history, starting fresh', { error: err.message });
    }

    const snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      weights: currentOverride?.weights || {},
      appliedAt: currentOverride?.appliedAt || new Date().toISOString(),
      expiresAt: currentOverride?.expiresAt || null,
      reason: metadata.reason || null,
      appliedBy: metadata.appliedBy || 'system',
      metadata: { ...metadata },
      storedAt: new Date().toISOString(),
    };

    history.unshift(snapshot);
    const MAX_HISTORY = 100;
    if (history.length > MAX_HISTORY) {
      history = history.slice(0, MAX_HISTORY);
    }

    await mkdir(this.baseDir, { recursive: true });
    await writeFile(historyPath, JSON.stringify(history, null, 2), 'utf8');

    log.info('Stored weight snapshot', { snapshotId: snapshot.id, weights: snapshot.weights });
    return snapshot;
  }
}

function resolveExpiry(metadata = {}, now = new Date()) {
  if (!metadata || typeof metadata !== 'object') return null;

  if (metadata.expiresAt) {
    const expiresAt = new Date(metadata.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error('Invalid expiresAt: must be a valid ISO timestamp');
    }
    return expiresAt.toISOString();
  }

  const ttlMs = typeof metadata.ttlMs === 'number'
    ? metadata.ttlMs
    : (typeof metadata.ttlSeconds === 'number'
      ? metadata.ttlSeconds * 1000
      : (typeof metadata.ttlMinutes === 'number' ? metadata.ttlMinutes * 60_000 : null));

  if (ttlMs !== null && ttlMs !== undefined) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('Invalid ttl: must be a positive number');
    }
    return new Date(now.getTime() + ttlMs).toISOString();
  }

  return null;
}
