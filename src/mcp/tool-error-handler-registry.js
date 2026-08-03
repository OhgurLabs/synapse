/**
 * Tool Error Handler Registry
 *
 * Allows registration of custom error handlers for specific tools or tool categories.
 * Enables tool-specific error processing, recovery logic, and fallback strategies.
 */

import { createLogger } from '../logger.js';

const log = createLogger('tool-error-handler-registry');

/**
 * ToolErrorHandler - Custom error handler for a specific tool or category.
 *
 * @typedef {Object} ToolErrorHandler
 * @property {string} name - Handler name
 * @property {string|RegExp} toolPattern - Tool name pattern (exact match or regex)
 * @property {Function} handleError - Error handler function (error, context) => handlerResult
 * @property {number} priority - Handler priority (higher = runs first)
 * @property {Array<string>} [errorCodes] - Error codes this handler applies to (optional)
 * @property {Array<string>} [errorCategories] - Error categories this handler applies to (optional)
 */

/**
 * HandlerResult - Result from a custom error handler.
 *
 * @typedef {Object} HandlerResult
 * @property {boolean} handled - Whether error was fully handled
 * @property {Object} [modifiedError] - Modified error object (optional)
 * @property {Object} [recoveryAction] - Custom recovery action (optional)
 * @property {string} [fallbackToolName] - Alternative tool to try (optional)
 * @property {boolean} [preventRetry] - Prevent automatic retry (optional)
 * @property {Object} [metadata] - Additional metadata (optional)
 */

/**
 * ToolErrorHandlerRegistry - Registry for custom error handlers.
 */
export class ToolErrorHandlerRegistry {
  constructor() {
    this._handlers = [];
    this._handlersByTool = new Map();
    this._handlersByCategory = new Map();

    log.info('ToolErrorHandlerRegistry initialized');
  }

  /**
   * Register a custom error handler.
   *
   * @param {ToolErrorHandler} handler - Error handler configuration
   * @returns {string} Handler ID
   */
  register(handler) {
    if (!handler.name || typeof handler.name !== 'string') {
      throw new TypeError('Handler name is required and must be a string');
    }

    if (!handler.handleError || typeof handler.handleError !== 'function') {
      throw new TypeError('Handler handleError function is required');
    }

    if (!handler.toolPattern) {
      throw new TypeError('Handler toolPattern is required');
    }

    const handlerId = `${handler.name}-${Date.now()}`;
    const handlerRecord = {
      id: handlerId,
      name: handler.name,
      toolPattern: handler.toolPattern,
      handleError: handler.handleError,
      priority: handler.priority || 0,
      errorCodes: handler.errorCodes || [],
      errorCategories: handler.errorCategories || [],
      registeredAt: Date.now()
    };

    this._handlers.push(handlerRecord);

    // Sort by priority (higher priority first)
    this._handlers.sort((a, b) => b.priority - a.priority);

    // Index by tool pattern for faster lookup
    if (typeof handler.toolPattern === 'string') {
      if (!this._handlersByTool.has(handler.toolPattern)) {
        this._handlersByTool.set(handler.toolPattern, []);
      }
      this._handlersByTool.get(handler.toolPattern).push(handlerRecord);
    }

    // Index by category if specified
    if (handler.errorCategories && handler.errorCategories.length > 0) {
      for (const category of handler.errorCategories) {
        if (!this._handlersByCategory.has(category)) {
          this._handlersByCategory.set(category, []);
        }
        this._handlersByCategory.get(category).push(handlerRecord);
      }
    }

    log.info({
      handlerId,
      name: handler.name,
      toolPattern: handler.toolPattern,
      priority: handlerRecord.priority
    }, 'Error handler registered');

    return handlerId;
  }

