/**
 * Prometheus metrics generation for Synapse.
 * Generates text/plain; version=0.0.4 format from current system state.
 * Uses prom-client for formatting but builds a fresh registry per scrape
 * to avoid stale global state and test isolation issues.
 */
import { Registry, Gauge, Counter, Histogram } from 'prom-client';

const CB_STATE_VALUES = { closed: 0, half_open: 0.5, open: 1 };

export function computePercentile(durations, p) {
  if (!durations || durations.length === 0) return 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[idx];
}

/**
 * Generate Prometheus text format metrics from current system state.
 * @param {object} deps - { performanceStore, circuitBreaker, campaignManager, sandbox, stateManager }
 * @returns {Promise<string>} Prometheus text format string
 */
export async function generateMetricsText(deps = {}) {
  const { performanceStore, circuitBreaker, campaignManager, sandbox, stateManager, timelineStore, checkpointManager, healthAggregator, router, agentRegistry } = deps;
  const registry = new Registry();

  // --- Dispatch & Performance Metrics ---

  // synapse_dispatch_total
  const dispatchTotal = new Counter({
    name: 'synapse_dispatch_total',
    help: 'Total number of agent dispatches recorded',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  if (performanceStore) {
    const allStats = performanceStore.getAllAgentStats();
    for (const s of allStats) {
      dispatchTotal.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').inc(s.totalDispatches ?? 0);
    }
  }

  // synapse_agent_success_rate
  const agentSuccessRate = new Gauge({
    name: 'synapse_agent_success_rate',
    help: 'Agent success rate (0-1). -1 when insufficient data (<5 dispatches).',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  // synapse_task_duration_seconds_avg
  const taskDurationAvg = new Gauge({
    name: 'synapse_task_duration_seconds_avg',
    help: 'Average task duration in seconds',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  // synapse_task_duration_seconds_p50
  const taskDurationP50 = new Gauge({
    name: 'synapse_task_duration_seconds_p50',
    help: 'P50 task duration in seconds',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  // synapse_task_duration_seconds_p95
  const taskDurationP95 = new Gauge({
    name: 'synapse_task_duration_seconds_p95',
    help: 'P95 task duration in seconds',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  // synapse_task_duration_seconds_p99
  const taskDurationP99 = new Gauge({
    name: 'synapse_task_duration_seconds_p99',
    help: 'P99 task duration in seconds',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  if (performanceStore) {
    const allStats = performanceStore.getAllAgentStats();
    for (const s of allStats) {
      const rate = s.totalDispatches >= 5 ? (s.successRate ?? 0) : -1;
      agentSuccessRate.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(rate);

      const avgDurationSec = (s.avgDurationMs ?? 0) / 1000;
      taskDurationAvg.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(avgDurationSec);

      const durationHistory = s.durationHistory || [];
      if (durationHistory.length > 0) {
        const p50 = computePercentile(durationHistory, 0.50) / 1000;
        const p95 = computePercentile(durationHistory, 0.95) / 1000;
        const p99 = computePercentile(durationHistory, 0.99) / 1000;
        taskDurationP50.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(p50);
        taskDurationP95.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(p95);
        taskDurationP99.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(p99);
      } else {
        taskDurationP50.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(0);
        taskDurationP95.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(0);
        taskDurationP99.labels(s.agentId ?? 'unknown', s.taskCategory ?? 'unknown').set(0);
      }
    }
  }

  // --- Correlation Pipeline Metrics ---

  // synapse_correlation_total_dispatches
  const correlationTotal = new Counter({
    name: 'synapse_correlation_total_dispatches',
    help: 'Total number of dispatches processed for correlation tracking',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  // synapse_correlation_correlated_dispatches
  const correlationCorrelated = new Counter({
    name: 'synapse_correlation_correlated_dispatches',
    help: 'Number of dispatches successfully correlated with traceId/dispatchId',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  // synapse_correlation_missing_correlation_ids
  const correlationMissing = new Counter({
    name: 'synapse_correlation_missing_correlation_ids',
    help: 'Number of dispatches missing correlation IDs (traceId and dispatchId)',
    labelNames: ['agent_id', 'category'],
    registers: [registry],
  });

  // synapse_correlation_fallback_lookup_cases
  const correlationFallback = new Counter({
    name: 'synapse_correlation_fallback_lookup_cases',
    help: 'Number of dispatches requiring fallback lookup from dispatch log',
    labelNames: ['agent_id', 'category', 'reason'],
    registers: [registry],
  });

  if (timelineStore && typeof timelineStore.getCorrelationMetrics === 'function') {
    const metrics = timelineStore.getCorrelationMetrics();
    if (metrics && typeof metrics.getSnapshot === 'function') {
      const snapshot = await metrics.getSnapshot();
      if (snapshot && snapshot.byAgent) {
        for (const [agentId, agentData] of Object.entries(snapshot.byAgent)) {
          if (agentData.categories) {
            for (const catData of Object.values(agentData.categories)) {
              const category = catData.category || 'unknown';
              correlationTotal.labels(agentId, category).inc(catData.totalDispatches || 0);
              correlationCorrelated.labels(agentId, category).inc(catData.correlatedDispatches || 0);
              correlationMissing.labels(agentId, category).inc(catData.missingCorrelationIds || 0);
              
              if (catData.reasons) {
                for (const [reason, count] of Object.entries(catData.reasons)) {
                  correlationFallback.labels(agentId, category, reason).inc(count || 0);
                }
              }
            }
          }
        }
      }
    }
  }

  // --- System & Circuit Breaker Metrics ---

  // synapse_circuit_breaker_state
  const cbState = new Gauge({
    name: 'synapse_circuit_breaker_state',
    help: 'Circuit breaker state: 0=closed, 0.5=half_open, 1=open',
    labelNames: ['scope', 'id'],
    registers: [registry],
  });

  if (circuitBreaker) {
    const status = circuitBreaker.getStatus();
    for (const [provider, info] of Object.entries(status.providers || {})) {
      const val = CB_STATE_VALUES[info.state] ?? 0;
      cbState.labels('provider', provider).set(val);
    }
    for (const [agentId, info] of Object.entries(status.agents || {})) {
      const val = CB_STATE_VALUES[info.state] ?? 0;
      cbState.labels('agent', agentId).set(val);
    }
  }

  // synapse_campaign_active_total
  const campaignActive = new Gauge({
    name: 'synapse_campaign_active_total',
    help: 'Number of currently active campaigns',
    registers: [registry],
  });

  if (campaignManager && stateManager) {
    let activeCount = 0;
    try {
      const projects = stateManager.listProjects();
      for (const proj of projects) {
        const campaigns = campaignManager.listCampaigns(proj.id, 'active');
        activeCount += campaigns.length;
      }
    } catch {
      // if listing fails, leave count at 0
    }
    campaignActive.set(activeCount);
  } else {
    campaignActive.set(0);
  }

  // synapse_process_sandbox_active
  const sandboxActive = new Gauge({
    name: 'synapse_process_sandbox_active',
    help: 'Number of currently active sandbox processes',
    registers: [registry],
  });

  if (sandbox) {
    sandboxActive.set(sandbox.activeCount ?? 0);
  } else {
    sandboxActive.set(0);
  }

  // --- Circuit Breaker Extended Metrics ---

  // synapse_circuit_breaker_failures_total
  const cbFailures = new Counter({
    name: 'synapse_circuit_breaker_failures_total',
    help: 'Total number of circuit breaker failures',
    labelNames: ['scope', 'id'],
    registers: [registry],
  });

  if (circuitBreaker) {
    const status = circuitBreaker.getStatus();
    for (const [provider, info] of Object.entries(status.providers || {})) {
      cbFailures.labels('provider', provider).inc(info.failureCount ?? 0);
    }
    for (const [agentId, info] of Object.entries(status.agents || {})) {
      cbFailures.labels('agent', agentId).inc(info.failureCount ?? 0);
    }
  }

  // synapse_circuit_breaker_open_duration_seconds
  const cbOpenDuration = new Gauge({
    name: 'synapse_circuit_breaker_open_duration_seconds',
    help: 'Duration circuit breaker has been open in seconds',
    labelNames: ['scope', 'id'],
    registers: [registry],
  });

  if (circuitBreaker) {
    const status = circuitBreaker.getStatus();
    const now = Date.now();
    for (const [provider, info] of Object.entries(status.providers || {})) {
      if (info.state === 'open' && info.openedAt) {
        const durationSec = (now - new Date(info.openedAt).getTime()) / 1000;
        cbOpenDuration.labels('provider', provider).set(durationSec);
      }
    }
    for (const [agentId, info] of Object.entries(status.agents || {})) {
      if (info.state === 'open' && info.openedAt) {
        const durationSec = (now - new Date(info.openedAt).getTime()) / 1000;
        cbOpenDuration.labels('agent', agentId).set(durationSec);
      }
    }
  }

  // --- Recovery Time Metrics ---

  // synapse_recovery_time_seconds (histogram)
  const recoveryTimeHist = new Histogram({
    name: 'synapse_recovery_time_seconds',
    help: 'Recovery time distribution in seconds',
    labelNames: ['fault_type'],
    registers: [registry],
    buckets: [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
  });

  if (circuitBreaker) {
    const status = circuitBreaker.getStatus();
    const now = Date.now();
    for (const [provider, info] of Object.entries(status.providers || {})) {
      if (info.state === 'closed' && info.recoveryAt) {
        const recoveryTime = (now - new Date(info.recoveryAt).getTime()) / 1000;
        recoveryTimeHist.labels('provider_failure').observe(recoveryTime);
      }
    }
    for (const [agentId, info] of Object.entries(status.agents || {})) {
      if (info.state === 'closed' && info.recoveryAt) {
        const recoveryTime = (now - new Date(info.recoveryAt).getTime()) / 1000;
        recoveryTimeHist.labels('agent_failure').observe(recoveryTime);
      }
    }
  }

  // --- Failover Metrics ---

  // synapse_failover_total
  const failoverTotal = new Counter({
    name: 'synapse_failover_total',
    help: 'Total number of provider failovers',
    labelNames: ['from_provider', 'to_provider'],
    registers: [registry],
  });

  if (router && router.failoverCount) {
    for (const [key, count] of Object.entries(router.failoverCount)) {
      const [fromProvider, toProvider] = key.split(':');
      failoverTotal.labels(fromProvider || 'unknown', toProvider || 'unknown').inc(count);
    }
  }

  // --- Checkpoint Metrics ---

  // synapse_checkpoint_lag_seconds
  const checkpointLag = new Gauge({
    name: 'synapse_checkpoint_lag_seconds',
    help: 'Seconds behind current dispatch',
    registers: [registry],
  });

  // synapse_checkpoint_age_seconds
  const checkpointAge = new Gauge({
    name: 'synapse_checkpoint_age_seconds',
    help: 'Age of last checkpoint in seconds',
    registers: [registry],
  });

  if (checkpointManager && typeof checkpointManager.getCheckpointMetrics === 'function') {
    try {
      const metrics = checkpointManager.getCheckpointMetrics();
      if (metrics) {
        checkpointLag.set(metrics.lagSeconds ?? 0);
        checkpointAge.set(metrics.ageSeconds ?? 0);
      }
    } catch {
      checkpointLag.set(0);
      checkpointAge.set(0);
    }
  } else {
    checkpointLag.set(0);
    checkpointAge.set(0);
  }

  // --- Agent Connection Metrics ---

  // synapse_agent_connected
  const agentConnected = new Gauge({
    name: 'synapse_agent_connected',
    help: 'Agent is connected (1) or not (0)',
    labelNames: ['agent_id'],
    registers: [registry],
  });

  // synapse_agent_total
  const agentTotal = new Gauge({
    name: 'synapse_agent_total',
    help: 'Total number of registered agents',
    labelNames: ['agent_id'],
    registers: [registry],
  });

  // synapse_agent_disconnected
  const agentDisconnected = new Gauge({
    name: 'synapse_agent_disconnected',
    help: 'Agent is disconnected (1) or not (0)',
    labelNames: ['agent_id'],
    registers: [registry],
  });

  // synapse_agent_last_heartbeat_timestamp
  const agentLastHeartbeat = new Gauge({
    name: 'synapse_agent_last_heartbeat_timestamp',
    help: 'Unix timestamp of last heartbeat',
    labelNames: ['agent_id'],
    registers: [registry],
  });

  if (agentRegistry && typeof agentRegistry.getAgentStatus === 'function') {
    const statuses = agentRegistry.getAgentStatus();
    for (const [agentId, status] of Object.entries(statuses)) {
      agentTotal.labels(agentId).set(1);
      if (status.connected) {
        agentConnected.labels(agentId).set(1);
        agentDisconnected.labels(agentId).set(0);
      } else {
        agentConnected.labels(agentId).set(0);
        agentDisconnected.labels(agentId).set(1);
      }
      if (status.lastHeartbeat) {
        agentLastHeartbeat.labels(agentId).set(status.lastHeartbeat / 1000);
      }
    }
  }

  // --- Provider Degradation Metrics ---

  // synapse_provider_degraded
  const providerDegraded = new Gauge({
    name: 'synapse_provider_degraded',
    help: 'Provider is degraded (1) or not (0)',
    labelNames: ['provider_id'],
    registers: [registry],
  });

  // synapse_provider_total
  const providerTotal = new Gauge({
    name: 'synapse_provider_total',
    help: 'Total number of providers',
    labelNames: ['provider_id'],
    registers: [registry],
  });

  if (circuitBreaker) {
    const status = circuitBreaker.getStatus();
    for (const [provider, info] of Object.entries(status.providers || {})) {
      providerTotal.labels(provider).set(1);
      if (info.state === 'open' || info.state === 'half_open') {
        providerDegraded.labels(provider).set(1);
      } else {
        providerDegraded.labels(provider).set(0);
      }
    }
  }

  // --- Queue Metrics ---

  // synapse_dispatch_queue_depth
  const queueDepth = new Gauge({
    name: 'synapse_dispatch_queue_depth',
    help: 'Current dispatch queue depth',
    registers: [registry],
  });

  if (healthAggregator && healthAggregator.queueDepth !== undefined) {
    queueDepth.set(healthAggregator.queueDepth);
  } else {
    queueDepth.set(0);
  }

  // --- Cascade Detection Metrics ---

  // synapse_cascade_pattern_detected
  const cascadePattern = new Gauge({
    name: 'synapse_cascade_pattern_detected',
    help: 'Cascade pattern detected (1) or not (0)',
    labelNames: ['pattern_id'],
    registers: [registry],
  });

  // synapse_cascade_recovery_active
  const cascadeRecovery = new Gauge({
    name: 'synapse_cascade_recovery_active',
    help: 'Cascade recovery is active (1) or not (0)',
    registers: [registry],
  });

  if (healthAggregator && healthAggregator.cascadePatterns) {
    for (const [patternId, detected] of Object.entries(healthAggregator.cascadePatterns)) {
      cascadePattern.labels(patternId).set(detected ? 1 : 0);
    }
  }

  if (healthAggregator && healthAggregator.cascadeRecoveryActive !== undefined) {
    cascadeRecovery.set(healthAggregator.cascadeRecoveryActive ? 1 : 0);
  } else {
    cascadeRecovery.set(0);
  }

  return registry.metrics();
}
