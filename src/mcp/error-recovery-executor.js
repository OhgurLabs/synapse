/**
 * Error Recovery Executor
 *
 * Executes recovery strategies for failed MCP tool invocations.
 * Implements automatic retry, fallback tool invocation, parameter correction,
 * and other recovery actions based on error context and policies.
 *
 * Features:
 * - Automatic retry with exponential backoff and jitter
 * - Fallback tool invocation with smart selection
 * - Parameter correction based on validation errors
 * - Circuit breaker integration
 * - Recovery attempt tracking and limits
 * - Graceful degradation when appropriate
 * - Recovery metrics collection
 */

import { createLogger } from '../logger.js';

const log = createLogger('error-recovery-executor');

/**
 * Recovery attempt record
 *
 * @typedef {Object} RecoveryAttempt
 * @property {string} id - Unique attempt ID
 * @property {number} attemptNumber - Attempt number (0-indexed)
 * @property {string} strategy - Recovery strategy used
 * @property {string} toolName - Tool name
 * @property {Object} parameters - Tool parameters used
 * @property {number} timestamp - Timestamp of attempt
 * @property {number} delayMs - Delay before this attempt
 * @property {Object} result - Result of attempt (success/error)
 * @property {number} durationMs - Duration of attempt
 */

/**
 * Recovery execution result
 *
 * @typedef {Object} RecoveryResult
 * @property {boolean} success - Whether recovery succeeded
 * @property {Object} result - Tool invocation result (if success)
 * @property {Object} error - Final error (if failed)
 * @property {Array<RecoveryAttempt>} attempts - All recovery attempts
 * @property {string} finalStrategy - Final recovery strategy used
 * @property {number} totalDurationMs - Total duration of all attempts
 * @property {Object} metrics - Recovery metrics
 */

/**
 * ErrorRecoveryExecutor - Executes recovery strategies for failed tool invocations.
 */
export class ErrorRecoveryExecutor {
  /**
   * @param {Object} options - Configuration options
   * @param {Function} options.invokeTool - Function to invoke a tool (toolName, params, context) => Promise<result>
   * @param {Object} options.toolRegistry - Tool registry for finding fallback tools
   * @param {Object} options.circuitBreakerRegistry - Circuit breaker registry (optional)
   * @param {number} options.maxTotalAttempts - Maximum total recovery attempts (default: 10)
   * @param {boolean} options.enableRetry - Enable automatic retry (default: true)
   * @param {boolean} options.enableFallbackTools - Enable fallback tool invocation (default: true)
   * @param {boolean} options.enableParameterCorrection - Enable parameter correction (default: true)
   * @param {boolean} options.trackMetrics - Enable recovery metrics tracking (default: true)
   */
  constructor(options = {}) {
    if (!options.invokeTool || typeof options.invokeTool !== 'function') {
      throw new TypeError('invokeTool function is required');
    }

    this.invokeTool = options.invokeTool;
    this.toolRegistry = options.toolRegistry || null;
    this.circuitBreakerRegistry = options.circuitBreakerRegistry || null;

    this.maxTotalAttempts = options.maxTotalAttempts !== undefined ? options.maxTotalAttempts : 10;
    this.enableRetry = options.enableRetry !== false;
    this.enableFallbackTools = options.enableFallbackTools !== false;
    this.enableParameterCorrection = options.enableParameterCorrection !== false;
    this.trackMetrics = options.trackMetrics !== false;

    // Recovery attempt tracking
    this._activeRecoveries = new Map();
    this._recoveryHistory = [];

    // Metrics
    this._metrics = {
      totalRecoveries: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      recoveryAttempts: 0,
      recoveryStrategies: {
        retry: 0,
        fallback_tool: 0,
        parameter_correction: 0,
        manual_intervention: 0
      },
      averageRecoveryTimeMs: 0,
      averageAttemptsPerRecovery: 0
    };

    log.info('ErrorRecoveryExecutor initialized', {
      maxTotalAttempts: this.maxTotalAttempts,
      enableRetry: this.enableRetry,
      enableFallbackTools: this.enableFallbackTools,
      enableParameterCorrection: this.enableParameterCorrection
    });
  }

