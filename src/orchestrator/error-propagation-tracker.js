/**
 * Error Propagation Tracker
 * 
 * Traces failure upward through campaign decomposition hierarchy and annotates
 * each ancestor node with impact data.
 * 
 * Core functionality:
 * - walkErrorChain(failedNode): walks hierarchy from leaf to root
 * - computeImpact(node, level): calculates sibling stats and risk levels  
 * - buildErrorChain(failedNode): produces ordered array from leaf to campaign
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Risk level thresholds for impact assessment
 */
const RISK_THRESHOLDS = {
  critical: { maxCompletion: 50, maxMilestonesAtRisk: 0 },
  high:     { maxCompletion: 75, maxMilestonesAtRisk: 1 },
  medium:   { maxCompletion: 90, maxMilestonesAtRisk: null },
  low:      { maxCompletion: 100, maxMilestonesAtRisk: null },
};

/**
 * Node type hierarchy levels (for ordering in error chain)
 */
const NODE_LEVELS = {
  subtask: 1,
  task: 2,
  milestone: 3,
  campaign: 4,
};

/**
 * Calculate risk level based on completion percentage and milestone impact
 * @param {number} completionPercentage - Campaign completion percentage (0-100)
 * @param {number} milestonesAtRisk - Number of milestones affected
 * @returns {string} 'low'|'medium'|'high'|'critical'
 */
function calculateRiskLevel(completionPercentage, milestonesAtRisk = 0) {
  if (completionPercentage <= RISK_THRESHOLDS.critical.maxCompletion && 
      milestonesAtRisk >= RISK_THRESHOLDS.critical.maxMilestonesAtRisk) {
    return 'critical';
  }
  if (completionPercentage <= RISK_THRESHOLDS.high.maxCompletion && 
      milestonesAtRisk >= RISK_THRESHOLDS.high.maxMilestonesAtRisk) {
    return 'high';
  }
  if (completionPercentage <= RISK_THRESHOLDS.medium.maxCompletion) {
    return 'medium';
  }
  return 'low';
}

/**
 * Count siblings with specific status at a given level
 * @param {Array} siblings - Array of sibling nodes
 * @param {string[]} statuses - Statuses to count (e.g., ['failed', 'blocked'])
 * @returns {number} Count of matching siblings
 */
function countSiblingsByStatus(siblings, statuses) {
  if (!siblings || !Array.isArray(siblings)) return 0;
  return siblings.filter(s => s && statuses.includes(s.status)).length;
}

/**
 * Calculate completion percentage for a node
 * @param {Array} children - Array of child nodes
 * @returns {number} Completion percentage (0-100)
 */
function calculateCompletionPercentage(children) {
  if (!children || children.length === 0) return 0;
  const completed = children.filter(c => c.status === 'completed' || c.status === 'done').length;
  return Math.round((completed / children.length) * 100);
}

/**
 * Compute impact assessment for a node given a failure
 * @param {Object} node - The node to compute impact for
 * @param {string} nodeType - Type of node (campaign, milestone, task, subtask)
 * @param {Array} siblings - Array of sibling nodes at same level
 * @param {number} completionPercentage - Current completion percentage
 * @param {number} milestonesAtRisk - Number of milestones at risk
 * @returns {Object} impactAssessment object
 */
function computeImpactAssessment(node, nodeType, siblings, completionPercentage, milestonesAtRisk) {
  const failedSiblings = countSiblingsByStatus(siblings, ['failed', 'cancelled']);
  const blockedSiblings = countSiblingsByStatus(siblings, ['blocked', 'at_risk', 'pending']);
  
  // Determine node status based on impact
  let status = 'at_risk';
  if (node.status === 'failed' || node.status === 'cancelled') {
    status = 'failed';
  } else if (failedSiblings > 0 || blockedSiblings > 0) {
    status = 'blocked';
  }

  const riskLevel = calculateRiskLevel(completionPercentage, milestonesAtRisk);

  return {
    siblingsFailed: failedSiblings,
    siblingsBlocked: blockedSiblings,
    completionPercentage: completionPercentage,
    riskLevel: riskLevel,
    status: status,
  };
}

/**
 * Get parent ID from a node based on its type
 * @param {Object} node - Node object
 * @param {string} nodeType - Type of node
 * @param {Object} data - Loaded data structure
 * @returns {string|null} Parent ID or null if no parent
 */
function getParentId(node, nodeType, data) {
  switch (nodeType) {
    case 'subtask':
      // subtask -> task: find task containing this subtask
      const task = data.tasks?.find(t => 
        t.subtasks?.some(st => st.id === node.id)
      );
      return task ? task.id : null;
      
    case 'task':
      // task -> milestone: find milestone containing this task
      const milestone = data.milestones?.find(m => 
        m.tasks?.some(t => (typeof t === 'string' ? t : t.id) === node.id)
      );
      return milestone ? milestone.id : null;
      
    case 'milestone':
      // milestone -> campaign: return campaign ID from milestone
      return node.campaignId || null;
      
    case 'campaign':
      // Campaign has no parent
      return null;
      
    default:
      return null;
  }
}

