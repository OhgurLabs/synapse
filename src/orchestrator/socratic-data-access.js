/**
 * Socratic Data Access Module
 * 
 * Provides query functions for Socratic campaign research and question generation.
 * Wraps LearningsManager, TimelineStore, CampaignManager, and CrossProjectScanner
 * to provide domain-specific context for Socratic reasoning.
 */

import { createLogger } from '../logger.js';

const log = createLogger('socratic-data');

/**
 * Query learnings for a project, optionally filtered by domain tags.
 * 
 * @param {LearningsManager} learningsManager - The LearningsManager instance
 * @param {string} projectId - Project ID to query
 * @param {string|null} domain - Optional domain filter (e.g., 'architecture', 'process')
 * @returns {Promise<object[]>} Array of learning entries matching filters
 */
export async function queryCampaignLearnings(learningsManager, projectId, domain = null) {
  try {
    // Always return all learnings for Socratic analysis - domain filtering is too restrictive
    let learnings = learningsManager.query(projectId, { limit: 100 });
    
    // Sort by timestamp descending
    learnings.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    log.debug('Queried learnings', { projectId, domain, count: learnings.length });
    return learnings;
  } catch (err) {
    log.error('Failed to query learnings', { projectId, domain, error: err.message });
    return [];
  }
}

/**
 * Query timeline events for a project with optional filters.
 * 
 * @param {TimelineStore} timelineStore - The TimelineStore instance
 * @param {string} projectId - Project ID to query
 * @param {object} filters - Optional filters: campaignId, taskId, type, since, until, limit
 * @returns {Promise<object[]>} Array of timeline events
 */
export async function queryTimelineEvents(timelineStore, projectId, filters = {}) {
  try {
    const queryFilters = {
      campaignId: filters.campaignId,
      taskId: filters.taskId,
      type: filters.type,
      since: filters.since,
      until: filters.until,
      limit: filters.limit || 100,
      offset: filters.offset || 0,
    };
    
    // Timeline events are correlated by campaign_id, not project directly
    // We need to find campaigns for this project first, then query events
    const events = timelineStore.query(queryFilters);
    
    log.debug('Queried timeline events', { projectId, campaignId: filters.campaignId, count: events.length });
    return events;
  } catch (err) {
    log.error('Failed to query timeline events', { projectId, error: err.message });
    return [];
  }
}

/**
 * Query pattern findings for a project from cross-project pattern detection.
 * 
 * @param {object} patternScanner - The cross-project pattern scanner instance
 * @param {string} projectId - Project ID to query
 * @returns {Promise<object[]>} Array of pattern findings involving this project
 */
export async function queryPatternFindings(patternScanner, projectId) {
  try {
    // Get current scan state/findings
    let findings = [];
    
    if (patternScanner.getScanStatus && typeof patternScanner.getScanStatus === 'function') {
      const status = patternScanner.getScanStatus();
      if (status && status.findings) {
        // Filter findings that involve this project
        findings = status.findings.filter(f => {
          if (f.projects) {
            return f.projects.includes(projectId);
          }
          if (f.projectId) {
            return f.projectId === projectId;
          }
          return false;
        });
      }
    }
    
    log.debug('Queried pattern findings', { projectId, count: findings.length });
    return findings;
  } catch (err) {
    log.error('Failed to query pattern findings', { projectId, error: err.message });
    return [];
  }
}

/**
 * Get campaign context including metadata, milestones, and related data.
 * 
 * @param {object} campaignManager - The CampaignManager instance
 * @param {string} projectId - Project ID
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<object|null>} Campaign object with enriched context, or null if not found
 */
export async function getCampaignContext(campaignManager, projectId, campaignId) {
  try {
    const campaign = campaignManager.getCampaign(projectId, campaignId);
    
    if (!campaign) {
      log.warn('Campaign not found', { projectId, campaignId });
      return null;
    }
    
    // Enrich with additional context
    const context = {
      ...campaign,
      
      // Milestone details (if available)
      milestones: campaign.milestones || [],
      
      // Task pipeline summary
      taskPipeline: campaign.taskPipeline || [],
      
      // Progress metrics
      percentComplete: campaign.percentComplete || 0,
      
      // Related learnings count
      learningCount: 0,
      
      // Timeline event count
      timelineEventCount: 0,
    };
    
    log.debug('Retrieved campaign context', { projectId, campaignId, type: campaign.type });
    return context;
  } catch (err) {
    log.error('Failed to get campaign context', { projectId, campaignId, error: err.message });
    return null;
  }
}

/**
 * Get all projects with their campaigns for cross-project analysis.
 * 
 * @param {object} stateManager - The StateManager instance
 * @param {object} campaignManager - The CampaignManager instance
 * @returns {Promise<object[]>} Array of { projectId, campaigns[], learningsCount }
 */
