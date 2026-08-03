/**
 * Error Recovery Strategies
 *
 * Provides recovery recommendations and retry policies for different error categories.
 * Integrates with ErrorResponseProcessor to suggest actionable recovery steps.
 */

import { createLogger } from '../logger.js';

const log = createLogger('error-recovery-strategies');

/**
 * Retry policy configuration for different error categories.
 */
export const RetryPolicies = Object.freeze({
  // Transient errors - retry with exponential backoff
  TRANSIENT: {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterFactor: 0.1,
    retryable: true
  },

  // Rate limit errors - longer backoff with jitter
  RATE_LIMIT: {
    maxRetries: 5,
    baseDelayMs: 5000,
    maxDelayMs: 120000,
    backoffMultiplier: 2,
    jitterFactor: 0.2,
    retryable: true
  },

  // Timeout errors - retry with increased timeout
  TIMEOUT: {
    maxRetries: 2,
    baseDelayMs: 2000,
    maxDelayMs: 10000,
    backoffMultiplier: 1.5,
    jitterFactor: 0.1,
    retryable: true,
    increaseTimeoutFactor: 1.5
  },

  // Connection errors - retry with reconnection
  CONNECTION: {
    maxRetries: 3,
    baseDelayMs: 3000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterFactor: 0.15,
    retryable: true,
    requiresReconnection: true
  },

  // Validation errors - not retryable without parameter changes
  VALIDATION: {
    maxRetries: 0,
    retryable: false
  },

  // Protocol errors - not retryable
  PROTOCOL: {
    maxRetries: 0,
    retryable: false
  },

  // Authentication errors - not retryable without credential refresh
  AUTHENTICATION: {
    maxRetries: 1,
    baseDelayMs: 5000,
    maxDelayMs: 5000,
    backoffMultiplier: 1,
    jitterFactor: 0,
    retryable: false,
    requiresAuthRefresh: true
  },

  // Authorization errors - not retryable
  AUTHORIZATION: {
    maxRetries: 0,
    retryable: false
  },

  // Resource not found - may be retryable after delay
  RESOURCE: {
    maxRetries: 2,
    baseDelayMs: 2000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    jitterFactor: 0.1,
    retryable: true
  },

  // Server errors - retry with backoff
  SERVER: {
    maxRetries: 3,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterFactor: 0.15,
    retryable: true
  },

  // Execution errors - limited retries
  EXECUTION: {
    maxRetries: 1,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    backoffMultiplier: 1.5,
    jitterFactor: 0.1,
    retryable: true
  },

  // Unknown errors - minimal retry
  UNKNOWN: {
    maxRetries: 1,
    baseDelayMs: 5000,
    maxDelayMs: 10000,
    backoffMultiplier: 1,
    jitterFactor: 0,
    retryable: false
  }
});

/**
 * Recovery action recommendations for different error categories.
 */
