// Guarded Fetch — SSRF-protected wrapper around Node's global fetch.
// Blocks requests to prohibited hosts and records guardrail events.

import { checkUrl } from './ssrf-filter.js';
import ssrfConfigStore from './ssrf-config-store.js';
import { createLogger } from './logger.js';

const log = createLogger('guarded-fetch');

let timelineStore = null;
let operatorAuditStore = null;

/**
 * Initialize guarded-fetch with dependency injection
 * @param {{ timelineStore: object, operatorAuditStore: object }} deps
 */
export function init(deps) {
  timelineStore = deps.timelineStore;
  operatorAuditStore = deps.operatorAuditStore;
  log.info('Guarded fetch initialized');
}

/**
 * SSRF-protected fetch wrapper.
 * Checks URL against SSRF policy before making request.
 * Records guardrail events for blocked and explicitly allowed requests.
 *
 * @param {string|URL|Request} input - URL or Request object
 * @param {RequestInit} [init] - Fetch options
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivateRanges] - Suppress private-range
 *   classification blocks (loopback/RFC1918) for operator-configured
 *   endpoints (e.g. MCP servers from config). Explicit denylist entries,
 *   cloud-metadata IPs, blocked schemes, and DNS-rebinding detection still
 *   block — only the blanket private-range rule is relaxed.
 * @returns {Promise<Response>}
 * @throws {Error} If request is blocked by SSRF policy
 */
export async function guardedFetch(input, init, opts = {}) {
  // Extract URL from input
  let url;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  } else {
    throw new TypeError('First argument must be a string, URL, or Request object');
  }

  // Check against SSRF policy
  const policy = ssrfConfigStore.getPolicy();
  const checkResult = await checkUrl(url, policy);

  // The DEFAULT_POLICY denylist duplicates the private-range classification
  // (so protection holds when blockPrivateRanges is off). For
  // allowPrivateRanges callers, blocks from those default entries must be
  // suppressed too — otherwise a fresh install (no policy file) still blocks
  // localhost MCP servers. Cloud-metadata, multicast/reserved, and
  // operator-added denylist entries stay blocked.
  const PRIVATE_EQUIVALENT_RULES = new Set([
    'denylist:127.0.0.0/8', 'denylist:10.0.0.0/8', 'denylist:172.16.0.0/12',
    'denylist:192.168.0.0/16', 'denylist:::1/128', 'denylist:fc00::/7',
  ]);
  if (!checkResult.allowed
      && opts.allowPrivateRanges
      && (String(checkResult.matchedRule || '').startsWith('private-range:')
          || PRIVATE_EQUIVALENT_RULES.has(String(checkResult.matchedRule || '')))) {
    log.debug('Private-range block suppressed for operator-configured endpoint', {
      url, matchedRule: checkResult.matchedRule,
    });
    checkResult.allowed = true;
  }

  if (!checkResult.allowed) {
    // Record blocked request
    const eventData = {
      outcome: 'block',
      ruleId: 'ssrf-denylist',
      ruleName: 'SSRF Denylist Guard',
      data: {
        url,
        reason: checkResult.reason,
        resolvedIp: checkResult.resolvedIp,
        matchedRule: checkResult.matchedRule,
      },
    };

    // Record to timeline store if available
    if (timelineStore && typeof timelineStore.appendGuardrailEvent === 'function') {
      try {
        timelineStore.appendGuardrailEvent(eventData);
      } catch (err) {
        log.warn('Failed to append guardrail event to timeline', { error: err.message });
      }
    }

    // Record to audit store if available
    if (operatorAuditStore) {
      try {
        operatorAuditStore.append({
          actionType: 'ssrf_violation',
          target: url,
          decision: 'blocked',
          reason: checkResult.reason,
          payload: {
            resolvedIp: checkResult.resolvedIp,
            matchedRule: checkResult.matchedRule,
          },
        });
      } catch (err) {
        log.warn('Failed to append SSRF violation to audit store', { error: err.message });
      }
    }

    // Throw error to block the request
    const error = new Error(`SSRF policy violation: ${checkResult.reason} (rule: ${checkResult.matchedRule})`);
    error.code = 'SSRF_BLOCKED';
    error.url = url;
    error.matchedRule = checkResult.matchedRule;
    throw error;
  }

  // Record advisory event for explicitly allowed requests (matched allowlist)
  if (checkResult.matchedRule && checkResult.matchedRule.startsWith('allowlist:')) {
    const eventData = {
      outcome: 'allow',
      ruleId: 'ssrf-allowlist',
      ruleName: 'SSRF Allowlist Guard',
      data: {
        url,
        reason: checkResult.reason,
        matchedRule: checkResult.matchedRule,
      },
    };

    if (timelineStore && typeof timelineStore.appendGuardrailEvent === 'function') {
      try {
        timelineStore.appendGuardrailEvent(eventData);
      } catch (err) {
        log.warn('Failed to append allowlist advisory event', { error: err.message });
      }
    }
  }

  // Request is allowed - proceed with fetch
  return fetch(input, init);
}

// Export as default for convenience
export default guardedFetch;
