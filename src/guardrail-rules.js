const DEFAULT_SEVERITY = 'critical';
const DEFAULT_ENFORCEMENT_MODE = 'blocking';
const PAYLOAD_EXCERPT_TRUNCATION_LENGTH = 200;

function truncateExcerpt(text) {
    if (typeof text !== 'string') {
        return '';
    }
    return text.length > PAYLOAD_EXCERPT_TRUNCATION_LENGTH
        ? text.substring(0, PAYLOAD_EXCERPT_TRUNCATION_LENGTH) + '...'
        : text;
}

/**
 * Estimates token count using a simple chars/4 heuristic.
 */
function estimateTokens(text) {
    if (typeof text !== 'string') {
        return 0;
    }
    return Math.ceil(text.length / 4);
}

/**
 * Token Budget Rule: Pre-dispatch rule that estimates token count from the prompt string
 * and blocks if over budget.
 * @param {object} options
 * @param {number} options.maxTokens - The maximum allowed tokens.
 * @param {string} [options.severity='critical'] - The severity of the rule.
 * @returns {GuardrailRule}
 */
function tokenBudgetRule({ maxTokens, severity = DEFAULT_SEVERITY }) {
    return {
        name: 'token-budget',
        severity,
        enforcementMode: DEFAULT_ENFORCEMENT_MODE,
        phase: 'pre-dispatch',
        validate: (context) => {
            const { prompt } = context;
            const estimatedTokens = estimateTokens(prompt);

            if (estimatedTokens > maxTokens) {
                return {
                    passed: false,
                    message: `Prompt exceeds token budget. Estimated: ${estimatedTokens}, Max: ${maxTokens}.`,
                    payloadExcerpt: truncateExcerpt(prompt),
                };
            }
            return { passed: true };
        },
    };
}

/**
 * Output Schema Rule: Post-dispatch rule that validates agent response against a JSON schema object.
 * Lightweight validation: checks required keys exist and types match.
 * @param {object} options
 * @param {object} options.schema - The JSON schema to validate against.
 * @param {string} [options.severity='critical'] - The severity of the rule.
 * @returns {GuardrailRule}
 */
function outputSchemaRule({ schema, severity = DEFAULT_SEVERITY }) {
    return {
        name: 'output-schema',
        severity,
        enforcementMode: DEFAULT_ENFORCEMENT_MODE,
        phase: 'post-dispatch',
        validate: (context) => {
            const { response } = context;
            if (!response) {
                return {
                    passed: false,
                    message: 'No response received to validate against schema.',
                    payloadExcerpt: 'No response',
                };
            }

            // Basic required key and type validation
            for (const key in schema.properties) {
                const schemaProp = schema.properties[key];
                const responseValue = response[key];

                if (schema.required && schema.required.includes(key) && responseValue === undefined) {
                    return {
                        passed: false,
                        message: `Missing required key: '${key}'.`,
                        payloadExcerpt: truncateExcerpt(JSON.stringify(response)),
                    };
                }

                if (responseValue !== undefined) {
                    // Basic type checking
                    const actualType = Array.isArray(responseValue) ? 'array' : typeof responseValue;
                    if (schemaProp.type === 'integer' && actualType === 'number' && !Number.isInteger(responseValue)) {
                        return {
                            passed: false,
                            message: `Key '${key}' expected type '${schemaProp.type}', but got a non-integer number.`,
                            payloadExcerpt: truncateExcerpt(JSON.stringify(response)),
                        };
                    } else if (schemaProp.type !== actualType && !(schemaProp.type === 'integer' && actualType === 'number')) { // Allow integer values to satisfy 'integer' schema type
                        return {
                            passed: false,
                            message: `Key '${key}' expected type '${schemaProp.type}', but got '${actualType}'.`,
                            payloadExcerpt: truncateExcerpt(JSON.stringify(response)),
                        };
                    }
                }
            }

            return { passed: true };
        },
    };
}

/**
 * Content Policy Rule: Dual-phase rule that scans input/output text against an array of regex patterns for policy violations.
 * @param {object} options
 * @param {string[]} options.blockedPatterns - An array of regex pattern strings.
 * @param {string} [options.severity='critical'] - The severity of the rule.
 * @returns {GuardrailRule}
 */
function contentPolicyRule({ blockedPatterns, severity = DEFAULT_SEVERITY }) {
    const regexes = blockedPatterns.map(pattern => new RegExp(pattern, 'i')); // Case-insensitive

    return {
        name: 'content-policy',
        severity,
        enforcementMode: DEFAULT_ENFORCEMENT_MODE,
        phase: 'dual-phase',
        validate: (context) => {
            const { prompt, response } = context;

            const checkText = (text, type) => {
                if (typeof text !== 'string') {
                    return null;
                }
                for (const regex of regexes) {
                    const match = text.match(regex);
                    if (match) {
                        return {
                            passed: false,
                            message: `Content policy violation in ${type}: matched pattern '${regex.source}'.`,
                            payloadExcerpt: truncateExcerpt(text),
                        };
                    }
                }
                return null;
            };

            // Check prompt for violations (pre-dispatch)
            const promptViolation = checkText(prompt, 'prompt');
            if (promptViolation) {
                return promptViolation;
            }

            // Check response for violations (post-dispatch)
            // Note: In dual-phase, if a pre-dispatch check fails, it returns.
            // If it passes, then for post-dispatch it will check the response.
            // The `phase` property determines when `validate` is called.
            // For `dual-phase`, `validate` is called for both pre and post dispatch if needed.
            if (response !== undefined) {
                const responseViolation = checkText(JSON.stringify(response), 'response'); // Stringify response object for scanning
                if (responseViolation) {
                    return responseViolation;
                }
            }

            return { passed: true };
        },
    };
}

/**
 * Registers default guardrail rules with sensible defaults.
 * @param {object} registry - The rule registry object.
 * @param {object} config - Configuration object for thresholds.
 * @param {number} [config.maxTokens=4000] - Default max tokens for tokenBudgetRule.
 * @param {object} [config.outputSchema={}] - Default schema for outputSchemaRule.
 * @param {string[]} [config.blockedPatterns=[]] - Default blocked patterns for contentPolicyRule.
 */
function bootstrapDefaultRules(registry, config = {}) {
    const {
        maxTokens = 4000,
        outputSchema = {},
        blockedPatterns = [],
    } = config;

    registry.addRule(tokenBudgetRule({ maxTokens }));
    registry.addRule(outputSchemaRule({ schema: outputSchema }));
    registry.addRule(contentPolicyRule({ blockedPatterns }));
}

export {
    tokenBudgetRule,
    outputSchemaRule,
    contentPolicyRule,
    bootstrapDefaultRules,
};
