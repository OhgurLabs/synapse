/**
 * Error Aggregator
 *
 * Tracks error patterns and trends for MCP tool invocations.
 * Provides insights for monitoring, alerting, and debugging.
 */

import { createLogger } from '../logger.js';

const log = createLogger('error-aggregator');

/**
 * ErrorAggregator - Collects and analyzes error patterns.
 */
export class ErrorAggregator {
  constructor(options = {}) {
    this.maxHistorySize = options.maxHistorySize || 10000;
    this.windowSizeMs = options.windowSizeMs || 3600000; // 1 hour default
    this.aggregationIntervalMs = options.aggregationIntervalMs || 60000; // 1 minute default

    // Error history storage
    this._errors = [];
    this._errorsByTool = new Map();
    this._errorsByCategory = new Map();
    this._errorsByCode = new Map();
    this._errorsByServer = new Map();

    // Aggregated statistics
    this._stats = {
      totalErrors: 0,
      errorRate: 0,
      lastAggregationTime: Date.now(),
      topErrors: [],
      topFailingTools: [],
      topFailingServers: []
    };

    // Error pattern detection
    this._patterns = {
      repeatedErrors: new Map(), // toolName → { count, firstSeen, lastSeen, errorCode }
      cascadingFailures: [], // { serverId, count, timeWindow }
      rateSpikes: [] // { category, baseline, current, timestamp }
    };

    log.info('ErrorAggregator initialized', {
      maxHistorySize: this.maxHistorySize,
      windowSizeMs: this.windowSizeMs
    });
  }

  /**
   * Record an error occurrence.
   *
   * @param {Object} error - Processed error from ErrorResponseProcessor
   * @param {Object} context - Additional context
   */
  recordError(error, context = {}) {
    const timestamp = Date.now();

    const errorRecord = {
      timestamp,
      code: error.code,
      category: error.category,
      severity: error.severity,
      toolName: error.toolName,
      serverId: error.serverId,
      retryable: error.retryable,
      message: error.message,
      elapsedMs: error.elapsedMs,
      context
    };

    // Add to history
    this._errors.push(errorRecord);
    if (this._errors.length > this.maxHistorySize) {
      this._errors.shift();
    }

    // Update per-tool errors
    if (error.toolName) {
      if (!this._errorsByTool.has(error.toolName)) {
        this._errorsByTool.set(error.toolName, []);
      }
      this._errorsByTool.get(error.toolName).push(errorRecord);
      this._trimErrorList(this._errorsByTool.get(error.toolName));
    }

    // Update per-category errors
    if (error.category) {
      if (!this._errorsByCategory.has(error.category)) {
        this._errorsByCategory.set(error.category, []);
      }
      this._errorsByCategory.get(error.category).push(errorRecord);
      this._trimErrorList(this._errorsByCategory.get(error.category));
    }

    // Update per-code errors
    if (error.code) {
      if (!this._errorsByCode.has(error.code)) {
        this._errorsByCode.set(error.code, []);
      }
      this._errorsByCode.get(error.code).push(errorRecord);
      this._trimErrorList(this._errorsByCode.get(error.code));
    }

    // Update per-server errors
    if (error.serverId) {
      if (!this._errorsByServer.has(error.serverId)) {
        this._errorsByServer.set(error.serverId, []);
      }
      this._errorsByServer.get(error.serverId).push(errorRecord);
      this._trimErrorList(this._errorsByServer.get(error.serverId));
    }

    // Update statistics
    this._stats.totalErrors++;

    // Detect error patterns
    this._detectPatterns(errorRecord);

    log.debug({ code: error.code, category: error.category, toolName: error.toolName }, 'Error recorded');
  }

