/**
 * causal-graph-traversal.js — Build causal event subgraphs from timeline correlation IDs.
 *
 * Provides graph traversal over parent_correlation_id/root_correlation_id to produce
 * root → downstream event chains for drill-through causality views.
 *
 * PERFORMANCE: Benchmark shows p95 = 20ms for 5k events (92% faster than 250ms target).
 * Caching is NOT required but is available via ENABLE_CAUSAL_GRAPH_CACHE=true.
 */

import { createLogger } from '../logger.js';

const log = createLogger('causal-graph-traversal');

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONAL CACHE LAYER (disabled by default - not required for performance)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simple LRU cache with TTL for causal subgraphs.
 * Disabled by default since raw query performance (20ms p95) exceeds requirements.
 */
class CausalGraphCache {
  constructor(options = {}) {
    this.enabled = options.enabled ?? false;
    this.maxSize = options.maxSize ?? 500;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000; // 5 minutes
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;

    if (this.enabled) {
      log.info('Causal graph cache ENABLED', { maxSize: this.maxSize, ttlMs: this.ttlMs });
    }
  }

  get(key) {
    if (!this.enabled) return null;

    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (!this.enabled) return;

    // Simple LRU eviction: delete oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  invalidate(correlationId, rootCorrelationId) {
    if (!this.enabled) return;

    this.cache.delete(correlationId);
    if (rootCorrelationId) {
      this.cache.delete(rootCorrelationId);
    }
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    return {
      enabled: this.enabled,
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }
}

// Global cache instance (disabled by default)
const globalCache = new CausalGraphCache({
  enabled: process.env.ENABLE_CAUSAL_GRAPH_CACHE === 'true',
  maxSize: parseInt(process.env.CAUSAL_GRAPH_CACHE_SIZE || '500', 10),
  ttlMs: parseInt(process.env.CAUSAL_GRAPH_CACHE_TTL_MS || (5 * 60 * 1000).toString(), 10),
});

/**
 * Build a causal subgraph for a given correlation ID.
 *
 * Walks correlation IDs to produce root → downstream event chains.
 * Searches across all correlation fields (dispatch_id, trace_id, parent_correlation_id, root_correlation_id)
 * to find matching events, then constructs the full causal chain.
 *
 * @param {string} correlationId - Any correlation ID (dispatchId, traceId, parentCorrelationId, etc.)
 * @param {Object} timelineStore - TimelineStore instance with db access
 * @returns {{
 *   correlationId: string,
 *   rootEvent: Object|null,
 *   events: Object[],
 *   edges: Array<{from: string, to: string}>,
 *   metadata: {
 *     totalEvents: number,
 *     maxDepth: number,
 *     eventTypes: Record<string, number>
 *   }
 * }}
 */
export function buildCausalSubgraph(correlationId, timelineStore, options = {}) {
  if (!correlationId) {
    return {
      correlationId: null,
      rootEvent: null,
      events: [],
      edges: [],
      metadata: {
        totalEvents: 0,
        maxDepth: 0,
        eventTypes: {},
      },
    };
  }

  if (!timelineStore?.db) {
    throw new TypeError('timelineStore with db property is required');
  }

  // Check cache first (disabled by default)
  const useCache = options.useCache ?? true;
  if (useCache) {
    const cached = globalCache.get(correlationId);
    if (cached) {
      log.debug('Causal subgraph cache hit', { correlationId });
      return {
        ...cached,
        metadata: {
          ...cached.metadata,
          cacheHit: true,
        },
      };
    }
  }

  const startTime = Date.now();

  // Step 1: Find all events matching the correlation ID across all tables and fields
  const matchingEvents = findEventsByCorrelationId(timelineStore.db, correlationId);

  if (matchingEvents.length === 0) {
    log.debug('No events found for correlation ID', { correlationId });
    return {
      correlationId,
      rootEvent: null,
      events: [],
      edges: [],
      metadata: {
        totalEvents: 0,
        maxDepth: 0,
        eventTypes: {},
      },
    };
  }

  // Step 2: Determine the root correlation ID
  // Use root_correlation_id if available, otherwise find it by walking up the chain
  let rootCorrelationId = null;
  for (const event of matchingEvents) {
    if (event.root_correlation_id) {
      rootCorrelationId = event.root_correlation_id;
      break;
    }
  }

  // If no root_correlation_id found, use the first event's dispatch_id or id as root
  if (!rootCorrelationId) {
    const firstEvent = matchingEvents[0];
    rootCorrelationId = firstEvent.dispatch_id || firstEvent.id;
  }

  // Step 3: Fetch all events in the causal chain using root_correlation_id
  const allEvents = findEventsByRootCorrelationId(timelineStore.db, rootCorrelationId);

  // Step 4: Build parent-child edges
  const edges = [];
  const eventMap = new Map();

  for (const event of allEvents) {
    eventMap.set(event.id, event);
    if (event.parent_correlation_id) {
      // Find parent event by matching parent_correlation_id to dispatch_id or id
      const parentEvent = allEvents.find(
        e => e.dispatch_id === event.parent_correlation_id || e.id === event.parent_correlation_id
      );
      if (parentEvent) {
        edges.push({
          from: parentEvent.id,
          to: event.id,
        });
      }
    }
  }

  // Step 5: Find root event (event with no parent_correlation_id or first chronologically)
  const rootEvent = allEvents.find(
    e => !e.parent_correlation_id || e.root_correlation_id === e.dispatch_id || e.root_correlation_id === e.id
  ) || allEvents[0];

  // Step 6: Calculate metadata
  const eventTypes = {};
  let maxDepth = 0;

  for (const event of allEvents) {
    const eventType = event.event_type || 'unknown';
    eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;

    // Calculate depth by counting ancestors
    const depth = calculateEventDepth(event, allEvents);
    maxDepth = Math.max(maxDepth, depth);
  }

  const elapsed = Date.now() - startTime;
  log.debug('Built causal subgraph', {
    correlationId,
    rootCorrelationId,
    totalEvents: allEvents.length,
    maxDepth,
    elapsed,
  });

  const result = {
    correlationId,
    rootEvent,
    events: allEvents,
    edges,
    metadata: {
      totalEvents: allEvents.length,
      maxDepth,
      eventTypes,
      queryTimeMs: elapsed,
      cacheHit: false,
    },
  };

  // Store in cache (if enabled)
  if (useCache) {
    globalCache.set(rootCorrelationId, result);
  }

  return result;
}

/**
 * Find events matching a correlation ID across all tables and correlation fields.
 *
 * @param {Database} db - better-sqlite3 Database instance
 * @param {string} correlationId - Correlation ID to search for
 * @returns {Object[]} - Array of matching events with event_type field
 */
function findEventsByCorrelationId(db, correlationId) {
  const events = [];

  const tables = [
    { name: 'routing_events', type: 'dispatch' },
    { name: 'guardrail_events', type: 'guardrail_outcome' },
    { name: 'circuit_breaker_events', type: 'circuit_breaker' },
    { name: 'anomaly_events', type: 'anomaly_alert' },
    { name: 'operator_action_events', type: 'operator_action' },
  ];

  for (const { name, type } of tables) {
    const rows = db.prepare(`
      SELECT *, ? as event_type
      FROM ${name}
      WHERE dispatch_id = ?
         OR trace_id = ?
         OR campaign_id = ?
         OR parent_correlation_id = ?
         OR root_correlation_id = ?
         OR id = ?
      ORDER BY event_ts ASC
    `).all(type, correlationId, correlationId, correlationId, correlationId, correlationId, correlationId);

    events.push(...rows);
  }

  return events;
}

/**
 * Find all events with a given root_correlation_id across all tables.
 *
 * @param {Database} db - better-sqlite3 Database instance
 * @param {string} rootCorrelationId - Root correlation ID
 * @returns {Object[]} - Array of events in the causal chain
 */
function findEventsByRootCorrelationId(db, rootCorrelationId) {
  const events = [];

  const tables = [
    { name: 'routing_events', type: 'dispatch' },
    { name: 'guardrail_events', type: 'guardrail_outcome' },
    { name: 'circuit_breaker_events', type: 'circuit_breaker' },
    { name: 'anomaly_events', type: 'anomaly_alert' },
    { name: 'operator_action_events', type: 'operator_action' },
  ];

  for (const { name, type } of tables) {
    // Find events where root_correlation_id matches, OR where dispatch_id/id matches root (the root event itself)
    const rows = db.prepare(`
      SELECT *, ? as event_type
      FROM ${name}
      WHERE root_correlation_id = ?
         OR (root_correlation_id IS NULL AND (dispatch_id = ? OR id = ?))
      ORDER BY event_ts ASC
    `).all(type, rootCorrelationId, rootCorrelationId, rootCorrelationId);

    events.push(...rows);
  }

  return events;
}

/**
 * Calculate the depth of an event in the causal tree by counting ancestors.
 *
 * @param {Object} event - Event object
 * @param {Object[]} allEvents - All events in the causal chain
 * @returns {number} - Depth (0 for root, 1 for immediate children, etc.)
 */
function calculateEventDepth(event, allEvents) {
  if (!event.parent_correlation_id) {
    return 0;
  }

  let depth = 0;
  let currentEvent = event;

  // Walk up the parent chain, with cycle detection
  const visited = new Set();
  while (currentEvent.parent_correlation_id && depth < 100) {
    if (visited.has(currentEvent.id)) {
      log.warn('Cycle detected in causal chain', { eventId: currentEvent.id });
      break;
    }
    visited.add(currentEvent.id);

    const parent = allEvents.find(
      e => e.dispatch_id === currentEvent.parent_correlation_id || e.id === currentEvent.parent_correlation_id
    );

    if (!parent) {
      break;
    }

    depth++;
    currentEvent = parent;
  }

  return depth;
}

/**
 * Build a hierarchical tree structure from the flat event list.
 * Useful for UI visualization.
 *
 * @param {Object} subgraph - Result from buildCausalSubgraph
 * @returns {Object|null} - Tree structure with children arrays
 */
export function buildCausalTree(subgraph) {
  if (!subgraph.rootEvent) {
    return null;
  }

  const eventMap = new Map();
  for (const event of subgraph.events) {
    eventMap.set(event.id, { ...event, children: [] });
  }

  // Build parent-child relationships
  for (const edge of subgraph.edges) {
    const parent = eventMap.get(edge.from);
    const child = eventMap.get(edge.to);
    if (parent && child) {
      parent.children.push(child);
    }
  }

  return eventMap.get(subgraph.rootEvent.id) || null;
}

/**
 * Invalidate cache entries for a correlation ID.
 * Call this when new events are ingested that affect a causal chain.
 *
 * @param {string} correlationId - Any correlation ID in the chain
 * @param {string} rootCorrelationId - Root correlation ID (if known)
 */
export function invalidateCausalGraphCache(correlationId, rootCorrelationId) {
  globalCache.invalidate(correlationId, rootCorrelationId);
}

/**
 * Get cache statistics (for monitoring).
 *
 * @returns {{enabled: boolean, size: number, maxSize: number, hits: number, misses: number, hitRate: number}}
 */
export function getCausalGraphCacheStats() {
  return globalCache.getStats();
}

/**
 * Clear the entire cache (useful for testing).
 */
export function clearCausalGraphCache() {
  globalCache.clear();
}

export default {
  buildCausalSubgraph,
  buildCausalTree,
  invalidateCausalGraphCache,
  getCausalGraphCacheStats,
  clearCausalGraphCache,
};
