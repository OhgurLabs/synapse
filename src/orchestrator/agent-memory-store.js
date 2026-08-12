/**
 * Agent-Scoped Persistent Memory System
 * Stores agent expertise, experience, and preferences across campaigns.
 * Append-only JSONL storage per agent with content-hash deduplication.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
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
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

/** Non-blocking sleep for the async acquire path. */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export class AgentMemoryStore {
  constructor(stateManager, options = {}) {
    this._stateManager = stateManager;
    this._hashSets = new Map(); // agentId → Set<contentHash>
    this._onAdd = null; // callback: (agentId, memory) => void
    this._lockTimeoutMs = Math.max(1, options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS);
    this._lockStaleMs = Math.max(1, options.lockStaleMs || DEFAULT_LOCK_STALE_MS);
    this._lockRetryMs = Math.max(1, options.lockRetryMs || DEFAULT_LOCK_RETRY_MS);
  }

  /** Register a callback fired after every successful add(). */
  onMemoryAdded(callback) {
    this._onAdd = callback;
  }

  /** Path to memory JSONL for an agent. */
  _getMemoryPath(agentId) {
    // Defense in depth: agent ids must be path-safe even if a caller skips
    // addAgent validation (tests, loaders, manual JSON).
    if (
      !agentId ||
      typeof agentId !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(agentId) ||
      agentId.length > 100
    ) {
      throw new Error(
        `Invalid agentId for memory path: "${String(agentId).slice(0, 80)}" — alphanumeric/hyphens/underscores only`
      );
    }
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
    const hashes = this._readHashesFromDisk(this._getMemoryPath(agentId));
    this._hashSets.set(agentId, hashes);
    return hashes;
  }

  _readHashesFromDisk(path) {
    const hashes = new Set();
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.contentHash) hashes.add(entry.contentHash);
        } catch { /* skip corrupt lines */ }
      }
    }
    return hashes;
  }

  /**
   * One attempt at taking the write lock.
   *
   * Factored out so the synchronous and asynchronous acquire loops share
   * EXACTLY this logic and cannot drift apart — only the way they wait differs.
   *
   * @returns {{ release: Function } | { retryNow: true } | { waitMs: number }}
   *   release  — lock taken, call to release it
   *   retryNow — stale lock reclaimed or vanished; try again immediately
   *   waitMs   — lock is held by a live owner; wait this long, then retry
   * @throws on a real error, or MEMORY_LOCK_TIMEOUT once the budget is spent
   */
  _attemptWriteLock(lockPath, owner, agentId, startedAt) {
    {
      try {
        const lockFd = openSync(lockPath, 'wx', 0o600);
        let setupError = null;
        try {
          writeSync(lockFd, JSON.stringify(owner), null, 'utf8');
          fsyncSync(lockFd);
        } catch (err) {
          setupError = err;
        } finally {
          closeSync(lockFd);
        }
        if (setupError) {
          try { unlinkSync(lockPath); } catch { /* stale recovery handles cleanup if needed */ }
          throw setupError;
        }

        return {
          release: () => {
            try {
              const currentOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
              if (currentOwner.token === owner.token) unlinkSync(lockPath);
            } catch (err) {
              if (err?.code !== 'ENOENT') {
                log.warn('Failed to release memory write lock', { agentId, lockPath, error: err.message });
              }
            }
          },
        };
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;

        try {
          const lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
          if (lockAgeMs >= this._lockStaleMs) {
            let ownerPid = null;
            try { ownerPid = JSON.parse(readFileSync(lockPath, 'utf8')).pid; } catch { /* corrupt locks have no live owner */ }
            if (!isProcessAlive(ownerPid)) {
              unlinkSync(lockPath);
              log.warn('Recovered stale memory write lock', { agentId, lockPath, lockAgeMs, ownerPid });
              return { retryNow: true };
            }
          }
        } catch (staleErr) {
          if (staleErr?.code === 'ENOENT') return { retryNow: true };
          throw staleErr;
        }

        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= this._lockTimeoutMs) {
          const timeoutError = new Error(`Timed out waiting for memory write lock for ${agentId}`);
          timeoutError.code = 'MEMORY_LOCK_TIMEOUT';
          timeoutError.lockPath = lockPath;
          throw timeoutError;
        }
        return { waitMs: Math.min(this._lockRetryMs, this._lockTimeoutMs - elapsedMs) };
      }
    }
  }

  /** Fresh owner identity + deadline for one acquire attempt sequence. */
  _newLockAttempt(path) {
    return {
      lockPath: `${path}.lock`,
      startedAt: Date.now(),
      owner: {
        pid: process.pid,
        token: randomBytes(16).toString('hex'),
        createdAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Synchronous acquire. Kept for callers that cannot await — including a
   * large number of existing tests — so this signature is unchanged.
   *
   * WARNING: the wait here is Atomics.wait, which blocks the ENTIRE event loop,
   * not merely this caller. Under contention that stalls every agent, HTTP
   * request and timer in the process for up to lockTimeoutMs. Prefer
   * acquireWriteLockAsync()/addAsync() from any async context.
   */
  _acquireWriteLock(path, agentId) {
    const { lockPath, startedAt, owner } = this._newLockAttempt(path);
    while (true) {
      const r = this._attemptWriteLock(lockPath, owner, agentId, startedAt);
      if (r.release) return r.release;
      if (r.retryNow) continue;
      Atomics.wait(SLEEP_VIEW, 0, 0, r.waitMs);
    }
  }

  /**
   * Asynchronous acquire — identical semantics, but yields the event loop
   * while waiting instead of freezing it.
   */
  async _acquireWriteLockAsync(path, agentId) {
    const { lockPath, startedAt, owner } = this._newLockAttempt(path);
    while (true) {
      const r = this._attemptWriteLock(lockPath, owner, agentId, startedAt);
      if (r.release) return r.release;
      if (r.retryNow) continue;
      await sleep(r.waitMs);
    }
  }

  _appendAndSync(path, record) {
    const fd = openSync(path, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
  /**
   * Validation + hashing + directory setup, i.e. everything that happens
   * BEFORE the lock is taken. Shared by add() and addAsync() so the two cannot
   * validate differently.
   */
  _prepareAdd(agentId, entry) {
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

    // Ensure directory exists (redundant with _getMemoryPath but explicit per requirements)
    const baseDir = this._stateManager?.baseDir || '.synapse';
    const dir = join(baseDir, 'agents', agentId, 'memory');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    return { path: this._getMemoryPath(agentId), hash };
  }

  add(agentId, entry) {
    const { path, hash } = this._prepareAdd(agentId, entry);
    return this._commitAdd(agentId, entry, path, hash, this._acquireWriteLock(path, agentId));
  }

  /**
   * Same as add(), but waits for the lock WITHOUT freezing the event loop.
   *
   * add() is unchanged and still synchronous: it has a large number of callers,
   * and making it async would have turned every un-awaited `const r = add(...)`
   * into a truthy Promise — `if (r)` and `assert.ok(r)` would keep passing while
   * asserting nothing. So the async path is additive, and production uses it.
   *
   * @returns {Promise<object|null>} The entry if added, null if duplicate.
   */
  async addAsync(agentId, entry) {
    const { path, hash } = this._prepareAdd(agentId, entry);
    return this._commitAdd(agentId, entry, path, hash, await this._acquireWriteLockAsync(path, agentId));
  }

  /** The critical section itself, identical for both entry points. */
  _commitAdd(agentId, entry, path, hash, releaseLock) {
    let record;
    try {
      // The in-memory cache is only a fast local hint. Reload under the
      // cross-process lock so a second orchestrator cannot append a duplicate
      // based on a stale per-process cache.
      const hashes = this._readHashesFromDisk(path);
      this._hashSets.set(agentId, hashes);
      if (hashes.has(hash)) {
        log.debug('Duplicate memory skipped', { agentId, hash });
        return null;
      }

      record = {
        id: entry.id || generateId(),
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

      this._appendAndSync(path, record);
      hashes.add(hash);
    } finally {
      releaseLock();
    }

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
