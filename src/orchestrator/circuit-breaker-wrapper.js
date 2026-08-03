// Circuit breaker wrapper utilities for protecting external service calls.
// Provides reusable wrapper functions that wrap async service calls with circuit breaker protection,
// handles fail-fast logic when circuit is open, and provides fallback execution paths.

import { createLogger } from '../logger.js';
import { STATES } from './circuit-breaker.js';
import { classifyCbFailureReason } from './agent-interaction.js';

const log = createLogger('circuit-breaker-wrapper');

/**
 * Creates a wrapper function that protects async service calls with circuit breaker logic.
 * 
 * @param {object} options
 * @param {CircuitBreaker} options.circuitBreaker - CircuitBreaker instance to use
 * @param {string} options.serviceName - Name of the service for circuit breaker key
 * @param {Function} options.execute - Async function to execute
 * @param {Function} [options.onCircuitOpen] - Optional callback when circuit opens
 * @param {Function} [options.fallback] - Optional fallback function when circuit is open
 * @returns {Function} Wrapped async function
 */
export function createCircuitBreakerWrapper({
  circuitBreaker,
  serviceName,
  execute,
  onCircuitOpen,
  fallback,
}) {
  if (!circuitBreaker || !serviceName || !execute) {
    throw new Error(
      'circuitBreaker, serviceName, and execute are required for circuit breaker wrapper'
    );
  }

  return async function wrappedServiceCall(...args) {
    const state = circuitBreaker.getStateProvider(serviceName);

    if (state === STATES.OPEN) {
      log.warn(`Circuit breaker open for service ${serviceName}, executing fallback`, {
        state,
        serviceName,
      });

      if (onCircuitOpen) {
        try {
          await onCircuitOpen({ serviceName, state, timestamp: new Date().toISOString() });
        } catch (onOpenError) {
          log.error('onCircuitOpen callback failed', { serviceName, error: onOpenError.message });
        }
      }

      if (fallback) {
        try {
          return await fallback({ serviceName, state, args, timestamp: new Date().toISOString() });
        } catch (fallbackError) {
          log.error('Fallback execution failed', {
            serviceName,
            error: fallbackError.message,
            stack: fallbackError.stack,
          });
          throw fallbackError;
        }
      }

      const error = new Error(
        `Service ${serviceName} is unavailable (circuit breaker open)`
      );
      error.code = 'SERVICE_UNAVAILABLE';
      error.serviceName = serviceName;
      error.state = state;
      throw error;
    }

    try {
      const result = await execute(...args);
      circuitBreaker.recordSuccessProvider(serviceName);
      return result;
    } catch (error) {
      // Classify the failure so the CB carries the reason forward into the
      // circuit_breaker:open event. Generic service errors usually classify as
      // 'transient' or 'unknown' here — both map to short cooldowns, never to
      // the 5h default. Keeps non-LLM service failures from blocking provider
      // dispatch for hours.
      const reason = classifyCbFailureReason(error);
      circuitBreaker.recordFailureProvider(serviceName, null, reason);
      const currentState = circuitBreaker.getStateProvider(serviceName);
      
      log.error(`Service call failed for ${serviceName}, circuit state: ${currentState}`, {
        serviceName,
        error: error.message,
        state: currentState,
      });

      throw error;
    }
  };
}

/**
 * Creates a no-op fallback that returns a default value or resolves to undefined.
 * 
 * @param {any} defaultValue - Value to return when circuit is open
 * @returns {Function} Fallback function
 */
export function createNoOpFallback(defaultValue = undefined) {
  return async function noopFallback({ serviceName }) {
    log.info(`Using no-op fallback for ${serviceName}`, { serviceName, defaultValue });
    return defaultValue;
  };
}

/**
 * Creates a fallback that logs a warning but returns a default value.
 * Useful for services where degraded operation is acceptable.
 * 
 * @param {any} defaultValue - Value to return when circuit is open
 * @param {string} message - Warning message to log
 * @returns {Function} Fallback function
 */
export function createLoggingFallback(defaultValue = undefined, message = 'Service unavailable') {
  return async function loggingFallback({ serviceName, state }) {
    log.warn(message, { serviceName, circuitState: state });
    return defaultValue;
  };
}

/**
 * Creates a fallback that throws a ServiceUnavailableError.
 * Useful for critical services where degradation is not acceptable.
 * 
 * @param {string} serviceName - Name of the unavailable service
 * @returns {Function} Fallback function
 */
export function createErrorFallback(serviceName) {
  return async function errorFallback({ state }) {
    const error = new Error(`Service ${serviceName} is unavailable (circuit breaker open)`);
    error.code = 'SERVICE_UNAVAILABLE';
    error.serviceName = serviceName;
    error.state = state;
    throw error;
  };
}

/**
 * Creates an event handler that records circuit breaker state changes for a service.
 * 
 * @param {string} serviceName - Name of the service
 * @param {Function} [onTransition] - Optional callback for state transitions
 * @returns {Function} Event handler
 */
export function createCircuitBreakerEventHandler(serviceName, onTransition) {
  return async function handleCircuitTransition(transition) {
    if (transition.provider !== serviceName) {
      return;
    }

    log.info('Circuit breaker state transition', {
      serviceName,
      previousState: transition.previousState,
      newState: transition.newState,
      trigger: transition.trigger,
      failureCount: transition.failureCount,
    });

    if (onTransition) {
      try {
        await onTransition(transition);
      } catch (error) {
        log.error('onTransition callback failed', {
          serviceName,
          error: error.message,
        });
      }
    }
  };
}

/**
 * Query circuit breaker status for a service.
 * 
 * @param {CircuitBreaker} circuitBreaker - CircuitBreaker instance
 * @param {string} serviceName - Name of the service
 * @returns {object} Status object with state, failures, and recovery info
 */
export function getCircuitBreakerStatus(circuitBreaker, serviceName) {
  const state = circuitBreaker.getStateProvider(serviceName);
  const failures = circuitBreaker.getFailuresProvider(serviceName);
  const recoveryAt = circuitBreaker.getRecoveryTimeProvider(serviceName);

  return {
    serviceName,
    state,
    failures,
    recoveryAt: recoveryAt ? new Date(recoveryAt).toISOString() : null,
    canRequest: circuitBreaker.canRequestProvider(serviceName),
  };
}

/**
 * Get status of all tracked services.
 * 
 * @param {CircuitBreaker} circuitBreaker - CircuitBreaker instance
 * @returns {Object} Map of serviceName -> status
 */
export function getAllCircuitBreakerStatus(circuitBreaker) {
  const providerStatus = circuitBreaker.getProviderStatus();
  const statusMap = {};

  for (const [serviceName, status] of Object.entries(providerStatus)) {
    statusMap[serviceName] = {
      serviceName,
      state: status.state,
      failures: status.failures,
      recoveryAt: status.recoveryAt,
      canRequest: status.state !== STATES.OPEN,
    };
  }

  return statusMap;
}

export { STATES };
