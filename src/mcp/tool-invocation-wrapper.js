import { createLogger } from '../logger.js';
import config from '../config.js';
import { createExecutionMetricsCollector } from './execution-metrics-collector.js';
import { createToolErrorHandlingCoordinator } from './tool-error-handling-coordinator.js';
import { toolErrorCategorizer } from './tool-error-categorization.js';

const log = createLogger('mcp-tool-invocation-wrapper');

/**
 * ToolInvocationError — Structured error for tool invocation failures.
 *
 * Error codes:
 * - TIMEOUT: Tool invocation exceeded timeout threshold
 * - CHUNK_TIMEOUT: Streaming tool produced no chunk within the inter-chunk timeout
 * - TOOL_ERROR: Tool execution failed with error response
 * - CONNECTION_ERROR: MCP connection lost during invocation
 * - INVALID_RESPONSE: Response format unexpected or malformed
 * - MALFORMED_RESPONSE: Tool returned a structurally invalid response
 * - VALIDATION_ERROR: Tool parameters failed validation before invocation
 * - CIRCUIT_OPEN: Circuit breaker is open for this tool
 *
 * @param {string} message - Error message
 * @param {string} code - Error code
 * @param {Object} context - Additional context (toolName, timeoutMs, elapsedMs, etc.)
 * @param {Object} [enrichment] - Optional enrichment from error categorizer
 * @param {string} [enrichment.recovery] - Primary recovery strategy key
 * @param {string[]} [enrichment.recoveryActions] - Human-readable recovery steps
 * @param {string} [enrichment.toolCategory] - Tool category (filesystem, network, etc.)
 * @param {boolean} [enrichment.retryable] - Whether the error is retryable
 * @param {string} [enrichment.severity] - Error severity (low, medium, high)
 */
export class ToolInvocationError extends Error {
  constructor(message, code, context = {}, enrichment = {}) {
    super(message);
    this.name = 'ToolInvocationError';
    this.code = code;
    this.context = context;

    // Tool-specific enrichment fields
    this.recovery = enrichment.recovery || null;
    this.recoveryActions = enrichment.recoveryActions || [];
    this.toolCategory = enrichment.toolCategory || null;
    this.retryable = enrichment.retryable !== undefined ? enrichment.retryable : _defaultRetryable(code);
    this.severity = enrichment.severity || _defaultSeverity(code);

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      recovery: this.recovery,
      recoveryActions: this.recoveryActions,
      toolCategory: this.toolCategory,
      retryable: this.retryable,
      severity: this.severity
    };
  }

  /**
   * Classify a raw error into a ToolInvocationError with tool-specific enrichment.
   *
   * Uses ToolSpecificErrorCategorizer to determine category, severity, retryability,
   * and recovery suggestions based on both the tool name and error characteristics.
   *
   * @param {string} toolName - Name of the tool that failed
   * @param {Error|Object} rawError - The raw error to classify
   * @param {Object} [context] - Additional context (elapsedMs, timeoutMs, etc.)
   * @returns {ToolInvocationError} Enriched error instance
   */
  static classify(toolName, rawError, context = {}) {
    return classifyToolError(toolName, rawError, context);
  }
}

/**
 * Determine default retryability for a given error code.
 *
 * @private
 * @param {string} code - ToolInvocationError code
 * @returns {boolean}
 */
function _defaultRetryable(code) {
  switch (code) {
    case 'TIMEOUT':
    case 'CHUNK_TIMEOUT':
    case 'CONNECTION_ERROR':
      return true;
    case 'TOOL_ERROR':
    case 'INVALID_RESPONSE':
    case 'MALFORMED_RESPONSE':
    case 'VALIDATION_ERROR':
    case 'CIRCUIT_OPEN':
      return false;
    default:
      return false;
  }
}

/**
 * Determine default severity for a given error code.
 *
 * @private
 * @param {string} code - ToolInvocationError code
 * @returns {string}
 */
function _defaultSeverity(code) {
  switch (code) {
    case 'TIMEOUT':
    case 'CHUNK_TIMEOUT':
    case 'TOOL_ERROR':
      return 'medium';
    case 'CONNECTION_ERROR':
    case 'CIRCUIT_OPEN':
      return 'high';
    case 'INVALID_RESPONSE':
    case 'MALFORMED_RESPONSE':
    case 'VALIDATION_ERROR':
      return 'low';
    default:
      return 'medium';
  }
}

/**
 * Map a raw error name/type to a ToolInvocationError code.
 *
 * @private
 * @param {Error|Object} rawError - Raw error to inspect
 * @returns {string} ToolInvocationError code
 */
function _mapErrorCode(rawError) {
  if (!rawError) return 'TOOL_ERROR';
  const name = rawError.name || rawError.constructor?.name || '';
  const code = rawError.code || '';

  if (name === 'TimeoutError' || code === 'TIMEOUT_ERROR') return 'TIMEOUT';
  if (name === 'ConnectionError' || code === 'CONNECTION_ERROR') return 'CONNECTION_ERROR';
  if (name === 'ProtocolError' || code === 'PROTOCOL_ERROR') return 'INVALID_RESPONSE';
  if (name === 'MalformedResponseError' || code === 'MALFORMED_RESPONSE_ERROR') return 'MALFORMED_RESPONSE';
  if (name === 'AuthenticationError' || code === 'AUTHENTICATION_ERROR') return 'CONNECTION_ERROR';
  if (name === 'ValidationError' || code === 'VALIDATION_ERROR') return 'VALIDATION_ERROR';
  if (code === 'CIRCUIT_OPEN') return 'CIRCUIT_OPEN';

  return 'TOOL_ERROR';
}

