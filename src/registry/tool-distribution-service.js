/**
 * Tool Distribution Service
 *
 * Distributes approved MCP tools to agents based on role permissions:
 * - Fetches approved tools from ToolRegistry filtered by agent role
 * - Applies per-agent tool allowlists/denylists (_toolsConfig)
 * - Maintains distributed tool state per agent
 * - Provides tool invocation routing to MCP servers
 *
 * Distribution Rules:
 * 1. Tools with empty/null allowed_roles are accessible to all roles
 * 2. Tools with specific allowed_roles are only accessible to matching roles
 * 3. Per-agent _toolsConfig allowlist overrides: only listed tools permitted
 * 4. Per-agent _toolsConfig denylist blocks: always blocked regardless of role
 */

import { createLogger } from '../logger.js';
import { parameterValidator } from '../mcp/parameter-validator.js';
import config from '../config.js';
import { TOOLS as NATIVE_TOOLS } from '../mcp-server.js';
import { EVENT_TYPES } from '../orchestrator/timeline-schema.js';
import {
  mapToolInvocationStartEvent,
  mapToolInvocationSuccessEvent,
  mapToolInvocationErrorEvent,
} from '../orchestrator/timeline-event-mappers.js';

// The bus every TOOL_INVOCATION_* event is published on.
//
// This was:
//     const _globalBus = typeof EventBusClass.emit === 'function' ? EventBusClass : null;
// EventBus is a CLASS and emit is an INSTANCE method on its prototype, so
// EventBusClass.emit is undefined, the ternary always chose null, and every one
// of the twelve safeEmit() calls below silently returned a resolved promise.
//
// Measured, not inferred:
//     typeof EventBus.emit           -> undefined
//     typeof EventBus.prototype.emit -> function
//
// So tool invocations have never appeared on the operator timeline — not in
// tests, and not in production. The failure was invisible precisely because
// safeEmit swallows a missing bus by design; there is no bus to be missing at
// startup, so nothing ever logged a warning.
//
// Now set from the constructor. It stays module-scoped rather than per-instance
// so the twelve existing call sites are untouched; the orchestrator constructs
// exactly one ToolDistributionService (orchestrator.js:199). If a second
// instance with a DIFFERENT bus is ever introduced, this must become
// per-instance state — noted here because the last constructor would silently
// win.
let _globalBus = null;

function safeEmit(...args) {
  if (_globalBus) {
    return _globalBus.emit(...args) || Promise.resolve();
  }
  return Promise.resolve();
}

const log = createLogger('tool-distribution');

export class ToolDistributionService {
  /**
   * Create a ToolDistributionService instance.
   *
   * @param {ToolRegistry} toolRegistry - ToolRegistry instance
   * @param {McpConnectionManager} connectionManager - MCP connection manager
   * @param {Function} getAgents - Function to get agents map
   */
  /**
   * @param {Object} toolRegistry
   * @param {Object} connectionManager
   * @param {Function} getAgents
   * @param {Object} [events] - EventBus INSTANCE used to publish
   *   TOOL_INVOCATION_* timeline events. Optional and additive: the three
   *   existing argument positions are unchanged, and omitting it reproduces
   *   exactly the previous (silent) behaviour.
   */
  constructor(toolRegistry, connectionManager, getAgents, events = null) {
    if (!toolRegistry) {
      throw new TypeError('toolRegistry is required');
    }
    if (!connectionManager) {
      throw new TypeError('connectionManager is required');
    }
    if (!getAgents || typeof getAgents !== 'function') {
      throw new TypeError('getAgents must be a function');
    }

    this.toolRegistry = toolRegistry;
    this.connectionManager = connectionManager;
    this.getAgents = getAgents;

    // An instance, not the class — see the note on _globalBus above.
    if (events && typeof events.emit === 'function') {
      _globalBus = events;
    }

    // Map of agentId -> { tools: Map<toolName, toolDef>, lastUpdated: number }
    this._distributedTools = new Map();
  }

