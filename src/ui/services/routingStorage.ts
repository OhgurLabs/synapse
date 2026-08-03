// src/ui/services/routingStorage.ts

import {
  DispatchLogResponse,
  DispatchDecision,
  ServiceError,
} from '../types/routing';
import { fetchDecisionLog, classifyError, FetchDecisionLogParams } from './routingService';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 second base delay

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: DispatchDecision[];
  timestamp: number;
}

interface NormalizedParams {
  limit: number;
  offset: number;
  campaignId?: string;
  agentId?: string;
  category?: string;
  since?: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const cache = new Map<string, CacheEntry>();
const pendingRequests = new Map<string, Promise<DispatchDecision[]>>();
const errors = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Normalizes routing decision parameters so cache keys match fetch defaults.
 */
function normalizeParams(params: FetchDecisionLogParams = {}): NormalizedParams {
  const { limit = 100, offset = 0, campaignId, agentId, category, since } = params;
  return { limit, offset, campaignId, agentId, category, since };
}

/**
 * Generates a unique cache key for a given set of parameters.
 * Ensures consistent ordering for reliable cache hits.
 */
function generateCacheKey(params: NormalizedParams): string {
  // Sort keys to ensure consistent cache key generation
  const sortedEntries = Object.entries(params)
    .filter(([_, value]) => value !== undefined)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  return JSON.stringify(Object.fromEntries(sortedEntries));
}

/**
 * Performs an API call with retry logic and exponential backoff.
 * Retries on network errors and 5xx server errors.
 */
async function fetchWithRetry(
  params: FetchDecisionLogParams,
  retries = 0,
): Promise<DispatchDecision[]> {
  try {
    const response = await fetchDecisionLog(params);
    return response.decisions;
  } catch (error: unknown) {
    const serviceError = classifyError(error);

    // Retry on network errors or 5xx server errors
    const shouldRetry =
      (serviceError.kind === 'network' ||
       (serviceError.kind === 'api' && serviceError.statusCode && serviceError.statusCode >= 500)) &&
      retries < MAX_RETRIES;

    if (shouldRetry) {
      const delay = RETRY_DELAY_MS * Math.pow(2, retries);
      console.warn(
        `Attempt ${retries + 1} failed (${serviceError.message}). Retrying in ${delay}ms...`,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(params, retries + 1);
    }

    // Final failure - throw the error
    throw error;
  }
}

/**
 * Internal fetch implementation with caching, deduplication, and error handling.
 */
async function fetchDecisionsInternal(
  params: FetchDecisionLogParams = {},
  forceRefresh = false,
): Promise<DispatchDecision[]> {
  const normalizedParams = normalizeParams(params);
  const cacheKey = generateCacheKey(normalizedParams);

  // Check for pending requests (deduplication)
  if (!forceRefresh && pendingRequests.has(cacheKey)) {
    console.log(`Request deduplication: reusing in-flight request for ${cacheKey}`);
    return pendingRequests.get(cacheKey)!;
  }

  // Check cache if not forcing refresh
  if (!forceRefresh && cache.has(cacheKey)) {
    const cachedEntry = cache.get(cacheKey)!;
    const age = Date.now() - cachedEntry.timestamp;

    if (age < CACHE_DURATION_MS) {
      console.log(`Cache hit for ${cacheKey} (age: ${Math.round(age / 1000)}s)`);
      return cachedEntry.data;
    } else {
      console.log(`Cache expired for ${cacheKey}`);
      cache.delete(cacheKey);
    }
  }

  // Perform the API call with retry logic
  const apiCallPromise = (async () => {
    try {
      errors.delete(cacheKey); // Clear any previous error
      const data = await fetchWithRetry(normalizedParams);

      // Cache the successful result
      cache.set(cacheKey, { data, timestamp: Date.now() });
      console.log(`Cached ${data.length} decisions for ${cacheKey}`);

      return data;
    } catch (error: unknown) {
      const serviceError = classifyError(error);
      console.error('Final error fetching routing decisions after retries:', serviceError);

      // Store error message for retrieval
      errors.set(cacheKey, serviceError.message);

      // Fallback to empty dataset as per spec
      return [];
    } finally {
      // Always clear pending request state
      pendingRequests.delete(cacheKey);
    }
  })();

  // Store the promise to enable deduplication
  pendingRequests.set(cacheKey, apiCallPromise);

  return apiCallPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Promise from the most recent init/warm cycle, so callers can await readiness. */
let warmPromise: Promise<void> | null = null;

/**
 * Initializes the routing storage service and warms the cache by pre-fetching
 * the default dataset.  Emits a `routing-decisions:prefetched` CustomEvent on
 * `window` once the data is available so other modules can react without
 * polling.
 *
 * Safe to call more than once — subsequent calls return the same promise until
 * the cache expires or `clearCache()` is called.
 *
 * @returns The cache-warming promise (resolves when prefetch completes or fails
 *          gracefully).
 *
 * @example
 * ```typescript
 * import { init } from './routingStorage';
 * document.addEventListener('DOMContentLoaded', () => init());
 * ```
 */
export function init(): Promise<void> {
  if (warmPromise) return warmPromise;

  console.log('Routing storage service initialized.');
  warmPromise = warmCache()
    .then(() => {
      // Re-read from cache so we hand consumers the stored data
      return getDecisions();
    })
    .then((data) => {
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(
            new CustomEvent('routing-decisions:prefetched', {
              detail: { params: { limit: 100, offset: 0 }, data: data || [] },
            }),
          );
        } catch (e) {
          console.warn('Dispatch log prefetch event failed to emit', e);
        }
      }
    })
    .catch((err) => {
      console.warn('Dispatch log prefetch failed:', err instanceof Error ? err.message : err);
    });

  return warmPromise;
}

/**
 * Returns the promise from the last `init()` call, or `null` if `init()` has
 * not been called yet.  Useful for components that need to wait until the
 * initial data is ready.
 */
export function ready(): Promise<void> | null {
  return warmPromise;
}

/**
 * Retrieves routing decisions with caching and request deduplication.
 * Returns cached data if available and fresh, otherwise fetches from API.
 *
 * @param params - Optional filter parameters
 * @param forceRefresh - If true, bypass cache and force new API call
 * @returns Promise resolving to array of routing decisions
 *
 * @example
 * ```typescript
 * // Get recent decisions with default parameters
 * const decisions = await getDecisions();
 *
 * // Get decisions for a specific agent
 * const agentDecisions = await getDecisions({ agentId: 'agent123', limit: 50 });
 *
 * // Force refresh from API
 * const freshDecisions = await getDecisions({}, true);
 * ```
 */
export async function getDecisions(
  params: FetchDecisionLogParams = {},
  forceRefresh = false,
): Promise<DispatchDecision[]> {
  return fetchDecisionsInternal(params, forceRefresh);
}

/**
 * Refreshes the data for a given set of parameters.
 * Clears the cache entry and forces a new API call.
 *
 * @param params - Optional filter parameters
 * @returns Promise resolving to refreshed array of routing decisions
 *
 * @example
 * ```typescript
 * // Refresh all routing decisions
 * const decisions = await refresh();
 *
 * // Refresh decisions for a specific campaign
 * const campaignDecisions = await refresh({ campaignId: 'camp123' });
 * ```
 */
export async function refresh(params: FetchDecisionLogParams = {}): Promise<DispatchDecision[]> {
  const normalizedParams = normalizeParams(params);
  const cacheKey = generateCacheKey(normalizedParams);

  // Clear the specific cache entry
  cache.delete(cacheKey);
  pendingRequests.delete(cacheKey);
  errors.delete(cacheKey);

  console.log(`Cache cleared for ${cacheKey}, fetching fresh data...`);

  return getDecisions(params, true);
}

/**
 * Clears the entire cache or a specific cache entry.
 * Also clears any associated error states and pending request markers.
 *
 * @param params - Optional parameters to identify specific cache entry to clear.
 *                 If omitted, clears the entire cache.
 *
 * @example
 * ```typescript
 * // Clear all cached data
 * clearCache();
 *
 * // Clear cache for specific parameters
 * clearCache({ agentId: 'agent123', limit: 50 });
 * ```
 */
export function clearCache(params?: FetchDecisionLogParams): void {
  if (params) {
    const normalizedParams = normalizeParams(params);
    const cacheKey = generateCacheKey(normalizedParams);

    cache.delete(cacheKey);
    pendingRequests.delete(cacheKey);
    errors.delete(cacheKey);

    console.log(`Cache and errors cleared for key: ${cacheKey}`);
  } else {
    cache.clear();
    pendingRequests.clear();
    errors.clear();
    warmPromise = null; // Allow init() to re-warm after full clear

    console.log('All caches and errors cleared.');
  }
}

/**
 * Checks if a request for the given parameters is currently in progress.
 *
 * @param params - Parameters used to identify the request
 * @returns True if a request is pending, false otherwise
 *
 * @example
 * ```typescript
 * if (isLoading({ agentId: 'agent1' })) {
 *   console.log('Loading...');
 * }
 * ```
 */
export function isLoading(params: FetchDecisionLogParams = {}): boolean {
  const normalizedParams = normalizeParams(params);
  const cacheKey = generateCacheKey(normalizedParams);
  return pendingRequests.has(cacheKey);
}

/**
 * Returns the last error message encountered for the given parameters, if any.
 *
 * @param params - Parameters used to identify the request
 * @returns The error message or null if no error occurred
 *
 * @example
 * ```typescript
 * const error = getError({ campaignId: 'camp1' });
 * if (error) {
 *   console.error('Last error:', error);
 * }
 * ```
 */
export function getError(params: FetchDecisionLogParams = {}): string | null {
  const normalizedParams = normalizeParams(params);
  const cacheKey = generateCacheKey(normalizedParams);
  return errors.get(cacheKey) || null;
}

/**
 * Warms the cache by pre-fetching the default dataset.
 * Call this on page load to ensure data is available immediately.
 *
 * @returns Promise that resolves when the cache warming is complete
 *
 * @example
 * ```typescript
 * // Warm cache on page load
 * document.addEventListener('DOMContentLoaded', () => {
 *   warmCache();
 * });
 * ```
 */
export async function warmCache(): Promise<void> {
  try {
    console.log('Warming routing storage cache...');
    await getDecisions(); // Fetch with default parameters
    console.log('Cache warming complete.');
  } catch (error) {
    console.warn('Cache warming failed:', error);
    // Don't throw - warming is optional
  }
}
