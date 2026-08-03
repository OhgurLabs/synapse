/**
 * Streaming Result Handler
 * 
 * Handles streaming results for long-running tool operations.
 * Provides chunk collection, aggregation, progress tracking, and timeout handling
 * for tools that emit incremental results.
 * 
 * @module mcp-streaming-handler
 */

import { createLogger } from '../logger.js';
import { TimeoutError, ConnectionError } from './errors.js';
import {
  classifyResult,
  isSuccessResult,
  isErrorResult
} from './result-types.js';

const log = createLogger('streaming-handler');

/**
 * Stream state enumeration
 * @enum {string}
 */
export const StreamState = {
  IDLE: 'idle',
  STARTED: 'started',
  RECEIVING: 'receiving',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled'
};

/**
 * Progress update from streaming operation
 * @typedef {Object} ProgressUpdate
 * @property {number} percent - Completion percentage (0-100)
 * @property {string} [message] - Progress message
 * @property {number} [current] - Current item count
 * @property {number} [total] - Total item count
 * @property {number} timestamp - Update timestamp
 */

/**
 * Streaming chunk received from server
 * @typedef {Object} StreamingChunk
 * @property {Object} data - Chunk payload
 * @property {boolean} [final] - Whether this is the final chunk
 * @property {number} [chunkIndex] - Chunk index
 * @property {number} [totalChunks] - Expected total chunks
 * @property {string} [chunkId] - Unique chunk identifier
 * @property {ProgressUpdate} [progress] - Progress information
 */

/**
 * Stream configuration options
 * @typedef {Object} StreamOptions
 * @property {number} [timeoutMs] - Stream timeout in milliseconds
 * @property {number} [maxChunks] - Maximum chunks to collect
 * @property {number} [chunkTimeoutMs] - Timeout between chunks
 * @property {boolean} [autoAggregate] - Auto-aggregate on completion
 * @property {Function} [onChunk] - Callback for each chunk
 * @property {Function} [onProgress] - Callback for progress updates
 * @property {Function} [onComplete] - Callback for stream completion
 * @property {Function} [onError] - Callback for stream errors
 */

/**
 * Aggregated streaming result
 * @typedef {Object} AggregatedStreamingResult
 * @property {'success'|'error'|'partial'} status - Overall status
 * @property {Object} [result] - Aggregated result
 * @property {Array<StreamingChunk>} chunks - All chunks received
 * @property {StreamContext} context - Stream context
 * @property {string} [error] - Error message if failed
 * @property {Error} [errorObject] - Error object if failed
 */

/**
 * Stream context information
 * @typedef {Object} StreamContext
 * @property {string} toolName - Tool name
 * @property {string} serverId - Server ID
 * @property {string} streamId - Stream identifier
 * @property {StreamState} state - Current state
 * @property {number} startTimeMs - Start timestamp
 * @property {number} [endTimeMs] - End timestamp
 * @property {number} elapsedMs - Elapsed time
 * @property {number} chunkCount - Chunks received
 * @property {number} bytesReceived - Total bytes
 * @property {ProgressUpdate} [lastProgress] - Last progress update
 * @property {boolean} complete - Whether stream completed
 */

/**
 * StreamingHandler — Manages streaming results for long-running operations.
 * 
 * Responsibilities:
 * - Collect streaming chunks from tool invocations
 * - Track progress and emit progress updates
 * - Handle timeouts and partial results
 * - Aggregate chunks into final results
 * - Support pause/resume for long-running operations
 * - Manage chunk buffers and memory limits
 * - Handle stream errors gracefully
 */
export class StreamingHandler {
  /**
   * Create a StreamingHandler instance.
   * 
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.defaultTimeoutMs] - Default timeout for streams
   * @param {number} [options.defaultChunkTimeoutMs] - Default timeout between chunks
   * @param {number} [options.maxChunks] - Maximum chunks to collect
   * @param {number} [options.maxBufferSize] - Maximum buffer size in bytes
   */
  constructor(options = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs || 300000;
    this.defaultChunkTimeoutMs = options.defaultChunkTimeoutMs || 30000;
    this.maxChunks = options.maxChunks || 10000;
    this.maxBufferSize = options.maxBufferSize || 100 * 1024 * 1024;

    this._activeStreams = new Map();
    this._streamIdCounter = 0;
  }

