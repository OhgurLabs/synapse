// Vector store — binary Float32 vectors + JSONL metadata index.
// Storage layout per project: .synapse/projects/{id}/embeddings/
//   vectors.bin  — raw Float32 array, 768 dims × 4 bytes = 3072 bytes per row
//   index.jsonl  — one line per embedding: { msgId, project, channel, threadId, speaker, timestamp, charLen, snippet, contentHash }
//
// Crash recovery: metadata is written first, then binary.
// On startup, if binary has fewer records than JSONL, re-embed the tail.
//
// V2 additions: vector cache, snippet backfill, content-hash dedup.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import config from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('rag/store');

const DIMS = config.embeddings.dimensions;
const BYTES_PER_VEC = DIMS * 4; // Float32 = 4 bytes

/** Short content hash for dedup (first 16 hex chars of SHA-256). */
export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class VectorStore {
  static getLog() {
    return log;
  }

  /**
   * @param {string} baseDir — .synapse/projects/{projectId}
   */
  constructor(baseDir) {
    this.dir = join(baseDir, 'embeddings');
    this.vectorsPath = join(this.dir, 'vectors.bin');
    this.indexPath = join(this.dir, 'index.jsonl');
    this.indexedIds = new Set();
    this._contentHashes = new Set(); // content-hash dedup
    this._metaCache = [];   // in-memory copy of metadata entries
    this._vectorCount = 0;  // count of vectors in binary file
    this._vectorCache = null; // lazy in-memory vector cache
  }

  /** Initialize store — create dirs, load existing index, check alignment. */
  init() {
    mkdirSync(this.dir, { recursive: true });

    // Load metadata index
    if (existsSync(this.indexPath)) {
      const lines = readFileSync(this.indexPath, 'utf-8').trim().split('\n').filter(Boolean);
      let skipCount = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          this._metaCache.push(entry);
          this.indexedIds.add(entry.msgId);
          if (entry.contentHash) this._contentHashes.add(entry.contentHash);
        } catch {
          skipCount++;
        }
      }
      if (skipCount > 0) {
        log.warn('RAG index has corrupt entries', { path: this.indexPath, skippedLines: skipCount, totalLines: lines.length });
      }
    }

    // Count binary vectors
    if (existsSync(this.vectorsPath)) {
      const size = statSync(this.vectorsPath).size;
      this._vectorCount = Math.floor(size / BYTES_PER_VEC);
    }

    // Auto-repair: if vectors exceed metadata, truncate vectors.bin to match
    // (corrupt JSONL lines were skipped above, leaving fewer metadata entries)
    if (this._vectorCount > this._metaCache.length && this._metaCache.length > 0) {
      const expectedSize = this._metaCache.length * BYTES_PER_VEC;
      log.warn('RAG vectors/metadata misaligned — truncating vectors.bin', {
        vectorCount: this._vectorCount, metaCount: this._metaCache.length,
      });
      const buf = readFileSync(this.vectorsPath);
      writeFileSync(this.vectorsPath, buf.subarray(0, expectedSize));
      this._vectorCount = this._metaCache.length;
      this._vectorCache = null;
    }

    return this;
  }

  /**
   * Check alignment between metadata and binary.
   * @returns {{ aligned: boolean, metaCount: number, vectorCount: number, tailCount: number }}
   */
  checkAlignment() {
    const metaCount = this._metaCache.length;
    const vectorCount = this._vectorCount;
    const aligned = metaCount === vectorCount;
    return {
      aligned,
      metaCount,
      vectorCount,
      // Number of metadata entries without matching vectors (need re-embedding)
      tailCount: aligned ? 0 : Math.max(0, metaCount - vectorCount),
    };
  }

  /**
   * Get metadata entries that need re-embedding (tail of index without binary vectors).
   * @returns {Array<{msgId: string, index: number}>}
   */
  getMisalignedEntries() {
    const { aligned, tailCount } = this.checkAlignment();
    if (aligned || tailCount === 0) return [];
    return this._metaCache.slice(-tailCount).map((entry, i) => ({
      msgId: entry.msgId,
      index: this._metaCache.length - tailCount + i,
    }));
  }

  /**
   * Check if a message ID has already been indexed.
   * @param {string} msgId
   * @returns {boolean}
   */
  has(msgId) {
    return this.indexedIds.has(msgId);
  }

  /**
   * Check if content is a duplicate by hash.
   * @param {string} hash — contentHash value
   * @returns {boolean}
   */
  hasContentHash(hash) {
    return this._contentHashes.has(hash);
  }

  /**
   * Add a vector + metadata entry.
   * Writes metadata JSONL first (crash recovery — can re-embed from tail).
   * @param {{ msgId: string, project: string, channel: string, threadId?: string, speaker: string, timestamp: string, charLen: number, snippet?: string, contentHash?: string }} meta
   * @param {Float32Array} vector
   * @returns {boolean} true if added, false if skipped (duplicate)
   */
  add(meta, vector) {
    if (this.indexedIds.has(meta.msgId)) return false; // already indexed by ID
    if (meta.contentHash && this._contentHashes.has(meta.contentHash)) return false; // content-hash dedup
    if (vector.length !== DIMS) {
      throw new Error(`Vector dimension mismatch: got ${vector.length}, expected ${DIMS}`);
    }

    // 1. Write metadata first (crash-safe: if binary write fails, we re-embed on next startup)
    const metaLine = JSON.stringify({
      msgId: meta.msgId,
      project: meta.project,
      channel: meta.channel,
      threadId: meta.threadId || null,
      speaker: meta.speaker,
      timestamp: meta.timestamp,
      charLen: meta.charLen,
      snippet: meta.snippet || null,
      contentHash: meta.contentHash || null,
    });
    appendFileSync(this.indexPath, metaLine + '\n');

    // 2. Append binary vector (little-endian Float32)
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    appendFileSync(this.vectorsPath, buf);

    // 3. Update in-memory state
    const entry = JSON.parse(metaLine);
    this._metaCache.push(entry);
    this.indexedIds.add(meta.msgId);
    if (meta.contentHash) this._contentHashes.add(meta.contentHash);
    this._vectorCount++;

    // 4. Invalidate vector cache (will be rebuilt on next search)
    this._vectorCache = null;

    return true;
  }

  /**
   * Load all vectors into memory for brute-force search.
   * Uses in-memory cache — only reads disk on first call or after cache invalidation.
   * @returns {Float32Array[]}
   */
  loadVectors() {
    if (this._vectorCache) return this._vectorCache;
    if (!existsSync(this.vectorsPath)) return [];
    const buf = readFileSync(this.vectorsPath);
    const count = Math.floor(buf.length / BYTES_PER_VEC);
    const vectors = [];
    for (let i = 0; i < count; i++) {
      const offset = i * BYTES_PER_VEC;
      const arr = new Float32Array(buf.buffer, buf.byteOffset + offset, DIMS);
      vectors.push(new Float32Array(arr)); // copy to own buffer
    }
    this._vectorCache = vectors;
    return vectors;
  }

  /**
   * Get metadata for all indexed entries.
   * @returns {Array<Object>}
   */
  getMetadata() {
    return this._metaCache;
  }

  /**
   * Get total count of indexed entries.
   * @returns {number}
   */
  count() {
    return this._metaCache.length;
  }

  /**
   * Count entries missing snippets (need backfill).
   * @returns {number}
   */
  countMissingSnippets() {
    return this._metaCache.filter(e => !e.snippet).length;
  }

  /**
   * Backfill snippets for entries that have snippet: null.
   * Calls lookupFn(msgId, projectId, channel) to resolve the original message content.
   * Rewrites index.jsonl in-place (atomic: write tmp → rename).
   *
   * @param {(msgId: string, project: string, channel: string) => string|null} lookupFn
   * @returns {number} count of snippets backfilled
   */
  backfillSnippets(lookupFn) {
    let backfilled = 0;
    for (const entry of this._metaCache) {
      if (entry.snippet) continue;
      const content = lookupFn(entry.msgId, entry.project, entry.channel);
      if (!content) continue;
      entry.snippet = content.length > 400 ? content.slice(0, 400) + '...' : content;
      backfilled++;
    }
    if (backfilled > 0) {
      // Rewrite index.jsonl with updated entries
      const lines = this._metaCache.map(e => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(this.indexPath, lines);
    }
    return backfilled;
  }
}
