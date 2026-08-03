/**
 * FaultInjector - Central orchestrator for chaos engineering fault injection.
 * 
 * This class manages the registration of fault types, tracks active injections,
 * and delegates inject/recover operations to the appropriate fault providers.
 * 
 * @module chaos/fault-injector
 */

import { EventEmitter } from 'events';
import {
  FaultProvider,
  FaultInjectionError,
  FaultRecoveryError,
  FaultNotInjectableError,
} from './fault-provider.js';

/**
 * Error for when fault type is not registered
 */
export class FaultTypeNotRegisteredError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} faultType - The unregistered fault type
   */
  constructor(message, faultType) {
    super(message);
    this.name = 'FaultTypeNotRegisteredError';
    this.faultType = faultType;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error for when target is invalid or missing
 */
export class InvalidTargetError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} target - The invalid target value
   */
  constructor(message, target) {
    super(message);
    this.name = 'InvalidTargetError';
    this.target = target;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Registry entry for an active fault injection
 */
class FaultRegistryEntry {
  /**
   * @param {string} faultType - Type of fault
   * @param {string} target - Target of injection
   * @param {FaultProvider} provider - The fault provider instance
   * @param {Object} options - Injection options
   */
  constructor(faultType, target, provider, options) {
    this.faultType = faultType;
    this.target = target;
    this.provider = provider;
    this.options = options;
    this.createdAt = Date.now();
  }

  /**
   * @returns {Object} Entry state
   */
  getState() {
    return {
      faultType: this.faultType,
      target: this.target,
      providerState: this.provider.getState(),
      options: this.options,
      createdAt: this.createdAt,
    };
  }
}

/**
 * FaultInjector - Central orchestrator for chaos engineering fault injection.
 * 
 * Manages registration of fault types, tracks active injections, and delegates
 * inject/recover operations to the appropriate fault providers.
 * 
 * @extends EventEmitter
 */
export class FaultInjector extends EventEmitter {
  /**
   * Creates a new FaultInjector instance.
   * 
   * @param {Object} options - Configuration options
   * @param {boolean} [options.emitEvents=true] - Whether to emit lifecycle events
   */
  constructor(options = {}) {
    super();
    
    /**
     * Whether to emit lifecycle events
     * @type {boolean}
     */
    this.emitEvents = options.emitEvents !== false;
    
    /**
     * Registry of registered fault types (name -> provider class)
     * @private
     * @type {Map<string, new (options: Object) => FaultProvider>}
     */
    this._faultTypes = new Map();
    
    /**
     * Registry of active fault injections (key: faultType+target -> entry)
     * @private
     * @type {Map<string, FaultRegistryEntry>}
     */
    this._activeInjections = new Map();
    
    /**
     * Counter for generating unique fault IDs
     * @private
     * @type {number}
     */
    this._faultIdCounter = 0;
  }

  /**
   * Registers a fault type with its provider class.
   * 
   * @param {string} name - Unique name for the fault type (e.g., 'provider_failure')
   * @param {new (options: Object) => FaultProvider} providerClass - Provider class constructor
   * @throws {FaultTypeNotRegisteredError} If fault type is already registered
   * 
   * @example
   * injector.registerFaultType('provider_failure', ProviderFailureProvider);
   * injector.registerFaultType('rate_limit', RateLimitProvider);
   */
  registerFaultType(name, providerClass) {
    if (this._faultTypes.has(name)) {
      throw new FaultTypeNotRegisteredError(
        `Fault type '${name}' is already registered`,
        name
      );
    }
    
    if (typeof providerClass !== 'function' || !(providerClass.prototype instanceof FaultProvider)) {
      throw new TypeError(
        `Provider class for '${name}' must be a constructor extending FaultProvider`
      );
    }
    
    this._faultTypes.set(name, providerClass);
    
    if (this.emitEvents) {
      this.emit('faultTypeRegistered', { name });
    }
  }

  /**
   * Injects a fault into the system.
   * 
   * @param {string} faultType - Type of fault to inject
   * @param {string} target - Target of injection (e.g., 'anthropic', 'openai', 'ollama')
   * @param {Object} [options] - Injection options
   * @param {number} [options.recoveryTimeout] - Override recovery timeout in ms
   * @param {Object} [options.metadata] - Custom metadata for the fault provider
   * @returns {Promise<FaultRegistryEntry>} The registry entry for this injection
   * @throws {FaultTypeNotRegisteredError} If fault type is not registered
   * @throws {InvalidTargetError} If target is invalid
   * @throws {FaultNotInjectableError} If fault cannot be injected for this target
   * @throws {FaultInjectionError} If injection fails
   * 
   * @example
   * const entry = await injector.inject('provider_failure', 'anthropic', {
   *   recoveryTimeout: 5000,
   *   metadata: { simulateError: 'rate_limit_exceeded' }
   * });
   */
  async inject(faultType, target, options = {}) {
    const faultId = this._generateFaultId(faultType, target);

    if (!this._faultTypes.has(faultType)) {
      throw new FaultTypeNotRegisteredError(
        `Fault type '${faultType}' is not registered`,
        faultType
      );
    }
    
    if (!target || typeof target !== 'string') {
      throw new InvalidTargetError(
        `Target must be a non-empty string, got: ${target}`,
        target
      );
    }
    
    const providerClass = this._faultTypes.get(faultType);
    const provider = new providerClass({
      ...options, // Spread all options
      type: faultType, // Ensure type is correctly set/overridden
      emitEvents: this.emitEvents,
    });
    
    const context = {
      faultId,
      target,
      now: Date.now(),
      armedAt: Date.now(),
      metadata: options.metadata,
    };
    
    if (!provider.canInject(context)) {
      throw new FaultNotInjectableError(
        `Fault '${faultType}' cannot be injected on target '${target}'`,
        faultId,
        context,
        'Target incompatible with fault type'
      );
    }
    
    try {
      await provider.inject(context);
    } catch (e) {
      throw new FaultInjectionError(
        `Failed to inject fault '${faultType}': ${e.message}`,
        faultId,
        context
      );
    }
    
    const entry = new FaultRegistryEntry(faultType, target, provider, options);
    const registryKey = this._getRegistryKey(faultType, target);
    this._activeInjections.set(registryKey, entry);
    
    if (this.emitEvents) {
      this.emit('faultInjected', {
        faultType,
        target,
        faultId,
        entry: entry.getState(),
      });
    }
    
    return entry;
  }

  /**
   * Removes an active fault injection and recovers the system.
   * 
   * @param {string} faultType - Type of fault to remove
   * @param {string} target - Target of the injection
   * @returns {Promise<void>} Resolves when recovery is complete
   * @throws {FaultRecoveryError} If recovery fails
   * 
   * @example
   * await injector.remove('provider_failure', 'anthropic');
   */
  async remove(faultType, target) {
    const registryKey = this._getRegistryKey(faultType, target);
    const entry = this._activeInjections.get(registryKey);
    
    if (!entry) {
      // No active injection to remove - this is not an error
      return;
    }
    
    const context = {
      faultId: entry.provider.constructor.name,
      target,
      now: Date.now(),
    };
    
    try {
      await entry.provider.recover(context);
    } finally {
      await entry.provider.cleanup(context);
      this._activeInjections.delete(registryKey);
    }
    
    if (this.emitEvents) {
      this.emit('faultRemoved', { faultType, target });
    }
  }

  /**
   * Removes all active fault injections and recovers the system.
   * 
   * @returns {Promise<void>} Resolves when all recoveries are complete
   * 
   * @example
   * await injector.removeAll();
   */
  async removeAll() {
    const entries = Array.from(this._activeInjections.values());
    this._activeInjections.clear();
    
    for (const entry of entries) {
      const context = {
        faultId: entry.provider.constructor.name,
        target: entry.target,
        now: Date.now(),
      };
      
      try {
        await entry.provider.recover(context);
      } finally {
        await entry.provider.cleanup(context);
      }
      
      if (this.emitEvents) {
        this.emit('faultRemoved', {
          faultType: entry.faultType,
          target: entry.target,
        });
      }
    }
    
    if (this.emitEvents) {
      this.emit('allFaultsRemoved');
    }
  }

  /**
   * Lists all active fault injections.
   * 
   * @returns {Object[]} Array of active injection states
   * @returns {string} returns[].faultType - Type of fault
   * @returns {string} returns[].target - Target of injection
   * @returns {Object} returns[].providerState - Provider state information
   * @returns {number} returns[].createdAt - Timestamp when fault was injected
   * 
   * @example
   * const active = injector.listActive();
   * console.log(`Active faults: ${active.length}`);
   */
  listActive() {
    return Array.from(this._activeInjections.values()).map(entry => entry.getState());
  }

  /**
   * Checks if a specific fault injection is active.
   * 
   * @param {string} faultType - Type of fault
   * @param {string} target - Target of injection
   * @returns {boolean} True if fault is active
   * 
   * @example
   * if (injector.isActive('provider_failure', 'anthropic')) {
   *   console.log('Provider failure is currently active');
   * }
   */
  isActive(faultType, target) {
    const registryKey = this._getRegistryKey(faultType, target);
    return this._activeInjections.has(registryKey);
  }

  /**
   * Gets the count of active fault injections.
   * 
   * @returns {number} Number of active injections
   */
  activeCount() {
    return this._activeInjections.size;
  }

  /**
   * Gets the number of registered fault types.
   * 
   * @returns {number} Number of registered fault types
   */
  registeredCount() {
    return this._faultTypes.size;
  }

  /**
   * Gets the list of registered fault type names.
   * 
   * @returns {string[]} Array of fault type names
   */
  getRegisteredTypes() {
    return Array.from(this._faultTypes.keys());
  }

  /**
   * Generates a unique fault ID.
   * 
   * @private
   * @param {string} faultType - Type of fault
   * @param {string} target - Target of injection
   * @returns {string} Unique fault ID
   */
  _generateFaultId(faultType, target) {
    this._faultIdCounter++;
    return `${faultType}:${target}:${this._faultIdCounter}`;
  }

  /**
   * Generates a registry key for an injection.
   * 
   * @private
   * @param {string} faultType - Type of fault
   * @param {string} target - Target of injection
   * @returns {string} Registry key
   */
  _getRegistryKey(faultType, target) {
    return `${faultType}:${target}`;
  }
}

export default FaultInjector;
