import { createLogger } from './logger.js';
import { MalformedResponseError, TimeoutError, DiscoveryError } from './mcp/errors.js';

const log = createLogger('mcp-discovery');

/**
 * MCP Discovery Module
 *
 * Wires MCP client to ToolRegistry:
 * - On successful connection, calls tools/list via the client
 * - Maps each MCP tool definition to ToolRegistry format
 * - Calls upsertTool() for each discovered tool
 *
 * MCP Tool Definition Format:
 * {
 *   name: string,           // Tool name (e.g., "fs.read_file")
 *   description: string,    // Human-readable description
 *   inputSchema: object,    // JSON Schema for tool inputs
 *   outputSchema?: object   // JSON Schema for tool outputs (optional)
 * }
 *
 * ToolRegistry Format:
 * {
 *   name: string,
 *   source: string,         // MCP server name
 *   metadata: {
 *     description: string,
 *     inputSchema: object,
 *     outputSchema?: object
 *   },
 *   approval_state: 'pending' (preserved on rediscovery)
 * }
 */

function matchesToken(name, token) {
  const pattern = new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'i');
  return pattern.test(name);
}

function detectCapabilityFlags(toolName) {
  if (!toolName || typeof toolName !== 'string') return [];

  const normalized = toolName.toLowerCase();
  const capabilities = new Set();

  const readTokens = ['read', 'get', 'list', 'fetch'];
  const writeTokens = ['write', 'create', 'update', 'delete', 'set', 'add', 'remove'];
  const searchTokens = ['search', 'query', 'find', 'lookup'];

  for (const token of readTokens) {
    if (matchesToken(normalized, token)) {
      capabilities.add('read');
      break;
    }
  }

  for (const token of writeTokens) {
    if (matchesToken(normalized, token)) {
      capabilities.add('write');
      break;
    }
  }

  for (const token of searchTokens) {
    if (matchesToken(normalized, token)) {
      capabilities.add('search');
      break;
    }
  }

  return Array.from(capabilities);
}

export function extractParameterSchemas(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') return null;

  const properties = inputSchema.properties;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];

  if (!properties || typeof properties !== 'object') {
    return { parameters: [], requiredParameters: required };
  }

  const parameters = Object.entries(properties).map(([name, schema]) => {
    const param = { name };

    if (schema && typeof schema === 'object') {
      if (schema.type) param.type = schema.type;
      if (schema.description) param.description = schema.description;
      if (schema.default !== undefined) param.default = schema.default;
      if (Array.isArray(schema.enum)) param.enum = schema.enum;
    }

    param.required = required.includes(name);
    return param;
  });

  return { parameters, requiredParameters: required };
}

/**
 * Map an MCP tool definition to ToolRegistry format.
 *
 * @param {Object} mcpTool - Tool definition from MCP server
 * @param {string} mcpTool.name - Tool name
 * @param {string} [mcpTool.description] - Tool description
 * @param {Object} [mcpTool.inputSchema] - JSON Schema for inputs
 * @returns {Object} Mapped tool metadata for ToolRegistry
 */
export function mapMcpToolToRegistryFormat(mcpTool) {
  if (!mcpTool || typeof mcpTool !== 'object') {
    throw new TypeError('Invalid MCP tool definition');
  }

  if (!mcpTool.name || typeof mcpTool.name !== 'string') {
    throw new TypeError('MCP tool must have a valid name');
  }

  const metadata = {};

  if (mcpTool.description) {
    metadata.description = mcpTool.description;
  }

  if (mcpTool.inputSchema) {
    metadata.inputSchema = mcpTool.inputSchema;
    const extracted = extractParameterSchemas(mcpTool.inputSchema);
    if (extracted) {
      metadata.parameters = extracted.parameters;
      metadata.requiredParameters = extracted.requiredParameters;
    }
  }

  if (mcpTool.outputSchema) {
    metadata.outputSchema = mcpTool.outputSchema;
    const extractedOutput = extractParameterSchemas(mcpTool.outputSchema);
    if (extractedOutput) {
      metadata.outputParameters = extractedOutput.parameters;
      metadata.requiredOutputParameters = extractedOutput.requiredParameters;
    }
  }

  const capabilityFlags = detectCapabilityFlags(mcpTool.name);
  if (capabilityFlags.length > 0) {
    metadata.capabilities = capabilityFlags;
  }

  return {
    name: mcpTool.name,
    metadata
  };
}

