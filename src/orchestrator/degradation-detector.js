// degradation-detector.js — Detect sustained performance degradation and build decay proposals
//
// Provides:
// - detectSustainedDegradation(signalHistory): detects minConsecutiveDeclines consecutive windows
//   of declining success rate (by declineThreshold)
// - buildDecayProposalFromEvidence(degradation, config): converts detection results into
//   recommendation objects compatible with createRoutingProposal()
//
// Usage:
//   const degradations = detectSustainedDegradation(signalHistory, { minConsecutiveDeclines: 3, declineThreshold: 0.03 });
//   const proposals = degradations.map(d => buildDecayProposalFromEvidence(d, config));

import { createLogger } from '../logger.js';

const log = createLogger('degradation-detector');

/**
 * Detect sustained degradation in analytics signal history.
 * Checks for minConsecutiveDeclines consecutive windows of declining success rate
 * by at least declineThreshold each window.
 *
 * @param {Object[]} signalHistory - Array of signal snapshots sorted by generatedAt descending (newest first)
 * @param {Object} config - Configuration
 * @param {number} config.minConsecutiveDeclines - Minimum consecutive declining windows required (default: 3)
 * @param {number} config.declineThreshold - Minimum decline in success rate between windows (default: 0.03)
 * @returns {Object[]} Array of degradation objects with agentId, category, windowDeltas, evidence
 */
export function detectSustainedDegradation(signalHistory, config = {}) {
  const {
    minConsecutiveDeclines = 3,
    declineThreshold = 0.03,
  } = config;

  if (!signalHistory || !Array.isArray(signalHistory) || signalHistory.length === 0) {
    return [];
  }

  // Group signals by provider and task category
  const groupedSignals = new Map();
  
  for (const signal of signalHistory) {
    const key = `${signal.provider}:${signal.taskCategory || 'global'}`;
    
    if (!groupedSignals.has(key)) {
      groupedSignals.set(key, []);
    }
    
    groupedSignals.get(key).push(signal);
  }

  const degradations = [];

  // Check each provider/category combination
  for (const [key, signals] of groupedSignals) {
    // Sort by generatedAt ascending (oldest first) for chronological analysis
    const sortedSignals = [...signals].sort((a, b) => 
      new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime()
    );

    if (sortedSignals.length < minConsecutiveDeclines) {
      continue;
    }

    // Calculate window-over-window success rate deltas
    const windowDeltas = [];
    for (let i = 1; i < sortedSignals.length; i++) {
      const prevSignal = sortedSignals[i - 1];
      const currSignal = sortedSignals[i];
      
      if (prevSignal.successRate === null || currSignal.successRate === null) {
        continue;
      }

      const delta = currSignal.successRate - prevSignal.successRate;
      windowDeltas.push({
        fromWindow: `${prevSignal.windowStart} to ${prevSignal.windowEnd}`,
        toWindow: `${currSignal.windowStart} to ${currSignal.windowEnd}`,
        prevSuccessRate: prevSignal.successRate,
        currSuccessRate: currSignal.successRate,
        delta,
      });
    }

    if (windowDeltas.length === 0) {
      continue;
    }

    // Find consecutive declining windows
    let consecutiveDeclines = 0;
    const decliningSequence = [];

    for (const windowDelta of windowDeltas) {
      if (windowDelta.delta < -declineThreshold) {
        consecutiveDeclines++;
        decliningSequence.push(windowDelta);
      } else {
        // Reset if decline threshold not met
        consecutiveDeclines = 0;
        decliningSequence.length = 0;
      }

      // Check if we have enough consecutive declines
      if (consecutiveDeclines >= minConsecutiveDeclines) {
        const provider = signals[0].provider;
        const taskCategory = signals[0].taskCategory || null;
        
        degradations.push({
          agentId: provider,
          category: taskCategory,
          windowDeltas: decliningSequence.slice(-minConsecutiveDeclines),
          evidence: {
            totalWindowsAnalyzed: sortedSignals.length,
            consecutiveDeclines: minConsecutiveDeclines,
            declineThreshold,
            firstDeclineWindow: decliningSequence[0].fromWindow,
            lastDeclineWindow: decliningSequence[decliningSequence.length - 1].toWindow,
            initialSuccessRate: decliningSequence[0].prevSuccessRate,
            finalSuccessRate: decliningSequence[decliningSequence.length - 1].currSuccessRate,
            totalDecline: decliningSequence[0].prevSuccessRate - decliningSequence[decliningSequence.length - 1].currSuccessRate,
          },
        });
        
        // Move to next potential sequence after this one
        break;
      }
    }
  }

  return degradations;
}

/**
 * Build a decay proposal recommendation from degradation evidence.
 * Converts detection results into recommendation objects compatible with createRoutingProposal().
 *
 * @param {Object} degradation - Degradation object from detectSustainedDegradation()
 * @param {Object} config - Configuration
 * @param {number} config.defaultTtlMs - Default TTL for proposals in milliseconds (default: 604800000 = 7 days)
 * @param {number} [config.weightReductionScale=0.5] - Scale factor for weight reduction (0.0-1.0)
 * @returns {Object} Recommendation object compatible with createRoutingProposal()
 */
export function buildDecayProposalFromEvidence(degradation, config = {}) {
  const {
    defaultTtlMs = 604800000, // 7 days in milliseconds
    weightReductionScale = 0.5,
  } = config;

  const { agentId, category, windowDeltas, evidence } = degradation;

  // Build detailed rationale with window-over-window deltas
  const rationaleParts = [
    `Sustained degradation detected for ${agentId}${category ? ` (${category})` : ''}: ${evidence.consecutiveDeclines} consecutive windows declining by ≥${(evidence.declineThreshold * 100).toFixed(0)}%`,
    `Success rate declined from ${(evidence.initialSuccessRate * 100).toFixed(1)}% to ${(evidence.finalSuccessRate * 100).toFixed(1)}% (total: -${(evidence.totalDecline * 100).toFixed(1)}%)`,
  ];

  // Add per-window deltas
  for (let i = 0; i < windowDeltas.length; i++) {
    const delta = windowDeltas[i];
    rationaleParts.push(
      `Window ${i + 1}: ${(delta.prevSuccessRate * 100).toFixed(1)}% → ${(delta.currSuccessRate * 100).toFixed(1)}% (${delta.delta < 0 ? '' : '-'}${(Math.abs(delta.delta) * 100).toFixed(1)}%)`
    );
  }

  const rationale = rationaleParts.join('; ');

  // Calculate proposed weight reduction based on total decline
  const proposedReduction = Math.min(weightReductionScale, evidence.totalDecline);
  
  // Build old/new weights (single provider/category focus)
  const old_weights = { [agentId]: 1.0 };
  const new_weights = { [agentId]: Math.max(0.1, 1.0 - proposedReduction) };

  // Generate recommendation ID and timestamp
  const recommendationId = `decay_${Date.now()}_${agentId}${category || 'global'}`;
  const timestamp = new Date().toISOString();

  return {
    id: recommendationId,
    timestamp,
    type: 'shift_weight',
    message: `Reduce weight for ${agentId}${category ? ` (${category})` : ''} due to sustained degradation`,
    confidence: 'high',
    confidenceScore: 0.9,
    rationale,
    old_weights,
    new_weights,
    ttlMs: defaultTtlMs,
    context: {
      degradationType: 'success_rate_decay',
      agentId,
      category,
      evidence,
      windowDeltas,
      weightReduction: proposedReduction,
      proposalTTL: defaultTtlMs,
    },
  };
}

export default {
  detectSustainedDegradation,
  buildDecayProposalFromEvidence,
};
