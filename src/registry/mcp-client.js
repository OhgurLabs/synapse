import { EventEmitter } from 'events';
import { McpConnectionManager } from '../mcp/connection-manager.js';
import { discoverAndRegister } from '../mcp-discovery.js';
import { createLogger } from '../logger.js';
import { MCPClientEvents } from '../mcp/client.js';

const log = createLogger('registry-mcp-client');

/**
 * _EventingConnectionManager — Internal subclass of McpConnectionManager that injects
 * event emission into the connection lifecycle hooks.
 *
 * Overrides:
 *   connect()        → emits 'connect' and 'reconnect' events
 *   disconnect()     → emits 'disconnect'
 *   _discoverTools() → replaces parent impl to capture result and emit 'tools_discovered'
 *   _scheduleReconnect() → emits 'max_retries_exhausted' when max attempts reached
 *
 * Events emitted on the RegistryMCPClient emitter:
 *   'connection_open'       { serverId: string }
 *   'connection_closed'     { serverId: string }
 *   'tools_discovered'      { serverId: string, tools: Array, count: number }
 *   'reconnect'             { serverId: string, attempt: number }
 *   'max_retries_exhausted' { serverId: string, attempts: number, lastError: string }
 *   'state_change'          { serverId: string, oldStatus: string, newStatus: string }
 *
 * @private
 */
class _EventingConnectionManager extends McpConnectionManager {
  /**
   * @param {Object} managerOptions - Options forwarded to McpConnectionManager
   * @param {EventEmitter} emitter - RegistryMCPClient instance to emit events on
   */
  constructor(managerOptions, emitter) {
    super(managerOptions);
    this._emitter = emitter;
    // this._connectionHistory = new Map(); // Removed: Redundant. `previousStatus` is determined from `stateBefore` or 'disconnected'
  }

  /**
   * Connect to a server and emit 'connection_open' on success.
   * Also emits 'reconnect' if this was a reconnection after prior failures.
   * @param {string} serverId
   */
  async connect(serverId) {
    const state = this._connections.get(serverId);
    const stateBefore = state?.status;
    const previousStatus = stateBefore || 'disconnected'; // Use stateBefore for previous status
    const attemptBefore = state?.reconnectAttempt || 0;
    
    try {
      await super.connect(serverId);
      
      const stateAfter = this._connections.get(serverId)?.status;
      
      if (stateBefore !== 'connected' && stateAfter === 'connected') {
        log.debug({ serverId }, 'connection_open event');
        this._emitter.emit('connection_open', { serverId });
        
        if (previousStatus === 'error' || previousStatus === 'reconnecting' || attemptBefore > 0) {
          log.debug({ serverId, attempt: attemptBefore }, 'reconnect event');
          this._emitter.emit('reconnect', { serverId, attempt: attemptBefore });
        }
      }
      
      if (stateBefore !== stateAfter) {
        this._emitter.emit('state_change', { serverId, oldStatus: stateBefore, newStatus: stateAfter });
      }
    } catch (err) {
      log.error({ serverId, err }, 'Connection failed in eventing manager');
      this._emitter.emit('server_error', err, { serverId });
      throw err;
    }
  }

  /**
   * Disconnect from a server and emit 'connection_closed'.
   * @param {string} serverId
   */
  async disconnect(serverId) {
    const stateBefore = this._connections.get(serverId)?.status;
    try {
      await super.disconnect(serverId);
    } catch (err) {
      this._emitter.emit('server_error', err, { serverId });
      throw err;
    }
    const stateAfter = this._connections.get(serverId)?.status;
    
    log.debug({ serverId }, 'connection_closed event');
    this._emitter.emit('connection_closed', { serverId });
    
    if (stateBefore !== stateAfter) {
      this._emitter.emit('state_change', { serverId, oldStatus: stateBefore, newStatus: stateAfter });
    }
  }

  /**
   * Emit connection_closed event for unexpected disconnections.
   * Called when a server disconnects unexpectedly (e.g., process crash).
   * @param {string} serverId
   */
  emitConnectionClosed(serverId) {
    log.debug({ serverId }, 'connection_closed event (unexpected disconnect)');
    this._emitter.emit('connection_closed', { serverId });
  }

