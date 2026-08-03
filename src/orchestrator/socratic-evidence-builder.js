/**
 * Socratic Evidence Citation Builder
 * 
 * Provides utilities for building properly formatted evidence citations
 * for Socratic questions. Citations must reference specific data points
 * including event IDs, file paths, metric values, task IDs, campaign IDs,
 * and milestone IDs.
 * 
 * @typedef {import('./socratic-validation.js').SocraticQuestion} SocraticQuestion
 */

const CITATION_FORMATS = {
  TIMELINE_EVENT: 'timeline_event',
  TASK_REFERENCE: 'task_reference',
  FILE_REFERENCE: 'file_reference',
  CAMPAIGN_REFERENCE: 'campaign_reference',
  MILESTONE_REFERENCE: 'milestone_reference',
  METRIC_REFERENCE: 'metric_reference',
};

/**
 * Build a timeline event citation.
 * 
 * @param {string} eventId - Event ID (e.g., 'event_123', 'evt-456')
 * @param {string} timestamp - ISO timestamp of the event
 * @param {string} eventType - Type of event (e.g., 'task_completed', 'milestone_reached')
 * @param {string} summary - Brief summary of the event
 * @returns {string} Formatted citation string
 */
function buildTimelineEventCitation(eventId, timestamp, eventType, summary) {
  if (!eventId || !timestamp) {
    throw new Error('eventId and timestamp are required for timeline event citation');
  }
  
  const summaryPart = summary ? ` - ${summary}` : '';
  return `${eventId} (${timestamp}, ${eventType})${summaryPart}`;
}

/**
 * Build a task reference citation.
 * 
 * @param {string} taskId - Task ID (e.g., 'task_123')
 * @param {string} subtaskId - Subtask ID (optional, e.g., 'st_456')
 * @param {string} metric - Metric or outcome reference (e.g., 'completion_rate=0.85')
 * @param {string} status - Task status
 * @returns {string} Formatted citation string
 */
function buildTaskReferenceCitation(taskId, subtaskId, metric, status) {
  if (!taskId) {
    throw new Error('taskId is required for task reference citation');
  }
  
  let citation = `${taskId}`;
  
  if (subtaskId) {
    citation += `/${subtaskId}`;
  }
  
  if (metric) {
    citation += ` [${metric}]`;
  }
  
  if (status) {
    citation += ` (${status})`;
  }
  
  return citation;
}

/**
 * Build a file reference citation.
 * 
 * @param {string} filePath - Absolute or relative file path
 * @param {number} lineNumber - Line number (optional)
 * @param {string} context - Code context or description (optional)
 * @returns {string} Formatted citation string
 */
function buildFileReferenceCitation(filePath, lineNumber, context) {
  if (!filePath) {
    throw new Error('filePath is required for file reference citation');
  }
  
  let citation = filePath;
  
  if (lineNumber) {
    citation += `:${lineNumber}`;
  }
  
  if (context) {
    citation += ` - ${context}`;
  }
  
  return citation;
}

/**
 * Build a campaign reference citation.
 * 
 * @param {string} projectId - Project ID
 * @param {string} campaignId - Campaign ID
 * @param {string} milestoneId - Milestone ID (optional)
 * @param {string} status - Campaign status
 * @returns {string} Formatted citation string
 */
function buildCampaignReferenceCitation(projectId, campaignId, milestoneId, status) {
  if (!projectId || !campaignId) {
    throw new Error('projectId and campaignId are required for campaign reference citation');
  }
  
  let citation = `${projectId}/${campaignId}`;
  
  if (milestoneId) {
    citation += `/${milestoneId}`;
  }
  
  if (status) {
    citation += ` [${status}]`;
  }
  
  return citation;
}

/**
 * Build a metric reference citation.
 * 
 * @param {string} metricName - Name of the metric
 * @param {string|number} value - Metric value
 * @param {string} unit - Unit of measurement (optional)
 * @param {string} timeframe - Timeframe for the metric (optional)
 * @returns {string} Formatted citation string
 */
