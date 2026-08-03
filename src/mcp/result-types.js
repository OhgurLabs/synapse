/**
 * MCP Result Type Definitions
 * 
 * Comprehensive type definitions for all MCP (Model Context Protocol) response formats.
 * Provides type safety and documentation for tool invocation results, error responses,
 * streaming results, and partial results.
 * 
 * @module mcp-result-types
 */

/**
 * JSON-RPC 2.0 base response structure
 * @typedef {Object} JSONRPCResponse
 * @property {string} jsonrpc - JSON-RPC version (must be "2.0")
 * @property {number|string} id - Request ID
 */

/**
 * JSON-RPC 2.0 success response
 * @typedef {JSONRPCResponse} JSONRPCSuccessResponse
 * @property {*} result - Response result (type varies by method)
 */

/**
 * JSON-RPC 2.0 error response
 * @typedef {JSONRPCResponse} JSONRPCErrorResponse
 * @property {JSONRPCError} error - Error object
 */

/**
 * JSON-RPC 2.0 error object
 * @typedef {Object} JSONRPCError
 * @property {number} code - Error code (negative for protocol errors, positive for application errors)
 * @property {string} message - Error message
 * @property {*} [data] - Additional error data
 */

/**
 * JSON-RPC 2.0 standard error codes
 * @enum {number}
 */
export const JSONRPCErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
};

/**
 * MCP-specific error codes
 * @enum {number}
 */
export const MCPErrorCodes = {
  TOOL_NOT_FOUND: -32001,
  TOOL_EXECUTION_FAILED: -32002,
  SERVER_ERROR: -32003,
  TIMEOUT: -32004,
  RATE_LIMITED: -32005,
  AUTHENTICATION_FAILED: -32006,
  PERMISSION_DENIED: -32007,
  RESOURCE_NOT_FOUND: -32008,
  INVALID_TOOL_ARGUMENTS: -32009
};

/**
 * Initialize response from MCP server
 * @typedef {Object} InitializeResult
 * @property {string} protocolVersion - MCP protocol version
 * @property {ServerInfo} serverInfo - Server information
 * @property {ServerCapabilities} capabilities - Server capabilities
 * @property {string} [instructions] - Optional server instructions
 */

/**
 * Server information
 * @typedef {Object} ServerInfo
 * @property {string} name - Server name
 * @property {string} version - Server version
 */

/**
 * Server capabilities
 * @typedef {Object} ServerCapabilities
 * @property {Object} [tools] - Tool capabilities
 * @property {boolean} [tools.listChanged] - Whether tools list can change dynamically
 * @property {boolean} [tools.streaming] - Whether server supports streaming tool results
 * @property {Object} [resources] - Resource capabilities
 * @property {boolean} [resources.subscribe] - Whether server supports resource subscriptions
 * @property {boolean} [resources.listChanged] - Whether resources list can change dynamically
 * @property {Object} [prompts] - Prompt capabilities
 * @property {boolean} [prompts.listChanged] - Whether prompts list can change dynamically
 * @property {Object} [logging] - Logging capabilities
 */

/**
 * Tools/list response from MCP server
 * @typedef {Object} ToolsListResult
 * @property {Array<MCPToolDefinition>} tools - Array of tool definitions
 * @property {string} [nextCursor] - Cursor for pagination (if supported)
 */

/**
 * MCP tool definition from server
 * @typedef {Object} MCPToolDefinition
 * @property {string} name - Tool name
 * @property {string} [description] - Human-readable description
 * @property {JSONSchema} inputSchema - JSON Schema for tool inputs
 * @property {JSONSchema} [outputSchema] - JSON Schema for tool outputs (optional)
 * @property {ToolAnnotations} [annotations] - Tool annotations (capabilities, etc.)
 */

/**
 * JSON Schema definition
 * @typedef {Object} JSONSchema
 * @property {string} type - Schema type (object, array, string, number, etc.)
 * @property {Object} [properties] - Object properties (for type: 'object')
 * @property {Array<string>} [required] - Required property names
 * @property {Object} [items] - Array item schema (for type: 'array')
 * @property {string} [description] - Schema description
 * @property {*} [default] - Default value
 * @property {Array<*>} [enum] - Enum values
 * @property {string} [format] - Format specifier
 * @property {number} [minimum] - Minimum value for numbers
 * @property {number} [maximum] - Maximum value for numbers
 * @property {number} [minLength] - Minimum string length
 * @property {number} [maxLength] - Maximum string length
 * @property {string} [pattern] - Regex pattern for strings
 * @property {number} [minItems] - Minimum array items
 * @property {number} [maxItems] - Maximum array items
 * @property {boolean} [uniqueItems] - Unique array items flag
 */

