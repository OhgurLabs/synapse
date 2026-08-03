/**
 * Self-ranking validation and normalization for Socratic questions.
 *
 * This module provides:
 * 1. Validation that priority (1-10) reflects impact assessment
 * 2. Helper functions to convert qualitative impact descriptions to numeric scores
 * 3. Normalization logic to ensure consistency between impactIfWrong and priority
 *
 * @typedef {import('./socratic-validation.js').SocraticQuestion} SocraticQuestion
 */

const MIN_PRIORITY = 1;
const MAX_PRIORITY = 10;

// Impact severity keywords and their typical priority ranges
const IMPACT_SEVERITY_KEYWORDS = {
  critical: { min: 8, max: 10, keywords: [
    'system failure', 'catastrophic', 'irreversible', 'data loss',
    'security breach', 'compliance violation', 'legal liability',
    'safety hazard', 'unrecoverable', 'total outage'
  ]},
  high: { min: 6, max: 8, keywords: [
    'significant', 'major', 'substantial', 'severe', 'critical path',
    'blocker', 'showstopper', 'regression', 'degradation', 'breakdown'
  ]},
  medium: { min: 4, max: 6, keywords: [
    'moderate', 'noticeable', 'measurable', 'impactful', 'consequential',
    'affects users', 'reduces efficiency', 'increases cost'
  ]},
  low: { min: 2, max: 4, keywords: [
    'minor', 'slight', 'negligible', 'cosmetic', 'inconvenience',
    'suboptimal', 'inefficient', 'confusing', 'unclear'
  ]},
  informational: { min: 1, max: 2, keywords: [
    'clarification', 'optimization', 'enhancement', 'improvement',
    'nice to have', 'future consideration', 'long-term'
  ]}
};

// Impact scale descriptors with numeric mappings
const IMPACT_SCALE = {
  catastrophic: 10,
  severe: 9,
  critical: 8,
  high: 7,
  moderate: 6,
  medium: 5,
  low: 4,
  minor: 3,
  negligible: 2,
  minimal: 1,
  informational: 1,
  none: 1
};

/**
 * Validate that a priority value is within the valid range (1-10).
 *
 * @param {any} priority - The priority value to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePriorityRange(priority) {
  if (typeof priority !== 'number') {
    return {
      valid: false,
      error: `priority must be a number, got ${typeof priority}`
    };
  }

  if (!Number.isInteger(priority)) {
    return {
      valid: false,
      error: `priority must be an integer, got ${priority}`
    };
  }

  if (priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
    return {
      valid: false,
      error: `priority must be between ${MIN_PRIORITY} and ${MAX_PRIORITY}, got ${priority}`
    };
  }

  return { valid: true };
}

/**
 * Detect the severity level from an impact description string.
 *
 * @param {string} impactDescription - The impactIfWrong description
 * @returns {{ severity: string, confidence: number, matchedKeywords: string[] }}
 */
function detectImpactSeverity(impactDescription) {
  if (!impactDescription || typeof impactDescription !== 'string') {
    return { severity: 'unknown', confidence: 0, matchedKeywords: [] };
  }

  const lower = impactDescription.toLowerCase();
  let maxScore = 0;
  let detectedSeverity = 'informational';
  const matchedKeywords = [];

  for (const [severity, config] of Object.entries(IMPACT_SEVERITY_KEYWORDS)) {
    for (const keyword of config.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        const score = keyword.length; // Longer matches = higher confidence
        if (score > maxScore) {
          maxScore = score;
          detectedSeverity = severity;
        }
        matchedKeywords.push(keyword);
      }
    }
  }

  const confidence = Math.min(maxScore / 20, 1); // Normalize to 0-1

  return {
    severity: detectedSeverity,
    confidence,
    matchedKeywords
  };
}

/**
 * Convert a qualitative impact description to a numeric priority score.
 * Uses keyword matching and scale detection to estimate appropriate priority.
 *
 * @param {string} impactDescription - The impactIfWrong description
 * @returns {{ priority: number, method: string, confidence: number }}
 */
