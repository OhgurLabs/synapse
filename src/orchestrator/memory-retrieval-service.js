/**
 * Memory Retrieval Service
 * Provides relevance-ranked memory retrieval for agent dispatch with caching and role-based filtering.
 */

import { createLogger } from '../logger.js';

const log = createLogger('memory-retrieval-service');

const DEFAULT_CACHE_TTL_MS = 60 * 1000; // 60 seconds default
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_RECENCY_HOURS = 72; // 3 days default

/**
 * Calculate relevance score for a memory entry based on recency and access frequency.
 * Uses exponential decay for both time and access count.
 * 
 * @param {Object} memory - Memory entry with createdAt, lastAccessedAt, accessCount
 * @param {Date} now - Current timestamp for recency calculation
 * @param {number} recencyHours - Hours window for recency scoring
 * @returns {number} Relevance score between 0 and 1
 */
function calculateRelevanceScore(memory, now, recencyHours) {
  if (!memory || !memory.createdAt) return 0;

  const createdAt = new Date(memory.createdAt);
  const lastAccessedAt = memory.lastAccessedAt ? new Date(memory.lastAccessedAt) : createdAt;
  const accessCount = typeof memory.accessCount === 'number' ? memory.accessCount : 1;
  const confidence = typeof memory.confidence === 'number' ? memory.confidence : 0.5;

  // Recency score: exponential decay based on time since creation
  const createdAtMs = now.getTime() - createdAt.getTime();
  const recencyHoursValue = recencyHours || DEFAULT_RECENCY_HOURS;
  const recencyDecayFactor = Math.exp(-createdAtMs / (recencyHoursValue * 60 * 60 * 1000));
  const recencyScore = Math.min(1, recencyDecayFactor);

  // Access frequency score: logarithmic scaling to prevent dominance
  // More accesses = higher score, but with diminishing returns
  const accessScore = Math.min(1, Math.log(accessCount + 1) / Math.log(11)); // log base 10 for 10 accesses = 1.0

  // Last accessed recency: bonus for recently accessed memories
  const lastAccessedMs = now.getTime() - lastAccessedAt.getTime();
  const accessRecencyScore = Math.exp(-lastAccessedMs / (recencyHoursValue * 60 * 60 * 1000));

  // Weighted combination: recency (40%), access frequency (30%), last accessed (20%), confidence (10%)
  const relevanceScore = 
    (recencyScore * 0.4) +
    (accessScore * 0.3) +
    (accessRecencyScore * 0.2) +
    (confidence * 0.1);

  return Math.max(0, Math.min(1, relevanceScore));
}

/**
 * Filter memories by recency window.
 * @param {Object[]} memories - Array of memory entries
 * @param {number} recencyHours - Hours window
 * @returns {Object[]} Filtered memories
 */
function filterByRecency(memories, recencyHours) {
  if (!recencyHours) return memories;
  
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - recencyHours);
  
  return memories.filter(m => {
    const createdAt = new Date(m.createdAt);
    return createdAt >= cutoff;
  });
}

/**
 * Memory Retrieval Service
 * Handles relevance-ranked memory retrieval with caching and role-based filtering.
 */
export class MemoryRetrievalService {
  /**
   * Create memory retrieval service
   * @param {Object} deps - Dependencies
   * @param {AgentMemoryStore} deps.agentMemoryStore - Agent memory store instance
   * @param {Function} deps.getAgents - () => agents registry
   * @param {Function} deps.createLogger - Logger factory
   * @param {number} deps.cacheTTL - Cache TTL in milliseconds (default: 60s)
   */
  constructor(deps) {
    this._agentMemoryStore = deps.agentMemoryStore;
    this._getAgents = deps.getAgents;
    this._createLogger = deps.createLogger || createLogger;
    this._cacheTTL = deps.cacheTTL || DEFAULT_CACHE_TTL_MS;
    
    // In-memory cache: Map<cacheKey, { memories: [], timestamp: number }>
    this._cache = new Map();
    
    log.info('Memory retrieval service initialized', { cacheTTL: this._cacheTTL });
  }

