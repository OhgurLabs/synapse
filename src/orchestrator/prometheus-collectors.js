/**
 * Prometheus Collectors
 *
 * Bridges existing instrumentation into the Prometheus registry.
 * Each collector is independently startable/stoppable and fails gracefully.
 *
 * Collectors implemented:
 * 1. dispatchLatencyCollector - subscribes to MetricsInterceptor dispatch events
 * 2. circuitBreakerCollector - polls circuit-breaker.js ServiceState
 * 3. handoffCollector - hooks into handoff-protocol.js state transitions
 * 4. deliberationCollector - hooks into deliberation-protocol.js terminal states
 * 5. alertCollector - queries alert-store for firing alerts
 * 6. agentHealthCollector - queries health-aggregator for per-agent health
 */

import {
  recordDispatchDuration,
  setCircuitBreakerState,
  incrementHandoffTotal,
  incrementDeliberationTotal,
  setAlertFiring,
  setAgentHealthStatus
} from './prometheus-registry.js';
import { createLogger } from '../logger.js';

const log = createLogger('prometheus-collectors');

// ===== CONFIGURATION =====
const DEFAULT_CONFIG = {
  // Polling intervals in milliseconds
  circuitBreakerPollInterval: 5000,
  alertPollInterval: 10000,
  agentHealthPollInterval: 15000,
  
  // Collector enablement
  enableDispatchLatency: true,
  enableCircuitBreaker: true,
  enableHandoff: true,
  enableDeliberation: true,
  enableAlerts: true,
  enableAgentHealth: true
};

// ===== COLLECTOR REGISTRY =====
const collectors = new Map();

/**
 * Base class for all collectors.
 * Provides error isolation and lifecycle management.
 */
class BaseCollector {
  constructor(name, config = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isRunning = false;
    this.cleanupHandlers = [];
    this.errorCount = 0;
    this.maxErrors = 10; // Stop after N consecutive errors
  }

  /**
   * Start the collector.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      log.debug({ collector: this.name }, 'Collector already running');
      return;
    }

    try {
      this.isRunning = true;
      await this.doStart();
      log.info({ collector: this.name }, 'Collector started');
    } catch (err) {
      this.handleError(err, 'start');
      this.isRunning = false;
      throw err;
    }
  }

  /**
   * Stop the collector and clean up resources.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      // Run cleanup handlers
      for (const handler of this.cleanupHandlers) {
        try {
          await handler();
        } catch (err) {
          log.warn({ collector: this.name, err }, 'Cleanup handler failed');
        }
      }

      await this.doStop();
      this.isRunning = false;
      log.info({ collector: this.name }, 'Collector stopped');
    } catch (err) {
      this.handleError(err, 'stop');
      this.isRunning = false;
    }
  }

  /**
   * Handle errors gracefully without crashing the collector.
   * @param {Error} err - The error that occurred
   * @param {string} operation - The operation that failed
   */
  handleError(err, operation) {
    this.errorCount++;
    log.error(
      { collector: this.name, operation, error: err.message, errorCount: this.errorCount },
      'Collector error'
    );

    // Stop the collector after max consecutive errors
    if (this.errorCount >= this.maxErrors) {
      log.warn(
        { collector: this.name, maxErrors: this.maxErrors },
        'Collector stopped due to excessive errors'
      );
      this.stop();
    }
  }

  /**
   * Add a cleanup handler to be called on stop.
   * @param {Function} handler - Cleanup function
   */
  addCleanupHandler(handler) {
    this.cleanupHandlers.push(handler);
  }

  /**
   * Override this method to implement collector-specific start logic.
   */
  async doStart() {
    // Override in subclass
  }

  /**
   * Override this method to implement collector-specific stop logic.
   */
  async doStop() {
    // Override in subclass
  }
}

// ===== DISPATCH LATENCY COLLECTOR =====
/**
 * Collects dispatch latency metrics from MetricsInterceptor events.
 * Subscribes to MetricsStore 'metric:recorded' events and records
 * observations into the dispatch_duration_seconds histogram.
 */
class DispatchLatencyCollector extends BaseCollector {
  constructor(config = {}) {
    super('dispatchLatency', config);
    this.metricsStore = null;
    this.eventListener = null;
  }

  /**
   * Initialize the collector with a MetricsStore instance.
   * @param {MetricsStore} metricsStore - The MetricsStore to subscribe to
   */
  initialize(metricsStore) {
    if (!metricsStore) {
      throw new Error('DispatchLatencyCollector requires a MetricsStore instance');
    }
    this.metricsStore = metricsStore;
  }