function estimatePriorityFromImpact(impactDescription) {
  if (!impactDescription || typeof impactDescription !== 'string') {
    return { priority: 5, method: 'default', confidence: 0 };
  }

  const lower = impactDescription.toLowerCase().trim();

  // Check for explicit scale descriptors
  for (const [descriptor, score] of Object.entries(IMPACT_SCALE)) {
    if (lower.includes(descriptor)) {
      return { priority: score, method: 'scale_descriptor', confidence: 0.9 };
    }
  }

  // Check for severity-based keywords
  const severityResult = detectImpactSeverity(impactDescription);
  
  if (severityResult.confidence > 0.3) {
    const severityConfig = IMPACT_SEVERITY_KEYWORDS[severityResult.severity];
    const midPoint = Math.floor((severityConfig.min + severityConfig.max) / 2);
    
    // Adjust based on confidence and number of matched keywords
    const adjustment = Math.min(severityResult.matchedKeywords.length * 0.5, 2);
    const adjustedPriority = Math.round(midPoint + adjustment);
    
    return {
      priority: Math.max(MIN_PRIORITY, Math.min(MAX_PRIORITY, adjustedPriority)),
      method: 'severity_keywords',
      confidence: severityResult.confidence
    };
  }

  // Check for numeric hints in the description
  const numericMatch = lower.match(/(\d+)%|level\s*(\d+)|rank\s*(\d+)/);
  if (numericMatch) {
    const score = parseInt(numericMatch[1] || numericMatch[2] || numericMatch[3], 10);
    // Convert percentage or level to 1-10 scale
    let priority;
    if (numericMatch[1]) {
      // Percentage: 90% -> 9
      priority = Math.ceil(score / 10);
    } else {
      // Level/rank: normalize to 1-10
      priority = Math.max(1, Math.min(10, Math.round(score)));
    }
    return { priority, method: 'numeric_hint', confidence: 0.7 };
  }

  // Default fallback
  return { priority: 5, method: 'default', confidence: 0 };
}

/**
 * Validate that priority is consistent with impact description.
 * Checks if the stated priority aligns with what the impact description suggests.
 *
 * @param {Object} question - The Socratic question
 * @returns {{ valid: boolean, warnings: string[], suggestedPriority?: number }}
 */
function validateImpactPriorityConsistency(question) {
  const warnings = [];
  let suggestedPriority;

  const priorityValidation = validatePriorityRange(question.priority);
  if (!priorityValidation.valid) {
    return {
      valid: false,
      warnings: [`Invalid priority: ${priorityValidation.error}`]
    };
  }

  if (!question.impactIfWrong || typeof question.impactIfWrong !== 'string') {
    return {
      valid: true,
      warnings: ['No impact description to validate against priority']
    };
  }

  const estimated = estimatePriorityFromImpact(question.impactIfWrong);
  
  // Check if there's a significant discrepancy
  const difference = Math.abs(question.priority - estimated.priority);
  
  if (difference >= 3 && estimated.confidence > 0.5) {
    const severity = IMPACT_SEVERITY_KEYWORDS[estimated.method === 'severity_keywords' 
      ? detectImpactSeverity(question.impactIfWrong).severity 
      : 'medium'];
    
    warnings.push(
      `Priority ${question.priority} may not reflect impact severity. ` +
      `Impact description suggests priority ${estimated.priority} (${estimated.method}, confidence: ${estimated.confidence.toFixed(2)}). ` +
      `Consider reviewing the assessment.`
    );

    suggestedPriority = estimated.priority;
  }

  return {
    valid: true,
    warnings,
    suggestedPriority
  };
}

/**
 * Normalize a question's priority based on its impact description.
 * If the priority seems inconsistent with the impact, suggests an adjusted value.
 *
 * @param {Object} question - The Socratic question to normalize
 * @param {Object} options - Normalization options
 * @param {boolean} [options.autoAdjust=false] - Whether to auto-adjust inconsistent priorities
 * @param {number} [options.minConfidence=0.6] - Minimum confidence required for auto-adjustment
 * @returns {{ normalized: Object, adjustments: string[] }}
 */
function normalizeQuestionPriority(question, options = {}) {
  const { autoAdjust = false, minConfidence = 0.6 } = options;
  
  const adjustments = [];
  const normalized = { ...question };

  const consistencyCheck = validateImpactPriorityConsistency(question);
  
  if (!consistencyCheck.valid) {
    return {
      normalized: question,
      adjustments: consistencyCheck.warnings
    };
  }

  if (consistencyCheck.suggestedPriority && autoAdjust) {
    const current = question.priority;
    const suggested = consistencyCheck.suggestedPriority;
    
    // Only auto-adjust if confidence is high enough
    const estimated = estimatePriorityFromImpact(question.impactIfWrong);
    if (estimated.confidence >= minConfidence) {
      normalized.priority = suggested;
      adjustments.push(
        `Adjusted priority from ${current} to ${suggested} based on impact severity analysis`
      );
    }
  }

  return { normalized, adjustments };
}

/**
 * Rank questions by priority (descending) and return with rank metadata.
 *
 * @param {Object[]} questions - Array of Socratic questions
 * @returns {Object[]} Questions with added rank index
 */
function rankQuestionsByPriority(questions) {
  if (!Array.isArray(questions)) {
    return [];
  }

  const sorted = [...questions].sort((a, b) => {
    const priorityA = typeof a.priority === 'number' ? a.priority : 0;
    const priorityB = typeof b.priority === 'number' ? b.priority : 0;
    return priorityB - priorityA; // Descending order
  });

  return sorted.map((q, index) => ({
    ...q,
    rankIndex: index + 1,
    priority: q.priority
  }));
}

/**
 * Validate an array of questions for self-ranking quality.
 * Checks that priorities are properly assigned and varied (not all same value).
 *
 * @param {Object[]} questions - Array of Socratic questions
 * @returns {{ valid: boolean, warnings: string[], metadata: Object }}
 */
