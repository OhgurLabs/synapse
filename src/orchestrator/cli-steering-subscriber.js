import { createLogger } from '../logger.js';

const log = createLogger('cli-steering-subscriber');

const PROPAGATION_LATENCY_THRESHOLD_MS = 2000;
const LATENCY_RECOVERY_WINDOW_MS = 30000;

export class CliSteeringSubscriber {
  constructor(options = {}) {
    this.baseUri = options.baseUri || process.env.SYNAPSE_STEERING_URL || 'ws://localhost:8080';
    this.sseEndpoint = `${this.baseUri.replace('ws://', 'http://').replace('wss://', 'https://')}/api/steering/stream`;
    this.enabled = options.enabled ?? true;
    this.reconnectDelay = 5000;
    this.keepaliveInterval = 15000;
    this.lastEventId = null;
    this.latencyWindows = [];
    this.fallbackPollActive = false;
    this.fallbackTimer = null;
    this.recoveryTimer = null;
    this.pollInterval = 2000;
    this.lastSeenEventId = null;
    this.connected = false;
    this.subscribed = false;
    this.onEvent = options.onEvent || (() => {});
    this.onLatencyWarning = options.onLatencyWarning || (() => {});
    this.onLatencyRecovered = options.onLatencyRecovered || (() => {});
    this.onConnected = options.onConnected || (() => {});
    this.onDisconnected = options.onDisconnected || (() => {});
    this.sseEventSource = null;
    this.pollTimer = null;
  }

  connect() {
    if (!this.enabled) {
      log.warn('CLI steering subscriber disabled');
      return;
    }

    log.info(`Connecting to steering stream at ${this.sseEndpoint}`);
    this.connected = false;
    this.subscribed = false;
    this._connectSSE();
  }

  _connectSSE() {
    this._cleanup();

    if (typeof EventSource === 'undefined') {
      log.error('EventSource not available, falling back to polling');
      this._startPolling();
      return;
    }

    const url = this.sseEndpoint;
    this.sseEventSource = new EventSource(url);

    this.sseEventSource.onopen = (event) => {
      log.info('SSE connection opened');
      this.connected = true;
      this._resetLatencyTracking();
      this.onConnected();
    };

    this.sseEventSource.onmessage = (event) => {
      this.lastEventId = event.lastEventId || this.lastEventId;
      
      try {
        const data = JSON.parse(event.data);
        this._handleSSEEvent(data, event);
      } catch (err) {
        log.error('Failed to parse SSE event', err);
      }
    };

    this.sseEventSource.onerror = (error) => {
      log.error('SSE connection error', error);
      this.connected = false;
      this._cleanup();
      
      if (this.sseEventSource) {
        this.sseEventSource.close();
        this.sseEventSource = null;
      }
      
      this.onDisconnected();
      
      setTimeout(() => this._connectSSE(), this.reconnectDelay);
    };
  }

  _handleSSEEvent(data, sseEvent) {
    if (data.type !== 'operator:action' && !data.type?.startsWith('steering:')) {
      return;
    }

    const serverTimestamp = data.timestamp || data.serverTimestamp || Date.now();
    const receiveTimestamp = Date.now();
    const latency = receiveTimestamp - serverTimestamp;

    this._trackLatency(latency);

    const steeringEvent = {
      type: data.type,
      actionId: data.actionId || data.action_id,
      correlationId: data.correlationId || data.correlation_id,
      actor: data.actor,
      actionType: data.actionType || data.action_type,
      payload: data.payload || data.data,
      projectId: data.projectId || data.project_id,
      channelId: data.channelId || data.channel_id,
      serverTimestamp,
      receiveTimestamp,
      propagationLatency: latency,
    };

    this.onEvent(steeringEvent);

    if (data.actionId || data.action_id) {
      this.lastSeenEventId = data.actionId || data.action_id;
    }
  }

  _trackLatency(latency) {
    this.latencyWindows.push({ latency, timestamp: Date.now() });
    
    const MAX_WINDOWS = 100;
    if (this.latencyWindows.length > MAX_WINDOWS) {
      this.latencyWindows.shift();
    }

    const p95Latency = this._calculateP95();
    
    if (p95Latency > PROPAGATION_LATENCY_THRESHOLD_MS && !this.fallbackPollActive) {
      this._activateFallback();
    } else if (p95Latency <= PROPAGATION_LATENCY_THRESHOLD_MS && this.fallbackPollActive) {
      this._checkRecovery();
    }
  }

