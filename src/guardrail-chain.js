// src/guardrail-chain.js

class GuardrailChain {
    constructor() {
        this.preDispatchRules = [];
        this.postDispatchRules = [];
    }

    /**
     * Registers a rule to be executed before dispatching to an agent.
     * @param {string} ruleName - The unique name of the rule.
     * @param {function} ruleFunction - The function implementing the rule. It should take a context object
     *                                  and return a violation object if the rule is broken, or null/undefined otherwise.
     *                                  Violation object structure: { message, payloadExcerpt? }.
     * @param {object} options - Options for the rule.
     * @param {string} options.severity - The severity of the rule (e.g., 'critical', 'high', 'medium', 'low').
     * @param {'advisory'|'blocking'} options.enforcementMode - The enforcement mode ('advisory' or 'blocking').
     */
    registerPreDispatchRule(ruleName, ruleFunction, { severity, enforcementMode }) {
        this.preDispatchRules.push({ ruleName, ruleFunction, severity, enforcementMode });
    }

    /**
     * Registers a rule to be executed after receiving a response from an agent.
     * @param {string} ruleName - The unique name of the rule.
     * @param {function} ruleFunction - The function implementing the rule. It should take a context object
     *                                  and return a violation object if the rule is broken, or null/undefined otherwise.
     *                                  Violation object structure: { message, payloadExcerpt? }.
     * @param {object} options - Options for the rule.
     * @param {string} options.severity - The severity of the rule (e.g., 'critical', 'high', 'medium', 'low').
     * @param {'advisory'|'blocking'} options.enforcementMode - The enforcement mode ('advisory' or 'blocking').
     */
    registerPostDispatchRule(ruleName, ruleFunction, { severity, enforcementMode }) {
        this.postDispatchRules.push({ ruleName, ruleFunction, severity, enforcementMode });
    }

    /**
     * Runs all registered pre-dispatch rules.
     * @param {object} context - The context for pre-dispatch rules (e.g., {prompt, agentId, projectId}).
     * @returns {{passed: boolean, violations: Array<object>}} - An object indicating if all blocking rules passed and a list of all violations.
     */
    runPreDispatch(context) {
        const violations = [];
        let passed = true;

        for (const rule of this.preDispatchRules) {
            const violation = rule.ruleFunction(context);
            if (violation) {
                violations.push({
                    ruleName: rule.ruleName,
                    severity: rule.severity,
                    enforcementMode: rule.enforcementMode,
                    message: violation.message,
                    payloadExcerpt: violation.payloadExcerpt,
                    phase: 'pre-dispatch'
                });
                if (rule.enforcementMode === 'blocking') {
                    passed = false;
                }
            }
        }
        return { passed, violations };
    }

    /**
     * Runs all registered post-dispatch rules.
     * @param {object} context - The context for post-dispatch rules (e.g., {prompt, agentId, projectId, response}).
     * @returns {{passed: boolean, violations: Array<object>}} - An object indicating if all blocking rules passed and a list of all violations.
     */
    runPostDispatch(context) {
        const violations = [];
        let passed = true;

        for (const rule of this.postDispatchRules) {
            const violation = rule.ruleFunction(context);
            if (violation) {
                violations.push({
                    ruleName: rule.ruleName,
                    severity: rule.severity,
                    enforcementMode: rule.enforcementMode,
                    message: violation.message,
                    payloadExcerpt: violation.payloadExcerpt,
                    phase: 'post-dispatch'
                });
                if (rule.enforcementMode === 'blocking') {
                    passed = false;
                }
            }
        }
        return { passed, violations };
    }
}

/**
 * Bootstraps a GuardrailChain with default rules.
 * @returns {GuardrailChain} - An instance of GuardrailChain with default rules registered.
 */
function bootstrapDefaultRules() {
    const chain = new GuardrailChain();

    // Token-budget — prevents pathologically huge prompts from reaching providers.
    // 40_000 chars ≈ 10K tokens. Comfortable headroom for vault context (~1KB) +
    // persona + conversation history. Blocking mode preserves operator visibility
    // (codex R1 reasoning: silent advisory mode would mask runaway prompt growth
    // until it surfaces as provider 4XX or latency, which is worse).
    chain.registerPreDispatchRule(
        'token-budget',
        (context) => {
            const PROMPT_CHAR_LIMIT = 40000;
            if (context.prompt && context.prompt.length > PROMPT_CHAR_LIMIT) {
                return {
                    message: `Prompt exceeds char budget (${context.prompt.length} > ${PROMPT_CHAR_LIMIT}). Trim context or split the request.`,
                    payloadExcerpt: context.prompt.substring(0, 200) + '...',
                };
            }
            return null;
        },
        { severity: 'critical', enforcementMode: 'blocking' }
    );

    // Content-policy — operator-configurable blocked-pattern list.
    // Defaults to empty (no false positives). The earlier hardcoded
    // 'badword1'/'badword2' test fixture was scaffolding that escaped into
    // production via orchestrator.js wiring; replaced with an empty-default
    // policy so operators opt in to specific patterns via config later.
    // Mode kept 'advisory' so flagged prompts still dispatch but get logged.
    chain.registerPreDispatchRule(
        'content-policy',
        (context) => {
            const blockedPatterns = []; // operator-configured; empty = no-op
            if (blockedPatterns.length === 0) return null;
            for (const pattern of blockedPatterns) {
                if (context.prompt && context.prompt.toLowerCase().includes(pattern.toLowerCase())) {
                    return {
                        message: `Prompt matches blocked pattern: ${pattern}`,
                        payloadExcerpt: context.prompt.substring(0, 200) + '...',
                    };
                }
            }
            return null;
        },
        { severity: 'high', enforcementMode: 'advisory' }
    );

    // NOTE: The prior placeholder output-schema rule was removed. It required
    // every response to contain the literal substring `{"action":` and blocked
    // anything that didn't — wrong for chat dispatches, which return markdown
    // text. Real post-dispatch validation belongs in a future configurable
    // rule (see src/guardrail-rules.js for a schema-aware implementation).

    return chain;
}

export { GuardrailChain, bootstrapDefaultRules };
