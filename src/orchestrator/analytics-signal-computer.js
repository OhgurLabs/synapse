/**
 * analytics-signal-computer.js — Compute per-provider performance signals from timeline events.
 *
 * This module queries the TimelineStore for routing and guardrail events within a given
 * time window and aggregates them into actionable routing signals:
 * - success_rate: (successes / total dispatches)
 * - p50_latency: 50th percentile duration in ms
 * - p95_latency: 95th percentile duration in ms
 * - p99_latency: 99th percentile duration in ms
 * - guardrail_violation_rate: (blocked / total guardrail evaluations)
 *
 * Also computes reviewer accuracy metrics from the state database:
 * - reviewer_accuracy: percentage of reviews that have not been overturned
 */

import { createLogger } from '../logger.js';
import { getDb } from './state-db.js';

const log = createLogger('analytics-signal-computer');

/**
 * TTL-based cache for reviewer accuracy metrics.
 * Key: baseDir (all windows share the same cache entry, invalidated on overturn).
 * Value: { data: Object, expiresAt: number }
 *
 * Cache is invalidated when a rejection is overturned, ensuring real-time accuracy.
 */
const reviewerAccuracyCache = new Map();
const REVIEWER_ACCURACY_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Invalidate the reviewer accuracy cache for a given base directory.
 * Call this after a rejection is overturned to ensure the next GET request
 * reflects the updated accuracy.
 *
 * @param {string} baseDir - Base directory containing the state database
 */
export function invalidateReviewerAccuracyCache(baseDir) {
  if (reviewerAccuracyCache.has(baseDir)) {
    reviewerAccuracyCache.delete(baseDir);
    log.debug('Reviewer accuracy cache invalidated', { baseDir });
  }
}

/**
 * Invalidate the reviewer accuracy cache for all base directories.
 * Use this when you don't know which baseDir was affected.
 */
export function invalidateAllReviewerAccuracyCache() {
  const count = reviewerAccuracyCache.size;
  reviewerAccuracyCache.clear();
  log.debug('All reviewer accuracy caches invalidated', { cleared: count });
}

/**
 * Clear the reviewer accuracy cache for a given base directory.
 * Useful for testing to ensure fresh data on each computation.
 *
 * @param {string} baseDir - Base directory containing the state database
 */
export function clearReviewerAccuracyCache(baseDir) {
  reviewerAccuracyCache.delete(baseDir);
}

export function clearAllReviewerAccuracyCaches() {
  reviewerAccuracyCache.clear();
}

/**
 * Compute p50, p95, and p99 percentiles for a list of numbers.
 * Uses the nearest-rank method for simplicity and to avoid interpolation
 * of actual measured durations.
 * @param {number[]} values - Array of numeric values
 * @returns {{ p50: number, p95: number, p99: number }}
 */
function computeLatencyPercentiles(values) {
  if (!values || values.length === 0) {
    return { p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;

  // Nearest-rank method: k = ceil(P / 100 * N)
  const getPercentile = (p) => {
    const k = Math.ceil((p / 100) * len);
    return sorted[Math.max(0, k - 1)];
  };

  return {
    p50: getPercentile(50),
    p95: getPercentile(95),
    p99: getPercentile(99)
  };
}

function tableHasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);
}

/**
 * Compute analytics signals for all providers within a given time window.
 *
 * @param {import('./timeline-store.js').TimelineStore} timelineStore - The SQLite-backed timeline store
 * @param {string} windowStart - ISO timestamp (inclusive)
 * @param {string} windowEnd - ISO timestamp (inclusive)
 * @returns {Promise<Object>} Map of providerName -> signals object
 */
