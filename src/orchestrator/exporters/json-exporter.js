import { createLogger } from '../../logger.js';

const log = createLogger('json-exporter');

/**
 * JSONExporter - Streaming JSON writer for audit events
 *
 * Writes JSON array with events streamed from an async generator.
 * Keeps memory footprint constant by processing events in batches
 * without buffering entire result set in memory.
 */
export class JSONExporter {
  /**
   * @param {Object} options
   * @param {NodeJS.WritableStream} options.outputStream - Writable stream for JSON output
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

    this.eventsWritten = 0;
    this.bytesWritten = 0;
  }

  /**
   * Write a chunk to the output stream, handling backpressure
   * @private
   * @returns {boolean} Whether the stream is ready for more data
   */
  _write(chunk) {
    const ready = this.outputStream.write(chunk);
    this.bytesWritten += Buffer.byteLength(chunk, 'utf8');
    return ready;
  }

  /**
   * Wait for the stream to drain if backpressure is applied
   * @private
   */
  async _waitForDrain() {
    await new Promise(resolve => this.outputStream.once('drain', resolve));
  }

  /**
   * Export events to JSON
   * @returns {Promise<Object>} Export statistics
   */
  async export() {
    const startTime = Date.now();

    try {
      // Write opening bracket
      this._write('[');

      // Stream events from query engine
      const eventStream = this.queryEngine.queryEventsStream(this.filters, {
        onProgress: this.onProgress,
      });

      let isFirst = true;

      for await (const batch of eventStream) {
        if (batch.length === 0) continue;

        // Write each event in the batch
        for (const event of batch) {
          // Add comma separator before all events except the first
          if (!isFirst) {
            this._write(',');
          } else {
            isFirst = false;
          }

          // Serialize individual event to JSON (compact format)
          const eventJson = JSON.stringify(event);
          const ready = this._write(eventJson);
          this.eventsWritten++;

          // Apply backpressure if stream buffer is full
          if (!ready) {
            await this._waitForDrain();
          }
        }

        // Progress update every batch
        if (this.onProgress && this.eventsWritten % 5000 === 0) {
          this.onProgress({
            phase: 'writing',
            eventsWritten: this.eventsWritten,
            bytesWritten: this.bytesWritten,
          });
        }
      }

      // Write closing bracket
      this._write(']');

      const duration = Date.now() - startTime;

      log.info('JSON export complete', {
        eventsWritten: this.eventsWritten,
        bytesWritten: this.bytesWritten,
        durationMs: duration,
      });

      return {
        format: 'json',
        eventsWritten: this.eventsWritten,
        bytesWritten: this.bytesWritten,
        durationMs: duration,
      };
    } catch (error) {
      log.error('JSON export failed', { error: error.message, stack: error.stack });
      throw error;
    }
  }
}

/**
 * Create a JSONExporter instance
 * @param {Object} options
 * @returns {JSONExporter}
 */
export function createJSONExporter(options) {
  return new JSONExporter(options);
}

/**
 * Export events to JSON (convenience function)
 * @param {Object} options
 * @param {NodeJS.WritableStream} options.outputStream
 * @param {ExportQueryEngine} options.queryEngine
 * @param {Object} [options.filters]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object>} Export statistics
 */
export async function exportToJSON(options) {
  const exporter = createJSONExporter(options);
  return await exporter.export();
}

export default JSONExporter;
