// Autonomous task system — CAS-protected task lifecycle with event logging.
// Council-designed v1: deterministic assignment, heartbeat-driven execution.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { computeBackoffWithJitter } from './utils/backoff.js';
import { createLogger } from './logger.js';
import config from './config.js';
import { DeliberationProtocol } from './orchestrator/deliberation-protocol.js';
import { getDb, rowToTask, rowToSubtask, persistTasks } from './orchestrator/state-db.js';

const log = createLogger('tasks');

const MAX_CAS_RETRIES = 3;
const SUBTASK_COOLDOWN_MS = 300000; // 5 minute cooldown for failed agents
const SCHEMA_VERSION = '1';

// Valid status transitions (state machine)
const TASK_TRANSITIONS = {
  queued:    ['planning', 'executing', 'deferred', 'cancelled', 'failed'],  // executing: delegation tasks arrive pre-planned
  planning:  ['executing', 'deferred', 'failed', 'cancelled', 'queued'],
  executing: ['reviewing', 'deferred', 'failed', 'cancelled', 'planning'], // planning = interject
  reviewing: ['done', 'executing', 'failed', 'cancelled', 'sleeping'],  // sleeping = daemon cycle complete
  done:      [],
  sleeping:  ['planning', 'executing', 'cancelled', 'failed'],  // daemon: sleep → next cycle
  failed:    ['queued'],  // manual retry
  deferred:  ['queued', 'planning', 'cancelled', 'failed'],
  cancelled: [],
};

const SUBTASK_TRANSITIONS = {
  queued:    ['claimed'],
  claimed:   ['executing', 'queued'],  // queued = unclaim/timeout
  executing: ['done', 'failed'],
  done:      [],
  failed:    ['queued'],  // requeue once
};

// Integrity guard — auto-repairs subtask invariants before persistence.
// Previously threw on violations, which blocked ALL saves in the project
// and caused cascading failures. Now repairs and logs warnings.
function validateTaskIntegrity(task) {
  if (!task || typeof task !== 'object') throw new Error('Task integrity check failed: task missing');
  if (!task.id) throw new Error('Task integrity check failed: missing task.id');
  if (!TASK_TRANSITIONS[task.status] && !['done', 'failed', 'cancelled'].includes(task.status)) {
    throw new Error(`Task integrity check failed: invalid status '${task.status}' for ${task.id}`);
  }

  for (const st of task.subtasks || []) {
    if (!st.id) throw new Error(`Task integrity check failed: subtask without id in ${task.id}`);
    
    // Auto-repair: invalid subtask statuses (e.g., 'pending') → convert to 'queued'
    if (!SUBTASK_TRANSITIONS[st.status] && !['done', 'failed'].includes(st.status)) {
      console.warn(`Auto-repair: invalid subtask status '${st.status}' → 'queued' on ${task.id}/${st.id}`);
      st.status = 'queued';
      delete st.completedAt;
      delete st.completedBy;
      delete st.assignee;
      delete st.claimedAt;
      delete st.claimedBy;
      delete st.claimedUntil;
    }

    // Auto-repair: terminal subtasks must have completedAt
    const isTerminal = st.status === 'done' || st.status === 'failed';
    if (isTerminal && !st.completedAt) {
      st.completedAt = new Date().toISOString();
    }

    // Auto-repair: non-terminal subtasks must not have completedAt
    if (!isTerminal && st.completedAt) {
      delete st.completedAt;
      delete st.completedBy;
    }

    // Auto-repair: queued subtasks must not retain claims/assignees
    if (st.status === 'queued' && (st.assignee || st.claimedUntil)) {
      delete st.assignee;
      delete st.claimedAt;
      delete st.claimedBy;
      delete st.claimedUntil;
    }
  }
}

export const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);
const NON_TERMINAL_SUBTASK_STATUSES = new Set(['queued', 'claimed', 'executing']);
export const KNOWN_TASK_CATEGORIES = new Set([
  'general',
  'dev',
  'ops',
  'implementation',
  'research',
  'review',
  'review_request',
  'design_decision',
  'architecture_design',
  'architecture_decision',
  'code_review',
  'status_check',
  'question',
  'simple_response',
  'delegation',
]);

function normalizeTaskCategory(taskCategory) {
  if (taskCategory === undefined || taskCategory === null) return null;
  const normalized = String(taskCategory).trim();
  return normalized || null;
}

export function normalizeSuggestedRole(role) {
  if (!role) return null;
  const normalized = String(role).trim().toLowerCase();
  if (normalized === 'executor') return 'implementer';
  return normalized;
}

function hasNonTerminalSubtasks(task) {
  return (task?.subtasks || []).some(st => NON_TERMINAL_SUBTASK_STATUSES.has(st?.status));
}

// Fallback routing patterns by provider (used when agent has no skills defined)
const PROVIDER_ROUTING = {
  ollama: /\b(implement|code|fix|bug|refactor|test|debug|build|patch|migrate|deploy|configure|setup|ship|create|write|modify|edit)\b/i,
  codex:  /\b(implement|code|fix|bug|refactor|test|audit|debug|build|patch|migrate|deploy)\b/i,
  claude: /\b(analyze|document|explain|review|design|plan|draft|summarize|assess|audit)\b/i,
  gemini: /\b(research|search|find|compare|explore|investigate|scan|benchmark|survey)\b/i,
};

// Provider cost tiers — lower = preferred for autonomous work.
// Protects expensive/rate-limited providers (claude) from being burned on subtasks.
// When multiple agents match by skill, prefer the cheapest available.
export const PROVIDER_COST_TIER = {
  ollama: 0,   // free, unlimited (local GPU)
  codex:  1,   // $20/mo flat, generous limits
  gemini: 1,   // free tier or cheap sub
  claude: 2,   // $200/mo flat, 4x rate — fallback tier for unknown Claude agents
};

// Cost tier labels for API responses
export const COST_TIER_LABELS = {
  0: 'free',
  1: 'low',
  2: 'high',
};

// Per-agent cost tiers — override provider-level tier for model-differentiated
// agents. Empty by default: per-agent overrides belong in the operator's own
// deployment (agents not listed fall back to PROVIDER_COST_TIER[provider]).
export const AGENT_COST_TIER = {};

export function getAgentCostTier(agentId, provider) {
  if (AGENT_COST_TIER[agentId] !== undefined) return AGENT_COST_TIER[agentId];
  return PROVIDER_COST_TIER[provider] ?? 1;
}

/**
 * Parse /task commands from user input.
 * Returns { command, args } or null.
 */
export function parseTaskCommand(text) {
  const trimmed = text.trim();

  if (trimmed === '/task' || trimmed === '/task list') {
    return { command: 'list', args: null };
  }

  // Handle hyphenated commands: /task create-daemon → command 'create-daemon'
  const match = trimmed.match(/^\/task\s+([\w-]+)(?:\s+(.+))?$/s);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || null;
  const valid = ['create', 'create-daemon', 'list', 'show', 'cancel', 'interject', 'retry', 'status', 'pause', 'resume', 'done', 'fail'];
  if (!valid.includes(command)) return null;

  return { command, args };
}

const COMPLEXITY_RANK = { low: 1, medium: 2, high: 3 };

function applyComplexityGate(agentIds, agentMap, complexity, complexityGate) {
  if (!complexityGate || !complexity) return agentIds;
  const rank = COMPLEXITY_RANK[complexity] || 2;
  return agentIds.filter(id => {
    const provider = agentMap[id]?.provider;
    const maxComplexity = complexityGate[provider];
    if (!maxComplexity) return true; // no gate = unrestricted
    return rank <= (COMPLEXITY_RANK[maxComplexity] || 2);
  });
}

/**
 * Determine which agent should handle a subtask.
 * Complexity-aware routing with configurable priority order and complexity gating.
 *
 * Priority logic:
 *   1. If subtask has suggestedRole + complexity from planner, route by role+complexity:
 *      - implementer → cheapest eligible by cost tier (complexity gate applied);
 *        implementerPriority is DEPRECATED — cost tier IS the priority
 *      - reviewer → Clara (reviewer role), then any Claude
 *      - architect → Clarence
 *      - researcher → Gem (Gemini)
 *   2. Fallback: skill match with cost-tier tiebreak (existing logic)
 *   3. Last resort: cheapest available
 *
 * @param {string} subtaskText - the subtask description
 * @param {string[]} availableAgentIds - agent IDs that aren't cooling down
 * @param {Object} agentMap - { id: agentInstance } map (agents must have .skills and .provider)
 * @param {Object} [subtaskMeta] - optional { complexity, suggestedRole } from planner
 * @param {Function} [permissionFilter] - optional permission filter function
 * @param {Object} [taskConfig] - optional { implementerPriority, complexityGate } from config.tasks
 * Returns agent id.
 */
