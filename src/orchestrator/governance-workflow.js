/**
 * Governance Review Workflow — two-key cross-ecosystem verification for governance changes.
 *
 * Triggered by governance:proposal_created events.
 * Dispatches governor agents from different providers independently.
 * All governors must approve for a change to be applied.
 * Constitutional invariants are checked in code after votes, regardless of approval.
 */
import { createLogger } from '../logger.js';
import { resolveGovernors, buildVerificationPrompt, parseVerdict } from '../governance.js';
import { WeightOverrides } from './weight-overrides.js';
import { AttributionTracker } from './attribution-tracker.js';

const log = createLogger('governance-workflow');

export function createGovernanceWorkflow(deps) {
  const {
    governanceManager, agents, events, addMessage, broadcastToChannel,
    withTimeout, config, PROJECT_DIR, stateManager,
    timelineStore, weightOverrides, operatorAudit, attributionTracker,
    approvalAuditTrail,
  } = deps;

  /**
   * Handle routing_proposal governance outcome (approval or rejection).
   * @param {string} projectId - Project identifier
   * @param {string} proposalId - Proposal identifier
   * @param {Object} proposal - Proposal object with type, proposedWeights, etc.
   * @param {Array} votes - Governor vote records
   * @param {string} outcome - 'approved' or 'rejected'
   * @param {string} channelId - Channel for messages
   * @returns {Promise<Object>} Outcome result
   */
  async function handleRoutingProposal(projectId, proposalId, proposal, votes, outcome, channelId) {
    const ttlMs = proposal.ttlMs ?? 86400000; // Default to 24 hours

    if (outcome === 'approved') {
      // Apply routing weight override
      try {
        const appliedOverride = await weightOverrides.apply(proposal.proposedWeights, {
          reason: proposal.rationale || 'Governance-approved routing proposal',
          appliedBy: 'governance-pipeline',
          ttlMs,
          correlationId: proposalId,
        });

        // Record pre-change metrics for attribution tracking
        if (attributionTracker && proposal.proposedWeights) {
          const affectedAgents = Object.keys(proposal.proposedWeights);
          attributionTracker.recordPreChangeMetrics(proposalId, affectedAgents, 'routing', proposal.proposedWeights, {
            appliedAt: appliedOverride.appliedAt,
            appliedBy: 'governance-pipeline',
            reason: proposal.rationale || null,
            correlationId: proposalId,
          });
        }

        // Update proposal state in timeline
        if (timelineStore) {
          timelineStore.updateProposalState(proposalId, 'approved', {
            votes,
            appliedAt: appliedOverride.appliedAt,
            appliedOverride,
          });
        }

        // Append operator audit entry
        if (operatorAudit) {
          const isAutoresearch = proposal.source === 'autoresearch' && proposal.cycleId;
          const auditEntry = {
            actionType: 'routing_proposal_approved',
            correlationId: proposalId,
            target: 'routing_weights',
            votes,
            beforeState: proposal.currentWeights,
            afterState: proposal.proposedWeights,
            payload: {
              proposalId,
              confidence: proposal.confidence,
              rationale: proposal.rationale,
              ttlMs,
              governorVotes: votes.map(v => ({
                governorId: v.governorId,
                provider: v.provider,
                verdict: v.verdict,
                confidence: v.confidence,
                reasoning: v.reasoning,
              })),
            },
          };
          if (isAutoresearch) {
            auditEntry.causalChain = [proposal.cycleId, proposalId, appliedOverride.id];
            auditEntry.payload.source = 'autoresearch';
            auditEntry.payload.cycleId = proposal.cycleId;
          }
          operatorAudit.append(auditEntry);
        }

        // Append approval audit trail entry
        if (approvalAuditTrail) {
          approvalAuditTrail.logApproval({
            operatorId: 'governance-pipeline',
            milestoneId: proposalId,
            campaignId: proposal.source === 'autoresearch' ? proposal.cycleId : null,
            projectId,
            reason: proposal.rationale || `Governance-approved routing proposal: ${proposalId}`,
            approvalRequestedAt: proposal.createdAt || new Date().toISOString(),
            approvalApprovedAt: appliedOverride.appliedAt,
            approvalDuration: appliedOverride.appliedAt ? 
              Math.round((new Date(appliedOverride.appliedAt) - new Date(proposal.createdAt || appliedOverride.appliedAt)) / 1000) : null,
            context: {
              proposalType: 'routing_proposal',
              source: proposal.source,
              confidence: proposal.confidence,
              ttlMs,
              votes: votes.map(v => ({
                governorId: v.governorId,
                provider: v.provider,
                verdict: v.verdict,
                confidence: v.confidence,
              })),
              weightChangeId: appliedOverride.id,
              affectedAgents: Object.keys(proposal.proposedWeights || {}),
            },
          });
        }

       // Emit autoresearch_weight_boost_applied timeline event on autoresearch approval
        if (proposal.source === 'autoresearch' && proposal.cycleId && timelineStore) {
          const affectedAgents = Object.keys(proposal.proposedWeights || {});
          timelineStore.appendOperatorActionEvent({
            actionType: 'autoresearch_weight_boost_applied',
            agentId: affectedAgents[0] || null,
            operatorId: 'governance-pipeline',
            timestamp: appliedOverride.appliedAt,
            data: {
              agents: affectedAgents,
              cycleId: proposal.cycleId,
              proposalId,
              weightChangeId: appliedOverride.id,
              ttlExpiryTimestamp: appliedOverride.expiresAt || null,
              baselineSuccessRate: proposal.baselineSuccessRate || null,
              proposedWeights: proposal.proposedWeights,
              causalChain: [proposal.cycleId, proposalId, appliedOverride.id],
            },
          });
          log.info('Autoresearch weight boost applied', {
            cycleId: proposal.cycleId,
            proposalId,
            weightChangeId: appliedOverride.id,
            agents: affectedAgents,
          });
        }

        addMessage(projectId, channelId, 'System',
          `Routing proposal \`${proposalId}\` **APPROVED** and weights applied. ` +
          `Verified by: ${votes.map(v => `@${v.governorId} (${v.verdict})`).join(', ')}`,
          'system');

        log.info('Routing proposal approved and applied', {
          proposalId,
          weights: proposal.proposedWeights,
          ttlMs,
        });

        return { outcome: 'approved', votes, appliedOverride };
      } catch (err) {
        log.error('Failed to apply routing proposal', { proposalId, error: err.message });

        // Update to rejected state on application failure
        if (timelineStore) {
          timelineStore.updateProposalState(proposalId, 'rejected', {
            votes,
            rejectionReason: `Application failed: ${err.message}`,
          });
        }

        addMessage(projectId, channelId, 'System',
          `Routing proposal \`${proposalId}\` approved by governors but **FAILED** to apply: ${err.message}`,
          'system');

        return { outcome: 'application_failed', error: err.message, votes };
      }
    }

    // Handle rejection
    const rejectReasons = votes.filter(v => v.verdict === 'REJECT')
      .map(v => `${v.governorId}: ${v.reasoning}`).join('; ');

    // Update proposal state in timeline
    if (timelineStore) {
      timelineStore.updateProposalState(proposalId, 'rejected', {
        votes,
        rejectionReason: rejectReasons,
      });
    }

    // Append operator audit entry
    if (operatorAudit) {
      const isAutoresearch = proposal.source === 'autoresearch' && proposal.cycleId;
      const auditEntry = {
        actionType: isAutoresearch ? 'autoresearch_proposal_rejected' : 'routing_proposal_rejected',
        correlationId: isAutoresearch ? proposal.cycleId : proposalId,
        target: 'routing_weights',
        votes,
        payload: {
          proposalId,
          confidence: proposal.confidence,
          rationale: proposal.rationale,
          rejectionReason: rejectReasons,
          governorVotes: votes.map(v => ({
            governorId: v.governorId,
            provider: v.provider,
            verdict: v.verdict,
            confidence: v.confidence,
            reasoning: v.reasoning,
            concerns: v.concerns,
          })),
        },
      };
      if (isAutoresearch) {
        auditEntry.causalChain = [proposal.cycleId, proposalId];
        auditEntry.payload.source = 'autoresearch';
        auditEntry.payload.cycleId = proposal.cycleId;
      }
      operatorAudit.append(auditEntry);
    }

    // Append approval audit trail entry for rejection
    if (approvalAuditTrail) {
      approvalAuditTrail.logRejection({
        operatorId: 'governance-pipeline',
        milestoneId: proposalId,
        campaignId: proposal.source === 'autoresearch' ? proposal.cycleId : null,
        projectId,
        reason: rejectReasons || `Governance-rejected routing proposal: ${proposalId}`,
        approvalRequestedAt: proposal.createdAt || new Date().toISOString(),
        context: {
          proposalType: 'routing_proposal',
          source: proposal.source,
          confidence: proposal.confidence,
          rejectionReasons: rejectReasons,
          votes: votes.map(v => ({
            governorId: v.governorId,
            provider: v.provider,
            verdict: v.verdict,
            confidence: v.confidence,
          })),
        },
      });
    }

    addMessage(projectId, channelId, 'System',
      `Routing proposal \`${proposalId}\` **REJECTED**. ` +
      votes.filter(v => v.verdict === 'REJECT').map(v => `@${v.governorId}: ${v.reasoning}`).join(' | '),
      'system');

    log.info('Routing proposal rejected', { proposalId, rejectReasons });

    return { outcome: 'rejected', reason: rejectReasons, votes };
  }

  /**
   * Handle a governance proposal — resolve governors, dispatch verification, evaluate votes.
   */
  async function reviewProposal(projectId, proposalId, proposal) {
    const channelId = 'general';

    // Step 1: Resolve governor agents
    const resolution = resolveGovernors(agents);
    if (!resolution.available) {
      // No cross-ecosystem governance available — require operator session
      log.warn('Governance unavailable — insufficient governors', { reason: resolution.reason });
      addMessage(projectId, channelId, 'System',
        `Governance proposal \`${proposalId}\` requires manual operator approval: ${resolution.reason}`, 'system');
      governanceManager.rejectProposal(projectId, proposalId,
        `Autonomous governance unavailable: ${resolution.reason}`, []);
      return { outcome: 'manual_required', reason: resolution.reason };
    }

    const governors = resolution.governors;
    log.info('Governance review started', {
      proposalId,
      governors: governors.map(g => `${g.id}(${g.provider})`),
    });

    addMessage(projectId, channelId, 'System',
      `Governance review started for proposal \`${proposalId}\`: ` +
      `${governors.map(g => `@${g.id} (${g.provider})`).join(', ')}`, 'system');

    // Step 2: Dispatch each governor independently with isolated context
    const verificationPrompt = buildVerificationPrompt(proposal);
    const votes = [];
    const timeout = config.tasks?.executionTimeouts?.claude || 300000;

    for (const governor of governors) {
      try {
        const workingDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
        broadcastToChannel(projectId, channelId, {
          type: 'status', speaker: governor.id, status: 'thinking',
        });

        const response = await withTimeout(
          governor.send(verificationPrompt, workingDir, {
            maxTurns: 1,
            bypassPermissions: false,
          }),
          timeout,
          governor.name,
        );

        const verdict = parseVerdict(response || '');
        const vote = governanceManager.recordVote(projectId, proposalId, {
          governorId: governor.id,
          provider: governor.provider,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          reasoning: verdict.reasoning,
          concerns: verdict.concerns,
        });

        votes.push(vote);

        addMessage(projectId, channelId, governor.name,
          `**Governance Vote:** ${verdict.verdict} (${verdict.confidence})\n` +
          `**Reasoning:** ${verdict.reasoning}\n` +
          `**Concerns:** ${verdict.concerns}`,
          'message', { model: governor.model });

      } catch (err) {
        log.error('Governor dispatch failed', { governorId: governor.id, error: err.message });

        // A failed governor = REJECT (fail-safe)
        const vote = governanceManager.recordVote(projectId, proposalId, {
          governorId: governor.id,
          provider: governor.provider,
          verdict: 'REJECT',
          confidence: 'HIGH',
          reasoning: `Governor dispatch failed: ${err.message}. Defaulting to REJECT (fail-safe).`,
          concerns: 'Governor was unreachable — cannot verify proposal safety.',
        });

        votes.push(vote);

        addMessage(projectId, channelId, 'System',
          `Governor @${governor.id} failed to respond — defaulting to REJECT`, 'system');
      }
    }

    // Step 3: Evaluate votes
    const evaluation = governanceManager.evaluateVotes(votes, governors.length);

    // Webhook subscribers: vote:completed fires once per proposal regardless
    // of outcome. Subscribers receive the full evaluation so they can react
    // to approved/rejected/incomplete tallies without re-querying.
    if (events && typeof events.emit === 'function') {
      events.emit('vote:completed', {
        projectId, proposalId,
        proposalType: proposal.type,
        outcome: evaluation.outcome || 'incomplete',
        decided: evaluation.decided,
        votesReceived: votes.length,
        governorsRequired: governors.length,
      }).catch(() => {});
    }

    if (!evaluation.decided) {
      log.error('Governance vote incomplete', { proposalId, votesReceived: votes.length, required: governors.length });
      governanceManager.rejectProposal(projectId, proposalId, 'Incomplete votes', votes);
      return { outcome: 'rejected', reason: 'incomplete_votes' };
    }

    if (evaluation.outcome === 'rejected') {
      const rejectReasons = votes.filter(v => v.verdict === 'REJECT')
        .map(v => `${v.governorId}: ${v.reasoning}`).join('; ');

      // Handle routing_proposal rejection via timeline store
      if (proposal.type === 'routing_proposal') {
        return handleRoutingProposal(projectId, proposalId, proposal, votes, 'rejected', channelId);
      }

      governanceManager.rejectProposal(projectId, proposalId, rejectReasons, votes);

      addMessage(projectId, channelId, 'System',
        `Governance proposal \`${proposalId}\` **REJECTED**. ` +
        votes.filter(v => v.verdict === 'REJECT').map(v => `@${v.governorId}: ${v.reasoning}`).join(' | '),
        'system');

      return { outcome: 'rejected', reason: rejectReasons, votes };
    }

    // Step 4a: Handle routing_proposal approval (non-file-based)
    if (proposal.type === 'routing_proposal') {
      return handleRoutingProposal(projectId, proposalId, proposal, votes, 'approved', channelId);
    }

    // Step 4b: All approved — apply file-based proposal with invariant check
    let proposedContent = proposal.diff;
    // Try to parse as JSON for agents.json / config.json
    try { proposedContent = JSON.parse(proposal.diff); } catch { /* leave as string */ }

    let currentContent = proposal.currentContent;
    try { currentContent = JSON.parse(proposal.currentContent); } catch { /* leave as string */ }

    const result = governanceManager.applyProposal(
      projectId, proposalId, proposal.file, proposedContent, currentContent,
    );

    if (result.applied) {
      const appliedAt = new Date().toISOString();
      const approvalRequestedAt = proposal.createdAt || new Date().toISOString();
      const approvalDuration = Math.round((new Date(appliedAt).getTime() - new Date(approvalRequestedAt).getTime()) / 1000);

      // Log file-based proposal approval to audit trail
      if (approvalAuditTrail) {
        try {
          approvalAuditTrail.logApproval({
            operatorId: 'governance-pipeline',
            milestoneId: proposalId,
            campaignId: null,
            projectId,
            reason: proposal.rationale || `Governance-approved file-based proposal: ${proposalId}`,
            approvalRequestedAt,
            approvalApprovedAt: appliedAt,
            approvalDuration,
            context: {
              proposalType: 'file_proposal',
              targetFile: proposal.file,
              confidence: proposal.confidence,
              votes: votes.map(v => ({
                governorId: v.governorId,
                provider: v.provider,
                verdict: v.verdict,
                confidence: v.confidence,
              })),
            },
          });
        } catch (err) {
          log.error('Failed to log file-based proposal approval to audit trail', { proposalId, error: err.message });
        }
      }

      addMessage(projectId, channelId, 'System',
        `Governance proposal \`${proposalId}\` **APPROVED** and applied. ` +
        `Verified by: ${votes.map(v => `@${v.governorId} (${v.verdict})`).join(', ')}`,
        'system');
      return { outcome: 'applied', votes };
    } else {
      const rejectedAt = new Date().toISOString();
      const approvalRequestedAt = proposal.createdAt || new Date().toISOString();
      const approvalDuration = Math.round((new Date(rejectedAt).getTime() - new Date(approvalRequestedAt).getTime()) / 1000);

      // Log file-based proposal rejection to audit trail
      if (approvalAuditTrail) {
        try {
          approvalAuditTrail.logRejection({
            operatorId: 'governance-pipeline',
            milestoneId: proposalId,
            campaignId: null,
            projectId,
            reason: `Invariant violation: ${(result.violations || [result.reason]).join('; ')}`,
            approvalRequestedAt,
            approvalApprovedAt: rejectedAt,
            approvalDuration,
            context: {
              proposalType: 'file_proposal',
              targetFile: proposal.file,
              confidence: proposal.confidence,
              invariantViolations: result.violations || [result.reason],
              votes: votes.map(v => ({
                governorId: v.governorId,
                provider: v.provider,
                verdict: v.verdict,
                confidence: v.confidence,
              })),
            },
          });
        } catch (err) {
          log.error('Failed to log file-based proposal rejection to audit trail', { proposalId, error: err.message });
        }
      }

      addMessage(projectId, channelId, 'System',
        `Governance proposal \`${proposalId}\` approved by governors but **BLOCKED** by constitutional invariant: ` +
        (result.violations || [result.reason]).join('; '),
        'system');
      return { outcome: 'invariant_violation', violations: result.violations, votes };
    }
  }

  /**
   * Subscribe to governance:proposal_created events.
   */
  function start() {
    events.on('governance:proposal_created', async ({ projectId, proposalId, proposal }) => {
      try {
        await reviewProposal(projectId, proposalId, proposal);
      } catch (err) {
        log.error('Governance review failed', { proposalId, error: err.message });
      }
    });
    log.info('Governance workflow started');
  }

  return { reviewProposal, start };
}