  async doStart() {
    if (!this.metricsStore) {
      throw new Error('MetricsStore not initialized');
    }

    // Create event listener for metric:recorded events
    this.eventListener = (metric) => {
      try {
        this.onMetricRecorded(metric);
      } catch (err) {
        this.handleError(err, 'onMetricRecorded');
      }
    };

    // Subscribe to metric:recorded events
    this.metricsStore.on('metric:recorded', this.eventListener);

    // Add cleanup handler
    this.addCleanupHandler(() => {
      if (this.eventListener && this.metricsStore) {
        this.metricsStore.removeListener('metric:recorded', this.eventListener);
      }
    });
  }

  /**
   * Handle a metric:recorded event.
   * @param {Object} metric - The recorded metric
   */
  onMetricRecorded(metric) {
    const { dispatchId, agentId, campaignId, model, latencyMs } = metric;

    // Validate required fields
    if (!agentId || !model || latencyMs === undefined) {
      log.debug(
        { dispatchId, agentId, model },
        'Skipping metric with missing required fields'
      );
      return;
    }

    // Convert latency from milliseconds to seconds
    const durationSeconds = latencyMs / 1000;

    // Record the histogram observation
    // Use 'unknown' for missing campaignId
    const effectiveCampaignId = campaignId || 'unknown';
    recordDispatchDuration(agentId, effectiveCampaignId, model, durationSeconds);

    log.debug(
      { dispatchId, agentId, model, campaignId, latencyMs, durationSeconds },
      'Dispatch latency recorded'
    );
  }

  async doStop() {
    // Cleanup handled by cleanup handler
  }
}

// ===== CIRCUIT BREAKER COLLECTOR =====
/**
 * Collects circuit breaker state metrics by polling the CircuitBreaker.
 * Updates the circuit_breaker_state gauge per service.
 */
class CircuitBreakerCollector extends BaseCollector {
  constructor(config = {}) {
    super('circuitBreaker', config);
    this.circuitBreaker = null;
    this.pollInterval = null;
  }

  /**
   * Initialize the collector with a CircuitBreaker instance.
   * @param {CircuitBreaker} circuitBreaker - The CircuitBreaker to poll
   */
  initialize(circuitBreaker) {
    if (!circuitBreaker) {
      throw new Error('CircuitBreakerCollector requires a CircuitBreaker instance');
    }
    this.circuitBreaker = circuitBreaker;
  }

  async doStart() {
    if (!this.circuitBreaker) {
      throw new Error('CircuitBreaker not initialized');
    }

    // Initial collection
    await this.collect();

    // Start polling interval
    this.pollInterval = setInterval(() => {
      if (this.isRunning) {
        this.collect().catch(err => this.handleError(err, 'poll'));
      }
    }, this.config.circuitBreakerPollInterval);

    // Add cleanup handler
    this.addCleanupHandler(() => {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    });
  }

  /**
   * Collect circuit breaker states from all services.
   */
  async collect() {
    try {
      // Get all circuit breaker statuses
      const statuses = this.circuitBreaker.getAllCircuitBreakerStatus?.() || {};

      for (const [serviceName, status] of Object.entries(statuses)) {
        try {
          // Update the gauge with the current state
          // State should be 'closed', 'half_open', or 'open'
          const state = status.state || status.status || 'closed';
          this.updateGauge(serviceName, state);
        } catch (err) {
          log.debug(
            { serviceName, error: err.message },
            'Failed to update circuit breaker state'
          );
        }
      }
    } catch (err) {
      this.handleError(err, 'collect');
    }
  }

  /**
   * Update the circuit breaker state gauge.
   * @param {string} serviceName - The service name
   * @param {string} state - The state (closed, half_open, open)
   */
  updateGauge(serviceName, state) {
    setCircuitBreakerState(serviceName, state);
  }

  async doStop() {
    // Cleanup handled by cleanup handler
  }
}

// ===== HANDOFF COLLECTOR =====
/**
 * Collects handoff protocol state transitions.
 * Hooks into handoff-protocol.js state transitions and increments
 * the handoff_total counter by status.
 */
class HandoffCollector extends BaseCollector {
  constructor(config = {}) {
    super('handoff', config);
    this.handoffProtocol = null;
    this.eventListener = null;
  }

