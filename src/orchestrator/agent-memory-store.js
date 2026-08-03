/**
 * Agent-Scoped Persistent Memory System
 * Stores agent expertise, experience, and preferences across campaigns.
 * Append-only JSONL storage per agent with content-hash deduplication.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('agent-memory');

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function generateId() {
  const ts = Date.now();
  const rand = randomBytes(3).toString('hex');
  return `mem_${ts}_${rand}`;
}

const VALID_CATEGORIES = ['expertise', 'experience', 'preference'];

export class AgentMemoryStore {
  constructor(stateManager) {
    this._stateManager = stateManager;
    this._hashSets = new Map(); // agentId → Set<contentHash>
    this._onAdd = null; // callback: (agentId, memory) => void
  }

  /** Register a callback fired after every successful add(). */
  onMemoryAdded(callback) {
    this._onAdd = callback;
  }

  /** Path to memory JSONL for an agent. */
  _getMemoryPath(agentId) {
    const baseDir = this._stateManager?.baseDir || '.synapse';
    const dir = join(baseDir, 'agents', agentId, 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'memory.jsonl');
  }

  /** Compute content hash for deduplication. */
  _computeContentHash(entry) {
    return contentHash(`${entry.category}|${entry.content}`);
  }

  /** Load content hashes for dedup (lazy, cached per agent). */
  _loadHashes(agentId) {
    if (this._hashSets.has(agentId)) return this._hashSets.get(agentId);
    const hashes = new Set();
    const path = this._getMemoryPath(agentId);
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
   * Load all memory entries for an agent.
   * @returns {object[]}
   */
  _loadAll(agentId) {
    const path = this._getMemoryPath(agentId);
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
   * Add a memory entry. Deduplicates by contentHash.
   * @param {string} agentId
   * @param {object} entry - { category, content, source?, tags?, confidence? }
   * @returns {object|null} The entry if added, null if duplicate.
   */
  add(agentId, entry) {
    // Validate required fields
    if (!entry.category || !VALID_CATEGORIES.includes(entry.category)) {
      log.warn('Invalid category', { agentId, category: entry.category });
      throw new Error(`Invalid category: ${entry.category}. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
    }
    if (!entry.content || typeof entry.content !== 'string' || entry.content.trim() === '') {
      log.warn('Missing or invalid content', { agentId });
      throw new Error('Content is required and must be a non-empty string');
    }

    // Compute content hash
    const hash = this._computeContentHash(entry);

    // Check dedup cache
    const hashes = this._loadHashes(agentId);
    if (hashes.has(hash)) {
      log.debug('Duplicate memory skipped', { agentId, hash });
      return null;
    }

    // Generate id
    const id = entry.id || generateId();

    // Build record with validated schema
    const record = {
      id,
      agentId,
      category: entry.category,
      content: entry.content,
      source: entry.source || {},
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      confidence: typeof entry.confidence === 'number' ? Math.max(0, Math.min(1, entry.confidence)) : 0.5,
      accessCount: typeof entry.accessCount === 'number' ? entry.accessCount : 1,
      contentHash: hash,
      createdAt: entry.createdAt || new Date().toISOString(),
      lastAccessedAt: entry.lastAccessedAt || new Date().toISOString(),
    };

    // Ensure directory exists (redundant with _getMemoryPath but explicit per requirements)
    const baseDir = this._stateManager?.baseDir || '.synapse';
    const dir = join(baseDir, 'agents', agentId, 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Append to JSONL file
    const path = this._getMemoryPath(agentId);
    appendFileSync(path, JSON.stringify(record) + '\n');

    // Update hash cache
    hashes.add(hash);

    log.info('Memory added', { agentId, id: record.id, category: record.category, confidence: record.confidence });

    // Fire onMemoryAdded callbacks (non-blocking)
    if (this._onAdd) {
      try {
        this._onAdd(agentId, record);
      } catch (err) {
        log.warn('onMemoryAdded callback failed', { agentId, error: err.message });
      }
    }

    return record;
  }

  /**
   * Query memory entries for an agent, filtered by tags/type/category.
   * @param {string} agentId
   * @param {object} opts - { tags?, type?, category?, limit? }
   * @returns {object[]} Matching records, newest first.
   */
  query(agentId, { tags = [], type = null, category = null, limit = 10 } = {}) {
    const all = this._loadAll(agentId);
    const normalizedTags = tags.map(t => t.toLowerCase());

    const filtered = all.filter(entry => {
      if (type && entry.category !== type) return false;
      if (category && entry.category !== category) return false;
      if (normalizedTags.length > 0) {
        const entryTags = (entry.tags || []).map(t => t.toLowerCase());
        const hasMatch = normalizedTags.some(t => entryTags.includes(t));
        if (!hasMatch) return false;
      }
      return true;
    });

    // Newest first
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return filtered.slice(0, limit);
  }

  /**
   * Format memory records as a concise context summary, budget-capped.
   * @param {object[]} records
   * @param {number} maxChars
   * @returns {string|null}
   */
  formatForContext(records, maxChars = 500) {
    if (!records || records.length === 0) return null;

    const lines = ['=== AGENT MEMORY (past experience) ==='];
    let used = lines[0].length + 1;

    for (const rec of records) {
      const tags = rec.tags && rec.tags.length > 0 ? ` [${rec.tags.join(', ')}]` : '';
      const line = `- [${rec.category}]${tags}: ${rec.content}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }

    lines.push('=== END AGENT MEMORY ===');
    if (lines.length <= 2) return null; // only header/footer
    return lines.join('\n');
  }

  /**
   * Query agent expertise for specific topic keywords.
   * Searches expertise and experience entries for keyword matches.
   * @param {string} agentId
   * @param {string[]} keywords - Topic keywords to match against tags and content
   * @returns {object} { score: number, entries: object[], matchedKeywords: string[] }
   */
  queryExpertiseForTopic(agentId, keywords = []) {
    if (!keywords || keywords.length === 0) {
      return { score: 0, entries: [], matchedKeywords: [] };
    }

    const all = this._loadAll(agentId);
    const expertiseEntries = all.filter(
      entry => entry.category === 'expertise' || entry.category === 'experience'
    );

    if (expertiseEntries.length === 0) {
      return { score: 0, entries: [], matchedKeywords: [] };
    }

    const normalizedKeywords = keywords.map(k => k.toLowerCase());
    const matchedKeywords = new Set();
    const scoredEntries = [];

    for (const entry of expertiseEntries) {
      let entryScore = 0;
      const entryContent = (entry.content || '').toLowerCase();
      const entryTags = (entry.tags || []).map(t => t.toLowerCase());

      for (const keyword of normalizedKeywords) {
        if (entryContent.includes(keyword) || entryTags.includes(keyword)) {
          matchedKeywords.add(keyword);
          entryScore += 1;
        }
      }

      if (entryScore > 0) {
        scoredEntries.push({
          ...entry,
          matchScore: entryScore * (entry.confidence || 0.5),
        });
      }
    }

    scoredEntries.sort((a, b) => b.matchScore - a.matchScore);

    const totalScore = matchedKeywords.size * 10;
    const maxPossibleScore = normalizedKeywords.length * 10;
    const normalizedScore = maxPossibleScore > 0 ? totalScore / maxPossibleScore : 0;

    return {
      score: normalizedScore,
      entries: scoredEntries.slice(0, 5),
      matchedKeywords: Array.from(matchedKeywords),
    };
  }
}
