/**
 * Validation for Socratic campaign questions.
 *
 * @typedef {Object} SocraticQuestion
 * @property {string} question           - The critical thinking question
 * @property {string} assumptionChallenged - The assumption being challenged
 * @property {string[]} [evidenceFor]    - Supporting evidence for the assumption
 * @property {string[]} [evidenceAgainst]- Evidence against the assumption
 * @property {string} impactIfWrong      - Consequences if assumption is wrong
 * @property {number} priority           - Priority level (1-10, integer)
 * @property {string} domain             - Domain or context for the question
 *
 * @typedef {Object} ValidationResult
 * @property {boolean} valid      - Whether validation passed
 * @property {string} [error]     - Top-level error (type/count issue)
 * @property {string[]} [details] - Per-field error messages
 */

const MIN_QUESTION_COUNT = 5;
const MAX_QUESTION_COUNT = 15;
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 10;

const REQUIRED_STRING_FIELDS = ['question', 'assumptionChallenged', 'impactIfWrong', 'domain'];
const REQUIRED_FIELDS = [...REQUIRED_STRING_FIELDS, 'priority'];
const OPTIONAL_ARRAY_FIELDS = ['evidenceFor', 'evidenceAgainst'];

/**
 * Validate a single Socratic question object.
 * Returns { valid: true } or { valid: false, error?: string, details?: string[] }.
 *
 * @param {any} question
 * @returns {ValidationResult}
 */
function validateSocraticQuestion(question) {
  if (question === null || question === undefined || typeof question !== 'object' || Array.isArray(question)) {
    return {
      valid: false,
      error: 'Question must be an object',
      details: []
    };
  }

  const errors = [];

  // Required string fields
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!(field in question)) {
      errors.push(`missing required field "${field}"`);
    } else if (typeof question[field] !== 'string') {
      errors.push(`field "${field}" must be a string`);
    } else if (!question[field].trim()) {
      errors.push(`field "${field}" cannot be empty`);
    }
  }

  // Required number field: priority
  if (!('priority' in question)) {
    errors.push('missing required field "priority"');
  } else if (typeof question.priority !== 'number') {
    errors.push('field "priority" must be a number');
  } else if (!Number.isInteger(question.priority)) {
    errors.push('field "priority" must be an integer');
  } else if (question.priority < MIN_PRIORITY || question.priority > MAX_PRIORITY) {
    errors.push(`field "priority" must be between ${MIN_PRIORITY} and ${MAX_PRIORITY} (got ${question.priority})`);
  }

  // Optional array fields
  for (const field of OPTIONAL_ARRAY_FIELDS) {
    if (field in question && question[field] !== null && question[field] !== undefined) {
      if (!Array.isArray(question[field])) {
        errors.push(`field "${field}" must be an array`);
      } else {
        question[field].forEach((item, i) => {
          if (typeof item !== 'string') {
            errors.push(`${field}[${i}] must be a string`);
          }
        });
      }
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
 * Validate an array of Socratic questions and enforce the 5-15 count constraint.
 * Returns { valid: true } or { valid: false, error: string, details?: string[] }.
 *
 * Count constraints are hard errors (not warnings): fewer than 5 or more than 15
 * questions causes a validation failure.
 *
 * @param {any} questions
 * @returns {ValidationResult}
 */
function validateQuestionSchema(questions) {
  if (!Array.isArray(questions)) {
    return {
      valid: false,
      error: 'Questions must be an array',
      details: []
    };
  }

  // Check count constraints FIRST (as per original behavior for tests)
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

  // Then validate individual questions
  const allErrors = [];
  questions.forEach((q, idx) => {
    const result = validateSocraticQuestion(q);
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
      error: `Question validation failed with ${allErrors.length} error(s)`,
      details: allErrors
    };
  }

  return { valid: true };
}

/**
 * Primary export: validate an array of Socratic questions.
 * Alias for validateQuestionSchema, exposed under the canonical name.
 *
 * @param {any} questions
 * @returns {ValidationResult}
 */
const validateSocraticQuestions = validateQuestionSchema;

export {
  validateSocraticQuestion,
  validateQuestionSchema,
  validateSocraticQuestions,
  MIN_QUESTION_COUNT,
  MAX_QUESTION_COUNT,
  MIN_PRIORITY,
  MAX_PRIORITY,
  REQUIRED_FIELDS,
  REQUIRED_STRING_FIELDS,
  OPTIONAL_ARRAY_FIELDS
};