  /**
   * Get aggregated error statistics.
   *
   * @returns {Object} Aggregated statistics
   */
  getStatistics() {
    const now = Date.now();
    const windowStart = now - this.windowSizeMs;

    // Filter recent errors
    const recentErrors = this._errors.filter(e => e.timestamp >= windowStart);

    // Calculate error rate (errors per second) with minimum precision
    const rawErrorRate = recentErrors.length / (this.windowSizeMs / 1000);
    const errorRate = recentErrors.length > 0 ? Math.max(rawErrorRate, 0.01) : 0;

    // Top error codes
    const errorCodeCounts = new Map();
    for (const error of recentErrors) {
      const count = errorCodeCounts.get(error.code) || 0;
      errorCodeCounts.set(error.code, count + 1);
    }
    const topErrors = Array.from(errorCodeCounts.entries())
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Top failing tools
    const toolCounts = new Map();
    for (const error of recentErrors) {
      if (error.toolName) {
        const count = toolCounts.get(error.toolName) || 0;
        toolCounts.set(error.toolName, count + 1);
      }
    }
    const topFailingTools = Array.from(toolCounts.entries())
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Top failing servers
    const serverCounts = new Map();
    for (const error of recentErrors) {
      if (error.serverId) {
        const count = serverCounts.get(error.serverId) || 0;
        serverCounts.set(error.serverId, count + 1);
      }
    }
    const topFailingServers = Array.from(serverCounts.entries())
      .map(([serverId, count]) => ({ serverId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Error distribution by category
    const categoryDistribution = new Map();
    for (const error of recentErrors) {
      if (error.category) {
        const count = categoryDistribution.get(error.category) || 0;
        categoryDistribution.set(error.category, count + 1);
      }
    }

    // Error distribution by severity
    const severityDistribution = new Map();
    for (const error of recentErrors) {
      if (error.severity) {
        const count = severityDistribution.get(error.severity) || 0;
        severityDistribution.set(error.severity, count + 1);
      }
    }

    return {
      totalErrors: this._stats.totalErrors,
      recentErrors: recentErrors.length,
      windowSizeMs: this.windowSizeMs,
      errorRate: Math.round(errorRate * 100) / 100,
      topErrors,
      topFailingTools,
      topFailingServers,
      categoryDistribution: Object.fromEntries(categoryDistribution),
      severityDistribution: Object.fromEntries(severityDistribution),
      lastUpdated: now
    };
  }

  /**
   * Get errors for a specific tool.
   *
   * @param {string} toolName - Tool name
   * @param {number} [limit=100] - Maximum errors to return
   * @returns {Array<Object>} Recent errors for the tool
   */
  getToolErrors(toolName, limit = 100) {
    const errors = this._errorsByTool.get(toolName) || [];
    return errors.slice(-limit);
  }

  /**
   * Get errors for a specific category.
   *
   * @param {string} category - Error category
   * @param {number} [limit=100] - Maximum errors to return
   * @returns {Array<Object>} Recent errors in the category
   */
  getCategoryErrors(category, limit = 100) {
    const errors = this._errorsByCategory.get(category) || [];
    return errors.slice(-limit);
  }

  /**
   * Get errors for a specific error code.
   *
   * @param {string} code - Error code
   * @param {number} [limit=100] - Maximum errors to return
   * @returns {Array<Object>} Recent errors with the code
   */
  getCodeErrors(code, limit = 100) {
    const errors = this._errorsByCode.get(code) || [];
    return errors.slice(-limit);
  }

  /**
   * Get errors for a specific server.
   *
   * @param {string} serverId - Server ID
   * @param {number} [limit=100] - Maximum errors to return
   * @returns {Array<Object>} Recent errors for the server
   */
  getServerErrors(serverId, limit = 100) {
    const errors = this._errorsByServer.get(serverId) || [];
    return errors.slice(-limit);
  }

  /**
   * Get detected error patterns.
   *
   * @returns {Object} Detected patterns
   */
  getPatterns() {
    return {
      repeatedErrors: Array.from(this._patterns.repeatedErrors.entries()).map(([toolName, pattern]) => ({
        toolName,
        ...pattern
      })),
      cascadingFailures: this._patterns.cascadingFailures,
      rateSpikes: this._patterns.rateSpikes
    };
  }

  /**
   * Clear all error history.
   */
  clear() {
    this._errors = [];
    this._errorsByTool.clear();
    this._errorsByCategory.clear();
    this._errorsByCode.clear();
    this._errorsByServer.clear();
    this._patterns.repeatedErrors.clear();
    this._patterns.cascadingFailures = [];
    this._patterns.rateSpikes = [];
    this._stats.totalErrors = 0;
    this._stats.lastAggregationTime = Date.now();

    log.info('Error history cleared');
  }

  /**
   * Detect error patterns in recorded errors.
   *
   * @private
   * @param {Object} errorRecord - New error record
   */
  _detectPatterns(errorRecord) {
    const now = Date.now();
    const { toolName, code, serverId, category } = errorRecord;

    // Detect repeated errors for the same tool
    if (toolName && code) {
      const key = toolName;
      if (!this._patterns.repeatedErrors.has(key)) {
        this._patterns.repeatedErrors.set(key, {
          count: 1,
          firstSeen: now,
          lastSeen: now,
          errorCode: code
        });
      } else {
        const pattern = this._patterns.repeatedErrors.get(key);
        pattern.count++;
        pattern.lastSeen = now;
        pattern.errorCode = code;

        // Log if repeated errors exceed threshold
        if (pattern.count >= 5) {
          log.warn({
            toolName,
            errorCode: code,
            count: pattern.count,
            duration: now - pattern.firstSeen
          }, 'Repeated error pattern detected');
        }
      }
    }

    // Detect cascading failures (multiple errors from same server in short time)
    if (serverId) {
      const recentServerErrors = this._errorsByServer.get(serverId) || [];
      const windowStart = now - 60000; // 1 minute window
      const recentCount = recentServerErrors.filter(e => e.timestamp >= windowStart).length;

      if (recentCount >= 10) {
        // Check if already recorded
        const existing = this._patterns.cascadingFailures.find(
          f => f.serverId === serverId && now - f.timestamp < 60000
        );

        if (!existing) {
          this._patterns.cascadingFailures.push({
            serverId,
            count: recentCount,
            timeWindow: '1m',
            timestamp: now
          });

          log.warn({
            serverId,
            errorCount: recentCount
          }, 'Cascading failure detected');
        }
      }
    }

    // Detect rate spikes (sudden increase in error rate for a category)
    if (category) {
      const recentCategoryErrors = this._errorsByCategory.get(category) || [];
      const windowStart = now - 300000; // 5 minute window
      const recentCount = recentCategoryErrors.filter(e => e.timestamp >= windowStart).length;
      const currentRate = recentCount / 300; // errors per second

      // Calculate baseline rate (previous 5 minutes)
      const baselineStart = now - 600000;
      const baselineEnd = now - 300000;
      const baselineCount = recentCategoryErrors.filter(
        e => e.timestamp >= baselineStart && e.timestamp < baselineEnd
      ).length;
      const baselineRate = baselineCount / 300;

      // Detect spike if current rate is 3x baseline
      if (baselineRate > 0 && currentRate > baselineRate * 3) {
        const existing = this._patterns.rateSpikes.find(
          s => s.category === category && now - s.timestamp < 300000
        );

        if (!existing) {
          this._patterns.rateSpikes.push({
            category,
            baseline: Math.round(baselineRate * 100) / 100,
            current: Math.round(currentRate * 100) / 100,
            timestamp: now
          });

          log.warn({
            category,
            baselineRate,
            currentRate,
            multiplier: currentRate / baselineRate
          }, 'Error rate spike detected');
        }
      }
    }

    // Cleanup old patterns periodically
    if (now - this._stats.lastAggregationTime > this.aggregationIntervalMs) {
      this._cleanupOldPatterns(now);
      this._stats.lastAggregationTime = now;
    }
  }

  /**
   * Trim error list to prevent unbounded growth.
   *
   * @private
   * @param {Array<Object>} errorList - Error list to trim
   */
  _trimErrorList(errorList) {
    if (errorList.length > this.maxHistorySize / 10) {
      errorList.splice(0, errorList.length - (this.maxHistorySize / 10));
    }
  }

  /**
   * Clean up old pattern detections.
   *
   * @private
   * @param {number} now - Current timestamp
   */
  _cleanupOldPatterns(now) {
    const patternTTL = 3600000; // 1 hour

    // Clean up repeated error patterns
    for (const [key, pattern] of this._patterns.repeatedErrors.entries()) {
      if (now - pattern.lastSeen > patternTTL) {
        this._patterns.repeatedErrors.delete(key);
      }
    }

    // Clean up cascading failures
    this._patterns.cascadingFailures = this._patterns.cascadingFailures.filter(
      f => now - f.timestamp < patternTTL
    );

    // Clean up rate spikes
    this._patterns.rateSpikes = this._patterns.rateSpikes.filter(
      s => now - s.timestamp < patternTTL
    );
  }
}

/**
 * Create an ErrorAggregator instance.
 *
 * @param {Object} options - Configuration options
 * @returns {ErrorAggregator}
 */
export function createErrorAggregator(options = {}) {
  return new ErrorAggregator(options);
}