export function routeSubtask(subtaskText, availableAgentIds, agentMap = {}, subtaskMeta = {}, permissionFilter = null, taskConfig = null, scoreboard = null, contributorAgentIds = [], taskCategory = null, isAgentCoolingDown = null, circuitBreaker = null, busyAgents = null) {
  const { complexity = 'medium', suggestedRole = null, failedProviders = [] } = subtaskMeta;
  const normalizedRole = normalizeSuggestedRole(suggestedRole);

  // Governors are reserved for governance workflows — never route regular subtasks to them.
  availableAgentIds = availableAgentIds.filter(id => agentMap[id]?.role !== 'governor');

  // Apply permission filter first (Layer 1 — routing constraint)
  if (permissionFilter) {
    const eligible = permissionFilter(availableAgentIds, 'task:execute', agentMap);
    if (eligible.length > 0) availableAgentIds = eligible;
  }

  // Exclude providers that already failed this subtask (escalation)
  if (failedProviders && failedProviders.length > 0) {
    const filtered = availableAgentIds.filter(id => !failedProviders.includes(agentMap[id]?.provider));
    if (filtered.length > 0) availableAgentIds = filtered;
    // If all filtered out, fall through with original set (last resort)
  }

  // Apply complexity gate (filter out agents that can't handle this complexity)
  if (taskConfig?.complexityGate) {
    const gated = applyComplexityGate(availableAgentIds, agentMap, complexity, taskConfig.complexityGate);
    if (gated.length > 0) availableAgentIds = gated;
    // If all agents gated out, fall through with original set (graceful degradation)
  }

  // Apply complexity gate (filter out agents that can't handle this complexity)
  if (taskConfig?.complexityGate) {
    const gated = applyComplexityGate(availableAgentIds, agentMap, complexity, taskConfig.complexityGate);
    if (gated.length > 0) availableAgentIds = gated;
    // If all agents gated out, fall through with original set (graceful degradation)
  }

  // === REVIEWER SELECTION LOGIC (when suggestedRole is 'reviewer') ===
  if (normalizedRole === 'reviewer') {
    const contributorIdsSet = new Set(contributorAgentIds);

    const contributorModels = new Set(
      contributorAgentIds
        .map(id => agentMap[id]?.model)
        .filter(Boolean)
    );
    const contributorProviders = new Set(
      contributorAgentIds
        .map(id => agentMap[id]?.provider)
        .filter(Boolean)
    );

    const isReviewerEligible = ([id, a]) =>
      !!a &&
      (!a._status || a._status === 'active') &&
      // Operator's explicit "never review" — the code:review deny checkbox.
      !(a._denyActions || []).includes('code:review') &&
      (!busyAgents || !busyAgents.has(id)) && // busyAgents can be null if not passed
      (!isAgentCoolingDown || !isAgentCoolingDown(id)) && // isAgentCoolingDown can be null
      (!circuitBreaker || circuitBreaker.canRequest(id)); // circuitBreaker can be null

    // An explicit code:review grant promotes the agent to the preferred
    // reviewer tier without requiring a role change — the positive half of
    // the same checkbox.
    const isPreferredReviewer = ([id, a]) => a.role === 'reviewer' || a.provider === 'ollama'
      || (a._permissions || []).includes('code:review');

    const sortReviewerCandidates = ([aId, a], [bId, b]) => {
      // Prioritize agents whose skills match the taskCategory
      // If taskCategory is not provided, this will have no effect on sorting
      const aSkillMatch = (a.skills || []).includes(taskCategory) ? 0 : 1;
      const bSkillMatch = (b.skills || []).includes(taskCategory) ? 0 : 1;
      if (aSkillMatch !== bSkillMatch) return aSkillMatch - bSkillMatch;

      // Prefer cross-provider reviewers
      const aCrossProvider = contributorProviders.has(a.provider) ? 0 : 1;
      const bCrossProvider = contributorProviders.has(b.provider) ? 0 : 1;
      if (bCrossProvider !== aCrossProvider) return bCrossProvider - aCrossProvider;

      // Prefer cross-model reviewers
      const aCrossModel = contributorModels.has(a.model) ? 0 : 1;
      const bCrossModel = contributorModels.has(b.model) ? 0 : 1;
      if (bCrossModel !== aCrossModel) return bCrossModel - aCrossModel;

      return aId.localeCompare(bId);
    };

    const eligibleAgents = Object.entries(agentMap).filter(([id]) => availableAgentIds.includes(id));

    const preferredExcludingContributors = eligibleAgents
      .filter(isReviewerEligible)
      .filter(isPreferredReviewer)
      .filter(([id]) => !contributorIdsSet.has(id))
      .sort(sortReviewerCandidates);

    const crossModelReviewers = preferredExcludingContributors
      .filter(([, a]) => !contributorModels.has(a.model));
    const sameModelFallbackReviewers = preferredExcludingContributors
      .filter(([, a]) => contributorModels.has(a.model));

    // Tier 3: any eligible non-contributor (any role) — exhausted before falling back to same-agent.
    const anyNonContributorReviewers = eligibleAgents
      .filter(isReviewerEligible)
      .filter(([id, a]) => !contributorIdsSet.has(id) && a.role !== 'governor') // allow architects as reviewers here
      .sort(sortReviewerCandidates);

    // Last resort: allow same-agent review only when NO independent agent is available.
    const sameAgentLastResortReviewers = eligibleAgents
      .filter(isReviewerEligible)
      .filter(isPreferredReviewer)
      .filter(([id]) => contributorIdsSet.has(id))
      .sort(sortReviewerCandidates);

    const reviewerEntry =
      crossModelReviewers[0] ||
      sameModelFallbackReviewers[0] ||
      anyNonContributorReviewers[0] ||
      sameAgentLastResortReviewers[0] ||
      null;

    if (reviewerEntry) {
      return reviewerEntry[0];
    }
  }
  // === END REVIEWER SELECTION LOGIC ===

  // Phase 1: Cookies on the table — cheapest eligible agent picks up the task.
  //   Eligibility = role can do the work + complexity gate (already applied above).
  //   No hardcoded provider waterfalls — cost tier IS the priority.
  //   Complexity gate controls which tasks an agent can pick up; dial it back via
  //   config (e.g. SYNAPSE_TASK_OLLAMA_MAX_COMPLEXITY=medium) to restrict struggling agents.
  if (normalizedRole) {
    const byRole = (role) => availableAgentIds.filter(id => agentMap[id]?.role === role);
    const cheapestOf = (ids) => {
      if (!ids.length) return null;
      return ids.sort((a, b) => {
        const ta = getAgentCostTier(a, agentMap[a]?.provider);
        const tb = getAgentCostTier(b, agentMap[b]?.provider);
        if (ta !== tb) return ta - tb;
        // Tiebreaker: prefer agent with higher success rate from scoreboard
        if (scoreboard) {
          const sa = scoreboard.getScore(a)?.successRate ?? 0.5;
          const sb = scoreboard.getScore(b)?.successRate ?? 0.5;
          if (sa !== sb) return sb - sa;
        }
        return 0;
      })[0];
    };

    // Implementers = developer + reviewer roles (reviewers are developers with extra duties)
    const allImplementers = () => availableAgentIds.filter(id =>
      ['developer', 'reviewer'].includes(agentMap[id]?.role)
    );

    let candidate = null;

    if (normalizedRole === 'implementer') {
      candidate = cheapestOf(allImplementers());
    } else if (normalizedRole === 'reviewer') {
      // Reviewer tasks: prefer reviewer-role agents, fall back to any implementer
      candidate = cheapestOf(byRole('reviewer'))
        || cheapestOf(allImplementers());
    } else if (normalizedRole === 'architect') {
      // Architect tasks: prefer architect-role agents, fall back to cheapest implementer
      candidate = cheapestOf(byRole('architect'))
        || cheapestOf(allImplementers());
    } else if (normalizedRole === 'researcher') {
      candidate = cheapestOf(byRole('researcher'))
        || cheapestOf(allImplementers());
    }

    if (candidate) return candidate;
  }

  // Phase 2 & 3 use the general pool only — architects handle planning, not implementation fallback.
  const generalPool = availableAgentIds.filter(id => agentMap[id]?.role !== 'architect');

  // Phase 2: Skill match with cost-tier tiebreak (fallback when no role metadata)
  const lower = subtaskText.toLowerCase();
  const scored = [];
  for (const id of generalPool) {
    const agent = agentMap[id];
    if (!agent?.skills?.length) continue;
    const score = agent.skills.filter(s => lower.includes(s)).length;
    if (score > 0) {
      const tier = getAgentCostTier(id, agent.provider);
      scored.push({ id, score, tier });
    }
  }

  if (scored.length > 0) {
    scored.sort((a, b) => (b.score - a.score) || (a.tier - b.tier));
    return scored[0].id;
  }

  // Phase 3: Last resort — cheapest available, scoreboard tiebreak
  const byTier = [...generalPool].sort((a, b) => {
    const ta = getAgentCostTier(a, agentMap[a]?.provider);
    const tb = getAgentCostTier(b, agentMap[b]?.provider);
    if (ta !== tb) return ta - tb;
    if (scoreboard) {
      const sa = scoreboard.getScore(a)?.successRate ?? 0.5;
      const sb = scoreboard.getScore(b)?.successRate ?? 0.5;
      if (sa !== sb) return sb - sa;
    }
    return 0;
  });
  return byTier[0];
}

/**
 * Serialize a task and subtask into a JSON-serializable bundle.
 * Used for preserving context during rejection → rework cycles.
 *
 * @param {Object} task - Task object from tasks.json
 * @param {Object} [subtask] - Optional subtask object being worked on
 * @returns {Object} JSON-serializable bundle with task and subtask context
 */
function normalizeDeliberationState(deliberation) {
  if (!deliberation || typeof deliberation !== 'object') return null;
  return {
    enabled: Boolean(deliberation.enabled),
    sessionId: deliberation.sessionId || null,
    assignedAgents: Array.isArray(deliberation.assignedAgents) ? deliberation.assignedAgents : [],
  };
}

function normalizeTaskDeliberation(task) {
  if (!task || typeof task !== 'object') return task;
  const normalized = normalizeDeliberationState(task.deliberation);
  task.deliberation = normalized || { enabled: false, sessionId: null, assignedAgents: [] };
  return task;
}

export function serializeTaskBundle(task, subtask = null) {
  if (!task) {
    throw new Error('Task is required for serialization');
  }

  const bundle = {
    // Task-level context fields
    taskId: task.id,
    title: task.title,
    description: task.description,
    context: task.context || null,
    plan: task.plan || null,
    delegationContext: task.delegationContext || null,
    reviewCycle: task.reviewCycle || 0,
    reviewFindings: task.reviewFindings || [],
    touchedFiles: task.touchedFiles || [],
    gitBaseline: task.gitBaseline || null,
    traceContext: task.traceContext || null,
    doneCriteria: task.doneCriteria || null,
    campaignId: task.campaignId || null,
    milestoneId: task.milestoneId || null,
    deliberation: normalizeDeliberationState(task.deliberation),
    suggestedTools: task.suggestedTools || [],
    rationale: task.rationale || null,
  };

  // Subtask-level fields (if subtask provided)
  if (subtask) {
    bundle.subtask = {
      id: subtask.id,
      text: subtask.text,
      status: subtask.status,
      assignee: subtask.assignee || null,
      claimedUntil: subtask.claimedUntil || null,
      retryCount: subtask.retryCount || 0,
      result: subtask.result || null,
      error: subtask.error || null,
      meta: subtask.meta || null,
      complexity: subtask.complexity || 'medium',
      suggestedRole: subtask.suggestedRole || null,
      toolResults: subtask.toolResults || [],
      // Messages array (if stored in meta)
      messages: subtask.meta?.messages || [],
      createdAt: subtask.createdAt,
      startedAt: subtask.startedAt,
      completedAt: subtask.completedAt,
      updatedAt: subtask.updatedAt,
    };
  }

  return bundle;
}

/**
 * Error thrown when rehydrateTaskBundle receives null/undefined input.
 */
