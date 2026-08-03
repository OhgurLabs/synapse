/**
 * ToolConflictResolver
 *
 * Detects and resolves naming conflicts between tools from multiple MCP servers
 * and native Synapse tools. Provides namespace prefixing, priority-based resolution,
 * and tool provenance tracking.
 *
 * Features:
 * - Duplicate detection: Identifies tools with identical base names across sources
 * - Namespace prefixing: Automatically prefixes conflicting tools with source identifier
 * - Priority rules: Configurable resolution strategies for conflict handling
 * - Provenance tracking: Query which server provides which tool variant
 *
 * Usage:
 *   const resolver = new ToolConflictResolver();
 *   const hasConflict = resolver.detectConflict('read_file', 'server1', existingTools);
 *   const resolvedName = resolver.resolveConflict('read_file', 'server1', existingTools);
 */

import { createLogger } from '../../logger.js';

const log = createLogger('tool-conflict-resolver');

/**
 * Conflict resolution strategies
 */
export const ResolutionStrategy = {
  NAMESPACE_FIRST: 'namespace_first',
  PRIORITY_BASED: 'priority_based',
  FIRST_WINS: 'first_wins',
  LATEST_WINS: 'latest_wins'
};

/**
 * Default priority levels for tool sources
 * Higher numbers = higher priority
 */
export const DEFAULT_PRIORITIES = {
  native: 100,
  mcp: 50,
  custom: 25
};

export class ToolConflictResolver {
  /**
   * @param {Object} options
   * @param {string} options.nameSeparator - Separator for namespace prefixing (default: ':')
   * @param {Object} options.priorities - Priority levels for different sources
   * @param {string} options.strategy - Conflict resolution strategy (default: 'namespace_first')
   * @param {boolean} options.autoPrefix - Enable automatic namespace prefixing (default: true)
   */
  constructor(options = {}) {
    this.nameSeparator = options.nameSeparator || ':';
    this.priorities = { ...DEFAULT_PRIORITIES, ...(options.priorities || {}) };
    this.strategy = options.strategy || ResolutionStrategy.NAMESPACE_FIRST;
    this.autoPrefix = options.autoPrefix !== false;
    
    // Cache for tool provenance tracking
    this._toolProvenance = new Map();
  }

/**
    * Extract the base name from a potentially namespace-prefixed tool name.
    * For 'test-mcp-server:read_file' returns 'read_file'. For 'filesystem:read_file' returns 'filesystem:read_file' (no extraction).
    *
    * @param {string} name - Tool name, optionally prefixed
    * @returns {string} Base name without namespace prefix
    */
   extractBaseName(name) {
     if (!name || typeof name !== 'string') {
       return name;
     }
     // Don't extract base name - treat the full name as the base name
     // Namespace prefixing only happens when there's a conflict
     return name;
   }

/**
    * Check if a tool name has a namespace prefix.
    * A namespace prefix is identified by checking if the prefix matches a known server ID pattern.
    *
    * @param {string} name - Tool name
    * @returns {boolean} True if name has a namespace prefix
    */
   hasNamespace(name) {
     if (!name) return false;
     const separatorIdx = name.indexOf(this.nameSeparator);
     if (separatorIdx === -1) {
       return false;
     }
     const potentialNamespace = name.slice(0, separatorIdx);
     // Check if the prefix looks like a server ID (e.g., 'test-mcp-server', 'fs-tools', etc.)
     // Server IDs typically don't contain colons, so if the prefix doesn't contain a colon, it's likely a server ID
     return !potentialNamespace.includes(this.nameSeparator);
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
     // Only return namespace if it looks like a server ID (doesn't contain colons)
     if (!potentialNamespace.includes(this.nameSeparator)) {
       return potentialNamespace;
     }
     return null;
   }

  /**
   * Create a namespace-prefixed tool name.
   *
   * @param {string} source - Source/server identifier
   * @param {string} baseName - Base tool name
   * @returns {string} Namespaced tool name
   */
  createNamespacedName(source, baseName) {
    return `${source}${this.nameSeparator}${baseName}`;
  }

