import { createLogger } from '../logger.js';
import { MCPClient, MCPClientEvents } from './client.js';
import { discoverAndRegister } from '../mcp-discovery.js';
import { CircuitBreaker, STATES } from '../orchestrator/circuit-breaker.js';
import { ConnectionError, TimeoutError, ProtocolError } from './errors.js';
import { invokeToolWithTimeout, invokeToolWithStreaming as invokeToolWithStreamingWrapper } from './tool-invocation-wrapper.js';
import { ToolCircuitBreaker } from './tool-circuit-breaker.js';
import { ToolRegistrationService } from './registration/ToolRegistrationService.js';
import fs from 'fs';
import path from 'path';

const log = createLogger('mcp-connection-manager');

/**
 * McpConnectionManager — Multi-server connection lifecycle manager
 *
 * Responsibilities:
 * - Read MCP server config and instantiate MCPClient per server
 * - Track per-connection state machine (disconnected → connecting → connected → error → reconnecting)
 * - Auto-discover tools via discoverAndRegister() on successful connection
 * - Exponential backoff reconnect with jitter
 * - Health reporting via getStates()
 *
 * State machine:
 *   disconnected → connecting → connected | error
 *   error → reconnecting → connecting (with exponential backoff)
 *   On max retries exhausted: state stays 'error', no further reconnects
 *
 * ==================================================================================
 * CIRCUIT BREAKER INTEGRATION & FALLBACK BEHAVIOR
 * ==================================================================================
 *
 * Each MCP server has an independent circuit breaker to prevent cascading failures
 * and allow graceful degradation when servers become unavailable.
 *
 * CIRCUIT BREAKER STATES:
 * -----------------------
 *
 * 1. CLOSED (Normal Operation)
 *    - All requests to the server are allowed
 *    - Failures are recorded with timestamps
 *    - When recent failures >= failureThreshold (default: 3), circuit trips OPEN
 *
 * 2. OPEN (Failing Fast)
 *    - Server is considered unhealthy
 *    - ALL connection attempts are rejected immediately (no remote calls)
 *    - ConnectionError thrown with retryable: false
 *    - Automatic transition to HALF_OPEN after cooldown period (default: 30s)
 *
 * 3. HALF_OPEN (Recovery Probe)
 *    - Cooldown period has elapsed
 *    - ONE probe connection attempt is allowed
 *    - On success → CLOSED (server recovered)
 *    - On failure → OPEN (reset cooldown, try again later)
 *
 * STATE TRANSITIONS:
 * ------------------
 *
 *   CLOSED → OPEN:
 *     Trigger: Recent failures >= failureThreshold within maxFailureAgeMs window
 *     Action: Block all requests, start cooldown timer
 *     Log: "Circuit breaker OPEN for server {serverId}"
 *
 *   OPEN → HALF_OPEN:
 *     Trigger: Cooldown period elapses (automatic, checked in canRequest())
 *     Action: Allow single probe request
 *     Log: "Circuit breaker HALF_OPEN for server {serverId}"
 *
 *   HALF_OPEN → CLOSED:
 *     Trigger: Probe connection succeeds
 *     Action: Resume normal operation, clear failure history
 *     Log: "Circuit breaker CLOSED for server {serverId}"
 *
 *   HALF_OPEN → OPEN:
 *     Trigger: Probe connection fails
 *     Action: Re-trip circuit, reset cooldown
 *     Log: "Circuit breaker re-opened after probe failure for server {serverId}"
 *
 *   OPEN → CLOSED (Auto-Recovery):
 *     Trigger: All failures age out (older than maxFailureAgeMs, default: 1 hour)
 *     Action: Automatically close circuit without probe
 *     Log: "Circuit breaker auto-recovered (failures aged out) for server {serverId}"
 *
 * FAILURE WINDOW & AGING:
 * -----------------------
 *
 * Only failures within the maxFailureAgeMs window (default: 1 hour) count toward
 * the threshold. Older failures are automatically discarded. This prevents a brief
 * outage from permanently marking a server as unhealthy.
 *
 * Example:
 *   - failureThreshold: 3
 *   - maxFailureAgeMs: 3600000 (1 hour)
 *   - Failures at: [10:00, 10:05, 10:10] → circuit trips OPEN
 *   - At 11:01, all failures aged out → circuit auto-recovers to CLOSED
 *
 * EXPONENTIAL BACKOFF WITH JITTER:
 * ---------------------------------
 *
 * When a connection fails in CLOSED state (before circuit trips):
 *   - Attempt 1: baseDelay (default: 1000ms) + random jitter (0-500ms)
 *   - Attempt 2: baseDelay * multiplier (default: 2.0) + jitter
 *   - Attempt 3: baseDelay * multiplier^2 + jitter
 *   - Max delay capped at maxDelay (default: 30000ms)
 *   - Max attempts: reconnectPolicy.maxAttempts (default: 5)
 *
 * Jitter prevents thundering herd when multiple servers reconnect simultaneously.
 *
 * FALLBACK BEHAVIOR:
 * ------------------
 *
 * When a circuit is OPEN:
 *   1. connect(serverId) throws ConnectionError with retryable: false
 *   2. getClient(serverId) returns null (no client available)
 *   3. getToolCatalog() excludes tools from unavailable servers
 *   4. Application layer must handle missing servers gracefully
 *   5. Circuit will automatically attempt recovery after cooldown
 *
 * Recommended fallback strategies:
 *   - Tool invocation: Check getClient() before calling, return error if null
 *   - Discovery: Filter out unavailable servers from tool catalog
 *   - Health checks: Use getCircuitBreakerStatus() to monitor server health
 *   - Alerts: Monitor circuit_breaker:open events for operational awareness
 *
 * CONFIGURATION:
 * --------------
 *
 * Constructor options.circuitBreaker:
 *   {
 *     failureThreshold: 3,        // Consecutive failures before tripping
 *     cooldownMs: 30000,          // Time before HALF_OPEN probe (30s)
 *     maxFailureAgeMs: 3600000    // Failure aging window (1 hour)
 *   }
 *
 * Constructor options.reconnect:
 *   {
 *     maxAttempts: 5,             // Max reconnection attempts
 *     baseDelay: 1000,            // Base backoff delay (1s)
 *     maxDelay: 30000,            // Max backoff cap (30s)
 *     multiplier: 2.0             // Backoff multiplier
 *   }
 *
 * MONITORING & OBSERVABILITY:
 * ---------------------------
 *
 * Methods for inspecting circuit breaker state:
 *   - getCircuitState(serverId): Returns 'closed', 'open', or 'half_open'
 *   - canRequest(serverId): Returns true if circuit allows requests
 *   - getCircuitBreakerStatus(): Returns status for all servers
 *   - resetCircuit(serverId): Manually reset circuit (use with caution)
 *
 * Error logging includes context:
 *   - serverId: Which server failed
 *   - errorType: ConnectionError, TimeoutError, or ProtocolError
 *   - retryCount: Current reconnection attempt number
 *   - backoffDelay: Calculated delay until next attempt
 *   - circuitState: Current circuit breaker state
 *
 * Example log output:
 *   {
 *     "serverId": "fs-tools",
 *     "errorType": "ConnectionError",
 *     "error": "ECONNREFUSED",
 *     "retryCount": 2,
 *     "backoffDelay": 2147,
 *     "circuitState": "closed",
 *     "message": "Connection failed, scheduling retry"
 *   }
 *
 * ==================================================================================
 *
 * Config schema:
 *   servers: [
 *     {
 *       id: 'fs-tools',
 *       transport: 'stdio' | 'http',
 *       command: 'node',           // stdio only
 *       args: ['./server.js'],     // stdio only
 *       url: 'http://...',         // http only
 *       timeout: 30000,
 *       enabled: true,
 *       auth: {                    // optional authentication config
 *         type: 'apikey' | 'oauth' | 'mtls' | 'none',
 *         apiKey: 'key',           // for apikey type
 *         token: 'token',          // for oauth type
 *         certPath: '/path/cert',  // for mtls type
 *         keyPath: '/path/key'     // for mtls type
 *       },
 *       retry: {                   // optional retry policy for auth failures
 *         maxAttempts: 3,
 *         baseDelay: 1000,
 *         maxDelay: 10000
 *       }
 *     }
 *   ]
 */
