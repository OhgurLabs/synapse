/**
 * Execution Metrics Collector
 *
 * Collects and aggregates performance metrics for MCP tool invocations.
 * Provides monitoring capabilities for timeout enforcement, latency tracking,
 * and error rate analysis.
 *
 * Features:
 * - Per-tool and aggregate metrics collection
 * - Latency percentiles (p50, p90, p95, p99)
 * - Timeout tracking and alerting thresholds
 * - Error categorization and rate calculation
 * - Time-windowed rolling statistics
 * - Memory-efficient circular buffer for recent invocations
 */

import { createLogger } from '../logger.js';
import config from '../config.js';

const log = createLogger('mcp-execution-metrics');

/**
 * ExecutionMetric — Single invocation metric record.
 *
 * @typedef {Object} ExecutionMetric
 * @property {string} toolName - Name of the invoked tool
 * @property {string} serverId - MCP server ID
 * @property {number} timestamp - Invocation timestamp (ms epoch)
 * @property {number} startTime - Invocation start timestamp (ms epoch)
 * @property {number} endTime - Invocation end timestamp (ms epoch)
 * @property {number} elapsedMs - Total elapsed time (ms)
 * @property {number} timeoutMs - Configured timeout (ms)
 * @property {string} status - Final status (success, timeout, error)
 * @property {string} [errorCode] - Error code if failed
 * @property {number} [retryCount] - Number of retries attempted
 * @property {number} [chunkCount] - Number of chunks (for streaming)
 * @property {boolean} [isStreaming] - Whether streaming was used
 */

/**
 * ToolMetricsSummary — Aggregated metrics for a single tool.
 *
 * @typedef {Object} ToolMetricsSummary
 * @property {string} toolName - Tool name
 * @property {number} totalInvocations - Total invocation count
 * @property {number} successCount - Successful invocations
 * @property {number} timeoutCount - Timeout failures
 * @property {number} errorCount - Other errors
 * @property {number} avgElapsedMs - Average elapsed time (ms)
 * @property {number} minElapsedMs - Minimum elapsed time (ms)
 * @property {number} maxElapsedMs - Maximum elapsed time (ms)
 * @property {number} p50ElapsedMs - 50th percentile latency (ms)
 * @property {number} p90ElapsedMs - 90th percentile latency (ms)
 * @property {number} p95ElapsedMs - 95th percentile latency (ms)
 * @property {number} p99ElapsedMs - 99th percentile latency (ms)
 * @property {number} successRate - Success rate (0-1)
 * @property {number} timeoutRate - Timeout rate (0-1)
 * @property {number} errorRate - Error rate (0-1)
 * @property {number} lastInvocationTime - Last invocation timestamp
 * @property {number} firstInvocationTime - First invocation timestamp
 */

/**
 * AggregateMetricsSummary — Overall metrics across all tools.
 *
 * @typedef {Object} AggregateMetricsSummary
 * @property {number} totalInvocations - Total invocations across all tools
 * @property {number} successCount - Total successful invocations
 * @property {number} timeoutCount - Total timeout failures
 * @property {number} errorCount - Total other errors
 * @property {number} avgElapsedMs - Average elapsed time (ms)
 * @property {number} p50ElapsedMs - 50th percentile latency (ms)
 * @property {number} p90ElapsedMs - 90th percentile latency (ms)
 * @property {number} p95ElapsedMs - 95th percentile latency (ms)
 * @property {number} p99ElapsedMs - 99th percentile latency (ms)
 * @property {number} successRate - Overall success rate (0-1)
 * @property {number} timeoutRate - Overall timeout rate (0-1)
 * @property {number} errorRate - Overall error rate (0-1)
 * @property {number} uniqueTools - Number of unique tools invoked
 * @property {Object} byTool - Per-tool summaries
 */

/**
 * AlertThresholds — Configurable alerting thresholds.
 *
 * @typedef {Object} AlertThresholds
 * @property {number} [timeoutRateThreshold=0.1] - Alert if timeout rate exceeds this (0-1)
 * @property {number} [errorRateThreshold=0.05] - Alert if error rate exceeds this (0-1)
 * @property {number} [p95LatencyThresholdMs=10000] - Alert if p95 latency exceeds this (ms)
 * @property {number} [minSampleSize=10] - Minimum samples before evaluating thresholds
 */

