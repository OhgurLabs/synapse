// Agenda tracking system — command-driven, file-backed, CAS-protected.
// Council-designed v1: manual commands only, no message scanning.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { assertSafeProjectId } from './safe-id.js';

const MAX_CAS_RETRIES = 3;

/**
 * Parse a numbered/bulleted list into agenda item strings.
 * Supports: "1. item", "1) item", "- item", "* item"
 * Returns raw strings — caller handles metadata.
 */
export function parseAgenda(text) {
  const lines = text.split('\n');
  const items = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:\d+[.)]\s*|[-*]\s+)(.+)$/);
    if (match) {
      const item = match[1].trim();
      if (item.length > 0) items.push(item);
    }
  }
  return items;
}

/**
 * Parse /agenda commands from user input.
 * Returns { command, args } or null.
 *
 * Supported:
 *   /agenda set <text with items>   — create agenda from numbered list
 *   /agenda set --force <text>      — override existing agenda
 *   /agenda add "item text"         — add a single item
 *   /agenda check <N>               — mark item N as completed (1-based)
 *   /agenda uncheck <N>             — mark item N back to pending
 *   /agenda defer <N>               — defer item N
 *   /agenda progress <N>            — mark item N as in_progress
 *   /agenda clear                   — clear the agenda
 *   /agenda replace <text>          — atomic replace (clear + set)
 *   /agenda                         — show current agenda (no subcommand)
 */
export function parseAgendaCommand(text) {
  const trimmed = text.trim();

  // Show agenda (bare command)
  if (trimmed === '/agenda') {
    return { command: 'show', args: null };
  }

  const match = trimmed.match(/^\/agenda\s+(\w+)(?:\s+(.+))?$/s);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || null;
  const valid = ['set', 'add', 'check', 'uncheck', 'defer', 'progress', 'clear', 'replace', 'show'];
  if (!valid.includes(command)) return null;

  return { command, args };
}

export class AgendaManager {
  constructor(stateManager) {
    this.stateManager = stateManager;
  }

  _agendaPath(projectId) {
    assertSafeProjectId(projectId);
    return join(this.stateManager.projectsDir, projectId, 'agenda.json');
  }

  _eventLogPath(projectId) {
    assertSafeProjectId(projectId);
    return join(this.stateManager.projectsDir, projectId, 'agenda-events.jsonl');
  }

