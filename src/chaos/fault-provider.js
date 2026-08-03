/**
 * FaultProvider base class and error types for the chaos engineering framework.
 * 
 * This module defines the contract for all fault injection implementations.
 * Subclasses must implement inject(), recover(), and canInject() methods.
 * 
 * @module chaos/fault-provider
 */

import { EventEmitter } from 'events';

/**
 * Base error for fault injection failures
 */
export class FaultInjectionError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} faultId - ID of the fault that failed
   * @param {FaultContext} context - Context at time of failure
   */
  constructor(message, faultId, context) {
    super(message);
    this.name = 'FaultInjectionError';
    this.faultId = faultId;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error for fault recovery failures
 */
export class FaultRecoveryError extends FaultInjectionError {
  /**
   * @param {string} message - Error message
   * @param {string} faultId - ID of the fault that failed to recover
   * @param {FaultContext} context - Context at time of failure
   * @param {Error} originalError - Original error that caused recovery failure
   */
  constructor(message, faultId, context, originalError) {
    super(message, faultId, context);
    this.name = 'FaultRecoveryError';
    this.originalError = originalError;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error for when fault cannot be injected
 */
export class FaultNotInjectableError extends FaultInjectionError {
  /**
   * @param {string} message - Error message
   * @param {string} faultId - ID of the fault
   * @param {FaultContext} context - Context at time of check
   * @param {string} reason - Specific reason why injection is not possible
   */
  constructor(message, faultId, context, reason) {
    super(message, faultId, context);
    this.name = 'FaultNotInjectableError';
    this.reason = reason;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Base class for all fault providers.
 * 
 * Defines the contract for fault injection implementations:
 * - inject(context): Apply the fault
 * - recover(context): Remove the fault effect
 * - canInject(context): Check if fault can be injected
 * 
 * @extends EventEmitter
 */
export class FaultProvider extends EventEmitter {
  /**
   * Creates a new FaultProvider instance.
   * 
   * @param {Object} options - Configuration options
   * @param {string} [options.type='unknown'] - Type identifier for this fault
   * @param {number} [options.recoveryTimeout=30000] - Default recovery timeout in ms
   * @param {boolean} [options.emitEvents=true] - Whether to emit lifecycle events
   */
  constructor(options = {}) {
    super();
    
    /**
     * Type identifier for this fault (e.g., 'network', 'timeout', 'crash')
     * @type {string}
     */
    this.type = options.type || 'unknown';
    
    /**
     * Whether the fault is currently active
     * @type {boolean}
     */
    this.active = false;
    
    /**
     * Timestamp when fault was injected
     * @type {number|null}
     */
    this.injectedAt = null;
    
    /**
     * Default recovery timeout in milliseconds
     * @type {number}
     */
    this.recoveryTimeout = options.recoveryTimeout || 30000;
    
    /**
     * Whether to emit lifecycle events
     * @type {boolean}
     */
    this.emitEvents = options.emitEvents !== false;
    
    /**
     * Cleanup timer reference for auto-recovery
     * @private
     * @type {NodeJS.Timeout|null}
     */
    this._cleanupTimer = null;
  }

  /**
   * Injects the fault into the system.
   * 
   * This method must be implemented by subclasses to apply the specific
   * fault behavior. It should modify system state to reflect the fault
   * condition and resolve when the fault is successfully applied.
   * 
   * @abstract
   * @param {FaultContext} context - Execution context containing injection metadata
   * @param {string} context.faultId - Unique identifier for this fault instance
   * @param {string} [context.agentId] - Target agent ID (if agent-specific scope)
   * @param {string} [context.moduleName] - Target module name (if module-specific scope)
   * @param {string} context.operationName - Operation/function name where injection occurs
   * @param {any[]} [context.operationArgs] - Original arguments passed to the operation
   * @param {Function} [context.originalFunction] - Original function being wrapped
   * @param {number} context.armedAt - Timestamp when fault was armed
   * @param {number} context.now - Current timestamp
   * @param {any} [context.request] - Request object (for network faults)
   * @param {any} [context.response] - Response object (for network faults)
   * @param {Function} [context.callback] - Callback handler (for timeout/crash faults)
   * @param {Function} [context.reject] - Promise reject handler
   * @param {Function} [context.resolve] - Promise resolve handler
   * @param {Object} [context.metadata] - Custom metadata for specific fault types
   * @returns {Promise<void>} Resolves when fault is applied
   * @throws {FaultInjectionError} If fault injection fails
   */
  async inject(context) {
    throw new Error('inject() must be implemented by subclass');
  }

  /**
   * Recovers the system from the injected fault.
   * 
   * This method must be implemented by subclasses to restore the system
   * to normal operation. It should clear any fault state, restore original
   * behavior, and clean up resources.
   * 
   * @abstract
   * @param {FaultContext} context - Execution context containing injection metadata
   * @param {string} context.faultId - Unique identifier for this fault instance
   * @param {number} context.now - Current timestamp
   * @returns {Promise<void>} Resolves when recovery is complete
   * @throws {FaultRecoveryError} If recovery fails
   */
  async recover(context) {
    throw new Error('recover() must be implemented by subclass');
  }

  /**
   * Checks if the fault can be injected in the given context.
   * 
   * This method must be implemented by subclasses to perform lightweight
   * validation checks before attempting injection. It should not have
   * side effects and should return false if injection would fail or
   * is incompatible with the target.
   * 
   * @abstract
   * @param {FaultContext} context - Execution context containing injection metadata
   * @param {string} context.faultId - Unique identifier for this fault instance
   * @param {string} context.operationName - Operation/function name
   * @param {any} [context.request] - Request object (for network faults)
   * @param {any} [context.response] - Response object (for network faults)
   * @param {Function} [context.callback] - Callback handler (for timeout/crash faults)
   * @returns {boolean} True if fault can be injected, false otherwise
   */
  canInject(context) {
    throw new Error('canInject() must be implemented by subclass');
  }

  /**
   * Returns the current fault state.
   * 
   * @returns {Object} Current state information
   * @returns {string} returns.type - Fault type identifier
   * @returns {boolean} returns.active - Whether fault is currently active
   * @returns {number|null} returns.injectedAt - Timestamp when fault was injected
   */
  getState() {
    return {
      type: this.type,
      active: this.active,
      injectedAt: this.injectedAt,
    };
  }

  /**
   * Schedules automatic recovery after the specified timeout.
   * 
   * This is a helper method for time-bound faults that should recover
   * automatically after a duration. Stores the timer reference for
   * potential cancellation.
   * 
   * @param {FaultContext} context - Execution context (includes now timestamp)
   * @returns {Promise<void>} Resolves when recovery completes
   * @throws {FaultRecoveryError} If recovery fails
   */
  async scheduleAutoRecovery(context) {
    return new Promise((resolve, reject) => {
      this._cleanupTimer = setTimeout(async () => {
        try {
          await this.recover(context);
          resolve();
        } catch (e) {
          const error = new FaultRecoveryError(
            `Auto-recovery failed: ${e.message}`,
            context.faultId,
            context,
            e
          );
          reject(error);
        }
      }, this.recoveryTimeout);
    });
  }

  /**
   * Cancels any scheduled auto-recovery timer.
   * 
   * @returns {boolean} True if timer was cancelled, false if no timer was active
   */
  cancelAutoRecovery() {
    if (this._cleanupTimer) {
      clearTimeout(this._cleanupTimer);
      this._cleanupTimer = null;
      return true;
    }
    return false;
  }

  /**
   * Cleans up resources and ensures fault is recovered.
   * 
   * This method should be called when the fault provider is no longer
   * needed. It cancels any pending timers and attempts recovery.
   * 
   * @param {FaultContext} context - Execution context
   * @returns {Promise<void>} Resolves when cleanup is complete
   */
  async cleanup(context) {
    // Cancel any pending auto-recovery
    this.cancelAutoRecovery();
    
    // Ensure fault is recovered
    if (this.active) {
      try {
        await this.recover(context);
      } catch (e) {
        // Log but don't throw - cleanup should be best-effort
        console.error(`Cleanup failed for fault ${context.faultId}:`, e);
      }
    }
  }

  /**
   * Creates a copy of this provider with different configuration.
   * 
   * @param {Object} overrides - Configuration overrides
   * @returns {FaultProvider} New instance with merged configuration
   */
  clone(overrides = {}) {
    const ConfigClass = this.constructor;
    return new ConfigClass({
      type: this.type,
      recoveryTimeout: this.recoveryTimeout,
      emitEvents: this.emitEvents,
      ...overrides,
    });
  }
}

/**
 * @typedef {Object} FaultContext
 * @property {string} faultId - Unique identifier for this fault instance
 * @property {string} [agentId] - Target agent ID (if agent-specific scope)
 * @property {string} [moduleName] - Target module name (if module-specific scope)
 * @property {string} operationName - Operation/function name where injection occurs
 * @property {any[]} [operationArgs] - Original arguments passed to the operation
 * @property {Function} [originalFunction] - Original function being wrapped
 * @property {number} armedAt - Timestamp when fault was armed
 * @property {number} now - Current timestamp
 * @property {any} [request] - Request object (for network faults)
 * @property {any} [response] - Response object (for network faults)
 * @property {Function} [callback] - Callback handler (for timeout/crash faults)
 * @property {Function} [reject] - Promise reject handler
 * @property {Function} [resolve] - Promise resolve handler
 * @property {Object} [metadata] - Custom metadata for specific fault types
 */

export default FaultProvider;
