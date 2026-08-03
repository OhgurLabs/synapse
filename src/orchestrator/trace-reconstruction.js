/**
  * Trace Reconstruction Engine
  * 
  * Builds execution DAG from campaign/milestone/task hierarchy with audit events attached.
  * Queries timeline store to correlate events with campaign decomposition tree.
  */

import { createLogger } from '../logger.js';
import { CampaignManager } from '../campaigns.js';
import { TaskManager } from '../tasks.js';
import { TimelineStore } from './timeline-store.js';

const log = createLogger('trace-reconstruction');

/**
 * Build a trace tree for a campaign, linking hierarchy with audit events
 * @param {object} options - Options object
 * @param {TimelineStore} options.timelineStore - TimelineStore instance
 * @param {CampaignManager} options.campaignManager - CampaignManager instance  
 * @param {TaskManager} options.taskManager - TaskManager instance
 * @param {string} options.projectId - Project ID
 * @param {string} options.campaignId - Campaign ID to build trace for
 * @param {number} [options.depth] - Maximum tree depth (default: unlimited)
 * @param {boolean} [options.includeEvents=true] - Include audit events in nodes (default: true)
 * @param {string} [options.status] - Filter by status ('failed' returns only failed branches)
 * @returns {Promise<object>} Trace tree with structure:
 *  {
 *    campaignId,
 *    status,
 *    milestones: [{
 *      milestoneId,
 *      status,
 *      tasks: [{
 *        taskId,
 *        status,
 *        subtasks: [...],
 *        events: [...]
 *      }],
 *      events: [...]
 *    }],
 *    summary: {
 *      totalTasks,
 *      completedTasks,
 *      failedTasks,
 *      activeAgents
 *    }
 *  }
 */
export async function buildTraceTree(options) {
  const {
    timelineStore,
    campaignManager,
    taskManager,
    projectId,
    campaignId,
    depth = Infinity,
    includeEvents = true,
    status = null,
  } = options;

  if (!campaignId) {
    throw new Error('campaignId is required');
  }

  // Load campaign
  const campaign = campaignManager.getCampaign(projectId, campaignId);
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  // Load error chains for this campaign if timelineStore is available
  let errorChainsForCampaign = [];
  if (timelineStore && typeof timelineStore.getErrorChainsByCampaign === 'function') {
    try {
      errorChainsForCampaign = timelineStore.getErrorChainsByCampaign(campaignId) || [];
    } catch (err) {
      log.warn('Failed to load error chains for campaign', { campaignId, error: err.message });
    }
  }

  // Build the trace tree
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

  // Process each milestone (depth 1 from root)
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
    });

    if (milestoneNode) {
      tree.milestones.push(milestoneNode);
    }
  }

  // Calculate summary statistics
  tree.summary.totalTasks = tree.summary.completedTasks + tree.summary.failedTasks;
  
  // Convert Set to array for JSON serialization
  tree.summary.activeAgents = Array.from(tree.summary.activeAgents);

  return tree;
}

