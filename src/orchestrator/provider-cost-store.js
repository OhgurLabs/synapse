// provider-cost-store.js — Persistence layer for per-provider cost model
//
// Stores relative cost units per dispatch for each provider (e.g., { claude: 1.0, codex: 0.3 }).
// Costs are persisted to `.synapse/projects/_provider-costs.json`.
//
// Usage:
//   const store = new ProviderCostStore('/path/to/.synapse/projects');
//   const costs = await store.getCosts();
//   await store.setCosts({ claude: 1.0, codex: 0.3 });
//   await store.setCost('gpt4', 0.8);

import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('provider-cost-store');

const COSTS_FILE = '_provider-costs.json';
const LOCK_FILE = '_provider-costs.lock';

/**
 * ProviderCostStore — Manages persistent per-provider cost data.
 */
export class ProviderCostStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.filePath = join(baseDir, COSTS_FILE);
    this.lockPath = join(baseDir, LOCK_FILE);
  }

  /**
   * Acquire an exclusive file lock using atomic file creation.
   * @private
   * @returns {Promise<string>} Lock token
   */
  async _acquireLock() {
    const lockToken = `${process.pid}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const lockCheckPath = this.lockPath + '.check';
    
    try {
      await mkdir(this.baseDir, { recursive: true });
      await writeFile(lockCheckPath, lockToken, { flag: 'wx' });
      return lockToken;
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new Error('Lock already held by another process, retrying...');
      }
      throw err;
    }
  }

  /**
   * Release the file lock.
   * @private
   * @param {string} token - Lock token to verify ownership
   */
  async _releaseLock(token) {
    try {
      const lockCheckPath = this.lockPath + '.check';
      if (existsSync(lockCheckPath)) {
        const currentToken = readFileSync(lockCheckPath, 'utf8').trim();
        if (currentToken === token) {
          unlinkSync(lockCheckPath);
        }
      }
    } catch (err) {
      log.warn('Failed to release lock', { error: err.message });
    }
  }

  /**
   * Get all provider costs.
   * Missing providers default to 1.0.
   * @returns {Promise<Object>} Cost map (e.g., { claude: 1.0, codex: 0.3 })
   */
  async getCosts() {
    if (!existsSync(this.filePath)) {
      log.debug('No provider costs file found, returning empty default');
      return {};
    }

    try {
      const data = await readFile(this.filePath, 'utf8');
      const costs = JSON.parse(data);

      // Validate structure
      if (!costs || typeof costs !== 'object') {
        log.warn('Invalid costs file structure, returning empty default', { filePath: this.filePath });
        return {};
      }

      // Validate all values are positive numbers
      for (const [provider, cost] of Object.entries(costs)) {
        if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || Number.isNaN(cost)) {
          log.warn('Invalid cost value for provider', { provider, cost });
          return {};
        }
      }

      return costs;
    } catch (err) {
      log.error('Failed to read provider costs file', { error: err.message, filePath: this.filePath });
      return {};
    }
  }

  /**
   * Get the effective cost for a specific provider.
   * Missing providers default to 1.0.
   * @param {string} provider - Provider name
   * @returns {number} Cost value (default 1.0)
   */
  async getCost(provider) {
    const costs = await this.getCosts();
    return costs[provider] !== undefined ? costs[provider] : 1.0;
  }

  /**
   * Set the entire cost map.
   * @param {Object} costs - Cost map (e.g., { claude: 1.0, codex: 0.3 })
   * @returns {Promise<Object>} The updated cost map
   */
  async setCosts(costs) {
    // Validate input
    if (!costs || typeof costs !== 'object' || Object.keys(costs).length === 0) {
      throw new Error('Invalid costs: must be a non-empty object');
    }

    // Validate all values are positive numbers
    for (const [provider, cost] of Object.entries(costs)) {
      if (typeof provider !== 'string' || provider.trim() === '') {
        throw new Error(`Invalid provider name: "${provider}"`);
      }
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || Number.isNaN(cost)) {
        throw new Error(`Invalid cost for provider "${provider}": ${cost} (must be a positive number)`);
      }
    }

    // Ensure directory exists
    await mkdir(this.baseDir, { recursive: true });

    // Acquire exclusive lock to prevent concurrent write race conditions
    const lockToken = await this._acquireLock();
    try {
      // Atomic write: write to temp file then rename
      const tmpPath = this.filePath + '.tmp.' + process.pid;
      try {
        writeFileSync(tmpPath, JSON.stringify(costs, null, 2), 'utf8');
        renameSync(tmpPath, this.filePath);
      } catch (err) {
        // Clean up temp file on failure
        try {
          unlinkSync(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
        throw err;
      }
    } finally {
      await this._releaseLock(lockToken);
    }

    log.info('Updated provider costs', { costs, filePath: this.filePath });

    return costs;
  }

 /**
    * Set the cost for a single provider.
    * @param {string} provider - Provider name
    * @param {number} cost - Cost value (must be positive)
    * @returns {Promise<Object>} The updated cost map
    */
   async setCost(provider, cost) {
     if (typeof provider !== 'string' || provider.trim() === '') {
       throw new Error(`Invalid provider name: "${provider}"`);
     }

     if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || Number.isNaN(cost)) {
       throw new Error(`Invalid cost: ${cost} (must be a positive number)`);
     }

     // Read existing costs atomically
     const existingCosts = await this.getRawCosts() || {};
     existingCosts[provider] = cost;

     return await this.setCosts(existingCosts);
   }

  /**
   * Clear all provider costs (delete the file).
   * @returns {Promise<void>}
   */
  async clear() {
    if (!existsSync(this.filePath)) {
      return;
    }

    await unlink(this.filePath);
    log.info('Cleared provider costs', { filePath: this.filePath });
  }

  /**
   * Check if a cost file exists.
   * @returns {Promise<boolean>}
   */
  async hasCosts() {
    return existsSync(this.filePath);
  }

  /**
   * Get the raw cost data without defaults applied.
   * @returns {Promise<Object|null>} Raw cost object or null if file doesn't exist
   */
  async getRawCosts() {
    if (!existsSync(this.filePath)) {
      return null;
    }

    try {
      const data = await readFile(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      log.error('Failed to read raw provider costs', { error: err.message });
      return null;
    }
  }
}