/**
 * Tool annotations
 * @typedef {Object} ToolAnnotations
 * @property {boolean} [destructive] - Whether tool is destructive (modifies state)
 * @property {boolean} [idempotent] - Whether tool is idempotent
 * @property {boolean} [openWorld] - Whether tool requires open-world assumption
 * @property {Array<string>} [tags] - Tool tags for categorization
 * @property {string} [title] - Human-readable title
 * @property {string} [readOnlyHint] - Read-only hint for UI
 * @property {string} [priority] - Execution priority
 */

/**
 * Tool result content type
 * @typedef {'text'|'image'|'resource'|'audio'|'video'} ContentItemType
 */

/**
 * Base content item structure
 * @typedef {Object} BaseContentItem
 * @property {ContentItemType} type - Content item type
 */

/**
 * Text content item
 * @typedef {BaseContentItem} TextContentItem
 * @property {'text'} type - Content type
 * @property {string} text - Text content
 * @property {string} [mimeType] - MIME type (e.g., 'text/plain', 'text/markdown')
 */

/**
 * Image content item
 * @typedef {BaseContentItem} ImageContentItem
 * @property {'image'} type - Content type
 * @property {string} data - Base64-encoded image data
 * @property {string} mimeType - MIME type (e.g., 'image/png', 'image/jpeg')
 */

/**
 * Resource content item
 * @typedef {BaseContentItem} ResourceContentItem
 * @property {'resource'} type - Content type
 * @property {string} uri - Resource URI
 * @property {Object} [metadata] - Resource metadata
 */

/**
 * Audio content item
 * @typedef {BaseContentItem} AudioContentItem
 * @property {'audio'} type - Content type
 * @property {string} data - Base64-encoded audio data
 * @property {string} mimeType - MIME type (e.g., 'audio/mp3', 'audio/wav')
 */

/**
 * Video content item
 * @typedef {BaseContentItem} VideoContentItem
 * @property {'video'} type - Content type
 * @property {string} data - Base64-encoded video data
 * @property {string} mimeType - MIME type (e.g., 'video/mp4', 'video/webm')
 */

/**
 * Any content item
 * @typedef {TextContentItem|ImageContentItem|ResourceContentItem|AudioContentItem|VideoContentItem} ContentItem
 */

/**
 * Tools/call success response
 * @typedef {Object} ToolCallResult
 * @property {Array<ContentItem>} content - Array of content items
 * @property {boolean} [isError] - Whether result represents an error
 * @property {Object} [meta] - Additional metadata
 * @property {string} [_meta] - Internal metadata
 * @property {Object} [data] - Additional data (non-standard)
 */

/**
 * Tools/call response (union of success and error)
 * @typedef {ToolCallResult|JSONRPCError} ToolCallResponse
 */

/**
 * Processed tool invocation result from ToolInvocationEngine
 * @typedef {Object} ProcessedToolResult
 * @property {'ok'|'error'} status - Result status
 * @property {*} [result] - Result payload (for status: 'ok')
 * @property {string} [code] - Error code (for status: 'error')
 * @property {string} [message] - Error message (for status: 'error')
 * @property {Array<ValidationError>} [details] - Validation error details (for status: 'error', code: 'VALIDATION_FAILED')
 * @property {ErrorInfo} [error] - Error information (for status: 'error', code: 'INVOCATION_FAILED')
 * @property {string} [source] - Result source (e.g., 'mcp')
 * @property {string} [serverSource] - Server source name
 */

/**
 * Validation error detail
 * @typedef {Object} ValidationError
 * @property {string} field - Field path that failed validation
 * @property {string} constraint - Constraint that failed (required, type, format, etc.)
 * @property {string} message - Human-readable error message
 * @property {*} [actual] - Actual value
 * @property {*} [expected] - Expected value (if applicable)
 */

/**
 * Error information wrapper
 * @typedef {Object} ErrorInfo
 * @property {string} type - Error type/class name
 * @property {string} message - Error message
 * @property {string} [stack] - Error stack trace
 * @property {*} [originalError] - Original error object
 */

