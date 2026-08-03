import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';
import { createLogger } from '../../logger.js';

const log = createLogger('mcp-http-transport');

/**
 * HttpTransport — Communicates with MCP servers via HTTP POST (+ optional SSE).
 *
 * Client-to-server messages are sent as JSON-RPC 2.0 POST requests.
 * POST responses are parsed and emitted as 'message' events.
 * If the server supports SSE, server-to-client notifications arrive via SSE stream.
 *
 * Emits:
 * - 'message' (data) - When a JSON-RPC message is received (from POST response or SSE)
 * - 'error' (err) - When an error occurs
 * - 'close' () - When the connection is closed
 *
 * Usage:
 *   const transport = new HttpTransport({ url: 'http://localhost:3001/mcp' });
 *   await transport.connect();
 *   transport.on('message', (msg) => console.log(msg));
 *   transport.send({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });
 */
export class HttpTransport extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.url - MCP server HTTP endpoint URL
   * @param {number} [options.timeout] - Request timeout in ms (default: 30000)
   * @param {number} [options.handshakeTimeout] - Timeout for connect probe in ms (default: 10000)
   * @param {string} [options.protocolVersion] - MCP protocol version header (default: '2024-11-05')
   * @param {boolean} [options.enableSSE] - Attempt SSE connection for server notifications (default: false)
   */
  constructor(options = {}) {
    super();

    if (!options.url) {
      throw new TypeError('url option is required');
    }

    this.url = options.url;
    this.timeout = options.timeout || 30000;
    this.handshakeTimeout = options.handshakeTimeout || 10000;
    this.protocolVersion = options.protocolVersion || '2024-11-05';
    this.enableSSE = options.enableSSE || false;

    this._connected = false;
    this._sseConnection = null;
    this._sseLastEventId = null;

    // SSE parsing state
    this._sseCurrentEventId = null;
    this._sseCurrentEventType = 'message';
    this._sseCurrentData = '';
    this._sseBuffer = '';
  }

  /**
   * Connect to the MCP server.
   *
   * Marks the transport as connected. The first send() call will verify
   * the server is reachable. If enableSSE is true, also opens an SSE stream
   * for server-to-client notifications.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._connected) {
      log.debug('Already connected');
      return;
    }

    // Verify the server is reachable with a lightweight probe
    await this._probe();

    this._connected = true;
    log.info({ url: this.url }, 'HTTP transport connected');

    // Optionally open SSE stream for server-to-client notifications
    if (this.enableSSE) {
      this._openSSE();
    }
  }

  /**
   * Probe the server to verify it's reachable.
   * Sends an empty POST and checks for a valid HTTP response.
   * @private
   * @returns {Promise<void>}
   */
  _probe() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Handshake timeout after ${this.handshakeTimeout}ms`));
      }, this.handshakeTimeout);

      const urlObj = new URL(this.url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // Send a JSON-RPC ping to verify the server accepts requests
      const body = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' });

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'MCP-Protocol-Version': this.protocolVersion
        },
        timeout: this.handshakeTimeout
      };

      const req = httpModule.request(options, (res) => {
        // Drain response body
        res.resume();
        clearTimeout(timer);

        if (res.statusCode >= 200 && res.statusCode < 500) {
          // Any non-server-error response means the server is reachable
          resolve();
        } else {
          reject(new Error(`Server probe failed: HTTP ${res.statusCode}`));
        }
      });

      req.on('timeout', () => {
        clearTimeout(timer);
        req.destroy();
        reject(new Error(`Handshake timeout after ${this.handshakeTimeout}ms`));
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Open an SSE connection for receiving server-to-client messages.
   * Failures are non-fatal — the transport remains connected for POST-based communication.
   * @private
   */
  _openSSE() {
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
        'MCP-Protocol-Version': this.protocolVersion
      }
    };

    if (this._sseLastEventId) {
      options.headers['Last-Event-ID'] = this._sseLastEventId;
    }

    const req = httpModule.request(options, (res) => {
      if (res.statusCode !== 200) {
        log.debug({ statusCode: res.statusCode }, 'SSE not supported by server, POST-only mode');
        res.resume();
        return;
      }

      log.info({ url: this.url }, 'SSE connection established');
      this._sseConnection = res;
      this._sseBuffer = '';

      res.on('data', (chunk) => {
        this._sseBuffer += chunk.toString('utf8');
        const lines = this._sseBuffer.split('\n');
        this._sseBuffer = lines.pop() || '';
        this._parseSSELines(lines);
      });

      res.on('end', () => {
        log.info('SSE connection closed by server');
        this._sseConnection = null;
      });

      res.on('error', (err) => {
        log.error({ err }, 'SSE stream error');
        this._sseConnection = null;
        this.emit('error', err);
      });
    });

    req.on('error', (err) => {
      log.debug({ err }, 'SSE connection failed, continuing in POST-only mode');
    });

    req.end();
  }

  /**
   * Parse SSE event lines.
   * @private
   * @param {Array<string>} lines
   */
  _parseSSELines(lines) {
    for (const line of lines) {
      if (line.length === 0) {
        if (this._sseCurrentData) {
          this._dispatchSSEEvent(
            this._sseCurrentEventType,
            this._sseCurrentData,
            this._sseCurrentEventId
          );
          this._sseCurrentEventId = null;
          this._sseCurrentEventType = 'message';
          this._sseCurrentData = '';
        }
        continue;
      }

      if (line.startsWith(':')) continue;

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const field = line.substring(0, colonIndex);
      let value = line.substring(colonIndex + 1);
      if (value.startsWith(' ')) value = value.substring(1);

      if (field === 'id') {
        this._sseCurrentEventId = value;
      } else if (field === 'event') {
        this._sseCurrentEventType = value;
      } else if (field === 'data') {
        this._sseCurrentData += (this._sseCurrentData ? '\n' : '') + value;
      }
    }
  }

  /**
   * Dispatch a completed SSE event as a 'message' emission.
   * @private
   */
  _dispatchSSEEvent(eventType, data, eventId) {
    if (eventId) {
      this._sseLastEventId = eventId;
    }

    try {
      const message = JSON.parse(data);
      log.debug({ eventType, message }, 'Received SSE message');
      this.emit('message', message);
    } catch (err) {
      log.warn({ data, err }, 'Failed to parse SSE event data as JSON');
      this.emit('error', new Error(`SSE JSON parse error: ${err.message}`));
    }
  }

  /**
   * Send a JSON-RPC message to the server via HTTP POST.
   *
   * For request messages (with id), the response is parsed and emitted as a 'message' event.
   * For notification messages (no id), the POST is fire-and-forget.
   *
   * @param {Object} message - JSON-RPC message object
   * @returns {boolean} True if send was initiated
   */
  send(message) {
    if (!this._connected) {
      log.error('Cannot send message: not connected');
      return false;
    }

    try {
      const body = JSON.stringify(message);
      const urlObj = new URL(this.url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'MCP-Protocol-Version': this.protocolVersion
        },
        timeout: this.timeout
      };

      const req = httpModule.request(options, (res) => {
        let responseBody = '';

        res.on('data', (chunk) => {
          responseBody += chunk.toString('utf8');
        });

        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            log.error({ statusCode: res.statusCode, body: responseBody }, 'HTTP POST error response');
            this.emit('error', new Error(`HTTP POST failed: ${res.statusCode}`));
            return;
          }

          // Parse response body for requests (messages with an id)
          if (message.id !== undefined && responseBody.trim()) {
            try {
              const response = JSON.parse(responseBody);
              log.debug({ response }, 'Received POST response');
              this.emit('message', response);
            } catch (err) {
              log.warn({ body: responseBody, err }, 'Failed to parse POST response as JSON');
              this.emit('error', new Error(`Response JSON parse error: ${err.message}`));
            }
          }
        });

        res.on('error', (err) => {
          log.error({ err }, 'POST response stream error');
          this.emit('error', err);
        });
      });

      req.on('timeout', () => {
        log.error({ timeout: this.timeout }, 'POST request timeout');
        req.destroy(new Error(`Request timeout after ${this.timeout}ms`));
      });

      req.on('error', (err) => {
        log.error({ err, method: message.method }, 'POST request error');
        this.emit('error', err);
      });

      req.write(body);
      req.end();

      log.debug({ method: message.method, id: message.id }, 'Sent POST message');
      return true;
    } catch (err) {
      log.error({ err, message }, 'Failed to send message');
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Close the connection.
   */
  close() {
    if (!this._connected) {
      log.debug('Already disconnected');
      return;
    }

    log.info({ url: this.url }, 'Closing connection');

    if (this._sseConnection) {
      this._sseConnection.destroy();
      this._sseConnection = null;
    }

    this._connected = false;
    this._sseBuffer = '';
    this._sseCurrentEventId = null;
    this._sseCurrentEventType = 'message';
    this._sseCurrentData = '';

    this.emit('close');
  }

  /**
   * Check if the transport is connected.
   * @returns {boolean}
   */
  isConnected() {
    return this._connected;
  }

  /**
   * Get the last SSE event ID (for resumability).
   * @returns {string|null}
   */
  getLastEventId() {
    return this._sseLastEventId;
  }
}
