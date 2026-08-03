/**
 * Collective Learnings System — agents learn from each other's mistakes.
 * Append-only JSONL storage per project with dedup, query, and context injection.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { createLogger } from './logger.js';
import { extractDomainTags } from './orchestrator/domain-tags.js';

const log = createLogger('learnings');

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function generateId() {
  const ts = Date.now();
  const rand = randomBytes(3).toString('hex');
  return `lrn_${ts}_${rand}`;
}

const VALID_CATEGORIES = ['review_finding', 'escalation_failure', 'governance_violation', 'pattern_detected'];
const VALID_SEVERITIES = ['critical', 'important', 'minor'];

export class LearningsManager {
  constructor(stateManager) {
    this._stateManager = stateManager;
    this._hashSets = new Map(); // projectId → Set<contentHash>
    this._onAdd = null; // callback: (projectId, learning) => void
  }

  /** Register a callback fired after every successful add(). */
  onLearningAdded(callback) {
    this._onAdd = callback;
  }

  /** Path to learnings JSONL for a project. */
  _path(projectId) {
    const dir = join(this._stateManager.projectsDir, projectId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'learnings.jsonl');
  }

  /** Load content hashes for dedup (lazy, cached per project). */
  _loadHashes(projectId) {
    if (this._hashSets.has(projectId)) return this._hashSets.get(projectId);
    const hashes = new Set();
    const path = this._path(projectId);
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.contentHash) hashes.add(entry.contentHash);
        } catch { /* skip corrupt lines */ }
      }
    }
    this._hashSets.set(projectId, hashes);
    return hashes;
  }

  /**
   * Add a learning entry. Deduplicates by contentHash.
   * @returns {object|null} The entry if added, null if duplicate.
   */
  add(projectId, entry) {
    const hash = entry.contentHash || contentHash(`${entry.pattern}|${entry.correction}`);
    const hashes = this._loadHashes(projectId);
    if (hashes.has(hash)) {
      log.debug('Duplicate learning skipped', { projectId, hash });
      return null;
    }

    const record = {
      id: entry.id || generateId(),
      timestamp: entry.timestamp || new Date().toISOString(),
      category: VALID_CATEGORIES.includes(entry.category) ? entry.category : 'pattern_detected',
      pattern: entry.pattern || '',
      why: entry.why || '',
      correction: entry.correction || '',
      severity: VALID_SEVERITIES.includes(entry.severity) ? entry.severity : 'minor',
      source: entry.source || {},
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      contentHash: hash,
    };

    const path = this._path(projectId);
    appendFileSync(path, JSON.stringify(record) + '\n');
    hashes.add(hash);
    log.info('Learning added', { projectId, id: record.id, category: record.category, severity: record.severity });

    // Fire vault callback (non-blocking)
    if (this._onAdd) {
      try { this._onAdd(projectId, record); } catch { /* non-blocking */ }
    }

    return record;
  }

  /**
   * Load all entries for a project.
   * @returns {object[]}
   */
  _loadAll(projectId) {
    const path = this._path(projectId);
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
   * Query learnings with filters.
   * @param {string} projectId
   * @param {object} options - { category, severity, tags, limit }
   * @returns {object[]}
   */
  query(projectId, options = {}) {
    let entries = this._loadAll(projectId);

    if (options.category) {
      const cats = Array.isArray(options.category) ? options.category : [options.category];
      entries = entries.filter(e => cats.includes(e.category));
    }
    if (options.severity) {
      const sevs = Array.isArray(options.severity) ? options.severity : [options.severity];
      entries = entries.filter(e => sevs.includes(e.severity));
    }
    if (options.tags && options.tags.length > 0) {
      entries = entries.filter(e =>
        e.tags && options.tags.some(t => e.tags.includes(t))
      );
    }
    if (options.campaignId) {
      entries = entries.filter(e => e.source?.campaignId === options.campaignId);
    }
    if (options.milestoneId) {
      entries = entries.filter(e => e.source?.milestoneId === options.milestoneId);
    }
    if (options.limit && options.limit > 0) {
      entries = entries.slice(-options.limit);
    }
    return entries;
  }

  /** Get the last N entries. */
  getRecent(projectId, n = 10) {
    const all = this._loadAll(projectId);
    return all.slice(-n);
  }

  /** Get all entries of a given severity. */
  getBySeverity(projectId, severity) {
    return this.query(projectId, { severity });
  }

  /** Get entries matching any of the given tags. */
  getByTags(projectId, tags) {
    return this.query(projectId, { tags });
  }

  /** Total learning count for a project. */
  count(projectId) {
    return this._loadAll(projectId).length;
  }

  /**
   * Format entries into an injectable text block for agent prompts.
   * @param {object[]} entries
   * @param {number} maxChars - max output length
   * @returns {string}
   */
  formatForContext(entries, maxChars = 500) {
    if (!entries || entries.length === 0) return '';

    const lines = ['=== LEARNINGS (do not repeat these mistakes) ==='];
    let charCount = lines[0].length;

    for (const e of entries) {
      const severity = e.severity || 'minor';
      const line1 = `[${severity}] ${e.pattern}`;
      const line2 = e.why ? `  WHY: ${e.why}` : '';
      const line3 = e.correction ? `  DO: ${e.correction}` : '';
      const block = [line1, line2, line3].filter(Boolean).join('\n');

      if (charCount + block.length + 2 > maxChars) break;
      lines.push('');
      lines.push(block);
      charCount += block.length + 2;
    }

    lines.push('=== END LEARNINGS ===');
    return lines.join('\n');
  }

  /**
   * Build context for subtask dispatch: critical learnings + tag-matched + recent from same campaign.
   * @returns {string} formatted block or empty string
   */
  buildSubtaskContext(projectId, { subtaskText, campaignId, milestoneId } = {}) {
    const entries = new Map(); // id → entry (dedup)

    // 1. All critical learnings (capped at 5)
    const critical = this.getBySeverity(projectId, 'critical').slice(-5);
    for (const e of critical) entries.set(e.id, e);

    // 2. Tag-matched learnings: file refs + domain keywords from subtask text
    if (subtaskText) {
      const fileRefs = subtaskText.match(/[\w/.-]+\.\w+/g) || [];
      const fileTags = fileRefs.map(f => `file:${f}`);
      const domTags  = extractDomainTags(subtaskText);
      const allTags  = [...fileTags, ...domTags];
      if (allTags.length > 0) {
        const tagged = this.getByTags(projectId, allTags).slice(-5);
        for (const e of tagged) entries.set(e.id, e);
      }
    }

    // 3. Recent learnings from same campaign (capped at 3)
    if (campaignId) {
      const campaignLearnings = this.query(projectId, { campaignId }).slice(-3);
      for (const e of campaignLearnings) entries.set(e.id, e);
    }

    const sorted = [...entries.values()].sort((a, b) => {
      const sevOrder = { critical: 0, important: 1, minor: 2 };
      return (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2);
    });

    return this.formatForContext(sorted, 500);
  }

  /**
   * Load all entries across multiple projects.
   * @param {string[]} projectIds
   * @returns {Map<string, object[]>} projectId → entries[]
   */
  loadAllProjects(projectIds) {
    const result = new Map();
    for (const pid of projectIds) {
      result.set(pid, this._loadAll(pid));
    }
    return result;
  }

  /**
   * Build context for campaign/milestone decomposition.
   * Filters to review_finding and pattern_detected categories.
   * @returns {string}
   */
  buildDecompositionContext(projectId) {
    const entries = this.query(projectId, {
      category: ['review_finding', 'pattern_detected'],
      severity: ['critical', 'important'],
    }).slice(-8);

    return this.formatForContext(entries, 600);
  }
}