/**
 * Validate tools/list response structure (top-level only)
 * @param {*} response - The tools/list response from MCP server
 * @returns {Object} Validation result with isValid flag and errors array
 */
/**
 * Validate tools/list response structure (top-level only)
 * @param {*} response - The tools/list response from MCP server
 * @param {Object} options - Validation options
 * @param {boolean} options.strict - If true, throw on non-array responses (default: false for backward compatibility)
 * @returns {Object} Validation result with isValid flag and errors array
 */
function validateToolsListResponse(response, options = {}) {
  const errors = [];
  const strict = options.strict === true;

  if (response === null || response === undefined) {
    if (strict) {
      errors.push('tools/list response is null or undefined');
      return { isValid: false, errors, isNull: true };
    }
    log.warn('Null/undefined tools/list response treated as empty');
    return { isValid: true, errors, isEmpty: true, wasNull: true };
  }

  if (!Array.isArray(response)) {
    if (strict) {
      errors.push(`Expected array of tools, got ${typeof response}`);
      return { isValid: false, errors };
    }
    log.warn({ actual: typeof response }, 'Non-array tools/list response treated as empty');
    return { isValid: true, errors, isEmpty: true, wasNonArray: true };
  }

  if (response.length === 0) {
    log.debug('tools/list response is empty array');
    return { isValid: true, errors, isEmpty: true };
  }

  return { isValid: true, errors };
}

/**
 * Discover and register tools from an MCP server.
 *
 * @param {MCPClient} mcpClient - Connected MCP client instance
 * @param {ToolRegistry} toolRegistry - ToolRegistry instance
 * @param {string} serverName - Name of the MCP server (for source tracking)
 * @param {ToolRegistrationService} [registrationService] - Optional registration service for duplicate detection
 * @param {Object} [options] - Optional settings
 * @param {number} [options.timeoutMs] - Discovery timeout in milliseconds
 * @param {boolean} [options.healthCheck=true] - Whether to check server health before discovery
 * @param {number} [options.healthCheckPingTimeoutMs=5000] - Timeout for health check ping
 * @returns {Promise<Array>} Array of registered tool objects from ToolRegistry
 * @throws {MalformedResponseError} If tools/list response is malformed
 * @throws {TimeoutError} If discovery times out
 * @throws {Error} If discovery fails (connection error, etc.)
 */
