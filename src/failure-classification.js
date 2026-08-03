// Failure classification constants for performance tracking
// Distinguishes capability failures from infrastructure/external failures

export const FAILURE_TYPES = Object.freeze({
  // Capability failures - agent couldn't complete due to skill/knowledge gap
  CAPABILITY: 'capability',    // Agent lacks the skill/knowledge to complete the task
  BUG: 'bug',                  // Agent wrote broken/incorrect code (attributed to implementer)
  INCORRECT: 'incorrect',      // Agent's output was wrong but not necessarily broken code
  
  // Infrastructure/external failures - NOT capability issues
  TIMEOUT: 'timeout',          // Agent process exceeded time limit
  DISCONNECT: 'disconnect',    // Network/connection lost mid-execution
  RATE_LIMIT: 'rate_limit',    // Provider rate limit hit (external constraint)
  KILLED: 'killed',            // Process was terminated (OOM, manual, system)
  SANDBOX: 'sandbox',          // Sandbox restriction blocked execution
  PROVIDER_ERROR: 'provider_error',  // Provider API error (not agent's fault)
  
  // Review-specific failures
  REVIEWER_MISSED: 'reviewer_missed',  // Reviewer failed to catch implementer's error
  REVIEWER_FALSE_POSITIVE: 'reviewer_false_positive',  // Reviewer incorrectly flagged good work
});

export const FAILURE_CATEGORIES = Object.freeze({
  CAPABILITY: ['capability', 'bug', 'incorrect'],
  INFRASTRUCTURE: ['timeout', 'disconnect', 'rate_limit', 'killed', 'sandbox', 'provider_error'],
  REVIEW: ['reviewer_missed', 'reviewer_false_positive'],
});

/**
 * Determines if a failure should count against agent's capability score
 * @param {string} failureType - The type of failure
 * @returns {boolean} true if this is a capability failure
 */
export function isCapabilityFailure(failureType) {
  return FAILURE_CATEGORIES.CAPABILITY.includes(failureType);
}

/**
 * Determines if a failure is infrastructure/external (should NOT count against capability)
 * @param {string} failureType - The type of failure  
 * @returns {boolean} true if this is an infrastructure failure
 */
export function isInfrastructureFailure(failureType) {
  return FAILURE_CATEGORIES.INFRASTRUCTURE.includes(failureType);
}

/**
 * Classifies an error message into a failure type
 * @param {Error|string} error - The error object or message
 * @param {Object} context - Additional context (exitCode, stderr, etc.)
 * @returns {string} The classified failure type
 */
export function classifyFailure(error, context = {}) {
  const msg = String(error || '');
  const exitCode = context.exitCode;
  const stderr = String(context.stderr || '');
  
  // Check for rate limit errors
  if (/you've hit your(?: usage)? limit|rate limit exceeded|too many requests|HTTP 429|status 429|quota exceeded|exhausted your capacity/i.test(msg)) {
    return FAILURE_TYPES.RATE_LIMIT;
  }
  
  // Check for timeout errors
  if (/timeout|timed out|exceeded time limit|operation timed out/i.test(msg)) {
    return FAILURE_TYPES.TIMEOUT;
  }
  
  // Check for disconnect errors
  if (/disconnect|connection lost|network error|ECONNRESET|ECONNREFUSED/i.test(msg)) {
    return FAILURE_TYPES.DISCONNECT;
  }
  
  // Check for killed process (exit null, OOM, SIGKILL)
  if (exitCode === null || exitCode === 137 || /killed|OOM|SIGKILL/i.test(msg)) {
    return FAILURE_TYPES.KILLED;
  }
  
  // Check for sandbox errors
  if (/sandbox|already has an active process|process limit/i.test(msg)) {
    return FAILURE_TYPES.SANDBOX;
  }
  
  // Check for provider errors
  if (/provider error|API error|terminal.?quota.?error/i.test(msg)) {
    return FAILURE_TYPES.PROVIDER_ERROR;
  }
  
  // Default to capability failure if we can't classify
  return FAILURE_TYPES.CAPABILITY;
}