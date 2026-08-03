/**
 * ProcessCrashProvider - Simulates process crashes.
 * 
 * Consolidates AgentCrashSimulator.scheduleCrash logic from checkpoint-failure-injection.js
 * to simulate agent crashes after a specified number of operations.
 * 
 * @module chaos/providers/process-crash
 */

import { FaultProvider, FaultInjectionError } from '../fault-provider.js';

/**
 * Named operation constants for crash timing.
 * Use these with `targetOperation` option or `checkForCrash` / `withOperation`.
 *
 * @enum {string}
 */
export const OPERATIONS = {
  /** During checkpoint save (state persistence to disk) */
  CHECKPOINT_SAVE: 'checkpointSave',
  /** During task dispatch (sending work to an agent) */
  TASK_DISPATCH: 'taskDispatch',
  /** During milestone transition (advancing to next milestone) */
  MILESTONE_TRANSITION: 'milestoneTransition',
};

/**
 * Process crash error for simulated crashes
 */
export class ProcessCrashError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [reason] - Crash reason
   */
  constructor(message, reason = 'simulated') {
    super(message);
    this.name = 'ProcessCrashError';
    this.reason = reason;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * ProcessCrashProvider - Simulates process crashes.
 * 
 * Implements crash simulation:
 * - Schedule crash after N operations
 * - Track operation count
 * - Trigger crash when threshold reached
 * - Support immediate crash injection
 * 
 * @extends FaultProvider
 */
export class ProcessCrashProvider extends FaultProvider {
  /**
   * @param {Object} options - Configuration options
   * @param {string} [options.type='process_crash'] - Fault type identifier
   * @param {number} [options.recoveryTimeout=30000] - Recovery timeout in ms
   * @param {boolean} [options.emitEvents=true] - Emit lifecycle events
   * @param {number} [options.operations=1] - Number of operations before crash
   * @param {string} [options.reason='simulated'] - Crash reason
   * @param {boolean} [options.immediate=false] - Crash immediately
   * @param {string} [options.targetOperation] - Specific operation to crash during (e.g., 'checkpointSave', 'taskDispatch', 'milestoneTransition')
   */
  constructor(options = {}) {
    super({
      type: options.type || 'process_crash',
      recoveryTimeout: options.recoveryTimeout || 30000,
      emitEvents: options.emitEvents !== false,
    });

    /**
     * Number of operations before crash
     * @type {number}
     */
    this.operations = options.operations || 1;

    /**
     * Crash reason
     * @type {string}
     */
    this.reason = options.reason || 'simulated';

    /**
     * Crash immediately flag
     * @type {boolean}
     */
    this.immediate = options.immediate || false;

    /**
     * Target operation name to crash during (optional)
     * If set, crash only occurs during this specific operation
     * @type {string|null}
     */
    this.targetOperation = options.targetOperation || null;

    /**
     * Current operation count
     * @private
     * @type {number}
     */
    this._operationCount = 0;

    /**
     * Current operation name (set during operation execution)
     * @private
     * @type {string|null}
     */
    this._currentOperation = null;

    /**
     * Whether crash has been triggered
     * @private
     * @type {boolean}
     */
    this._crashTriggered = false;

    /**
     * Original check function (for recovery)
     * @private
     * @type {Function|null}
     */
    this._originalCheckFunction = null;

    /**
     * Target object for monkey-patching
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
   * @param {Function} [context.metadata.checkFunction] - Check function to wrap
   * @param {number} [context.metadata.operationCount] - Current operation count
   * @returns {boolean} True if fault can be injected
   */
  canInject(context) {
    if (!context.target) {
      return false;
    }

    // Can inject if we have a check function, crashing immediately, or targeting a named operation
    const hasFunction = context.metadata?.checkFunction !== undefined;
    const isImmediate = this.immediate;
    const hasTargetOperation = this.targetOperation !== null;

    return hasFunction || isImmediate || hasTargetOperation;
  }
  
  /**
   * Inject the process crash fault.
   *
   * @param {Object} context - Injection context
   * @param {string} context.faultId - Unique fault identifier
   * @param {string} context.target - Target identifier
   * @param {Object} [context.metadata] - Custom metadata
   * @param {Function} [context.metadata.checkFunction] - Check function to wrap
   * @param {number} [context.metadata.operationCount] - Current operation count
   * @param {Function} [context.metadata.incrementOperation] - Function to increment operation count
   * @param {string} [context.metadata.operationName] - Current operation name
   * @returns {Promise<void>} Resolves when fault is applied
   * @throws {FaultInjectionError} If injection fails
   */
  async inject(context) {
    const checkFunction = context.metadata?.checkFunction;
    const incrementOperation = context.metadata?.incrementOperation;

    // Store operation name from context if provided
    if (context.metadata?.operationName) {
      this._currentOperation = context.metadata.operationName;
    }

    if (this.immediate) {
      // Immediate crash - throw right away
      this.active = true;
      this.injectedAt = context.now;
      this._crashTriggered = true;

      if (this.emitEvents) {
        this.emit('faultApplied', {
          faultId: context.faultId,
          reason: this.reason,
          mode: 'immediate',
          operationName: this._currentOperation,
          targetOperation: this.targetOperation,
        });
      }

      // Throw the crash error
      throw new ProcessCrashError(
        `Simulated agent crash: ${this.reason}${this._currentOperation ? ` during ${this._currentOperation}` : ''}`,
        this.reason
      );
    }

    if (checkFunction && typeof checkFunction === 'function') {
      this._targetObject = checkFunction;
      this._originalCheckFunction = checkFunction;

      const wrappedFunction = (...args) => {
        // Increment operation count if function provided
        if (incrementOperation && typeof incrementOperation === 'function') {
          incrementOperation();
        }

        // Check if we should crash
        if (this.shouldCrash()) {
          throw new ProcessCrashError(
            `Simulated agent crash: ${this.reason}${this._currentOperation ? ` during ${this._currentOperation}` : ''}`,
            this.reason
          );
        }

        // Call original function
        return checkFunction(...args);
      };

      // Replace the function
      if (context.metadata?.targetFnName && context.metadata.target) {
        context.metadata.target[context.metadata.targetFnName] = wrappedFunction;
      }

      this.active = true;
      this.injectedAt = context.now;

      if (this.emitEvents) {
        this.emit('faultApplied', {
          faultId: context.faultId,
          reason: this.reason,
          operations: this.operations,
          mode: 'scheduled',
          operationName: this._currentOperation,
          targetOperation: this.targetOperation,
        });
      }
    } else {
      // Mark as active for tracking
      this.active = true;
      this.injectedAt = context.now;

      if (this.emitEvents) {
        this.emit('faultApplied', {
          faultId: context.faultId,
          reason: this.reason,
          operations: this.operations,
          mode: 'scheduled',
          operationName: this._currentOperation,
          targetOperation: this.targetOperation,
          note: 'Crash will be triggered after threshold operations',
        });
      }
    }
  }
  
  /**
   * Recover from the process crash fault.
   * 
   * @param {Object} context - Recovery context
   * @param {string} context.faultId - Unique fault identifier
   * @returns {Promise<void>} Resolves when recovery is complete
   * @throws {FaultRecoveryError} If recovery fails
   */
  async recover(context) {
    try {
      // Restore original function
      if (this._targetObject && this._originalCheckFunction) {
        if (context.metadata?.targetFnName && context.metadata.target) {
          context.metadata.target[context.metadata.targetFnName] = this._originalCheckFunction;
        }
        this._originalCheckFunction = null;
        this._targetObject = null;
      }
      
      // Reset state
      this._operationCount = 0;
      this._crashTriggered = false;
      this.active = false;
      this.injectedAt = null;
      
      if (this.emitEvents) {
        this.emit('faultRecovered', {
          faultId: context.faultId,
          crashTriggered: this._crashTriggered,
        });
      }
    } catch (e) {
      throw new FaultInjectionError(
        `Failed to recover from process crash: ${e.message}`,
        context.faultId,
        context
      );
    }
  }
  
  /**
   * Increment operation count.
   */
  incrementOperation() {
    this._operationCount++;
  }
  
  /**
   * Set operation count.
   *
   * @param {number} count - Operation count
   */
  setOperationCount(count) {
    this._operationCount = count;
  }

  /**
   * Set current operation name.
   *
   * @param {string} operationName - Current operation name
   */
  setOperationName(operationName) {
    this._currentOperation = operationName;
  }

  /**
   * Get current operation name.
   *
   * @returns {string|null} Current operation name
   */
  getOperationName() {
    return this._currentOperation;
  }

  /**
   * Check for a crash at the named operation point and throw if one should occur.
   *
   * Call this at the start of any guarded operation (checkpoint save, task dispatch,
   * milestone transition). Increments the operation counter and throws
   * ProcessCrashError when the threshold + operation match conditions are met.
   *
   * @param {string} operationName - One of the OPERATIONS constants or a custom name
   * @throws {ProcessCrashError} When crash conditions are met
   *
   * @example
   * provider.checkForCrash(OPERATIONS.CHECKPOINT_SAVE);
   */
  checkForCrash(operationName) {
    this._currentOperation = operationName;
    this._operationCount++;

    if (this.shouldCrash(operationName)) {
      throw new ProcessCrashError(
        `Simulated agent crash: ${this.reason} during ${operationName}`,
        this.reason
      );
    }
  }

  /**
   * Wrap an async function so that crash injection is checked before it runs.
   *
   * The operation counter is incremented and the current operation name is set
   * before calling `fn`. If crash conditions are met a ProcessCrashError is thrown
   * instead of calling `fn`.
   *
   * @param {string} operationName - One of the OPERATIONS constants or a custom name
   * @param {Function} fn - Async (or sync) function to wrap
   * @returns {Function} Wrapped function with the same signature as `fn`
   *
   * @example
   * const safeSave = provider.withOperation(OPERATIONS.CHECKPOINT_SAVE, saveCheckpoint);
   * await safeSave(checkpointData);
   */
  withOperation(operationName, fn) {
    return async (...args) => {
      this.checkForCrash(operationName);
      return fn(...args);
    };
  }

  /**
   * Check if crash should be triggered.
   *
   * Crash is triggered when:
   * 1. Operation count threshold is reached AND
   * 2. Current operation matches targetOperation (if targetOperation is set)
   *
   * @param {string} [operationName] - Current operation name (optional)
   * @returns {boolean} True if crash should be triggered
   */
  shouldCrash(operationName = null) {
    if (this._crashTriggered) {
      return false; // Already crashed
    }

    // Update current operation if provided
    if (operationName) {
      this._currentOperation = operationName;
    }

    // Check operation count threshold
    if (this._operationCount < this.operations) {
      return false;
    }

    // If targetOperation is set, check if current operation matches
    if (this.targetOperation) {
      const matches = this._currentOperation === this.targetOperation;
      if (!matches) {
        return false; // Count reached but operation doesn't match
      }
    }

    // All conditions met - trigger crash
    this._crashTriggered = true;
    return true;
  }
  
  /**
   * Get crash status.
   * 
   * @returns {Object} Crash status
   */
  getCrashStatus() {
    return {
      triggered: this._crashTriggered,
      operationCount: this._operationCount,
      operationsThreshold: this.operations,
      remaining: Math.max(0, this.operations - this._operationCount),
    };
  }
  
  /**
   * Get current crash state.
   * 
   * @returns {Object} Crash state
   */
  getState() {
    const baseState = super.getState();
    return {
      ...baseState,
      operations: this.operations,
      reason: this.reason,
      immediate: this.immediate,
      targetOperation: this.targetOperation,
      currentOperation: this._currentOperation,
      operationCount: this._operationCount,
      crashTriggered: this._crashTriggered,
      crashStatus: this.getCrashStatus(),
    };
  }
}

export default ProcessCrashProvider;