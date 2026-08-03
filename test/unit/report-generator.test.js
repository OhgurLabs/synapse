// test/unit/report-generator.test.js
// Unit tests for report-generator module

import { strict as assert } from 'assert';
import { TimelineStore } from '../../src/orchestrator/timeline-store.js';
import {
  generateCsvReport,
  generateJsonReport,
  generatePdfReport,
} from '../../src/orchestrator/report-generator.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  console.log(`  Running: ${name}`);
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
    if (err.stack) console.log('    ' + err.stack.split('\n').slice(1, 5).join('\n    '));
  }
}

console.log('test/unit/report-generator.test.js\n');

const testDbPath = join(process.cwd(), 'test-data', 'report-gen-test.db');
const testReportsDir = join(process.cwd(), 'test-data', 'reports');

function cleanup() {
  try {
    rmSync(join(process.cwd(), 'test-data'), { recursive: true, force: true });
  } catch {}
}

function createTimelineStore() {
  cleanup();
  mkdirSync(join(process.cwd(), 'test-data'), { recursive: true });
  return new TimelineStore({ dbPath: testDbPath });
}

function seedTestEvents(store, count = 100) {
  const now = new Date();
  const campaignId = 'campaign-test-123';

  for (let i = 0; i < count; i++) {
    const eventTime = new Date(now);
    eventTime.setMinutes(eventTime.getMinutes() - i);

    store.appendRoutingEvent({
      id: `evt-${randomUUID()}`,
      eventTs: eventTime.toISOString(),
      campaignId: campaignId,
      dispatchId: `disp-${i}`,
      traceId: `trace-${i}`,
      agentId: `agent-${i % 5}`,
      provider: 'gemini',
      selectedAgent: `agent-${i % 5}`,
      selectionReason: `test reason ${i}`,
      data: { taskCategory: 'coding', status: 'success' },
    });
  }

  return campaignId;
}

await test('generateCsvReport returns valid CSV string', async () => {
  const store = createTimelineStore();
  const campaignId = seedTestEvents(store, 50);

  const now = new Date();
  const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
  const endDate = now.toISOString();

  const csvContent = generateCsvReport(
    store,
    { startDate, endDate, scope: `campaign:${campaignId}` }
  );

  assert.ok(typeof csvContent === 'string', 'should return a string');
  assert.ok(csvContent.length > 0, 'CSV content should not be empty');
  assert.ok(csvContent.includes('timestamp'), 'CSV should have header row');
  assert.ok(csvContent.split('\n').length > 1, 'CSV should have data rows');
  assert.ok(csvContent.split('\n').length === 52, 'CSV should have 52 lines (header + 50 events + trailing newline)');

  store.close();
  cleanup();
});

await test('generateJsonReport returns valid JSON string', async () => {
  const store = createTimelineStore();
  const campaignId = seedTestEvents(store, 30);

  const now = new Date();
  const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endDate = now.toISOString();

  const jsonContent = generateJsonReport(
    store,
    { startDate, endDate, scope: `campaign:${campaignId}` }
  );

  assert.ok(typeof jsonContent === 'string', 'should return a string');
  assert.ok(jsonContent.length > 0, 'JSON content should not be empty');

  const parsed = JSON.parse(jsonContent);
  assert.ok(Array.isArray(parsed), 'JSON should be an array');
  assert.ok(parsed.length === 30, 'JSON array should have 30 events');

  store.close();
  cleanup();
});

await test('generatePdfReport returns valid PDF buffer with activity_summary template', async () => {
  const store = createTimelineStore();
  const campaignId = seedTestEvents(store, 20);

  const now = new Date();
  const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endDate = now.toISOString();

  const pdfBuffer = await generatePdfReport(
    store,
    { startDate, endDate, scope: `campaign:${campaignId}` },
    'activity_summary'
  );

  assert.ok(Buffer.isBuffer(pdfBuffer), 'should return a Buffer');
  assert.ok(pdfBuffer.length > 0, 'PDF buffer should not be empty');

  // Check PDF magic bytes
  assert.ok(pdfBuffer.toString('utf8', 0, 5) === '%PDF-', 'Buffer should be a PDF');

  store.close();
  cleanup();
});

await test('generatePdfReport returns valid PDF buffer with incident_timeline template', async () => {
  const store = createTimelineStore();
  const campaignId = seedTestEvents(store, 15);

  const now = new Date();
  const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const endDate = now.toISOString();

  const pdfBuffer = await generatePdfReport(
    store,
    { startDate, endDate, scope: `campaign:${campaignId}` },
    'incident_timeline'
  );

  assert.ok(Buffer.isBuffer(pdfBuffer), 'should return a Buffer');
  assert.ok(pdfBuffer.length > 0, 'PDF buffer should not be empty');
  assert.ok(pdfBuffer.toString('utf8', 0, 5) === '%PDF-', 'Buffer should be a PDF');

  store.close();
  cleanup();
});

await test('scope parameter supports multiple filter types', async () => {
  const store = createTimelineStore();
  seedTestEvents(store, 10);

  const now = new Date();
  const params = {
    startDate: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    endDate: now.toISOString(),
  };

  // Test system scope
  const systemResult = generateCsvReport(store, { ...params, scope: 'system' });
  assert.ok(systemResult.includes('agent-0'), 'System scope should return all agents');

  // Test agent scope
  const agentResult = generateCsvReport(store, { ...params, scope: 'agent:agent-0' });
  assert.ok(agentResult.includes('agent-0'), 'Agent scope should filter by agent');

  // Test provider scope
  const providerResult = generateCsvReport(store, { ...params, scope: 'provider:gemini' });
  assert.ok(providerResult.includes('gemini'), 'Provider scope should filter by provider');

  store.close();
  cleanup();
});

await test('generatePdfReport throws error for invalid template', async () => {
  const store = createTimelineStore();
  seedTestEvents(store, 5);

  const now = new Date();
  const params = {
    startDate: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    endDate: now.toISOString(),
    scope: 'system',
  };

  try {
    await generatePdfReport(store, params, 'invalid-template');
    assert.fail('Should have thrown error for invalid template');
  } catch (err) {
    assert.ok(err.message.includes('Unknown PDF template'), 'Error message should mention unknown template');
  }

  store.close();
  cleanup();
});

await test('generateCsvReport throws error for invalid scope format', async () => {
  const store = createTimelineStore();
  seedTestEvents(store, 5);

  const now = new Date();
  const params = {
    startDate: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    endDate: now.toISOString(),
    scope: 'invalid-scope-format', // Missing colon separator
  };

  try {
    generateCsvReport(store, params);
    assert.fail('Should have thrown error for invalid scope format');
  } catch (err) {
    assert.ok(err.message.includes('Invalid scope format'), 'Error message should mention invalid scope format');
  }

  store.close();
  cleanup();
});

await test('CSV report handles empty result set', async () => {
  const store = createTimelineStore();
  seedTestEvents(store, 10);

  // Query for date range with no events
  const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const params = {
    startDate: futureDate,
    endDate: futureDate,
    scope: 'system',
  };

  const csvContent = generateCsvReport(store, params);

  assert.ok(typeof csvContent === 'string', 'should return a string');
  assert.ok(csvContent.includes('timestamp'), 'CSV should still have header row even with no events');
  assert.ok(csvContent.split('\n').length === 2, 'Empty CSV should have header + trailing newline');

  store.close();
  cleanup();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
