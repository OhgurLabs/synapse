/**
 * Error Registry
 * A central place to store and retrieve classified errors within the orchestrator.
 */

const errors = [];
const MAX_ERRORS = 100; // Limit the number of stored errors to prevent memory issues

/**
 * Adds a classified error to the registry.
 * @param {{category: string, message: string, suggestedFix: string, timestamp: string, agent: object, originalError: string}} errorObject
 */
export function addError(errorObject) {
  if (errors.length >= MAX_ERRORS) {
    errors.shift(); // Remove the oldest error
  }
  errors.push({ ...errorObject, timestamp: new Date().toISOString() });
}

/**
 * Retrieves all currently registered errors.
 * @returns {Array<object>} An array of error objects.
 */
export function getErrors() {
  return [...errors]; // Return a copy to prevent external modification
}

/**
 * Clears all errors from the registry.
 */
export function clearErrors() {
  errors.length = 0;
}

/**
 * Initializes the error registry. (Currently no-op but good for future expansion)
 */
export function initializeErrorRegistry() {
  // Can be used for loading persisted errors, setting up event listeners, etc.
  console.log("Error Registry initialized.");
}
