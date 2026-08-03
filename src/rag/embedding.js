// Ollama embedding client — sequential async queue with retry logic.
// Uses POST /v1/embeddings with nomic-embed-text (768 dimensions).

import config from '../config.js';
import { createLogger } from '../logger.js';
import { guardedFetch } from '../guarded-fetch.js';

const log = createLogger('rag/embedding');

const { endpoint, model, maxChars, timeoutMs, retries, retryDelays, maxConsecutiveFailures } = config.embeddings;

// RAG is OPTIONAL: with no SYNAPSE_EMBED_ENDPOINT the feature is simply off.
// Without this gate, every embed attempt fetched "null/v1/embeddings", the
// SSRF guard rejected it, and a fresh install's journal filled with
// "Embed failed: Invalid URL" errors for a feature nobody configured.
export const ragConfigured = typeof endpoint === 'string' && endpoint.length > 0;
if (!ragConfigured) {
  log.info('RAG disabled — no embedding endpoint configured (set SYNAPSE_EMBED_ENDPOINT to enable semantic recall)');
}

let consecutiveFailures = 0;
let queuePaused = false;

// Sequential promise chain — one embed at a time (single GPU constraint)
let pending = Promise.resolve();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Check if the Ollama server is reachable.
 * @returns {Promise<boolean>}
 */
export async function healthCheck() {
  if (!ragConfigured) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await guardedFetch(`${endpoint}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Embed a single text string via Ollama /v1/embeddings.
 * Retries up to `retries` times with exponential backoff.
 * @param {string} text
 * @returns {Promise<Float32Array>} embedding vector (768 dims)
 */
async function embedSingle(text) {
  // Truncate if needed — add speaker prefix handling upstream
  const truncated = text.length > maxChars ? text.slice(0, maxChars) : text;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await guardedFetch(`${endpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: truncated }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 404 || res.status === 501) {
          // Permanent failure — llama.cpp doesn't serve /v1/embeddings. Pause immediately, no retries.
          queuePaused = true;
          consecutiveFailures = maxConsecutiveFailures;
          const msg = res.status === 501 ? "Embedding not supported by server (501) — paused" : "Embedding endpoint unavailable (404) — paused";
          log.warn(msg);
          return null;
        }
        throw new Error(`Ollama /v1/embeddings returned ${res.status}: ${body}`);
      }

      const json = await res.json();
      // /v1/embeddings returns { embeddings: [[...]] } for single input
      const vec = json.data?.[0]?.embedding;
      if (!vec || vec.length !== config.embeddings.dimensions) {
        throw new Error(`Unexpected embedding shape: got ${vec?.length ?? 'null'}, expected ${config.embeddings.dimensions}`);
      }

      consecutiveFailures = 0;
      queuePaused = false;
      return new Float32Array(vec);

    } catch (err) {
      if (attempt < retries) {
        const delay = retryDelays[attempt] || retryDelays[retryDelays.length - 1];
        await sleep(delay);
        continue;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        queuePaused = true;
      }
      throw err;
    }
  }
}

/**
 * Queue an embedding request. Executes sequentially.
 * Returns null if the queue is paused due to consecutive failures.
 * @param {string} text
 * @returns {Promise<Float32Array|null>}
 */
export function embed(text) {
  if (!ragConfigured) return Promise.resolve(null); // feature off — silent no-op
  if (queuePaused) return Promise.resolve(null);

  const p = pending.then(() => embedSingle(text)).catch(err => {
    log.error('Embed failed', { error: err.message });
    return null;
  });
  pending = p.then(() => {}); // keep chain going even on failure
  return p;
}

/**
 * Reset the failure state (e.g., after a successful health check).
 */
export function resetFailures() {
  consecutiveFailures = 0;
  queuePaused = false;
}

/**
 * @returns {boolean} whether the queue is paused
 */
export function isPaused() {
  return queuePaused;
}