/**
  * Build a milestone node with its tasks and events
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

  // Query timeline events for this milestone
  if (includeEvents) {
    const milestoneEvents = await queryTimelineForNode(
      timelineStore,
      projectId,
      'milestone',
      milestone.id,
      campaignId
    );
    milestoneNode.events = milestoneEvents;
  }

  // Process tasks in this milestone
  const tasks = [];
  
  for (const taskId of milestone.tasks || []) {
    const task = taskManager.getTask(projectId, taskId);
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
      errorChains: errorChains,
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
    const hasFailedNodes = await checkForFailedNodesInMilestone(milestone, taskManager, status);
    if (!hasFailedNodes) {
      return null;
    }
  }

  return milestoneNode;
}

/**
  * Build a task node with its subtasks and events
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

  // Query timeline events for this task
  if (includeEvents) {
    const taskEvents = await queryTimelineForNode(
      timelineStore,
      projectId,
      'task',
      task.id,
      campaignId,
      milestoneId
    );
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
 * 
 * This function queries events using WHERE campaign_id = ? AND (milestone_id = ? OR task_id = ?)
 * pattern to ensure proper correlation between hierarchy nodes and audit events.
 * 
 * @param {TimelineStore} timelineStore - TimelineStore instance
 * @param {string} projectId - Project ID (for additional filtering)
 * @param {string} nodeType - Node type: 'milestone' or 'task'
 * @param {string} nodeId - ID of the node to query events for
 * @param {string} campaignId - Campaign ID (required for trace context)
 * @param {string} [milestoneId] - Milestone ID (for task-level events)
 * @returns {Promise<Array>} Array of timeline events associated with this node
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
    limit: 500, // Reasonable default, can be adjusted
  };

  if (nodeType === 'milestone') {
    // Query for milestone-level events: WHERE campaign_id = ? AND milestone_id = ?
    filters.milestoneId = nodeId;
  } else if (nodeType === 'task') {
    // Query for task-level events: WHERE campaign_id = ? AND task_id = ?
    filters.taskId = nodeId;
    if (milestoneId) {
      filters.milestoneId = milestoneId;
    }
  }

  const result = timelineStore.query(filters);
  
  // Filter events by projectId and verify trace context columns are correctly set
  return (result.events || []).filter(event => {
    // Events should be associated with the project
    if (event.project && event.project !== projectId) {
      return false;
    }
    
    // Verify trace context columns are properly set for correlation:
    // campaign_id must match the campaign we're querying for
    if (event.campaign_id && event.campaign_id !== campaignId) {
      return false;
    }
    
    // For milestone events, milestone_id must match the node ID
    if (nodeType === 'milestone' && event.milestone_id !== nodeId) {
      return false;
    }
    
    // For task events, task_id must match the node ID
    if (nodeType === 'task' && event.task_id !== nodeId) {
      return false;
    }
    
    // For task-level events, ensure they match the milestone if provided
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
 * Status rollup logic (clear priority order):
 * - If ANY child is 'failed' → parent is 'failed'
 * - If ALL children are 'done'/'completed' → parent is 'completed'
 * - Otherwise (mixed states or active) → parent is 'active'
 * 
 * This ensures deterministic status propagation up the hierarchy.
 */
function rollupStatusFromTasks(tasks, originalStatus) {
  if (!tasks || tasks.length === 0) {
    return originalStatus;
  }

  const statuses = tasks.map(t => t.status);
  
  // Priority 1: If any child failed, parent is failed (failure propagation)
  if (statuses.includes('failed')) {
    return 'failed';
  }
  
  // Priority 2: If all children completed, parent is completed
  const allDone = statuses.every(s => s === 'done' || s === 'completed');
  if (allDone) {
    return 'completed';
  }
  
  // Priority 3: Otherwise (mixed states or active tasks), parent is active
  return 'active';
}

/**
 * Check if a milestone contains any failed nodes (task or subtask level)
 * This is used for status filtering to determine if a milestone should be included
 */
async function checkForFailedNodesInMilestone(milestone, taskManager, status) {
  if (status !== 'failed') {
    return true;
  }

  // Check each task in the milestone
  for (const taskId of milestone.tasks || []) {
    const task = taskManager.getTask('default', taskId);
    if (!task) continue;

    // Task itself is failed
    if (task.status === 'failed') {
      return true;
    }

    // Check subtasks
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
  * Extracts relevant error chains that affect this specific node
  * @param {string} nodeId - The ID of the node to annotate
  * @param {string} nodeType - Type of node ('milestone', 'task', 'subtask')
  * @param {Array} allErrorChains - All error chains for the campaign
  * @returns {Array} Array of error chain entries affecting this node
  */
function annotateNodeWithErrors(nodeId, nodeType, allErrorChains) {
  if (!allErrorChains || allErrorChains.length === 0) {
    return [];
  }

  const affectedChains = [];

  for (const errorChainEvent of allErrorChains) {
    const errorChain = errorChainEvent.error_chain;
    if (!errorChain || !errorChain.errorChain) {
      continue;
    }

    // Check if this node is on the error chain
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
  * @param {Object} subtask - Subtask object
  * @param {Array} allErrorChains - All error chains for the campaign
  * @returns {Object|null} Annotated subtask node or null
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
  buildTraceTree,
  queryTimelineForNode,
  rollupStatusFromTasks,
  checkForFailedNodesInMilestone,
  annotateNodeWithErrors,
  annotateSubtaskWithErrors,
};