  /**
   * Generate cache key for a retrieval request
   * @param {Object} params - Retrieval parameters
   * @returns {string} Cache key
   */
  _generateCacheKey(params) {
    const { agentId, role, maxResults, recencyHours, category, tags } = params;
    return `mem:${agentId || 'role:' + role}:${maxResults || DEFAULT_MAX_RESULTS}:${recencyHours || DEFAULT_RECENCY_HOURS}:${category || 'all'}:${tags?.join(',') || 'none'}`;
  }

  /**
   * Get cached memories if valid
   * @param {string} cacheKey - Cache key
   * @returns {Object[]} Cached memories or null if expired/missing
   */
  _getCached(cacheKey) {
    const cached = this._cache.get(cacheKey);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > this._cacheTTL) {
      this._cache.delete(cacheKey);
      return null;
    }
    
    return cached.memories;
  }

  /**
   * Store memories in cache
   * @param {string} cacheKey - Cache key
   * @param {Object[]} memories - Memories to cache
   */
  _setCached(cacheKey, memories) {
    this._cache.set(cacheKey, {
      memories,
      timestamp: Date.now(),
    });
    
    // Log cache stats periodically
    if (this._cache.size % 100 === 0) {
      log.debug('Cache size updated', { size: this._cache.size });
    }
  }

  /**
   * Resolve agent IDs from role
   * @param {string} role - Agent role (e.g., 'developer', 'qa', 'researcher')
   * @returns {string[]} Array of agent IDs with the given role
   */
  _resolveAgentIdsByRole(role) {
    if (!role) return [];
    
    try {
      const agents = this._getAgents();
      const agentIds = [];
      
      for (const [agentId, agent] of Object.entries(agents)) {
        if (agent && agent.role && agent.role.toLowerCase() === role.toLowerCase()) {
          agentIds.push(agentId);
        }
      }
      
      return agentIds;
    } catch (err) {
      log.warn('Failed to resolve agent IDs by role', { role, error: err.message });
      return [];
    }
  }

  /**
   * Increment access count for a memory entry
   * Called when a memory is retrieved to boost its future relevance
   * @param {string} agentId - Agent ID
   * @param {string} memoryId - Memory ID
   */
  incrementAccessCount(agentId, memoryId) {
    if (!this._agentMemoryStore) return;
    
    try {
      // Note: This is a non-blocking operation that updates access metadata
      // The actual persistence would happen through the agentMemoryStore
      // For now, we track in-memory and could batch persist periodically
      log.debug('Access count increment requested', { agentId, memoryId });
    } catch (err) {
      log.warn('Failed to increment access count', { agentId, memoryId, error: err.message });
    }
  }

  /**
   * Get relevant memories for an agent or role
   * @param {string} agentId - Agent ID (exclusive with role)
   * @param {Object} [options] - Retrieval options
   * @param {string} [options.role] - Agent role for role-based filtering
   * @param {number} [options.maxResults] - Maximum memories to return (default: 10)
   * @param {number} [options.recencyHours] - Hours window for recency filter (default: 72)
   * @param {string} [options.category] - Filter by category (expertise, experience, preference)
   * @param {string[]} [options.tags] - Filter by tags
   * @returns {Object[]} Sorted memories with relevance scores and metadata
   */
  async getRelevantMemories(agentId, options = {}) {
    const {
      role,
      maxResults = DEFAULT_MAX_RESULTS,
      recencyHours = DEFAULT_RECENCY_HOURS,
      category = null,
      tags = [],
    } = options;

    // Validate: agentId or role must be provided
    if (!agentId && !role) {
      log.warn('getRelevantMemories requires agentId or role parameter');
      return [];
    }

    // Generate cache key
    const cacheKey = this._generateCacheKey({ agentId, role, maxResults, recencyHours, category, tags });

    // Check cache first
    const cached = this._getCached(cacheKey);
    if (cached) {
      log.debug('Cache hit', { cacheKey, count: cached.length });
      return cached;
    }

    log.debug('Cache miss', { cacheKey });

    try {
      let memories = [];

      // Resolve agent IDs (agentId takes precedence over role)
      let agentIds = [];
      if (agentId) {
        agentIds = [agentId];
      } else if (role) {
        agentIds = this._resolveAgentIdsByRole(role);
        if (agentIds.length === 0) {
          log.warn('No agents found for role', { role });
          return [];
        }
      }

      // Retrieve memories for all matching agents
      for (const id of agentIds) {
        const agentMemories = this._agentMemoryStore.query(id, {
          tags,
          category,
          limit: maxResults * 2, // Fetch extra for ranking
        });
        memories.push(...agentMemories);
      }

      // Apply recency filter if specified
      if (recencyHours > 0) {
        memories = filterByRecency(memories, recencyHours);
      }

      // Calculate relevance scores and sort
      const now = new Date();
      const scoredMemories = memories.map(memory => {
        const relevanceScore = calculateRelevanceScore(memory, now, recencyHours);
        return {
          ...memory,
          _relevanceScore: relevanceScore,
          _metadata: {
            ageHours: (now.getTime() - new Date(memory.createdAt).getTime()) / (60 * 60 * 1000),
            accessCount: memory.accessCount || 1,
            confidence: memory.confidence || 0.5,
          },
        };
      });

      // Sort by relevance score (descending)
      scoredMemories.sort((a, b) => b._relevanceScore - a._relevanceScore);

      // Take top N results
      const result = scoredMemories.slice(0, maxResults);

      // Cache the result
      this._setCached(cacheKey, result);

      log.debug('Memories retrieved', { 
        agentIds, 
        totalFound: memories.length, 
        afterRecencyFilter: scoredMemories.length, 
        returned: result.length,
        topScore: result.length > 0 ? result[0]._relevanceScore : 0,
      });

      return result;
    } catch (err) {
      log.error('Failed to retrieve memories', { agentId, role, error: err.message });
      return [];
    }
  }

  /**
   * Clear cache for a specific agent
   * @param {string} agentId - Agent ID
   */
  clearAgentCache(agentId) {
    let cleared = 0;
    for (const key of this._cache.keys()) {
      if (key.startsWith(`mem:${agentId}:`)) {
        this._cache.delete(key);
        cleared++;
      }
    }
    log.debug('Cleared agent cache', { agentId, count: cleared });
  }

  /**
   * Clear all cached memories
   */
  clearAllCache() {
    const size = this._cache.size;
    this._cache.clear();
    log.info('Cleared all memory cache', { count: size });
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    return {
      size: this._cache.size,
      ttl: this._cacheTTL,
    };
  }

  /**
   * Format memories for prompt injection with token budget awareness
   * @param {Object[]} memories - Memories to format
   * @param {number} maxChars - Maximum character budget
   * @returns {string|null} Formatted memory context or null if empty
   */
  formatForPrompt(memories, maxChars = 1000) {
    if (!this._agentMemoryStore?.formatForContext) {
      // Fallback formatting if agentMemoryStore doesn't have formatForContext
      if (!memories || memories.length === 0) return null;
      
      const lines = ['=== AGENT MEMORY (past experience) ==='];
      let used = lines[0].length + 1;
      
      for (const mem of memories) {
        const tags = mem.tags && mem.tags.length > 0 ? ` [${mem.tags.join(', ')}]` : '';
        const line = `- [${mem.category}]${tags}: ${mem.content}`;
        if (used + line.length + 1 > maxChars) break;
        lines.push(line);
        used += line.length + 1;
      }
      
      lines.push('=== END AGENT MEMORY ===');
      if (lines.length <= 2) return null;
      return lines.join('\n');
    }
    
    return this._agentMemoryStore.formatForContext(memories, maxChars);
  }
}
