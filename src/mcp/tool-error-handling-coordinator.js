/**
 * Tool Error Handling Coordinator
 *
 * Orchestrates all error handling components for MCP tool invocation.
 * Integrates error processing, recovery strategies, custom handlers, aggregation,
 * and fallback policies into a unified error handling pipeline.
 *
 * Pipeline flow:
 * 1. Error occurs during tool invocation
 * 2. ErrorResponseProcessor normalizes error
 * 3. ToolErrorHandlerRegistry applies custom handlers (priority-based)
 * 4. ErrorRecoveryStrategy determines recovery approach
 * 5. ErrorAggregator records error for monitoring
 * 6. FallbackPolicyManager decides if fallback should be triggered
 *
 * Output: Unified error result with recovery recommendations
 */

import { createLogger } from '../logger.js';
import { ErrorResponseProcessor } from './error-response-processor.js';
import { ErrorRecoveryStrategy } from './error-recovery-strategies.js';
import { ToolErrorHandlerRegistry } from './tool-error-handler-registry.js';
import { ErrorAggregator } from './error-aggregator.js';
import { FallbackPolicyManager } from './fallback-policy.js';
import { createToolSpecificErrorCategorizer, ToolCategories } from './tool-error-categorization.js';

const log = createLogger('tool-error-handling-coordinator');

/**
 * ToolErrorHandlingCoordinator - Unified error handling for tool invocations.
 */
export class ToolErrorHandlingCoordinator {
  /**
   * Create a ToolErrorHandlingCoordinator instance.
   *
   * @param {Object} options - Configuration options
   * @param {ErrorResponseProcessor} [options.errorResponseProcessor] - Error response processor (creates default if not provided)
   * @param {ErrorRecoveryStrategy} [options.errorRecoveryStrategy] - Recovery strategy (creates default if not provided)
   * @param {ToolErrorHandlerRegistry} [options.errorHandlerRegistry] - Handler registry (creates default if not provided)
   * @param {ErrorAggregator} [options.errorAggregator] - Error aggregator (creates default if not provided)
   * @param {FallbackPolicyManager} [options.fallbackPolicyManager] - Fallback policy manager (creates default if not provided)
   * @param {Object} [options.toolRegistry] - Tool registry for alternative tool suggestions
   * @param {Object} [options.config] - Configuration object
   * @param {boolean} [options.enableDetailedLogging=false] - Enable detailed error logging
   * @param {boolean} [options.enableErrorAggregation=true] - Enable error aggregation
   * @param {boolean} [options.enableFallbackTools=true] - Enable fallback tool suggestions
   * @param {boolean} [options.enableAutoRetry=true] - Enable automatic retry based on recovery strategy
   * @param {boolean} [options.enableToolSpecificCategorization=true] - Enable tool-specific error categorization
   */
  constructor(options = {}) {
    // Initialize error response processor
    this.errorResponseProcessor = options.errorResponseProcessor || new ErrorResponseProcessor({
      enableDetailedLogging: options.enableDetailedLogging || false,
      includeOriginalError: true,
      strictMode: true
    });

    // Initialize tool-specific error categorizer for enhanced categorization
    this.toolErrorCategorizer = options.toolErrorCategorizer || createToolSpecificErrorCategorizer();
    this.enableToolSpecificCategorization = options.enableToolSpecificCategorization !== false;

    // Initialize error recovery strategy
    this.errorRecoveryStrategy = options.errorRecoveryStrategy || new ErrorRecoveryStrategy({
      enableFallbackTools: options.enableFallbackTools !== false,
      enableAutoRetry: options.enableAutoRetry !== false,
      toolRegistry: options.toolRegistry || null
    });

    // Initialize error handler registry
    this.errorHandlerRegistry = options.errorHandlerRegistry || new ToolErrorHandlerRegistry();

    // Initialize error aggregator
    this.errorAggregator = options.errorAggregator || new ErrorAggregator({
      maxHistorySize: 10000,
      windowSizeMs: 3600000
    });

    // Initialize fallback policy manager
    this.fallbackPolicyManager = options.fallbackPolicyManager || new FallbackPolicyManager(
      options.config?.fallback || {}
    );

    this.enableErrorAggregation = options.enableErrorAggregation !== false;
    this.enableDetailedLogging = options.enableDetailedLogging || false;

    log.info('ToolErrorHandlingCoordinator initialized', {
      enableErrorAggregation: this.enableErrorAggregation,
      enableFallbackTools: this.errorRecoveryStrategy.enableFallbackTools,
      enableAutoRetry: this.errorRecoveryStrategy.enableAutoRetry,
      enableToolSpecificCategorization: this.enableToolSpecificCategorization
    });
  }