  /**
   * Override _setupClientEventListeners to emit disconnect on unexpected disconnect.
   * @private
   * @param {string} serverId - Server id
   * @param {MCPClient} client - MCP client instance
   */
  _setupClientEventListeners(serverId, client) {
    // Set up our own disconnect handler that handles unexpected disconnects with reconnection
    const state = this._connections.get(serverId);
    if (!state) {
      log.warn({ serverId }, 'Cannot set up event listeners - state not found');
      return;
    }

    const disconnectHandler = (data) => {
      log.info({ serverId, reason: data?.reason }, 'Client disconnect event received');
      
      // Mark as error and schedule reconnect for unexpected disconnects
      state.status = 'error';
      state.failureCount++;
      state.lastError = `Unexpected disconnect: ${data?.reason || 'unknown'}`;
      state.circuitBreaker.recordFailure(serverId);
      
      // Unregister tools
      this._handleServerDisconnect(serverId).catch(err => {
        log.error({ serverId, err }, 'Error handling server disconnect');
      });
      
      // Emit disconnect event
      this.emitConnectionClosed(serverId);
      
      // Schedule reconnect
      this._scheduleReconnect(serverId);
    };

    const heartbeatFailureHandler = (data) => {
      log.warn({ serverId, error: data?.error?.message }, 'Client heartbeat failure');
      // Record failure in circuit breaker
      const currentState = this._connections.get(serverId);
      if (currentState?.circuitBreaker) {
        currentState.circuitBreaker.recordFailure(serverId);
      }
    };

    client.on(MCPClientEvents.DISCONNECT, disconnectHandler);
    client.on(MCPClientEvents.HEARTBEAT_FAILURE, heartbeatFailureHandler);
    client.on(MCPClientEvents.CLIENT_ERROR, () => {
      // Log client errors but don't trigger unregistration
      log.debug({ serverId }, 'Client error event received');
    });

    // Store handlers for cleanup
    state._eventHandlers = { disconnectHandler, heartbeatFailureHandler };
  }
  
  /**
   * Override _scheduleReconnect to emit 'max_retries_exhausted' event.
   * @param {string} serverId - Server id
   * @private
   */
  _scheduleReconnect(serverId) {
    const state = this._connections.get(serverId);
    if (!state) {
      return;
    }
    
    if (state.reconnectAttempt >= this.reconnectPolicy.maxAttempts) {
      log.error({ serverId, attempts: state.reconnectAttempt, lastError: state.lastError }, 'Max reconnect attempts exhausted');
      this._emitter.emit('max_retries_exhausted', {
        serverId,
        attempts: state.reconnectAttempt,
        lastError: state.lastError
      });
    }
    
    super._scheduleReconnect(serverId);
  }

  /**
   * Override tool discovery to capture registered tools and emit 'tools_discovered'.
   * Mirrors the parent implementation but returns the registered tools array and emits.
   * @param {string} serverId
   * @private
   */
  async _discoverTools(serverId) {
    const state = this._connections.get(serverId);
    if (!state || !state.client) {
      return;
    }

    try {
      log.info({ serverId }, 'Starting tool auto-discovery');

      const registeredTools = await discoverAndRegister(
        state.client,
        this.toolRegistry,
        serverId
      );

      log.info({ serverId, count: registeredTools.length }, 'Tool auto-discovery complete');

      this._emitter.emit('tools_discovered', {
        serverId,
        tools: registeredTools,
        count: registeredTools.length
      });
    } catch (err) {
      log.warn({ serverId, err }, 'Tool discovery failed (server remains connected)');
      this._emitter.emit('server_error', err, { serverId });
    }
  }
}