function validateSelfRankingQuality(questions) {
  const warnings = [];
  const metadata = {
    totalQuestions: questions.length,
    priorityDistribution: {},
    averagePriority: 0,
    minPriority: MAX_PRIORITY,
    maxPriority: MIN_PRIORITY
  };

  if (!Array.isArray(questions)) {
    return {
      valid: false,
      warnings: ['Input must be an array of questions'],
      metadata
    };
  }

  if (questions.length === 0) {
    return {
      valid: false,
      warnings: ['No questions to validate'],
      metadata
    };
  }

  const priorities = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    
    if (!q.priority || typeof q.priority !== 'number') {
      warnings.push(`Question ${i + 1}: missing or invalid priority`);
      continue;
    }

    priorities.push(q.priority);

    // Track distribution
    const priorityStr = String(q.priority);
    metadata.priorityDistribution[priorityStr] = 
      (metadata.priorityDistribution[priorityStr] || 0) + 1;

    // Track min/max
    metadata.minPriority = Math.min(metadata.minPriority, q.priority);
    metadata.maxPriority = Math.max(metadata.maxPriority, q.priority);
  }

  if (priorities.length === 0) {
    return {
      valid: false,
      warnings: ['No questions have valid priority values'],
      metadata
    };
  }

  // Calculate average
  metadata.averagePriority = parseFloat(
    priorities.reduce((a, b) => a + b, 0) / priorities.length
  ).toFixed(2);

  // Check for lack of variation (all same priority)
  const uniquePriorities = new Set(priorities);
  if (uniquePriorities.size === 1) {
    warnings.push(
      `All ${questions.length} questions have the same priority (${priorities[0]}). ` +
      `Consider varying priorities to reflect different impact levels.`
    );
  }

  // Check for clustering (most questions at one end of scale)
  const highPriorityCount = priorities.filter(p => p >= 8).length;
  const lowPriorityCount = priorities.filter(p => p <= 3).length;

  if (highPriorityCount > questions.length * 0.7) {
    warnings.push(
      `High priority clustering detected: ${highPriorityCount} of ${questions.length} ` +
      `questions have priority >= 8. Consider differentiating more carefully.`
    );
  }

  if (lowPriorityCount > questions.length * 0.7) {
    warnings.push(
      `Low priority clustering detected: ${lowPriorityCount} of ${questions.length} ` +
      `questions have priority <= 3. Ensure these are appropriately low-impact.`
    );
  }

  return {
    valid: true,
    warnings,
    metadata
  };
}

/**
 * Generate a prioritized question set with validation and ranking.
 * Main entry point for processing raw questions into a curated, ranked set.
 *
 * @param {Object[]} rawQuestions - Array of raw Socratic questions
 * @param {Object} options - Processing options
 * @param {boolean} [options.validate=true] - Whether to validate each question
 * @param {boolean} [options.normalize=false] - Whether to normalize priorities
 * @param {boolean} [options.autoAdjust=false] - Whether to auto-adjust inconsistent priorities
 * @returns {{ valid: boolean, questions: Object[], errors: string[], warnings: string[] }}
 */
function processQuestionSet(rawQuestions, options = {}) {
  const {
    validate = true,
    normalize = false,
    autoAdjust = false
  } = options;

  const result = {
    valid: true,
    questions: [],
    errors: [],
    warnings: []
  };

  if (!Array.isArray(rawQuestions)) {
    result.valid = false;
    result.errors.push('Input must be an array of questions');
    return result;
  }

  const processed = [];

  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    
    // Validate individual question
    if (validate) {
      const priorityValidation = validatePriorityRange(q.priority);
      if (!priorityValidation.valid) {
        result.errors.push(`Question ${i + 1}: ${priorityValidation.error}`);
        continue;
      }
    }

    // Normalize priority if requested
    let processedQuestion = q;
    if (normalize) {
      const normalized = normalizeQuestionPriority(q, { autoAdjust });
      processedQuestion = normalized.normalized;
      if (normalized.adjustments.length > 0) {
        result.warnings.push(...normalized.adjustments);
      }
    }

    processed.push(processedQuestion);
  }

  // Validate overall ranking quality
  const qualityCheck = validateSelfRankingQuality(processed);
  if (!qualityCheck.valid) {
    result.valid = false;
    result.errors.push(...qualityCheck.warnings);
  } else {
    result.warnings.push(...qualityCheck.warnings);
  }

  // Rank by priority
  result.questions = rankQuestionsByPriority(processed);
  result.metadata = qualityCheck.metadata;

  return result;
}

export {
  MIN_PRIORITY,
  MAX_PRIORITY,
  IMPACT_SEVERITY_KEYWORDS,
  IMPACT_SCALE,
  validatePriorityRange,
  detectImpactSeverity,
  estimatePriorityFromImpact,
  validateImpactPriorityConsistency,
  normalizeQuestionPriority,
  rankQuestionsByPriority,
  validateSelfRankingQuality,
  processQuestionSet
};