  /**
   * Handle an error from tool invocation.
   *
   * @param {Error|Object} error - Raw error or error object
   * @param {Object} context - Error context
   * @param {string} context.toolName - Tool name
   * @param {string} context.serverId - MCP server ID
   * @param {string} context.toolId - Tool ID
   * @param {string} context.requestId - Request ID
   * @param {Object} [context.invocationContext] - Additional invocation context
   * @returns {Promise<Object>} Processed error result with recovery recommendations
   */
  async handleError(error, context = {}) {
    const startTimeMs = Date.now();

    try {
      log.debug({
        toolName: context.toolName,
        serverId: context.serverId,
        errorType: error?.constructor?.name,
        errorMessage: error?.message
      }, 'Processing tool error');

      // Step 1: Normalize and process error through ErrorResponseProcessor
      const processedError = await this._processError(error, context);

      // Step 1.5: Enhance error categorization with tool-specific categorizer if enabled
      if (this.enableToolSpecificCategorization && context.toolName) {
        const toolSpecificInfo = this.toolErrorCategorizer.categorizeError(
          context.toolName,
          { code: processedError.code, message: processedError.message || error?.message },
          context
        );

        // Merge tool-specific categorization with processed error
        // Tool-specific categorization takes precedence for category, severity, and retryability
        processedError.toolSpecificCategory = toolSpecificInfo.category;
        processedError.toolSpecificSeverity = toolSpecificInfo.severity;
        processedError.toolSpecificRetryable = toolSpecificInfo.retryable;
        processedError.toolSpecificRecovery = toolSpecificInfo.recovery;

        // Get formatted recovery recommendations from categorizer
        const recoveryRecs = this.toolErrorCategorizer.getRecoveryRecommendations(
          context.toolName,
          { code: processedError.code, message: processedError.message || error?.message }
        );
        processedError.toolSpecificRecoveryActions = recoveryRecs.recommendations;

        // Use tool-specific category for display (but keep original in _originalCategory)
        if (toolSpecificInfo.category && toolSpecificInfo.category !== ToolCategories.CUSTOM) {
          processedError._originalCategory = processedError.category;
          processedError.category = toolSpecificInfo.category;
        }

        // Use tool-specific severity if different from default
        if (toolSpecificInfo.severity) {
          processedError._originalSeverity = processedError.severity;
          processedError.severity = toolSpecificInfo.severity;
        }

        // Use tool-specific retryability if different from default
        if (toolSpecificInfo.retryable !== undefined) {
          processedError._originalRetryable = processedError.retryable;
          processedError.retryable = toolSpecificInfo.retryable;
        }
      }

      // Step 2: Apply custom error handlers through ToolErrorHandlerRegistry
      const handlerResult = await this.errorHandlerRegistry.handleError(
        processedError,
        context
      );

      // Step 3: Determine recovery strategy through ErrorRecoveryStrategy
      // For tool-specific categories, map them to appropriate recovery policies
      const errorForRecovery = handlerResult.handled ? handlerResult.error : processedError;
      const mappedCategory = this._mapToolCategoryToRecoveryCategory(errorForRecovery.category);
      const errorForRecoveryWithMappedCategory = {
        ...errorForRecovery,
        category: mappedCategory
      };
      const recoveryStrategy = this.errorRecoveryStrategy.getRecoveryStrategy(errorForRecoveryWithMappedCategory);

      // Step 4: Record error through ErrorAggregator
      if (this.enableErrorAggregation) {
        this.errorAggregator.recordError(processedError, {
          ...context,
          handlerCount: handlerResult.handlerCount || 0,
          handled: handlerResult.handled
        });
      }

      // Step 5: Determine if fallback should be triggered
      const operationCategory = this._inferOperationCategory(context.toolName);
      const fallbackPolicy = this.fallbackPolicyManager.getPolicyForOperation(operationCategory);
      const shouldFallback = this.fallbackPolicyManager.shouldTriggerFallback(
        processedError,
        fallbackPolicy
      );

      // Assemble final error result
      const errorResult = this._assembleErrorResult(
        processedError,
        handlerResult,
        recoveryStrategy,
        {
          ...context,
          operationCategory,
          shouldFallback,
          fallbackPolicy
        }
      );

      const processingTimeMs = Date.now() - startTimeMs;

      if (this.enableDetailedLogging) {
        log.debug({
          toolName: context.toolName,
          errorCode: processedError.code,
          errorCategory: processedError.category,
          handlerCount: handlerResult.handlerCount,
          handled: handlerResult.handled,
          shouldRetry: recoveryStrategy.retry.shouldRetry,
          shouldFallback,
          processingTimeMs
        }, 'Error processing completed');
      }

      return errorResult;
    } catch (err) {
      log.error({
        toolName: context.toolName,
        error: err.message,
        originalError: error?.message
      }, 'Error processing failed');

      // Return a fallback error result if processing fails
      return this._createFallbackErrorResult(error, context, err);
    }
  }