function buildMetricReferenceCitation(metricName, value, unit, timeframe) {
  if (!metricName || value === undefined && value !== 0) {
    throw new Error('metricName and value are required for metric reference citation');
  }
  
  let citation = `${metricName}=${value}`;
  
  if (unit) {
    citation += ` ${unit}`;
  }
  
  if (timeframe) {
    citation += ` (${timeframe})`;
  }
  
  return citation;
}

/**
 * Build a milestone reference citation.
 * 
 * @param {string} projectId - Project ID
 * @param {string} campaignId - Campaign ID
 * @param {string} milestoneId - Milestone ID (e.g., 'ms_123', 'milestone_456')
 * @param {string} description - Milestone description
 * @param {string} completionDate - Completion date (optional)
 * @returns {string} Formatted citation string
 */
function buildMilestoneReferenceCitation(projectId, campaignId, milestoneId, description, completionDate) {
  if (!projectId || !campaignId || !milestoneId) {
    throw new Error('projectId, campaignId, and milestoneId are required for milestone reference citation');
  }
  
  let citation = `${projectId}/${campaignId}/${milestoneId}`;
  
  if (description) {
    citation += `: ${description}`;
  }
  
  if (completionDate) {
    citation += ` [completed: ${completionDate}]`;
  }
  
  return citation;
}

/**
 * Validate that a citation string contains proper formatting.
 * 
 * @param {string} citation - The citation to validate
 * @returns {boolean} True if citation appears properly formatted
 */
function isValidCitation(citation) {
  if (!citation || typeof citation !== 'string') {
    return false;
  }
  
  const trimmed = citation.trim();
  
  // Must have some content
  if (trimmed.length < 3) {
    return false;
  }
  
  // Check for common citation patterns
  const hasEventId = /\b(event_|evt-|EVENT_)[a-zA-Z0-9_-]+\b/i.test(trimmed);
  const hasTaskId = /\b(task_|subtask_|st_)[a-zA-Z0-9_-]+\b/i.test(trimmed);
  const hasCampaignId = /\b(campaign_|camp-)[a-zA-Z0-9_-]+\b/i.test(trimmed);
  const hasMilestoneId = /\b(milestone_|ms_)[a-zA-Z0-9_-]+\b/i.test(trimmed);
  const hasFilePath = /([a-z]+\/[a-z0-9_\-]+\.js|[a-z]+\/[a-z0-9_\-]+\.ts|\/[a-zA-Z0-9_\-\/]+[\.](js|ts|json|md))\b/i.test(trimmed);
  const hasMetric = /\b(metric_|[a-z_]+=[a-zA-Z0-9_\-\.%]+)/i.test(trimmed) || /value[:\s]+[\d.]+/i.test(trimmed);
  const hasTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(trimmed);
  const hasLineRef = /:\d{3,}/.test(trimmed);
  
  return hasEventId || hasTaskId || hasCampaignId || hasMilestoneId || 
         hasFilePath || hasMetric || hasTimestamp || hasLineRef;
}

/**
 * Build a set of evidence citations from multiple data sources.
 * 
 * @param {object} sources - Object containing various data sources
 * @param {string[]} sources.timelineEvents - Array of timeline event IDs
 * @param {string[]} sources.tasks - Array of task IDs
 * @param {string[]} sources.files - Array of file paths
 * @param {string[]} sources.campaigns - Array of campaign references
 * @param {string[]} sources.metrics - Array of metric references
 * @returns {string[]} Array of formatted citation strings
 */
