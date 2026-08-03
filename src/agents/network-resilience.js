import globalConfig from '../config.js';
import { computeBackoffWithJitter } from '../utils/backoff.js';
import { toProviderError } from '../utils/provider-error.js';

const NETWORK_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 3,
  initialBackoffMs: 1000,
  maxBackoffMs: 10000,
});

export function isRetryableNetworkError(error, { provider } = {}) {
  const providerError = toProviderError(error, { provider });
  return providerError.errorType === 'NETWORK_ERROR' && providerError.isTransient();
}

export function getNetworkRetryConfig(overrides = {}) {
  const configured = globalConfig.agents?.networkResilience || {};
  return {
    maxAttempts: overrides.maxAttempts ?? configured.maxAttempts ?? NETWORK_RETRY_DEFAULTS.maxAttempts,
    initialBackoffMs: overrides.initialBackoffMs ?? configured.initialBackoffMs ?? NETWORK_RETRY_DEFAULTS.initialBackoffMs,
    maxBackoffMs: overrides.maxBackoffMs ?? configured.maxBackoffMs ?? NETWORK_RETRY_DEFAULTS.maxBackoffMs,
  };
}

export function executeWithNetworkResilience(operationFactory, options = {}) {
  const { provider } = options;
  const retryConfig = getNetworkRetryConfig(options);
  let activeAbort = null;
  let aborted = false;

  const promise = (async () => {
    let lastError;

    for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
      if (aborted) {
        throw toProviderError('operation aborted', { provider, errorType: 'NETWORK_ERROR' });
      }

      const operation = operationFactory({ attempt });
      activeAbort = typeof operation?.abort === 'function' ? operation.abort : null;

      try {
        return await operation;
      } catch (error) {
        const providerError = toProviderError(error, { provider });
        lastError = providerError;

        if (!isRetryableNetworkError(providerError, { provider }) || attempt >= retryConfig.maxAttempts - 1) {
          throw providerError;
        }

        const backoffMs = computeBackoffWithJitter(
          attempt,
          retryConfig.initialBackoffMs,
          retryConfig.maxBackoffMs
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      } finally {
        activeAbort = null;
      }
    }

    throw lastError;
  })();

  promise.abort = () => {
    aborted = true;
    if (activeAbort) activeAbort();
  };

  return promise;
}