/**
 * Classify a raw error into a ToolInvocationError with tool-specific enrichment.
 *
 * Combines error-type-based code mapping with tool-specific categorization
 * to produce a fully enriched ToolInvocationError.
 *
 * @param {string} toolName - Name of the tool that failed
 * @param {Error|Object} rawError - The raw error to classify
 * @param {Object} [context] - Additional context (elapsedMs, timeoutMs, etc.)
 * @returns {ToolInvocationError} Enriched error instance
 */
export function classifyToolError(toolName, rawError, context = {}) {
  const invocationCode = _mapErrorCode(rawError);
  const errorForCategorizer = {
    code: rawError?.code || invocationCode,
    message: rawError?.message || String(rawError)
  };

  let enrichment = {};
  try {
    const categorized = toolErrorCategorizer.categorizeError(toolName, errorForCategorizer, context);
    const recoveryRecs = toolErrorCategorizer.getRecoveryRecommendations(toolName, errorForCategorizer);

    enrichment = {
      recovery: categorized.recovery || null,
      recoveryActions: recoveryRecs.recommendations.map(r => r.description),
      toolCategory: categorized.category || null,
      retryable: categorized.retryable !== undefined ? categorized.retryable : _defaultRetryable(invocationCode),
      severity: categorized.severity || _defaultSeverity(invocationCode)
    };
  } catch (categorizationErr) {
    log.warn({ toolName, err: categorizationErr.message }, 'Error categorization failed, using defaults');
  }

  const message = rawError?.message
    ? `Tool '${toolName}' failed: ${rawError.message}`
    : `Tool '${toolName}' invocation failed`;

  return new ToolInvocationError(message, invocationCode, {
    ...context,
    toolName,
    originalError: rawError?.message,
    originalCode: rawError?.code
  }, enrichment);
}

/**
 * ToolTimeoutConfig — Per-tool timeout configuration.
 *
 * Supports both global defaults and per-tool overrides.
 * Per-tool configs take precedence over global defaults.
 *
 * @typedef {Object} ToolTimeoutConfig
 * @property {number} defaultTimeoutMs - Default timeout for all tools (from config)
 * @property {Record<string, number>} [perToolTimeouts] - Per-tool timeout overrides
 * @property {number} [minTimeoutMs] - Minimum allowed timeout (default: 1000ms)
 * @property {number} [maxTimeoutMs] - Maximum allowed timeout (default: 300000ms)
 */

/**
 * ExecutionMetrics — Metrics collected during tool invocation.
 *
 * Captures timing information for monitoring and alerting.
 *
 * @typedef {Object} ExecutionMetrics
 * @property {string} toolName - Name of the invoked tool
 * @property {number} startTime - Invocation start timestamp (ms)
 * @property {number} endTime - Invocation end timestamp (ms)
 * @property {number} elapsedMs - Total elapsed time (ms)
 * @property {number} timeoutMs - Configured timeout (ms)
 * @property {string} status - Final status (success, timeout, error)
 * @property {string} [errorCode] - Error code if failed
 * @property {number} [retryCount] - Number of retries attempted
 */

/**
 * ToolTimeoutManager — Manages per-tool timeout configuration.
 *
 * Provides centralized timeout resolution with support for:
 * - Global default timeout from config
 * - Per-tool timeout overrides
 * - Timeout validation and clamping
 * - Metrics collection for monitoring
 */
export class ToolTimeoutManager {
  /**
   * Create a ToolTimeoutManager instance.
   *
   * @param {Object} config - Timeout manager configuration
   * @param {number} [config.defaultTimeoutMs] - Default timeout (uses config.mcp.toolInvocationTimeoutMs if not provided)
   * @param {Record<string, number>} [config.perToolTimeouts] - Per-tool timeout overrides
   * @param {number} [config.minTimeoutMs=1000] - Minimum allowed timeout
   * @param {number} [config.maxTimeoutMs=300000] - Maximum allowed timeout
   */
  constructor({
    defaultTimeoutMs = config.mcp.toolInvocationTimeoutMs,
    perToolTimeouts = {},
    minTimeoutMs = 1000,
    maxTimeoutMs = 300000,
    metricsCollector = null
  } = {}) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.perToolTimeouts = new Map(Object.entries(perToolTimeouts));
    this.minTimeoutMs = minTimeoutMs;
    this.maxTimeoutMs = maxTimeoutMs;
    
    // Use provided metrics collector or create default instance
    this._metricsCollector = metricsCollector || createExecutionMetricsCollector();
    
