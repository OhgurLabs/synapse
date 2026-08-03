// Circuit breaker for MCP tool invocations.
// Tracks consecutive failures per tool and trips open after threshold.
// States: closed (normal) → open (reject) → half-open (probe one request).
import { createLogger } from '../logger.js';

const log = createLogger('mcp-tool-circuit-breaker');

export const STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

/**
 * Per-tool circuit breaker for MCP tool invocations.
 * Implements a simple state machine:
 * - CLOSED: normal operation, track failures
 * - OPEN: reject all calls immediately, wait for cooldown
 * - HALF_OPEN: probe with one request after cooldown
 */
export class ToolCircuitBreaker {
  /**
   * @param {object} config
   * @param {number} config.failureThreshold - consecutive failures before tripping open
   * @param {number} config.cooldownMs - ms before open→half-open probe
   */
  constructor(config) {
    this._failureThreshold = config.failureThreshold || 3;
    this._cooldownMs = config.cooldownMs || 60000;

    // toolName → { state, failureTimestamps, openedAt }
    this._tools = new Map();

    log.info('Tool circuit breaker initialized', {
      failureThreshold: this._failureThreshold,
      cooldownMs: this._cooldownMs,
    });
  }

  /**
   * Get or create circuit breaker state for a tool.
   * @private
   * @param {string} toolName
   * @returns {{state: string, failureTimestamps: number[], openedAt: number|null}}
   */
  _getOrCreate(toolName) {
    if (!this._tools.has(toolName)) {
      this._tools.set(toolName, {
        state: STATES.CLOSED,
        failureTimestamps: [],
        openedAt: null,
      });
    }
    return this._tools.get(toolName);
  }

  /**
   * Check if a tool can execute.
   * Returns {allowed: true} if closed or half-open.
   * Returns {allowed: false, error: {...}} if open.
   *
   * @param {string} toolName
   * @returns {{allowed: boolean, error?: {status: string, code: string, message: string}}}
   */
  canExecute(toolName) {
    const circuit = this._getOrCreate(toolName);
    const now = Date.now();

    // State machine transitions
    if (circuit.state === STATES.OPEN) {
      const elapsed = now - (circuit.openedAt || 0);
      if (elapsed >= this._cooldownMs) {
        // Transition: OPEN → HALF_OPEN (probe one request)
        circuit.state = STATES.HALF_OPEN;
        log.info('Circuit breaker transitioned to half-open', {
          toolName,
          cooldownMs: elapsed,
        });
        return { allowed: true };
      } else {
        // Still open, reject immediately
        return {
          allowed: false,
          error: {
            status: 'error',
            code: 'CIRCUIT_OPEN',
            message: `Tool ${toolName} circuit breaker is open (cooldown: ${Math.round((this._cooldownMs - elapsed) / 1000)}s remaining)`,
          },
        };
      }
    }

    // CLOSED or HALF_OPEN: allow execution
    return { allowed: true };
  }

  /**
   * Record a successful tool invocation.
   * Resets failure count and transitions HALF_OPEN → CLOSED.
   *
   * @param {string} toolName
   */
  recordSuccess(toolName) {
    const circuit = this._getOrCreate(toolName);
    const previousState = circuit.state;

    // Clear failure history
    circuit.failureTimestamps = [];
    circuit.openedAt = null;

    // Transition HALF_OPEN → CLOSED
    if (circuit.state === STATES.HALF_OPEN) {
      circuit.state = STATES.CLOSED;
      log.info('Circuit breaker closed after successful probe', { toolName });
    }

    // Log only if state changed or we're clearing failures
    if (previousState !== STATES.CLOSED) {
      log.debug('Tool invocation success recorded', {
        toolName,
        transition: `${previousState} → ${circuit.state}`,
      });
    }
  }

  /**
   * Record a failed tool invocation.
   * Increments failure count and transitions CLOSED → OPEN if threshold exceeded.
   * HALF_OPEN failures immediately transition back to OPEN.
   *
   * @param {string} toolName
   */
  recordFailure(toolName) {
    const circuit = this._getOrCreate(toolName);
    const now = Date.now();

    circuit.failureTimestamps.push(now);

    log.debug('Tool invocation failure recorded', {
      toolName,
      state: circuit.state,
      consecutiveFailures: circuit.failureTimestamps.length,
    });

    // HALF_OPEN failures immediately reopen
    if (circuit.state === STATES.HALF_OPEN) {
      circuit.state = STATES.OPEN;
      circuit.openedAt = now;
      log.warn('Circuit breaker reopened after probe failure', {
        toolName,
        cooldownMs: this._cooldownMs,
      });
      return;
    }

    // CLOSED: check if we've hit threshold
    if (circuit.state === STATES.CLOSED) {
      if (circuit.failureTimestamps.length >= this._failureThreshold) {
        // Transition: CLOSED → OPEN
        circuit.state = STATES.OPEN;
        circuit.openedAt = now;
        log.warn('Circuit breaker opened', {
          toolName,
          consecutiveFailures: circuit.failureTimestamps.length,
          threshold: this._failureThreshold,
          cooldownMs: this._cooldownMs,
        });
      }
    }
  }

  /**
   * Get current state for a tool.
   * @param {string} toolName
   * @returns {{state: string, failureCount: number, openedAt: number|null}}
   */
  getState(toolName) {
    const circuit = this._getOrCreate(toolName);
    return {
      state: circuit.state,
      failureCount: circuit.failureTimestamps.length,
      openedAt: circuit.openedAt,
    };
  }

  /**
   * Get all circuit breaker states.
   * @returns {Map<string, {state: string, failureCount: number, openedAt: number|null}>}
   */
  getAllStates() {
    const states = new Map();
    for (const [toolName, circuit] of this._tools.entries()) {
      states.set(toolName, {
        state: circuit.state,
        failureCount: circuit.failureTimestamps.length,
        openedAt: circuit.openedAt,
      });
    }
    return states;
  }

  /**
   * Manually reset a circuit breaker (for testing/debugging).
   * @param {string} toolName
   */
  reset(toolName) {
    if (this._tools.has(toolName)) {
      const circuit = this._tools.get(toolName);
      circuit.state = STATES.CLOSED;
      circuit.failureTimestamps = [];
      circuit.openedAt = null;
      log.info('Circuit breaker manually reset', { toolName });
    }
  }

  /**
   * Manually reset all circuit breakers (for testing/debugging).
   */
  resetAll() {
    for (const toolName of this._tools.keys()) {
      this.reset(toolName);
    }
    log.info('All circuit breakers reset');
  }
}

/**
 * Factory function to create a ToolCircuitBreaker from config.
 * @param {object} config - MCP tool circuit breaker config (from src/config.js)
 * @returns {ToolCircuitBreaker}
 */
export function createToolCircuitBreaker(config) {
  return new ToolCircuitBreaker({
    failureThreshold: config.failureThreshold,
    cooldownMs: config.cooldownMs,
  });
}