export class McpConnectionManager {
  /**
     * @param {Object} options
     * @param {Array<Object>} options.servers - Array of server config objects
     * @param {ToolRegistry} options.toolRegistry - For auto-discovery registration
     * @param {Object} [options.reconnect] - Reconnect policy
     * @param {number} [options.reconnect.maxAttempts=5] - Max reconnect attempts before giving up
     * @param {number} [options.reconnect.baseDelay=1000] - Base delay in ms
     * @param {number} [options.reconnect.maxDelay=30000] - Max backoff cap in ms
     * @param {Object} [options.circuitBreaker] - Circuit breaker config
     * @param {number} [options.circuitBreaker.failureThreshold=3] - Failures before opening circuit
     * @param {number} [options.circuitBreaker.cooldownMs=30000] - Cooldown before half-open
     * @param {number} [options.circuitBreaker.maxFailureAgeMs=3600000] - Failure age threshold
     * @param {ToolCircuitBreaker} [options.toolCircuitBreaker] - Tool-level circuit breaker for per-tool protection
     * @param {ToolRegistrationService} [options.registrationService] - Tool registration service for duplicate detection
     * @param {Function} [options.onMaxRetriesExhausted] - Callback invoked when max reconnection attempts are exhausted
     * @param {Function} onMaxRetriesExhausted(serverId, error, attempts) - Called when reconnect fails permanently
     */
    constructor(options = {}) {
      if (!options.servers || !Array.isArray(options.servers)) {
        throw new TypeError('servers option is required and must be an array');
      }

      if (!options.toolRegistry) {
        throw new TypeError('toolRegistry option is required');
      }

      this.servers = options.servers;
      this.toolRegistry = options.toolRegistry;
      this.toolCircuitBreaker = options.toolCircuitBreaker || new ToolCircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 30000
      });
      
      // Tool registration service for duplicate detection and namespace prefixing
      this.registrationService = options.registrationService || new ToolRegistrationService(options.toolRegistry);

     // Reconnect policy
     this.reconnectPolicy = {
       maxAttempts: options.reconnect?.maxAttempts ?? 5,
       baseDelay: options.reconnect?.baseDelay ?? 1000,
       maxDelay: options.reconnect?.maxDelay ?? 30000,
       multiplier: options.reconnect?.multiplier ?? 2.0
     };

     // Circuit breaker config
     this.circuitBreakerConfig = {
       failureThreshold: options.circuitBreaker?.failureThreshold ?? 3,
       cooldownMs: options.circuitBreaker?.cooldownMs ?? 30000,
       maxFailureAgeMs: options.circuitBreaker?.maxFailureAgeMs ?? 3600000
     };

      // Health check config
      this.healthCheckConfig = {
        intervalMs: options.healthCheck?.intervalMs ?? 5000 // Default to 5 seconds
      };

      // Max retries exhausted callback
      this.onMaxRetriesExhausted = options.onMaxRetriesExhausted || null;

      // Optional client factory — production uses MCPClient; unit tests inject mocks.
      this.createClient = typeof options.createClient === 'function' ? options.createClient : null;

      // Internal state per connection
     // Map: serverId → { id, config, client, status, lastConnectedAt, failureCount, lastError, reconnectTimer, reconnectAttempt, circuitBreaker }
     this._connections = new Map();

     // Tool distribution service for disconnect handling
     this._toolDistributionService = null;

     // Validate and initialize connection state
     this._initializeConnectionStates();
   }

 /**
    * Validate server configs and initialize connection state objects.
    * @private
    */
  _initializeConnectionStates() {
    const seenIds = new Set();

    for (const serverConfig of this.servers) {
      this._validateServerConfig(serverConfig);

      // Control-plane scoping guard (defense-in-depth). A filesystem MCP
      // server whose root contains `.synapse/` would let an agent read or
      // delete Synapse's own config/state via an absolute path — the Iter4
      // self-destruct class by a non-cwd vector. Fresh inits already scope
      // the root to <base>/workspace; this catches legacy / hand-edited
      // .env by rescoping in place and warning loudly (MCP is optional, so
      // we degrade rather than refuse startup).
      if (
        serverConfig.transport === 'stdio' &&
        Array.isArray(serverConfig.args) &&
        serverConfig.args.some(a => typeof a === 'string' && a.includes('server-filesystem'))
      ) {
        const rootIdx = serverConfig.args.length - 1;
        const root = serverConfig.args[rootIdx];
        if (typeof root === 'string' && root && fs.existsSync(path.join(root, '.synapse'))) {
          const scoped = path.join(root, 'workspace');
          try { fs.mkdirSync(scoped, { recursive: true }); } catch { /* best effort */ }
          log.warn(
            { serverId: serverConfig.id, was: root, now: scoped },
            'Filesystem MCP root contained the .synapse control plane — rescoped to workspace/ to prevent agent access. Update SYNAPSE_MCP_SERVERS to silence this.',
          );
          serverConfig.args = [...serverConfig.args];
          serverConfig.args[rootIdx] = scoped;
        }
      }

      if (seenIds.has(serverConfig.id)) {
        throw new Error(`Duplicate server id: ${serverConfig.id}`);
      }
      seenIds.add(serverConfig.id);

      // Create per-server circuit breaker
      const circuitBreaker = new CircuitBreaker({
        failureThreshold: this.circuitBreakerConfig.failureThreshold,
        cooldownMs: this.circuitBreakerConfig.cooldownMs,
        maxFailureAgeMs: this.circuitBreakerConfig.maxFailureAgeMs
      });

      this._connections.set(serverConfig.id, {
        id: serverConfig.id,
        config: serverConfig,
        client: null,
        status: 'disconnected',
        lastConnectedAt: null,
        failureCount: 0,
        lastError: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        circuitBreaker,
        healthCheckInterval: null // Added for health monitoring
      });

      log.debug({ serverId: serverConfig.id, transport: serverConfig.transport, enabled: serverConfig.enabled }, 'Initialized connection state');
    }
  }

  /**
   * Validate a single server config.
   * @private
   * @param {Object} config - Server config
   * @throws {Error} If config is invalid
   */
  _validateServerConfig(config) {
    if (!config.id || typeof config.id !== 'string') {
      throw new TypeError('Server config must have a valid id');
    }

    if (!config.transport || !['stdio', 'http'].includes(config.transport)) {
      throw new TypeError(`Server ${config.id}: transport must be 'stdio' or 'http'`);
    }

    if (config.transport === 'stdio' && !config.command) {
      throw new TypeError(`Server ${config.id}: command is required for stdio transport`);
    }

    if (config.transport === 'http' && !config.url) {
      throw new TypeError(`Server ${config.id}: url is required for http transport`);
    }

    if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) {
      throw new TypeError(`Server ${config.id}: timeout must be a positive number`);
    }

    // Validate auth config if present
    if (config.auth) {
      this._validateAuthConfig(config.id, config.auth);
    }

    // Validate retry config if present
    if (config.retry) {
      this._validateRetryConfig(config.id, config.retry);
    }
  }

  /**
   * Validate auth configuration.
   * @private
   * @param {string} serverId - Server ID for error messages
   * @param {Object} auth - Auth config object
   * @throws {TypeError} If auth config is invalid
   */
  _validateAuthConfig(serverId, auth) {
    const { type, apiKey, token, certPath, keyPath } = auth;

    if (!type || typeof type !== 'string') {
      throw new TypeError(`Server ${serverId}: auth.type must be specified`);
    }

    const validTypes = ['none', 'apikey', 'oauth', 'mtls'];
    if (!validTypes.includes(type)) {
      throw new TypeError(`Server ${serverId}: invalid auth.type '${type}'. Must be one of: ${validTypes.join(', ')}`);
    }

    if (type === 'apikey' && !apiKey) {
      throw new TypeError(`Server ${serverId}: auth.apiKey is required for apikey auth type`);
    }

    if (type === 'oauth' && !token) {
      throw new TypeError(`Server ${serverId}: auth.token is required for oauth auth type`);
    }

    if (type === 'mtls') {
      if (!certPath || !keyPath) {
        throw new TypeError(`Server ${serverId}: both auth.certPath and auth.keyPath are required for mtls auth type`);
      }

      // Resolve paths relative to cwd
      const resolvedCertPath = path.isAbsolute(certPath) ? certPath : path.resolve(process.cwd(), certPath);
      const resolvedKeyPath = path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath);

      if (!fs.existsSync(resolvedCertPath)) {
        throw new Error(`Server ${serverId}: certificate file not found: ${resolvedCertPath}`);
      }

      if (!fs.existsSync(resolvedKeyPath)) {
        throw new Error(`Server ${serverId}: key file not found: ${resolvedKeyPath}`);
      }
    }
  }

 /**
    * Validate retry configuration.
    * @private
    * @param {string} serverId - Server ID for error messages
    * @param {Object} retry - Retry config object
    * @throws {TypeError} If retry config is invalid
    */
  _validateRetryConfig(serverId, retry) {
    const { maxAttempts, baseDelay, maxDelay, multiplier } = retry;

    // Use AuthHandler defaults for cross-field validation
    const defaultBaseDelay = 1000;
    const defaultMaxDelay = 10000;
    const defaultMultiplier = 2.0;

    const effectiveBaseDelay = baseDelay !== undefined ? baseDelay : defaultBaseDelay;
    const effectiveMaxDelay = maxDelay !== undefined ? maxDelay : defaultMaxDelay;

    if (maxAttempts !== undefined) {
      if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
        throw new TypeError(`Server ${serverId}: retry.maxAttempts must be a non-negative integer`);
      }
    }

    if (baseDelay !== undefined) {
      if (!Number.isFinite(baseDelay) || baseDelay < 0) {
        throw new TypeError(`Server ${serverId}: retry.baseDelay must be a non-negative number`);
      }
    }

    if (maxDelay !== undefined) {
      if (!Number.isFinite(maxDelay) || maxDelay < 0) {
        throw new TypeError(`Server ${serverId}: retry.maxDelay must be a non-negative number`);
      }
    }

    if (multiplier !== undefined) {
      if (!Number.isFinite(multiplier) || multiplier <= 0) {
        throw new TypeError(`Server ${serverId}: retry.multiplier must be a positive number`);
      }
    }

    // Cross-field validation using effective values (includes defaults)
    if (effectiveMaxDelay < effectiveBaseDelay) {
      throw new TypeError(`Server ${serverId}: retry.maxDelay (${effectiveMaxDelay}) must be greater than or equal to retry.baseDelay (${effectiveBaseDelay})`);
    }
  }

  /**
   * Connect to all enabled servers.
   * @returns {Promise<Object>} Summary of connection attempts
   */
  async connectAll() {
    log.info({ count: this.servers.length }, 'Connecting to all enabled MCP servers');

    const results = [];

    for (const serverConfig of this.servers) {
      if (serverConfig.enabled === false) {
        log.debug({ serverId: serverConfig.id }, 'Skipping disabled server');
        results.push({ id: serverConfig.id, skipped: true });
        continue;
      }

      try {
        await this.connect(serverConfig.id);
        results.push({ id: serverConfig.id, success: true });
      } catch (err) {
        log.error({ serverId: serverConfig.id, err }, 'Failed to connect');
        results.push({ id: serverConfig.id, success: false, error: err.message });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => r.success === false).length;
    const skipped = results.filter(r => r.skipped).length;

    log.info({ successful, failed, skipped, total: this.servers.length }, 'Connection batch complete');

    return { successful, failed, skipped, results };
  }

 /**
    * Connect to a single server by id.
    * @param {string} serverId - Server id
    * @returns {Promise<void>}
    * @throws {Error} If server not found or connection fails
    */
  async connect(serverId) {
    const state = this._connections.get(serverId);
    if (!state) {
      throw new Error(`Server not found: ${serverId}`);
    }

    // Check circuit breaker
    if (!this.canRequest(serverId)) {
      throw new ConnectionError(`Circuit breaker open for server ${serverId}`, {
        serverId,
        retryable: false
      });
    }

    // Already connected
    if (state.status === 'connected' && state.client) {
      log.debug({ serverId }, 'Already connected');
      return;
    }

    // Already connecting
    if (state.status === 'connecting') {
      log.debug({ serverId }, 'Connection already in progress');
      return;
    }

    // Clear any pending reconnect timer
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    state.status = 'connecting';
    log.info({ serverId, transport: state.config.transport }, 'Connecting to MCP server');

    try {
      // Instantiate MCPClient
      const clientOptions = {
        transport: state.config.transport,
        timeout: state.config.timeout || 30000,
        autoReconnect: false,
      };

      // Propagate per-server auth configuration (and optional retry policy) to the client
      if (state.config.auth) {
        clientOptions.auth = state.config.auth;
      }
      if (state.config.retry) {
        clientOptions.retry = state.config.retry;
      }

      if (state.config.transport === 'stdio') {
        clientOptions.command = state.config.command;
        clientOptions.args = state.config.args || [];
      } else if (state.config.transport === 'http') {
        clientOptions.url = state.config.url;
      }

      // createClient is injectable for unit tests (mock clients); production uses MCPClient.
      const createClient = this.createClient || ((opts) => new MCPClient(opts));
      const client = createClient(clientOptions);
      state.client = client;

// Connect and initialize
       await client.connect();

       // Set up event listeners for disconnect handling
       this._setupClientEventListeners(serverId, client);

       // Transition to connected state
        state.status = 'connected';
        state.lastConnectedAt = new Date().toISOString();
        state.reconnectAttempt = 0;  // Reset backoff counter
        state.lastError = null;

        // Record success in circuit breaker
        state.circuitBreaker.recordSuccess(serverId);

        log.info({ serverId, transport: state.config.transport }, 'MCP server connected');

        // Auto-discover tools
        await this._discoverTools(serverId);

        // Start health checks
        this._startHealthCheck(serverId);

     } catch (err) {
       log.error({ serverId, err }, 'Connection failed');

       state.status = 'error';
       state.failureCount++;
       state.lastError = err.message;

       // Record failure in circuit breaker
       state.circuitBreaker.recordFailure(serverId);

       // Schedule reconnect if attempts remain
       this._scheduleReconnect(serverId);

       throw err;
     }
  }

/**
      * Auto-discover tools from a connected server.
      * @private
      * @param {string} serverId - Server id
      * @returns {Promise<void>}
      */
    async _discoverTools(serverId) {
      const state = this._connections.get(serverId);
      if (!state || !state.client) {
        return;
      }

      try {
        const timeoutMs = state.config.timeout || 30000;
        log.info({ serverId, timeoutMs }, 'Starting tool auto-discovery');

        const registeredTools = await discoverAndRegister(
          state.client,
          this.toolRegistry,
          serverId,
          this.registrationService,
          { timeoutMs }
        );

        log.info({ serverId, count: registeredTools.length }, 'Tool auto-discovery complete');
      } catch (err) {
        log.warn({ serverId, err }, 'Tool discovery failed (server remains connected)');
        // Don't throw - connection is still valid even if discovery fails
      }
    }

/**
      * Set up event listeners on the MCP client for disconnect handling.
      * @private
      * @param {string} serverId - Server id
      * @param {MCPClient} client - MCP client instance
      */
     _setupClientEventListeners(serverId, client) {
       const state = this._connections.get(serverId);
       if (!state) {
         log.warn({ serverId }, 'Cannot set up event listeners - state not found');
         return;
       }

        // Handle disconnect events from the client
        const disconnectHandler = (data) => {
          log.info({ serverId, reason: data?.reason }, 'Client disconnect event received');
          this._handleUnexpectedDisconnect(serverId, data).catch(err => {
            log.error({ serverId, err }, 'Error handling server disconnect');
          });
        };

       const heartbeatFailureHandler = (data) => {
         log.warn({ serverId, error: data?.error?.message }, 'Client heartbeat failure');
         // Record failure in circuit breaker
         const currentState = this._connections.get(serverId);
         if (currentState?.circuitBreaker) {
           currentState.circuitBreaker.recordFailure(serverId);
         }
       };

       const clientErrorHandler = () => {
         // Log client errors but don't trigger unregistration
         log.debug({ serverId }, 'Client error event received');
       };
       client.on(MCPClientEvents.DISCONNECT, disconnectHandler);
       client.on(MCPClientEvents.HEARTBEAT_FAILURE, heartbeatFailureHandler);
       client.on(MCPClientEvents.CLIENT_ERROR, clientErrorHandler);

       // Store handlers for cleanup
       state._eventHandlers = { disconnectHandler, heartbeatFailureHandler, clientErrorHandler };
     }

  /**
     * Clean up event listeners for a client.
     * @private
     * @param {string} serverId - Server id
     * @param {MCPClient} client - MCP client instance
     */
    _cleanupClientEventListeners(serverId, client) {
      const state = this._connections.get(serverId);
      if (state?._eventHandlers && client) {
        const { disconnectHandler, heartbeatFailureHandler, clientErrorHandler } = state._eventHandlers;
        client.off(MCPClientEvents.DISCONNECT, disconnectHandler);
        client.off(MCPClientEvents.HEARTBEAT_FAILURE, heartbeatFailureHandler);
        if (clientErrorHandler) client.off(MCPClientEvents.CLIENT_ERROR, clientErrorHandler);
        state._eventHandlers = null;
      }
    }

  /**
    * Schedule a reconnect attempt with exponential backoff.
    * @private
    * @param {string} serverId - Server id
    */
   _scheduleReconnect(serverId) {
     const state = this._connections.get(serverId);
     if (!state) {
       return;
     }

     // Duplicate disconnect/error notifications must not create parallel
     // reconnect timers or consume the retry budget multiple times.
     if (state.reconnectTimer) {
       return;
     }

     // Check if max attempts exhausted
     if (state.reconnectAttempt >= this.reconnectPolicy.maxAttempts) {
       log.error({ serverId, attempts: state.reconnectAttempt, lastError: state.lastError }, 'Max reconnect attempts exhausted');
       state.status = 'error';
       
       // Invoke failure callback if provided
       if (this.onMaxRetriesExhausted) {
         const error = state.lastError ? new Error(state.lastError) : new Error('Max reconnect attempts exhausted');
         try {
           this.onMaxRetriesExhausted(serverId, error, state.reconnectAttempt);
         } catch (callbackErr) {
           log.error({ serverId, err: callbackErr }, 'Error in onMaxRetriesExhausted callback');
         }
       }
       return;
     }

    state.reconnectAttempt++;
    state.status = 'reconnecting';

    // Exponential backoff: delay = min(baseDelay * multiplier^attempt, maxDelay)
    const backoffDelay = Math.min(
      this.reconnectPolicy.baseDelay * Math.pow(this.reconnectPolicy.multiplier, state.reconnectAttempt - 1),
      this.reconnectPolicy.maxDelay
    );

    // Add jitter: random 0-500ms to prevent thundering herd
    const jitter = Math.random() * 500;
    const delay = backoffDelay + jitter;

    log.info({ serverId, attempt: state.reconnectAttempt, delayMs: Math.round(delay) }, 'Scheduling reconnect');

    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null;
      try {
        await this.connect(serverId);
      } catch (err) {
        log.error({ serverId, attempt: state.reconnectAttempt, err }, 'Reconnect attempt failed');
        // connect() schedules the next attempt only on its internal failure path.
        // Circuit-open / non-retryable ConnectionError throws before that path,
        // so without re-scheduling here the reconnect loop stalls forever and
        // onMaxRetriesExhausted never fires.
        if (err instanceof ConnectionError && err.retryable === false) {
          this._scheduleReconnect(serverId);
        }
      }
    }, delay);
  }

  /**
   * Start periodic health checks for a server.
   * @private
   * @param {string} serverId - Server id
   */
  _startHealthCheck(serverId) {
    const state = this._connections.get(serverId);
    if (!state || state.healthCheckInterval) {
      return;
    }

    log.debug({ serverId, intervalMs: this.healthCheckConfig.intervalMs }, 'Starting health checks');

    state.healthCheckInterval = setInterval(async () => {
      await this._performHealthCheck(serverId);
    }, this.healthCheckConfig.intervalMs);
  }

