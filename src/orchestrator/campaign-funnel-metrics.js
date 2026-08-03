// campaign-funnel-metrics.js — Campaign completion funnel and error rate aggregation
//
// Traverses campaign→milestone→task hierarchy from campaigns.json files,
// joins with dispatch_decisions table to compute stage counts and conversion rates.
//
// Usage:
//   const metrics = await computeCampaignFunnelMetrics(baseDir, { window: '30d' });
//

import { readFileSync, existsSync, readdirSync, statSync as _statSync } from 'fs';
import { getDb, rowToCampaign, rowToMilestone, stateDbExists } from './state-db.js';
// NOTE: readFileSync retained for performance.json read (line ~340 in
// computeErrorBreakdown). Campaign data migrated to SQLite via state-db
// helpers above; performance.json remains JSON-only and outside #18 scope.
import { join, dirname } from 'path';
import Database from '../persistence/sqlite-provider.js';
import { createLogger } from '../logger.js';

const log = createLogger('campaign-funnel-metrics');
const statSync = _statSync;

const DEFAULT_BASE_DIR = '.synapse';
// Campaign data is read from SQLite (state.sqlite) via the canonical
// state-db helpers. Previously this module read campaigns.json directly;
// migrated 2026-05-30 to match the rest of the orchestrator's read path
// and unblock the JSON-as-snapshot-only refactor (task #18). The
// state.sqlite path is resolved via stateDbExists in state-db.js — no
// local STATE_DB_FILE constant needed.

/**
 * Compute campaign funnel metrics for a given time window.
 *
 * @param {string} baseDir - Base directory (e.g., '.synapse')
 * @param {Object} [options] - Options
 * @param {string} [options.window='30d'] - Time window: '1h', '24h', '7d', '30d'
 * @returns {Promise<Object>} Funnel metrics with stage counts, conversion rates, and error breakdown
 */
export async function computeCampaignFunnelMetrics(baseDir, options = {}) {
  const { window: windowParam = '30d' } = options;

  const baseDirectory = baseDir || join(process.cwd(), DEFAULT_BASE_DIR);
  const projectsDir = join(baseDirectory, 'projects');

  // Calculate time bounds based on window
  const endTime = new Date();
  const startTime = calculateStartTime(windowParam);

  // Load all campaigns from all projects
  const campaignData = loadAllCampaigns(projectsDir);

  // Compute stage counts from campaign hierarchy
  const stageCounts = computeStageCounts(campaignData, startTime, endTime);

  // Query dispatch decisions for outcome breakdown
  const dispatchMetrics = queryDispatchMetrics(baseDirectory, startTime, endTime);

  // Compute error breakdown by category
  const errorBreakdown = computeErrorBreakdown(dispatchMetrics, startTime, endTime, baseDirectory);

  // Calculate conversion rates between stages
  const conversionRates = calculateConversionRates(stageCounts, dispatchMetrics);

  return {
    window: windowParam,
    timeRange: {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    },
    stages: {
      campaigns: stageCounts.campaigns,
      milestones: stageCounts.milestones,
      tasks: stageCounts.tasks,
      dispatches: dispatchMetrics.totalDispatches,
      successes: dispatchMetrics.successes,
      failures: dispatchMetrics.failures,
      partial: dispatchMetrics.partial,
    },
    conversionRates,
    errorBreakdown,
    metadata: {
      projectsScanned: campaignData.projects.length,
      campaignsFound: stageCounts.campaigns,
      computedAt: new Date().toISOString(),
    },
  };
}

/**
 * Calculate start time based on window parameter.
 *
 * @param {string} window - Time window string
 * @returns {Date} Start time
 */
function calculateStartTime(window) {
  const now = new Date();
  const hours = parseInt(window.match(/\d+/)?.[0] || '30', 10);
  const unit = window.match(/[a-z]+/)?.[0] || 'd';

  switch (unit) {
    case 'h':
      now.setHours(now.getHours() - hours);
      break;
    case 'd':
      now.setDate(now.getDate() - hours);
      break;
    case 'w':
      now.setDate(now.getDate() - hours * 7);
      break;
    case 'm':
      now.setMonth(now.getMonth() - hours);
      break;
    default:
      now.setDate(now.getDate() - hours);
  }

  return now;
}

/**
 * Load all campaigns from all projects in the projects directory.
 *
 * @param {string} projectsDir - Path to projects directory
 * @returns {Object} Aggregated campaign data
 */
