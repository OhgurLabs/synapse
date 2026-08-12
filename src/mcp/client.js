import { spawn } from 'child_process';
import { createLogger } from '../logger.js';
import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import { AuthHandler } from './auth.js';
import { toolCache } from './cache/toolCache.js';
import { retry } from './utils/retry.js';
import { TimeoutError, MalformedResponseError, ResponseValidator } from './errors.js';
import { guardedFetch } from '../guarded-fetch.js';

const log = createLogger('mcp-client');

/**
 * Event types emitted by MCPClient
 * @enum {string}
 */
export const MCPClientEvents = {
  DISCONNECT: 'disconnect',
  RECONNECT: 'reconnect',
  CLIENT_ERROR: 'client_error',
  HEARTBEAT_FAILURE: 'heartbeat_failure'
};

/**
 * MCPClient — Connects to MCP servers via stdio or HTTP transport.
 *
 * Supports:
 * - stdio transport (spawns child process, communicates via stdin/stdout)
 * - HTTP transport (JSON-RPC over HTTP POST + Server-Sent Events)
 *
 * JSON-RPC 2.0 protocol:
 * - Requests: { jsonrpc: '2.0', id, method, params }
 * - Responses: { jsonrpc: '2.0', id, result } or { jsonrpc: '2.0', id, error }
 * - Notifications: { jsonrpc: '2.0', method, params } (no id)
 *
 * SSE support (HTTP transport only):
 * - Server-to-client notifications via SSE stream
 * - Server-to-client requests via SSE stream (client sends response via POST)
 * - Event ID tracking for resumability
 * - Automatic reconnection on disconnect
 *
 * Key methods:
 * - initialize: Handshake with server
 * - tools/list: Discover available tools
 * - tools/call: Invoke a tool
 * - ping: Health check
 * - onNotification: Register handler for server notifications
 * - onServerRequest: Register handler for server requests
 */
export class MCPClient {
  /**
   * @param {Object} options
   * @param {string} options.transport - 'stdio' or 'http'
   * @param {string} [options.command] - Command for stdio transport
   * @param {string} [options.args] - Args for stdio transport
   * @param {Object} [options.env] - Environment variables for stdio child process
   * @param {string} [options.url] - URL for HTTP transport
   * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
   * @param {number} [options.reconnectDelay] - Delay before reconnect in ms (default: 1000)
   * @param {number} [options.maxReconnectAttempts] - Max reconnect attempts (default: 3)
   * @param {string} [options.protocolVersion] - MCP protocol version (default: '2024-11-05')
   */
  constructor(options = {}) {
    if (!options.transport) {
      throw new TypeError('transport option is required');
    }

    if (options.transport === 'stdio' && !options.command) {
      throw new TypeError('command option is required for stdio transport');
    }

    if (options.transport === 'http' && !options.url) {
      throw new TypeError('url option is required for http transport');
    }

    this.transport = options.transport;
    this.command = options.command;
    this.args = options.args || [];
    this.env = options.env || undefined;
    this.url = options.url;
    this.timeout = options.timeout || 30000;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 3;
    this.autoReconnect = options.autoReconnect !== false;
    this.protocolVersion = options.protocolVersion || '2024-11-05';

    this._process = null;
    this._connected = false;
    this._initializing = false;
    this._initialized = false;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._lastPing = null;
    this._tools = []; // This will now be primarily managed by _toolCache

    // Initialize auth handler
    this._authHandler = new AuthHandler({
      auth: options.auth || { type: 'none' },
      retry: options.retry
    });

    // Initialize tool cache and retry options
    this._toolCache = options.toolCacheInstance || toolCache;
    this._retryOptions = options.retryOptions || {};

    // SSE support for HTTP transport
    this._sseConnection = null;
    this._sseLastEventId = null;
    this._notificationHandlers = new Map();
    this._serverRequestHandlers = new Map();

    // SSE parsing state (maintained across data chunks)
    this._sseCurrentEventId = null;
    this._sseCurrentEventType = 'message';
    this._sseCurrentData = '';

    // Event emitter for lifecycle events
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(10);
    this._emitter.on('error', (err) => this._handleEmitterError(err));

    if (this.transport === 'stdio') {
      this._setupStdio();
    } else if (this.transport === 'http') {
      this._setupHttp();
    }
  }

  /**
   * Set up stdio transport.
   * @private
   */
  _setupStdio() {
    const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (this.env) {
      spawnOpts.env = this.env;
    }
    this._process = spawn(this.command, this.args, spawnOpts);

    this._process.stdout.on('data', (data) => {
      this._handleStdioData(data);
    });

    this._process.stderr.on('data', (data) => {
      const stderr = data.toString('utf8').trim();
      if (stderr) {
        log.debug({ stderr }, 'MCP server stderr');
      }
    });

    this._process.on('exit', (code, signal) => {
      this._handleProcessExit(code, signal);
    });

    this._process.on('error', (err) => {
      log.error({ err, command: this.command, args: this.args }, 'MCP process error');
      this._setConnected(false);
      this._scheduleReconnect();
    });
  }

