/**
 * PDF Report Formatter for Audit Trail System
 * Generates formatted PDF reports from structured report data
 * Uses PDFKit for streaming PDF generation
 */

import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import { createLogger } from '../logger.js';

const log = createLogger('pdf-formatter');

/**
 * Initialize a PDF document with header metadata
 * @param {Object} metadata - Report metadata
 * @param {string} metadata.title - Report title
 * @param {string} metadata.dateRange - Date range string
 * @param {string} metadata.scope - Scope identifier
 * @param {string} metadata.scopeType - Scope type (system/project/campaign)
 * @returns {PDFDocument} PDFKit document instance
 */
function initializePDF({ title, dateRange, scope, scopeType = 'system' }) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: title,
      Producer: 'Synapse Audit System',
      Creator: 'Synapse PDF Generator',
    },
  });

  // Add title page
  doc.fontSize(24).text(title, { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Date Range: ${dateRange}`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Scope: ${scopeType ? `${scopeType.charAt(0).toUpperCase() + scopeType.slice(1)}` : 'System'} - ${scope}`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
  doc.addPage();

  return doc;
}

/**
 * Add page numbers to footer
 * @param {PDFDocument} doc - PDFKit document instance
 */
function addPageNumbers(doc) {
  const pageCount = doc.pageCount;
  
  doc.on('page', (page) => {
    const pageNum = page.number;
    const totalPages = page.attributes['/Pages'].attributes['/Count'];
    
    doc.fontSize(8)
      .fillColor('#666666')
      .text(
        `Page ${pageNum} of ${totalPages}`,
        doc.page.margins.right,
        doc.page.height - 20,
        { align: 'right', width: doc.page.margins.right }
      );
  });
}

/**
 * Add a section with title and content
 * @param {PDFDocument} doc - PDFKit document instance
 * @param {string} title - Section title
 * @param {Array} content - Array of content lines or objects
 */
function addSection(doc, title, content) {
  if (!content || !Array.isArray(content) || content.length === 0) {
    return;
  }

  doc.moveDown(0.5);
  doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text(title);
  doc.font('Helvetica');
  doc.fontSize(10).fillColor('#000000');
  doc.moveDown(0.3);

  for (const item of content) {
    if (typeof item === 'string') {
      doc.text(item);
    } else if (item.text) {
      doc.text(item.text);
    }
    doc.moveDown(0.15);
  }
}

/**
 * Create a formatted table from data array
 * @param {PDFDocument} doc - PDFKit document instance
 * @param {Array} headers - Array of header strings
 * @param {Array} rows - Array of row data arrays
 * @param {Object} options - Table options
 * @param {number} [options.y] - Starting Y position
 * @param {number} [options.width] - Table width
 * @param {number} [options.cellHeight] - Height per cell
 * @param {string} [options.headerFillColor] - Header background color
 */
function renderTable(doc, headers, rows, options = {}) {
  const {
    y = doc.y,
    width = doc.page.width - doc.page.margins.left - doc.page.margins.right,
    cellHeight = 12,
    headerFillColor = '#f0f0f0',
  } = options;

  const colCount = headers.length;
  const colWidth = width / colCount;

  // Draw header
  let currentY = y;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333');
  
  for (let i = 0; i < colCount; i++) {
    const x = doc.page.margins.left + i * colWidth;
    doc.rect(x, currentY, colWidth - 1, cellHeight).fill(headerFillColor);
    doc.text(headers[i], x + 4, currentY + 4, {
      width: colWidth - 8,
      align: 'left',
    });
  }
  doc.rect(doc.page.margins.left, currentY, width, cellHeight).stroke('#cccccc');
  currentY += cellHeight;

  // Draw data rows
  doc.font('Helvetica').fontSize(9).fillColor('#000000');
  
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const x = doc.page.margins.left + i * colWidth;
      const value = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
      doc.rect(x, currentY, colWidth - 1, cellHeight).stroke('#dddddd');
      doc.text(value, x + 4, currentY + 4, {
        width: colWidth - 8,
        align: 'left',
        valign: 'top',
      });
    }
    currentY += cellHeight;
    
    // Check if we need a new page
    if (currentY > doc.page.height - doc.page.margins.bottom - 50) {
      doc.addPage();
      addPageNumbers(doc);
      currentY = doc.page.margins.top;
    }
  }

  return currentY;
}

