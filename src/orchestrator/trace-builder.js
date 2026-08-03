/**
 * Trace Builder - Optimized trace reconstruction for campaign hierarchies
 * 
 * Provides high-performance functions to build trace trees and error chains
 * with latency target of <100ms for campaigns with up to 200 tasks.
 */

import { createLogger } from '../logger.js';
import {
  getAllCampaignEvents,
  groupEventsByHierarchy,
  buildStatusMap,
  TraceMetadataCache,
} from './trace-builder-perf.js';

const log = createLogger('trace-builder');

/**
 * Build campaign trace tree - optimized version
 * 
 * @param {string} campaignId - Campaign ID to build trace for
 * @param {Object} timelineStore - TimelineStore instance with query method
 * @param {Object} campaignManager - CampaignManager instance with getCampaign/listCampaigns methods
 * @param {Object} taskManager - TaskManager instance with getTask method
 * @param {string} projectId - Project ID (defaults to 'default')
 * @param {Object} options - Optional configuration
 * @param {number} [options.depth] - Maximum tree depth (default: Infinity)
 * @param {boolean} [options.includeEvents=true] - Include audit events in nodes
 * @param {string} [options.status] - Filter by status ('failed' returns only failed branches)
 * @returns {Promise<Object>} Trace tree with hierarchy and status rollups
 */
export async function buildCampaignTraceTree(
  campaignId,
  timelineStore,
  campaignManager,
  taskManager,
  projectId = 'default',
  options = {}
) {
  const {
    depth = Infinity,
    includeEvents = true,
    status = null,
  } = options;

  const startTime = performance.now();

  // Validate inputs
  if (!campaignId || typeof campaignId !== 'string') {
    throw new TypeError('campaignId is required and must be a string');
  }

  if (!campaignManager || typeof campaignManager.getCampaign !== 'function') {
    throw new Error('campaignManager is required with getCampaign method');
  }

  if (!taskManager || typeof taskManager.getTask !== 'function') {
    throw new Error('taskManager is required with getTask method');
  }

  // Initialize cache for metadata lookups
  const metadataCache = new TraceMetadataCache();

  // Get campaign from manager
  const campaigns = campaignManager.listCampaigns();
  const campaignData = campaigns.find(c => c.id === campaignId);
  
  if (!campaignData) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  const campaign = metadataCache.getCampaign(campaignManager, projectId, campaignId);
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  // Batch fetch all events for the campaign (optimized single query)
  let allEvents = [];
  if (timelineStore && typeof timelineStore.query === 'function') {
    try {
      allEvents = await getAllCampaignEvents(timelineStore, campaignId, 10000);
    } catch (err) {
      log.warn('Failed to fetch campaign events', { campaignId, error: err.message });
    }
  }

  // Group events by hierarchy level (optimized batch processing)
  const groupedEvents = groupEventsByHierarchy(allEvents);

  // Build pre-aggregated status map (single pass over events)
  const statusMap = buildStatusMap(groupedEvents, campaign);

  // Load error chains for this campaign
  let errorChainsForCampaign = [];
  if (timelineStore && typeof timelineStore.getErrorChainsByCampaign === 'function') {
    try {
      errorChainsForCampaign = timelineStore.getErrorChainsByCampaign(campaignId) || [];
    } catch (err) {
      log.warn('Failed to load error chains for campaign', { campaignId, error: err.message });
    }
  }

  // Build the trace tree structure
  const tree = {
    campaignId: campaign.id,
    status: campaign.status,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    title: campaign.title,
    milestones: [],
    summary: {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      activeAgents: new Set(),
    },
  };

  // Process each milestone using batched events
  for (const milestone of campaign.milestones) {
    const milestoneNode = await buildMilestoneNode({
      milestone,
      campaignId,
      projectId,
      taskManager,
      timelineStore,
      depth,
      includeEvents,
      status,
      summary: tree.summary,
      currentDepth: 1,
      errorChains: errorChainsForCampaign,
      groupedEvents,
      statusMap,
      metadataCache,
    });

    if (milestoneNode) {
      tree.milestones.push(milestoneNode);
    }
  }

  // Calculate summary statistics
  tree.summary.totalTasks = tree.summary.completedTasks + tree.summary.failedTasks;
  
  // Convert Set to array for JSON serialization
  tree.summary.activeAgents = Array.from(tree.summary.activeAgents);

  const latencyMs = performance.now() - startTime;
  
  log.debug('Trace tree built', {
    campaignId,
    latencyMs: latencyMs.toFixed(2),
    milestoneCount: tree.milestones.length,
    totalTasks: tree.summary.totalTasks,
    includeEvents,
    statusFilter: status,
  });

  return tree;
}

