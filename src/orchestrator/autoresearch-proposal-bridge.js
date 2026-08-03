/**
 * Autoresearch Proposal Bridge — connects autoresearch cycle outcomes to the governance pipeline.
 *
 * Lifecycle:
 * - evaluatePendingCycles(): scans for unevaluated completed cycles, evaluates each,
 *   creates routing proposals for significant improvements, logs non-significant outcomes
 *
 * Each evaluation:
 *   1. Discovers cycles via discoverCycles()
 *   2. Evaluates outcome via evaluateAutoresearchOutcome()
 *   3. Marks cycle as evaluated (persisted in state file)
 *   4. If significant: creates governance proposal with causal correlation
 *   5. If not significant: emits logged timeline event
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { evaluateAutoresearchOutcome, discoverCycles as discoverCyclesUtil } from './autoresearch-outcome-evaluator.js';
import { createRoutingProposal } from './routing-proposal-pipeline.js';

const log = createLogger('autoresearch-bridge');

/**
 * Load evaluated cycles state from file.
 * @returns {Object} Map keyed by agentId:cycleId
 */
function loadEvaluatedState(stateFilePath) {
  if (existsSync(stateFilePath)) {
    try {
      return JSON.parse(readFileSync(stateFilePath, 'utf-8'));
    } catch (err) {
      log.warn('Failed to load evaluated cycles state, starting fresh', { error: err.message });
      return {};
    }
  }
  return {};
}

/**
 * Persist evaluated cycles state to file.
 * @param {Object} state - Map keyed by agentId:cycleId
 * @param {string} stateFilePath - Path to state file
 */
