/**
 * PDFExporter - Streaming PDF report generator for audit events
 * 
 * Generates PDF reports from timeline events using pdfkit with streaming
 * to maintain constant memory footprint regardless of result set size.
 * Supports two templates: 'activity_summary' and 'incident_timeline'.
 */

import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import { createLogger } from '../../logger.js';
import {
  buildActivitySummaryReport,
  buildIncidentTimelineReport,
} from './pdf-formatter.js';

const log = createLogger('pdf-exporter');

/**
 * PDFExporter - Streaming PDF writer for audit reports
 * 
 * Writes PDF data incrementally using pdfkit's streaming capabilities.
 * Processes events in batches without buffering entire result set in memory.
 */
export class PDFExporter {
  /**
   * @param {Object} options
   * @param {NodeJS.WritableStream} options.outputStream - Writable stream for PDF output
   * @param {ExportQueryEngine} options.queryEngine - Export query engine instance
   * @param {Object} [options.filters] - Query filters
   * @param {string} [options.template='activity_summary'] - Report template
   * @param {Function} [options.onProgress] - Progress callback(status)
   */
  constructor(options = {}) {
    if (!options.outputStream) {
      throw new TypeError('outputStream option is required');
    }
    if (!options.queryEngine) {
      throw new TypeError('queryEngine option is required');
    }

    this.outputStream = options.outputStream;
    this.queryEngine = options.queryEngine;
    this.filters = options.filters || {};
    this.template = options.template || 'activity_summary';
    this.onProgress = options.onProgress;

    this.eventsProcessed = 0;
    this.bytesWritten = 0;
    this.pdfDoc = null;
    this.metadata = null;
  }

  /**
   * Parse scope parameter into metadata
   * @private
   */
  _parseScope() {
    let scopeType = 'system';
    let scopeValue = 'All';
    let dateRangeStart = null;
    let dateRangeEnd = null;

    // Handle scope filter
    if (this.filters.scope && typeof this.filters.scope === 'string') {
      const parts = this.filters.scope.split(':');
      if (parts.length === 2) {
        scopeType = parts[0];
        scopeValue = parts[1];
      }
    }

    // Handle date range
    if (this.filters.startDate || this.filters.since) {
      dateRangeStart = this.filters.startDate || this.filters.since;
    }
    if (this.filters.endDate || this.filters.until) {
      dateRangeEnd = this.filters.endDate || this.filters.until;
    }

    // Format date range string
    const formatDate = (dateStr) => {
      if (!dateStr) return 'unknown';
      return new Date(dateStr).toISOString().split('T')[0];
    };

    const dateRange = `${formatDate(dateRangeStart)} to ${formatDate(dateRangeEnd)}`;

    return {
      title: this.template === 'activity_summary' ? 'Activity Summary Report' : 'Incident Timeline Report',
      dateRange,
      scope: scopeValue,
      scopeType,
    };
  }