export async function discoverAndRegister(mcpClient, toolRegistry, serverName, registrationService, options = {}) {
  if (!mcpClient) {
    throw new TypeError('mcpClient is required');
  }

  if (!toolRegistry) {
    throw new TypeError('toolRegistry is required');
  }

  if (!serverName || typeof serverName !== 'string') {
    throw new TypeError('serverName is required');
  }

  const timeoutMs = options.timeoutMs || 30000;
  const healthCheckEnabled = options.healthCheck !== false;
  const healthCheckPingTimeoutMs = options.healthCheckPingTimeoutMs || 5000;

  log.info({ serverName, timeoutMs }, 'Starting tool discovery');

  if (healthCheckEnabled) {
    const healthResult = await checkServerHealth(mcpClient, serverName, {
      ping: true,
      pingTimeoutMs: healthCheckPingTimeoutMs
    });

    if (!healthResult.healthy) {
      const reason = healthResult.reason || 'unknown';
      log.warn({ serverName, reason }, 'Server health check failed, aborting discovery');
      throw new DiscoveryError(
        `Server health check failed: ${reason}`,
        {
          serverName,
          errorType: 'HEALTH_CHECK_FAILED',
          retryable: true,
          details: { healthCheck: healthResult }
        }
      );
    }

    log.debug({ serverName }, 'Server health check passed, proceeding to list tools');
  }

  let tools = [];
  const registeredTools = [];
  const skippedTools = [];

  try {
    // Fetch tools from MCP server with timeout
    const listToolsPromise = mcpClient.listTools();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new TimeoutError(
        `tools/list request timed out after ${timeoutMs}ms`,
        { timeoutMs, serverName }
      )), timeoutMs);
    });

    tools = await Promise.race([listToolsPromise, timeoutPromise]);

    // Validate response structure
    const validation = validateToolsListResponse(tools, { strict: false });

    if (!validation.isValid) {
      const error = new MalformedResponseError(
        `Invalid tools/list response from ${serverName}`,
        {
          serverName,
          method: 'tools/list',
          expected: 'Array of tool definitions',
          actual: typeof tools,
          validationErrors: validation.errors
        }
      );
      log.error({ serverName, errors: validation.errors, actual: tools }, 'Malformed tools/list response');
      throw error;
    }

    // Treat null/undefined as malformed response (not just empty)
    if (validation.wasNull || tools === null || tools === undefined) {
      const error = new MalformedResponseError(
        `Invalid tools/list response from ${serverName}: received null or undefined instead of array`,
        {
          serverName,
          method: 'tools/list',
          expected: 'Array of tool definitions',
          actual: tools === undefined ? 'undefined' : 'null',
          validationErrors: ['Response is null or undefined']
        }
      );
      log.error({ serverName, actual: tools }, 'Malformed tools/list response - null/undefined');
      throw error;
    }

    // Treat non-null/undefined non-array responses as malformed (strict mode for non-empty types)
    if (validation.wasNonArray) {
      const error = new MalformedResponseError(
        `Invalid tools/list response from ${serverName}: expected array, got ${typeof tools}`,
        {
          serverName,
          method: 'tools/list',
          expected: 'Array of tool definitions',
          actual: typeof tools,
          validationErrors: [`Expected array, got ${typeof tools}`]
        }
      );
      log.error({ serverName, actual: tools }, 'Malformed tools/list response - non-array type');
      throw error;
    }

    if (validation.isEmpty) {
      log.info({ serverName }, 'Server returned empty tool list');
      return [];
    }

    log.info({ serverName, count: tools.length }, 'Received tools from server');

    // Register each tool
    for (let i = 0; i < tools.length; i++) {
      const mcpTool = tools[i];

      try {
        const toolValidation = validateMcpTool(mcpTool);

        if (!toolValidation.valid) {
          log.warn({ serverName, index: i, tool: mcpTool, errors: toolValidation.errors }, 'Skipping malformed tool');
          skippedTools.push({ index: i, errors: toolValidation.errors });
          continue;
        }

        const registryTool = mapMcpToolToRegistryFormat(mcpTool);

        let result;
        if (registrationService) {
          // Use registration service for duplicate detection and namespace prefixing
          result = await registrationService.registerTool(
            registryTool.name,
            serverName,
            registryTool.metadata
          );
        } else {
          // Fall back to direct registry upsert
          result = toolRegistry.upsertTool(
            registryTool.name,
            `mcp:${serverName}`,
            registryTool.metadata
          );
        }

        registeredTools.push(result);
        log.debug({ name: result.name, source: `mcp:${serverName}`, approval_state: result.approval_state, wasPrefixed: result.wasPrefixed }, 'Tool registered via discovery');
      } catch (err) {
        log.error({ serverName, index: i, tool: mcpTool, err }, 'Failed to register tool');
        skippedTools.push({ index: i, error: err.message });
      }
    }

    if (skippedTools.length > 0) {
      log.warn({ serverName, total: tools.length, registered: registeredTools.length, skipped: skippedTools.length }, 'Some tools were skipped during discovery');
    }

    log.info({ serverName, count: tools.length, registered: registeredTools.length, skipped: skippedTools.length }, 'Tool discovery complete');

    return registeredTools;
  } catch (err) {
    if (err instanceof MalformedResponseError || err instanceof TimeoutError) {
      log.error({ serverName, code: err.code, message: err.message, validationErrors: err.validationErrors }, 'Discovery failed');
      throw err;
    }

    log.error({ serverName, err }, 'Discovery failed');
    throw err;
  }
}

/**
 * Build detailed error information from an error object.
 * @param {Error} err - Error object
 * @param {string} serverName - Server name for context
 * @returns {Object} Detailed error information
 */
