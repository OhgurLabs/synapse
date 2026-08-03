// Campaign system — autonomous goal-driven execution with milestones, progress tracking,
// and contingency plans. CAS-protected JSON + append-only JSONL events.
// Direct delegation model: architect decomposes, agents execute. No roundtable.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';
import { detectConstraintConflict } from './constraint-conflict.js';
import { startSpan, endSpan, addSpanEvent } from './tracing.js';
import { validateQuestionSchema as validateSocraticQuestions } from './orchestrator/socratic-validation.js';
import { createCampaignBranch, campaignBranchName, checkoutBranch as gitCheckout } from './orchestrator/git-branches.js';
import { getDb, rowToCampaign, rowToMilestone, persistCampaigns } from './orchestrator/state-db.js';

const log = createLogger('campaigns');

// Active campaign spans — kept in memory for adding events and ending on completion/failure
// If the server restarts, these are lost, but the persisted spanContext allows child spans to link back
const activeCampaignSpans = new Map(); // campaignId -> span object
const activeMilestoneSpans = new Map(); // milestoneId -> span object

const MAX_CAS_RETRIES = 3;
const SCHEMA_VERSION = '1';

const CAMPAIGN_STATUSES = ['active', 'paused', 'awaiting_approval', 'completed', 'failed', 'needs_review', 'cycling'];
const MILESTONE_STATUSES = ['pending', 'active', 'completed', 'failed', 'skipped', 'waiting_approval'];

const CAMPAIGN_TYPES = ['standard', 'evergreen', 'socratic', 'verbatim'];
const CAMPAIGN_OUTPUT_MODES = ['implementation', 'research'];

const CAMPAIGN_TRANSITIONS = {
  queued:            ['active', 'failed'],
  active:            ['paused', 'completed', 'failed', 'needs_review', 'cycling', 'awaiting_approval'],
  paused:            ['active', 'failed', 'needs_review', 'awaiting_approval'],
  awaiting_approval: ['active', 'paused', 'failed', 'completed'],
  completed:         [],
  failed:            ['active'],  // manual retry
  needs_review:      ['active', 'failed'],
  cycling:           ['active', 'paused', 'failed', 'needs_review'],
};

const CAMPAIGN_PRIORITIES = ['critical', 'high', 'elevated', 'normal'];
const PRIORITY_ORDER = { critical: 0, high: 1, elevated: 2, normal: 3 };

const MILESTONE_TRANSITIONS = {
  pending:         ['active', 'skipped', 'waiting_approval'],
  active:          ['completed', 'failed', 'skipped', 'pending', 'waiting_approval'],
  completed:       [],
  failed:          ['active', 'pending'],  // retry
  skipped:         ['pending'],             // un-skip
  waiting_approval: ['active', 'pending'],  // approved or cancelled
};

const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'timeout'];

/**
 * Validate approval state value
 * @param {string} state - Approval state to validate
 * @returns {boolean} True if valid
 */
export function isValidApprovalState(state) {
  return APPROVAL_STATES.includes(state);
}

/**
 * Socratic campaign lifecycle states
 * @typedef {Object} SOCRATIC_STATES
 * @property {string[]} states - Valid lifecycle states
 * @property {Object} transitions - Allowed state transitions
 */
const SOCRATIC_STATES = {
  states: ['created', 'researching', 'curating', 'reviewed', 'done'],
  transitions: {
    created:   ['researching'],
    researching: ['curating', 'created'],
    curating:  ['reviewed', 'researching'],
    reviewed:  ['done', 'curating'],
    done:      [],
  },
};

/**
 * Socratic question output schema (7 required fields)
 * @typedef {Object} SocraticQuestion
 * @property {string} question - The Socratic question itself
 * @property {string} assumptionChallenged - What assumption this question challenges
 * @property {string[]} evidenceFor - Supporting evidence for the premise
 * @property {string[]} evidenceAgainst - Contradictory evidence or counterarguments
 * @property {number} impactIfWrong - Impact score if the underlying assumption is wrong (1-10)
 * @property {number} priority - Question priority: 1 (critical), 2 (high), 3 (normal)
 * @property {string} domain - Domain/category of the question
 */

/**
 * Socratic campaign with curated questions
 * @typedef {Object} SocraticCampaign
 * @property {string} id - Campaign unique identifier
 * @property {string} title - Campaign title
 * @property {string} description - Campaign description
 * @property {string} domain - Domain being explored
 * @property {string[]} references - Optional campaign references to build upon
 * @property {string} status - Socratic lifecycle state (created/researching/curating/reviewed/done)
 * @property {SocraticQuestion[]} questions - Curated question set (5-15 questions)
 * @property {number} questionCount - Count of curated questions (mirrors questions.length)
 * @property {string} researchNotes - Research findings and insights
 * @property {string} createdAt - Creation timestamp
 * @property {string} updatedAt - Last update timestamp
 * @property {string} completedAt - Completion timestamp
 */

/**
 * Validate a single Socratic question object.
 * Returns { valid: true } or { valid: false, error: string, details: array }.
 *
 * Required fields per docs/schema/socratic-campaign-schema.md:
 * - question (string, non-empty)
 * - assumptionChallenged (string, non-empty)
 * - impactIfWrong (string, non-empty)
 * - priority (number, 1-10)
 * - domain (string, non-empty)
 *
 * Optional fields:
 * - evidenceFor (array of strings)
 * - evidenceAgainst (array of strings)
 *
 * @param {Object} question - Single question object to validate
 * @returns {Object} { valid: boolean, error?: string, details?: Array }
 */
export function validateSocraticQuestion(question) {
  const errors = [];

  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    return {
      valid: false,
      error: 'Question must be an object',
      details: []
    };
  }

  const requiredFields = ['question', 'assumptionChallenged', 'impactIfWrong', 'priority', 'domain'];

  for (const field of requiredFields) {
    if (!(field in question)) {
      errors.push(`missing required field "${field}"`);
      continue;
    }

    if (field !== 'priority') {
      if (typeof question[field] !== 'string') {
        errors.push(`field "${field}" must be a string`);
      } else if (!question[field].trim()) {
        errors.push(`field "${field}" cannot be empty`);
      }
    }
  }

  if ('priority' in question) {
    if (typeof question.priority !== 'number') {
      errors.push('field "priority" must be a number');
    } else if (!Number.isInteger(question.priority)) {
      errors.push('field "priority" must be an integer');
    } else if (question.priority < 1 || question.priority > 10) {
      errors.push(`field "priority" must be between 1 and 10 (got ${question.priority})`);
    }
  }

  if ('evidenceFor' in question && question.evidenceFor !== null && question.evidenceFor !== undefined) {
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

  if ('evidenceAgainst' in question && question.evidenceAgainst !== null && question.evidenceAgainst !== undefined) {
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

  if (errors.length > 0) {
    return {
      valid: false,
      error: `Question validation failed with ${errors.length} error(s)`,
      details: errors
    };
  }

  return { valid: true };
}

/**
 * Validate a single Socratic question object.
 * Returns { valid: boolean, errors: string[] }.
 *
 * Required fields (all 7):
 * - question (string, non-empty)
 * - assumptionChallenged (string, non-empty)
 * - evidenceFor (array of strings)
 * - evidenceAgainst (array of strings)
 * - impactIfWrong (string, non-empty)
 * - priority (number, 1-10)
 * - domain (string, non-empty)
 *
 * @param {Object} question - Single question object to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateQuestion(question) {
  const errors = [];

  if (!question || typeof question !== 'object' || Array.isArray(question)) {
    return {
      valid: false,
      errors: ['Question must be an object']
    };
  }

  const requiredFields = [
    'question',
    'assumptionChallenged',
    'evidenceFor',
    'evidenceAgainst',
    'impactIfWrong',
    'priority',
    'domain'
  ];

  for (const field of requiredFields) {
    if (!(field in question)) {
      errors.push(`missing required field "${field}"`);
    }
  }

  if (!errors.length) {
    if (typeof question.question !== 'string' || !question.question.trim()) {
      errors.push('field "question" must be a non-empty string');
    }

    if (typeof question.assumptionChallenged !== 'string' || !question.assumptionChallenged.trim()) {
      errors.push('field "assumptionChallenged" must be a non-empty string');
    }

    if (typeof question.impactIfWrong !== 'string' || !question.impactIfWrong.trim()) {
      errors.push('field "impactIfWrong" must be a non-empty string');
    }

    if (typeof question.domain !== 'string' || !question.domain.trim()) {
      errors.push('field "domain" must be a non-empty string');
    }

    if ('priority' in question) {
      if (typeof question.priority !== 'number') {
        errors.push('field "priority" must be a number');
      } else if (!Number.isInteger(question.priority)) {
        errors.push('field "priority" must be an integer');
      } else if (question.priority < 1 || question.priority > 10) {
        errors.push(`field "priority" must be between 1 and 10 (got ${question.priority})`);
      }
    }

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
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate question count against 5-15 constraint (soft warning).
 * This is a soft constraint - returns warnings but doesn't fail validation.
 * Used during state transitions to alert operators about count issues.
 *
 * @param {number} count - Number of questions to validate
 * @returns {Object} { valid: boolean, warnings: string[] }
 */
// Re-export validation from socratic-validation for backward compatibility
export { validateSocraticQuestions as validateQuestionSchema } from './orchestrator/socratic-validation.js';
export function validateQuestionCount(count) {
  const warnings = [];

  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    return {
      valid: false,
      warnings: ['Question count must be a non-negative integer']
    };
  }

  if (count < 5) {
    warnings.push(`Question count is ${count}, minimum 5 required`);
  }

  if (count > 15) {
    warnings.push(`Question count is ${count}, maximum 15 recommended`);
  }

  // Return valid: true even with warnings (soft constraint)
  return {
    valid: true,
    warnings
  };
}

/**
 * Validate project IDs for multi-project campaigns.
 * Returns { valid: true } or { valid: false, error: string, details: [] }.
 *
 * Checks:
 * - projectIds is a non-empty array
 * - All project IDs exist in the state manager
 *
 * @param {Object} stateManager - StateManager instance
 * @param {Array<string>} projectIds - Array of project identifiers to validate
 * @returns {Object} { valid: boolean, error?: string, details?: Array }
 */
export function validateProjectIds(stateManager, projectIds) {
  const errors = [];

  // Check if projectIds is an array
  if (!Array.isArray(projectIds)) {
    return {
      valid: false,
      error: 'projectIds must be an array',
      details: ['projectIds is not an array']
    };
  }

  // Check if array is empty
  if (projectIds.length === 0) {
    return {
      valid: false,
      error: 'projectIds cannot be empty',
      details: ['projectIds array has zero elements']
    };
  }

  // Check each projectId exists
  for (const projectId of projectIds) {
    if (typeof projectId !== 'string') {
      errors.push(`projectId must be a string, got ${typeof projectId}`);
      continue;
    }

    if (!projectId.trim()) {
      errors.push('projectId cannot be empty string');
      continue;
    }

    const project = stateManager.getProject(projectId);
    if (!project) {
      errors.push(`project not found: ${projectId}`);
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      error: `projectIds validation failed with ${errors.length} error(s)`,
      details: errors
    };
  }

  return { valid: true };
}

/**
 * Validate Socratic question schema and enforce 5-15 question constraint.
 * Returns { valid: true } or { valid: false, error: string, details: array }.
 *
 * Required fields per docs/schema/socratic-campaign-schema.md:
 * - question (string, non-empty)
 * - assumptionChallenged (string, non-empty)
 * - impactIfWrong (string, non-empty)
 * - priority (number, 1-10)
 * - domain (string, non-empty)
 *
 * Optional fields:
 * - evidenceFor (array of strings)
 * - evidenceAgainst (array of strings)
 *
 * @param {Array} questions - Array of question objects to validate
 * @returns {Object} { valid: boolean, error?: string, details?: Array }

/**
 * Wrapper for Socratic campaign state transitions.
 * Validates the campaign exists and is a Socratic campaign, then delegates to CampaignManager.updateSocraticState().
 * Exported for use from API layer.
 *
 * @param {CampaignManager} manager - CampaignManager instance
 * @param {string} projectId - Project identifier
 * @param {string} campaignId - Campaign identifier
 * @param {string} newState - Target Socratic lifecycle state
 * @param {string} reason - Reason for state transition
 * @param {string|null} userId - Optional user ID for ownership validation
 * @returns {Object} Updated campaign object
 * @throws {Error} If campaign not found, not a Socratic campaign, or invalid transition
 */