export class ExecutionMetricsCollector {
  /**
   * Create an ExecutionMetricsCollector instance.
   *
   * @param {Object} [options] - Configuration options
   * @param {number} [options.maxHistorySize=10000] - Maximum metrics to retain in memory
   * @param {number} [options.retentionWindowMs=3600000] - Retention window in ms (default 1 hour)
   * @param {AlertThresholds} [options.alertThresholds] - Alerting thresholds
   */
  constructor(options = {}) {
    this._maxHistorySize = options.maxHistorySize ?? 10000;
    this._retentionWindowMs = options.retentionWindowMs ?? config.mcp.toolInvocationTimeoutMs * 12; // 12x default timeout
    this._alertThresholds = {
      timeoutRateThreshold: 0.1,
      errorRateThreshold: 0.05,
      p95LatencyThresholdMs: 10000,
      minSampleSize: 10,
      ...options.alertThresholds
    };

    // Main metrics storage (circular buffer behavior via shift)
    this._metrics = [];
    
    // Per-tool indexed data for efficient lookups
    this._toolIndices = new Map(); // toolName -> { firstIdx, lastIdx, count }
    
    // Cache for computed summaries (invalidated on new metric)
    this._cachedSummaries = null;
    this._cachedAggregate = null;
    
    log.debug('Execution metrics collector initialized', {
      maxHistorySize: this._maxHistorySize,
      retentionWindowMs: this._retentionWindowMs,
      alertThresholds: this._alertThresholds
    });
  }

  /**
   * Record a metric for a tool invocation.
   *
   * @param {ExecutionMetric} metric - Metric to record
   */
  record(metric) {
    if (!metric || typeof metric !== 'object') {
      log.warn('Invalid metric object, skipping');
      return;
    }

    // Ensure timestamp is set before validation
    if (!('timestamp' in metric)) {
      metric.timestamp = Date.now();
    }

    const requiredFields = ['toolName', 'timestamp', 'elapsedMs', 'status'];
    for (const field of requiredFields) {
      if (!(field in metric)) {
        log.warn(`Missing required field ${field}, skipping metric`);
        return;
      }
    }

    // Add to metrics array
    const idx = this._metrics.length;
    this._metrics.push(metric);

    // Update tool index
    if (!this._toolIndices.has(metric.toolName)) {
      this._toolIndices.set(metric.toolName, {
        firstIdx: idx,
        lastIdx: idx,
        count: 1
      });
    } else {
      const toolIdx = this._toolIndices.get(metric.toolName);
      toolIdx.lastIdx = idx;
      toolIdx.count++;
    }

    // Invalidate caches
    this._cachedSummaries = null;
    this._cachedAggregate = null;

    // Enforce max history size (circular buffer behavior)
    if (this._metrics.length > this._maxHistorySize) {
      const removedCount = this._metrics.length - this._maxHistorySize;
      this._metrics.shift();
      
      // Rebuild indices after removal
      this._rebuildIndices();
      
      if (removedCount > 1) {
        log.debug(`Trimmed ${removedCount} old metrics from history`);
      }
    }

    // Check alert thresholds periodically (every 100 metrics)
    if (this._metrics.length % 100 === 0) {
      this._checkAlertThresholds();
    }
  }

  /**
   * Rebuild tool indices after history trimming.
   * @private
   */
  _rebuildIndices() {
    this._toolIndices.clear();
    
    for (let i = 0; i < this._metrics.length; i++) {
      const metric = this._metrics[i];
      const toolName = metric.toolName;
      
      if (!this._toolIndices.has(toolName)) {
        this._toolIndices.set(toolName, {
          firstIdx: i,
          lastIdx: i,
          count: 1
        });
      } else {
        const toolIdx = this._toolIndices.get(toolName);
        toolIdx.lastIdx = i;
        toolIdx.count++;
      }
    }
  }

