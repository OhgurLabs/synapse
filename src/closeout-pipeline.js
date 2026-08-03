import { createLogger } from './logger.js';

const log = createLogger('closeout-pipeline');

/**
 * Ingest agent performance metrics from campaign closeout summaries into the PerformanceStore.
 * Processes the last 50 completed campaigns for the given project.
 * Skips campaigns that have already been ingested.
 *
 * @param {CampaignManager} campaignManager
 * @param {PerformanceStore} performanceStore
 * @param {string} projectId
 */
export function ingestFromCloseouts(campaignManager, performanceStore, projectId) {
  log.info('Starting closeout ingestion', { projectId });
  
  const data = campaignManager.load(projectId);
  if (!data || !data.campaigns) {
    log.info('No campaigns found for project', { projectId });
    return;
  }

  // Filter for completed/failed campaigns with closeout summaries
  // Sort by completion date descending and take last 50
  const completed = data.campaigns
    .filter(c => c.closeoutSummary && (c.status === 'completed' || c.status === 'failed'))
    .sort((a, b) => {
      const dateA = new Date(a.completedAt || 0);
      const dateB = new Date(b.completedAt || 0);
      return dateB - dateA;
    })
    .slice(0, 50);

  let ingestedCount = 0;
  for (const campaign of completed) {
    // Skip if already in performance store to avoid double-counting
    if (performanceStore.getCampaignStats(campaign.id)) {
      continue;
    }

    const success = ingestCampaignPerformance(performanceStore, campaign);
    if (success) {
      ingestedCount++;
    }
  }

  if (ingestedCount > 0) {
    performanceStore.flush();
  }
  
  log.info('Closeout ingestion complete', { projectId, ingestedCount });
}

/**
 * Extract metrics from a single campaign's closeout summary and update the PerformanceStore.
 *
 * @param {PerformanceStore} performanceStore
 * @param {object} campaign
 * @returns {boolean} True if stats were ingested, false otherwise
 */
export function ingestCampaignPerformance(performanceStore, campaign) {
  const summary = campaign.closeoutSummary;
  if (!summary || !summary.agentStats) {
    log.warn('Campaign missing agentStats in closeoutSummary', { campaignId: campaign.id });
    return false;
  }

  log.info('Ingesting campaign stats', { campaignId: campaign.id });

  for (const [agentId, agentData] of Object.entries(summary.agentStats)) {
    // Process per-category breakdown (added in recent enhancement)
    if (agentData.byCategory) {
      for (const [category, catStats] of Object.entries(agentData.byCategory)) {
        const total = catStats.dispatches;
        if (total === 0) continue;

        // Distribute total duration across all dispatches for this category
        const avgDuration = (catStats.totalDurationMs || 0) / total;

        // Ingest successful subtasks
        for (let i = 0; i < catStats.subtasksCompleted; i++) {
          performanceStore.updateAgentPerformance(agentId, category, true, avgDuration, campaign.id);
        }
        // Ingest failed subtasks
        for (let i = 0; i < catStats.subtasksFailed; i++) {
          performanceStore.updateAgentPerformance(agentId, category, false, avgDuration, campaign.id);
        }
      }
    } else {
      // Fallback for older closeout summaries without category breakdown
      const total = agentData.dispatches;
      if (total === 0) continue;

      const avgDuration = (agentData.totalDurationMs || 0) / total;
      const category = 'unknown';

      for (let i = 0; i < agentData.subtasksCompleted; i++) {
        performanceStore.updateAgentPerformance(agentId, category, true, avgDuration, campaign.id);
      }
      for (let i = 0; i < agentData.subtasksFailed; i++) {
        performanceStore.updateAgentPerformance(agentId, category, false, avgDuration, campaign.id);
      }
    }
  }

  // Mark as completed in performance store
  performanceStore.markCampaignCompleted(campaign.id);
  return true;
}
