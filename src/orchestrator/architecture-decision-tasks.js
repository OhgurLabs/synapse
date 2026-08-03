/**
 * Architecture Decision Task Factory
 *
 * Provides factory methods for creating architecture_decision tasks that reliably
 * trigger multi-agent deliberation with minimum argument exchange requirements.
 *
 * Architecture decision tasks are designed to produce structured deliberations where
 * multiple agents engage in proposal → challenge → counter-argument → synthesis flows.
 *
 * Key features:
 * - Enforces minimum of 3 argument exchanges before synthesis
 * - Provides structured prompts for each deliberation phase
 * - Includes topic-specific context extraction hints
 * - Integrates with DeliberationCoordinator and DeliberationProtocol
 */

import { createLogger } from '../logger.js';
import { buildDeliberationSubtaskText } from './deliberation-prompts.js';

const log = createLogger('architecture-decision-tasks');

/**
 * Create an architecture decision task that triggers deliberation.
 *
 * The task is configured with metadata that ensures:
 * 1. It triggers the review-and-revise (deliberation) workflow
 * 2. At least 3 substantive argument exchanges occur before synthesis
 * 3. Structured prompts guide agents through deliberation phases
 *
 * @param {object} taskManager - TaskManager instance
 * @param {string} projectId - Project identifier
 * @param {string} channelId - Channel for task execution
 * @param {string} campaignId - Parent campaign ID (optional)
 * @param {object} options - Task creation options
 * @param {string} options.title - Task title (required, e.g., "Architecture decision: REST vs GraphQL")
 * @param {string} [options.description] - Extended task description with context
 * @param {string} [options.context] - Additional context for decision-making
 * @param {string[]} [options.assignedAgents] - Pre-assigned agent IDs for deliberation
 * @param {number} [options.minMessages=3] - Minimum deliberation exchanges required (default: 3)
 * @param {object} [options.contextHints] - Topic-specific context extraction hints
 * @returns {object} Created task object with deliberation metadata
 * @throws {Error} If title is not provided
 */
export function createArchitectureDecisionTask(
  taskManager,
  projectId,
  channelId,
  campaignId,
  options = {}
) {
  const {
    title,
    description,
    context,
    assignedAgents = [],
    minMessages = 3,
    contextHints = {},
  } = options;

  if (!title) {
    throw new Error('Architecture decision tasks require a title parameter');
  }

  // Ensure the title clearly indicates this is an architecture decision
  const taskTitle = title.toLowerCase().startsWith('architecture decision')
    ? title
    : `Architecture decision: ${title}`;

  // Build a description that includes context and deliberation expectations
  const taskDescription =
    description ||
    [
      `Make an architecture decision on: ${title}`,
      '',
      'This task requires structured multi-agent deliberation:',
      '- A proposal with rationale, tradeoffs, and alternatives',
      '- Challenges with specific concerns and evidence',
      '- Counter-arguments addressing objections',
      '- Synthesis incorporating all perspectives',
      '',
      context ? `Context: ${context}` : null,
    ]
      .filter((line) => line !== null)
      .join('\n');

  // Create the base task with architecture_decision category
  // Note: taskCategory is what createTask expects for setting the category field
  const baseTask = taskManager.createTask(projectId, channelId, {
    title: taskTitle,
    description: taskDescription,
    taskCategory: 'architecture_decision', // Critical: triggers deliberation in lifecycle.js
    campaignId: campaignId || undefined,
  });

  // Update the task with deliberation metadata and config via CAS-safe update
  // This is necessary because createTask has a fixed schema and doesn't accept custom fields
  const task = taskManager._saveWithRetry(projectId, (data) => {
    const t = data.tasks.find((task) => task.id === baseTask.id);
    if (!t) throw new Error(`Task not found: ${baseTask.id}`);

    // Add metadata field
    t.metadata = {
      // Topic-specific context extraction hints
      contextHints: {
        // System components or modules affected
        affectedModules: contextHints.affectedModules || [],
        // Technical factors to consider (performance, scalability, maintainability, etc.)
        technicalFactors: contextHints.technicalFactors || [
          'performance',
          'scalability',
          'maintainability',
          'complexity',
          'compatibility',
        ],
        // Stakeholder concerns or constraints
        constraints: contextHints.constraints || [],
        // Prior decisions or patterns to consider
        precedents: contextHints.precedents || [],
        // Success metrics for evaluation
        successMetrics: contextHints.successMetrics || [],
        ...contextHints,
      },
      // Original context for reference
      originalContext: context || taskDescription,
      // Timestamp for audit
      createdAt: new Date().toISOString(),
      // Task type marker for specialized handling
      taskType: 'architecture_decision',
    };

    // Update deliberation configuration
    t.deliberation = {
      enabled: true,
      sessionId: null,
      // Minimum message threshold — prevents premature synthesis
      minMessages,
      // Pre-assigned agents if specified
      assignedAgents: assignedAgents.length > 0 ? [...assignedAgents] : [],
      // Phase requirements: ensure substantive exchanges
      phaseRequirements: {
        proposal: {
          required: true,
          sections: ['recommendation', 'rationale', 'tradeoffs', 'alternatives', 'successCriteria'],
        },
        challenge: {
          required: true,
          sections: ['primaryConcern', 'evidence', 'alternative', 'acceptanceConditions'],
        },
        counterArgument: {
          required: true,
          sections: ['acknowledgedConcerns', 'refutation', 'amendments', 'pathToConvergence'],
        },
        synthesis: {
          required: true,
          allowedAfter: minMessages,
          sections: ['decision', 'rationale', 'incorporatedFeedback', 'acceptedTradeoffs', 'actionItems'],
        },
      },
    };

    t.updatedAt = new Date().toISOString();
    return data;
  });

  // Get the updated task from saved data
  const updatedTask = task.tasks.find((t) => t.id === baseTask.id);

  log.info('Architecture decision task created', {
    taskId: updatedTask.id,
    projectId,
    campaignId: campaignId || 'standalone',
    title: taskTitle,
    minMessages,
    assignedAgents: assignedAgents.length > 0 ? assignedAgents : 'auto-assign',
  });

  return updatedTask;
}