export async function getCrossProjectContext(stateManager, campaignManager) {
  try {
    const projects = stateManager.listProjects();
    
    const context = await Promise.all(projects.map(async (proj) => {
      const projectId = proj.id || proj;
      const campaigns = campaignManager.listCampaigns(projectId);
      
      return {
        projectId,
        projectName: proj.name || projectId,
        campaigns: campaigns.map(c => ({
          id: c.id,
          title: c.title,
          type: c.type,
          status: c.status,
          domain: c.domain || null,
        })),
        campaignCount: campaigns.length,
      };
    }));
    
    log.debug('Retrieved cross-project context', { projectCount: context.length });
    return context;
  } catch (err) {
    log.error('Failed to get cross-project context', { error: err.message });
    return [];
  }
}

/**
 * Build a comprehensive research package for Socratic analysis.
 * Combines learnings, timeline events, pattern findings, and campaign context.
 * 
 * @param {object} deps - Dependency injection object with all managers
 * @param {string} deps.projectId - Project ID
 * @param {string} deps.campaignId - Campaign ID (optional)
 * @param {string} deps.domain - Domain for filtering
 * @param {LearningsManager} deps.learningsManager - LearningsManager instance
 * @param {TimelineStore} deps.timelineStore - TimelineStore instance
 * @param {object} deps.campaignManager - CampaignManager instance
 * @param {object} deps.patternScanner - Pattern scanner instance
 * @returns {Promise<object>} Research package with all context data
 */
export async function buildResearchPackage(deps) {
  const {
    projectId,
    campaignId = null,
    domain = null,
    learningsManager,
    timelineStore,
    campaignManager,
    patternScanner,
  } = deps;
  
  const pkg = {
    projectId,
    campaignId,
    domain,
    timestamp: new Date().toISOString(),
    data: {},
  };
  
  try {
    // Gather all context in parallel
    const [learnings, timelineEvents, patternFindings, campaignContext] = await Promise.all([
      queryCampaignLearnings(learningsManager, projectId, domain),
      queryTimelineEvents(timelineStore, projectId, { campaignId, limit: 50 }),
      queryPatternFindings(patternScanner, projectId),
      campaignId ? getCampaignContext(campaignManager, projectId, campaignId) : null,
    ]);
    pkg.data = {
      learnings: {
        total: learnings.length,
        entries: learnings,
        categories: extractCategories(learnings),
        severities: extractSeverities(learnings),
      },
      timelineEvents: {
        total: timelineEvents.length,
        events: timelineEvents,
      },
      patternFindings: {
        total: patternFindings.length,
        findings: patternFindings,
      },
      campaign: campaignContext,
    };
    
    log.info('Built research package', { 
      projectId, 
      campaignId, 
      learningsCount: pkg.data.learnings.total,
      eventsCount: pkg.data.timelineEvents.total,
      patternsCount: pkg.data.patternFindings.total,
    });
    
    return pkg;
  } catch (err) {
    log.error('Failed to build research package', { projectId, campaignId, error: err.message });
    
    // Return partial package with error flag
    pkg.error = err.message;
    pkg.data = {
      learnings: { total: 0, entries: [], categories: {}, severities: {} },
      timelineEvents: { total: 0, events: [] },
      patternFindings: { total: 0, findings: [] },
      campaign: null,
    };
    
    return pkg;
  }
}

/**
 * Extract unique categories from learnings entries.
 */
function extractCategories(learnings) {
  const categories = {};
  learnings.forEach(l => {
    const cat = l.category || 'unknown';
    categories[cat] = (categories[cat] || 0) + 1;
  });
  return categories;
}

/**
 * Extract unique severity levels from learnings entries.
 */
function extractSeverities(learnings) {
  const severities = {};
  learnings.forEach(l => {
    const sev = l.severity || 'unknown';
    severities[sev] = (severities[sev] || 0) + 1;
  });
  return severities;
}

/**
 * Validate research package structure.
 * 
 * @param {object} pkg - Research package to validate
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateResearchPackage(pkg) {
  const errors = [];
  
  if (!pkg || typeof pkg !== 'object') {
    return { valid: false, errors: ['Package must be an object'] };
  }
  
  if (!pkg.projectId || typeof pkg.projectId !== 'string') {
    errors.push('Missing or invalid projectId');
  }
  
  if (!pkg.data || typeof pkg.data !== 'object') {
    errors.push('Missing or invalid data object');
  } else {
    if (!Array.isArray(pkg.data.learnings?.entries)) {
      errors.push('Invalid learnings.entries array');
    }
    if (!Array.isArray(pkg.data.timelineEvents?.events)) {
      errors.push('Invalid timelineEvents.events array');
    }
    if (!Array.isArray(pkg.data.patternFindings?.findings)) {
      errors.push('Invalid patternFindings.findings array');
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

export default {
  queryCampaignLearnings,
  queryTimelineEvents,
  queryPatternFindings,
  getCampaignContext,
  getCrossProjectContext,
  buildResearchPackage,
  validateResearchPackage,
};
