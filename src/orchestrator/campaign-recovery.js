// campaign-recovery.js — Campaign startup recovery implementation
//
// Detects and recovers campaigns left in 'active' state after system restart.
// On startup, scans all projects for active campaigns and checks if they were interrupted
// (no events within threshold before last shutdown). Interrupted campaigns are either
// auto-resumed (if all tasks are resumable) or marked 'needs_review' for operator intervention.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getDb, rowToCampaign, rowToTask, stateDbExists } from './state-db.js';
import { assertSafeProjectId } from '../safe-id.js';

// readFileSync retained for last-shutdown.json read below. Other fs writers
// (writeFileSync/mkdirSync/etc.) were imported but never used in this file —
// dropped 2026-05-30 as part of the #18 JSON-reader migration cleanup.

const STALE_THRESHOLD_MS = 600000; // 10 minutes default
const FRESHNESS_FALLBACK_MS = 3600000; // 1 hour fallback if no shutdown timestamp

/**
 * Check for interrupted campaigns and recover them.
 *
 * @param {object} deps - Dependencies
 * @param {object} deps.stateManager - StateManager instance with listProjects() and projectsDir
 * @param {object} deps.campaignManager - CampaignManager instance with setRecoveryStatus()
 * @param {object} deps.eventBus - EventBus instance for emitting recovery events
 * @param {object} deps.config - Configuration
 * @param {boolean} deps.config.skipRecovery - If true, skip recovery entirely
 * @param {number} deps.config.campaignStaleMs - Staleness threshold in ms (default 600000 = 10 min)
 * @param {string} deps.config.baseDir - Base directory for .synapse folder (defaults to stateManager.baseDir)
 * @returns {Promise<object>} - { recovered: [], needsReview: [], scanned: number, skipped: number, clean: boolean }
 */
export async function recoveryCheck(deps) {
  const { stateManager, campaignManager, eventBus, config = {} } = deps;

  const results = {
    recovered: [],
    needsReview: [],
    scanned: 0,
    skipped: 0,
    clean: true,
  };

  // Skip recovery if flag is set
  if (config.skipRecovery) {
    return results;
  }

  // Get staleness threshold (default 10 minutes)
  const staleThresholdMs = config.campaignStaleMs || 600000;

  // Read last-shutdown.json to get shutdown timestamp
  const baseDir = config.baseDir || stateManager.baseDir;
  const lastShutdownPath = join(baseDir, 'last-shutdown.json');
  let shutdownTime;

  if (existsSync(lastShutdownPath)) {
    try {
      const lastShutdownData = JSON.parse(readFileSync(lastShutdownPath, 'utf8'));
      shutdownTime = new Date(lastShutdownData.shutdownAt).getTime();
    } catch (err) {
      // Corrupted file, fall back to default (1 hour ago)
      shutdownTime = Date.now() - 3600000;
    }
  } else {
    // Missing last-shutdown.json, use default (1 hour ago)
    shutdownTime = Date.now() - 3600000;
  }

  // Calculate staleness cutoff: campaigns with no activity before this time are stale
  const staleCutoff = shutdownTime - staleThresholdMs;

  // Get all projects
  const projects = stateManager.listProjects();

  for (const project of projects) {
    const projectId = project.id;

    // Read active campaigns for this project from state.sqlite. Migrated
    // from campaigns.json (#18, 2026-05-30) — SQLite is the live read path.
    // Skip projects with missing OR 0-byte state.sqlite (the latter would
    // crash the whole orchestrator via getDb's process.exit guard;
    // stateDbExists check added 2026-05-31 after enclave crash loop).
    try {
      assertSafeProjectId(projectId);
    } catch {
      continue; // skip path-unsafe project ids mid multi-project scan
    }
    const projectPath = join(stateManager.projectsDir, projectId);
    if (!stateDbExists(projectPath)) {
      continue;
    }

    let campaigns = [];
    try {
      const db = getDb(projectPath);
      const rows = db
        .prepare("SELECT * FROM campaigns WHERE project_id = ? AND status = 'active'")
        .all(projectId);
      campaigns = rows.map(rowToCampaign);
    } catch (err) {
      // Failed to query state DB for this project — skip without crashing
      // recovery for the rest of the projects.
      continue;
    }

    for (const campaign of campaigns) {
      results.scanned++;

      // SELECT already filtered status='active', but keep the guard for
      // resilience against schema drift or future query changes.
      if (campaign.status !== 'active') {
        results.skipped++;
        continue;
      }

      // Check if campaign is stale (last update before staleCutoff)
      const lastEventTime = new Date(campaign.updatedAt).getTime();

      if (lastEventTime < staleCutoff) {
        // Campaign is interrupted
        results.clean = false;

        // Check if campaign has non-resumable tasks
        const hasNonResumable = await checkNonResumableTasks(
          stateManager.projectsDir,
          projectId,
          campaign.id
        );

        if (hasNonResumable) {
          // Mark as needs_review
          results.needsReview.push({ campaignId: campaign.id, projectId });

          // Update campaign recovery status
          campaignManager.setRecoveryStatus(projectId, campaign.id, 'needs_review');

          // Emit event
          await eventBus.emit('campaign:needs_review', {
            campaignId: campaign.id,
            projectId,
            reason: 'interrupted_with_non_resumable_tasks',
          });
        } else {
          // Auto-resume
          results.recovered.push({ campaignId: campaign.id, projectId });

          // Update campaign recovery status
          campaignManager.setRecoveryStatus(projectId, campaign.id, 'recovered');

          // Emit event
          await eventBus.emit('campaign:recovered', {
            campaignId: campaign.id,
            projectId,
            reason: 'interrupted_and_resumed',
          });
        }
      } else {
        // Campaign is not stale, skip
        results.skipped++;
      }
    }
  }

  return results;
}

/**
 * Check if a campaign has non-resumable tasks.
 * A task is non-resumable if it's in 'executing' state with claimed subtasks.
 *
 * @param {string} projectsDir - Projects directory path
 * @param {string} projectId - Project ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<boolean>} - True if campaign has non-resumable tasks
 */
async function checkNonResumableTasks(projectsDir, projectId, campaignId) {
  try {
    assertSafeProjectId(projectId);
  } catch {
    return false;
  }
  const projectPath = join(projectsDir, projectId);

  // Same 0-byte safety as the campaigns scan above.
  if (!stateDbExists(projectPath)) {
    return false;
  }

  try {
    const db = getDb(projectPath);
    // Filter at the SQL layer: only tasks in 'executing' status for this
    // campaign. Avoids loading non-executing tasks we'd otherwise discard.
    const taskRows = db
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND campaign_id = ? AND status = 'executing'",
      )
      .all(projectId, campaignId);
    if (taskRows.length === 0) return false;

    // For each executing task, check if any subtask is in 'claimed' status.
    // We could COUNT(*) per task, but most campaigns have <5 executing tasks
    // so per-task SELECT is fine — and we get out early on the first hit.
    const claimedStmt = db.prepare(
      "SELECT 1 FROM subtasks WHERE task_id = ? AND status = 'claimed' LIMIT 1",
    );
    for (const taskRow of taskRows) {
      const task = rowToTask(taskRow);
      const claimed = claimedStmt.get(task.id);
      if (claimed) {
        return true;
      }
    }
    return false;
  } catch (err) {
    // Failed to query state DB — assume no non-resumable tasks rather than
    // pessimistically blocking recovery on a transient DB error.
    return false;
  }
}
