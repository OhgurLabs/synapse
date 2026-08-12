/**
 * Dangerous Command Detector — pattern-based detection of destructive operations.
 *
 * Detects dangerous command patterns in task descriptions, prompts, and workflow nodes:
 *   - rm -rf / rm -fr (recursive force delete)
 *   - git reset --hard (destructive git operation)
 *   - git push --force / git push -f (force push)
 *   - DROP TABLE / DROP DATABASE (SQL destructive operations)
 *   - git clean -f / git clean -fd (git clean force)
 *   - truncate (SQL truncate)
 *   - systemctl/service stop synapse (Synapse self-stop)
 *
 * Integration points:
 *   - Workflow engine: check node.config content before execution
 *   - Governance: escalate via governanceManager.createProposal
 *   - Checkpoints: include detection metadata in checkpoint entries
 *
 * Returns detection results with:
 *   - isDangerous: boolean
 *   - matches: array of detected patterns with context
 *   - risk: 'high' | 'medium' | 'low'
 *   - recommendation: governance action suggestion
 */

import { createLogger } from './logger.js';
import { DangerousCommandDetector } from './orchestrator/dangerous-command-detector.js';

const log = createLogger('dangerous-commands');

/** @type {DangerousCommandDetector|null} */
let _detectorInstance = null;


/**
 * Detect dangerous command patterns in text.
 * @param {string} text - text to scan (task description, prompt, node config)
 * @param {Object} context - additional context (taskId, nodeId, etc.)
 * @returns {Object} detection result
 */
/**
 * Check if a dangerous command is allowlisted.
 * @param {string} projectId
 * @param {Object} detection - result from detectDangerousCommands
 * @param {Object} [options]
 * @param {string} [options.agentId]
 * @returns {boolean}
 */
export function checkAllowlist(projectId, detection, options = {}) {
  if (!detection || !detection.isDangerous) {
    return false;
  }

  const detector = getDetectorInstance();
  const allowlistResult = detector.isAllowlisted(detection.fullText || '', {
    projectId,
    agentId: options.agentId,
  });

  return allowlistResult.isAllowlisted;
}

/**
 * Get singleton detector instance.
 */
function getDetectorInstance() {
  if (!_detectorInstance) {
    _detectorInstance = new DangerousCommandDetector();
    _detectorInstance.loadAllowlist();
  }
  return _detectorInstance;
}

export function detectDangerousCommands(text, context = {}) {
  if (!text || typeof text !== 'string') {
    return {
      isDangerous: false,
      matches: [],
      risk: null,
      recommendation: null,
      context,
      obfuscationDetected: false,
    };
  }

  // Use the DangerousCommandDetector class for full obfuscation detection support
  const detector = getDetectorInstance();
  const result = detector.detectDangerous(text, context);
  
  // Ensure obfuscationDetected is included (it should be from the class)
  if (result.obfuscationDetected === undefined) {
    result.obfuscationDetected = false;
  }
  
  return result;
}

/**
 * Create a governance proposal for dangerous command approval.
 * @param {Object} governanceManager - governance manager instance
 * @param {string} projectId - project identifier
 * @param {Object} detection - detection result from detectDangerousCommands
 * @param {Object} additionalContext - task/workflow context
 * @returns {Object} proposal result { id, proposal }
 */
export function createDangerousCommandProposal(governanceManager, projectId, detection, additionalContext = {}) {
  const { matches, risk, context } = detection;

  // Build detailed justification
  const justification = buildJustification(detection, additionalContext);

  // Build task context for governors
  const taskContext = buildTaskContext(detection, additionalContext);

  // Create the proposal with type field for governance workflow routing
  const proposalData = {
    proposer: additionalContext.agentId || 'workflow-engine',
    file: 'dangerous_command_execution',
    diff: JSON.stringify(matches, null, 2),
    justification,
    taskContext,
    currentContent: JSON.stringify({
      detectionTime: detection.detectedAt,
      risk,
      matchCount: matches.length,
    }, null, 2),
  };

  const proposal = governanceManager.createProposal(projectId, proposalData);

  // Add type field to the proposal for governance workflow identification
  // This is set after creation since it's metadata, not core proposal data
  proposal.proposal.type = 'dangerous_command';
  proposal.proposal.risk = risk;
  proposal.proposal.checkpointId = additionalContext.checkpointId;
  proposal.proposal.fsCheckpointId = additionalContext.fsCheckpointId;

  log.info('Dangerous command governance proposal created', {
    projectId,
    proposalId: proposal.id,
    risk,
    matchCount: matches.length,
    checkpointId: additionalContext.checkpointId,
    fsCheckpointId: additionalContext.fsCheckpointId,
  });

  return proposal;
}

/**
 * Build justification text for governance proposal.
 */