  /**
   * Handle timeout errors specifically.
   *
   * @param {Object} timeoutContext - Timeout context
   * @param {number} timeoutContext.timeoutMs - Configured timeout
   * @param {number} timeoutContext.elapsedMs - Actual elapsed time
   * @param {Array} [timeoutContext.partialChunks] - Partial chunks collected (for streaming)
   * @param {Object} context - Error context
   * @returns {Promise<Object>} Processed timeout error result
   */
  async handleTimeout(timeoutContext, context = {}) {
    log.debug({
      toolName: context.toolName,
      timeoutMs: timeoutContext.timeoutMs,
      elapsedMs: timeoutContext.elapsedMs,
      chunksCollected: timeoutContext.partialChunks?.length || 0
    }, 'Processing timeout error');

    // Process timeout through ErrorResponseProcessor
    const timeoutError = await this.errorResponseProcessor.processTimeout(
      timeoutContext,
      context
    );

    // Handle through the full error pipeline
    return this.handleError(timeoutError, context);
  }

  /**
   * Handle connection errors specifically.
   *
   * @param {Object} connectionError - Connection error context
   * @param {string} connectionError.message - Error message
   * @param {string} connectionError.code - Error code
   * @param {boolean} connectionError.retryable - Whether error is retryable
   * @param {number} connectionError.reconnectAttempts - Number of reconnect attempts
   * @param {Object} context - Error context
   * @returns {Promise<Object>} Processed connection error result
   */
  async handleConnectionError(connectionError, context = {}) {
    log.debug({
      toolName: context.toolName,
      connectionCode: connectionError.code,
      reconnectAttempts: connectionError.reconnectAttempts
    }, 'Processing connection error');

    // Map common connection error codes to standardized codes
    const connectionCodeMap = {
      'ECONNREFUSED': 'CONNECTION_ERROR',
      'ECONNRESET': 'CONNECTION_ERROR',
      'ETIMEDOUT': 'CONNECTION_ERROR',
      'ENOTFOUND': 'CONNECTION_ERROR',
      'ECONNABORTED': 'CONNECTION_ERROR',
      'EHOSTUNREACH': 'CONNECTION_ERROR',
      'ENETUNREACH': 'CONNECTION_ERROR'
    };

    const mappedCode = connectionCodeMap[connectionError.code] || connectionError.code || 'CONNECTION_ERROR';

    const mappedConnectionError = {
      ...connectionError,
      code: mappedCode
    };

    // Process connection error through ErrorResponseProcessor
    const connError = await this.errorResponseProcessor.processConnectionError(
      mappedConnectionError,
      context
    );

    // Handle through the full error pipeline
    return this.handleError(connError, context);
  }

  /**
   * Handle validation errors specifically.
   *
   * @param {Object} validationError - Validation error context
   * @param {Array|Object} validationError.errors - Validation errors
   * @param {string} validationError.field - Field that failed validation
   * @param {string} validationError.constraint - Constraint that failed
   * @param {any} validationError.actual - Actual value
   * @param {any} validationError.expected - Expected value
   * @param {Object} context - Error context
   * @returns {Promise<Object>} Processed validation error result
   */
  async handleValidationError(validationError, context = {}) {
    log.debug({
      toolName: context.toolName,
      errorCount: Array.isArray(validationError.errors) ? validationError.errors.length : 1
    }, 'Processing validation error');

    // Process validation error through ErrorResponseProcessor
    const validError = await this.errorResponseProcessor.processValidationError(
      validationError,
      context
    );

    // Handle through the full error pipeline
    return this.handleError(validError, context);
  }