/**
 * Render reasoning excerpt with formatting
 * @param {PDFDocument} doc - PDFKit document instance
 * @param {string} reasoning - Reasoning text
 * @param {number} [y] - Starting Y position
 * @returns {number} New Y position
 */
function renderReasoning(doc, reasoning, y) {
  if (!reasoning) return y;

  const formattedReasoning = String(reasoning)
    .replace(/\n/g, '\n    ')
    .trim();

  doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555')
    .text(formattedReasoning, doc.page.margins.left, y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20,
      align: 'left',
    });

  return y + 25;
}

/**
 * Stream PDF document to HTTP response
 * @param {PDFDocument} doc - PDFKit document instance
 * @param {import('http').ServerResponse} res - HTTP response object
 * @param {string} filename - Output filename
 */
function streamPDFToResponse(doc, res, filename) {
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });

  // Pipe PDF to response
  doc.pipe(res);
  
  doc.on('end', () => {
    res.end();
  });

  doc.on('error', (err) => {
    log.error('PDF generation error', { error: err.message });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PDF generation failed', details: err.message }));
    }
  });

  return doc;
}

/**
 * Render Activity Summary PDF
 * @param {Object} reportData - Structured report data
 * @param {Object} metadata - Report metadata
 * @returns {PDFDocument} PDF document instance
 */
function renderActivitySummaryPDF(reportData, metadata) {
  const doc = initializePDF({
    title: 'Activity Summary Report',
    dateRange: metadata.dateRange,
    scope: metadata.scope,
    scopeType: metadata.scopeType,
  });

  // Handle empty data case - add a message on the second page
  const summary = reportData.summary || {};
  if (summary.totalEvents === 0 || summary.totalEvents === undefined) {
    doc.fontSize(12).text('No events found for the selected date range and scope.', { align: 'center' });
    // Do NOT end the document here. The caller owns the lifecycle and always
    // calls end() itself (report-generator.js is the only caller), so ending
    // here made a SECOND end() throw ERR_STREAM_PUSH_AFTER_EOF — an empty
    // export answered 500 instead of returning an empty PDF. The sibling
    // renderIncidentTimelinePDF's empty branch already returns without ending;
    // this one was the outlier.
    return doc;
  }

  const sections = [];

  // Executive Summary
  sections.push({
    title: 'Executive Summary',
    content: [
      `Total Events: ${summary.totalEvents || 0}`,
      `Time Period: ${metadata.dateRange}`,
      `Scope: ${metadata.scopeType} - ${metadata.scope}`,
      `Success Rate: ${summary.successRate !== null ? `${(summary.successRate * 100).toFixed(1)}%` : 'N/A'}`,
      `Error Rate: ${summary.errorRate !== null ? `${(summary.errorRate * 100).toFixed(1)}%` : 'N/A'}`,
    ],
  });

  // Agent Activity Breakdown
  if (reportData.agentBreakdown && reportData.agentBreakdown.length > 0) {
    const headers = ['Agent', 'Dispatches', 'Success Rate', 'Errors', 'Successes', 'Failures'];
    const rows = reportData.agentBreakdown.map(agent => [
      agent.agentId,
      agent.totalDispatches || 0,
      agent.successRate !== null ? `${(agent.successRate * 100).toFixed(1)}%` : 'N/A',
      agent.errors || 0,
      agent.successes || 0,
      agent.failures || 0,
    ]);
    
    sections.push({
      title: 'Agent Activity Breakdown',
      table: { headers, rows },
    });
  }

  // Decision Audit Trail
  if (reportData.decisionTrail && reportData.decisionTrail.length > 0) {
    const decisionTrail = reportData.decisionTrail.slice(0, 50); // Limit to first 50 for readability
    const trailContent = decisionTrail.map((decision, idx) => {
      const reasoning = decision.reasoning || decision.selectionReason || 'No reasoning provided';
      return {
        text: `${idx + 1}. ${decision.agentId || 'Unknown'} - ${decision.timestamp || 'N/A'}: ${decision.summary || decision.outcome || 'Decision'}`,
        reasoning,
      };
    });
    
    sections.push({
      title: 'Decision Audit Trail (Recent)',
      content: trailContent,
    });
  }

  // Write sections to PDF
  for (const section of sections) {
    if (section.table) {
      renderTable(doc, section.table.headers, section.table.rows);
      doc.moveDown(1);
    } else if (section.title === 'Decision Audit Trail (Recent)') {
      // Special handling for decision trail with reasoning excerpts
      doc.moveDown(0.5);
      doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text(section.title);
      doc.font('Helvetica');
      doc.fontSize(10).fillColor('#000000');
      doc.moveDown(0.5);

      for (const item of section.content) {
        // Check if we need a new page
        if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
          doc.addPage();
        }

        // Render decision summary
        doc.fontSize(10).fillColor('#000000').font('Helvetica')
          .text(item.text, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        doc.moveDown(0.2);

        // Render reasoning excerpt if present
        if (item.reasoning) {
          doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555')
            .text(`    Reasoning: ${item.reasoning}`, {
              width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20,
              align: 'left',
            });
        }
        doc.moveDown(0.5);
      }
    } else {
      addSection(doc, section.title, section.content);
      doc.moveDown(1);
    }
  }

  return doc;
}