function buildEvidenceCitations(sources) {
  const citations = [];
  
  if (sources.timelineEvents && Array.isArray(sources.timelineEvents)) {
    sources.timelineEvents.forEach(event => {
      if (event.event_id || event.id) {
        citations.push(
          buildTimelineEventCitation(
            event.event_id || event.id,
            event.timestamp,
            event.type,
            event.summary || event.description
          )
        );
      }
    });
  }
  
  if (sources.tasks && Array.isArray(sources.tasks)) {
    sources.tasks.forEach(task => {
      citations.push(
        buildTaskReferenceCitation(
          task.task_id || task.id,
          task.subtask_id || task.subtaskId,
          task.metric || task.outcome,
          task.status
        )
      );
    });
  }
  
  if (sources.files && Array.isArray(sources.files)) {
    sources.files.forEach(file => {
      citations.push(
        buildFileReferenceCitation(
          file.path || file.filePath,
          file.line,
          file.context
        )
      );
    });
  }
  
  if (sources.campaigns && Array.isArray(sources.campaigns)) {
    sources.campaigns.forEach(camp => {
      citations.push(
        buildCampaignReferenceCitation(
          camp.projectId || camp.project_id,
          camp.campaignId || camp.campaign_id,
          camp.milestoneId || camp.milestone_id,
          camp.status
        )
      );
    });
  }
  
  if (sources.metrics && Array.isArray(sources.metrics)) {
    sources.metrics.forEach(metric => {
      citations.push(
        buildMetricReferenceCitation(
          metric.name || metric.metricName,
          metric.value,
          metric.unit,
          metric.timeframe
        )
      );
    });
  }
  
  return citations;
}

/**
 * Get the citation type for a given citation string.
 * 
 * @param {string} citation - The citation to analyze
 * @returns {string} Type of citation (CITATION_FORMATS.*)
 */
function getCitationType(citation) {
  if (!citation || typeof citation !== 'string') {
    return 'unknown';
  }
  
  const trimmed = citation.trim();
  
  if (/\b(event_|evt-|EVENT_)[a-zA-Z0-9_-]+\b/i.test(trimmed)) {
    return CITATION_FORMATS.TIMELINE_EVENT;
  }
  
  if (/\b(task_|subtask_|st_)[a-zA-Z0-9_-]+\b/i.test(trimmed)) {
    return CITATION_FORMATS.TASK_REFERENCE;
  }
  
  if (/([a-z]+\/[a-z0-9_\-]+\.js|[a-z]+\/[a-z0-9_\-]+\.ts|\/[a-zA-Z0-9_\-\/]+[\.](js|ts|json|md))\b/i.test(trimmed)) {
    return CITATION_FORMATS.FILE_REFERENCE;
  }
  
  if (/\b(campaign_|camp-)[a-zA-Z0-9_-]+\b/i.test(trimmed) || 
      /\w+\/[a-zA-Z0-9_\-]+/.test(trimmed)) {
    return CITATION_FORMATS.CAMPAIGN_REFERENCE;
  }
  
  if (/\b(milestone_|ms_)[a-zA-Z0-9_-]+\b/i.test(trimmed)) {
    return CITATION_FORMATS.MILESTONE_REFERENCE;
  }
  
  if (/\b(metric_|[a-z_]+=[a-zA-Z0-9_\-\.%]+)/i.test(trimmed) || /value[:\s]+[\d.]+/i.test(trimmed)) {
    return CITATION_FORMATS.METRIC_REFERENCE;
  }
  
  return 'unknown';
}

/**
 * Format evidence for use in Socratic questions.
 * Ensures all citations are properly formatted and valid.
 * 
 * @param {string|string[]} rawEvidence - Raw evidence string or array
 * @returns {string[]} Array of validated citation strings
 */
function formatEvidence(rawEvidence) {
  if (!rawEvidence) {
    return [];
  }
  
  const evidenceArray = Array.isArray(rawEvidence) ? rawEvidence : [rawEvidence];
  
  const formatted = evidenceArray
    .map(e => {
      if (typeof e === 'string') {
        return e.trim();
      }
      if (e.citation) {
        return e.citation;
      }
      if (e.text) {
        return e.text;
      }
      return String(e);
    })
    .filter(c => c.length > 0 && isValidCitation(c));
  
  return formatted;
}

export {
  CITATION_FORMATS,
  buildTimelineEventCitation,
  buildTaskReferenceCitation,
  buildFileReferenceCitation,
  buildCampaignReferenceCitation,
  buildMilestoneReferenceCitation,
  buildMetricReferenceCitation,
  isValidCitation,
  buildEvidenceCitations,
  getCitationType,
  formatEvidence,
};
