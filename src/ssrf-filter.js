// SSRF Filter — URL validation and DNS resolution to prevent SSRF attacks.
// Blocks private IP ranges (RFC-1918), cloud metadata endpoints, loopback,
// link-local, and matches against configurable allowlist/denylist patterns.
// Zero npm dependencies — Node built-ins only (url, net, dns).

import { promises as dnsPromises } from 'dns';
import net from 'net';
import { createLogger } from './logger.js';

const log = createLogger('ssrf-filter');

// ─── DNS TTL Cache (rebinding protection) ──────────────────────────
//
// DNS rebinding attack: an attacker's domain resolves to a public IP at
// check time (passes filter), then rapidly re-resolves to a private IP when
// the actual HTTP request is made. Mitigation:
//   1. Cache resolved IPs and reuse within the TTL window — even if DNS changes,
//      the caller gets the validated IP for the full TTL duration.
//   2. Detect IP changes that occur within the rebinding window (5 s) and block
//      requests where the new IP is private/reserved.
//
const DNS_CACHE = new Map(); // hostname → { ip, resolvedAt, expiresAt }
const DNS_CACHE_TTL_MS = 30_000;    // 30 s: reuse validated IP for this duration
const DNS_REBIND_WINDOW_MS = 5_000; // 5 s: IP changes within this window are suspicious

/**
 * Resolve a hostname to an IP address with TTL-based caching.
 * Cache hits return the previously-validated IP without touching DNS.
 * On cache miss / expiry, a fresh lookup is done and rebinding detection runs.
 *
 * @param {string} hostname
 * @returns {Promise<{ ip: string, fromCache: boolean, rebindingDetected: boolean, previousIp?: string }>}
 */
async function resolveWithCache(hostname) {
  const now = Date.now();
  const entry = DNS_CACHE.get(hostname);

  if (entry && now < entry.expiresAt) {
    // Cache hit — return the previously-validated IP.
    // This is the primary rebinding protection: even if DNS has changed since
    // we last checked, we serve the IP we already validated.
    return { ip: entry.ip, fromCache: true, rebindingDetected: false };
  }

  // Cache miss or expired — fresh DNS lookup.
  const { address } = await dnsPromises.lookup(hostname);

  // Rebinding detection: did the IP change suspiciously fast?
  let rebindingDetected = false;
  let previousIp;
  if (entry && entry.ip !== address) {
    const elapsed = now - entry.resolvedAt;
    if (elapsed < DNS_REBIND_WINDOW_MS) {
      rebindingDetected = true;
      previousIp = entry.ip;
      log.warn('DNS rebinding suspected: IP changed within rebind window', {
        hostname,
        previousIp: entry.ip,
        newIp: address,
        elapsedMs: elapsed,
        rebindWindowMs: DNS_REBIND_WINDOW_MS,
      });
    }
  }

  DNS_CACHE.set(hostname, { ip: address, resolvedAt: now, expiresAt: now + DNS_CACHE_TTL_MS });
  return { ip: address, fromCache: false, rebindingDetected, previousIp };
}

/**
 * Clear the DNS resolution cache. Intended for use in tests.
 */
export function clearDnsCache() {
  DNS_CACHE.clear();
}

/**
 * Return a snapshot of the DNS cache for observability/debugging.
 */
export function getDnsCacheStats() {
  const now = Date.now();
  return Array.from(DNS_CACHE.entries()).map(([hostname, entry]) => ({
    hostname,
    ip: entry.ip,
    resolvedAt: entry.resolvedAt,
    expiresAt: entry.expiresAt,
    ttlRemainingMs: Math.max(0, entry.expiresAt - now),
  }));
}

// Only HTTP(S) schemes allowed — block file://, ftp://, gopher://, etc.
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Cloud metadata endpoint IPs — separate from generic link-local for clearer audit trails
const CLOUD_METADATA_IPS = new Set([
  '169.254.169.254',  // AWS IMDS, GCP metadata, Azure IMDS
  '169.254.169.253',  // AWS alternate metadata
  '169.254.170.2',    // AWS ECS task metadata
]);

