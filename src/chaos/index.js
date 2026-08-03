/**
 * Chaos Engineering Framework - Main Export
 * 
 * This module provides the unified chaos engineering framework for testing
 * system resilience. It consolidates all fault injection capabilities into
 * a single API while maintaining backward compatibility with existing test helpers.
 * 
 * @module chaos
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { FaultProvider } from './fault-provider.js';
import { FaultInjector } from './fault-injector.js';
import {
  FaultInjectionError,
  FaultRecoveryError,
  FaultNotInjectableError,
} from './fault-provider.js';
import {
  FaultTypeNotRegisteredError,
  InvalidTargetError,
} from './fault-injector.js';
import { ProviderFailureProvider } from './providers/provider-failure.js';
import { RateLimitProvider } from './providers/rate-limit.js';
import { NetworkPartitionProvider } from './providers/network-partition.js';
import { StateCorruptionProvider } from './providers/state-corruption.js';
import { ProcessCrashProvider, OPERATIONS } from './providers/process-crash.js';
import { JSONLCorruptionProvider } from './providers/jsonl-corruption.js';
import { NetworkError } from './providers/network-partition.js';

/**
 * Pre-configured default FaultInjector instance with all fault types registered.
 * 
 * @type {FaultInjector}
 */
const defaultInjector = new FaultInjector({ emitEvents: true });

// Register all five fault types
defaultInjector.registerFaultType('provider_failure', ProviderFailureProvider);
defaultInjector.registerFaultType('rate_limit', RateLimitProvider);
defaultInjector.registerFaultType('network_partition', NetworkPartitionProvider);
defaultInjector.registerFaultType('state_corruption', StateCorruptionProvider);
defaultInjector.registerFaultType('process_crash', ProcessCrashProvider);
defaultInjector.registerFaultType('jsonl_corruption', JSONLCorruptionProvider);

/**
 * Inject agent crash during checkpoint operation.
 * Backward-compatible wrapper for AgentCrashSimulator.scheduleCrash + shouldCrash.
 * 
 * @param {Object} simulator - Agent crash simulator instance with scheduleCrash and shouldCrash methods
 * @param {number} operationCount - Current operation count
 * @throws {Error} If crash is injected
 */
export function injectAgentCrash(simulator, operationCount) {
  if (simulator.shouldCrash(operationCount)) {
    throw new AgentCrashError('Simulated agent crash during checkpoint operation');
  }
}

/**
 * Agent crash error class.
 */
export class AgentCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentCrashError';
  }
}

/**
 * Inject circuit breaker trip during checkpoint operation.
 * Backward-compatible wrapper for CircuitBreakerSimulator.
 * 
 * @param {Object} simulator - Circuit breaker simulator instance
 * @param {string} key - Provider or agent identifier
 * @param {Object} [breaker] - Real circuit breaker instance (optional)
 * @returns {boolean} - True if breaker is open
 */
export function injectCircuitBreakerTrip(simulator, key, breaker = null) {
  const isProvider = !key.includes('agent');
  const forcedOpen = isProvider
    ? simulator.isProviderForcedOpen(key)
    : simulator.isAgentForcedOpen(key);

  if (forcedOpen) {
    return true;
  }

  // If a real breaker is provided, trip it
  if (breaker) {
    simulator.tripBreaker(breaker, key);
    const state = isProvider
      ? breaker.getStateProvider(key)
      : breaker.getStateAgent(key);
    return state === 'OPEN';
  }

  return false;
}

/**
 * Inject network failure during checkpoint operation.
 * Backward-compatible wrapper for NetworkSimulator.
 * 
 * @param {Object} simulator - Network simulator instance
 * @param {Function} operation - Async operation to wrap
 * @returns {Promise<any>}
 */
export async function injectNetworkFailure(simulator, operation) {
  return simulator.withAllFailures(operation)();
}

/**
 * Inject circuit breaker failure by tripping the breaker.
 * Backward-compatible wrapper that trips a specific node's breaker.
 * 
 * @param {Object} breakers - Map of breaker instances keyed by node ID
 * @param {string} nodeId - Identifier of the node whose breaker should be tripped
 * @param {number} [failureCount=3] - Number of failures to report before tripping
 */