  /**
   * Check alert thresholds and log warnings if exceeded.
   * @private
   */
  _checkAlertThresholds() {
    const aggregate = this.getAggregateSummary();
    
    if (aggregate.totalInvocations < this._alertThresholds.minSampleSize) {
      return; // Not enough data
    }

    const alerts = [];

    if (aggregate.timeoutRate > this._alertThresholds.timeoutRateThreshold) {
      alerts.push(`timeout rate ${Math.round(aggregate.timeoutRate * 100)}% > ${Math.round(this._alertThresholds.timeoutRateThreshold * 100)}%`);
    }

    if (aggregate.errorRate > this._alertThresholds.errorRateThreshold) {
      alerts.push(`error rate ${Math.round(aggregate.errorRate * 100)}% > ${Math.round(this._alertThresholds.errorRateThreshold * 100)}%`);
    }

    if (aggregate.p95ElapsedMs > this._alertThresholds.p95LatencyThresholdMs) {
      alerts.push(`p95 latency ${aggregate.p95ElapsedMs}ms > ${this._alertThresholds.p95LatencyThresholdMs}ms`);
    }

    if (alerts.length > 0) {
      log.warn('Alert thresholds exceeded', {
        alerts,
        totalInvocations: aggregate.totalInvocations,
        successRate: Math.round(aggregate.successRate * 100) + '%',
        timeoutRate: Math.round(aggregate.timeoutRate * 100) + '%',
        errorRate: Math.round(aggregate.errorRate * 100) + '%',
        p95ElapsedMs: aggregate.p95ElapsedMs
      });
    }
  }

  /**
   * Get metrics for a specific tool within a time window.
   *
   * @param {string} toolName - Tool name
   * @param {number} [windowMs] - Time window in ms (defaults to retention window)
   * @returns {ExecutionMetric[]} Metrics for the tool
   */
  getToolMetrics(toolName, windowMs = null) {
    const cutoffTime = (windowMs ?? this._retentionWindowMs);
    const now = Date.now();
    
    return this._metrics.filter(m => 
      m.toolName === toolName && 
      m.timestamp >= now - cutoffTime
    );
  }

  /**
   * Get all metrics within a time window.
   *
   * @param {number} [windowMs] - Time window in ms (defaults to retention window)
   * @returns {ExecutionMetric[]} All metrics in window
   */
  getMetrics(windowMs = null) {
    const cutoffTime = windowMs ?? this._retentionWindowMs;
    const now = Date.now();
    
    return this._metrics.filter(m => m.timestamp >= now - cutoffTime);
  }

  /**
   * Get recent metrics (most recent N).
   *
   * @param {number} [limit=100] - Maximum number of metrics to return
   * @returns {ExecutionMetric[]} Recent metrics
   */
  getRecentMetrics(limit = 100) {
    const start = Math.max(0, this._metrics.length - limit);
    return this._metrics.slice(start);
  }