export class BundleNotFoundError extends Error {
  constructor(message = 'Task bundle not found or is null') {
    super(message);
    this.name = 'BundleNotFoundError';
    this.code = 'BUNDLE_NOT_FOUND';
  }
}

/**
 * Rehydrate a serialized task context bundle produced by serializeTaskBundle.
 *
 * Validates the bundle shape, restores messages, attachments, and session
 * metadata, and returns an object matching the original task/subtask shape.
 *
 * @param {object|null|undefined} serializedBundle - Output of serializeTaskBundle / JSON.parse
 * @returns {{ taskId, title, description, context, plan, delegationContext,
 *             reviewCycle, reviewFindings, touchedFiles, gitBaseline,
 *             traceContext, doneCriteria, campaignId, milestoneId, deliberation,
 *             subtask?: object, messages: array, attachments: array,
 *             sessionMeta: object }}
 * @throws {BundleNotFoundError} if serializedBundle is null/undefined
 * @throws {Error} if the bundle is missing required fields (corrupt bundle)
 */
export function rehydrateTaskBundle(serializedBundle) {
  if (serializedBundle == null) {
    throw new BundleNotFoundError();
  }

  // Validate required fields
  if (!serializedBundle.taskId || typeof serializedBundle.taskId !== 'string') {
    throw new Error('Invalid task bundle: missing or invalid taskId');
  }
  if (!serializedBundle.title || typeof serializedBundle.title !== 'string') {
    throw new Error('Invalid task bundle: missing or invalid title');
  }

  // Restore top-level task fields
  const rehydrated = {
    taskId: serializedBundle.taskId,
    title: serializedBundle.title,
    description: serializedBundle.description || null,
    context: serializedBundle.context || null,
    plan: serializedBundle.plan || null,
    delegationContext: serializedBundle.delegationContext || null,
    reviewCycle: typeof serializedBundle.reviewCycle === 'number' ? serializedBundle.reviewCycle : 0,
    reviewFindings: Array.isArray(serializedBundle.reviewFindings) ? serializedBundle.reviewFindings : [],
    touchedFiles: Array.isArray(serializedBundle.touchedFiles) ? serializedBundle.touchedFiles : [],
    gitBaseline: serializedBundle.gitBaseline || null,
    traceContext: serializedBundle.traceContext || null,
    doneCriteria: serializedBundle.doneCriteria || null,
    campaignId: serializedBundle.campaignId || null,
    milestoneId: serializedBundle.milestoneId || null,
    deliberation: normalizeDeliberationState(serializedBundle.deliberation)
      || { enabled: false, sessionId: null, assignedAgents: [] },
    suggestedTools: Array.isArray(serializedBundle.suggestedTools) ? serializedBundle.suggestedTools : [],
    rationale: serializedBundle.rationale || null,
    // Top-level messages/attachments/sessionMeta (from rework-context-bundle.js shape)
    messages: Array.isArray(serializedBundle.messages) ? serializedBundle.messages : [],
    attachments: Array.isArray(serializedBundle.attachments) ? serializedBundle.attachments : [],
    sessionMeta: serializedBundle.sessionMeta && typeof serializedBundle.sessionMeta === 'object'
      ? {
          agentId: serializedBundle.sessionMeta.agentId || null,
          provider: serializedBundle.sessionMeta.provider || null,
          traceContext: serializedBundle.sessionMeta.traceContext || null,
          touchedFiles: Array.isArray(serializedBundle.sessionMeta.touchedFiles)
            ? serializedBundle.sessionMeta.touchedFiles
            : [],
          gitBaseline: serializedBundle.sessionMeta.gitBaseline || null,
          claimTime: serializedBundle.sessionMeta.claimTime || null,
          retryCount: typeof serializedBundle.sessionMeta.retryCount === 'number'
            ? serializedBundle.sessionMeta.retryCount
            : 0,
          maxRetries: serializedBundle.sessionMeta.maxRetries || null,
        }
      : { agentId: null, provider: null, traceContext: null, touchedFiles: [], gitBaseline: null,
          claimTime: null, retryCount: 0, maxRetries: null },
  };

  // Restore subtask if present
  if (serializedBundle.subtask && typeof serializedBundle.subtask === 'object') {
    const st = serializedBundle.subtask;
    rehydrated.subtask = {
      id: st.id || null,
      text: st.text || null,
      status: st.status || null,
      assignee: st.assignee || null,
      claimedUntil: st.claimedUntil || null,
      retryCount: typeof st.retryCount === 'number' ? st.retryCount : 0,
      result: st.result || null,
      error: st.error || null,
      meta: st.meta || null,
      complexity: st.complexity || 'medium',
      suggestedRole: st.suggestedRole || null,
      toolResults: Array.isArray(st.toolResults) ? st.toolResults : [],
      messages: Array.isArray(st.messages) ? st.messages : [],
      createdAt: st.createdAt || null,
      startedAt: st.startedAt || null,
      completedAt: st.completedAt || null,
      updatedAt: st.updatedAt || null,
    };
  }

  return rehydrated;
}

/**
 * Save a context bundle to durable storage using atomic write-rename pattern.
 * Path: .synapse/projects/<projectId>/context-bundles/<taskId>.json
 *
 * @param {Object} stateManager - StateManager instance
 * @param {string} projectId - The project identifier
 * @param {string} taskId - The task identifier
 * @param {Object} bundle - The serialized bundle object to persist
 * @throws {Error} If write or rename fails
 */
