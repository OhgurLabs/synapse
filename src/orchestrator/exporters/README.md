# Audit Event Exporters

Streaming exporters for audit events with constant memory footprint.

## PDF Exporter

### Overview

The PDF exporter provides memory-efficient streaming export of audit events to PDF format. It generates professional reports with executive summaries, agent activity breakdowns, and decision audit trails using pdfkit.

### Features

- **Streaming PDF Generation**: Uses pdfkit's streaming API for constant memory usage
- **Two Report Templates**: Activity Summary and Incident Timeline
- **Executive Summary**: Success/error rates, event counts, and key metrics
- **Agent Activity Breakdown**: Per-agent dispatch statistics and success rates
- **Decision Audit Trail**: Recent routing decisions with reasoning excerpts
- **Incident Timeline**: Error/failure events with propagation chains
- **Automatic Page Numbers**: Page X of Y footer on all pages
- **Smart Truncation**: Limits to 10K events for reasonable file sizes
- **Progress Callbacks**: Reports progress during large exports

### Usage

```javascript
import { createWriteStream } from 'fs';
import { exportToPDF } from './exporters/pdf-exporter.js';
import { createExportQueryEngine } from './export-query-engine.js';

// Set up query engine
const queryEngine = createExportQueryEngine({
  timelineStore,
  batchSize: 1000,
});

// Define export filters
const filters = {
  startDate: '2026-03-01T00:00:00.000Z',
  endDate: '2026-03-31T23:59:59.999Z',
  scope: 'campaign:campaign-123',
};

// Export to PDF file
const outputStream = createWriteStream('report.pdf');

const result = await exportToPDF({
  outputStream,
  queryEngine,
  filters,
  template: 'activity_summary', // or 'incident_timeline'
  onProgress: (status) => {
    console.log(`Progress: ${status.eventsProcessed} events`);
  },
});

outputStream.end();

console.log(`Exported ${result.eventsProcessed} events in ${result.durationMs}ms`);
```

### Report Templates

#### Activity Summary

The Activity Summary report provides an overview of system performance:

- **Executive Summary**: Total events, time period, scope, success/error rates
- **Agent Activity Breakdown**: Table showing per-agent:
  - Total dispatches
  - Success rate (percentage)
  - Error count
  - Success count
  - Failure count
- **Decision Audit Trail**: Recent routing decisions (up to 50) with:
  - Agent ID
  - Timestamp
  - Decision summary
  - Selection reasoning

#### Incident Timeline

The Incident Timeline report focuses on failures and errors:

- **Incidents Section**: All error/failure events with:
  - Severity level (critical, high, medium, low)
  - Timestamp, agent, trace ID
  - Description and reasoning
  - Failure propagation chains
  - Sorted by most recent first
- **Event Timeline**: Non-error events (up to 100) showing:
  - Event type and timestamp
  - Agent and trace references
  - Event summary
  - Reasoning when available

### Memory Characteristics

The PDF exporter maintains constant memory usage regardless of result set size:

- **Batch Processing**: Events processed in batches from query engine (default 1000)
- **Streaming PDF**: PDF pages written incrementally to output stream
- **Event Limit**: Capped at 10K events to keep file size reasonable
- **No Full Buffering**: Events not accumulated in memory

For a 50K event export over 30 days:
- Expected memory: **< 200MB**
- Expected duration: **< 30 seconds** (for first 10K events)
- Peak throughput: **~10,000 events/second**

### API Reference

#### `PDFExporter` Class

```javascript
import { PDFExporter } from './exporters/pdf-exporter.js';

const exporter = new PDFExporter({
  outputStream,    // Required: Writable stream
  queryEngine,     // Required: ExportQueryEngine instance
  filters,         // Optional: Query filters
  template,        // Optional: 'activity_summary' or 'incident_timeline' (default: activity_summary)
  onProgress,      // Optional: Progress callback
});

const result = await exporter.export();
```

#### `exportToPDF()` Convenience Function

```javascript
import { exportToPDF } from './exporters/pdf-exporter.js';

const result = await exportToPDF({
  outputStream,
  queryEngine,
  filters,
  template,
  onProgress,
});
```

#### Result Object

