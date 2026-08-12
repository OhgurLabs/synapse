// Credential vault — encrypted secret storage per project.
// AES-256-GCM encryption at rest with a master key derived from the auth token.
// Zero npm dependencies — Node.js crypto built-ins only.
//
// Storage: .synapse/projects/:projectId/credentials.json (encrypted values)
// Reference pattern: {{credential:name}} in workflow templates and agent env
//
// Credentials are never exposed in API list responses or logs.
// Only the vault's resolve() function can decrypt values for injection.

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { createLogger } from './logger.js';
import { validateId } from './state.js';

const log = createLogger('credentials');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;      // 256 bits
const IV_LENGTH = 16;       // 128 bits
const TAG_LENGTH = 16;      // 128 bits auth tag
const SALT_LENGTH = 16;     // for key derivation
const MAX_CREDENTIALS = 100;
const MAX_NAME_LENGTH = 64;
const MAX_VALUE_LENGTH = 8192;

function deriveKey(masterSecret, salt) {
  return scryptSync(masterSecret, salt, KEY_LENGTH);
}

function encrypt(plaintext, masterSecret) {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(masterSecret, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: salt:iv:tag:ciphertext (all hex)
  return [salt, iv, tag, encrypted].map(b => b.toString('hex')).join(':');
}

function decrypt(encoded, masterSecret) {
  const parts = encoded.split(':');
  if (parts.length !== 4) throw new Error('Invalid encrypted format');
  const [salt, iv, tag, ciphertext] = parts.map(p => Buffer.from(p, 'hex'));
  const key = deriveKey(masterSecret, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf-8');
}

export class CredentialVault {
  constructor(baseDir, masterSecret) {
    this.baseDir = baseDir;
    if (!masterSecret) throw new Error('CredentialVault requires a masterSecret');
    this._masterSecret = masterSecret;
  }

  _path(projectId) {
    validateId(projectId, 'project ID');
    return join(this.baseDir, '.synapse', 'projects', projectId, 'credentials.json');
  }

  _load(projectId) {
    const p = this._path(projectId);
    if (!existsSync(p)) return { credentials: [], version: 0 };
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch { return { credentials: [], version: 0 }; }
  }

  _save(projectId, data) {
    const p = this._path(projectId);
    mkdirSync(dirname(p), { recursive: true });
    data.version = (data.version || 0) + 1;
    writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    // mode option only applies at creation — tighten pre-existing files too
    try { chmodSync(p, 0o600); } catch { /* non-POSIX */ }
  }

  // List credentials — NEVER returns decrypted values
  list(projectId) {
    const data = this._load(projectId);
    return data.credentials.map(({ name, description, createdAt, updatedAt }) => ({
      name, description, createdAt, updatedAt,
    }));
  }

  // Check if a credential exists
  has(projectId, name) {
    const data = this._load(projectId);
    return data.credentials.some(c => c.name === name);
  }

  // Create or update a credential
  set(projectId, name, value, description) {
    if (!name || typeof name !== 'string') throw new Error('Credential name required');
    if (name.length > MAX_NAME_LENGTH) throw new Error(`Name max ${MAX_NAME_LENGTH} chars`);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Name must be alphanumeric (start with letter, allow _ and -)');
    if (!value || typeof value !== 'string') throw new Error('Credential value required');
    if (value.length > MAX_VALUE_LENGTH) throw new Error(`Value max ${MAX_VALUE_LENGTH} chars`);

    const data = this._load(projectId);
    const now = new Date().toISOString();
    const encrypted = encrypt(value, this._masterSecret);
    const existing = data.credentials.find(c => c.name === name);

    if (existing) {
      existing.encrypted = encrypted;
      existing.description = description ?? existing.description;
      existing.updatedAt = now;
      log.info('Credential updated', { projectId, name });
    } else {
      if (data.credentials.length >= MAX_CREDENTIALS) {
        throw new Error(`Max ${MAX_CREDENTIALS} credentials per project`);
      }
      data.credentials.push({
        name,
        encrypted,
        description: description || null,
        createdAt: now,
        updatedAt: now,
      });
      log.info('Credential created', { projectId, name });
    }

    this._save(projectId, data);
    return { name, description: description || existing?.description || null };
  }

  // Get decrypted value — ONLY for internal use (agent injection, workflow interpolation)
  resolve(projectId, name) {
    const data = this._load(projectId);
    const cred = data.credentials.find(c => c.name === name);
    if (!cred) return null;
    try {
      return decrypt(cred.encrypted, this._masterSecret);
    } catch (err) {
      log.error('Credential decrypt failed', { projectId, name, error: err.message });
      return null;
    }
  }

  // Delete a credential
  remove(projectId, name) {
    const data = this._load(projectId);
    const idx = data.credentials.findIndex(c => c.name === name);
    if (idx === -1) return false;
    data.credentials.splice(idx, 1);
    this._save(projectId, data);
    log.info('Credential removed', { projectId, name });
    return true;
  }

  // Resolve all {{credential:name}} references in a string
  interpolate(projectId, text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\{\{credential:([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g, (match, name) => {
      const value = this.resolve(projectId, name);
      if (value === null) {
        log.warn('Credential not found during interpolation', { projectId, name });
        return match; // leave placeholder if not found
      }
      return value;
    });
  }
}
