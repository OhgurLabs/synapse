/**
 * Socratic Task Execution Handler
 *
 * Handles creation and execution of Socratic research tasks within the campaign system.
 * Integrates with the dispatch system to invoke LLM agents for question generation.
 *
 * Workflow:
 * 1. Create Socratic task linked to campaign
 * 2. Dispatch to specialized socratic-agent
 * 3. Generate raw questions (15-20)
 * 4. Apply curation (deduplication, merging)
 * 5. Validate output against schema
 * 6. Persist questions to campaign via setQuestions()
 *
 * This module provides the integration point between campaign tasks and the socratic-agent orchestration.
 */

import { createLogger } from '../logger.js';
import { executeSocraticResearch, detectSocraticTask } from './socratic-agent.js';
import { curateQuestions } from './socratic-curation.js';
import { validateQuestionSchema } from './socratic-validation.js';
import { generateQuestionGenerationPrompt } from './socratic-prompts.js';

const log = createLogger('socratic-task-executor');

/**
 * Create a Socratic research task for a campaign.
 *
 * @param {object} taskManager - TaskManager instance
 * @param {string} projectId - Project identifier
 * @param {string} channelId - Channel for task execution
 * @param {string} campaignId - Parent campaign ID
 * @param {object} options - Task creation options
 * @param {string} options.domain - Domain being explored (required for socratic)
 * @param {string} options.title - Task title (optional, auto-generated if not provided)
 * @param {string} options.description - Task description (optional)
 * @returns {object} Created task object
 */
export function createSocraticTask(taskManager, projectId, channelId, campaignId, options = {}) {
  const { domain, title, description } = options;

  if (!domain) {
    throw new Error('Socratic tasks require a domain parameter');
  }

  const taskTitle = title || `Socratic research: ${domain}`;
  const taskDescription = description || `Conduct Socratic analysis of ${domain} to identify assumptions and generate critical questions.`;

  const task = taskManager.createTask(projectId, channelId, {
    title: taskTitle,
    description: taskDescription,
    type: 'socratic-research',
    campaignId,
    metadata: {
      domain,
      phase: 'pending',
      createdAt: new Date().toISOString(),
    },
  });

  log.info('Socratic task created', {
    taskId: task.id,
    projectId,
    campaignId,
    domain,
  });

  return task;
}

/**
 * Execute a Socratic task end-to-end.
 *
 * This is the main entry point for running a Socratic research task.
 * It coordinates all phases: research, assumption identification, question generation, curation, and persistence.
 *
 * @param {object} task - The Socratic task to execute
 * @param {object} deps - Dependencies container
 * @param {object} deps.campaignManager - CampaignManager instance
 * @param {object} deps.learningsManager - LearningsManager instance
 * @param {object} deps.timelineStore - TimelineStore instance
 * @param {object} deps.patternScanner - PatternScanner instance
 * @param {object} deps.taskManager - TaskManager instance
 * @param {string} deps.projectId - Project identifier
 * @param {string} deps.channelId - Channel identifier
 * @param {function} deps.addMessage - Function to add system messages to channel
 * @param {function} deps.broadcastToChannel - Function to broadcast to channel
 * @returns {Promise<object>} Execution result with questions and metadata
 */
