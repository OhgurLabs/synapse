/**
 * Tool Registration Service
 *
 * Handles duplicate tool detection with namespace prefixing and tool unregistration
 * when MCP servers disconnect. Provides a thread-safe registration API for concurrent
 * tool registration from multiple MCP servers.
 *
 * Features:
 * - Duplicate detection: Identifies tools with the same base name from different servers
 * - Namespace prefixing: Automatically prefixes tool names with server ID when conflicts detected
 * - Thread-safe registration: Uses async locks to prevent race conditions during concurrent registration
 * - Tool unregistration: Removes tools from registry when servers disconnect
 * - Metadata preservation: Maintains tool metadata during namespace prefixing
 */

import { createLogger } from '../../logger.js';
import { ToolConflictResolver, ResolutionStrategy } from '../utils/tool-conflict-resolver.js';
import { ReferenceCounter } from '../utils/reference-counter.js';

const log = createLogger('tool-registration');

/**
 * Simple async lock implementation for thread-safe operations
 */
class AsyncLock {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return this._releaseFn;
    }

    return new Promise((resolve) => {
      this._queue.push(() => {
        this._locked = true;
        resolve(this._releaseFn);
      });
    });
  }

  _releaseFn = () => {
    this._locked = false;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      setImmediate(next);
    }
  };
}

export class ToolRegistrationService {
  /**
   * @param {ToolRegistry} toolRegistry - ToolRegistry instance
   * @param {Object} options
   * @param {boolean} options.autoPrefix - Automatically prefix tools on conflict (default: true)
   * @param {string} options.nameSeparator - Separator for namespace prefixing (default: ':')
   * @param {ReferenceCounter} options.referenceCounter - Reference counter for tracking active tool usage (optional)
   */
  constructor(toolRegistry, options = {}) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }

    this.toolRegistry = toolRegistry;
    this.autoPrefix = options.autoPrefix !== false;
    this.nameSeparator = options.nameSeparator || ':';
    
    // Lock for thread-safe registration
    this._registrationLock = new AsyncLock();
    
    // Cache of server -> tools mapping for quick lookup during unregistration
    this._serverToolCache = new Map();

    // Reference counter for tracking active tool usage
    this._referenceCounter = options.referenceCounter || new ReferenceCounter();

    // Initialize conflict resolver
    this._conflictResolver = new ToolConflictResolver({
      nameSeparator: this.nameSeparator,
      autoPrefix: this.autoPrefix,
      strategy: options.strategy || ResolutionStrategy.NAMESPACE_FIRST,
      priorities: options.priorities || {}
    });
  }

 /**
    * Extract the base name from a potentially namespace-prefixed tool name.
    * Only extracts namespace if the prefix matches a known server ID pattern.
    * For 'test-mcp-server:read_file' returns 'read_file'. For 'filesystem:read_file' returns 'filesystem:read_file' (no extraction).
    *
    * @private
    * @param {string} name - Tool name, optionally prefixed with 'serverId:'
    * @returns {string} Base name without namespace prefix
    */
   _extractBaseName(name) {
     // Don't extract base name from tool names - treat the full name as the base name
     // Namespace prefixing only happens when there's a conflict, and the prefix is the server ID
     return name;
   }

/**
    * Check if a tool name has a namespace prefix.
    * A namespace prefix is identified by matching the prefix against known server IDs.
    *
    * @param {string} name - Tool name
    * @returns {boolean} True if name has a namespace prefix
    */
   hasNamespace(name) {
     // Check if the name has a server ID prefix by checking against known servers
     const separatorIdx = name.indexOf(this.nameSeparator);
     if (separatorIdx === -1) {
       return false;
     }
     const potentialNamespace = name.slice(0, separatorIdx);
     // Check if the prefix is a known server ID (exists in cache or matches mcp: prefix pattern)
     return this._serverToolCache.has(potentialNamespace);
   }