  /**
   * Unregister an error handler.
   *
   * @param {string} handlerId - Handler ID to unregister
   * @returns {boolean} True if handler was found and removed
   */
  unregister(handlerId) {
    const index = this._handlers.findIndex(h => h.id === handlerId);
    if (index === -1) {
      return false;
    }

    const handler = this._handlers[index];
    this._handlers.splice(index, 1);

    // Remove from indexed lookups
    if (typeof handler.toolPattern === 'string') {
      const toolHandlers = this._handlersByTool.get(handler.toolPattern);
      if (toolHandlers) {
        const toolIndex = toolHandlers.findIndex(h => h.id === handlerId);
        if (toolIndex !== -1) {
          toolHandlers.splice(toolIndex, 1);
        }
        if (toolHandlers.length === 0) {
          this._handlersByTool.delete(handler.toolPattern);
        }
      }
    }

    if (handler.errorCategories) {
      for (const category of handler.errorCategories) {
        const categoryHandlers = this._handlersByCategory.get(category);
        if (categoryHandlers) {
          const catIndex = categoryHandlers.findIndex(h => h.id === handlerId);
          if (catIndex !== -1) {
            categoryHandlers.splice(catIndex, 1);
          }
          if (categoryHandlers.length === 0) {
            this._handlersByCategory.delete(category);
          }
        }
      }
    }

    log.info({ handlerId, name: handler.name }, 'Error handler unregistered');
    return true;
  }

  /**
   * Handle an error with registered handlers.
   *
   * @param {Object} error - Processed error from ErrorResponseProcessor
   * @param {Object} context - Error context
   * @returns {Promise<Object>} Handler result
   */
  async handleError(error, context = {}) {
    const applicableHandlers = this._findApplicableHandlers(error, context);

    if (applicableHandlers.length === 0) {
      return {
        handled: false,
        error,
        context
      };
    }

    log.debug({
      toolName: error.toolName,
      errorCode: error.code,
      handlerCount: applicableHandlers.length
    }, 'Processing error with custom handlers');

    let currentError = error;
    let handlerResults = [];
    let fullyHandled = false;

    // Execute handlers in priority order
    for (const handler of applicableHandlers) {
      try {
        const result = await handler.handleError(currentError, context);

        if (result && typeof result === 'object') {
          handlerResults.push({
            handlerName: handler.name,
            result
          });

          // Update error if handler modified it
          if (result.modifiedError) {
            currentError = result.modifiedError;
          }

          // If handler fully handled the error, stop processing
          if (result.handled) {
            fullyHandled = true;
            log.info({
              toolName: error.toolName,
              handlerName: handler.name,
              errorCode: error.code
            }, 'Error fully handled by custom handler');
            break;
          }
        }
      } catch (err) {
        log.error({
          handlerName: handler.name,
          toolName: error.toolName,
          err: err.message
        }, 'Error handler threw exception');
      }
    }

    // Aggregate handler results
    const aggregatedResult = {
      handled: fullyHandled,
      error: currentError,
      context,
      handlerResults,
      handlerCount: applicableHandlers.length
    };

    // Extract recovery actions and fallback tools from handler results
    const recoveryActions = [];
    const fallbackTools = [];
    let preventRetry = false;

    for (const handlerResult of handlerResults) {
      if (handlerResult.result.recoveryAction) {
        recoveryActions.push(handlerResult.result.recoveryAction);
      }
      if (handlerResult.result.fallbackToolName) {
        fallbackTools.push(handlerResult.result.fallbackToolName);
      }
      if (handlerResult.result.preventRetry) {
        preventRetry = true;
      }
    }

    if (recoveryActions.length > 0) {
      aggregatedResult.recoveryActions = recoveryActions;
    }
    if (fallbackTools.length > 0) {
      aggregatedResult.fallbackTools = fallbackTools;
    }
    if (preventRetry) {
      aggregatedResult.preventRetry = true;
    }

    return aggregatedResult;
  }

  /**
   * Find handlers applicable to an error.
   *
   * @private
   * @param {Object} error - Error object
   * @param {Object} context - Error context
   * @returns {Array<Object>} Applicable handlers in priority order
   */
  _findApplicableHandlers(error, context) {
    const applicableHandlers = [];

    for (const handler of this._handlers) {
      // Check tool pattern match
      if (!this._matchesToolPattern(handler.toolPattern, error.toolName)) {
        continue;
      }

      // Check error code filter (if specified)
      if (handler.errorCodes.length > 0 && !handler.errorCodes.includes(error.code)) {
        continue;
      }

      // Check error category filter (if specified)
      if (handler.errorCategories.length > 0 && !handler.errorCategories.includes(error.category)) {
        continue;
      }

      applicableHandlers.push(handler);
    }

    return applicableHandlers;
  }