  /**
   * Execute recovery for a failed tool invocation.
   *
   * @param {Object} errorResult - Error result from ToolErrorHandlingCoordinator
   * @param {Object} context - Invocation context
   * @param {string} context.toolName - Original tool name
   * @param {Object} context.parameters - Original tool parameters
   * @param {Object} [context.invocationContext] - Additional invocation context
   * @returns {Promise<RecoveryResult>} Recovery execution result
   */
  async executeRecovery(errorResult, context = {}) {
    const { toolName, parameters, invocationContext = {} } = context;
    const recoveryId = this._generateRecoveryId();

    log.info({
      recoveryId,
      toolName,
      errorCode: errorResult.code,
      errorCategory: errorResult.category,
      retryable: errorResult.retryable
    }, 'Starting recovery execution');

    // Early exit if maxTotalAttempts is 0
    if (this.maxTotalAttempts <= 0) {
      log.info({
        recoveryId,
        toolName,
        maxTotalAttempts: this.maxTotalAttempts
      }, 'Max total attempts is 0, skipping recovery');

      return {
        success: false,
        result: null,
        error: errorResult,
        attempts: [],
        finalStrategy: 'none',
        totalDurationMs: 0,
        metrics: {
          totalAttempts: 0,
          successfulAttempts: 0,
          failedAttempts: 0,
          totalDelayMs: 0,
          totalDurationMs: 0,
          averageDurationMs: 0,
          strategiesUsed: []
        }
      };
    }

    const startTimeMs = Date.now();
    const attempts = [];
    let finalResult = null;
    let finalError = null;
    let success = false;
    let finalStrategy = 'none';

    try {
      // Execute recovery based on error result
      if (errorResult.retryable && this.enableRetry && errorResult.retryPolicy.shouldRetry) {
        const retryResult = await this._executeRetry(
          recoveryId,
          toolName,
          parameters,
          errorResult,
          invocationContext,
          attempts
        );

        // Track that retry strategy was attempted
        if (attempts.length > 0) {
          finalStrategy = 'retry';
        }

        if (retryResult.success) {
          success = true;
          finalResult = retryResult.result;
        } else {
          finalError = retryResult.error;
        }
      }

      // Try fallback tools if retry failed
      if (!success && this.enableFallbackTools && errorResult.alternativeTools.length > 0) {
        const fallbackResult = await this._executeFallbackTools(
          recoveryId,
          toolName,
          parameters,
          errorResult.alternativeTools,
          errorResult,
          invocationContext,
          attempts
        );

        // Track that fallback strategy was attempted
        const hadFallbackAttempts = attempts.some(a => a.strategy === 'fallback_tool');
        if (hadFallbackAttempts) {
          finalStrategy = 'fallback_tool';
        }

        if (fallbackResult.success) {
          success = true;
          finalResult = fallbackResult.result;
        } else {
          finalError = fallbackResult.error || finalError;
        }
      }

      // Try parameter correction if enabled and appropriate
      if (!success && this.enableParameterCorrection && errorResult.category === 'validation') {
        const correctionResult = await this._executeParameterCorrection(
          recoveryId,
          toolName,
          parameters,
          errorResult,
          invocationContext,
          attempts
        );

        // Track that parameter correction strategy was attempted
        const hadCorrectionAttempts = attempts.some(a => a.strategy === 'parameter_correction');
        if (hadCorrectionAttempts) {
          finalStrategy = 'parameter_correction';
        }

        if (correctionResult.success) {
          success = true;
          finalResult = correctionResult.result;
        } else {
          finalError = correctionResult.error || finalError;
        }
      }

      // If all recovery failed, return the original error
      if (!success) {
        finalError = finalError || errorResult;
        // Keep the finalStrategy that was attempted, or set to 'manual_intervention' if no attempts were made
        if (finalStrategy === 'none') {
          finalStrategy = 'manual_intervention';
        }
      }

      // Update metrics
      if (this.trackMetrics) {
        this._updateMetrics(success, attempts.length, finalStrategy, Date.now() - startTimeMs);
      }

      // Record recovery in history
      this._recordRecovery(recoveryId, toolName, success, attempts, finalStrategy, Date.now() - startTimeMs);

      const totalDurationMs = Date.now() - startTimeMs;

      log.info({
        recoveryId,
        toolName,
        success,
        finalStrategy,
        attemptCount: attempts.length,
        totalDurationMs
      }, 'Recovery execution completed');

      return {
        success,
        result: finalResult,
        error: finalError,
        attempts,
        finalStrategy,
        totalDurationMs,
        metrics: this._getAttemptMetrics(attempts)
      };
    } catch (err) {
      log.error({
        recoveryId,
        toolName,
        error: err.message
      }, 'Recovery execution failed unexpectedly');

      const totalDurationMs = Date.now() - startTimeMs;

      return {
        success: false,
        result: null,
        error: {
          code: 'RECOVERY_EXECUTION_FAILED',
          message: `Recovery execution failed: ${err.message}`,
          originalError: errorResult
        },
        attempts,
        finalStrategy: 'error',
        totalDurationMs,
        metrics: this._getAttemptMetrics(attempts)
      };
    }
  }