    // Legacy metrics storage for backward compatibility
    this._metrics = [];
    this._maxMetricsHistory = 1000;
  }

  /**
   * Resolve the effective timeout for a tool.
   *
   * Checks per-tool overrides first, then falls back to global default.
   * Clamps the result to the configured min/max bounds.
   *
   * @param {string} toolName - Tool name to look up
   * @param {number} [overrideTimeoutMs] - Optional per-invocation override
   * @returns {number} Effective timeout in milliseconds
   */
  getTimeout(toolName, overrideTimeoutMs = null) {
    let timeoutMs;

    if (overrideTimeoutMs !== null && overrideTimeoutMs !== undefined) {
      timeoutMs = overrideTimeoutMs;
    } else if (this.perToolTimeouts.has(toolName)) {
      timeoutMs = this.perToolTimeouts.get(toolName);
    } else {
      timeoutMs = this.defaultTimeoutMs;
    }

    return this._clampTimeout(timeoutMs, toolName);
  }

  /**
   * Set a per-tool timeout override.
   *
   * @param {string} toolName - Tool name
   * @param {number} timeoutMs - Timeout in milliseconds
   */
  setToolTimeout(toolName, timeoutMs) {
    const clamped = this._clampTimeout(timeoutMs, toolName);
    this.perToolTimeouts.set(toolName, clamped);
    log.debug({ toolName, timeoutMs: clamped }, 'Per-tool timeout configured');
  }

  /**
   * Remove a per-tool timeout override.
   *
   * @param {string} toolName - Tool name
   * @returns {boolean} True if timeout was removed, false if not found
   */
  removeToolTimeout(toolName) {
    const removed = this.perToolTimeouts.delete(toolName);
    if (removed) {
      log.debug({ toolName }, 'Per-tool timeout removed');
    }
    return removed;
  }

  /**
   * Get all per-tool timeout configurations.
   *
   * @returns {Record<string, number>} Map of tool names to timeouts
   */
  getAllToolTimeouts() {
    const result = {};
    for (const [toolName, timeoutMs] of this.perToolTimeouts.entries()) {
      result[toolName] = timeoutMs;
    }
    return result;
  }

  /**
   * Clamp timeout value to configured bounds with logging.
   *
   * @private
   * @param {number} timeoutMs - Timeout to clamp
   * @param {string} toolName - Tool name for logging context
   * @returns {number} Clamped timeout value
   */
  _clampTimeout(timeoutMs, toolName) {
    if (timeoutMs < this.minTimeoutMs) {
      log.warn({ toolName, timeoutMs, minTimeoutMs: this.minTimeoutMs }, 'Timeout below minimum, clamping');
      return this.minTimeoutMs;
    }
    if (timeoutMs > this.maxTimeoutMs) {
      log.warn({ toolName, timeoutMs, maxTimeoutMs: this.maxTimeoutMs }, 'Timeout above maximum, clamping');
      return this.maxTimeoutMs;
    }
    return timeoutMs;
  }

  /**
   * Record execution metrics for a tool invocation.
   *
   * @param {ExecutionMetrics} metrics - Metrics to record
   * @param {string} [serverId] - Optional MCP server ID for enhanced tracking
   */
  recordMetrics(metrics, serverId = null) {
    // Record to legacy storage for backward compatibility
    this._metrics.push(metrics);
    if (this._metrics.length > this._maxMetricsHistory) {
      this._metrics.shift();
    }
    
    // Record to enhanced metrics collector
    if (this._metricsCollector) {
      this._metricsCollector.record({
        toolName: metrics.toolName,
        serverId: serverId || 'unknown',
        timestamp: metrics.startTime,
        startTime: metrics.startTime,
        endTime: metrics.endTime,
        elapsedMs: metrics.elapsedMs,
        timeoutMs: metrics.timeoutMs,
        status: metrics.status,
        errorCode: metrics.errorCode || undefined,
        retryCount: metrics.retryCount || 0,
        chunkCount: metrics.chunkCount || undefined,
        isStreaming: metrics.chunkCount !== undefined
      });
    }
  }

  /**
   * Get recent execution metrics.
   *
   * @param {number} [limit=100] - Maximum number of metrics to return
   * @returns {ExecutionMetrics[]} Recent execution metrics
   */
  getRecentMetrics(limit = 100) {
    // Use enhanced collector if available, fallback to legacy storage
    if (this._metricsCollector) {
      return this._metricsCollector.getRecentMetrics(limit);
    }
    const start = Math.max(0, this._metrics.length - limit);
    return this._metrics.slice(start);
  }

  /**
   * Get aggregated timeout statistics.
   *
   * @returns {Object} Aggregated statistics
   */
  getTimeoutStats() {
    // Use enhanced collector if available for comprehensive stats
    if (this._metricsCollector) {
      const aggregate = this._metricsCollector.getAggregateSummary();
      return {
        totalInvocations: aggregate.totalInvocations,
        timeouts: aggregate.timeoutCount,
        success: aggregate.successCount,
        errors: aggregate.errorCount,
        avgElapsedMs: aggregate.avgElapsedMs,
        p50ElapsedMs: aggregate.p50ElapsedMs,
        p90ElapsedMs: aggregate.p90ElapsedMs,
        p95ElapsedMs: aggregate.p95ElapsedMs,
        p99ElapsedMs: aggregate.p99ElapsedMs,
        successRate: aggregate.successRate,
        timeoutRate: aggregate.timeoutRate,
        errorRate: aggregate.errorRate,
        uniqueTools: aggregate.uniqueTools
      };
    }
    
    // Fallback to legacy storage
    if (this._metrics.length === 0) {
      return {
        totalInvocations: 0,
        timeouts: 0,
        success: 0,
        errors: 0,
        avgElapsedMs: 0,
        p95ElapsedMs: 0,
        p99ElapsedMs: 0
      };
    }

    const elapsedTimes = this._metrics.map(m => m.elapsedMs).sort((a, b) => a - b);
    const total = this._metrics.length;
    const timeouts = this._metrics.filter(m => m.status === 'timeout').length;
    const success = this._metrics.filter(m => m.status === 'success').length;
    const errors = this._metrics.filter(m => m.status === 'error').length;

    const avgElapsedMs = elapsedTimes.reduce((a, b) => a + b, 0) / total;
    const p95Index = Math.floor(total * 0.95);
    const p99Index = Math.floor(total * 0.99);

    return {
      totalInvocations: total,
      timeouts,
      success,
      errors,
      avgElapsedMs: Math.round(avgElapsedMs * 100) / 100,
      p95ElapsedMs: elapsedTimes[p95Index] || 0,
      p99ElapsedMs: elapsedTimes[p99Index] || 0
    };
  }

  /**
   * Clear all recorded metrics.
   */
  clearMetrics() {
    this._metrics = [];
    if (this._metricsCollector) {
      this._metricsCollector.clear();
    }
    log.debug('Execution metrics cleared');
  }

  /**
   * Get the underlying metrics collector for advanced operations.
   *
   * @returns {ExecutionMetricsCollector|null} The metrics collector instance
   */
  getMetricsCollector() {
    return this._metricsCollector;
  }

  /**
   * Get per-tool summary metrics.
   *
   * @param {string} toolName - Tool name
   * @returns {Object|null} Tool summary or null if not available
   */
  getToolSummary(toolName) {
    if (this._metricsCollector) {
      return this._metricsCollector.getToolSummary(toolName);
    }
    return null;
  }

  /**
   * Get all tool summaries.
   *
   * @returns {Object} Map of toolName -> summary
   */
  getAllToolSummaries() {
    if (this._metricsCollector) {
      return this._metricsCollector.getAllToolSummaries();
    }
    return {};
  }

  /**
   * Get collector statistics.
   *
   * @returns {Object} Collector stats
   */
  getCollectorStats() {
    if (this._metricsCollector) {
      return this._metricsCollector.getStats();
    }
    return {
      totalMetricsStored: this._metrics.length,
      uniqueTools: 0
    };
  }
}