/**
 * Streaming result chunk
 * 
 * Represents a single chunk of data from a streaming tool invocation.
 * Chunks are delivered incrementally via the `onChunk` callback during
 * streaming invocations, allowing real-time processing without waiting
 * for the full response.
 * 
 * @typedef {Object} StreamingChunk
 * @property {ContentItem|ToolCallResult} data - Chunk payload (text, image, or tool result)
 * @property {boolean} [final] - Whether this is the final chunk in the stream
 * @property {number} [chunkIndex] - Zero-based index of this chunk in the stream
 * @property {number} [totalChunks] - Total expected chunks (if known by server)
 * @property {string} [chunkId] - Unique chunk identifier for deduplication/tracking
 * @property {boolean} [failed] - Whether chunk processing failed
 * @property {boolean} [validationFailed] - Whether chunk failed schema validation
 * @property {ErrorInfo} [error] - Error details if chunk failed
 * @property {Object} [progress] - Progress information from server
 * 
 * @example
 * // Handling chunks in real-time
 * await engine.invokeWithStreaming('streamData', {}, {
 *   onChunk: (chunk) => {
 *     // Process each chunk immediately as it arrives
 *     if (chunk.data.type === 'text') {
 *       console.log('Chunk content:', chunk.data.text);
 *     }
 *     
 *     if (chunk.final) {
 *       console.log('Stream complete');
 *     }
 *   }
 * });
 */

/**
 * Streaming result context
 * 
 * Contextual information about a streaming invocation, passed to callbacks
 * and included in the final aggregated result. Provides metadata about
 * the streaming session including timing, chunk counts, and server info.
 * 
 * @typedef {Object} StreamingContext
 * @property {string} toolName - Tool name being invoked
 * @property {string} serverId - MCP server identifier
 * @property {string} [source] - Result source (typically 'mcp')
 * @property {string} [serverSource] - Server source name
 * @property {number} elapsedMs - Elapsed time in milliseconds since invocation start
 * @property {number} chunkCount - Number of chunks received so far
 * @property {number} [bytesReceived] - Total bytes received across all chunks
 * @property {boolean} [complete] - Whether streaming has completed (final chunk received)
 * @property {string} [streamId] - Unique stream identifier for tracking/correlation
 * @property {number} [startTimeMs] - Start timestamp in milliseconds
 * @property {number} [endTimeMs] - End timestamp in milliseconds (if complete)
 * @property {number} [timeoutMs] - Configured timeout for this invocation
 * 
 * @example
 * // Context passed to onChunk callback
 * await engine.invokeWithStreaming('tool', {}, {
 *   onChunk: (chunk, context) => {
 *     console.log(`Chunk ${chunk.chunkIndex}/${context.chunkCount} received`);
 *     console.log(`Elapsed: ${context.elapsedMs}ms`);
 *     console.log(`Stream ID: ${context.streamId}`);
 *   }
 * });
 */

/**
 * Aggregated streaming result
 * 
 * The return value from `invokeWithStreaming()` after all chunks have been
 * received or the invocation has timed out. This is the aggregated/final
 * result, distinct from the `onChunk` callbacks which fire for each individual
 * chunk during the stream.
 * 
 * Key differences between return value and onChunk:
 * - **onChunk callbacks**: Fire immediately for each chunk (real-time/streaming)
 * - **Return value**: Delivered after ALL chunks received or timeout (aggregated)
 * 
 * Use onChunk for: Progress bars, live updates, incremental processing
 * Use return value for: Final processing, persistence, validation, cleanup
 * 
 * @typedef {Object} AggregatedStreamingResult
 * @property {'success'|'error'|'partial'} status - Overall status
 * @property {ToolCallResult} [result] - Final aggregated result (concatenated/merged chunks)
 * @property {Array<StreamingChunk>} chunks - All individual chunks received in order
 * @property {StreamingContext} context - Streaming context with metadata
 * @property {Object} [validation] - Schema validation result for aggregated output
 * @property {number} [failedChunksCount] - Number of chunks that failed processing
 * @property {number} [validationFailedChunksCount] - Chunks that failed validation but preserved
 * @property {string} [code] - Error code (for status: 'error')
 * @property {string} [error] - Error message (for status: 'error')
 * @property {Array<string>} [warnings] - Warnings about partial failures or data loss
 * 
 * @example
 * // Return value vs onChunk demonstration
 * const result = await engine.invokeWithStreaming('generateText', {}, {
 *   onChunk: (chunk) => {
 *     // Fires 10 times for 10 chunks (immediate/real-time)
 *     displayChunk(chunk.data);
 *   }
 * });
 * 
 * // Fires once after all chunks received (aggregated/final)
 * console.log('Total chunks:', result.chunks.length); // 10
 * console.log('Aggregated result:', result.result); // Combined text
 * console.log('Failed chunks:', result.failedChunksCount); // 0
 */