function loadAllCampaigns(projectsDir) {
  const result = {
    projects: [],
    campaigns: [],
    milestones: [],
    tasks: [],
  };

  if (!existsSync(projectsDir)) {
    log.warn(`Projects directory not found: ${projectsDir}`);
    return result;
  }

  const projectDirs = readdirSync(projectsDir).filter((item) => {
    const itemPath = join(projectsDir, item);
    return existsSync(itemPath) && statSync(itemPath).isDirectory();
  });

  for (const projectDir of projectDirs) {
    const projectPath = join(projectsDir, projectDir);

    // Skip non-project subdirectories AND projects with 0-byte state.sqlite
    // (the latter would crash via getDb's process.exit guard; stateDbExists
    // check covers both cases — added 2026-05-31 after enclave crash loop).
    if (!stateDbExists(projectPath)) {
      continue;
    }

    try {
      const db = getDb(projectPath);
      const campaignRows = db
        .prepare('SELECT * FROM campaigns WHERE project_id = ?')
        .all(projectDir);
      const campaigns = campaignRows.map(rowToCampaign);

      // Populate each campaign's milestones from the milestones table —
      // matches the nested-array shape that JSON consumers expect.
      const milestoneStmt = db.prepare(
        'SELECT * FROM milestones WHERE campaign_id = ? AND project_id = ?',
      );
      for (const campaign of campaigns) {
        const milestoneRows = milestoneStmt.all(campaign.id, projectDir);
        campaign.milestones = milestoneRows.map(rowToMilestone);
      }

      const projectName = projectDir;

      result.projects.push({
        name: projectName,
        campaignCount: campaigns.length,
      });

      for (const campaign of campaigns) {
        result.campaigns.push(campaign);

        // Extract milestones
        if (Array.isArray(campaign.milestones)) {
          for (const milestone of campaign.milestones) {
            const milestoneWithCampaign = {
              ...milestone,
              campaignId: campaign.id,
            };
            result.milestones.push(milestoneWithCampaign);

            // Extract task IDs from milestones
            if (Array.isArray(milestone.tasks)) {
              for (const taskId of milestone.tasks) {
                result.tasks.push({
                  id: taskId,
                  milestoneId: milestone.id,
                  campaignId: campaign.id,
                });
              }
            }
          }
        }

        // Extract top-level tasks if present
        if (Array.isArray(campaign.tasks)) {
          for (const taskId of campaign.tasks) {
            result.tasks.push({
              id: taskId,
              campaignId: campaign.id,
            });
          }
        }
      }
    } catch (err) {
      log.warn(`Failed to load campaigns from ${projectPath}/state.sqlite`, { error: err.message });
    }
  }

  return result;
}

/**
 * Filter campaigns/milestones/tasks by time window.
 *
 * @param {Object} campaignData - Campaign data object
 * @param {Date} startTime - Start time for filtering
 * @param {Date} endTime - End time for filtering
 * @returns {Object} Count of items at each stage within time window
 */
function computeStageCounts(campaignData, startTime, endTime) {
  let campaigns = 0;
  let milestones = 0;
  let tasks = 0;

  for (const campaign of campaignData.campaigns) {
    const campaignTime = new Date(campaign.createdAt || campaign.updatedAt);
    if (campaignTime >= startTime && campaignTime <= endTime) {
      campaigns += 1;

      // Count milestones within window
      if (Array.isArray(campaign.milestones)) {
        for (const milestone of campaign.milestones) {
          const milestoneTime = new Date(milestone.createdAt || milestone.updatedAt);
          if (milestoneTime >= startTime && milestoneTime <= endTime) {
            milestones += 1;

            // Count tasks in milestone
            if (Array.isArray(milestone.tasks)) {
              tasks += milestone.tasks.length;
            }
          }
        }
      }

      // Count top-level campaign tasks
      if (Array.isArray(campaign.tasks)) {
        tasks += campaign.tasks.length;
      }
    }
  }

  return { campaigns, milestones, tasks };
}

/**
 * Query dispatch metrics from dispatch log.
 *
 * @param {string} baseDir - Base directory
 * @param {Date} startTime - Start time for filtering
 * @param {Date} endTime - End time for filtering
 * @returns {Object} Dispatch metrics with total, success, failure, partial counts
 */