/**
 * Render Incident Timeline PDF
 * @param {Object} reportData - Structured report data
 * @param {Object} metadata - Report metadata
 * @returns {PDFDocument} PDFKit document instance
 */
function renderIncidentTimelinePDF(reportData, metadata) {
  const doc = initializePDF({
    title: 'Incident Timeline Report',
    dateRange: metadata.dateRange,
    scope: metadata.scope,
    scopeType: metadata.scopeType,
  });

  // Handle empty data case - add a message on the second page
  const hasIncidents = reportData.incidents && reportData.incidents.length > 0;
  const hasTimelineEvents = reportData.timelineEvents && reportData.timelineEvents.length > 0;
  
  if (!hasIncidents && !hasTimelineEvents) {
    doc.fontSize(12).text('No incidents found for the selected date range and scope.', { align: 'center' });
    return doc;
  }

  // Incidents Section
  if (reportData.incidents && reportData.incidents.length > 0) {
    doc.moveDown(0.5);
    doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text('Incidents');
    doc.font('Helvetica');
    doc.fontSize(10).fillColor('#000000');
    doc.moveDown(0.3);

    for (const incident of reportData.incidents) {
      // Check if we need a new page before rendering incident
      if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
        doc.addPage();
      }

      // Incident title with severity badge
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#333333')
        .text(`[${incident.severity || 'INFO'}] ${incident.title || incident.summary || 'Incident'}`, doc.page.margins.left, doc.y);
      doc.font('Helvetica');

      // Metadata line: timestamp and agent in gray
      const timestamp = incident.timestamp || incident.event_ts || 'N/A';
      const agentId = incident.agentId || 'N/A';
      const traceId = incident.traceId || incident.trace_id || 'N/A';

      doc.fontSize(9).fillColor('#666666');
      const metaStartY = doc.y + 12;
      const prefixText = `${timestamp} | Agent: ${agentId} | Trace: `;
      doc.text(prefixText, doc.page.margins.left, metaStartY, { continued: true });

      // Format trace ID as clickable-looking link (blue text)
      const traceStartX = doc.page.margins.left + doc.widthOfString(prefixText, { fontSize: 9 });
      doc.fillColor('#0066cc');
      doc.text(traceId, { underline: true, continued: false });

      // Draw underline manually for better control
      const traceWidth = doc.widthOfString(traceId, { fontSize: 9 });
      doc.save();
      doc.strokeColor('#0066cc').lineWidth(0.5);
      doc.moveTo(traceStartX, metaStartY + 10).lineTo(traceStartX + traceWidth, metaStartY + 10).stroke();
      doc.restore();

      doc.fillColor('#000000');
      doc.moveDown(0.5);

      // Description (may include reasoning)
      if (incident.description || incident.detail) {
        doc.fontSize(9).fillColor('#000000')
          .text(String(incident.description || incident.detail), doc.page.margins.left, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20,
            align: 'left',
          });
        doc.moveDown(0.3);
      }

      // Agent reasoning (if provided as separate field)
      if (incident.reasoning && incident.reasoning !== incident.description) {
        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555')
          .text('Agent Reasoning:', doc.page.margins.left, doc.y);
        doc.font('Helvetica').fontSize(8).fillColor('#666666')
          .text(`    ${String(incident.reasoning)}`, doc.page.margins.left, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20,
            align: 'left',
          });
        doc.moveDown(0.3);
      }

      // Failure propagation chain
      if (incident.failureChain || incident.propagationChain) {
        const chain = incident.failureChain || incident.propagationChain;
        if (Array.isArray(chain) && chain.length > 0) {
          doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555')
            .text('Failure Propagation:', doc.page.margins.left, doc.y);
          doc.font('Helvetica');
          doc.fontSize(8).fillColor('#777777');

          for (const step of chain) {
            const stepText = typeof step === 'string' ? step : (step.message || step.reason || step.reasoning || JSON.stringify(step));
            doc.text(`  ↳ ${stepText}`, doc.page.margins.left, doc.y, {
              width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20,
            });
          }
          doc.moveDown(0.3);
        }
      }

      doc.moveDown(0.5);
    }
  }

  // Timeline Events Section
  if (reportData.timelineEvents && reportData.timelineEvents.length > 0) {
    doc.addPage();
    doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text('Event Timeline');
    doc.font('Helvetica');
    doc.fontSize(10).fillColor('#000000');
    doc.moveDown(0.3);

    // Limit to 100 events for readability
    const eventsToShow = reportData.timelineEvents.slice(0, 100);

    for (const event of eventsToShow) {
      // Check if we need a new page
      if (doc.y > doc.page.height - doc.page.margins.bottom - 80) {
        doc.addPage();
      }

      // Event type and timestamp
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#444444')
        .text(`${event.type || 'unknown'} - ${event.timestamp || event.event_ts || 'N/A'}`, doc.page.margins.left, doc.y);

      // Agent and trace reference
      doc.font('Helvetica').fontSize(9).fillColor('#666666');
      const agentId = event.agentId || event.agent_id || 'N/A';
      const traceId = event.traceId || event.trace_id || null;

      if (traceId) {
        const agentPrefix = `Agent: ${agentId} | Trace: `;
        const agentTraceY = doc.y;
        doc.text(agentPrefix, doc.page.margins.left, agentTraceY, { continued: true });

        // Format trace ID as blue link with underline
        const traceStartX = doc.page.margins.left + doc.widthOfString(agentPrefix, { fontSize: 9 });
        doc.fillColor('#0066cc');
        doc.text(traceId, { continued: false });

        // Draw underline
        const traceWidth = doc.widthOfString(traceId, { fontSize: 9 });
        doc.save();
        doc.strokeColor('#0066cc').lineWidth(0.5);
        doc.moveTo(traceStartX, agentTraceY + 10).lineTo(traceStartX + traceWidth, agentTraceY + 10).stroke();
        doc.restore();

        doc.fillColor('#000000');
      } else {
        doc.text(`Agent: ${agentId}`, doc.page.margins.left, doc.y);
      }

      // Event summary
      if (event.summary || event.event_data) {
        doc.fontSize(8).fillColor('#333333')
          .text(`    ${event.summary || event.event_data || 'No summary'}`, doc.page.margins.left, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20,
            align: 'left',
          });
      }

      // Agent reasoning (if available in timeline event)
      if (event.reasoning) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#555555')
          .text(`    Reasoning: ${event.reasoning}`, doc.page.margins.left, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 20,
            align: 'left',
          });
        doc.font('Helvetica');
      }

      doc.moveDown(0.4);
    }

    // Note if events were truncated
    if (reportData.timelineEvents.length > 100) {
      doc.fontSize(8).fillColor('#999999')
        .text(`Note: Showing first 100 of ${reportData.timelineEvents.length} timeline events`, doc.page.margins.left, doc.y);
    }
  }

  return doc;
}

