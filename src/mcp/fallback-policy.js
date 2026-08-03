/**
 * FallbackPolicy — Configurable fallback policies for MCP tool invocation
 *
 * Manages fallback behavior when primary tools fail:
 * - Maximum fallback attempts per failure
 * - Timeout per fallback attempt
 * - Retry logic with exponential backoff
 * - Per-operation-category policy overrides
 *
 * Features:
 * - Global default policy
 * - Category-specific policies (filesystem, network, data-processing, etc.)
 * - Exponential backoff with jitter for retries
 * - Configurable via environment variables
 * - Policy validation and sanitization
 *
 * Usage:
 *   const policyManager = new FallbackPolicyManager(config.mcp.fallback);
 *   const policy = policyManager.getPolicyForOperation('filesystem');
 *   const result = await invokeTool(tool, args, policy);
 */

import { createLogger } from '../logger.js';

const log = createLogger('fallback-policy');

/**
 * Default fallback policy configuration
 */
export const DEFAULT_FALLBACK_POLICY = {
  // Enable fallback mechanism globally
  enabled: true,

  // Maximum number of fallback tools to attempt per failure
  maxAttempts: 3,

  // Timeout for each fallback attempt (ms)
  timeoutMs: 30000,

  // Retry configuration for each fallback attempt
  retry: {
    // Enable retry for individual fallback attempts
    enabled: true,

    // Maximum retries per fallback tool
    maxRetries: 2,

    // Initial retry delay (ms)
    baseDelayMs: 1000,

    // Maximum retry delay (ms)
    maxDelayMs: 10000,

    // Exponential backoff multiplier
    multiplier: 2.0,

    // Add random jitter to prevent thundering herd (ms)
    jitterMs: 500
  },

  // Fallback selection strategy
  selection: {
    // Strategy: 'ranked' (use compatibility + priority ranking), 'random', 'round-robin'
    strategy: 'ranked',

    // Prefer fallbacks from different servers to avoid correlated failures
    diversifyServers: true,

    // Skip fallbacks with open circuit breakers
    skipOpenCircuits: true
  },

  // Failure conditions that trigger fallback
  triggers: {
    // Trigger on timeout
    onTimeout: true,

    // Trigger on connection error
    onConnectionError: true,

    // Trigger on tool execution error
    onToolError: true,

    // Trigger when circuit breaker is open
    onCircuitOpen: true
  }
};

/**
 * Operation category-specific policy overrides
 */
export const CATEGORY_POLICIES = {
  // Filesystem operations: fast timeout, more attempts (cheap operations)
  filesystem: {
    maxAttempts: 5,
    timeoutMs: 15000,
    retry: {
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000
    }
  },

  // Network operations: longer timeout, fewer attempts (expensive operations)
  network: {
    maxAttempts: 2,
    timeoutMs: 60000,
    retry: {
      maxRetries: 1,
      baseDelayMs: 2000,
      maxDelayMs: 20000
    }
  },

  // Data processing: moderate timeout, moderate attempts
  'data-processing': {
    maxAttempts: 3,
    timeoutMs: 45000,
    retry: {
      maxRetries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 10000
    }
  },

  // Database operations: shorter timeout, more attempts
  database: {
    maxAttempts: 4,
    timeoutMs: 20000,
    retry: {
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000
    }
  },

  // Search operations: moderate timeout, more attempts
  search: {
    maxAttempts: 4,
    timeoutMs: 30000,
    retry: {
      maxRetries: 2,
      baseDelayMs: 1000,
      maxDelayMs: 8000
    }
  }
};

/**
 * FallbackPolicyManager — Manages fallback policies per operation category
 */
export class FallbackPolicyManager {
  /**
   * @param {Object} config - Fallback configuration
   * @param {Object} config.default - Default policy
   * @param {Object} config.categories - Category-specific policies
   */
  constructor(config = {}) {
    // Merge config with defaults
    this.defaultPolicy = this._mergePolicy(DEFAULT_FALLBACK_POLICY, config.default || {});

    // Load category policies
    this.categoryPolicies = new Map();
    const categories = { ...CATEGORY_POLICIES, ...(config.categories || {}) };

    for (const [category, policyOverride] of Object.entries(categories)) {
      const mergedPolicy = this._mergePolicy(this.defaultPolicy, policyOverride);
      this.categoryPolicies.set(category, mergedPolicy);

      log.debug({
        category,
        maxAttempts: mergedPolicy.maxAttempts,
        timeoutMs: mergedPolicy.timeoutMs
      }, 'Loaded category policy');
    }

    log.info({
      defaultMaxAttempts: this.defaultPolicy.maxAttempts,
      defaultTimeoutMs: this.defaultPolicy.timeoutMs,
      categoryCount: this.categoryPolicies.size
    }, 'FallbackPolicyManager initialized');
  }

