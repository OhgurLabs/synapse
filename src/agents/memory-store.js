/**
 * Agent-Scoped Persistent Memory — each agent accumulates experience over time.
 * Append-only JSONL storage at .synapse/agents/{agentId}/memory.jsonl
 * with dedup, query, and context injection for agent prompts.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('agent-memory');

const VALID_TYPES = ['experience', 'expertise'];

function memoryContentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function generateId() {
  const ts = Date.now();
  const rand = randomBytes(3).toString('hex');
  return `amem_${ts}_${rand}`;
}

export class AgentMemoryStore {
  /**
   * @param {string} baseDir - The .synapse base directory (stateManager.baseDir)
   */
  constructor(baseDir) {
    this._baseDir = baseDir;
    this._hashSets = new Map(); // agentId → Set<contentHash>
  }

  /**
   * Path to memory JSONL for an agent. Creates directory on first access.
   * @param {string} agentId
   * @returns {string}
   */
  _path(agentId) {
    const dir = join(this._baseDir, 'agents', agentId, 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'memory.jsonl');
  }

  /**
   * Load content hashes for dedup (lazy, cached per agent).
   * @param {string} agentId
   * @returns {Set<string>}
   */
  _loadHashes(agentId) {
    if (this._hashSets.has(agentId)) return this._hashSets.get(agentId);
    const hashes = new Set();
    const path = this._path(agentId);
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.contentHash) hashes.add(entry.contentHash);
        } catch { /* skip corrupt lines */ }
      }
    }
    this._hashSets.set(agentId, hashes);
    return hashes;
  }

  /**
   * Add a memory record for an agent. Deduplicates by contentHash.
   * @param {string} agentId
   * @param {object} entry - { type, category, outcome, tags, source, description }
   * @returns {object|null} The record if added, null if duplicate.
   */
  add(agentId, entry) {
    const hashInput = `${agentId}|${entry.type || ''}|${entry.category || ''}|${entry.outcome || ''}|${(entry.tags || []).sort().join(',')}`;
    const hash = entry.contentHash || memoryContentHash(hashInput);
    const hashes = this._loadHashes(agentId);
    if (hashes.has(hash)) {
      log.debug('Duplicate memory skipped', { agentId, hash });
      return null;
    }

    const record = {
      id: entry.id || generateId(),
      timestamp: entry.timestamp || new Date().toISOString(),
      type: VALID_TYPES.includes(entry.type) ? entry.type : 'experience',
      category: entry.category || '',
      outcome: entry.outcome || '',
      description: entry.description || '',
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      source: entry.source || {},
      contentHash: hash,
    };

    const path = this._path(agentId);
    appendFileSync(path, JSON.stringify(record) + '\n');
    hashes.add(hash);
    log.info('Agent memory added', { agentId, id: record.id, type: record.type, category: record.category });

    return record;
  }

  /**
   * Load all memory entries for an agent.
   * @param {string} agentId
   * @returns {object[]}
   */
  _loadAll(agentId) {
    const path = this._path(agentId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch { /* skip corrupt lines */ }
    }
    return entries;
  }

  /**
   * Query agent memories with filters.
   * @param {string} agentId
   * @param {object} options - { tags, type, category, limit }
   * @returns {object[]}
   */
  query(agentId, options = {}) {
    let entries = this._loadAll(agentId);

    if (options.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type];
      entries = entries.filter(e => types.includes(e.type));
    }
    if (options.category) {
      const cats = Array.isArray(options.category) ? options.category : [options.category];
      entries = entries.filter(e => cats.includes(e.category));
    }
    if (options.tags && options.tags.length > 0) {
      entries = entries.filter(e =>
        e.tags && options.tags.some(t => e.tags.includes(t))
      );
    }
    if (options.limit && options.limit > 0) {
      entries = entries.slice(-options.limit);
    }
    return entries;
  }

  /**
   * Format memory records into an injectable text block for agent prompts.
   * Budget-capped to stay within token limits.
   * @param {object[]} records
   * @param {number} maxChars - max output length (default 500)
   * @returns {string}
   */
  formatForContext(records, maxChars = 500) {
    if (!records || records.length === 0) return '';

    const header = '=== AGENT MEMORY (past experience) ===';
    const footer = '=== END AGENT MEMORY ===';
    const lines = [header];
    let charCount = header.length + footer.length + 2; // reserve space for footer

    for (const r of records) {
      const outcomeStr = r.outcome ? ` [${r.outcome}]` : '';
      const line1 = `- ${r.type}: ${r.category}${outcomeStr}`;
      const line2 = r.description ? `  ${r.description}` : '';
      const line3 = r.tags && r.tags.length > 0 ? `  tags: ${r.tags.join(', ')}` : '';
      const block = [line1, line2, line3].filter(Boolean).join('\n');

      if (charCount + block.length + 1 > maxChars) break;
      lines.push(block);
      charCount += block.length + 1;
    }

    lines.push(footer);
    return lines.join('\n');
  }

  /**
   * Check if an agent has any memory records.
   * @param {string} agentId
   * @returns {boolean}
   */
  hasMemory(agentId) {
    const path = this._path(agentId);
    return existsSync(path);
  }

  /**
   * Count total memory records for an agent.
   * @param {string} agentId
   * @returns {number}
   */
  count(agentId) {
    return this._loadAll(agentId).length;
  }
}
