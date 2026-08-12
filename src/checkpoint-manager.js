// CheckpointManager — persist campaign subtask completion checkpoints with JSONL storage.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { replayFromCheckpoint as replayImpl } from './checkpoint-manager-replay.js';
import { assertSafeProjectId, assertSafeId } from './safe-id.js';

function generateCheckpointId() {
  return `ckpt_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function checkpointsDir(projectsDir, projectId) {
  assertSafeProjectId(projectId);
  return join(projectsDir, projectId, 'checkpoints');
}

function checkpointFile(projectsDir, projectId) {
  return join(checkpointsDir(projectsDir, projectId), 'checkpoints.jsonl');
}

function checkpointPath(projectsDir, projectId, campaignId) {
  // campaignId becomes a filename under the project checkpoints dir
  assertSafeId(campaignId, 'campaign ID');
  return join(checkpointsDir(projectsDir, projectId), `${campaignId}.jsonl`);
}

function collectMilestoneProgress(campaign) {
   const progress = {};
   for (const ms of campaign.milestones || []) {
     const entry = {
       status: ms.status,
       completedAt: ms.completedAt || null,
       requireApproval: ms.requireApproval || false,
     };
     // Include approval state for milestones waiting for approval
     if (ms.status === 'waiting_approval' || ms.status === 'awaiting_approval') {
       entry.approvalState = ms.approvalState || null;
       entry.approvalRequestedAt = ms.approvalRequestedAt || null;
       entry.approverId = ms.approverId || null;
       entry.approvalReason = ms.approvalReason || null;
     }
     progress[ms.id] = entry;
   }
   return progress;
 }

function collectCompletedSubtasks(taskManager, projectId, campaignId) {
  const completed = [];
  const allTasks = taskManager.listTasks?.(projectId) || [];
  const tasks = allTasks.filter(t => t.campaignId === campaignId);

  for (const task of tasks) {
    for (const subtask of task.subtasks || []) {
      if (subtask.status === 'done' && subtask.result) {
        completed.push({
          subtaskId: subtask.id,
          taskId: task.id,
          result: subtask.result,
        });
      }
    }
  }
  
  return completed;
}

export function createCheckpointManager(deps) {
  const { stateManager, campaignManager, taskManager, broadcastToChannel, broadcast } = deps;
  if (!stateManager || !stateManager.projectsDir) {
    throw new Error('CheckpointManager requires stateManager with projectsDir');
  }
  const projectsDir = stateManager.projectsDir;

  function init(projectId) {
    const checkpointsDirPath = checkpointsDir(projectsDir, projectId);
    if (!existsSync(checkpointsDirPath)) {
      mkdirSync(checkpointsDirPath, { recursive: true });
    }
  }

  function createCheckpoint({ projectId, campaignId, taskId, subtaskId }) {
    const checkpointsDirPath = checkpointsDir(projectsDir, projectId);
    
    if (!existsSync(checkpointsDirPath)) {
      mkdirSync(checkpointsDirPath, { recursive: true });
    }

    const campaign = campaignManager?.getCampaign(projectId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const checkpointId = generateCheckpointId();
    const createdAt = new Date().toISOString();
    const campaignVersion = campaign.version || 1;
    const campaignStatusAtCheckpoint = campaign.status; // Capture the campaign's current status
    const milestoneProgress = collectMilestoneProgress(campaign);
    const completedSubtasks = collectCompletedSubtasks(taskManager, projectId, campaignId);

    const checkpointEntry = {
      checkpointId,
      projectId,
      campaignId,
      campaignVersion,
      campaignStatus: campaignStatusAtCheckpoint,
      milestoneProgress,
      completedSubtasks,
      lastSubtaskId: subtaskId,
      lastTaskId: taskId,
      createdAt,
    };

    const line = JSON.stringify(checkpointEntry) + '\n';
    const checkpointsPath = checkpointPath(projectsDir, projectId, campaignId);
    const tmpPath = checkpointsPath + '.tmp.' + process.pid + '.' + Date.now();
    
    try {
      if (existsSync(checkpointsPath)) {
        const existingContent = readFileSync(checkpointsPath, 'utf-8');
        writeFileSync(tmpPath, existingContent + line);
      } else {
        writeFileSync(tmpPath, line);
      }
      renameSync(tmpPath, checkpointsPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }

    pruneCheckpoints(projectId, campaignId, 50);

    // Broadcast checkpoint creation project-wide. The Checkpoints panel is a
    // sidebar (not channel-scoped), so a channel-targeted send to 'operator'
    // never reached a user viewing #general — the panel stayed empty (U9).
    if (broadcast) {
      broadcast({
        type: 'checkpoint',
        projectId,
        checkpointId,
        campaignId,
        status: 'created',
        summary: `Checkpoint after subtask ${subtaskId}`,
        timestamp: createdAt,
      });
    }

    return {
      checkpointId,
      projectId,
      campaignId,
      createdAt,
    };
  }

  function loadCheckpoints(projectId, campaignId) {
    const checkpointsPath = checkpointPath(projectsDir, projectId, campaignId);

    if (!existsSync(checkpointsPath)) {
      return [];
    }

    try {
      const content = readFileSync(checkpointsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      const checkpoints = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          checkpoints.push(entry);
        } catch {
        }
      }

      checkpoints.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      return checkpoints;
    } catch {
      return [];
    }
  }

  function pruneCheckpoints(projectId, campaignId, maxCount = 50) {
    const checkpointsPath = checkpointPath(projectsDir, projectId, campaignId);
    
    if (!existsSync(checkpointsPath)) {
      return 0;
    }

    let checkpoints = [];
    try {
      const content = readFileSync(checkpointsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          checkpoints.push(entry);
        } catch {
        }
      }
    } catch {
      return 0;
    }

    if (checkpoints.length <= maxCount) {
      return 0;
    }

    checkpoints.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    const kept = checkpoints.slice(0, maxCount);
    const removedCount = checkpoints.length - maxCount;
    
    const newContent = kept.map(c => JSON.stringify(c) + '\n').join('');
    
    try {
      const tmpPath = checkpointsPath + '.tmp.' + process.pid;
      writeFileSync(tmpPath, newContent);
      renameSync(tmpPath, checkpointsPath);
    } catch (err) {
      try { unlinkSync(checkpointsPath + '.tmp.' + process.pid); } catch { /* ignore */ }
      return 0;
    }

    if (campaignManager?._appendEvent) {
      campaignManager._appendEvent(projectId, {
        type: 'checkpoint_pruned',
        projectId,
        campaignId,
        removedCount,
        keptCount: kept.length,
        maxCount,
        timestamp: new Date().toISOString(),
      });
    }

    return removedCount;
  }

  function getCheckpoint(projectId, campaignId, checkpointId) {
    // Validate checkpointId format to prevent path traversal
    if (!/^ckpt_\d+_[a-f0-9]{8}$/.test(checkpointId)) {
      return null;
    }

    const checkpoints = loadCheckpoints(projectId, campaignId);
    return checkpoints.find(cp => cp.checkpointId === checkpointId) || null;
  }

  /**
   * Create a subtask checkpoint with explicit state parameters.
   * @param {string} projectId
   * @param {string} campaignId
   * @param {Array<string>} completedSubtaskIds - array of "taskId:subtaskId" strings
   * @param {Object} milestoneProgressMap - { milestoneId: { status, completedAt } }
   * @param {Object} resultSummaries - { "taskId:subtaskId": result }
   * @returns {Object} checkpoint metadata { checkpointId, campaignId, version, createdAt }
   */
  function createSubtaskCheckpoint(projectId, campaignId, completedSubtaskIds, milestoneProgressMap, resultSummaries) {
    const checkpointsDirPath = checkpointsDir(projectsDir, projectId);

    // Ensure checkpoints directory exists
    if (!existsSync(checkpointsDirPath)) {
      mkdirSync(checkpointsDirPath, { recursive: true });
    }

    const campaign = campaignManager?.getCampaign(projectId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const checkpointId = generateCheckpointId();
    const createdAt = new Date().toISOString();
    const version = campaign.version || 1;
    const campaignStatusAtCheckpoint = campaign.status; // Capture the campaign's current status

    const checkpointEntry = {
      checkpointId,
      campaignId,
      version,
      milestoneProgressMap,
      completedSubtaskIds,
      resultSummaries,
      createdAt,
    };

    // Append as JSONL entry atomically
    const line = JSON.stringify(checkpointEntry) + '\n';
    const checkpointsPath = checkpointPath(projectsDir, projectId, campaignId);
    const tmpPath = checkpointsPath + '.tmp.' + process.pid + '.' + Date.now();
    
    try {
      if (existsSync(checkpointsPath)) {
        const existingContent = readFileSync(checkpointsPath, 'utf-8');
        writeFileSync(tmpPath, existingContent + line);
      } else {
        writeFileSync(tmpPath, line);
      }
      renameSync(tmpPath, checkpointsPath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }

    // Auto-prune to keep at most 50 checkpoints per campaign
    pruneCheckpoints(projectId, campaignId, 50);

    // Broadcast project-wide (see note above — channel-scoped send was U9).
    if (broadcast) {
      broadcast({
        type: 'checkpoint',
        projectId,
        checkpointId,
        campaignId,
        status: 'created',
        summary: `Checkpoint after ${completedSubtaskIds.length} subtask(s)`,
        timestamp: createdAt,
      });
    }

    return {
      checkpointId,
      campaignId,
      version,
      createdAt,
    };
  }

  /**
   * List all checkpoints for a specific campaign.
   * @param {string} projectId
   * @param {string} campaignId
   * @returns {Array} array of checkpoint entries for the campaign, sorted newest first
   */
  function listCheckpoints(projectId, campaignId) {
    const checkpoints = loadCheckpoints(projectId, campaignId);

    // Sort by createdAt descending (newest first)
    checkpoints.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return checkpoints;
  }

  /**
   * Load a specific checkpoint by ID for a campaign.
   * @param {string} projectId
   * @param {string} campaignId
   * @param {string} checkpointId
   * @returns {Object|null} checkpoint entry or null if not found
   */
  function loadCheckpoint(projectId, campaignId, checkpointId) {
    // Validate checkpointId format to prevent path traversal
    if (!/^ckpt_\d+_[a-f0-9]{8}$/.test(checkpointId)) {
      return null;
    }

    const checkpoints = listCheckpoints(projectId, campaignId);
    return checkpoints.find(c => c.checkpointId === checkpointId) || null;
  }

  /**
   * Replay a campaign from a specific checkpoint.
   * Restores milestone statuses, re-queues post-checkpoint tasks, and sets campaign to active.
   *
   * @param {string} projectId
   * @param {string} campaignId
   * @param {string} checkpointId
   * @param {Object} campaignManager - campaign manager instance
   * @param {Object} taskManager - task manager instance
   * @returns {Promise<Object>} checkpoint data
   * @throws {Error} if checkpoint not found, campaign not found, or campaign not in replayable state
   */
  async function replayFromCheckpoint(projectId, campaignId, checkpointId, campaignMgr, taskMgr) {
    // Delegate to the replay implementation
    const checkpointMgr = {
      loadCheckpoint,
      listCheckpoints,
      createSubtaskCheckpoint,
    };
    return replayImpl(checkpointMgr, campaignMgr, taskMgr, projectId, campaignId, checkpointId);
  }

  /**
   * Read all checkpoints for a project across all campaigns.
   * @param {string} projectId
   * @returns {Array} array of checkpoint entries sorted by createdAt ascending
   */
  function readCheckpoints(projectId) {
    const checkpointsDirPath = checkpointsDir(projectsDir, projectId);
    if (!existsSync(checkpointsDirPath)) {
      return [];
    }

    let files;
    try {
      files = readdirSync(checkpointsDirPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      return [];
    }

    const all = [];
    for (const file of files) {
      const filePath = join(checkpointsDirPath, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            all.push(JSON.parse(line));
          } catch { /* skip corrupt */ }
        }
      } catch { /* skip unreadable */ }
    }

    all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return all;
  }

  return {
    // Legacy methods (keep for backward compatibility)
    createCheckpoint,
    init,
    pruneCheckpoints,
    loadCheckpoints,
    getCheckpoint,
    readCheckpoints,

    // Required API surface from task plan
    createSubtaskCheckpoint,
    listCheckpoints,
    loadCheckpoint,
    replayFromCheckpoint,

    // Metrics support
    getCheckpointMetrics,
  };
}

function getCheckpointMetrics() {
  const allCheckpoints = [];
  try {
    const projects = stateManager?.listProjects() || [];
    for (const project of projects) {
      const projectId = project.id || project;
      const checkpoints = readCheckpoints(projectId);
      allCheckpoints.push(...checkpoints);
    }
  } catch {
    return { lagSeconds: 0, ageSeconds: 0 };
  }

  if (allCheckpoints.length === 0) {
    return { lagSeconds: 0, ageSeconds: 0 };
  }

  const now = Date.now();
  const latestCheckpoint = allCheckpoints.reduce((latest, cp) => {
    const cpTime = new Date(cp.createdAt).getTime();
    return cpTime > new Date(latest.createdAt).getTime() ? cp : latest;
  });

  const ageSeconds = (now - new Date(latestCheckpoint.createdAt).getTime()) / 1000;
  const lagSeconds = 0;

  return { lagSeconds, ageSeconds };
}

/**
 * Default export: class-compatible constructor wrapper so callers can use
 * `new CheckpointManager(deps)` as well as the named `createCheckpointManager`.
 */
function CheckpointManager(deps) {
  return createCheckpointManager(deps);
}

export default CheckpointManager;