  /**
   * Get fallback policy for a specific operation category.
   *
   * @param {string} category - Operation category (e.g., 'filesystem', 'network')
   * @returns {Object} Fallback policy
   */
  getPolicyForOperation(category) {
    if (!category) {
      log.debug('No category provided, using default policy');
      return { ...this.defaultPolicy };
    }

    const policy = this.categoryPolicies.get(category);

    if (policy) {
      log.debug({ category }, 'Using category-specific policy');
      return { ...policy };
    }

    log.debug({ category }, 'No category-specific policy, using default');
    return { ...this.defaultPolicy };
  }

  /**
   * Calculate retry delay with exponential backoff and jitter.
   *
   * @param {number} attemptNumber - Current attempt number (0-indexed)
   * @param {Object} retryConfig - Retry configuration
   * @returns {number} Delay in milliseconds
   */
  calculateRetryDelay(attemptNumber, retryConfig) {
    const { baseDelayMs, maxDelayMs, multiplier, jitterMs } = retryConfig;

    // Exponential backoff: delay = baseDelay * multiplier^attempt
    const backoffDelay = baseDelayMs * Math.pow(multiplier, attemptNumber);

    // Cap at max delay
    const cappedDelay = Math.min(backoffDelay, maxDelayMs);

    // Add random jitter (0 to jitterMs)
    const jitter = Math.random() * jitterMs;

    // Ensure total delay doesn't exceed max
    const totalDelay = Math.min(cappedDelay + jitter, maxDelayMs);

    log.debug({
      attemptNumber,
      backoffDelay: Math.round(backoffDelay),
      cappedDelay: Math.round(cappedDelay),
      jitter: Math.round(jitter),
      totalDelay: Math.round(totalDelay)
    }, 'Calculated retry delay');

    return totalDelay;
  }

  /**
   * Check if a failure should trigger fallback based on policy.
   *
   * @param {Object} error - Error object
   * @param {Object} policy - Fallback policy
   * @returns {boolean} Whether fallback should be triggered
   */
  shouldTriggerFallback(error, policy) {
    if (!policy.enabled) {
      return false;
    }

    const { triggers } = policy;
    const errorType = this._classifyError(error);

    switch (errorType) {
      case 'timeout':
        return triggers.onTimeout;
      case 'connection':
        return triggers.onConnectionError;
      case 'tool_error':
        return triggers.onToolError;
      case 'circuit_open':
        return triggers.onCircuitOpen;
      case 'validation':
        // Validation errors should not trigger fallback
        return false;
      default:
        // Unknown error types trigger fallback by default
        return true;
    }
  }

  /**
   * Validate and sanitize a policy configuration.
   *
   * @param {Object} policy - Policy to validate
   * @returns {Object} Validated and sanitized policy
   * @throws {Error} If policy is invalid
   */
  validatePolicy(policy) {
    if (!policy || typeof policy !== 'object') {
      throw new Error('Policy must be an object');
    }

    const validated = { ...policy };

    // Validate maxAttempts
    if (validated.maxAttempts !== undefined) {
      if (!Number.isInteger(validated.maxAttempts) || validated.maxAttempts < 0) {
        throw new Error('maxAttempts must be a non-negative integer');
      }
      if (validated.maxAttempts > 10) {
        log.warn({ maxAttempts: validated.maxAttempts }, 'maxAttempts is very high, capping at 10');
        validated.maxAttempts = 10;
      }
    }

    // Validate timeoutMs
    if (validated.timeoutMs !== undefined) {
      if (!Number.isFinite(validated.timeoutMs) || validated.timeoutMs < 1000) {
        throw new Error('timeoutMs must be at least 1000ms');
      }
      if (validated.timeoutMs > 300000) {
        log.warn({ timeoutMs: validated.timeoutMs }, 'timeoutMs is very high, capping at 300s');
        validated.timeoutMs = 300000;
      }
    }

    // Validate retry config
    if (validated.retry) {
      const retry = validated.retry;

      if (retry.maxRetries !== undefined) {
        if (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0) {
          throw new Error('retry.maxRetries must be a non-negative integer');
        }
        if (retry.maxRetries > 5) {
          log.warn({ maxRetries: retry.maxRetries }, 'retry.maxRetries is very high, capping at 5');
          retry.maxRetries = 5;
        }
      }

      if (retry.baseDelayMs !== undefined) {
        if (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0) {
          throw new Error('retry.baseDelayMs must be a non-negative number');
        }
      }

      if (retry.maxDelayMs !== undefined) {
        if (!Number.isFinite(retry.maxDelayMs) || retry.maxDelayMs < 0) {
          throw new Error('retry.maxDelayMs must be a non-negative number');
        }
      }

      if (retry.baseDelayMs && retry.maxDelayMs && retry.baseDelayMs > retry.maxDelayMs) {
        throw new Error('retry.baseDelayMs must not exceed retry.maxDelayMs');
      }

      if (retry.multiplier !== undefined) {
        if (!Number.isFinite(retry.multiplier) || retry.multiplier <= 0) {
          throw new Error('retry.multiplier must be a positive number');
        }
      }
    }

    return validated;
  }