export async function executeSocraticTask(task, deps) {
  const {
    campaignManager,
    learningsManager,
    timelineStore,
    patternScanner,
    taskManager,
    projectId,
    channelId,
    addMessage,
    broadcastToChannel,
  } = deps;

  const campaignId = task.campaignId;
  const campaign = campaignManager.getCampaign(projectId, campaignId);

  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  if (campaign.type !== 'socratic') {
    throw new Error(`Campaign is not Socratic type: ${campaign.type}`);
  }

  const domain = campaign.domain;

  log.info('Starting Socratic task execution', {
    taskId: task.id,
    campaignId,
    domain,
  });

  // Update task status to executing
  taskManager.updateTask(projectId, task.id, {
    status: 'executing',
    metadata: {
      ...task.metadata,
      phase: 'research',
      startedAt: new Date().toISOString(),
    },
  });

  // Update campaign state to researching
  campaignManager.updateCampaignStatus(
    projectId,
    campaignId,
    'researching',
    'Starting Socratic research phase'
  );

  const result = {
    taskId: task.id,
    campaignId,
    projectId,
    domain,
    phases: {
      research: { status: 'pending', questions: null },
      curation: { status: 'pending', questions: null },
      validation: { status: 'pending', valid: false },
      persistence: { status: 'pending', success: false },
    },
    errors: [],
    output: null,
  };

  try {
    // Phase 1: Execute Socratic research (generates raw questions)
    addMessage(projectId, channelId, 'System', `Starting Socratic research for domain: **${domain}**`, 'system');
    
    log.info('Phase 1: Executing Socratic research');
    result.phases.research.status = 'in_progress';

    const researchResult = await executeSocraticResearch(task, {
      campaignManager,
      learningsManager,
      timelineStore,
      patternScanner,
    });

    if (researchResult.errors.length > 0) {
      result.errors.push(...researchResult.errors);
    }

    result.phases.research.status = 'completed';
    result.phases.research.data = researchResult.output;
    result.phases.research.questions = researchResult.output?.questions || [];

    log.info('Research phase complete', {
      questionCount: result.phases.research.questions.length,
      errors: result.phases.research.errors || [],
    });

    addMessage(projectId, channelId, 'System', 
      `Research complete: generated ${result.phases.research.questions.length} raw questions`,
      'system');

    // Phase 2: Curation (deduplication, merging, quality filtering)
    addMessage(projectId, channelId, 'System', 'Starting question curation...', 'system');
    log.info('Phase 2: Applying curation');
    result.phases.curation.status = 'in_progress';

    const rawQuestions = result.phases.research.questions;
    // Apply curation to deduplicate and merge similar questions
    // Threshold 0.75 balances merging near-duplicates while preserving distinct questions
    // See socratic-curation.js DEFAULT_SIMILARITY_THRESHOLD for calibration rationale
    const curatedResult = curateQuestions(rawQuestions, {
      dedupThreshold: 0.75,
      minPriority: 3,
      requireEvidence: true,
      minOutput: 5,
      maxOutput: 15,
    });

    result.phases.curation.status = 'completed';
    result.phases.curation.data = curatedResult;
    result.phases.curation.questions = curatedResult.curatedQuestions || [];

    log.info('Curation phase complete', {
      inputCount: rawQuestions.length,
      outputCount: curatedResult.curatedQuestions?.length || 0,
      deduplicated: curatedResult.metadata?.deduplicatedCount || 0,
      merged: curatedResult.metadata?.mergedCount || 0,
    });

    addMessage(projectId, channelId, 
      `Curation complete: reduced from ${rawQuestions.length} to ${curatedResult.curatedQuestions?.length || 0} questions`,
      'system');

    // Phase 3: Validation
    addMessage(projectId, channelId, 'System', 'Validating question schema...', 'system');
    log.info('Phase 3: Validating output');
    result.phases.validation.status = 'in_progress';

    const validation = validateQuestionSchema(curatedResult.curatedQuestions || []);
    
    result.phases.validation.status = 'completed';
    result.phases.validation.valid = validation.valid;
    result.phases.validation.errors = validation.valid ? [] : [validation.error, ...(validation.details || [])];

    if (!validation.valid) {
      log.warn('Validation failed', { errors: result.phases.validation.errors });
      addMessage(projectId, channelId, 
        `Validation failed: ${validation.error}`,
        'system');
      
      result.errors.push(`Validation failed: ${validation.error}`);
      
      // Return early with partial results if validation fails
      return {
        ...result,
        success: false,
      };
    }

    addMessage(projectId, channelId, 
      `Validation passed: ${curatedResult.curatedQuestions?.length || 0} questions meet schema requirements`,
      'system');

    // Phase 4: Persistence to campaign
    addMessage(projectId, channelId, 'System', 'Persisting questions to campaign...', 'system');
    log.info('Phase 4: Persisting to campaign');
    result.phases.persistence.status = 'in_progress';

    const persistResult = campaignManager.updateSocraticQuestions(
      projectId,
      campaignId,
      curatedResult.curatedQuestions || [],
      'socratic-task-executor'
    );

    result.phases.persistence.status = 'completed';
    result.phases.persistence.success = persistResult.success;
    result.phases.persistence.campaign = persistResult.campaign;

    if (!persistResult.success) {
      result.errors.push(...(persistResult.errors || []));
      throw new Error(`Failed to persist questions: ${persistResult.errors?.join(', ')}`);
    }

    addMessage(projectId, channelId, 
      `Questions persisted successfully. Campaign updated to 'curating' state.`,
      'system');

    // Update task status to completed
    taskManager.updateTask(projectId, task.id, {
      status: 'completed',
      metadata: {
        ...task.metadata,
        phase: 'done',
        completedAt: new Date().toISOString(),
        questionCount: curatedResult.curatedQuestions?.length || 0,
      },
    });

    // Update campaign state to 'reviewed' (after curation complete)
    campaignManager.updateCampaignStatus(
      projectId,
      campaignId,
      'reviewed',
      `Socratic research completed: ${curatedResult.curatedQuestions?.length || 0} questions curated`
    );

    // Build final output
    result.output = {
      campaignId,
      domain,
      questionCount: curatedResult.curatedQuestions?.length || 0,
      questions: curatedResult.curatedQuestions || [],
      researchSummary: researchResult.output?.researchSummary || {},
      curationSummary: {
        inputCount: rawQuestions.length,
        outputCount: curatedResult.curatedQuestions?.length || 0,
        deduplicatedCount: curatedResult.metadata?.deduplicatedCount || 0,
        mergedCount: curatedResult.metadata?.mergedCount || 0,
        filteredCount: curatedResult.metadata?.filteredCount || 0,
      },
      validation: {
        valid: true,
        schemaVersion: '1.0',
      },
    };

    log.info('Socratic task execution completed successfully', {
      taskId: task.id,
      campaignId,
      questionCount: result.output.questionCount,
    });

    addMessage(projectId, channelId, 
      `✅ Socratic research complete!\n\nDomain: ${domain}\nQuestions curated: ${curatedResult.curatedQuestions?.length || 0}\nCampaign state: reviewed`,
      'system');

    return {
      ...result,
      success: true,
    };

  } catch (err) {
    log.error('Socratic task execution failed', {
      taskId: task.id,
      error: err.message,
      stack: err.stack,
    });

    result.errors.push(err.message);
    
    // Update task status to failed
    taskManager.updateTask(projectId, task.id, {
      status: 'failed',
      metadata: {
        ...task.metadata,
        phase: 'failed',
        failedAt: new Date().toISOString(),
        error: err.message,
      },
    });

    // Update campaign state if needed
    if (campaign.status === 'created' || campaign.status === 'researching') {
      campaignManager.updateCampaignStatus(
        projectId,
        campaignId,
        'failed',
        `Socratic research failed: ${err.message}`
      );
    }

    addMessage(projectId, channelId, 
      `❌ Socratic research failed: ${err.message}`,
      'system');

    return {
      ...result,
      success: false,
    };
  }
}

