// SLA Monitor — evaluates latency_p95, error_rate, and hourly_cost thresholds
// on a configurable interval and emits breach/resolution events.

import { createLogger } from '../logger.js';
import { appendAlertEntry } from './alert-history-store.js';

const log = createLogger('sla-monitor');

const DEFAULT_INTERVAL_MS = 60_000;

export function createSLAMonitor(opts = {}) {
  const { events, config, performanceStore, timelineStore, filePath } = opts;
  const activeBreaches = new Map(); // breachKey → breach object
  let interval = null;

  const slaConfig = config?.sla || {};
  const intervalMs = config?.sla?.intervalMs ?? DEFAULT_INTERVAL_MS;

  // EventBus listeners to persist breach/resolved events to alert history
  // (same pattern as alert-monitor.js lines 100-133)
  if (events && filePath) {
    events.on('alert:sla_breach', (breach) => {
      try {
        appendAlertEntry(filePath, breach);
      } catch (err) {
        log.warn('Failed to persist SLA breach to alert history', {
          slaType: breach.slaType,
          error: err.message
        });
      }
    });

    events.on('alert:sla_resolved', (resolution) => {
      try {
        appendAlertEntry(filePath, resolution);
      } catch (err) {
        log.warn('Failed to persist SLA resolution to alert history', {
          slaType: resolution.slaType,
          error: err.message
        });
      }
    });
  }

  function breachKey(slaType, provider, projectId) {
    return `${slaType}:${provider || '_all'}:${projectId || '_global'}`;
  }

  // --- Evaluators for each SLA type ---

  function evaluateLatencyP95() {
    const cfg = slaConfig.latency_p95;
    if (!cfg?.enabled) return [];

    const thresholdMs = cfg.thresholdMs;
    const windowMinutes = cfg.windowMinutes || 15;
    const projectId = config?.project?.id || null;
    const results = [];

    // Get all agent stats and check p95 latency from durationHistory
    const allStats = performanceStore?.getAllAgentStats?.() || [];
    // Aggregate all durations within the window
    // performanceStore keeps a ring buffer of durations; filter by recency isn't directly supported
    // so we use the full durationHistory (last 200) as an approximation
    const windows = performanceStore?.getDispatchWindows?.(undefined) || [];

    for (const w of windows) {
      if (w.insufficientData) continue;
      const agentId = w.agentId;
      const category = w.category;
      const stats = performanceStore.getStatsByAgentCategory(agentId, category);
      const durations = stats?.durationHistory || [];
      if (durations.length === 0) continue;

      const p95 = computeP95(durations);
      results.push({
        slaType: 'latency_p95',
        threshold: thresholdMs,
        actual: p95,
        windowMinutes,
        agentId,
        projectId,
        breached: p95 > thresholdMs,
      });
    }

    return results;
  }

  function evaluateErrorRate() {
    const cfg = slaConfig.error_rate;
    if (!cfg?.enabled) return [];

    const thresholdPct = cfg.thresholdPct;
    const windowMinutes = cfg.windowMinutes || 15;
    const projectId = config?.project?.id || null;
    const results = [];

    const windows = performanceStore?.getDispatchWindows?.(windowMinutes) || [];
    for (const w of windows) {
      if (w.insufficientData || w.successRate === null) continue;
      const errorRate = (1 - w.successRate) * 100;
      results.push({
        slaType: 'error_rate',
        threshold: thresholdPct,
        actual: errorRate,
        windowMinutes,
        agentId: w.agentId,
        taskCategory: w.category,
        dispatchCount: w.dispatchCount,
        projectId,
        breached: errorRate > thresholdPct,
      });
    }

    return results;
  }

  function evaluateHourlyCost() {
    const cfg = slaConfig.hourly_cost;
    if (!cfg?.enabled) return [];

    const thresholdUsd = cfg.thresholdUsd;
    const windowMinutes = cfg.windowMinutes || 60;
    const projectId = config?.project?.id || null;

    const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

    let costSummary;
    try {
      costSummary = timelineStore?.getCostSummary?.({ since });
    } catch (err) {
      log.warn('Failed to query cost summary for hourly_cost SLA', { error: err.message });
      return [{ slaType: 'hourly_cost', status: 'no_data', reason: 'query_error' }];
    }

    if (!costSummary || costSummary.totalDispatches === 0) {
      log.debug('No cost data available for hourly_cost SLA evaluation');
      return [{ slaType: 'hourly_cost', status: 'no_data', reason: 'empty' }];
    }

    const totalCost = costSummary.totalCostUsd || 0;
    return [{
      slaType: 'hourly_cost',
      threshold: thresholdUsd,
      actual: totalCost,
      windowMinutes,
      projectId,
      breached: totalCost > thresholdUsd,
    }];
  }

  // --- Core lifecycle ---

  function processSlaResult(result) {
    if (result.status === 'no_data') return; // graceful skip

    const key = breachKey(result.slaType, result.provider, result.projectId);

    if (result.breached) {
      if (!activeBreaches.has(key)) {
        const breachedAt = new Date().toISOString();
        const breach = {
          slaType: result.slaType,
          threshold: result.threshold,
          actual: result.actual,
          windowMinutes: result.windowMinutes,
          provider: result.provider || null,
          projectId: result.projectId || null,
          agentId: result.agentId || null,
          taskCategory: result.taskCategory || null,
          dispatchCount: result.dispatchCount || null,
          breachedAt,
        };
        activeBreaches.set(key, breach);

        // Persist to timeline store
        try {
          timelineStore?.appendSlaEvent?.({
            eventType: 'SLA_BREACH',
            slaType: result.slaType,
            threshold: result.threshold,
            actual: result.actual,
            windowMinutes: result.windowMinutes,
            provider: result.provider || null,
            projectId: result.projectId || null,
            agentId: result.agentId || null,
            taskCategory: result.taskCategory || null,
            dispatchCount: result.dispatchCount || null,
            breachedAt,
          });
        } catch (err) {
          log.warn('Failed to persist SLA breach', { slaType: result.slaType, error: err.message });
        }

        // Emit event (EventBus listener will persist to alert history)
        events?.emit('alert:sla_breach', breach);
        log.warn('SLA breach detected', breach);
      }
    } else {
      // Metric is within threshold — check if we need to resolve
      if (activeBreaches.has(key)) {
        const breach = activeBreaches.get(key);
        activeBreaches.delete(key);
        const resolvedAt = new Date().toISOString();

        const resolution = {
          slaType: result.slaType,
          threshold: result.threshold,
          actual: result.actual,
          windowMinutes: result.windowMinutes,
          provider: breach.provider || null,
          projectId: breach.projectId || null,
          agentId: breach.agentId || result.agentId || null,
          taskCategory: breach.taskCategory || result.taskCategory || null,
          dispatchCount: result.dispatchCount || null,
          breachedAt: breach.breachedAt,
          resolvedAt,
        };

        try {
          timelineStore?.appendSlaEvent?.({
            eventType: 'SLA_RESOLVED',
            ...resolution,
          });
        } catch (err) {
          log.warn('Failed to persist SLA resolution', { slaType: result.slaType, error: err.message });
        }

        // Emit event (EventBus listener will persist to alert history)
        events?.emit('alert:sla_resolved', resolution);
        log.info('SLA breach resolved', resolution);
      }
    }
  }

  function tick() {
    const allResults = [
      ...evaluateLatencyP95(),
      ...evaluateErrorRate(),
      ...evaluateHourlyCost(),
    ];

    for (const result of allResults) {
      processSlaResult(result);
    }
  }

  function start() {
    const anyEnabled = slaConfig.latency_p95?.enabled ||
                       slaConfig.error_rate?.enabled ||
                       slaConfig.hourly_cost?.enabled;

    if (!anyEnabled) {
      log.info('SLA monitor disabled — no SLA types enabled');
      return;
    }

    tick(); // immediate first check
    interval = setInterval(tick, intervalMs);
    log.info('SLA monitor started', { intervalMs });
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function getActiveBreaches() {
    return [...activeBreaches.values()];
  }

  function getConfig() {
    return slaConfig || {};
  }

  return { start, stop, tick, getActiveBreaches, getConfig };
}

// Utility: compute p95 from array of durations
function computeP95(durations) {
  if (!durations || durations.length === 0) return 0;
  const sorted = [...durations].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[idx];
}