/**
 * Build a deliberation subtask description for architecture decisions.
 *
 * This generates enriched subtask text that includes structured prompt templates
 * for the assigned agent, guiding them through the deliberation phase they're
 * expected to execute (proposal, challenge, counter-argument, synthesis).
 *
 * @param {object} task - The parent architecture decision task
 * @param {string} agentId - Agent being assigned the subtask
 * @param {string} phase - Deliberation phase: 'proposal', 'challenge', 'counter_argument', 'synthesis'
 * @param {string[]} [participants] - All participant agent IDs
 * @returns {string} Enriched subtask text with phase-specific instructions
 */
export function buildArchitectureDecisionSubtask(task, agentId, phase, participants = []) {
  // For the proposal phase, use the existing buildDeliberationSubtaskText
  if (phase === 'proposal') {
    return buildDeliberationSubtaskText(task, agentId, participants);
  }

  // For other phases, provide phase-specific context
  const phaseDescriptions = {
    challenge: 'Challenge the proposed architecture with specific technical concerns and alternatives',
    counter_argument: 'Address challenges with evidence and propose amendments to the original proposal',
    synthesis: 'Synthesize all arguments into a consensus decision with clear action items',
  };

  const phaseDesc = phaseDescriptions[phase] || 'Participate in architecture deliberation';

  return [
    `[Architecture Decision — ${phase.toUpperCase().replace('_', ' ')} Phase]`,
    '',
    `Task: ${task.title}`,
    `Your role: ${phaseDesc}`,
    '',
    task.description ? `Context:\n${task.description}` : '',
    '',
    `Participants: ${participants.join(', ')}`,
    '',
    'Refer to the deliberation prompts module for structured guidance on this phase.',
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

/**
 * Validate that a task is properly configured as an architecture decision.
 *
 * @param {object} task - Task object to validate
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
export function validateArchitectureDecisionTask(task) {
  const errors = [];

  if (!task) {
    return { valid: false, errors: ['Task object is required'] };
  }

  if (task.category !== 'architecture_decision') {
    errors.push(`Task category must be 'architecture_decision', got '${task.category}'`);
  }

  if (!task.deliberation || !task.deliberation.enabled) {
    errors.push('Task must have deliberation.enabled = true');
  }

  if (task.deliberation && typeof task.deliberation.minMessages !== 'number') {
    errors.push('Task must specify deliberation.minMessages as a number');
  }

  if (task.deliberation && task.deliberation.minMessages < 3) {
    errors.push(`deliberation.minMessages must be ≥3 for architecture decisions, got ${task.deliberation.minMessages}`);
  }

  if (!task.title || task.title.trim().length === 0) {
    errors.push('Task must have a non-empty title');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Suggested context hints for common architecture decision types.
 * These can be passed to createArchitectureDecisionTask via options.contextHints.
 */
export const CONTEXT_HINT_TEMPLATES = {
  // Microservices vs monolith decisions
  systemArchitecture: {
    technicalFactors: ['scalability', 'team size', 'deployment complexity', 'development velocity', 'operational overhead'],
    successMetrics: ['deployment frequency', 'mean time to recovery', 'team productivity', 'system reliability'],
  },

  // API design decisions
  apiDesign: {
    technicalFactors: ['client diversity', 'query flexibility', 'network efficiency', 'type safety', 'backwards compatibility'],
    successMetrics: ['client satisfaction', 'API adoption rate', 'breaking change frequency', 'response time'],
  },

  // Database selection
  dataStore: {
    technicalFactors: ['data model', 'query patterns', 'consistency requirements', 'scalability', 'operational maturity'],
    successMetrics: ['query latency p99', 'write throughput', 'operational incidents', 'schema evolution ease'],
  },

  // Communication patterns
  messaging: {
    technicalFactors: ['latency tolerance', 'failure modes', 'coupling', 'debugging complexity', 'operational overhead'],
    successMetrics: ['end-to-end latency', 'message loss rate', 'incident resolution time', 'development velocity'],
  },

  // Security architecture
  security: {
    technicalFactors: ['threat model', 'compliance requirements', 'user experience impact', 'implementation complexity'],
    successMetrics: ['vulnerability count', 'compliance audit pass rate', 'authentication latency', 'false positive rate'],
  },
};