```javascript
{
  format: 'pdf',
  eventsProcessed: 1234,
  bytesWritten: 567890,
  durationMs: 123,
  template: 'activity_summary'
}
```

### Progress Callback

The progress callback receives status updates during export:

```javascript
function onProgress(status) {
  // During event collection
  if (status.phase === 'processing') {
    console.log(`Processed ${status.eventsProcessed} events`);
  }

  // During PDF writing
  if (status.phase === 'writing') {
    console.log(`Written ${status.bytesWritten} bytes`);
  }
}
```

### Error Handling

The exporter throws errors for:
- Missing required options (`outputStream`, `queryEngine`)
- Invalid template name
- Stream errors during write operations
- Query engine failures

Always wrap in try/catch and handle stream cleanup:

```javascript
const outputStream = createWriteStream('report.pdf');

try {
  await exportToPDF({ outputStream, queryEngine, filters, template: 'activity_summary' });
  outputStream.end();
} catch (error) {
  console.error('Export failed:', error);
  outputStream.destroy();
}
```

## CSV Exporter

### Overview

The CSV exporter provides memory-efficient streaming export of audit events to CSV format. It processes events in batches from the `ExportQueryEngine` without buffering the entire result set in memory.

### Features

- **Streaming Architecture**: Uses Node.js streams for constant memory usage
- **Automatic Field Detection**: Dynamically determines CSV columns from event data
- **Proper CSV Escaping**: Handles commas, quotes, and newlines correctly
- **Data Flattening**: Converts nested `data` objects to `data_*` prefixed columns
- **Progress Callbacks**: Reports progress during large exports
- **Backpressure Handling**: Respects stream backpressure to avoid memory spikes

### Usage

```javascript
import { createWriteStream } from 'fs';
import { exportToCSV } from './exporters/csv-exporter.js';
import { createExportQueryEngine } from './export-query-engine.js';

// Set up query engine
const queryEngine = createExportQueryEngine({
  timelineStore,
  batchSize: 1000,
});

// Define export filters
const filters = {
  dateRange: {
    from: '2026-03-01T00:00:00.000Z',
    to: '2026-03-31T23:59:59.999Z',
  },
  scope: {
    type: 'campaign',
    id: 'campaign-123',
  },
};

// Export to CSV file
const outputStream = createWriteStream('audit-export.csv');

const result = await exportToCSV({
  outputStream,
  queryEngine,
  filters,
  onProgress: (status) => {
    console.log(`Progress: ${status.progress}%`);
  },
});

outputStream.end();

console.log(`Exported ${result.rowsWritten} rows in ${result.durationMs}ms`);
```

### CSV Structure

The CSV exporter produces the following structure:

#### Standard Correlation Fields

These fields appear first in every CSV export:

- `id` - Event unique identifier
- `event_ts` - Event timestamp (ISO 8601)
- `export_type` - Event type (routing, guardrail, circuitBreaker, etc.)
- `campaign_id` - Campaign identifier
- `dispatch_id` - Dispatch identifier
- `trace_id` - Distributed trace identifier
- `milestone_id` - Milestone identifier
- `task_id` - Task identifier
- `subtask_id` - Subtask identifier
- `agent_id` - Agent identifier
- `provider` - Provider name (openai, anthropic, etc.)
- `created_at` - Creation timestamp
- `parent_correlation_id` - Parent correlation identifier
- `root_correlation_id` - Root correlation identifier

#### Event-Specific Fields

Additional fields vary by event type:

**Routing Events**:
- `selectedAgent` - Selected agent ID
- `selectionReason` - Selection reasoning

**Guardrail Events**:
- `outcome` - Outcome (allowed, blocked, etc.)
- `ruleId` - Rule identifier
- `ruleName` - Rule name

**Circuit Breaker Events**:
- `previousState` - Previous state
- `newState` - New state
- `failureCount` - Failure count

**Anomaly Events**:
- `severity` - Severity level
- `anomalyType` - Anomaly type
- `detail` - Detail message

**Operator Action Events**:
- `actionType` - Action type
- `operatorId` - Operator identifier
- `sourceDispatchId` - Source dispatch ID
- `targetDispatchId` - Target dispatch ID
- `status` - Action status