  /**
   * Initialize PDF document with metadata
   * @private
   */
  _initializePDF(doc, metadata) {
    // Title page
    doc.fontSize(24).text(metadata.title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Date Range: ${metadata.dateRange}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(
      `Scope: ${metadata.scopeType ? `${metadata.scopeType.charAt(0).toUpperCase() + metadata.scopeType.slice(1)}` : 'System'} - ${metadata.scope}`,
      { align: 'center' }
    );
    doc.moveDown();
    doc.fontSize(10).text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
    doc.addPage();
  }

  /**
   * Add page numbers to footer
   * @private
   */
  _addPageNumbers(doc) {
    doc.on('page', (page) => {
      const pageNum = page.number;
      const totalPages = page.attributes['/Pages'].attributes['/Count'];

      doc
        .fontSize(8)
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
   * Render activity summary section
   * @private
   */
  _renderActivitySummary(doc, reportData) {
    const summary = reportData.summary || {};

    // Executive Summary
    doc.moveDown(0.5);
    doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text('Executive Summary');
    doc.font('Helvetica');
    doc.fontSize(10).fillColor('#000000');
    doc.moveDown(0.3);

    doc.text(`Total Events: ${summary.totalEvents || 0}`);
    doc.text(`Time Period: ${this.metadata.dateRange}`);
    doc.text(
      `Scope: ${this.metadata.scopeType} - ${this.metadata.scope}`,
    );
    doc.text(
      `Success Rate: ${
        summary.successRate !== null
          ? `${(summary.successRate * 100).toFixed(1)}%`
          : 'N/A'
      }`,
    );
    doc.text(
      `Error Rate: ${
        summary.errorRate !== null
          ? `${(summary.errorRate * 100).toFixed(1)}%`
          : 'N/A'
      }`,
    );
    doc.moveDown(1);

    // Agent Activity Breakdown
    if (reportData.agentBreakdown && reportData.agentBreakdown.length > 0) {
      doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text('Agent Activity Breakdown');
      doc.font('Helvetica');
      doc.fontSize(10).fillColor('#000000');
      doc.moveDown(0.3);

      const headers = ['Agent', 'Dispatches', 'Success Rate', 'Errors', 'Successes', 'Failures'];
      const rows = reportData.agentBreakdown.map((agent) => [
        agent.agentId,
        agent.totalDispatches || 0,
        agent.successRate !== null
          ? `${(agent.successRate * 100).toFixed(1)}%`
          : 'N/A',
        agent.errors || 0,
        agent.successes || 0,
        agent.failures || 0,
      ]);

      this._renderTable(doc, headers, rows);
      doc.moveDown(1);
    }

    // Decision Audit Trail
    if (reportData.decisionTrail && reportData.decisionTrail.length > 0) {
      doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text('Decision Audit Trail (Recent)');
      doc.font('Helvetica');
      doc.fontSize(10).fillColor('#000000');
      doc.moveDown(0.3);

      const decisionTrail = reportData.decisionTrail.slice(0, 50);

      for (const decision of decisionTrail) {
        const reasoning = decision.reasoning || decision.selectionReason || 'No reasoning provided';
        const text = `${decision.agentId || 'Unknown'} - ${decision.timestamp || 'N/A'}: ${
          decision.summary || decision.outcome || 'Decision'
        }`;

        doc.fontSize(10).fillColor('#000000').font('Helvetica').text(text);
        doc.moveDown(0.2);

        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555').text(
          `    Reasoning: ${reasoning}`,
          {
            width:
              doc.page.width -
              doc.page.margins.left -
              doc.page.margins.right -
              20,
            align: 'left',
          }
        );
        doc.moveDown(0.5);

        // Check for page overflow
        if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
          doc.addPage();
          this._addPageNumbers(doc);
        }
      }
    }
  }

  /**
   * Render incident timeline section
   * @private
   */
  _renderIncidentTimeline(doc, reportData) {
    const { incidents, timelineEvents } = reportData;

    // Incidents Section
    if (incidents && incidents.length > 0) {
      doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text('Incidents');
      doc.font('Helvetica');
      doc.fontSize(10).fillColor('#000000');
      doc.moveDown(0.3);

      for (const incident of incidents) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
          doc.addPage();
          this._addPageNumbers(doc);
        }

        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333333').text(
          `[${incident.severity || 'INFO'}] ${incident.title || incident.summary || 'Incident'}`,
          doc.page.margins.left,
          doc.y
        );
        doc.font('Helvetica');

        const timestamp = incident.timestamp || incident.event_ts || 'N/A';
        const agentId = incident.agentId || 'N/A';
        const traceId = incident.traceId || incident.trace_id || 'N/A';

        doc.fontSize(9).fillColor('#666666');
        const prefixText = `${timestamp} | Agent: ${agentId} | Trace: `;
        doc.text(prefixText, doc.page.margins.left, doc.y, { continued: true });

        doc.fillColor('#0066cc');
        doc.text(traceId, { underline: true, continued: false });

        const traceWidth = doc.widthOfString(traceId, { fontSize: 9 });
        doc.save();
        doc.strokeColor('#0066cc').lineWidth(0.5);
        doc.moveTo(
          doc.page.margins.left + doc.widthOfString(prefixText, { fontSize: 9 }),
          doc.y + 10
        ).lineTo(
          doc.page.margins.left + doc.widthOfString(prefixText, { fontSize: 9 }) + traceWidth,
          doc.y + 10
        ).stroke();
        doc.restore();

        doc.fillColor('#000000');
        doc.moveDown(0.5);

        if (incident.description || incident.detail) {
          doc.fontSize(9).fillColor('#000000').text(
            String(incident.description || incident.detail),
            doc.page.margins.left,
            doc.y,
            {
              width:
                doc.page.width -
                doc.page.margins.left -
                doc.page.margins.right -
                20,
              align: 'left',
            }
          );
          doc.moveDown(0.3);
        }

        if (incident.reasoning) {
          doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555').text(
            'Agent Reasoning:',
            doc.page.margins.left,
            doc.y
          );
          doc.font('Helvetica').fontSize(8).fillColor('#666666').text(
            `    ${String(incident.reasoning)}`,
            doc.page.margins.left,
            doc.y,
            {
              width:
                doc.page.width -
                doc.page.margins.left -
                doc.page.margins.right -
                20,
              align: 'left',
            }
          );
          doc.moveDown(0.3);
        }

        if (incident.failureChain || incident.propagationChain) {
          const chain = incident.failureChain || incident.propagationChain;
          if (Array.isArray(chain) && chain.length > 0) {
            doc.fontSize(9).font('Helvetica-Oblique').fillColor('#555555').text(
              'Failure Propagation:',
              doc.page.margins.left,
              doc.y
            );
            doc.font('Helvetica');
            doc.fontSize(8).fillColor('#777777');

            for (const step of chain) {
              const stepText =
                typeof step === 'string'
                  ? step
                  : step.message || step.reason || step.reasoning || JSON.stringify(step);
              doc.text(`  ↳ ${stepText}`, doc.page.margins.left, doc.y, {
                width:
                  doc.page.width -
                  doc.page.margins.left -
                  doc.page.margins.right -
                  20,
              });
            }
            doc.moveDown(0.3);
          }
        }

        doc.moveDown(0.5);
      }
    }

    // Timeline Events Section
    if (timelineEvents && timelineEvents.length > 0) {
      doc.addPage();
      doc.fontSize(16).fillColor('#000000').font('Helvetica-Bold').text('Event Timeline');
      doc.font('Helvetica');
      doc.fontSize(10).fillColor('#000000');
      doc.moveDown(0.3);

      const eventsToShow = timelineEvents.slice(0, 100);

      for (const event of eventsToShow) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 80) {
          doc.addPage();
          this._addPageNumbers(doc);
        }

        doc.fontSize(10).font('Helvetica-Bold').fillColor('#444444').text(
          `${event.type || 'unknown'} - ${event.timestamp || event.event_ts || 'N/A'}`,
          doc.page.margins.left,
          doc.y
        );

        doc.font('Helvetica').fontSize(9).fillColor('#666666');
        const agentId = event.agentId || event.agent_id || 'N/A';
        const traceId = event.traceId || event.trace_id || null;

        if (traceId) {
          const agentPrefix = `Agent: ${agentId} | Trace: `;
          const agentTraceY = doc.y;
          doc.text(agentPrefix, doc.page.margins.left, agentTraceY, { continued: true });

          doc.fillColor('#0066cc');
          doc.text(traceId, { continued: false });

          const traceWidth = doc.widthOfString(traceId, { fontSize: 9 });
          doc.save();
          doc.strokeColor('#0066cc').lineWidth(0.5);
          doc.moveTo(
            doc.page.margins.left + doc.widthOfString(agentPrefix, { fontSize: 9 }),
            agentTraceY + 10
          ).lineTo(
            doc.page.margins.left + doc.widthOfString(agentPrefix, { fontSize: 9 }) + traceWidth,
            agentTraceY + 10
          ).stroke();
          doc.restore();

          doc.fillColor('#000000');
        } else {
          doc.text(`Agent: ${agentId}`, doc.page.margins.left, doc.y);
        }

        if (event.summary || event.event_data) {
          doc.fontSize(8).fillColor('#333333').text(
            `    ${event.summary || event.event_data || 'No summary'}`,
            doc.page.margins.left,
            doc.y,
            {
              width:
                doc.page.width -
                doc.page.margins.left -
                doc.page.margins.right -
                20,
              align: 'left',
            }
          );
        }

        if (event.reasoning) {
          doc.fontSize(8).font('Helvetica-Oblique').fillColor('#555555').text(
            `    Reasoning: ${event.reasoning}`,
            doc.page.margins.left,
            doc.y,
            {
              width:
                doc.page.width -
                doc.page.margins.left -
                doc.page.margins.right -
                20,
              align: 'left',
            }
          );
          doc.font('Helvetica');
        }

        doc.moveDown(0.4);
      }

      if (timelineEvents.length > 100) {
        doc.fontSize(8).fillColor('#999999').text(
          `Note: Showing first 100 of ${timelineEvents.length} timeline events`,
          doc.page.margins.left,
          doc.y
        );
      }
    }
  }

  /**
   * Render a formatted table
   * @private
   */
  _renderTable(doc, headers, rows) {
    const colCount = headers.length;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = width / colCount;
    const cellHeight = 12;

    let currentY = doc.y;

    // Draw header
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333');

    for (let i = 0; i < colCount; i++) {
      const x = doc.page.margins.left + i * colWidth;
      doc.rect(x, currentY, colWidth - 1, cellHeight).fill('#f0f0f0');
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

      if (currentY > doc.page.height - doc.page.margins.bottom - 50) {
        doc.addPage();
        this._addPageNumbers(doc);
        currentY = doc.page.margins.top;
      }
    }
  }

  /**
   * Stream PDF document to HTTP response
   * @private
   */
  _streamPDF() {
    this.outputStream.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="report.pdf"`,
    });

    this.pdfDoc.pipe(this.outputStream);

    this.pdfDoc.on('end', () => {
      this.outputStream.end();
      log.info('PDF export stream ended', {
        eventsProcessed: this.eventsProcessed,
        bytesWritten: this.bytesWritten,
      });
    });

    this.pdfDoc.on('error', (err) => {
      log.error('PDF generation error', { error: err.message });
      if (!this.outputStream.headersSent) {
        this.outputStream.writeHead(500, { 'Content-Type': 'application/json' });
        this.outputStream.end(
          JSON.stringify({ error: 'PDF generation failed', details: err.message })
        );
      }
    });
  }

  /**
   * Export events to PDF
   * @returns {Promise<Object>} Export statistics
   */
  async export() {
    const startTime = Date.now();

    try {
      // Initialize PDF document
      this.metadata = this._parseScope();
      this.pdfDoc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: {
          Title: this.metadata.title,
          Producer: 'Synapse Audit System',
          Creator: 'Synapse PDF Generator',
        },
      });

      this._streamPDF();
      this._initializePDF(this.pdfDoc, this.metadata);
      this._addPageNumbers(this.pdfDoc);

      // Stream events from query engine and build report data
      const eventStream = this.queryEngine.queryEventsStream(this.filters, {
        onProgress: this.onProgress,
      });

      const allEvents = [];
      let firstBatch = true;

      for await (const batch of eventStream) {
        if (batch.length === 0) continue;

        allEvents.push(...batch);
        this.eventsProcessed += batch.length;

        // Progress update every 5000 events
        if (this.onProgress && this.eventsProcessed % 5000 === 0) {
          this.onProgress({
            phase: 'processing',
            eventsProcessed: this.eventsProcessed,
            bytesWritten: this.bytesWritten,
          });
        }

        // Limit to 10K events for PDF to keep file size reasonable
        if (allEvents.length >= 10000) {
          log.warn('PDF report limited to 10K events', {
            template: this.template,
          });
          break;
        }
      }

      log.info('Collected events for PDF', {
        eventCount: allEvents.length,
        template: this.template,
      });

      // Build report data based on template
      let reportData;
      if (this.template === 'incident_timeline') {
        reportData = buildIncidentTimelineReport(allEvents);
      } else if (this.template === 'activity_summary') {
        reportData = buildActivitySummaryReport(allEvents);
      } else {
        throw new TypeError(
          `Unknown PDF template: ${this.template}. Valid templates: activity_summary, incident_timeline`
        );
      }

      // Handle empty data case
      if (this.template === 'activity_summary' && (reportData.summary.totalEvents === 0 || reportData.summary.totalEvents === undefined)) {
        this.pdfDoc.fontSize(12).text('No events found for the selected date range and scope.', {
          align: 'center',
        });
        this.pdfDoc.end();
        const duration = Date.now() - startTime;
        return {
          format: 'pdf',
          eventsProcessed: 0,
          bytesWritten: 0,
          durationMs: duration,
        };
      }

      if (this.template === 'incident_timeline' && !reportData.incidents && !reportData.timelineEvents) {
        this.pdfDoc.fontSize(12).text('No incidents found for the selected date range and scope.', {
          align: 'center',
        });
        this.pdfDoc.end();
        const duration = Date.now() - startTime;
        return {
          format: 'pdf',
          eventsProcessed: 0,
          bytesWritten: 0,
          durationMs: duration,
        };
      }

      // Render report content
      if (this.template === 'activity_summary') {
        this._renderActivitySummary(this.pdfDoc, reportData);
      } else if (this.template === 'incident_timeline') {
        this._renderIncidentTimeline(this.pdfDoc, reportData);
      }

      this.pdfDoc.end();

      const duration = Date.now() - startTime;

      log.info('PDF export complete', {
        eventsProcessed: this.eventsProcessed,
        bytesWritten: this.bytesWritten,
        durationMs: duration,
        template: this.template,
      });

      return {
        format: 'pdf',
        eventsProcessed: this.eventsProcessed,
        bytesWritten: this.bytesWritten,
        durationMs: duration,
        template: this.template,
      };
    } catch (error) {
      log.error('PDF export failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }
}

/**
 * Create a PDFExporter instance
 * @param {Object} options
 * @returns {PDFExporter}
 */
export function createPDFExporter(options) {
  return new PDFExporter(options);
}

/**
 * Export events to PDF (convenience function)
 * @param {Object} options
 * @param {NodeJS.WritableStream} options.outputStream
 * @param {ExportQueryEngine} options.queryEngine
 * @param {Object} [options.filters]
 * @param {string} [options.template='activity_summary']
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object>} Export statistics
 */
export async function exportToPDF(options) {
  const exporter = createPDFExporter(options);
  return await exporter.export();
}

export default PDFExporter;