  /**
   * Initialize the collector with a HandoffProtocol instance.
   * @param {HandoffProtocol} handoffProtocol - The HandoffProtocol to subscribe to
   */
  initialize(handoffProtocol) {
    if (!handoffProtocol) {
      throw new Error('HandoffCollector requires a HandoffProtocol instance');
    }
    this.handoffProtocol = handoffProtocol;
  }

  async doStart() {
    if (!this.handoffProtocol) {
      throw new Error('HandoffProtocol not initialized');
    }

    // Create event listener for state transition events
    this.eventListener = (transition) => {
      try {
        this.onStateTransition(transition);
      } catch (err) {
        this.handleError(err, 'onStateTransition');
      }
    };

    // Subscribe to state transition events
    // HandoffProtocol should emit 'state:transition' or 'state:change' events
    const eventName = this.handoffProtocol.on ? 'state:transition' : null;
    if (eventName && this.handoffProtocol.on) {
      this.handoffProtocol.on(eventName, this.eventListener);
    }

    // Add cleanup handler
    this.addCleanupHandler(() => {
      if (this.eventListener && this.handoffProtocol && this.handoffProtocol.removeListener) {
        this.handoffProtocol.removeListener('state:transition', this.eventListener);
      }
    });
  }

  /**
   * Handle a state transition event.
   * @param {Object} transition - The state transition
   */
  onStateTransition(transition) {
    const { status, state } = transition;

    // Map terminal states to counter labels
    const terminalStates = ['COMPLETED', 'REJECTED', 'TIMEOUT', 'NACKED'];
    const effectiveStatus = status || state;

    if (terminalStates.includes(effectiveStatus)) {
      try {
        // Normalize status to lowercase
        const normalizedStatus = effectiveStatus.toLowerCase();
        incrementHandoffTotal(normalizedStatus);
        log.debug({ status: effectiveStatus }, 'Handoff total incremented');
      } catch (err) {
        this.handleError(err, 'incrementHandoffTotal');
      }
    }
  }

  async doStop() {
    // Cleanup handled by cleanup handler
  }
}

// ===== DELIBERATION COLLECTOR =====
/**
 * Collects deliberation protocol state transitions.
 * Hooks into deliberation-protocol.js terminal states and increments
 * the deliberation_total counter by outcome.
 */
class DeliberationCollector extends BaseCollector {
  constructor(config = {}) {
    super('deliberation', config);
    this.deliberationProtocol = null;
    this.eventListener = null;
  }

  /**
   * Initialize the collector with a DeliberationProtocol instance.
   * @param {DeliberationProtocol} deliberationProtocol - The DeliberationProtocol to subscribe to
   */
  initialize(deliberationProtocol) {
    if (!deliberationProtocol) {
      throw new Error('DeliberationCollector requires a DeliberationProtocol instance');
    }
    this.deliberationProtocol = deliberationProtocol;
  }

  async doStart() {
    if (!this.deliberationProtocol) {
      throw new Error('DeliberationProtocol not initialized');
    }

    // Create event listener for state transition events
    this.eventListener = (transition) => {
      try {
        this.onStateTransition(transition);
      } catch (err) {
        this.handleError(err, 'onStateTransition');
      }
    };

    // Subscribe to state transition events
    if (this.deliberationProtocol.on) {
      this.deliberationProtocol.on('state:transition', this.eventListener);
    }

    // Add cleanup handler
    this.addCleanupHandler(() => {
      if (this.eventListener && this.deliberationProtocol && this.deliberationProtocol.removeListener) {
        this.deliberationProtocol.removeListener('state:transition', this.eventListener);
      }
    });
  }

  /**
   * Handle a state transition event.
   * @param {Object} transition - The state transition
   */
  onStateTransition(transition) {
    const { outcome, state } = transition;

    // Map terminal states to counter labels
    const terminalStates = ['CONSENSUS_REACHED', 'MAX_TURNS_EXCEEDED'];
    const effectiveOutcome = outcome || state;

    if (terminalStates.includes(effectiveOutcome)) {
      try {
        // Normalize outcome to snake_case
        const normalizedOutcome = effectiveOutcome
          .toLowerCase()
          .replace(/_/g, '_');
        incrementDeliberationTotal(normalizedOutcome);
        log.debug({ outcome: effectiveOutcome }, 'Deliberation total incremented');
      } catch (err) {
        this.handleError(err, 'incrementDeliberationTotal');
      }
    }
  }

  async doStop() {
    // Cleanup handled by cleanup handler
  }
}

// ===== ALERT COLLECTOR =====
/**
 * Collects alert firing status by polling the AlertStore.
 * Updates the alert_firing gauge by severity.
 */
