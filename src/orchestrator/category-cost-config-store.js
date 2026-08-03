// category-cost-config-store.js — Persistence layer for per-category cost coefficient configuration
//
// Allows operators to configure cost/quality tradeoff preferences per task category.
// Config is persisted to `.synapse/projects/_category-cost-config.json`.
//
// Usage:
//   const store = new CategoryCostConfigStore('/path/to/.synapse/projects');
//   await store.set('coding', 0.5);
//   const config = await store.get('coding');
//   const all = await store.getAll();

import { readFile, writeFile, mkdir } from 'fs/promises';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('category-cost-config');

const CONFIG_FILE = '_category-cost-config.json';
const LOCK_FILE = '_category-cost-config.lock';

/**
 * CategoryCostConfigStore — Manages persistent per-category cost coefficient configuration.
 */
export class CategoryCostConfigStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.filePath = join(baseDir, CONFIG_FILE);
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
   * Get cost configuration for a specific category.
   * @param {string} category - The task category (e.g., 'coding', 'writing')
   * @returns {Promise<Object>} Object with costCoefficient property (default 0.0)
   */
  async get(category) {
    if (!existsSync(this.filePath)) {
      return { costCoefficient: 0.0 };
    }

    try {
      const data = await readFile(this.filePath, 'utf8');
      const configMap = JSON.parse(data);

      if (!configMap || typeof configMap !== 'object') {
        log.warn('Invalid config file structure, returning defaults', { filePath: this.filePath });
        return { costCoefficient: 0.0 };
      }

      const categoryConfig = configMap[category];
      if (!categoryConfig || typeof categoryConfig !== 'object' || !('costCoefficient' in categoryConfig)) {
        return { costCoefficient: 0.0 };
      }

      const coefficient = categoryConfig.costCoefficient;
      if (typeof coefficient !== 'number' || Number.isNaN(coefficient)) {
        log.warn('Invalid costCoefficient for category, returning default', { 
          category, 
          value: coefficient 
        });
        return { costCoefficient: 0.0 };
      }

      // Clamp to valid range [0.0, 1.0]
      const clamped = Math.max(0.0, Math.min(1.0, coefficient));
      
      if (clamped !== coefficient) {
        log.info('Clamped costCoefficient for category', { 
          category, 
          original: coefficient, 
          clamped 
        });
      }

      return { costCoefficient: clamped };
    } catch (err) {
      log.error('Failed to read category cost config', { error: err.message, filePath: this.filePath });
      return { costCoefficient: 0.0 };
    }
  }

  /**
   * Set cost coefficient for a specific category.
   * @param {string} category - The task category
   * @param {number} costCoefficient - Cost coefficient (0.0-1.0, will be clamped)
   * @returns {Promise<Object>} The updated category configuration
   */
  async set(category, costCoefficient) {
    // Validate category
    if (!category || typeof category !== 'string' || category.trim() === '') {
      throw new Error('Invalid category: must be a non-empty string');
    }

    // Validate costCoefficient
    if (typeof costCoefficient !== 'number' || Number.isNaN(costCoefficient)) {
      throw new Error('Invalid costCoefficient: must be a number');
    }

    if (!Number.isFinite(costCoefficient)) {
      throw new Error('Invalid costCoefficient: must be a finite number');
    }

    // Clamp to valid range [0.0, 1.0]
    const clamped = Math.max(0.0, Math.min(1.0, costCoefficient));
    
    if (clamped !== costCoefficient) {
      log.info('Clamped costCoefficient', { 
        category, 
        original: costCoefficient, 
        clamped 
      });
    }

    // Load existing config
    let configMap = {};
    if (existsSync(this.filePath)) {
      try {
        const data = await readFile(this.filePath, 'utf8');
        configMap = JSON.parse(data);
        if (!configMap || typeof configMap !== 'object') {
          configMap = {};
          log.warn('Corrupted config file, starting fresh', { filePath: this.filePath });
        }
      } catch (err) {
        log.warn('Failed to read existing config, starting fresh', { error: err.message });
        configMap = {};
      }
    }

    // Update category configuration
    configMap[category] = { costCoefficient: clamped };

    // Ensure directory exists
    await mkdir(this.baseDir, { recursive: true });

    // Acquire exclusive lock to prevent concurrent write race conditions
    const lockToken = await this._acquireLock();
    try {
      // Atomic write: write to temp file then rename
      const tmpPath = this.filePath + '.tmp.' + process.pid;
      try {
        writeFileSync(tmpPath, JSON.stringify(configMap, null, 2), 'utf8');
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

    log.info('Updated category cost configuration', { 
      category, 
      costCoefficient: clamped 
    });

    return { [category]: { costCoefficient: clamped } };
  }

  /**
   * Get cost configuration for all categories.
   * @returns {Promise<Object>} Map of category to {costCoefficient}
   */
  async getAll() {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      const data = await readFile(this.filePath, 'utf8');
      const configMap = JSON.parse(data);

      if (!configMap || typeof configMap !== 'object') {
        log.warn('Invalid config file structure', { filePath: this.filePath });
        return {};
      }

      // Validate and normalize all entries
      const result = {};
      for (const [category, config] of Object.entries(configMap)) {
        if (!config || typeof config !== 'object' || !('costCoefficient' in config)) {
          log.warn('Invalid config entry for category, skipping', { category });
          continue;
        }

        const coefficient = config.costCoefficient;
        if (typeof coefficient !== 'number' || Number.isNaN(coefficient) || !Number.isFinite(coefficient)) {
          log.warn('Invalid costCoefficient for category, skipping', { category, value: coefficient });
          continue;
        }

        // Clamp to valid range
        const clamped = Math.max(0.0, Math.min(1.0, coefficient));
        
        result[category] = { costCoefficient: clamped };
      }

      return result;
    } catch (err) {
      log.error('Failed to read category cost config', { error: err.message, filePath: this.filePath });
      return {};
    }
  }

  /**
   * Set multiple category configurations at once.
   * @param {Object} configMap - Map of category to {costCoefficient}
   * @returns {Promise<Object>} The updated configuration map
   */
  async setAll(configMap) {
    if (!configMap || typeof configMap !== 'object') {
      throw new Error('Invalid configMap: must be an object');
    }

    // Validate all entries
    const validated = {};
    for (const [category, config] of Object.entries(configMap)) {
      if (!config || typeof config !== 'object' || !('costCoefficient' in config)) {
        log.warn('Invalid config entry, skipping', { category });
        continue;
      }

      const coefficient = config.costCoefficient;
      if (typeof coefficient !== 'number' || Number.isNaN(coefficient) || !Number.isFinite(coefficient)) {
        log.warn('Invalid costCoefficient, skipping', { category, value: coefficient });
        continue;
      }

      const clamped = Math.max(0.0, Math.min(1.0, coefficient));
      validated[category] = { costCoefficient: clamped };
    }

    if (Object.keys(validated).length === 0) {
      throw new Error('No valid category configurations provided');
    }

    // Ensure directory exists
    await mkdir(this.baseDir, { recursive: true });

    // Acquire exclusive lock to prevent concurrent write race conditions
    const lockToken = await this._acquireLock();
    try {
      // Atomic write using temp file + rename
      const tmpPath = this.filePath + '.tmp.' + process.pid;
      try {
        writeFileSync(tmpPath, JSON.stringify(validated, null, 2), 'utf8');
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

    log.info('Updated category cost configurations', { categories: Object.keys(validated) });

    return validated;
  }
}