// ─── IPv4 Helpers ──────────────────────────────────────────────────

/**
 * Convert dotted-decimal IPv4 to unsigned 32-bit number.
 * Uses multiplication (not bit shift) to avoid sign issues with high octets.
 */
function ipv4ToNumber(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const p = Number(part);
    if (!Number.isInteger(p) || p < 0 || p > 255) return null;
    num = num * 256 + p;
  }
  return num;
}

// Pre-computed private/reserved IPv4 ranges: [startNum, endNum, rangeName]
const IPV4_PRIVATE_RANGES = [
  [ipv4ToNumber('10.0.0.0'),    ipv4ToNumber('10.255.255.255'),  'RFC1918-10'],
  [ipv4ToNumber('172.16.0.0'),  ipv4ToNumber('172.31.255.255'),  'RFC1918-172'],
  [ipv4ToNumber('192.168.0.0'), ipv4ToNumber('192.168.255.255'), 'RFC1918-192'],
  [ipv4ToNumber('127.0.0.0'),   ipv4ToNumber('127.255.255.255'), 'loopback'],
  [ipv4ToNumber('169.254.0.0'), ipv4ToNumber('169.254.255.255'), 'link-local'],
  [ipv4ToNumber('0.0.0.0'),     ipv4ToNumber('0.255.255.255'),   'unspecified'],
];

function classifyIPv4(ip) {
  const num = ipv4ToNumber(ip);
  if (num === null) return null;
  for (const [start, end, name] of IPV4_PRIVATE_RANGES) {
    if (num >= start && num <= end) return { range: name };
  }
  return null;
}

// ─── IPv6 Helpers ──────────────────────────────────────────────────

/**
 * Extract IPv4 from IPv6-mapped IPv4 address (::ffff:a.b.c.d or ::ffff:XXYY:ZZWW).
 */
function extractMappedIPv4(ip) {
  const lower = ip.toLowerCase();
  // Dotted form: ::ffff:a.b.c.d
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  // Hex form: ::ffff:XXYY:ZZWW
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function classifyIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1') return { range: 'ipv6-loopback' };
  if (lower.startsWith('fc') || lower.startsWith('fd')) return { range: 'ipv6-ula' };
  // fe80::/10 covers fe80-febf
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return { range: 'ipv6-link-local' };
  if (lower === '::') return { range: 'ipv6-unspecified' };
  return null;
}

/**
 * Classify an IP as private/reserved or public.
 * Handles IPv4, IPv6, and IPv6-mapped IPv4 (::ffff:x.x.x.x).
 * Returns { range: string } for private/reserved, null for public.
 */
function classifyIp(ip) {
  const mapped = extractMappedIPv4(ip);
  if (mapped) return classifyIPv4(mapped);
  if (ip.includes(':')) return classifyIPv6(ip);
  return classifyIPv4(ip);
}

/**
 * Check if an IP is a known cloud metadata endpoint.
 */
function isCloudMetadata(ip) {
  const effective = extractMappedIPv4(ip) || ip;
  return CLOUD_METADATA_IPS.has(effective);
}

// ─── CIDR Helpers ──────────────────────────────────────────────────

/**
 * Parse a CIDR notation string into { networkNum, bits }.
 * Returns null if not a valid IPv4 CIDR block.
 */
function parseCidr(cidr) {
  const slash = cidr.lastIndexOf('/');
  if (slash === -1) return null;
  const ip = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const networkNum = ipv4ToNumber(ip);
  if (networkNum === null) return null;
  return { networkNum, bits };
}

/**
 * Test whether an IPv4 address falls within a CIDR block.
 * Uses unsigned 32-bit arithmetic to avoid sign-extension with high octets.
 * @param {string} ip   - dotted-decimal IPv4 address
 * @param {string} cidr - e.g. "10.0.0.0/8" or "192.168.1.0/24"
 */