  /**
   * Handle tool execution errors specifically.
   *
   * @param {Object} executionError - Execution error context
   * @param {string} executionError.message - Error message
   * @param {string} executionError.errorCode - Error code
   * @param {string} executionError.stack - Error stack trace
   * @param {Error} executionError.originalError - Original error object
   * @param {Object} context - Error context
   * @returns {Promise<Object>} Processed execution error result
   */
  async handleToolExecutionError(executionError, context = {}) {
    log.debug({
      toolName: context.toolName,
      errorCode: executionError.errorCode
    }, 'Processing tool execution error');

    // Process execution error through ErrorResponseProcessor
    const execError = await this.errorResponseProcessor.processToolExecutionError(
      executionError,
      context
    );

    // Handle through the full error pipeline
    return this.handleError(execError, context);
  }

  /**
   * Process error through ErrorResponseProcessor based on error type.
   *
   * @private
   * @param {Error|Object} error - Raw error
   * @param {Object} context - Error context
   * @returns {Promise<Object>} Processed error
   */
  async _processError(error, context) {
    // Check if error is already processed (has status field)
    if (error && typeof error === 'object' && error.status) {
      return error;
    }

    // Check if error is a JSON-RPC error response
    if (error && typeof error === 'object' && error.error) {
      return this.errorResponseProcessor.process(error, context);
    }

    // Check error type and route to appropriate processor
    const errorType = error?.constructor?.name || 'Error';

    switch (errorType) {
      case 'TimeoutError':
        return this.errorResponseProcessor.processTimeout(
          {
            timeoutMs: error.timeoutMs || context.timeoutMs,
            elapsedMs: context.elapsedMs,
            partialChunks: context.partialChunks || []
          },
          context
        );

      case 'ConnectionError':
        return this.errorResponseProcessor.processConnectionError(
          {
            message: error.message,
            code: error.code,
            retryable: error.retryable,
            reconnectAttempts: context.reconnectAttempts || 0
          },
          context
        );

      case 'ValidationError':
        return this.errorResponseProcessor.processValidationError(
          {
            errors: error.errors,
            field: error.field,
            constraint: error.constraint,
            actual: error.actual,
            expected: error.expected
          },
          context
        );

      default:
        // Generic error - process as tool execution error
        return this.errorResponseProcessor.processToolExecutionError(
          {
            message: error?.message || 'Unknown error',
            errorCode: error?.code || 'INVOCATION_FAILED',
            stack: error?.stack,
            originalError: error
          },
          context
        );
    }
  }