/**
 * Check server connection health before attempting discovery.
 *
 * Performs a two-tier health check:
 * 1. Passive check: Inspects client.getHealth() if available (no I/O)
 * 2. Active check: Sends a ping() to verify server responsiveness (lightweight I/O)
 *
 * @param {Object} client - MCPClient instance
 * @param {string} serverName - Server name for logging
 * @param {Object} [options] - Health check options
 * @param {boolean} [options.ping=true] - Whether to perform active ping
 * @param {number} [options.pingTimeoutMs=5000] - Timeout for ping in ms
 * @returns {Promise<{healthy: boolean, reason: string|null, checkedAt: string}>}
 */
export async function checkServerHealth(client, serverName, options = {}) {
  const checkedAt = new Date().toISOString();
  const doPing = options.ping !== false;
  const pingTimeoutMs = options.pingTimeoutMs || 5000;

  if (!client) {
    return { healthy: false, reason: 'client_is_null', checkedAt };
  }

  if (typeof client.getHealth === 'function') {
    const health = client.getHealth();

    if (!health) {
      return { healthy: false, reason: 'health_status_unavailable', checkedAt };
    }

    if (health.healthy === false) {
      return {
        healthy: false,
        reason: health.connected === false
          ? 'not_connected'
          : health.initialized === false
            ? 'not_initialized'
            : 'unhealthy',
        checkedAt,
        details: health
      };
    }
  }

  if (doPing && typeof client.ping === 'function') {
    try {
      const pingPromise = client.ping();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`ping timed out after ${pingTimeoutMs}ms`)), pingTimeoutMs)
      );

      await Promise.race([pingPromise, timeoutPromise]);

      return { healthy: true, reason: null, checkedAt };
    } catch (err) {
      log.warn({ serverName, err: err.message }, 'Server health check ping failed');
      return { healthy: false, reason: 'ping_failed', checkedAt, pingError: err.message };
    }
  }

  return { healthy: true, reason: null, checkedAt };
}

function buildErrorDetails(err, serverName) {
  const errorDetails = {
    message: err.message || String(err),
    errorType: err.constructor.name,
    retryable: err.retryable ?? false,
    code: err.code || null,
    serverName
  };

  if (err instanceof TimeoutError) {
    errorDetails.errorType = 'TIMEOUT';
    errorDetails.timeoutMs = err.timeoutMs || null;
  } else if (err instanceof MalformedResponseError) {
    errorDetails.errorType = 'MALFORMED_RESPONSE';
    errorDetails.validationErrors = err.validationErrors || [];
    errorDetails.method = err.method || null;
  } else if (err instanceof DiscoveryError) {
    errorDetails.errorType = err.errorType || 'DISCOVERY';
    errorDetails.timeoutMs = err.timeoutMs || null;
  }

  if (err.stack) {
    errorDetails.stack = err.stack;
  }

  return errorDetails;
}

/**
 * Discover tools from multiple MCP servers.
 *
 * @param {Array<Object>} serverConfigs - Array of server configurations
 * @param {MCPClient} serverConfigs[].client - MCPClient instance
 * @param {string} serverConfigs[].name - Server name
 * @param {number} [serverConfigs[].timeoutMs] - Optional per-server timeout in milliseconds
 * @param {ToolRegistry} toolRegistry - ToolRegistry instance
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.continueOnError] - Continue if one server fails (default: true)
 * @param {number} [options.timeoutMs] - Default timeout in milliseconds if not specified per-server (default: 30000)
 * @param {ToolRegistrationService} [options.registrationService] - Optional ToolRegistrationService for duplicate detection
 * @param {boolean} [options.healthCheck=true] - Whether to perform health check before discovery
 * @param {number} [options.healthCheckPingTimeoutMs=5000] - Timeout for health check ping in ms
 * @returns {Promise<Object>} Discovery results for all servers
 */
