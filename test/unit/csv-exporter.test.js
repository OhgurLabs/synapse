import { strict as assert } from 'assert';
import { Writable } from 'stream';
import { CSVExporter, createCSVExporter, exportToCSV } from '../../src/orchestrator/exporters/csv-exporter.js';

// Mock query engine for testing
class MockQueryEngine {
  constructor(mockEvents = []) {
    this.mockEvents = mockEvents;
  }

  async *queryEventsStream(filters, options) {
    const batchSize = 10;
    const { onProgress } = options || {};

    for (let i = 0; i < this.mockEvents.length; i += batchSize) {
      const batch = this.mockEvents.slice(i, i + batchSize);

      // Call progress callback if provided
      if (onProgress) {
        onProgress({
          processed: Math.min(i + batchSize, this.mockEvents.length),
          total: this.mockEvents.length,
        });
      }

      yield batch;
    }
  }
}

// In-memory writable stream for testing
class MemoryStream extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(chunk);
    callback();
  }

  getData() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

// Test: CSV exporter requires outputStream and queryEngine
{
  try {
    new CSVExporter({});
    assert.fail('Should throw when outputStream missing');
  } catch (err) {
    assert.match(err.message, /outputStream.*required/);
  }

  try {
    new CSVExporter({ outputStream: new MemoryStream() });
    assert.fail('Should throw when queryEngine missing');
  } catch (err) {
    assert.match(err.message, /queryEngine.*required/);
  }

  console.log('✓ CSVExporter constructor validation');
}

// Test: Empty export writes header only
{
  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine([]);
  const exporter = new CSVExporter({ outputStream, queryEngine });

  const result = await exporter.export();

  assert.equal(result.rowsWritten, 0);
  assert.equal(result.format, 'csv');

  const output = outputStream.getData();
  const lines = output.trim().split('\n');

  assert.equal(lines.length, 1); // Header only
  assert.match(lines[0], /^id,event_ts,export_type/); // Standard fields in header

  console.log('✓ Empty export writes header only');
}

// Test: Single event export
{
  const mockEvents = [
    {
      id: 'test-1',
      event_ts: '2026-03-19T10:00:00.000Z',
      export_type: 'routing',
      campaign_id: 'camp-1',
      dispatch_id: 'disp-1',
      trace_id: 'trace-1',
      milestone_id: null,
      task_id: null,
      subtask_id: null,
      agent_id: 'lola',
      provider: 'openai',
      created_at: '2026-03-19T10:00:00.000Z',
      parent_correlation_id: null,
      root_correlation_id: 'disp-1',
      selectedAgent: 'lola',
      selectionReason: 'weighted_performance',
      data: {
        complexity: 'medium',
        weights: { lola: 0.8, kai: 0.2 },
      },
    },
  ];

  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine(mockEvents);
  const exporter = new CSVExporter({ outputStream, queryEngine });

  const result = await exporter.export();

  assert.equal(result.rowsWritten, 1);

  const output = outputStream.getData();
  const lines = output.trim().split('\n');

  assert.equal(lines.length, 2); // Header + 1 row
  assert.match(lines[0], /^id,event_ts/); // Header

  // Verify data row contains key fields
  assert.match(lines[1], /test-1/);
  assert.match(lines[1], /2026-03-19T10:00:00\.000Z/);
  assert.match(lines[1], /routing/);
  assert.match(lines[1], /lola/);
  assert.match(lines[1], /openai/);

  console.log('✓ Single event export');
}

// Test: Multiple events with different types
{
  const mockEvents = [
    {
      id: 'route-1',
      event_ts: '2026-03-19T10:00:00.000Z',
      export_type: 'routing',
      campaign_id: 'camp-1',
      agent_id: 'lola',
      provider: 'openai',
      data: { complexity: 'medium' },
    },
    {
      id: 'guard-1',
      event_ts: '2026-03-19T10:01:00.000Z',
      export_type: 'guardrail',
      campaign_id: 'camp-1',
      agent_id: 'kai',
      provider: 'anthropic',
      outcome: 'allowed',
      ruleId: 'rule-1',
      data: { ruleType: 'pattern' },
    },
    {
      id: 'cb-1',
      event_ts: '2026-03-19T10:02:00.000Z',
      export_type: 'circuitBreaker',
      campaign_id: 'camp-1',
      agent_id: 'lola',
      provider: 'openai',
      previousState: 'closed',
      newState: 'open',
      failureCount: 5,
      data: {},
    },
  ];

  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine(mockEvents);
  const exporter = new CSVExporter({ outputStream, queryEngine });

  const result = await exporter.export();

  assert.equal(result.rowsWritten, 3);

  const output = outputStream.getData();
  const lines = output.trim().split('\n');

  assert.equal(lines.length, 4); // Header + 3 rows

  // Verify header includes type-specific fields
  const header = lines[0];
  assert.match(header, /outcome/); // From guardrail event
  assert.match(header, /ruleId/); // From guardrail event
  assert.match(header, /previousState/); // From circuit breaker event
  assert.match(header, /failureCount/); // From circuit breaker event

  console.log('✓ Multiple events with different types');
}

