// src/orchestrator/correlation-metrics.js — Tracks correlation pipeline metrics
//
// Exposes functions for successfully correlated events, fallback lookups,
// correlation failures, and out-of-window events.

import { createLogger } from '../logger.js';

const log = createLogger('correlation-metrics');

/** Reason buckets for correlation fallback */
export const FALLBACK_REASONS = Object.freeze({
  MISSING_TRACE_ID: 'missing_trace_id',
  MISSING_DISPATCH_ID: 'missing_dispatch_id',
  DISPATCH_NOT_FOUND: 'dispatch_not_found', // for compatibility with timeline-ingest
  LOOKUP_ERROR: 'lookup_error',
  OUTSIDE_WINDOW: 'outside_window',
  FALLBACK_UUID: 'fallback_uuid',
});

/** @deprecated Use FALLBACK_REASONS */
export const FAILURE_REASONS = FALLBACK_REASONS;

// Internal state for metrics
let totalDispatches = 0;
let correlatedDispatches = 0;
let missingCorrelationIds = 0;
let fallbackLookupCases = 0;

// Per-agent/category breakdown
// Structure: { [agent_id]: { totalDispatches, correlatedDispatches, ... categories: { [category]: { ... } } } }
let agentMetrics = {};

/**
 * Ensures the nested structure for agent and category metrics exists.
 * @param {string} agentId 
 * @param {string} category 
 * @returns {object} The category metrics object
 */
function ensureMetrics(agentId = 'unknown', category = 'unknown') {
  const aid = agentId || 'unknown';
  const cat = category || 'unknown';
  
  if (!agentMetrics[aid]) {
    agentMetrics[aid] = {
      totalDispatches: 0,
      correlatedDispatches: 0,
      missingCorrelationIds: 0,
      fallbackLookupCases: 0,
      categories: {},
    };
  }
  
  const agent = agentMetrics[aid];
  const catKey = `${aid}-${cat}`; // unique key for category within agent
  
  if (!agent.categories[catKey]) {
    agent.categories[catKey] = {
      category: cat,
      totalDispatches: 0,
      correlatedDispatches: 0,
      missingCorrelationIds: 0,
      fallbackLookupCases: 0,
      reasons: {},
    };
  }
  
  return agent.categories[catKey];
}

export function incrementTotalDispatches({ agent_id, category } = {}) {
  totalDispatches++;
  const catMetrics = ensureMetrics(agent_id, category);
  catMetrics.totalDispatches++;
  agentMetrics[agent_id || 'unknown'].totalDispatches++;
}

export function incrementCorrelatedDispatches({ agent_id, category } = {}) {
  correlatedDispatches++;
  const catMetrics = ensureMetrics(agent_id, category);
  catMetrics.correlatedDispatches++;
  agentMetrics[agent_id || 'unknown'].correlatedDispatches++;
}

export function incrementMissingCorrelationIds({ agent_id, category } = {}) {
  missingCorrelationIds++;
  const catMetrics = ensureMetrics(agent_id, category);
  catMetrics.missingCorrelationIds++;
  agentMetrics[agent_id || 'unknown'].missingCorrelationIds++;
}

export function incrementFallbackLookupCases({ agent_id, category, reason } = {}) {
  fallbackLookupCases++;
  correlatedDispatches++; // Fallback is still a successful correlation
  const catMetrics = ensureMetrics(agent_id, category);
  catMetrics.fallbackLookupCases++;
  catMetrics.correlatedDispatches++;
  agentMetrics[agent_id || 'unknown'].fallbackLookupCases++;
  agentMetrics[agent_id || 'unknown'].correlatedDispatches++;
  
  const r = reason || 'unknown';
  catMetrics.reasons[r] = (catMetrics.reasons[r] || 0) + 1;
}

export async function getCorrelationMetricsSnapshot() {
  const total = totalDispatches;
  const correlated = correlatedDispatches;
  
  return {
    totalDispatches: total,
    correlatedDispatches: correlated,
    missingCorrelationIds,
    fallbackLookupCases,
    correlationRate: total > 0 ? correlated / total : null,
    missingIdRate: total > 0 ? missingCorrelationIds / total : null,
    fallbackRate: total > 0 ? fallbackLookupCases / total : null,
    byAgent: agentMetrics,
    timestamp: new Date().toISOString(),
  };
}

export function resetCorrelationMetrics() {
  totalDispatches = 0;
  correlatedDispatches = 0;
  missingCorrelationIds = 0;
  fallbackLookupCases = 0;
  agentMetrics = {};
}

// For backward compatibility with the class-based approach if needed by other modules
export class CorrelationMetrics {
  recordSuccess() { incrementCorrelatedDispatches(); }
  recordFallback() { incrementFallbackLookupCases(); }
  recordFailure(reason) { 
    if (reason === 'outside_window') incrementFallbackLookupCases({ reason: FALLBACK_REASONS.OUTSIDE_WINDOW });
    else incrementMissingCorrelationIds();
  }
  recordOutOfWindow() { incrementFallbackLookupCases({ reason: FALLBACK_REASONS.OUTSIDE_WINDOW }); }
  getSnapshot() {
    const total = totalDispatches;
    const correlated = correlatedDispatches;
    return {
      totalIngested: total,
      success: correlated - fallbackLookupCases, // approximate
      fallback: fallbackLookupCases,
      failures: missingCorrelationIds,
      outOfWindow: 0, // consolidated into fallback reasons
      correlationRate: total > 0 ? correlated / total : null,
      failuresByReason: {},
      startedAt: new Date().toISOString(),
    };
  }
}

export function createCorrelationMetrics() {
  return new CorrelationMetrics();
}

export default {
  incrementTotalDispatches,
  incrementCorrelatedDispatches,
  incrementMissingCorrelationIds,
  incrementFallbackLookupCases,
  getCorrelationMetricsSnapshot,
  resetCorrelationMetrics,
  FALLBACK_REASONS,
};