  /**
   * Create a new stream for collecting chunks.
   * 
   * @param {string} toolName - Tool name
   * @param {string} serverId - Server ID
   * @param {StreamOptions} [options] - Stream options
   * @returns {Object} Stream controller with methods
   */
  createStream(toolName, serverId, options = {}) {
    const streamId = this._generateStreamId();
    const startTimeMs = Date.now();

    const stream = {
      streamId,
      toolName,
      serverId,
      state: StreamState.STARTED,
      startTimeMs,
      endTimeMs: null,
      chunks: [],
      bytesReceived: 0,
      chunkCount: 0,
      lastChunkTime: startTimeMs,
      lastProgress: null,
      complete: false,
      error: null,
      errorObject: null,
      timeoutMs: options.timeoutMs || this.defaultTimeoutMs,
      chunkTimeoutMs: options.chunkTimeoutMs || this.defaultChunkTimeoutMs,
      maxChunks: options.maxChunks || this.maxChunks,
      maxBufferSize: options.maxBufferSize || this.maxBufferSize,
      onChunk: options.onChunk || null,
      onProgress: options.onProgress || null,
      onComplete: options.onComplete || null,
      onError: options.onError || null,
      abortController: new AbortController()
    };

    this._activeStreams.set(streamId, stream);
    log.debug({ streamId, toolName, serverId }, 'Created streaming handler');

    return this._createStreamController(stream, options);
  }

  /**
   * Add a chunk to the stream.
   * 
   * @param {string} streamId - Stream identifier
   * @param {StreamingChunk} chunk - Chunk to add
   * @returns {Object} Current stream state
   */
  addChunk(streamId, chunk) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    if (stream.state !== StreamState.RECEIVING && stream.state !== StreamState.STARTED) {
      log.warn({ streamId, state: stream.state }, 'Cannot add chunk to non-receiving stream');
      return this._getStreamContext(stream);
    }

    if (stream.chunkCount >= stream.maxChunks) {
      log.warn({ streamId, maxChunks: stream.maxChunks }, 'Buffer overflow: Max chunks exceeded');
      this.fail(streamId, `Buffer overflow: Exceeded maximum chunk count of ${stream.maxChunks}`);
      return this._getStreamContext(stream);
    }

    let addedBytes = 0;
    try {
      addedBytes = JSON.stringify(chunk.data || {}).length;
    } catch {
      // Ignore serialization errors for byte counting
    }

    if (stream.bytesReceived + addedBytes > stream.maxBufferSize) {
      log.warn({ streamId, maxBufferSize: stream.maxBufferSize }, 'Buffer overflow: Max buffer size exceeded');
      this.fail(streamId, `Buffer overflow: Exceeded maximum buffer size of ${stream.maxBufferSize} bytes`);
      return this._getStreamContext(stream);
    }

    stream.state = StreamState.RECEIVING;
    stream.lastChunkTime = Date.now();

    const chunkIndex = stream.chunks.length;
    const processedChunk = {
      ...chunk,
      chunkIndex: chunk.chunkIndex ?? chunkIndex,
      receivedAt: Date.now()
    };

    stream.chunks.push(processedChunk);
    stream.chunkCount++;
    stream.bytesReceived += addedBytes;

    if (chunk.progress) {
      stream.lastProgress = {
        ...chunk.progress,
        timestamp: Date.now()
      };
    }

    if (stream.onChunk) {
      try {
        stream.onChunk(processedChunk, this._getStreamContext(stream));
      } catch (err) {
        log.error({ streamId, err }, 'onChunk callback error');
      }
    }