export async function computeSignalsForWindow(timelineStore, windowStart, windowEnd) {
  if (!timelineStore || !timelineStore.db) {
    throw new Error('Valid timelineStore with database connection required');
  }

  log.info('Computing signals for window', { windowStart, windowEnd });

  const signals = {};

  try {
  // 1. Fetch routing performance data (successes and durations)
     // We extract outcome and durationMs from the JSON event_data column.
     // Note: Better-sqlite3 is synchronous, but we keep this function async for future-proofing.
     const routingRows = timelineStore.db.prepare(`
       SELECT
         provider,
         json_extract(event_data, '$.outcome') as outcome,
         json_extract(event_data, '$.durationMs') as durationMs
       FROM routing_events
       WHERE event_ts >= ? AND event_ts <= ?
         AND provider IS NOT NULL
     `).all(windowStart, windowEnd);

    // 2. Fetch guardrail outcomes
    const guardrailRows = timelineStore.db.prepare(`
      SELECT
        provider,
        outcome
      FROM guardrail_events
      WHERE event_ts >= ? AND event_ts <= ?
        AND provider IS NOT NULL
    `).all(windowStart, windowEnd);

    // Grouping structures
    const providerStats = {}; // { [provider]: { total: 0, success: 0, durations: [] } }
    const providerGuardrails = {}; // { [provider]: { total: 0, blocked: 0 } }

    // Process routing events
    for (const row of routingRows) {
      const p = row.provider;
      if (!providerStats[p]) {
        providerStats[p] = { total: 0, success: 0, durations: [] };
      }
      providerStats[p].total++;
      if (row.outcome === 'success') {
        providerStats[p].success++;
      }
      if (typeof row.durationMs === 'number') {
        providerStats[p].durations.push(row.durationMs);
      }
    }

    // Process guardrail events
    for (const row of guardrailRows) {
      const p = row.provider;
      if (!providerGuardrails[p]) {
        providerGuardrails[p] = { total: 0, blocked: 0 };
      }
      providerGuardrails[p].total++;
      if (row.outcome === 'blocked' || row.outcome === 'block') {
        providerGuardrails[p].blocked++;
      }
    }

    // Get all unique providers from both sources
    const allProviders = new Set([
      ...Object.keys(providerStats),
      ...Object.keys(providerGuardrails)
    ]);

    for (const provider of allProviders) {
      const stats = providerStats[provider] || { total: 0, success: 0, durations: [] };
      const gr = providerGuardrails[provider] || { total: 0, blocked: 0 };

      const { p50, p95, p99 } = computeLatencyPercentiles(stats.durations);

      signals[provider] = {
        provider,
        success_rate: stats.total > 0 ? +(stats.success / stats.total).toFixed(4) : null,
        p50_latency: p50 || null,
        p95_latency: p95 || null,
        p99_latency: p99 || null,
        guardrail_violation_rate: gr.total > 0 ? +(gr.blocked / gr.total).toFixed(4) : 0,
        dispatch_count: stats.total,
        evaluation_count: gr.total,
        window_start: windowStart,
        window_end: windowEnd,
        computed_at: new Date().toISOString()
      };
    }

    log.info('Signal computation complete', { providerCount: allProviders.size });
    return signals;

  } catch (err) {
    log.error('Failed to compute signals for window', {
      windowStart,
      windowEnd,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

/**
 * Compute per-agent performance metrics over a configurable time window.
 *
 * @param {import('./timeline-store.js').TimelineStore} timelineStore - The SQLite-backed timeline store
 * @param {string} windowStart - ISO timestamp (inclusive)
 * @param {string} windowEnd - ISO timestamp (inclusive)
 * @returns {Promise<Object>} Map of agent_id -> metrics object with success_rate, dispatch_count, p50/p95/p99 latencies
 */
export async function computeAgentMetricsForWindow(timelineStore, windowStart, windowEnd) {
  if (!timelineStore || !timelineStore.db) {
    throw new Error('Valid timelineStore with database connection required');
  }

  log.info('Computing agent metrics for window', { windowStart, windowEnd });

  try {
    const routingHasIsOverturned = tableHasColumn(timelineStore.db, 'routing_events', 'is_overturned');
    const routingReviewFilter = routingHasIsOverturned
      ? `
        AND NOT (
          COALESCE(r.is_overturned, 0) = 1
          AND COALESCE(json_extract(r.event_data, '$.outcome'), '') != 'success'
        )
      `
      : '';

    // Conditionally build the overturned-rejection exclusion filter.
    // tableHasColumn returns false when the table doesn't exist, so this is safe
    // even on databases that have never run migration 015/016.
    const rejectionHasIsOverturned = tableHasColumn(timelineStore.db, 'review_rejection_events', 'is_overturned');
    const rejectionOverturnFilter = rejectionHasIsOverturned
      ? `
        AND NOT EXISTS (
          SELECT 1
          FROM review_rejection_events rr
          WHERE rr.agent_id = r.agent_id
            AND COALESCE(rr.is_overturned, 0) = 1
            AND COALESCE(json_extract(r.event_data, '$.outcome'), '') != 'success'
            AND (
              (r.dispatch_id IS NOT NULL AND rr.dispatch_id = r.dispatch_id)
              OR (r.trace_id IS NOT NULL AND rr.trace_id = r.trace_id)
              OR (r.subtask_id IS NOT NULL AND rr.subtask_id = r.subtask_id)
              OR (r.task_id IS NOT NULL AND rr.task_id = r.task_id)
            )
        )
      `
      : '';

    const agentRows = timelineStore.db.prepare(`
      SELECT
        r.agent_id,
        json_extract(r.event_data, '$.outcome') as outcome,
        json_extract(r.event_data, '$.durationMs') as durationMs
      FROM routing_events r
      WHERE r.event_ts >= ? AND r.event_ts <= ?
        AND r.agent_id IS NOT NULL
        ${routingReviewFilter}
        ${rejectionOverturnFilter}
    `).all(windowStart, windowEnd);

    const agentStats = {};

    for (const row of agentRows) {
      const agent = row.agent_id;
      if (!agentStats[agent]) {
        agentStats[agent] = { total: 0, success: 0, durations: [] };
      }
      agentStats[agent].total++;
      if (row.outcome === 'success') {
        agentStats[agent].success++;
      }
      if (typeof row.durationMs === 'number') {
        agentStats[agent].durations.push(row.durationMs);
      }
    }

    const metrics = {};
    for (const [agent, stats] of Object.entries(agentStats)) {
      const { p50, p95, p99 } = computeLatencyPercentiles(stats.durations);

      metrics[agent] = {
        agent_id: agent,
        success_rate: stats.total > 0 ? +(stats.success / stats.total).toFixed(4) : null,
        dispatch_count: stats.total,
        p50_latency: p50 || null,
        p95_latency: p95 || null,
        p99_latency: p99 || null,
        window_start: windowStart,
        window_end: windowEnd,
        computed_at: new Date().toISOString()
      };
    }

    log.info('Agent metrics computation complete', { agentCount: Object.keys(metrics).length });
    return metrics;

  } catch (err) {
    log.error('Failed to compute agent metrics for window', {
      windowStart,
      windowEnd,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

/**
 * Compute per-model performance metrics over a configurable time window.
 *
 * @param {import('./timeline-store.js').TimelineStore} timelineStore - The SQLite-backed timeline store
 * @param {string} windowStart - ISO timestamp (inclusive)
 * @param {string} windowEnd - ISO timestamp (inclusive)
 * @returns {Promise<Object>} Map of model keys (provider::taskCategory) -> metrics object with success_rate, dispatch_count, p50/p95/p99 latencies, grouped by task_category
 */
export async function computeModelMetricsForWindow(timelineStore, windowStart, windowEnd) {
  if (!timelineStore || !timelineStore.db) {
    throw new Error('Valid timelineStore with database connection required');
  }

  log.info('Computing model metrics for window', { windowStart, windowEnd });

  try {
    const modelRows = timelineStore.db.prepare(`
      SELECT
        provider,
        COALESCE(json_extract(event_data, '$.taskCategory'), json_extract(event_data, '$.task_category'), 'general') as taskCategory,
        json_extract(event_data, '$.outcome') as outcome,
        json_extract(event_data, '$.durationMs') as durationMs
      FROM routing_events
      WHERE event_ts >= ? AND event_ts <= ?
        AND provider IS NOT NULL
    `).all(windowStart, windowEnd);

    const modelStats = {};

    for (const row of modelRows) {
      const modelKey = `${row.provider}::${row.taskCategory}`;
      if (!modelStats[modelKey]) {
        modelStats[modelKey] = {
          provider: row.provider,
          taskCategory: row.taskCategory,
          total: 0,
          success: 0,
          durations: []
        };
      }
      modelStats[modelKey].total++;
      if (row.outcome === 'success') {
        modelStats[modelKey].success++;
      }
      if (typeof row.durationMs === 'number') {
        modelStats[modelKey].durations.push(row.durationMs);
      }
    }

    const metrics = {};
    const metricsByCategory = {};

    for (const [modelKey, stats] of Object.entries(modelStats)) {
      const { p50, p95, p99 } = computeLatencyPercentiles(stats.durations);

      metrics[modelKey] = {
        model_key: modelKey,
        provider: stats.provider,
        taskCategory: stats.taskCategory,
        success_rate: stats.total > 0 ? +(stats.success / stats.total).toFixed(4) : null,
        dispatch_count: stats.total,
        p50_latency: p50 || null,
        p95_latency: p95 || null,
        p99_latency: p99 || null,
        window_start: windowStart,
        window_end: windowEnd,
        computed_at: new Date().toISOString()
      };

      if (!metricsByCategory[stats.taskCategory]) {
        metricsByCategory[stats.taskCategory] = [];
      }
      metricsByCategory[stats.taskCategory].push(metrics[modelKey]);
    }

    log.info('Model metrics computation complete', { 
      modelCount: Object.keys(metrics).length, 
      categoryCount: Object.keys(metricsByCategory).length 
    });

    return {
      metrics,
      byCategory: metricsByCategory
    };

  } catch (err) {
    log.error('Failed to compute model metrics for window', {
      windowStart,
      windowEnd,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

/**
 * Compute reviewer accuracy metrics over a configurable time window.
 *
 * A review is considered incorrect if it has been overturned (COALESCE(is_overturned, 0) = 1).
 * Accuracy is calculated as: (total_reviews - overturned_count) / total_reviews * 100
 *
 * @param {string} baseDir - Base directory containing the state database (e.g., '.synapse')
 * @param {string} windowStart - ISO timestamp (inclusive)
 * @param {string} windowEnd - ISO timestamp (inclusive)
 * @param {Object} [options] - Options
 * @param {string} [options.reviewerId] - Optional filter to compute accuracy for a specific reviewer
 * @returns {Promise<Object>} Map of reviewer_id -> {total_reviews, overturned_count, accuracy_percentage}
 */
export async function computeReviewerAccuracyForWindow(baseDir, windowStart, windowEnd, options = {}) {
  const { reviewerId } = options;

  log.info('Computing reviewer accuracy for window', { windowStart, windowEnd, reviewerId });

  try {
    const db = getDb(baseDir);

    // Query tasks table for all reviews within the time window
    // A task is considered a "review" if it has a reviewer_id set
    const query = `
      SELECT
        reviewer_id,
        COUNT(*) as total_reviews,
        SUM(CASE WHEN COALESCE(is_overturned, 0) = 1 THEN 1 ELSE 0 END) as overturned_count
      FROM tasks
      WHERE reviewer_id IS NOT NULL
        AND completed_at IS NOT NULL
        AND completed_at >= ?
        AND completed_at <= ?
        ${reviewerId ? 'AND reviewer_id = ?' : ''}
      GROUP BY reviewer_id
    `;

    const params = reviewerId ? [windowStart, windowEnd, reviewerId] : [windowStart, windowEnd];
    const rows = db.prepare(query).all(...params);

    const accuracy = {};
    for (const row of rows) {
      const correctReviews = row.total_reviews - row.overturned_count;
      const accuracyPct = row.total_reviews > 0
        ? +(correctReviews / row.total_reviews * 100).toFixed(2)
        : 0;

      accuracy[row.reviewer_id] = {
        reviewer_id: row.reviewer_id,
        total_reviews: row.total_reviews,
        overturned_count: row.overturned_count,
        correct_reviews: correctReviews,
        accuracy_percentage: accuracyPct,
        window_start: windowStart,
        window_end: windowEnd,
        computed_at: new Date().toISOString()
      };
    }

    log.info('Reviewer accuracy computation complete', { reviewerCount: Object.keys(accuracy).length });
    return accuracy;

  } catch (err) {
    log.error('Failed to compute reviewer accuracy for window', {
      windowStart,
      windowEnd,
      reviewerId,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}

export default {
  computeSignalsForWindow,
  computeAgentMetricsForWindow,
  computeModelMetricsForWindow,
  computeReviewerAccuracyForWindow,
  invalidateReviewerAccuracyCache,
  invalidateAllReviewerAccuracyCache,
  clearReviewerAccuracyCache
};