  /**
   * Supply the EventBus INSTANCE used to publish TOOL_INVOCATION_* events.
   *
   * Exists because the orchestrator builds this service before it builds the
   * bus, so the bus cannot be a constructor argument there without a temporal
   * dead zone at boot. Mirrors providerMetricsStore.setEventBus().
   *
   * @param {Object} events - EventBus instance (must have .emit)
   */
  setEventBus(events) {
    if (events && typeof events.emit === 'function') {
      _globalBus = events;
    }
  }

  /**
   * Distribute tools to all active agents.
   * Should be called after tool approval state changes.
   *
   * @returns {Promise<Object>} Distribution results per agent
   */
  async distributeToAllAgents() {
    const agents = this.getAgents();
    const results = {};

    for (const [agentId, agent] of Object.entries(agents)) {
      try {
        const distributed = await this.distributeToAgent(agentId, agent);
        results[agentId] = { success: true, count: distributed.tools.size };
      } catch (err) {
        log.error({ agentId, err }, `Failed to distribute tools to agent`);
        results[agentId] = { success: false, error: err.message };
      }
    }

    log.info({ agentCount: Object.keys(results).length }, 'Tool distribution complete');
    return results;
  }

  /**
   * Distribute tools to a specific agent.
   *
   * @param {string} agentId - Agent ID
   * @param {Object} agent - Agent instance
   * @returns {Promise<Object>} Distribution result with tools map
   */
  async distributeToAgent(agentId, agent) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }
    if (!agent) {
      throw new TypeError(`Agent not found: ${agentId}`);
    }

    // Get approved tools for agent's role
    const role = agent.role || null;
    const approvedTools = this.toolRegistry.listApprovedToolsForRole(role);

    // Apply per-agent tool configuration (allowlist/denylist)
    const filteredTools = this._applyToolConfig(approvedTools, agent._toolsConfig);

    // Build tools map with source tracking
    const toolsMap = new Map();
    for (const tool of filteredTools) {
      toolsMap.set(tool.name, {
        name: tool.name,
        source: tool.source,
        metadata: tool.metadata,
        approval_state: tool.approval_state
      });
    }

    // Store distributed tools
    this._distributedTools.set(agentId, {
      tools: toolsMap,
      lastUpdated: Date.now(),
      role
    });

    log.debug({ agentId, role, count: toolsMap.size }, 'Tools distributed to agent');

    return {
      agentId,
      tools: toolsMap,
      count: toolsMap.size,
      lastUpdated: Date.now()
    };
  }

  /**
   * Apply per-agent tool configuration (allowlist/denylist).
   *
   * @param {Array<Object>} tools - List of approved tools
   * @param {Object} toolsConfig - Per-agent tool configuration
   * @returns {Array<Object>} Filtered tools
   */
  _applyToolConfig(tools, toolsConfig) {
    if (!toolsConfig) {
      return tools;
    }

    let filtered = [...tools];

    // Apply allowlist: if present, only listed tools are permitted
    if (toolsConfig.allow && Array.isArray(toolsConfig.allow)) {
      const allowSet = new Set(toolsConfig.allow);
      filtered = filtered.filter(tool => allowSet.has(tool.name));
    }

    // Apply denylist AFTER the allowlist — deny always wins. The old
    // early-return made an allowlist silently disable the denylist, so
    // { allow: ['a','b'], deny: ['b'] } permitted 'b' — contradicting this
    // file's own contract ("denylist blocks: always blocked regardless").
    if (toolsConfig.deny && Array.isArray(toolsConfig.deny)) {
      const denySet = new Set(toolsConfig.deny);
      filtered = filtered.filter(tool => !denySet.has(tool.name));
    }

    return filtered;
  }

  /**
   * Get tools available for an agent by looking up the agent's role and fetching
   * approved tools from the registry. This is a query-only method that does not
   * modify the distributed tools cache.
   *
   * @param {string} agentId - Agent ID
   * @returns {Array<Object>} Array of tools available for the agent, or empty array if agent not found
   */
  getToolsForAgent(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }

    const agents = this.getAgents();
    const agent = agents[agentId];

    if (!agent) {
      return [];
    }

    const role = agent.role || null;
    const tools = this.toolRegistry.listApprovedToolsForRole(role);

    // Apply per-agent tool configuration if present
    if (agent._toolsConfig) {
      return this._applyToolConfig(tools, agent._toolsConfig);
    }

    return tools;
  }

  /**
   * Get distributed tools for an agent.
   *
   * @param {string} agentId - Agent ID
   * @returns {Map<string, Object>} Tools map or empty map if not distributed
   */
  getDistributedTools(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }

    const distribution = this._distributedTools.get(agentId);
    return distribution ? distribution.tools : new Map();
  }

  /**
   * Get tool definition for an agent.
   *
   * @param {string} agentId - Agent ID
   * @param {string} toolName - Tool name
   * @returns {Object|null} Tool definition or null if not available
   */
  getToolForAgent(agentId, toolName) {
    const tools = this.getDistributedTools(agentId);
    return tools.get(toolName) || null;
  }

  /**
   * Check if a tool is available for an agent.
   *
   * @param {string} agentId - Agent ID
   * @param {string} toolName - Tool name
   * @returns {boolean} True if tool is available
   */
  hasTool(agentId, toolName) {
    const tools = this.getDistributedTools(agentId);
    return tools.has(toolName);
  }

  /**
   * Get native tool catalog with source metadata.
   * Imports TOOLS from mcp-server.js and returns array with source: 'native'.
   *
   * @returns {Array<Object>} Native tools with source metadata
   */
  getNativeToolCatalog() {
    return NATIVE_TOOLS.map(tool => ({
      name: tool.name,
      source: 'native',
      metadata: {
        description: tool.description,
        inputSchema: tool.inputSchema,
        originalToolName: tool.name,
        source: 'native'
      },
      approval_state: 'approved'
    }));
  }

  /**
   * Calculate a numeric priority for a given tool.
   * Native tools have higher priority by default. Priority can be overridden via tool metadata.
   *
   * @param {Object} tool - The tool definition object.
   * @returns {number} The calculated priority. Higher number means higher priority.
   */
  calculateToolPriority(tool) {
    if (tool.metadata?.priority != null) {
      return tool.metadata.priority;
    }

    switch (tool.source) {
      case 'native':
        return 1.0;
      case 'mcp':
        return 0.8;
      default:
        return 0.5; // Default for unknown sources
    }
  }

  /**
   * Get a unified list of all available tools (native and MCP) for an agent,
   * with consistent metadata and source tracking.
   *
   * @param {string} agentId - Agent ID
   * @returns {Array<Object>} An array of unified tool definition objects.
   */
  getUnifiedToolRegistry(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }

    const nativeTools = this.getNativeToolCatalog();
    const mcpTools = Array.from(this.getDistributedTools(agentId).values());

    const unifiedTools = [];

    // Add native tools, ensuring consistent structure and priority
    for (const tool of nativeTools) {
      const toolWithPriority = {
        name: tool.name,
        source: 'native',
        metadata: tool.metadata,
        approval_state: tool.approval_state
      };
      toolWithPriority.priority = this.calculateToolPriority(toolWithPriority);
      unifiedTools.push(toolWithPriority);
    }

    // Add MCP tools, ensuring consistent structure, server health, and priority
    for (const tool of mcpTools) {
      const serverId = tool.source.replace('mcp:', '');
      const connectionState = this.connectionManager.getState?.(serverId);
      const circuitBreakerStatusMap = this.connectionManager.getCircuitBreakerStatus?.();
      const circuitBreakerStatus = circuitBreakerStatusMap?.[serverId];

      const serverHealth = {
        status: connectionState?.status || 'unknown',
        circuitState: circuitBreakerStatus?.state || 'unknown',
        canRequest: circuitBreakerStatus?.canRequest ?? false,
      };

      const toolWithPriority = {
        name: tool.name,
        source: 'mcp', // Normalize source to 'mcp'
        metadata: {
          ...tool.metadata,
          source: 'mcp', // Explicit source in metadata for distinguishing tool origins
          serverHealth,
        },
        approval_state: tool.approval_state
      };
      toolWithPriority.priority = this.calculateToolPriority(toolWithPriority);
      unifiedTools.push(toolWithPriority);
    }

    return unifiedTools;
  }

  /**
   * Get a compact, LLM-readable summary of available tools for an agent.
   * Merges native synapse tools with MCP tools distributed to the agent.
   * Formats tool name, description, parameter schemas, and source metadata.
   *
   * @param {string} agentId - Agent ID
   * @returns {string} LLM-readable tool catalog summary, or empty string if no tools
   */
  getToolSummaryForAgent(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }

    const unifiedTools = this.getUnifiedToolRegistry(agentId);

    if (unifiedTools.length === 0) {
      return '';
    }

    // Sort tools by priority (descending)
    unifiedTools.sort((a, b) => b.priority - a.priority);

    const lines = ['## Available Tools\n'];

    for (const toolDef of unifiedTools) {
      const meta = toolDef.metadata || {};
      const description = meta.description || '(no description)';
      
      let toolNameDisplay = toolDef.name;
      if (toolDef.source === 'mcp' && meta.serverHealth) {
        const isOffline = meta.serverHealth.status !== 'connected' || meta.serverHealth.circuitState === 'open';
        if (isOffline) {
          toolNameDisplay += ' [OFFLINE]';
        }
      }

      lines.push(`### ${toolNameDisplay} [source: ${toolDef.source}]`);
      lines.push(description);

      // Use inputSchema for native tools, parameters for MCP tools if inputSchema is not present
      const schema = meta.inputSchema || meta.parameters;
      if (schema && schema.properties && Object.keys(schema.properties).length > 0) {
        lines.push('**Parameters:**');
        for (const [paramName, paramDef] of Object.entries(schema.properties)) {
          const required = Array.isArray(schema.required) && schema.required.includes(paramName);
          const type = paramDef.type || 'any';
          const paramDesc = paramDef.description ? ` — ${paramDef.description}` : '';
          lines.push(`- \`${paramName}\` (${type}${required ? ', required' : ''})${paramDesc}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Invoke a tool on behalf of an agent.
   * Routes the call to the appropriate MCP server.
   *
   * @param {string} agentId - Agent ID (for logging/audit)
   * @param {string} toolName - Tool name to invoke
   * @param {Object} arguments_ - Tool arguments
   * @param {Object} context - Task context for correlation (taskId, subtaskId, campaignId, dispatchId, traceId)
   * @returns {Promise<Object>} Tool execution result
   * @throws {Error} If tool is not available or invocation fails
   */
  async invokeTool(agentId, toolName, arguments_ = {}, context = {}) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }
    if (!toolName || typeof toolName !== 'string') {
      throw new TypeError('toolName is required');
    }

    // Check if tool is available for this agent
    const toolDef = this.getToolForAgent(agentId, toolName);
    if (!toolDef) {
      throw new Error(`[TOOL_NOT_AVAILABLE] Tool not available for agent: ${toolName}`);
    }

    // Extract server name from source (format: "mcp:{serverName}")
    const source = toolDef.source;
    if (!source.startsWith('mcp:')) {
      throw new Error(`[INVALID_SOURCE] Invalid tool source: ${source}`);
    }

    const serverName = source.slice(4); // Remove "mcp:" prefix

    // Extract correlation keys from context parameter, with fallback to toolDef for backward compatibility
    // This is done early so that timeline events can be emitted even for early errors
    const correlationKeys = {
      campaignId: context.campaignId || toolDef.correlationKeys?.campaignId || null,
      taskId: context.taskId || toolDef.correlationKeys?.taskId || null,
      subtaskId: context.subtaskId || toolDef.correlationKeys?.subtaskId || null,
      dispatchId: context.dispatchId || toolDef.correlationKeys?.dispatchId || null,
      traceId: context.traceId || toolDef.correlationKeys?.traceId || null,
    };

    // Get MCP client for the server
    const client = this.connectionManager.getClient(serverName);
    if (!client) {
      const startTime = Date.now();

      // Emit TOOL_INVOCATION_START event before error
      const startEvent = mapToolInvocationStartEvent({
        toolName,
        serverSource: serverName,
        agentId,
        parameters: arguments_,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });
      safeEmit(EVENT_TYPES.TOOL_INVOCATION_START, startEvent)
        .catch(err => log.error({ err, event: startEvent }, 'Failed to emit TOOL_INVOCATION_START event'));

      const elapsedMs = Date.now() - startTime;

      // Emit TOOL_INVOCATION_ERROR event for SERVER_NOT_CONNECTED
      const errorEvent = mapToolInvocationErrorEvent({
        toolName,
        serverSource: serverName,
        agentId,
        error: `MCP server not connected: ${serverName}`,
        code: 'SERVER_NOT_CONNECTED',
        elapsedMs,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });
      safeEmit(EVENT_TYPES.TOOL_INVOCATION_ERROR, errorEvent)
        .catch(err => log.error({ err, event: errorEvent }, 'Failed to emit TOOL_INVOCATION_ERROR event'));

      throw new Error(`[SERVER_NOT_CONNECTED] MCP server not connected: ${serverName}`);
    }

    // Extract original tool name from metadata (MCP servers expect unprefixed names)
    const originalToolName = toolDef.metadata?.originalToolName || toolName;

    // Extract operation category for fallback resolution
    const operationCategory = toolDef.metadata?.operationCategory || null;
    const annotations = toolDef.metadata?.annotations || toolDef.metadata?.capabilities || toolDef.capabilities || {};
    const idempotent = annotations.readOnlyHint === true || annotations.idempotentHint === true;

    // Validate parameters against tool schema
    const inputSchema = toolDef.metadata?.inputSchema;
    if (inputSchema) {
      const validationResult = parameterValidator.validate(inputSchema, arguments_);
      if (!validationResult.valid) {
        log.warn({
          agentId,
          toolName,
          errors: validationResult.errors
        }, 'Parameter validation failed');

        // Return structured validation error without hitting the network
        return parameterValidator.createErrorResult(validationResult);
      }
    }

    // Emit TOOL_INVOCATION_START event
    const startEvent = mapToolInvocationStartEvent({
      toolName,
      serverSource: serverName,
      agentId,
      parameters: arguments_,
      campaignId: correlationKeys.campaignId,
      taskId: correlationKeys.taskId,
      subtaskId: correlationKeys.subtaskId,
      dispatchId: correlationKeys.dispatchId,
      traceId: correlationKeys.traceId,
      timestamp: new Date().toISOString(),
    });
    safeEmit(EVENT_TYPES.TOOL_INVOCATION_START, startEvent)
      .catch(err => log.error({ err, event: startEvent }, 'Failed to emit TOOL_INVOCATION_START event'));

    let result;
    const startTime = Date.now();
    try {
      // Invoke the tool with circuit breaker protection and timeout enforcement
      log.info({ agentId, toolName, serverName, originalToolName, operationCategory }, 'Invoking tool with circuit breaker');

      result = await this.connectionManager.invokeToolWithCircuitBreaker(
        serverName,
        originalToolName,
        arguments_,
        {
          timeoutMs: config.mcp.toolInvocationTimeoutMs,
          operationCategory,
          fallbackToolName: toolName,
          idempotent,
        }
      );

      const elapsedMs = Date.now() - startTime;

      if (result.status === 'error') {
        log.error({
          agentId,
          toolName,
          serverName,
          originalToolName,
          status: result.status,
          code: result.code,
          error: result.error,
          fallbackTools: result.fallbackTools,
          elapsedMs
        }, 'Tool invocation failed (returned error status)');

        const errorEvent = mapToolInvocationErrorEvent({
          toolName,
          serverSource: serverName,
          agentId,
          error: result.error || 'Tool invocation returned error status',
          code: result.code || 'TOOL_ERROR',
          elapsedMs,
          campaignId: correlationKeys.campaignId,
          taskId: correlationKeys.taskId,
          subtaskId: correlationKeys.subtaskId,
          dispatchId: correlationKeys.dispatchId,
          traceId: correlationKeys.traceId,
          timestamp: new Date().toISOString(),
        });
        
        if (result.fallbackTools && result.fallbackTools.length > 0) {
          errorEvent.data.fallbackTools = result.fallbackTools;
          errorEvent.data.fallbackErrors = result.context?.fallbackErrors || [];
        }

        safeEmit(EVENT_TYPES.TOOL_INVOCATION_ERROR, errorEvent)
          .catch(err => log.error({ err, event: errorEvent }, 'Failed to emit TOOL_INVOCATION_ERROR event'));

        return result;
      }

      log.info({ agentId, toolName, serverName, originalToolName, status: result.status, elapsedMs }, 'Tool invocation complete');

      // Emit TOOL_INVOCATION_SUCCESS event
      const successEvent = mapToolInvocationSuccessEvent({
        toolName,
        serverSource: serverName,
        agentId,
        result: result.result, // Assuming result object has a 'result' property
        elapsedMs,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });
      safeEmit(EVENT_TYPES.TOOL_INVOCATION_SUCCESS, successEvent)
        .catch(err => log.error({ err, event: successEvent }, 'Failed to emit TOOL_INVOCATION_SUCCESS event'));

      return result;
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      log.error({ 
        agentId, 
        toolName, 
        serverName, 
        error: err.message, 
        fallbackTools: err.fallbackTools,
        elapsedMs 
      }, 'Tool invocation failed');

      // Emit TOOL_INVOCATION_ERROR event
      const errorEvent = mapToolInvocationErrorEvent({
        toolName,
        serverSource: serverName,
        agentId,
        error: err.message,
        code: err.code || 'TOOL_ERROR',
        elapsedMs,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });

      if (err.fallbackTools && err.fallbackTools.length > 0) {
        errorEvent.data.fallbackTools = err.fallbackTools;
        errorEvent.data.fallbackErrors = err.fallbackErrors || [];
      }

      safeEmit(EVENT_TYPES.TOOL_INVOCATION_ERROR, errorEvent)
        .catch(err => log.error({ err, event: errorEvent }, 'Failed to emit TOOL_INVOCATION_ERROR event'));

      throw err;
    }
  }

  /**
   * Invoke a tool with streaming support.
   * Routes the call to the appropriate MCP server with chunk callbacks.
   *
   * @param {string} agentId - Agent ID (for logging/audit)
   * @param {string} toolName - Tool name to invoke
   * @param {Object} arguments_ - Tool arguments
   * @param {Object} context - Task context for correlation (taskId, subtaskId, campaignId, dispatchId, traceId)
   * @param {Object} options - Streaming options
   * @param {Function} options.onChunk - Callback for each streaming chunk
   * @param {number} options.timeoutMs - Timeout in milliseconds
   * @param {Function} options.onTimeout - Callback on timeout
   * @returns {Promise<Object>} Tool execution result with streaming metadata
   * @throws {Error} If tool is not available or invocation fails
   */
  async invokeToolWithStreaming(agentId, toolName, arguments_ = {}, context = {}, options = {}) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }
    if (!toolName || typeof toolName !== 'string') {
      throw new TypeError('toolName is required');
    }

    const toolDef = this.getToolForAgent(agentId, toolName);
    if (!toolDef) {
      throw new Error(`[TOOL_NOT_AVAILABLE] Tool not available for agent: ${toolName}`);
    }

    const source = toolDef.source;
    if (!source.startsWith('mcp:')) {
      throw new Error(`[INVALID_SOURCE] Invalid tool source: ${source}`);
    }

    const serverName = source.slice(4);

    // Extract correlation keys from context parameter, with fallback to toolDef for backward compatibility
    // This is done early so that timeline events can be emitted even for early errors
    const correlationKeys = {
      campaignId: context.campaignId || toolDef.correlationKeys?.campaignId || null,
      taskId: context.taskId || toolDef.correlationKeys?.taskId || null,
      subtaskId: context.subtaskId || toolDef.correlationKeys?.subtaskId || null,
      dispatchId: context.dispatchId || toolDef.correlationKeys?.dispatchId || null,
      traceId: context.traceId || toolDef.correlationKeys?.traceId || null,
    };

    const client = this.connectionManager.getClient(serverName);
    if (!client) {
      const startTime = Date.now();

      // Emit TOOL_INVOCATION_START event before error
      const startEvent = mapToolInvocationStartEvent({
        toolName,
        serverSource: serverName,
        agentId,
        parameters: arguments_,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });
      safeEmit(EVENT_TYPES.TOOL_INVOCATION_START, startEvent)
        .catch(err => log.error({ err, event: startEvent }, 'Failed to emit TOOL_INVOCATION_START event for streaming'));

      const elapsedMs = Date.now() - startTime;

      // Emit TOOL_INVOCATION_ERROR event for SERVER_NOT_CONNECTED
      const errorEvent = mapToolInvocationErrorEvent({
        toolName,
        serverSource: serverName,
        agentId,
        error: `MCP server not connected: ${serverName}`,
        code: 'SERVER_NOT_CONNECTED',
        elapsedMs,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });
      safeEmit(EVENT_TYPES.TOOL_INVOCATION_ERROR, errorEvent)
        .catch(err => log.error({ err, event: errorEvent }, 'Failed to emit TOOL_INVOCATION_ERROR event for streaming'));

      throw new Error(`[SERVER_NOT_CONNECTED] MCP server not connected: ${serverName}`);
    }

    const originalToolName = toolDef.metadata?.originalToolName || toolName;
    const operationCategory = toolDef.metadata?.operationCategory || null;

    const inputSchema = toolDef.metadata?.inputSchema;
    if (inputSchema) {
      const validationResult = parameterValidator.validate(inputSchema, arguments_);
      if (!validationResult.valid) {
        log.warn({
          agentId,
          toolName,
          errors: validationResult.errors
        }, 'Parameter validation failed');

        return parameterValidator.createErrorResult(validationResult);
      }
    }

    // Emit TOOL_INVOCATION_START event for streaming
    const startEvent = mapToolInvocationStartEvent({
      toolName,
      serverSource: serverName,
      agentId,
      parameters: arguments_,
      campaignId: correlationKeys.campaignId,
      taskId: correlationKeys.taskId,
      subtaskId: correlationKeys.subtaskId,
      dispatchId: correlationKeys.dispatchId,
      traceId: correlationKeys.traceId,
      timestamp: new Date().toISOString(),
    });
    safeEmit(EVENT_TYPES.TOOL_INVOCATION_START, startEvent)
      .catch(err => log.error({ err, event: startEvent }, 'Failed to emit TOOL_INVOCATION_START event for streaming'));

    const { onChunk, onTimeout, timeoutMs } = options;
    const annotations = toolDef.metadata?.annotations
      || toolDef.metadata?.capabilities
      || toolDef.capabilities
      || {};
    const idempotent = annotations.readOnlyHint === true || annotations.idempotentHint === true;

    const chunks = [];
    const startTime = Date.now();

    const wrappedOnChunk = (chunk) => {
      chunks.push(chunk);
      if (typeof onChunk === 'function') {
        onChunk(chunk);
      }
    };

    const streamingOptions = {
      timeoutMs: timeoutMs ?? config.mcp.toolInvocationTimeoutMs,
      onChunk: wrappedOnChunk,
      idempotent,
    };

    if (onTimeout) {
      streamingOptions.onTimeout = onTimeout;
    }

    try {
      const result = await this.connectionManager.invokeToolWithStreaming(
        serverName,
        originalToolName,
        arguments_,
        streamingOptions
      );

      const elapsedMs = Date.now() - startTime;

      if (result.status === 'error') {
        log.error({
          agentId,
          toolName,
          serverName,
          originalToolName,
          status: result.status,
          code: result.code,
          error: result.error,
          fallbackTools: result.fallbackTools,
          chunkCount: chunks.length,
          elapsedMs
        }, 'Streaming tool invocation failed (returned error status)');

        const errorEvent = mapToolInvocationErrorEvent({
          toolName,
          serverSource: serverName,
          agentId,
          error: result.error || 'Streaming tool invocation returned error status',
          code: result.code || 'TOOL_ERROR',
          elapsedMs,
          campaignId: correlationKeys.campaignId,
          taskId: correlationKeys.taskId,
          subtaskId: correlationKeys.subtaskId,
          dispatchId: correlationKeys.dispatchId,
          traceId: correlationKeys.traceId,
          timestamp: new Date().toISOString(),
        });
        
        if (result.fallbackTools && result.fallbackTools.length > 0) {
          errorEvent.data.fallbackTools = result.fallbackTools;
          errorEvent.data.fallbackErrors = result.context?.fallbackErrors || [];
        }

        safeEmit(EVENT_TYPES.TOOL_INVOCATION_ERROR, errorEvent)
          .catch(err => log.error({ err, event: errorEvent }, 'Failed to emit TOOL_INVOCATION_ERROR event for streaming'));

        return result;
      }

      log.info({ agentId, toolName, serverName, originalToolName, status: result.status, chunkCount: chunks.length, elapsedMs }, 'Streaming tool invocation complete');

      // Emit TOOL_INVOCATION_SUCCESS event for streaming
      const successEvent = mapToolInvocationSuccessEvent({
        toolName,
        serverSource: serverName,
        agentId,
        result: result.result, // Assuming result object has a 'result' property for streaming
        elapsedMs,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });
      safeEmit(EVENT_TYPES.TOOL_INVOCATION_SUCCESS, successEvent)
        .catch(err => log.error({ err, event: successEvent }, 'Failed to emit TOOL_INVOCATION_SUCCESS event for streaming'));

      return {
        ...result,
        elapsedMs,
        chunks,
        chunkCount: chunks.length,
      };
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      log.error({ 
        agentId, 
        toolName, 
        serverName, 
        error: err.message, 
        fallbackTools: err.fallbackTools,
        chunksCollected: chunks.length, 
        elapsedMs 
      }, 'Streaming tool invocation failed');

      // Emit TOOL_INVOCATION_ERROR event for streaming
      const errorEvent = mapToolInvocationErrorEvent({
        toolName,
        serverSource: serverName,
        agentId,
        error: err.message,
        code: err.code || 'TOOL_ERROR',
        elapsedMs,
        campaignId: correlationKeys.campaignId,
        taskId: correlationKeys.taskId,
        subtaskId: correlationKeys.subtaskId,
        dispatchId: correlationKeys.dispatchId,
        traceId: correlationKeys.traceId,
        timestamp: new Date().toISOString(),
      });

      if (err.fallbackTools && err.fallbackTools.length > 0) {
        errorEvent.data.fallbackTools = err.fallbackTools;
        errorEvent.data.fallbackErrors = err.fallbackErrors || [];
      }

      safeEmit(EVENT_TYPES.TOOL_INVOCATION_ERROR, errorEvent)
        .catch(err => log.error({ err, event: errorEvent }, 'Failed to emit TOOL_INVOCATION_ERROR event for streaming'));

      throw err;
    }
  }

  /**
   * Get distribution state for all agents.
   *
   * @returns {Object} Distribution state per agent
   */
  getDistributionState() {
    const state = {};

    for (const [agentId, distribution] of this._distributedTools) {
      state[agentId] = {
        count: distribution.tools.size,
        lastUpdated: distribution.lastUpdated,
        role: distribution.role,
        toolNames: Array.from(distribution.tools.keys())
      };
    }

    return state;
  }

  /**
   * Clear distributed tools for an agent.
   *
   * @param {string} agentId - Agent ID
   */
  clearAgentTools(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      throw new TypeError('agentId is required');
    }

    this._distributedTools.delete(agentId);
    log.debug({ agentId }, 'Cleared distributed tools');
  }

  /**
   * Clear all distributed tools.
   */
  clearAll() {
    this._distributedTools.clear();
    log.info('Cleared all distributed tools');
  }
}