/**
 * RegistryMCPClient — Event-emitting MCP client integration for the ToolRegistry.
 *
 * Wraps McpConnectionManager with:
 * - EventEmitter interface for connection lifecycle events
 * - start()/stop() methods for orchestrator integration
 * - getHealth() for health monitoring
 *
 * Events:
 *   'connection_open'   { serverId: string }
 *     Fired when a server connects and the MCP initialization handshake succeeds.
 *
 *   'connection_closed' { serverId: string }
 *     Fired when a server disconnects (graceful shutdown or network failure).
 *
 *   'tools_discovered'  { serverId: string, tools: Array, count: number }
 *     Fired after tools/list completes and tools are registered in ToolRegistry.
 *     tools[] contains the ToolRegistry rows for each discovered tool.
 *
 *   'reconnect'         { serverId: string, attempt: number }
 *     Fired when a server successfully reconnects after prior failures.
 *     attempt indicates the reconnection attempt number (1-based).
 *
 *   'max_retries_exhausted' { serverId: string, attempts: number, lastError: string }
 *     Fired when max reconnection attempts are reached and no further retries will occur.
 *
 *   'state_change'      { serverId: string, oldStatus: string, newStatus: string }
 *     Fired whenever a connection state changes (disconnected/connecting/connected/error/reconnecting).
 *
 * Usage:
 *   const mcpClient = new RegistryMCPClient({ servers, toolRegistry, reconnect });
 *   mcpClient.on('connection_open', ({ serverId }) => log.info({ serverId }, 'connected'));
 *   mcpClient.on('reconnect', ({ serverId, attempt }) => log.info({ serverId, attempt }, 'reconnected'));
 *   mcpClient.on('max_retries_exhausted', ({ serverId, attempts }) => log.error({ serverId, attempts }, 'gave up'));
 *   await mcpClient.start();
 *   // ...
 *   await mcpClient.stop();
 */
export class RegistryMCPClient extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Array<Object>} options.servers
   *   Server config array. Each entry:
   *   { id, transport, command?, args?, url?, timeout?, enabled? }
   * @param {ToolRegistry} options.toolRegistry
   *   SQLite-backed registry where discovered tools are persisted.
   * @param {Object} [options.reconnect]
   *   Reconnect policy forwarded to McpConnectionManager:
   *   { maxAttempts, baseDelay, maxDelay }
   */
  constructor(options = {}) {
    super();

    if (!options.servers || !Array.isArray(options.servers)) {
      throw new TypeError('servers option is required and must be an array');
    }
    if (!options.toolRegistry) {
      throw new TypeError('toolRegistry option is required');
    }

    this._started = false;
    this._manager = new _EventingConnectionManager(
      {
        servers: options.servers,
        toolRegistry: options.toolRegistry,
        reconnect: options.reconnect,
        healthCheck: options.healthCheck,
        circuitBreaker: options.circuitBreaker
      },
      this
    );
  }

  /**
   * Start the MCP client: connect to all enabled servers.
   *
   * Each enabled server will attempt connection. Failures are logged and retried
   * via McpConnectionManager's exponential backoff. Successful connections trigger
   * tool auto-discovery, which emits 'tools_discovered'.
   *
   * @returns {Promise<Object>} { successful, failed, skipped, results }
   */
  async start() {
    this._started = true;
    const enabledCount = this._manager.servers.filter(s => s.enabled !== false).length;
    log.info({ serverCount: this._manager.servers.length, enabled: enabledCount }, 'MCP client starting');

    const summary = await this._manager.connectAll();

    log.info(
      { successful: summary.successful, failed: summary.failed, skipped: summary.skipped },
      'MCP client start complete'
    );

    return summary;
  }

  /**
   * Stop the MCP client: disconnect all servers gracefully.
   * Clears reconnect timers and cancels pending requests.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this._started = false;
    log.info('MCP client stopping');
    await this._manager.disconnectAll();
    log.info('MCP client stopped');
  }

  /**
   * Get health status for all managed connections.
   *
   * @returns {Object}
   *   {
   *     started: boolean,
   *     summary: { total, connected, disconnected, reconnecting, error },
   *     servers: Array<{ id, transport, status, lastConnectedAt, failureCount, lastError }>
   *   }
   */
  getHealth() {
    const states = this._manager.getStates();
    return {
      started: this._started,
      summary: {
        total: states.length,
        connected: states.filter(s => s.status === 'connected').length,
        disconnected: states.filter(s => s.status === 'disconnected').length,
        reconnecting: states.filter(s => s.status === 'reconnecting').length,
        error: states.filter(s => s.status === 'error').length
      },
      servers: states
    };
  }

  /**
   * Get the underlying MCPClient for a connected server.
   * Returns null if the server is not currently connected.
   *
   * @param {string} serverId
   * @returns {MCPClient|null}
   */
  getClient(serverId) {
    return this._manager.getClient(serverId);
  }

  /**
   * Get connection state for a single server.
   *
   * @param {string} serverId
   * @returns {Object|null} { id, transport, status, lastConnectedAt, failureCount, lastError }
   */
  getServerState(serverId) {
    return this._manager.getState(serverId);
  }
}
