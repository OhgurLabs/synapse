// routing-analytics.js — Provider-level routing analytics and auto-tuning recommendations
//
// Pure-function module that computes per-provider performance aggregates and deltas.
// Used by /api/routing-analytics endpoint to surface auto-tuning suggestions.
//
// Usage:
//   const deltas = computeProviderDeltas(dispatchLog, performanceStore, { since, campaignId, agents });
//   const recommendations = generateRecommendations(deltas);

import { createLogger } from '../logger.js';

const log = createLogger('routing-analytics');

/**
 * Compute per-provider performance aggregates and deltas.
 *
 * @param {Object} dispatchLog - DispatchLog instance
 * @param {Object} performanceStore - PerformanceStore instance
 * @param {Object} opts - Options
 * @param {string} [opts.since] - ISO timestamp for lower time bound
 * @param {string} [opts.until] - ISO timestamp for upper time bound
 * @param {string} [opts.campaignId] - Filter by campaign ID
 * @param {Object} [opts.agents] - Agent registry mapping agent ID to { provider, ... }
 * @param {number} [opts.minDispatches=5] - Minimum dispatches threshold for including provider
 * @returns {Object} { providers: [...], deltas: [...], metadata: {...} }
 */
export function computeProviderDeltas(dispatchLog, performanceStore, opts = {}) {
  const { since, until, campaignId, agents = {}, minDispatches = 5 } = opts;

  // Query dispatch decisions from the dispatch log
  const filters = {};
  if (since) filters.startTime = since;
  if (until) filters.endTime = until;
  if (campaignId) filters.campaignId = campaignId;
  filters.limit = 500; // Max allowed

  const { decisions } = dispatchLog.query(filters);

  // Build provider-level aggregates from dispatch decisions
  const providerStats = {};

  for (const decision of decisions) {
    const agentId = decision.selectedAgent;
    if (!agentId) continue;

    // Map agent ID to provider
    let provider = null;
    if (agents[agentId]?.provider) {
      provider = agents[agentId].provider;
    } else {
      // Fallback: extract from candidates array in decision
      const candidate = decision.candidates?.find(c => c.agentId === agentId);
      if (candidate?.provider) {
        provider = candidate.provider;
      }
    }

    if (!provider) {
      log.warn(`Could not determine provider for agent ${agentId}, skipping decision ${decision.id}`);
      continue;
    }

    // Initialize provider stats if needed
    if (!providerStats[provider]) {
      providerStats[provider] = {
        provider,
        totalDispatches: 0,
        successCount: 0,
        failureCount: 0,
        partialCount: 0,
        totalDurationMs: 0,
        latencyDispatches: 0,
        knownOutcomes: 0,
        durationSamples: 0,
        durationSum: 0,
      };
    }

    const stats = providerStats[provider];
    stats.totalDispatches += 1;

    // Aggregate outcome counts
    if (decision.outcome === 'success') {
      stats.successCount += 1;
      stats.knownOutcomes += 1;
    } else if (decision.outcome === 'failure') {
      stats.failureCount += 1;
      stats.knownOutcomes += 1;
    } else if (decision.outcome === 'partial') {
      stats.partialCount += 1;
      stats.knownOutcomes += 1;
    }
  }

  // Enrich with performance store data (latency/duration)
  const allAgentStats = performanceStore?.getAllAgentStats() || [];

  for (const agentStat of allAgentStats) {
    const agentId = agentStat.agentId;
    let provider = null;

    if (agents[agentId]?.provider) {
      provider = agents[agentId].provider;
    }

    if (!provider) continue;

    if (!providerStats[provider]) {
      providerStats[provider] = {
        provider,
        totalDispatches: 0,
        successCount: 0,
        failureCount: 0,
        partialCount: 0,
        totalDurationMs: 0,
        latencyDispatches: 0,
        knownOutcomes: 0,
        p95WeightedSum: 0,
        p95Dispatches: 0,
        p50WeightedSum: 0,
        p50Dispatches: 0,
        p99WeightedSum: 0,
        p99Dispatches: 0,
      };
    }

    // Accumulate duration data from performance store
    if (agentStat.avgDurationMs && agentStat.totalDispatches > 0) {
      providerStats[provider].totalDurationMs += agentStat.avgDurationMs * agentStat.totalDispatches;
      providerStats[provider].latencyDispatches += agentStat.totalDispatches;
    }

    // Accumulate actual p95 latency (weighted by dispatch count)
    if (agentStat.p95LatencyMs !== null && agentStat.p95LatencyMs !== undefined && agentStat.totalDispatches > 0) {
      providerStats[provider].p95WeightedSum += agentStat.p95LatencyMs * agentStat.totalDispatches;
      providerStats[provider].p95Dispatches += agentStat.totalDispatches;
    }

    // Accumulate actual p50 latency (weighted by dispatch count)
    if (agentStat.p50LatencyMs !== null && agentStat.p50LatencyMs !== undefined && agentStat.totalDispatches > 0) {
      providerStats[provider].p50WeightedSum += agentStat.p50LatencyMs * agentStat.totalDispatches;
      providerStats[provider].p50Dispatches += agentStat.totalDispatches;
    }

    // Accumulate actual p99 latency (weighted by dispatch count)
    if (agentStat.p99LatencyMs !== null && agentStat.p99LatencyMs !== undefined && agentStat.totalDispatches > 0) {
      providerStats[provider].p99WeightedSum += agentStat.p99LatencyMs * agentStat.totalDispatches;
      providerStats[provider].p99Dispatches += agentStat.totalDispatches;
    }
  }

  // Compute final aggregates
  const providers = [];
  for (const stats of Object.values(providerStats)) {
    const successRate = stats.knownOutcomes > 0
      ? stats.successCount / stats.knownOutcomes
      : null;

    const avgLatencyMs = stats.latencyDispatches > 0
      ? stats.totalDurationMs / stats.latencyDispatches
      : null;

    // Compute weighted average p95 latency from actual PerformanceStore values
    const p95LatencyMs = stats.p95Dispatches > 0
      ? Math.round(stats.p95WeightedSum / stats.p95Dispatches)
      : null;

    // Compute weighted average p50 latency from actual PerformanceStore values
    const p50LatencyMs = stats.p50Dispatches > 0
      ? Math.round(stats.p50WeightedSum / stats.p50Dispatches)
      : null;

    // Compute weighted average p99 latency from actual PerformanceStore values
    const p99LatencyMs = stats.p99Dispatches > 0
      ? Math.round(stats.p99WeightedSum / stats.p99Dispatches)
      : null;

    providers.push({
      provider: stats.provider,
      totalDispatches: stats.totalDispatches,
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      partialCount: stats.partialCount,
      successRate,
      avgLatencyMs,
      p50LatencyMs,
      p95LatencyMs,
      p99LatencyMs,
    });
  }

  // Filter out providers below minimum threshold
  const qualifiedProviders = providers.filter(p => p.totalDispatches >= minDispatches);

  // Compute pairwise deltas between providers
  const deltas = [];
  for (let i = 0; i < qualifiedProviders.length; i++) {
    for (let j = i + 1; j < qualifiedProviders.length; j++) {
      const a = qualifiedProviders[i];
      const b = qualifiedProviders[j];

      const successDelta = (a.successRate !== null && b.successRate !== null)
        ? a.successRate - b.successRate
        : null;

      const avgLatencyDelta = (a.avgLatencyMs !== null && b.avgLatencyMs !== null)
        ? a.avgLatencyMs - b.avgLatencyMs
        : null;

      const p95LatencyDelta = (a.p95LatencyMs !== null && b.p95LatencyMs !== null)
        ? a.p95LatencyMs - b.p95LatencyMs
        : null;

      // Compute relative p95 latency delta (percentage difference)
      const relativeP95LatencyDelta = (a.p95LatencyMs !== null && b.p95LatencyMs !== null && b.p95LatencyMs > 0)
        ? (a.p95LatencyMs - b.p95LatencyMs) / b.p95LatencyMs
        : null;

      deltas.push({
        providerA: a.provider,
        providerB: b.provider,
        successDelta,
        avgLatencyDelta,
        p95LatencyDelta,
        relativeP95LatencyDelta,
        dispatchesA: a.totalDispatches,
        dispatchesB: b.totalDispatches,
        successRateA: a.successRate,
        successRateB: b.successRate,
        avgLatencyA: a.avgLatencyMs,
        avgLatencyB: b.avgLatencyMs,
        p95LatencyA: a.p95LatencyMs,
        p95LatencyB: b.p95LatencyMs,
      });
    }
  }

  return {
    providers,
    deltas,
    metadata: {
      totalDecisions: decisions.length,
      timeWindow: { since, until },
      campaignId,
      minDispatches,
    },
  };
}

