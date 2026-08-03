/**
 * API keys for external harnesses (Hermes, OpenClaw, scripts, CI).
 *
 * Synapse is "worked within but operated from outside": everything the UI
 * can configure goes through the REST API, so a scoped bearer key gives an
 * external harness the full config surface without sharing the master token
 * or a browser session.
 *
 * Key format: syn_<48 hex chars>. Only the sha256 hash is stored at rest
 * (.synapse/api-keys.json, mode 0600) — the full key is shown exactly once
 * at creation. Roles map onto the existing policy matrix
 * (admin > operator > reviewer > viewer); the policy engine receives the
 * key's role as a roleHint so a viewer key cannot drive operator actions.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('api-keys');

const FILE = 'api-keys.json';
const VALID_ROLES = new Set(['admin', 'operator', 'reviewer', 'viewer']);

export function createApiKeyStore(synapseDir) {
  const path = join(synapseDir, FILE);

  function load() {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function save(keys) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    try { chmodSync(path, 0o600); } catch { /* best effort on non-POSIX */ }
  }

  function hashKey(key) {
    return createHash('sha256').update(key).digest('hex');
  }

  /** Create a key. Returns { key, record } — `key` is shown once, never stored. */
  function create(name, role = 'operator') {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('name is required');
    }
    if (!VALID_ROLES.has(role)) {
      throw new Error(`role must be one of: ${[...VALID_ROLES].join(', ')}`);
    }
    const keys = load();
    const cleanName = name.trim().slice(0, 64);
    if (keys.some(k => k.name === cleanName && !k.revokedAt)) {
      throw new Error(`an active key named "${cleanName}" already exists`);
    }
    const key = `syn_${randomBytes(24).toString('hex')}`;
    const record = {
      id: `key_${Date.now()}_${randomBytes(3).toString('hex')}`,
      name: cleanName,
      role,
      prefix: key.slice(0, 12),
      hash: hashKey(key),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    keys.push(record);
    save(keys);
    log.info('API key created', { id: record.id, name: cleanName, role, prefix: record.prefix });
    return { key, record: publicView(record) };
  }

  /** List keys (public fields only — never hashes). */
  function list() {
    return load().map(publicView);
  }

  function publicView(k) {
    return {
      id: k.id, name: k.name, role: k.role, prefix: k.prefix,
      createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt,
    };
  }

  function revoke(id) {
    const keys = load();
    const k = keys.find(x => x.id === id);
    if (!k) return false;
    if (!k.revokedAt) {
      k.revokedAt = new Date().toISOString();
      save(keys);
      log.info('API key revoked', { id, name: k.name });
    }
    return true;
  }

  // Throttle lastUsedAt writes — one disk write per key per minute, not per
  // request.
  const lastUsedFlush = new Map();

  /** Verify a bearer. Returns { name, role, keyId } or null. */
  function verify(bearer) {
    if (typeof bearer !== 'string' || !bearer.startsWith('syn_')) return null;
    const candidate = Buffer.from(hashKey(bearer));
    const keys = load();
    for (const k of keys) {
      if (k.revokedAt) continue;
      const stored = Buffer.from(k.hash);
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        const now = Date.now();
        if ((lastUsedFlush.get(k.id) || 0) < now - 60_000) {
          lastUsedFlush.set(k.id, now);
          try {
            k.lastUsedAt = new Date().toISOString();
            save(keys);
          } catch { /* stat tracking is best-effort */ }
        }
        return { name: k.name, role: k.role, keyId: k.id };
      }
    }
    return null;
  }

  return { create, list, revoke, verify, VALID_ROLES: [...VALID_ROLES], _path: path, _exists: () => existsSync(path) };
}