  /**
   * Assemble final error result from all processing stages.
   *
   * @private
   * @param {Object} processedError - Processed error from ErrorResponseProcessor
   * @param {Object} handlerResult - Result from custom handlers
   * @param {Object} recoveryStrategy - Recovery strategy
   * @param {Object} fallbackContext - Fallback context
   * @returns {Object} Final error result
   */
  _assembleErrorResult(processedError, handlerResult, recoveryStrategy, fallbackContext) {
    // Start with the modified error if handler modified it, otherwise use processed error
    const baseError = handlerResult.error || processedError;

    const errorResult = {
      // Error identification (use modified error if available)
      status: 'error',
      code: baseError.code || processedError.code,
      message: baseError.message || processedError.message,
      category: baseError.category || processedError.category,
      severity: baseError.severity || processedError.severity,

      // Context information
      toolName: processedError.toolName,
      serverId: processedError.serverId,
      toolId: processedError.toolId,
      requestId: processedError.requestId,
      source: processedError.source,
      serverSource: processedError.serverSource,

      // Retry information
      retryable: baseError.retryable !== undefined ? baseError.retryable : processedError.retryable,
      retryPolicy: recoveryStrategy.retry,

      // Handler information
      handlerInfo: {
        count: handlerResult.handlerCount || 0,
        handled: handlerResult.handled || false,
        results: handlerResult.handlerResults || []
      },

      // Recovery actions
      recoveryActions: processedError.toolSpecificRecoveryActions
        ? processedError.toolSpecificRecoveryActions.map(r => r.description)
        : recoveryStrategy.actions,
      fallbackStrategy: recoveryStrategy.fallbackStrategy,
      requiresUserIntervention: recoveryStrategy.requiresUserIntervention,

      // Special handling flags
      requiresReconnection: recoveryStrategy.requiresReconnection || false,
      requiresAuthRefresh: recoveryStrategy.requiresAuthRefresh || false,

      // Fallback information
      fallback: {
        shouldTrigger: fallbackContext.shouldFallback,
        operationCategory: fallbackContext.operationCategory,
        policy: fallbackContext.fallbackPolicy
      },

      // Alternative tool suggestions
      alternativeTools: recoveryStrategy.alternativeTools || [],

      // Original error details
      error: processedError.error,
      originalResponse: processedError.originalResponse,
      validationErrors: processedError.validationErrors,

      // Additional error fields (preserve all fields from both processed and modified error)
      ...Object.keys(baseError).reduce((acc, key) => {
        if (!acc.hasOwnProperty(key) && key !== 'toolName' && key !== 'serverId' &&
            key !== 'toolId' && key !== 'requestId' && key !== 'timestamp' &&
            key !== 'status' && key !== 'code' && key !== 'message' && key !== 'category' &&
            key !== 'severity' && key !== 'retryable' && key !== 'error' &&
            key !== 'originalResponse' && key !== 'validationErrors') {
          acc[key] = baseError[key];
        }
        return acc;
      }, {}),

      // Prevent retry flag (if handlers set it)
      preventRetry: handlerResult.preventRetry || false,

      // Timestamp
      timestamp: new Date().toISOString()
    };

    // Add custom recovery actions from handlers
    if (handlerResult.recoveryActions && handlerResult.recoveryActions.length > 0) {
      errorResult.handlerRecoveryActions = handlerResult.recoveryActions;
    }

    // Add fallback tools from handlers
    if (handlerResult.fallbackTools && handlerResult.fallbackTools.length > 0) {
      errorResult.fallbackTools = handlerResult.fallbackTools;
    }

    // Prevent retry if handlers indicated or if error is not recoverable
    if (handlerResult.preventRetry || !this.errorRecoveryStrategy.isRecoverable(processedError)) {
      errorResult.retryPolicy.shouldRetry = false;
      errorResult.retryable = false;
    }

    return errorResult;
  }

