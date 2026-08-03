/**
 * Retry utility with exponential backoff.
 *
 * Features:
 * - Configurable max retries
 * - Exponential backoff with configurable factor
 * - Custom error handler for selective retry logic
 * - Jitter support to prevent thundering herd
 *
 * Usage:
 *   const result = await retry(
 *     () => fetchToolsFromServer(),
 *     { maxRetries: 5, initialDelayMs: 1000, backoffFactor: 2 }
 *   );
 */

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [options.initialDelayMs=1000] - Initial delay in milliseconds
 * @param {number} [options.backoffFactor=2] - Multiplier for exponential backoff
 * @param {boolean} [options.jitter=true] - Add random jitter to delays
 * @param {Function} [options.errorHandler] - Custom error handler. Return false to stop retrying.
 * @returns {Promise} Result of the function
 */
export async function retry(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    backoffFactor = 2,
    jitter = true,
    errorHandler
  } = options;

  let attempt = 0;
  let delay = initialDelayMs;

  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      
      // Check if we should stop retrying
      if (attempt > maxRetries) {
        throw error;
      }
      
      // Check custom error handler
      if (errorHandler && !errorHandler(error, attempt)) {
        throw error;
      }
      
      // Calculate delay with optional jitter
      let actualDelay = delay;
      if (jitter) {
        actualDelay = delay * (0.5 + Math.random() * 0.5);
      }
      
      console.warn(`Attempt ${attempt} failed. Retrying in ${Math.round(actualDelay)}ms...`, error.message);
      
      await new Promise(resolve => setTimeout(resolve, actualDelay));
      
      // Exponential backoff
      delay *= backoffFactor;
    }
  }
  
  // This part should ideally not be reached if maxRetries is honored
  throw new Error('Retry function exhausted all attempts.');
}

/**
 * Create a retry wrapper with pre-configured options.
 * @param {Object} defaultOptions - Default retry options
 * @returns {Function} Retry wrapper function
 */
export function createRetry(defaultOptions = {}) {
  return (fn, options = {}) => {
    return retry(fn, { ...defaultOptions, ...options });
  };
}
