/**
 * Guardrails Framework — Ordered rule execution for pre/post-dispatch validation.
 *
 * GuardrailChain runs ordered rules on dispatch context, supporting:
 * - Pre-dispatch validation (prompt, token budget, content policy)
 * - Post-dispatch validation (response schema, content policy)
 * - Enforcement modes: advisory (log only) or blocking (halt dispatch)
 * - Operator overrides to downgrade blocking rules to advisory
 */

import { createLogger } from './logger.js';
import { classifyIp } from './ssrf-filter.js';

const log = createLogger('guardrails');

/**
 * Estimates token count using a simple chars/4 heuristic.
 */
function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Truncates text for payload excerpts in violations.
 */
function truncateExcerpt(text, maxLength = 200) {
  if (typeof text !== 'string') return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

/**
 * GuardrailChain — Executes ordered rules on dispatch context.
 */
export class GuardrailChain {
  constructor() {
    this.rules = [];
  }

  /**
   * Register a guardrail rule.
   * @param {object} rule - {name, phase, enforcementMode, check}
   */
  register(rule) {
    if (!rule.name || !rule.phase || !rule.check) {
      throw new Error('Rule must have name, phase, and check function');
    }
    this.rules.push(rule);
    log.info(`Registered guardrail rule: ${rule.name} (${rule.phase}, ${rule.enforcementMode})`);
  }

  /**
   * Run rules for a specific phase.
   * @param {string} phase - 'pre' or 'post'
   * @param {object} context - {prompt, response, operatorOverride}
   * @returns {object} {allowed: boolean, violations: [...]}
   */
  run(phase, context) {
    const violations = [];
    let allowed = true;

    // Filter rules for this phase
    const applicableRules = this.rules.filter(r => r.phase === phase || r.phase === 'both');

    for (const rule of applicableRules) {
      // Check for operator override
      let effectiveEnforcementMode = rule.enforcementMode;
      if (context.operatorOverride && context.operatorOverride.includes(rule.name)) {
        effectiveEnforcementMode = 'advisory';
        log.info(`Operator override applied: ${rule.name} downgraded to advisory`);
      }

      // Execute rule check
      const violation = rule.check(context);
      if (violation) {
        violations.push({
          rule: rule.name,
          message: violation.message || `Rule ${rule.name} violated`,
          severity: rule.severity || 'medium',
          enforcementMode: effectiveEnforcementMode,
          payloadExcerpt: violation.payloadExcerpt,
        });

        log.warn(`Guardrail violation: ${rule.name} - ${violation.message}, enforcementMode=${effectiveEnforcementMode}`);

        // If blocking mode and no override, deny dispatch
        if (effectiveEnforcementMode === 'blocking') {
          allowed = false;
        }
      }
      log.debug(`Rule ${rule.name}: enforcementMode=${rule.enforcementMode}, effectiveEnforcementMode=${effectiveEnforcementMode}, currentAllowed=${allowed}`);
    }
    log.debug(`GuardrailChain.run returning allowed=${allowed}, violations=${violations.length}`);
    return { allowed, violations };
  }

  /**
   * Convenience method for pre-dispatch validation.
   * @param {object} context - {prompt, agentId, projectId, operatorOverride}
   * @returns {object} {passed: boolean, violations: [...]}
   */
  runPreDispatch(context) {
    const result = this.run('pre', context);
    return {
      passed: result.allowed,
      violations: result.violations.map(v => ({
        ...v,
        ruleName: v.rule,
      })),
    };
  }

  /**
   * Convenience method for post-dispatch validation.
   * @param {object} context - {prompt, response, agentId, projectId, operatorOverride}
   * @returns {object} {passed: boolean, violations: [...]}
   */
  runPostDispatch(context) {
    const result = this.run('post', context);
    return {
      passed: result.allowed,
      violations: result.violations.map(v => ({
        ...v,
        ruleName: v.rule,
      })),
    };
  }

  /**
   * Clear all registered rules (for testing).
   */
  _clearRules() {
    this.rules = [];
    log.info('Cleared all guardrail rules');
  }
}

/**
 * Token Budget Rule — Pre-dispatch rule that checks prompt token count.
 * @param {object} opts - {name, maxTokens, enforcementMode, severity}
 */
export function tokenBudgetRule({ name: ruleName, maxTokens, enforcementMode = 'blocking', severity = 'critical' }) {
  return {
    name: ruleName || 'token-budget',
    phase: 'pre',
    enforcementMode,
    severity,
    check: (context) => {
      const { prompt } = context;
      const estimatedTokens = estimateTokens(prompt);

      if (estimatedTokens > maxTokens) {
        return {
          message: `Prompt exceeds token budget. Estimated: ${estimatedTokens}, Max: ${maxTokens}`,
          payloadExcerpt: truncateExcerpt(prompt),
        };
      }
      return null;
    },
  };
}

/**
 * Output Schema Rule — Post-dispatch rule that validates agent response against schema.
 * @param {object} opts - {name, schema, enforcementMode, severity}
 */
export function outputSchemaRule({ name: ruleName, schema, enforcementMode = 'blocking', severity = 'critical' }) {
  return {
    name: ruleName || 'output-schema',
    phase: 'post',
    enforcementMode,
    severity,
    check: (context) => {
      const { response } = context;

      if (!response) {
        return {
          message: 'No response received to validate against schema',
          payloadExcerpt: 'null',
        };
      }

      // Parse response if it's a string
      let parsedResponse = response;
      if (typeof response === 'string') {
        try {
          parsedResponse = JSON.parse(response);
        } catch (err) {
          return {
            message: 'Response is not valid JSON',
            payloadExcerpt: truncateExcerpt(response),
          };
        }
      }

      // Check required fields
      if (schema.required) {
        for (const key of schema.required) {
          if (parsedResponse[key] === undefined) {
            return {
              message: `Missing required field: ${key}`,
              payloadExcerpt: truncateExcerpt(JSON.stringify(parsedResponse)),
            };
          }
        }
      }

      // Check field types
      if (schema.properties) {
        for (const [key, schemaProp] of Object.entries(schema.properties)) {
          const value = parsedResponse[key];
          if (value !== undefined && schemaProp.type) {
            const actualType = Array.isArray(value) ? 'array' : typeof value;
            const expectedType = schemaProp.type;

            if (expectedType === 'integer' && actualType === 'number' && !Number.isInteger(value)) {
              return {
                message: `Field '${key}' must be integer, got non-integer number`,
                payloadExcerpt: truncateExcerpt(JSON.stringify(parsedResponse)),
              };
            }

            if (actualType !== expectedType && !(expectedType === 'number' && actualType === 'number')) {
              return {
                message: `Field '${key}' has wrong type. Expected ${expectedType}, got ${actualType}`,
                payloadExcerpt: truncateExcerpt(JSON.stringify(parsedResponse)),
              };
            }
          }
        }
      }

      return null;
    },
  };
}

/**
 * Content Policy Rule — Dual-phase rule that scans prompt and response for blocked patterns.
 * @param {object} opts - {name, blockedPatterns, enforcementMode, severity}
 */
export function contentPolicyRule({ name: ruleName, blockedPatterns, enforcementMode = 'blocking', severity = 'critical' }) {
  const regexes = blockedPatterns.map(pattern => new RegExp(pattern, 'i'));

  return {
    name: ruleName || 'content-policy',
    phase: 'both',
    enforcementMode,
    severity,
    check: (context) => {
      const { prompt, response } = context;

      // Check prompt (pre-dispatch)
      if (prompt) {
        for (const regex of regexes) {
          if (regex.test(prompt)) {
            return {
              message: `Content policy violation in prompt: matched pattern '${regex.source}'`,
              payloadExcerpt: truncateExcerpt(prompt),
            };
          }
        }
      }

      // Check response (post-dispatch)
      if (response) {
        const responseText = typeof response === 'string' ? response : JSON.stringify(response);
        for (const regex of regexes) {
          if (regex.test(responseText)) {
            return {
              message: `Content policy violation in response: matched pattern '${regex.source}'`,
              payloadExcerpt: truncateExcerpt(responseText),
            };
          }
        }
      }

      return null;
    },
  };
}

/**
 * SSRF Guard Rule — Synchronous pre-dispatch rule that blocks dispatches to agents
 * whose configured endpoints resolve to private/reserved IP ranges.
 *
 * Uses classifyIp() from ssrf-filter for synchronous IP literal checks.
 * For hostname-based endpoints the rule checks against an optional denylist.
 * Only runs in the 'pre' phase (no-op in 'post').
 *
 * @param {object} [opts] - Optional overrides
 * @param {string[]} [opts.denylist] - Extra hostname patterns to block
 */
export function ssrfGuardRule(opts = {}) {
  const extraDenylist = opts.denylist || [];

  return {
    name: 'ssrf-guard',
    phase: 'pre',
    enforcementMode: 'blocking',
    severity: 'critical',
    check: (context) => {
      const endpoint = context?.agentConfig?.endpoint;
      if (!endpoint) return null;

      let hostname;
      try {
        hostname = new URL(endpoint).hostname;
        // Strip IPv6 brackets
        if (hostname.startsWith('[') && hostname.endsWith(']')) {
          hostname = hostname.slice(1, -1);
        }
      } catch {
        return {
          message: `SSRF guard: invalid endpoint URL: ${endpoint}`,
          payloadExcerpt: String(endpoint).slice(0, 200),
        };
      }

      // Check extra denylist (hostname string match)
      for (const pattern of extraDenylist) {
        if (hostname === pattern || hostname.endsWith('.' + pattern)) {
          return {
            message: `SSRF guard: endpoint hostname blocked by denylist (${pattern})`,
            payloadExcerpt: endpoint.slice(0, 200),
          };
        }
      }

      // Synchronous IP check — works for IP literals; hostnames that aren't IPs pass through
      const classification = classifyIp(hostname);
      if (classification) {
        return {
          message: `SSRF guard: endpoint resolves to private/reserved IP range (${hostname} in ${classification.range})`,
          payloadExcerpt: endpoint.slice(0, 200),
        };
      }

      return null;
    },
  };
}