  /**
   * Execute retry with exponential backoff.
   *
   * @private
   * @param {string} recoveryId - Recovery ID
   * @param {string} toolName - Tool name
   * @param {Object} parameters - Tool parameters
   * @param {Object} errorResult - Error result
   * @param {Object} invocationContext - Invocation context
   * @param {Array<RecoveryAttempt>} attempts - Attempts array to populate
   * @returns {Promise<Object>} Retry result
   */
  async _executeRetry(recoveryId, toolName, parameters, errorResult, invocationContext, attempts) {
    const { retryPolicy } = errorResult;
    const maxRetries = Math.min(retryPolicy.maxRetries, this.maxTotalAttempts - attempts.length);

    log.debug({
      recoveryId,
      toolName,
      maxRetries,
      baseDelayMs: retryPolicy.baseDelayMs
    }, 'Executing retry strategy');

    for (let i = 0; i <= maxRetries; i++) {
      const attemptNumber = attempts.length;
      const delayMs = i === 0 ? 0 : this._calculateRetryDelay(i - 1, retryPolicy);

      // Wait before retry (except first attempt)
      if (delayMs > 0) {
        await this._delay(delayMs);
      }

      const attemptId = `${recoveryId}-retry-${i}`;
      const attemptStartTimeMs = Date.now();

      try {
        log.debug({
          recoveryId,
          attemptNumber,
          delayMs,
          toolName
        }, 'Executing retry attempt');

        // Invoke tool
        const result = await this._invokeToolWithCircuitBreaker(
          toolName,
          parameters,
          invocationContext
        );

        const durationMs = Date.now() - attemptStartTimeMs;

        attempts.push({
          id: attemptId,
          attemptNumber,
          strategy: 'retry',
          toolName,
          parameters,
          timestamp: Date.now(),
          delayMs,
          result: { success: true, data: result },
          durationMs
        });

        log.info({
          recoveryId,
          attemptNumber,
          durationMs
        }, 'Retry attempt succeeded');

        return { success: true, result };
      } catch (err) {
        const durationMs = Date.now() - attemptStartTimeMs;

        attempts.push({
          id: attemptId,
          attemptNumber,
          strategy: 'retry',
          toolName,
          parameters,
          timestamp: Date.now(),
          delayMs,
          result: { success: false, error: err },
          durationMs
        });

        log.warn({
          recoveryId,
          attemptNumber,
          error: err.message,
          durationMs
        }, 'Retry attempt failed');

        // Continue to next retry if not the last one
        if (i < maxRetries) {
          continue;
        }

        return { success: false, error: err };
      }
    }

    return { success: false, error: errorResult };
  }

