// Agent performance scoreboard — tracks success/failure/duration per agent.
// Used by routeSubtask() as a tiebreaker when multiple agents match the same cost tier.
// Advisory data — not critical state, no CAS needed.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('analytics');

const WINDOW_SIZE = 100; // sliding window of last N outcomes per agent
const PERSIST_DEBOUNCE_MS = 30_000;

// Circuit breaker states
const STATES = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
};

export class AgentScoreboard {
  constructor(baseDir, eventBus = null) {
    this._path = join(baseDir, '.synapse', 'analytics.json');
    this._data = {}; // agentId → outcome[]
    this._dirty = false;
    this._persistTimer = null;
    this._eventBus = eventBus;
    
    this._load();
    
    // Subscribe to provider latency events for scorecard updates
    if (eventBus) {
      this._setupEventSubscriptions();
    }
  }

  _setupEventSubscriptions() {
    // Subscribe to individual provider latency events
    this._eventBus.on('provider_latency', (data) => {
      this._handleProviderLatency(data);
    });

    // Subscribe to aggregated provider latency events
    this._eventBus.on('provider_latency_aggregated', (data) => {
      this._handleAggregatedLatency(data);
    });

    // Subscribe to circuit breaker state transitions for scorecard visibility
    this._eventBus.on('circuit_breaker:open', (data) => {
      this._handleCircuitBreakerTransition(data);
    });

    this._eventBus.on('circuit_breaker:half_open', (data) => {
      this._handleCircuitBreakerTransition(data);
    });

    this._eventBus.on('circuit_breaker:closed', (data) => {
      this._handleCircuitBreakerTransition(data);
    });
  }

  _handleProviderLatency(data) {
    // Record provider latency for the agent that made the dispatch
    if (data.agentId && data.dispatchId) {
      const { provider, latencyMs, success, dispatchId } = data;
      this.record(provider, {
        success: success !== false,
        durationMs: latencyMs || 0,
        complexity: 'medium',
        provider: provider,
        dispatchId: dispatchId,
      });
    }
  }

  _handleAggregatedLatency(data) {
    // Update scorecard with aggregated provider metrics
    if (data.artifacts && Array.isArray(data.artifacts)) {
      for (const artifact of data.artifacts) {
        const { provider, percentiles } = artifact;
        if (provider && percentiles) {
          // Log provider health status for monitoring
          const p95 = percentiles.p95;
          if (p95 !== null) {
            if (p95 > 2000) {
              log.warn('Provider latency degraded', { provider, p95 });
            } else if (p95 > 1000) {
              log.info('Provider latency warning', { provider, p95 });
            }
          }
        }
      }
    }
  }

  _handleCircuitBreakerTransition(data) {
    // Record circuit breaker state transitions for scorecard visibility
    const { provider, agentId, state, previousState, failureCount, trigger, timestamp } = data;
    const key = agentId || provider;
    
    if (!key) return;

    // Ensure agent/provider entry exists
    if (!this._data[key]) {
      this._data[key] = [];
    }

    // Record circuit breaker transition as a special outcome
    this._data[key].push({
      success: state === STATES.CLOSED,
      durationMs: 0,
      complexity: 'medium',
      provider: provider || agentId,
      ts: typeof timestamp === 'number' ? timestamp : Date.now(),
      circuitBreaker: {
        state,
        previousState,
        failureCount,
        trigger: trigger || {},
      },
    });

    // Maintain sliding window
    if (this._data[key].length > WINDOW_SIZE) {
      this._data[key] = this._data[key].slice(-WINDOW_SIZE);
    }

    // Schedule persist
    this._schedulePersist();

    // Log circuit breaker state changes for monitoring
    if (state === 'open') {
      log.warn('Circuit breaker opened', { key, failureCount, trigger: trigger?.reason });
    } else if (state === 'closed' && previousState === 'open') {
      log.info('Circuit breaker recovered', { key, previousState, state });
    }
  }

  _load() {
    try {
      const raw = readFileSync(this._path, 'utf-8');
      this._data = JSON.parse(raw);
    } catch {
      this._data = {};
    }
  }

  _schedulePersist() {
    if (this._persistTimer) return;
    this._dirty = true;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  _persist() {
    if (!this._dirty) return;
    try {
      mkdirSync(join(this._path, '..'), { recursive: true });
      writeFileSync(this._path, JSON.stringify(this._data, null, 2));
      this._dirty = false;
    } catch (err) {
      log.warn('Scoreboard persist failed', { error: err.message });
    }
  }

  /**
   * Record an outcome for an agent.
   * @param {string} agentId
   * @param {{ success: boolean, durationMs?: number, complexity?: string, provider?: string }} outcome
   */
  record(agentId, { success, durationMs = 0, complexity = 'medium', provider = '' }) {
    if (!this._data[agentId]) this._data[agentId] = [];
    this._data[agentId].push({
      success, durationMs, complexity, provider,
      ts: Date.now(),
    });
    // Sliding window
    if (this._data[agentId].length > WINDOW_SIZE) {
      this._data[agentId] = this._data[agentId].slice(-WINDOW_SIZE);
    }
    this._schedulePersist();
  }

  /**
   * Get score for an agent.
   * @param {string} agentId
   * @returns {{ successRate: number, avgDuration: number, total: number, score: number }}
   */
  getScore(agentId) {
    const outcomes = this._data[agentId];
    if (!outcomes || outcomes.length === 0) {
      return { successRate: 0.5, avgDuration: 0, total: 0, score: 50 };
    }
    const total = outcomes.length;
    const successes = outcomes.filter(o => o.success).length;
    const successRate = successes / total;
    const avgDuration = outcomes.reduce((sum, o) => sum + (o.durationMs || 0), 0) / total;
    // Score: success rate weighted heavily, slight penalty for slow agents
    const score = successRate * 100 - (avgDuration / 60000);
    return { successRate, avgDuration, total, score };
  }

  /**
   * Get full scoreboard.
   * @returns {Object} Map of agentId → score data
   */
  getScoreboard() {
    const board = {};
    for (const agentId of Object.keys(this._data)) {
      board[agentId] = this.getScore(agentId);
    }
    return board;
  }

  /** Flush pending writes (for graceful shutdown). */
  flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._persist();
  }
}
