// Guarded Fetch — SSRF-protected wrapper around Node's global fetch.
// Blocks requests to prohibited hosts and records guardrail events.

import { checkUrl } from './ssrf-filter.js';
import ssrfConfigStore from './ssrf-config-store.js';
import { createLogger } from './logger.js';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

const log = createLogger('guarded-fetch');

let timelineStore = null;
let operatorAuditStore = null;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Perform the actual HTTP request against the IP address that passed policy
 * validation. The Host header and TLS servername remain the original hostname,
 * so virtual hosting and certificate verification continue to work.
 */
async function pinnedFetch(input, init, resolvedIp) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'host')) headers.host = url.host;
  const body = ['GET', 'HEAD'].includes(request.method)
    ? null
    : Buffer.from(await request.arrayBuffer());

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      protocol: url.protocol,
      hostname: resolvedIp,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
    };
    if (url.protocol === 'https:' && net.isIP(url.hostname) === 0) {
      options.servername = url.hostname;
    }

    const req = transport.request(options, res => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach(v => responseHeaders.append(name, v));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const noBody = request.method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
      const responseBody = noBody ? null : Readable.toWeb(res);
      resolve(new Response(responseBody, {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: responseHeaders,
      }));
    });
    req.on('error', reject);
    if (request.signal) {
      const abort = () => req.destroy(request.signal.reason || new DOMException('Aborted', 'AbortError'));
      if (request.signal.aborted) return abort();
      request.signal.addEventListener('abort', abort, { once: true });
      req.once('close', () => request.signal.removeEventListener('abort', abort));
    }
    if (body?.length) req.write(body);
    req.end();
  });
}

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
  const checkUrlImpl = opts.checkUrlImpl || checkUrl;
  const checkResult = await checkUrlImpl(url, policy);

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

  // Request is allowed. Pin the connection to the address that was actually
  // validated and take manual control of redirects so every Location target
  // passes the same policy before another socket is opened.
  const request = new Request(input, init);
  const method = request.method;
  const headers = new Headers(request.headers);
  const body = ['GET', 'HEAD'].includes(method)
    ? null
    : await request.clone().arrayBuffer();
  // Disabled policies intentionally bypass resolution; preserve that explicit
  // operator choice while still retaining manual redirect handling.
  const fetchImpl = opts.fetchImpl || (checkResult.resolvedIp ? pinnedFetch : fetch);
  const response = await fetchImpl(request, { redirect: 'manual' }, checkResult.resolvedIp);

  const location = response.headers.get('location');
  if (!REDIRECT_STATUSES.has(response.status) || !location) return response;

  const redirectCount = opts._redirectCount || 0;
  const maxRedirects = opts.maxRedirects ?? 5;
  if (redirectCount >= maxRedirects) {
    const error = new Error(`SSRF redirect limit exceeded (${maxRedirects})`);
    error.code = 'SSRF_REDIRECT_LIMIT';
    throw error;
  }

  const nextUrl = new URL(location, url);
  let nextMethod = method;
  let nextBody = body;
  if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
    nextMethod = 'GET';
    nextBody = null;
    headers.delete('content-length');
    headers.delete('content-type');
  }
  if (nextUrl.origin !== new URL(url).origin) {
    headers.delete('authorization');
    headers.delete('cookie');
  }

  return guardedFetch(nextUrl, {
    method: nextMethod,
    headers,
    body: nextBody,
    signal: request.signal,
  }, { ...opts, _redirectCount: redirectCount + 1 });
}

// Export as default for convenience
export default guardedFetch;