export function transitionSocraticCampaign(manager, projectId, campaignId, newState, reason, userId = null) {
  return manager.transitionSocraticCampaign(projectId, campaignId, newState, reason, userId);
}

/**
 * Parse /campaign commands from user input.
 * Returns { command, args } or null.
 */
export function parseCampaignCommand(text) {
  const trimmed = text.trim();

  if (trimmed === '/campaign' || trimmed === '/campaign list') {
    return { command: 'list', args: null };
  }

  // Support standalone /approve command (in addition to /campaign approve)
  if (trimmed === '/approve' || trimmed.startsWith('/approve ')) {
    const approveMatch = trimmed.match(/^\/approve\s+(\S+)(?:\s+--project\s+(\S+))?$/);
    if (!approveMatch) return null;
    return {
      command: 'approve',
      args: {
        milestoneId: approveMatch[1],
        projectId: approveMatch[2] || null,
      },
    };
  }

  const match = trimmed.match(/^\/campaign\s+([\w-]+)(?:\s+(.+))?$/s);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || null;
  const valid = ['create', 'list', 'show', 'inject', 'pause', 'resume', 'milestone', 'status', 'decompose', 'replay', 'approve'];
  if (!valid.includes(command)) return null;

  if (command === 'approve') {
    const approveMatch = args?.match(/^(\S+)(?:\s+--project\s+(\S+))?$/);
    if (!approveMatch) return null;
    return {
      command: 'approve',
      args: {
        milestoneId: approveMatch[1],
        projectId: approveMatch[2] || null,
      },
    };
  }

  return { command, args };
}

export class CampaignManager {
  constructor(stateManager, errorPatternConstraintStore = null, checkpointManager = null) {
    this.stateManager = stateManager;
    this.errorPatternConstraintStore = errorPatternConstraintStore;
    this.checkpointManager = checkpointManager;
    this._onEvent = null;
    this._afterSave = null;
    this._config = null;
  }

  setConfig(config) { this._config = config; }
  setOnEvent(fn) { this._onEvent = fn; }
  setAfterSave(fn) { this._afterSave = fn; }
  setCheckpointManager(checkpointManager) { this.checkpointManager = checkpointManager; }

  _campaignsPath(projectId) {
    return join(this.stateManager.projectsDir, projectId, 'campaigns.json');
  }

  _eventsPath(projectId) {
    return join(this.stateManager.projectsDir, projectId, 'campaign-events.jsonl');
  }

  _campaignsMdPath(projectId) {
    const proj = this.stateManager.getProject(projectId);
    const projectDir = proj?.projectDir || join(this.stateManager.projectsDir, projectId);
    return join(projectDir, 'CAMPAIGNS.md');
  }

  // --- Persistence (CAS-protected, mirrors tasks.js) ---

  load(projectId) {
    try {
      const projectDir = join(this.stateManager.projectsDir, projectId);
      const db = getDb(projectDir);
      const campaignRows = db.prepare('SELECT * FROM campaigns WHERE project_id = ?').all(projectId);
      if (campaignRows.length === 0) {
        return { schemaVersion: SCHEMA_VERSION, version: 0, campaigns: [] };
      }
      const campaigns = campaignRows.map(row => {
        const campaign = rowToCampaign(row);
        const milestoneRows = db.prepare('SELECT * FROM milestones WHERE campaign_id = ?').all(campaign.id);
        campaign.milestones = milestoneRows.map(rowToMilestone);
        return campaign;
      });
      return { schemaVersion: SCHEMA_VERSION, version: 0, campaigns };
    } catch (err) {
      // Fail LOUD (mirrors tasks.js): _loadFailed poisons the snapshot so a
      // save cycle can't wipe campaigns via destructive delete-then-insert.
      log.error('Campaign load failed — returning empty read-only snapshot', { projectId, error: err.message });
      return { schemaVersion: SCHEMA_VERSION, version: 0, campaigns: [], _loadFailed: true };
    }
  }

  _saveWithRetry(projectId, mutator) {
    for (let i = 0; i < MAX_CAS_RETRIES; i++) {
      const data = this.load(projectId);
      if (data._loadFailed) {
        throw new Error(`Refusing to persist ${projectId}: campaign state failed to load (saving would wipe existing data)`);
      }
      const modified = mutator(data);
      try {
        const projectDir = join(this.stateManager.projectsDir, projectId);
        const db = getDb(projectDir);
        persistCampaigns(db, projectId, modified.campaigns);
        if (this._afterSave) this._afterSave(projectId);
        return modified;
      } catch (err) {
        if (i === MAX_CAS_RETRIES - 1) throw err;
      }
    }
  }

  /** Check if user has access to an entity (owner or sharedWith). No-op for system calls. */
  _assertOwnership(entity, userId) {
    if (!userId) return; // System-level calls bypass ownership check
    if (entity.owner === userId || entity.owner === 'system' || entity.owner == null) return;
    if (entity.sharedWith && entity.sharedWith.includes(userId)) return;
    const err = new Error(`Forbidden: user '${userId}' cannot access ${entity.id} (owner: '${entity.owner}')`);
    err.code = 'OWNERSHIP_DENIED';
    err.owner = entity.owner;
    err.userId = userId;
    throw err;
  }

  /**
   * CAS retry with ownership re-verification on every reload.
   * On each retry iteration, entityFinder locates the entity in the freshly loaded data
   * and _assertOwnership verifies the user still has access before the mutator runs.
   * This prevents user A's retry from succeeding on data that user B now owns.
   */
  _saveWithRetryScoped(projectId, userId, entityFinder, mutator) {
    return this._saveWithRetry(projectId, (data) => {
      if (userId) {
        const entity = entityFinder(data);
        if (!entity) throw new Error('Entity not found after CAS reload');
        this._assertOwnership(entity, userId);
      }
      return mutator(data);
    });
  }