**Review Rejection Events**:
- `reviewerId` - Reviewer agent ID
- `cycleNumber` - Review cycle number
- `findingsCount` - Number of findings
- `reworkStatus` - Rework status
- `verdict` - Review verdict

**Routing Proposal Events**:
- `proposalId` - Proposal identifier
- `sourceType` - Source type
- `state` - Proposal state
- `confidence` - Confidence score
- `rationale` - Proposal rationale

**Cost Events**:
- `model` - Model name
- `inputTokens` - Input token count
- `outputTokens` - Output token count
- `costUsd` - Cost in USD

**Error Propagation Events**:
- `failedNodeId` - Failed node identifier

#### Data Fields

The `data` object from each event is flattened with `data_` prefix:

```javascript
// Event data
{
  data: {
    complexity: 'medium',
    weights: { lola: 0.8, kai: 0.2 }
  }
}

// CSV columns
data_complexity,data_weights
medium,"{""lola"":0.8,""kai"":0.2}"
```

### CSV Escaping Rules

1. **Commas**: Fields containing commas are quoted
   - `value,with,commas` → `"value,with,commas"`

2. **Double Quotes**: Quotes are doubled and field is quoted
   - `She said "hello"` → `"She said ""hello"""`

3. **Newlines**: Newlines are preserved in quoted fields
   - `Line 1\nLine 2` → `"Line 1\nLine 2"`

4. **Complex Objects**: JSON-serialized with escaped quotes
   - `{"a":1}` → `"{""a"":1}"`

### Memory Characteristics

The CSV exporter maintains constant memory usage regardless of result set size:

- **Batch Processing**: Events processed in batches from query engine (default 1000)
- **Stream Writing**: CSV rows written directly to output stream
- **No Buffering**: No in-memory accumulation of full result set
- **Backpressure**: Pauses when output stream is overwhelmed

For a 50K event export over 30 days:
- Expected memory: **< 200MB**
- Expected duration: **< 30 seconds**
- Peak throughput: **~10,000 rows/second**

### API Reference

#### `CSVExporter` Class

```javascript
import { CSVExporter } from './exporters/csv-exporter.js';

const exporter = new CSVExporter({
  outputStream,    // Required: Writable stream
  queryEngine,     // Required: ExportQueryEngine instance
  filters,         // Optional: Query filters
  onProgress,      // Optional: Progress callback
});

const result = await exporter.export();
```

#### `exportToCSV()` Convenience Function

```javascript
import { exportToCSV } from './exporters/csv-exporter.js';

const result = await exportToCSV({
  outputStream,
  queryEngine,
  filters,
  onProgress,
});
```

#### Result Object

```javascript
{
  format: 'csv',
  rowsWritten: 1234,
  bytesWritten: 567890,
  durationMs: 123
}
```

### Progress Callback

The progress callback receives status updates during export:

```javascript
function onProgress(status) {
  // From query engine (per event type)
  if (status.kind && status.total) {
    console.log(`Processing ${status.kind}: ${status.progress}%`);
  }

  // From CSV writer (per batch)
  if (status.phase === 'writing') {
    console.log(`Written ${status.rowsWritten} rows, ${status.bytesWritten} bytes`);
  }
}
```

### Error Handling

The exporter throws errors for:
- Missing required options (`outputStream`, `queryEngine`)
- Stream errors during write operations
- Query engine failures

Always wrap in try/catch and handle stream cleanup:

```javascript
const outputStream = createWriteStream('export.csv');

try {
  await exportToCSV({ outputStream, queryEngine, filters });
  outputStream.end();
} catch (error) {
  console.error('Export failed:', error);
  outputStream.destroy();
}
```

### Testing

Run unit tests:
```bash
node test/unit/csv-exporter.test.js
```

Run integration demo:
```bash
node test/integration/csv-export-demo.js
```

### Performance Tips

1. **Batch Size**: Default 1000 rows per batch is optimal for most cases
2. **Stream Buffering**: Use `createWriteStream` with default highWaterMark
3. **Parallel Queries**: Query engine processes event types in series (by design)
4. **Progress Updates**: Enable only for user-facing exports (adds overhead)

### Future Enhancements

- Column selection (export only specific fields)
- Custom column ordering
- CSV dialect options (delimiter, quote character)
- Compression (gzip stream wrapper)
- Null value handling options
