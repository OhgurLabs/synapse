/**
 * FallbackPriorityRanker
 *
 * Ranks alternative tools for fallback selection based on multiple criteria:
 * - Server priority configuration
 * - Historical success rates
 * - Response latency metrics
 * - Compatibility scores
 *
 * Features:
 * - Multi-criteria ranking with configurable weights
 * - Historical metrics tracking per tool
 * - Server priority-based ordering
 * - Latency-aware selection
 * - Success rate optimization
 * - Cache for ranking results
 *
 * Usage:
 *   const ranker = new FallbackPriorityRanker();
 *   const rankedTools = ranker.rankTools(primaryTool, candidateTools, metrics);
 *   const bestFallback = rankedTools[0];
 */

import { createLogger } from '../../logger.js';
import { DEFAULT_PRIORITIES } from './tool-conflict-resolver.js';

const log = createLogger('fallback-priority-ranker');

/**
 * Default ranking weights for different criteria
 * Weights should sum to 1.0
 */
export const DEFAULT_RANKING_WEIGHTS = {
  serverPriority: 0.25,
  successRate: 0.30,
  responseLatency: 0.25,
  compatibilityScore: 0.20
};

/**
 * Default configuration options
 */
export const DEFAULT_CONFIG = {
  minSuccessRateThreshold: 0.5,
  maxLatencyMultiplier: 3.0,
  historyWindowMs: 3600000,
  minHistorySamples: 3,
  enableMetricsTracking: true,
  rankingWeights: { ...DEFAULT_RANKING_WEIGHTS }
};

/**
 * FallbackPriorityRanker - Ranks alternative tools for fallback selection
 */
export class FallbackPriorityRanker {
  /**
   * @param {Object} options
   * @param {Object} options.rankingWeights - Weights for different ranking criteria
   * @param {number} options.minSuccessRateThreshold - Minimum success rate to consider a tool
   * @param {number} options.maxLatencyMultiplier - Max latency relative to best tool
   * @param {number} options.historyWindowMs - Time window for historical metrics
   * @param {number} options.minHistorySamples - Minimum samples for reliable metrics
   * @param {Object} options.serverPriorities - Custom server priority mappings
   * @param {boolean} options.enableMetricsTracking - Enable metrics tracking
   */
  constructor(options = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...(options.rankingWeights ? { rankingWeights: { ...DEFAULT_RANKING_WEIGHTS, ...options.rankingWeights } } : {}),
      minSuccessRateThreshold: options.minSuccessRateThreshold ?? DEFAULT_CONFIG.minSuccessRateThreshold,
      maxLatencyMultiplier: options.maxLatencyMultiplier ?? DEFAULT_CONFIG.maxLatencyMultiplier,
      historyWindowMs: options.historyWindowMs ?? DEFAULT_CONFIG.historyWindowMs,
      minHistorySamples: options.minHistorySamples ?? DEFAULT_CONFIG.minHistorySamples,
      enableMetricsTracking: options.enableMetricsTracking ?? DEFAULT_CONFIG.enableMetricsTracking,
      serverPriorities: options.serverPriorities || {}
    };

    // Historical metrics storage: toolKey → { successes, failures, latencies }
    this._metrics = new Map();

    // Ranking cache: cacheKey → ranked results
    this._rankingCache = new Map();

    // Server priority mappings (extends DEFAULT_PRIORITIES)
    this._serverPriorities = {
      ...DEFAULT_PRIORITIES,
      ...this.config.serverPriorities
    };