/**
 * Build error chain trace - returns all error paths from failed nodes to campaign root
 * 
 * @param {string} campaignId - Campaign ID
 * @param {Object} timelineStore - TimelineStore instance
 * @returns {Array} Array of error chain objects with full propagation path
 */
export function buildErrorChain(campaignId, timelineStore) {
  const startTime = performance.now();

  if (!campaignId || typeof campaignId !== 'string') {
    throw new TypeError('campaignId is required and must be a string');
  }

  if (!timelineStore || typeof timelineStore.getErrorChainsByCampaign !== 'function') {
    throw new Error('timelineStore is required with getErrorChainsByCampaign method');
  }

  // Get all error propagation events for this campaign
  const errorPropagationEvents = timelineStore.getErrorChainsByCampaign(campaignId) || [];

  if (errorPropagationEvents.length === 0) {
    return [];
  }

  // Build error chains from events
  const errorChains = [];

  for (const event of errorPropagationEvents) {
    const chain = buildSingleErrorChain(event);
    if (chain) {
      errorChains.push(chain);
    }
  }

  const latencyMs = performance.now() - startTime;

  log.debug('Error chains built', {
    campaignId,
    latencyMs: latencyMs.toFixed(2),
    errorCount: errorChains.length,
  });

  return errorChains;
}

/**
 * Build a single error chain from an error propagation event
 * @param {Object} event - Error propagation event row
 * @returns {Object|null} Error chain object or null if invalid
 */
function buildSingleErrorChain(event) {
  if (!event || !event.error_chain) {
    return null;
  }

  let errorChainData;
  try {
    errorChainData = typeof event.error_chain === 'string' 
      ? JSON.parse(event.error_chain) 
      : event.error_chain;
  } catch (err) {
    log.warn('Failed to parse error_chain', { eventId: event.id, error: err.message });
    return null;
  }

  if (!errorChainData || !errorChainData.errorChain) {
    return null;
  }

  // Build the full propagation path from failed node to campaign root
  const propagationChain = buildPropagationPath(errorChainData.errorChain);

  return {
    errorId: event.id,
    failedNodeId: event.failed_node_id,
    failedNodeType: extractNodeType(event.failed_node_id),
    failureTimestamp: event.event_ts,
    impactSummary: event.impact_summary ? 
      (typeof event.impact_summary === 'string' ? JSON.parse(event.impact_summary) : event.impact_summary) : {},
    propagationChain: propagationChain,
    errorPath: buildErrorPath(propagationChain),
  };
}

/**
 * Build the propagation path from failed node up to campaign root
 * @param {Array} errorChain - Array of nodes in the error chain
 * @returns {Array} Ordered propagation chain from leaf to root
 */
function buildPropagationPath(errorChain) {
  if (!errorChain || !Array.isArray(errorChain)) {
    return [];
  }

  // Sort by depth to ensure proper ordering (deepest first)
  const sortedChain = [...errorChain].sort((a, b) => {
    const depthA = getNodeTypeDepth(a.nodeType);
    const depthB = getNodeTypeDepth(b.nodeType);
    return depthB - depthA; // Descending order: subtask > task > milestone > campaign
  });

  return sortedChain.map(entry => ({
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
    status: entry.status,
    timestamp: entry.timestamp || new Date().toISOString(),
    error: entry.error || null,
  }));
}