  /**
   * Check if tool name matches pattern.
   *
   * @private
   * @param {string|RegExp} pattern - Tool pattern
   * @param {string} toolName - Tool name to match
   * @returns {boolean} True if matches
   */
  _matchesToolPattern(pattern, toolName) {
    if (!toolName) {
      return false;
    }

    if (typeof pattern === 'string') {
      // Exact match or wildcard match
      if (pattern === '*') {
        return true;
      }
      if (pattern.includes('*')) {
        // Simple wildcard matching
        const regexPattern = pattern.replace(/\*/g, '.*');
        return new RegExp(`^${regexPattern}$`).test(toolName);
      }
      return pattern === toolName;
    }

    if (pattern instanceof RegExp) {
      return pattern.test(toolName);
    }

    return false;
  }

  /**
   * Get all registered handlers.
   *
   * @returns {Array<Object>} Handler configurations
   */
  getAllHandlers() {
    return this._handlers.map(h => ({
      id: h.id,
      name: h.name,
      toolPattern: h.toolPattern,
      priority: h.priority,
      errorCodes: h.errorCodes,
      errorCategories: h.errorCategories,
      registeredAt: h.registeredAt
    }));
  }

  /**
   * Get handlers for a specific tool.
   *
   * @param {string} toolName - Tool name
   * @returns {Array<Object>} Applicable handlers
   */
  getHandlersForTool(toolName) {
    const handlers = [];

    for (const handler of this._handlers) {
      if (this._matchesToolPattern(handler.toolPattern, toolName)) {
        handlers.push({
          id: handler.id,
          name: handler.name,
          priority: handler.priority
        });
      }
    }

    return handlers;
  }

  /**
   * Clear all registered handlers.
   */
  clear() {
    this._handlers = [];
    this._handlersByTool.clear();
    this._handlersByCategory.clear();
    log.info('All error handlers cleared');
  }
}

/**
 * Create a ToolErrorHandlerRegistry instance.
 *
 * @returns {ToolErrorHandlerRegistry}
 */
export function createToolErrorHandlerRegistry() {
  return new ToolErrorHandlerRegistry();
}

/**
 * Built-in error handler factories for common scenarios.
 */
export const BuiltInHandlers = {
  /**
   * Create a timeout retry handler with increased timeout.
   *
   * @param {Object} options - Handler options
   * @param {string} options.toolPattern - Tool pattern to apply to
   * @param {number} options.timeoutMultiplier - Timeout multiplier (default: 1.5)
   * @returns {ToolErrorHandler}
   */
  createTimeoutRetryHandler(options) {
    const { toolPattern, timeoutMultiplier = 1.5 } = options;

    return {
      name: 'timeout-retry-handler',
      toolPattern,
      priority: 10,
      errorCategories: ['timeout'],
      handleError: async (error, context) => {
        return {
          handled: false,
          modifiedError: {
            ...error,
            retryable: true
          },
          recoveryAction: {
            type: 'retry_with_increased_timeout',
            timeoutMultiplier,
            maxRetries: 2
          }
        };
      }
    };
  },

  /**
   * Create a fallback tool handler.
   *
   * @param {Object} options - Handler options
   * @param {string} options.toolPattern - Tool pattern to apply to
   * @param {string|Function} options.fallbackTool - Fallback tool name or function
   * @returns {ToolErrorHandler}
   */
  createFallbackToolHandler(options) {
    const { toolPattern, fallbackTool } = options;

    return {
      name: 'fallback-tool-handler',
      toolPattern,
      priority: 5,
      handleError: async (error, context) => {
        const fallbackToolName = typeof fallbackTool === 'function'
          ? fallbackTool(error, context)
          : fallbackTool;

        return {
          handled: false,
          fallbackToolName,
          recoveryAction: {
            type: 'try_fallback_tool',
            toolName: fallbackToolName
          }
        };
      }
    };
  },

  /**
   * Create a parameter correction handler.
   *
   * @param {Object} options - Handler options
   * @param {string} options.toolPattern - Tool pattern to apply to
   * @param {Function} options.correctParameters - Parameter correction function
   * @returns {ToolErrorHandler}
   */
  createParameterCorrectionHandler(options) {
    const { toolPattern, correctParameters } = options;

    return {
      name: 'parameter-correction-handler',
      toolPattern,
      priority: 15,
      errorCategories: ['validation'],
      handleError: async (error, context) => {
        try {
          const correctedParams = await correctParameters(error, context);

          return {
            handled: false,
            modifiedError: {
              ...error,
              retryable: correctedParams !== null
            },
            recoveryAction: {
              type: 'retry_with_corrected_parameters',
              correctedParameters: correctedParams
            }
          };
        } catch (err) {
          return { handled: false };
        }
      }
    };
  }
};
