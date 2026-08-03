/**
 * error-pattern-detector.js — Sliding-window error pattern detector.
 *
 * Tracks error-classifier.js outcomes per agent/category pair in an in-memory sliding window.
 * When >3 failures of the same error category occur within the window for a given agent,
 * emits a constraint recommendation event to the timeline store.
 */

import { randomUUID } from 'crypto';
import { validateTimelineEvent, EVENT_TYPES } from './timeline-schema.js';
import { createLogger } from '../logger.js';

const log = createLogger('error-pattern-detector');

/**
 * ErrorPatternDetector — Detects error patterns and emits constraint recommendations.
 */
export class ErrorPatternDetector {
  /**
   * @param {Object} options
   * @param {number} [options.windowMs=3600000] - Sliding window size in milliseconds (default: 1 hour)
   * @param {number} [options.threshold=4] - Number of failures to trigger constraint (>3 means 4+)
   * @param {Object} [options.timelineStore] - Timeline store instance for emitting events
   * @param {Object} [options.constraintStore] - ErrorPatternConstraintStore for persisting constraints
   * @param {number} [options.defaultTtlMs=7200000] - Default TTL for constraints (default: 2 hours)
   * @param {Function} [options.nowFn] - Optional function to get current time (for testing)
   */
  constructor({ windowMs = 3600000, threshold = 4, timelineStore, constraintStore, defaultTtlMs = 7200000, nowFn = Date.now } = {}) {
    if (!timelineStore) {
      throw new TypeError('timelineStore is required');
    }

    this.windowMs = windowMs;
    this.threshold = threshold;
    this.timelineStore = timelineStore;
    this.constraintStore = constraintStore;
    this.defaultTtlMs = defaultTtlMs;
    this._nowFn = nowFn;

    // Sliding window: Map<agentId, Map<category, Array<{timestamp, dispatchId, errorClassification}>>>
    this.windows = new Map();

    // Track emitted patterns to prevent duplicate emissions: Set<patternId>
    this.emittedPatterns = new Set();

    // Track pattern metadata: Map<patternId, {agentId, category, triggeringDispatchIds, rootCorrelationId}>
    this.patterns = new Map();
  }

  /**
   * Record a failure and check if it triggers a constraint recommendation.
   *
   * @param {string} agentId - Agent identifier
   * @param {string} category - Error category (e.g., from ERROR_CATEGORIES)
   * @param {string} errorClassification - Detailed classification of the error
   * @param {string} dispatchId - Dispatch ID that triggered this failure
   * @param {string} [traceId] - Optional trace ID for correlation
   */
  recordFailure(agentId, category, errorClassification, dispatchId, traceId) {
    if (!agentId || !category || !errorClassification || !dispatchId) {
      log.warn('recordFailure: missing required parameters', { agentId, category, errorClassification, dispatchId });
      return;
    }

    const now = this._nowFn();
    const windowKey = `${agentId}:${category}`;

    // Initialize window for this agent+category pair if needed
    if (!this.windows.has(agentId)) {
      this.windows.set(agentId, new Map());
    }
    if (!this.windows.get(agentId).has(category)) {
      this.windows.get(agentId).set(category, []);
    }

    const window = this.windows.get(agentId).get(category);

    // Prune expired entries (sliding window)
    this._pruneExpired(window, now);

    // Add new failure entry
    window.push({
      timestamp: now,
      dispatchId,
      errorClassification,
      traceId,
    });

    // Check if threshold is exceeded (>3 failures means 4+)
    if (window.length >= this.threshold) {
      this._emitConstraint(agentId, category, window);
    }
  }

  /**
   * Prune expired entries from a sliding window.
   *
   * @param {Array} window - Array of failure entries
   * @param {number} now - Current timestamp in ms
   */
  _pruneExpired(window, now) {
    const cutoff = now - this.windowMs;
    
    // Filter out entries older than the window (strictly less than cutoff are expired)
    const pruned = window.filter(entry => entry.timestamp >= cutoff);

    // Replace array contents in-place to maintain references
    while (window.length > 0) {
      window.pop();
    }
    window.push(...pruned);
  }