/**
 * invokeToolWithTimeout — Wrap MCP tool invocation with timeout enforcement.
 *
 * Wraps MCPClient.callTool to enforce a configurable per-call timeout.
 * Uses Promise.race to cancel pending requests that exceed the timeout.
 *
 * @param {MCPClient} client - MCPClient instance
 * @param {string} toolName - Name of the tool to invoke
 * @param {Object} args - Tool arguments
 * @param {Object} options - Invocation options
 * @param {number} [options.timeoutMs] - Timeout in ms (defaults to config.mcp.toolInvocationTimeoutMs)
 * @param {Function} [options.onTimeout] - Optional callback invoked on timeout (receives { toolName, timeoutMs })
 * @param {ToolTimeoutManager} [options.timeoutManager] - Optional timeout manager for per-tool configs and metrics
 * @param {ToolCircuitBreaker} [options.circuitBreaker] - Optional circuit breaker for failure tracking
 * @param {string} [options.circuitBreakerKey] - Key for circuit breaker (defaults to toolName)
 * @param {string} [options.serverId] - Optional MCP server ID for enhanced metrics tracking
 * @returns {Promise<Object>} Invocation result with standardized format:
 *   - On success: { status: 'success', result: <toolResult> }
 *   - On timeout: { status: 'error', code: 'TIMEOUT', error: <error>, context: { toolName, timeoutMs, elapsedMs } }
 *   - On error: { status: 'error', code: <errorCode>, error: <error>, context: { toolName } }
 */