class AlertCollector extends BaseCollector {
  constructor(config = {}) {
    super('alert', config);
    this.alertStore = null;
    this.pollInterval = null;
  }

  /**
   * Initialize the collector with an AlertStore instance.
   * @param {AlertStore} alertStore - The AlertStore to poll
   */
  initialize(alertStore) {
    if (!alertStore) {
      throw new Error('AlertCollector requires an AlertStore instance');
    }
    this.alertStore = alertStore;
  }

  async doStart() {
    if (!this.alertStore) {
      throw new Error('AlertStore not initialized');
    }

    // Initial collection
    await this.collect();

    // Start polling interval
    this.pollInterval = setInterval(() => {
      if (this.isRunning) {
        this.collect().catch(err => this.handleError(err, 'poll'));
      }
    }, this.config.alertPollInterval);

    // Add cleanup handler
    this.addCleanupHandler(() => {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    });
  }

  /**
   * Collect alert firing status from AlertStore.
   */
  async collect() {
    try {
      // Query for firing alerts
      const alerts = this.alertStore.query?.({ state: 'firing' }) || [];

      // Group by severity and count
      const severityCounts = {};
      for (const alert of alerts) {
        const severity = alert.severity || 'info';
        severityCounts[severity] = (severityCounts[severity] || 0) + 1;
      }

      // Update gauges for each severity
      // Ensure all severities are represented (even if 0)
      const allSeverities = ['critical', 'warning', 'info'];
      for (const severity of allSeverities) {
        const count = severityCounts[severity] || 0;
        setAlertFiring(severity, count);
      }

      log.debug({ counts: severityCounts }, 'Alert firing counts updated');
    } catch (err) {
      this.handleError(err, 'collect');
    }
  }

  async doStop() {
    // Cleanup handled by cleanup handler
  }
}

// ===== AGENT HEALTH COLLECTOR =====
/**
 * Collects agent health status by polling the health-aggregator.
 * Updates the agent_health_status gauge per agent.
 */
class AgentHealthCollector extends BaseCollector {
  constructor(config = {}) {
    super('agentHealth', config);
    this.healthAggregator = null;
    this.pollInterval = null;
  }

  /**
   * Initialize the collector with a health-aggregator instance.
   * @param {Object} healthAggregator - The health aggregator to poll
   */
  initialize(healthAggregator) {
    if (!healthAggregator) {
      throw new Error('AgentHealthCollector requires a health aggregator instance');
    }
    this.healthAggregator = healthAggregator;
  }

  async doStart() {
    if (!this.healthAggregator) {
      throw new Error('Health aggregator not initialized');
    }

    // Initial collection
    await this.collect();

    // Start polling interval
    this.pollInterval = setInterval(() => {
      if (this.isRunning) {
        this.collect().catch(err => this.handleError(err, 'poll'));
      }
    }, this.config.agentHealthPollInterval);

    // Add cleanup handler
    this.addCleanupHandler(() => {
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    });
  }

  /**
   * Collect agent health status from health-aggregator.
   */
  async collect() {
    try {
      // Get aggregate health data
      const healthData = this.healthAggregator.aggregateHealthData?.() || {};

      // Extract per-agent health status
      const agents = healthData.agents || healthData || {};

      // Update gauges for each agent
      for (const [agentId, status] of Object.entries(agents)) {
        try {
          // Map health status to numeric value
          const numericStatus = this.mapHealthStatus(status);
          setAgentHealthStatus(agentId, numericStatus);
        } catch (err) {
          log.debug(
            { agentId, error: err.message },
            'Failed to update agent health status'
          );
        }
      }

      log.debug({ agentCount: Object.keys(agents).length }, 'Agent health status updated');
    } catch (err) {
      this.handleError(err, 'collect');
    }
  }

  /**
   * Map health status string to numeric value.
   * @param {string|Object} status - The health status
   * @returns {number} Numeric status (1=healthy, 0.5=degraded, 0=down)
   */
  mapHealthStatus(status) {
    if (typeof status === 'object') {
      // Handle object status with 'status' or 'state' property
      const statusStr = status.status || status.state || status.health;
      return this.mapHealthStatus(statusStr);
    }

    const statusStr = String(status).toLowerCase();

    if (statusStr === 'healthy' || statusStr === 'ok' || statusStr === 'active') {
      return 1;
    }
    if (statusStr === 'degraded' || statusStr === 'warning' || statusStr === 'unhealthy') {
      return 0.5;
    }
    if (statusStr === 'down' || statusStr === 'failed' || statusStr === 'error') {
      return 0;
    }

    // Unknown status, default to degraded
    return 0.5;
  }