/**
 * Get node type from node ID prefix
 * @param {string} nodeId - Node ID (e.g., 'campaign_123', 'st_456')
 * @returns {string} nodeType
 */
function getNodeTypeId(nodeId) {
  if (nodeId.startsWith('campaign_')) return 'campaign';
  if (nodeId.startsWith('milestone_')) return 'milestone';
  if (nodeId.startsWith('task_')) return 'task';
  if (nodeId.startsWith('st_')) return 'subtask';
  return 'unknown';
}

/**
 * Walk up the hierarchy from a failed node to the campaign root
 * @param {Object} failedNode - The node that failed
 * @param {string} failedNodeId - ID of the failed node
 * @param {Object} data - Complete campaign data structure
 * @returns {Array} Array of nodes in hierarchy from leaf to root
 */
function walkErrorChain(failedNode, failedNodeId, data) {
  const chain = [];
  let currentId = failedNodeId;
  let currentType = getNodeTypeId(failedNodeId);
  
  // Add the failed node as starting point
  chain.push({
    nodeId: currentId,
    nodeType: currentType,
    status: failedNode.status || 'failed',
    data: failedNode,
  });

  // Track the current node being processed (starts as failedNode)
  let currentNode = failedNode;

  // Walk up hierarchy until we reach campaign level or no parent
  while (currentType !== 'campaign') {
    const parentId = getParentId(currentNode, currentType, data);
    if (!parentId) break;

    // Find parent node based on type
    let parentNode = null;
    let parentType = null;

    if (currentType === 'subtask') {
      // Parent is task
      parentNode = data.tasks?.find(t => t.id === parentId);
      parentType = 'task';
    } else if (currentType === 'task') {
      // Parent is milestone
      parentNode = data.milestones?.find(m => m.id === parentId);
      parentType = 'milestone';
    } else if (currentType === 'milestone') {
      // Parent is campaign
      parentNode = data.campaigns?.find(c => c.id === parentId);
      parentType = 'campaign';
    }

    if (!parentNode) break;

    chain.push({
      nodeId: parentNode.id,
      nodeType: parentType,
      status: parentNode.status || 'active',
      data: parentNode,
    });

 // Move up - update both ID and current node
currentId = parentId;
currentNode = parentNode;
currentType = parentType;
}

return chain;
}

/**
 * Count milestones at risk given an error chain
 * @param {Array} chain - Error chain from walkErrorChain
 * @param {Object} data - Complete campaign data
 * @returns {number} Number of milestones at risk
 */
function countMilestonesAtRisk(chain, data) {
  const milestoneNode = chain.find(n => n.nodeType === 'milestone');
  if (!milestoneNode) return 0;

  const milestoneId = milestoneNode.nodeId;
  
  // Check if this milestone's siblings are affected
  const campaign = data.campaigns?.find(c => c.id === milestoneNode.data.campaignId);
  if (!campaign || !campaign.milestones) return 0;

  // Count milestones that are failed, blocked, or at_risk
  return campaign.milestones.filter(m => {
    if (m.id === milestoneId) return false;
    return m.status === 'failed' || m.status === 'blocked' || m.status === 'at_risk';
  }).length;
}

/**
 * Build complete error chain with impact assessments
 * @param {Object} failedNode - The node that failed
 * @param {string} failedNodeId - ID of the failed node
 * @param {Object} data - Complete campaign data structure
 * @returns {Object} Complete error chain with impact assessments
 */
