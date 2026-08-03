/**
 * Syslog Forwarder — RFC 5424 compliant forwarding of timeline events to syslog receivers.
 *
 * Supports UDP, TCP, and TLS transports. Maps Synapse timeline event types to
 * appropriate syslog severity levels. Handles connection failures gracefully with
 * a configurable drop-on-failure policy.
 *
 * RFC 5424 PRI = (facility * 8) + severity
 * Facility 16 = local0 (commonly used for application logs)
 */

import dgram from 'dgram';
import net from 'net';
import tls from 'tls';
import fs from 'fs';
import os from 'os';

// RFC 5424 severity levels
export const SYSLOG_SEVERITY = {
  EMERGENCY: 0,  // System is unusable
  ALERT:     1,  // Action must be taken immediately
  CRITICAL:  2,  // Critical conditions
  ERROR:     3,  // Error conditions
  WARNING:   4,  // Warning conditions
  NOTICE:    5,  // Normal but significant condition
  INFO:      6,  // Informational messages
  DEBUG:     7,  // Debug-level messages
};

// RFC 5424 facility codes
export const SYSLOG_FACILITY = {
  KERN:   0,
  USER:   1,
  MAIL:   2,
  DAEMON: 3,
  AUTH:   4,
  SYSLOG: 5,
  LPR:    6,
  NEWS:   7,
  UUCP:   8,
  CRON:   9,
  LOCAL0: 16,
  LOCAL1: 17,
  LOCAL2: 18,
  LOCAL3: 19,
  LOCAL4: 20,
  LOCAL5: 21,
  LOCAL6: 22,
  LOCAL7: 23,
};

/**
 * Map a Synapse timeline event to an RFC 5424 severity level.
 * @param {object} event - Timeline event with type and optional data fields.
 * @returns {number} Syslog severity level (0–7).
 */
export function mapEventSeverity(event) {
  const type = event?.type;
  const data = event?.data || {};

  switch (type) {
    case 'circuit_breaker':
      // Opening the breaker is an error; half-open is a warning
      if (data.newState === 'open') return SYSLOG_SEVERITY.ERROR;
      if (data.newState === 'half_open') return SYSLOG_SEVERITY.WARNING;
      return SYSLOG_SEVERITY.INFO;  // closed = recovery

    case 'anomaly_alert': {
      const sev = data.severity;
      if (sev === 'critical') return SYSLOG_SEVERITY.CRITICAL;
      if (sev === 'high')     return SYSLOG_SEVERITY.ERROR;
      if (sev === 'medium')   return SYSLOG_SEVERITY.WARNING;
      return SYSLOG_SEVERITY.NOTICE;
    }

    case 'sla_breach':
      return SYSLOG_SEVERITY.ERROR;

    case 'error_propagation':
      return SYSLOG_SEVERITY.ERROR;

    case 'error_pattern_constraint':
      return SYSLOG_SEVERITY.WARNING;

    case 'error_constraint_recommendation':
      return SYSLOG_SEVERITY.WARNING;

    case 'task_rejected':
      return SYSLOG_SEVERITY.WARNING;

    case 'sla_resolved':
      return SYSLOG_SEVERITY.NOTICE;

    case 'error_constraint_expired':
      return SYSLOG_SEVERITY.NOTICE;

    case 'operator_action':
    case 'operator_replay':
    case 'operator_steer':
      return SYSLOG_SEVERITY.NOTICE;

    case 'dispatch':
      if (data.outcome === 'failure') return SYSLOG_SEVERITY.WARNING;
      return SYSLOG_SEVERITY.INFO;

    default:
      return SYSLOG_SEVERITY.INFO;
  }
}

/**
 * Format a Synapse timeline event as an RFC 5424 syslog message string.
 *
 * Format: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
 *
 * @param {object} event   - Timeline event object.
 * @param {object} options - Formatting options.
 * @param {number} [options.facility=SYSLOG_FACILITY.LOCAL0] - Syslog facility code.
 * @param {string} [options.hostname]  - Hostname to embed (defaults to os.hostname()).
 * @param {string} [options.appName]   - Application name tag (default: 'synapse').
 * @param {string} [options.procId]    - Process ID string (default: process.pid).
 * @returns {string} RFC 5424 formatted syslog message (no trailing newline).
 */
export function formatSyslogMessage(event, options = {}) {
  const facility = options.facility ?? SYSLOG_FACILITY.LOCAL0;
  const severity = mapEventSeverity(event);
  const pri = facility * 8 + severity;

  const version   = 1;
  const timestamp = event.timestamp || new Date().toISOString();
  const hostname  = options.hostname || os.hostname() || '-';
  const appName   = (options.appName || 'synapse').replace(/\s+/g, '_');
  const procId    = String(options.procId !== undefined ? options.procId : process.pid);
  const msgId     = (event.id || '-').replace(/\s+/g, '_');

  // Build STRUCTURED-DATA from correlationKeys
  let structuredData = '-';
  if (event.correlationKeys && typeof event.correlationKeys === 'object') {
    const pairs = Object.entries(event.correlationKeys)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}="${String(v).replace(/["\\]/g, '\\$&')}"`)
      .join(' ');
    if (pairs.length > 0) {
      structuredData = `[synapse@32473 ${pairs}]`;
    }
  }

  const msg = (event.summary || '').replace(/[\r\n]/g, ' ');

  return `<${pri}>${version} ${timestamp} ${hostname} ${appName} ${procId} ${msgId} ${structuredData} ${msg}`;
}