/**
 * Generate auto-tuning recommendations based on provider deltas.
 *
 * Thresholds: >5% success rate delta or >20% relative p95 latency delta.
 * Each recommendation includes old/new weights, detailed rationale with metrics,
 * and a confidence score that considers both sample size and delta magnitude.
 *
 * Each recommendation is assigned a unique ID (timestamp-based) and timestamp
 * for audit trail persistence.
 *
 * @param {Object} deltaResult - Output from computeProviderDeltas()
 * @returns {Array<Object>} Array of recommendation objects with id, timestamp, and audit metadata
 */
export function generateRecommendations(deltaResult) {
  const { providers, deltas } = deltaResult;
  const recommendations = [];

  // Generate base timestamp for this batch of recommendations
  const batchTimestamp = Date.now();
  let sequenceNumber = 0;

  // Thresholds for generating recommendations
  const SUCCESS_DELTA_THRESHOLD = 0.05; // 5% success rate difference
  const P95_RELATIVE_THRESHOLD = 0.20;  // 20% relative p95 latency difference

  // Find significant performance deltas
  for (const delta of deltas) {
    const {
      providerA, providerB,
      successDelta, relativeP95LatencyDelta,
      dispatchesA, dispatchesB,
    } = delta;

    // Skip if insufficient data for success rate
    if (successDelta === null) continue;

    let winner, loser;
    let triggerType = null;

    // Check success delta first
    if (successDelta > SUCCESS_DELTA_THRESHOLD) {
      winner = providerA;
      loser = providerB;
      triggerType = 'success';
    } else if (successDelta < -SUCCESS_DELTA_THRESHOLD) {
      winner = providerB;
      loser = providerA;
      triggerType = 'success';
    }

    // If success is not significant, check p95 latency (lower is better)
    if (!triggerType && relativeP95LatencyDelta != null) {
      if (relativeP95LatencyDelta < -P95_RELATIVE_THRESHOLD) {
        winner = providerA;
        loser = providerB;
        triggerType = 'latency';
      } else if (relativeP95LatencyDelta > P95_RELATIVE_THRESHOLD) {
        winner = providerB;
        loser = providerA;
        triggerType = 'latency';
      }
    }

    if (!triggerType) continue;

    // Get provider stats for context
    const winnerStats = providers.find(p => p.provider === winner);
    const loserStats = providers.find(p => p.provider === loser);
    if (!winnerStats || !loserStats) continue;

    const winnerSuccessRate = winnerStats.successRate;
    const loserSuccessRate = loserStats.successRate;
    const actualSuccessDiff = Math.abs(winnerSuccessRate - loserSuccessRate);
    const winnerP95 = winnerStats.p95LatencyMs;
    const loserP95 = loserStats.p95LatencyMs;

    // Compute relative p95 advantage (positive = winner faster)
    let relativeP95Advantage = 0;
    if (winnerP95 != null && loserP95 != null && loserP95 > 0) {
      relativeP95Advantage = (loserP95 - winnerP95) / loserP95;
    }

    // Build rationale array with detailed metrics
    const rationale = [];
    if (actualSuccessDiff > SUCCESS_DELTA_THRESHOLD) {
      rationale.push(
        `${winner} success rate ${(winnerSuccessRate * 100).toFixed(1)}% vs ${loser} ${(loserSuccessRate * 100).toFixed(1)}% (delta +${(actualSuccessDiff * 100).toFixed(1)}%)`
      );
    }
    if (winnerP95 != null && loserP95 != null && Math.abs(loserP95 - winnerP95) > 1) {
      rationale.push(
        `${winner} p95 latency ${winnerP95}ms vs ${loser} ${loserP95}ms (${(relativeP95Advantage * 100).toFixed(1)}% ${winnerP95 < loserP95 ? 'faster' : 'slower'})`
      );
    }
    rationale.push(
      `Sample sizes: ${winner} ${winnerStats.totalDispatches} dispatches, ${loser} ${loserStats.totalDispatches} dispatches`
    );

    // Build message
    let message = `Shift weight from ${loser} to ${winner}`;
    const reasons = [];
    if (actualSuccessDiff > SUCCESS_DELTA_THRESHOLD) {
      reasons.push(`success rate +${(actualSuccessDiff * 100).toFixed(1)}%`);
    }
    if (winnerP95 != null && loserP95 != null && winnerP95 < loserP95 && loserP95 > 0) {
      const pctFaster = ((loserP95 - winnerP95) / loserP95 * 100).toFixed(1);
      reasons.push(`p95 latency -${pctFaster}%`);
    }
    if (reasons.length > 0) {
      message += `: ${reasons.join(', ')}`;
    }

    // Calculate confidence based on both sample size AND delta magnitude
    const minSampleSize = Math.min(dispatchesA, dispatchesB);
    let confidenceScore = 0;

    // Sample size contribution (0–0.5)
    if (minSampleSize >= 50) {
      confidenceScore += 0.5;
    } else if (minSampleSize >= 20) {
      confidenceScore += 0.3;
    } else if (minSampleSize >= 5) {
      confidenceScore += 0.1;
    }

    // Delta magnitude contribution (0–0.5)
    if (actualSuccessDiff > 0.20) {
      confidenceScore += 0.4;
    } else if (actualSuccessDiff > 0.10) {
      confidenceScore += 0.3;
    } else if (actualSuccessDiff > 0.05) {
      confidenceScore += 0.15;
    }

    // P95 latency advantage contribution (0–0.2)
    if (relativeP95Advantage > 0.20) {
      confidenceScore += 0.2;
    }

    confidenceScore = Math.round(confidenceScore * 100) / 100;

    let confidence;
    if (confidenceScore >= 0.7) {
      confidence = 'high';
    } else if (confidenceScore >= 0.4) {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    // Compute weight adjustments once, attach to all shift recommendations
    const { old_weights, new_weights } = computeWeightAdjustments(deltaResult);

    // Generate unique recommendation ID (timestamp + sequence)
    const recommendationId = `rec_${batchTimestamp}_${String(sequenceNumber).padStart(3, '0')}`;
    sequenceNumber++;

    recommendations.push({
      id: recommendationId,
      timestamp: new Date(batchTimestamp).toISOString(),
      type: 'shift_weight',
      message,
      confidence,
      confidenceScore,
      rationale,
      old_weights,
      new_weights,
      context: {
        winner,
        loser,
        successDelta: actualSuccessDiff,
        p95LatencyDelta: delta.p95LatencyDelta,
        relativeP95LatencyDelta: delta.relativeP95LatencyDelta,
        winnerSuccessRate,
        loserSuccessRate,
        winnerP95LatencyMs: winnerP95,
        winnerP95Latency: winnerP95,
        loserP95LatencyMs: loserP95,
        loserP95Latency: loserP95,
        winnerTotalDispatches: winnerStats.totalDispatches,
        loserTotalDispatches: loserStats.totalDispatches,
      },
    });
  }

  // If no recommendations, add a default "no action needed" message
  if (recommendations.length === 0) {
    // Compute current weights for "no action" recommendation
    const { old_weights } = computeWeightAdjustments(deltaResult);

    const recommendationId = `rec_${batchTimestamp}_${String(sequenceNumber).padStart(3, '0')}`;

    recommendations.push({
      id: recommendationId,
      timestamp: new Date(batchTimestamp).toISOString(),
      type: 'no_action',
      message: 'No significant performance deltas detected. Current routing weights appear optimal.',
      confidence: 'high',
      confidenceScore: 1.0,
      rationale: [
        'All provider performance metrics are within acceptable thresholds (< 5% success delta, < 20% relative p95 latency delta).',
      ],
      old_weights,
      new_weights: old_weights, // No change recommended
      context: {
        providersAnalyzed: providers.length,
        totalDispatches: providers.reduce((sum, p) => sum + p.totalDispatches, 0),
      },
    });
  }

  return recommendations;
}

/**
 * Compute current and proposed routing weights per provider.
 *
 * Current weights are based on dispatch distribution. Proposed weights use
 * delta-proportional allocation based on success rate and p95 latency performance.
 *
 * @param {Object} deltaResult - Output from computeProviderDeltas()
 * @param {Object} [opts] - Options
 * @param {number} [opts.minWeight=0.05] - Floor weight to preserve exploration
 * @param {number} [opts.successWeight=0.7] - Weight given to success rate (vs 0.3 for latency)
 * @returns {{ old_weights: Object, new_weights: Object }}
 */
export function computeWeightAdjustments(deltaResult, opts = {}) {
  const { providers } = deltaResult;
  const {
    minWeight = 0.05,
    successWeight = 0.7,
  } = opts;

  if (providers.length === 0) {
    return { old_weights: {}, new_weights: {} };
  }

  // Step 1: Compute old weights from current dispatch distribution
  const totalDispatches = providers.reduce((sum, p) => sum + p.totalDispatches, 0);

  if (totalDispatches === 0) {
    // No data - return uniform weights
    const uniform = +(1 / providers.length).toFixed(4);
    const weights = {};
    for (const p of providers) {
      weights[p.provider] = uniform;
    }
    return { old_weights: weights, new_weights: weights };
  }

  const old_weights = {};
  for (const p of providers) {
    old_weights[p.provider] = +(p.totalDispatches / totalDispatches).toFixed(4);
  }

  // Step 2: Compute performance scores for each provider
  // Combine success rate and latency (inverse) into a composite score
  const providerScores = {};

  for (const p of providers) {
    let score = 0;

    // Success rate component (0.7 weight by default)
    if (p.successRate !== null) {
      score += p.successRate * successWeight;
    } else {
      score += 0.5 * successWeight; // Neutral for unknown
    }

    // Latency component (0.3 weight by default) - use p95 if available, else avg
    const latencyValue = p.p95LatencyMs || p.avgLatencyMs;
    if (latencyValue !== null && latencyValue > 0) {
      // Will normalize after collecting all latencies
      providerScores[p.provider] = { score, latency: latencyValue };
    } else {
      providerScores[p.provider] = { score, latency: null };
    }
  }

  // Normalize latency component (invert so lower latency = higher score)
  const latencies = Object.values(providerScores)
    .map(s => s.latency)
    .filter(l => l !== null);

  if (latencies.length > 0) {
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const latencyRange = maxLatency - minLatency;

    for (const provider in providerScores) {
      const { score, latency } = providerScores[provider];
      if (latency !== null && latencyRange > 0) {
        // Normalize to 0-1 range, then invert (lower is better)
        const normalizedLatency = (latency - minLatency) / latencyRange;
        const latencyScore = (1 - normalizedLatency) * (1 - successWeight);
        providerScores[provider] = score + latencyScore;
      } else if (latency !== null && latencyRange === 0) {
        // All latencies equal
        providerScores[provider] = score + (0.5 * (1 - successWeight));
      } else {
        // No latency data
        providerScores[provider] = score + (0.5 * (1 - successWeight));
      }
    }
  } else {
    // No latency data for any provider
    for (const provider in providerScores) {
      providerScores[provider] = providerScores[provider].score + (0.5 * (1 - successWeight));
    }
  }

  // Step 3: Apply delta-proportional weighting (similar to router.js computeRoutingWeights)
  const minScore = Math.min(...Object.values(providerScores));
  const scoreDeltas = {};

  for (const provider in providerScores) {
    scoreDeltas[provider] = providerScores[provider] - minScore;
  }

  const sumDeltas = Object.values(scoreDeltas).reduce((sum, d) => sum + d, 0);
  const new_weights = {};

  if (sumDeltas > 0) {
    // Compute raw proportional weights
    const rawWeights = {};
    for (const provider in scoreDeltas) {
      rawWeights[provider] = scoreDeltas[provider] / sumDeltas;
    }

    // Apply floor weight
    const flooredWeights = {};
    for (const provider in rawWeights) {
      flooredWeights[provider] = Math.max(minWeight, rawWeights[provider]);
    }

    // Normalize to sum to 1.0
    const sumFloored = Object.values(flooredWeights).reduce((sum, w) => sum + w, 0);
    for (const provider in flooredWeights) {
      new_weights[provider] = +(flooredWeights[provider] / sumFloored).toFixed(4);
    }
  } else {
    // All scores equal - use uniform weights
    const uniform = +(1 / providers.length).toFixed(4);
    for (const p of providers) {
      new_weights[p.provider] = uniform;
    }
  }

  return { old_weights, new_weights };
}