/**
 * Partial result (for interrupted or incomplete invocations)
 * 
 * Partial results are returned when:
 * - Stream times out mid-transfer (timeoutMs exceeded)
 * - Connection interrupted but some chunks received
 * - Tool signals cancellation but has produced some output
 * - Circuit breaker opens during streaming
 * 
 * Unlike errors, partial results contain usable data from chunks received
 * before the interruption. The `data` field contains aggregated chunks
 * received so far, and `context.chunks` contains individual chunk data.
 * 
 * @typedef {Object} PartialResult
 * @property {ToolCallResult|StreamingChunk} data - Partial/aggregated data from chunks received
 * @property {boolean} [isComplete] - Always false for partial results
 * @property {number} [completionPercent] - Estimated completion percentage (0-100)
 * @property {string} [state] - Current state ('partial', 'interrupted', 'timeout')
 * @property {ErrorInfo} [error] - Error that caused interruption (if applicable)
 * @property {string} [reason] - Reason for partial result ('timeout', 'cancelled', 'interrupted')
 * @property {Array<StreamingChunk>} [chunks] - Individual chunks received before interruption
 * @property {StreamingContext} [context] - Streaming context with metadata
 * 
 * @example
 * // Partial result from timeout
 * const result = await engine.invokeWithStreaming('slowTool', {}, { timeoutMs: 5000 });
 * if (result.status === 'partial') {
 *   console.log('Got partial data:', result.chunks.length, 'chunks');
 *   // Process whatever data was received before timeout
 *   result.chunks.forEach(chunk => process(chunk.data));
 * }
 */

/**
 * Result processing options
 * @typedef {Object} ResultProcessingOptions
 * @property {boolean} [validateSchema] - Whether to validate against outputSchema
 * @property {boolean} [allowPartial] - Whether to accept partial results
 * @property {boolean} [enableStreaming] - Whether to enable streaming processing
 * @property {Function} [onChunk] - Callback for streaming chunks
 * @property {Function} [onProgress] - Callback for progress updates
 * @property {number} [maxChunks] - Maximum chunks to collect (for streaming)
 * @property {number} [timeoutMs] - Processing timeout in milliseconds
 */

/**
 * @example <caption>Complete streaming invocation example</caption>
 * import { ToolInvocationEngine } from './tool-invocation-engine.js';
 * 
 * // Setup
 * const engine = new ToolInvocationEngine(toolRegistry, connectionManager);
 * 
 * // Invoke streaming tool with callbacks
 * const result = await engine.invokeWithStreaming(
 *   'readLargeFile',
 *   { path: '/data/large-dataset.csv', lines: 1000000 },
 *   {
 *     timeoutMs: 60000,           // 60s overall timeout
 *     chunkTimeoutMs: 5000,       // 5s per-chunk timeout
 *     onChunk: (chunk, context) => {
 *       // Real-time processing of each chunk
 *       console.log(`Chunk ${chunk.chunkIndex}:`, chunk.data.text?.substring(0, 100));
 *       
 *       // Update progress bar
 *       const progress = (context.chunkCount / expectedChunks) * 100;
 *       updateProgressBar(progress);
 *       
 *       // Handle final chunk
 *       if (chunk.final) {
 *         console.log('Stream completed');
 *       }
 *     },
 *     onProgress: (progress) => {
 *       // Progress updates from server
 *       console.log(`Server progress: ${progress.progress}%`);
 *     },
 *     onError: (err, partialResult) => {
 *       // Handle streaming errors
 *       console.error('Streaming error:', err);
 *       if (partialResult?.chunks) {
 *         // Save partial data before failure
 *         savePartialData(partialResult.chunks);
 *       }
 *     }
 *   }
 * );
 * 
 * // Post-processing after all chunks received
 * if (result.status === 'success') {
 *   // Full result available
 *   const totalBytes = result.context.bytesReceived;
 *   const chunkCount = result.chunks.length;
 *   console.log(`Completed: ${chunkCount} chunks, ${totalBytes} bytes`);
 *   
 *   // Access individual chunks if needed
 *   result.chunks.forEach((chunk, idx) => {
 *     console.log(`Chunk ${idx}:`, chunk.data);
 *   });
 * } else if (result.status === 'partial') {
 *   // Timeout or interruption - process what we got
 *   console.log('Partial result with', result.chunks.length, 'chunks');
 *   result.chunks.forEach(chunk => process(chunk.data));
 * } else {
 *   // Error occurred
 *   console.error('Invocation failed:', result.message);
 * }

/**
 * Processed result with metadata
 * @typedef {Object} ProcessedResult
 * @property {ProcessedToolResult|AggregatedStreamingResult|PartialResult} result - The processed result
 * @property {ResultMetadata} metadata - Processing metadata
 */