/**
 * Run a complete Socratic campaign from creation to completion.
 *
 * This is a convenience function that creates a campaign, executes the socratic task,
 * and returns the final result. Useful for testing and automation.
 *
 * @param {object} campaignManager - CampaignManager instance
 * @param {object} taskManager - TaskManager instance
 * @param {object} learningsManager - LearningsManager instance
 * @param {object} timelineStore - TimelineStore instance
 * @param {object} patternScanner - PatternScanner instance
 * @param {string} projectId - Project identifier
 * @param {string} channelId - Channel for task execution
 * @param {object} campaignOptions - Campaign creation options
 * @param {string} campaignOptions.domain - Domain being explored (required)
 * @param {string} campaignOptions.title - Campaign title (optional)
 * @param {string} campaignOptions.description - Campaign description (optional)
 * @param {function} addMessage - Function to add system messages
 * @param {function} broadcastToChannel - Function to broadcast to channel
 * @returns {Promise<object>} Final campaign result with questions
 */
export async function runSocraticCampaign(
  campaignManager,
  taskManager,
  learningsManager,
  timelineStore,
  patternScanner,
  projectId,
  channelId,
  campaignOptions,
  addMessage,
  broadcastToChannel
) {
  const { domain, title, description } = campaignOptions;

  if (!domain) {
    throw new Error('Socratic campaigns require a domain parameter');
  }

  log.info('Starting end-to-end Socratic campaign', {
    projectId,
    domain,
    title: title || 'Untitled',
  });

  // Step 1: Create Socratic campaign
  const campaign = campaignManager.createCampaign(projectId, {
    title: title || `Socratic analysis: ${domain}`,
    description: description || `Automated Socratic research on ${domain}`,
    type: 'socratic',
    domain,
    doneCriteria: 'Generate 5-15 high-quality Socratic questions with evidence citations',
    contingency: 'If quality is low, iterate on prompts and re-run',
  });

  log.info('Socratic campaign created', {
    campaignId: campaign.id,
    projectId,
    domain,
  });

  addMessage(projectId, channelId, 
    `🎯 Created Socratic campaign: **${campaign.title}**\nDomain: ${domain}`,
    'system');

  // Step 2: Create Socratic task
  const task = createSocraticTask(
    taskManager,
    projectId,
    channelId,
    campaign.id,
    { domain }
  );

  log.info('Socratic task created', {
    taskId: task.id,
    campaignId: campaign.id,
  });

  // Step 3: Execute task
  const result = await executeSocraticTask(task, {
    campaignManager,
    learningsManager,
    timelineStore,
    patternScanner,
    taskManager,
    projectId,
    channelId,
    addMessage,
    broadcastToChannel,
  });

 return {
    success: result.success,
    campaign: campaign,
    task: task,
    result: result,
    questions: result.output?.questions || [],
    questionCount: result.output?.questionCount || 0,
  };
}