  /**
   * Emit a constraint recommendation event when threshold is exceeded.
   *
   * @param {string} agentId - Agent identifier
   * @param {string} category - Error category
   * @param {Array} window - Current window of failures
   */
  _emitConstraint(agentId, category, window) {
    const patternId = `pattern-${agentId}-${category}-${Math.floor(Date.now() / 60000)}`;

    // Check for duplicate emission (idempotency)
    if (this.emittedPatterns.has(patternId)) {
      log.debug('Pattern already emitted, skipping duplicate', { patternId, agentId, category });
      return;
    }

    const triggeringDispatchIds = window.map(entry => entry.dispatchId);
    const rootCorrelationId = `pattern-${patternId}`;
    const now = this._nowFn();
    const expiresAt = new Date(now + this.defaultTtlMs).toISOString();

    // Create timeline event with full causal correlation
    const event = {
      id: `constraint-${randomUUID()}`,
      type: EVENT_TYPES.ERROR_PATTERN_CONSTRAINT,
      timestamp: new Date().toISOString(),
      summary: `Error pattern detected: ${category} for agent ${agentId}`,
      correlationKeys: {
        agentId,
        dispatchId: triggeringDispatchIds[0],
        traceId: window[0]?.traceId || null,
      },
      data: {
        agentId,
        errorCategory: category,
        patternId,
        triggeringDispatchIds,
        parentCorrelationId: triggeringDispatchIds[0],
        rootCorrelationId,
      },
    };

    // Validate event before emission
    const validation = validateTimelineEvent(event);
    if (!validation.valid) {
      log.error('Timeline event validation failed', { errors: validation.errors });
      return;
    }

    // Emit to timeline store
    try {
      this.timelineStore.appendRoutingEvent(event);
      log.info('Emitted error pattern constraint', {
        patternId,
        agentId,
        category,
        failureCount: window.length,
        triggeringDispatchIds: triggeringDispatchIds.slice(0, 5), // Log first 5
      });
    } catch (err) {
      log.error('Failed to emit timeline event', { error: err.message });
      return;
    }

    // Add constraint to constraint store if available
    if (this.constraintStore) {
      try {
        const constraintId = this.constraintStore.add({
          agentId,
          errorCategory: category,
          penaltyFactor: 0.2,
          patternId,
          triggeringFailures: triggeringDispatchIds,
          expiresAt,
        });
        log.info('Added error pattern constraint to store', {
          patternId,
          constraintId,
          agentId,
          category,
          expiresAt,
        });
      } catch (err) {
        log.error('Failed to add constraint to store', { error: err.message });
      }
    }

    // Track emitted pattern
    this.emittedPatterns.add(patternId);
    this.patterns.set(patternId, {
      agentId,
      category,
      triggeringDispatchIds,
      rootCorrelationId,
      createdAt: new Date().toISOString(),
      expiresAt,
    });
  }

  /**
   * Get all active patterns (patterns that have been emitted but not cleared).
   *
   * @returns {Array<Object>} Array of active pattern objects
   */
  getActivePatterns() {
    return Array.from(this.patterns.values());
  }

  /**
   * Clear a specific pattern by patternId.
   * This allows operator override and removes the pattern from tracking.
   *
   * @param {string} patternId - Pattern identifier to clear
   * @returns {boolean} True if pattern was found and cleared, false otherwise
   */
  clearPattern(patternId) {
    const found = this.patterns.delete(patternId);
    this.emittedPatterns.delete(patternId);

    if (found) {
      log.info('Cleared error pattern', { patternId });
    } else {
      log.debug('Pattern not found for clearance', { patternId });
    }

    return found;
  }

  /**
   * Get the current window size for a specific agent+category pair.
   *
   * @param {string} agentId - Agent identifier
   * @param {string} category - Error category
   * @param {number} now - Current timestamp (for testing)
   * @returns {number} Number of failures in the current window
   */
  _getWindowSize(agentId, category, now = Date.now()) {
    if (!this.windows.has(agentId)) {
      return 0;
    }
    const agentWindows = this.windows.get(agentId);
    if (!agentWindows.has(category)) {
      return 0;
    }

    const window = agentWindows.get(category);
    this._pruneExpired(window, now);
    return window.length;
  }

  /**
   * Reset the detector state (for testing purposes).
   */
  reset() {
    this.windows.clear();
    this.emittedPatterns.clear();
    this.patterns.clear();
  }
}

export default ErrorPatternDetector;