/**
 * Result metadata
 * @typedef {Object} ResultMetadata
 * @property {string} toolName - Tool name
 * @property {string} serverId - MCP server identifier
 * @property {string} [toolId] - Tool ID from registry
 * @property {number} startTimeMs - Start timestamp in milliseconds
 * @property {number} endTimeMs - End timestamp in milliseconds
 * @property {number} durationMs - Duration in milliseconds
 * @property {string} processingStatus - Processing status
 * @property {boolean} [wasCached] - Whether result was from cache
 * @property {boolean} [wasRetried] - Whether invocation was retried
 * @property {number} [retryCount] - Number of retries performed
 * @property {string} [responseId] - Unique response identifier
 * @property {string} [requestId] - Original request ID
 * @property {string} [source] - Result source (e.g., 'mcp')
 * @property {string} [serverSource] - Server source name
 */

/**
 * Result validation status
 * @typedef {'valid'|'invalid'|'partial'|'unknown'} ValidationStatus
 */

/**
 * Result validation outcome
 * @typedef {Object} ResultValidationOutcome
 * @property {ValidationStatus} status - Validation status
 * @property {Array<ValidationError>} [errors] - Validation errors
 * @property {Array<string>} [warnings] - Validation warnings
 * @property {boolean} [canProceed] - Whether processing can proceed despite issues
 * @property {string} [recommendation] - Recommendation for handling the result
 */

/**
 * Tool capability flags
 * @typedef {Object} ToolCapabilities
 * @property {boolean} [read] - Tool reads data
 * @property {boolean} [write] - Tool writes data
 * @property {boolean} [search] - Tool performs search
 * @property {boolean} [streaming] - Tool supports streaming results
 * @property {boolean} [idempotent] - Tool is idempotent
 * @property {boolean} [destructive] - Tool is destructive
 */

/**
 * Streaming invocation options
 * @typedef {Object} StreamingInvocationOptions
 * @property {number} [timeoutMs] - Overall invocation timeout in milliseconds
 * @property {number} [chunkTimeoutMs] - Per-chunk timeout in milliseconds
 * @property {Function} [onChunk] - Callback invoked for each streaming chunk
 * @property {Function} [onChunk(StreamingChunk, StreamingContext)] - Chunk callback signature
 * @property {Function} [onProgress] - Callback for progress updates
 * @property {Function} [onProgress(ProgressUpdate)] - Progress callback signature
 * @property {Function} [onComplete] - Callback when streaming completes
 * @property {Function} [onComplete(AggregatedStreamingResult)] - Complete callback signature
 * @property {Function} [onError] - Callback for streaming errors
 * @property {Function} [onError(Error, PartialResult)] - Error callback signature
 * @property {number} [maxChunks] - Maximum chunks to collect (0 = unlimited)
 */

/**
 * Progress update from streaming tool
 * @typedef {Object} ProgressUpdate
 * @property {string} toolName - Tool name being invoked
 * @property {number} progress - Progress value (0-100 or partial)
 * @property {string} [message] - Progress message
 * @property {number} [elapsedMs] - Elapsed time in milliseconds
 * @property {number} [chunkCount] - Number of chunks received so far
 * @property {number} [bytesReceived] - Total bytes received
 */