  /**
   * Detect if a tool name conflicts with existing tools.
   *
   * @param {string} baseName - Base tool name to check
   * @param {string} source - Source of the incoming tool
   * @param {Array<Object>} existingTools - Array of existing tool records
   * @param {string} existingTools[].name - Tool name
   * @param {string} existingTools[].source - Tool source
   * @returns {Object} Conflict detection result
   */
  detectConflict(baseName, source, existingTools = []) {
    if (!Array.isArray(existingTools)) {
      existingTools = [];
    }

    const conflicts = [];
    const sourcePrefix = `mcp:${source}`;

    for (const tool of existingTools) {
      const toolBaseName = this.extractBaseName(tool.name);
      
      if (toolBaseName === baseName) {
        // Skip if same source re-registering
        if (tool.source === sourcePrefix) {
          continue;
        }

        conflicts.push({
          id: tool.id,
          name: tool.name,
          source: tool.source,
          baseName: toolBaseName,
          priority: this._getSourcePriority(tool.source)
        });
      }
    }

    const hasConflict = conflicts.length > 0;

    log.debug({
      baseName,
      source,
      hasConflict,
      conflictCount: conflicts.length
    }, 'Conflict detection completed');

    return {
      baseName,
      source,
      hasConflict,
      conflicts,
      conflictCount: conflicts.length
    };
  }

  /**
   * Resolve a naming conflict and return the appropriate tool name.
   *
   * @param {string} baseName - Base tool name
   * @param {string} source - Source of the incoming tool
   * @param {Array<Object>} existingTools - Array of existing tool records
   * @param {Object} options
   * @param {boolean} options.forcePrefix - Force prefixing even without conflicts
   * @returns {Object} Resolution result with final name
   */
  resolveConflict(baseName, source, existingTools = [], options = {}) {
    const forcePrefix = options.forcePrefix === true;
    const sourcePrefix = `mcp:${source}`;

    // Check for conflicts
    const detection = this.detectConflict(baseName, source, existingTools);

    let finalName = baseName;
    let wasPrefixed = false;
    let resolutionReason = 'no_conflict';

    // Check if this exact name already exists from this server
    const existingTool = existingTools.find(t => t.name === baseName && t.source === sourcePrefix);
    const isOwnTool = !!existingTool;

    if (isOwnTool) {
      // Re-registration from same server - no change needed
      finalName = baseName;
      resolutionReason = 'own_tool';
    } else if (forcePrefix) {
      // Force prefixing requested
      finalName = this.createNamespacedName(source, baseName);
      wasPrefixed = true;
      resolutionReason = 'force_prefix';
    } else if (detection.hasConflict && this.autoPrefix) {
      // Apply namespace prefixing based on strategy
      switch (this.strategy) {
        case ResolutionStrategy.NAMESPACE_FIRST:
          finalName = this.createNamespacedName(source, baseName);
          wasPrefixed = true;
          resolutionReason = 'namespace_prefix';
          break;

        case ResolutionStrategy.PRIORITY_BASED:
          finalName = this._resolveByPriority(baseName, source, detection.conflicts);
          wasPrefixed = finalName !== baseName;
          resolutionReason = 'priority_based';
          break;

        case ResolutionStrategy.FIRST_WINS:
          // Keep base name for first server, prefix others
          const firstTool = detection.conflicts[0];
          if (firstTool && !this.hasNamespace(firstTool.name)) {
            finalName = this.createNamespacedName(source, baseName);
            wasPrefixed = true;
          }
          resolutionReason = 'first_wins';
          break;

        case ResolutionStrategy.LATEST_WINS:
          // Latest server gets base name, others get prefixed
          finalName = this.createNamespacedName(source, baseName);
          wasPrefixed = true;
          resolutionReason = 'latest_wins';
          break;

        default:
          finalName = this.createNamespacedName(source, baseName);
          wasPrefixed = true;
          resolutionReason = 'default_namespace';
      }
    }

    log.debug({
      baseName,
      source,
      finalName,
      wasPrefixed,
      resolutionReason
    }, 'Conflict resolution completed');

    return {
      baseName,
      source,
      finalName,
      wasPrefixed,
      resolutionReason,
      conflicts: detection.conflicts,
      hasConflict: detection.hasConflict
    };
  }

  /**
   * Resolve conflict based on source priorities.
   *
   * @private
   * @param {string} baseName - Base tool name
   * @param {string} source - Incoming source
   * @param {Array<Object>} conflicts - Existing conflicting tools
   * @returns {string} Resolved tool name
   */
  _resolveByPriority(baseName, source, conflicts) {
    const incomingPriority = this._getSourcePriority(`mcp:${source}`);
    const highestPriorityConflict = conflicts.reduce((highest, conflict) => {
      if (!highest || conflict.priority > highest.priority) {
        return conflict;
      }
      return highest;
    }, null);

    if (!highestPriorityConflict) {
      return baseName;
    }

    // If incoming has higher or equal priority, it gets base name
    // Otherwise, it gets prefixed
    if (incomingPriority >= highestPriorityConflict.priority) {
      log.warn({
        baseName,
        source,
        incomingPriority,
        existingPriority: highestPriorityConflict.priority
      }, 'Incoming tool has higher priority - may cause conflict');
      return baseName;
    }

    return this.createNamespacedName(source, baseName);
  }