/**
 * SyslogForwarder — forwards Synapse timeline events to a syslog receiver.
 *
 * Config shape:
 * {
 *   host:     string,           // syslog receiver hostname/IP (required)
 *   port:     number,           // syslog receiver port (required)
 *   protocol: 'udp'|'tcp'|'tls', // transport (default: 'udp')
 *   facility: number,           // syslog facility (default: LOCAL0 = 16)
 *   appName:  string,           // application name tag (default: 'synapse')
 *   hostname: string,           // originator hostname (default: os.hostname())
 *   tlsOptions: object,         // passed to tls.connect() when protocol='tls'
 *   dropOnFailure: boolean,     // if true, swallow send errors (default: true)
 * }
 */
export class SyslogForwarder {
  constructor(config = {}) {
    if (!config.host) throw new Error('SyslogForwarder: config.host is required');
    if (!config.port) throw new Error('SyslogForwarder: config.port is required');

    this.host         = config.host;
    this.port         = config.port;
    this.protocol     = (config.protocol || 'udp').toLowerCase();
    this.facility     = config.facility ?? SYSLOG_FACILITY.LOCAL0;
    this.appName      = config.appName  || 'synapse';
    this.hostname     = config.hostname || os.hostname();
    this.tlsOptions   = config.tlsOptions || {};
    this.dropOnFailure = config.dropOnFailure !== false; // default true

    // For TCP/TLS we maintain a persistent socket; for UDP we create per-send.
    this._socket      = null;
    this._connecting  = false;
    this._queue       = [];   // buffered messages while connecting
    this._closed      = false;
  }

  /**
   * Forward a timeline event to the syslog receiver.
   * @param {object} event - Timeline event object.
   * @returns {Promise<void>}
   */
  async forward(event) {
    if (this._closed) {
      if (this.dropOnFailure) return;
      throw new Error('SyslogForwarder: forwarder is closed');
    }

    const message = formatSyslogMessage(event, {
      facility: this.facility,
      appName:  this.appName,
      hostname: this.hostname,
    });

    return this._send(message);
  }

  /**
   * Send a pre-formatted syslog message string.
   * @param {string} message
   * @returns {Promise<void>}
   */
  async _send(message) {
    if (this.protocol === 'udp') {
      return this._sendUdp(message);
    }
    return this._sendStream(message);
  }

  _sendUdp(message) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const buf    = Buffer.from(message + '\n', 'utf8');

      socket.send(buf, 0, buf.length, this.port, this.host, (err) => {
        socket.close();
        if (err) {
          if (this.dropOnFailure) return resolve();
          return reject(err);
        }
        resolve();
      });
    });
  }

  /**
   * Get or create a persistent TCP/TLS socket. Queues messages sent during
   * connection establishment and flushes them once connected.
   */
  _getOrCreateStreamSocket() {
    if (this._socket && !this._socket.destroyed) {
      return Promise.resolve(this._socket);
    }

    if (this._connecting) {
      return new Promise((resolve, reject) => {
        this._queue.push({ resolve, reject });
      });
    }

    this._connecting = true;
    return new Promise((resolve, reject) => {
      const connectOpts = { host: this.host, port: this.port, ...this.tlsOptions };
      const socket = this.protocol === 'tls'
        ? tls.connect(connectOpts)
        : net.connect(connectOpts);

      socket.once('connect', () => {
        this._socket = socket;
        this._connecting = false;
        // Drain waiting callers
        const waiting = this._queue.splice(0);
        for (const waiter of waiting) waiter.resolve(socket);
        resolve(socket);
      });

      socket.once('error', (err) => {
        this._socket = null;
        this._connecting = false;
        const waiting = this._queue.splice(0);
        for (const waiter of waiting) waiter.reject(err);
        reject(err);
      });

      socket.once('close', () => {
        this._socket = null;
      });
    });
  }

  async _sendStream(message) {
    let socket;
    try {
      socket = await this._getOrCreateStreamSocket();
    } catch (err) {
      if (this.dropOnFailure) return;
      throw err;
    }

    return new Promise((resolve, reject) => {
      socket.write(message + '\n', 'utf8', (err) => {
        if (err) {
          this._socket = null;
          if (this.dropOnFailure) return resolve();
          return reject(err);
        }
        resolve();
      });
    });
  }

  /**
   * Close the underlying socket (for TCP/TLS). Safe to call multiple times.
   */
  close() {
    this._closed = true;
    if (this._socket) {
      try { this._socket.destroy(); } catch (_) { /* ignore */ }
      this._socket = null;
    }
  }
}