  /**
   * Execute fallback tools.
   *
   * @private
   * @param {string} recoveryId - Recovery ID
   * @param {string} originalToolName - Original tool name
   * @param {Object} parameters - Tool parameters
   * @param {Array<Object>} alternativeTools - Alternative tools to try
   * @param {Object} errorResult - Error result
   * @param {Object} invocationContext - Invocation context
   * @param {Array<RecoveryAttempt>} attempts - Attempts array to populate
   * @returns {Promise<Object>} Fallback result
   */
  async _executeFallbackTools(recoveryId, originalToolName, parameters, alternativeTools, errorResult, invocationContext, attempts) {
    const maxFallbackAttempts = Math.min(alternativeTools.length, this.maxTotalAttempts - attempts.length);

    log.debug({
      recoveryId,
      originalToolName,
      alternativeToolCount: alternativeTools.length,
      maxFallbackAttempts
    }, 'Executing fallback tool strategy');

    for (let i = 0; i < maxFallbackAttempts; i++) {
      const fallbackTool = alternativeTools[i];
      const attemptNumber = attempts.length;

      // Skip if circuit breaker is open for this tool
      if (this._isCircuitBreakerOpen(fallbackTool.toolName)) {
        log.debug({
          recoveryId,
          fallbackTool: fallbackTool.toolName,
          reason: 'circuit_breaker_open'
        }, 'Skipping fallback tool');
        continue;
      }

      const attemptId = `${recoveryId}-fallback-${i}`;
      const delayMs = 0;
      const attemptStartTimeMs = Date.now();

      try {
        log.debug({
          recoveryId,
          attemptNumber,
          originalTool: originalToolName,
          fallbackTool: fallbackTool.toolName,
          reason: fallbackTool.reason
        }, 'Executing fallback tool attempt');

        // Map parameters for fallback tool if needed
        const mappedParams = this._mapParametersForFallback(
          originalToolName,
          fallbackTool.toolName,
          parameters
        );

        // Invoke fallback tool
        const result = await this._invokeToolWithCircuitBreaker(
          fallbackTool.toolName,
          mappedParams,
          invocationContext
        );

        const durationMs = Date.now() - attemptStartTimeMs;

        attempts.push({
          id: attemptId,
          attemptNumber,
          strategy: 'fallback_tool',
          toolName: fallbackTool.toolName,
          parameters: mappedParams,
          timestamp: Date.now(),
          delayMs,
          result: { success: true, data: result, fallbackFrom: originalToolName },
          durationMs
        });

        log.info({
          recoveryId,
          attemptNumber,
          fallbackTool: fallbackTool.toolName,
          durationMs
        }, 'Fallback tool attempt succeeded');

        return { success: true, result, fallbackTool: fallbackTool.toolName };
      } catch (err) {
        const durationMs = Date.now() - attemptStartTimeMs;

        attempts.push({
          id: attemptId,
          attemptNumber,
          strategy: 'fallback_tool',
          toolName: fallbackTool.toolName,
          parameters,
          timestamp: Date.now(),
          delayMs,
          result: { success: false, error: err },
          durationMs
        });

        log.warn({
          recoveryId,
          attemptNumber,
          fallbackTool: fallbackTool.toolName,
          error: err.message,
          durationMs
        }, 'Fallback tool attempt failed');

        // Continue to next fallback tool
        continue;
      }
    }

    return { success: false, error: errorResult };
  }