export function injectBreakerFailure(breakers, nodeId, failureCount = 3) {
  if (!breakers[nodeId]) {
    throw new Error(`No circuit breaker found for node ${nodeId}`);
  }

  const breaker = breakers[nodeId];
  
  for (let i = 0; i < failureCount; i++) {
    try {
      throw new Error('Rate limit exceeded (mock)');
    } catch (err) {
      breaker.reportFailure(err);
    }
  }

  breaker.open();
}

/**
 * Simulate a dropped TCP connection mid-write by appending an incomplete JSON
 * line to the checkpoint log.
 * 
 * @param {string} checkpointsPath - Full path to the checkpoints JSONL file.
 */
export function injectDroppedConnection(checkpointsPath) {
  appendFileSync(checkpointsPath, '{"checkpointId":"corrupt-drop","partial":true');
}

/**
 * Simulate a partial write (e.g., socket timeout) by truncating the final
 * bytes of the checkpoint log, leaving the last JSON line malformed.
 * 
 * @param {string} checkpointsPath - Full path to the checkpoints JSONL file.
 * @param {number} truncateBytes - How many bytes to strip from the tail.
 */
export function injectPartialWrite(checkpointsPath, truncateBytes = 8) {
  if (!existsSync(checkpointsPath)) {
    throw new Error(`Cannot truncate missing checkpoint file at ${checkpointsPath}`);
  }

  const buf = readFileSync(checkpointsPath);
  const nextLength = Math.max(0, buf.length - truncateBytes);
  const truncated = buf.subarray(0, nextLength);
  writeFileSync(checkpointsPath, truncated);
}



/**
 * Agent crash simulator for process-level failures.
 */
export class AgentCrashSimulator {
  constructor() {
    this._crashAfter = null;
    this._crashCount = 0;
    this._checkpointCorruption = false;
    this._corruptionType = null;
  }

  scheduleCrash(operations) {
    this._crashAfter = operations;
  }

  clearCrashSchedule() {
    this._crashAfter = null;
  }

  shouldCrash(operationCount) {
    if (this._crashAfter === null) {
      return false;
    }
    if (operationCount >= this._crashAfter) {
      this._crashAfter = null;
      this._crashCount++;
      return true;
    }
    return false;
  }

  enableCorruption(type = 'random') {
    this._checkpointCorruption = true;
    this._corruptionType = type;
  }

  disableCorruption() {
    this._checkpointCorruption = false;
    this._corruptionType = null;
  }

  corruptCheckpoint(data) {
    if (!this._checkpointCorruption) {
      return data;
    }

    const corrupted = { ...data };

    switch (this._corruptionType) {
      case 'truncate':
        delete corrupted.completedSubtasks;
        break;

      case 'random':
        const fields = ['completedSubtasks', 'milestoneProgress', 'resultSummaries'];
        const field = fields[Math.floor(Math.random() * fields.length)];
        if (corrupted[field]) {
          corrupted[field] = null;
        }
        break;

      case 'checksum':
        corrupted.createdAt = 'invalid-timestamp';
        corrupted.version = -1;
        break;

      default:
        delete corrupted.checkpointId;
    }

    return corrupted;
  }

  getCrashCount() {
    return this._crashCount;
  }
}

/**
 * Circuit breaker simulator for breaker-level failures.
 */
export class CircuitBreakerSimulator {
  constructor() {
    this._breakers = new Map();
    this._forcedOpenProviders = new Set();
    this._forcedOpenAgents = new Set();
  }

  forceProviderOpen(provider) {
    this._forcedOpenProviders.add(provider);
  }

  forceAgentOpen(agentId) {
    this._forcedOpenAgents.add(agentId);
  }

  releaseProvider(provider) {
    this._forcedOpenProviders.delete(provider);
  }

  releaseAgent(agentId) {
    this._forcedOpenAgents.delete(agentId);
  }

  isProviderForcedOpen(provider) {
    return this._forcedOpenProviders.has(provider);
  }

  isAgentForcedOpen(agentId) {
    return this._forcedOpenAgents.has(agentId);
  }

  tripBreaker(breaker, key, options = {}) {
    const { threshold = 3 } = options;
    for (let i = 0; i < threshold; i++) {
      if (key.includes('agent')) {
        breaker.reportFailure({ agentId: key });
      } else {
        breaker.reportFailure(key);
      }
    }
  }