/**
 * Streaming result (return value from invokeWithStreaming)
 * @typedef {Object} StreamingResult
 * @property {string} status - Result status ('success', 'error', 'partial')
 * @property {ToolCallResult} [result] - Final aggregated result (for status: 'success')
 * @property {Array<StreamingChunk>} chunks - All chunks received during streaming
 * @property {StreamingContext} context - Streaming context with metadata
 * @property {Object} [validation] - Validation result for aggregated output
 * @property {number} [failedChunksCount] - Number of chunks that failed processing
 * @property {string} [code] - Error code (for status: 'error')
 * @property {string} [message] - Error message (for status: 'error')
 * @property {string} [source] - Result source ('mcp')
 * @property {string} [serverSource] - MCP server identifier
 * @property {string} [streamId] - Unique stream identifier
 * 
 * @example
 * // Basic streaming invocation with chunk callbacks
 * const result = await engine.invokeWithStreaming('readFile', { path: '/large/file.txt' }, {
 *   onChunk: (chunk, context) => {
 *     console.log(`Received chunk ${chunk.chunkIndex}:`, chunk.data);
 *   },
 *   onProgress: (progress) => {
 *     console.log(`Progress: ${progress.progress}%`);
 *   }
 * });
 * 
 * // Access aggregated result after completion
 * console.log('Final result:', result.result);
 * console.log('Total chunks:', result.chunks.length);
 * 
 * @example
 * // Streaming with timeout and partial result handling
 * try {
 *   const result = await engine.invokeWithStreaming('processData', { data: largeDataset }, {
 *     timeoutMs: 30000,
 *     chunkTimeoutMs: 5000,
 *     onChunk: (chunk) => {
 *       // Process chunk immediately without waiting for completion
 *       processChunk(chunk.data);
 *     }
 *   });
 *   
 *   if (result.status === 'partial') {
 *     // Handle partial results (e.g., timeout mid-stream)
 *     console.log('Partial result with', result.chunks.length, 'chunks');
 *   } else if (result.status === 'success') {
 *     // Full result available
 *     console.log('Complete result:', result.result);
 *   }
 * } catch (err) {
 *   // Handle invocation errors (network, server errors)
 *   console.error('Invocation failed:', err);
 * }
 * 
 * @example
 * // Difference between onChunk and return value:
 * // - onChunk: Called immediately for each chunk (real-time processing)
 * // - return value: Aggregated result after ALL chunks received or timeout
 * 
 * const streamingResult = await engine.invokeWithStreaming('generateReport', {}, {
 *   onChunk: (chunk, ctx) => {
 *     // This runs IMMEDIATELY for each chunk (streaming/real-time)
 *     // Use for: progress bars, live updates, incremental processing
 *     updateProgressUI(chunk.data);
 *   }
 * });
 * 
 * // This runs AFTER all chunks received or timeout (aggregated/final)
 * // Use for: final processing, persistence, cleanup
 * saveToDatabase(streamingResult.result);
 */

/**
 * Result classification
 * @typedef {'success'|'error'|'timeout'|'partial'|'cancelled'} ResultClassification
 */

/**
 * Classified result
 * @typedef {Object} ClassifiedResult
 * @property {ResultClassification} classification - Result classification
 * @property {ProcessedResult} result - The processed result
 * @property {boolean} [retryable] - Whether the invocation can be retried
 * @property {string} [suggestedAction] - Suggested action for handling the result
 */

/**
 * Error response processing result
 * @typedef {Object} ErrorResponseResult
 * @property {'error'} status - Always 'error'
 * @property {string} code - Error code
 * @property {string} message - Error message
 * @property {JSONRPCError|ErrorInfo} [error] - Detailed error information
 * @property {string} [serverId] - Server ID where error occurred
 * @property {string} [toolName] - Tool name that caused the error
 * @property {boolean} [retryable] - Whether the error is retryable
 * @property {number} [errorType] - JSON-RPC or MCP error code
 * @property {*} [errorData] - Additional error data from server
 */

/**
 * Malformed response handling result
 * @typedef {Object} MalformedResponseResult
 * @property {'error'|'partial'} status - Status ('error' if unrecoverable, 'partial' if some data extracted)
 * @property {string} code - Error code (e.g., 'MALFORMED_RESPONSE')
 * @property {string} message - Description of the malformation
 * @property {Array<ValidationError>} [validationErrors] - Specific validation errors
 * @property {*} [rawResponse] - Raw response data for debugging
 * @property {*} [extractedData] - Any data that could be extracted
 * @property {boolean} [canRetry] - Whether retrying might help
 */

