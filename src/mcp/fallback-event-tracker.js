/**
 * FallbackEventTracker
 *
 * Comprehensive logging and event tracking system for MCP tool fallback operations.
 * Provides operational monitoring capabilities including:
 * - Structured event logging with correlation IDs
 * - Performance metrics collection for fallback attempts
 * - Aggregated statistics for operational dashboards
 * - Real-time alerting on fallback failures
 * - Compatibility analysis tracking
 * - Circuit breaker impact monitoring
 *
 * Features:
 * - End-to-end tracing with correlation IDs
 * - Time-windowed statistics and aggregations
 * - Per-operation-category metrics
 * - Fallback chain tracking (primary → fallback1 → fallback2 → ...)
 * - Integration with ExecutionMetricsCollector
 * - Event emission for external monitoring systems
 *
 * Events Emitted:
 * - fallback_initiated: Fallback process started
 * - fallback_candidate_analysis: Compatibility analysis completed for candidate
 * - fallback_ranking_complete: Ranking completed for all candidates
 * - fallback_attempt_start: Individual fallback tool invocation starting
 * - fallback_attempt_success: Individual fallback tool succeeded
 * - fallback_attempt_failure: Individual fallback tool failed
 * - fallback_complete_success: Fallback process succeeded overall
 * - fallback_complete_failure: All fallbacks exhausted
 * - fallback_circuit_impact: Circuit breaker affected fallback availability
 *
 * Usage:
 *   const tracker = new FallbackEventTracker({ metricsCollector });
 *   const correlationId = tracker.startFallback(primaryTool, operationCategory);
 *   tracker.recordAttempt(correlationId, fallbackTool, result);
 *   tracker.completeFallback(correlationId, finalResult);
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';
import crypto from 'crypto';

const log = createLogger('fallback-event-tracker');

/**
 * Fallback event types for structured logging
 */
export const FallbackEventType = {
  INITIATED: 'fallback_initiated',
  CANDIDATE_ANALYSIS: 'fallback_candidate_analysis',
  RANKING_COMPLETE: 'fallback_ranking_complete',
  ATTEMPT_START: 'fallback_attempt_start',
  ATTEMPT_SUCCESS: 'fallback_attempt_success',
  ATTEMPT_FAILURE: 'fallback_attempt_failure',
  COMPLETE_SUCCESS: 'fallback_complete_success',
  COMPLETE_FAILURE: 'fallback_complete_failure',
  CIRCUIT_IMPACT: 'fallback_circuit_impact',
  POLICY_APPLIED: 'fallback_policy_applied'
};

/**
 * Fallback failure reasons for categorization
 */
export const FallbackFailureReason = {
  NO_CANDIDATES: 'no_candidates',
  NO_COMPATIBLE: 'no_compatible_tools',
  ALL_FAILED: 'all_attempts_failed',
  ALL_CIRCUITS_OPEN: 'all_circuits_open',
  TIMEOUT: 'timeout',
  POLICY_LIMIT: 'policy_limit_reached'
};

/**
 * Default configuration for event tracking
 */
const DEFAULT_CONFIG = {
  // Enable detailed logging
  detailedLogging: true,

  // Enable performance metrics collection
  enableMetrics: true,

  // Retention window for statistics (1 hour)
  retentionWindowMs: 3600000,

  // Maximum events to retain in memory
  maxEventHistory: 1000,

  // Alert thresholds
  alertThresholds: {
    fallbackFailureRate: 0.3, // Alert if >30% of fallbacks fail
    avgFallbackTimeMs: 10000, // Alert if average fallback time >10s
    circuitOpenRate: 0.5 // Alert if >50% of candidates have open circuits
  }
};

/**
 * FallbackEventTracker — Tracks and logs all fallback operations
 */
export class FallbackEventTracker extends EventEmitter {
  /**
   * Create a FallbackEventTracker instance
   * @param {Object} options - Configuration options
   * @param {ExecutionMetricsCollector} [options.metricsCollector] - Metrics collector instance
   * @param {Object} [options.config] - Configuration overrides
   */
  constructor(options = {}) {
    super();

    this.metricsCollector = options.metricsCollector || null;
    this.config = { ...DEFAULT_CONFIG, ...options.config };

    // Active fallback sessions keyed by correlation ID
    this._activeSessions = new Map();

    // Event history for statistics
    this._eventHistory = [];

    // Aggregated statistics
    this._stats = {
      totalFallbacks: 0,
      successfulFallbacks: 0,
      failedFallbacks: 0,
      byOperationCategory: new Map(),
      byFailureReason: new Map(),
      commonFallbackPairs: new Map(), // Track primary → fallback mappings
      avgFallbackTimeMs: 0,
      p50FallbackTimeMs: 0,
      p90FallbackTimeMs: 0,
      p95FallbackTimeMs: 0
    };

    // Start periodic cleanup of old events
    this._cleanupInterval = setInterval(() => this._cleanupOldEvents(), 60000);

    log.info({
      detailedLogging: this.config.detailedLogging,
      enableMetrics: this.config.enableMetrics,
      retentionWindowMs: this.config.retentionWindowMs
    }, 'FallbackEventTracker initialized');
  }