export async function discoverFromMultipleServers(serverConfigs, toolRegistry, options = {}) {
  if (!serverConfigs || !Array.isArray(serverConfigs)) {
    throw new TypeError('serverConfigs must be an array');
  }

  if (!toolRegistry) {
    throw new TypeError('toolRegistry is required');
  }

  const continueOnError = options.continueOnError !== false;
  const defaultTimeoutMs = options.timeoutMs || 30000;
  const registrationService = options.registrationService;
  const healthCheckEnabled = options.healthCheck !== false;
  const healthCheckPingTimeoutMs = options.healthCheckPingTimeoutMs || 5000;
  const maxConcurrent = options.maxConcurrent || serverConfigs.length;

  const discoveryPromises = [];
  const executing = new Set();

  for (const config of serverConfigs) {
    const promise = (async () => {
      const startTime = Date.now();
      const timeoutMs = (config && config.timeoutMs) || defaultTimeoutMs;

      try {
        if (!config || !config.client || !config.name) {
          throw new TypeError('Each server config must have client and name');
        }

        if (healthCheckEnabled) {
          const healthResult = await checkServerHealth(config.client, config.name, {
            ping: true,
            pingTimeoutMs: healthCheckPingTimeoutMs
          });

          if (!healthResult.healthy) {
            const endTime = Date.now();
            log.warn({ serverName: config.name, reason: healthResult.reason }, 'Server health check failed, skipping discovery');
            return {
              serverName: config.name,
              success: false,
              tools: null,
              error: `Server health check failed: ${healthResult.reason}`,
              errorType: 'HEALTH_CHECK_FAILED',
              errorCode: null,
              retryable: true,
              timeoutMs,
              validationErrors: [],
              healthCheck: healthResult,
              startTime,
              endTime,
              durationMs: endTime - startTime
            };
          }

          log.debug({ serverName: config.name }, 'Server health check passed, proceeding with discovery');
        }

        const result = await discoverAndRegister(
          config.client,
          toolRegistry,
          config.name,
          registrationService,
          { timeoutMs, healthCheck: false }
        );
        
        const endTime = Date.now();
        return {
          serverName: config.name,
          success: true,
          tools: result,
          error: null,
          startTime,
          endTime,
          durationMs: endTime - startTime
        };
      } catch (err) {
        const endTime = Date.now();
        const errorDetails = buildErrorDetails(err, config?.name || 'unknown');
        
        return {
          serverName: config?.name || 'unknown',
          success: false,
          tools: null,
          error: errorDetails.message,
          errorType: errorDetails.errorType,
          errorCode: errorDetails.code,
          retryable: errorDetails.retryable,
          timeoutMs: errorDetails.timeoutMs || timeoutMs,
          validationErrors: errorDetails.validationErrors || [],
          startTime,
          endTime,
          durationMs: endTime - startTime
        };
      }
    })();
    
    discoveryPromises.push(promise);
    
    if (maxConcurrent < serverConfigs.length) {
      executing.add(promise);
      promise.finally(() => executing.delete(promise));
      if (executing.size >= maxConcurrent) {
        await Promise.race(executing);
      }
    }
  }

  const settledResults = await Promise.allSettled(discoveryPromises);
  
  const results = [];
  let totalInserted = 0;
  let totalUpdated = 0;
  const failedServers = [];
  const successfulServers = [];

  for (const settled of settledResults) {
    if (settled.status === 'fulfilled') {
      const result = settled.value;
      
      const resultEntry = {
        serverName: result.serverName,
        success: result.success,
        startTime: result.startTime,
        endTime: result.endTime,
        durationMs: result.durationMs
      };

      if (result.success && result.tools) {
        resultEntry.tools = result.tools;
        resultEntry.toolCount = result.tools.length;
        totalInserted += result.tools.inserted || 0;
        totalUpdated += result.tools.updated || 0;
        successfulServers.push(result.serverName);
        
        log.info({ serverName: result.serverName, toolCount: result.tools?.length, inserted: result.tools.inserted || 0, updated: result.tools.updated || 0 }, 'Discovery succeeded');
      } else {
         resultEntry.error = result.error;
         resultEntry.errorType = result.errorType;
         resultEntry.errorCode = result.errorCode;
         resultEntry.retryable = result.retryable;
         resultEntry.timeoutMs = result.timeoutMs;
         if (result.validationErrors && result.validationErrors.length > 0) {
           resultEntry.validationErrors = result.validationErrors;
         }
         if (result.healthCheck) {
           resultEntry.healthCheck = result.healthCheck;
         }
         failedServers.push({
          serverName: result.serverName,
          error: result.error,
          errorType: result.errorType,
          retryable: result.retryable
        });
        
        log.warn({ serverName: result.serverName, error: result.error, errorType: result.errorType, retryable: result.retryable }, 'Discovery failed');
      }

      results.push(resultEntry);
    } else {
      const serverName = settled.reason?.serverName || 'unknown';
      const error = settled.reason?.message || String(settled.reason);
      const errorDetails = buildErrorDetails(settled.reason, serverName);
      
      const resultEntry = {
        serverName,
        success: false,
        error: errorDetails.message,
        errorType: errorDetails.errorType,
        errorCode: errorDetails.code,
        retryable: errorDetails.retryable
      };
      
      results.push(resultEntry);
      failedServers.push({
        serverName,
        error: error,
        errorType: errorDetails.errorType,
        retryable: errorDetails.retryable
      });

      log.error({ serverName, error, errorType: errorDetails.errorType }, 'Discovery promise rejected');

      if (!continueOnError) {
        break;
      }
    }
  }

  const successfulCount = results.filter(r => r.success).length;
  const failedCount = results.filter(r => !r.success).length;

  // Build partial results for successful servers with tool details
  const partialResults = results
    .filter(r => r.success && r.tools)
    .map(r => ({
      serverName: r.serverName,
      tools: r.tools,
      toolCount: r.tools.length,
      inserted: r.tools.inserted || 0,
      updated: r.tools.updated || 0,
      durationMs: r.durationMs
    }));

  log.info({ 
    total: serverConfigs.length, 
    successful: successfulCount, 
    failed: failedCount,
    totalInserted,
    totalUpdated,
    successfulServers,
    failedServers 
  }, 'Multi-server discovery complete');

  return {
    servers: serverConfigs.length,
    successful: successfulCount,
    failed: failedCount,
    totalInserted,
    totalUpdated,
    results,
    partialResults,
    successfulServers,
    failedServers
  };
}

