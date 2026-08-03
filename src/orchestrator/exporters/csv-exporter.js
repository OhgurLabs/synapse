import { Writable } from 'stream';
import { createLogger } from '../../logger.js';

const log = createLogger('csv-exporter');

/**
 * CSV field escape utility
 * Escapes double quotes and wraps field in quotes if needed
 */
function escapeCSVField(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  // Check if field needs quoting (contains comma, newline, or double quote)
  if (stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('"')) {
    // Escape double quotes by doubling them, then wrap in quotes
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Flatten event data for CSV export
 * Converts nested data object to dot-notation fields
 */
function flattenEventData(event) {
  const flattened = {};

  // Copy all top-level fields except 'data' and 'row'
  for (const [key, value] of Object.entries(event)) {
    if (key === 'data' || key === 'row') continue;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // For nested objects, serialize to JSON string
      flattened[key] = JSON.stringify(value);
    } else if (Array.isArray(value)) {
      // For arrays, serialize to JSON string
      flattened[key] = JSON.stringify(value);
    } else {
      flattened[key] = value;
    }
  }

  // Flatten data object with data_ prefix
  if (event.data && typeof event.data === 'object') {
    for (const [key, value] of Object.entries(event.data)) {
      const prefixedKey = `data_${key}`;
      if (typeof value === 'object' && value !== null) {
        flattened[prefixedKey] = JSON.stringify(value);
      } else {
        flattened[prefixedKey] = value;
      }
    }
  }

  return flattened;
}

/**
 * Determine CSV columns from a batch of events
 * Collects all unique field names across all events
 */
function determineColumns(events) {
  const columnSet = new Set();

  // Standard correlation fields (ensure these come first)
  const standardFields = [
    'id',
    'event_ts',
    'export_type',
    'campaign_id',
    'dispatch_id',
    'trace_id',
    'milestone_id',
    'task_id',
    'subtask_id',
    'agent_id',
    'provider',
    'created_at',
    'parent_correlation_id',
    'root_correlation_id',
  ];

  standardFields.forEach(field => columnSet.add(field));

  // Collect all other fields from events
  for (const event of events) {
    const flattened = flattenEventData(event);
    for (const key of Object.keys(flattened)) {
      columnSet.add(key);
    }
  }

  // Convert to array, keeping standard fields first
  const columns = [...standardFields];
  for (const col of columnSet) {
    if (!standardFields.includes(col)) {
      columns.push(col);
    }
  }

  return columns;
}

/**
 * CSVExporter - Streaming CSV writer for audit events
 *
 * Writes CSV data with header row followed by event rows streamed
 * from an async generator. Keeps memory footprint constant by
 * processing events in batches without buffering entire result set.
 */
export class CSVExporter {
  /**
   * @param {Object} options
   * @param {NodeJS.WritableStream} options.outputStream - Writable stream for CSV output
   * @param {ExportQueryEngine} options.queryEngine - Export query engine instance
   * @param {Object} [options.filters] - Query filters
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
    this.onProgress = options.onProgress;

    this.columns = null;
    this.headerWritten = false;
    this.rowsWritten = 0;
    this.bytesWritten = 0;
  }

  /**
   * Write a single CSV row to the output stream
   * @private
   */
  _writeRow(values) {
    const csvLine = values.map(v => escapeCSVField(v)).join(',') + '\n';
    const success = this.outputStream.write(csvLine);
    this.bytesWritten += Buffer.byteLength(csvLine, 'utf8');

    return success;
  }

  /**
   * Write CSV header row
   * @private
   */
  _writeHeader(columns) {
    if (this.headerWritten) return;

    this.columns = columns;
    this._writeRow(columns);
    this.headerWritten = true;

    log.debug('CSV header written', { columnCount: columns.length });
  }

  /**
   * Write event as CSV row
   * @private
   */
  _writeEvent(event) {
    if (!this.headerWritten) {
      throw new Error('Cannot write event before header');
    }

    const flattened = flattenEventData(event);
    const values = this.columns.map(col => flattened[col] ?? '');

    this._writeRow(values);
    this.rowsWritten++;
  }

  /**
   * Export events to CSV
   * @returns {Promise<Object>} Export statistics
   */
  async export() {
    const startTime = Date.now();

    try {
      // Stream events from query engine
      const eventStream = this.queryEngine.queryEventsStream(this.filters, {
        onProgress: this.onProgress,
      });

      let firstBatch = true;

      for await (const batch of eventStream) {
        if (batch.length === 0) continue;

        // Write header on first batch
        if (firstBatch) {
          const columns = determineColumns(batch);
          this._writeHeader(columns);
          firstBatch = false;
        }

        // Write each event in the batch
        for (const event of batch) {
          this._writeEvent(event);

          // Apply backpressure if needed
          if (!this.outputStream.write('')) {
            await new Promise(resolve => this.outputStream.once('drain', resolve));
          }
        }

        // Progress update every batch
        if (this.onProgress && this.rowsWritten % 5000 === 0) {
          this.onProgress({
            phase: 'writing',
            rowsWritten: this.rowsWritten,
            bytesWritten: this.bytesWritten,
          });
        }
      }

      // Handle case where no events were found
      if (!this.headerWritten) {
        // Write header with standard fields only
        const emptyColumns = [
          'id', 'event_ts', 'export_type', 'campaign_id', 'dispatch_id',
          'trace_id', 'milestone_id', 'task_id', 'subtask_id', 'agent_id',
          'provider', 'created_at', 'parent_correlation_id', 'root_correlation_id',
        ];
        this._writeHeader(emptyColumns);
      }

      const duration = Date.now() - startTime;

      log.info('CSV export complete', {
        rowsWritten: this.rowsWritten,
        bytesWritten: this.bytesWritten,
        durationMs: duration,
      });

      return {
        format: 'csv',
        rowsWritten: this.rowsWritten,
        bytesWritten: this.bytesWritten,
        durationMs: duration,
      };
    } catch (error) {
      log.error('CSV export failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }
}

/**
 * Create a CSVExporter instance
 * @param {Object} options
 * @returns {CSVExporter}
 */
export function createCSVExporter(options) {
  return new CSVExporter(options);
}

/**
 * Export events to CSV (convenience function)
 * @param {Object} options
 * @param {NodeJS.WritableStream} options.outputStream
 * @param {ExportQueryEngine} options.queryEngine
 * @param {Object} [options.filters]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object>} Export statistics
 */
export async function exportToCSV(options) {
  const exporter = createCSVExporter(options);
  return await exporter.export();
}

export default CSVExporter;