/**
 * Build a simplified error path string from propagation chain
 * @param {Array} propagationChain - Array of nodes in propagation chain
 * @returns {Array} Array of node IDs representing the path
 */
function buildErrorPath(propagationChain) {
  return propagationChain.map(node => node.nodeId);
}

/**
 * Extract node type from node ID
 * @param {string} nodeId - Node ID to classify
 * @returns {string} Node type string
 */
function extractNodeType(nodeId) {
  if (!nodeId) return 'unknown';
  
  if (nodeId.startsWith('campaign_')) return 'campaign';
  if (nodeId.startsWith('milestone_')) return 'milestone';
  if (nodeId.startsWith('task_')) return 'task';
  if (nodeId.startsWith('st_')) return 'subtask';
  
  // Infer from context or return unknown
  return 'unknown';
}

/**
 * Get numeric depth for node type (higher = deeper in hierarchy)
 * @param {string} nodeType - Node type string
 * @returns {number} Depth value
 */
function getNodeTypeDepth(nodeType) {
  switch (nodeType) {
    case 'subtask': return 3;
    case 'task': return 2;
    case 'milestone': return 1;
    case 'campaign': return 0;
    default: return -1;
  }
}

/**
 * Build a milestone node with its tasks and events
 * Optimized to use batched events from groupedEvents instead of querying per node
 */
async function buildMilestoneNode({
  milestone,
  campaignId,
  projectId,
  taskManager,
  timelineStore,
  depth,
  includeEvents,
  status,
  summary,
  currentDepth = 1,
  errorChains = [],
  groupedEvents,
  statusMap,
  metadataCache,
}) {
  const milestoneNode = {
    id: milestone.id,
    type: 'milestone',
    title: milestone.title,
    status: milestone.status,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt,
    completedAt: milestone.completedAt,
    order: milestone.order,
  };

  // Get pre-fetched events from grouped data (optimized)
  if (includeEvents) {
    const milestoneEvents = groupedEvents.milestone.get(milestone.id) || [];
    milestoneNode.events = milestoneEvents;
  }

  // Process tasks in this milestone
  const tasks = [];
  
  for (const taskId of milestone.tasks || []) {
    // Use cached task lookup
    const task = metadataCache.getTask(taskManager, projectId, taskId);
    if (!task) continue;

    // Always count tasks for summary regardless of filter
    updateSummaryForTask(task, summary);

    const taskNode = await buildTaskNode({
      task,
      milestoneId: milestone.id,
      campaignId,
      projectId,
      timelineStore,
      depth,
      includeEvents,
      status,
      summary,
      currentDepth,
      errorChains,
      groupedEvents,
      statusMap,
      metadataCache,
    });

    if (taskNode) {
      tasks.push(taskNode);
    }
  }

  milestoneNode.tasks = tasks;

  // Roll up milestone status from tasks
  milestoneNode.status = rollupStatusFromTasks(tasks, milestone.status);
  
  // Annotate with error chain information if available
  const milestoneErrorChains = annotateNodeWithErrors(milestone.id, 'milestone', errorChains);
  if (milestoneErrorChains.length > 0) {
    milestoneNode.errorChains = milestoneErrorChains;
    milestoneNode.isOnErrorPath = true;
  }
  
  // If filtering by failed, only include milestone if it has failed nodes at any level
  if (status === 'failed') {
    const hasFailedNodes = checkForFailedNodesInMilestone(milestone, taskManager, status);
    if (!hasFailedNodes) {
      return null;
    }
  }

  return milestoneNode;
}

