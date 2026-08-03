/**
 * Deliberation Gate — Qualifying Criteria Evaluator
 * 
 * Determines whether a subtask should enter a deliberation cycle and which mode to use.
 * Pure module with no I/O side effects — fully testable.
 * 
 * Qualifying criteria:
 *   1. Task complexity signal (description length, estimated tokens, subtask type)
 *   2. Agent confidence signal (if present in dispatch result)
 *   3. Sampling gate (top-N% complexity by default, configurable)
 * 
 * Mode selection:
 *   - 'reviewer': Default mode for high-complexity implementation tasks
 *   - 'challenger': For architecture/design decisions requiring challenge-synthesis
 *   - 'socratic': For research/investigation tasks requiring iterative questioning
 */

import config from '../config.js';

/**
 * @typedef {'challenger' | 'reviewer' | 'socratic'} DeliberationMode
 */

/**
 * @typedef {Object} DeliberationConfig
 * @property {boolean} [enableDeliberation] - Global enable/disable switch (default: true)
 * @property {number} [samplingPercentile] - Top N% of tasks by complexity qualify (default: 20)
 * @property {number} [confidenceThreshold] - Max confidence to trigger deliberation (default: 0.7)
 * @property {Object} [complexityWeights] - Weights for complexity scoring components
 * @property {number} [complexityWeights.descriptionLength] - Weight for description char length (default: 1.0)
 * @property {number} [complexityWeights.estimatedTokens] - Weight for estimated token count (default: 2.0)
 * @property {number} [complexityWeights.subtaskCount] - Weight for parent task subtask count (default: 0.5)
 * @property {Object} [modeRules] - Rules for mode selection by task category
 * @property {string[]} [modeRules.challengerCategories] - Task categories for challenger mode
 * @property {string[]} [modeRules.socraticCategories] - Task categories for socratic mode
 * @property {string} [modeRules.defaultMode] - Default mode when no category match (default: 'reviewer')
 */

/**
 * @typedef {Object} SubtaskPayload
 * @property {string} id - Subtask ID
 * @property {string} text - Subtask description/text
 * @property {string} [complexity] - Explicit complexity label: 'low' | 'medium' | 'high'
 * @property {string} [suggestedRole] - Suggested role for this subtask
 * @property {number} [estimatedTokens] - Estimated token count for completion
 * @property {string} [taskCategory] - Category of parent task
 * @property {number} [parentSubtaskCount] - Total subtasks in parent task
 * @property {Object} [meta] - Optional metadata
 */

/**
 * @typedef {Object} DispatchResult
 * @property {boolean} [success] - Whether dispatch succeeded
 * @property {number} [confidence] - Agent confidence score (0-1)
 * @property {string} [agentId] - ID of dispatched agent
 * @property {string} [failureType] - Type of failure if unsuccessful
 */

/**
 * @typedef {Object} DeliberationDecision
 * @property {boolean} shouldDeliberate - Whether task should enter deliberation
 * @property {DeliberationMode|null} mode - Selected deliberation mode or null
 * @property {string} reason - Human-readable explanation
 * @property {number} [complexityScore] - Computed complexity score (0-100)
 * @property {boolean} [passedSamplingGate] - Whether task passed sampling threshold
 */

/**
 * Default configuration values
 * @type {DeliberationConfig}
 */
const DEFAULT_CONFIG = Object.freeze({
  enableDeliberation: true,
  samplingPercentile: 20,
  confidenceThreshold: 0.7,
  complexityWeights: Object.freeze({
    descriptionLength: 1.0,
    estimatedTokens: 2.0,
    subtaskCount: 0.5,
  }),
  modeRules: Object.freeze({
    challengerCategories: ['architecture_design', 'architecture_decision', 'design_decision'],
    socraticCategories: ['research', 'question', 'status_check'],
    defaultMode: 'reviewer',
  }),
});

/**
 * Complexity rank for explicit labels
 * @type {Record<string, number>}
 */
const COMPLEXITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

