/**
 * Strict validation for Socratic questions with enhanced evidence requirements.
 *
 * This module extends basic validation by enforcing:
 * 1. Non-empty evidenceFor and evidenceAgainst arrays (when present)
 * 2. Evidence citations must contain specific references (event IDs, file paths, metric values)
 *
 * @typedef {import('./socratic-validation.js').SocraticQuestion} SocraticQuestion
 * @typedef {import('./socratic-validation.js').ValidationResult} ValidationResult
 */

const CITATION_PATTERNS = [
  // Event ID patterns: event_XXX, evt-XXX, EVENT_XXX
  /\b(event_|evt-|EVENT_)[a-zA-Z0-9_-]+\b/i,
  
  // File path patterns: src/..., /opt/..., relative paths with directories
  /\b(src\/|lib\/|app\/|config\/|\.\/|\.\.\/|[a-z]+\/[a-z0-9_\-]+\.js|[a-z]+\/[a-z0-9_\-]+\.ts)\b/i,
  
  // Absolute file paths
  /\/[a-zA-Z0-9_\-\/]+[\.](js|ts|json|md|yml|yaml)\b/,
  
  // Metric patterns: metric_XXX, value: XXX, count: XXX, score: XXX
  /\b(metric_|value[:\s]+|count[:\s]+|score[:\s]+|latency[:\s]+|error[:\s]+)[a-zA-Z0-9_\-\.]+\b/i,
  
  // Task/subtask IDs: task_XXX, subtask_XXX, st_XXX
  /\b(task_|subtask_|st_)[a-zA-Z0-9_-]+\b/i,
  
  // Campaign IDs: campaign_XXX, camp-XXX
  /\b(campaign_|camp-)[a-zA-Z0-9_-]+\b/i,
  
  // Milestone IDs: milestone_XXX, ms_XXX
  /\b(milestone_|ms_)[a-zA-Z0-9_-]+\b/i,
  
  // Line number references: line XXX, :XXX (in code context)
  /\b(line\s+\d+|:\d{3,})\b/,
  
  // Timestamp patterns: ISO dates, Unix timestamps
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  /\b\d{10,}\b/,
  
  // Specific data point references: "point X", "case Y", item Z
  /\b(point\s+\d+|case\s+\d+|item\s+\d+)\b/i
];

const MIN_EVIDENCE_COUNT = 1;

/**
 * Check if a citation string contains a specific reference.
 * 
 * @param {string} citation - The evidence citation text
 * @returns {boolean} True if citation contains a specific reference pattern
 */
function hasSpecificReference(citation) {
  if (!citation || typeof citation !== 'string') {
    return false;
  }

  return CITATION_PATTERNS.some(pattern => pattern.test(citation));
}

/**
 * Find which citation patterns are matched in a citation string.
 * 
 * @param {string} citation - The evidence citation text
 * @returns {string[]} Array of matched pattern descriptions
 */
function findMatchedPatterns(citation) {
  const descriptions = [];
  
  if (!citation || typeof citation !== 'string') {
    return descriptions;
  }

  if (/\b(event_|evt-|EVENT_)[a-zA-Z0-9_-]+\b/i.test(citation)) {
    descriptions.push('event_id');
  }
  
  if (/\b(src\/|lib\/|app\/|config\/|\.\/|\.\.\/|[a-z]+\/[a-z0-9_\-]+\.js|[a-z]+\/[a-z0-9_\-]+\.ts)\b/i.test(citation)) {
    descriptions.push('relative_file_path');
  }
  
  if (/\b(metric_|value[:\s]+|count[:\s]+|score[:\s]+|latency[:\s]+|error[:\s]+)[a-zA-Z0-9_\-\.]+\b/i.test(citation)) {
    descriptions.push('metric_reference');
  }
  
  if (/\b(task_|subtask_|st_)[a-zA-Z0-9_-]+\b/i.test(citation)) {
    descriptions.push('task_id');
  }
  
  if (/\b(campaign_|camp-)[a-zA-Z0-9_-]+\b/i.test(citation)) {
    descriptions.push('campaign_id');
  }
  
  if (/\b(milestone_|ms_)[a-zA-Z0-9_-]+\b/i.test(citation)) {
    descriptions.push('milestone_id');
  }
  
  if (/\b(line\s+\d+|:\d{3,})\b/.test(citation)) {
    descriptions.push('line_reference');
  }
  
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(citation)) {
    descriptions.push('timestamp');
  }

  return descriptions;
}