  /**
   * Set up HTTP transport.
   * @private
   */
  _setupHttp() {
    // HTTP transport uses SSE for server-to-client messages
    // POST requests are used for client-to-server messages
    // SSE connection is established after initialization
  }

  /**
   * Establish SSE connection for HTTP transport to receive server-to-client messages.
   * @private
   */
  async _connectSSE() {
    if (this.transport !== 'http') {
      return;
    }

    if (this._sseConnection) {
      log.debug('SSE connection already exists');
      return;
    }

    // Reset SSE parsing state
    this._sseCurrentEventId = null;
    this._sseCurrentEventType = 'message';
    this._sseCurrentData = '';

    // Validate mTLS configuration before attempting connection
    const tlsOptions = this._authHandler.getTlsOptions();
    if (tlsOptions) {
      const urlObj = new URL(this.url);
      if (urlObj.protocol !== 'https:') {
        throw new Error('mTLS authentication requires HTTPS transport');
      }
    }

    // Wrap SSE connection setup in auth retry logic
    // Non-config errors are handled internally to allow HTTP transport without SSE
    try {
      await this._authHandler.withRetry(async () => {
        return new Promise((resolve, reject) => {
          const urlObj = new URL(this.url);
          const isHttps = urlObj.protocol === 'https:';
          const httpModule = isHttps ? https : http;

          const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
              'Accept': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'MCP-Protocol-Version': this.protocolVersion,
              ...this._authHandler.getHeaders()
            }
          };

          // Apply mTLS options if configured
          if (tlsOptions) {
            Object.assign(options, tlsOptions);
          }

        // Include last event ID for resumability
        if (this._sseLastEventId) {
          options.headers['Last-Event-ID'] = this._sseLastEventId;
        }

        const req = httpModule.request(options, (res) => {
          // Headers arrived — disarm the connect timeout. It is an inactivity
          // timer, and a healthy SSE stream may be silent for minutes.
          req.setTimeout(0);
          if (res.statusCode !== 200) {
            log.error({ statusCode: res.statusCode }, 'SSE connection failed');
            // Auth errors (401/403) will be retried by withRetry wrapper
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          log.info('SSE connection established');
          this._sseConnection = res;
          resolve(); // Connection successful

          let buffer = '';

          res.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');

            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || '';

            this._parseSSELines(lines);
          });

res.on('end', () => {
             log.info('SSE connection closed by server');
             this._handleSSEDisconnect();
           });

           res.on('error', (err) => {
             log.error({ err }, 'SSE connection error');
             // Don't call _handleSSEError here as it may emit events that cause issues
             // The connection is already being cleaned up
             this._sseConnection = null;
           });
         });

        req.on('error', (err) => {
          log.error({ err }, 'SSE request error');
          reject(err);
        });

        // A server that accepts the socket but never flushes response headers
        // would otherwise hang this promise (and connect()) forever.
        req.setTimeout(this.timeout || 30000, () => {
          req.destroy(new Error(`SSE connection timed out after ${this.timeout || 30000}ms waiting for response headers`));
        });

        req.end();
      });
    });
    } catch (err) {
      // If auth retry logic exhausted or connection fails, handle as SSE error
      // This allows HTTP transport to work without SSE support
      log.error({ err }, 'SSE connection failed after auth retries');
      this._handleSSEError(err);
    }
  }

  /**
   * Parse SSE event lines.
   * @private
   * @param {Array<string>} lines - Array of SSE lines
   */
  _parseSSELines(lines) {
    for (const line of lines) {
      if (line.length === 0) {
        // Empty line signals end of event
        if (this._sseCurrentData) {
          this._handleSSEEvent(
            this._sseCurrentEventType,
            this._sseCurrentData,
            this._sseCurrentEventId
          );
          // Reset for next event
          this._sseCurrentEventId = null;
          this._sseCurrentEventType = 'message';
          this._sseCurrentData = '';
        }
        continue;
      }

      if (line.startsWith(':')) {
        // Comment, ignore
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        continue;
      }

      const field = line.substring(0, colonIndex);
      let value = line.substring(colonIndex + 1);

      // Remove leading space if present
      if (value.startsWith(' ')) {
        value = value.substring(1);
      }

      if (field === 'id') {
        this._sseCurrentEventId = value;
      } else if (field === 'event') {
        this._sseCurrentEventType = value;
      } else if (field === 'data') {
        this._sseCurrentData += (this._sseCurrentData ? '\n' : '') + value;
      }
      // 'retry' field is ignored for now
    }
  }

  /**
   * Handle an SSE event.
   * @private
   * @param {string} eventType - Event type
   * @param {string} data - Event data
   * @param {string|null} eventId - Event ID
   */
  _handleSSEEvent(eventType, data, eventId) {
    // Update last event ID for resumability
    if (eventId) {
      this._sseLastEventId = eventId;
    }

    try {
      const message = JSON.parse(data);

      // Handle JSON-RPC messages
      if (message.jsonrpc === '2.0') {
        if (message.method) {
          // Server-to-client notification or request
          if (message.id !== undefined) {
            // Request - server expects a response
            this._handleServerRequest(message);
          } else {
            // Notification - no response expected
            this._handleServerNotification(message);
          }
        } else if (message.id !== undefined) {
          // Response to a client request (shouldn't normally come via SSE, but handle it)
          this._handleMessage(message);
        }
      }
    } catch (err) {
      log.warn({ data, err }, 'Failed to parse SSE event data as JSON-RPC');
    }
  }

  /**
   * Handle server-to-client notification.
   * @private
   * @param {Object} message - JSON-RPC notification
   */
  _handleServerNotification(message) {
    const { method, params } = message;
    log.debug({ method, params }, 'Received server notification');

    const handlers = this._notificationHandlers.get(method);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(params);
        } catch (err) {
          log.error({ method, err }, 'Notification handler error');
        }
      });
    }
  }

  /**
   * Handle server-to-client request.
   * @private
   * @param {Object} message - JSON-RPC request
   */
  async _handleServerRequest(message) {
    const { id, method, params } = message;
    log.debug({ id, method, params }, 'Received server request');

    const handler = this._serverRequestHandlers.get(method);
    if (!handler) {
      // No handler registered, send error response
      await this._sendServerResponse(id, null, {
        code: -32601,
        message: 'Method not found'
      });
      return;
    }

    try {
      const result = await handler(params);
      await this._sendServerResponse(id, result, null);
    } catch (err) {
      log.error({ id, method, err }, 'Server request handler error');
      await this._sendServerResponse(id, null, {
        code: -32603,
        message: 'Internal error',
        data: err.message
      });
    }
  }

  /**
   * Send response to a server-to-client request.
   * @private
   * @param {number|string} id - Request ID
   * @param {*} result - Result value (null if error)
   * @param {Object|null} error - Error object (null if success)
   */
  async _sendServerResponse(id, result, error) {
    const response = {
      jsonrpc: '2.0',
      id
    };

    if (error) {
      response.error = error;
    } else {
      response.result = result;
    }

    // Send response via POST with auth retry logic
    try {
      await this._authHandler.withRetry(async () => {
        const fetchResponse = await guardedFetch(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': this.protocolVersion,
            ...this._authHandler.getHeaders()
          },
          body: JSON.stringify(response)
        }, { allowPrivateRanges: true });

        if (!fetchResponse.ok) {
          throw new Error(`HTTP ${fetchResponse.status}: ${fetchResponse.statusText}`);
        }

        return fetchResponse;
      });
    } catch (err) {
      log.error({ id, err }, 'Failed to send server response');
    }
  }

 /**
    * Handle SSE disconnection.
    * @private
    */
   _handleSSEDisconnect() {
     this._sseConnection = null;

     if (this._connected) {
       this._emit(MCPClientEvents.DISCONNECT, { wasConnected: true, reason: 'sse_disconnect' });
       this._scheduleReconnect();
     }
   }

   /**
    * Handle SSE error.
    * @private
    * @param {Error} err - Error object
    */
   _handleSSEError(err) {
     this._sseConnection = null;
     log.error({ err }, 'SSE error');
     this._emit(MCPClientEvents.CLIENT_ERROR, { error: err, context: 'sse' });

     if (this._connected) {
       this._emit(MCPClientEvents.DISCONNECT, { wasConnected: true, reason: 'sse_error', error: err });
       this._scheduleReconnect();
     }
   }

  /**
   * Handle stdio data from the MCP server.
   * @private
   * @param {Buffer} data - Raw data from stdout
   */
  _handleStdioData(data) {
    const str = data.toString('utf8');
    const lines = str.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        this._handleMessage(message);
      } catch (err) {
        log.warn({ line, err }, 'Failed to parse MCP message');
      }
    }
  }

  /**
   * Handle a JSON-RPC message.
   * @private
   * @param {Object} message - Parsed JSON-RPC message
   */
  _handleMessage(message) {
    if (message.id !== undefined) {
      // This is a response to a request
      const pending = this._pendingRequests.get(message.id);
      if (pending) {
        this._pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      // This is a notification (server-to-client)
      this._handleServerNotification(message);
    }
  }

 /**
     * Handle process exit.
     * @private
     * @param {number|null} code - Exit code
     * @param {string|null} signal - Exit signal
     */
    _handleProcessExit(code, signal) {
      const wasConnected = this._connected || this._initializing;
      log.info({ code, signal }, 'MCP process exited');
      
      // Reject all pending requests
      const error = new Error(`Stream terminated unexpectedly: process exited with code ${code} or signal ${signal}`);
      for (const [id, pending] of this._pendingRequests) {
        pending.reject(error);
      }
      this._pendingRequests.clear();
      
      this._setConnected(false);
      this._emit(MCPClientEvents.DISCONNECT, { wasConnected, reason: 'process_exit', code, signal });

      if (wasConnected) {
        this._scheduleReconnect();
      }
    }

  /**
   * Schedule a reconnect attempt.
   * @private
   */
  _scheduleReconnect() {
    // A connection manager may own reconnect policy for this client. In that
    // mode the client emits lifecycle events but must not start a second,
    // independent reconnect loop.
    if (!this.autoReconnect) return;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      log.error({ attempts: this._reconnectAttempts }, 'Max reconnect attempts reached');
      return;
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectAttempts++;
      log.info({ attempt: this._reconnectAttempts }, 'Attempting to reconnect');
      this.connect().catch(err => {
        log.error({ err, attempt: this._reconnectAttempts }, 'Reconnect failed');
      });
    }, this.reconnectDelay);
  }

 /**
    * Set connected state and notify listeners.
    * @private
    * @param {boolean} connected - New connected state
    */
   _setConnected(connected) {
     const wasConnected = this._connected;
     this._connected = connected;

     if (wasConnected && !connected) {
       log.info('Connection lost');
       this._emit(MCPClientEvents.DISCONNECT, { wasConnected, reason: 'connection_lost' });
     } else if (!wasConnected && connected) {
       log.info('Connection established');
     }
   }