/**
    * Perform a single health check for a server.
    * @private
    * @param {string} serverId - Server id
    */
   async _performHealthCheck(serverId) {
     const state = this._connections.get(serverId);
     if (!state || !state.client || state.status !== 'connected') {
       // If not connected or client missing, consider it a failure for circuit breaker
       state?.circuitBreaker?.recordFailure(serverId);
       return;
     }

      try {
        // Perform a lightweight check, e.g., listTools. If that fails, it's unhealthy.
        // A more robust solution might involve a dedicated ping method on MCPClient.
        await state.client.listTools();
        state.circuitBreaker.recordSuccess(serverId);
        log.debug({ serverId }, 'Health check successful');
      } catch (err) {
        state.circuitBreaker.recordFailure(serverId);
        log.warn({ serverId, err: err.message }, 'Health check failed');

        // Check if circuit breaker has tripped due to repeated failures
        const circuitState = state.circuitBreaker.getState(serverId);
        if (circuitState === 'open') {
          log.error({ serverId }, 'Circuit breaker opened due to health check failures');
          // Transition state to error immediately (within health check interval)
          state.status = 'error';
          state.lastError = err.message;
          // Tear down the unhealthy client and enter the normal reconnect path.
          await this._handleUnexpectedDisconnect(serverId, {
            reason: 'health_check_failed',
            error: err,
            closeClient: true,
          });
        }
      }
   }

  /**
   * Checks if a server connection is considered healthy.
   * A server is healthy if it's connected and its circuit breaker is not 'open'.
   * @param {string} serverId - Server id
   * @returns {boolean} True if the server is healthy, false otherwise.
   */
  isHealthy(serverId) {
    const state = this._connections.get(serverId);
    if (!state || state.status !== 'connected') {
      return false;
    }
    // A server is considered healthy if its circuit breaker is not in the OPEN state.
    // This means it's either CLOSED (normal) or HALF_OPEN (probing for recovery).
    const circuitState = state.circuitBreaker.getState(serverId);
    return circuitState === 'closed' || circuitState === 'half_open';
  }

  /**
   * Disconnect a single server.
   * @param {string} serverId - Server id
   * @returns {Promise<void>}
   */
  async disconnect(serverId) {
    const state = this._connections.get(serverId);
    if (!state) {
      throw new Error(`Server not found: ${serverId}`);
    }

    log.info({ serverId }, 'Disconnecting from MCP server');

    // 1. Clear reconnect timer to prevent reconnection attempts
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    // 2. Clear health check interval if present (set by health monitoring)
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
      state.healthCheckInterval = null;
    }

