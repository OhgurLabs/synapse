/**
 * NetworkPartitionProvider - Simulates network failures.
 * 
 * Consolidates inject-network-failure.js logic to simulate:
 * - Connection drops (mid-write incomplete data)
 * - Partial writes (truncated data)
 * - Network delays
 * - Packet loss/errors
 * 
 * @module chaos/providers/network-partition
 */

import { FaultProvider, FaultInjectionError } from '../fault-provider.js';

/**
 * Network error for simulated network failures
 */
export class NetworkError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [type] - Error type (drop, timeout, reset, partial)
   */
  constructor(message, type = 'network') {
    super(message);
    this.name = 'NetworkError';
    this.type = type;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * NetworkPartitionProvider - Simulates network failures.
 * 
 * Implements various network failure modes:
 * - Dropped connections: Simulate TCP connection drops mid-write
 * - Partial writes: Truncate data mid-transmission
 * - Connection delays: Add artificial latency
 * - Packet loss: Randomly fail requests
 * 
 * @extends FaultProvider
 */
export class NetworkPartitionProvider extends FaultProvider {
  /**
   * @param {Object} options - Configuration options
   * @param {string} [options.type='network_partition'] - Fault type identifier
   * @param {number} [options.recoveryTimeout=30000] - Recovery timeout in ms
   * @param {boolean} [options.emitEvents=true] - Emit lifecycle events
   * @param {string} [options.failureMode='drop'] - Failure mode (drop, delay, partial, error, dns_timeout, connection_timeout)
   * @param {number} [options.delayMs=0] - Delay in milliseconds
   * @param {number} [options.dropRate=1.0] - Probability of dropping (0.0 to 1.0)
   * @param {number} [options.errorRate=0.0] - Probability of errors (0.0 to 1.0)
   * @param {number} [options.truncateBytes=8] - Bytes to truncate for partial writes
   * @param {number} [options.timeoutMs=5000] - Timeout for connection_timeout mode in milliseconds
   */
    constructor(options = {}) {
      super({
        type: options.type || 'network_partition',
        recoveryTimeout: options.recoveryTimeout || 30000,
        emitEvents: options.emitEvents !== false,
      });

      /**
       * Failure mode to simulate
       * @type {string}
       */
      this.failureMode = options.failureMode || 'drop';

      /**
       * Delay in milliseconds
       * @type {number}
       */
      this.delayMs = options.delayMs || 0;

      /**
       * Drop rate (probability)
       * @type {number}
       */
      this.dropRate = Math.max(0, Math.min(1, options.dropRate ?? 1.0));

      /**
       * Error rate (probability)
       * @type {number}
       */
      this.errorRate = Math.max(0, Math.min(1, options.errorRate ?? 0.0));

      /**
       * Bytes to truncate for partial writes
       * @type {number}
       */
      this.truncateBytes = options.truncateBytes || 8;

      /**
       * Timeout for connection_timeout mode in milliseconds
       * @type {number}
       */
      this.timeoutMs = options.timeoutMs || 3000;

      /**
       * Original async function (for recovery)
       * @private
       * @type {Function|null}
       */
      this._originalFunction = null;

      /**
       * Target function object
       * @private
       * @type {Object|null}
       */
      this._targetObject = null;
    }

    /**
     * Check if the fault can be injected.
     * 
     * @param {Object} context - Injection context
     * @param {string} context.target - Target identifier
     * @param {Object} [context.metadata] - Custom metadata
     * @param {Function} [context.metadata.asyncFunction] - Async function to wrap
     * @param {any} [context.request] - Request object
     * @param {any} [context.response] - Response object
     * @returns {boolean} True if fault can be injected
     */
    canInject(context) {
      if (!context.target) {
        return false;
      }

      // Can inject if we have a function to wrap or if target is valid
      const hasFunction = context.metadata?.asyncFunction !== undefined;
      const hasRequestOrResponse = context.request !== undefined || context.response !== undefined;

      return hasFunction || hasRequestOrResponse;
    }

    /**
     * Inject the network partition fault.
     * 
     * @param {Object} context - Injection context
     * @param {string} context.faultId - Unique fault identifier
     * @param {string} context.target - Target identifier
     * @param {Object} [context.metadata] - Custom metadata
     * @param {Function} [context.metadata.asyncFunction] - Async function to wrap
     * @param {any} [context.request] - Request object
     * @param {any} [context.response] - Response object
     * @param {Function} [context.callback] - Callback handler
     * @param {Function} [context.reject] - Promise reject handler
     * @param {Function} [context.resolve] - Promise resolve handler
     * @returns {Promise<void>} Resolves when fault is applied
     * @throws {FaultInjectionError} If injection fails
     */
    async inject(context) {
      const asyncFunction = context.metadata?.asyncFunction;

      if (asyncFunction && typeof asyncFunction === 'function') {
        this._targetObject = asyncFunction;
        this._originalFunction = asyncFunction;

        const wrappedFunction = async (...args) => {
          // Apply delay if configured
          if (this.delayMs > 0) {
            await this._sleep(this.delayMs);
          }

          // Handle DNS resolution timeout
          if (this.failureMode === 'dns_timeout') {
            throw new NetworkError('DNS resolution failed', 'dns_timeout');
          }

          // Check for drop
          if (this.failureMode === 'drop' && Math.random() < this.dropRate) {
            throw new NetworkError('Connection dropped', 'drop');
          }

          let operationPromise = asyncFunction(...args);

          // Handle connection timeout
          if (this.failureMode === 'connection_timeout') {
            operationPromise = Promise.race([
              operationPromise,
              new Promise((_, reject) =>
                setTimeout(() => reject(new NetworkError('Connection timed out', 'connection_timeout')), this.timeoutMs)
              ),
            ]);
          }

          // Apply to original function
          try {
            const result = await operationPromise;

            // Check for error injection after successful call
            if (this.failureMode === 'error' && Math.random() < this.errorRate) {
              const errors = [
                new NetworkError('Connection reset', 'reset'),
                new NetworkError('Timeout exceeded', 'timeout'),
                new NetworkError('Packet loss detected', 'loss'),
              ];
              throw errors[Math.floor(Math.random() * errors.length)];
            }

            // Handle partial write mode
            if (this.failureMode === 'partial' && typeof result === 'string') {
              const truncated = result.slice(0, Math.max(0, result.length - this.truncateBytes));
              return truncated;
            }

            return result;
          } catch (e) {
            throw e;
          }
        };

        // Replace the function
        if (context.metadata?.targetFnName) {
          context.metadata.target[context.metadata.targetFnName] = wrappedFunction;
        }

        this.active = true;
        this.injectedAt = context.now;

        if (this.emitEvents) {
          this.emit('faultApplied', {
            faultId: context.faultId,
            failureMode: this.failureMode,
            delayMs: this.delayMs,
            dropRate: this.dropRate,
            errorRate: this.errorRate,
            timeoutMs: this.timeoutMs,
          });
        }
      } else {
        // Mark as active for tracking
        this.active = true;
        this.injectedAt = context.now;

        if (this.emitEvents) {
          this.emit('faultApplied', {
            faultId: context.faultId,
            failureMode: this.failureMode,
            delayMs: this.delayMs,
            dropRate: this.dropRate,
            errorRate: this.errorRate,
            timeoutMs: this.timeoutMs,
            note: 'Network partition marked - will affect next operation',
          });
        }
      }
    }

    /**
     * Recover from the network partition fault.
     * 
     * @param {Object} context - Recovery context
     * @param {string} context.faultId - Unique fault identifier
     * @returns {Promise<void>} Resolves when recovery is complete
     * @throws {FaultRecoveryError} If recovery fails
     */
    async recover(context) {
      try {
        // Restore original function
        if (this._targetObject && this._originalFunction) {
          if (context.metadata?.targetFnName && context.metadata.target) {
            context.metadata.target[context.metadata.targetFnName] = this._originalFunction;
          }
          this._originalFunction = null;
          this._targetObject = null;
        }

        this.active = false;
        this.injectedAt = null;

        if (this.emitEvents) {
          this.emit('faultRecovered', {
            faultId: context.faultId,
          });
        }
      } catch (e) {
        throw new FaultInjectionError(
          `Failed to recover from network partition: ${e.message}`,
          context.faultId,
          context
        );
      }
    }

    /**
     * Sleep helper for delays.
     * 
     * @private
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>}
     */
    _sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current network state.
     * 
     * @returns {Object} Network state
     */
    getState() {
      const baseState = super.getState();
      return {
        ...baseState,
        failureMode: this.failureMode,
        delayMs: this.delayMs,
        dropRate: this.dropRate,
        errorRate: this.errorRate,
        truncateBytes: this.truncateBytes,
        timeoutMs: this.timeoutMs,
      };
    }
   }
export default NetworkPartitionProvider;