export const RecoveryActions = Object.freeze({
  // Validation errors
  VALIDATION: {
    actions: [
      'Review tool parameter requirements and constraints',
      'Validate parameter types and formats before retrying',
      'Check for missing required parameters',
      'Ensure parameter values meet schema constraints'
    ],
    fallbackStrategy: 'parameter_correction',
    requiresUserIntervention: true
  },

  // Timeout errors
  TIMEOUT: {
    actions: [
      'Retry with increased timeout threshold',
      'Check if tool operation can be simplified or chunked',
      'Verify network connectivity and server responsiveness',
      'Consider using streaming for long-running operations'
    ],
    fallbackStrategy: 'retry_with_increased_timeout',
    requiresUserIntervention: false
  },

  // Connection errors
  CONNECTION: {
    actions: [
      'Verify MCP server is running and accessible',
      'Check network connectivity',
      'Reconnect to MCP server',
      'Verify server configuration and credentials'
    ],
    fallbackStrategy: 'reconnect_and_retry',
    requiresUserIntervention: false
  },

  // Rate limit errors
  RATE_LIMIT: {
    actions: [
      'Implement exponential backoff with jitter',
      'Reduce request rate',
      'Check rate limit headers for reset time',
      'Consider batching requests if supported'
    ],
    fallbackStrategy: 'backoff_and_retry',
    requiresUserIntervention: false
  },

  // Protocol errors
  PROTOCOL: {
    actions: [
      'Verify MCP server protocol version compatibility',
      'Check request format conforms to JSON-RPC 2.0',
      'Review MCP server logs for protocol violations',
      'Update MCP client or server if version mismatch'
    ],
    fallbackStrategy: 'none',
    requiresUserIntervention: true
  },

  // Authentication errors
  AUTHENTICATION: {
    actions: [
      'Refresh authentication credentials',
      'Verify API keys or tokens are valid',
      'Check authentication configuration',
      'Re-authenticate with MCP server'
    ],
    fallbackStrategy: 'refresh_credentials',
    requiresUserIntervention: true
  },

  // Authorization errors
  AUTHORIZATION: {
    actions: [
      'Verify tool permissions are granted',
      'Check user/agent authorization level',
      'Request necessary permissions from administrator',
      'Review tool access control policies'
    ],
    fallbackStrategy: 'none',
    requiresUserIntervention: true
  },

  // Server errors
  SERVER: {
    actions: [
      'Retry with exponential backoff',
      'Check MCP server health and status',
      'Review server logs for errors',
      'Contact server administrator if persistent'
    ],
    fallbackStrategy: 'retry_with_backoff',
    requiresUserIntervention: false
  },

  // Execution errors
  EXECUTION: {
    actions: [
      'Review tool execution logs for error details',
      'Verify tool prerequisites are met',
      'Check if tool supports the requested operation',
      'Try alternative tool if available'
    ],
    fallbackStrategy: 'try_alternative_tool',
    requiresUserIntervention: false
  },

  // Resource errors
  RESOURCE: {
    actions: [
      'Verify resource identifier is correct',
      'Check if resource exists or has been moved',
      'Wait briefly and retry (resource may be creating)',
      'Create resource if it should exist'
    ],
    fallbackStrategy: 'retry_with_delay',
    requiresUserIntervention: false
  },

  // Unknown errors
  UNKNOWN: {
    actions: [
      'Review error details and context',
      'Check MCP server and client logs',
      'Verify tool and server configuration',
      'Contact support if error persists'
    ],
    fallbackStrategy: 'manual_investigation',
    requiresUserIntervention: true
  }
});

/**
 * ErrorRecoveryStrategy - Provides recovery recommendations for errors.
 */
export class ErrorRecoveryStrategy {
  constructor(options = {}) {
    this.enableFallbackTools = options.enableFallbackTools ?? true;
    this.enableAutoRetry = options.enableAutoRetry ?? true;
    this.toolRegistry = options.toolRegistry || null;
  }

  /**
   * Get recovery strategy for an error.
   *
   * @param {Object} error - Processed error from ErrorResponseProcessor
   * @returns {Object} Recovery strategy with retry policy, actions, and fallback options
   */
  getRecoveryStrategy(error) {
    const category = error.category || 'unknown';
    const categoryUpper = category.toUpperCase();

    const retryPolicy = RetryPolicies[categoryUpper] || RetryPolicies.UNKNOWN;
    const recoveryActions = RecoveryActions[categoryUpper] || RecoveryActions.UNKNOWN;

    const strategy = {
      // Retry configuration
      retry: {
        shouldRetry: retryPolicy.retryable && this.enableAutoRetry,
        maxRetries: retryPolicy.maxRetries,
        baseDelayMs: retryPolicy.baseDelayMs,
        maxDelayMs: retryPolicy.maxDelayMs,
        backoffMultiplier: retryPolicy.backoffMultiplier,
        jitterFactor: retryPolicy.jitterFactor,
        increaseTimeoutFactor: retryPolicy.increaseTimeoutFactor
      },

      // Recovery actions
      actions: recoveryActions.actions,
      fallbackStrategy: recoveryActions.fallbackStrategy,
      requiresUserIntervention: recoveryActions.requiresUserIntervention,

      // Special handling flags
      requiresReconnection: retryPolicy.requiresReconnection || false,
      requiresAuthRefresh: retryPolicy.requiresAuthRefresh || false,

      // Fallback tool suggestions (if enabled and available)
      alternativeTools: []
    };

    // Add alternative tool suggestions if enabled
    if (this.enableFallbackTools && error.toolName && this.toolRegistry) {
      strategy.alternativeTools = this._findAlternativeTools(
        error.toolName,
        error.category,
        error.code
      );
    }

    return strategy;
  }

  /**
   * Calculate retry delay with exponential backoff and jitter.
   *
   * @param {number} attemptNumber - Current attempt number (0-based)
   * @param {Object} retryPolicy - Retry policy configuration
   * @returns {number} Delay in milliseconds
   */
  calculateRetryDelay(attemptNumber, retryPolicy) {
    if (!retryPolicy || attemptNumber < 0) {
      return 0;
    }

    const baseDelay = retryPolicy.baseDelayMs || 1000;
    const multiplier = retryPolicy.backoffMultiplier || 2;
    const maxDelay = retryPolicy.maxDelayMs || 30000;
    const jitterFactor = retryPolicy.jitterFactor || 0.1;

    // Calculate exponential backoff
    const exponentialDelay = baseDelay * Math.pow(multiplier, attemptNumber);

    // Clamp to max delay
    const clampedDelay = Math.min(exponentialDelay, maxDelay);

    // Add jitter (±jitterFactor * delay)
    const jitterRange = clampedDelay * jitterFactor;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    const finalDelay = clampedDelay + jitter;

    // Ensure non-negative and within max delay
    return Math.max(0, Math.min(maxDelay, Math.round(finalDelay)));
  }