function buildErrorChain(failedNode, failedNodeId, data) {
  // Walk up hierarchy to get all ancestor nodes
  const rawChain = walkErrorChain(failedNode, failedNodeId, data);
  
  if (rawChain.length === 0) {
    return null;
  }

  // Calculate campaign-level metrics for risk assessment
  const campaignNode = rawChain.find(n => n.nodeType === 'campaign');
  let milestonesAtRisk = 0;
  let campaignCompletion = 100;

  if (campaignNode && data.campaigns) {
    const campaign = data.campaigns.find(c => c.id === campaignNode.nodeId);
    // campaign.milestones is an array of milestone IDs, need to look up actual milestone objects
    const milestoneIds = campaign?.milestones || [];
    const milestoneObjects = milestoneIds.map(id => data.milestones?.find(m => m.id === id));
    if (milestoneObjects.length > 0) {
      milestonesAtRisk = countMilestonesAtRisk(rawChain, data);
      
      const completedMilestones = milestoneObjects.filter(m => 
        m?.status === 'completed'
      ).length;
      campaignCompletion = Math.round(
        (completedMilestones / milestoneObjects.length) * 100
      );
    }
  }

  // Build chain with impact assessments (rawChain is already leaf-to-root)
  const errorChain = rawChain.map((nodeEntry, index) => {
    const isRoot = index === rawChain.length - 1;
    
    // Get siblings at this level
    let siblings = [];
    if (nodeEntry.nodeType === 'campaign' && data.campaigns) {
      siblings = data.campaigns.filter(c => c.id !== nodeEntry.nodeId);
    } else if (nodeEntry.nodeType === 'milestone' && campaignNode?.data?.milestones) {
      siblings = campaignNode.data.milestones.filter(m => m.id !== nodeEntry.nodeId);
    } else if (nodeEntry.nodeType === 'task' && data.tasks) {
      const task = data.tasks.find(t => t.id === nodeEntry.nodeId);
      siblings = data.tasks.filter(t => 
        t.milestoneId === task?.milestoneId && t.id !== nodeEntry.nodeId
      );
    } else if (nodeEntry.nodeType === 'subtask') {
      const task = data.tasks?.find(t => 
        t.subtasks?.some(st => st.id === nodeEntry.nodeId)
      );
      if (task) {
        siblings = task.subtasks.filter(st => st.id !== nodeEntry.nodeId);
      }
    }

    // Calculate completion percentage at this level
    let completionPercentage = 100;
    if (nodeEntry.nodeType === 'campaign' && campaignNode?.data?.milestones) {
      completionPercentage = campaignCompletion;
    } else if (nodeEntry.nodeType === 'milestone' && campaignNode?.data?.milestones) {
      const milestone = campaignNode.data.milestones.find(m => m.id === nodeEntry.nodeId);
      if (milestone?.tasks) {
        completionPercentage = calculateCompletionPercentage(milestone.tasks);
      }
    } else if (nodeEntry.nodeType === 'task') {
      const task = data.tasks?.find(t => t.id === nodeEntry.nodeId);
      if (task?.subtasks) {
        completionPercentage = calculateCompletionPercentage(task.subtasks);
      }
    } else if (nodeEntry.nodeType === 'subtask') {
      // Subtasks don't have children, so completion is 0% (leaf node)
      completionPercentage = 0;
    }

    // Compute impact assessment
    const impactAssessment = computeImpactAssessment(
      nodeEntry.data,
      nodeEntry.nodeType,
      siblings,
      completionPercentage,
      milestonesAtRisk
    );

    return {
      nodeId: nodeEntry.nodeId,
      nodeType: nodeEntry.nodeType,
      status: impactAssessment.status,
      impactAssessment: {
        siblingsFailed: impactAssessment.siblingsFailed,
        siblingsBlocked: impactAssessment.siblingsBlocked,
        completionPercentage: impactAssessment.completionPercentage,
        riskLevel: impactAssessment.riskLevel,
      },
    };
  });

  // Calculate overall impact summary
  const highestRiskLevel = errorChain.reduce((max, entry) => {
    const levels = { critical: 4, high: 3, medium: 2, low: 1 };
    return levels[entry.impactAssessment.riskLevel] > levels[max] 
      ? entry.impactAssessment.riskLevel 
      : max;
  }, 'low');

  const totalSiblingsAffected = errorChain.reduce((sum, entry) => {
    return sum + entry.impactAssessment.siblingsFailed + entry.impactAssessment.siblingsBlocked;
  }, 0);

  return {
    failedNodeId: failedNodeId,
    failedNodeType: getNodeTypeId(failedNodeId),
    failureTimestamp: failedNode.updatedAt || failedNode.createdAt || new Date().toISOString(),
    errorChain: errorChain,
    impactSummary: {
      totalSiblingsAffected: totalSiblingsAffected,
      campaignCompletionImpact: campaignCompletion,
      highestRiskLevel: highestRiskLevel,
    },
  };
}

/**
 * Main export: Build error chain for a failed node
 * @param {Object} failedNode - The node that failed (subtask/task/milestone)
 * @param {string} failedNodeId - ID of the failed node
 * @param {Object} data - Complete campaign data { campaigns, milestones, tasks }
 * @returns {Object|null} Error chain object or null if invalid input
 */
export function buildErrorChainForFailure(failedNode, failedNodeId, data) {
  if (!failedNode || !failedNodeId || !data) {
    return null;
  }

  // Validate node ID format
  const nodeType = getNodeTypeId(failedNodeId);
  if (nodeType === 'unknown') {
    return null;
  }

  return buildErrorChain(failedNode, failedNodeId, data);
}

/**
 * Walk error chain without computing impact (for debugging)
 * @param {Object} failedNode - The node that failed
 * @param {string} failedNodeId - ID of the failed node
 * @param {Object} data - Complete campaign data structure
 * @returns {Array} Raw hierarchy walk
 */
export function walkHierarchy(failedNode, failedNodeId, data) {
  return walkErrorChain(failedNode, failedNodeId, data);
}

/**
 * Calculate risk level helper (exported for testing)
 * @param {number} completionPercentage
 * @param {number} milestonesAtRisk
 * @returns {string}
 */
export { calculateRiskLevel };

/**
 * Compute impact assessment helper (exported for testing)
 * @param {Object} node
 * @param {string} nodeType
 * @param {Array} siblings
 * @param {number} completionPercentage
 * @param {number} milestonesAtRisk
 * @returns {Object}
 */
export { computeImpactAssessment };