  /**
   * Execute parameter correction for validation errors.
   *
   * @private
   * @param {string} recoveryId - Recovery ID
   * @param {string} toolName - Tool name
   * @param {Object} parameters - Original parameters
   * @param {Object} errorResult - Error result
   * @param {Object} invocationContext - Invocation context
   * @param {Array<RecoveryAttempt>} attempts - Attempts array to populate
   * @returns {Promise<Object>} Correction result
   */
  async _executeParameterCorrection(recoveryId, toolName, parameters, errorResult, invocationContext, attempts) {
    log.debug({
      recoveryId,
      toolName,
      validationErrors: errorResult.validationErrors?.length
    }, 'Executing parameter correction strategy');

    const attemptNumber = attempts.length;
    const attemptId = `${recoveryId}-correction-0`;
    const delayMs = 0;
    const attemptStartTimeMs = Date.now();

    try {
      // Attempt to correct parameters based on validation errors
      const correctedParams = this._correctParameters(
        parameters,
        errorResult.validationErrors || []
      );

      if (!correctedParams) {
        log.debug({
          recoveryId,
          toolName
        }, 'No parameter corrections possible');
        return { success: false, error: errorResult };
      }

      log.debug({
        recoveryId,
        toolName,
        correctedFields: Object.keys(correctedParams)
      }, 'Parameters corrected, retrying tool invocation');

      // Invoke tool with corrected parameters
      const result = await this._invokeToolWithCircuitBreaker(
        toolName,
        { ...parameters, ...correctedParams },
        invocationContext
      );

      const durationMs = Date.now() - attemptStartTimeMs;

      attempts.push({
        id: attemptId,
        attemptNumber,
        strategy: 'parameter_correction',
        toolName,
        parameters: { ...parameters, ...correctedParams },
        timestamp: Date.now(),
        delayMs,
        result: { success: true, data: result, corrections: correctedParams },
        durationMs
      });

      log.info({
        recoveryId,
        attemptNumber,
        durationMs
      }, 'Parameter correction succeeded');

      return { success: true, result, correctedParams };
    } catch (err) {
      const durationMs = Date.now() - attemptStartTimeMs;

      attempts.push({
        id: attemptId,
        attemptNumber,
        strategy: 'parameter_correction',
        toolName,
        parameters,
        timestamp: Date.now(),
        delayMs,
        result: { success: false, error: err },
        durationMs
      });

      log.warn({
        recoveryId,
        attemptNumber,
        error: err.message,
        durationMs
      }, 'Parameter correction failed');

      return { success: false, error: err };
    }
  }

  /**
   * Invoke tool with circuit breaker protection.
   *
   * @private
   * @param {string} toolName - Tool name
   * @param {Object} parameters - Tool parameters
   * @param {Object} invocationContext - Invocation context
   * @returns {Promise<Object>} Tool invocation result
   */
  async _invokeToolWithCircuitBreaker(toolName, parameters, invocationContext) {
    // Check if circuit breaker is open
    if (this._isCircuitBreakerOpen(toolName)) {
      const error = new Error(`Circuit breaker is open for tool: ${toolName}`);
      error.code = 'CIRCUIT_BREAKER_OPEN';
      error.toolName = toolName;
      throw error;
    }

    // Invoke tool
    const result = await this.invokeTool(toolName, parameters, invocationContext);

    // Record success in circuit breaker
    if (this.circuitBreakerRegistry) {
      this._recordCircuitBreakerSuccess(toolName);
    }

    return result;
  }

  /**
   * Check if circuit breaker is open for a tool.
   *
   * @private
   * @param {string} toolName - Tool name
   * @returns {boolean} True if circuit breaker is open
   */
  _isCircuitBreakerOpen(toolName) {
    if (!this.circuitBreakerRegistry) {
      return false;
    }

    try {
      const circuitBreaker = this.circuitBreakerRegistry.getCircuitBreaker(toolName);
      if (!circuitBreaker) {
        log.debug({ toolName }, 'No circuit breaker found for tool');
        return false;
      }
      const isOpen = circuitBreaker.isOpen();
      log.debug({ toolName, isOpen }, 'Circuit breaker state');
      return isOpen;
    } catch (err) {
      log.debug({ toolName, error: err.message }, 'Failed to check circuit breaker state');
      return false;
    }
  }

  /**
   * Record circuit breaker success.
   *
   * @private
   * @param {string} toolName - Tool name
   */
  _recordCircuitBreakerSuccess(toolName) {
    if (!this.circuitBreakerRegistry) {
      return;
    }

    try {
      const circuitBreaker = this.circuitBreakerRegistry.getCircuitBreaker(toolName);
      if (circuitBreaker) {
        circuitBreaker.recordSuccess();
      }
    } catch (err) {
      log.debug({ toolName, error: err.message }, 'Failed to record circuit breaker success');
    }
  }

