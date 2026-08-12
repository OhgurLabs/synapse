// routing-proposal-pipeline.js — Proposal Creation Pipeline with Causal Correlation
//
// Converts routing analytics recommendations into timeline events with full causal chain.
// Triggers governance review and persists audit trail entries.

import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { TimelineStore } from './timeline-store.js';
import { OperatorAuditStore } from '../operator-audit-store.js';

const log = createLogger('routing-proposal-pipeline');

/**
 * Create a routing proposal from an analytics recommendation.
 *
 * @param {Object} recommendation - Recommendation object from routing-analytics.js generateRecommendations()
 * @param {string} sourceCorrelationId - Correlation ID of the triggering analytics signal
 * @param {Object} opts - Options
 * @param {TimelineStore} opts.timelineStore - Timeline store instance
 * @param {OperatorAuditStore} opts.operatorAuditStore - Operator audit store instance
 * @param {Object} opts.events - Event bus instance (EventEmitter)
 * @param {string} opts.projectId - Project ID for governance
 * @param {boolean} opts.skipGovernance - If true, skip governance event emission (operator-only approval mode)
 * @returns {Promise<string>} Proposal ID
 */
export async function createRoutingProposal(recommendation, sourceCorrelationId, opts = {}) {
  const {
    timelineStore,
    operatorAuditStore,
    events,
    projectId = 'default',
    skipGovernance = false,
  } = opts;

  // Validate required dependencies
  if (!timelineStore) {
    throw new Error('timelineStore is required');
  }
  if (!operatorAuditStore) {
    throw new Error('operatorAuditStore is required');
  }
  if (!events && !skipGovernance) {
    throw new Error('events (event bus) is required unless skipGovernance is true');
  }

  // Generate proposal ID from recommendation ID or create new UUID
  const proposalId = recommendation.id || `proposal-${randomUUID()}`;

  // Map recommendation fields to timeline event data
  const recommendationType = recommendation.type; // 'shift_weight' or 'no_action'
  const confidence = recommendation.confidence; // 'high', 'medium', 'low'
  const proposedWeights = recommendation.new_weights || {};
  const currentWeights = recommendation.old_weights || {};
  const rationale = Array.isArray(recommendation.rationale)
    ? recommendation.rationale.join('; ')
    : (recommendation.rationale || recommendation.message || '');

  // Construct timeline event
  const event = {
    id: `routing-proposal-${randomUUID()}`,
    proposalId,
    recommendationType,
    confidence,
    status: 'pending',
    proposedWeights,
    currentWeights,
    rationale,
    eventTs: recommendation.timestamp || new Date().toISOString(),
    parentCorrelationId: sourceCorrelationId,
    // Populate the agent correlation column. timeline-store's
    // normalizeCorrelation reads event.agentId into agent_id, and nothing set
    // it — so every routing proposal was stored with agent_id NULL, and the
    // duplicate-suppression query in analytics-pipeline (which filtered on the
    // agent) could never match its own rows.
    agentId: recommendation.context?.agentId ?? null,
    data: {
      proposalId,
      recommendationType,
      confidence,
      confidenceScore: recommendation.confidenceScore,
      status: 'pending',
      proposedWeights,
      currentWeights,
      rationale,
      message: recommendation.message,
      context: recommendation.context || {},
      sourceType: recommendation.context?.sourceTypeOverride || 'analytics',
      sourceRecommendationId: recommendation.id,
      // Carry the recommendation's TTL through to the persisted proposal.
      //
      // degradation-detector's buildDecayProposalFromEvidence computes this
      // (defaultTtlMs, 7 days by default, threaded from analytics-pipeline's
      // proposalConfig) and returns it as recommendation.ttlMs — but nothing
      // here read it, so the value was computed and then dropped on the floor.
      // There is no ttl_ms COLUMN on routing_proposal_events, so it belongs in
      // the data blob; timeline-store spreads event.data, so extra keys are
      // preserved rather than whitelisted away.
      //
      // Recording it does NOT enforce it: nothing currently expires a pending
      // routing proposal (router.js's expiresAt is for error-pattern
      // penalties, a different mechanism). This makes the intended lifetime
      // visible and auditable; acting on it is a separate piece of work.
      ttlMs: recommendation.ttlMs ?? null,
    },
  };

  // Append routing proposal event to timeline store
  log.info(`Creating routing proposal ${proposalId} from recommendation ${recommendation.id}`);
  const persistedEvent = timelineStore.appendRoutingProposalEvent(event);

  // Append operator audit trail entry
  const auditEventId = operatorAuditStore.append({
    projectId,
    actionType: 'routing_proposal_created',
    correlationId: sourceCorrelationId,
    status: 'pending',
    target: proposalId,
    payload: {
      proposalId,
      recommendationId: recommendation.id,
      recommendationType,
      confidence,
      confidenceScore: recommendation.confidenceScore,
      message: recommendation.message,
      proposedWeights,
      currentWeights,
      sourceCorrelationId,
      timelineEventId: persistedEvent.id,
    },
  });
  log.info('Operator audit entry appended', {
    auditEventId,
    proposalId,
    correlationId: sourceCorrelationId,
  });

  // Emit governance event unless skipGovernance is true
  if (!skipGovernance) {
    try {
      await events.emit('governance:proposal_created', {
        projectId,
        proposalId,
        proposal: {
          id: proposalId,
          type: 'routing_weight_adjustment',
          recommendationType,
          message: recommendation.message,
          confidence,
          confidenceScore: recommendation.confidenceScore,
          rationale: recommendation.rationale,
          old_weights: currentWeights,
          new_weights: proposedWeights,
          context: recommendation.context || {},
          sourceCorrelationId,
          timelineEventId: persistedEvent.id,
          auditEventId,
        },
      });
      log.info('Governance proposal event emitted', { proposalId, projectId });
    } catch (err) {
      log.error('Failed to emit governance proposal event', {
        proposalId,
        error: err.message,
      });
      // Don't fail the entire operation — governance workflow can be triggered manually
    }
  } else {
    log.info('Governance event emission skipped (operator-only mode)', { proposalId });
  }

  return proposalId;
}