  /**
   * Register or update a category-specific policy.
   *
   * @param {string} category - Operation category
   * @param {Object} policyOverride - Policy overrides
   */
  setPolicy(category, policyOverride) {
    const validatedOverride = this.validatePolicy(policyOverride);
    const mergedPolicy = this._mergePolicy(this.defaultPolicy, validatedOverride);

    this.categoryPolicies.set(category, mergedPolicy);

    log.info({
      category,
      maxAttempts: mergedPolicy.maxAttempts,
      timeoutMs: mergedPolicy.timeoutMs
    }, 'Category policy updated');
  }

  /**
   * Remove a category-specific policy (fall back to default).
   *
   * @param {string} category - Operation category
   */
  removePolicy(category) {
    if (this.categoryPolicies.delete(category)) {
      log.info({ category }, 'Category policy removed');
    }
  }

  /**
   * Get all configured policies.
   *
   * @returns {Object} All policies (default + categories)
   */
  getAllPolicies() {
    const policies = {
      default: { ...this.defaultPolicy },
      categories: {}
    };

    for (const [category, policy] of this.categoryPolicies.entries()) {
      policies.categories[category] = { ...policy };
    }

    return policies;
  }

  /**
   * Merge two policies (override takes precedence).
   *
   * @private
   * @param {Object} base - Base policy
   * @param {Object} override - Override policy
   * @returns {Object} Merged policy
   */
  _mergePolicy(base, override) {
    const merged = { ...base };

    // Merge top-level properties
    for (const key of ['enabled', 'maxAttempts', 'timeoutMs']) {
      if (override[key] !== undefined) {
        merged[key] = override[key];
      }
    }

    // Deep merge retry config
    if (override.retry) {
      merged.retry = {
        ...base.retry,
        ...override.retry
      };
    }

    // Deep merge selection config
    if (override.selection) {
      merged.selection = {
        ...base.selection,
        ...override.selection
      };
    }

    // Deep merge triggers config
    if (override.triggers) {
      merged.triggers = {
        ...base.triggers,
        ...override.triggers
      };
    }

    return merged;
  }

  /**
   * Classify error type for trigger matching.
   *
   * @private
   * @param {Object} error - Error object
   * @returns {string} Error type
   */
  _classifyError(error) {
    if (!error) {
      return 'unknown';
    }

    const message = error.message || error.toString();
    const code = error.code || error.errorCode || '';

    // Check for validation error (check before other patterns)
    if (code === 'VALIDATION_FAILED' || code === 'INVALID_PARAMS' ||
        message.toLowerCase().includes('validation') ||
        message.toLowerCase().includes('parameter')) {
      return 'validation';
    }

    // Check for timeout
    if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || message.includes('timeout') || message.includes('timed out')) {
      return 'timeout';
    }

    // Check for connection error
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'CONNECTION_ERROR' ||
        message.includes('connection') || message.includes('refused')) {
      return 'connection';
    }

    // Check for circuit breaker
    if (code === 'CIRCUIT_OPEN' || message.includes('circuit breaker')) {
      return 'circuit_open';
    }

    // Check for tool execution error
    if (error.isError || code === 'TOOL_ERROR' || message.includes('tool') || message.includes('execution')) {
      return 'tool_error';
    }

    return 'unknown';
  }
}

/**
 * Create a fallback policy manager from configuration.
 *
 * @param {Object} config - Configuration object
 * @returns {FallbackPolicyManager} Policy manager instance
 */
export function createFallbackPolicyManager(config) {
  return new FallbackPolicyManager(config);
}