/**
 * Validate an MCP tool definition against expected schema.
 *
 * @param {Object} mcpTool - Tool definition to validate
 * @returns {Object} Validation result
 * @returns {boolean} result.valid - Whether tool is valid
 * @returns {Array<string>} result.errors - List of validation errors
 */
export function validateMcpTool(mcpTool) {
  const errors = [];

  if (mcpTool === null || mcpTool === undefined) {
    return { valid: false, errors: ['Tool is null or undefined'] };
  }

  if (typeof mcpTool !== 'object') {
    return { valid: false, errors: [`Tool must be an object, got ${typeof mcpTool}`] };
  }

  if (!mcpTool.name) {
    errors.push('name field is missing');
  } else if (typeof mcpTool.name !== 'string') {
    errors.push(`name must be a string, got ${typeof mcpTool.name}`);
  } else if (mcpTool.name.length === 0) {
    errors.push('name cannot be an empty string');
  }

  if (mcpTool.description !== undefined && typeof mcpTool.description !== 'string') {
    errors.push(`description must be a string if provided, got ${typeof mcpTool.description}`);
  }

  if (mcpTool.inputSchema !== undefined) {
    if (mcpTool.inputSchema === null) {
      errors.push('inputSchema is null');
    } else if (typeof mcpTool.inputSchema !== 'object') {
      errors.push(`inputSchema must be an object if provided, got ${typeof mcpTool.inputSchema}`);
    } else if (mcpTool.inputSchema.type !== undefined && typeof mcpTool.inputSchema.type !== 'string') {
      errors.push(`inputSchema.type must be a string if provided, got ${typeof mcpTool.inputSchema.type}`);
    }
  }

  if (mcpTool.outputSchema !== undefined) {
    if (mcpTool.outputSchema === null) {
      errors.push('outputSchema is null');
    } else if (typeof mcpTool.outputSchema !== 'object') {
      errors.push(`outputSchema must be an object if provided, got ${typeof mcpTool.outputSchema}`);
    } else if (mcpTool.outputSchema.type !== undefined && typeof mcpTool.outputSchema.type !== 'string') {
      errors.push(`outputSchema.type must be a string if provided, got ${typeof mcpTool.outputSchema.type}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
