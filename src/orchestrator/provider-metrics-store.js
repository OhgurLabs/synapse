// src/orchestrator/provider-metrics-store.js

import { createLogger } from '../logger.js';

const logger = createLogger('provider-metrics-store');

/**
 * ProviderMetricsStore — tracks provider dispatch metrics with audit logging.
 *
 * Integrates:
 * - AuditLogger for audit trail of provider events
 * - LatencyStore for latency percentile tracking (p50, p95, p99)
 * - EventBus (ContextBus) for publishing latency artifacts to scorecard
 *
 * Usage:
 *   providerMetricsStore.recordDispatchMetrics({ ... });
 *   providerMetricsStore.recordProviderLatency({ provider: 'claude', latencyMs: 1200, dispatchId: '...' });
 *   providerMetricsStore.publishLatencyArtifacts();
 */
class ProviderMetricsStore {
  constructor(telemetryStore = null) {
    this._telemetryStore = telemetryStore;
    this._auditLogger = null;
    this._eventBus = null;
    
    // Latency tracking per provider (rolling window)
    this._latencyWindows = new Map(); // provider -> { latencies: [], windowMs: 300000 }
    this._windowMs = 5 * 60 * 1000; // 5-minute rolling window
    
    // Circuit breaker correlation
    this._cbCorrelations = new Map(); // dispatchId -> { provider, cbState, timestamp }
    
    logger.info('ProviderMetricsStore initialized');
  }

  setTelemetryStore(telemetryStore) {
    this._telemetryStore = telemetryStore;
    logger.info('TelemetryStore set for ProviderMetricsStore');
  }

  /**
   * Set AuditLogger for audit trail integration.
   * @param {Object} auditLogger - AuditLogger instance with logAction() method
   */
  setAuditLogger(auditLogger) {
    this._auditLogger = auditLogger;
    logger.info('AuditLogger set for ProviderMetricsStore');
  }

  /**
   * Set EventBus for publishing latency artifacts to scorecard.
   * @param {Object} eventBus - EventBus instance with emit() method
   */
  setEventBus(eventBus) {
    this._eventBus = eventBus;
    logger.info('EventBus set for ProviderMetricsStore');
  }

  /**
   * Records dispatch metrics for a provider.
   * @param {object} metrics
   * @param {string} metrics.projectId
   * @param {string} metrics.providerName
   * @param {number} metrics.durationMs
   * @param {boolean} metrics.success
   * @param {string} metrics.dispatchId
   * @param {string} [metrics.agentId] - Agent that made the dispatch
   * @param {string} [metrics.campaignId] - Campaign context
   * @param {string} [metrics.cbState] - Circuit breaker state at dispatch time
   */
  recordDispatchMetrics({ 
    projectId, 
    providerName, 
    durationMs, 
    success, 
    dispatchId,
    agentId,
    campaignId,
    cbState 
  }) {
    const eventData = {
      providerName,
      durationMs,
      success,
      dispatchId,
      agentId,
      campaignId,
      cbState,
      timestamp: new Date().toISOString(),
    };

    // Record to telemetry store
    if (this._telemetryStore && projectId) {
      this._telemetryStore.append(projectId, 'provider:dispatch_metrics', eventData);
    } else {
      logger.warn('TelemetryStore not available or projectId missing, logging provider metrics locally.', { eventData });
    }

    // Audit log the dispatch
    this._logProviderEvent('dispatch', {
      ...eventData,
      action: 'dispatch_recorded',
    });

    // Track latency for percentile calculations
    this._trackLatency(providerName, durationMs);

    // Correlate with circuit breaker state
    if (cbState) {
      this._cbCorrelations.set(dispatchId, {
        provider: providerName,
        cbState,
        timestamp: eventData.timestamp,
      });
    }
  }

  /**
   * Record provider latency with circuit breaker correlation.
   * @param {object} params
   * @param {string} params.provider - Provider name
   * @param {number} params.latencyMs - Latency in milliseconds
   * @param {string} params.dispatchId - Dispatch identifier
   * @param {string} [params.agentId] - Agent identifier
   * @param {string} [params.campaignId] - Campaign identifier
   * @param {string} [params.cbState] - Circuit breaker state
   * @param {boolean} [params.success] - Whether the dispatch succeeded
   */
  recordProviderLatency({ 
    provider, 
    latencyMs, 
    dispatchId, 
    agentId, 
    campaignId, 
    cbState,
    success 
  }) {
    const event = {
      provider,
      latencyMs,
      dispatchId,
      agentId,
      campaignId,
      cbState,
      success,
      timestamp: new Date().toISOString(),
    };

    // Track latency for percentiles
    this._trackLatency(provider, latencyMs);

    // Audit log
    this._logProviderEvent('latency', {
      ...event,
      action: 'latency_recorded',
    });

    // Correlate with circuit breaker
    if (cbState) {
      this._cbCorrelations.set(dispatchId, {
        provider,
        cbState,
        timestamp: event.timestamp,
      });
    }

    // Publish latency artifact to EventBus for scorecard
    this._publishLatencyArtifact(event);
  }

  /**
   * Track latency in rolling window for percentile calculations.
   * @private
   */
  _trackLatency(provider, latencyMs) {
    const now = Date.now();
    
    if (!this._latencyWindows.has(provider)) {
      this._latencyWindows.set(provider, {
        latencies: [],
        windowMs: this._windowMs,
      });
    }
    
    const window = this._latencyWindows.get(provider);
    
    // Add new latency
    window.latencies.push({ timestamp: now, value: latencyMs });
    
    // Clean old entries outside window
    const cutoff = now - window.windowMs;
    window.latencies = window.latencies.filter(l => l.timestamp > cutoff);
  }