// 3. Clean up event listeners before disconnecting client
    if (state.client) {
      this._cleanupClientEventListeners(serverId, state.client);
    }

    // 4. Disconnect client — handles SSE destroy, child process SIGTERM, and pending request rejection
    if (state.client) {
       try {
         await this._disconnectClient(state.client, serverId);
       } catch (err) {
         log.warn({ serverId, err }, 'Error during client disconnect');
       }
       state.client = null;
     }

     state.status = 'disconnected';
     state.reconnectAttempt = 0;

     // 5. Handle server disconnect - unregister tools
     await this._handleServerDisconnect(serverId);

    log.info({ serverId }, 'Disconnected');
  }

  /**
   * Operator-initiated reconnect. Unlike the automatic path, this clears the
   * exhausted-retries give-up state ('error' after maxAttempts) and the open
   * circuit breaker, so a server that died past its retry budget can be
   * revived without restarting Synapse.
   * @param {string} serverId - Server id
   * @returns {Promise<void>}
   * @throws {Error} If server not found or the fresh connection attempt fails
   */
  async reconnect(serverId) {
    const state = this._connections.get(serverId);
    if (!state) {
      throw new Error(`Server not found: ${serverId}`);
    }
    log.info({ serverId, previousStatus: state.status }, 'Operator reconnect requested');
    try {
      await this.disconnect(serverId);
    } catch (err) {
      // A half-dead client may fail teardown — proceed with a fresh connect
      log.warn({ serverId, err: err.message }, 'Teardown before reconnect failed, continuing');
    }
    this.resetCircuit(serverId);
    await this.connect(serverId);
  }

  /**
   * Disconnect a client with a timeout guard and forced cleanup fallback.
   * If the client's disconnect() hangs beyond 5s, forcibly kill the child process.
   * @private
   * @param {MCPClient} client - The MCP client instance
   * @param {string} serverId - Server id for logging
   * @returns {Promise<void>}
   */
  async _disconnectClient(client, serverId) {
    const DISCONNECT_TIMEOUT = 5000;

    const disconnectPromise = client.disconnect();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Client disconnect timed out')),
        DISCONNECT_TIMEOUT
      );
    });

    try {
      await Promise.race([disconnectPromise, timeoutPromise]);
    } catch (err) {
      log.warn({ serverId, err: err.message }, 'Graceful disconnect failed, forcing cleanup');

      // Force-kill stdio child process if still alive
      if (client._process && !client._process.killed) {
        try {
          client._process.kill('SIGKILL');
        } catch (killErr) {
          log.warn({ serverId, err: killErr.message }, 'Force kill failed');
        }
      }

      // Force-destroy SSE connection if still open
      if (client._sseConnection) {
        try {
          client._sseConnection.destroy();
        } catch (sseErr) {
          log.warn({ serverId, err: sseErr.message }, 'SSE destroy failed');
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Disconnect all servers and clean up all resources.
   * Clears all reconnect timers and health intervals first (synchronous),
   * then disconnects all clients in parallel.
   * @returns {Promise<void>}
   */
  async disconnectAll() {
    log.info({ count: this._connections.size }, 'Disconnecting all MCP servers');

    // Phase 1: Synchronously clear all timers/intervals to prevent
    // any new reconnect or health check from firing during teardown
    for (const state of this._connections.values()) {
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      if (state.healthCheckInterval) {
        clearInterval(state.healthCheckInterval);
        state.healthCheckInterval = null;
      }
    }

    // Phase 2: Disconnect all clients in parallel
    const disconnectPromises = [];

    for (const serverId of this._connections.keys()) {
      disconnectPromises.push(
        this.disconnect(serverId).catch(err => {
          log.error({ serverId, err }, 'Error during disconnectAll');
        })
      );
    }

    await Promise.all(disconnectPromises);

    log.info('All MCP servers disconnected');
  }

  /**
   * Get connection state for a single server.
   * @param {string} serverId - Server id
   * @returns {Object|null} Connection state or null if not found
   */
  getState(serverId) {
    const state = this._connections.get(serverId);
    if (!state) {
      return null;
    }

    return {
      id: state.id,
      transport: state.config.transport,
      status: state.status,
      lastConnectedAt: state.lastConnectedAt,
      failureCount: state.failureCount,
      lastError: state.lastError
    };
  }

  /**
   * Get connection states for all servers.
   * @returns {Array<Object>} Array of connection state objects
   */
  getStates() {
    const states = [];

    for (const state of this._connections.values()) {
      states.push({
        id: state.id,
        transport: state.config.transport,
        status: state.status,
        lastConnectedAt: state.lastConnectedAt,
        failureCount: state.failureCount,
        lastError: state.lastError
      });
    }

    return states;
  }

  /**
   * Get a connected client by server id.
   * @param {string} serverId - Server id
   * @returns {MCPClient|null} Client instance or null if not connected
   */
  getClient(serverId) {
    const state = this._connections.get(serverId);
    if (!state || state.status !== 'connected') {
      return null;
    }
    return state.client;
  }

  /**
   * Get aggregated tool catalog from all connected servers.
   * Returns a queryable map of all discovered tools with their metadata.
   *
   * @returns {Promise<Object>} Tool catalog object with the following structure:
   *   {
   *     tools: Map<string, Object>,  // Map keyed by "serverId:toolName"
   *     byServer: Map<string, Array> // Tools grouped by server id
   *   }
   *
   * Each tool entry contains:
   *   - serverId: string           // Origin server id
   *   - name: string               // Tool name
   *   - description: string        // Tool description (if available)
   *   - inputSchema: object        // JSON Schema for parameters (if available)
   *   - qualifiedName: string      // Fully qualified name "serverId:toolName"
   *   - parameters: Array<Object>  // Extracted parameter schemas (if available)
   *   - requiredParameters: Array  // Required parameter names (if available)
   *   - capabilities: Object|Array // Capability flags (if available)
   */
  async getToolCatalog() {
    log.debug('Building tool catalog from connected servers');

    const allTools = [];
    const byName = new Map();
    const byQualifiedName = new Map();
    const byServer = new Map();

    // Iterate over all connections
    for (const [serverId, state] of this._connections.entries()) {
      // Skip non-connected servers
      if (state.status !== 'connected' || !state.client) {
        log.debug({ serverId, status: state.status }, 'Skipping non-connected server');
        continue;
      }

      try {
        // Fetch tools from this server (prefer enriched metadata when available)
        const tools = typeof state.client.listToolsWithMetadata === 'function'
          ? await state.client.listToolsWithMetadata()
          : await state.client.listTools();

        if (!tools || !Array.isArray(tools)) {
          log.warn({ serverId }, 'Invalid listTools response');
          continue;
        }

        const serverTools = [];

        // Process each tool
        for (const tool of tools) {
          if (!tool || !tool.name) {
            log.warn({ serverId, tool }, 'Skipping tool with missing name');
            continue;
          }

          const qualifiedName = `${serverId}:${tool.name}`;

          const toolEntry = {
            serverId,
            source: `mcp:${serverId}`,
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema || null,
            qualifiedName,
            parameters: Array.isArray(tool.parameters) ? tool.parameters : undefined,
            requiredParameters: Array.isArray(tool.requiredParameters) ? tool.requiredParameters : undefined,
            capabilities: tool.capabilities ?? undefined
          };

          allTools.push(toolEntry);

          // Index by qualified name
          byQualifiedName.set(qualifiedName, toolEntry);

          // Index by tool name (multiple servers may provide the same tool)
          if (!byName.has(tool.name)) {
            byName.set(tool.name, []);
          }
          byName.get(tool.name).push(toolEntry);

          serverTools.push(toolEntry);
        }

        // Store server's tools
        byServer.set(serverId, serverTools);

        log.debug({ serverId, count: serverTools.length }, 'Added tools from server to catalog');

      } catch (err) {
        log.error({ serverId, err }, 'Failed to list tools from server');
        // Continue with other servers
      }
    }

    const totalTools = allTools.length;
    const connectedServers = byServer.size;

    log.info({ totalTools, connectedServers }, 'Tool catalog built');

    return {
      tools: allTools,
      byName,
      byQualifiedName,
      byServer,
      totalTools,
      connectedServers
    };
  }

  /**
   * Get circuit breaker state for a server.
   * @param {string} serverId - Server id
   * @returns {string|null} Circuit state (closed, open, half_open) or null if server not found
   */
  getCircuitState(serverId) {
    const state = this._connections.get(serverId);
    if (!state || !state.circuitBreaker) {
      return null;
    }
    return state.circuitBreaker.getState(serverId);
  }

  /**
   * Check if requests can be made to a server (circuit breaker allows it).
   * @param {string} serverId - Server id
   * @returns {boolean} True if requests can be made
   */
  canRequest(serverId) {
    const state = this._connections.get(serverId);
    if (!state || !state.circuitBreaker) {
      return false;
    }
    return state.circuitBreaker.canRequest(serverId);
  }

  /**
   * Reset circuit breaker for a server.
   * @param {string} serverId - Server id
   * @returns {boolean} True if reset successful
   */
  resetCircuit(serverId) {
    const state = this._connections.get(serverId);
    if (!state || !state.circuitBreaker) {
      return false;
    }
    state.circuitBreaker.reset(serverId);
    return true;
  }

  /**
   * Get circuit breaker status for all servers.
   * @returns {Object} Map of serverId to circuit breaker status
   */
 getCircuitBreakerStatus() {
    const status = {};
    for (const [serverId, state] of this._connections.entries()) {
      if (state.circuitBreaker) {
        const cbState = state.circuitBreaker.getState(serverId);
        const failures = state.circuitBreaker.getFailures(serverId);
        status[serverId] = {
          state: cbState,
          failures,
          canRequest: state.circuitBreaker.canRequest(serverId)
        };
      }
    }
    return status;
  }

  /**
   * Get the number of active (connected) connections.
   * @returns {number} Count of connected servers
   */
  get activeConnections() {
    let count = 0;
    for (const state of this._connections.values()) {
      if (state.status === 'connected') {
        count++;
      }
    }
    return count;
  }

  /**
   * Get the total number of configured connections.
   * @returns {number} Total configured servers
   */
  get totalConnections() {
    return this._connections.size;
  }

  /**
    * Get distribution of connection states.
    * @returns {Object} { connected, disconnected, connecting, error, reconnecting }
    */
   getConnectionStateDistribution() {
     const dist = {
       connected: 0,
       disconnected: 0,
       connecting: 0,
       error: 0,
       reconnecting: 0
     };

     for (const state of this._connections.values()) {
       if (state.status in dist) {
         dist[state.status]++;
       }
     }

     return dist;
   }

   /**
    * Set the tool distribution service for disconnect handling.
    * @param {ToolDistributionService} service - Tool distribution service instance
    */
   setToolDistributionService(service) {
     this._toolDistributionService = service;
   }

   /**
    * Invoke a tool with circuit breaker protection and timeout enforcement.
    * @param {string} serverId - MCP server id
    * @param {string} toolName - Tool name to invoke
    * @param {Object} args - Tool arguments
    * @param {Object} options - Invocation options
    * @param {number} [options.timeoutMs] - Timeout in ms
    * @param {string} [options.operationCategory] - Operation category for fallback
    * @param {string} [options.fallbackToolName] - Fallback tool name for error payload
    * @returns {Promise<Object>} Invocation result
    */
   async invokeToolWithCircuitBreaker(serverId, toolName, args = {}, options = {}) {
     const state = this._connections.get(serverId);
     if (!state) {
       throw new Error(`Server not found: ${serverId}`);
     }

     if (state.status !== 'connected' || !state.client) {
       throw new Error(`Server not connected: ${serverId}`);
     }

      const toolKey = `${serverId}:${toolName}`;

      // Check tool-level circuit breaker (this also triggers OPEN → HALF_OPEN transition if cooldown elapsed)
      const canExecuteResult = this.toolCircuitBreaker.canExecute(toolKey);
      if (!canExecuteResult.allowed) {
        // Find fallback tools for this operation category.
        // Exclude: the failed tool (bare or server-qualified name), and any tool
        // from the same MCP server (same host is likely equally unhealthy).
        const operationCategory = options.operationCategory || null;
        let fallbackTools = [];
        if (operationCategory) {
          const failedNames = new Set([
            toolName,
            toolKey,
            options.fallbackToolName,
          ].filter(Boolean));
          const sameServerSources = new Set([`mcp:${serverId}`, serverId]);
          fallbackTools = this.toolRegistry.getToolsByCategory(operationCategory)
            .filter(t =>
              t.approval_state === 'approved'
              && !failedNames.has(t.name)
              && !sameServerSources.has(t.source)
            )
            .map(t => ({
              name: t.name,
              source: t.source,
              id: t.id,
              description: t.metadata?.description
                ?? t.description
                ?? '',
            }));
        }

        return {
          status: 'error',
          code: canExecuteResult.error.code,
          error: canExecuteResult.error.message,
          context: {
            toolName,
            serverId,
            fallbackTools,
            cooldownMs: this.toolCircuitBreaker.cooldownMs
          },
          fallbackTools // Also at top level for easier access
        };
      }

     try {
       // Invoke with timeout
       const result = await invokeToolWithTimeout(state.client, toolName, args, {
         timeoutMs: options.timeoutMs,
         idempotent: options.idempotent === true,
       });

       if (result.status === 'error') {
         // Record failure in tool circuit breaker
         this.toolCircuitBreaker.recordFailure(toolKey);

         // Check if circuit should now be open
         const updatedState = this.toolCircuitBreaker.getState(toolKey);
         if (updatedState.state === STATES.OPEN) {
           log.info({ toolKey, failureCount: updatedState.failureCount }, 'Tool circuit breaker opened');
         }

         return result;
       }

       // Record success
       this.toolCircuitBreaker.recordSuccess(toolKey);
       return result;
     } catch (err) {
       // Record failure
       this.toolCircuitBreaker.recordFailure(toolKey);
       throw err;
     }
   }

   /**
    * Invoke a tool with streaming support.
    * @param {string} serverId - MCP server id
    * @param {string} toolName - Tool name to invoke
    * @param {Object} args - Tool arguments
    * @param {Object} options - Invocation options
    * @param {number} [options.timeoutMs] - Timeout in ms
    * @param {Function} [options.onChunk] - Callback for streaming chunks
    * @param {Function} [options.onTimeout] - Callback on timeout
    * @returns {Promise<Object>} Invocation result with streaming metadata
    */
   async invokeToolWithStreaming(serverId, toolName, args = {}, options = {}) {
     const state = this._connections.get(serverId);
     if (!state) {
       throw new Error(`Server not found: ${serverId}`);
     }

     if (state.status !== 'connected' || !state.client) {
       throw new Error(`Server not connected: ${serverId}`);
     }

     return invokeToolWithStreamingWrapper(state.client, toolName, args, options);
   }

/**
      * Tear down state after an unexpected disconnect and schedule one reconnect.
      * @private
      * @param {string} serverId - Server id that disconnected
      */
     async _handleUnexpectedDisconnect(serverId, data = {}) {
       const state = this._connections.get(serverId);
       if (!state || state.status === 'disconnected') return;

       const client = state.client;
       if (state.healthCheckInterval) {
         clearInterval(state.healthCheckInterval);
         state.healthCheckInterval = null;
       }
       if (client) this._cleanupClientEventListeners(serverId, client);

       if (data.closeClient && client) {
         try {
           await this._disconnectClient(client, serverId);
         } catch (err) {
           log.warn({ serverId, err }, 'Failed to close unhealthy MCP client');
         }
       }

       state.client = null;
       state.status = 'error';
       state.failureCount++;
       state.lastError = data.error?.message || data.reason || 'MCP server disconnected unexpectedly';

       // Reconnect backoff already limits retries. Reset the connection circuit
       // so a health-check trip cannot block every scheduled reconnect attempt.
       state.circuitBreaker.reset(serverId);

       await this._handleServerDisconnect(serverId);
       this._scheduleReconnect(serverId);
     }

     /**
      * Unregister tools and notify the distribution service after disconnect.
      * @private
      * @param {string} serverId - Server id that disconnected
      */
     async _handleServerDisconnect(serverId) {
       const state = this._connections.get(serverId);
       // Prevent duplicate unregistration calls
       if (state && state._unregistrationInProgress) {
         log.debug({ serverId }, 'Unregistration already in progress, skipping');
         return;
       }
       if (state) state._unregistrationInProgress = true;

       try {
         // Unregister tools using registration service (thread-safe with cache cleanup)
         try {
           const result = await this.registrationService.unregisterServerTools(serverId);
           log.info({ serverId, deletedCount: result.deletedCount }, 'Tools unregistered from registry');
         } catch (err) {
           log.error({ serverId, err }, 'Failed to unregister tools during disconnect');
           // Fallback to direct registry removal
           try {
             this.toolRegistry.removeToolsBySource(`mcp:${serverId}`);
           } catch (fallbackErr) {
             log.error({ serverId, err: fallbackErr }, 'Fallback tool removal also failed');
           }
         }

         // Notify tool distribution service to update agent tool lists
         if (this._toolDistributionService) {
           try {
             await this._toolDistributionService.distributeToAllAgents();
             log.info({ serverId }, 'Tool distribution updated after server disconnect');
           } catch (err) {
             log.error({ serverId, err }, 'Failed to update tool distribution after disconnect');
           }
         }
       } finally {
         if (state) state._unregistrationInProgress = false;
       }
     }
}
