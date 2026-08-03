import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * ToolCache - Local cache for MCP tool metadata with offline mode support.
 *
 * Features:
 * - TTL-based expiration with configurable time-to-live
 * - LRU eviction when cache reaches capacity
 * - Per-server tool tracking for multi-server support
 * - Disk persistence for offline mode resilience
 * - Cache statistics and hit/miss tracking
 * - Version-based invalidation for schema updates
 *
 * Cache Data Structures:
 * - cache: Map<cacheKey, CachedToolEntry>
 *   - cacheKey: "${serverId}::${toolName}"
 *   - CachedToolEntry: { tool, serverId, version, cachedAt, expiresAt, ttl, accessCount, lastAccessed }
 * - serverStates: Map<serverId, ServerCacheState>
 *   - ServerCacheState: { serverId, connected, lastSeen, toolCount, schemaVersion, tools: Map<toolName, CachedToolEntry> }
 *
 * Invalidation Strategy:
 * 1. TTL-based: Entries expire after configured time-to-live (default 5 minutes)
 * 2. Server reconnection: invalidateServer() clears all tools from a server when it reconnects
 * 3. Version-based: When schemaVersion changes, all tools from that server are invalidated
 * 4. LRU eviction: When cache reaches maxEntries, least recently used entries are evicted
 * 5. Manual: clear() for full cache reset, clearExpired() for cleanup
 */
export class ToolCache {
  /**
   * @param {Object} config - Cache configuration
   * @param {number} [config.defaultTTL=300000] - Default TTL in milliseconds (5 minutes)
   * @param {number} [config.maxEntries=1000] - Maximum entries before LRU eviction
   * @param {boolean} [config.persistenceEnabled=false] - Enable disk persistence for offline mode
   * @param {string} [config.persistencePath] - Path to cache file
   */
  constructor(config = {}) {
    this.defaultTTL = config.defaultTTL ?? 300000;
    this.maxEntries = config.maxEntries ?? 1000;
    this.persistenceEnabled = config.persistenceEnabled ?? false;
    this.persistencePath = config.persistencePath ?? join(__dirname, '.tool-cache.json');
    
    // Core cache: cacheKey -> CachedToolEntry
    this.cache = new Map();
    
    // Server state tracking: serverId -> ServerCacheState
    this.serverStates = new Map();
    
    // Statistics
    this.totalHits = 0;
    this.totalMisses = 0;

    // Load persisted cache if enabled
    if (this.persistenceEnabled && this._fileExists(this.persistencePath)) {
      this._loadFromDisk();
    }
  }

  /**
   * Check if file exists.
   * @private
   * @param {string} path - File path
   * @returns {boolean} True if file exists
   */
  _fileExists(path) {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }

  /**
   * Load cache from disk persistence.
   * @private
   */
  _loadFromDisk() {
    try {
      const data = readFileSync(this.persistencePath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Restore cache entries
      for (const [key, entry] of Object.entries(parsed.cache || {})) {
        const cachedEntry = {
          tool: entry.tool,
          serverId: entry.serverId,
          version: entry.version || '',
          cachedAt: entry.cachedAt,
          expiresAt: entry.expiresAt,
          ttl: entry.ttl,
          accessCount: entry.accessCount || 0,
          lastAccessed: entry.lastAccessed || entry.cachedAt
        };
        
        // Check if entry is still valid
        if (Date.now() < cachedEntry.expiresAt) {
          this.cache.set(key, cachedEntry);
        }
      }

      // Restore server states
      for (const [serverId, state] of Object.entries(parsed.serverStates || {})) {
        const toolsMap = new Map(Object.entries(state.tools || {}));
        this.serverStates.set(serverId, {
          serverId,
          connected: false, // Reset connection state on reload
          lastSeen: state.lastSeen,
          toolCount: state.toolCount,
          schemaVersion: state.schemaVersion,
          tools: toolsMap
        });
      }

      console.debug(`Cache loaded from disk: ${this.cache.size} entries, ${this.serverStates.size} servers`);
    } catch (err) {
      console.warn(`Failed to load cache from disk: ${err.message}`);
    }
  }

  /**
   * Persist cache to disk.
   * @private
   */
  _saveToDisk() {
    if (!this.persistenceEnabled) return;

    try {
      const cacheObj = {};
      for (const [key, entry] of this.cache.entries()) {
        cacheObj[key] = entry;
      }

      const serverStatesObj = {};
      for (const [serverId, state] of this.serverStates.entries()) {
        serverStatesObj[serverId] = {
          ...state,
          tools: Object.fromEntries(state.tools)
        };
      }

      const data = JSON.stringify({
        cache: cacheObj,
        serverStates: serverStatesObj,
        savedAt: Date.now()
      }, null, 2);

      writeFileSync(this.persistencePath, data, 'utf8');
    } catch (err) {
      console.warn(`Failed to persist cache to disk: ${err.message}`);
    }
  }

  /**
   * Generate cache key for a tool from a specific server.
   * @private
   * @param {string} serverId - MCP server ID
   * @param {string} toolName - Tool name
   * @returns {string} Cache key
   */
  _getCacheKey(serverId, toolName) {
    return `${serverId}::${toolName}`;
  }

  /**
   * Evict least recently used entries when cache is full.
   * @private
   */
  _evictLRU() {
    if (this.cache.size < this.maxEntries) return;

    let minAccess = Infinity;
    let minKey = null;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < minAccess) {
        minAccess = entry.lastAccessed;
        minKey = key;
      }
    }