/**
 * Validate a single Socratic question object.
 *
 * @param {Object} question - Question to validate
 * @returns {Object} { valid: boolean, errors?: string[] }
 */
export function validateSocraticQuestion(question) {
  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    return { valid: false, errors: ['Question must be an object'] };
  }

  const requiredFields = ['question', 'assumptionChallenged', 'impactIfWrong', 'priority', 'domain'];
  const errors = [];

  for (const field of requiredFields) {
    if (!(field in question)) {
      errors.push(`missing required field "${field}"`);
    }
  }

  // Validate string fields
  const stringFields = ['question', 'assumptionChallenged', 'impactIfWrong', 'domain'];
  for (const field of stringFields) {
    if (field in question) {
      if (typeof question[field] !== 'string') {
        errors.push(`field "${field}" must be a string`);
      } else if (!question[field].trim()) {
        errors.push(`field "${field}" cannot be empty`);
      }
    }
  }

  // Validate priority
  if ('priority' in question) {
    if (typeof question.priority !== 'number') {
      errors.push('field "priority" must be a number');
    } else if (!Number.isInteger(question.priority)) {
      errors.push('field "priority" must be an integer');
    } else if (question.priority < 1 || question.priority > 10) {
      errors.push(`field "priority" must be between 1 and 10 (got ${question.priority})`);
    }
  }

  // Validate evidenceFor if present
  if ('evidenceFor' in question) {
    if (!Array.isArray(question.evidenceFor)) {
      errors.push('field "evidenceFor" must be an array');
    } else {
      question.evidenceFor.forEach((item, i) => {
        if (typeof item !== 'string') {
          errors.push(`evidenceFor[${i}] must be a string`);
        }
      });
    }
  }

  // Validate evidenceAgainst if present
  if ('evidenceAgainst' in question) {
    if (!Array.isArray(question.evidenceAgainst)) {
      errors.push('field "evidenceAgainst" must be an array');
    } else {
      question.evidenceAgainst.forEach((item, i) => {
        if (typeof item !== 'string') {
          errors.push(`evidenceAgainst[${i}] must be a string`);
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export default {
  createSocraticTask,
  executeSocraticTask,
  runSocraticCampaign,
};