/**
 * Timeout handling result
 * 
 * Returned when a streaming invocation exceeds its timeout threshold.
 * Unlike hard errors, timeouts may return partial results if chunks were
 * received before the timeout occurred. The status is 'partial' when
 * chunks were collected, 'error' when no data was received.
 * 
 * @typedef {Object} TimeoutResult
 * @property {'error'|'partial'} status - 'error' if no partial data, 'partial' if chunks received
 * @property {string} code - Always 'TIMEOUT'
 * @property {string} message - Timeout message
 * @property {number} timeoutMs - Configured timeout threshold in milliseconds
 * @property {number} elapsedMs - Actual elapsed time when timeout occurred
 * @property {Array<StreamingChunk>} [chunks] - Partial chunks collected before timeout
 * @property {number} [chunksCollected] - Number of chunks collected before timeout
 * @property {string} toolName - Tool that timed out
 * @property {ToolCallResult} [result] - Aggregated partial data (for status: 'partial')
 * 
 * @example
 * // Timeout with partial data
 * const result = await engine.invokeWithStreaming('slowTool', {}, { timeoutMs: 5000 });
 * 
 * if (result.status === 'partial') {
 *   // Process the chunks we got before timeout
 *   console.log('Got', result.chunks.length, 'chunks before timeout');
 *   result.chunks.forEach(chunk => process(chunk.data));
 * } else if (result.status === 'error' && result.code === 'TIMEOUT') {
 *   // No data received before timeout
 *   console.log('Complete timeout, no data received');
 * }
 */

/**
 * Ping response
 * @typedef {Object} PingResult
 * @property {string} status - Always 'pong'
 * @property {number} timestamp - Server timestamp in milliseconds
 * @property {Object} [metadata] - Optional server metadata
 */

/**
 * Health check result
 * @typedef {Object} HealthCheckResult
 * @property {boolean} healthy - Whether server is healthy
 * @property {boolean} connected - Connection status
 * @property {boolean} initialized - Initialization status
 * @property {number|null} lastPing - Timestamp of last successful ping
 * @property {number|null} lastPingAge - Age of last ping in milliseconds
 * @property {string} transport - Transport type ('stdio' or 'http')
 * @property {number} reconnectAttempts - Number of reconnect attempts
 * @property {string} [checkedAt] - ISO timestamp of health check
 * @property {Object} [details] - Additional health details
 */

/**
 * Resource reference in content
 * @typedef {Object} ResourceReference
 * @property {string} uri - Resource URI
 * @property {string} [mimeType] - Resource MIME type
 * @property {Object} [metadata] - Resource metadata
 */

/**
 * File content result (filesystem tools)
 * @typedef {Object} FileContentResult
 * @property {string} content - File content as string
 * @property {number} size - File size in bytes
 * @property {string} [encoding] - Content encoding (e.g., 'utf-8', 'base64')
 * @property {string} [mimeType] - Detected MIME type
 * @property {boolean} [isBinary] - Whether content is binary
 */

/**
 * Directory listing result (filesystem tools)
 * @typedef {Object} DirectoryListingResult
 * @property {Array<DirectoryEntry>} entries - Directory entries
 * @property {number} totalCount - Total number of entries
 * @property {string} path - Directory path
 * @property {boolean} [truncated] - Whether listing was truncated
 */

/**
 * Directory entry
 * @typedef {Object} DirectoryEntry
 * @property {string} name - Entry name
 * @property {'file'|'directory'|'symlink'} type - Entry type
 * @property {number} [size] - Entry size in bytes (for files)
 * @property {string} [modifiedTime] - Last modified timestamp
 * @property {string} [permissions] - File permissions
 * @property {string} [target] - Symlink target (for symlinks)
 */

/**
 * Search result
 * @typedef {Object} SearchResult
 * @property {Array<SearchMatch}> matches - Search matches
 * @property {number} totalMatches - Total number of matches
 * @property {string} query - Search query
 * @property {number} elapsedMs - Search duration in milliseconds
 * @property {boolean} [truncated] - Whether results were truncated
 */

/**
 * Search match
 * @typedef {Object} SearchMatch
 * @property {string} path - File or resource path
 * @property {number} line - Line number (for file searches)
 * @property {string} content - Line content containing match
 * @property {Array<MatchHighlight>} highlights - Highlighted match positions
 */

/**
 * Match highlight
 * @typedef {Object} MatchHighlight
 * @property {number} start - Start position
 * @property {number} end - End position
 * @property {string} text - Matched text
 */