  /**
   * Start tracking a new fallback operation
   * @param {string} primaryToolName - Primary tool that failed
   * @param {string} primaryServerId - Primary server ID
   * @param {string} operationCategory - Operation category
   * @param {Object} context - Additional context
   * @returns {string} Correlation ID for this fallback operation
   */
  startFallback(primaryToolName, primaryServerId, operationCategory, context = {}) {
    const correlationId = this._generateCorrelationId();
    const timestamp = Date.now();

    const session = {
      correlationId,
      primaryToolName,
      primaryServerId,
      primaryToolKey: `${primaryServerId}:${primaryToolName}`,
      operationCategory,
      startTime: timestamp,
      endTime: null,
      status: 'in_progress',
      attempts: [],
      candidateAnalysis: [],
      rankingResults: null,
      finalResult: null,
      totalElapsedMs: null,
      context: {
        ...context,
        initiatedAt: new Date(timestamp).toISOString()
      }
    };

    this._activeSessions.set(correlationId, session);

    // Log initiation
    if (this.config.detailedLogging) {
      log.info({
        correlationId,
        primaryTool: session.primaryToolKey,
        operationCategory,
        ...context
      }, 'Fallback operation initiated');
    }

    // Emit event
    this.emit(FallbackEventType.INITIATED, {
      correlationId,
      primaryToolName,
      primaryServerId,
      operationCategory,
      timestamp,
      ...context
    });

    // Record event in history
    this._recordEvent({
      type: FallbackEventType.INITIATED,
      correlationId,
      timestamp,
      data: { primaryToolName, primaryServerId, operationCategory, ...context }
    });

    return correlationId;
  }