  /**
   * Calculate percentile from sorted array.
   *
   * @private
   * @param {number[]} sorted - Sorted array of values
   * @param {number} percentile - Percentile (0-100)
   * @returns {number} Percentile value
   */
  _percentile(sorted, percentile) {
    if (sorted.length === 0) return 0;
    if (sorted.length === 1) return sorted[0];
    
    const idx = (percentile / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    const weight = idx - lower;
    
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /**
   * Compute summary metrics for a single tool.
   *
   * @param {ExecutionMetric[]} metrics - Metrics for the tool
   * @returns {ToolMetricsSummary} Computed summary
   */
  computeToolSummary(metrics) {
    if (!metrics || metrics.length === 0) {
      return {
        totalInvocations: 0,
        successCount: 0,
        timeoutCount: 0,
        errorCount: 0,
        avgElapsedMs: 0,
        minElapsedMs: 0,
        maxElapsedMs: 0,
        p50ElapsedMs: 0,
        p90ElapsedMs: 0,
        p95ElapsedMs: 0,
        p99ElapsedMs: 0,
        successRate: 0,
        timeoutRate: 0,
        errorRate: 0,
        lastInvocationTime: 0,
        firstInvocationTime: 0
      };
    }

    const total = metrics.length;
    const successCount = metrics.filter(m => m.status === 'success').length;
    const timeoutCount = metrics.filter(m => m.status === 'timeout').length;
    const errorCount = metrics.filter(m => m.status === 'error').length;

    const elapsedTimes = metrics.map(m => m.elapsedMs).sort((a, b) => a - b);
    const totalElapsed = elapsedTimes.reduce((a, b) => a + b, 0);

    return {
      toolName: metrics[0].toolName,
      totalInvocations: total,
      successCount,
      timeoutCount,
      errorCount,
      avgElapsedMs: Math.round(totalElapsed / total * 100) / 100,
      minElapsedMs: elapsedTimes[0],
      maxElapsedMs: elapsedTimes[elapsedTimes.length - 1],
      p50ElapsedMs: this._percentile(elapsedTimes, 50),
      p90ElapsedMs: this._percentile(elapsedTimes, 90),
      p95ElapsedMs: this._percentile(elapsedTimes, 95),
      p99ElapsedMs: this._percentile(elapsedTimes, 99),
      successRate: Math.round((successCount / total) * 10000) / 10000,
      timeoutRate: Math.round((timeoutCount / total) * 10000) / 10000,
      errorRate: Math.round((errorCount / total) * 10000) / 10000,
      lastInvocationTime: metrics[metrics.length - 1].timestamp,
      firstInvocationTime: metrics[0].timestamp
    };
  }

  /**
   * Get summary metrics for a specific tool.
   *
   * @param {string} toolName - Tool name
   * @param {number} [windowMs] - Time window in ms
   * @returns {ToolMetricsSummary} Summary metrics
   */
  getToolSummary(toolName, windowMs = null) {
    const metrics = this.getToolMetrics(toolName, windowMs);
    return this.computeToolSummary(metrics);
  }

  /**
   * Get summaries for all tools.
   *
   * @param {number} [windowMs] - Time window in ms
   * @returns {Object} Map of toolName -> ToolMetricsSummary
   */
  getAllToolSummaries(windowMs = null) {
    if (this._cachedSummaries && !windowMs) {
      return this._cachedSummaries;
    }

    const summaries = {};
    for (const toolName of this._toolIndices.keys()) {
      summaries[toolName] = this.getToolSummary(toolName, windowMs);
    }

    if (!windowMs) {
      this._cachedSummaries = summaries;
    }

    return summaries;
  }

  /**
   * Get aggregate summary across all tools.
   *
   * @param {number} [windowMs] - Time window in ms
   * @returns {AggregateMetricsSummary} Aggregate summary
   */
  getAggregateSummary(windowMs = null) {
    if (this._cachedAggregate && !windowMs) {
      return this._cachedAggregate;
    }

    const metrics = windowMs ? this.getMetrics(windowMs) : this._metrics;
    
    if (metrics.length === 0) {
      return {
        totalInvocations: 0,
        successCount: 0,
        timeoutCount: 0,
        errorCount: 0,
        avgElapsedMs: 0,
        p50ElapsedMs: 0,
        p90ElapsedMs: 0,
        p95ElapsedMs: 0,
        p99ElapsedMs: 0,
        successRate: 0,
        timeoutRate: 0,
        errorRate: 0,
        uniqueTools: 0,
        byTool: {}
      };
    }

    const total = metrics.length;
    const successCount = metrics.filter(m => m.status === 'success').length;
    const timeoutCount = metrics.filter(m => m.status === 'timeout').length;
    const errorCount = metrics.filter(m => m.status === 'error').length;

    const elapsedTimes = metrics.map(m => m.elapsedMs).sort((a, b) => a - b);
    const totalElapsed = elapsedTimes.reduce((a, b) => a + b, 0);

    const uniqueTools = new Set(metrics.map(m => m.toolName)).size;
    const byTool = this.getAllToolSummaries(windowMs);

    const result = {
      totalInvocations: total,
      successCount,
      timeoutCount,
      errorCount,
      avgElapsedMs: Math.round(totalElapsed / total * 100) / 100,
      p50ElapsedMs: this._percentile(elapsedTimes, 50),
      p90ElapsedMs: this._percentile(elapsedTimes, 90),
      p95ElapsedMs: this._percentile(elapsedTimes, 95),
      p99ElapsedMs: this._percentile(elapsedTimes, 99),
      successRate: Math.round((successCount / total) * 10000) / 10000,
      timeoutRate: Math.round((timeoutCount / total) * 10000) / 10000,
      errorRate: Math.round((errorCount / total) * 10000) / 10000,
      uniqueTools,
      byTool
    };

    if (!windowMs) {
      this._cachedAggregate = result;
    }

    return result;
  }

  /**
   * Get metrics filtered by status.
   *
   * @param {string} status - Status to filter (success, timeout, error)
   * @param {number} [limit=100] - Maximum metrics to return
   * @returns {ExecutionMetric[]} Filtered metrics
   */
  getMetricsByStatus(status, limit = 100) {
    const filtered = this._metrics.filter(m => m.status === status);
    const start = Math.max(0, filtered.length - limit);
    return filtered.slice(start);
  }

  /**
   * Get timeout metrics (invocations that timed out).
   *
   * @param {number} [limit=100] - Maximum metrics to return
   * @returns {ExecutionMetric[]} Timeout metrics
   */
  getTimeoutMetrics(limit = 100) {
    return this.getMetricsByStatus('timeout', limit);
  }

  /**
   * Get error metrics (invocations that errored, excluding timeouts).
   *
   * @param {number} [limit=100] - Maximum metrics to return
   * @returns {ExecutionMetric[]} Error metrics
   */
  getErrorMetrics(limit = 100) {
    return this.getMetricsByStatus('error', limit);
  }

  /**
   * Get tools with highest timeout rates.
   *
   * @param {number} [limit=10] - Number of tools to return
   * @param {number} [minInvocations=5] - Minimum invocations to include
   * @returns {Array<{toolName: string, timeoutRate: number, totalInvocations: number}>}
   */
  getHighestTimeoutRateTools(limit = 10, minInvocations = 5) {
    const summaries = this.getAllToolSummaries();
    
    return Object.values(summaries)
      .filter(s => s.totalInvocations >= minInvocations)
      .sort((a, b) => b.timeoutRate - a.timeoutRate)
      .slice(0, limit)
      .map(s => ({
        toolName: s.toolName,
        timeoutRate: s.timeoutRate,
        totalInvocations: s.totalInvocations
      }));
  }

  /**
   * Get tools with highest error rates.
   *
   * @param {number} [limit=10] - Number of tools to return
   * @param {number} [minInvocations=5] - Minimum invocations to include
   * @returns {Array<{toolName: string, errorRate: number, totalInvocations: number}>}
   */
  getHighestErrorRateTools(limit = 10, minInvocations = 5) {
    const summaries = this.getAllToolSummaries();
    
    return Object.values(summaries)
      .filter(s => s.totalInvocations >= minInvocations)
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, limit)
      .map(s => ({
        toolName: s.toolName,
        errorRate: s.errorRate,
        totalInvocations: s.totalInvocations
      }));
  }

  /**
   * Get tools with highest latency (p95).
   *
   * @param {number} [limit=10] - Number of tools to return
   * @param {number} [minInvocations=5] - Minimum invocations to include
   * @returns {Array<{toolName: string, p95ElapsedMs: number, totalInvocations: number}>}
   */
  getHighestLatencyTools(limit = 10, minInvocations = 5) {
    const summaries = this.getAllToolSummaries();
    
    return Object.values(summaries)
      .filter(s => s.totalInvocations >= minInvocations)
      .sort((a, b) => b.p95ElapsedMs - a.p95ElapsedMs)
      .slice(0, limit)
      .map(s => ({
        toolName: s.toolName,
        p95ElapsedMs: s.p95ElapsedMs,
        totalInvocations: s.totalInvocations
      }));
  }

  /**
   * Export metrics as JSON-serializable object.
   *
   * @param {number} [windowMs] - Time window in ms
   * @returns {Object} Exportable metrics data
   */
  exportMetrics(windowMs = null) {
    return {
      aggregate: this.getAggregateSummary(windowMs),
      byTool: this.getAllToolSummaries(windowMs),
      recentMetrics: this.getRecentMetrics(100),
      exportedAt: Date.now()
    };
  }

  /**
   * Clear all recorded metrics.
   */
  clear() {
    this._metrics = [];
    this._toolIndices.clear();
    this._cachedSummaries = null;
    this._cachedAggregate = null;
    log.debug('Execution metrics cleared');
  }

  /**
   * Get collector statistics.
   *
   * @returns {Object} Collector stats
   */
  getStats() {
    return {
      totalMetricsStored: this._metrics.length,
      uniqueTools: this._toolIndices.size,
      maxHistorySize: this._maxHistorySize,
      retentionWindowMs: this._retentionWindowMs,
      oldestMetricTime: this._metrics.length > 0 ? this._metrics[0].timestamp : null,
      newestMetricTime: this._metrics.length > 0 ? this._metrics[this._metrics.length - 1].timestamp : null
    };
  }
}

/**
 * Create a configured ExecutionMetricsCollector instance.
 *
 * @param {Object} [options] - Configuration options
 * @returns {ExecutionMetricsCollector}
 */
export function createExecutionMetricsCollector(options = {}) {
  return new ExecutionMetricsCollector(options);
}
