/**
 * StateCorruptionProvider - Simulates state corruption.
 * 
 * Consolidates AgentCrashSimulator.corruptCheckpoint logic from checkpoint-failure-injection.js
 * to simulate various types of checkpoint data corruption.
 * 
 * @module chaos/providers/state-corruption
 */

import { FaultProvider, FaultInjectionError } from '../fault-provider.js';

/**
 * State corruption error for simulated data corruption
 */
export class StateCorruptionError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [type] - Corruption type (truncate, random, checksum, missing)
   */
  constructor(message, type = 'corruption') {
    super(message);
    this.name = 'StateCorruptionError';
    this.type = type;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * StateCorruptionProvider - Simulates state corruption.
 * 
 * Implements various corruption modes for checkpoint data:
 * - Truncate: Remove completed subtasks
 * - Random: Randomly corrupt fields
 * - Checksum: Corrupt version/timestamp
 * - Missing: Remove checkpointId
 * 
 * @extends FaultProvider
 */
export class StateCorruptionProvider extends FaultProvider {
  /**
   * @param {Object} options - Configuration options
   * @param {string} [options.type='state_corruption'] - Fault type identifier
   * @param {number} [options.recoveryTimeout=30000] - Recovery timeout in ms
   * @param {boolean} [options.emitEvents=true] - Emit lifecycle events
   * @param {string} [options.corruptionType='random'] - Corruption type (truncate, random, checksum, missing)
   * @param {string} [options.targetType='checkpoint'] - Target type (checkpoint, state, config)
   */
  constructor(options = {}) {
    super({
      type: options.type || 'state_corruption',
      recoveryTimeout: options.recoveryTimeout || 30000,
      emitEvents: options.emitEvents !== false,
    });
    
    /**
     * Corruption type to simulate
     * @type {string}
     */
    this.corruptionType = options.corruptionType || 'random';
    
    /**
     * Target type being corrupted
     * @type {string}
     */
    this.targetType = options.targetType || 'checkpoint';
    
    /**
     * Original data (for recovery verification)
     * @private
     * @type {Object|null}
     */
    this._originalData = null;
    
    /**
     * Corrupted data reference
     * @private
     * @type {Object|null}
     */
    this._corruptedData = null;
  }
  
  /**
   * Check if the fault can be injected.
   * 
   * @param {Object} context - Injection context
   * @param {string} context.target - Target identifier
   * @param {Object} [context.metadata] - Custom metadata
   * @param {Object} [context.metadata.data] - Data object to corrupt
   * @param {string} [context.metadata.dataType] - Type of data being corrupted
   * @returns {boolean} True if fault can be injected
   */
  canInject(context) {
    if (!context.target) {
      return false;
    }
    
    // Check if we have data to corrupt
    const hasData = context.metadata?.data !== undefined;
    
    return hasData;
  }
  
  /**
   * Inject the state corruption fault.
   * 
   * @param {Object} context - Injection context
   * @param {string} context.faultId - Unique fault identifier
   * @param {string} context.target - Target identifier
   * @param {Object} [context.metadata] - Custom metadata
   * @param {Object} [context.metadata.data] - Data object to corrupt
   * @param {string} [context.metadata.dataType] - Type of data being corrupted
   * @returns {Promise<Object>} Corrupted data
   * @throws {FaultInjectionError} If injection fails
   */
  async inject(context) {
    const data = context.metadata?.data;
    const dataType = context.metadata?.dataType || this.targetType;
    
    if (!data) {
      throw new FaultInjectionError(
        'No data provided for corruption',
        context.faultId,
        context
      );
    }
    
    // Store original data
    this._originalData = JSON.parse(JSON.stringify(data));
    
    // Corrupt the data
    this._corruptedData = this._corruptData(data, this.corruptionType, dataType);
    
    // Update the metadata to use corrupted data
    if (context.metadata?.data) {
      context.metadata.data = this._corruptedData;
    }
    
    this.active = true;
    this.injectedAt = context.now;
    
    if (this.emitEvents) {
      this.emit('faultApplied', {
        faultId: context.faultId,
        corruptionType: this.corruptionType,
        dataType,
        fieldsCorrupted: this._countCorruptedFields(data, this._corruptedData),
      });
    }
    
    return this._corruptedData;
  }
  
  /**
   * Recover from the state corruption fault.
   * 
   * @param {Object} context - Recovery context
   * @param {string} context.faultId - Unique fault identifier
   * @param {Object} [context.metadata] - Recovery metadata
   * @param {Object} [context.metadata.data] - Data to restore
   * @returns {Promise<Object>} Restored data
   * @throws {FaultRecoveryError} If recovery fails
   */
  async recover(context) {
    try {
      const metadata = context.metadata || {};
      let data = metadata.data;
      
      // If we have original data, restore it
      if (this._originalData) {
        data = this._originalData;
      } else if (data) {
        // Otherwise, try to fix the corrupted data
        data = this._fixCorruptedData(data, this.corruptionType);
      }
      
      // Update metadata if provided
      if (context.metadata?.data) {
        context.metadata.data = data;
      }
      
      this._originalData = null;
      this._corruptedData = null;
      this.active = false;
      this.injectedAt = null;
      
      if (this.emitEvents) {
        this.emit('faultRecovered', {
          faultId: context.faultId,
        });
      }
      
      return data;
    } catch (e) {
      throw new FaultInjectionError(
        `Failed to recover from state corruption: ${e.message}`,
        context.faultId,
        context
      );
    }
  }
  
  /**
   * Corrupt data based on corruption type.
   * 
   * @private
   * @param {Object} data - Data to corrupt
   * @param {string} type - Corruption type
   * @param {string} dataType - Type of data
   * @returns {Object} Corrupted data
   */
  _corruptData(data, type, dataType) {
    const corrupted = JSON.parse(JSON.stringify(data));
    
    if (dataType !== 'checkpoint') {
      // For non-checkpoint data, do a simple corruption
      const keys = Object.keys(corrupted);
      if (keys.length > 0) {
        const key = keys[Math.floor(Math.random() * keys.length)];
        corrupted[key] = null;
      }
      return corrupted;
    }
    
    switch (type) {
      case 'truncate':
        // Remove completed subtasks
        delete corrupted.completedSubtasks;
        break;
      
      case 'random':
        // Randomly corrupt fields
        const fields = ['completedSubtasks', 'milestoneProgress', 'resultSummaries'];
        const field = fields[Math.floor(Math.random() * fields.length)];
        if (corrupted[field]) {
          corrupted[field] = null;
        }
        break;
      
      case 'checksum':
        // Corrupt version/timestamp
        corrupted.createdAt = 'invalid-timestamp';
        corrupted.version = -1;
        break;
      
      case 'missing':
      default:
        // Remove checkpointId
        delete corrupted.checkpointId;
    }
    
    return corrupted;
  }
  
  /**
   * Fix corrupted data.
   * 
   * @private
   * @param {Object} data - Corrupted data
   * @param {string} type - Original corruption type
   * @returns {Object} Fixed data
   */
  _fixCorruptedData(data, type) {
    const fixed = JSON.parse(JSON.stringify(data));
    
    // Try to restore missing fields with defaults
    if (type === 'missing' || type === 'truncate') {
      if (!fixed.completedSubtasks) {
        fixed.completedSubtasks = [];
      }
    }
    
    if (type === 'checksum' || type === 'random') {
      if (fixed.createdAt === 'invalid-timestamp') {
        fixed.createdAt = new Date().toISOString();
      }
      if (fixed.version === -1) {
        fixed.version = 1;
      }
    }
    
    return fixed;
  }
  
  /**
   * Count corrupted fields.
   * 
   * @private
   * @param {Object} original - Original data
   * @param {Object} corrupted - Corrupted data
   * @returns {number} Number of corrupted fields
   */
  _countCorruptedFields(original, corrupted) {
    let count = 0;
    const originalKeys = new Set(Object.keys(original));
    const corruptedKeys = new Set(Object.keys(corrupted));
    
    // Check for missing keys
    for (const key of originalKeys) {
      if (!corruptedKeys.has(key)) {
        count++;
      } else if (original[key] !== corrupted[key]) {
        count++;
      }
    }
    
    return count;
  }
  
  /**
   * Get current corruption state.
   * 
   * @returns {Object} Corruption state
   */
  getState() {
    const baseState = super.getState();
    return {
      ...baseState,
      corruptionType: this.corruptionType,
      targetType: this.targetType,
      hasOriginalData: this._originalData !== null,
      hasCorruptedData: this._corruptedData !== null,
    };
  }
}

export default StateCorruptionProvider;