  /**
   * Map parameters for fallback tool.
   *
   * @private
   * @param {string} originalToolName - Original tool name
   * @param {string} fallbackToolName - Fallback tool name
   * @param {Object} originalParams - Original parameters
   * @returns {Object} Mapped parameters
   */
  _mapParametersForFallback(originalToolName, fallbackToolName, originalParams) {
    // Simple parameter mapping - can be enhanced with more sophisticated logic
    // For now, return the same parameters (assumes compatible interfaces)
    return { ...originalParams };
  }

  /**
   * Correct parameters based on validation errors.
   *
   * @private
   * @param {Object} originalParams - Original parameters
   * @param {Array<Object>} validationErrors - Validation errors
   * @returns {Object|null} Corrected parameters or null if no corrections possible
   */
  _correctParameters(originalParams, validationErrors) {
    const corrections = {};

    for (const validationError of validationErrors) {
      const { field, constraint, actual, expected } = validationError;

      // Handle missing required fields
      if (constraint === 'required' && !originalParams[field]) {
        // Try to infer a default value
        if (expected !== undefined) {
          corrections[field] = expected;
        } else {
          // Cannot auto-correct
          return null;
        }
      }

      // Handle type mismatches
      if (constraint === 'type' && expected) {
        try {
          switch (expected) {
            case 'number':
              corrections[field] = Number(actual);
              break;
            case 'boolean':
              corrections[field] = Boolean(actual);
              break;
            case 'string':
              corrections[field] = String(actual);
              break;
            case 'array':
              corrections[field] = Array.isArray(actual) ? actual : [actual];
              break;
            default:
              // Cannot auto-correct
              return null;
          }
        } catch (err) {
          // Conversion failed
          return null;
        }
      }

      // Handle value constraints
      if (constraint === 'enum' && expected && Array.isArray(expected)) {
        if (!expected.includes(actual)) {
          // Use first enum value as fallback
          corrections[field] = expected[0];
        }
      }
    }

    return Object.keys(corrections).length > 0 ? corrections : null;
  }

  /**
   * Calculate retry delay with exponential backoff and jitter.
   *
   * @private
   * @param {number} attemptNumber - Attempt number (0-indexed)
   * @param {Object} retryPolicy - Retry policy
   * @returns {number} Delay in milliseconds
   */
  _calculateRetryDelay(attemptNumber, retryPolicy) {
    const {
      baseDelayMs = 1000,
      maxDelayMs = 30000,
      backoffMultiplier = 2,
      jitterFactor = 0.1
    } = retryPolicy;

    // Exponential backoff
    const backoffDelay = baseDelayMs * Math.pow(backoffMultiplier, attemptNumber);

    // Clamp to max delay
    const clampedDelay = Math.min(backoffDelay, maxDelayMs);

    // Add jitter (±jitterFactor * delay)
    const jitterRange = clampedDelay * jitterFactor;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    const finalDelay = clampedDelay + jitter;

    // Ensure non-negative and within max delay
    return Math.max(0, Math.min(maxDelayMs, Math.round(finalDelay)));
  }