/**
 * Compute complexity score (0-100) from subtask signals.
 * 
 * Scoring algorithm:
 *   1. Base score from explicit complexity label (if present): low=20, medium=50, high=80
 *   2. Description length contribution: chars / 500 * weight, capped at 30 points
 *   3. Estimated tokens contribution: tokens / 1000 * weight, capped at 40 points
 *   4. Subtask count contribution: (count - 1) / 10 * weight, capped at 10 points
 *   5. Final score clamped to [0, 100]
 * 
 * @param {SubtaskPayload} subtask - The subtask to score
 * @param {DeliberationConfig} config - Configuration with complexity weights
 * @returns {number} Complexity score in range [0, 100]
 */
export function computeComplexityScore(subtask, config = DEFAULT_CONFIG) {
  const weights = config.complexityWeights || DEFAULT_CONFIG.complexityWeights;
  
  // Base score from explicit complexity label
  let score = 0;
  if (subtask.complexity && COMPLEXITY_RANK[subtask.complexity]) {
    const rank = COMPLEXITY_RANK[subtask.complexity];
    score = (rank - 1) * 40; // low=0, medium=40, high=80
  }
  
  // Description length contribution
  const descriptionLength = (subtask.text || '').length;
  if (descriptionLength > 0 && weights.descriptionLength > 0) {
    const lengthScore = (descriptionLength / 500) * weights.descriptionLength * 30;
    score += Math.min(lengthScore, 30);
  }
  
  // Estimated tokens contribution
  if (subtask.estimatedTokens && subtask.estimatedTokens > 0 && weights.estimatedTokens > 0) {
    const tokenScore = (subtask.estimatedTokens / 1000) * weights.estimatedTokens * 40;
    score += Math.min(tokenScore, 40);
  }
  
  // Subtask count contribution (more subtasks = more complex coordination)
  if (subtask.parentSubtaskCount && subtask.parentSubtaskCount > 1 && weights.subtaskCount > 0) {
    const countScore = ((subtask.parentSubtaskCount - 1) / 10) * weights.subtaskCount * 10;
    score += Math.min(countScore, 10);
  }
  
  // Clamp to [0, 100]
  return Math.max(0, Math.min(100, score));
}

/**
 * Select deliberation mode based on task category and characteristics.
 * 
 * Mode selection rules:
 *   1. If taskCategory matches challengerCategories → 'challenger'
 *   2. If taskCategory matches socraticCategories → 'socratic'
 *   3. Otherwise → defaultMode (typically 'reviewer')
 * 
 * @param {SubtaskPayload} subtask - The subtask to evaluate
 * @param {DeliberationConfig} config - Configuration with mode rules
 * @returns {DeliberationMode} Selected deliberation mode
 */
export function selectDeliberationMode(subtask, config = DEFAULT_CONFIG) {
  const modeRules = config.modeRules || DEFAULT_CONFIG.modeRules;
  const taskCategory = subtask.taskCategory?.toLowerCase() || '';
  
  // Check challenger categories
  const challengerCategories = (modeRules.challengerCategories || []).map(c => c.toLowerCase());
  if (challengerCategories.includes(taskCategory)) {
    return 'challenger';
  }
  
  // Check socratic categories
  const socraticCategories = (modeRules.socraticCategories || []).map(c => c.toLowerCase());
  if (socraticCategories.includes(taskCategory)) {
    return 'socratic';
  }
  
  // Default mode
  return modeRules.defaultMode || 'reviewer';
}

/**
 * Determine if a subtask should enter deliberation and which mode to use.
 * 
 * Qualifying algorithm:
 *   1. Check global enable flag — return early if disabled
 *   2. Compute complexity score from subtask signals
 *   3. Check confidence threshold — low confidence triggers deliberation
 *   4. Apply sampling gate — only top N% complexity scores qualify
 *   5. Select mode based on task category
 * 
 * @param {SubtaskPayload} subtask - The subtask to evaluate
 * @param {DispatchResult} [dispatchResult] - Optional dispatch result with confidence signal
 * @param {DeliberationConfig} [config] - Configuration (defaults to DEFAULT_CONFIG)
 * @param {number} [complexityPercentileRank] - Optional: this task's percentile rank among peers (0-100)
 *                                                If provided, sampling gate uses this instead of raw score
 * @returns {DeliberationDecision} Decision object with shouldDeliberate, mode, reason
 */
