/**
 * Report Generator for Scheduled Export System
 * Generates CSV, JSON, and PDF reports from timeline events
 * Integrates with existing export-formatters.js and pdf-formatter.js
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { streamCSV, formatJSONArray } from './export-formatters.js';
import {
  buildActivitySummaryReport,
  buildIncidentTimelineReport,
  renderActivitySummaryPDF,
  renderIncidentTimelinePDF,
} from './pdf-formatter.js';
import { createLogger } from '../logger.js';

const log = createLogger('report-generator');

/**
 * Parse scope parameter into timeline query filters
 * @param {string} scope - Scope string (e.g., "system", "campaign:abc123", "agent:alice")
 * @returns {Object} Filter object for TimelineStore.query()
 */
function parseScopeToFilters(scope) {
  if (!scope || scope === 'system') {
    return {}; // No filters for system-wide scope
  }

  // Parse "type:value" format
  const parts = scope.split(':');
  if (parts.length !== 2) {
    throw new TypeError(`Invalid scope format: "${scope}". Expected "type:value" or "system"`);
  }

  const [scopeType, scopeValue] = parts;

  const filterMap = {
    campaign: 'campaignId',
    agent: 'agentId',
    provider: 'provider',
    dispatch: 'dispatchId',
    trace: 'traceId',
    milestone: 'milestoneId',
    task: 'taskId',
    subtask: 'subtaskId',
  };

  const filterKey = filterMap[scopeType];
  if (!filterKey) {
    throw new TypeError(`Unknown scope type: "${scopeType}". Valid types: ${Object.keys(filterMap).join(', ')}, system`);
  }

  return { [filterKey]: scopeValue };
}

/**
 * Format date range for display
 * @param {string} startDate - ISO date string
 * @param {string} endDate - ISO date string
 * @returns {string} Formatted date range
 */
function formatDateRange(startDate, endDate) {
  const start = startDate ? new Date(startDate).toISOString().split('T')[0] : 'beginning';
  const end = endDate ? new Date(endDate).toISOString().split('T')[0] : 'now';
  return `${start} to ${end}`;
}

/**
 * Generate CSV report from timeline events
 * @param {Object} timelineStore - TimelineStore instance
 * @param {Object} params - Report parameters
 * @param {string} params.startDate - ISO 8601 start date
 * @param {string} params.endDate - ISO 8601 end date
 * @param {string} [params.scope='system'] - Scope filter (e.g., "campaign:abc", "agent:alice", "system")
 * @returns {string} CSV content as string
 */