  /**
   * Delay execution for specified milliseconds.
   *
   * @private
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate unique recovery ID.
   *
   * @private
   * @returns {string} Recovery ID
   */
  _generateRecoveryId() {
    return `recovery-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get metrics from attempts.
   *
   * @private
   * @param {Array<RecoveryAttempt>} attempts - Recovery attempts
   * @returns {Object} Attempt metrics
   */
  _getAttemptMetrics(attempts) {
    if (attempts.length === 0) {
      return {
        totalAttempts: 0,
        successfulAttempts: 0,
        failedAttempts: 0,
        totalDelayMs: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        strategiesUsed: []
      };
    }

    const successfulAttempts = attempts.filter(a => a.result.success).length;
    const failedAttempts = attempts.length - successfulAttempts;
    const totalDelayMs = attempts.reduce((sum, a) => sum + a.delayMs, 0);
    const totalDurationMs = attempts.reduce((sum, a) => sum + a.durationMs, 0);
    const strategiesUsed = [...new Set(attempts.map(a => a.strategy))];

    return {
      totalAttempts: attempts.length,
      successfulAttempts,
      failedAttempts,
      totalDelayMs,
      totalDurationMs,
      averageDurationMs: Math.round(totalDurationMs / attempts.length),
      strategiesUsed
    };
  }

  /**
   * Update recovery metrics.
   *
   * @private
   * @param {boolean} success - Whether recovery succeeded
   * @param {number} attemptCount - Number of attempts
   * @param {string} strategy - Recovery strategy used
   * @param {number} durationMs - Total duration
   */
  _updateMetrics(success, attemptCount, strategy, durationMs) {
    this._metrics.totalRecoveries++;
    this._metrics.recoveryAttempts += attemptCount;

    if (success) {
      this._metrics.successfulRecoveries++;
    } else {
      this._metrics.failedRecoveries++;
    }

    // Update strategy counts
    if (this._metrics.recoveryStrategies[strategy] !== undefined) {
      this._metrics.recoveryStrategies[strategy]++;
    }

    // Update average recovery time
    const totalRecoveryTime = this._metrics.averageRecoveryTimeMs * (this._metrics.totalRecoveries - 1);
    this._metrics.averageRecoveryTimeMs = Math.round((totalRecoveryTime + durationMs) / this._metrics.totalRecoveries);

    // Update average attempts per recovery
    const totalAttempts = this._metrics.averageAttemptsPerRecovery * (this._metrics.totalRecoveries - 1);
    this._metrics.averageAttemptsPerRecovery = Math.round((totalAttempts + attemptCount) / this._metrics.totalRecoveries);
  }

  /**
   * Record recovery in history.
   *
   * @private
   * @param {string} recoveryId - Recovery ID
   * @param {string} toolName - Tool name
   * @param {boolean} success - Whether recovery succeeded
   * @param {Array<RecoveryAttempt>} attempts - Recovery attempts
   * @param {string} strategy - Recovery strategy used
   * @param {number} durationMs - Total duration
   */
  _recordRecovery(recoveryId, toolName, success, attempts, strategy, durationMs) {
    const record = {
      recoveryId,
      toolName,
      success,
      attemptCount: attempts.length,
      strategy,
      durationMs,
      timestamp: Date.now()
    };

    this._recoveryHistory.push(record);

    // Limit history size
    if (this._recoveryHistory.length > 1000) {
      this._recoveryHistory.shift();
    }
  }

  /**
   * Get recovery metrics.
   *
   * @returns {Object} Recovery metrics
   */
  getMetrics() {
    return {
      ...this._metrics,
      successRate: this._metrics.totalRecoveries > 0
        ? Math.round((this._metrics.successfulRecoveries / this._metrics.totalRecoveries) * 100) / 100
        : 0
    };
  }

  /**
   * Get recovery history.
   *
   * @param {number} [limit=100] - Maximum records to return
   * @returns {Array<Object>} Recovery history
   */
  getHistory(limit = 100) {
    return this._recoveryHistory.slice(-limit);
  }

  /**
   * Clear recovery history and metrics.
   */
  clearHistory() {
    this._recoveryHistory = [];
    this._metrics = {
      totalRecoveries: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      recoveryAttempts: 0,
      recoveryStrategies: {
        retry: 0,
        fallback_tool: 0,
        parameter_correction: 0,
        manual_intervention: 0
      },
      averageRecoveryTimeMs: 0,
      averageAttemptsPerRecovery: 0
    };

    log.info('Recovery history and metrics cleared');
  }
}

/**
 * Create an ErrorRecoveryExecutor instance.
 *
 * @param {Object} options - Configuration options
 * @returns {ErrorRecoveryExecutor}
 */
export function createErrorRecoveryExecutor(options = {}) {
  return new ErrorRecoveryExecutor(options);
}
