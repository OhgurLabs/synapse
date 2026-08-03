// replayFromCheckpoint implementation for CheckpointManager
// This module exports the replay functionality to be integrated into checkpoint-manager.js
import { addSpanEvent, endSpan, startSpan } from './tracing.js';

/**
 * Replay a campaign from a specific checkpoint.
 * Restores milestone statuses, re-queues post-checkpoint tasks, and sets campaign to active.
 *
 * @param {Object} checkpointManager - checkpoint manager instance
 * @param {Object} campaignManager - campaign manager instance
 * @param {Object} taskManager - task manager instance
 * @param {string} projectId
 * @param {string} campaignId
 * @param {string} checkpointId
 * @returns {Promise<Object>} checkpoint data
 * @throws {Error} if checkpoint not found, campaign not found, or campaign not in replayable state
 */
export async function replayFromCheckpoint(checkpointManager, campaignManager, taskManager, projectId, campaignId, checkpointId) {
  const replaySpan = startSpan('checkpoint.replay', {
    'checkpoint.project_id': projectId,
    'checkpoint.campaign_id': campaignId,
    'checkpoint.id': checkpointId,
  });
  const replayStartTime = Date.now();

  try {
    // (1) Load the checkpoint
    const loadSpan = startSpan(
      'checkpoint.replay.load',
      { 'checkpoint.id': checkpointId },
      replaySpan?.spanContext?.()
    );
    const checkpoint = checkpointManager.loadCheckpoint(projectId, campaignId, checkpointId);
    endSpan(loadSpan, { success: !!checkpoint });
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    // (2) Validate campaign exists and is in replayable state
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

  const replayableStates = ['failed', 'paused', 'active', 'awaiting_approval'];
     if (!replayableStates.includes(campaign.status)) {
       throw new Error(`Campaign ${campaignId} is not in a replayable state (current: ${campaign.status})`);
     }

    // Build set of completed subtask IDs from checkpoint
    // Handle both old format (completedSubtasks array) and new format (completedSubtaskIds array)
    const completedSubtaskIds = new Set();

    if (checkpoint.completedSubtaskIds) {
      // New format: array of "taskId:subtaskId" strings
      checkpoint.completedSubtaskIds.forEach(id => completedSubtaskIds.add(id));
    } else if (checkpoint.completedSubtasks) {
      // Old format: array of { taskId, subtaskId, result } objects
      checkpoint.completedSubtasks.forEach(cs => {
        const fullId = `${cs.taskId}:${cs.subtaskId}`;
        completedSubtaskIds.add(fullId);
      });
    }

    // Build map of subtask results from checkpoint
    const resultSummaries = {};
    if (checkpoint.resultSummaries) {
      // New format: object map
      Object.assign(resultSummaries, checkpoint.resultSummaries);
    } else if (checkpoint.completedSubtasks) {
      // Old format: array of objects
      checkpoint.completedSubtasks.forEach(cs => {
        const fullId = `${cs.taskId}:${cs.subtaskId}`;
        if (cs.result) {
          resultSummaries[fullId] = cs.result;
        }
      });
    }

    // (3) Restore milestone statuses from checkpoint's milestoneProgressMap
    // Use CAS-safe _saveWithRetry
    const milestoneSpan = startSpan(
      'checkpoint.replay.restore_milestones',
      { 'checkpoint.campaign_id': campaignId },
      replaySpan?.spanContext?.()
    );
    campaignManager._saveWithRetry(projectId, (data) => {
      const camp = data.campaigns.find(c => c.id === campaignId);
      if (!camp) throw new Error(`Campaign not found during restore: ${campaignId}`);

      // Handle both milestoneProgressMap and milestoneProgress field names
      const milestoneProgressMap = checkpoint.milestoneProgressMap || checkpoint.milestoneProgress || {};

      for (const milestone of camp.milestones) {
        const checkpointMilestone = milestoneProgressMap[milestone.id];
        if (checkpointMilestone) {
          // Completed milestones stay completed
          if (checkpointMilestone.status === 'completed') {
            milestone.status = 'completed';
            if (checkpointMilestone.completedAt) {
              milestone.completedAt = checkpointMilestone.completedAt;
            }
          }
          // Milestones waiting for approval preserve their approval state
          else if (checkpointMilestone.status === 'waiting_approval') {
            milestone.status = 'waiting_approval';
            if (checkpointMilestone.approvalState) {
              milestone.approvalState = checkpointMilestone.approvalState;
            }
            if (checkpointMilestone.approvalRequestedAt) {
              milestone.approvalRequestedAt = checkpointMilestone.approvalRequestedAt;
            }
            if (checkpointMilestone.approverId !== undefined) {
              milestone.approverId = checkpointMilestone.approverId;
            }
            if (checkpointMilestone.approvalReason !== undefined) {
              milestone.approvalReason = checkpointMilestone.approvalReason;
            }
          }
          // Active/pending milestones stay as-is in the checkpoint
          else if (checkpointMilestone.status === 'active' || checkpointMilestone.status === 'pending') {
            milestone.status = checkpointMilestone.status;
          }
        }
      }

      return data;
    });
    endSpan(milestoneSpan, { success: true });

    // (4) Iterate campaign tasks and update their status based on completedSubtaskIds
    // Get all tasks for the campaign
    const taskRestoreSpan = startSpan(
      'checkpoint.replay.restore_tasks',
      { 'checkpoint.campaign_id': campaignId },
      replaySpan?.spanContext?.()
    );
    const allTasks = taskManager.listTasks(projectId);
    const campaignTasks = allTasks.filter(t => t.campaignId === campaignId);

    // Use CAS-safe _saveWithRetry for each task update
    for (const task of campaignTasks) {
      taskManager._saveWithRetry(projectId, (data) => {
        const t = data.tasks.find(x => x.id === task.id);
        if (!t) return data;

        // Check if all subtasks for this task are in completedSubtaskIds
        const allSubtasksComplete = t.subtasks && t.subtasks.length > 0 &&
          t.subtasks.every(st => {
            const fullId = `${t.id}:${st.id}`;
            return completedSubtaskIds.has(fullId);
          });

        if (allSubtasksComplete) {
          // Mark task as done
          t.status = 'done';
          if (!t.completedAt) {
            t.completedAt = new Date().toISOString();
          }
        } else {
          // Reset task to queued
          t.status = 'queued';
          t.completedAt = null;

          // Reset non-completed subtasks to pending, preserve results for completed ones
          if (t.subtasks) {
            for (const subtask of t.subtasks) {
              const fullId = `${t.id}:${subtask.id}`;

              if (completedSubtaskIds.has(fullId)) {
                // Preserve completed subtask
                subtask.status = 'done';
                // Restore result from checkpoint if available and not already set
                if (!subtask.result && resultSummaries[fullId]) {
                  subtask.result = resultSummaries[fullId];
                }
                // Ensure completedAt is set
                if (!subtask.completedAt) {
                  subtask.completedAt = new Date().toISOString();
                }
              } else {
                // Reset to queued so dispatcher can pick it up again
                subtask.status = 'queued';
                subtask.result = null;
                subtask.claimedBy = null;
                subtask.claimedAt = null;
                subtask.expiresAt = null;
                subtask.completedAt = null;
                subtask.error = null;
              }
            }
          }
        }

        return data;
      });
    }
    endSpan(taskRestoreSpan, { success: true });

   // (5) Set campaign status to 'active'
     const activateSpan = startSpan(
       'checkpoint.replay.activate_campaign',
       { 'checkpoint.campaign_id': campaignId },
       replaySpan?.spanContext?.()
     );
     campaignManager._saveWithRetry(projectId, (data) => {
       const camp = data.campaigns.find(c => c.id === campaignId);
       if (!camp) throw new Error(`Campaign not found during status update: ${campaignId}`);

       // Restore campaign status from checkpoint, supporting both field names for backward compatibility
       camp.status = checkpoint.campaignStatus || checkpoint.campaignStatusAtCheckpoint || 'active';
       camp.completedAt = null;

       return data;
     });
     endSpan(activateSpan, { success: true });

    // (6) Emit a 'checkpoint_replay' event
    campaignManager._appendEvent(projectId, {
      action: 'checkpoint_replay',
      campaignId,
      checkpointId,
      agent: 'system',
      reason: `Campaign replayed from checkpoint ${checkpointId}`,
      completedSubtaskCount: completedSubtaskIds.size,
    });

    addSpanEvent(replaySpan, 'checkpoint_replay.completed', {
      'checkpoint.completed_subtask_count': completedSubtaskIds.size,
      'checkpoint.campaign_task_count': campaignTasks.length,
      'checkpoint.duration_ms': Date.now() - replayStartTime,
    });
    endSpan(replaySpan, { success: true });

    // (7) Return the checkpoint data
    return checkpoint;
  } catch (error) {
    addSpanEvent(replaySpan, 'checkpoint_replay.failed', {
      'checkpoint.duration_ms': Date.now() - replayStartTime,
      error: error.message,
    });
    endSpan(replaySpan, { error });
    throw error;
  }
}