  _load(projectId) {
    const path = this._agendaPath(projectId);
    if (!existsSync(path)) {
      return { version: 0, nextId: 1, items: [], createdAt: null, channel: null };
    }
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return { version: 0, nextId: 1, items: [], createdAt: null, channel: null };
    }
  }

  /**
   * Atomic write with CAS — compare version before writing.
   * Uses tmp+rename for crash safety.
   */
  _save(projectId, data, expectedVersion) {
    const path = this._agendaPath(projectId);
    const current = this._load(projectId);
    if (current.version !== expectedVersion) {
      throw new Error(`CAS conflict: expected version ${expectedVersion}, got ${current.version}`);
    }
    data.version = expectedVersion + 1;
    const tmp = path + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, path);
    return data;
  }

  /**
   * Save with CAS retry (up to MAX_CAS_RETRIES).
   * `mutator` receives current data, returns modified data.
   */
  _saveWithRetry(projectId, mutator) {
    for (let i = 0; i < MAX_CAS_RETRIES; i++) {
      const data = this._load(projectId);
      const modified = mutator(data);
      try {
        return this._save(projectId, modified, data.version);
      } catch (err) {
        if (i === MAX_CAS_RETRIES - 1) throw err;
        // retry with fresh read
      }
    }
  }

  _appendEvent(projectId, event) {
    const path = this._eventLogPath(projectId);
    const entry = {
      schema_version: 1,
      event_id: `evt_${Date.now()}_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      project: projectId,
      ...event,
    };
    appendFileSync(path, JSON.stringify(entry) + '\n');
  }

  /**
   * Set agenda from parsed items. Returns the agenda state.
   */
  set(projectId, channelId, items, speaker, force = false) {
    const current = this._load(projectId);
    if (current.items.length > 0 && !force) {
      return { error: 'Agenda already exists. Use `/agenda set --force` to override, or `/agenda replace` to atomically replace.' };
    }

    const data = this._saveWithRetry(projectId, (d) => {
      const nextId = d.nextId || 1;
      d.items = items.map((text, i) => ({
        id: nextId + i,
        text,
        status: 'pending',
        source: { speaker, channel: channelId, type: 'cli' },
        createdAt: new Date().toISOString(),
      }));
      d.nextId = nextId + items.length;
      d.createdAt = new Date().toISOString();
      d.channel = channelId;
      return d;
    });

    this._appendEvent(projectId, {
      op: 'set',
      items: data.items.map(i => ({ id: i.id, text: i.text })),
      source: { type: 'cli', speaker, channel: channelId },
    });

    return { agenda: data };
  }

  /**
   * Add a single item to the existing agenda.
   */
  add(projectId, channelId, text, speaker) {
    const data = this._saveWithRetry(projectId, (d) => {
      const id = d.nextId || (d.items.length + 1);
      d.items.push({
        id,
        text,
        status: 'pending',
        source: { speaker, channel: channelId, type: 'cli' },
        createdAt: new Date().toISOString(),
      });
      d.nextId = id + 1;
      return d;
    });

    this._appendEvent(projectId, {
      op: 'add',
      item_id: data.items[data.items.length - 1].id,
      text,
      source: { type: 'cli', speaker, channel: channelId },
    });

    return { agenda: data };
  }

  /**
   * Update item status by 1-based position number.
   */
  updateStatus(projectId, itemNum, status, speaker) {
    const num = parseInt(itemNum, 10);
    if (!Number.isFinite(num) || num < 1) {
      return { error: `Invalid item number: "${itemNum}". Use 1-based numbering.` };
    }

    const current = this._load(projectId);
    if (current.items.length === 0) {
      return { error: 'No agenda set. Use `/agenda set` first.' };
    }

    // 1-based index
    const idx = num - 1;
    if (idx >= current.items.length) {
      return { error: `Item ${num} does not exist. Agenda has ${current.items.length} items.` };
    }

    const data = this._saveWithRetry(projectId, (d) => {
      d.items[idx].status = status;
      d.items[idx].updatedAt = new Date().toISOString();
      d.items[idx].updatedBy = speaker;
      return d;
    });

    this._appendEvent(projectId, {
      op: 'status_change',
      item_id: data.items[idx].id,
      status,
      source: { type: 'cli', speaker },
    });

    return { agenda: data, item: data.items[idx] };
  }

  /**
   * Clear the agenda (remove all items but preserve nextId).
   */
  clear(projectId, speaker) {
    const data = this._saveWithRetry(projectId, (d) => {
      d.items = [];
      d.channel = null;
      return d;
    });

    this._appendEvent(projectId, {
      op: 'clear',
      source: { type: 'cli', speaker },
    });

    return { agenda: data };
  }

  /**
   * Atomic replace — clear + set in one write.
   */
  replace(projectId, channelId, items, speaker) {
    const data = this._saveWithRetry(projectId, (d) => {
      const nextId = d.nextId || 1;
      d.items = items.map((text, i) => ({
        id: nextId + i,
        text,
        status: 'pending',
        source: { speaker, channel: channelId, type: 'cli' },
        createdAt: new Date().toISOString(),
      }));
      d.nextId = nextId + items.length;
      d.createdAt = new Date().toISOString();
      d.channel = channelId;
      return d;
    });

    this._appendEvent(projectId, {
      op: 'replace',
      items: data.items.map(i => ({ id: i.id, text: i.text })),
      source: { type: 'cli', speaker, channel: channelId },
    });

    return { agenda: data };
  }

  /**
   * Get current agenda state.
   */
  get(projectId) {
    return this._load(projectId);
  }

  /**
   * Format agenda for display (plain text).
   */
  formatAgenda(projectId) {
    const data = this._load(projectId);
    if (data.items.length === 0) return 'No agenda set.';

    const statusIcons = {
      pending: '[ ]',
      in_progress: '[~]',
      completed: '[x]',
      deferred: '[-]',
    };

    const lines = ['**Agenda**'];
    data.items.forEach((item, i) => {
      const icon = statusIcons[item.status] || '[ ]';
      const num = i + 1;
      lines.push(`${num}. ${icon} ${item.text}`);
    });

    const total = data.items.length;
    const done = data.items.filter(i => i.status === 'completed').length;
    const inProg = data.items.filter(i => i.status === 'in_progress').length;
    const deferred = data.items.filter(i => i.status === 'deferred').length;
    lines.push(`\n*${done}/${total} complete${inProg ? `, ${inProg} in progress` : ''}${deferred ? `, ${deferred} deferred` : ''}*`);

    return lines.join('\n');
  }

  /**
   * Format agenda for agent context injection.
   * Returns a compact string that agents see in their system prompt.
   */
  formatForContext(projectId) {
    const data = this._load(projectId);
    if (data.items.length === 0) return null;

    const lines = ['=== AGENDA ==='];
    data.items.forEach((item, i) => {
      const status = item.status.toUpperCase();
      lines.push(`${i + 1}. [${status}] ${item.text}`);
    });
    lines.push('=== END AGENDA ===');
    return lines.join('\n');
  }

  /**
   * Get agenda summary for session-end context.md generation.
   */
  getSessionSummary(projectId) {
    const data = this._load(projectId);
    if (data.items.length === 0) return null;

    const lines = ['## Agenda Status'];
    data.items.forEach((item, i) => {
      const status = item.status === 'completed' ? 'DONE' :
                     item.status === 'in_progress' ? 'IN PROGRESS' :
                     item.status === 'deferred' ? 'DEFERRED' : 'PENDING';
      lines.push(`${i + 1}. [${status}] ${item.text}`);
    });

    const total = data.items.length;
    const done = data.items.filter(i => i.status === 'completed').length;
    lines.push(`\nCompletion: ${done}/${total}`);

    return lines.join('\n');
  }
}