function buildJustification(detection, additionalContext) {
  const { matches, risk } = detection;

  const lines = [
    `Dangerous command pattern(s) detected — ${matches.length} match(es) — risk level: ${risk.toUpperCase()}`,
    '',
    'Detected patterns:',
  ];

  for (const match of matches) {
    lines.push(`  - ${match.pattern}: \`${match.matched}\``);
    lines.push(`    Category: ${match.category}, Risk: ${match.risk}`);
    lines.push(`    Context: "${match.snippet.slice(0, 100)}..."`);
  }

  if (additionalContext.taskId) {
    lines.push('', `Related task: ${additionalContext.taskId}`);
  }
  if (additionalContext.workflowId) {
    lines.push(`Related workflow: ${additionalContext.workflowId}`);
  }
  if (additionalContext.nodeId) {
    lines.push(`Workflow node: ${additionalContext.nodeId}`);
  }

  lines.push('', 'This operation requires governance approval before execution.');

  return lines.join('\n');
}

/**
 * Build task context for governor review.
 */
function buildTaskContext(detection, additionalContext) {
  const lines = [
    '## Dangerous Command Detection Context',
    '',
    `**Risk Level:** ${detection.risk.toUpperCase()}`,
    `**Detection Time:** ${detection.detectedAt}`,
    `**Match Count:** ${detection.matches.length}`,
  ];

  if (additionalContext.taskId) {
    lines.push(`**Task ID:** ${additionalContext.taskId}`);
  }
  if (additionalContext.workflowId) {
    lines.push(`**Workflow ID:** ${additionalContext.workflowId}`);
  }
  if (additionalContext.nodeId) {
    lines.push(`**Node ID:** ${additionalContext.nodeId}`);
  }
  if (additionalContext.agentId) {
    lines.push(`**Agent ID:** ${additionalContext.agentId}`);
  }

  lines.push('', '## Detected Patterns');

  for (const [idx, match] of detection.matches.entries()) {
    lines.push(`### Match ${idx + 1}/${detection.matches.length}`);
    lines.push(`- **Pattern:** ${match.pattern}`);
    lines.push(`- **Matched:** \`${match.matched}\``);
    lines.push(`- **Category:** ${match.category}`);
    lines.push(`- **Risk:** ${match.risk}`);
    lines.push(`- **Context:** "${match.snippet}"`);
    lines.push('');
  }

  if (additionalContext.fullText) {
    lines.push('## Full Command/Task Text');
    lines.push('```');
    lines.push(additionalContext.fullText.slice(0, 1000)); // Limit to 1000 chars
    if (additionalContext.fullText.length > 1000) {
      lines.push('... [truncated]');
    }
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Create a checkpoint before dangerous command execution.
 *
 * Creates up to two checkpoints:
 *  1. A campaign-state checkpoint via checkpointManager.createSubtaskCheckpoint (when
 *     both checkpointManager and campaignId are supplied).
 *  2. A filesystem checkpoint via createFsCheckpoint (when supplied with baseDir + fsPaths).
 *
 * Both are best-effort: failures are logged but do not throw.
 *
 * @param {Object} params
 * @param {string}   params.projectId            - project identifier
 * @param {string}   [params.campaignId]          - campaign ID; required for campaign checkpoint
 * @param {Object}   [params.checkpointManager]   - instance with createSubtaskCheckpoint(); required for campaign checkpoint
 * @param {Function} [params.createFsCheckpoint]  - (baseDir, projectId, paths) => checkpointId; required for filesystem checkpoint
 * @param {string}   [params.baseDir]             - repo root; required for filesystem checkpoint
 * @param {Array<string>} [params.fsPaths]        - absolute paths to snapshot; required for filesystem checkpoint
 * @param {Object}   params.detection             - result from detectDangerousCommands()
 * @param {Object}   [params.context]             - extra context stored in the campaign checkpoint
 *                                                  (workflowId, runId, nodeId, completedSubtaskIds, milestoneProgressMap)
 * @returns {{ checkpointId: string|null, fsCheckpointId: string|null, createdAt: string }}
 *   checkpointId    — campaign-state checkpoint ID (or null if skipped/failed)
 *   fsCheckpointId  — filesystem checkpoint ID (or null if skipped/failed)
 *   createdAt       — ISO timestamp of the call
 */
export function createDangerousCommandCheckpoint({
  projectId,
  campaignId,
  checkpointManager,
  createFsCheckpoint,
  baseDir,
  fsPaths,
  detection,
  context = {},
}) {
  const createdAt = new Date().toISOString();
  let checkpointId = null;
  let fsCheckpointId = null;

  // 1. Campaign-state checkpoint — records which subtasks were completed at the time of
  //    detection so the campaign can be replayed from this point if needed.
  if (checkpointManager && campaignId) {
    try {
      const completedSubtaskIds = context.completedSubtaskIds || [];
      const milestoneProgressMap = context.milestoneProgressMap || {};
      const resultSummaries = {
        dangerous_command_detection: formatForCheckpoint(detection),
      };

      const ckpt = checkpointManager.createSubtaskCheckpoint(
        projectId,
        campaignId,
        completedSubtaskIds,
        milestoneProgressMap,
        resultSummaries,
      );
      checkpointId = ckpt.checkpointId;

      log.info('Campaign checkpoint created before dangerous command execution', {
        projectId,
        campaignId,
        checkpointId,
        risk: detection.risk,
      });
    } catch (err) {
      log.error('Failed to create campaign checkpoint before dangerous command', {
        projectId,
        campaignId,
        error: err.message,
      });
    }
  }

  // 2. Filesystem checkpoint — copies specified paths so files can be restored if governance
  //    rejects the operation or something goes wrong during execution.
  if (typeof createFsCheckpoint === 'function' && baseDir && Array.isArray(fsPaths) && fsPaths.length > 0) {
    try {
      fsCheckpointId = createFsCheckpoint(baseDir, projectId, fsPaths);

      log.info('Filesystem checkpoint created before dangerous command execution', {
        projectId,
        fsCheckpointId,
        risk: detection.risk,
        pathCount: fsPaths.length,
      });
    } catch (err) {
      log.error('Failed to create filesystem checkpoint before dangerous command', {
        projectId,
        error: err.message,
      });
    }
  }

  return { checkpointId, fsCheckpointId, createdAt };
}

/**
 * Format detection result for checkpoint metadata.
 * Returns a clean object suitable for JSONL storage.
 * @param {Object} detection - detection result from detectDangerousCommands
 * @returns {Object} checkpoint-safe metadata
 */
export function formatForCheckpoint(detection) {
  if (!detection || !detection.isDangerous) {
    return null;
  }

  return {
    dangerousCommandDetected: true,
    risk: detection.risk,
    matchCount: detection.matches.length,
    categories: [...new Set(detection.matches.map(m => m.category))],
    patterns: detection.matches.map(m => ({
      pattern: m.pattern,
      matched: m.matched,
      risk: m.risk,
      category: m.category,
    })),
    detectedAt: detection.detectedAt,
    recommendation: detection.recommendation,
  };
}

/**
 * Wait for a governance proposal decision with timeout.
 *
 * Listens for governance events (proposal_applied, proposal_rejected) for the given
 * proposal ID. Returns when a decision is made or timeout expires.
 *
 * @param {Object} params
 * @param {string}   params.proposalId        - governance proposal ID to wait for
 * @param {Object}   params.governanceManager - governance manager instance (for polling)
 * @param {Object}   params.events            - event emitter to listen for governance events
 * @param {string}   params.projectId         - project identifier
 * @param {number}   [params.timeoutMs]       - timeout in milliseconds (default: 300000 = 5 min)
 * @param {number}   [params.pollIntervalMs]  - polling interval in ms (default: 1000)
 * @returns {Promise<{
 *   outcome: 'approved'|'rejected'|'timeout'|'invariant_violation',
 *   reason?: string,
 *   votes?: Array,
 *   violations?: Array,
 *   timedOut?: boolean
 * }>}
 */
export async function waitForGovernanceDecision({
  proposalId,
  governanceManager,
  events,
  projectId,
  timeoutMs = 300000, // 5 minutes default
  pollIntervalMs = 1000,
}) {
  const startTime = Date.now();

  log.info('Waiting for governance decision', {
    proposalId,
    projectId,
    timeoutMs,
  });

  return new Promise((resolve) => {
    let resolved = false;
    let timeoutHandle = null;
    let pollHandle = null;
    let appliedListener = null;
    let rejectedListener = null;

    // Helper to clean up and resolve once
    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;

      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (pollHandle) clearInterval(pollHandle);
      if (appliedListener && events) events.off('governance:proposal_applied', appliedListener);
      if (rejectedListener && events) events.off('governance:proposal_rejected', rejectedListener);

      const elapsed = Date.now() - startTime;
      log.info('Governance decision received', {
        proposalId,
        outcome: result.outcome,
        elapsedMs: elapsed,
      });

      resolve(result);
    };

    // Set up timeout
    timeoutHandle = setTimeout(() => {
      log.warn('Governance decision timed out', {
        proposalId,
        projectId,
        timeoutMs,
      });
      cleanup({
        outcome: 'timeout',
        reason: `No governance decision received within ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);

    // Listen for approval event
    if (events) {
      appliedListener = ({ projectId: eventProjectId, proposalId: eventProposalId }) => {
        if (eventProjectId === projectId && eventProposalId === proposalId) {
          // Fetch the proposal to get votes
          const proposal = governanceManager.getProposal(projectId, proposalId);
          cleanup({
            outcome: 'approved',
            votes: proposal?.votes || [],
          });
        }
      };
      events.on('governance:proposal_applied', appliedListener);

      // Listen for rejection event
      rejectedListener = ({ projectId: eventProjectId, proposalId: eventProposalId, reason }) => {
        if (eventProjectId === projectId && eventProposalId === proposalId) {
          // Fetch the proposal to get votes
          const proposal = governanceManager.getProposal(projectId, proposalId);
          cleanup({
            outcome: 'rejected',
            reason: reason || 'Proposal rejected by governors',
            votes: proposal?.votes || [],
          });
        }
      };
      events.on('governance:proposal_rejected', rejectedListener);
    }

    // Fallback: poll proposal status in case events don't fire
    // This handles edge cases where event system might fail
    pollHandle = setInterval(() => {
      try {
        const proposal = governanceManager.getProposal(projectId, proposalId);
        if (!proposal) return;

        if (proposal.status === 'applied') {
          cleanup({
            outcome: 'approved',
            votes: proposal.votes || [],
          });
        } else if (proposal.status === 'rejected') {
          cleanup({
            outcome: 'rejected',
            reason: 'Proposal rejected by governors',
            votes: proposal.votes || [],
          });
        } else if (proposal.status === 'invariant_violation') {
          cleanup({
            outcome: 'invariant_violation',
            reason: 'Proposal blocked by constitutional invariant',
            votes: proposal.votes || [],
            violations: proposal.violations || [],
          });
        }
      } catch (err) {
        log.warn('Error polling proposal status', {
          proposalId,
          error: err.message,
        });
      }
    }, pollIntervalMs);
  });
}

/**
 * Full workflow: detect, checkpoint, propose, and wait for governance approval.
 *
 * Convenience wrapper that chains together:
 *  1. Create checkpoint (if checkpointManager provided)
 *  2. Create governance proposal
 *  3. Wait for approval/rejection with timeout
 *
 * @param {Object} params
 * @param {string}   params.projectId           - project identifier
 * @param {Object}   params.detection           - detection result from detectDangerousCommands()
 * @param {Object}   params.governanceManager   - governance manager instance
 * @param {Object}   params.events              - event emitter
 * @param {Object}   [params.checkpointManager] - checkpoint manager instance
 * @param {string}   [params.campaignId]        - campaign ID for checkpoint
 * @param {Function} [params.createFsCheckpoint]- filesystem checkpoint function
 * @param {string}   [params.baseDir]           - base directory for filesystem checkpoint
 * @param {Array<string>} [params.fsPaths]      - paths to snapshot
 * @param {Object}   [params.additionalContext] - context for proposal (taskId, workflowId, etc.)
 * @param {number}   [params.timeoutMs]         - approval timeout in ms (default: 300000)
 * @returns {Promise<{
 *   outcome: 'approved'|'rejected'|'timeout'|'invariant_violation',
 *   proposalId: string,
 *   checkpointId?: string,
 *   fsCheckpointId?: string,
 *   reason?: string,
 *   votes?: Array,
 *   violations?: Array
 * }>}
 */
export async function requestDangerousCommandApproval({
  projectId,
  detection,
  governanceManager,
  events,
  checkpointManager,
  campaignId,
  createFsCheckpoint,
  baseDir,
  fsPaths,
  additionalContext = {},
  timeoutMs = 300000,
}) {
  // Step 1: Create checkpoint (best-effort, failures logged but don't block)
  const checkpointResult = createDangerousCommandCheckpoint({
    projectId,
    campaignId,
    checkpointManager,
    createFsCheckpoint,
    baseDir,
    fsPaths,
    detection,
    context: additionalContext,
  });

  log.info('Dangerous command checkpoint created', {
    projectId,
    checkpointId: checkpointResult.checkpointId,
    fsCheckpointId: checkpointResult.fsCheckpointId,
    risk: detection.risk,
  });

  // Step 2: Create governance proposal
  const proposal = createDangerousCommandProposal(
    governanceManager,
    projectId,
    detection,
    {
      ...additionalContext,
      checkpointId: checkpointResult.checkpointId,
      fsCheckpointId: checkpointResult.fsCheckpointId,
    }
  );

  // Step 3: Wait for approval/rejection with timeout
  const decision = await waitForGovernanceDecision({
    proposalId: proposal.id,
    governanceManager,
    events,
    projectId,
    timeoutMs,
  });

  return {
    ...decision,
    proposalId: proposal.id,
    checkpointId: checkpointResult.checkpointId,
    fsCheckpointId: checkpointResult.fsCheckpointId,
  };
}

export default {
  detectDangerousCommands,
  createDangerousCommandProposal,
  formatForCheckpoint,
  createDangerousCommandCheckpoint,
  waitForGovernanceDecision,
  requestDangerousCommandApproval,
};