/**
 * Build a task node with its subtasks and events
 * Optimized to use batched events from groupedEvents instead of querying per node
 */
async function buildTaskNode({
  task,
  milestoneId,
  campaignId,
  projectId,
  timelineStore,
  depth,
  includeEvents,
  status,
  summary,
  currentDepth = 2,
  errorChains = [],
  groupedEvents,
  statusMap,
  metadataCache,
}) {
  const taskNode = {
    id: task.id,
    type: 'task',
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    type: task.type || 'oneshot',
  };

  // Track active agents
  if (task.agentId) {
    summary.activeAgents.add(task.agentId);
  }

  // Get pre-fetched events from grouped data (optimized)
  if (includeEvents) {
    const taskEvents = groupedEvents.task.get(task.id) || [];
    taskNode.events = taskEvents;
  }

  // Process subtasks if present and depth allows
  if (task.subtasks && task.subtasks.length > 0 && currentDepth < depth) {
    const subtasks = [];
    for (const subtask of task.subtasks) {
      // Check if subtask should be included based on status filter
      if (status === 'failed' && subtask.status !== 'failed') {
        continue;
      }

      // Annotate subtask with error chains if available
      let subtaskNode = null;
      if (errorChains && errorChains.length > 0) {
        subtaskNode = annotateSubtaskWithErrors(subtask, errorChains);
      }
      
      // Fallback to basic subtask node if no error chains or annotation returned null
      if (!subtaskNode) {
        subtaskNode = buildSubtaskNode(subtask, includeEvents);
      }
      
      if (subtaskNode) {
        subtasks.push(subtaskNode);
      }
    }
    taskNode.subtasks = subtasks;
  } else {
    taskNode.subtasks = [];
  }

  // Annotate with error chain information if available
  const taskErrorChains = annotateNodeWithErrors(task.id, 'task', errorChains);
  if (taskErrorChains.length > 0) {
    taskNode.errorChains = taskErrorChains;
    taskNode.isOnErrorPath = true;
  }

  // If filtering by failed, only include task if it or its subtasks are failed
  if (status === 'failed') {
    const hasFailedSubtasks = task.subtasks && task.subtasks.some(st => st.status === 'failed');
    if (!hasFailedSubtasks && task.status !== 'failed') {
      return null;
    }
  }

  return taskNode;
}

/**
 * Build a subtask node
 */
