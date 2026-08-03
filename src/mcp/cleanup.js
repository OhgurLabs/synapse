/**
 * MCP Tool Cleanup Service
 *
 * Provides periodic garbage collection for orphaned tool references and metadata.
 * Identifies and prunes stale references from the dispatch system when tasks complete
 * or become invalid.
 *
 * Features:
 * - Periodic garbage collection of orphaned references
 * - Cleanup of stale tool metadata
 * - Integration with ReferenceCounter for safe cleanup
 * - Configurable cleanup intervals
 * - Statistics and monitoring
 */

import { createLogger } from '../logger.js';

const log = createLogger('mcp-cleanup');

export class MpcCleanupService {
  /**
   * @param {Object} deps
   * @param {ReferenceCounter} deps.referenceCounter - Reference counter instance
   * @param {ToolRegistrationService} deps.registrationService - Registration service instance
   * @param {Object} options
   * @param {number} options.cleanupIntervalMs - Interval between cleanup runs (default: 60000)
   * @param {number} options.maxOrphanAgeMs - Maximum age of orphaned references before cleanup (default: 300000)
   */
  constructor(deps, options = {}) {
    if (!deps.referenceCounter) {
      throw new TypeError('referenceCounter is required');
    }
    if (!deps.registrationService) {
      throw new TypeError('registrationService is required');
    }

    this._referenceCounter = deps.referenceCounter;
    this._registrationService = deps.registrationService;
    this._cleanupIntervalMs = options.cleanupIntervalMs || 60000;
    this._maxOrphanAgeMs = options.maxOrphanAgeMs || 300000;

    this._cleanupInterval = null;
    this._running = false;

    this._stats = {
      totalRuns: 0,
      totalOrphansCleaned: 0,
      lastRunAt: null,
      lastRunDurationMs: 0
    };
  }

  /**
   * Start the periodic cleanup routine.
   */
  start() {
    if (this._running) {
      log.warn('Cleanup service already running');
      return;
    }

    this._running = true;
    this._cleanupInterval = setInterval(() => {
      this.runCleanup().catch(err => {
        log.error({ err }, 'Error during periodic cleanup');
      });
    }, this._cleanupIntervalMs);

    log.info({
      intervalMs: this._cleanupIntervalMs,
      maxOrphanAgeMs: this._maxOrphanAgeMs
    }, 'Cleanup service started');
  }

  /**
   * Stop the periodic cleanup routine.
   */
  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._running = false;

    log.info('Cleanup service stopped');
  }

  /**
   * Run a cleanup cycle.
   * Identifies and removes orphaned references.
   *
   * @param {Set<string>} validTaskIds - Set of currently active task IDs
   * @returns {Promise<Object>} Cleanup statistics
   */
  async runCleanup(validTaskIds = new Set()) {
    const startTime = Date.now();
    this._stats.totalRuns++;

    log.debug('Starting cleanup cycle');

    try {
      // Clean up orphaned references
      const cleanupResult = this._referenceCounter.cleanupOrphans(validTaskIds);
      this._stats.totalOrphansCleaned += cleanupResult.tasksCleaned;

      log.info({
        tasksCleaned: cleanupResult.tasksCleaned,
        toolsCleaned: cleanupResult.toolsCleaned,
        validTasksCount: validTaskIds.size
      }, 'Cleanup cycle complete');

      this._stats.lastRunAt = new Date().toISOString();
      this._stats.lastRunDurationMs = Date.now() - startTime;

      return {
        success: true,
        ...cleanupResult,
        durationMs: this._stats.lastRunDurationMs
      };
    } catch (err) {
      log.error({ err }, 'Cleanup cycle failed');
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Find orphaned references without cleaning them up.
   * Useful for monitoring and diagnostics.
   *
   * @param {Set<string>} validTaskIds - Set of currently active task IDs
   * @returns {Object} Orphan information
   */
  findOrphans(validTaskIds) {
    if (!(validTaskIds instanceof Set)) {
      throw new TypeError('validTaskIds must be a Set');
    }

    return this._referenceCounter.findOrphans(validTaskIds);
  }

  /**
   * Get cleanup statistics.
   *
   * @returns {Object} Statistics about cleanup operations
   */
  getStats() {
    return {
      ...this._stats,
      isRunning: this._running,
      cleanupIntervalMs: this._cleanupIntervalMs,
      maxOrphanAgeMs: this._maxOrphanAgeMs,
      referenceStats: this._referenceCounter.getStats()
    };
  }

  /**
   * Force immediate cleanup of all orphaned references.
   *
   * @param {Set<string>} validTaskIds - Set of currently active task IDs
   * @returns {Promise<Object>} Cleanup statistics
   */
  async forceCleanup(validTaskIds = new Set()) {
    return this.runCleanup(validTaskIds);
  }

  /**
   * Get tools that are candidates for cleanup (no active references).
   *
   * @param {Array<string>} toolIds - Tool IDs to check
   * @returns {Object} Safe and blocked tools
   */
  getSafeToRemoveTools(toolIds) {
    return this._referenceCounter.getSafeToRemoveTools(toolIds);
  }

  /**
   * Check if the cleanup service is running.
   *
   * @returns {boolean} True if running
   */
  isRunning() {
    return this._running;
  }
}