  _appendEvent(projectId, event) {
    const path = this._eventsPath(projectId);
    const entry = {
      schemaVersion: SCHEMA_VERSION,
      eventId: `evt_${Date.now()}_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      project: projectId,
      ...event,
    };
    appendFileSync(path, JSON.stringify(entry) + '\n');
  }

  // --- Campaign CRUD ---

  createCampaign(projectId, { title, description, doneCriteria, contingency, priority = 'normal', owner = 'system', sharedWith = [],
    type = 'standard', outputMode = 'implementation', domain = null, campaignReferences = null, projectIds = null }) {
    const campaignId = `campaign_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Default projectIds to [projectId] for backward compatibility
    if (!projectIds || !Array.isArray(projectIds) || projectIds.length === 0) {
      projectIds = [projectId];
    }

    // Ensure primary projectId is always included in the list
    if (!projectIds.includes(projectId)) {
      projectIds = [projectId, ...projectIds];
    }

    // Validate that all projectIds exist
    const validation = validateProjectIds(this.stateManager, projectIds);
    if (!validation.valid) {
      throw new Error(`Project validation failed: ${validation.error} - ${validation.details?.join('; ') || ''}`);
    }

    // Normalize LLM-generated priorities to valid values
    const PRIORITY_ALIASES = { revenue: 'high', medium: 'elevated', low: 'normal' };
    if (!CAMPAIGN_PRIORITIES.includes(priority)) {
      priority = PRIORITY_ALIASES[priority] || 'normal';
    }

    // Validate type and outputMode
    if (!CAMPAIGN_TYPES.includes(type)) type = 'standard';
    if (!CAMPAIGN_OUTPUT_MODES.includes(outputMode)) outputMode = 'implementation';

    // Socratic campaigns require a domain
    if (type === 'socratic' && !domain) {
      throw new Error('Socratic campaigns require a domain field');
    }

    // Check if we should queue this campaign (respect maxActiveCampaigns)
    const activeCampaigns = this.listCampaigns(projectId, 'active');
    const maxActive = this._config?.campaigns?.maxActiveCampaigns ?? Infinity;
    const shouldQueue = activeCampaigns.length >= maxActive;

    // For socratic campaigns, set initial status to 'created' lifecycle state
    let campaignStatus = shouldQueue ? 'queued' : 'active';
    if (type === 'socratic') {
      campaignStatus = 'created';
    }

    const campaign = {
      id: campaignId,
      projectIds,
      title,
      description: description || title,
      doneCriteria: doneCriteria || null,
      owner: owner || 'system',
      sharedWith: sharedWith || [],
      contingency: contingency || null,
      priority,
      type,
      outputMode,
      domain: domain || null,
      references: campaignReferences || [],
      cycleCount: 0,
      cycleHistory: [],
      status: campaignStatus,
      milestones: [],
      constraints: [],
      lastReviewAt: null,
      lastReviewSummary: null,
      nextAction: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      traceContext: null,  // OTel span context for parent-child linkage
      // Socratic question fields (initialized for socratic campaigns, null otherwise)
      questions: type === 'socratic' ? [] : null,
      questionCount: type === 'socratic' ? 0 : null,
      // Socratic-specific fields (null for non-socratic campaigns)
      socraticConfig: type === 'socratic' ? {
        domain: domain,
        campaignReferences: campaignReferences || [],
        questions: [],
        questionCount: 0,
      } : null,
      branch: null,
    };

    // Start OTel root span for campaign lifecycle
    const span = startSpan('campaign.lifecycle', {
      campaignId,
      title,
      goalSummary: doneCriteria || description,
      priority,
      status: campaign.status,
    });

    // Store spanContext for child spans (milestone, task, subtask) to reference
    campaign.traceContext = span.spanContext();

    // Keep span in memory for adding events and ending on completion/failure
    activeCampaignSpans.set(campaignId, span);

    // Create campaign branch (Phase 1: project lifecycle branching)
    if (campaignStatus === 'active') {
      const projectDir = this.stateManager?.getProject(projectId)?.projectDir;
      const repoConfig = this.stateManager?.getProjectRepoConfig?.(projectId);
      if (projectDir) {
        const branchName = createCampaignBranch(projectDir, campaignId, repoConfig);
        if (branchName) {
          campaign.branch = branchName;
          log.info('Campaign branch created', { campaignId, branch: branchName });
        } else if (repoConfig?.mode === 'none') {
          log.info('Campaign branch creation skipped (repoConfig.mode=none)', { campaignId });
        } else {
          log.error('Failed to create campaign branch — campaign execution will be blocked instead of using current branch', { campaignId });
        }
      } else {
        log.warn('No project directory found — skipping branch creation', { projectId, campaignId });
      }
    }

    // Write campaign to ALL participating projects (multi-project support)
    for (const targetProjectId of projectIds) {
      this._saveWithRetry(targetProjectId, (d) => {
        d.campaigns.push(campaign);
        return d;
      });

      this._appendEvent(targetProjectId, {
        action: 'campaign_created',
        campaignId,
        agent: 'system',
        reason: `Campaign created: ${title}`,
      });

      this._renderCampaignMd(targetProjectId);
    }

    // Emit event for primary project only (to avoid duplicate event handling)
    if (this._onEvent) this._onEvent('campaign:created', { projectId, campaignId: campaign.id, title });

    return campaign;
  }

  getCampaign(projectId, campaignId) {
    const data = this.load(projectId);
    return data.campaigns.find(c => c.id === campaignId) || null;
  }

  patchCampaign(projectId, campaignId, fields) {
    const projectIds = this._allProjectIds(projectId, campaignId);
    const now = new Date().toISOString();
    for (const targetProjectId of projectIds) {
      this._saveWithRetry(targetProjectId, (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        if (!campaign) return d;
        Object.assign(campaign, fields, { updatedAt: now });
        return d;
      });
    }
  }

  setMilestonePriority(projectId, campaignId, milestoneId, priority) {
    if (!CAMPAIGN_PRIORITIES.includes(priority) && priority !== null) {
      throw new Error(`Invalid priority "${priority}". Must be one of: ${CAMPAIGN_PRIORITIES.join(', ')}, or null.`);
    }
    const projectIds = this._allProjectIds(projectId, campaignId);
    const now = new Date().toISOString();
    for (const targetProjectId of projectIds) {
      this._saveWithRetry(targetProjectId, (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        if (!campaign) return d;
        const milestone = campaign.milestones?.find(m => m.id === milestoneId);
        if (!milestone) return d;
        milestone.priority = priority;
        campaign.updatedAt = now;
        return d;
      });
    }
  }

  _allProjectIds(projectId, campaignId) {
    const data = this.load(projectId);
    const campaign = data.campaigns.find(c => c.id === campaignId);
    return campaign?.projectIds || [projectId];
  }

  listCampaigns(projectId, statusFilter = null, userId = null) {
    const data = this.load(projectId);
    let campaigns = data.campaigns;

    if (userId) {
      campaigns = campaigns.filter(c => 
        c.owner === userId || 
        c.owner === 'system' || 
        (c.sharedWith && c.sharedWith.includes(userId))
      );
    }

    if (statusFilter) {
      campaigns = campaigns.filter(c => c.status === statusFilter);
    }
    return campaigns;
  }

  deleteCampaign(projectId, campaignId) {
    const data = this.load(projectId);
    const campaign = data.campaigns.find(c => c.id === campaignId);
    if (!campaign) return false;
    if (campaign.status === 'active') {
      throw new Error('Cannot delete an active campaign. Pause or fail it first.');
    }

    // Get all projectIds for this campaign (multi-project support)
    const projectIds = campaign.projectIds || [projectId];

    // Delete from ALL participating projects
    for (const targetProjectId of projectIds) {
      this._saveWithRetry(targetProjectId, (d) => {
        d.campaigns = d.campaigns.filter(c => c.id !== campaignId);
        return d;
      });
      this._appendEvent(targetProjectId, {
        action: 'campaign_deleted',
        campaignId,
        agent: 'system',
        reason: `Campaign deleted: ${campaign.title}`,
      });
      this._renderCampaignMd(targetProjectId);
    }

    return true;
  }

  /**
   * Update campaign status (and cascade-cancel non-terminal child tasks on `failed`
   * when a taskManager is supplied).
   *
   * @param {string} projectId
   * @param {string} campaignId
   * @param {string} newStatus
   * @param {string} reason
   * @param {string|null} userId
   * @param {object|null} taskManager - optional; when present AND newStatus === 'failed',
   *        the campaign's queued + planning child tasks are cancelled too. Tasks in
   *        `executing` are left to finish naturally (their output is preserved).
   *        Signature kept backward-compatible — existing callers that don't pass
   *        taskManager retain pre-cascade behavior.
   */
  updateCampaignStatus(projectId, campaignId, newStatus, reason, userId = null, taskManager = null) {
    let milestoneEvents = [];
    let previousStatus = null;
    let updatedCampaign = null;

    // Load campaign from primary project to get projectIds and validate
    const primaryData = this.load(projectId);
    const primaryCampaign = primaryData.campaigns.find(c => c.id === campaignId);
    if (!primaryCampaign) throw new Error(`Campaign not found: ${campaignId}`);

    // Get all projectIds for this campaign (multi-project support)
    const projectIds = primaryCampaign.projectIds || [projectId];

    // Validate transition using the primary campaign
    previousStatus = primaryCampaign.status;
    const transitionMap = primaryCampaign.type === 'socratic' ? SOCRATIC_STATES.transitions : CAMPAIGN_TRANSITIONS;
    const allowed = transitionMap[previousStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid campaign transition: ${previousStatus} → ${newStatus}`);
    }

    // Validate Socratic question schema before allowing transition to reviewed/done
    if (primaryCampaign.type === 'socratic' && (newStatus === 'reviewed' || newStatus === 'done')) {
      const questions = primaryCampaign.questions || [];
      const validation = validateSocraticQuestions(questions);
      if (!validation.valid) {
        throw new Error(`Cannot transition Socratic campaign to '${newStatus}': ${validation.error}${validation.details && validation.details.length > 0 ? '. Details: ' + validation.details.join('; ') : ''}`);
      }

      // Soft warning for question count outside 5-15 range
      const countValidation = validateQuestionCount(primaryCampaign.questionCount || 0);
      if (countValidation.warnings && countValidation.warnings.length > 0) {
        log.warn(`Socratic campaign ${campaignId} transitioning to '${newStatus}' with question count ${primaryCampaign.questionCount}: ${countValidation.warnings.join('; ')}`);
      }
    }

    // Handle milestone state transitions when pausing/resuming
    milestoneEvents = [];
    if (newStatus === 'paused') {
      // Find all active milestones and mark them for transition to pending
      primaryCampaign.milestones.forEach(m => {
        if (m.status === 'active') {
          milestoneEvents.push({
            action: 'milestone_status_changed',
            campaignId,
            milestoneId: m.id,
            previousStatus: 'active',
            newStatus: 'pending',
            reason: 'Campaign paused',
          });
        }
      });
      // Log zombie state for active milestones if any exist
      const activeMilestones = primaryCampaign.milestones.filter(m => m.status === 'active');
      if (activeMilestones.length > 0) {
        console.warn(`[ZOMBIE STATE DETECTED] Campaign ${primaryCampaign.id} has ${activeMilestones.length} active milestone(s) while being paused.`);
      }
    } else if (newStatus === 'active') {
      const pending = primaryCampaign.milestones
        .filter(m => m.status === 'pending')
        .sort((a, b) => (a.order - b.order) || (new Date(a.createdAt) - new Date(b.createdAt)));
      if (pending.length > 0) {
        milestoneEvents.push({
          action: 'milestone_status_changed',
          campaignId,
          milestoneId: pending[0].id,
          previousStatus: 'pending',
          newStatus: 'active',
          reason: 'Campaign resumed'
        });
      }
    }

    // Update ALL participating projects
    const now = new Date().toISOString();
    for (const targetProjectId of projectIds) {
      this._saveWithRetryScoped(targetProjectId, userId,
        (d) => d.campaigns.find(c => c.id === campaignId),
        (d) => {
          const campaign = d.campaigns.find(c => c.id === campaignId);
          if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

          // Handle milestone state transitions
          if (newStatus === 'paused') {
            for (const milestone of campaign.milestones) {
              if (milestone.status === 'active') {
                milestone.status = 'pending';
                milestone.updatedAt = now;
              }
            }
          } else if (newStatus === 'active') {
            const pending = campaign.milestones
              .filter(m => m.status === 'pending')
              .sort((a, b) => (a.order - b.order) || (new Date(a.createdAt) - new Date(b.createdAt)));
            if (pending.length > 0) {
              pending[0].status = 'active';
              pending[0].updatedAt = now;
            }
            // Create campaign branch if not yet created (e.g. queued→active transition)
            if (!campaign.branch) {
              const pDir = this.stateManager?.getProject(projectId)?.projectDir;
              const pRepoCfg = this.stateManager?.getProjectRepoConfig?.(projectId);
              if (pDir) {
                const branchName = createCampaignBranch(pDir, campaignId, pRepoCfg);
                if (branchName) {
                  campaign.branch = branchName;
                  log.info('Campaign branch created on activation', { campaignId, branch: branchName });
                } else if (pRepoCfg?.mode !== 'none') {
                  log.error('Failed to create campaign branch on activation — execution will be blocked', { campaignId });
                }
              }
            }
          } else if (newStatus === 'completed') {
            // Terminalize remaining non-terminal milestones so none lingers
            // (e.g. waiting_approval/pending) under a completed campaign.
            for (const milestone of campaign.milestones) {
              if (!['completed', 'failed', 'skipped'].includes(milestone.status)) {
                milestone.status = 'completed';
                milestone.completedAt = now;
                milestone.updatedAt = now;
              }
            }
          }

          campaign.status = newStatus;
          campaign.updatedAt = now;
          if (newStatus === 'completed' || newStatus === 'failed') {
            campaign.completedAt = now;
          }
          if (targetProjectId === projectId) {
            updatedCampaign = campaign;
          }
          return d;
        });
    }

    // Cascade-cancel non-terminal child tasks when an operator (or rollback) closes
    // a campaign as failed. Without this, queued tasks under the closed campaign
    // would keep being picked up by agents — wasted cycles on operator-orphaned work.
    // Scope: status === 'failed' only; queued+planning only (executing left to finish
    // so agent effort already underway can land its output). Caller opts in by
    // passing a taskManager.
    if (newStatus === 'failed' && taskManager && typeof taskManager.listTasks === 'function') {
      const CANCELLABLE_CHILD_STATUSES = new Set(['queued', 'planning']);
      let cascaded = 0;
      let inflightSkipped = 0;
      for (const targetProjectId of projectIds) {
        let projectTasks;
        try {
          projectTasks = taskManager.listTasks(targetProjectId);
        } catch (err) {
          log.warn('Cascade-cancel: listTasks failed', {
            campaignId, projectId: targetProjectId, error: err.message,
          });
          continue;
        }
        const children = projectTasks.filter(t => t.campaignId === campaignId);
        for (const child of children) {
          if (child.status === 'executing') {
            inflightSkipped += 1;
            continue;
          }
          if (!CANCELLABLE_CHILD_STATUSES.has(child.status)) continue;
          try {
            taskManager.updateTaskStatus(
              targetProjectId,
              child.id,
              'cancelled',
              'system',
              `Parent campaign cancelled: ${reason || 'Campaign failed'}`,
            );
            cascaded += 1;
          } catch (err) {
            log.warn('Cascade-cancel: updateTaskStatus failed', {
              campaignId, projectId: targetProjectId, taskId: child.id, error: err.message,
            });
          }
        }
      }
      if (cascaded > 0 || inflightSkipped > 0) {
        log.info('Cascade-cancelled child tasks of failed campaign', {
          campaignId, cascaded, inflightSkipped, reason: reason || null,
        });
      }
    }

    // OTel: add span event for status transition and end span on completion/failure
    const span = activeCampaignSpans.get(campaignId);
    if (span) {
      addSpanEvent(span, 'campaign_status_change', {
        from: previousStatus,
        to: newStatus,
        reason: reason || `Status: ${newStatus}`,
      });

      if (newStatus === 'completed' || newStatus === 'failed') {
        endSpan(span, { success: newStatus === 'completed' });
        activeCampaignSpans.delete(campaignId);
      }
    }

    // On completion/failure, switch back to main from campaign branch
    if ((newStatus === 'completed' || newStatus === 'failed') && updatedCampaign?.branch) {
      const projectDir = this.stateManager?.getProject(projectId)?.projectDir;
      if (projectDir) {
        try {
          gitCheckout(projectDir, 'main');
          log.info('Switched back to main after campaign completion', {
            campaignId, fromBranch: updatedCampaign.branch, status: newStatus,
          });
        } catch (err) {
          log.warn('Failed to switch back to main', { campaignId, error: err.message });
        }
      }
    }

    // Append events to ALL participating projects
    for (const targetProjectId of projectIds) {
      this._appendEvent(targetProjectId, {
        action: 'campaign_status_changed',
        campaignId,
        agent: 'system',
        reason: reason || `Status: ${newStatus}`,
      });

      // Emit events for milestone status changes
      for (const event of milestoneEvents) {
        this._appendEvent(targetProjectId, {
          action: event.action,
          campaignId: event.campaignId,
          milestoneId: event.milestoneId,
          previousStatus: event.previousStatus,
          newStatus: event.newStatus,
          agent: 'system',
          reason: event.reason,
        });
      }
    }

    // Fire event callback for primary project only (to avoid duplicate event handling)
    if (this._onEvent) {
      this._onEvent('campaign:status_changed', { projectId, campaignId, status: newStatus });
      // Specific lifecycle events for webhook subscribers — fired alongside the
      // generic status_changed so consumers can pick the granularity they need.
      if (newStatus === 'paused') {
        this._onEvent('campaign:paused', { projectId, campaignId, previousStatus, reason: reason || null });
      } else if (newStatus === 'active' && previousStatus === 'paused') {
        this._onEvent('campaign:resumed', { projectId, campaignId, reason: reason || null });
      }
    }

    // Render CAMPAIGNS.md for all participating projects
    for (const targetProjectId of projectIds) {
      this._renderCampaignMd(targetProjectId);
    }

    return updatedCampaign;
  }

  /**
   * Update Socratic campaign lifecycle state with CAS-protected persistence.
   * Validates state transitions using SOCRATIC_STATES.transitions.
   *
   * @param {string} projectId - Project identifier
   * @param {string} campaignId - Campaign identifier
   * @param {string} newState - Target Socratic lifecycle state (created/researching/curating/reviewed/done)
   * @param {string} reason - Reason for state transition
   * @param {string|null} userId - Optional user ID for ownership validation
   * @returns {Object} Updated campaign object
   * @throws {Error} If campaign not found, not a Socratic campaign, or invalid transition
   */
  updateSocraticState(projectId, campaignId, newState, reason, userId = null) {
    let previousState = null;

    const data = this._saveWithRetryScoped(projectId, userId,
      (d) => d.campaigns.find(c => c.id === campaignId),
      (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        if (!campaign) {
          throw new Error(`Campaign not found: ${campaignId}`);
        }

        // Verify this is a Socratic campaign
        if (campaign.type !== 'socratic') {
          throw new Error(`Campaign ${campaignId} is not a Socratic campaign (type: ${campaign.type})`);
        }

        // Validate new state is a valid Socratic state
        if (!SOCRATIC_STATES.states.includes(newState)) {
          throw new Error(`Invalid Socratic state: ${newState}. Valid states: ${SOCRATIC_STATES.states.join(', ')}`);
        }

        previousState = campaign.status;

        // Validate state transition
        const allowed = SOCRATIC_STATES.transitions[campaign.status];
        if (!allowed || !allowed.includes(newState)) {
          throw new Error(`Invalid Socratic state transition: ${campaign.status} → ${newState}. Allowed transitions from ${campaign.status}: ${(allowed || []).join(', ') || 'none'}`);
        }

        // Validate Socratic question schema before allowing transition to reviewed/done
        if (newState === 'reviewed' || newState === 'done') {
          const questions = campaign.questions || [];
          const validation = validateSocraticQuestions(questions);
          if (!validation.valid) {
            throw new Error(`Cannot transition Socratic campaign to '${newState}': ${validation.error}${validation.details && validation.details.length > 0 ? '. Details: ' + validation.details.join('; ') : ''}`);
          }

          // Soft warning for question count outside 5-15 range
          const countValidation = validateQuestionCount(campaign.questionCount || 0);
          if (countValidation.warnings && countValidation.warnings.length > 0) {
            log.warn(`Socratic campaign ${campaignId} transitioning to '${newState}' with question count ${campaign.questionCount}: ${countValidation.warnings.join('; ')}`);
          }
        }

        // Update campaign state
        campaign.status = newState;
        campaign.updatedAt = new Date().toISOString();

        // Mark completion timestamp when reaching 'done' state
        if (newState === 'done') {
          campaign.completedAt = campaign.updatedAt;
        }

        return d;
      }
    );

    // OTel: add span event for Socratic state transition and end span on completion
    const span = activeCampaignSpans.get(campaignId);
    if (span) {
      addSpanEvent(span, 'socratic_state_change', {
        from: previousState,
        to: newState,
        reason: reason || `Socratic state: ${newState}`,
      });

      if (newState === 'done') {
        endSpan(span, { success: true });
        activeCampaignSpans.delete(campaignId);
      }
    }

    // Append event to JSONL log
    this._appendEvent(projectId, {
      action: 'socratic_state_changed',
      campaignId,
      agent: 'system',
      previousState,
      newState,
      reason: reason || `Socratic state: ${newState}`,
    });

    // Fire event callback
    if (this._onEvent) {
      this._onEvent('campaign:socratic_state_changed', {
        projectId,
        campaignId,
        previousState,
        newState
      });
    }

    this._renderCampaignMd(projectId);
    return data.campaigns.find(c => c.id === campaignId);
  }

  /**
   * Transition a Socratic campaign through its lifecycle states.
   * Validates the campaign is of type 'socratic', then delegates to updateSocraticState().
   * This is the preferred public API for Socratic state changes from the API layer.
   *
   * @param {string} projectId - Project identifier
   * @param {string} campaignId - Campaign identifier
   * @param {string} newState - Target Socratic lifecycle state
   * @param {string} reason - Reason for state transition
   * @param {string|null} userId - Optional user ID for ownership validation
   * @returns {Object} Updated campaign object
   * @throws {Error} If campaign not found, not a Socratic campaign, or invalid transition
   */
  transitionSocraticCampaign(projectId, campaignId, newState, reason, userId = null) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    if (campaign.type !== 'socratic') {
      throw new Error(`Campaign ${campaignId} is not a Socratic campaign (type: ${campaign.type})`);
    }
    return this.updateSocraticState(projectId, campaignId, newState, reason, userId);
  }

  /**
   * Add a single question to a Socratic campaign.
   * Validates the question object before persisting.
   *
   * @param {string} projectId - Project identifier
   * @param {string} campaignId - Campaign identifier
   * @param {Object} questionData - Question object to add
   * @returns {{ campaign: Object, errors: string[] }} Updated campaign and any validation errors
   */
  addQuestion(projectId, campaignId, questionData) {
    const validation = validateQuestion(questionData);
    if (!validation.valid) {
      return { campaign: null, errors: validation.errors };
    }

    let updated;
    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      if (campaign.type !== 'socratic') {
        throw new Error(`Campaign ${campaignId} is not a Socratic campaign (type: ${campaign.type})`);
      }
      if (!Array.isArray(campaign.questions)) campaign.questions = [];
      campaign.questions.push(questionData);
      campaign.questionCount = campaign.questions.length;
      campaign.updatedAt = new Date().toISOString();
      updated = campaign;
      return d;
    });

    this._appendEvent(projectId, {
      action: 'question_added',
      campaignId,
      agent: 'system',
      questionCount: updated.questionCount,
    });

    return { campaign: updated, errors: [] };
  }

  /**
   * Replace all questions on a Socratic campaign.
   * Validates each question object before persisting.
   * Returns validation errors for any invalid questions without persisting.
   *
   * @param {string} projectId - Project identifier
   * @param {string} campaignId - Campaign identifier
   * @param {Array} questions - Array of question objects
   * @returns {{ campaign: Object, errors: string[] }} Updated campaign and any validation errors
   */
  setQuestions(projectId, campaignId, questions) {
    if (!Array.isArray(questions)) {
      return { campaign: null, errors: ['questions must be an array'] };
    }

    const allErrors = [];
    questions.forEach((q, i) => {
      const result = validateQuestion(q);
      if (!result.valid) {
        result.errors.forEach(e => allErrors.push(`question[${i}]: ${e}`));
      }
    });

    if (allErrors.length > 0) {
      return { campaign: null, errors: allErrors };
    }

    let updated;
    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      if (campaign.type !== 'socratic') {
        throw new Error(`Campaign ${campaignId} is not a Socratic campaign (type: ${campaign.type})`);
      }
      campaign.questions = questions.slice();
      campaign.questionCount = campaign.questions.length;
      campaign.updatedAt = new Date().toISOString();
      updated = campaign;
      return d;
    });

    this._appendEvent(projectId, {
      action: 'questions_set',
      campaignId,
      agent: 'system',
      questionCount: updated.questionCount,
    });

    return { campaign: updated, errors: [] };
  }

  /**
   * Update Socratic campaign questions with full validation and state transition.
   * This is the primary API for persisting socratic-agent output to campaigns.
   *
   * Validates questions using validateQuestionSchema (enforces 5-15 count, all required fields).
   * Persists questions to campaign.questions array via CAS-protected write.
   * Updates campaign lifecycle state from 'researching' to 'curating'.
   * Returns detailed validation errors if questions fail schema validation.
   *
   * @param {string} projectId - Project identifier
   * @param {string} campaignId - Campaign identifier
   * @param {Array} questions - Array of Socratic question objects (5-15 items)
   * @param {string} source - Source of questions (e.g., 'socratic-agent', 'manual', 'curation')
   * @returns {{ success: boolean, campaign?: Object, errors?: string[], validation?: Object }}
   *   success: true if questions persisted and state updated
   *   campaign: updated campaign object (only if success)
   *   errors: array of validation/persistence errors (only if success is false)
   *   validation: detailed validation result from validateQuestionSchema
   */
  updateSocraticQuestions(projectId, campaignId, questions, source = 'socratic-agent') {
    // Step 1: Validate question schema (5-15 count, all required fields)
    const schemaValidation = validateSocraticQuestions(questions);
    
    if (!schemaValidation.valid) {
      return {
        success: false,
        errors: [schemaValidation.error],
        details: schemaValidation.details || [],
        validation: schemaValidation,
      };
    }

    // Step 2: Validate each individual question for additional field-level checks
    const individualErrors = [];
    questions.forEach((q, i) => {
      const result = validateQuestion(q);
      if (!result.valid && result.errors) {
        result.errors.forEach(e => individualErrors.push(`question[${i}]: ${e}`));
      }
    });

    if (individualErrors.length > 0) {
      return {
        success: false,
        errors: individualErrors,
        validation: schemaValidation,
      };
    }

    // Step 3: Persist questions via CAS-protected write
    let updatedCampaign;
    try {
      this._saveWithRetry(projectId, (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        if (!campaign) {
          throw new Error(`Campaign not found: ${campaignId}`);
        }
        if (campaign.type !== 'socratic') {
          throw new Error(`Campaign ${campaignId} is not a Socratic campaign (type: ${campaign.type})`);
        }

        // Update questions and count
        campaign.questions = questions.slice();
        campaign.questionCount = campaign.questions.length;
        
        // Update socraticConfig if it exists
        if (campaign.socraticConfig) {
          campaign.socraticConfig.questions = campaign.questions.slice();
          campaign.socraticConfig.questionCount = campaign.questionCount;
        }

        campaign.updatedAt = new Date().toISOString();
        updatedCampaign = campaign;
        return d;
      });
    } catch (err) {
      // Handle CAS conflicts and other persistence errors
      if (err.code === 'CAS_CONFLICT') {
        return {
          success: false,
          errors: [`CAS conflict while persisting questions: ${err.message}`],
          validation: schemaValidation,
        };
      }
      return {
        success: false,
        errors: [err.message],
        validation: schemaValidation,
      };
    }

    // Step 4: Append event to JSONL log
    this._appendEvent(projectId, {
      action: 'socratic_questions_updated',
      campaignId,
      agent: source || 'system',
      questionCount: updatedCampaign.questionCount,
      source: source,
    });

    // Step 5: Update campaign lifecycle state from 'researching' to 'curating'
    // This is a soft transition - if already in curating or later state, don't change
    if (updatedCampaign.status === 'researching') {
      try {
        this.updateSocraticState(
          projectId,
          campaignId,
          'curating',
          `Questions updated by ${source || 'system'}: ${updatedCampaign.questionCount} questions persisted`,
          'system'
        );
      } catch (stateErr) {
        // Log state transition error but don't fail the overall operation
        log.warn('Failed to update Socratic campaign state after question persistence', {
          campaignId,
          from: 'researching',
          to: 'curating',
          error: stateErr.message,
        });
      }
    }

    // Step 6: Log success
    log.info('Socratic questions updated successfully', {
      projectId,
      campaignId,
      questionCount: updatedCampaign.questionCount,
      source: source || 'system',
    });

    return {
      success: true,
      campaign: updatedCampaign,
      validation: schemaValidation,
      questionCount: updatedCampaign.questionCount,
      source: source || 'system',
    };
  }

  /**
   * Promote the highest-priority queued campaign to active.
   * Called after a campaign completes or fails to fill the slot.
   * Returns the promoted campaign or null.
   */
  promoteNextCampaign(projectId) {
    const queued = this.listCampaigns(projectId, 'queued');
    if (queued.length === 0) return null;

    const maxActive = this._config?.campaigns?.maxActiveCampaigns || 1;
    const active = this.listCampaigns(projectId, 'active');
    if (active.length >= maxActive) return null;

    // Sort by priority (critical > revenue > normal), then by creation date
    queued.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 2;
      const pb = PRIORITY_ORDER[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const next = queued[0];
    this.updateCampaignStatus(projectId, next.id, 'active', 'Auto-promoted from queue');
    return next;
  }

  updateCampaignReview(projectId, campaignId, { lastReviewSummary, nextAction }) {
    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      campaign.lastReviewAt = new Date().toISOString();
      if (lastReviewSummary !== undefined) campaign.lastReviewSummary = lastReviewSummary;
      if (nextAction !== undefined) campaign.nextAction = nextAction;
      campaign.updatedAt = campaign.lastReviewAt;
      return d;
    });

    this._appendEvent(projectId, {
      action: 'campaign_reviewed',
      campaignId,
      agent: 'strategist',
      reason: lastReviewSummary || 'Periodic review',
    });
  }

  /**
   * Set recovery status on a campaign (transient field for recoveryCheck).
   * Values: null (normal), 'recovered' (auto-resumed), 'needs_review' (requires intervention).
   * @param {string} projectId
   * @param {string} campaignId
   * @param {string|null} status - 'recovered', 'needs_review', or null to clear
   * @returns {object} the updated campaign
   */
  setRecoveryStatus(projectId, campaignId, status) {
    if (status !== null && !['recovered', 'needs_review'].includes(status)) {
      throw new Error(`Invalid recoveryStatus: '${status}'. Valid values: 'recovered', 'needs_review', null`);
    }

    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      campaign.recoveryStatus = status;
      campaign.updatedAt = new Date().toISOString();
      return d;
    });

    this._appendEvent(projectId, {
      action: 'recovery_status_updated',
      campaignId,
      agent: 'system',
      recoveryStatus: status,
      reason: `Recovery status set to: ${status}`,
    });

    return this.getCampaign(projectId, campaignId);
  }

  /**
   * Clear recovery status on a campaign (set to null).
   * @param {string} projectId
   * @param {string} campaignId
   * @returns {object} the updated campaign
   */
  clearRecoveryStatus(projectId, campaignId) {
    return this.setRecoveryStatus(projectId, campaignId, null);
  }

  // --- Constraint Management ---
  //
  // === Constraint Data Schema ===
  //
  // Constraints are stored as an array on each campaign object: `campaign.constraints: []`
  // Each constraint entry:
  //   {
  //     id:            string  — unique ID, format: `con_{timestamp}_{uuid8}`
  //     type:          string  — one of: 'exclude_agents', 'require_provider', 'max_concurrent', 'priority_override', 'time_window'
  //     value:         any     — type-dependent:
  //                              exclude_agents:    string[]  (non-empty array of agent IDs to exclude from routing)
  //                              require_provider:  string    (non-empty provider name, e.g. 'claude', 'gemini')
  //                              max_concurrent:    number    (non-negative integer, max parallel tasks)
  //                              priority_override: string    (one of CAMPAIGN_PRIORITIES)
  //                              time_window:       object    (non-empty object, e.g. { after, before } or { days, startHour, endHour })
  //     operatorId:    string  — who injected the constraint (userId or 'system')
  //     reason:        string|null — human-readable justification
  //     createdAt:     string  — ISO 8601 timestamp
  //     active:        boolean — true = enforced, false = soft-deleted
  //     deactivatedAt: string|null — ISO 8601 timestamp when deactivated (null if active)
  //     deactivatedBy: string|null — operator who deactivated (null if active)
  //   }
  //
  // Deactivation: soft-delete via `active: false` + `deactivatedAt` + `deactivatedBy`.
  // This preserves the full audit trail — operators can see what constraints were applied
  // and when/by whom they were removed. Hard deletion is not supported.
  //
  // Backward compatibility: campaigns created before the constraints array existed
  // will have `constraints: null`. Readers must default to `[]` via (campaign.constraints || []).
  //
  // Integration points:
  //   - campaigns.js:      addConstraint(), removeConstraint(), getActiveConstraints() — CRUD
  //   - orchestrator/api.js: POST /campaigns/:id/constraints endpoint for operator injection
  //   - orchestrator/dispatch.js: consult getActiveConstraints() during routing to honor
  //                               exclude_agents and require_provider rules
  //   - orchestrator/strategist.js: consult getActiveConstraints() during milestone decomposition
  //                                 to honor max_concurrent and priority_override rules
  //   - Event log: `constraint_added` and `constraint_removed` events via _appendEvent()
  //
  // CAS safety: all writes use _saveWithRetry() for conflict resolution.
  //

  /**
   * Validate and set constraints on a campaign (legacy single-object API).
   * Constraints override routing weights and can pause/resume campaigns.
   * @param {string} projectId
   * @param {string} campaignId
   * @param {object} constraints - e.g. { exclude_agents, require_provider, pause_campaign, max_concurrent }
   * @param {string} [userId] - operator who injected the constraint (for audit)
   * @returns {object} the updated campaign
   * @deprecated Use addConstraint() / removeConstraint() for the array-based model.
   */
  setConstraints(projectId, campaignId, constraints, userId = null) {
    // Validate constraint object
    if (constraints === null || constraints === undefined) {
      throw new Error('Constraints object is required');
    }
    if (typeof constraints !== 'object' || Array.isArray(constraints)) {
      throw new Error('Constraints must be a plain object');
    }

    const VALID_KEYS = ['exclude_agents', 'require_provider', 'pause_campaign', 'max_concurrent', 'reason'];
    const keys = Object.keys(constraints);
    for (const key of keys) {
      if (!VALID_KEYS.includes(key)) {
        throw new Error(`Invalid constraint key: '${key}'. Valid keys: ${VALID_KEYS.join(', ')}`);
      }
    }

    // Type-check individual fields
    if (constraints.exclude_agents !== undefined) {
      if (!Array.isArray(constraints.exclude_agents)) {
        throw new Error('exclude_agents must be an array of agent IDs');
      }
    }
    if (constraints.require_provider !== undefined) {
      if (typeof constraints.require_provider !== 'string') {
        throw new Error('require_provider must be a string');
      }
    }
    if (constraints.pause_campaign !== undefined) {
      if (typeof constraints.pause_campaign !== 'boolean') {
        throw new Error('pause_campaign must be a boolean');
      }
    }
    if (constraints.max_concurrent !== undefined) {
      if (typeof constraints.max_concurrent !== 'number' || constraints.max_concurrent < 0 || !Number.isInteger(constraints.max_concurrent)) {
        throw new Error('max_concurrent must be a non-negative integer');
      }
    }
    if (constraints.reason !== undefined && typeof constraints.reason !== 'string') {
      throw new Error('reason must be a string');
    }

    const data = this._saveWithRetryScoped(projectId, userId,
      (d) => d.campaigns.find(c => c.id === campaignId),
      (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
        campaign.constraints = constraints;
        campaign.updatedAt = new Date().toISOString();
        return d;
      });

    this._appendEvent(projectId, {
      action: 'constraint_injected',
      campaignId,
      agent: userId || 'system',
      constraints,
      reason: constraints.reason || 'Constraint injected',
    });

    if (this._onEvent) {
      this._onEvent('campaign:constraints_updated', { projectId, campaignId, constraints });
    }

    this._renderCampaignMd(projectId);
    return data.campaigns.find(c => c.id === campaignId);
  }

  /**
   * Add a single constraint to a campaign (array-based model).
   * Each constraint gets a unique ID, timestamp, and operator metadata.
   * Uses _saveWithRetry() for CAS-protected write.
   * @param {string} projectId
   * @param {string} campaignId
   * @param {object} constraint - { type, value, reason? }
   * @param {string} operatorId - who injected the constraint
   * @returns {object} the created constraint entry
   */
  async addConstraint(projectId, campaignId, constraint, operatorId, agentMap) {
    if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) {
      throw new Error('Constraint must be a plain object');
    }

    const VALID_TYPES = ['exclude_agents', 'require_provider', 'max_concurrent', 'priority_override', 'time_window', 'pause_campaign'];
    if (!constraint.type || typeof constraint.type !== 'string') {
      throw new Error("Constraint 'type' field is required and must be a string");
    }
    if (!VALID_TYPES.includes(constraint.type)) {
      throw new Error(`Invalid constraint type: '${constraint.type}'. Valid types: ${VALID_TYPES.join(', ')}`);
    }

    // Value is required for all constraint types
    if (constraint.value === undefined || constraint.value === null) {
      throw new Error("Constraint 'value' field is required");
    }

    // Type-specific value validation
    try {
      switch (constraint.type) {
        case 'exclude_agents':
          if (!Array.isArray(constraint.value) || constraint.value.length === 0) {
            throw new Error('exclude_agents value must be a non-empty array of agent IDs');
          }
          if (!constraint.value.every(id => typeof id === 'string' && id.length > 0)) {
            throw new Error('exclude_agents value must contain only non-empty string agent IDs');
          }
          break;
        case 'require_provider':
          if (typeof constraint.value !== 'string' || constraint.value.length === 0) {
            throw new Error('require_provider value must be a non-empty string');
          }
          break;
        case 'max_concurrent':
          if (typeof constraint.value !== 'number' || constraint.value < 0 || !Number.isInteger(constraint.value)) {
            throw new Error('max_concurrent value must be a non-negative integer');
          }
          break;
        case 'priority_override':
          if (!CAMPAIGN_PRIORITIES.includes(constraint.value)) {
            throw new Error(`priority_override value must be one of: ${CAMPAIGN_PRIORITIES.join(', ')}`);
          }
          break;
        case 'time_window': {
          const v = constraint.value;
          if (typeof v !== 'object' || Array.isArray(v)) {
            throw new Error('time_window value must be an object');
          }
          if (Object.keys(v).length === 0) {
            throw new Error('time_window value must be a non-empty object (e.g. { after, before } or { days, startHour, endHour })');
          }

          const hasAbsolute = 'after' in v || 'before' in v;
          const hasRecurring = 'days' in v || 'startHour' in v || 'endHour' in v;

          if (hasAbsolute && hasRecurring) {
            throw new Error('time_window cannot mix absolute (after/before) and recurring (days/startHour/endHour) formats');
          }

          if (hasAbsolute) {
            if ('after' in v && typeof v.after !== 'string') {
              throw new Error('time_window after must be a string');
            }
            if ('before' in v && typeof v.before !== 'string') {
              throw new Error('time_window before must be a string');
            }
          }

          if (hasRecurring) {
            if ('days' in v) {
              if (!Array.isArray(v.days)) {
                throw new Error('time_window days must be an array of day names');
              }
              const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
              for (const d of v.days) {
                if (typeof d !== 'string' || !validDays.includes(d.toLowerCase())) {
                  throw new Error(`time_window days contains invalid day name: '${d}'`);
                }
              }
            }
            if ('startHour' in v) {
              if (typeof v.startHour !== 'number' || !Number.isInteger(v.startHour) || v.startHour < 0 || v.startHour > 23) {
                throw new Error('time_window startHour must be an integer between 0 and 23');
              }
            }
            if ('endHour' in v) {
              if (typeof v.endHour !== 'number' || !Number.isInteger(v.endHour) || v.endHour < 0 || v.endHour > 23) {
                throw new Error('time_window endHour must be an integer between 0 and 23');
              }
            }
          }
          break;
        }
        case 'pause_campaign':
          if (typeof constraint.value !== 'boolean') {
            throw new Error('pause_campaign value must be a boolean (true to pause, false to resume)');
          }
          break;
      }
    } catch (validationError) {
      log.error('Constraint validation failed', { constraint, error: validationError.message });
      throw validationError;
    }

    // Check for routing conflicts if agentMap is provided
    if (agentMap) {
      const activeConstraints = this.getActiveConstraints(projectId, campaignId);
      const conflict = detectConstraintConflict(agentMap, activeConstraints, constraint);
      if (conflict) {
        const err = new Error(`Constraint would cause routing deadlock: ${conflict.diagnostic}`);
        err.conflict = conflict;
        throw err;
      }
    }

    const constraintId = `con_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const entry = {
      id: constraintId,
      type: constraint.type,
      value: constraint.value,
      operatorId: operatorId || 'system',
      reason: constraint.reason || null,
      createdAt: now,
      active: true,
      deactivatedAt: null,
      deactivatedBy: null,
    };

    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      if (!Array.isArray(campaign.constraints)) {
        campaign.constraints = [];
      }
      campaign.constraints.push(entry);
      campaign.updatedAt = now;
      return d;
    });

    this._appendEvent(projectId, {
      action: 'constraint_added',
      campaignId,
      constraintId,
      constraintType: entry.type,
      agent: operatorId || 'system',
      reason: entry.reason || `Constraint added: ${entry.type}`,
    });

    if (this._onEvent) {
      this._onEvent('campaign:constraint_added', { projectId, campaignId, constraintId, constraint: entry });
    }

    // Auto-pause campaign when pause_campaign: true constraint is applied
    if (entry.type === 'pause_campaign' && entry.value === true) {
      this.updateCampaignStatus(projectId, campaignId, 'paused', `Paused via constraint by ${operatorId || 'system'}`);
    }

    this._renderCampaignMd(projectId);
    return entry;
  }