/**
    * Emit an event to all registered listeners.
    * @private
    * @param {string} event - Event name
    * @param {*} data - Event data
    */
   _emit(event, data) {
     // Use emit with error handling to prevent uncaught exceptions
     this._emitter.emit(event, data);
   }

  /**
   * Handle uncaught errors from event listeners.
   * @private
   */
  _handleEmitterError(err) {
    log.error({ err }, 'Error in event listener');
  }

  /**
   * Register an event listener.
   * @param {string} event - Event name (see MCPClientEvents)
   * @param {Function} listener - Callback function
   * @returns {MCPClient} This instance for chaining
   */
  on(event, listener) {
    this._emitter.on(event, listener);
    return this;
  }

  /**
   * Remove an event listener.
   * @param {string} event - Event name
   * @param {Function} listener - Callback function to remove
   * @returns {MCPClient} This instance for chaining
   */
  off(event, listener) {
    this._emitter.off(event, listener);
    return this;
  }

  /**
   * Remove all event listeners.
   * @returns {MCPClient} This instance for chaining
   */
  removeAllListeners() {
    this._emitter.removeAllListeners();
    return this;
  }

  /**
   * Make an HTTP POST request with mTLS support.
   * @private
   * @param {Object} requestBody - JSON-RPC request body
   * @returns {Promise<Object>} Response result
   */
  async _makeHttpPostRequest(requestBody) {
    // Wrap the entire request in AuthHandler.withRetry to handle 401/403 errors
    return this._authHandler.withRetry(async () => {
      const tlsOptions = this._authHandler.getTlsOptions();
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': this.protocolVersion,
        ...this._authHandler.getHeaders()
      };

      // Use fetch() for non-mTLS requests. guardedFetch enforces the SSRF
      // policy; this.url is operator config (not derived from responses), so
      // private-range blocks are relaxed — metadata/denylist still enforced.
      if (!tlsOptions) {
        const response = await guardedFetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody)
        }, { allowPrivateRanges: true });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
      }

      // Use https module for mTLS requests
      const urlObj = new URL(this.url);
      if (urlObj.protocol !== 'https:') {
        throw new Error('mTLS authentication requires HTTPS transport');
      }

      const body = JSON.stringify(requestBody);

      return new Promise((resolve, reject) => {
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': Buffer.byteLength(body)
          },
          ...tlsOptions
        };

        const req = https.request(options, (res) => {
          let data = '';

          res.on('data', (chunk) => {
            data += chunk.toString('utf8');
          });

          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
              return;
            }

            try {
              const result = JSON.parse(data);
              resolve(result);
            } catch (err) {
              reject(new Error(`Failed to parse response: ${err.message}`));
            }
          });
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.write(body);
        req.end();
      });
    });
  }

  /**
   * Send a JSON-RPC request.
   * @private
   * @param {string} method - Method name
   * @param {Object} params - Request parameters
   * @param {Object} [options]
   * @param {AbortSignal} [options.signal] - Cancels the pending request
   * @returns {Promise<Object>} Response result
   */
  async _request(method, params = {}, options = {}) {
    if (this.transport === 'stdio' && (!this._process || this._process.killed)) {
      throw new Error('Not connected');
    }

    const id = ++this._requestId;
    const signal = options.signal;
    let timeout = null;
    let abortHandler = null;

    const promise = new Promise((resolve, reject) => {
      const cleanup = () => {
        if (timeout !== null) clearTimeout(timeout);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      };

      this._pendingRequests.set(id, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });

      timeout = setTimeout(() => {
        const pending = this._pendingRequests.get(id);
        if (!pending) return;
        this._pendingRequests.delete(id);
        pending.reject(new Error(`Request timeout after ${this.timeout}ms`));
      }, this.timeout);

      abortHandler = () => {
        const pending = this._pendingRequests.get(id);
        if (!pending) return;
        this._pendingRequests.delete(id);
        const abortError = new Error(signal?.reason?.message || signal?.reason || 'Request aborted');
        abortError.name = 'AbortError';
        abortError.code = 'ABORT_ERR';
        pending.reject(abortError);
        this._sendCancellationNotification(id, abortError.message);
      };
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      }
    });

    if (signal?.aborted) return promise;

    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    if (this.transport === 'stdio') {
      try {
        this._process.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        const pending = this._pendingRequests.get(id);
        this._pendingRequests.delete(id);
        pending?.reject(err);
      }
    } else if (this.transport === 'http') {
      // Fire-and-forget: resolve/reject the promise via pending handlers.
      // Errors are forwarded through pending.reject() so the timeout is always cancelled.
      this._makeHttpPostRequest(request)
        .then((rawResult) => {
          const pending = this._pendingRequests.get(id);
          if (pending) {
            this._pendingRequests.delete(id);
            
            // Validate the response structure
            const validation = ResponseValidator.validateJSONRPC(rawResult, {
              strict: true,
              validateResult: true,
              expectedMethod: method
            });

            if (!validation.valid) {
              // Attempt recovery for malformed responses
              const recovery = ResponseValidator.attemptRecovery(rawResult);
              
              if (recovery.success && method === 'tools/call') {
                // Recovery successful for tool call - log warning and proceed
                log.warn({ 
                  validationErrors: validation.errors,
                  recoveryStrategy: recovery.strategy,
                  method 
                }, 'Recovered from malformed response');
                pending.resolve(recovery.data);
              } else if (validation.canProceed && rawResult.error) {
                // Can proceed with error
                pending.reject(rawResult.error);
              } else {
                // Cannot proceed - create detailed MalformedResponseError
                const error = MalformedResponseError.fromProtocolViolation(
                  validation.errors[0].message,
                  rawResult,
                  {
                    method,
                    validationErrors: validation.errors,
                    validationDetails: validation
                  }
                );
                pending.reject(error);
              }
            } else if (rawResult.error) {
              pending.reject(rawResult.error);
            } else {
              pending.resolve(rawResult.result);
            }
          }
        })
        .catch((err) => {
          const pending = this._pendingRequests.get(id);
          if (pending) {
            this._pendingRequests.delete(id);
            pending.reject(err);
          }
        });
    }

    return promise;
  }

  /** Best-effort MCP cancellation for a request that has already been sent. */
  _sendCancellationNotification(requestId, reason) {
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId, reason },
    };
    try {
      if (this.transport === 'stdio') {
        if (this._process && !this._process.killed) {
          this._process.stdin.write(JSON.stringify(notification) + '\n');
        }
      } else if (this.transport === 'http') {
        this._makeHttpPostRequest(notification).catch(err => {
          log.debug({ err: err.message, requestId }, 'MCP cancellation notification failed');
        });
      }
    } catch (err) {
      log.debug({ err: err.message, requestId }, 'MCP cancellation notification failed');
    }
  }

  /**
   * Connect to the MCP server and initialize.
   * @returns {Promise<Object>} Initialization result
   */
  async connect() {
    if (this._connected && this._initialized) {
      log.debug('Already connected and initialized');
      return { connected: true };
    }

    try {
      if (this.transport === 'stdio') {
        if (!this._process || this._process.killed) {
          this._setupStdio();
        }
      }

      const result = await this.initialize();
      this._initialized = true;
      this._reconnectAttempts = 0;
      this._setConnected(true);
      this._toolCache.clear(); // Clear cache on successful connection/reconnection

      // Establish SSE connection for HTTP transport to receive server-to-client messages
      if (this.transport === 'http') {
        await this._connectSSE();
      }

      return result;
    } catch (err) {
      log.error({ err }, 'Failed to connect');
      this._setConnected(false);
      throw err;
    }
  }

  /**
   * Initialize connection with MCP server.
   * @returns {Promise<Object>} Server capabilities and protocol info
   */
  async initialize() {
    if (this._initializing) {
      throw new Error('Already initializing');
    }

    this._initializing = true;

    try {
      const result = await this._request('initialize', {
        protocolVersion: this.protocolVersion,
        capabilities: {
          sampling: {},
          experimental: {}
        },
        clientInfo: {
          name: 'synapse-mcp-client',
          version: '1.0.0'
        }
      });

      log.info({ serverInfo: result.serverInfo, capabilities: result.capabilities }, 'MCP server initialized');
      return result;
    } finally {
      this._initializing = false;
    }
  }

  /**
   * List available tools from the MCP server.
   * @returns {Promise<Array<Object>} Array of tool definitions
   */
  async listTools() {
    if (!this._initialized) {
      await this.connect();
    }

    let result;
    try {
      result = await retry(() => this._request('tools/list'), this._retryOptions);
      // Clear existing tools in cache and populate with fresh data
      this._toolCache.clear();
      
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      tools.forEach(tool => {
        if (tool && tool.name) {
          this._toolCache.set(tool.name, tool);
        }
      });
      this._tools = tools;
      
      if (!Array.isArray(result?.tools) && result?.tools !== undefined) {
        log.warn({ actual: typeof result.tools }, 'Server returned non-array tools list');
        // If it was supposed to be tools but isn't an array, we might want to throw if in strict mode,
        // but for now we'll just treat it as empty tools and log a warning.
        // Actually, let's throw if it's not an array to be consistent with MalformedResponseError.
        throw new MalformedResponseError('tools/list result.tools must be an array', {
          method: 'tools/list',
          expected: 'Array',
          actual: typeof result.tools
        });
      }
    } catch (err) {
      log.warn({ err }, 'Failed to fetch tools from server, attempting to use cached tools.');
      // If server request fails, attempt to load from cache (offline mode)
      this._tools = this._toolCache.getAllTools();
      if (this._tools.length === 0) {
        const message = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
        throw new Error(`No tools available from server or cache. Discovery failed with: ${message}`);
      }
      log.info({ count: this._tools.length }, 'Tools loaded from cache (offline mode).');
      return this._tools; // Return cached tools directly
    }

    // Block #5: this method is called on every reconnect cycle (~5s). Logging
    // the full 14-tool array each time floods the operator's log with
    // identical lines. Only log when the discovered tool SET differs from
    // the previous discovery — that's the actually-interesting event.
    const toolNames = this._tools.map(t => t.name).sort().join(',');
    if (toolNames !== this._lastLoggedToolNames) {
      log.info({ count: this._tools.length, tools: this._tools.map(t => t.name) }, 'Tools discovered');
      this._lastLoggedToolNames = toolNames;
    } else {
      log.debug({ count: this._tools.length }, 'Tools rediscovered (unchanged)');
    }
    return this._tools;
  }

  /**
   * Get metadata for a specific tool.
   * Returns normalized metadata including parameters array and requiredParameters.
   * @param {string} toolName - Name of the tool
   * @returns {Object|null} Tool metadata or null if not found
   */
  getToolMetadata(toolName) {
     if (typeof toolName !== 'string' || !toolName) {
       throw new TypeError('toolName must be a non-empty string');
     }

     const tool = this._tools.find(t => t.name === toolName);
     if (!tool) {
       return null;
     }

     const parameters = [];
     const requiredParameters = [];

     const normalizedSchema = tool.inputSchema || { type: 'object', properties: {} };
     if (!normalizedSchema.properties) {
       normalizedSchema.properties = {};
     }

     if (normalizedSchema.properties) {
       for (const [paramName, paramSchema] of Object.entries(normalizedSchema.properties)) {
         const required = normalizedSchema.required?.includes(paramName) || false;
         const param = {
           name: paramName,
           type: paramSchema.type || 'any',
           description: paramSchema.description || '',
           required
         };

         if (paramSchema.default !== undefined) param.default = paramSchema.default;
         if (Array.isArray(paramSchema.enum)) param.enum = paramSchema.enum;

         if (paramSchema.items) param.items = paramSchema.items;
         if (paramSchema.properties) param.properties = paramSchema.properties;
         if (paramSchema.anyOf) param.anyOf = paramSchema.anyOf;
         if (paramSchema.allOf) param.allOf = paramSchema.allOf;
         if (paramSchema.oneOf) param.oneOf = paramSchema.oneOf;
         if (paramSchema.format) param.format = paramSchema.format;
         if (paramSchema.minimum !== undefined) param.minimum = paramSchema.minimum;
         if (paramSchema.maximum !== undefined) param.maximum = paramSchema.maximum;
         if (paramSchema.minLength !== undefined) param.minLength = paramSchema.minLength;
         if (paramSchema.maxLength !== undefined) param.maxLength = paramSchema.maxLength;
         if (paramSchema.pattern) param.pattern = paramSchema.pattern;
         if (paramSchema.minItems !== undefined) param.minItems = paramSchema.minItems;
         if (paramSchema.maxItems !== undefined) param.maxItems = paramSchema.maxItems;
         if (paramSchema.uniqueItems) param.uniqueItems = paramSchema.uniqueItems;
         if (paramSchema.const !== undefined) param.const = paramSchema.const;
         if (paramSchema.$ref) param.$ref = paramSchema.$ref;
         if (paramSchema.$defs) param.$defs = paramSchema.$defs;
         if (paramSchema.definitions) param.definitions = paramSchema.definitions;

         parameters.push(param);
         if (required) {
           requiredParameters.push(paramName);
         }
       }
     }

     return {
       name: tool.name,
       description: tool.description || '',
       inputSchema: normalizedSchema,
       parameters,
       requiredParameters,
       capabilities: tool.annotations || tool.capabilities || {}
     };
   }

  /**
   * List all tools with normalized metadata.
   * @returns {Promise<Array<Object>>} Array of tools with metadata
   */
  async listToolsWithMetadata() {
    let toolsFromCache = this._toolCache.getAllTools();
    if (toolsFromCache.length === 0) {
      // If cache is empty, try to fetch from server (which will also populate the cache)
      await this.listTools();
      toolsFromCache = this._toolCache.getAllTools();
    }

    return toolsFromCache.map(tool => this.getToolMetadata(tool.name));
  }

  /**
   * Call a tool on the MCP server.
   * @param {string} name - Tool name
   * @param {Object} arguments_ - Tool arguments
   * @param {Object} [options]
   * @param {AbortSignal} [options.signal] - Cancels the tool request
   * @returns {Promise<Object>} Tool result
   */
  async callTool(name, arguments_ = {}, options = {}) {
    if (!this._initialized) {
      await this.connect();
    }

    const rawResult = await this._request('tools/call', {
      name,
      arguments: arguments_
    }, options);

    // Validate tool result structure
    const validation = ResponseValidator.validateToolResult(rawResult);
    
    if (!validation.valid) {
      // Attempt auto-recovery
      const recovery = ResponseValidator.attemptRecovery(rawResult);
      
      if (recovery.success) {
        log.warn({ 
          toolName: name,
          validationErrors: validation.errors,
          recoveryStrategy: recovery.strategy 
        }, 'Recovered from malformed tool result');
        log.info({ name, result: recovery.data }, 'Tool called (recovered)');
        return recovery.data;
      }

      // Cannot recover - throw detailed error
      throw MalformedResponseError.fromInvalidContentStructure(
        rawResult,
        validation.errors[0].message,
        {
          method: 'tools/call',
          toolName: name
        }
      );
    }

    log.info({ name, result: rawResult }, 'Tool called');
    return rawResult;
  }

  /**
   * Invoke a tool with streaming support, yielding chunks as they arrive.
   * 
   * For stdio transport: Uses the tools/call/chunk notification mechanism.
   * For HTTP transport: Uses SSE for streaming chunks.
   *
   * @param {string} name - Tool name
   * @param {Object} arguments_ - Tool arguments
   * @param {Object} options - Streaming options
   * @param {number} [options.timeout] - Timeout in ms for the stream (defaults to client timeout)
   * @yields {Object} Chunk objects with { data, index, status?, error?, final? }
   * @returns {AsyncGenerator<Object, void, void>}
   */
  async *invokeStreaming(name, arguments_ = {}, options = {}) {
    if (!this._initialized) {
      await this.connect();
    }

    const streamId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const timeout = options.timeout || this.timeout;

    const chunks = [];
    let completed = false;
    let errored = false;

    // Set up chunk collection via notification handler
    const chunkHandler = (params) => {
      if (params.streamId === streamId) {
        chunks.push(params);
      }
    };

    this.onNotification('tools/call/chunk', chunkHandler);

    try {
      // Start the tool call with streaming metadata
      const callPromise = this._request('tools/call', {
        name,
        arguments: arguments_,
        _meta: {
          streaming: true,
          streamId
        }
      });

      // Set up timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new TimeoutError(`Stream timeout after ${timeout}ms`, { timeoutMs: timeout })), timeout);
      });

      // Race between call completion and timeout
      const callWithTimeout = Promise.race([callPromise, timeoutPromise]);

      // Yield chunks until completion
      while (!completed && !errored) {
        // Check if we have chunks to yield
        if (chunks.length > 0) {
          const chunk = chunks.shift();
          
          // Check for error chunk
          if (chunk.status === 'error') {
            errored = true;
            yield {
              status: 'partial',
              error: chunk.error || 'Stream error',
              chunks: chunks.slice()
            };
            continue;
          }

          yield chunk;

          // Check if this is the final chunk
          if (chunk.final) {
            completed = true;
          }
        } else {
          // No chunks available, wait for the call to complete or timeout
          try {
            await callWithTimeout;
            // After call completes, check if we have any remaining chunks to process
            if (!completed && !errored && chunks.length > 0) {
              // Process remaining chunks
              while (chunks.length > 0 && !completed && !errored) {
                const chunk = chunks.shift();
                if (chunk.status === 'error') {
                  errored = true;
                  yield {
                    status: 'partial',
                    error: chunk.error || 'Stream error',
                    chunks: chunks.slice()
                  };
                  continue;
                }
                yield chunk;
                if (chunk.final) {
                  completed = true;
                }
              }
            }
            // If still not completed after processing all chunks, treat as abnormal termination
            if (!completed && !errored) {
              completed = true;
              yield {
                status: 'partial',
                error: 'Stream terminated without final chunk',
                chunks: chunks.slice()
              };
            }
          } catch (err) {
            // Timeout or error - first yield any remaining chunks, then yield partial error
            if (!errored) {
              // Yield any remaining chunks before the error
              while (chunks.length > 0) {
                const chunk = chunks.shift();
                if (chunk.status === 'error') {
                  errored = true;
                  yield {
                    status: 'partial',
                    error: chunk.error || 'Stream error',
                    chunks: chunks.slice()
                  };
                  continue;
                }
                yield chunk;
                if (chunk.final) {
                  completed = true;
                }
              }
              // Then yield the error
              yield {
                status: 'partial',
                error: err.message || 'Stream terminated',
                chunks: chunks.slice()
              };
            }
            break;
          }
        }
      }

    } catch (err) {
      // Handle unexpected errors
      if (!errored) {
        yield {
          status: 'partial',
          error: err.message || 'Unexpected error',
          chunks: chunks.slice()
        };
      }
    } finally {
      this.offNotification('tools/call/chunk', chunkHandler);
    }
  }

  /**
   * Collect chunks from a streaming invocation into a single result.
   * 
   * For string data: concatenates all chunks
   * For object data: returns the last chunk value
   * 
   * @param {AsyncGenerator} stream - Stream from invokeStreaming()
   * @returns {Promise<Object>} Collected result with { data, chunks, status, error? }
   */
  async collect(stream) {
    const chunks = [];
    let lastData = null;
    let isStringStream = false;
    let collectedString = '';
    let error = null;
    let status = 'complete';

    try {
      for await (const chunk of stream) {
        chunks.push(chunk);

        if (chunk.status === 'partial' && chunk.error) {
          status = 'partial';
          error = chunk.error;
          break;
        }

        if (chunk.data !== undefined) {
          lastData = chunk.data;
          
          // Determine if this is a string stream on first chunk
          if (chunks.length === 1) {
            isStringStream = typeof chunk.data === 'string';
          }

          // Accumulate strings, keep last object
          if (isStringStream) {
            collectedString += chunk.data;
          }
        }
      }
    } catch (err) {
      status = 'partial';
      error = err.message || 'Collection error';
    }

    return {
      data: isStringStream ? collectedString : lastData,
      chunks,
      status,
      ...(error && { error })
    };
  }