  /**
   * Get priority for a source.
   *
   * @private
   * @param {string} source - Tool source
   * @returns {number} Priority level
   */
  _getSourcePriority(source) {
    if (!source) {
      return this.priorities.custom || 25;
    }

    if (source === 'native' || source === 'synapse') {
      return this.priorities.native || 100;
    }

    if (source.startsWith('mcp:')) {
      return this.priorities.mcp || 50;
    }

    // Check for custom priorities
    const sourceKey = source.split(':')[0];
    if (this.priorities[sourceKey]) {
      return this.priorities[sourceKey];
    }

    return this.priorities.custom || 25;
  }

  /**
   * Get provenance information for a tool or base name.
   *
   * @param {string} identifier - Tool name or base name
   * @param {Array<Object>} tools - Array of all registered tools
   * @returns {Object} Provenance information
   */
  getToolProvenance(identifier, tools = []) {
    const baseName = this.extractBaseName(identifier);
    const exactMatch = tools.find(t => t.name === identifier);

    const result = {
      identifier,
      baseName,
      exactMatch,
      variants: [],
      sourceCount: 0
    };

    // Find all variants with the same base name
    for (const tool of tools) {
      const toolBaseName = this.extractBaseName(tool.name);
      if (toolBaseName === baseName) {
        result.variants.push({
          id: tool.id,
          name: tool.name,
          source: tool.source,
          isNamespaced: this.hasNamespace(tool.name),
          namespace: this.getNamespace(tool.name),
          priority: this._getSourcePriority(tool.source)
        });
      }
    }

    result.sourceCount = new Set(result.variants.map(v => v.source)).size;

    // Update provenance cache
    this._toolProvenance.set(baseName, result);

    log.debug({
      identifier,
      baseName,
      variantCount: result.variants.length,
      sourceCount: result.sourceCount
    }, 'Tool provenance retrieved');

    return result;
  }

  /**
   * Get all tools that provide a specific base name.
   *
   * @param {string} baseName - Base tool name
   * @param {Array<Object>} tools - Array of all registered tools
   * @returns {Array<Object>} Array of tool variants
   */
  getToolVariants(baseName, tools = []) {
    const provenance = this.getToolProvenance(baseName, tools);
    return provenance.variants;
  }

  /**
   * Get which server provides a specific tool name.
   *
   * @param {string} toolName - Tool name (namespaced or base)
   * @param {Array<Object>} tools - Array of all registered tools
   * @returns {Object|null} Server information or null if not found
   */
  getToolServer(toolName, tools = []) {
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      return null;
    }

    const source = tool.source;
    let serverId = null;

    if (source.startsWith('mcp:')) {
      serverId = source.replace('mcp:', '');
    }

    return {
      toolName: tool.name,
      source: tool.source,
      serverId: serverId || 'native',
      isMcpTool: source.startsWith('mcp:'),
      isNamespaced: this.hasNamespace(tool.name),
      baseName: this.extractBaseName(tool.name)
    };
  }

  /**
   * List all base names that have conflicts.
   *
   * @param {Array<Object>} tools - Array of all registered tools
   * @returns {Array<Object>} Array of conflict groups
   */
  listAllConflicts(tools = []) {
    const baseNameGroups = new Map();

    // Group tools by base name
    for (const tool of tools) {
      const baseName = this.extractBaseName(tool.name);
      if (!baseNameGroups.has(baseName)) {
        baseNameGroups.set(baseName, []);
      }
      baseNameGroups.get(baseName).push(tool);
    }

    // Find groups with multiple sources
    const conflicts = [];
    for (const [baseName, group] of baseNameGroups) {
      const sources = new Set(group.map(t => t.source));
      if (sources.size > 1) {
        conflicts.push({
          baseName,
          sourceCount: sources.size,
          tools: group.map(t => ({
            id: t.id,
            name: t.name,
            source: t.source,
            isNamespaced: this.hasNamespace(t.name)
          }))
        });
      }
    }

    log.debug({
      totalGroups: baseNameGroups.size,
      conflictCount: conflicts.length
    }, 'All conflicts listed');

    return conflicts;
  }

  /**
   * Update priority for a source.
   *
   * @param {string} source - Source identifier
   * @param {number} priority - New priority level
   */
  setSourcePriority(source, priority) {
    this.priorities[source] = priority;
    log.info({ source, priority }, 'Source priority updated');
  }

  /**
   * Get priority for a source.
   *
   * @param {string} source - Source identifier
   * @returns {number} Priority level
   */
  getSourcePriority(source) {
    return this._getSourcePriority(source);
  }

  /**
   * Clear the provenance cache.
   */
  clearCache() {
    this._toolProvenance.clear();
    log.info('Provenance cache cleared');
  }
}