    if (minKey) {
      this.cache.delete(minKey);
      console.debug(`LRU eviction: removed ${minKey}`);
    }
  }

  /**
   * Cache a tool from a specific server.
   * @param {string} serverId - MCP server ID
   * @param {Object} tool - Tool schema
   * @param {string} [version] - Optional version string for invalidation
   * @param {number} [ttl] - Optional TTL override in milliseconds
   */
  set(serverId, tool, version, ttl) {
    const key = this._getCacheKey(serverId, tool.name);
    const now = Date.now();
    const effectiveTTL = ttl ?? this.defaultTTL;

    const entry = {
      tool,
      serverId,
      version: version || '',
      cachedAt: now,
      expiresAt: now + effectiveTTL,
      ttl: effectiveTTL,
      accessCount: 0,
      lastAccessed: now
    };

    this._evictLRU();
    this.cache.set(key, entry);

    // Update server state
    if (!this.serverStates.has(serverId)) {
      this.serverStates.set(serverId, {
        serverId,
        connected: true,
        lastSeen: now,
        toolCount: 0,
        tools: new Map()
      });
    }
    
    const serverState = this.serverStates.get(serverId);
    serverState.tools.set(tool.name, entry);
    serverState.toolCount = serverState.tools.size;
    serverState.connected = true;
    serverState.lastSeen = now;

    // Persist if enabled
    if (this.persistenceEnabled) {
      this._saveToDisk();
    }
  }

  /**
   * Cache multiple tools from a server.
   * @param {string} serverId - MCP server ID
   * @param {Array<Object>} tools - Array of tool schemas
   * @param {string} [schemaVersion] - Optional overall schema version
   * @param {number} [ttl] - Optional TTL override
   */
  setMany(serverId, tools, schemaVersion, ttl) {
    // Clear existing tools from this server first (for invalidation)
    this.invalidateServer(serverId);

    for (const tool of tools) {
      this.set(serverId, tool, schemaVersion, ttl);
    }
  }

  /**
   * Get a cached tool by server and name.
   * @param {string} serverId - MCP server ID
   * @param {string} toolName - Tool name
   * @returns {Object|undefined} Cached tool or undefined if not found/expired
   */
  get(serverId, toolName) {
    const key = this._getCacheKey(serverId, toolName);
    const entry = this.cache.get(key);

    if (!entry) {
      this.totalMisses++;
      return undefined;
    }

    // Check expiration
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      this.totalMisses++;
      return undefined;
    }

    // Update access stats
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.totalHits++;

    return entry.tool;
  }

  /**
   * Check if a tool is cached without updating access stats.
   * @param {string} serverId - MCP server ID
   * @param {string} toolName - Tool name
   * @returns {boolean} True if cached and valid
   */
  has(serverId, toolName) {
    const key = this._getCacheKey(serverId, toolName);
    const entry = this.cache.get(key);

    if (!entry) return false;
    return Date.now() < entry.expiresAt;
  }

  /**
   * Delete a specific tool from cache.
   * @param {string} serverId - MCP server ID
   * @param {string} toolName - Tool name
   * @returns {boolean} True if deleted
   */
  delete(serverId, toolName) {
    const key = this._getCacheKey(serverId, toolName);
    const deleted = this.cache.delete(key);

    // Update server state
    const serverState = this.serverStates.get(serverId);
    if (serverState) {
      serverState.tools.delete(toolName);
      serverState.toolCount = serverState.tools.size;
    }

    if (this.persistenceEnabled && deleted) {
      this._saveToDisk();
    }

    return deleted;
  }

  /**
   * Invalidate all tools from a specific server.
   * Called when server reconnects with updated schema.
   * @param {string} serverId - MCP server ID
   * @returns {number} Number of entries invalidated
   */
  invalidateServer(serverId) {
    let count = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.serverId === serverId) {
        this.cache.delete(key);
        count++;
      }
    }

    // Clear server state but keep the entry
    const serverState = this.serverStates.get(serverId);
    if (serverState) {
      serverState.tools.clear();
      serverState.toolCount = 0;
    }

    if (this.persistenceEnabled && count > 0) {
      this._saveToDisk();
    }

    console.debug(`Invalidated ${count} entries for server ${serverId}`);
    return count;
  }

  /**
   * Get all tools from a specific server (cached).
   * @param {string} serverId - MCP server ID
   * @returns {Array<Object>} Array of cached tools
   */
  getServerTools(serverId) {
    const tools = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.serverId === serverId && Date.now() < entry.expiresAt) {
        tools.push(entry.tool);
      }
    }

    return tools;
  }

  /**
   * Get all cached tools across all servers.
   * @returns {Array<Object>} Array of all cached tools
   */
  getAllTools() {
    const tools = [];
    const now = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (now < entry.expiresAt) {
        tools.push(entry.tool);
      }
    }

    return tools;
  }

  /**
   * Get tools available in offline mode (cached tools).
   * @param {string} [serverId] - Optional server filter
   * @returns {Array<Object>} Array of cached tools
   */
  getOfflineTools(serverId) {
    if (serverId) {
      return this.getServerTools(serverId);
    }
    return this.getAllTools();
  }

  /**
   * Mark a server as connected.
   * @param {string} serverId - MCP server ID
   */
  markServerConnected(serverId) {
    const now = Date.now();
    
    if (!this.serverStates.has(serverId)) {
      this.serverStates.set(serverId, {
        serverId,
        connected: true,
        lastSeen: now,
        toolCount: 0,
        tools: new Map()
      });
    } else {
      const state = this.serverStates.get(serverId);
      state.connected = true;
      state.lastSeen = now;
    }
  }

  /**
   * Mark a server as disconnected.
   * @param {string} serverId - MCP server ID
   */
  markServerDisconnected(serverId) {
    const state = this.serverStates.get(serverId);
    if (state) {
      state.connected = false;
    }
  }

  /**
   * Check if a server is currently connected.
   * @param {string} serverId - MCP server ID
   * @returns {boolean} True if connected
   */
  isServerConnected(serverId) {
    const state = this.serverStates.get(serverId);
    return state?.connected ?? false;
  }

  /**
   * Get server cache state.
   * @param {string} serverId - MCP server ID
   * @returns {Object|undefined} Server state or undefined
   */
  getServerState(serverId) {
    return this.serverStates.get(serverId);
  }

  /**
   * Get cache statistics.
   * @returns {Object} Cache statistics
   */
  getStats() {
    const now = Date.now();
    let activeEntries = 0;
    let expiredEntries = 0;

    for (const [, entry] of this.cache.entries()) {
      if (now < entry.expiresAt) {
        activeEntries++;
      } else {
        expiredEntries++;
      }
    }

    const totalRequests = this.totalHits + this.totalMisses;

    return {
      totalEntries: this.cache.size,
      activeEntries,
      expiredEntries,
      serversCached: this.serverStates.size,
      hitRate: totalRequests > 0 ? this.totalHits / totalRequests : 0,
      missRate: totalRequests > 0 ? this.totalMisses / totalRequests : 0,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses
    };
  }

  /**
   * Clear all cache entries.
   */
  clear() {
    this.cache.clear();
    this.serverStates.clear();
    
    if (this.persistenceEnabled) {
      try {
        unlinkSync(this.persistencePath);
      } catch {
        // File may not exist
      }
    }
  }

  /**
   * Clear expired entries.
   * @returns {number} Number of entries cleared
   */
  clearExpired() {
    const now = Date.now();
    let count = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
        count++;
      }
    }

    if (count > 0 && this.persistenceEnabled) {
      this._saveToDisk();
    }

    return count;
  }

  /**
   * Check if cache has any tools for offline mode.
   * @param {string} [serverId] - Optional server filter
   * @returns {boolean} True if tools are available offline
   */
  hasOfflineTools(serverId) {
    if (serverId) {
      const state = this.serverStates.get(serverId);
      return (state?.tools.size ?? 0) > 0;
    }
    return this.getAllTools().length > 0;
  }
}

// Singleton instance with default configuration
export const toolCache = new ToolCache();
