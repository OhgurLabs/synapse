
import config from '../config.js';
import { RATE_LIMIT_RE, MODEL_NOT_FOUND_RE } from './agent-interaction.js'; // Re-use existing regex

// Define the error categories and their base properties
export const ERROR_CATEGORIES = {
  PERMISSION_DENIED: 'permission-denied',
  SPAWN_FAILURE: 'spawn-failure',
  CIRCUIT_BREAKER_OPEN: 'circuit-breaker-open',
  PERSONA_INVALID: 'persona-invalid',
  TIMEOUT: 'timeout',
  CLI_NOT_FOUND: 'CLI-not-found',
  AUTH_EXPIRED: 'auth-expired',
  UNKNOWN: 'unknown',
};

/**
 * Classifies an error into a predefined category and generates a human-readable suggested fix.
 * @param {Error|string} error The error object or message string.
 * @param {object} [agent] The agent object, if available, to provide context (e.g., agent.name, agent.provider, agent.model).
 * @param {object} [context] Additional context, e.g., command, exitCode, stderr for spawn failures.
 * @returns {{category: string, message: string, suggestedFix: string}} Classified error object.
 */
export function classifyError(error, agent = {}, context = {}) {
  const errorMessage = typeof error === 'string' ? error : error?.message || 'An unknown error occurred.';
  const { name: agentName, provider, model } = agent;
  const { command, exitCode, stderr } = context;

  let category = ERROR_CATEGORIES.UNKNOWN;
  let message = errorMessage;
  let suggestedFix = 'Review the system logs for more details or contact support.';

  // --- Specific Classifications ---

  // Timeout
  if (errorMessage.includes('timed out') || errorMessage.includes('timeout')) {
    category = ERROR_CATEGORIES.TIMEOUT;
    message = agentName ? `${agentName} timed out.` : 'Agent operation timed out.';
    suggestedFix = `Increase the agent's timeout setting in config.js or simplify the task. Current timeout: ${config.agents.timeouts[agentName] || config.agents.timeouts.default || 'N/A'}ms.`;
  }
  // Rate Limit / Circuit Breaker Open
  else if (RATE_LIMIT_RE.test(errorMessage)) {
    category = ERROR_CATEGORIES.CIRCUIT_BREAKER_OPEN;
    message = agentName ? `${agentName} (provider: ${provider}) hit a rate limit.` : `A provider (${provider}) hit a rate limit.`;
    suggestedFix = `The agent or its provider (${provider}) is currently rate-limited. Wait for the cooldown period to expire or try an alternative agent/provider.`;
  }
  // Model Not Found / Persona Invalid (often related if persona relies on specific model)
  else if (MODEL_NOT_FOUND_RE.test(errorMessage) || errorMessage.includes('persona tampered') || errorMessage.includes('persona invalid')) {
    category = ERROR_CATEGORIES.PERSONA_INVALID; // Grouping persona issues here
    message = agentName ? `${agentName} encountered a persona or model configuration issue.` : 'Agent persona or model configuration is invalid.';
    suggestedFix = `Verify the agent's persona file and model configuration for agent '${agentName}'. Ensure the specified model '${model}' is available and correctly configured for provider '${provider}'.`;
  }
  // Spawn Failure / CLI Not Found (often related if CLI is needed to spawn)
  else if (errorMessage.includes('spawn') || errorMessage.includes('ENOENT') || errorMessage.includes('command not found') || (stderr && (stderr.includes('command not found') || stderr.includes('No such file or directory')))) {
    if (errorMessage.includes('command not found') || errorMessage.includes('ENOENT') || (command && !command.startsWith('/')) ) { // Heuristic for CLI not found
      category = ERROR_CATEGORIES.CLI_NOT_FOUND;
      message = agentName ? `${agentName} failed to execute a command: CLI tool not found.` : `Required CLI tool for command '${command}' not found.`;
      suggestedFix = `Ensure all necessary CLI tools and their dependencies are installed and accessible in the system's PATH. Specifically, check command: '${command}'.`;
    } else {
      category = ERROR_CATEGORIES.SPAWN_FAILURE;
      message = agentName ? `${agentName} failed to spawn a process.` : 'Failed to spawn an agent process.';
      suggestedFix = `Check agent '${agentName}' configuration and environment for issues preventing process execution (e.g., incorrect paths, permissions). Command: '${command}', Exit Code: ${exitCode || 'N/A'}.`;
    }
  }
  // Permission Denied
  else if (errorMessage.includes('EACCES') || errorMessage.includes('permission denied')) {
    category = ERROR_CATEGORIES.PERMISSION_DENIED;
    message = agentName ? `${agentName} was denied permission to perform an operation.` : 'Permission denied during an operation.';
    suggestedFix = `Verify the operating system's file permissions or agent's execution rights. Ensure necessary directories and files are accessible.`;
  }
  // Auth Expired
  else if (errorMessage.includes('Unauthorized') || errorMessage.includes('authentication failed') || errorMessage.includes('token expired') || errorMessage.includes('credentials invalid')) {
    category = ERROR_CATEGORIES.AUTH_EXPIRED;
    message = agentName ? `${agentName} encountered an authentication issue with its provider.` : 'Authentication credentials have expired or are invalid.';
    suggestedFix = `Refresh or re-configure authentication credentials for agent '${agentName}' and its provider '${provider}'. Check API keys or tokens.`;
  }

  // Fallback for general errors
  if (category === ERROR_CATEGORIES.UNKNOWN) {
    message = agentName ? `An unexpected error occurred with ${agentName}: ${errorMessage.slice(0, 150)}...` : `An unexpected error occurred: ${errorMessage.slice(0, 150)}...`;
    suggestedFix = 'Review agent logs and system configuration. If the issue persists, contact support with the error details.';
  }

  return { category, message, suggestedFix };
}

// Error categories classified as transient (amber/warning styling)
export const TRANSIENT_CATEGORIES = new Set([
  ERROR_CATEGORIES.TIMEOUT,
  ERROR_CATEGORIES.CIRCUIT_BREAKER_OPEN,
]);

// Error categories classified as persistent (red/error styling with action-required)
export const PERSISTENT_CATEGORIES = new Set([
  ERROR_CATEGORIES.PERMISSION_DENIED,
  ERROR_CATEGORIES.SPAWN_FAILURE,
  ERROR_CATEGORIES.PERSONA_INVALID,
  ERROR_CATEGORIES.CLI_NOT_FOUND,
  ERROR_CATEGORIES.AUTH_EXPIRED,
]);