/**
    * Ping the MCP server to check connection health.
    * @returns {Promise<Object>} Ping response
    */
   async ping() {
     try {
       const result = await this._request('ping');
       this._lastPing = Date.now();
       return result;
     } catch (err) {
       this._emit(MCPClientEvents.HEARTBEAT_FAILURE, { error: err, lastPing: this._lastPing });
       throw err;
     }
   }

  /**
   * Get connection health status.
   * @returns {Object} Health status object
   */
  getHealth() {
    const isHealthy = this._connected && this._initialized;
    const lastPingAge = this._lastPing ? Date.now() - this._lastPing : null;

    return {
      connected: this._connected,
      initialized: this._initialized,
      healthy: isHealthy,
      transport: this.transport,
      lastPing: this._lastPing,
      lastPingAge,
      reconnectAttempts: this._reconnectAttempts
    };
  }

  /**
   * Get the auth handler for testing purposes.
   * @returns {AuthHandler} Auth handler instance
   */
  get authHandler() {
    return this._authHandler;
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this.transport === 'stdio' && this._process) {
      this._process.kill('SIGTERM');
      this._process = null;
    }

    if (this.transport === 'http' && this._sseConnection) {
      this._sseConnection.destroy();
      this._sseConnection = null;
    }

    // Reject all pending requests to cancel their timeouts
    for (const [, pending] of this._pendingRequests) {
      pending.reject(new Error('Disconnected'));
    }
    this._pendingRequests.clear();
    this._setConnected(false);
    this._initialized = false;
    log.info('Disconnected');
  }

  /**
   * Register a handler for server-to-client notifications.
   * @param {string} method - Notification method name
   * @param {Function} handler - Handler function that receives params
   */
  onNotification(method, handler) {
    if (!this._notificationHandlers.has(method)) {
      this._notificationHandlers.set(method, []);
    }
    this._notificationHandlers.get(method).push(handler);
    log.debug({ method }, 'Registered notification handler');
  }

  /**
   * Unregister a notification handler.
   * @param {string} method - Notification method name
   * @param {Function} handler - Handler function to remove
   */
  offNotification(method, handler) {
    const handlers = this._notificationHandlers.get(method);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
      if (handlers.length === 0) {
        this._notificationHandlers.delete(method);
      }
    }
  }

  /**
   * Register a handler for server-to-client requests.
   * @param {string} method - Request method name
   * @param {Function} handler - Async handler function that receives params and returns result
   */
  onServerRequest(method, handler) {
    this._serverRequestHandlers.set(method, handler);
    log.debug({ method }, 'Registered server request handler');
  }

  /**
   * Unregister a server request handler.
   * @param {string} method - Request method name
   */
  offServerRequest(method) {
    this._serverRequestHandlers.delete(method);
  }

  /**
   * Get the last event ID received from SSE stream (for resumability).
   * @returns {string|null} Last event ID
   */
  getLastEventId() {
    return this._sseLastEventId;
  }
}

// Re-export error classes and validators for consumers
export { 
  ConnectionError, 
  TimeoutError, 
  ProtocolError, 
  AuthenticationError, 
  MCPError, 
  MalformedResponseError, 
  DiscoveryError,
  ResponseValidator 
} from './errors.js';