/**
 * Batch operation result
 * @typedef {Object} BatchOperationResult
 * @property {number} total - Total operations
 * @property {number} succeeded - Number of successful operations
 * @property {number} failed - Number of failed operations
 * @property {Array<OperationSuccess>} successes - Success details
 * @property {Array<OperationFailure>} failures - Failure details
 * @property {number} elapsedMs - Total elapsed time
 */

/**
 * Operation success
 * @typedef {Object} OperationSuccess
 * @property {string} operation - Operation identifier
 * @property {*} result - Operation result
 * @property {number} elapsedMs - Operation duration
 */

/**
 * Operation failure
 * @typedef {Object} OperationFailure
 * @property {string} operation - Operation identifier
 * @property {string} error - Error message
 * @property {string} code - Error code
 * @property {*} [details] - Error details
 */

/**
 * Type guard: Check if value is JSON-RPC response
 * @param {*} value - Value to check
 * @returns {value is JSONRPCResponse}
 */
export function isJSONRPCResponse(value) {
  return value !== null && 
         typeof value === 'object' && 
         value.jsonrpc === '2.0' && 
         value.id !== undefined;
}

/**
 * Type guard: Check if value is JSON-RPC error response
 * @param {*} value - Value to check
 * @returns {value is JSONRPCErrorResponse}
 */
export function isJSONRPCErrorResponse(value) {
  return isJSONRPCResponse(value) && value.error !== undefined;
}

/**
 * Type guard: Check if value is JSON-RPC success response
 * @param {*} value - Value to check
 * @returns {value is JSONRPCSuccessResponse}
 */
export function isJSONRPCSuccessResponse(value) {
  return isJSONRPCResponse(value) && value.result !== undefined && value.error === undefined;
}

/**
 * Type guard: Check if value is tool call result
 * @param {*} value - Value to check
 * @returns {value is ToolCallResult}
 */
export function isToolCallResult(value) {
  return value !== null &&
         typeof value === 'object' &&
         Array.isArray(value.content) &&
         (value.isError === undefined || typeof value.isError === 'boolean');
}

/**
 * Type guard: Check if result is success
 * @param {ProcessedToolResult} result - Result to check
 * @returns {boolean}
 */
export function isSuccessResult(result) {
  return result.status === 'ok';
}

/**
 * Type guard: Check if result is error
 * @param {ProcessedToolResult} result - Result to check
 * @returns {boolean}
 */
export function isErrorResult(result) {
  return result.status === 'error';
}

/**
 * Type guard: Check if result is validation error
 * @param {ProcessedToolResult} result - Result to check
 * @returns {boolean}
 */
export function isValidationError(result) {
  return isErrorResult(result) && result.code === 'VALIDATION_FAILED';
}

/**
 * Type guard: Check if result is invocation error
 * @param {ProcessedToolResult} result - Result to check
 * @returns {boolean}
 */
export function isInvocationError(result) {
  return isErrorResult(result) && result.code === 'INVOCATION_FAILED';
}

/**
 * Type guard: Check if result is a streaming result
 * @param {*} result - Result to check
 * @returns {result is AggregatedStreamingResult|StreamingResult}
 */
export function isStreamingResult(result) {
  return result !== null &&
         typeof result === 'object' &&
         Array.isArray(result.chunks) &&
         typeof result.context === 'object';
}

/**
 * Type guard: Check if result is a partial result
 * @param {*} result - Result to check
 * @returns {result is PartialResult}
 */
export function isPartialResult(result) {
  return result?.status === 'partial' ||
         (result?.isComplete === false && result?.data !== undefined);
}

/**
 * Type guard: Check if result is a timeout result with partial data
 * @param {*} result - Result to check
 * @returns {result is TimeoutResult}
 */
export function isTimeoutWithPartialData(result) {
  return result?.code === 'TIMEOUT' &&
         result?.chunks &&
         result.chunks.length > 0;
}

/**
 * Get result classification
 * @param {ProcessedToolResult|AggregatedStreamingResult|TimeoutResult} result - Result to classify
 * @returns {ResultClassification}
 */
export function classifyResult(result) {
  if (result.status === 'ok' || result.status === 'success') {
    return 'success';
  }
  // Check for partial results with chunks before checking for timeout
  if (result.chunks && result.chunks.length > 0 && result.status === 'error') {
    return 'partial';
  }
  if (result.code === 'TIMEOUT' || result.status === 'error' && result.context?.timeoutMs) {
    return 'timeout';
  }
  if (result.status === 'error' || result.code === 'CANCELLED') {
    return 'error';
  }
  return 'error';
}