export function saveContextBundle(stateManager, projectId, taskId, bundle) {
  const bundleDir = join(stateManager.projectsDir, projectId, 'context-bundles');
  const bundlePath = join(bundleDir, `${taskId}.json`);
  const tmpPath = `${bundlePath}.tmp.${process.pid}`;

  try {
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(bundle, null, 2) + '\n');
    renameSync(tmpPath, bundlePath);
    log.debug('Context bundle saved', { projectId, taskId, path: bundlePath });
  } catch (err) {
    // Clean up temp file if it exists
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Load a context bundle from durable storage.
 * Path: .synapse/projects/<projectId>/context-bundles/<taskId>.json
 *
 * @param {Object} stateManager - StateManager instance
 * @param {string} projectId - The project identifier
 * @param {string} taskId - The task identifier
 * @returns {Object|null} The deserialized bundle, or null if not found
 * @throws {Error} If read or parse fails (except for missing file)
 */
export function loadContextBundle(stateManager, projectId, taskId) {
  const bundlePath = join(stateManager.projectsDir, projectId, 'context-bundles', `${taskId}.json`);

  if (!existsSync(bundlePath)) {
    return null;
  }

  try {
    const content = readFileSync(bundlePath, 'utf-8');
    const bundle = JSON.parse(content);
    log.debug('Context bundle loaded', { projectId, taskId, path: bundlePath });
    return bundle;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export class TaskManager {
  constructor(stateManager) {
    this.stateManager = stateManager;
    // Track requeue attempts: subtask key → count
    this._requeueCounts = new Map();
    // Track completed tasks per project for audit scheduling
    this._completedSinceAudit = new Map();
    // Optional event hook — set by orchestrator to emit webhook events
    this._onEvent = null;
    // Optional after-save hook — set by orchestrator for snapshot persistence
    this._afterSave = null;
    // Optional deliberation protocol instance — set by orchestrator for multi-agent deliberation
    this._deliberationProtocol = null;
  }

  setOnEvent(fn) { this._onEvent = fn; }
  setAfterSave(fn) { this._afterSave = fn; }
  setDeliberationProtocol(protocol) { this._deliberationProtocol = protocol; }

  /** Save a context bundle for a task. */
  saveContextBundle(projectId, taskId, bundle) {
    return saveContextBundle(this.stateManager, projectId, taskId, bundle);
  }

  /** Load a context bundle for a task. */
  loadContextBundle(projectId, taskId) {
    return loadContextBundle(this.stateManager, projectId, taskId);
  }

  /** Check if an audit should be triggered for this project. */
  shouldAudit(projectId, auditInterval, hasFailures, auditOnFailure) {
    if (auditOnFailure && hasFailures) return true;
    const count = this._completedSinceAudit.get(projectId) || 0;
    return count > 0 && (count % auditInterval === 0);
  }

  /** Record that a task completed in this project. */
  recordTaskCompletion(projectId) {
    const count = this._completedSinceAudit.get(projectId) || 0;
    this._completedSinceAudit.set(projectId, count + 1);
  }

  /** Reset the audit counter after an audit runs. */
  resetAuditCounter(projectId) {
    this._completedSinceAudit.set(projectId, 0);
  }

  _tasksPath(projectId) {
    return join(this.stateManager.projectsDir, projectId, 'tasks.json');
  }

  _eventsPath(projectId) {
    return join(this.stateManager.projectsDir, projectId, 'task-events.jsonl');
  }

  _todoPath(projectId) {
    const proj = this.stateManager.getProject(projectId);
    const projectDir = proj?.projectDir || join(this.stateManager.projectsDir, projectId);
    return join(projectDir, 'TASKS.md');
  }

  /**
   * Snapshot a single task's state for transactional rollback.
   */
  snapshotTaskState(projectId, taskId) {
    const data = this.load(projectId);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    return {
      version: data.version,
      task: JSON.parse(JSON.stringify(task)),
    };
  }

  /**
   * Restore a task from a previously captured snapshot. Used to rollback
   * partial updates when provider execution fails mid-flight.
   */
  restoreTaskState(projectId, snapshot, reason = 'rollback') {
    if (!snapshot || !snapshot.task) return null;
    return this._saveWithIntegrity(projectId, (d) => {
      const idx = d.tasks.findIndex(t => t.id === snapshot.task.id);
      if (idx === -1) throw new Error(`Task not found during restore: ${snapshot.task.id}`);
      d.tasks[idx] = JSON.parse(JSON.stringify(snapshot.task));
      d.tasks[idx].updatedAt = new Date().toISOString();
      d.tasks[idx].rollbackReason = reason;
      return d;
    }, 'restore_task_state');
  }

  // --- Persistence (CAS-protected) ---

  load(projectId) {
    try {
      const projectDir = join(this.stateManager.projectsDir, projectId);
      const db = getDb(projectDir);
      const taskRows = db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(projectId);
      if (taskRows.length === 0) {
        return { schemaVersion: SCHEMA_VERSION, version: 0, tasks: [] };
      }
      const tasks = taskRows.map(row => {
        const task = rowToTask(row);
        const subtaskRows = db.prepare('SELECT * FROM subtasks WHERE task_id = ?').all(task.id);
        task.subtasks = subtaskRows.map(rowToSubtask);
        return task;
      });
      tasks.forEach(normalizeTaskDeliberation);
      return { schemaVersion: SCHEMA_VERSION, version: 0, tasks };
    } catch (err) {
      // Fail LOUD, not silent. Readers get an empty snapshot so views degrade
      // gracefully, but _loadFailed marks it poisoned: persistTasks is
      // delete-then-insert, so saving an empty snapshot from a failed load
      // would destroy every task in the project.
      log.error('Task load failed — returning empty read-only snapshot', { projectId, error: err.message });
      return { schemaVersion: SCHEMA_VERSION, version: 0, tasks: [], _loadFailed: true };
    }
  }

  _saveWithIntegrity(projectId, mutator, label = 'save_with_integrity') {
    return this._saveWithRetry(projectId, (data) => {
      const next = mutator(data);
      const tasks = next?.tasks || [];
      for (const t of tasks) validateTaskIntegrity(t);
      return next;
    });
  }

  _saveWithRetry(projectId, mutator) {
    for (let i = 0; i < MAX_CAS_RETRIES; i++) {
      const data = this.load(projectId);
      if (data._loadFailed) {
        throw new Error(`Refusing to persist ${projectId}: task state failed to load (saving would wipe existing data)`);
      }
      const modified = mutator(data);
      try {
        const projectDir = join(this.stateManager.projectsDir, projectId);
        const db = getDb(projectDir);
        persistTasks(db, projectId, modified.tasks);
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

  // --- Task CRUD ---

  createTask(projectId, channelIdOrTask, taskInput = null) {
    const hasLegacySignature = typeof channelIdOrTask === 'string';
    const taskArgs = hasLegacySignature ? (taskInput || {}) : (channelIdOrTask || {});
    const channelId = hasLegacySignature
      ? channelIdOrTask
      : normalizeTaskCategory(taskArgs.channel) || 'general';
    const {
      title,
      description,
      doneCriteria,
      context: taskContext,
      threadId,
      delegationContext,
      type = 'oneshot',
      daemon = {},
      campaignId = null,
      milestoneId = null,
      dependencies = [],
      owner = 'system',
      sharedWith = [],
      taskCategory: explicitTaskCategory = null,
      suggestedTools = [], // New field
      rationale = null, // New field
    } = taskArgs;
    const taskId = `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const taskCategory = normalizeTaskCategory(explicitTaskCategory) || normalizeTaskCategory(channelId);
    const reviewCategory = taskCategory || channelId;

    const task = {
      id: taskId,
      title,
      description: description || title,
      type,  // 'oneshot' or 'daemon'
      status: 'queued',
      project: projectId,
      channel: channelId,
      taskCategory,
      category: taskCategory,
      owner: owner || 'system',      // Track owner for user-scoped visibility
      sharedWith: sharedWith || [],  // Explicitly shared with these userIds
      subtasks: [],
      plan: null,
      doneCriteria: doneCriteria || null,
      dependencies,
      context: taskContext || null,
      threadId: threadId || null,
      delegationContext: delegationContext || null,
      campaignId: campaignId || null,
      milestoneId: milestoneId || null,
      reviewCycle: 0,             // current fix cycle (incremented on each FAIL → fix loop)
      maxReviewCycles: null,      // per-task override (null = use config default)
      reviewFindings: [],         // structured findings from last review (fed to fix agents)
      reviewIterations: 0,        // count of review-revise loop iterations
      lastReviewerId: null,       // ID of the last reviewer agent
      reviewFeedbackHistory: [],  // array of {iteration, reviewerId, feedback, timestamp}
      reworkInProgress: false,    // flag to prevent duplicate fix cycles during rework
      reviewAndRevise: config.tasks.reviewAndRevise.triggerTaskTypes.includes(reviewCategory)
        ? { enabled: config.tasks.reviewAndRevise.enabled, maxIterations: config.tasks.reviewAndRevise.maxIterations, currentIteration: 0 }
        : null,  // Only enable for configured task types (code-review, architecture-design, etc.)
      deliberation: { enabled: false, sessionId: null, assignedAgents: [] }, // Multi-agent deliberation state
      gitBaseline: null,    // git status snapshot taken when task starts executing
      touchedFiles: [],     // populated on completion by diffing baseline vs current
      traceContext: null,   // OTel span context for parent-child linkage (under milestone span)
      suggestedTools: suggestedTools || [], // New field
      rationale: rationale || null, // New field
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };

    // Daemon-specific fields
    if (type === 'daemon') {
      task.daemon = {
        sleepIntervalMs: daemon.sleepIntervalMs || 60 * 60 * 1000,  // default 1 hour
        maxDailyCost:    daemon.maxDailyCost || null,     // null = no cap
        maxPerCycleCost: daemon.maxPerCycleCost || null,  // null = no cap
        cycleCount:      0,
        lastCycleAt:     null,
        sleepUntil:      null,
        totalSpend:      0,
        dailySpend:      0,
        dailySpendReset: now,
        paused:          false,
        pauseReason:     null,
      };
    }

    const data = this._saveWithRetry(projectId, (d) => {
      d.tasks.push(task);
      return d;
    });

    this._appendEvent(projectId, {
      action: 'task_created',
      taskId,
      agent: 'system',
      reason: `Task created: ${title}`,
    });

    log.info('Task created', { projectId, taskId, title, type, owner: task.owner });

    if (this._onEvent) this._onEvent('task:created', { projectId, taskId, title, type });

    return task;
  }

  getTask(projectId, taskId) {
    const data = this.load(projectId);
    return data.tasks.find(t => t.id === taskId) || null;
  }

  listTasks(projectId, userId = null, statusFilter = null) {
    const data = this.load(projectId);
    let tasks = data.tasks;

    if (userId) {
      tasks = tasks.filter(t =>
        t.owner === userId ||
        t.owner === 'system' ||
        (t.sharedWith && t.sharedWith.includes(userId))
      );
    }

    if (statusFilter) {
      tasks = tasks.filter(t => t.status === statusFilter);
    }
    return tasks;
  }

  updateTaskStatus(projectId, taskId, newStatus, agent = 'system', reason = '', userId = null) {
    const data = this._saveWithRetryScoped(projectId, userId,
      (d) => d.tasks.find(t => t.id === taskId),
      (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      if (task.status === newStatus) {
        return d;
      }

      const allowed = TASK_TRANSITIONS[task.status];
      if (!allowed || !allowed.includes(newStatus)) {
        throw new Error(`Invalid transition: ${task.status} → ${newStatus}`);
      }

      // Lifecycle invariant: terminal tasks must not contain non-terminal subtasks.
      // 'done' requires all subtasks terminal. For 'failed'/'cancelled', normalize
      // any in-flight subtasks to failed to preserve terminal consistency.
      if (newStatus === 'done' && hasNonTerminalSubtasks(task)) {
        throw new Error('Cannot mark task done: non-terminal subtasks remain (queued/claimed/executing).');
      }
      if ((newStatus === 'failed' || newStatus === 'cancelled') && hasNonTerminalSubtasks(task)) {
        const terminalizedAt = new Date().toISOString();
        for (const st of task.subtasks || []) {
          if (!NON_TERMINAL_SUBTASK_STATUSES.has(st?.status)) continue;
          st.status = 'failed';
          st.assignee = null;
          st.claimedUntil = null;
          st.completedAt = terminalizedAt;
          st.error = st.error || `Auto-terminalized: parent task marked ${newStatus}`;
          st.updatedAt = terminalizedAt;
        }
      }

      const oldStatus = task.status;
      task.status = newStatus;
      task.updatedAt = new Date().toISOString();

      if (newStatus === 'planning' && !task.startedAt) {
        task.startedAt = task.updatedAt;
      }
      // Operator-initiated requeue resets the automatic-retry budget; system
      // requeues (heartbeat/strategist) manage their own counters and must
      // not clear them.
      if (newStatus === 'queued' && agent !== 'system' && agent !== 'strategist') {
        delete task.requeueCount;
        delete task.requeueExhausted;
        delete task.backlogRetryCount;
      }
      if (newStatus === 'done' || newStatus === 'failed' || newStatus === 'cancelled') {
        task.completedAt = task.updatedAt;
      } else if (newStatus === 'queued' || newStatus === 'planning' || newStatus === 'executing' || newStatus === 'deferred') {
        task.completedAt = null;
      }

      validateTaskIntegrity(task);
      return d;
    });

    this._appendEvent(projectId, {
      action: 'task_status_changed',
      taskId,
      agent,
      reason: reason || `Status: ${newStatus}`,
    });

    const updatedTask = data.tasks.find(t => t.id === taskId);
    log.info('Task status changed', { projectId, taskId, newStatus, agent, reason: reason || `Status: ${newStatus}` });
    if (newStatus === 'done') {
      log.info('Task completed', { projectId, taskId, title: updatedTask?.title, agent });
    } else if (newStatus === 'failed') {
      log.error('Task failed', { projectId, taskId, reason, agent });
    } else if (newStatus === 'cancelled') {
      log.warn('Task cancelled', { projectId, taskId, reason, agent });
    }

    if (this._onEvent) {
      this._onEvent('task:status_changed', { projectId, taskId, status: newStatus, agent });
      if (newStatus === 'done') {
        this._onEvent('task:completed', { projectId, taskId, title: updatedTask?.title });
      }
    }

    this._renderTodoMd(projectId);
    return updatedTask;
  }

  deferTask(projectId, taskId, untilIso, agent = 'system', reason = 'Deferred retry') {
    const data = this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status === 'deferred') {
        return d;
      }
      const allowed = TASK_TRANSITIONS[task.status];
      if (!allowed || !allowed.includes('deferred')) {
        throw new Error(`Invalid transition: ${task.status} → deferred`);
      }
      const now = new Date().toISOString();
      task.status = 'deferred';
      task.nextAttemptAt = untilIso;
      task.deferReason = reason;
      task.updatedAt = now;
      task.completedAt = null;
      return d;
    });

    this._appendEvent(projectId, {
      action: 'task_status_changed',
      taskId,
      agent,
      reason: `${reason} (deferred until ${untilIso})`,
    });

    log.info('Task deferred', { projectId, taskId, untilIso, reason, agent });

    this._renderTodoMd(projectId);
    return data.tasks.find(t => t.id === taskId);
  }

  resumeDueDeferredTasks(projectId, nowMs = Date.now(), agent = 'system', reason = 'Deferred retry window reached') {
    const dueTaskIds = this.listTasks(projectId, 'deferred')
      .filter(t => t.nextAttemptAt && new Date(t.nextAttemptAt).getTime() <= nowMs)
      .map(t => t.id);
    for (const taskId of dueTaskIds) {
      try {
        this._saveWithRetry(projectId, (d) => {
          const t = d.tasks.find(x => x.id === taskId);
          if (!t || t.status !== 'deferred') return d;
          t.nextAttemptAt = null;
          t.deferReason = null;
          return d;
        });
        this.updateTaskStatus(projectId, taskId, 'queued', agent, reason);
      } catch {
        // Non-fatal CAS race; heartbeat will retry.
      }
    }
    return dueTaskIds;
  }

  // --- Subtask Management ---

  addSubtasks(projectId, taskId, subtasks, agent = 'system') {
    const now = new Date().toISOString();

    const data = this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        throw new Error(`Cannot add subtasks to terminal task (${task.status}): ${taskId}`);
      }

      // Deduplicate incoming subtasks by text (case-insensitive)
      const seenTexts = new Set();
      const existingTexts = new Set(task.subtasks.map(s => s.text?.toLowerCase()));
      subtasks = subtasks.filter(st => {
        const text = (typeof st === 'string' ? st : st.text)?.toLowerCase();
        if (!text || seenTexts.has(text) || existingTexts.has(text)) return false;
        seenTexts.add(text);
        return true;
      });
      if (subtasks.length === 0) return d; // all filtered as duplicates

      const startId = task.subtasks.length + 1;
      for (let i = 0; i < subtasks.length; i++) {
        const st = subtasks[i];
        task.subtasks.push({
          id: `st_${startId + i}`,
          text: typeof st === 'string' ? st : st.text,
          status: 'queued',
          assignee: (typeof st === 'object' && st.assignee) || null,
          complexity: (typeof st === 'object' && st.complexity) || 'medium',
          suggestedRole: normalizeSuggestedRole((typeof st === 'object' && st.role) || null),
          meta: (typeof st === 'object' && st.meta) || null,
          suggestedTools: (typeof st === 'object' && Array.isArray(st.suggestedTools)) ? st.suggestedTools : [],
          rationale: (typeof st === 'object' && typeof st.rationale === 'string') ? st.rationale : null,
          claimedUntil: null,
          result: null,
          error: null,
          retryCount: 0,
          retryAttempts: 0,
          lastRetryAt: null,
          nextRetryAt: null,
          backoffMs: 0,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        });
      }

      task.updatedAt = now;
      return d;
    });

    this._appendEvent(projectId, {
      action: 'subtasks_added',
      taskId,
      agent,
      reason: `Added ${subtasks.length} subtasks`,
      patch: { subtasks: subtasks.map(s => typeof s === 'string' ? s : s.text) },
    });

    log.info('Subtasks added', { projectId, taskId, count: subtasks.length, agent });

    this._renderTodoMd(projectId);
    return data.tasks.find(t => t.id === taskId);
  }

  claimSubtask(projectId, taskId, subtaskId, agentId, timeoutMs = 300000) {
    const data = this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const st = task.subtasks.find(s => s.id === subtaskId);
      if (!st) throw new Error(`Subtask not found: ${subtaskId}`);

      const allowed = SUBTASK_TRANSITIONS[st.status];
      if (!allowed || !allowed.includes('claimed')) {
        throw new Error(`Cannot claim subtask in status: ${st.status}`);
      }

      st.status = 'claimed';
      st.assignee = agentId;
      st.claimedUntil = new Date(Date.now() + timeoutMs).toISOString();
      // claimedAt persists via the subtask meta spillover (subtaskToRow) — stuck-cookie
      // detection and router duration metrics read it and previously always found nothing.
      st.claimedAt = new Date().toISOString();
      st.claimedBy = agentId;
      st.startedAt = new Date().toISOString();
      st.updatedAt = st.startedAt;
      task.updatedAt = st.updatedAt;

      return d;
    });

    this._appendEvent(projectId, {
      action: 'subtask_claimed',
      taskId,
      subtaskId,
      agent: agentId,
      reason: `Claimed by ${agentId}`,
    });

    log.info('Subtask claimed', { projectId, taskId, subtaskId, agentId });

    return data.tasks.find(t => t.id === taskId);
  }

  updateSubtask(projectId, taskId, subtaskId, { status, result, error, complexity, failedProviders, retryCount, verdict, meta, text, cooldownUntil, retryAttempts, lastRetryAt, nextRetryAt, backoffMs, assignee, toolResults }, agent = 'system') {
    const data = this._saveWithIntegrity(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        throw new Error(`Cannot update subtask of terminal task (${task.status}): ${taskId}`);
      }

      const st = task.subtasks.find(s => s.id === subtaskId);
      if (!st) throw new Error(`Subtask not found: ${subtaskId}`);

      // Ownership re-check: an agent may only terminalize a subtask it still owns.
      // Reconcile can requeue a subtask it believes dead while the original agent is
      // still executing; if another agent has since claimed it, the stale completion
      // must be rejected or both results race (double execution, double side effects).
      // st.assignee === null (requeued, unclaimed) is allowed: the late result is the
      // work being finished once, and marking it done prevents a second execution.
      if (agent !== 'system' && (status === 'done' || status === 'failed') &&
          st.assignee && st.assignee !== agent) {
        throw new Error(`Ownership check failed: subtask ${subtaskId} is assigned to ${st.assignee}, not ${agent}`);
      }

      if (status) {
        // For executing, the subtask must be claimed
        if (status === 'executing') {
          if (st.status !== 'claimed') throw new Error(`Cannot execute: subtask is ${st.status}`);
          st.status = 'executing';
        } else if (status === 'done') {
          st.status = 'done';
          st.completedAt = new Date().toISOString();
        } else if (status === 'failed') {
          st.status = 'failed';
          st.completedAt = new Date().toISOString();
        } else if (status === 'queued') {
          // Requeue (from failed or claimed timeout)
          st.status = 'queued';
          st.assignee = null;
          st.claimedUntil = null;
          st.completedAt = null;
          delete st.claimedAt;
          delete st.claimedBy;
        }
      }

      if (result !== undefined) st.result = result;
      // Guard: if result is being set and subtask is still queued, auto-advance to done.
      // A subtask with a result has been executed — its status should reflect that.
      if (result !== undefined && st.status === 'queued') {
        const hasContent = typeof result === 'string' ? result.trim().length > 0 :
          (typeof result === 'object' && result !== null && (result.text || '').trim().length > 0);
        if (hasContent) {
          st.status = 'done';
          st.completedAt = new Date().toISOString();
        }
      }
      if (error !== undefined) st.error = error;
      if (complexity !== undefined) st.complexity = complexity;
      if (failedProviders !== undefined) st.failedProviders = failedProviders;
      if (retryCount !== undefined) st.retryCount = retryCount;
      if (verdict !== undefined) st.verdict = verdict;
      if (meta !== undefined) st.meta = { ...(st.meta || {}), ...meta };
      if (text !== undefined) st.text = text;
      if (cooldownUntil !== undefined) st.cooldownUntil = cooldownUntil;
      if (retryAttempts !== undefined) st.retryAttempts = retryAttempts;
      if (lastRetryAt !== undefined) st.lastRetryAt = lastRetryAt;
      if (nextRetryAt !== undefined) st.nextRetryAt = nextRetryAt;
      if (backoffMs !== undefined) st.backoffMs = backoffMs;
      if (assignee !== undefined) st.assignee = assignee;
      if (toolResults !== undefined) {
        if (Array.isArray(toolResults)) {
          const existing = st.toolResults || [];
          const existingToolNames = new Set(existing.map(tr => tr?.toolName).filter(n => n));
          const newResults = toolResults.filter(tr => tr?.toolName && !existingToolNames.has(tr.toolName));
          st.toolResults = [...existing, ...newResults];
        } else {
          st.toolResults = toolResults;
        }
      }
      st.updatedAt = new Date().toISOString();
      task.updatedAt = st.updatedAt;

      validateTaskIntegrity(task);
      return d;
    });

    this._appendEvent(projectId, {
      action: 'subtask_updated',
      taskId,
      subtaskId,
      agent,
      reason: status ? `Status → ${status}` : 'Updated',
      patch: { status, result: result ? result.substring(0, 500) : undefined, error },
    });

    if (status === 'done') {
      log.info('Subtask completed', { projectId, taskId, subtaskId, agent });
    } else if (status === 'failed') {
      log.error('Subtask failed', { projectId, taskId, subtaskId, agent, error });
    }

    this._renderTodoMd(projectId);
    return data.tasks.find(t => t.id === taskId);
  }

  /**
   * Escalate a failed subtask: bump complexity and requeue so routing picks a higher-tier agent.
   * Escalation chain: low → medium → high. Tracks which providers already failed.
   * Max 3 escalation attempts — after that, permanently fail.
   * Returns true if escalated (requeued), false if exhausted.
   */
  escalateSubtask(projectId, taskId, subtaskId, failedAgentProvider) {
    const MAX_ESCALATIONS = 3;
    const data = this.load(projectId);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return false;
    const st = task.subtasks.find(s => s.id === subtaskId);
    if (!st) return false;

    const retryCount = (st.retryCount || 0) + 1;

    // Hard cap: stop after 3 escalation attempts
    if (retryCount > MAX_ESCALATIONS) return false;

    const ESCALATION = ['low', 'medium', 'high'];
    const currentIdx = ESCALATION.indexOf(st.complexity || 'medium');
    const nextComplexity = currentIdx < ESCALATION.length - 1 ? ESCALATION[currentIdx + 1] : st.complexity;

    // Track which providers have been tried and failed
    const failedProviders = []; // Cooldown handles blocking, not permanent exclusion

    // If all 3 main provider tiers failed, truly give up
    const allProviders = ['ollama', 'codex', 'claude'];
    const allExhausted = allProviders.every(p => failedProviders.includes(p));
    if (allExhausted) return false;

    // Fail → queued with escalated complexity
    this.updateSubtask(projectId, taskId, subtaskId,
      { status: 'failed', error: `Failed by ${failedAgentProvider} — escalating (retry ${retryCount})` },
      'system');
    this.updateSubtask(projectId, taskId, subtaskId,
      { status: 'queued', complexity: nextComplexity, failedProviders, error: `Escalated: ${st.complexity} → ${nextComplexity}, excluding [${failedProviders}]` },
      'system');

    // Persist retryCount
    this._saveWithRetry(projectId, (d) => {
      const t = d.tasks.find(t2 => t2.id === taskId);
      const s = t?.subtasks.find(s2 => s2.id === subtaskId);
      if (s) s.retryCount = retryCount;
      return d;
    });

    log.warn('Subtask escalated', { projectId, taskId, subtaskId, retryCount, complexity: nextComplexity, failedProvider: failedAgentProvider });

    return true;
  }

  /**
   * Retry a failed subtask with exponential backoff.
   * Increments retryAttempts, computes backoff (1s * 2^attempt), and requeues.
   * Returns true if retried (requeued), false if max attempts (3) exhausted (persistently failed).
   */
  retrySubtask(projectId, taskId, subtaskId) {
    const MAX_RETRY_ATTEMPTS = 3;
    const BASE_BACKOFF_MS = 1000;
    const MAX_BACKOFF_MS = 30000;

    const data = this.load(projectId);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return false;
    const st = task.subtasks.find(s => s.id === subtaskId);
    if (!st) return false;

    const attempts = (st.retryAttempts || 0) + 1;

    // Exhausted: mark as persistently failed
    if (attempts > MAX_RETRY_ATTEMPTS) return false;

    const backoffMs = computeBackoffWithJitter(attempts - 1, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
    const now = Date.now();
    const lastRetryAt = new Date(now).toISOString();
    const nextRetryAt = new Date(now + backoffMs).toISOString();

    // Requeue with backoff metadata
    this.updateSubtask(projectId, taskId, subtaskId, {
      status: 'queued',
      retryAttempts: attempts,
      lastRetryAt,
      nextRetryAt,
      backoffMs,
      error: `Retry ${attempts}/${MAX_RETRY_ATTEMPTS} — backoff ${backoffMs}ms (jittered)`,
    }, 'system');

    this._appendEvent(projectId, {
      action: 'subtask_retried',
      taskId,
      subtaskId,
      agent: 'system',
      reason: `Retry ${attempts}/${MAX_RETRY_ATTEMPTS}, backoff ${backoffMs}ms (jittered)`,
      patch: { retryAttempts: attempts, backoffMs, nextRetryAt },
    });

    log.info('Subtask retried', { projectId, taskId, subtaskId, attempt: attempts, maxAttempts: MAX_RETRY_ATTEMPTS, backoffMs });

    return true;
  }

  /**
   * Get the next queued subtask for a task, or null if none.
   * Priority: previously-failed subtasks (retryCount > 0 or error set) before fresh ones,
   * then natural array order (original plan sequence) within each group.
   *
   * @param {string} excludeProvider - optional provider to skip (pull model: agent passes its own
   *   provider so it skips subtasks it has already failed on, rather than blocking the whole task)
   */
  getNextSubtask(projectId, taskId, excludeProvider = null) {
    const data = this.load(projectId);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return null;
    let queued = task.subtasks.filter(s => s.status === 'queued');
    // In pull model: skip subtasks this provider has already failed on so the agent can still
    // work on other subtasks in the same task (rather than skipping the entire task).
    if (excludeProvider) {
      queued = queued.filter(s => !(s.failedProviders || []).includes(excludeProvider));
    }
    // Respect exponential backoff: skip subtasks whose nextRetryAt is still in the future
    const now = new Date().toISOString();
    queued = queued.filter(s => !s.nextRetryAt || s.nextRetryAt <= now);
    if (queued.length === 0) return null;
    // "Clean up your toys" — retry previously-failed subtasks before starting new ones
    const retry = queued.filter(s => s.error || (s.retryCount ?? 0) > 0);
    return retry[0] ?? queued[0];
  }

  /**
   * Check for expired claims (claimedUntil passed) and handle them.
   * On first timeout: requeue to same pool. On second timeout: escalate to higher-tier agent.
   * @param {string} projectId
   * @param {Object} [agentMap] - optional agent map for provider lookup during escalation
   * Returns array of expired subtask IDs.
   */
  /**
   * Check if agent is on cooldown and when it expires.
   */
  isAgentOnCooldown(agentId) {
    const data = this.load(projectId);
    if (!data || !data.tasks) return { onCooldown: false };
    for (const task of data.tasks) {
      if (!task || !task.subtasks) continue;
      for (const st of task.subtasks) {
        if (st.cooldownUntil && st.cooldownUntil > new Date().toISOString()) {
          if (st.assignee === agentId) {
            return { onCooldown: true, expiresAt: st.cooldownUntil };
          }
        }
      }
    }
    return { onCooldown: false };
  }

  checkExpiredClaims(projectId, agentMap = {}) {
    const data = this.load(projectId);
    const expired = [];
    const now = Date.now();

    for (const task of data.tasks) {
      if (task.status !== 'executing') continue;
      for (const st of task.subtasks) {
        if ((st.status === 'claimed' || st.status === 'executing') && st.claimedUntil) {
          if (now > new Date(st.claimedUntil).getTime()) {
            expired.push({ taskId: task.id, subtaskId: st.id, assignee: st.assignee });
          }
        }
      }
    }

    // Handle expirations
    for (const { taskId, subtaskId, assignee } of expired) {
      const key = `${taskId}:${subtaskId}`;
      const count = this._requeueCounts.get(key) || 0;

      if (count < 1) {
        // Requeue once (same agent pool) - timeout does NOT mark as failed
        this._requeueCounts.set(key, count + 1);
        
        // Check if cooldown has expired and clear failedProviders
        const task = data.tasks.find(t => t.id === taskId);
        if (task) {
          const st = task.subtasks.find(s => s.id === subtaskId);
          if (st && st.cooldownUntil && new Date(st.cooldownUntil).getTime() < Date.now()) {
            const provider = agentMap[assignee]?.provider || assignee;
            if (st.failedProviders && st.failedProviders.includes(provider)) {
              st.failedProviders = st.failedProviders.filter(p => p !== provider);
            }
            st.cooldownUntil = null;
            this.updateSubtask(projectId, taskId, subtaskId, {
              failedProviders: st.failedProviders,
              cooldownUntil: null,
              updatedAt: new Date().toISOString()
            }, 'system');
          }
        }
        this.updateSubtask(projectId, taskId, subtaskId,
          { status: 'queued', error: `Timed out (was assigned to ${assignee})` },
          'system'
        );
      } else {
        // Second timeout — escalate to higher-tier provider instead of giving up
        const provider = agentMap[assignee]?.provider || assignee;
        const escalated = this.escalateSubtask(projectId, taskId, subtaskId, provider);
        if (!escalated) {
          this.updateSubtask(projectId, taskId, subtaskId,
            { status: 'failed', error: `Timed out twice (last: ${assignee}). All providers exhausted.` },
            'system'
          );
        }
      }
    }

    return expired;
  }

  /**
   * Check if all subtasks in a task are terminal (done or failed).
   */
  isTaskComplete(projectId, taskId) {
    const data = this.load(projectId);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) {
      log.debug('isTaskComplete: task not found', { projectId, taskId });
      return false;
    }
    if (task.subtasks.length === 0) {
      log.debug('isTaskComplete: no subtasks', { projectId, taskId });
      return false;
    }
    const isComplete = task.subtasks.every(s => s.status === 'done' || s.status === 'failed');
    log.debug('isTaskComplete: checking completion', {
      projectId,
      taskId,
      isComplete,
      subtaskCount: task.subtasks.length,
      subtaskStatuses: task.subtasks.map(s => ({ id: s.id, status: s.status })),
    });
    return isComplete;
  }

  /**
   * Check if any subtask failed.
   */
  hasFailedSubtasks(projectId, taskId) {
    const data = this.load(projectId);
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return false;
    return task.subtasks.some(s => s.status === 'failed');
  }

  // --- Daemon Lifecycle ---

  /**
   * Reset a daemon task for its next cycle.
   * Requeues all subtasks, increments cycleCount, sets sleepUntil.
   */
  resetDaemonCycle(projectId, taskId) {
    const data = this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task || task.type !== 'daemon') throw new Error(`Not a daemon task: ${taskId}`);

      // Reset all subtasks to queued
      for (const st of task.subtasks) {
        st.status = 'queued';
        st.assignee = null;
        st.claimedUntil = null;
        st.result = null;
        st.error = null;
        st.startedAt = null;
        st.completedAt = null;
        st.updatedAt = new Date().toISOString();
      }

      // Update daemon metadata
      task.daemon.cycleCount = (task.daemon.cycleCount || 0) + 1;
      task.daemon.lastCycleAt = new Date().toISOString();
      task.daemon.sleepUntil = new Date(Date.now() + (task.daemon.sleepIntervalMs || 3600000)).toISOString();
      task.updatedAt = new Date().toISOString();

      return d;
    });

    this._appendEvent(projectId, {
      action: 'daemon_cycle_complete',
      taskId,
      agent: 'system',
      reason: `Cycle ${data.tasks.find(t => t.id === taskId)?.daemon?.cycleCount} complete, sleeping`,
    });

    this._renderTodoMd(projectId);
    return data.tasks.find(t => t.id === taskId);
  }

  /**
   * Check if a daemon task's sleep period has elapsed.
   */
  isDaemonReady(projectId, taskId) {
    const task = this.getTask(projectId, taskId);
    if (!task || task.type !== 'daemon' || task.status !== 'sleeping') return false;
    if (task.daemon.paused) return false;
    if (!task.daemon.sleepUntil) return true;
    return Date.now() >= new Date(task.daemon.sleepUntil).getTime();
  }

  /**
   * Check and reset daily spend if day boundary has passed.
   * Returns true if spend was reset.
   */
  resetDailySpendIfNeeded(projectId, taskId) {
    const data = this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task?.daemon) return d;

      const resetTime = new Date(task.daemon.dailySpendReset || 0);
      const now = new Date();
      // Reset if it's been more than 24 hours
      if (now - resetTime > 24 * 60 * 60 * 1000) {
        task.daemon.dailySpend = 0;
        task.daemon.dailySpendReset = now.toISOString();
        task.updatedAt = now.toISOString();
      }
      return d;
    });
    return data;
  }

  /**
   * Record spend for a daemon task. Returns true if caps are OK, false if cap exceeded.
   */
  recordDaemonSpend(projectId, taskId, costUsd) {
    let capExceeded = false;
    let exceedReason = null;

    this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task?.daemon) return d;

      task.daemon.totalSpend = (task.daemon.totalSpend || 0) + costUsd;
      task.daemon.dailySpend = (task.daemon.dailySpend || 0) + costUsd;
      task.updatedAt = new Date().toISOString();

      if (task.daemon.maxDailyCost && task.daemon.dailySpend > task.daemon.maxDailyCost) {
        capExceeded = true;
        exceedReason = `Daily spend $${task.daemon.dailySpend.toFixed(2)} exceeds cap $${task.daemon.maxDailyCost.toFixed(2)}`;
      }
      if (task.daemon.maxPerCycleCost) {
        // Per-cycle: estimate from subtask count — rough proxy
        const cycleCost = costUsd; // individual subtask cost
        if (cycleCost > task.daemon.maxPerCycleCost) {
          capExceeded = true;
          exceedReason = `Subtask cost $${cycleCost.toFixed(2)} exceeds per-cycle cap $${task.daemon.maxPerCycleCost.toFixed(2)}`;
        }
      }

      return d;
    });

    if (capExceeded) {
      this._appendEvent(projectId, {
        action: 'daemon_spend_cap_exceeded',
        taskId,
        agent: 'system',
        reason: exceedReason,
      });
    }

    return { ok: !capExceeded, reason: exceedReason };
  }

  /**
   * Pause a daemon task (e.g., spend cap exceeded).
   */
  pauseDaemon(projectId, taskId, reason, userId = null) {
    this._saveWithRetryScoped(projectId, userId,
      (d) => d.tasks.find(t => t.id === taskId),
      (d) => {
        const task = d.tasks.find(t => t.id === taskId);
        if (!task?.daemon) return d;
        task.daemon.paused = true;
        task.daemon.pauseReason = reason;
        task.updatedAt = new Date().toISOString();
        return d;
      });

    this._appendEvent(projectId, {
      action: 'daemon_paused',
      taskId,
      agent: 'system',
      reason,
    });
  }

  /**
   * Resume a paused daemon task.
   */
  resumeDaemon(projectId, taskId, userId = null) {
    this._saveWithRetryScoped(projectId, userId,
      (d) => d.tasks.find(t => t.id === taskId),
      (d) => {
        const task = d.tasks.find(t => t.id === taskId);
        if (!task?.daemon) return d;
        task.daemon.paused = false;
        task.daemon.pauseReason = null;
        task.updatedAt = new Date().toISOString();
        return d;
      });

    this._appendEvent(projectId, {
      action: 'daemon_resumed',
      taskId,
      agent: 'system',
      reason: 'Resumed by user',
    });
  }

  /**
   * Check if a daemon task needs re-planning (every N cycles).
   */
  daemonNeedsReplan(projectId, taskId, rePlanInterval = 5) {
    const task = this.getTask(projectId, taskId);
    if (!task?.daemon) return false;
    return (task.daemon.cycleCount || 0) > 0 && (task.daemon.cycleCount % rePlanInterval) === 0;
  }

  // --- Git Tracking ---

  setGitBaseline(projectId, taskId, baseline) {
    this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      task.gitBaseline = baseline;
      task.updatedAt = new Date().toISOString();
      return d;
    });
  }

  setTouchedFiles(projectId, taskId, files) {
    this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      task.touchedFiles = files;
      task.updatedAt = new Date().toISOString();
      return d;
    });
  }

  setTaskFiles(projectId, taskId, files) {
    this._saveWithRetry(projectId, (d) => {
      const task = d.tasks.find(t => t.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      task.taskFiles = files;
      task.updatedAt = new Date().toISOString();
      return d;
    });
  }

  /**
   * Assign multiple agents to a task for deliberation.
   *
   * @param {string} projectId - The project ID
   * @param {string} taskId - The task ID
   * @param {string[]} agentIds - Array of agent IDs (must be 2 or more)
   * @param {object} config - Optional deliberation config (timeoutMs, consensusThreshold)
   * @returns {object} - Object with taskId, sessionId, and assigned agents
   * @throws {Error} if agentIds has fewer than 2 agents or deliberation protocol not initialized
   */
  assignMultipleAgents(projectId, taskId, agentIds, config = {}) {
    // Validate inputs
    if (!Array.isArray(agentIds) || agentIds.length < 2) {
      throw new Error(`assignMultipleAgents requires at least 2 agents, got ${agentIds?.length || 0}`);
    }

    if (!this._deliberationProtocol) {
      throw new Error('DeliberationProtocol not initialized. Call setDeliberationProtocol() first.');
    }

    // Get the task to use its title as the deliberation topic
    const task = this.getTask(projectId, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Generate a unique session ID
    const sessionId = `session_${taskId}_${Date.now()}`;
    const initiatorAgentId = agentIds[0]; // First agent is the initiator
    const topic = task.title || task.description || 'Multi-agent task';

    // Initialize deliberation session
    const sessionResult = this._deliberationProtocol.initSession(
      sessionId,
      agentIds,
      topic,
      initiatorAgentId,
      {
        timeoutMs: config.timeoutMs,
        consensusThreshold: config.consensusThreshold,
        projectId,
      }
    );

    // Update task with deliberation config via CAS-safe update
    const data = this._saveWithRetry(projectId, (d) => {
      const t = d.tasks.find(task => task.id === taskId);
      if (!t) throw new Error(`Task not found: ${taskId}`);

      // Initialize or update deliberation field
      t.deliberation = {
        enabled: true,
        sessionId: sessionResult.sessionId,
        assignedAgents: [...agentIds], // Clone array to avoid mutation
      };

      t.updatedAt = new Date().toISOString();
      return d;
    });

    // Log the event
    this._appendEvent(projectId, {
      action: 'multi_agent_assigned',
      taskId,
      agent: 'system',
      reason: `Assigned ${agentIds.length} agents for deliberation: ${agentIds.join(', ')}`,
      patch: { deliberation: { sessionId: sessionResult.sessionId, assignedAgents: agentIds } },
    });

    log.info(`Assigned ${agentIds.length} agents to task ${taskId}, session ${sessionResult.sessionId}`);

    return {
      taskId,
      sessionId: sessionResult.sessionId,
      assignedAgents: agentIds,
      status: sessionResult.status,
    };
  }

  // --- TODO.md Rendering ---

  _renderTodoMd(projectId) {
    const data = this.load(projectId);
    if (data.tasks.length === 0) return;

    const lines = ['# Task Progress', '', '*Auto-generated from tasks.json — do not edit manually.*', ''];

    for (const task of data.tasks) {
      const icon = task.status === 'done' ? '[x]' :
                   task.status === 'failed' ? '[!]' :
                   task.status === 'cancelled' ? '[-]' :
                   task.status === 'executing' ? '[~]' :
                   task.status === 'sleeping' ? '[z]' :
                   task.status === 'planning' ? '[>]' : '[ ]';

      const typeTag = task.type === 'daemon' ? ' (daemon)' : '';
      lines.push(`## ${icon} ${task.title}${typeTag}`);
      let statusLine = `Status: ${task.status} | Created: ${task.createdAt?.split('T')[0] || 'unknown'}`;
      if (task.daemon) {
        statusLine += ` | Cycle: ${task.daemon.cycleCount || 0}`;
        if (task.daemon.paused) statusLine += ' | PAUSED';
      }
      lines.push(statusLine);
      if (task.doneCriteria) lines.push(`Done when: ${task.doneCriteria}`);
      lines.push('');

      if (task.subtasks.length > 0) {
        for (const st of task.subtasks) {
          const stIcon = st.status === 'done' ? '[x]' :
                         st.status === 'failed' ? '[!]' :
                         st.status === 'executing' ? '[~]' :
                         st.status === 'claimed' ? '[>]' : '[ ]';
          const assignee = st.assignee ? ` @${st.assignee}` : '';
          lines.push(`- ${stIcon} ${st.text}${assignee}`);
          if (st.result) lines.push(`  Result: ${String(st.result).substring(0, 200)}`);
          if (st.error) lines.push(`  Error: ${st.error}`);
        }
        lines.push('');
      }
    }

    const todoPath = this._todoPath(projectId);
    try {
      writeFileSync(todoPath, lines.join('\n'));
    } catch {
      // Non-critical — don't crash if project dir is read-only
    }
  }

  // --- Display Formatting ---

  formatTaskList(projectId) {
    const data = this.load(projectId);
    if (data.tasks.length === 0) return 'No tasks.';

    const statusIcons = {
      queued: '[ ]', planning: '[>]', executing: '[~]',
      reviewing: '[?]', done: '[x]', failed: '[!]', cancelled: '[-]',
      sleeping: '[z]',
    };

    const lines = ['**Tasks**'];
    for (const task of data.tasks) {
      const icon = statusIcons[task.status] || '[ ]';
      const subs = task.subtasks.length > 0
        ? ` (${task.subtasks.filter(s => s.status === 'done').length}/${task.subtasks.length} subtasks)`
        : '';
      const typeTag = task.type === 'daemon' ? ' [daemon]' : '';
      const daemonInfo = task.daemon ? ` cycle:${task.daemon.cycleCount || 0}` : '';
      const pauseTag = task.daemon?.paused ? ' PAUSED' : '';
      lines.push(`${icon} \`${task.id}\` — ${task.title}${typeTag}${daemonInfo}${subs}${pauseTag}`);
    }

    return lines.join('\n');
  }

  formatTaskDetail(projectId, taskId) {
    const task = this.getTask(projectId, taskId);
    if (!task) return `Task not found: ${taskId}`;

    const lines = [
      `**${task.title}**`,
      `ID: \`${task.id}\``,
      `Type: ${task.type || 'oneshot'}`,
      `Status: ${task.status}`,
      `Project: ${task.project}#${task.channel}`,
    ];

    if (task.daemon) {
      lines.push(`Cycle: ${task.daemon.cycleCount || 0}`);
      lines.push(`Sleep interval: ${Math.round((task.daemon.sleepIntervalMs || 0) / 60000)}m`);
      if (task.daemon.sleepUntil) lines.push(`Sleep until: ${task.daemon.sleepUntil}`);
      if (task.daemon.totalSpend) lines.push(`Total spend: $${task.daemon.totalSpend.toFixed(2)}`);
      if (task.daemon.dailySpend) lines.push(`Daily spend: $${task.daemon.dailySpend.toFixed(2)}`);
      if (task.daemon.paused) lines.push(`PAUSED: ${task.daemon.pauseReason || 'unknown'}`);
    }
    if (task.doneCriteria) lines.push(`Done criteria: ${task.doneCriteria}`);
    if (task.context) lines.push(`Context: ${String(task.context).substring(0, 300)}`);
    if (task.plan) lines.push(`Plan: ${String(task.plan).substring(0, 500)}`);

    lines.push(`Created: ${task.createdAt}`);
    if (task.startedAt) lines.push(`Started: ${task.startedAt}`);
    if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);

    if (task.subtasks.length > 0) {
      lines.push('', '**Subtasks:**');
      for (let i = 0; i < task.subtasks.length; i++) {
        const st = task.subtasks[i];
        const icon = st.status === 'done' ? '[x]' :
                     st.status === 'failed' ? '[!]' :
                     st.status === 'executing' ? '[~]' :
                     st.status === 'claimed' ? '[>]' : '[ ]';
        const assignee = st.assignee ? ` → @${st.assignee}` : '';
        lines.push(`${i + 1}. ${icon} ${st.text}${assignee}`);
        if (st.result) lines.push(`   Result: ${String(st.result).substring(0, 200)}`);
        if (st.error) lines.push(`   Error: ${st.error}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format task context for agent prompts.
   * Returns a compact string agents see when executing subtasks.
   */
  /**
   * Format task context for agent prompts.
   * Returns a compact string agents see when executing subtasks.
   * @param {Object} [campaignManager] - optional CampaignManager for campaign context injection
   */
  formatForAgentContext(projectId, taskId, subtaskId, campaignManager = null, learningsManager = null, vaultQuery = null, agentRole = null, provider = null, agentId = null, agentMemoryStore = null) {
    const task = this.getTask(projectId, taskId);
    if (!task) return null;

    const st = task.subtasks.find(s => s.id === subtaskId);
    if (!st) return null;

    // Normalize: s.result may be a string (legacy) or a ResponseObject
    // ({text, ...}) from CliAgent. Same defensive pattern used at the 6
    // sites fixed in commit 0df374f8 — silent here because persisted
    // results from before that normalization landed in DB still surface.
    const completedSibs = task.subtasks
      .filter(s => s.status === 'done')
      .map(s => {
        const raw = s.result;
        const str = typeof raw === 'string' ? raw
          : (raw?.text != null ? String(raw.text) : (raw == null ? 'completed' : String(raw)));
        return `  - ${s.text}: ${str.substring(0, 200)}`;
      })
      .join('\n');

    const lines = [];

    // Inject campaign context if task belongs to a campaign
    if (task.campaignId && campaignManager) {
      const campaignCtx = campaignManager.formatCampaignContext(task.project, task.campaignId);
      if (campaignCtx) {
        lines.push(campaignCtx);
        lines.push('');
      }
    }

    // Inject collective learnings context
    if (learningsManager) {
      const learningsCtx = learningsManager.buildSubtaskContext(projectId, {
        subtaskText: st.text,
        campaignId: task.campaignId,
        milestoneId: task.milestoneId,
      });
      if (learningsCtx) {
        lines.push(learningsCtx);
        lines.push('');
      }
    }

    // Inject vault context (institutional knowledge)
    if (vaultQuery) {
      try {
        const taskFiles = (task.taskFiles || []).map(f => f.path || f);
        const role = agentRole || st.suggestedRole || 'developer';
        const prov = provider || 'claude';
        const scoredNotes = vaultQuery.findRelevant({
          projectId, subtaskText: st.text, taskFiles, agentRole: role, provider: prov,
        });
        if (scoredNotes.length > 0) {
          const budget = vaultQuery._config.maxChars[prov] ?? 2000;
          const vaultCtx = vaultQuery.formatForContext(scoredNotes, budget);
          if (vaultCtx) {
            lines.push(vaultCtx);
            lines.push('');
          }
          log.info('Vault context injected', {
            projectId, taskId, subtaskId, role, provider: prov,
            notesFound: scoredNotes.length,
            topNote: scoredNotes[0]?.slug,
            topScore: scoredNotes[0]?.score,
            charsInjected: vaultCtx?.length || 0,
          });
        }
      } catch (vaultErr) {
        log.warn('Vault query failed (non-blocking)', { projectId, taskId, error: vaultErr.message });
      }
    }

    // Inject agent memory context (past experience relevant to this subtask)
    if (agentId && agentMemoryStore) {
      try {
        const subtaskText = st.text || '';
        const tags = subtaskText.toLowerCase().split(/\W+/).filter(w => w.length > 3).slice(0, 10);
        const memories = agentMemoryStore.query(agentId, { tags, limit: 10 });
        const memCtx = agentMemoryStore.formatForContext(memories, 500);
        if (memCtx) {
          lines.push(memCtx);
          lines.push('');
          log.info('Agent memory context injected', {
            projectId, taskId, subtaskId, agentId,
            memoriesFound: memories.length,
            charsInjected: memCtx.length,
          });
        }
      } catch (memErr) {
        log.warn('Agent memory query failed (non-blocking)', { projectId, taskId, agentId, error: memErr.message });
      }
    }

    lines.push(
      '=== AUTONOMOUS TASK ===',
      `Task: ${task.title}`,
      `Description: ${task.description}`,
    );
    if (task.doneCriteria) lines.push(`Done criteria: ${task.doneCriteria}`);
    if (task.context) lines.push(`Context: ${task.context}`);
    if (task.plan) lines.push(`Plan: ${task.plan}`);

    if (task.delegationContext) {
      lines.push('', '=== DISCUSSION CONTEXT ===');
      lines.push('The following discussion led to this task:');
      lines.push(task.delegationContext);
      lines.push('=== END DISCUSSION ===');
    }

    lines.push('', `YOUR SUBTASK: ${st.text}`);
    lines.push(`Subtask ID: ${st.id}`);

    // Retry awareness — surfaces failure history so agents don't repeat the same mistake
    if ((st.retryCount || 0) > 0) {
      lines.push('', '=== RETRY CONTEXT (read carefully before proceeding) ===');
      lines.push(`WARNING: This subtask has failed ${st.retryCount} previous attempt(s).`);
      if (st.failedProviders?.length) lines.push(`Failed providers: ${st.failedProviders.join(', ')}`);
      if (st.error) lines.push(`Last failure reason: ${String(st.error).substring(0, 300)}`);
      if (st.result && String(st.result).trim()) lines.push(`Last response (may be wrong/incomplete): ${String(st.result).substring(0, 400)}`);
      lines.push('REQUIRED: Before acting, explain WHY previous attempts failed and how your approach differs.');
      lines.push('Do NOT repeat an approach that already failed.');
      lines.push('=== END RETRY CONTEXT ===');
    }

    // Inject review finding context for fix subtasks
    if (st.meta?.reviewFinding) {
      const f = st.meta.reviewFinding;
      lines.push('', '=== REVIEW FINDING (fix required) ===');
      if (f.severity) lines.push(`Severity: ${f.severity}`);
      if (f.file) lines.push(`File: ${f.file}${f.line ? ':' + f.line : ''}`);
      lines.push(`Issue: ${f.issue}`);
      if (f.fix) lines.push(`Suggested fix: ${f.fix}`);
      lines.push('=== END FINDING ===');
    }

    // Include task files context for agents
    if (task.taskFiles && task.taskFiles.length > 0) {
      lines.push('', '=== TASK FILES ===');
      for (const tf of task.taskFiles) {
        let fileRef = tf.path;
        if (tf.action === 'edit' && tf.line) {
          fileRef += `@${tf.line}`;
        }
        lines.push(`- ${fileRef}`);
      }
      lines.push('=== END FILES ===');
    }

    if (completedSibs) {
      lines.push('', 'Completed subtasks (for context):');
      lines.push(completedSibs);
    }

    if (st.suggestedRole === 'reviewer') {
      lines.push('', '=== REVIEWER INSTRUCTIONS ===');
      lines.push('Audit the work described. Review what was done, verify correctness, and provide your verdict.');
      
      if (st.meta?.reviewAndReviseContext) {
        const ctx = st.meta.reviewAndReviseContext;
        if (ctx.primaryAgentOutput) {
          lines.push('');
          lines.push('=== PRIMARY AGENT OUTPUT (under review) ===');
          lines.push(ctx.primaryAgentOutput);
          lines.push('=== END PRIMARY OUTPUT ===');
        }
        if (ctx.deliberationHistory && ctx.deliberationHistory.length > 0) {
          lines.push('');
          lines.push('=== DELIBERATION HISTORY ===');
          for (const msg of ctx.deliberationHistory) {
            lines.push(`[${msg.type}] from @${msg.agentId}: ${msg.payload.summary || JSON.stringify(msg.payload).substring(0, 300)}`);
          }
          lines.push('=== END DELIBERATION HISTORY ===');
        }
        if (ctx.reviewIteration) {
          lines.push('');
          lines.push(`=== REVIEW ITERATION ${ctx.reviewIteration} ===`);
          lines.push('This is iteration ' + ctx.reviewIteration + ' of the review-and-revise workflow.');
          if (ctx.reviewIteration > 1) {
            lines.push('Previous feedback has been provided. Review the revised output and provide updated feedback.');
          }
          lines.push('=== END ITERATION CONTEXT ===');
        }
      }
      
      lines.push('');
      lines.push('RESPOND WITH a JSON object (ReviewFeedback):');
      lines.push('{"status": "approved"|"rejected"|"commented", "findings": [...], "summary": "one-line summary"}');
      lines.push('');
      lines.push('Status values:');
      lines.push('  - "approved": Output meets all criteria, no changes needed');
      lines.push('  - "rejected": Output has issues requiring revision');
      lines.push('  - "commented": Minor feedback provided but output is acceptable');
      lines.push('');
      lines.push('Each finding: {"severity": "critical|serious|moderate", "file": "path/to/file", "line": 42, "issue": "what is wrong", "fix": "how to fix"}');
      lines.push('');
      lines.push('For "approved" status, use findings: []. Only use "rejected" for real, concrete issues requiring revision.');
      lines.push('=== END REVIEWER INSTRUCTIONS ===');
    } else {
      lines.push('', 'Instructions: Complete the subtask above. Be thorough but focused. Report what you did and any findings.');
    }
    lines.push('=== END TASK ===');

    return lines.join('\n');
  }
}