  /**
   * Soft-deactivate a constraint on a campaign.
   * Sets `active: false`, records `deactivatedAt` and `deactivatedBy`.
   * Uses _saveWithRetry() for CAS-protected write.
   * @param {string} projectId
   * @param {string} campaignId
   * @param {string} constraintId - ID of the constraint to deactivate
   * @param {string} operatorId - who removed the constraint
   * @returns {object} the deactivated constraint entry
   */
  removeConstraint(projectId, campaignId, constraintId, operatorId) {
    if (!constraintId || typeof constraintId !== 'string') {
      throw new Error('constraintId is required and must be a string');
    }

    const now = new Date().toISOString();
    let deactivated = null;

    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      if (!Array.isArray(campaign.constraints)) {
        throw new Error(`Constraint not found: ${constraintId}`);
      }
      const constraint = campaign.constraints.find(c => c.id === constraintId);
      if (!constraint) {
        throw new Error(`Constraint not found: ${constraintId}`);
      }
      if (constraint.active === false) {
        throw new Error(`Constraint already deactivated: ${constraintId}`);
      }
      constraint.active = false;
      constraint.deactivatedAt = now;
      constraint.deactivatedBy = operatorId || 'system';
      campaign.updatedAt = now;
      deactivated = { ...constraint };
      return d;
    });

    this._appendEvent(projectId, {
      action: 'constraint_removed',
      campaignId,
      constraintId,
      constraintType: deactivated.type,
      agent: operatorId || 'system',
      reason: `Constraint deactivated: ${deactivated.type}`,
    });

    if (this._onEvent) {
      this._onEvent('campaign:constraint_removed', { projectId, campaignId, constraintId, constraint: deactivated });
    }

    // Auto-resume campaign when the last active pause_campaign constraint is removed
    if (deactivated.type === 'pause_campaign' && deactivated.value === true) {
      const campaign = this.getCampaign(projectId, campaignId);
      const remainingPause = this.getActiveConstraints(projectId, campaignId)
        .some(c => c.type === 'pause_campaign' && c.value === true);
      if (!remainingPause && campaign && campaign.status === 'paused') {
        this.updateCampaignStatus(projectId, campaignId, 'active', `Auto-resumed: pause_campaign constraint removed by ${operatorId || 'system'}`);
      }
    }

    this._renderCampaignMd(projectId);
    return deactivated;
  }

  /**
   * Get active constraints for a campaign.
   * Returns only constraints with `active: true`. Handles backward compat:
   * - null/undefined → empty array
   * - legacy single-object format → wrapped in array (treated as active)
   * @param {string} projectId
   * @param {string} campaignId
   * @returns {object[]} array of active constraint entries (never null)
   */
  getActiveConstraints(projectId, campaignId) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return [];
    
    // Get campaign constraints
    const raw = campaign.constraints;
    let campaignConstraints = [];
    if (raw) {
      // Legacy single-object format: wrap in array for backward compat
      campaignConstraints = Array.isArray(raw) 
        ? raw.filter(c => c.active !== false)
        : [raw];
    }
    
    // Merge with error pattern constraints from store
    let errorPatternConstraints = [];
    if (this.errorPatternConstraintStore) {
      try {
        const constraints = this.errorPatternConstraintStore.getActiveConstraints();
        errorPatternConstraints = constraints.map(c => ({
          type: 'error_pattern_penalty',
          value: {
            agentId: c.agentId,
            errorCategory: c.errorCategory,
            penaltyFactor: c.penaltyFactor,
            patternId: c.patternId,
            expiresAt: c.expiresAt,
          },
        }));
      } catch (err) {
        log.warn('Failed to load error pattern constraints from store', { error: err.message });
      }
    }
    
    return [...campaignConstraints, ...errorPatternConstraints];
  }

  updateCampaignCloseout(projectId, campaignId, closeoutSummary) {
    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      campaign.closeoutSummary = closeoutSummary;
      campaign.updatedAt = new Date().toISOString();
      return d;
    });

    this._appendEvent(projectId, {
      action: 'campaign_closeout',
      campaignId,
      agent: 'strategist',
      reason: 'Strategic review completed',
    });

    this._renderCampaignMd(projectId);
  }

  /**
   * Cycle an evergreen campaign: archive current cycle, clear milestones, enter 'cycling' status.
   * Cycling status = parked, waiting for operator approval before next cycle.
   * @param {string} projectId
   * @param {string} campaignId
   * @param {string} summaryText - compact summary of the completed cycle
   */
  cycleCampaign(projectId, campaignId, summaryText) {
    const CYCLE_HISTORY_CAP = 10;

    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

      const cycleEntry = {
        cycle: (campaign.cycleCount || 0) + 1,
        completedAt: new Date().toISOString(),
        milestoneCount: campaign.milestones.length,
        summary: summaryText || 'No summary',
      };

      if (!campaign.cycleHistory) campaign.cycleHistory = [];
      campaign.cycleHistory.push(cycleEntry);
      // Rolling cap — oldest entries drop off, full history lives in event JSONL
      if (campaign.cycleHistory.length > CYCLE_HISTORY_CAP) {
        campaign.cycleHistory = campaign.cycleHistory.slice(-CYCLE_HISTORY_CAP);
      }

      campaign.cycleCount = (campaign.cycleCount || 0) + 1;
      campaign.milestones = [];
      campaign.status = 'cycling';
      campaign.cycleApproved = false;
      campaign.updatedAt = new Date().toISOString();

      // Check maxCycles cap
      if (campaign.maxCycles && campaign.cycleCount >= campaign.maxCycles) {
        campaign.status = 'completed';
        campaign.completedAt = new Date().toISOString();
      }

      return d;
    });

    const campaign = this.getCampaign(projectId, campaignId);

    this._appendEvent(projectId, {
      action: campaign?.status === 'completed' ? 'campaign_max_cycles_reached' : 'campaign_cycling',
      campaignId,
      cycleCount: campaign?.cycleCount,
      agent: 'strategist',
      reason: campaign?.status === 'completed'
        ? `Max cycles (${campaign.maxCycles}) reached — campaign completed`
        : `Cycle ${campaign?.cycleCount} completed — awaiting operator approval`,
    });

    if (this._onEvent) {
      this._onEvent(campaign?.status === 'completed' ? 'campaign:completed' : 'campaign:cycling', {
        projectId, campaignId,
        cycleCount: campaign?.cycleCount,
        status: campaign?.status,
      });
    }

    this._renderCampaignMd(projectId);
    log.info('Campaign cycled', { projectId, campaignId, cycleCount: campaign?.cycleCount, status: campaign?.status });
  }

  /**
   * Approve an evergreen campaign for its next cycle.
   * Sets cycleApproved flag — next strategistTick will transition cycling→active + decompose.
   */
  approveCycle(projectId, campaignId) {
    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
      if (campaign.status !== 'cycling') throw new Error(`Campaign is not in cycling status (current: ${campaign.status})`);
      campaign.cycleApproved = true;
      campaign.updatedAt = new Date().toISOString();
      return d;
    });

    this._appendEvent(projectId, {
      action: 'campaign_cycle_approved',
      campaignId,
      agent: 'operator',
      reason: 'Operator approved next cycle',
    });

    log.info('Campaign cycle approved', { projectId, campaignId });
  }

  /**
   * Generate a structured closeout summary for a completed/failed campaign.
   * @param {TaskManager} taskManager - task manager instance for task data
   * @param {LearningsManager} learningsManager - learnings manager instance (optional)
   * @returns {object|null} closeout summary object or null if campaign not found
   */
  generateCloseoutSummary(projectId, campaignId, taskManager, learningsManager = null) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return null;

    const createdAt = new Date(campaign.createdAt);
    const completedAt = new Date(campaign.completedAt || Date.now());
    const totalMs = completedAt.getTime() - createdAt.getTime();

    // Milestone outcomes with per-milestone duration
    const milestoneOutcomes = campaign.milestones.map(m => {
      const msStart = new Date(m.createdAt);
      const msEnd = m.completedAt ? new Date(m.completedAt) : completedAt;
      const msDurationMs = msEnd.getTime() - msStart.getTime();
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        duration: { startedAt: m.createdAt, completedAt: m.completedAt || completedAt.toISOString(), durationMs: msDurationMs },
      };
    });

    // Collect all task IDs from campaign milestones
    const allTaskIds = new Set(campaign.milestones.flatMap(m => m.tasks));
    const tasks = [];
    for (const taskId of allTaskIds) {
      const task = taskManager?.getTask(projectId, taskId);
      if (task) tasks.push(task);
    }

    // Agent stats from subtasks (flat + per-category breakdown)
    const agentStats = {};
    for (const task of tasks) {
      if (!task.subtasks || task.subtasks.length === 0) continue;
      for (const st of task.subtasks) {
        if (!st.assignee) continue;
        const agentId = st.assignee;
        if (!agentStats[agentId]) {
          agentStats[agentId] = { dispatches: 0, subtasksCompleted: 0, subtasksFailed: 0, totalDurationMs: 0, durationCount: 0, byCategory: {} };
        }
        agentStats[agentId].dispatches++;
        if (st.status === 'done') {
          agentStats[agentId].subtasksCompleted++;
        } else if (st.status === 'failed') {
          agentStats[agentId].subtasksFailed++;
        }

        let duration = 0;
        if (st.startedAt && st.completedAt) {
          const start = new Date(st.startedAt);
          const end = new Date(st.completedAt);
          duration = end.getTime() - start.getTime();
          if (duration > 0) {
            agentStats[agentId].totalDurationMs += duration;
            agentStats[agentId].durationCount++;
          } else {
            duration = 0;
          }
        }

        // Per-category breakdown using suggestedRole
        const category = st.suggestedRole || 'unknown';
        if (!agentStats[agentId].byCategory[category]) {
          agentStats[agentId].byCategory[category] = { dispatches: 0, subtasksCompleted: 0, subtasksFailed: 0, totalDurationMs: 0, durationCount: 0 };
        }
        const catStats = agentStats[agentId].byCategory[category];
        catStats.dispatches++;
        if (st.status === 'done') catStats.subtasksCompleted++;
        else if (st.status === 'failed') catStats.subtasksFailed++;
        if (duration > 0) {
          catStats.totalDurationMs += duration;
          catStats.durationCount++;
        }
      }
    }
    // Calculate success rates and average times (flat + per-category)
    for (const agentId of Object.keys(agentStats)) {
      const stats = agentStats[agentId];
      const total = stats.dispatches;
      stats.successRate = total > 0 ? stats.subtasksCompleted / total : 0;
      stats.avgTimeMs = stats.durationCount > 0 ? stats.totalDurationMs / stats.durationCount : 0;
      for (const cat of Object.keys(stats.byCategory)) {
        const catStats = stats.byCategory[cat];
        const catTotal = catStats.dispatches;
        catStats.successRate = catTotal > 0 ? catStats.subtasksCompleted / catTotal : 0;
        catStats.avgTimeMs = catStats.durationCount > 0 ? catStats.totalDurationMs / catStats.durationCount : 0;
      }
    }

    // Learnings from campaign duration window
    const learnings = [];
    if (learningsManager) {
      const campaignLearnings = learningsManager.query(projectId, { campaignId });
      for (const lrn of campaignLearnings) {
        learnings.push(lrn);
      }
    }

    // Outcome breakdown
    const completedMilestones = campaign.milestones.filter(m => m.status === 'completed').length;
    const failedMilestones = campaign.milestones.filter(m => m.status === 'failed').length;
    const skippedMilestones = campaign.milestones.filter(m => m.status === 'skipped').length;
    let doneSubtasks = 0, failedSubtasks = 0;
    for (const task of tasks) {
      if (task.subtasks) {
        for (const st of task.subtasks) {
          if (st.status === 'done') doneSubtasks++;
          else if (st.status === 'failed') failedSubtasks++;
        }
      }
    }

    return {
      milestoneOutcomes,
      agentStats,
      learnings,
      duration: {
        startedAt: campaign.createdAt,
        completedAt: campaign.completedAt || completedAt.toISOString(),
        totalMs,
        hours: totalMs / (1000 * 60 * 60),
      },
      outcomeBreakdown: {
        completed: completedMilestones,
        failed: failedMilestones,
        skipped: skippedMilestones,
        partial: campaign.milestones.length - (completedMilestones + failedMilestones + skippedMilestones),
        subtasksDone: doneSubtasks,
        subtasksFailed: failedSubtasks,
      },
    };
  }

  // --- Milestone Management ---

  addMilestone(projectId, campaignId, { title, description, doneCriteria, contingency, blockedBy, order, requireApproval, priority }, userId = null) {
    const milestoneId = `ms_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Validate requireApproval is a boolean (null is treated as false)
    if (requireApproval !== undefined && requireApproval !== null && typeof requireApproval !== 'boolean') {
      throw new Error(`requireApproval must be a boolean, got ${typeof requireApproval}`);
    }

    const milestone = {
      id: milestoneId,
      title,
      description: description || title,
      doneCriteria: doneCriteria || null,
      contingency: contingency || null,
      status: 'pending',
      blockedBy: blockedBy || [],
      tasks: [],
      order: order ?? 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      traceContext: null,  // OTel span context for parent-child linkage
      requireApproval: requireApproval || false,
      approvalState: null,
      approverId: null,
      approvalRequestedAt: null,
      approvalReason: null,
      priority: priority || null,
    };

    this._saveWithRetryScoped(projectId, userId,
      (d) => d.campaigns.find(c => c.id === campaignId),
      (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
        campaign.milestones.push(milestone);
        campaign.updatedAt = now;
        return d;
      });

    this._appendEvent(projectId, {
      action: 'milestone_added',
      campaignId,
      milestoneId,
      agent: 'system',
      reason: `Milestone added: ${title}`,
    });

    this._renderCampaignMd(projectId);
    return milestone;
  }

  updateMilestoneStatus(projectId, campaignId, milestoneId, newStatus, reason, userId = null) {
    let previousStatus = null;
    let milestoneTitle = null;
    let campaignTraceContext = null;
    let shouldCreateSpan = false;
    let autoPaused = false;

    const data = this._saveWithRetryScoped(projectId, userId,
      (d) => d.campaigns.find(c => c.id === campaignId),
      (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

      const milestone = campaign.milestones.find(m => m.id === milestoneId);
      if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`);

      previousStatus = milestone.status;
      milestoneTitle = milestone.title;
      campaignTraceContext = campaign.traceContext;

      const allowed = MILESTONE_TRANSITIONS[milestone.status];
      if (!allowed || !allowed.includes(newStatus)) {
        throw new Error(`Invalid milestone transition: ${milestone.status} → ${newStatus}`);
      }

      // Auto-pause interception: if transitioning to 'active' and milestone requires approval,
      // automatically transition to 'waiting_approval' instead and pause the campaign
      if (newStatus === 'active' && milestone.requireApproval === true) {
        newStatus = 'waiting_approval';
        autoPaused = true;
        milestone.approvalState = 'pending';
        milestone.approvalRequestedAt = new Date().toISOString();
        milestone.approverId = null;
        milestone.approvalReason = reason || 'Auto-paused for approval';
        // Set campaign status to awaiting_approval to halt further task processing
        if (campaign.status === 'active') {
          campaign.status = 'awaiting_approval';
        }
      }

      // OTel: Check if we need to create a span when transitioning to active
      if (newStatus === 'active' && !milestone.traceContext) {
        shouldCreateSpan = true;
      }

      milestone.status = newStatus;
      milestone.updatedAt = new Date().toISOString();
      if (newStatus === 'completed' || newStatus === 'failed') {
        milestone.completedAt = milestone.updatedAt;
      }

      campaign.updatedAt = milestone.updatedAt;
      return d;
    });

    // OTel: Create child span under campaign root span when milestone becomes active
    if (shouldCreateSpan && campaignTraceContext) {
      const span = startSpan('milestone.lifecycle', {
        milestoneId,
        milestoneTitle,
        campaignId,
      }, campaignTraceContext);

      // Store spanContext for child spans (tasks) to reference
      this._saveWithRetry(projectId, (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        const ms = campaign?.milestones.find(m => m.id === milestoneId);
        if (ms) {
          ms.traceContext = span.spanContext();
        }
        return d;
      });

      // Keep span in memory for adding events and ending on completion
      activeMilestoneSpans.set(milestoneId, span);
    }

    // OTel: Add span event for status transition
    const span = activeMilestoneSpans.get(milestoneId);
    if (span) {
      addSpanEvent(span, 'milestone_status_change', {
        from: previousStatus,
        to: newStatus,
        reason: reason || `Status: ${newStatus}`,
      });

      // End span on terminal states
      if (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'skipped') {
        endSpan(span, { success: newStatus === 'completed' });
        activeMilestoneSpans.delete(milestoneId);
      }
    }

    this._appendEvent(projectId, {
      action: 'milestone_status_changed',
      campaignId,
      milestoneId,
      agent: 'system',
      reason: reason || `Status: ${newStatus}`,
    });

    // Auto-pause logic: if we intercepted an activation and paused for approval
     if (autoPaused) {
       // Create checkpoint to persist state
       if (this.checkpointManager) {
         try {
           this.checkpointManager.createCheckpoint({
             projectId,
             campaignId,
             taskId: null,
             subtaskId: null,
           });
         } catch (checkpointErr) {
           log.warn('Checkpoint creation failed on auto-pause (non-blocking)', {
             projectId,
             campaignId,
             milestoneId,
             error: checkpointErr.message,
           });
         }
       }

       // Emit PAUSED event for monitoring
       if (this._onEvent) {
         this._onEvent('campaign:approval_requested', { projectId, campaignId, milestoneId, reason: 'Auto-paused for approval' });
         this._onEvent('campaign:milestone_paused', { projectId, campaignId, milestoneId });
         this._onEvent('campaign:status_changed', { projectId, campaignId, status: 'awaiting_approval' });
       }

       // Append approval_requested event and campaign status change
       this._appendEvent(projectId, {
         action: 'approval_requested',
         campaignId,
         milestoneId,
         agent: 'system',
         reason: 'Auto-paused for approval',
       });
       this._appendEvent(projectId, {
         action: 'campaign_status_changed',
         campaignId,
         agent: 'system',
         reason: 'Campaign paused awaiting approval for milestone',
       });
     } else {
      // Normal event emission for non-auto-pause transitions
      if (this._onEvent) {
        if (newStatus === 'completed') {
          this._onEvent('campaign:milestone_completed', { projectId, campaignId, milestoneId });
        } else if (newStatus === 'active') {
          this._onEvent('campaign:milestone_activated', { projectId, campaignId, milestoneId });
        }
      }
    }

    this._renderCampaignMd(projectId);

    // Re-fetch to get the latest state including traceContext from second save
    const finalData = this.load(projectId);
    return finalData.campaigns.find(c => c.id === campaignId)
      ?.milestones.find(m => m.id === milestoneId);
  }

  requestApproval(projectId, campaignId, milestoneId, reason, userId = null) {
    const now = new Date().toISOString();
    let previousStatus = null;

    this._saveWithRetryScoped(projectId, userId,
      (d) => d.campaigns.find(c => c.id === campaignId),
      (d) => {
        const campaign = d.campaigns.find(c => c.id === campaignId);
        if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

        const milestone = campaign.milestones.find(m => m.id === milestoneId);
        if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`);

        if (!milestone.requireApproval) {
          throw new Error(`Milestone ${milestoneId} does not require approval`);
        }

        previousStatus = milestone.status;
        milestone.status = 'waiting_approval';
        milestone.approvalState = 'pending';
        milestone.approvalRequestedAt = now;
        milestone.approverId = null;
        milestone.approvalReason = reason || null;
        milestone.updatedAt = now;

        campaign.updatedAt = now;
        return d;
      });

    // Create checkpoint to persist state across restarts
    if (this.checkpointManager) {
      try {
        this.checkpointManager.createCheckpoint({
          projectId,
          campaignId,
          taskId: null,
          subtaskId: null,
        });
      } catch (checkpointErr) {
        log.warn('Checkpoint creation failed on approval request (non-blocking)', {
          projectId,
          campaignId,
          milestoneId,
          error: checkpointErr.message,
        });
      }
    }

    this._appendEvent(projectId, {
      action: 'approval_requested',
      campaignId,
      milestoneId,
      agent: userId || 'system',
      reason: reason || 'Approval requested',
    });

    if (this._onEvent) {
      this._onEvent('campaign:approval_requested', { projectId, campaignId, milestoneId, reason });
      this._onEvent('campaign:milestone_paused', { projectId, campaignId, milestoneId });
    }

    this._renderCampaignMd(projectId);
  }

 approveMilestone(projectId, campaignId, milestoneId, reason, userId = null) {
     const now = new Date().toISOString();
     let previousApprovalState = null;

     this._saveWithRetryScoped(projectId, userId,
       (d) => d.campaigns.find(c => c.id === campaignId),
       (d) => {
         const campaign = d.campaigns.find(c => c.id === campaignId);
         if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

         const milestone = campaign.milestones.find(m => m.id === milestoneId);
         if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`);

         if (milestone.status !== 'waiting_approval') {
           throw new Error(`Milestone ${milestoneId} is not waiting for approval (current status: ${milestone.status})`);
         }

         if (milestone.approvalState !== 'pending') {
           throw new Error(`Milestone ${milestoneId} approvalState is not 'pending' (current state: ${milestone.approvalState})`);
         }

         previousApprovalState = milestone.approvalState;
         milestone.approvalState = 'approved';
         milestone.approverId = userId || 'system';
         milestone.approvalReason = reason || null;
         milestone.status = 'active';
         milestone.updatedAt = now;

         // Resume campaign from awaiting_approval state
         if (campaign.status === 'awaiting_approval') {
           campaign.status = 'active';
         }
         campaign.updatedAt = now;
         return d;
       });

     this._appendEvent(projectId, {
       action: 'approval_granted',
       campaignId,
       milestoneId,
       agent: userId || 'system',
       reason: reason || 'Approval granted',
     });

     // Append campaign status change event if resumed
     this._appendEvent(projectId, {
       action: 'campaign_status_changed',
       campaignId,
       agent: userId || 'system',
       reason: 'Campaign resumed after approval',
     });

     if (this._onEvent) {
       this._onEvent('campaign:approval_granted', { projectId, campaignId, milestoneId, approverId: userId, reason });
       this._onEvent('campaign:status_changed', { projectId, campaignId, status: 'active' });
       this._onEvent('campaign:milestone_activated', { projectId, campaignId, milestoneId });
     }

     this._renderCampaignMd(projectId);
   }