  async doStop() {
    // Cleanup handled by cleanup handler
  }
}

// ===== PUBLIC API =====

/**
 * Start all collectors with the given dependencies.
 *
 * @param {Object} deps - Dependencies for collectors
 * @param {MetricsStore} [deps.metricsStore] - MetricsStore for dispatch latency
 * @param {CircuitBreaker} [deps.circuitBreaker] - CircuitBreaker for circuit states
 * @param {HandoffProtocol} [deps.handoffProtocol] - HandoffProtocol for handoff events
 * @param {DeliberationProtocol} [deps.deliberationProtocol] - DeliberationProtocol for deliberation events
 * @param {AlertStore} [deps.alertStore] - AlertStore for alert queries
 * @param {Object} [deps.healthAggregator] - Health aggregator for agent health
 * @param {Object} [deps.config] - Optional configuration overrides
 * @returns {Promise<Object>} Started collectors map
 */
export async function startCollectors(deps = {}) {
  const {
    metricsStore,
    circuitBreaker,
    handoffProtocol,
    deliberationProtocol,
    alertStore,
    healthAggregator,
    config
  } = deps;

  const startedCollectors = {};

  try {
    // 1. Dispatch Latency Collector
    if (config?.enableDispatchLatency !== false && metricsStore) {
      const collector = new DispatchLatencyCollector(config);
      collector.initialize(metricsStore);
      await collector.start();
      collectors.set('dispatchLatency', collector);
      startedCollectors.dispatchLatency = true;
    }

    // 2. Circuit Breaker Collector
    if (config?.enableCircuitBreaker !== false && circuitBreaker) {
      const collector = new CircuitBreakerCollector(config);
      collector.initialize(circuitBreaker);
      await collector.start();
      collectors.set('circuitBreaker', collector);
      startedCollectors.circuitBreaker = true;
    }

    // 3. Handoff Collector
    if (config?.enableHandoff !== false && handoffProtocol) {
      const collector = new HandoffCollector(config);
      collector.initialize(handoffProtocol);
      await collector.start();
      collectors.set('handoff', collector);
      startedCollectors.handoff = true;
    }

    // 4. Deliberation Collector
    if (config?.enableDeliberation !== false && deliberationProtocol) {
      const collector = new DeliberationCollector(config);
      collector.initialize(deliberationProtocol);
      await collector.start();
      collectors.set('deliberation', collector);
      startedCollectors.deliberation = true;
    }

    // 5. Alert Collector
    if (config?.enableAlerts !== false && alertStore) {
      const collector = new AlertCollector(config);
      collector.initialize(alertStore);
      await collector.start();
      collectors.set('alert', collector);
      startedCollectors.alert = true;
    }

    // 6. Agent Health Collector
    if (config?.enableAgentHealth !== false && healthAggregator) {
      const collector = new AgentHealthCollector(config);
      collector.initialize(healthAggregator);
      await collector.start();
      collectors.set('agentHealth', collector);
      startedCollectors.agentHealth = true;
    }

    log.info({ startedCollectors }, 'Prometheus collectors started');
  } catch (err) {
    log.error({ error: err.message, deps: Object.keys(deps) }, 'Failed to start collectors');
    // Don't rethrow - allow partial startup
  }

  return startedCollectors;
}

/**
 * Stop all running collectors.
 * @returns {Promise<Object>} Stopped collectors map
 */
export async function stopCollectors() {
  const stoppedCollectors = {};

  for (const [name, collector] of collectors) {
    try {
      await collector.stop();
      stoppedCollectors[name] = true;
    } catch (err) {
      log.error(
        { collector: name, error: err.message },
        'Failed to stop collector'
      );
      stoppedCollectors[name] = false;
    }
  }

  collectors.clear();
  log.info({ stoppedCollectors }, 'Prometheus collectors stopped');

  return stoppedCollectors;
}

/**
 * Get the current collector status.
 * @returns {Object} Collector status map
 */
export function getCollectorStatus() {
  const status = {};
  for (const [name, collector] of collectors) {
    status[name] = {
      isRunning: collector.isRunning,
      errorCount: collector.errorCount
    };
  }
  return status;
}

/**
 * Get a specific collector instance.
 * @param {string} name - Collector name
 * @returns {BaseCollector|null} The collector instance or null
 */
export function getCollector(name) {
  return collectors.get(name) || null;
}
