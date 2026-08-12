/**
 * Memory Write-Back Service
 * Buffers memory candidates and writes them in batches with deduplication.
 */

import { createHash } from 'crypto';
import { createLogger } from '../logger.js';

const log = createLogger('memory-writeback');

const DEFAULT_FLUSH_INTERVAL_MS = 30 * 1000; // 30s
const DEFAULT_MAX_BATCH_SIZE = 50;

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function computeContentHash(entry) {
  return contentHash(`${entry.category}|${entry.content}`);
}

export class MemoryWriteBackService {
  /**
   * @param {Object} deps
   * @param {AgentMemoryStore} deps.agentMemoryStore
   * @param {number} [deps.flushIntervalMs]
   * @param {number} [deps.maxBatchSize]
   */
  constructor(deps = {}) {
    this._agentMemoryStore = deps.agentMemoryStore;
    this._flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this._maxBatchSize = deps.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

    this._buffer = []; // { agentId, entry, contentHash }
    this._pendingHashes = new Map(); // agentId -> Set<contentHash>
    this._isFlushing = false;

    this._startFlushTimer();

    log.info('Memory write-back service initialized', {
      flushIntervalMs: this._flushIntervalMs,
      maxBatchSize: this._maxBatchSize,
    });
  }

  _startFlushTimer() {
    if (this._flushIntervalMs <= 0) return;
    this._flushTimer = setInterval(() => {
      this.flush().catch(err => {
        log.warn('Periodic flush failed', { error: err.message });
      });
    }, this._flushIntervalMs);
    this._flushTimer.unref?.();
  }

  stop() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  _getPendingSet(agentId) {
    if (!this._pendingHashes.has(agentId)) {
      this._pendingHashes.set(agentId, new Set());
    }
    return this._pendingHashes.get(agentId);
  }

  _computeHash(entry) {
    if (this._agentMemoryStore && typeof this._agentMemoryStore._computeContentHash === 'function') {
      return this._agentMemoryStore._computeContentHash(entry);
    }
    return computeContentHash(entry);
  }

  /**
   * Add memory candidate to the buffer.
   * @param {string} agentId
   * @param {string} category
   * @param {string} content
   * @param {object} [source]
   * @param {string[]} [tags]
   * @param {number} [confidence]
   * @returns {object|null} candidate or null if duplicate/invalid
   */
  add(agentId, category, content, source = {}, tags = [], confidence = undefined) {
    if (!this._agentMemoryStore) {
      log.warn('AgentMemoryStore not configured; skipping write-back', { agentId });
      return null;
    }
    if (!agentId || !category || !content || typeof content !== 'string') {
      log.warn('Invalid memory candidate', { agentId, category });
      return null;
    }

    const entry = { category, content, source, tags };
    if (typeof confidence === 'number') entry.confidence = confidence;

    const hash = this._computeHash(entry);

    let existingHashes;
    try {
      existingHashes = this._agentMemoryStore._loadHashes(agentId);
    } catch (err) {
      log.warn('Failed to load hashes for deduplication', { agentId, error: err.message });
      existingHashes = new Set();
    }

    const pending = this._getPendingSet(agentId);
    if (existingHashes.has(hash) || pending.has(hash)) {
      log.debug('Duplicate memory candidate skipped', { agentId, hash });
      return null;
    }

    pending.add(hash);
    this._buffer.push({ agentId, entry, contentHash: hash });

    if (this._buffer.length >= this._maxBatchSize) {
      this.flush().catch(err => {
        log.warn('Immediate flush failed', { error: err.message });
      });
    }

    return { agentId, ...entry };
  }

  /**
   * Flush buffered memory candidates to the AgentMemoryStore.
   */
  async flush() {
    if (this._isFlushing || this._buffer.length === 0) return;
    this._isFlushing = true;

    const batch = this._buffer.splice(0, this._buffer.length);
    let written = 0;
    let skipped = 0;

    for (const item of batch) {
      const { agentId, entry, contentHash: hash } = item;
      try {
        // addAsync, not add: the synchronous path waits on the write lock with
        // Atomics.wait, which freezes the WHOLE event loop — every agent, HTTP
        // request and timer in the process — for up to lockTimeoutMs. flush()
        // is already async, so there is no reason to pay that here.
        const record = typeof this._agentMemoryStore.addAsync === 'function'
          ? await this._agentMemoryStore.addAsync(agentId, entry)
          : this._agentMemoryStore.add(agentId, entry);
        if (record) {
          written++;
        } else {
          skipped++;
        }
      } catch (err) {
        log.warn('Failed to write memory candidate', { agentId, error: err.message });
      } finally {
        const pending = this._pendingHashes.get(agentId);
        if (pending) pending.delete(hash);
      }
    }

    if (written > 0 || skipped > 0) {
      log.info('Memory write-back flush complete', { written, skipped, total: batch.length });
    }

    this._isFlushing = false;
  }
}