  /**
   * Get latency percentiles for a provider.
   * @param {string} provider - Provider name
   * @returns {object} { p50, p95, p99, count, windowMs }
   */
  getLatencyPercentiles(provider) {
    const window = this._latencyWindows.get(provider);
    
    if (!window || window.latencies.length === 0) {
      return { p50: null, p95: null, p99: null, count: 0, windowMs: window?.windowMs };
    }
    
    const values = window.latencies.map(l => l.value).sort((a, b) => a - b);
    const count = values.length;
    
    return {
      p50: this._percentile(values, 50),
      p95: this._percentile(values, 95),
      p99: this._percentile(values, 99),
      count,
      windowMs: window.windowMs,
    };
  }

  /**
   * Calculate percentile from sorted array.
   * @private
   */
  _percentile(sortedValues, p) {
    if (sortedValues.length === 0) return null;
    
    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    
    if (lower === upper) return sortedValues[lower];
    
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  /**
   * Get all provider latency percentiles.
   * @returns {Map<string, object>} Provider name -> percentiles
   */
  getAllProviderPercentiles() {
    const result = new Map();
    
    for (const provider of this._latencyWindows.keys()) {
      result.set(provider, this.getLatencyPercentiles(provider));
    }
    
    return result;
  }

  /**
   * Log provider event to AuditLogger.
   * @private
   */
  _logProviderEvent(eventType, eventData) {
    if (!this._auditLogger) {
      logger.debug('AuditLogger not configured, skipping audit log for provider event');
      return;
    }

    try {
      // Fire-and-forget: never block on audit logging
      this._auditLogger.logAction({
        traceId: eventData.dispatchId || null,
        agentId: eventData.agentId || 'provider-metrics-store',
        action_type: `provider_${eventType}`,
        input_summary: `Provider ${eventData.providerName || eventData.provider} ${eventType}`,
        output_summary: eventData.success !== undefined 
          ? (eventData.success ? 'success' : 'failure') 
          : 'recorded',
        outcome: eventData.success === false ? 'failure' : 'success',
        context_metadata: {
          provider: eventData.providerName || eventData.provider,
          dispatchId: eventData.dispatchId,
          campaignId: eventData.campaignId || null,
          latencyMs: eventData.durationMs || eventData.latencyMs || null,
          cbState: eventData.cbState || null,
          timestamp: eventData.timestamp,
        },
      }).catch(err => {
        logger.warn('Failed to log provider event to audit', { 
          eventType, 
          error: err.message 
        });
      });
    } catch (err) {
      logger.warn('AuditLogger.logAction threw, event not logged', { 
        eventType, 
        error: err.message 
      });
    }
  }

  /**
   * Publish latency artifact to EventBus for scorecard.
   * @private
   */
  _publishLatencyArtifact(event) {
    if (!this._eventBus) {
      logger.debug('EventBus not configured, skipping latency artifact publish');
      return;
    }

    try {
      // Fire-and-forget: never block on event publishing
      this._eventBus.emit('provider_latency', {
        provider: event.provider,
        latencyMs: event.latencyMs,
        dispatchId: event.dispatchId,
        agentId: event.agentId,
        campaignId: event.campaignId,
        cbState: event.cbState,
        success: event.success,
        timestamp: event.timestamp,
        // Include percentiles for scorecard
        percentiles: this.getLatencyPercentiles(event.provider),
      });
    } catch (err) {
      logger.warn('Failed to publish latency artifact to EventBus', { 
        provider: event.provider, 
        error: err.message 
      });
    }
  }

  /**
   * Publish aggregated latency artifacts for all providers.
   * Called periodically to update scorecard with current state.
   */
  publishLatencyArtifacts() {
    if (!this._eventBus) {
      logger.debug('EventBus not configured, skipping bulk latency artifact publish');
      return;
    }

    try {
      const artifacts = [];
      
      for (const [provider, percentiles] of this.getAllProviderPercentiles()) {
        artifacts.push({
          provider,
          percentiles,
          timestamp: new Date().toISOString(),
        });
      }

      this._eventBus.emit('provider_latency_aggregated', {
        artifacts,
        timestamp: new Date().toISOString(),
      });

      logger.debug('Published aggregated latency artifacts', { 
        providerCount: artifacts.length 
      });
    } catch (err) {
      logger.warn('Failed to publish aggregated latency artifacts', { 
        error: err.message 
      });
    }
  }

  /**
   * Get circuit breaker correlations for a dispatch.
   * @param {string} dispatchId - Dispatch identifier
   * @returns {object|null} Correlation data or null
   */
  getCBCorrelation(dispatchId) {
    return this._cbCorrelations.get(dispatchId) || null;
  }

  /**
   * Clear old circuit breaker correlations.
   * @param {number} maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   */
  clearOldCBCorrelations(maxAgeMs = 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    
    for (const [dispatchId, correlation] of this._cbCorrelations.entries()) {
      const corrTime = new Date(correlation.timestamp).getTime();
      if (corrTime < cutoff) {
        this._cbCorrelations.delete(dispatchId);
      }
    }
  }

  /**
   * Get provider health summary based on latency and success rate.
   * @param {string} provider - Provider name
   * @returns {object} Health summary
   */
  getProviderHealthSummary(provider) {
    const percentiles = this.getLatencyPercentiles(provider);
    
    // Determine health status based on latency thresholds
    let healthStatus = 'healthy';
    if (percentiles.p95 !== null) {
      if (percentiles.p95 > 2000) {
        healthStatus = 'degraded';
      } else if (percentiles.p95 > 1000) {
        healthStatus = 'warning';
      }
    }
    
    return {
      provider,
      healthStatus,
      percentiles,
      timestamp: new Date().toISOString(),
    };
  }
}

// Export an instance, but allow setting dependencies later
export const providerMetricsStore = new ProviderMetricsStore();