export async function invokeToolWithTimeout(client, toolName, args = {}, options = {}) {
  const {
    timeoutMs: overrideTimeoutMs,
    onTimeout,
    timeoutManager,
    circuitBreaker,
    circuitBreakerKey = toolName,
    serverId,
    errorHandlingCoordinator
  } = options;

  const effectiveTimeoutMs = timeoutManager
    ? timeoutManager.getTimeout(toolName, overrideTimeoutMs)
    : (overrideTimeoutMs ?? config.mcp.toolInvocationTimeoutMs);

  // Check circuit breaker BEFORE invoking — reject immediately if open
  if (circuitBreaker) {
    const check = circuitBreaker.canExecute(circuitBreakerKey);
    if (!check.allowed) {
      const cbError = new ToolInvocationError(
        check.error?.message || `Circuit breaker open for tool '${toolName}'`,
        'CIRCUIT_OPEN',
        { toolName, circuitBreakerKey },
        {
          recovery: 'wait_for_circuit_breaker_cooldown',
          recoveryActions: [
            'Wait for the circuit breaker cooldown period to expire before retrying.',
            'Investigate recent tool failures that tripped the circuit breaker.',
            'Consider using an alternative tool if available.'
          ],
          toolCategory: toolErrorCategorizer.getToolCategory(toolName),
          retryable: false,
          severity: 'high'
        }
      );
      log.warn({ toolName, circuitBreakerKey }, 'Rejecting tool invocation — circuit breaker is open');
      return {
        status: 'error',
        code: 'CIRCUIT_OPEN',
        error: cbError.message,
        context: { toolName, circuitBreakerKey },
        recovery: cbError.recovery,
        recoveryActions: cbError.recoveryActions,
        toolCategory: cbError.toolCategory,
        retryable: false,
        severity: 'high'
      };
    }
  }

  log.debug({ toolName, timeoutMs: effectiveTimeoutMs, args }, 'Invoking tool with timeout');

  const startTime = Date.now();
  let timeoutId = null;
  let aborted = false;

  // Create timeout promise with proper cleanup
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      aborted = true;
      const timeoutError = new ToolInvocationError(
        `Tool invocation timed out after ${effectiveTimeoutMs}ms`,
        'TIMEOUT',
        { toolName, timeoutMs: effectiveTimeoutMs },
        {
          recovery: 'increase_timeout_or_retry',
          recoveryActions: [
            `Increase the timeout beyond the current ${effectiveTimeoutMs}ms limit.`,
            'Retry the invocation if the tool is transiently slow.',
            'Check if the MCP server is under high load.'
          ],
          toolCategory: toolErrorCategorizer.getToolCategory(toolName),
          retryable: true,
          severity: 'medium'
        }
      );
      reject(timeoutError);
    }, effectiveTimeoutMs);
  });

  // Create tool invocation promise
  const invocationPromise = client.callTool(toolName, args).catch(err => {
    const elapsedMs = Date.now() - startTime;
    // Use classifyToolError for rich tool-specific error codes and recovery hints
    throw classifyToolError(toolName, err, { elapsedMs, timeoutMs: effectiveTimeoutMs });
  });

  try {
    // Race between invocation and timeout
    const result = await Promise.race([
      invocationPromise,
      timeoutPromise
    ]);

    const elapsedMs = Date.now() - startTime;
    
    // Clear timeout since invocation completed
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    log.debug({ toolName, elapsedMs, status: 'success' }, 'Tool invocation completed');

    // Record metrics if timeout manager provided
    if (timeoutManager) {
      timeoutManager.recordMetrics({
        toolName,
        startTime,
        endTime: Date.now(),
        elapsedMs,
        timeoutMs: effectiveTimeoutMs,
        status: 'success'
      }, serverId);
    }

    // Record success in circuit breaker if provided
    if (circuitBreaker) {
      circuitBreaker.recordSuccess(circuitBreakerKey);
    }

    return {
      status: 'success',
      result,
      context: { toolName, elapsedMs, timeoutMs: effectiveTimeoutMs }
    };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;

    // Clear timeout if still pending
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Record metrics if timeout manager provided
    if (timeoutManager) {
      timeoutManager.recordMetrics({
        toolName,
        startTime,
        endTime: Date.now(),
        elapsedMs,
        timeoutMs: effectiveTimeoutMs,
        status: err.code === 'TIMEOUT' ? 'timeout' : 'error',
        errorCode: err.code
      }, serverId);
    }

    if (err instanceof ToolInvocationError && err.code === 'TIMEOUT') {
      log.warn({
        toolName,
        timeoutMs: effectiveTimeoutMs,
        elapsedMs,
        errorType: 'TIMEOUT'
      }, 'Tool invocation timed out');

      // Record failure in circuit breaker if provided
      if (circuitBreaker) {
        circuitBreaker.recordFailure(circuitBreakerKey);
      }

      // Invoke timeout callback if provided
      if (typeof onTimeout === 'function') {
        try {
          onTimeout({ toolName, timeoutMs: effectiveTimeoutMs, elapsedMs });
        } catch (callbackErr) {
          log.error({
            toolName,
            err: callbackErr,
            errorType: callbackErr.constructor.name
          }, 'Error in onTimeout callback');
        }
      }

      // Use error handling coordinator if available for enhanced timeout processing
      if (errorHandlingCoordinator) {
        try {
          const enhancedError = await errorHandlingCoordinator.handleTimeout(
            {
              timeoutMs: effectiveTimeoutMs,
              elapsedMs,
              partialChunks: []
            },
            {
              toolName,
              serverId: serverId || 'unknown',
              toolId: null,
              requestId: null
            }
          );

          return {
            status: 'error',
            code: 'TIMEOUT',
            error: err.message,
            context: {
              toolName,
              timeoutMs: effectiveTimeoutMs,
              elapsedMs
            },
            // Enhanced error handling information
            enhancedError,
            recoveryActions: enhancedError.recoveryActions,
            retryable: enhancedError.retryable,
            severity: enhancedError.severity,
            category: enhancedError.category,
            alternativeTools: enhancedError.alternativeTools,
            retryPolicy: enhancedError.retryPolicy
          };
        } catch (coordinationError) {
          log.warn({
            toolName,
            coordinationError: coordinationError.message
          }, 'Error handling coordinator failed for timeout, falling back');
        }
      }

      // Fallback to basic timeout error handling — include enrichment from ToolInvocationError
      return {
        status: 'error',
        code: 'TIMEOUT',
        error: err.message,
        context: {
          toolName,
          timeoutMs: effectiveTimeoutMs,
          elapsedMs
        },
        recovery: err.recovery,
        recoveryActions: err.recoveryActions,
        toolCategory: err.toolCategory,
        retryable: err.retryable,
        severity: err.severity
      };
    }

    // Record failure in circuit breaker for non-timeout errors
    if (circuitBreaker && err instanceof ToolInvocationError) {
      circuitBreaker.recordFailure(circuitBreakerKey);
    }

    // Handle other error types
    log.error({
      toolName,
      err: err.message,
      errorType: err.constructor.name,
      errorCode: err.code,
      errorCategory: err.toolCategory,
      severity: err.severity,
      retryable: err.retryable,
      elapsedMs
    }, 'Tool invocation failed');

    // Use error handling coordinator if available for enhanced error processing
    if (errorHandlingCoordinator) {
      try {
        const enhancedError = await errorHandlingCoordinator.handleToolExecutionError(
          {
            message: err.message,
            errorCode: err.code || 'UNKNOWN_ERROR',
            stack: err.stack,
            originalError: err
          },
          {
            toolName,
            serverId: serverId || 'unknown',
            toolId: null,
            requestId: null
          }
        );

        // Preserve backward compatibility while adding enhanced error info
        return {
          status: 'error',
          code: err.code || 'UNKNOWN_ERROR',
          error: err.message,
          context: {
            toolName,
            elapsedMs,
            timeoutMs: effectiveTimeoutMs,
            originalError: err.context?.originalError
          },
          // Tool-specific enrichment from ToolInvocationError
          recovery: err.recovery,
          recoveryActions: err.recoveryActions?.length
            ? err.recoveryActions
            : enhancedError.recoveryActions,
          toolCategory: err.toolCategory,
          retryable: err.retryable !== null ? err.retryable : enhancedError.retryable,
          severity: err.severity || enhancedError.severity,
          // Enhanced error handling information
          enhancedError,
          category: enhancedError.category,
          alternativeTools: enhancedError.alternativeTools,
          requiresUserIntervention: enhancedError.requiresUserIntervention
        };
      } catch (coordinationError) {
        log.warn({
          toolName,
          coordinationError: coordinationError.message
        }, 'Error handling coordinator failed, falling back to basic error handling');
      }
    }

    // Fallback to basic error handling — include enrichment from ToolInvocationError
    return {
      status: 'error',
      code: err.code || 'UNKNOWN_ERROR',
      error: err.message,
      context: {
        toolName,
        elapsedMs,
        timeoutMs: effectiveTimeoutMs,
        originalError: err.context?.originalError
      },
      recovery: err.recovery,
      recoveryActions: err.recoveryActions,
      toolCategory: err.toolCategory,
      retryable: err.retryable,
      severity: err.severity
    };
  }
}