    log.info('FallbackPriorityRanker initialized', {
      weights: this.config.rankingWeights,
      minSuccessRateThreshold: this.config.minSuccessRateThreshold,
      historyWindowMs: this.config.historyWindowMs
    });
  }

  /**
   * Rank a list of candidate fallback tools.
   *
   * @param {Object} primaryTool - Primary tool that failed
   * @param {Array<Object>} candidateTools - Candidate fallback tools
   * @param {Object} options - Ranking options
   * @param {Object} options.metrics - Historical metrics (optional, uses internal tracking if not provided)
   * @param {Object} options.parameters - Parameters being passed (for compatibility scoring)
   * @param {Array<Object>} options.compatibilityResults - Pre-computed compatibility analysis results
   * @returns {Array<Object>} Ranked list of tools with scores
   */
  rankTools(primaryTool, candidateTools, options = {}) {
    const cacheKey = this._getCacheKey(primaryTool, candidateTools, options);

    if (this._rankingCache.has(cacheKey)) {
      log.debug({ cacheKey }, 'Ranking cache hit');
      return this._rankingCache.get(cacheKey);
    }

    log.debug({
      primaryTool: primaryTool?.name,
      candidateCount: candidateTools?.length
    }, 'Ranking fallback tools');

    const metrics = options.metrics || this._metrics;
    const parameters = options.parameters || {};
    const compatibilityResults = options.compatibilityResults || {};

    const rankedTools = candidateTools.map(tool => {
      const toolKey = this._getToolKey(tool);
      const serverId = this._extractServerId(tool.source);

      // Calculate individual scores for each criterion
      const serverPriorityScore = this._calculateServerPriorityScore(serverId);
      const successRateScore = this._calculateSuccessRateScore(toolKey, metrics);
      const latencyScore = this._calculateLatencyScore(toolKey, metrics, candidateTools, metrics);
      const compatibilityScore = this._getCompatibilityScore(
        tool,
        compatibilityResults,
        primaryTool,
        parameters
      );

      // Calculate weighted overall score
      const weights = this.config.rankingWeights;
      const overallScore =
        (serverPriorityScore * weights.serverPriority) +
        (successRateScore * weights.successRate) +
        (latencyScore * weights.responseLatency) +
        (compatibilityScore * weights.compatibilityScore);

      return {
        tool,
        toolKey,
        serverId,
        scores: {
          serverPriority: serverPriorityScore,
          successRate: successRateScore,
          responseLatency: latencyScore,
          compatibility: compatibilityScore
        },
        overallScore,
        metadata: {
          successRate: this._getSuccessRate(toolKey, metrics),
          avgLatencyMs: this._getAvgLatency(toolKey, metrics),
          sampleCount: this._getSampleCount(toolKey, metrics)
        }
      };
    });

    // Filter out tools below minimum success rate threshold
    // Tools with no history (successRate === null) are allowed through
    const filteredTools = rankedTools.filter(ranked => {
      const successRate = ranked.metadata.successRate;
      if (successRate !== null && successRate < this.config.minSuccessRateThreshold) {
        log.debug({
          toolName: ranked.tool.name,
          successRate,
          threshold: this.config.minSuccessRateThreshold
        }, 'Tool filtered out due to low success rate');
        return false;
      }
      return true;
    });

    // Sort by overall score (descending)
    filteredTools.sort((a, b) => b.overallScore - a.overallScore);

    // Cache the result
    this._rankingCache.set(cacheKey, filteredTools);

    log.debug({
      primaryTool: primaryTool?.name,
      rankedCount: filteredTools.length,
      topTool: filteredTools[0]?.tool.name,
      topScore: filteredTools[0]?.overallScore
    }, 'Tool ranking complete');

    return filteredTools;
  }

  /**
   * Calculate server priority score (normalized 0-1).
   *
   * @private
   * @param {string} serverId - Server identifier
   * @returns {number} Normalized priority score
   */
  _calculateServerPriorityScore(serverId) {
    const priority = this._getServerPriority(serverId);
    const maxPriority = Math.max(...Object.values(this._serverPriorities), priority);

    // Normalize to 0-1 range
    return maxPriority > 0 ? priority / maxPriority : 0.5;
  }

  /**
   * Calculate success rate score (0-1).
   *
   * @private
   * @param {string} toolKey - Tool identifier
   * @param {Map} metrics - Metrics storage
   * @returns {number} Success rate score
   */
  _calculateSuccessRateScore(toolKey, metrics) {
    const successRate = this._getSuccessRate(toolKey, metrics);

    // If no history, use neutral score
    if (successRate === null) {
      return 0.5;
    }

    return successRate;
  }

  /**
   * Calculate latency score (0-1, lower latency = higher score).
   *
   * @private
   * @param {string} toolKey - Tool identifier for current tool
   * @param {Map} metrics - Metrics storage
   * @param {Array<Object>} allTools - All candidate tools for relative comparison
   * @param {Map} allMetrics - All metrics for comparison
   * @returns {number} Latency score
   */
  _calculateLatencyScore(toolKey, metrics, allTools, allMetrics) {
    const avgLatency = this._getAvgLatency(toolKey, metrics);

    // If no history, use neutral score
    if (avgLatency === null) {
      return 0.5;
    }

    // Find minimum latency among all candidates for relative scoring
    let minLatency = avgLatency;
    for (const tool of allTools) {
      const otherKey = this._getToolKey(tool);
      const otherLatency = this._getAvgLatency(otherKey, allMetrics);
      if (otherLatency !== null && otherLatency < minLatency) {
        minLatency = otherLatency;
      }
    }

    // Calculate relative latency score
    // Tools with latency close to min get higher scores
    const maxLatency = minLatency * this.config.maxLatencyMultiplier;

    if (avgLatency <= minLatency) {
      return 1.0;
    }

    if (avgLatency >= maxLatency) {
      return 0.0;
    }

    // Linear interpolation between min and max
    return 1.0 - (avgLatency - minLatency) / (maxLatency - minLatency);
  }

  /**
   * Get compatibility score for a tool.
   *
   * @private
   * @param {Object} tool - Tool metadata
   * @param {Object} compatibilityResults - Pre-computed compatibility results
   * @param {Object} primaryTool - Primary tool
   * @param {Object} parameters - Parameters
   * @returns {number} Compatibility score (0-1)
   */
  _getCompatibilityScore(tool, compatibilityResults, primaryTool, parameters) {
    const toolKey = this._getToolKey(tool);

    if (compatibilityResults[toolKey]) {
      return compatibilityResults[toolKey].score ?? compatibilityResults[toolKey].compatibilityScore ?? 0.7;
    }

    // Default score if no compatibility analysis available
    return 0.7;
  }

  /**
   * Record a successful tool invocation.
   *
   * @param {string} toolKey - Tool identifier
   * @param {number} latencyMs - Response latency in milliseconds
   */
  recordSuccess(toolKey, latencyMs) {
    if (!this.config.enableMetricsTracking) {
      return;
    }

    const now = Date.now();
    this._ensureMetricsEntry(toolKey, now);

    const metrics = this._metrics.get(toolKey);
    metrics.successes.push(now);
    if (latencyMs !== undefined) {
      metrics.latencies.push({ timestamp: now, value: latencyMs });
    }

    this._cleanupOldMetrics(toolKey, now);
  }

  /**
   * Record a failed tool invocation.
   *
   * @param {string} toolKey - Tool identifier
   * @param {string} error - Error message (optional)
   */
  recordFailure(toolKey, error) {
    if (!this.config.enableMetricsTracking) {
      return;
    }

    const now = Date.now();
    this._ensureMetricsEntry(toolKey, now);

    const metrics = this._metrics.get(toolKey);
    metrics.failures.push(now);

    if (error) {
      const recentErrors = metrics.recentErrors || [];
      recentErrors.push({ timestamp: now, error });
      metrics.recentErrors = recentErrors.slice(-10); // Keep last 10 errors
    }

    this._cleanupOldMetrics(toolKey, now);
  }

  /**
   * Get success rate for a tool.
   *
   * @private
   * @param {string} toolKey - Tool identifier
   * @param {Map} metrics - Metrics storage
   * @returns {number|null} Success rate (0-1) or null if insufficient data
   */
  _getSuccessRate(toolKey, metrics) {
    const entry = metrics.get(toolKey);
    if (!entry) {
      return null;
    }

    const windowStart = Date.now() - this.config.historyWindowMs;
    const recentSuccesses = entry.successes.filter(t => t >= windowStart).length;
    const recentFailures = entry.failures.filter(t => t >= windowStart).length;
    const total = recentSuccesses + recentFailures;

    if (total < this.config.minHistorySamples) {
      return null;
    }

    return recentSuccesses / total;
  }

  /**
   * Get average latency for a tool.
   *
   * @private
   * @param {string} toolKey - Tool identifier
   * @param {Map} metrics - Metrics storage
   * @returns {number|null} Average latency in ms or null if insufficient data
   */
  _getAvgLatency(toolKey, metrics) {
    const entry = metrics.get(toolKey);
    if (!entry || !entry.latencies) {
      return null;
    }

    const windowStart = Date.now() - this.config.historyWindowMs;
    const recentLatencies = entry.latencies.filter(l => l.timestamp >= windowStart);

    if (recentLatencies.length < this.config.minHistorySamples) {
      return null;
    }

    const sum = recentLatencies.reduce((acc, l) => acc + l.value, 0);
    return sum / recentLatencies.length;
  }

  /**
   * Get sample count for a tool.
   *
   * @private
   * @param {string} toolKey - Tool identifier
   * @param {Map} metrics - Metrics storage
   * @returns {number} Total sample count
   */
  _getSampleCount(toolKey, metrics) {
    const entry = metrics.get(toolKey);
    if (!entry) {
      return 0;
    }

    const windowStart = Date.now() - this.config.historyWindowMs;
    const recentSuccesses = entry.successes.filter(t => t >= windowStart).length;
    const recentFailures = entry.failures.filter(t => t >= windowStart).length;

    return recentSuccesses + recentFailures;
  }

  /**
   * Get server priority.
   *
   * @private
   * @param {string} serverId - Server identifier
   * @returns {number} Priority value
   */
  _getServerPriority(serverId) {
    // Check for exact match first
    if (this._serverPriorities[serverId]) {
      return this._serverPriorities[serverId];
    }

    // Check for mcp: prefix
    if (serverId.startsWith('mcp:')) {
      return this._serverPriorities.mcp || DEFAULT_PRIORITIES.mcp;
    }

    // Default priority
    return this._serverPriorities.custom || DEFAULT_PRIORITIES.custom;
  }

  /**
   * Extract server ID from tool source.
   *
   * @private
   * @param {string} source - Tool source (e.g., "mcp:filesystem")
   * @returns {string} Server ID
   */
  _extractServerId(source) {
    if (!source) {
      return 'unknown';
    }

    // Remove "mcp:" prefix if present
    return source.replace(/^mcp:/, '');
  }

  /**
   * Generate tool key from tool object.
   *
   * @private
   * @param {Object} tool - Tool metadata
   * @returns {string} Tool key
   */
  _getToolKey(tool) {
    if (!tool) {
      return 'unknown';
    }

    // Use qualified name if available, otherwise construct from source and name
    if (tool.qualifiedName) {
      return tool.qualifiedName;
    }

    const serverId = this._extractServerId(tool.source);
    return `${serverId}:${tool.name}`;
  }

  /**
   * Ensure metrics entry exists for a tool.
   *
   * @private
   * @param {string} toolKey - Tool identifier
   * @param {number} now - Current timestamp
   */
  _ensureMetricsEntry(toolKey, now) {
    if (!this._metrics.has(toolKey)) {
      this._metrics.set(toolKey, {
        successes: [],
        failures: [],
        latencies: [],
        recentErrors: []
      });
    }
  }

  /**
   * Cleanup old metrics entries outside the history window.
   *
   * @private
   * @param {string} toolKey - Tool identifier
   * @param {number} now - Current timestamp
   */
  _cleanupOldMetrics(toolKey, now) {
    const entry = this._metrics.get(toolKey);
    if (!entry) {
      return;
    }

    const windowStart = now - this.config.historyWindowMs;

    // Cleanup old successes
    entry.successes = entry.successes.filter(t => t >= windowStart);

    // Cleanup old failures
    entry.failures = entry.failures.filter(t => t >= windowStart);

    // Cleanup old latencies
    if (entry.latencies) {
      entry.latencies = entry.latencies.filter(l => l.timestamp >= windowStart);
    }

    // Cleanup old errors
    if (entry.recentErrors) {
      entry.recentErrors = entry.recentErrors.filter(e => e.timestamp >= windowStart);
    }

    // Remove entry if empty
    if (entry.successes.length === 0 && entry.failures.length === 0) {
      this._metrics.delete(toolKey);
    }
  }

  /**
   * Generate cache key for ranking results.
   *
   * @private
   * @param {Object} primaryTool - Primary tool
   * @param {Array<Object>} candidateTools - Candidate tools
   * @param {Object} options - Ranking options
   * @returns {string} Cache key
   */
  _getCacheKey(primaryTool, candidateTools, options) {
    const primaryName = primaryTool?.name || 'unknown';
    const candidateNames = (candidateTools || []).map(t => t.name).sort().join(',');
    const paramKey = options.parameters ? JSON.stringify(Object.keys(options.parameters).sort()) : '';

    return `${primaryName}|${candidateNames}|${paramKey}`;
  }

  /**
   * Clear ranking cache.
   */
  clearCache() {
    this._rankingCache.clear();
    log.debug('Ranking cache cleared');
  }

  /**
   * Clear historical metrics.
   *
   * @param {string} [toolKey] - Optional tool key to clear (clears all if not provided)
   */
  clearMetrics(toolKey) {
    if (toolKey) {
      this._metrics.delete(toolKey);
      log.debug({ toolKey }, 'Metrics cleared for tool');
    } else {
      this._metrics.clear();
      log.debug('All metrics cleared');
    }
  }

  /**
   * Get metrics statistics for a tool.
   *
   * @param {string} toolKey - Tool identifier
   * @returns {Object} Metrics statistics
   */
  getMetrics(toolKey) {
    const entry = this._metrics.get(toolKey);
    if (!entry) {
      return {
        successRate: null,
        avgLatencyMs: null,
        sampleCount: 0,
        recentErrors: []
      };
    }

    return {
      successRate: this._getSuccessRate(toolKey, this._metrics),
      avgLatencyMs: this._getAvgLatency(toolKey, this._metrics),
      sampleCount: this._getSampleCount(toolKey, this._metrics),
      recentErrors: entry.recentErrors?.slice(-5) || []
    };
  }

  /**
   * Get metrics for all tracked tools.
   *
   * @returns {Object} Map of tool keys to metrics
   */
  getAllMetrics() {
    const result = {};
    for (const toolKey of this._metrics.keys()) {
      result[toolKey] = this.getMetrics(toolKey);
    }
    return result;
  }

  /**
   * Update server priority.
   *
   * @param {string} serverId - Server identifier
   * @param {number} priority - New priority value
   */
  setServerPriority(serverId, priority) {
    this._serverPriorities[serverId] = priority;
    this.clearCache(); // Invalidate cache due to priority change
    log.info({ serverId, priority }, 'Server priority updated');
  }

  /**
   * Get server priority.
   *
   * @param {string} serverId - Server identifier
   * @returns {number} Current priority value
   */
  getServerPriority(serverId) {
    return this._getServerPriority(serverId);
  }

  /**
   * Update ranking weights.
   *
   * @param {Object} weights - New weight configuration
   */
  setRankingWeights(weights) {
    this.config.rankingWeights = {
      ...DEFAULT_RANKING_WEIGHTS,
      ...weights
    };
    this.clearCache(); // Invalidate cache due to weight change
    log.info({ weights: this.config.rankingWeights }, 'Ranking weights updated');
  }

  /**
   * Get current configuration.
   *
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      ...this.config,
      serverPriorities: { ...this._serverPriorities }
    };
  }
}
