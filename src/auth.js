// API authentication — pre-shared token, auto-generated on first run.
// Supports token rotation with grace period for seamless client updates.
// Session cookies for browser-based access (login once, stay logged in).
// Optional SYNAPSE_PASSWORD for human-memorable login from phone/remote.
// Zero npm dependencies — Node.js crypto built-ins only.

import { randomBytes, timingSafeEqual, createHmac, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';
import { createApiKeyStore } from './orchestrator/api-key-store.js';

const log = createLogger('auth');

const TOKEN_BYTES = 32; // 256-bit

// ─── Auth-at-rest encryption (machine-keyed AES-256-GCM) ────────────────────
// auth.json is encrypted using a key derived from /etc/machine-id + a fixed salt.
// A stolen auth.json is useless without the machine it was generated on.
// The CredentialVault uses the auth token as its own master secret separately.

let _machineKeyCache = null;
function _getMachineKey(keyDir) {
  if (_machineKeyCache) return _machineKeyCache;
  let entropy;
  try {
    entropy = readFileSync('/etc/machine-id', 'utf-8').trim();
    if (!entropy) throw new Error('empty machine-id');
  } catch {
    // No /etc/machine-id (macOS, some containers): use a persisted random
    // secret instead of guessable hostname/username, which would make the
    // at-rest encryption decorative.
    const secretPath = join(keyDir, '.machine-key');
    try {
      entropy = readFileSync(secretPath, 'utf-8').trim();
      if (!entropy) throw new Error('empty');
    } catch {
      entropy = randomBytes(32).toString('hex');
      mkdirSync(keyDir, { recursive: true });
      writeFileSync(secretPath, entropy, { mode: 0o600 });
    }
  }
  // Fixed salt scoped to this feature — changing it would invalidate all auth files
  _machineKeyCache = scryptSync(entropy, 'synapse-auth-at-rest-v1', 32);
  return _machineKeyCache;
}

function _encryptAuthData(plainObj, keyDir) {
  const key = _getMachineKey(keyDir);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const text = JSON.stringify(plainObj);
  const encrypted = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _encrypted: true,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function _decryptAuthData(envelope, keyDir) {
  const key = _getMachineKey(keyDir);
  const iv = Buffer.from(envelope.iv, 'hex');
  const tag = Buffer.from(envelope.tag, 'hex');
  const ciphertext = Buffer.from(envelope.data, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = decipher.update(ciphertext) + decipher.final('utf-8');
  return JSON.parse(plain);
}
// ────────────────────────────────────────────────────────────────────────────
const DEFAULT_EXPIRY_DAYS = 30;
const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 1 hour grace for old token after rotation
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days
const COOKIE_NAME = 'synapse_session';

function safeEqual(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const cookies = {};
  header.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  });
  return cookies;
}

export function createAuth(config, baseDir) {
  const enabled = config.auth.enabled;
  const expiryDays = config.auth.tokenExpiryDays ?? DEFAULT_EXPIRY_DAYS;
  const gracePeriodMs = config.auth.graceMs ?? DEFAULT_GRACE_MS;
  const tokenPath = join(baseDir, '.synapse', 'auth.json');
  const apiKeys = createApiKeyStore(join(baseDir, '.synapse'));
  const password = process.env.SYNAPSE_PASSWORD || null;
  let token = null;
  let previousToken = null;     // old token during grace period
  let graceExpiresAt = null;    // when old token stops working
  let tokenExpiresAt = null;    // when current token expires

  function generateToken() {
    return randomBytes(TOKEN_BYTES).toString('hex');
  }

  function saveTokenData(data) {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, JSON.stringify(_encryptAuthData(data, dirname(tokenPath)), null, 2), { mode: 0o600 });
    // mode option only applies at creation — tighten pre-existing files too
    try { chmodSync(tokenPath, 0o600); } catch { /* non-POSIX */ }
  }

  function loadOrGenerate() {
    // ENV override takes priority — no rotation/expiry for ENV tokens
    if (process.env.SYNAPSE_AUTH_TOKEN) {
      token = process.env.SYNAPSE_AUTH_TOKEN;
      tokenExpiresAt = null; // ENV tokens don't expire
      return token;
    }
    // Try loading from disk
    try {
      const raw = JSON.parse(readFileSync(tokenPath, 'utf-8'));
      // Decrypt if encrypted envelope; migrate plaintext files transparently
      const data = raw._encrypted ? _decryptAuthData(raw, dirname(tokenPath)) : raw;
      if (!raw._encrypted && data.token) {
        // Migrate: re-save in encrypted form. Non-fatal — governance may have the file
        // locked (444) from a previous session; migration will complete on next restart.
        try {
          saveTokenData(data);
          log.info('auth.json migrated to encrypted-at-rest format', { path: tokenPath });
        } catch (err) {
          log.warn('auth.json encryption migration deferred', { reason: err.code || err.message });
        }
      }
      if (data.token) {
        // Check if expired
        if (data.expiresAt && new Date(data.expiresAt) <= new Date()) {
          log.info('Token expired, rotating', { expiredAt: data.expiresAt });
          return rotate(data.token);
        }
        token = data.token;
        tokenExpiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
        // Restore grace state if present
        if (data.previousToken && data.graceExpiresAt && new Date(data.graceExpiresAt) > new Date()) {
          previousToken = data.previousToken;
          graceExpiresAt = new Date(data.graceExpiresAt);
        }
        return token;
      }
    } catch { /* file missing or corrupt — generate */ }
    // Generate new token
    token = generateToken();
    const now = new Date();
    tokenExpiresAt = expiryDays > 0 ? new Date(now.getTime() + expiryDays * 86400000) : null;
    saveTokenData({
      token,
      created: now.toISOString(),
      expiresAt: tokenExpiresAt?.toISOString() || null,
    });
    log.info('Generated new auth token', { path: tokenPath, expiresAt: tokenExpiresAt?.toISOString() });
    return token;
  }

  // Rotate: generate new token, keep old one valid during grace period
  function rotate(oldToken) {
    const newToken = generateToken();
    const now = new Date();
    previousToken = oldToken || token;
    graceExpiresAt = new Date(now.getTime() + gracePeriodMs);
    token = newToken;
    tokenExpiresAt = expiryDays > 0 ? new Date(now.getTime() + expiryDays * 86400000) : null;
    saveTokenData({
      token: newToken,
      created: now.toISOString(),
      expiresAt: tokenExpiresAt?.toISOString() || null,
      previousToken,
      graceExpiresAt: graceExpiresAt.toISOString(),
    });
    log.info('Token rotated', { gracePeriodMs, expiresAt: tokenExpiresAt?.toISOString() });
    return newToken;
  }

  function validate(candidate) {
    if (!enabled || !token) return true;
    if (!candidate || typeof candidate !== 'string') return false;
    // Check current token
    if (safeEqual(token, candidate)) return true;
    // Check previous token during grace period
    if (previousToken && graceExpiresAt && new Date() < graceExpiresAt) {
      if (safeEqual(previousToken, candidate)) return true;
    }
    return false;
  }

  // Check credential — accepts token OR password
  function checkCredential(input) {
    if (!input || typeof input !== 'string') return false;
    // Check machine token
    if (validate(input)) return true;
    // Check password (if configured)
    if (password && safeEqual(password, input)) return true;
    return false;
  }

  // ─── Session Cookies (HMAC-signed, stateless) ───────────────────

  function _hmacSign(data, key) {
    return createHmac('sha256', key).update(data).digest('hex').slice(0, 32);
  }

  function createSession() {
    const ts = Date.now().toString(36);
    const sig = _hmacSign(ts, token);
    return `${ts}.${sig}`;
  }

  function validateSession(cookie) {
    if (!cookie || typeof cookie !== 'string') return { authenticated: false, userId: null };
    const dot = cookie.indexOf('.');
    if (dot < 0) return { authenticated: false, userId: null };
    const ts = cookie.slice(0, dot);
    const sig = cookie.slice(dot + 1);
    if (!ts || !sig) return { authenticated: false, userId: null };
    // Verify HMAC with current token
    if (safeEqual(_hmacSign(ts, token), sig)) {
      const created = parseInt(ts, 36);
      if (!isNaN(created) && Date.now() - created < SESSION_MAX_AGE_S * 1000) return { authenticated: true, userId: 'default' };
    }
    // Try previous token during grace period
    if (previousToken && graceExpiresAt && new Date() < graceExpiresAt) {
      if (safeEqual(_hmacSign(ts, previousToken), sig)) {
        const created = parseInt(ts, 36);
        if (!isNaN(created) && Date.now() - created < SESSION_MAX_AGE_S * 1000) return { authenticated: true, userId: 'default' };
      }
    }
    return { authenticated: false, userId: null };
  }

  function getSessionCookie(req) {
    return parseCookies(req)[COOKIE_NAME] || null;
  }

  function setSessionCookie(res) {
    const session = createSession();
    const parts = [
      `${COOKIE_NAME}=${session}`,
      `Path=/`,
      `HttpOnly`,
      `SameSite=Lax`,
      `Max-Age=${SESSION_MAX_AGE_S}`,
    ];
    // Append existing Set-Cookie headers (don't overwrite)
    const existing = res.getHeader('Set-Cookie');
    const cookies = existing ? [].concat(existing, parts.join('; ')) : [parts.join('; ')];
    res.setHeader('Set-Cookie', cookies);
  }

  function clearSessionCookie(res) {
    const parts = [
      `${COOKIE_NAME}=`,
      `Path=/`,
      `HttpOnly`,
      `SameSite=Lax`,
      `Max-Age=0`,
    ];
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // Extract token from Authorization header, query param, or session cookie
  function extractToken(req) {
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
    const url = new URL(req.url, 'http://localhost');
    const qp = url.searchParams.get('token');
    if (qp) return qp;
    return null;
  }

  // Full auth check: master token OR API key OR session cookie.
  // API keys (syn_*) carry a role — surfaced so the policy engine can scope
  // what an external harness is allowed to do.
  function isAuthenticated(req) {
    if (!enabled) return { authenticated: true, userId: 'default' };
    const candidate = extractToken(req);
    if (candidate && validate(candidate)) return { authenticated: true, userId: 'default' };
    if (candidate && candidate.startsWith('syn_')) {
      const keyResult = apiKeys.verify(candidate);
      if (keyResult) {
        return { authenticated: true, userId: `apikey:${keyResult.name}`, role: keyResult.role, apiKeyId: keyResult.keyId };
      }
    }
    // Check session cookie
    const sessionResult = validateSession(getSessionCookie(req));
    return sessionResult.authenticated ? { authenticated: true, userId: sessionResult.userId } : { authenticated: false, userId: null };
  }

  // REST middleware: returns true if request is authorized
  function checkRequest(req, res) {
    if (!enabled) return true;
    const url = new URL(req.url, 'http://localhost');
    // Health endpoint always public
    if (url.pathname === '/api/health') return true;
    // OpenAPI spec always public
    if (url.pathname === '/api/openapi.json') return true;
    // Login endpoint always public (handles its own auth)
    if (url.pathname === '/api/auth/login' && req.method === 'POST') return true;
    // Token rotation endpoint
    if (url.pathname === '/api/auth/rotate' && req.method === 'POST') {
      if (!isAuthenticated(req).authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
      }
      const newToken = rotate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        token: newToken,
        expiresAt: tokenExpiresAt?.toISOString() || null,
        graceExpiresAt: graceExpiresAt?.toISOString() || null,
      }));
      return false; // consumed — response already sent
    }
    // Token info endpoint
    if (url.pathname === '/api/auth/info' && req.method === 'GET') {
      if (!isAuthenticated(req).authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        expiresAt: tokenExpiresAt?.toISOString() || null,
        graceActive: !!(previousToken && graceExpiresAt && new Date() < graceExpiresAt),
        graceExpiresAt: graceExpiresAt?.toISOString() || null,
        isEnvToken: !!process.env.SYNAPSE_AUTH_TOKEN,
        hasPassword: !!password,
      }));
      return false; // consumed
    }
    if (isAuthenticated(req).authenticated) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  // WS upgrade check: token OR session cookie
  function checkUpgrade(req) {
    if (!enabled) return { authenticated: true, userId: 'default' };
    return isAuthenticated(req);
  }

  function getToken() { return token; }
  function isEnabled() { return enabled; }
  function getExpiresAt() { return tokenExpiresAt; }
  function hasPassword() { return !!password; }

  // Initialize — always generate/load token (used for credential vault encryption even if API auth disabled)
  loadOrGenerate();

  if (password) {
    log.info('Password login enabled (SYNAPSE_PASSWORD set)');
  }

  return {
    validate, extractToken, checkRequest, checkUpgrade,
    getToken, isEnabled, getExpiresAt, rotate, hasPassword,
    // Session methods
    checkCredential, isAuthenticated,
    createSession, validateSession, getSessionCookie,
    setSessionCookie, clearSessionCookie,
    // API keys for external harnesses (Hermes/OpenClaw/scripts)
    apiKeys,
  };
}