  /**
   * Check if error should trigger circuit breaker.
   *
   * @param {Object} error - Processed error
   * @returns {boolean} True if should trigger circuit breaker
   */
  shouldTriggerCircuitBreaker(error) {
    const category = error.category || 'unknown';

    // Circuit breaker should trigger for:
    // - Repeated timeouts
    // - Repeated connection errors
    // - Repeated server errors
    // - Repeated execution failures
    const triggerCategories = ['timeout', 'connection', 'server', 'execution'];

    return triggerCategories.includes(category);
  }

  /**
   * Check if error is recoverable.
   *
   * @param {Object} error - Processed error
   * @returns {boolean} True if error is recoverable
   */
  isRecoverable(error) {
    return error.retryable === true;
  }

  /**
   * Find alternative tools that can perform similar operations.
   *
   * @private
   * @param {string} failedToolName - Name of the failed tool
   * @param {string} errorCategory - Error category
   * @param {string} errorCode - Error code
   * @returns {Array<Object>} Array of alternative tool suggestions
   */
  _findAlternativeTools(failedToolName, errorCategory, errorCode) {
    if (!this.toolRegistry) {
      return [];
    }

    // For certain error types, alternative tools are not helpful
    const skipCategories = ['validation', 'protocol', 'authentication', 'authorization'];
    if (skipCategories.includes(errorCategory)) {
      return [];
    }

    // Get all tools from registry
    const allTools = this.toolRegistry.getAllTools();
    if (!allTools || allTools.length === 0) {
      return [];
    }

    // Find tools with similar capabilities
    // This is a simplified heuristic - could be enhanced with semantic matching
    const alternatives = [];
    const failedToolBaseName = this._extractBaseName(failedToolName);

    for (const tool of allTools) {
      // Skip the failed tool itself
      if (tool.name === failedToolName) {
        continue;
      }

      // Check for similar tool names (heuristic)
      const toolBaseName = this._extractBaseName(tool.name);
      if (this._areSimilarTools(failedToolBaseName, toolBaseName)) {
        alternatives.push({
          toolName: tool.name,
          source: tool.source,
          reason: 'Similar tool name pattern',
          confidence: 0.7
        });
      }

      // Check for same tool category/domain
      if (tool.metadata?.category === failedToolBaseName.split('_')[0]) {
        alternatives.push({
          toolName: tool.name,
          source: tool.source,
          reason: 'Same tool category',
          confidence: 0.6
        });
      }
    }

    // Limit to top 3 alternatives by confidence
    return alternatives
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  /**
   * Extract base tool name without namespace/prefix.
   *
   * @private
   * @param {string} toolName - Full tool name
   * @returns {string} Base tool name
   */
  _extractBaseName(toolName) {
    // Handle namespaced tools (e.g., "filesystem:read_file" → "read_file")
    if (toolName.includes(':')) {
      return toolName.split(':')[1];
    }
    return toolName;
  }

  /**
   * Check if two tool names are similar.
   *
   * @private
   * @param {string} name1 - First tool name
   * @param {string} name2 - Second tool name
   * @returns {boolean} True if tools are similar
   */
  _areSimilarTools(name1, name2) {
    // Simple heuristic: check for common prefixes or shared keywords
    const keywords1 = new Set(name1.toLowerCase().split(/[_-]/));
    const keywords2 = new Set(name2.toLowerCase().split(/[_-]/));

    // Count shared keywords
    let sharedCount = 0;
    for (const keyword of keywords1) {
      if (keywords2.has(keyword)) {
        sharedCount++;
      }
    }

    // Similar if they share 50%+ of keywords
    const minKeywords = Math.min(keywords1.size, keywords2.size);
    return minKeywords > 0 && (sharedCount / minKeywords) >= 0.5;
  }
}

/**
 * Create an ErrorRecoveryStrategy instance.
 *
 * @param {Object} options - Configuration options
 * @returns {ErrorRecoveryStrategy}
 */
export function createErrorRecoveryStrategy(options = {}) {
  return new ErrorRecoveryStrategy(options);
}