/**
 * Build activity summary report data from events
 * @param {Array} events - Array of timeline events
 * @returns {Object} Report data object
 */
function buildActivitySummaryReport(events) {
  const agentStats = {};
  let totalDispatches = 0;
  let totalSuccesses = 0;
  let totalErrors = 0;

  events.forEach(event => {
    const agentId = event.agent_id || event.agentId;
    if (!agentId) return;

    if (!agentStats[agentId]) {
      agentStats[agentId] = {
        agentId,
        totalDispatches: 0,
        successes: 0,
        errors: 0,
        failures: 0,
      };
    }

    agentStats[agentId].totalDispatches++;
    totalDispatches++;

    const status = event.status || event.data?.status;
    if (status === 'success' || status === 'completed') {
      agentStats[agentId].successes++;
      totalSuccesses++;
    } else if (status === 'error' || status === 'failed') {
      agentStats[agentId].errors++;
      agentStats[agentId].failures++;
      totalErrors++;
    }
  });

  const agentBreakdown = Object.values(agentStats).map(agent => ({
    ...agent,
    successRate: agent.totalDispatches > 0 
      ? agent.successes / agent.totalDispatches 
      : 0,
  }));

  agentBreakdown.sort((a, b) => b.totalDispatches - a.totalDispatches);

  // Extract decision trail from routing events
  const decisionTrail = events
    .filter(e => e.type === 'routing_event' || e.data?.type === 'routing')
    .slice(0, 50)
    .map(e => ({
      timestamp: e.event_ts || e.timestamp,
      agentId: e.agent_id || e.agentId,
      reasoning: e.selection_reason || e.data?.selection_reason || 'No reasoning provided',
      summary: e.summary || e.data?.summary || 'Routing decision',
    }));

  const overallSuccessRate = totalDispatches > 0 ? totalSuccesses / totalDispatches : 0;
  const overallErrorRate = totalDispatches > 0 ? totalErrors / totalDispatches : 0;

  return {
    summary: {
      totalEvents: events.length,
      totalDispatches,
      totalSuccesses,
      totalErrors,
      successRate: overallSuccessRate,
      errorRate: overallErrorRate,
    },
    agentBreakdown,
    decisionTrail,
  };
}