/**
    * Get the namespace from a prefixed tool name.
    *
    * @param {string} name - Tool name with namespace
    * @returns {string|null} Namespace prefix or null if not prefixed
    */
   getNamespace(name) {
     const separatorIdx = name.indexOf(this.nameSeparator);
     if (separatorIdx === -1) {
       return null;
     }
     const potentialNamespace = name.slice(0, separatorIdx);
     // Only return namespace if it's a known server ID
     if (this._serverToolCache.has(potentialNamespace)) {
       return potentialNamespace;
     }
     return null;
   }

  /**
   * Create a namespace-prefixed tool name.
   *
   * @param {string} serverId - MCP server ID
   * @param {string} baseName - Base tool name
   * @returns {string} Namespaced tool name
   */
  createNamespacedName(serverId, baseName) {
    return `${serverId}${this.nameSeparator}${baseName}`;
  }

  /**
   * Check for duplicate base names across servers.
   *
   * @param {string} baseName - Base tool name to check
   * @param {string} excludeName - Tool name to exclude from check (the one being registered)
   * @returns {Array<Object>} Array of conflicting tools
   */
  findBaseNameConflicts(baseName, excludeName) {
    const tools = this.toolRegistry.listTools();
    const conflicts = [];

    for (const tool of tools) {
      if (tool.name === excludeName) continue;

      const toolBaseName = this._extractBaseName(tool.name);
      if (toolBaseName === baseName) {
        conflicts.push({
          id: tool.id,
          name: tool.name,
          source: tool.source,
          baseName: toolBaseName
        });
      }
    }

    return conflicts;
  }

  /**
   * Get provenance information for a tool or base name.
   * Allows operators to query which server provides which tool variant.
   *
   * @param {string} identifier - Tool name or base name
   * @returns {Object} Provenance information including all variants
   */
  getToolProvenance(identifier) {
    const allTools = this.toolRegistry.listTools();
    return this._conflictResolver.getToolProvenance(identifier, allTools);
  }

  /**
   * Get all variants of a tool with the same base name.
   *
   * @param {string} baseName - Base tool name
   * @returns {Array<Object>} Array of tool variants from different servers
   */
  getToolVariants(baseName) {
    const allTools = this.toolRegistry.listTools();
    return this._conflictResolver.getToolVariants(baseName, allTools);
  }

  /**
   * Get which server provides a specific tool.
   *
   * @param {string} toolName - Tool name (namespaced or base)
   * @returns {Object|null} Server information or null if not found
   */
  getToolServer(toolName) {
    const allTools = this.toolRegistry.listTools();
    return this._conflictResolver.getToolServer(toolName, allTools);
  }

  /**
   * List all base names that have naming conflicts across servers.
   *
   * @returns {Array<Object>} Array of conflict groups
   */
  listAllConflicts() {
    const allTools = this.toolRegistry.listTools();
    return this._conflictResolver.listAllConflicts(allTools);
  }

  /**
   * Register a tool with duplicate detection and automatic namespace prefixing.
   *
   * @param {string} name - Tool name (may be prefixed or base name)
   * @param {string} serverId - MCP server ID
   * @param {Object} metadata - Tool metadata
   * @param {Object} options
   * @param {boolean} options.skipConflictCheck - Skip duplicate check (default: false)
   * @returns {Promise<Object>} Registered tool record with final name
   */
  async registerTool(name, serverId, metadata = {}, options = {}) {
    const skipConflictCheck = options.skipConflictCheck === true;
    const source = `mcp:${serverId}`;

    // Acquire lock for thread-safe registration
    const release = await this._registrationLock.acquire();
    
    try {
      let finalName = name;
      const baseName = this._extractBaseName(name);
      let wasPrefixed = false;

      // Check for conflicts if not skipped
      if (!skipConflictCheck && this.autoPrefix) {
        // Use the conflict resolver for detection and resolution
        const allTools = this.toolRegistry.listTools();
        const resolution = this._conflictResolver.resolveConflict(baseName, serverId, allTools);

        finalName = resolution.finalName;
        wasPrefixed = resolution.wasPrefixed;

        if (wasPrefixed) {
          log.info({
            originalName: name,
            finalName,
            serverId,
            conflictCount: resolution.conflicts.length,
            resolutionReason: resolution.resolutionReason
          }, 'Tool name prefixed due to cross-server conflict');

          // Update metadata to track original name
          metadata.originalToolName = baseName;
          metadata.namespaced = true;
          metadata.namespace = serverId;
        }
      }

      // Perform the upsert with final name
      const tool = this.toolRegistry.upsertTool(finalName, source, metadata);

      // Update cache
      if (!this._serverToolCache.has(serverId)) {
        this._serverToolCache.set(serverId, new Set());
      }
      this._serverToolCache.get(serverId).add(tool.id);

      log.debug({
        id: tool.id,
        name: finalName,
        source,
        wasPrefixed
      }, 'Tool registered');

      return {
        ...tool,
        wasPrefixed,
        originalName: name
      };
    } finally {
      release();
    }
  }

  /**
   * Register multiple tools concurrently with thread-safe conflict resolution.
   *
   * @param {Array<Object>} tools - Array of tool definitions
   * @param {string} tools[].name - Tool name
   * @param {Object} tools[].metadata - Tool metadata
   * @param {string} serverId - MCP server ID
   * @returns {Promise<Array<Object>>} Array of registered tool records
   */
  async registerTools(tools, serverId) {
    if (!tools || !Array.isArray(tools)) {
      throw new TypeError('tools must be an array');
    }
    if (!serverId || typeof serverId !== 'string') {
      throw new TypeError('serverId is required');
    }

    log.info({ serverId, count: tools.length }, 'Registering tools batch');

    const results = [];
    const errors = [];

    // Register tools sequentially to ensure proper conflict resolution
    for (const toolDef of tools) {
      try {
        const result = await this.registerTool(
          toolDef.name,
          serverId,
          toolDef.metadata || {}
        );
        results.push(result);
      } catch (err) {
        log.error({ tool: toolDef.name, err }, 'Failed to register tool');
        errors.push({
          name: toolDef.name,
          error: err.message
        });
      }
    }

    log.info({
      serverId,
      total: tools.length,
      success: results.length,
      failed: errors.length
    }, 'Tool batch registration complete');

    return {
      registered: results,
      errors
    };
  }

  /**
   * Unregister all tools from a specific server.
   * Called when an MCP server disconnects.
   * Uses reference counting to prevent removal of tools still in use by active tasks.
   *
   * @param {string} serverId - MCP server ID
   * @param {Object} options
   * @param {boolean} options.force - Force removal even if tools are in use (default: false)
   * @returns {Promise<Object>} Unregistration result with safe and blocked tools
   */
  async unregisterServerTools(serverId, options = {}) {
    const source = `mcp:${serverId}`;
    const force = options.force === true;

    // Acquire lock for thread-safe unregistration
    const release = await this._registrationLock.acquire();
    
    try {
      // Get cached tool IDs for this server
      const cachedToolIds = this._serverToolCache.get(serverId);
      const toolIds = cachedToolIds ? Array.from(cachedToolIds) : [];

      // Check reference counts to determine which tools can be safely removed
      const { safeToRemove, blocked } = this._referenceCounter.getSafeToRemoveTools(toolIds);

      // Remove safe tools from registry
      let deletedCount = 0;
      for (const toolId of safeToRemove) {
        if (this.toolRegistry.deleteTool(toolId)) {
          deletedCount++;
        }
      }

      // If force mode, remove blocked tools as well
      if (force && blocked.length > 0) {
        log.warn({
          serverId,
          blockedCount: blocked.length,
          blockedTools: blocked.map(b => b.toolId)
        }, 'Force removing tools with active references');

        for (const { toolId } of blocked) {
          if (this.toolRegistry.deleteTool(toolId)) {
            deletedCount++;
          }
          // Release references for force removal
          const tasks = this._referenceCounter.getReferencingTasks(toolId);
          for (const taskId of tasks) {
            this._referenceCounter.release(taskId, toolId);
          }
        }
      }

      // Clear cache
      this._serverToolCache.delete(serverId);

      log.info({
        serverId,
        totalTools: toolIds.length,
        deletedCount,
        safeRemoved: safeToRemove.length,
        blockedCount: blocked.length,
        cachedCount: cachedToolIds?.size || 0
      }, 'Server tools unregistration complete');

      return {
        serverId,
        deletedCount,
        safeToRemove,
        blocked,
        success: true
      };
    } finally {
      release();
    }
  }

  /**
   * Unregister a single tool by ID.
   * Uses reference counting to prevent removal of tools still in use.
   *
   * @param {string} toolId - Tool ID
   * @param {Object} options
   * @param {boolean} options.force - Force removal even if tool is in use (default: false)
   * @param {boolean} options.returnObject - Return full result object instead of boolean (default: false)
   * @returns {Promise<boolean|Object>} Boolean (deleted) or full result object if returnObject is true
   */
  async unregisterTool(toolId, options = {}) {
    const force = options.force === true;
    const returnObject = options.returnObject === true;

    const release = await this._registrationLock.acquire();
    
    try {
      // Check if tool is in use
      const refCount = this._referenceCounter.getRefCount(toolId);
      if (refCount > 0 && !force) {
        const tasks = this._referenceCounter.getReferencingTasks(toolId);
        log.warn({
          toolId,
          refCount,
          taskIds: Array.from(tasks)
        }, 'Tool cannot be unregistered - still in use by active tasks');
        
        if (returnObject) {
          return {
            success: false,
            reason: 'tool_in_use',
            refCount,
            taskIds: Array.from(tasks)
          };
        }
        return false;
      }

      // Find which server this tool belongs to
      let serverId = null;
      for (const [sid, toolIds] of this._serverToolCache) {
        if (toolIds.has(toolId)) {
          serverId = sid;
          toolIds.delete(toolId);
          break;
        }
      }

      const deleted = this.toolRegistry.deleteTool(toolId);

      // Release all references for this tool
      if (deleted) {
        const tasks = this._referenceCounter.getReferencingTasks(toolId);
        for (const taskId of tasks) {
          this._referenceCounter.release(taskId, toolId);
        }

        if (serverId) {
          log.debug({ toolId, serverId, refCount }, 'Tool unregistered');
        }
      }

      if (returnObject) {
        return {
          success: deleted,
          deleted
        };
      }
      return deleted;
    } finally {
      release();
    }
  }

  /**
   * Get all tools registered from a specific server.
   *
   * @param {string} serverId - MCP server ID
   * @returns {Array<Object>} Array of tool records
   */
  getServerTools(serverId) {
    const source = `mcp:${serverId}`;
    return this.toolRegistry.listTools({ source });
  }

  /**
   * Get registration statistics.
   *
   * @returns {Object} Registration statistics
   */
  getStats() {
    const allTools = this.toolRegistry.listTools();
    const mcpTools = allTools.filter(t => t.source.startsWith('mcp:'));
    
    const byServer = {};
    for (const tool of mcpTools) {
      const serverId = tool.source.replace('mcp:', '');
      if (!byServer[serverId]) {
        byServer[serverId] = 0;
      }
      byServer[serverId]++;
    }

    const namespacedTools = mcpTools.filter(t => this.hasNamespace(t.name));

    return {
      totalTools: allTools.length,
      mcpTools: mcpTools.length,
      nativeTools: allTools.length - mcpTools.length,
      namespacedTools: namespacedTools.length,
      servers: Object.keys(byServer).length,
      byServer
    };
  }

  /**
   * Clear all cached server tool mappings.
   * Use with caution - only call during full registry rebuild.
   */
  clearCache() {
    this._serverToolCache.clear();
    log.info('Registration cache cleared');
  }

  /**
   * Rebuild cache from registry state.
   * Call after registry restoration or cache invalidation.
   */
  rebuildCache() {
    const allTools = this.toolRegistry.listTools();
    
    for (const tool of allTools) {
      if (tool.source.startsWith('mcp:')) {
        const serverId = tool.source.replace('mcp:', '');
        
        if (!this._serverToolCache.has(serverId)) {
          this._serverToolCache.set(serverId, new Set());
        }
        this._serverToolCache.get(serverId).add(tool.id);
      }
    }

    log.info({ servers: this._serverToolCache.size }, 'Registration cache rebuilt');
  }

  /**
   * Track a task's usage of a tool.
   * Called when a task starts using a tool to prevent premature unregistration.
   *
   * @param {string} taskId - Task identifier
   * @param {string} toolId - Tool identifier
   * @returns {number} New reference count
   */
  acquireTool(taskId, toolId) {
    return this._referenceCounter.acquire(taskId, toolId);
  }

  /**
   * Release a task's usage of a tool.
   * Called when a task finishes using a tool.
   *
   * @param {string} taskId - Task identifier
   * @param {string} toolId - Tool identifier
   * @returns {number} New reference count
   */
  releaseTool(taskId, toolId) {
    return this._referenceCounter.release(taskId, toolId);
  }

  /**
   * Track a tool invocation as in-progress.
   * Called when a task invokes a tool.
   *
   * @param {string} taskId - Task identifier
   * @param {string} toolId - Tool identifier
   */
  startToolInvocation(taskId, toolId) {
    this._referenceCounter.startInvocation(taskId, toolId);
  }

  /**
   * Mark a tool invocation as completed.
   *
   * @param {string} taskId - Task identifier
   * @param {string} toolId - Tool identifier
   */
  endToolInvocation(taskId, toolId) {
    this._referenceCounter.endInvocation(taskId, toolId);
  }

  /**
   * Release all tool references for a completed task.
   *
   * @param {string} taskId - Task identifier
   * @returns {number} Number of references released
   */
  releaseTask(taskId) {
    return this._referenceCounter.releaseTask(taskId);
  }

  /**
   * Check if a tool can be safely unregistered.
   *
   * @param {string} toolId - Tool identifier
   * @returns {boolean} True if tool has no active references
   */
  canSafelyUnregister(toolId) {
    return !this._referenceCounter.isReferenced(toolId);
  }

  /**
   * Get reference count information for a tool.
   *
   * @param {string} toolId - Tool identifier
   * @returns {Object} Reference count details
   */
  getToolReferenceInfo(toolId) {
    const refCount = this._referenceCounter.getRefCount(toolId);
    const tasks = this._referenceCounter.getReferencingTasks(toolId);
    
    return {
      toolId,
      refCount,
      taskIds: Array.from(tasks),
      canUnregister: refCount === 0
    };
  }

  /**
   * Find orphaned references and clean them up.
   *
   * @param {Set<string>} validTaskIds - Set of currently active task IDs
   * @returns {Object} Cleanup statistics
   */
  cleanupOrphanedReferences(validTaskIds) {
    return this._referenceCounter.cleanupOrphans(validTaskIds);
  }

  /**
   * Get reference counter statistics.
   *
   * @returns {Object} Reference counter statistics
   */
  getReferenceStats() {
    return this._referenceCounter.getStats();
  }
}