export function shouldEnterDeliberation(
  subtask,
  dispatchResult = {},
  config = DEFAULT_CONFIG,
  complexityPercentileRank = null
) {
  // Guard: global enable flag
  if (config.enableDeliberation === false) {
    return {
      shouldDeliberate: false,
      mode: null,
      reason: 'Deliberation is globally disabled',
      complexityScore: 0,
      passedSamplingGate: false,
    };
  }
  
  // Compute complexity score
  const complexityScore = computeComplexityScore(subtask, config);
  
  // Check confidence threshold (low confidence → deliberation)
  const confidence = dispatchResult.confidence;
  const lowConfidence = confidence !== undefined && confidence !== null && confidence < (config.confidenceThreshold || 0.7);
  
  // Apply sampling gate
  // If percentile rank provided, use it; otherwise compare raw score to threshold
  const samplingThreshold = config.samplingPercentile ?? 20;
  let passedSamplingGate = false;
  let samplingReason = '';
  
  if (complexityPercentileRank !== null && complexityPercentileRank !== undefined) {
    // Use provided percentile rank
    passedSamplingGate = complexityPercentileRank >= (100 - samplingThreshold);
    samplingReason = `percentile rank ${complexityPercentileRank.toFixed(1)}% >= top ${samplingThreshold}% threshold`;
  } else {
    // Use raw score with heuristic threshold (score >= 60 qualifies as top 20%)
    const scoreThreshold = 60; // Heuristic: scores >= 60 are top ~20%
    passedSamplingGate = complexityScore >= scoreThreshold;
    samplingReason = `complexity score ${complexityScore.toFixed(1)} >= ${scoreThreshold} threshold`;
  }
  
  // Task qualifies if: low confidence OR passed sampling gate
  const shouldDeliberate = lowConfidence || passedSamplingGate;
  
  if (!shouldDeliberate) {
    const reason = lowConfidence 
      ? `Confidence ${confidence.toFixed(2)} below threshold ${config.confidenceThreshold}, but sampling gate not passed`
      : `Complexity score ${complexityScore.toFixed(1)} below sampling threshold (top ${samplingThreshold}%)`;
    
    return {
      shouldDeliberate: false,
      mode: null,
      reason,
      complexityScore,
      passedSamplingGate: false,
    };
  }
  
  // Select mode
  const mode = selectDeliberationMode(subtask, config);
  
  // Build reason string
  const reasons = [];
  if (lowConfidence) {
    reasons.push(`low confidence (${confidence.toFixed(2)} < ${config.confidenceThreshold})`);
  }
  if (passedSamplingGate) {
    reasons.push(samplingReason);
  }
  reasons.push(`mode: ${mode}`);
  
  return {
    shouldDeliberate: true,
    mode,
    reason: reasons.join('; '),
    complexityScore,
    passedSamplingGate,
  };
}

/**
 * Evaluate a batch of subtasks and return those that qualify for deliberation.
 * Useful for campaign-level sampling where you need to rank all tasks first.
 * 
 * @param {SubtaskPayload[]} subtasks - Array of subtasks to evaluate
 * @param {DispatchResult} [dispatchResult] - Optional dispatch result (applied to all)
 * @param {DeliberationConfig} [config] - Configuration
 * @returns {{qualifying: SubtaskPayload[], decisions: DeliberationDecision[]}}
 */
export function evaluateBatch(subtasks, dispatchResult = {}, config = DEFAULT_CONFIG) {
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return { qualifying: [], decisions: [] };
  }
  
  // Compute scores for all subtasks
  const scored = subtasks.map(st => ({
    subtask: st,
    score: computeComplexityScore(st, config),
  }));
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Compute percentile ranks
  const n = scored.length;
  scored.forEach((item, idx) => {
    // Percentile rank: what percentage of tasks have score <= this task
    const rank = ((n - idx) / n) * 100;
    item.percentileRank = rank;
  });
  
  // Evaluate each with percentile-aware sampling
  const decisions = scored.map(({ subtask, percentileRank }) =>
    shouldEnterDeliberation(subtask, dispatchResult, config, percentileRank)
  );
  
  // Extract qualifying subtasks
  const qualifying = scored
    .filter((_, idx) => decisions[idx].shouldDeliberate)
    .map(({ subtask }) => subtask);
  
  return { qualifying, decisions };
}

// Re-export config for convenience
export { DEFAULT_CONFIG };