function buildSubtaskNode(subtask, includeEvents) {
  const subtaskNode = {
    id: subtask.id || `subtask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'subtask',
    title: subtask.title || subtask.description || 'Unnamed subtask',
    status: subtask.status,
    createdAt: subtask.createdAt,
    updatedAt: subtask.updatedAt,
  };

  if (includeEvents && subtask.id) {
    // Subtasks may have events linked via task_id in timeline
    // Events are typically captured at the task level for subtasks
  }

  return subtaskNode;
}

/**
 * Query timeline store for events associated with a node using explicit trace context columns.
 */
async function queryTimelineForNode(
  timelineStore,
  projectId,
  nodeType,
  nodeId,
  campaignId,
  milestoneId = null
) {
  const filters = {
    campaignId,
    limit: 500,
  };

  if (nodeType === 'milestone') {
    filters.milestoneId = nodeId;
  } else if (nodeType === 'task') {
    filters.taskId = nodeId;
    if (milestoneId) {
      filters.milestoneId = milestoneId;
    }
  }

  const result = timelineStore.query(filters);
  
  // Filter events by projectId and verify trace context columns are correctly set
  return (result.events || []).filter(event => {
    if (event.project && event.project !== projectId) {
      return false;
    }
    
    if (event.campaign_id && event.campaign_id !== campaignId) {
      return false;
    }
    
    if (nodeType === 'milestone' && event.milestone_id !== nodeId) {
      return false;
    }
    
    if (nodeType === 'task' && event.task_id !== nodeId) {
      return false;
    }
    
    if (nodeType === 'task' && milestoneId && event.milestone_id !== milestoneId) {
      return false;
    }
    
    return true;
  });
}

/**
 * Update summary statistics for a task
 */
function updateSummaryForTask(task, summary) {
  if (task.status === 'done' || task.status === 'completed') {
    summary.completedTasks++;
  } else if (task.status === 'failed') {
    summary.failedTasks++;
  }
}

/**
 * Roll up status from child tasks to parent milestone.
 * 
 * Status rollup logic:
 * - If ANY child is 'failed' → parent is 'failed'
 * - If ALL children are 'done'/'completed' → parent is 'completed'
 * - Otherwise → parent is 'active'
 */
function rollupStatusFromTasks(tasks, originalStatus) {
  if (!tasks || tasks.length === 0) {
    return originalStatus;
  }

  const statuses = tasks.map(t => t.status);
  
  // Priority 1: If any child failed, parent is failed
  if (statuses.includes('failed')) {
    return 'failed';
  }
  
  // Priority 2: If all children completed, parent is completed
  const allDone = statuses.every(s => s === 'done' || s === 'completed');
  if (allDone) {
    return 'completed';
  }
  
  // Priority 3: Otherwise, parent is active
  return 'active';
}

/**
 * Check if a milestone contains any failed nodes
 * Optimized to use in-memory data instead of database queries
 */
function checkForFailedNodesInMilestone(milestone, taskManager, status) {
  if (status !== 'failed') {
    return true;
  }

  for (const taskId of milestone.tasks || []) {
    const task = taskManager.getTask('default', taskId);
    if (!task) continue;

    if (task.status === 'failed') {
      return true;
    }

    if (task.subtasks && task.subtasks.length > 0) {
      for (const subtask of task.subtasks) {
        if (subtask.status === 'failed') {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Annotate a node with error chains from the campaign's error chains
 */
function annotateNodeWithErrors(nodeId, nodeType, allErrorChains) {
  if (!allErrorChains || allErrorChains.length === 0) {
    return [];
  }

  const affectedChains = [];

  for (const errorChainEvent of allErrorChains) {
    let errorChain;
    try {
      errorChain = typeof errorChainEvent.error_chain === 'string'
        ? JSON.parse(errorChainEvent.error_chain)
        : errorChainEvent.error_chain;
    } catch (err) {
      continue;
    }

    if (!errorChain || !errorChain.errorChain) {
      continue;
    }

    const nodeEntry = errorChain.errorChain.find(entry => 
      entry.nodeId === nodeId && entry.nodeType === nodeType
    );

    if (nodeEntry) {
      affectedChains.push({
        failedNodeId: errorChain.failedNodeId,
        failedNodeType: errorChain.failedNodeType,
        failureTimestamp: errorChain.failureTimestamp,
        impactSummary: errorChain.impactSummary,
        chainAtNode: nodeEntry,
      });
    }
  }

  return affectedChains;
}

/**
 * Annotate subtasks with error chain information
 */
function annotateSubtaskWithErrors(subtask, allErrorChains) {
  if (!subtask.id || !allErrorChains || allErrorChains.length === 0) {
    return null;
  }

  const affectedChains = annotateNodeWithErrors(subtask.id, 'subtask', allErrorChains);
  
  if (affectedChains.length > 0) {
    return {
      id: subtask.id,
      type: 'subtask',
      title: subtask.title || subtask.description || 'Unnamed subtask',
      status: subtask.status,
      createdAt: subtask.createdAt,
      updatedAt: subtask.updatedAt,
      errorChains: affectedChains,
      isOnErrorPath: true,
    };
  }

  return null;
}

export default {
  buildCampaignTraceTree,
  buildErrorChain,
  queryTimelineForNode,
  rollupStatusFromTasks,
  checkForFailedNodesInMilestone,
  annotateNodeWithErrors,
  annotateSubtaskWithErrors,
};