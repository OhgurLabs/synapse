// Webhook config store — per-project webhook registrations.
// Stored at .synapse/projects/:projectId/webhooks.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

const MAX_WEBHOOKS_PER_PROJECT = 20;
const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 200;
const SECRET_BYTES = 32;

// Valid event types — must match WEBHOOK_EVENTS in webhooks.js.
// All names use colon notation (namespace:action) for consistency.
const VALID_EVENTS = new Set([
  'message', 'session:start', 'session:end',
  'agent:dispatch', 'vote:completed',
  'project:created', 'channel:created', 'agents:updated',
  'task:created', 'task:status_changed', 'task:completed',
  'campaign:created', 'campaign:status_changed', 'campaign:milestone_completed',
  'campaign:paused', 'campaign:resumed',
  'schedule:fired', 'thread:created',
  'alert:firing', 'alert:resolved',
  'alert:sla_breach', 'alert:sla_resolved',
  'timeline:insert',
  '*',
]);

function generateId() {
  return 'wh_' + randomBytes(4).toString('hex');
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') return 'url required';
  if (url.length > MAX_URL_LENGTH) return `url exceeds ${MAX_URL_LENGTH} chars`;
  try {
    const parsed = new URL(url);
    // Accept https:// (any host) or http:// (any host).
    // The SSRF policy at delivery time (src/ssrf-config-store.js) is the
    // authoritative security gate — duplicating an http→localhost-only check
    // here just blocked legitimate LAN targets like a private n8n instance.
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return null;
    return `url must use http:// or https:// (got ${parsed.protocol})`;
  } catch {
    return 'invalid url';
  }
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 'events array required (1-20 entries)';
  if (events.length > 20) return 'events array max 20 entries';
  for (const e of events) {
    if (typeof e !== 'string' || !VALID_EVENTS.has(e)) {
      return `invalid event type: "${e}". Valid: ${[...VALID_EVENTS].join(', ')}`;
    }
  }
  return null;
}

export class WebhookStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  _path(projectId) {
    return join(this.baseDir, '.synapse', 'projects', projectId, 'webhooks.json');
  }

  _load(projectId) {
    const p = this._path(projectId);
    if (!existsSync(p)) return [];
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  _save(projectId, webhooks) {
    const p = this._path(projectId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(webhooks, null, 2) + '\n');
  }

  list(projectId) {
    // Redact secrets in list responses
    return this._load(projectId).map(({ secret, ...rest }) => rest);
  }

  get(projectId, id) {
    return this._load(projectId).find(h => h.id === id) || null;
  }

  create(projectId, { url, events, description }) {
    const urlErr = validateUrl(url);
    if (urlErr) throw new Error(urlErr);
    const evtErr = validateEvents(events);
    if (evtErr) throw new Error(evtErr);
    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`description max ${MAX_DESCRIPTION_LENGTH} chars`);
    }

    const webhooks = this._load(projectId);
    if (webhooks.length >= MAX_WEBHOOKS_PER_PROJECT) {
      throw new Error(`max ${MAX_WEBHOOKS_PER_PROJECT} webhooks per project`);
    }

    const hook = {
      id: generateId(),
      url,
      secret: randomBytes(SECRET_BYTES).toString('hex'),
      events,
      active: true,
      createdAt: new Date().toISOString(),
      description: description?.trim() || null,
    };
    webhooks.push(hook);
    this._save(projectId, webhooks);
    return hook; // secret included on creation only
  }

  remove(projectId, id) {
    const webhooks = this._load(projectId);
    const idx = webhooks.findIndex(h => h.id === id);
    if (idx === -1) return false;
    webhooks.splice(idx, 1);
    this._save(projectId, webhooks);
    return true;
  }

  deactivate(projectId, id) {
    const webhooks = this._load(projectId);
    const hook = webhooks.find(h => h.id === id);
    if (!hook) return;
    hook.active = false;
    this._save(projectId, webhooks);
  }
}
