import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { createLogger } from '../../logger.js';

const log = createLogger('mcp-stdio-transport');

/**
 * StdioTransport — Communicates with MCP servers via stdio.
 *
 * Spawns a child process and communicates via stdin/stdout using
 * newline-delimited JSON-RPC messages.
 *
 * Emits:
 * - 'message' (data) - When a JSON-RPC message is received
 * - 'error' (err) - When an error occurs
 * - 'close' (code, signal) - When the process exits
 *
 * Usage:
 *   const transport = new StdioTransport({ command: 'node', args: ['server.js'] });
 *   transport.on('message', (msg) => console.log(msg));
 *   transport.send({ jsonrpc: '2.0', method: 'initialize', id: 1 });
 */
export class StdioTransport extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.command - Command to spawn
   * @param {string[]} [options.args] - Command arguments
   */
  constructor(options = {}) {
    super();

    if (!options.command) {
      throw new TypeError('command option is required');
    }

    this.command = options.command;
    this.args = options.args || [];

    this._process = null;
    this._readline = null;
    this._connected = false;
    this._buffer = '';
  }

  /**
   * Start the child process and set up communication.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._connected) {
      log.debug('Already connected');
      return;
    }

    try {
      // Spawn the child process
      this._process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      log.info({ command: this.command, args: this.args, pid: this._process.pid }, 'Child process spawned');

      // Set up readline interface for line-based JSON parsing
      this._readline = createInterface({
        input: this._process.stdout,
        terminal: false
      });

      // Handle incoming messages (newline-delimited JSON)
      this._readline.on('line', (line) => {
        this._handleLine(line);
      });

      // Handle stderr output (logging from child process)
      this._process.stderr.on('data', (data) => {
        const stderr = data.toString('utf8').trim();
        if (stderr) {
          log.debug({ stderr, pid: this._process.pid }, 'Child process stderr');
        }
      });

      // Handle process exit
      this._process.on('exit', (code, signal) => {
        log.info({ code, signal, pid: this._process.pid }, 'Child process exited');
        this._connected = false;
        this._cleanup();
        this.emit('close', code, signal);
      });

      // Handle process errors
      this._process.on('error', (err) => {
        log.error({ err, command: this.command, args: this.args }, 'Child process error');
        this._connected = false;
        this._cleanup();
        this.emit('error', err);
      });

      // Mark as connected once process is spawned
      this._connected = true;
    } catch (err) {
      log.error({ err, command: this.command }, 'Failed to spawn child process');
      this._cleanup();
      throw err;
    }
  }

  /**
   * Handle a line of input from the child process.
   * @private
   * @param {string} line - Raw line from stdout
   */
  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return; // Skip empty lines
    }

    try {
      const message = JSON.parse(trimmed);
      log.debug({ message }, 'Received message');
      this.emit('message', message);
    } catch (err) {
      log.warn({ line: trimmed, err }, 'Failed to parse JSON message');
      this.emit('error', new Error(`JSON parse error: ${err.message}`));
    }
  }

  /**
   * Send a JSON-RPC message to the child process.
   * @param {Object} message - JSON-RPC message object
   * @returns {boolean} True if sent successfully
   */
  send(message) {
    if (!this._connected || !this._process || this._process.killed) {
      log.error('Cannot send message: not connected');
      return false;
    }

    try {
      const line = JSON.stringify(message) + '\n';
      const written = this._process.stdin.write(line);

      if (!written) {
        log.warn('Write buffer full, message queued');
      }

      log.debug({ message }, 'Sent message');
      return true;
    } catch (err) {
      log.error({ err, message }, 'Failed to send message');
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Close the connection and terminate the child process.
   * @param {string} [signal='SIGTERM'] - Signal to send to child process
   */
  close(signal = 'SIGTERM') {
    if (!this._connected) {
      log.debug('Already disconnected');
      return;
    }

    log.info({ signal, pid: this._process?.pid }, 'Closing connection');

    if (this._process && !this._process.killed) {
      this._process.kill(signal);
    }

    this._cleanup();
  }

  /**
   * Clean up resources.
   * @private
   */
  _cleanup() {
    if (this._readline) {
      this._readline.close();
      this._readline = null;
    }

    this._connected = false;
    this._buffer = '';
  }

  /**
   * Check if the transport is connected.
   * @returns {boolean}
   */
  isConnected() {
    return this._connected && this._process && !this._process.killed;
  }

  /**
   * Get the child process PID.
   * @returns {number|null}
   */
  getPid() {
    return this._process?.pid || null;
  }
}