/**
 * Build incident timeline report data from events
 * @param {Array} events - Array of timeline events
 * @returns {Object} Report data object
 */
function buildIncidentTimelineReport(events) {
  const incidents = [];
  const timelineEvents = [];

  events.forEach(event => {
    const status = event.status || event.data?.status;
    const severity = event.severity || event.data?.severity || 'info';
    
    // Filter for error/failure events
    if (status === 'error' || status === 'failed' || severity === 'high' || severity === 'critical') {
      const incident = {
        timestamp: event.event_ts || event.timestamp,
        severity,
        status,
        agentId: event.agent_id || event.agentId,
        campaignId: event.campaign_id || event.campaignId,
        dispatchId: event.dispatch_id || event.dispatchId,
        title: event.summary || event.data?.summary || event.title,
        summary: event.summary || event.data?.summary || 'No summary available',
        description: event.detail || event.data?.detail || event.description,
        traceId: event.trace_id || event.traceId,
        failureChain: event.data?.failureChain || event.data?.errorChain || event.data?.propagationChain || [],
      };

      // Get reasoning if available
      if (event.selection_reason || event.data?.selection_reason) {
        incident.reasoning = event.selection_reason || event.data?.selection_reason;
      }

      incidents.push(incident);
    }

    // Add to timeline if not already an incident
    if (status !== 'error' && status !== 'failed') {
      timelineEvents.push({
        timestamp: event.event_ts || event.timestamp,
        type: event.type || 'general',
        summary: event.summary || 'Event occurred',
        agentId: event.agent_id || event.agentId,
        campaignId: event.campaign_id || event.campaignId,
        traceId: event.trace_id || event.traceId,
      });
    }
  });

  // Sort incidents by timestamp descending (most recent first)
  incidents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Sort timeline events by timestamp ascending
  timelineEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return {
    incidents,
    timelineEvents,
    summary: {
      totalIncidents: incidents.length,
      criticalCount: incidents.filter(i => i.severity === 'critical').length,
      highCount: incidents.filter(i => i.severity === 'high').length,
      mediumCount: incidents.filter(i => i.severity === 'medium').length,
    },
  };
}

export {
  initializePDF,
  addPageNumbers,
  addSection,
  renderTable,
  renderReasoning,
  streamPDFToResponse,
  renderActivitySummaryPDF,
  renderIncidentTimelinePDF,
  buildActivitySummaryReport,
  buildIncidentTimelineReport,
};