  getForcedOpenProviders() {
    return new Set(this._forcedOpenProviders);
  }

  getForcedOpenAgents() {
    return new Set(this._forcedOpenAgents);
  }

  clearAll() {
    this._forcedOpenProviders.clear();
    this._forcedOpenAgents.clear();
  }
}

/**
 * Network simulator for connection-level failures.
 */
export class NetworkSimulator {
  constructor() {
    this._delayMs = 0;
    this._dropRate = 0;
    this._errorRate = 0;
    this._active = false;
    this._pendingPromises = new Map();
  }

  setDelay(delayMs) {
    this._delayMs = delayMs;
  }

  setDropRate(rate) {
    this._dropRate = Math.max(0, Math.min(1, rate));
  }

  setErrorRate(rate) {
    this._errorRate = Math.max(0, Math.min(1, rate));
  }

  withDelay(fn) {
    return async (...args) => {
      if (this._delayMs > 0) {
        await this._sleep(this._delayMs);
      }
      return fn(...args);
    };
  }

  withDropConnection(fn) {
    return async (...args) => {
      if (Math.random() < this._dropRate) {
        throw new NetworkError('Connection dropped');
      }
      return fn(...args);
    };
  }

  withError(fn) {
    return async (...args) => {
      if (Math.random() < this._errorRate) {
        const errors = [
          new NetworkError('Connection reset'),
          new NetworkError('Timeout exceeded'),
          new NetworkError('Packet loss'),
        ];
        throw errors[Math.floor(Math.random() * errors.length)];
      }
      return fn(...args);
    };
  }

  withAllFailures(fn) {
    return async (...args) => {
      if (Math.random() < this._dropRate) {
        throw new NetworkError('Connection dropped');
      }
      if (this._delayMs > 0) {
        await this._sleep(this._delayMs);
      }
      if (Math.random() < this._errorRate) {
        throw new NetworkError('Network error during operation');
      }
      return fn(...args);
    };
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Get the default FaultInjector instance.
 * 
 * @returns {FaultInjector} Default injector instance with all fault types registered
 */
export function getDefaultInjector() {
  return defaultInjector;
}

/**
 * Create a new FaultInjector instance.
 * 
 * @param {Object} [options] - Configuration options
 * @param {boolean} [options.emitEvents=true] - Whether to emit lifecycle events
 * @returns {FaultInjector} New injector instance
 */
export function createInjector(options = {}) {
  const injector = new FaultInjector(options);
  
  // Register all fault types by default
  injector.registerFaultType('provider_failure', ProviderFailureProvider);
  injector.registerFaultType('rate_limit', RateLimitProvider);
  injector.registerFaultType('network_partition', NetworkPartitionProvider);
  injector.registerFaultType('state_corruption', StateCorruptionProvider);
  injector.registerFaultType('process_crash', ProcessCrashProvider);
  injector.registerFaultType('jsonl_corruption', JSONLCorruptionProvider);

  return injector;
}

export {
  FaultProvider,
  FaultInjector,
  FaultInjectionError,
  FaultRecoveryError,
  FaultNotInjectableError,
  FaultTypeNotRegisteredError,
  InvalidTargetError,
  ProviderFailureProvider,
  RateLimitProvider,
  NetworkPartitionProvider,
  StateCorruptionProvider,
  ProcessCrashProvider,
  JSONLCorruptionProvider,
  OPERATIONS,
  NetworkError,
};

export default {
  FaultProvider,
  FaultInjector,
  FaultInjectionError,
  FaultRecoveryError,
  FaultNotInjectableError,
  FaultTypeNotRegisteredError,
  InvalidTargetError,
  ProviderFailureProvider,
  RateLimitProvider,
  NetworkPartitionProvider,
  StateCorruptionProvider,
  ProcessCrashProvider,
  JSONLCorruptionProvider,
  OPERATIONS,
  injectAgentCrash,
  injectCircuitBreakerTrip,
  injectNetworkFailure,
  injectBreakerFailure,
  injectDroppedConnection,
  injectPartialWrite,
  NetworkError,
  AgentCrashSimulator,
  CircuitBreakerSimulator,
  NetworkSimulator,
  AgentCrashError,
  getDefaultInjector,
  createInjector,
  default: defaultInjector,
};