export function generateCsvReport(timelineStore, { startDate, endDate, scope = 'system' }) {
  try {
    log.info('Generating CSV report', { startDate, endDate, scope });

    // Parse scope into filters
    const scopeFilters = parseScopeToFilters(scope);

    // Query timeline store with date range and scope filters
    const queryFilters = {
      ...scopeFilters,
      since: startDate,
      until: endDate,
      limit: 500,
      offset: 0,
    };

    // Collect all events across pages (TimelineStore.query max limit is 500)
    const allEvents = [];
    let hasMore = true;

    while (hasMore) {
      const result = timelineStore.query(queryFilters);
      const events = result.events || [];
      allEvents.push(...events);

      // Check if we got fewer results than requested (end of results)
      hasMore = events.length === 500;
      queryFilters.offset += 500;

      // Safety limit to prevent infinite loops (50K events for CSV)
      if (allEvents.length >= 50000) {
        log.warn('CSV report truncated at 50K events', { scope, startDate, endDate });
        break;
      }
    }

    log.info('Queried timeline events for CSV', { eventCount: allEvents.length });

    // Use existing streamCSV formatter to generate CSV
    let csvContent = '';
    const writeCallback = (chunk) => {
      csvContent += chunk;
    };

    streamCSV(allEvents, writeCallback);

    return csvContent;
  } catch (error) {
    log.error('CSV report generation failed', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Generate JSON report from timeline events
 * @param {Object} timelineStore - TimelineStore instance
 * @param {Object} params - Report parameters
 * @param {string} params.startDate - ISO 8601 start date
 * @param {string} params.endDate - ISO 8601 end date
 * @param {string} [params.scope='system'] - Scope filter (e.g., "campaign:abc", "agent:alice", "system")
 * @returns {string} JSON content as string
 */
export function generateJsonReport(timelineStore, params) {
  try {
    const { startDate, endDate, scope = 'system' } = params;
    log.info('Generating JSON report', { startDate, endDate, scope });

    // Parse scope into filters
    const scopeFilters = parseScopeToFilters(scope);

    // Query timeline store with date range and scope filters
    const queryFilters = {
      ...scopeFilters,
      since: startDate,
      until: endDate,
      limit: 500,
      offset: 0,
    };

    // Collect all events across pages
    const allEvents = [];
    let hasMore = true;

    while (hasMore) {
      const result = timelineStore.query(queryFilters);
      const events = result.events || [];
      allEvents.push(...events);

      hasMore = events.length === 500;
      queryFilters.offset += 500;

      // Safety limit (50K events for JSON)
      if (allEvents.length >= 50000) {
        log.warn('JSON report truncated at 50K events', { scope, startDate, endDate });
        break;
      }
    }

    log.info('Queried timeline events for JSON', { eventCount: allEvents.length });

    // Use existing formatJSONArray formatter to generate JSON
    let jsonContent = '';
    const writeCallback = (chunk) => {
      jsonContent += chunk;
    };

    formatJSONArray(allEvents, writeCallback);

    return jsonContent;
  } catch (error) {
    log.error('JSON report generation failed', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Generate PDF report from timeline events
 * @param {Object} timelineStore - TimelineStore instance
 * @param {Object} params - Report parameters
 * @param {string} params.startDate - ISO 8601 start date
 * @param {string} params.endDate - ISO 8601 end date
 * @param {string} [params.scope='system'] - Scope filter (e.g., "campaign:abc", "agent:alice", "system")
 * @param {string} template - Report template ('activity_summary' or 'incident_timeline')
 * @returns {Promise<Buffer>} PDF buffer
 */
export async function generatePdfReport(timelineStore, params, template) {
  try {
    const { startDate, endDate, scope = 'system' } = params;
    log.info('Generating PDF report', { startDate, endDate, scope, template });

    // Parse scope into filters
    const scopeFilters = parseScopeToFilters(scope);

    // Query timeline store with date range and scope filters
    const queryFilters = {
      ...scopeFilters,
      since: startDate,
      until: endDate,
      limit: 500,
      offset: 0,
    };

    // Collect all events across pages (limit to 10K for PDF to keep file size reasonable)
    const allEvents = [];
    let hasMore = true;

    while (hasMore && allEvents.length < 10000) {
      const result = timelineStore.query(queryFilters);
      const events = result.events || [];
      allEvents.push(...events);

      hasMore = events.length === 500;
      queryFilters.offset += 500;
    }

    if (allEvents.length >= 10000) {
      log.warn('PDF report limited to 10K events', { scope, startDate, endDate });
    }

    log.info('Queried timeline events for PDF', { eventCount: allEvents.length, template });

    // Determine scope type and value for metadata
    let scopeType = 'system';
    let scopeValue = 'All';

    if (scope && scope !== 'system') {
      const parts = scope.split(':');
      if (parts.length === 2) {
        scopeType = parts[0];
        scopeValue = parts[1];
      }
    }

    // Build metadata for PDF
    const metadata = {
      dateRange: formatDateRange(startDate, endDate),
      scope: scopeValue,
      scopeType,
    };

    // Build report data based on template
    let reportData;
    let pdfDoc;

    if (template === 'incident_timeline') {
      reportData = buildIncidentTimelineReport(allEvents);
      pdfDoc = renderIncidentTimelinePDF(reportData, metadata);
    } else if (template === 'activity_summary') {
      reportData = buildActivitySummaryReport(allEvents);
      pdfDoc = renderActivitySummaryPDF(reportData, metadata);
    } else {
      throw new TypeError(`Unknown PDF template: ${template}. Valid templates: activity_summary, incident_timeline`);
    }

    // Convert PDF stream to buffer
    return new Promise((resolve, reject) => {
      const chunks = [];

      pdfDoc.on('data', (chunk) => {
        chunks.push(chunk);
      });

      pdfDoc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        log.info('PDF report generated successfully', { size: buffer.length, eventCount: allEvents.length });
        resolve(buffer);
      });

      pdfDoc.on('error', (error) => {
        log.error('PDF generation error', { error: error.message });
        reject(error);
      });

      // Finalize the PDF and trigger 'end' event
      pdfDoc.end();
    });
  } catch (error) {
    log.error('PDF report generation failed', { error: error.message, stack: error.stack });
    throw error;
  }
}

/**
 * Orchestration function for scheduled report generation
 * Called by lifecycle.js heartbeat tick to process due scheduled reports
 * @param {Object} params
 * @param {Object} params.schedule - Schedule object from ScheduledReportStore
 * @param {Object} params.scheduledReportStore - ScheduledReportStore instance
 * @param {Object} params.timelineStore - TimelineStore instance
 * @param {Object} params.log - Logger instance
 * @returns {Promise<string>} Path to generated report file
 */
export async function generateScheduledReport({ schedule, scheduledReportStore, timelineStore, log }) {
  const startTime = Date.now();

  try {
    log.info('Starting scheduled report generation', {
      scheduleId: schedule.id,
      format: schedule.format,
      template: schedule.template,
      scope: schedule.scope,
    });

    // Parse scope - could be string or object
    const scopeStr = typeof schedule.scope === 'object'
      ? (schedule.scope.scope || 'system')
      : (schedule.scope || 'system');

    // Extract date range from scope if present, or default to last 30 days
    const endDate = new Date().toISOString();
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const params = {
      startDate: schedule.scope?.startDate || startDate,
      endDate: schedule.scope?.endDate || endDate,
      scope: scopeStr,
    };

    // Generate report content based on format
    let content;
    let fileExtension;

    if (schedule.format === 'csv') {
      content = generateCsvReport(timelineStore, params);
      fileExtension = 'csv';
    } else if (schedule.format === 'json') {
      content = generateJsonReport(timelineStore, params);
      fileExtension = 'json';
    } else if (schedule.format === 'pdf') {
      const template = schedule.template || 'activity_summary';
      content = await generatePdfReport(timelineStore, params, template);
      fileExtension = 'pdf';
    } else {
      throw new TypeError(`Unsupported format: ${schedule.format}`);
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `report_${schedule.id}_${timestamp}.${fileExtension}`;
    const filePath = join(scheduledReportStore.reportsDir, filename);

    // Write content to disk
    if (Buffer.isBuffer(content)) {
      writeFileSync(filePath, content);
    } else {
      writeFileSync(filePath, content, 'utf-8');
    }

    const fileSize = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf-8');

    log.info('Report file written successfully', {
      scheduleId: schedule.id,
      filePath,
      fileSize,
    });

    // Record generated report in database
    const reportRecord = scheduledReportStore.recordGeneratedReport(schedule.id, filePath, {
      fileSize,
      format: schedule.format,
      scope: schedule.scope,
    });

    // Update next_run timestamp for this schedule
    const nextRun = scheduledReportStore._calculateNextRun(
      schedule.cron_expression,
      new Date().toISOString()
    );

    scheduledReportStore._stmts.schedule.updateNextRun.run(
      nextRun,
      new Date().toISOString(),
      schedule.id
    );

    const durationMs = Date.now() - startTime;
    log.info('Scheduled report generation complete', {
      scheduleId: schedule.id,
      reportId: reportRecord.id,
      filePath,
      fileSize,
      durationMs,
      nextRun,
    });

    return filePath;
  } catch (error) {
    log.error('Scheduled report generation failed', {
      scheduleId: schedule.id,
      error: error.message,
      stack: error.stack,
      durationMs: Date.now() - startTime,
    });
    throw error;
  }
}