// Test: CSV escaping - commas, quotes, newlines
{
  const mockEvents = [
    {
      id: 'escape-test',
      event_ts: '2026-03-19T10:00:00.000Z',
      export_type: 'routing',
      campaign_id: 'camp-1',
      agent_id: 'lola',
      provider: 'openai',
      selectionReason: 'Test with, comma',
      data: {
        message: 'Line 1\nLine 2',
        quoted: 'She said "hello"',
        complex: 'Comma, quote", and\nnewline',
      },
    },
  ];

  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine(mockEvents);
  const exporter = new CSVExporter({ outputStream, queryEngine });

  await exporter.export();

  const output = outputStream.getData();
  const lines = output.split('\n');

  // Verify CSV escaping
  assert.match(output, /"Test with, comma"/); // Comma causes quoting
  assert.match(output, /"She said ""hello"""/); // Quotes are doubled
  assert.match(output, /"Line 1\nLine 2"/); // Newlines preserved in quotes

  console.log('✓ CSV escaping (commas, quotes, newlines)');
}

// Test: Large batch streaming (memory footprint test)
{
  const eventCount = 1000;
  const mockEvents = [];

  for (let i = 0; i < eventCount; i++) {
    mockEvents.push({
      id: `event-${i}`,
      event_ts: new Date(Date.now() + i * 1000).toISOString(),
      export_type: 'routing',
      campaign_id: 'camp-1',
      agent_id: 'lola',
      provider: 'openai',
      data: { index: i, payload: 'x'.repeat(100) },
    });
  }

  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine(mockEvents);
  const exporter = new CSVExporter({ outputStream, queryEngine });

  const result = await exporter.export();

  assert.equal(result.rowsWritten, eventCount);
  assert.ok(result.bytesWritten > 0);
  assert.ok(result.durationMs >= 0);

  const output = outputStream.getData();
  const lines = output.trim().split('\n');

  assert.equal(lines.length, eventCount + 1); // Header + N rows

  console.log(`✓ Large batch streaming (${eventCount} events)`);
}

// Test: Flattening nested data fields
{
  const mockEvents = [
    {
      id: 'nested-test',
      event_ts: '2026-03-19T10:00:00.000Z',
      export_type: 'routing',
      campaign_id: 'camp-1',
      agent_id: 'lola',
      provider: 'openai',
      data: {
        simple: 'value',
        nested: { a: 1, b: 2 },
        array: [1, 2, 3],
        deep: { x: { y: { z: 'deep' } } },
      },
    },
  ];

  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine(mockEvents);
  const exporter = new CSVExporter({ outputStream, queryEngine });

  await exporter.export();

  const output = outputStream.getData();
  const lines = output.split('\n');
  const header = lines[0];

  // Verify data fields are prefixed with data_
  assert.match(header, /data_simple/);
  assert.match(header, /data_nested/);
  assert.match(header, /data_array/);
  assert.match(header, /data_deep/);

  // Verify complex data is JSON stringified and properly CSV-escaped
  // In CSV, quotes are doubled: {"a":1} becomes "{""a"":1}"
  const dataRow = lines[1];
  assert.ok(dataRow.includes('""a"":1,""b"":2')); // JSON with escaped quotes
  assert.ok(dataRow.includes('[1,2,3]')); // Array serialized

  console.log('✓ Flattening nested data fields');
}

// Test: Convenience function exportToCSV
{
  const mockEvents = [
    {
      id: 'test-1',
      event_ts: '2026-03-19T10:00:00.000Z',
      export_type: 'routing',
      campaign_id: 'camp-1',
      agent_id: 'lola',
      provider: 'openai',
      data: {},
    },
  ];

  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine(mockEvents);

  const result = await exportToCSV({ outputStream, queryEngine });

  assert.equal(result.rowsWritten, 1);
  assert.equal(result.format, 'csv');

  console.log('✓ Convenience function exportToCSV');
}

// Test: Progress callback
{
  const mockEvents = Array.from({ length: 50 }, (_, i) => ({
    id: `event-${i}`,
    event_ts: new Date().toISOString(),
    export_type: 'routing',
    campaign_id: 'camp-1',
    agent_id: 'lola',
    provider: 'openai',
    data: {},
  }));

  const outputStream = new MemoryStream();
  const queryEngine = new MockQueryEngine(mockEvents);

  const progressCalls = [];
  const onProgress = (status) => progressCalls.push(status);

  const exporter = new CSVExporter({
    outputStream,
    queryEngine,
    onProgress,
  });

  await exporter.export();

  // Progress should be called at least once from query engine
  assert.ok(progressCalls.length > 0);

  console.log('✓ Progress callback');
}

console.log('\n✅ All CSV exporter tests passed');
