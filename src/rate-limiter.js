// Per-client rate limiting — sliding window, no external deps.
// Tracks request counts per IP (or token) in a rolling time window.

import { createLogger } from './logger.js';

const log = createLogger('rate-limiter');

const DEFAULT_MAX_REQUESTS = 120;   // per window
const DEFAULT_WINDOW_MS = 60000;    // 1 minute

export function createRateLimiter(config = {}) {
  const maxRequests = config.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
  const enabled = config.enabled !== false;
  const trustedProxies = new Set(config.trustedProxies || []);

  // Map<clientId, timestamp[]> — timestamps of recent requests
  const clients = new Map();

  // Periodic cleanup — remove stale entries every 5 minutes
  const cleanupInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of clients) {
      const valid = timestamps.filter(t => t > cutoff);
      if (valid.length === 0) clients.delete(key);
      else clients.set(key, valid);
    }
  }, 300000);
  if (cleanupInterval.unref) cleanupInterval.unref();

  // Network identity only — never influenced by request headers an attacker
  // can rotate (XFF is honored only from configured trusted proxies).
  function getClientIp(req) {
    const remoteAddress = req.socket?.remoteAddress || 'unknown';
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded && trustedProxies.has(remoteAddress)) {
      return `ip:${forwarded.split(',')[0].trim()}`;
    }
    return `ip:${remoteAddress}`;
  }

  // Identify client by token or IP
  function getClientId(req) {
    // Prefer token-based identity (more accurate than IP)
    const auth = req.headers?.authorization;
    if (auth?.startsWith('Bearer ')) return `token:${auth.slice(7, 23)}`; // first 16 chars
    return getClientIp(req);
  }

  // Check if request is allowed. Returns { allowed, remaining, retryAfterMs }
  function check(clientId) {
    if (!enabled) return { allowed: true, remaining: maxRequests, retryAfterMs: 0 };

    const now = Date.now();
    const cutoff = now - windowMs;
    let timestamps = clients.get(clientId) || [];
    timestamps = timestamps.filter(t => t > cutoff);

    if (timestamps.length >= maxRequests) {
      // Rate limited — calculate when the oldest request in window will expire
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      clients.set(clientId, timestamps);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    timestamps.push(now);
    clients.set(clientId, timestamps);
    return { allowed: true, remaining: maxRequests - timestamps.length, retryAfterMs: 0 };
  }

  // HTTP middleware — returns true if request is allowed, sends 429 if not
  function checkRequest(req, res, options = {}) {
    if (!enabled) return true;

    // Health and OpenAPI endpoints exempt
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/health') return true;
      if (url.pathname === '/api/openapi.json') return true;
    } catch { /* ignore parse errors */ }

    const scope = options.scope || 'api';
    const requestLimit = options.maxRequests ?? maxRequests;
    // Login attempts carry the password in the BODY; the Authorization header
    // on a login request is attacker-chosen. Keying login buckets on it let a
    // brute-forcer reset the counter every attempt by rotating a fake Bearer
    // value. Login is therefore keyed on network identity only.
    const clientId = scope === 'login'
      ? `${scope}:${getClientIp(req)}`
      : `${scope}:${getClientId(req)}`;
    const now = Date.now();
    const cutoff = now - windowMs;
    let timestamps = (clients.get(clientId) || []).filter(t => t > cutoff);
    const allowed = timestamps.length < requestLimit;
    let retryAfterMs = 0;
    if (allowed) timestamps.push(now);
    else retryAfterMs = Math.max(0, timestamps[0] + windowMs - now);
    clients.set(clientId, timestamps);
    const result = {
      allowed,
      remaining: allowed ? requestLimit - timestamps.length : 0,
      retryAfterMs,
    };

    // Set rate limit headers on all responses
    res.setHeader('X-RateLimit-Limit', requestLimit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Window', Math.ceil(windowMs / 1000));

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Too Many Requests',
        retryAfter: retryAfterSec,
        limit: requestLimit,
        windowSeconds: Math.ceil(windowMs / 1000),
      }));
      log.warn('Rate limited', { clientId, limit: requestLimit, windowMs });
      return false;
    }

    return true;
  }

  function getStats() {
    return {
      enabled,
      maxRequests,
      windowMs,
      activeClients: clients.size,
    };
  }

  function stop() {
    clearInterval(cleanupInterval);
    clients.clear();
  }

  return { check, checkRequest, getClientId, getStats, stop };
}