rejectMilestone(projectId, campaignId, milestoneId, reason, userId = null) {
     const now = new Date().toISOString();

     this._saveWithRetryScoped(projectId, userId,
       (d) => d.campaigns.find(c => c.id === campaignId),
       (d) => {
         const campaign = d.campaigns.find(c => c.id === campaignId);
         if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

         const milestone = campaign.milestones.find(m => m.id === milestoneId);
         if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`);

         if (milestone.status !== 'waiting_approval') {
           throw new Error(`Milestone ${milestoneId} is not waiting for approval (current status: ${milestone.status})`);
         }

         milestone.approvalState = 'rejected';
         milestone.approverId = userId || 'system';
         milestone.approvalReason = reason || null;
         milestone.status = 'pending';
         milestone.updatedAt = now;

         // Resume campaign from awaiting_approval state
         if (campaign.status === 'awaiting_approval') {
           campaign.status = 'active';
         }
         campaign.updatedAt = now;
         return d;
       });

     this._appendEvent(projectId, {
       action: 'approval_rejected',
       campaignId,
       milestoneId,
       agent: userId || 'system',
       reason: reason || 'Approval rejected',
     });

     // Append campaign status change event if resumed
     this._appendEvent(projectId, {
       action: 'campaign_status_changed',
       campaignId,
       agent: userId || 'system',
       reason: 'Campaign resumed after approval rejection',
     });

     if (this._onEvent) {
       this._onEvent('campaign:approval_rejected', { projectId, campaignId, milestoneId, approverId: userId, reason });
       this._onEvent('campaign:status_changed', { projectId, campaignId, status: 'active' });
     }

     this._renderCampaignMd(projectId);
   }

  linkTaskToMilestone(projectId, campaignId, milestoneId, taskId) {
    this._saveWithRetry(projectId, (d) => {
      const campaign = d.campaigns.find(c => c.id === campaignId);
      if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

      const milestone = campaign.milestones.find(m => m.id === milestoneId);
      if (!milestone) throw new Error(`Milestone not found: ${milestoneId}`);

      if (!milestone.tasks.includes(taskId)) {
        milestone.tasks.push(taskId);
        milestone.updatedAt = new Date().toISOString();
        campaign.updatedAt = milestone.updatedAt;
      }
      return d;
    });

    this._appendEvent(projectId, {
      action: 'task_linked',
      campaignId,
      milestoneId,
      taskId,
      agent: 'system',
      reason: `Task ${taskId} linked to milestone ${milestoneId}`,
    });
  }

  // --- Progress Tracking ---

  /**
   * Check milestone progress by examining linked task statuses.
   * @param {TaskManager} taskManager - the task manager instance
   */
  checkMilestoneProgress(projectId, campaignId, milestoneId, taskManager) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return null;

    const milestone = campaign.milestones.find(m => m.id === milestoneId);
    if (!milestone) return null;

    let total = 0, done = 0, failed = 0, executing = 0;
    for (const taskId of milestone.tasks) {
      const task = taskManager.getTask(projectId, taskId);
      if (!task) continue;
      total++;
      if (task.status === 'done' || task.status === 'completed') done++;
      else if (task.status === 'failed') failed++;
      else if (['queued', 'planning', 'executing', 'reviewing'].includes(task.status)) executing++;
    }

    return { total, done, failed, executing };
  }

  /**
   * Check if a milestone is complete (all linked tasks done).
   */
  isMilestoneComplete(projectId, campaignId, milestoneId, taskManager) {
    const progress = this.checkMilestoneProgress(projectId, campaignId, milestoneId, taskManager);
    if (!progress || progress.total === 0) return false;
    return progress.done === progress.total;
  }

  /**
   * Check if a milestone has unrecoverable failures.
   */
  isMilestoneFailed(projectId, campaignId, milestoneId, taskManager) {
    const progress = this.checkMilestoneProgress(projectId, campaignId, milestoneId, taskManager);
    if (!progress) return false;
    // Failed if all tasks are terminal and some failed
    const allTerminal = (progress.done + progress.failed) === progress.total;
    return allTerminal && progress.failed > 0;
  }

  /**
   * Get the first milestone that is active or the first pending milestone with no blockers.
   */
  getActiveMilestone(projectId, campaignId) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return null;

    // First: return any explicitly active milestone
    const active = campaign.milestones.find(m => m.status === 'active');
    if (active) return active;

    // Second: return first pending milestone whose blockers are all completed/skipped
    return this.getNextUnblockedMilestone(projectId, campaignId);
  }

  /**
   * Get the next pending milestone whose blockers are all resolved.
   */
  getNextUnblockedMilestone(projectId, campaignId) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return null;

    const completedOrSkipped = new Set(
      campaign.milestones
        .filter(m => m.status === 'completed' || m.status === 'skipped')
        .map(m => m.id)
    );

    // Sort by order, then by creation time
    const pending = campaign.milestones
      .filter(m => m.status === 'pending')
      .sort((a, b) => (a.order - b.order) || (new Date(a.createdAt) - new Date(b.createdAt)));

    for (const ms of pending) {
      const blocked = ms.blockedBy.some(depId => !completedOrSkipped.has(depId));
      if (!blocked) return ms;
    }

    return null;
  }

  /**
   * Find which campaign a task belongs to (by taskId in any milestone).
   */
  findCampaignByTask(projectId, taskId) {
    const data = this.load(projectId);
    for (const campaign of data.campaigns) {
      if (campaign.status !== 'active') continue;
      for (const ms of campaign.milestones) {
        if (ms.tasks.includes(taskId)) return campaign;
      }
    }
    return null;
  }

  /**
   * Find which milestone a task belongs to.
   */
  findMilestoneByTask(projectId, campaignId, taskId) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return null;
    return campaign.milestones.find(m => m.tasks.includes(taskId)) || null;
  }

  // --- Context Generation ---

  /**
   * Format campaign context for injection into agent prompts.
   * Agents see the big picture when working on campaign tasks.
   */
  formatCampaignContext(projectId, campaignId) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return null;

    const completed = campaign.milestones.filter(m => m.status === 'completed');
    const active = campaign.milestones.find(m => m.status === 'active');
    const pending = campaign.milestones.filter(m => m.status === 'pending');
    const total = campaign.milestones.length;
    const doneCount = completed.length;

    const lines = [
      `=== CAMPAIGN: ${campaign.title} ===`,
      `Goal: ${campaign.doneCriteria || campaign.description}`,
      `Progress: ${doneCount}/${total} milestones complete`,
    ];

    if (campaign.contingency) {
      lines.push(`Contingency: ${campaign.contingency}`);
    }

    if (completed.length > 0) {
      lines.push('', 'Completed:');
      for (const ms of completed) {
        lines.push(`  [x] ${ms.title}`);
      }
    }

    if (active) {
      lines.push('', `Current milestone: ${active.title}`);
      if (active.doneCriteria) lines.push(`  Done when: ${active.doneCriteria}`);
      if (active.contingency) lines.push(`  If blocked: ${active.contingency}`);
    }

    const nextUp = pending.sort((a, b) => a.order - b.order)[0];
    if (nextUp && nextUp !== active) {
      const blockerText = nextUp.blockedBy.length > 0
        ? ` (blocked by ${nextUp.blockedBy.join(', ')})`
        : '';
      lines.push(``, `Up next: ${nextUp.title}${blockerText}`);
    }

    lines.push('=== END CAMPAIGN ===');
    return lines.join('\n');
  }

  /**
   * Format campaign summary for CLI display.
   */
  formatCampaignSummary(projectId, campaignId) {
    const campaign = this.getCampaign(projectId, campaignId);
    if (!campaign) return `Campaign not found: ${campaignId}`;

    const total = campaign.milestones.length;
    const done = campaign.milestones.filter(m => m.status === 'completed').length;
    const failed = campaign.milestones.filter(m => m.status === 'failed').length;
    const active = campaign.milestones.find(m => m.status === 'active');

    // Progress bar
    const barLen = 20;
    const filled = total > 0 ? Math.round((done / total) * barLen) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

    const lines = [
      `**${campaign.title}** [${campaign.status.toUpperCase()}]`,
      `ID: \`${campaign.id}\``,
      `Goal: ${campaign.doneCriteria || campaign.description}`,
      campaign.contingency ? `Contingency: ${campaign.contingency}` : null,
      `Progress: [${bar}] ${done}/${total} milestones${failed > 0 ? ` (${failed} failed)` : ''}`,
      `Created: ${campaign.createdAt?.split('T')[0]}`,
      campaign.lastReviewAt ? `Last review: ${campaign.lastReviewAt?.split('T')[0]}` : null,
      campaign.nextAction ? `Next action: ${campaign.nextAction}` : null,
    ].filter(Boolean);

    if (campaign.milestones.length > 0) {
      lines.push('', '**Milestones:**');
      const sorted = [...campaign.milestones].sort((a, b) => a.order - b.order);
      for (const ms of sorted) {
        const icon = ms.status === 'completed' ? '[x]' :
                     ms.status === 'failed' ? '[!]' :
                     ms.status === 'active' ? '[~]' :
                     ms.status === 'skipped' ? '[-]' : '[ ]';
        const taskCount = ms.tasks.length > 0 ? ` (${ms.tasks.length} tasks)` : '';
        const blockerText = ms.blockedBy.length > 0 ? ` blocked by: ${ms.blockedBy.join(', ')}` : '';
        lines.push(`${icon} ${ms.title}${taskCount}${blockerText}`);
        if (ms.doneCriteria) lines.push(`    Done when: ${ms.doneCriteria}`);
        if (ms.contingency) lines.push(`    If blocked: ${ms.contingency}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format compact campaign list for /campaign command.
   */
  formatCampaignList(projectId) {
    const data = this.load(projectId);
    if (data.campaigns.length === 0) return 'No campaigns.';

    const lines = ['**Campaigns**'];
    for (const c of data.campaigns) {
      const total = c.milestones.length;
      const done = c.milestones.filter(m => m.status === 'completed').length;
      const barLen = 10;
      const filled = total > 0 ? Math.round((done / total) * barLen) : 0;
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
      const statusTag = c.status === 'active' ? '' : ` [${c.status.toUpperCase()}]`;
      lines.push(`[${bar}] \`${c.id}\` — ${c.title} (${done}/${total})${statusTag}`);
    }
    return lines.join('\n');
  }

  // --- Rendering ---

  _renderCampaignMd(projectId) {
    const data = this.load(projectId);
    if (data.campaigns.length === 0) return;

    const active = data.campaigns.filter(c => c.status === 'active' || c.status === 'paused' || c.status === 'needs_review');
    const queued = data.campaigns.filter(c => c.status === 'queued');
    const completed = data.campaigns.filter(c => c.status === 'completed' || c.status === 'failed');

    const lines = ['# Campaign Progress', '', '*Auto-generated from campaigns.json — do not edit manually.*', ''];

    const renderCampaign = (campaign) => {
      const total = campaign.milestones.length;
      const done = campaign.milestones.filter(m => m.status === 'completed').length;
      const statusIcon = campaign.status === 'completed' ? '[x]' :
                         campaign.status === 'failed' ? '[!]' :
                         campaign.status === 'paused' ? '[=]' :
                         campaign.status === 'queued' ? '[>]' : '[~]';

      const priorityTag = campaign.priority && campaign.priority !== 'normal' ? ` [${campaign.priority}]` : '';
      lines.push(`## ${statusIcon} ${campaign.title}${priorityTag}`);
      let statusLine = `Status: ${campaign.status} | Progress: ${done}/${total} milestones | Created: ${campaign.createdAt?.split('T')[0] || 'unknown'}`;
      if (campaign.completedAt) statusLine += ` | Completed: ${campaign.completedAt.split('T')[0]}`;
      lines.push(statusLine);
      if (campaign.doneCriteria) lines.push(`Goal: ${campaign.doneCriteria}`);
      if (campaign.contingency) lines.push(`Contingency: ${campaign.contingency}`);
      if (campaign.nextAction) lines.push(`Next: ${campaign.nextAction}`);
      if (campaign.closeoutSummary) {
        lines.push('');
        lines.push('**Structured Summary:**');
        if (typeof campaign.closeoutSummary === 'string') {
          lines.push(campaign.closeoutSummary);
        } else {
          const summary = campaign.closeoutSummary;
          lines.push(`Duration: ${summary.duration?.totalMs ? Math.round(summary.duration.totalMs / 60000) : 0} minutes`);
          lines.push(`Milestones: ${summary.outcomeBreakdown?.completed || 0} completed, ${summary.outcomeBreakdown?.failed || 0} failed, ${summary.outcomeBreakdown?.skipped || 0} skipped`);
          lines.push(`Subtasks: ${summary.outcomeBreakdown?.subtasksDone || 0} done, ${summary.outcomeBreakdown?.subtasksFailed || 0} failed`);
          if (summary.learnings && summary.learnings.length > 0) {
            lines.push('');
            lines.push('Learnings:');
            for (const lrn of summary.learnings.slice(0, 5)) {
              lines.push(`- ${lrn.pattern || lrn}`);
            }
          }
        }
      }
      if (campaign.closeoutMarkdown) {
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push('**Strategic Review (LLM):**');
        lines.push(campaign.closeoutMarkdown);
      }
      lines.push('');

      const sorted = [...campaign.milestones].sort((a, b) => a.order - b.order);
      for (const ms of sorted) {
        const msIcon = ms.status === 'completed' ? '[x]' :
                       ms.status === 'failed' ? '[!]' :
                       ms.status === 'active' ? '[~]' :
                       ms.status === 'skipped' ? '[-]' : '[ ]';
        lines.push(`### ${msIcon} ${ms.title}`);
        let msStatusLine = `Status: ${ms.status}`;
        if (ms.tasks.length > 0) msStatusLine += ` | Tasks: ${ms.tasks.length}`;
        if (ms.blockedBy.length > 0) msStatusLine += ` | Blocked by: ${ms.blockedBy.join(', ')}`;
        lines.push(msStatusLine);
        if (ms.doneCriteria) lines.push(`Done when: ${ms.doneCriteria}`);
        if (ms.contingency) lines.push(`If blocked: ${ms.contingency}`);
        lines.push('');
      }
    };

    if (active.length > 0) {
      for (const campaign of active) renderCampaign(campaign);
    }

    if (queued.length > 0) {
      lines.push('---', '', '# Queued Campaigns', '');
      for (const campaign of queued) renderCampaign(campaign);
    }

    if (completed.length > 0) {
      lines.push('---', '', '# Completed Campaigns', '');
      for (const campaign of completed) renderCampaign(campaign);
    }

    const mdPath = this._campaignsMdPath(projectId);
    try {
      writeFileSync(mdPath, lines.join('\n'));
    } catch (err) {
      log.warn('Failed to write CAMPAIGNS.md', { projectId, path: mdPath, error: err.message });
    }
  }
}