  /**
   * Create fallback error result when error processing fails.
   *
   * @private
   * @param {Error|Object} originalError - Original error
   * @param {Object} context - Error context
   * @param {Error} processingError - Error that occurred during processing
   * @returns {Object} Fallback error result
   */
  _createFallbackErrorResult(originalError, context, processingError) {
    return {
      status: 'error',
      code: 'ERROR_PROCESSING_FAILED',
      message: `Error processing failed: ${processingError.message}`,
      category: 'unknown',
      severity: 'high',
      toolName: context.toolName,
      serverId: context.serverId,
      toolId: context.toolId,
      requestId: context.requestId,
      source: 'mcp',
      serverSource: context.serverId,
      retryable: false,
      retryPolicy: {
        shouldRetry: false,
        maxRetries: 0
      },
      handlerInfo: {
        count: 0,
        handled: false
      },
      recoveryActions: [
        'Review error processing pipeline',
        'Check error handler configurations',
        'Contact support if issue persists'
      ],
      fallbackStrategy: 'none',
      requiresUserIntervention: true,
      requiresReconnection: false,
      requiresAuthRefresh: false,
      fallback: {
        shouldTrigger: false,
        operationCategory: 'unknown',
        policy: null
      },
      alternativeTools: [],
      error: {
        type: 'ProcessingError',
        message: processingError.message,
        originalError: originalError?.message || 'Unknown'
      },
      originalError: originalError,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Map tool-specific categories to recovery strategy categories.
   *
   * @private
   * @param {string} category - Tool-specific category
   * @returns {string} Recovery strategy category
   */
  _mapToolCategoryToRecoveryCategory(category) {
    const categoryMapping = {
      'filesystem': 'execution',
      'network': 'connection',
      'database': 'server',
      'search': 'execution',
      'data-processing': 'execution',
      'authentication': 'authentication',
      'authorization': 'authorization',
      'notification': 'execution',
      'utility': 'execution'
    };

    return categoryMapping[category] || category;
  }

  /**
   * Infer operation category from tool name.
   *
   * @private
   * @param {string} toolName - Tool name
   * @returns {string} Operation category
   */
  _inferOperationCategory(toolName) {
    if (!toolName) {
      return 'unknown';
    }

    const toolNameLower = toolName.toLowerCase();

    // Map tool name patterns to operation categories (check more specific patterns first)

    // Check for database tools first (they contain 'query' which could be confused with search)
    if (toolNameLower.includes('database') ||
        toolNameLower.includes(':db:') ||
        toolNameLower.startsWith('db:') ||
        toolNameLower.includes('sql')) {
      return 'database';
    }

    // Check for network tools
    if (toolNameLower.includes('http') || toolNameLower.includes('fetch') ||
        toolNameLower.includes('request') || toolNameLower.includes('download') ||
        toolNameLower.includes('upload') || toolNameLower.includes('connect')) {
      return 'network';
    }

    // Check for filesystem tools
    if (toolNameLower.includes('file') || toolNameLower.includes('directory') ||
        toolNameLower.includes('path')) {
      return 'filesystem';
    }

    // Check for filesystem by operation type (but exclude database tools)
    if ((toolNameLower.includes('read') || toolNameLower.includes('write') ||
        toolNameLower.includes('delete')) && !toolNameLower.includes('db') &&
        !toolNameLower.includes('sql') && !toolNameLower.includes('database')) {
      return 'filesystem';
    }

    // Check for search tools (but exclude database tools)
    if ((toolNameLower.includes('query') || toolNameLower.includes('search') ||
        toolNameLower.includes('find') || toolNameLower.includes('filter') ||
        toolNameLower.includes('index') || toolNameLower.includes('lookup')) &&
        !toolNameLower.includes('db') && !toolNameLower.includes('sql') &&
        !toolNameLower.includes('database')) {
      return 'search';
    }

    // Check for data processing tools
    if (toolNameLower.includes('process') || toolNameLower.includes('transform') ||
        toolNameLower.includes('parse') || toolNameLower.includes('convert') ||
        toolNameLower.includes('encode') || toolNameLower.includes('decode')) {
      return 'data-processing';
    }

    return 'unknown';
  }

  /**
   * Register a custom error handler.
   *
   * @param {Object} handler - Handler configuration
   * @returns {string} Handler ID
   */
  registerErrorHandler(handler) {
    return this.errorHandlerRegistry.register(handler);
  }

  /**
   * Unregister a custom error handler.
   *
   * @param {string} handlerId - Handler ID to unregister
   * @returns {boolean} True if handler was found and removed
   */
  unregisterErrorHandler(handlerId) {
    return this.errorHandlerRegistry.unregister(handlerId);
  }

  /**
   * Get error statistics from aggregator.
   *
   * @returns {Object} Error statistics
   */
  getErrorStatistics() {
    return this.errorAggregator.getStatistics();
  }

  /**
   * Get errors for a specific tool.
   *
   * @param {string} toolName - Tool name
   * @param {number} [limit=100] - Maximum errors to return
   * @returns {Array<Object>} Tool errors
   */
  getToolErrors(toolName, limit = 100) {
    return this.errorAggregator.getToolErrors(toolName, limit);
  }

  /**
   * Get error patterns.
   *
   * @returns {Object} Detected patterns
   */
  getErrorPatterns() {
    return this.errorAggregator.getPatterns();
  }

  /**
   * Get all error handlers.
   *
   * @returns {Array<Object>} Handler configurations
   */
  getAllErrorHandlers() {
    return this.errorHandlerRegistry.getAllHandlers();
  }

  /**
   * Get handlers for a specific tool.
   *
   * @param {string} toolName - Tool name
   * @returns {Array<Object>} Applicable handlers
   */
  getHandlersForTool(toolName) {
    return this.errorHandlerRegistry.getHandlersForTool(toolName);
  }

  /**
   * Get all fallback policies.
   *
   * @returns {Object} All policies
   */
  getAllFallbackPolicies() {
    return this.fallbackPolicyManager.getAllPolicies();
  }

  /**
   * Set a fallback policy for a category.
   *
   * @param {string} category - Operation category
   * @param {Object} policyOverride - Policy overrides
   */
  setFallbackPolicy(category, policyOverride) {
    this.fallbackPolicyManager.setPolicy(category, policyOverride);
  }

  /**
   * Clear all error history.
   */
  clearErrorHistory() {
    this.errorAggregator.clear();
  }
}

/**
 * Create a ToolErrorHandlingCoordinator instance.
 *
 * @param {Object} options - Configuration options
 * @returns {ToolErrorHandlingCoordinator}
 */
export function createToolErrorHandlingCoordinator(options = {}) {
  return new ToolErrorHandlingCoordinator(options);
}
