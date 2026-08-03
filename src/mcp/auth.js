import { createLogger } from '../logger.js';
import fs from 'fs';
import path from 'path';

const log = createLogger('mcp-auth');

/**
 * AuthHandler — Authentication handler for MCP server connections.
 *
 * Supports:
 * - API Key: Authorization header with Bearer or custom scheme
 * - OAuth: Bearer token with optional refresh flow
 * - mTLS: Client certificate and key for mutual TLS authentication
 *
 * Authentication failures are handled with configurable retry logic
 * using exponential backoff.
 */
export class AuthHandler {
  /**
   * @param {Object} options
   * @param {Object} [options.auth] - Auth configuration
   * @param {string} [options.auth.type] - Auth type: 'apikey', 'oauth', 'mtls', or 'none'
   * @param {string} [options.auth.apiKey] - API key for apikey auth
   * @param {string} [options.auth.apiKeyHeader] - Header name for API key (default: 'Authorization')
   * @param {string} [options.auth.apiKeyPrefix] - Prefix for API key (default: 'Bearer')
   * @param {string} [options.auth.token] - OAuth Bearer token
   * @param {string} [options.auth.tokenType] - Token type (default: 'Bearer')
   * @param {string} [options.auth.certPath] - Path to client certificate for mTLS
   * @param {string} [options.auth.keyPath] - Path to client key for mTLS
   * @param {Object} [options.retry] - Retry configuration
   * @param {number} [options.retry.maxAttempts=3] - Max retry attempts for auth failures
   * @param {number} [options.retry.baseDelay=1000] - Base delay in ms for exponential backoff
   * @param {number} [options.retry.maxDelay=10000] - Max delay cap in ms
   */
  constructor(options = {}) {
    this.authConfig = options.auth || { type: 'none' };
    this.retryConfig = {
      maxAttempts: options.retry?.maxAttempts ?? 3,
      baseDelay: options.retry?.baseDelay ?? 1000,
      maxDelay: options.retry?.maxDelay ?? 10000,
      multiplier: options.retry?.multiplier ?? 2.0
    };

    this._validateAuthConfig();
    this._validateRetryConfig();
    this._retryAttempt = 0;
  }

  /**
   * Validate the authentication configuration.
   * @private
   * @throws {Error} If auth config is invalid
   */
  _validateAuthConfig() {
    const { type, apiKey, token, certPath, keyPath } = this.authConfig;

    if (!type || typeof type !== 'string') {
      throw new TypeError('Auth type must be specified');
    }

    const validTypes = ['none', 'apikey', 'oauth', 'mtls'];
    if (!validTypes.includes(type)) {
      throw new TypeError(`Invalid auth type: ${type}. Must be one of: ${validTypes.join(', ')}`);
    }

    if (type === 'apikey' && !apiKey) {
      throw new TypeError('API key is required for apikey auth type');
    }

    if (type === 'oauth' && !token) {
      throw new TypeError('Token is required for oauth auth type');
    }

    if (type === 'mtls') {
      if (!certPath || !keyPath) {
        throw new TypeError('Both certPath and keyPath are required for mtls auth type');
      }

      const resolvedCertPath = this._resolvePath(certPath);
      const resolvedKeyPath = this._resolvePath(keyPath);

      if (!fs.existsSync(resolvedCertPath)) {
        throw new Error(`Certificate file not found: ${resolvedCertPath}`);
      }

      if (!fs.existsSync(resolvedKeyPath)) {
        throw new Error(`Key file not found: ${resolvedKeyPath}`);
      }
    }
  }

  /**
   * Validate retry configuration values.
   * @private
   * @throws {TypeError} If retry config is invalid
   */
  _validateRetryConfig() {
    const { maxAttempts, baseDelay, maxDelay, multiplier } = this.retryConfig;

    if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
      throw new TypeError('Retry maxAttempts must be a non-negative integer');
    }

    if (!Number.isFinite(baseDelay) || baseDelay < 0) {
      throw new TypeError('Retry baseDelay must be a non-negative number');
    }

    if (!Number.isFinite(maxDelay) || maxDelay < 0) {
      throw new TypeError('Retry maxDelay must be a non-negative number');
    }