function queryDispatchMetrics(baseDir, startTime, endTime) {
  const dispatchDbPath = join(baseDir, 'dispatch-log.db');

  if (!existsSync(dispatchDbPath)) {
    log.warn(`Dispatch log database not found: ${dispatchDbPath}`);
    return { totalDispatches: 0, successes: 0, failures: 0, partial: 0 };
  }

  try {
    const db = new Database(dispatchDbPath, { readonly: true });

    const query = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures,
        SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partial
      FROM dispatch_decisions
      WHERE timestamp >= ? AND timestamp <= ?
    `;

    const row = db.prepare(query).get(startTime.toISOString(), endTime.toISOString());

    db.close();

    return {
      totalDispatches: row.total || 0,
      successes: row.successes || 0,
      failures: row.failures || 0,
      partial: row.partial || 0,
    };
  } catch (err) {
    log.error('Failed to query dispatch metrics', { error: err.message });
    return { totalDispatches: 0, successes: 0, failures: 0, partial: 0 };
  }
}

/**
 * Compute error breakdown by category from dispatch history.
 *
 * @param {Object} dispatchMetrics - Dispatch metrics object
 * @param {Date} startTime - Start time for filtering
 * @param {Date} endTime - End time for filtering
 * @param {string} baseDir - Base directory for data files
 * @returns {Object} Error breakdown by category
 */
function computeErrorBreakdown(dispatchMetrics, startTime, endTime, baseDir) {
  // Failure type constants from failure-classification.js
  const FAILURE_TYPES = {
    CAPABILITY: 'capability',
    BUG: 'bug',
    INCORRECT: 'incorrect',
    TIMEOUT: 'timeout',
    DISCONNECT: 'disconnect',
    RATE_LIMIT: 'rate_limit',
    KILLED: 'killed',
    SANDBOX: 'sandbox',
    PROVIDER_ERROR: 'provider_error',
  };

  // Get performance store data for failure type classification
  const performancePath = join(baseDir, 'performance.json');

  const errorCategories = {
    capability_failure: 0,
    timeout: 0,
    rate_limit: 0,
    disconnect: 0,
    other: 0,
  };

  if (existsSync(performancePath)) {
    try {
      const content = readFileSync(performancePath, 'utf8');
      const data = JSON.parse(content);

      // Iterate through all agent-category records
      if (data.byAgentCategory) {
        for (const record of Object.values(data.byAgentCategory)) {
          if (!record.dispatchHistory) continue;

          for (const dispatch of record.dispatchHistory) {
            const dispatchTime = new Date(dispatch.timestamp);
            if (dispatchTime < startTime || dispatchTime > endTime) continue;

            if (!dispatch.success && dispatch.failureType) {
              // Classify failure by type using FAILURE_TYPES constants
              if (
                dispatch.failureType === FAILURE_TYPES.CAPABILITY ||
                dispatch.failureType === FAILURE_TYPES.BUG ||
                dispatch.failureType === FAILURE_TYPES.INCORRECT
              ) {
                errorCategories.capability_failure += 1;
              } else if (dispatch.failureType === FAILURE_TYPES.TIMEOUT) {
                errorCategories.timeout += 1;
              } else if (dispatch.failureType === FAILURE_TYPES.RATE_LIMIT) {
                errorCategories.rate_limit += 1;
              } else if (dispatch.failureType === FAILURE_TYPES.DISCONNECT) {
                errorCategories.disconnect += 1;
              } else {
                // Handle other infrastructure failures (killed, sandbox, provider_error)
                errorCategories.other += 1;
              }
            }
          }
        }
      }
    } catch (err) {
      log.warn('Failed to read performance store for error breakdown', { error: err.message });
    }
  }

  const totalErrors = Object.values(errorCategories).reduce((sum, count) => sum + count, 0);

  return {
    categories: errorCategories,
    totalErrors,
    byPercentage: totalErrors > 0
      ? Object.fromEntries(
          Object.entries(errorCategories).map(([key, count]) => [
            key,
            Math.round((count / totalErrors) * 10000) / 100,
          ])
        )
      : null,
  };
}

/**
 * Calculate conversion rates between funnel stages.
 *
 * @param {Object} stageCounts - Stage counts object (includes campaigns, milestones, tasks)
 * @param {Object} dispatchMetrics - Dispatch metrics (includes dispatches, successes, failures, partial)
 * @returns {Object} Conversion rates between stages
 */
function calculateConversionRates(stageCounts, dispatchMetrics) {
  const { campaigns, milestones, tasks } = stageCounts;
  const dispatches = dispatchMetrics?.totalDispatches || 0;
  const successes = dispatchMetrics?.successes || 0;

  const rates = {};

  if (campaigns > 0) {
    rates.campaignToMilestone = milestones > 0
      ? Math.round((milestones / campaigns) * 10000) / 100
      : 0;
  }

  if (milestones > 0) {
    rates.milestoneToTask = tasks > 0
      ? Math.round((tasks / milestones) * 10000) / 100
      : 0;
  }

  // Task to dispatch conversion
  if (tasks > 0 && dispatches > 0) {
    rates.taskToDispatch = Math.round((dispatches / tasks) * 10000) / 100;
  } else if (campaigns > 0 && dispatches > 0) {
    // Fallback: campaigns to dispatches if no task data
    rates.taskToDispatch = Math.round((dispatches / campaigns) * 10000) / 100;
  } else if (dispatches > 0) {
    // If no campaign/task data but have dispatches, rate is undefined (0)
    rates.taskToDispatch = 0;
  }

  if (dispatches > 0) {
    rates.dispatchToSuccess = successes > 0
      ? Math.round((successes / dispatches) * 10000) / 100
      : 0;
  }

  // Overall conversion: campaigns to successes
  if (campaigns > 0 && dispatches > 0) {
    rates.overallCampaignToSuccess = successes > 0
      ? Math.round((successes / campaigns) * 10000) / 100
      : 0;
  }

  return rates;
}

export default computeCampaignFunnelMetrics;