function persistEvaluatedState(state, stateFilePath) {
  const dir = join(stateFilePath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Check if a cycle has already been evaluated.
 * @param {Object} evaluatedState - Map keyed by agentId:cycleId
 * @param {string} agentId - Agent identifier
 * @param {string} cycleId - Cycle identifier (e.g., 'cycle_1')
 * @returns {boolean}
 */
function isEvaluated(evaluatedState, agentId, cycleId) {
  const key = `${agentId}:${cycleId}`;
  return evaluatedState.hasOwnProperty(key);
}

/**
 * Mark a cycle as evaluated.
 * @param {Object} evaluatedState - Map keyed by agentId:cycleId
 * @param {string} agentId - Agent identifier
 * @param {string} cycleId - Cycle identifier
 */
function markAsEvaluated(evaluatedState, agentId, cycleId) {
  const key = `${agentId}:${cycleId}`;
  evaluatedState[key] = {
    evaluatedAt: new Date().toISOString(),
    agentId,
    cycleId,
  };
}

/**
 * Build routing recommendation from evaluation result.
 * @param {Object} evaluation - Result from evaluateAutoresearchOutcome()
 * @param {number} currentWeight - Current routing weight for the agent
 * @param {number} ttlMs - Proposal TTL in milliseconds
 * @returns {Object} Recommendation object for createRoutingProposal()
 */
function buildRecommendation(evaluation, currentWeight, ttlMs) {
  const { metrics, agentId, cycleId, needsOperatorReview } = evaluation;
  const { relativeImprovement, baseline, post } = metrics;

  // Recommended weight: current × (1 + min(relativeImprovement, 0.3)) — capped at 30% boost
  const relativeImprovementCapped = Math.min(relativeImprovement / 100, 0.3);
  const newWeight = parseFloat((currentWeight * (1 + relativeImprovementCapped)).toFixed(4));

  return {
    id: `autoresearch-${agentId}-${cycleId}`,
    type: 'shift_weight',
    timestamp: new Date().toISOString(),
    confidence: needsOperatorReview ? 'medium' : 'high',
    confidenceScore: needsOperatorReview ? 0.65 : 0.85,
    old_weights: { [agentId]: currentWeight },
    new_weights: { [agentId]: newWeight },
    rationale: [
      `Autoresearch cycle ${cycleId} completed for ${agentId}`,
      `Relative improvement: ${relativeImprovement.toFixed(2)}%`,
      `Baseline quality_score: ${baseline.quality_score?.toFixed(4) ?? 'N/A'}`,
      `Post-cycle quality_score: ${post.quality_score?.toFixed(4) ?? 'N/A'}`,
      needsOperatorReview ? 'Requires operator review (fallback threshold met)' : 'Primary threshold met',
    ],
    message: `Routing weight proposal from autoresearch cycle ${cycleId}: ${relativeImprovement.toFixed(2)}% improvement`,
    context: {
      source: 'autoresearch',
      sourceTypeOverride: 'autoresearch',
      cycleId,
      agentId,
      evidence: {
        baselineMetrics: {
          quality_score: baseline.quality_score,
          success_rate: baseline.success_rate,
          avg_latency: baseline.avg_latency,
          sampleSize: baseline.sampleSize,
        },
        postMetrics: {
          quality_score: post.quality_score,
          success_rate: post.success_rate,
          avg_latency: post.avg_latency,
          sampleSize: post.sampleSize,
        },
        relativeImprovement: relativeImprovement.toFixed(2),
        absoluteDelta: metrics.absoluteDelta,
        sampleSize: evaluation.sampleSize,
        needsOperatorReview,
      },
      proposalTtlMs: ttlMs,
      needsOperatorReview,
    },
    ttlMs,
  };
}

/**
 * Emit timeline event for proposal creation.
 * @param {Object} timelineStore - Timeline store instance
 * @param {Object} recommendation - Routing recommendation
 * @param {string} cycleId - Cycle ID for causal correlation
 */
function emitProposalCreatedEvent(timelineStore, recommendation, cycleId) {
  const event = {
    id: `autoresearch-proposal-${randomUUID()}`,
    proposalId: recommendation.id,
    eventTs: new Date().toISOString(),
    data: {
      proposalId: recommendation.id,
      sourceType: 'autoresearch',
      sourceRecommendationId: recommendation.id,
      proposedWeights: recommendation.new_weights,
      currentWeights: recommendation.old_weights,
      state: 'pending',
      confidence: recommendation.confidence,
      rationale: recommendation.rationale.join('; '),
      correlationId: cycleId,
    },
  };

  timelineStore.appendRoutingProposalEvent(event);

  log.info('Emitted autoresearch_proposal_created timeline event', {
    proposalId: recommendation.id,
    cycleId,
    agentId: Object.keys(recommendation.new_weights)[0],
  });
}

/**
 * Emit timeline event for non-significant outcome logging.
 * @param {Object} timelineStore - Timeline store instance
 * @param {Object} evaluation - Evaluation result
 */
function emitOutcomeLoggedEvent(timelineStore, evaluation) {
  const event = {
    id: `autoresearch-outcome-${randomUUID()}`,
    eventTs: new Date().toISOString(),
    data: {
      cycleId: evaluation.cycleId,
      agentId: evaluation.agentId,
      significant: evaluation.significant,
      reason: evaluation.reason,
      metrics: evaluation.metrics,
      sampleSize: evaluation.sampleSize,
      needsOperatorReview: evaluation.needsOperatorReview,
    },
  };

  // Use appendOperatorActionEvent for generic logging since there's no specific method
  timelineStore.appendOperatorActionEvent({
    ...event,
    actionType: 'autoresearch_outcome_logged',
    operatorId: 'system:autoresearch-bridge',
    target: evaluation.cycleId,
    payload: {
      cycleId: evaluation.cycleId,
      agentId: evaluation.agentId,
      significant: evaluation.significant,
      reason: evaluation.reason,
      metrics: evaluation.metrics,
      sampleSize: evaluation.sampleSize,
    },
  });

  log.info('Emitted autoresearch_outcome_logged timeline event', {
    cycleId: evaluation.cycleId,
    agentId: evaluation.agentId,
    significant: evaluation.significant,
    reason: evaluation.reason,
  });
}

/**
 * Evaluate pending autoresearch cycles and create proposals for significant improvements.
 *
 * @param {Object} deps - Dependencies
 * @param {Object} deps.timelineStore - Timeline store for event persistence
 * @param {Object} deps.operatorAuditStore - Operator audit store for audit trail
 * @param {Object} deps.events - Event bus (EventEmitter) for governance events
 * @param {Object} deps.config - Application config (uses config.autoresearchBridge)
 * @param {string} deps.autoresearchBaseDir - Base directory for autoresearch cycles (e.g., 'autoresearch')
 * @param {string} deps.stateFilePath - Path to evaluated cycles state file
 * @returns {Promise<{ evaluated: number, proposalsCreated: number, outcomesLogged: number, errors: number }>}
 */
export async function evaluatePendingCycles({
  timelineStore,
  operatorAuditStore,
  events,
  config,
  autoresearchBaseDir,
  stateFilePath,
}) {
  const bridgeCfg = config.autoresearchBridge || {};
  const enabled = bridgeCfg.enabled !== false;

  if (!enabled) {
    log.info('Autoresearch bridge is disabled, skipping evaluation');
    return { evaluated: 0, proposalsCreated: 0, outcomesLogged: 0, errors: 0 };
  }

  const ttlMs = bridgeCfg.proposalTtlMs || (14 * 24 * 60 * 60 * 1000); // 14 days default
  const evaluatedState = loadEvaluatedState(stateFilePath);

  log.info('Discovering unevaluated autoresearch cycles', { baseDir: autoresearchBaseDir });
  const cycles = discoverCyclesUtil(autoresearchBaseDir);

  if (cycles.length === 0) {
    log.info('No unevaluated cycles found');
    return { evaluated: 0, proposalsCreated: 0, outcomesLogged: 0, errors: 0 };
  }

  log.info(`Found ${cycles.length} unevaluated cycle(s)`, { count: cycles.length });

  let evaluated = 0;
  let proposalsCreated = 0;
  let outcomesLogged = 0;
  let errors = 0;

  for (const cycle of cycles) {
    const { cycleDir, cycleNumber, agentId } = cycle;
    const cycleId = `cycle_${cycleNumber}`;

    // Skip if already evaluated
    if (isEvaluated(evaluatedState, agentId, cycleId)) {
      log.debug('Skipping already-evaluated cycle', { agentId, cycleId });
      continue;
    }

    evaluated++;

    try {
      // Evaluate the cycle outcome
      const evaluation = evaluateAutoresearchOutcome(cycleDir, cycleNumber);

      // Mark as evaluated regardless of outcome (both state file and marker file)
      markAsEvaluated(evaluatedState, agentId, cycleId);
      
      // Create marker file for discoverCycles idempotency
      const evaluatedMarker = join(cycleDir, `cycle_${cycleNumber}_evaluated`);
      if (!existsSync(evaluatedMarker)) {
        writeFileSync(evaluatedMarker, JSON.stringify({ evaluatedAt: new Date().toISOString() }), 'utf-8');
      }

      if (evaluation.significant) {
        // Get current weight from config or default to 1.0
        const currentWeight = config.routing?.weights?.[agentId] || 1.0;

        // Build recommendation
        const recommendation = buildRecommendation(evaluation, currentWeight, ttlMs);

        // Create routing proposal via governance pipeline
        const sourceCorrelationId = cycleId;
        await createRoutingProposal(recommendation, sourceCorrelationId, {
          timelineStore,
          operatorAuditStore,
          events,
          projectId: 'default',
          skipGovernance: false,
        });

        proposalsCreated++;

        // Emit timeline event for proposal creation
        emitProposalCreatedEvent(timelineStore, recommendation, cycleId);

        log.info('Created routing proposal for significant autoresearch improvement', {
          agentId,
          cycleId,
          proposalId: recommendation.id,
          relativeImprovement: evaluation.metrics.relativeImprovement.toFixed(2),
          newWeight: recommendation.new_weights[agentId],
          ttlMs,
        });

        // Emit governance event if events bus is available
        if (events) {
          events.emit('governance:proposal_created', {
            proposalId: recommendation.id,
            source: 'autoresearch',
            cycleId,
            agentId,
          });
        }
      } else {
        // Emit timeline event for non-significant outcome
        emitOutcomeLoggedEvent(timelineStore, evaluation);

        outcomesLogged++;

        log.info('Logged non-significant autoresearch outcome', {
          agentId,
          cycleId,
          reason: evaluation.reason,
          sampleSize: evaluation.sampleSize,
        });
      }
    } catch (err) {
      errors++;
      log.error('Failed to evaluate cycle', {
        agentId,
        cycleId,
        error: err.message,
        stack: err.stack,
      });
    }
  }

  // Persist updated state
  persistEvaluatedState(evaluatedState, stateFilePath);

  log.info('Autoresearch cycle evaluation complete', {
    evaluated,
    proposalsCreated,
    outcomesLogged,
    errors,
  });

  return { evaluated, proposalsCreated, outcomesLogged, errors };
}

export default {
  evaluatePendingCycles,
  loadEvaluatedState,
  persistEvaluatedState,
  isEvaluated,
  markAsEvaluated,
  buildRecommendation,
  emitProposalCreatedEvent,
  emitOutcomeLoggedEvent,
};