    if (maxDelay < baseDelay) {
      throw new TypeError('Retry maxDelay must be greater than or equal to baseDelay');
    }

    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new TypeError('Retry multiplier must be a positive number');
    }
  }

  /**
   * Get auth headers to apply to HTTP requests.
   * @returns {Object} Headers object with authentication headers
   */
  getHeaders() {
    const { type, apiKey, apiKeyHeader, apiKeyPrefix, token, tokenType } = this.authConfig;
    const headers = {};

    if (type === 'apikey') {
      const prefix = apiKeyPrefix || 'Bearer';
      const headerName = apiKeyHeader || 'Authorization';
      headers[headerName] = `${prefix} ${apiKey}`;
    } else if (type === 'oauth') {
      const typeStr = tokenType || 'Bearer';
      headers['Authorization'] = `${typeStr} ${token}`;
    }

    return headers;
  }

  /**
   * Get TLS options for mTLS authentication.
   * @returns {Object|null} TLS options object or null if not using mTLS
   */
  getTlsOptions() {
    const { type, certPath, keyPath } = this.authConfig;

    if (type !== 'mtls') {
      return null;
    }

    const resolvedCertPath = this._resolvePath(certPath);
    const resolvedKeyPath = this._resolvePath(keyPath);

    return {
      cert: fs.readFileSync(resolvedCertPath),
      key: fs.readFileSync(resolvedKeyPath)
    };
  }

  /**
   * Get the full path to a certificate or key file.
   * Handles relative paths by resolving against the current working directory.
   * @private
   * @param {string} filePath - File path (absolute or relative)
   * @returns {string} Absolute file path
   */
  _resolvePath(filePath) {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(process.cwd(), filePath);
  }

  /**
   * Handle an authentication failure with retry logic.
   * @param {Error} error - The authentication error
   * @param {number} attempt - Current attempt number (1-indexed)
   * @returns {Promise<void>} Resolves when retry delay is complete, or rejects if max attempts reached
   * @throws {Error} If max retry attempts exceeded
   */
  async handleAuthFailure(error, attempt = 1) {
    this._retryAttempt = attempt;

    if (attempt >= this._getTotalAttempts()) {
      log.error(
        { error: error.message, attempts: attempt },
        'Max authentication retry attempts reached'
      );
      const maxError = new Error(`Max authentication retry attempts reached: ${error.message}`);
      maxError.cause = error;
      throw maxError;
    }

    const backoffDelay = this.getRetryDelay(attempt);

    log.warn(
      {
        error: error.message,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: this.retryConfig.maxAttempts,
        delayMs: backoffDelay
      },
      'Authentication failed, scheduling retry'
    );

    await this._sleep(backoffDelay);
  }

  /**
   * Wrap an async operation with authentication retry logic.
   * Calls fn() and retries on retryable auth errors with exponential backoff.
   *
   * @param {Function} fn - Async function to execute; receives (attempt: number)
   * @param {Function} [isRetryable] - Predicate to decide if an error should be retried.
   *                                   Defaults to _isAuthError (401/403 HTTP errors).
   * @returns {Promise<*>} Result of fn()
   * @throws {Error} If fn() fails on all attempts, or if the error is not retryable
   */
  async withRetry(fn, isRetryable = this._isAuthError.bind(this)) {
    const totalAttempts = this._getTotalAttempts();

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const result = await fn(attempt);
        this.resetRetryCounter();
        return result;
      } catch (err) {
        // Non-retryable errors propagate immediately
        if (!isRetryable(err)) {
          throw err;
        }

        // handleAuthFailure sleeps and then returns (if more retries remain),
        // or throws a "Max authentication retry attempts reached" error.
        await this.handleAuthFailure(err, attempt);
      }
    }
  }

  /**
   * Determine if an error is a retryable authentication error.
   * Checks HTTP 401/403 status codes, common message patterns, or an explicit flag.
   *
   * @private
   * @param {Error} err - The error to check
   * @returns {boolean} True if the error should trigger a retry
   */
  _isAuthError(err) {
    // Numeric status property (set by HTTP clients)
    if (err.status === 401 || err.status === 403) {
      return true;
    }
    // Status code embedded in message (e.g. "HTTP 401: Unauthorized")
    if (typeof err.message === 'string' &&
        (err.message.includes('401') || err.message.includes('403') ||
         err.message.includes('Unauthorized') || err.message.includes('Forbidden'))) {
      return true;
    }
    // Explicit opt-in flag
    return Boolean(err.isAuthError);
  }

  /**
   * Sleep for a specified duration.
   * @private
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calculate the backoff delay for a given attempt.
   * Attempt 1 uses baseDelay, attempt 2 uses baseDelay * multiplier, etc.
   *
   * @param {number} attempt - Current attempt number (1-indexed)
   * @returns {number} Delay in milliseconds capped at maxDelay
   */
  getRetryDelay(attempt) {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new TypeError('Retry attempt must be a positive integer');
    }

    return Math.min(
      this.retryConfig.baseDelay * Math.pow(this.retryConfig.multiplier, attempt - 1),
      this.retryConfig.maxDelay
    );
  }

  /**
   * Check if the current auth type requires HTTPS.
   * @returns {boolean} True if HTTPS is required
   */
  requiresHttps() {
    return this.authConfig.type === 'mtls';
  }

  /**
   * Reset retry counter (call after successful authentication).
   */
  resetRetryCounter() {
    this._retryAttempt = 0;
  }

  /**
   * Get the current retry attempt count.
   * @returns {number} Current retry attempt
   */
  getRetryAttempt() {
    return this._retryAttempt;
  }

  /**
   * Get the effective number of total attempts allowed for an operation.
   * A maxAttempts value of 0 means "try once and do not retry".
   *
   * @private
   * @returns {number} Effective total attempts
   */
  _getTotalAttempts() {
    return Math.max(1, this.retryConfig.maxAttempts);
  }

  /**
   * Validate that the server URL matches auth requirements.
   * @param {string} url - Server URL to validate
   * @throws {Error} If URL doesn't match auth requirements
   */
  validateServerUrl(url) {
    if (this.requiresHttps() && !url.startsWith('https://')) {
      throw new Error('mTLS authentication requires HTTPS URL');
    }
  }
}
