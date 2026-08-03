import { strict as assert } from 'assert';
import { Writable } from 'stream';
import { JSONExporter } from '../../src/orchestrator/exporters/json-exporter.js';

/**
 * Mock QueryEngine for testing
 */
class MockQueryEngine {
  constructor(events) {
    this.events = events;
    this.batchSize = 2;
  }

  async *queryEventsStream(filters, options) {
    // Yield events in batches
    for (let i = 0; i < this.events.length; i += this.batchSize) {
      const batch = this.events.slice(i, i + this.batchSize);
      yield batch;
    }
  }
}

/**
 * Capture stream writes to a buffer
 */
class CaptureStream extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(chunk.toString());
    callback();
  }

  getOutput() {
    return this.chunks.join('');
  }
}

// Test: Empty events array
{
  const outputStream = new CaptureStream();
  const queryEngine = new MockQueryEngine([]);
  const exporter = new JSONExporter({ outputStream, queryEngine });

  const stats = await exporter.export();

  const output = outputStream.getOutput();
  assert.equal(output, '[]', 'Empty events should produce []');
  assert.equal(stats.eventsWritten, 0, 'Should write 0 events');
  assert.equal(stats.format, 'json', 'Format should be json');

  console.log('✓ Empty events test passed');
}

// Test: Single event
{
  const outputStream = new CaptureStream();
  const events = [
    { id: '1', event_ts: '2026-03-19T10:00:00Z', agent_id: 'dom' }
  ];
  const queryEngine = new MockQueryEngine(events);
  const exporter = new JSONExporter({ outputStream, queryEngine });

  const stats = await exporter.export();

  const output = outputStream.getOutput();
  const parsed = JSON.parse(output);

  assert.equal(Array.isArray(parsed), true, 'Output should be an array');
  assert.equal(parsed.length, 1, 'Should have 1 event');
  assert.equal(parsed[0].id, '1', 'Event id should match');
  assert.equal(stats.eventsWritten, 1, 'Should write 1 event');

  console.log('✓ Single event test passed');
}

// Test: Multiple events with batching
{
  const outputStream = new CaptureStream();
  const events = [
    { id: '1', event_ts: '2026-03-19T10:00:00Z', agent_id: 'dom' },
    { id: '2', event_ts: '2026-03-19T10:01:00Z', agent_id: 'lola' },
    { id: '3', event_ts: '2026-03-19T10:02:00Z', agent_id: 'kai' },
    { id: '4', event_ts: '2026-03-19T10:03:00Z', agent_id: 'carl' },
    { id: '5', event_ts: '2026-03-19T10:04:00Z', agent_id: 'dom' }
  ];
  const queryEngine = new MockQueryEngine(events);
  const exporter = new JSONExporter({ outputStream, queryEngine });

  const stats = await exporter.export();

  const output = outputStream.getOutput();
  const parsed = JSON.parse(output);

  assert.equal(Array.isArray(parsed), true, 'Output should be an array');
  assert.equal(parsed.length, 5, 'Should have 5 events');
  assert.equal(parsed[0].id, '1', 'First event id should match');
  assert.equal(parsed[4].id, '5', 'Last event id should match');
  assert.equal(stats.eventsWritten, 5, 'Should write 5 events');

  console.log('✓ Multiple events test passed');
}

// Test: Events with nested objects
{
  const outputStream = new CaptureStream();
  const events = [
    {
      id: '1',
      event_ts: '2026-03-19T10:00:00Z',
      data: {
        complexity: 'high',
        nested: { value: 42 }
      },
      metadata: ['tag1', 'tag2']
    }
  ];
  const queryEngine = new MockQueryEngine(events);
  const exporter = new JSONExporter({ outputStream, queryEngine });

  await exporter.export();

  const output = outputStream.getOutput();
  const parsed = JSON.parse(output);

  assert.equal(parsed[0].data.complexity, 'high', 'Nested data should be preserved');
  assert.equal(parsed[0].data.nested.value, 42, 'Deeply nested data should be preserved');
  assert.deepEqual(parsed[0].metadata, ['tag1', 'tag2'], 'Arrays should be preserved');

  console.log('✓ Nested objects test passed');
}

// Test: Progress callback
{
  const outputStream = new CaptureStream();
  const events = Array.from({ length: 10000 }, (_, i) => ({
    id: String(i + 1),
    event_ts: '2026-03-19T10:00:00Z',
  }));

  const progressUpdates = [];
  const queryEngine = new MockQueryEngine(events);
  const exporter = new JSONExporter({
    outputStream,
    queryEngine,
    onProgress: (status) => progressUpdates.push(status),
  });

  const stats = await exporter.export();

  const output = outputStream.getOutput();
  const parsed = JSON.parse(output);

  assert.equal(parsed.length, 10000, 'Should have 10000 events');
  assert.equal(stats.eventsWritten, 10000, 'Should write 10000 events');
  assert.ok(progressUpdates.length > 0, 'Should have progress updates');
  assert.equal(progressUpdates[0].phase, 'writing', 'Progress should have writing phase');

  console.log('✓ Progress callback test passed');
}

console.log('\n✅ All JSON exporter tests passed!');