  _calculateP95() {
    if (this.latencyWindows.length === 0) return 0;
    
    const sorted = [...this.latencyWindows].map(w => w.latency).sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, index)] || 0;
  }

  _resetLatencyTracking() {
    this.latencyWindows = [];
    this.lastEventId = null;
    this.lastSeenEventId = null;
  }

  _activateFallback() {
    if (this.fallbackPollActive) return;
    
    this.fallbackPollActive = true;
    log.warn(`Propagation latency degraded (p95: ${this._calculateP95()}ms), activating fallback polling`);
    
    this.onLatencyWarning(this._calculateP95());
    
    this._startPolling();
  }

  _checkRecovery() {
    if (this.recoveryTimer) return;
    
    log.info('Latency recovered below threshold, starting recovery timer');
    
    this.recoveryTimer = setTimeout(() => {
      this._deactivateFallback();
      this.recoveryTimer = null;
    }, LATENCY_RECOVERY_WINDOW_MS);
  }

  _deactivateFallback() {
    if (!this.fallbackPollActive) return;
    
    this.fallbackPollActive = false;
    this._stopPolling();
    
    log.info('Fallback polling deactivated, resumed live streaming');
    this.onLatencyRecovered();
  }

  _startPolling() {
    if (this.pollTimer) return;
    
    log.info('Starting fallback reconciliation polling');
    
    this.pollTimer = setInterval(() => {
      this._pollForEvents();
    }, this.pollInterval);
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async _pollForEvents() {
    try {
      const url = this.lastSeenEventId 
        ? `${this.sseEndpoint}?since=${this.lastSeenEventId}`
        : this.sseEndpoint;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Polling failed: ${response.status}`);
      }
      
      const text = await response.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.substring(5).trim());
            this._handleSSEEvent(data, { lastEventId: this.lastEventId });
          } catch (err) {
            log.error('Failed to parse polled event', err);
          }
        }
      }
    } catch (err) {
      log.error('Polling error', err);
    }
  }

  _cleanup() {
    if (this.sseEventSource) {
      this.sseEventSource.close();
      this.sseEventSource = null;
    }
    
    this._stopPolling();
    
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  disconnect() {
    log.info('Disconnecting CLI steering subscriber');
    this._cleanup();
    this.connected = false;
    this.subscribed = false;
  }

  formatEvent(steeringEvent) {
    const time = new Date(steeringEvent.receiveTimestamp).toLocaleTimeString();
    const latency = steeringEvent.propagationLatency;
    const latencyStr = latency > PROPAGATION_LATENCY_THRESHOLD_MS 
      ? `${latency}ms ⚠️` 
      : `${latency}ms`;
    
    const lines = [
      `🎯 [${time}] ${steeringEvent.actionType.toUpperCase()}`,
      `   Correlation ID: ${steeringEvent.correlationId || 'N/A'}`,
      `   Action ID: ${steeringEvent.actionId || 'N/A'}`,
      `   Actor: ${steeringEvent.actor || 'system'}`,
      `   Latency: ${latencyStr}`,
    ];
    
    if (steeringEvent.payload) {
      const payloadStr = JSON.stringify(steeringEvent.payload, null, 2)
        .split('\n')
        .map(line => `   ${line}`)
        .join('\n');
      lines.push(`   Payload:\n${payloadStr}`);
    }
    
    return lines.join('\n');
  }

  formatLatencyWarning(p95Latency) {
    return `⚠️  Propagation latency degraded (p95: ${Math.round(p95Latency)}ms). Fallback polling active.`;
  }

  formatLatencyRecovered() {
    return `✅ Propagation latency recovered. Resumed live streaming.`;
  }

  getStatus() {
    return {
      connected: this.connected,
      fallbackActive: this.fallbackPollActive,
      latencyP95: this._calculateP95(),
      eventsReceived: this.latencyWindows.length,
    };
  }
}

export function createCliSteeringSubscriber(options = {}) {
  return new CliSteeringSubscriber(options);
}