function ipv4InCidr(ip, cidr) {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const ipNum = ipv4ToNumber(ip);
  if (ipNum === null) return false;
  if (parsed.bits === 0) return true; // /0 matches all addresses
  // >>> 0 keeps values in unsigned [0, 2^32) range
  const mask = (~((1 << (32 - parsed.bits)) - 1)) >>> 0;
  return ((ipNum >>> 0) & mask) === ((parsed.networkNum >>> 0) & mask);
}

/**
 * Return true if the pattern looks like an IPv4 CIDR block.
 * CIDR patterns are only meaningful against resolved IPs, not hostnames.
 */
function isCidrPattern(pattern) {
  return /^[\d.]+\/\d+$/.test(pattern);
}

/**
 * Match a resolved IPv4 address against an allowlist/denylist CIDR-or-exact-IP entry.
 * Does NOT handle hostname glob patterns — only IP literals and CIDR blocks.
 */
function matchesIpRule(resolvedIp, pattern) {
  if (isCidrPattern(pattern)) return ipv4InCidr(resolvedIp, pattern);
  return resolvedIp === pattern;
}

// ─── Pattern Matching ──────────────────────────────────────────────

/**
 * Simple glob pattern matcher. Supports * and ? wildcards.
 * Regex-special characters are escaped to prevent injection.
 */
function matchGlob(value, pattern) {
  if (pattern === value) return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(value);
}

/**
 * Match a hostname (optionally with port) against a policy pattern.
 * Patterns: "host", "host:port", "*.host", "192.168.*"
 */
function matchesRule(hostname, port, pattern) {
  if (pattern === hostname) return true;
  if (pattern === `${hostname}:${port}`) return true;
  if (matchGlob(hostname, pattern)) return true;
  // Also match against hostname:port for patterns like *.evil.com:8080
  if (matchGlob(`${hostname}:${port}`, pattern)) return true;
  return false;
}

// ─── Main API ──────────────────────────────────────────────────────

/**
 * Check if a URL is allowed by SSRF policy.
 * Resolves hostname to IP and checks against allowlist/denylist and private ranges.
 *
 * Priority order:
 *   1. Disabled → allow all
 *   2. Scheme check → block non-HTTP(S)
 *   3. Allowlist match → allow (overrides denylist and private range blocking)
 *   4. Denylist match → block
 *   5. Cloud metadata IP → block
 *   6. Private IP range → block (when blockPrivateRanges enabled)
 *   7. Default → allow (public IP)
 *
 * @param {string} url - URL to check
 * @param {object} [policy={}] - SSRF policy configuration
 * @param {boolean} [policy.enabled=true] - Whether SSRF filtering is active
 * @param {boolean} [policy.blockPrivateRanges=true] - Block private/reserved IP ranges
 * @param {string[]} [policy.allowlist=[]] - Patterns to explicitly allow
 * @param {string[]} [policy.denylist=[]] - Patterns to explicitly deny
 * @returns {Promise<{allowed: boolean, reason: string, resolvedIp?: string, matchedRule?: string}>}
 */