/**
 * invokeToolWithStreaming — Invoke tool with streaming result support.
 *
 * For tools that support streaming, this wrapper collects streaming chunks
 * and enforces timeout on the overall invocation.
 *
 * @param {MCPClient} client - MCPClient instance
 * @param {string} toolName - Name of the tool to invoke
 * @param {Object} args - Tool arguments
 * @param {Object} options - Invocation options
 * @param {number} [options.timeoutMs] - Timeout in ms (defaults to config.mcp.toolInvocationTimeoutMs)
 * @param {number} [options.chunkTimeoutMs] - Timeout between chunks (defaults to 30s)
 * @param {Function} [options.onChunk] - Callback invoked for each streaming chunk
 * @param {Function} [options.onTimeout] - Callback invoked on timeout
 * @param {ToolTimeoutManager} [options.timeoutManager] - Optional timeout manager for per-tool configs and metrics
 * @param {ToolCircuitBreaker} [options.circuitBreaker] - Optional circuit breaker for failure tracking
 * @param {string} [options.circuitBreakerKey] - Key for circuit breaker (defaults to toolName)
 * @param {string} [options.serverId] - Optional MCP server ID for enhanced metrics tracking
 * @returns {Promise<Object>} Aggregated result with streaming metadata
 */
export async function invokeToolWithStreaming(client, toolName, args = {}, options = {}) {
  const {
    timeoutMs: overrideTimeoutMs,
    chunkTimeoutMs = 30000,
    onChunk,
    onTimeout,
    timeoutManager,
    circuitBreaker,
    circuitBreakerKey = toolName,
    serverId,
    errorHandlingCoordinator
  } = options;

  const effectiveTimeoutMs = timeoutManager
    ? timeoutManager.getTimeout(toolName, overrideTimeoutMs)
    : (overrideTimeoutMs ?? config.mcp.toolInvocationTimeoutMs);

  // Check circuit breaker BEFORE invoking — reject immediately if open
  if (circuitBreaker) {
    const check = circuitBreaker.canExecute(circuitBreakerKey);
    if (!check.allowed) {
      const cbError = new ToolInvocationError(
        check.error?.message || `Circuit breaker open for tool '${toolName}'`,
        'CIRCUIT_OPEN',
        { toolName, circuitBreakerKey },
        {
          recovery: 'wait_for_circuit_breaker_cooldown',
          recoveryActions: [
            'Wait for the circuit breaker cooldown period to expire before retrying.',
            'Investigate recent tool failures that tripped the circuit breaker.',
            'Consider using an alternative tool if available.'
          ],
          toolCategory: toolErrorCategorizer.getToolCategory(toolName),
          retryable: false,
          severity: 'high'
        }
      );
      log.warn({ toolName, circuitBreakerKey }, 'Rejecting streaming tool invocation — circuit breaker is open');
      return {
        status: 'error',
        code: 'CIRCUIT_OPEN',
        error: cbError.message,
        chunks: [],
        context: { toolName, circuitBreakerKey },
        recovery: cbError.recovery,
        recoveryActions: cbError.recoveryActions,
        toolCategory: cbError.toolCategory,
        retryable: false,
        severity: 'high'
      };
    }
  }

  log.debug({ toolName, timeoutMs: effectiveTimeoutMs, streaming: true }, 'Invoking tool with streaming');

  const chunks = [];
  const startTime = Date.now();
  let timeoutId = null;
  let chunkTimeoutId = null;

  let rejectChunkPromise = null;
  let chunkPromiseResolved = false;

  // Create chunk-timeout promise — fires if no chunk arrives within chunkTimeoutMs.
  // rejectChunkPromise is assigned synchronously before resetChunkTimeout is called.
  const chunkTimeoutPromise = new Promise((_, reject) => {
    rejectChunkPromise = reject;
  });

  // Reset chunk timeout on each chunk
  const resetChunkTimeout = () => {
    if (chunkTimeoutId !== null) {
      clearTimeout(chunkTimeoutId);
    }
    chunkTimeoutId = setTimeout(() => {
      const err = new ToolInvocationError(
        `Chunk timeout: no data received for ${chunkTimeoutMs}ms`,
        'CHUNK_TIMEOUT',
        { toolName, chunkTimeoutMs, chunksCollected: chunks.length },
        {
          recovery: 'increase_chunk_timeout_or_retry',
          recoveryActions: [
            `Increase the chunk timeout beyond the current ${chunkTimeoutMs}ms limit.`,
            'Retry the invocation if the streaming source is transiently slow.',
            'Check if the MCP server is producing data at a reduced rate.'
          ],
          toolCategory: toolErrorCategorizer.getToolCategory(toolName),
          retryable: true,
          severity: 'medium'
        }
      );
      rejectChunkPromise(err);
    }, chunkTimeoutMs);
  };

  // Create timeout promise with proper cleanup
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new ToolInvocationError(
        `Streaming tool invocation timed out after ${effectiveTimeoutMs}ms`,
        'TIMEOUT',
        { toolName, timeoutMs: effectiveTimeoutMs, chunksCollected: chunks.length },
        {
          recovery: 'increase_timeout_or_retry',
          recoveryActions: [
            `Increase the timeout beyond the current ${effectiveTimeoutMs}ms limit.`,
            'Retry the invocation if the tool is transiently slow.',
            'Check if the MCP server is under high load.'
          ],
          toolCategory: toolErrorCategorizer.getToolCategory(toolName),
          retryable: true,
          severity: 'medium'
        }
      );
      reject(timeoutError);
    }, effectiveTimeoutMs);
  });

  // Create invocation promise with chunk collection
  const invocationPromise = (async () => {
    try {
      resetChunkTimeout();

      // Note: Current MCPClient.callTool doesn't support streaming natively.
      // This is a placeholder for future streaming support.
      // For now, fall back to regular invocation.
      const result = await client.callTool(toolName, args);
      
      // Clear chunk timeout on completion
      if (chunkTimeoutId !== null) {
        clearTimeout(chunkTimeoutId);
        chunkTimeoutId = null;
      }
      chunkPromiseResolved = true;
      
      // Emit single chunk for non-streaming tools
      if (typeof onChunk === 'function') {
        onChunk({ data: result, final: true });
        chunks.push(result);
      }
      
      return result;
    } catch (err) {
      if (chunkTimeoutId !== null) {
        clearTimeout(chunkTimeoutId);
        chunkTimeoutId = null;
      }
      chunkPromiseResolved = true;

      const elapsedMs = Date.now() - startTime;
      throw classifyToolError(toolName, err, { elapsedMs, timeoutMs: effectiveTimeoutMs });
    }
  })();

  try {
    const result = await Promise.race([
      invocationPromise,
      timeoutPromise,
      chunkTimeoutPromise
    ]);

    const elapsedMs = Date.now() - startTime;

    // Clear timeouts since invocation completed
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (chunkTimeoutId !== null) {
      clearTimeout(chunkTimeoutId);
      chunkTimeoutId = null;
    }

    log.debug({ toolName, elapsedMs, chunkCount: chunks.length, status: 'success' }, 'Streaming tool invocation completed');

    // Record metrics if timeout manager provided
    if (timeoutManager) {
      timeoutManager.recordMetrics({
        toolName,
        startTime,
        endTime: Date.now(),
        elapsedMs,
        timeoutMs: effectiveTimeoutMs,
        status: 'success',
        chunkCount: chunks.length
      }, serverId);
    }

    // Record success in circuit breaker if provided
    if (circuitBreaker) {
      circuitBreaker.recordSuccess(circuitBreakerKey);
    }

    return {
      status: 'success',
      result,
      chunks,
      context: { toolName, elapsedMs, chunkCount: chunks.length, timeoutMs: effectiveTimeoutMs }
    };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;

    // Clear all timeouts
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (chunkTimeoutId !== null && !chunkPromiseResolved) {
      clearTimeout(chunkTimeoutId);
      chunkTimeoutId = null;
    }

    // Record metrics if timeout manager provided
    if (timeoutManager) {
      timeoutManager.recordMetrics({
        toolName,
        startTime,
        endTime: Date.now(),
        elapsedMs,
        timeoutMs: effectiveTimeoutMs,
        status: err.code === 'TIMEOUT' || err.code === 'CHUNK_TIMEOUT' ? 'timeout' : 'error',
        errorCode: err.code,
        chunkCount: chunks.length
      }, serverId);
    }

    if (err instanceof ToolInvocationError && (err.code === 'TIMEOUT' || err.code === 'CHUNK_TIMEOUT')) {
      log.warn({
        toolName,
        timeoutMs: effectiveTimeoutMs,
        elapsedMs,
        chunksCollected: chunks.length,
        errorType: err.code
      }, 'Streaming tool invocation timed out');

      // Record failure in circuit breaker if provided
      if (circuitBreaker) {
        circuitBreaker.recordFailure(circuitBreakerKey);
      }

      if (typeof onTimeout === 'function') {
        try {
          onTimeout({ toolName, timeoutMs: effectiveTimeoutMs, elapsedMs, chunksCollected: chunks.length });
        } catch (callbackErr) {
          log.error({ toolName, err: callbackErr }, 'Error in onTimeout callback');
        }
      }

      // Use error handling coordinator if available for enhanced timeout processing
      if (errorHandlingCoordinator) {
        try {
          const enhancedError = await errorHandlingCoordinator.handleTimeout(
            {
              timeoutMs: effectiveTimeoutMs,
              elapsedMs,
              partialChunks: chunks
            },
            {
              toolName,
              serverId: serverId || 'unknown',
              toolId: null,
              requestId: null
            }
          );

          return {
            status: 'error',
            code: err.code,
            error: err.message,
            chunks: chunks,
            context: {
              toolName,
              timeoutMs: effectiveTimeoutMs,
              elapsedMs,
              chunksCollected: chunks.length
            },
            // Enhanced error handling information
            enhancedError,
            recoveryActions: enhancedError.recoveryActions,
            retryable: enhancedError.retryable,
            severity: enhancedError.severity,
            category: enhancedError.category,
            alternativeTools: enhancedError.alternativeTools,
            retryPolicy: enhancedError.retryPolicy
          };
        } catch (coordinationError) {
          log.warn({
            toolName,
            coordinationError: coordinationError.message
          }, 'Error handling coordinator failed for streaming timeout, falling back');
        }
      }

      // Fallback to basic timeout error handling — include enrichment from ToolInvocationError
      return {
        status: 'error',
        code: err.code,
        error: err.message,
        chunks: chunks,
        context: {
          toolName,
          timeoutMs: effectiveTimeoutMs,
          elapsedMs,
          chunksCollected: chunks.length
        },
        recovery: err.recovery,
        recoveryActions: err.recoveryActions,
        toolCategory: err.toolCategory,
        retryable: err.retryable,
        severity: err.severity
      };
    }

    // Record failure in circuit breaker for non-timeout errors
    if (circuitBreaker && err instanceof ToolInvocationError) {
      circuitBreaker.recordFailure(circuitBreakerKey);
    }

    log.error({
      toolName,
      err: err.message,
      errorType: err.constructor.name,
      elapsedMs
    }, 'Streaming tool invocation failed');

    // Use error handling coordinator if available for enhanced error processing
    if (errorHandlingCoordinator) {
      try {
        const enhancedError = await errorHandlingCoordinator.handleToolExecutionError(
          {
            message: err.message,
            errorCode: err.code || 'UNKNOWN_ERROR',
            stack: err.stack,
            originalError: err
          },
          {
            toolName,
            serverId: serverId || 'unknown',
            toolId: null,
            requestId: null
          }
        );

        return {
          status: 'error',
          code: err.code || 'UNKNOWN_ERROR',
          error: err.message,
          chunks: chunks,
          context: {
            toolName,
            elapsedMs,
            timeoutMs: effectiveTimeoutMs,
            chunksCollected: chunks.length
          },
          // Enhanced error handling information
          enhancedError,
          recoveryActions: enhancedError.recoveryActions,
          retryable: enhancedError.retryable,
          severity: enhancedError.severity,
          category: enhancedError.category,
          alternativeTools: enhancedError.alternativeTools,
          requiresUserIntervention: enhancedError.requiresUserIntervention
        };
      } catch (coordinationError) {
        log.warn({
          toolName,
          coordinationError: coordinationError.message
        }, 'Error handling coordinator failed for streaming error, falling back');
      }
    }

    // Fallback to basic error handling — include enrichment from ToolInvocationError
    return {
      status: 'error',
      code: err.code || 'UNKNOWN_ERROR',
      error: err.message,
      chunks: chunks,
      context: {
        toolName,
        elapsedMs,
        timeoutMs: effectiveTimeoutMs,
        chunksCollected: chunks.length
      },
      recovery: err.recovery,
      recoveryActions: err.recoveryActions,
      toolCategory: err.toolCategory,
      retryable: err.retryable,
      severity: err.severity
    };
  }
}

// Re-export for convenience
export { createExecutionMetricsCollector, ExecutionMetricsCollector } from './execution-metrics-collector.js';
