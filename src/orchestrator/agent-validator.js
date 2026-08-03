/**
 * Agent validation pipeline — validates agent configuration and execution path.
 *
 * Exposes a simple async function runValidation() that validates an agent through
 * sequential steps: CLI installed, authenticated, API reachable, canary execution.
 *
 * This module provides the API signature expected by the /api/agents/:id/validate
 * endpoint while delegating validation logic to the provider-aware validation pipeline.
 */

import { createValidationPipeline } from './validation-pipeline.js';

/**
 * Run validation pipeline for a given agent.
 *
 * @param {string} agentId - The agent ID to validate
 * @param {object} agents - Agent registry (agents object from agents.js)
 * @param {object} deps - Dependencies (probeAgent, createLogger)
 * @param {object} options - Validation options
 * @param {boolean} options.skipCanary - If true, skip the live canary task execution
 * @param {string} options.projectDir - Optional project directory override for canary execution
 * @returns {Promise<object>} Validation result with shape:
 *   {
 *     agentId: string,
 *     provider: string,
 *     overallStatus: 'pass'|'fail',
 *     steps: Array<{ step: string, status: 'pass'|'fail'|'skip', message: string, fixInstruction: string|null }>,
 *     timestamp: string (ISO 8601)
 *   }
 */
export async function runValidation(agentId, agents, deps, options = {}) {
  const { skipCanary = false, projectDir } = options;

  // Create validation pipeline with injected dependencies
  // The pipeline factory expects { agents, probeAgent, createLogger }
  const pipeline = createValidationPipeline({
    agents,
    probeAgent: deps.probeAgent,
    createLogger: deps.createLogger,
  });

  // Run validation and add timestamp to result
  const result = await pipeline.validateAgent(agentId, {
    skipCanary,
    projectDir,
  });

  // Add ISO 8601 timestamp to match API contract
  return {
    ...result,
    timestamp: new Date().toISOString(),
  };
}