    if (chunk.progress && stream.onProgress) {
      try {
        stream.onProgress(stream.lastProgress, this._getStreamContext(stream));
      } catch (err) {
        log.error({ streamId, err }, 'onProgress callback error');
      }
    }

    if (chunk.final) {
      this._completeStream(stream);
    }

    return this._getStreamContext(stream);
  }

  /**
   * Complete the stream successfully.
   * 
   * @param {string} streamId - Stream identifier
   * @param {Object} [finalData] - Optional final data
   * @returns {AggregatedStreamingResult} Aggregated result
   */
  complete(streamId, finalData) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    if (finalData) {
      this.addChunk(streamId, {
        data: finalData,
        final: true
      });
    } else {
      this._completeStream(stream);
    }

    return this._aggregateStream(stream);
  }

  /**
   * Fail the stream with an error.
   * 
   * @param {string} streamId - Stream identifier
   * @param {string} errorMessage - Error message
   * @param {Error} [errorObject] - Optional error object
   * @returns {AggregatedStreamingResult} Failed result
   */
  fail(streamId, errorMessage, errorObject) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    stream.state = StreamState.FAILED;
    stream.endTimeMs = Date.now();
    stream.error = errorMessage;
    stream.errorObject = errorObject || new Error(errorMessage);

    if (stream.onError) {
      try {
        stream.onError(stream.error, stream.errorObject, this._getStreamContext(stream));
      } catch (err) {
        log.error({ streamId, err }, 'onError callback error');
      }
    }

    // Don't auto-cleanup failed streams - allow context access after failure
    return this._aggregateStream(stream);
  }

  /**
   * Timeout the stream.
   * 
   * @param {string} streamId - Stream identifier
   * @param {number} timeoutMs - Timeout that was exceeded
   * @returns {AggregatedStreamingResult} Partial result with timeout info
   */
  timeout(streamId, timeoutMs) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    stream.state = StreamState.TIMED_OUT;
    stream.endTimeMs = Date.now();
    stream.error = `Stream timed out after ${timeoutMs}ms`;
    stream.errorObject = new TimeoutError(stream.error, { timeoutMs });

    if (stream.onError) {
      try {
        stream.onError(stream.error, stream.errorObject, this._getStreamContext(stream));
      } catch (err) {
        log.error({ streamId, err }, 'onError callback error');
      }
    }

    // Don't auto-cleanup timed out streams - allow context access
    return this._aggregateStream(stream);
  }

  /**
   * Cancel the stream.
   * 
   * @param {string} streamId - Stream identifier
   * @param {string} [reason] - Cancellation reason
   * @returns {AggregatedStreamingResult} Cancelled result
   */
  cancel(streamId, reason = 'Stream cancelled by user') {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    stream.state = StreamState.CANCELLED;
    stream.endTimeMs = Date.now();
    stream.error = reason;

    if (stream.abortController) {
      stream.abortController.abort();
    }

    // Call onError callback if registered
    if (stream.onError) {
      try {
        stream.onError(stream.error, null, this._getStreamContext(stream));
      } catch (err) {
        log.error({ streamId, err }, 'onError callback error');
      }
    }

    // Don't auto-cleanup cancelled streams - allow context access
    return this._aggregateStream(stream);
  }

  /**
   * Pause the stream.
   * 
   * @param {string} streamId - Stream identifier
   * @returns {Object} Stream context at pause time
   */
  pause(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    stream.state = StreamState.PAUSED;
    log.debug({ streamId }, 'Stream paused');
    return this._getStreamContext(stream);
  }

  /**
   * Resume a paused stream.
   * 
   * @param {string} streamId - Stream identifier
   * @returns {Object} Stream context after resume
   */
  resume(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    if (stream.state !== StreamState.PAUSED) {
      log.warn({ streamId, state: stream.state }, 'Cannot resume non-paused stream');
      return this._getStreamContext(stream);
    }

    stream.state = StreamState.RECEIVING;
    stream.lastChunkTime = Date.now();
    log.debug({ streamId }, 'Stream resumed');
    return this._getStreamContext(stream);
  }

  /**
   * Get the current context for a stream.
   * 
   * @param {string} streamId - Stream identifier
   * @returns {StreamContext} Stream context
   */
  getContext(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    return this._getStreamContext(stream);
  }

  /**
   * Get all chunks for a stream.
   * 
   * @param {string} streamId - Stream identifier
   * @returns {Array<StreamingChunk>} Chunks
   */
  getChunks(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    return [...stream.chunks];
  }

  /**
   * Aggregate stream chunks into a result.
   * 
   * @param {string} streamId - Stream identifier
   * @returns {AggregatedStreamingResult} Aggregated result
   */
  aggregate(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      log.error({ streamId }, 'Stream not found');
      throw new Error(`Stream not found: ${streamId}`);
    }

    return this._aggregateStream(stream);
  }

  /**
   * Check if a stream has timed out.
   * 
   * @param {string} streamId - Stream identifier
   * @returns {boolean} Whether stream has timed out
   */
  checkTimeout(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (!stream) {
      return false;
    }

    const elapsedMs = Date.now() - stream.startTimeMs;
    if (elapsedMs > stream.timeoutMs) {
      return true;
    }

    const chunkElapsedMs = Date.now() - stream.lastChunkTime;
    if (chunkElapsedMs > stream.chunkTimeoutMs && stream.chunks.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Clean up a completed or failed stream.
   * 
   * @param {string} streamId - Stream identifier
   */
  cleanup(streamId) {
    this._cleanupStream(streamId);
  }

  /**
   * Clean up all streams for a server.
   * 
   * @param {string} serverId - Server ID
   * @returns {number} Number of streams cleaned up
   */
  cleanupByServer(serverId) {
    let count = 0;
    for (const [streamId, stream] of this._activeStreams.entries()) {
      if (stream.serverId === serverId) {
        if (stream.state === StreamState.RECEIVING || stream.state === StreamState.PAUSED) {
          this.cancel(streamId, `Server ${serverId} disconnected`);
        }
        this._cleanupStream(streamId);
        count++;
      }
    }
    log.debug({ serverId, count }, 'Cleaned up streams by server');
    return count;
  }

  /**
   * Clean up all active streams.
   * 
   * @returns {number} Number of streams cleaned up
   */
  cleanupAll() {
    const count = this._activeStreams.size;
    for (const streamId of this._activeStreams.keys()) {
      this._cleanupStream(streamId);
    }
    log.debug({ count }, 'Cleaned up all streams');
    return count;
  }

  /**
   * Get active stream count.
   * 
   * @returns {number} Number of active streams
   */
  getActiveStreamCount() {
    return this._activeStreams.size;
  }

  /**
   * Generate a unique stream ID.
   * 
   * @private
   * @returns {string} Stream ID
   */
  _generateStreamId() {
    this._streamIdCounter++;
    return `stream_${Date.now()}_${this._streamIdCounter}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Complete a stream internally.
   * 
   * @private
   * @param {Object} stream - Stream object
   */
  _completeStream(stream) {
    stream.state = StreamState.COMPLETED;
    stream.endTimeMs = Date.now();
    stream.complete = true;

    if (stream.onComplete) {
      try {
        stream.onComplete(this._aggregateStream(stream));
      } catch (err) {
        log.error({ streamId: stream.streamId, err }, 'onComplete callback error');
      }
    }

    // Don't auto-cleanup completed streams - allow context access after completion
    // Caller can call cleanup() explicitly when done
  }

  /**
   * Clean up a stream internally.
   * 
   * @private
   * @param {string} streamId - Stream identifier
   */
  _cleanupStream(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (stream) {
      if (stream.abortController) {
        stream.abortController.abort();
      }
      this._activeStreams.delete(streamId);
      log.debug({ streamId, state: stream.state }, 'Stream cleaned up');
    }
  }

  /**
   * Get stream context object.
   * 
   * @private
   * @param {Object} stream - Stream object
   * @returns {StreamContext} Context object
   */
  _getStreamContext(stream) {
    const elapsedMs = stream.endTimeMs 
      ? stream.endTimeMs - stream.startTimeMs 
      : Date.now() - stream.startTimeMs;

    return {
      toolName: stream.toolName,
      serverId: stream.serverId,
      source: 'mcp',
      serverSource: stream.serverId,
      streamId: stream.streamId,
      state: stream.state,
      startTimeMs: stream.startTimeMs,
      endTimeMs: stream.endTimeMs,
      elapsedMs,
      chunkCount: stream.chunkCount,
      bytesReceived: stream.bytesReceived,
      lastProgress: stream.lastProgress,
      complete: stream.complete,
      error: stream.error
    };
  }

  /**
   * Aggregate stream into final result.
   * 
   * @private
   * @param {Object} stream - Stream object
   * @returns {AggregatedStreamingResult} Aggregated result
   */
  _aggregateStream(stream) {
    const elapsedMs = stream.endTimeMs 
      ? stream.endTimeMs - stream.startTimeMs 
      : Date.now() - stream.startTimeMs;

    if (stream.state === StreamState.FAILED || stream.state === StreamState.TIMED_OUT) {
      return {
        status: stream.state === StreamState.TIMED_OUT && stream.chunks.length > 0 ? 'partial' : 'error',
        chunks: stream.chunks,
        context: {
          ...this._getStreamContext(stream),
          timeoutMs: stream.timeoutMs
        },
        error: stream.error,
        errorObject: stream.errorObject
      };
    }

    if (stream.state === StreamState.CANCELLED) {
      return {
        status: stream.chunks.length > 0 ? 'partial' : 'error',
        chunks: stream.chunks,
        context: {
          ...this._getStreamContext(stream),
          cancelled: true
        },
        error: stream.error
      };
    }

    const aggregatedData = this._aggregateChunkData(stream.chunks);

    return {
      status: 'success',
      result: aggregatedData,
      chunks: stream.chunks,
      context: this._getStreamContext(stream)
    };
  }

  /**
   * Aggregate chunk data into a single result.
   * 
   * @private
   * @param {Array<StreamingChunk>} chunks - Chunks to aggregate
   * @returns {Object} Aggregated data
   */
  _aggregateChunkData(chunks) {
    if (chunks.length === 0) {
      return { content: [] };
    }

    const hasContent = chunks.some(c => c.data?.content && Array.isArray(c.data.content));

    if (hasContent) {
      const content = chunks.flatMap(c => c.data?.content || []);
      return { content, isError: false };
    }

    const lastChunk = chunks[chunks.length - 1];
    return lastChunk.data || {};
  }

  /**
   * Create stream controller object.
   * 
   * @private
   * @param {Object} stream - Stream object
   * @param {StreamOptions} options - Stream options
   * @returns {Object} Controller with stream methods
   */
  _createStreamController(stream, options) {
    const controller = {
      streamId: stream.streamId,
      addChunk: (chunk) => this.addChunk(stream.streamId, chunk),
      complete: (finalData) => this.complete(stream.streamId, finalData),
      fail: (message, error) => this.fail(stream.streamId, message, error),
      timeout: (timeoutMs) => this.timeout(stream.streamId, timeoutMs),
      cancel: (reason) => this.cancel(stream.streamId, reason),
      pause: () => this.pause(stream.streamId),
      resume: () => this.resume(stream.streamId),
      getContext: () => this.getContext(stream.streamId),
      getChunks: () => this.getChunks(stream.streamId),
      aggregate: () => this.aggregate(stream.streamId),
      checkTimeout: () => this.checkTimeout(stream.streamId),
      cleanup: () => this.cleanup(stream.streamId),
      abort: () => {
        if (stream.abortController) {
          stream.abortController.abort();
        }
      },
      get aborted() {
        return stream.abortController?.signal.aborted || false
      }
    };

    // autoAggregate is always true - aggregate() always returns current state

    return controller;
  }
}

// Export singleton instance for convenience
export const streamingHandler = new StreamingHandler();