  /**
   * Record compatibility analysis for a candidate tool
   * @param {string} correlationId - Fallback correlation ID
   * @param {string} candidateToolName - Candidate tool name
   * @param {string} candidateServerId - Candidate server ID
   * @param {Object} analysisResult - Compatibility analysis result
   */
  recordCandidateAnalysis(correlationId, candidateToolName, candidateServerId, analysisResult) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for candidate analysis');
      return;
    }

    const analysis = {
      toolName: candidateToolName,
      serverId: candidateServerId,
      toolKey: `${candidateServerId}:${candidateToolName}`,
      timestamp: Date.now(),
      isCompatible: analysisResult.isCompatible,
      compatibilityLevel: analysisResult.compatibilityLevel,
      compatibilityScore: analysisResult.compatibilityScore,
      parameterStatus: analysisResult.parameterStatus,
      transformationsRequired: analysisResult.transformations?.length || 0,
      warnings: analysisResult.warnings || []
    };

    session.candidateAnalysis.push(analysis);

    // Detailed logging for compatibility decisions
    if (this.config.detailedLogging) {
      log.debug({
        correlationId,
        candidateTool: analysis.toolKey,
        isCompatible: analysis.isCompatible,
        compatibilityLevel: analysis.compatibilityLevel,
        score: analysis.compatibilityScore,
        parameterStatus: analysis.parameterStatus
      }, 'Candidate compatibility analysis complete');
    }

    // Emit event
    this.emit(FallbackEventType.CANDIDATE_ANALYSIS, {
      correlationId,
      ...analysis
    });

    // Record event
    this._recordEvent({
      type: FallbackEventType.CANDIDATE_ANALYSIS,
      correlationId,
      timestamp: analysis.timestamp,
      data: analysis
    });
  }

  /**
   * Record ranking results for fallback tools
   * @param {string} correlationId - Fallback correlation ID
   * @param {Array} rankedTools - Ranked list of fallback tools with scores
   */
  recordRanking(correlationId, rankedTools) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for ranking');
      return;
    }

    const ranking = {
      timestamp: Date.now(),
      totalCandidates: rankedTools.length,
      rankings: rankedTools.map((ranked, index) => ({
        rank: index + 1,
        toolName: ranked.tool.name,
        serverId: ranked.tool.source.replace('mcp:', ''),
        overallScore: ranked.overallScore,
        scores: ranked.scores,
        compatibilityScore: ranked.compatibilityScore
      }))
    };

    session.rankingResults = ranking;

    // Log ranking summary
    if (this.config.detailedLogging) {
      const topThree = ranking.rankings.slice(0, 3).map(r => ({
        tool: `${r.serverId}:${r.toolName}`,
        score: r.overallScore.toFixed(3)
      }));

      log.info({
        correlationId,
        totalCandidates: ranking.totalCandidates,
        topThree
      }, 'Fallback tool ranking complete');
    }

    // Emit event
    this.emit(FallbackEventType.RANKING_COMPLETE, {
      correlationId,
      ...ranking
    });

    // Record event
    this._recordEvent({
      type: FallbackEventType.RANKING_COMPLETE,
      correlationId,
      timestamp: ranking.timestamp,
      data: ranking
    });
  }

  /**
   * Record the start of a fallback tool attempt
   * @param {string} correlationId - Fallback correlation ID
   * @param {string} fallbackToolName - Fallback tool name
   * @param {string} fallbackServerId - Fallback server ID
   * @param {Object} context - Additional context (rank, compatibility, etc.)
   */
  recordAttemptStart(correlationId, fallbackToolName, fallbackServerId, context = {}) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for attempt start');
      return;
    }

    const attempt = {
      toolName: fallbackToolName,
      serverId: fallbackServerId,
      toolKey: `${fallbackServerId}:${fallbackToolName}`,
      attemptIndex: session.attempts.length,
      startTime: Date.now(),
      endTime: null,
      status: 'in_progress',
      elapsedMs: null,
      result: null,
      error: null,
      context: { ...context }
    };

    session.attempts.push(attempt);

    // Log attempt start
    if (this.config.detailedLogging) {
      log.info({
        correlationId,
        fallbackTool: attempt.toolKey,
        attemptIndex: attempt.attemptIndex,
        rank: context.rank,
        compatibilityScore: context.compatibilityScore
      }, 'Starting fallback tool attempt');
    }

    // Emit event
    this.emit(FallbackEventType.ATTEMPT_START, {
      correlationId,
      ...attempt,
      primaryToolKey: session.primaryToolKey
    });

    // Record event
    this._recordEvent({
      type: FallbackEventType.ATTEMPT_START,
      correlationId,
      timestamp: attempt.startTime,
      data: { ...attempt, primaryToolKey: session.primaryToolKey }
    });
  }

  /**
   * Record successful fallback tool attempt
   * @param {string} correlationId - Fallback correlation ID
   * @param {string} fallbackToolName - Fallback tool name
   * @param {string} fallbackServerId - Fallback server ID
   * @param {Object} result - Tool invocation result
   */
  recordAttemptSuccess(correlationId, fallbackToolName, fallbackServerId, result) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for attempt success');
      return;
    }

    const toolKey = `${fallbackServerId}:${fallbackToolName}`;
    const attempt = session.attempts.find(a => a.toolKey === toolKey && a.status === 'in_progress');

    if (!attempt) {
      log.warn({ correlationId, toolKey }, 'Attempt not found for success recording');
      return;
    }

    const endTime = Date.now();
    attempt.endTime = endTime;
    attempt.elapsedMs = endTime - attempt.startTime;
    attempt.status = 'success';
    attempt.result = result;

    // Log success
    log.info({
      correlationId,
      fallbackTool: toolKey,
      attemptIndex: attempt.attemptIndex,
      elapsedMs: attempt.elapsedMs,
      previousAttempts: attempt.attemptIndex
    }, 'Fallback tool attempt succeeded');

    // Emit event
    this.emit(FallbackEventType.ATTEMPT_SUCCESS, {
      correlationId,
      fallbackToolName,
      fallbackServerId,
      toolKey,
      attemptIndex: attempt.attemptIndex,
      elapsedMs: attempt.elapsedMs,
      timestamp: endTime,
      primaryToolKey: session.primaryToolKey
    });

    // Record event
    this._recordEvent({
      type: FallbackEventType.ATTEMPT_SUCCESS,
      correlationId,
      timestamp: endTime,
      data: {
        fallbackToolName,
        fallbackServerId,
        toolKey,
        attemptIndex: attempt.attemptIndex,
        elapsedMs: attempt.elapsedMs,
        primaryToolKey: session.primaryToolKey
      }
    });

    // Collect metrics if enabled
    if (this.config.enableMetrics && this.metricsCollector) {
      this.metricsCollector.recordInvocation({
        toolName: fallbackToolName,
        serverId: fallbackServerId,
        timestamp: endTime,
        startTime: attempt.startTime,
        endTime: endTime,
        elapsedMs: attempt.elapsedMs,
        timeoutMs: attempt.context.timeoutMs || 30000,
        status: 'success',
        isFallback: true,
        fallbackAttemptIndex: attempt.attemptIndex
      });
    }
  }

  /**
   * Record failed fallback tool attempt
   * @param {string} correlationId - Fallback correlation ID
   * @param {string} fallbackToolName - Fallback tool name
   * @param {string} fallbackServerId - Fallback server ID
   * @param {Error|string} error - Error that occurred
   * @param {Object} context - Additional context (circuit state, etc.)
   */
  recordAttemptFailure(correlationId, fallbackToolName, fallbackServerId, error, context = {}) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for attempt failure');
      return;
    }

    const toolKey = `${fallbackServerId}:${fallbackToolName}`;
    const attempt = session.attempts.find(a => a.toolKey === toolKey && a.status === 'in_progress');

    if (!attempt) {
      log.warn({ correlationId, toolKey }, 'Attempt not found for failure recording');
      return;
    }

    const endTime = Date.now();
    attempt.endTime = endTime;
    attempt.elapsedMs = endTime - attempt.startTime;
    attempt.status = 'failure';
    attempt.error = typeof error === 'string' ? error : error.message;
    attempt.context = { ...attempt.context, ...context };

    // Log failure
    log.warn({
      correlationId,
      fallbackTool: toolKey,
      attemptIndex: attempt.attemptIndex,
      error: attempt.error,
      elapsedMs: attempt.elapsedMs,
      circuitState: context.circuitState
    }, 'Fallback tool attempt failed');

    // Emit event
    this.emit(FallbackEventType.ATTEMPT_FAILURE, {
      correlationId,
      fallbackToolName,
      fallbackServerId,
      toolKey,
      attemptIndex: attempt.attemptIndex,
      error: attempt.error,
      elapsedMs: attempt.elapsedMs,
      timestamp: endTime,
      primaryToolKey: session.primaryToolKey,
      ...context
    });

    // Record event
    this._recordEvent({
      type: FallbackEventType.ATTEMPT_FAILURE,
      correlationId,
      timestamp: endTime,
      data: {
        fallbackToolName,
        fallbackServerId,
        toolKey,
        attemptIndex: attempt.attemptIndex,
        error: attempt.error,
        elapsedMs: attempt.elapsedMs,
        primaryToolKey: session.primaryToolKey,
        ...context
      }
    });

    // Collect metrics if enabled
    if (this.config.enableMetrics && this.metricsCollector) {
      this.metricsCollector.recordInvocation({
        toolName: fallbackToolName,
        serverId: fallbackServerId,
        timestamp: endTime,
        startTime: attempt.startTime,
        endTime: endTime,
        elapsedMs: attempt.elapsedMs,
        timeoutMs: attempt.context.timeoutMs || 30000,
        status: 'error',
        errorCode: context.errorCode || 'FALLBACK_FAILURE',
        isFallback: true,
        fallbackAttemptIndex: attempt.attemptIndex
      });
    }
  }

  /**
   * Record impact of circuit breakers on fallback availability
   * @param {string} correlationId - Fallback correlation ID
   * @param {number} totalCandidates - Total candidate tools
   * @param {number} openCircuits - Number of candidates with open circuits
   * @param {Array<string>} affectedTools - Tools affected by circuit breakers
   */
  recordCircuitImpact(correlationId, totalCandidates, openCircuits, affectedTools = []) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for circuit impact');
      return;
    }

    const impact = {
      timestamp: Date.now(),
      totalCandidates,
      openCircuits,
      openCircuitRate: totalCandidates > 0 ? openCircuits / totalCandidates : 0,
      affectedTools
    };

    session.context.circuitImpact = impact;

    // Log circuit impact
    if (openCircuits > 0) {
      log.warn({
        correlationId,
        totalCandidates,
        openCircuits,
        openCircuitRate: (impact.openCircuitRate * 100).toFixed(1) + '%',
        affectedTools
      }, 'Circuit breakers limiting fallback availability');
    }

    // Check alert threshold
    if (impact.openCircuitRate > this.config.alertThresholds.circuitOpenRate) {
      log.error({
        correlationId,
        openCircuitRate: (impact.openCircuitRate * 100).toFixed(1) + '%',
        threshold: (this.config.alertThresholds.circuitOpenRate * 100).toFixed(1) + '%'
      }, 'ALERT: Circuit open rate exceeds threshold');
    }

    // Emit event
    this.emit(FallbackEventType.CIRCUIT_IMPACT, {
      correlationId,
      ...impact,
      primaryToolKey: session.primaryToolKey,
      operationCategory: session.operationCategory
    });

    // Record event
    this._recordEvent({
      type: FallbackEventType.CIRCUIT_IMPACT,
      correlationId,
      timestamp: impact.timestamp,
      data: impact
    });
  }

  /**
   * Record fallback policy application for a session
   * @param {string} correlationId - Fallback correlation ID
   * @param {Object} policy - Applied fallback policy
   * @param {string} policySource - Source of the policy (default, category, or override)
   * @param {Object} context - Additional context about policy application
   */
  recordPolicyApplied(correlationId, policy, policySource, context = {}) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for policy application');
      return;
    }

    const policyRecord = {
      timestamp: Date.now(),
      policySource,
      enabled: policy.enabled,
      maxAttempts: policy.maxAttempts,
      timeoutMs: policy.timeoutMs,
      retryEnabled: policy.retry?.enabled,
      maxRetries: policy.retry?.maxRetries,
      baseDelayMs: policy.retry?.baseDelayMs,
      maxDelayMs: policy.retry?.maxDelayMs,
      triggers: policy.triggers ? {
        onTimeout: policy.triggers.onTimeout,
        onConnectionError: policy.triggers.onConnectionError,
        onToolError: policy.triggers.onToolError,
        onCircuitOpen: policy.triggers.onCircuitOpen
      } : null
    };

    session.context.appliedPolicy = policyRecord;

    // Log policy application
    if (this.config.detailedLogging) {
      log.info({
        correlationId,
        policySource,
        enabled: policyRecord.enabled,
        maxAttempts: policyRecord.maxAttempts,
        timeoutMs: policyRecord.timeoutMs,
        retryEnabled: policyRecord.retryEnabled
      }, 'Fallback policy applied');
    }

    // Emit event
    this.emit(FallbackEventType.POLICY_APPLIED, {
      correlationId,
      ...policyRecord,
      operationCategory: session.operationCategory,
      primaryToolKey: session.primaryToolKey
    });

    // Record event
    this._recordEvent({
      type: FallbackEventType.POLICY_APPLIED,
      correlationId,
      timestamp: policyRecord.timestamp,
      data: { ...policyRecord, policySource, ...context }
    });
  }

  /**
   * Complete a fallback operation with final result
   * @param {string} correlationId - Fallback correlation ID
   * @param {string} status - Final status ('success' or 'failure')
   * @param {Object} result - Final result or error details
   */
  completeFallback(correlationId, status, result = {}) {
    const session = this._activeSessions.get(correlationId);
    if (!session) {
      log.warn({ correlationId }, 'Session not found for completion');
      return;
    }

    const endTime = Date.now();
    session.endTime = endTime;
    session.totalElapsedMs = endTime - session.startTime;
    session.status = status;
    session.finalResult = result;

    const eventType = status === 'success'
      ? FallbackEventType.COMPLETE_SUCCESS
      : FallbackEventType.COMPLETE_FAILURE;

    // Calculate statistics for this session
    const successfulAttempt = session.attempts.find(a => a.status === 'success');
    const failedAttempts = session.attempts.filter(a => a.status === 'failure');

    const summary = {
      correlationId,
      primaryToolKey: session.primaryToolKey,
      operationCategory: session.operationCategory,
      status,
      totalElapsedMs: session.totalElapsedMs,
      totalAttempts: session.attempts.length,
      successfulAttempt: successfulAttempt ? {
        toolKey: successfulAttempt.toolKey,
        attemptIndex: successfulAttempt.attemptIndex,
        elapsedMs: successfulAttempt.elapsedMs
      } : null,
      failedAttempts: failedAttempts.length,
      candidatesAnalyzed: session.candidateAnalysis.length,
      compatibleCandidates: session.candidateAnalysis.filter(c => c.isCompatible).length,
      failureReason: result.failureReason || null
    };

    // Log completion
    if (status === 'success') {
      log.info({
        ...summary,
        fallbackTool: successfulAttempt?.toolKey,
        attemptsBeforeSuccess: successfulAttempt?.attemptIndex
      }, 'Fallback operation completed successfully');
    } else {
      log.error({
        ...summary,
        failureReason: result.failureReason
      }, 'Fallback operation failed - all attempts exhausted');
    }

    // Emit event
    this.emit(eventType, {
      timestamp: endTime,
      ...summary
    });

    // Record event
    this._recordEvent({
      type: eventType,
      correlationId,
      timestamp: endTime,
      data: summary
    });

    // Update aggregated statistics
    this._updateStatistics(session);

    // Check alert thresholds
    this._checkAlertThresholds(session);

    // Remove from active sessions
    this._activeSessions.delete(correlationId);
  }

  /**
   * Get current statistics for operational monitoring
   * @param {Object} filters - Optional filters (operationCategory, timeWindowMs)
   * @returns {Object} Aggregated statistics
   */
  getStatistics(filters = {}) {
    const { operationCategory, timeWindowMs } = filters;
    const now = Date.now();
    const cutoffTime = timeWindowMs ? now - timeWindowMs : 0;

    // Filter events by time window
    const relevantEvents = this._eventHistory.filter(event =>
      event.timestamp >= cutoffTime &&
      (!operationCategory || event.data.operationCategory === operationCategory)
    );

    // Calculate statistics from filtered events
    const completionEvents = relevantEvents.filter(e =>
      e.type === FallbackEventType.COMPLETE_SUCCESS ||
      e.type === FallbackEventType.COMPLETE_FAILURE
    );

    const successEvents = relevantEvents.filter(e => e.type === FallbackEventType.COMPLETE_SUCCESS);
    const failureEvents = relevantEvents.filter(e => e.type === FallbackEventType.COMPLETE_FAILURE);

    const totalFallbacks = completionEvents.length;
    const successfulFallbacks = successEvents.length;
    const failedFallbacks = failureEvents.length;

    // Calculate fallback times
    const fallbackTimes = successEvents
      .map(e => e.data.totalElapsedMs)
      .filter(t => t != null)
      .sort((a, b) => a - b);

    const avgFallbackTimeMs = fallbackTimes.length > 0
      ? fallbackTimes.reduce((sum, t) => sum + t, 0) / fallbackTimes.length
      : 0;

    const p50Index = Math.floor(fallbackTimes.length * 0.5);
    const p90Index = Math.floor(fallbackTimes.length * 0.9);
    const p95Index = Math.floor(fallbackTimes.length * 0.95);

    // Aggregate by operation category
    const byCategory = new Map();
    for (const event of completionEvents) {
      const category = event.data.operationCategory || 'unknown';
      if (!byCategory.has(category)) {
        byCategory.set(category, { total: 0, success: 0, failure: 0 });
      }
      const stats = byCategory.get(category);
      stats.total++;
      if (event.type === FallbackEventType.COMPLETE_SUCCESS) {
        stats.success++;
      } else {
        stats.failure++;
      }
    }

    // Common fallback pairs (primary tool → fallback tool)
    const fallbackPairs = new Map();
    for (const event of successEvents) {
      if (event.data.successfulAttempt) {
        const pair = `${event.data.primaryToolKey} → ${event.data.successfulAttempt.toolKey}`;
        fallbackPairs.set(pair, (fallbackPairs.get(pair) || 0) + 1);
      }
    }

    // Calculate attempt statistics
    const attemptEvents = relevantEvents.filter(e =>
      e.type === FallbackEventType.ATTEMPT_SUCCESS ||
      e.type === FallbackEventType.ATTEMPT_FAILURE
    );

    const totalAttempts = attemptEvents.length;
    const successfulAttempts = attemptEvents.filter(e => e.type === FallbackEventType.ATTEMPT_SUCCESS).length;
    const failedAttempts = attemptEvents.filter(e => e.type === FallbackEventType.ATTEMPT_FAILURE).length;

    return {
      timeWindow: {
        startTime: cutoffTime,
        endTime: now,
        durationMs: timeWindowMs || 'all_time'
      },
      overall: {
        totalFallbacks,
        successfulFallbacks,
        failedFallbacks,
        successRate: totalFallbacks > 0 ? successfulFallbacks / totalFallbacks : 0,
        failureRate: totalFallbacks > 0 ? failedFallbacks / totalFallbacks : 0
      },
      attempts: {
        totalAttempts,
        successfulAttempts,
        failedAttempts,
        attemptSuccessRate: totalAttempts > 0 ? successfulAttempts / totalAttempts : 0,
        avgAttemptsPerFallback: totalFallbacks > 0 ? totalAttempts / totalFallbacks : 0
      },
      timing: {
        avgFallbackTimeMs: Math.round(avgFallbackTimeMs),
        p50FallbackTimeMs: fallbackTimes[p50Index] || 0,
        p90FallbackTimeMs: fallbackTimes[p90Index] || 0,
        p95FallbackTimeMs: fallbackTimes[p95Index] || 0,
        minFallbackTimeMs: fallbackTimes[0] || 0,
        maxFallbackTimeMs: fallbackTimes[fallbackTimes.length - 1] || 0
      },
      byOperationCategory: Object.fromEntries(
        Array.from(byCategory.entries()).map(([cat, stats]) => [
          cat,
          {
            ...stats,
            successRate: stats.total > 0 ? stats.success / stats.total : 0
          }
        ])
      ),
      commonFallbackPairs: Object.fromEntries(
        Array.from(fallbackPairs.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10) // Top 10 most common pairs
      ),
      activeSessions: this._activeSessions.size
    };
  }

  /**
   * Export statistics in Prometheus format for external monitoring
   * @returns {string} Prometheus metrics text format
   */
  exportPrometheusMetrics() {
    const stats = this.getStatistics();
    const lines = [];

    // Overall fallback metrics
    lines.push('# HELP synapse_fallback_total Total number of fallback operations');
    lines.push('# TYPE synapse_fallback_total counter');
    lines.push(`synapse_fallback_total ${stats.overall.totalFallbacks}`);

    lines.push('# HELP synapse_fallback_success_total Total number of successful fallbacks');
    lines.push('# TYPE synapse_fallback_success_total counter');
    lines.push(`synapse_fallback_success_total ${stats.overall.successfulFallbacks}`);

    lines.push('# HELP synapse_fallback_failure_total Total number of failed fallbacks');
    lines.push('# TYPE synapse_fallback_failure_total counter');
    lines.push(`synapse_fallback_failure_total ${stats.overall.failedFallbacks}`);

    // Timing metrics
    lines.push('# HELP synapse_fallback_duration_seconds Fallback operation duration in seconds');
    lines.push('# TYPE synapse_fallback_duration_seconds gauge');
    lines.push(`synapse_fallback_duration_seconds{quantile="0.5"} ${(stats.timing.p50FallbackTimeMs / 1000).toFixed(3)}`);
    lines.push(`synapse_fallback_duration_seconds{quantile="0.9"} ${(stats.timing.p90FallbackTimeMs / 1000).toFixed(3)}`);
    lines.push(`synapse_fallback_duration_seconds{quantile="0.95"} ${(stats.timing.p95FallbackTimeMs / 1000).toFixed(3)}`);
    lines.push(`synapse_fallback_duration_seconds{quantile="avg"} ${(stats.timing.avgFallbackTimeMs / 1000).toFixed(3)}`);

    // Per-category metrics
    for (const [category, catStats] of Object.entries(stats.byOperationCategory)) {
      lines.push(`synapse_fallback_by_category{category="${category}",status="total"} ${catStats.total}`);
      lines.push(`synapse_fallback_by_category{category="${category}",status="success"} ${catStats.success}`);
      lines.push(`synapse_fallback_by_category{category="${category}",status="failure"} ${catStats.failure}`);
    }

    // Active sessions
    lines.push('# HELP synapse_fallback_active_sessions Current number of active fallback sessions');
    lines.push('# TYPE synapse_fallback_active_sessions gauge');
    lines.push(`synapse_fallback_active_sessions ${stats.activeSessions}`);

    return lines.join('\n') + '\n';
  }

  /**
   * Get recent events for debugging and troubleshooting
   * @param {Object} options - Options
   * @param {number} [options.limit=100] - Maximum number of events to return
   * @param {string} [options.eventType] - Filter by event type
   * @param {string} [options.correlationId] - Filter by correlation ID
   * @returns {Array} Recent events
   */
  getRecentEvents(options = {}) {
    const { limit = 100, eventType, correlationId } = options;

    let events = [...this._eventHistory];

    // Apply filters
    if (eventType) {
      events = events.filter(e => e.type === eventType);
    }
    if (correlationId) {
      events = events.filter(e => e.correlationId === correlationId);
    }

    // Sort by timestamp descending and limit
    return events
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get summary of recent fallback failures for debugging
   * @param {number} [limit=20] - Maximum number of failures to return
   * @returns {Array} Summary of recent failures
   */
  getRecentFailureSummary(limit = 20) {
    const failureEvents = this._eventHistory
      .filter(e => e.type === FallbackEventType.COMPLETE_FAILURE)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    return failureEvents.map(event => ({
      correlationId: event.correlationId,
      timestamp: new Date(event.timestamp).toISOString(),
      primaryTool: event.data.primaryToolKey,
      operationCategory: event.data.operationCategory,
      failureReason: event.data.failureReason,
      totalAttempts: event.data.totalAttempts,
      failedAttempts: event.data.failedAttempts,
      elapsedMs: event.data.totalElapsedMs,
      session: this._activeSessions.get(event.correlationId) || null
    }));
  }

  /**
   * Get performance metrics for dashboard visualization
   * @returns {Object} Performance metrics
   */
  getPerformanceMetrics() {
    const stats = this.getStatistics();

    return {
      fallbackVolume: {
        total: stats.overall.totalFallbacks,
        success: stats.overall.successfulFallbacks,
        failure: stats.overall.failedFallbacks,
        rate: {
          success: stats.overall.successRate,
          failure: stats.overall.failureRate
        }
      },
      performance: {
        latency: {
          avg: stats.timing.avgFallbackTimeMs,
          p50: stats.timing.p50FallbackTimeMs,
          p90: stats.timing.p90FallbackTimeMs,
          p95: stats.timing.p95FallbackTimeMs
        },
        throughput: {
          avgAttemptsPerFallback: stats.attempts.avgAttemptsPerFallback,
          attemptSuccessRate: stats.attempts.attemptSuccessRate
        }
      },
      distribution: {
        byCategory: stats.byOperationCategory,
        topFallbackPairs: stats.commonFallbackPairs
      },
      system: {
        activeSessions: stats.activeSessions,
        retentionWindowMs: this.config.retentionWindowMs,
        alertThresholds: this.config.alertThresholds
      }
    };
  }

  /**
   * Get simplified statistics (alias for getStatistics)
   * @param {Object} filters - Filter options
   * @returns {Object} Statistics
   */
  getSimpleStatistics(filters = {}) {
    const { operationCategory, timeWindowMs } = filters;
    const now = Date.now();
    const cutoffTime = timeWindowMs ? now - timeWindowMs : 0;

    // Filter events by time window
    const relevantEvents = this._eventHistory.filter(event =>
      event.timestamp >= cutoffTime &&
      (!operationCategory || event.data.operationCategory === operationCategory)
    );

    // Calculate statistics from filtered events
    const completionEvents = relevantEvents.filter(e =>
      e.type === FallbackEventType.COMPLETE_SUCCESS ||
      e.type === FallbackEventType.COMPLETE_FAILURE
    );

    const successEvents = relevantEvents.filter(e => e.type === FallbackEventType.COMPLETE_SUCCESS);
    const failureEvents = relevantEvents.filter(e => e.type === FallbackEventType.COMPLETE_FAILURE);

    const totalFallbacks = completionEvents.length;
    const successfulFallbacks = successEvents.length;
    const failedFallbacks = failureEvents.length;

    // Calculate fallback times
    const fallbackTimes = successEvents
      .map(e => e.data.totalElapsedMs)
      .filter(t => t != null)
      .sort((a, b) => a - b);

    const avgFallbackTimeMs = fallbackTimes.length > 0
      ? fallbackTimes.reduce((sum, t) => sum + t, 0) / fallbackTimes.length
      : 0;

    const p50Index = Math.floor(fallbackTimes.length * 0.5);
    const p90Index = Math.floor(fallbackTimes.length * 0.9);
    const p95Index = Math.floor(fallbackTimes.length * 0.95);

    // Aggregate by operation category
    const byCategory = new Map();
    for (const event of completionEvents) {
      const category = event.data.operationCategory || 'unknown';
      if (!byCategory.has(category)) {
        byCategory.set(category, { total: 0, success: 0, failure: 0 });
      }
      const stats = byCategory.get(category);
      stats.total++;
      if (event.type === FallbackEventType.COMPLETE_SUCCESS) {
        stats.success++;
      } else {
        stats.failure++;
      }
    }

    // Common fallback pairs (primary tool → fallback tool)
    const fallbackPairs = new Map();
    for (const event of successEvents) {
      if (event.data.successfulAttempt) {
        const pair = `${event.data.primaryToolKey} → ${event.data.successfulAttempt.toolKey}`;
        fallbackPairs.set(pair, (fallbackPairs.get(pair) || 0) + 1);
      }
    }

    return {
      timeWindow: {
        startTime: cutoffTime,
        endTime: now,
        durationMs: timeWindowMs || 'all_time'
      },
      overall: {
        totalFallbacks,
        successfulFallbacks,
        failedFallbacks,
        successRate: totalFallbacks > 0 ? successfulFallbacks / totalFallbacks : 0,
        failureRate: totalFallbacks > 0 ? failedFallbacks / totalFallbacks : 0
      },
      timing: {
        avgFallbackTimeMs: Math.round(avgFallbackTimeMs),
        p50FallbackTimeMs: fallbackTimes[p50Index] || 0,
        p90FallbackTimeMs: fallbackTimes[p90Index] || 0,
        p95FallbackTimeMs: fallbackTimes[p95Index] || 0,
        minFallbackTimeMs: fallbackTimes[0] || 0,
        maxFallbackTimeMs: fallbackTimes[fallbackTimes.length - 1] || 0
      },
      byOperationCategory: Object.fromEntries(
        Array.from(byCategory.entries()).map(([cat, stats]) => [
          cat,
          {
            ...stats,
            successRate: stats.total > 0 ? stats.success / stats.total : 0
          }
        ])
      ),
      commonFallbackPairs: Object.fromEntries(
        Array.from(fallbackPairs.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10) // Top 10 most common pairs
      ),
      activeSessions: this._activeSessions.size
    };
  }

  /**
   * Get detailed information about an active or recent fallback session
   * @param {string} correlationId - Correlation ID
   * @returns {Object|null} Session details or null if not found
   */
  getSession(correlationId) {
    return this._activeSessions.get(correlationId) || null;
  }

  /**
   * Generate a unique correlation ID for fallback tracking
   * @private
   * @returns {string} Correlation ID
   */
  _generateCorrelationId() {
    return `fallback_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Record an event in the history
   * @private
   * @param {Object} event - Event to record
   */
  _recordEvent(event) {
    this._eventHistory.push(event);

    // Trim history if it exceeds max size
    if (this._eventHistory.length > this.config.maxEventHistory) {
      this._eventHistory.shift();
    }
  }

  /**
   * Update aggregated statistics based on completed session
   * @private
   * @param {Object} session - Completed session
   */
  _updateStatistics(session) {
    this._stats.totalFallbacks++;

    if (session.status === 'success') {
      this._stats.successfulFallbacks++;

      // Track common fallback pairs
      const successfulAttempt = session.attempts.find(a => a.status === 'success');
      if (successfulAttempt) {
        const pair = `${session.primaryToolKey}→${successfulAttempt.toolKey}`;
        this._stats.commonFallbackPairs.set(
          pair,
          (this._stats.commonFallbackPairs.get(pair) || 0) + 1
        );
      }
    } else {
      this._stats.failedFallbacks++;

      // Track failure reasons
      const reason = session.finalResult?.failureReason || 'unknown';
      this._stats.byFailureReason.set(
        reason,
        (this._stats.byFailureReason.get(reason) || 0) + 1
      );
    }

    // Update per-category statistics
    const category = session.operationCategory || 'unknown';
    if (!this._stats.byOperationCategory.has(category)) {
      this._stats.byOperationCategory.set(category, {
        total: 0,
        success: 0,
        failure: 0
      });
    }
    const categoryStats = this._stats.byOperationCategory.get(category);
    categoryStats.total++;
    if (session.status === 'success') {
      categoryStats.success++;
    } else {
      categoryStats.failure++;
    }
  }

  /**
   * Check alert thresholds and emit warnings
   * @private
   * @param {Object} session - Completed session
   */
  _checkAlertThresholds(session) {
    const stats = this.getStatistics({ timeWindowMs: this.config.retentionWindowMs });

    // Check fallback failure rate
    if (stats.overall.totalFallbacks >= 10 &&
        stats.overall.failureRate > this.config.alertThresholds.fallbackFailureRate) {
      log.error({
        failureRate: (stats.overall.failureRate * 100).toFixed(1) + '%',
        threshold: (this.config.alertThresholds.fallbackFailureRate * 100).toFixed(1) + '%',
        totalFallbacks: stats.overall.totalFallbacks
      }, 'ALERT: Fallback failure rate exceeds threshold');
    }

    // Check average fallback time
    if (stats.overall.totalFallbacks >= 10 &&
        stats.timing.avgFallbackTimeMs > this.config.alertThresholds.avgFallbackTimeMs) {
      log.error({
        avgFallbackTimeMs: stats.timing.avgFallbackTimeMs,
        threshold: this.config.alertThresholds.avgFallbackTimeMs,
        totalFallbacks: stats.overall.totalFallbacks
      }, 'ALERT: Average fallback time exceeds threshold');
    }
  }

  /**
   * Clean up old events outside retention window
   * @private
   */
  _cleanupOldEvents() {
    const cutoffTime = Date.now() - this.config.retentionWindowMs;
    const beforeCount = this._eventHistory.length;

    this._eventHistory = this._eventHistory.filter(event => event.timestamp >= cutoffTime);

    const removedCount = beforeCount - this._eventHistory.length;
    if (removedCount > 0) {
      log.debug({ removedCount, retainedCount: this._eventHistory.length }, 'Cleaned up old fallback events');
    }
  }

  /**
   * Shutdown the event tracker and clean up resources
   */
  shutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    log.info({
      totalFallbacks: this._stats.totalFallbacks,
      successfulFallbacks: this._stats.successfulFallbacks,
      activeSessions: this._activeSessions.size
    }, 'FallbackEventTracker shutting down');

    this.removeAllListeners();
  }

  /**
   * Get health status of the fallback system
   * @returns {Object} Health status with alerts
   */
  getHealthStatus() {
    const stats = this.getStatistics({ timeWindowMs: this.config.retentionWindowMs });

    const health = {
      status: 'healthy',
      alerts: [],
      metrics: {
        overall: stats.overall,
        timing: stats.timing,
        activeSessions: stats.activeSessions
      }
    };

    // Check fallback failure rate
    if (stats.overall.totalFallbacks >= 10) {
      const failureRate = stats.overall.failureRate;
      if (failureRate > this.config.alertThresholds.fallbackFailureRate) {
        health.status = 'degraded';
        health.alerts.push({
          severity: 'warning',
          type: 'high_failure_rate',
          message: `Fallback failure rate is ${(failureRate * 100).toFixed(1)}% (threshold: ${(this.config.alertThresholds.fallbackFailureRate * 100).toFixed(1)}%)`,
          value: failureRate,
          threshold: this.config.alertThresholds.fallbackFailureRate
        });
      }
    }

    // Check average fallback time
    if (stats.overall.totalFallbacks >= 10) {
      const avgTime = stats.timing.avgFallbackTimeMs;
      if (avgTime > this.config.alertThresholds.avgFallbackTimeMs) {
        health.status = health.status === 'healthy' ? 'degraded' : 'unhealthy';
        health.alerts.push({
          severity: 'warning',
          type: 'slow_fallback',
          message: `Average fallback time is ${avgTime}ms (threshold: ${this.config.alertThresholds.avgFallbackTimeMs}ms)`,
          value: avgTime,
          threshold: this.config.alertThresholds.avgFallbackTimeMs
        });
      }
    }

    // Check for stuck active sessions (sessions running for > 5 minutes)
    const stuckSessions = [];
    for (const [correlationId, session] of this._activeSessions.entries()) {
      const elapsedMs = Date.now() - session.startTime;
      if (elapsedMs > 300000) { // 5 minutes
        stuckSessions.push({
          correlationId,
          primaryTool: session.primaryToolKey,
          elapsedMs,
          attemptCount: session.attempts.length
        });
      }
    }

    if (stuckSessions.length > 0) {
      health.status = 'unhealthy';
      health.alerts.push({
        severity: 'critical',
        type: 'stuck_sessions',
        message: `${stuckSessions.length} fallback sessions running for > 5 minutes`,
        stuckSessions
      });
    }

    return health;
  }
}