export async function checkUrl(url, policy = {}) {
  const {
    enabled = true,
    blockPrivateRanges = true,
    allowlist = [],
    denylist = [],
  } = policy;

  // 0. Bypass when disabled
  if (!enabled) {
    return { allowed: true, reason: 'SSRF filter disabled' };
  }

  // 1. Parse and normalize URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'Invalid URL', matchedRule: 'invalid-url' };
  }

  // 2. Scheme check — only http/https
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: `Unsupported scheme: ${parsed.protocol}`,
      matchedRule: `blocked-scheme:${parsed.protocol}`,
    };
  }

  // Node v20+ returns brackets for IPv6 hostnames — strip them
  const rawHostname = parsed.hostname;
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

  // 3. Allowlist — highest priority, overrides denylist and private range blocking.
  //    CIDR patterns require a resolved IP and are evaluated post-DNS (step 3b below).
  for (const pattern of allowlist) {
    if (!isCidrPattern(pattern) && matchesRule(hostname, port, pattern)) {
      return {
        allowed: true,
        reason: 'Matched allowlist',
        matchedRule: `allowlist:${pattern}`,
      };
    }
  }

  // 4. Denylist — explicit denials.
  //    CIDR patterns require a resolved IP and are evaluated post-DNS (step 4b below).
  for (const pattern of denylist) {
    if (!isCidrPattern(pattern) && matchesRule(hostname, port, pattern)) {
      return {
        allowed: false,
        reason: 'Matched denylist',
        matchedRule: `denylist:${pattern}`,
      };
    }
  }

  // 5. Resolve hostname to IP with TTL-cached DNS (rebinding protection).
  //    IP literals bypass the cache (no DNS needed).
  //    resolveWithCache() returns the same validated IP for DNS_CACHE_TTL_MS,
  //    preventing a DNS change between our check and the caller's actual request.
  let resolvedIp;
  let rebindingDetected = false;
  let rebindingPreviousIp;
  try {
    if (net.isIP(hostname)) {
      resolvedIp = hostname;
    } else {
      const result = await resolveWithCache(hostname);
      resolvedIp = result.ip;
      rebindingDetected = result.rebindingDetected;
      rebindingPreviousIp = result.previousIp;
    }
  } catch (err) {
    log.warn('DNS resolution failed', { hostname, error: err.message });
    return {
      allowed: false,
      reason: `DNS resolution failed: ${err.message}`,
      matchedRule: 'dns-error',
    };
  }

  // 5b. DNS rebinding check: block if IP changed within the rebinding window
  //     AND the new IP is private/reserved. This catches the classic attack
  //     (public → private within TTL) while ignoring legitimate CDN changes
  //     (public → public IP changes never threaten internal network access).
  if (rebindingDetected) {
    const rebindClass = classifyIp(resolvedIp);
    const rebindMeta = isCloudMetadata(resolvedIp);
    if (rebindClass || rebindMeta) {
      return {
        allowed: false,
        reason: `DNS rebinding attack detected: ${hostname} changed from ${rebindingPreviousIp} to private/reserved IP ${resolvedIp} within ${DNS_REBIND_WINDOW_MS}ms`,
        resolvedIp,
        matchedRule: 'dns-rebinding',
      };
    }
  }

  // 3b. Allowlist CIDR/IP-literal check against resolved IP — still highest priority.
  for (const pattern of allowlist) {
    if (isCidrPattern(pattern) && matchesIpRule(resolvedIp, pattern)) {
      return {
        allowed: true,
        reason: 'Matched allowlist (CIDR)',
        resolvedIp,
        matchedRule: `allowlist:${pattern}`,
      };
    }
  }

  // 4b. Denylist CIDR/IP-literal check against resolved IP.
  for (const pattern of denylist) {
    if (isCidrPattern(pattern) && matchesIpRule(resolvedIp, pattern)) {
      return {
        allowed: false,
        reason: 'Matched denylist (CIDR)',
        resolvedIp,
        matchedRule: `denylist:${pattern}`,
      };
    }
  }

  // 7. Private range and cloud metadata checks
  if (blockPrivateRanges !== false) {
    // Cloud metadata endpoints get a specific reason for audit clarity
    if (isCloudMetadata(resolvedIp)) {
      return {
        allowed: false,
        reason: 'Cloud metadata endpoint blocked',
        resolvedIp,
        matchedRule: 'cloud-metadata',
      };
    }

    const classification = classifyIp(resolvedIp);
    if (classification) {
      return {
        allowed: false,
        reason: `Resolved to private IP range (${resolvedIp} in ${classification.range})`,
        resolvedIp,
        matchedRule: `private-range:${classification.range}`,
      };
    }
  }

  // 8. Default: allow public IPs
  return {
    allowed: true,
    reason: 'Allowed (public IP)',
    resolvedIp,
  };
}

// Export helpers for synchronous guardrail rules and tests
export { classifyIp, ipv4InCidr, parseCidr };
// DNS_REBIND_WINDOW_MS exported for tests that need to set up timing assertions
export { DNS_REBIND_WINDOW_MS, DNS_CACHE_TTL_MS };
