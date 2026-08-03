// Retrieval — brute-force cosine similarity over in-memory vectors.
// Returns top-K results above a similarity threshold.

import config from '../config.js';
import { embed } from './embedding.js';

const { topK: defaultTopK, threshold: defaultThreshold } = config.embeddings;

/**
 * Cosine similarity between two Float32Arrays.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} similarity in [-1, 1]
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Search for the most relevant messages given a query string.
 *
 * @param {string} query — the search text to embed
 * @param {VectorStore} store — initialized VectorStore instance
 * @param {{ topK?: number, threshold?: number, filter?: (meta: Object) => boolean }} [options]
 * @returns {Promise<Array<{ msgId: string, score: number, meta: Object }>>}
 */
export async function search(query, store, options = {}) {
  const { topK = defaultTopK, threshold = defaultThreshold, filter } = options;

  // Embed the query
  const queryVec = await embed(query);
  if (!queryVec) return []; // embedding failed or queue paused

  return searchByVector(queryVec, store, { topK, threshold, filter });
}

/**
 * Search using a pre-computed query vector (avoids re-embedding).
 *
 * @param {Float32Array} queryVec
 * @param {VectorStore} store
 * @param {{ topK?: number, threshold?: number, filter?: (meta: Object) => boolean }} [options]
 * @returns {Array<{ msgId: string, score: number, meta: Object }>}
 */
export function searchByVector(queryVec, store, options = {}) {
  const { topK = defaultTopK, threshold = defaultThreshold, filter } = options;

  const vectors = store.loadVectors();
  const metadata = store.getMetadata();
  const results = [];
  const safeLen = Math.min(vectors.length, metadata.length);

  for (let i = 0; i < safeLen; i++) {
    if (!metadata[i]) continue;
    if (filter && !filter(metadata[i])) continue;

    const score = cosineSimilarity(queryVec, vectors[i]);
    if (score >= threshold) {
      results.push({ msgId: metadata[i].msgId, score, meta: metadata[i] });
    }
  }

  // Sort by score descending, take top-K
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