/**
 * Validate that an evidence array contains only valid citations with specific references.
 * 
 * @param {any[]} evidenceArray - The evidence array to validate
 * @param {string} fieldName - The name of the field (for error messages)
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEvidenceArray(evidenceArray, fieldName) {
  const errors = [];

  if (!Array.isArray(evidenceArray)) {
    return {
      valid: false,
      errors: [`${fieldName} must be an array`]
    };
  }

  if (evidenceArray.length === 0) {
    return {
      valid: false,
      errors: [`${fieldName} cannot be empty - must contain at least one citation`]
    };
  }

  evidenceArray.forEach((item, index) => {
    if (typeof item !== 'string') {
      errors.push(`${fieldName}[${index}] must be a string`);
      return;
    }

    if (!item.trim()) {
      errors.push(`${fieldName}[${index}] cannot be empty`);
      return;
    }

    if (!hasSpecificReference(item)) {
      const matched = findMatchedPatterns(item);
      errors.push(
        `${fieldName}[${index}] must contain a specific reference ` +
        `(e.g., event ID, file path, metric value). Found patterns: ${matched.length > 0 ? matched.join(', ') : 'none'}. ` +
        `Example valid citations: "event_123", "src/orchestrator/socratic-validation.js:45", "metric_error_rate=0.05"`
      );
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Enhanced validation for a single Socratic question with strict evidence requirements.
 * Requires non-empty evidenceFor and evidenceAgainst arrays when present,
 * and validates that all citations contain specific references.
 *
 * @param {any} question
 * @returns {ValidationResult}
 */
function validateSocraticQuestionStrict(question) {
  const baseResult = validateSocraticQuestion(question);
  
  if (!baseResult.valid) {
    return {
      valid: false,
      error: baseResult.error,
      details: baseResult.details || []
    };
  }

  const strictErrors = [];

  // Validate evidenceFor array - must be non-empty with specific references
  if ('evidenceFor' in question && question.evidenceFor !== null) {
    const evidenceResult = validateEvidenceArray(question.evidenceFor, 'evidenceFor');
    if (!evidenceResult.valid) {
      strictErrors.push(...evidenceResult.errors);
    }
  } else {
    // If evidenceFor is explicitly absent, we still require it for strict validation
    strictErrors.push('evidenceFor is required and must be a non-empty array with specific citations');
  }

  // Validate evidenceAgainst array - must be non-empty with specific references
  if ('evidenceAgainst' in question && question.evidenceAgainst !== null) {
    const evidenceResult = validateEvidenceArray(question.evidenceAgainst, 'evidenceAgainst');
    if (!evidenceResult.valid) {
      strictErrors.push(...evidenceResult.errors);
    }
  } else {
    // If evidenceAgainst is explicitly absent, we still require it for strict validation
    strictErrors.push('evidenceAgainst is required and must be a non-empty array with specific citations');
  }

  if (strictErrors.length > 0) {
    return {
      valid: false,
      error: `Strict validation failed with ${strictErrors.length} error(s)`,
      details: strictErrors
    };
  }

  return { valid: true };
}

/**
 * Validate an array of Socratic questions with strict evidence requirements.
 * Enforces 5-15 question count, non-empty evidence arrays, and specific citation format.
 *
 * @param {any} questions
 * @returns {ValidationResult}
 */
function validateQuestionSchemaStrict(questions) {
  if (!Array.isArray(questions)) {
    return {
      valid: false,
      error: 'Questions must be an array',
      details: []
    };
  }

  if (questions.length < MIN_QUESTION_COUNT) {
    return {
      valid: false,
      error: `Question count too low: ${questions.length} question(s) provided, minimum is ${MIN_QUESTION_COUNT}`,
      details: []
    };
  }

  if (questions.length > MAX_QUESTION_COUNT) {
    return {
      valid: false,
      error: `Question count too high: ${questions.length} questions provided, maximum is ${MAX_QUESTION_COUNT}`,
      details: []
    };
  }

  const allErrors = [];
  
  questions.forEach((q, idx) => {
    const result = validateSocraticQuestionStrict(q);
    if (!result.valid) {
      if (result.details && result.details.length) {
        result.details.forEach(d => allErrors.push(`Question ${idx + 1}: ${d}`));
      } else if (result.error) {
        allErrors.push(`Question ${idx + 1}: ${result.error}`);
      }
    }
  });

  if (allErrors.length > 0) {
    return {
      valid: false,
      error: `${allErrors.length} validation error(s) in questions array`,
      details: allErrors
    };
  }

  return { valid: true };
}

// Re-export constants from base validation
const MIN_QUESTION_COUNT = 5;
const MAX_QUESTION_COUNT = 15;
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 10;

// Re-export base validation function
import { validateSocraticQuestion } from './socratic-validation.js';

/**
 * Primary export: strict validation for an array of Socratic questions.
 * 
 * @param {any} questions
 * @returns {ValidationResult}
 */
const validateSocraticQuestionsStrict = validateQuestionSchemaStrict;

export {
  validateSocraticQuestionStrict,
  validateQuestionSchemaStrict,
  validateSocraticQuestionsStrict,
  hasSpecificReference,
  findMatchedPatterns,
  validateEvidenceArray,
  CITATION_PATTERNS,
  MIN_QUESTION_COUNT,
  MAX_QUESTION_COUNT,
  MIN_PRIORITY,
  MAX_PRIORITY
};
