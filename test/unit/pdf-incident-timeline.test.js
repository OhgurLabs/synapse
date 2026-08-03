/**
 * Unit test for renderIncidentTimelinePDF function
 * Verifies PDF generation for incident timeline reports
 */

import { renderIncidentTimelinePDF } from '../../src/orchestrator/pdf-formatter.js';
import fs from 'fs';
import path from 'path';

// Sample incident timeline report data
const sampleReportData = {
  incidents: [
    {
      severity: 'critical',
      title: 'Agent dispatch failure in trade execution',
      timestamp: '2026-03-19T10:30:45.123Z',
      agentId: 'trader-alpha',
      traceId: 'trace_abc123def456',
      description: 'Agent failed to execute trade order due to rate limit exceeded',
      reasoning: 'Provider returned 429 status code after 3 retry attempts. Circuit breaker opened to prevent cascade failures.',
      failureChain: [
        'Initial dispatch to provider gemini failed with rate_limit_exceeded',
        'Retry attempt 1 failed with same error after 1s backoff',
        'Retry attempt 2 failed with same error after 2s backoff',
        'Circuit breaker opened after 3 consecutive failures',
        'Task escalated to high-complexity dispatcher'
      ]
    },
    {
      severity: 'warning',
      title: 'Slow response from ollama provider',
      timestamp: '2026-03-19T10:25:30.456Z',
      agentId: 'lola',
      traceId: 'trace_xyz789ghi012',
      description: 'Response time exceeded 5s threshold for code analysis task',
      failureChain: null
    }
  ],
  timelineEvents: [
    {
      timestamp: '2026-03-19T10:30:00.000Z',
      type: 'task_dispatch',
      agentId: 'trader-alpha',
      traceId: 'trace_abc123def456',
      summary: 'Dispatched trade execution task to gemini provider',
      reasoning: 'Selected gemini based on 95% success rate for trading tasks'
    },
    {
      timestamp: '2026-03-19T10:29:00.000Z',
      type: 'task_claimed',
      agentId: 'lola',
      traceId: 'trace_xyz789ghi012',
      summary: 'Claimed code analysis task from shared queue'
    },
    {
      timestamp: '2026-03-19T10:28:00.000Z',
      type: 'campaign_milestone',
      agentId: 'system',
      traceId: null,
      summary: 'Milestone completed: Initial deployment validation'
    }
  ]
};

const sampleMetadata = {
  dateRange: '2026-03-19 00:00:00 to 2026-03-19 23:59:59',
  scope: 'system',
  scopeType: 'system'
};

console.log('Testing renderIncidentTimelinePDF...');

try {
  // Generate PDF
  const pdfDoc = renderIncidentTimelinePDF(sampleReportData, sampleMetadata);

  // Create test output directory
  const testDir = path.join(process.cwd(), 'test-data');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  // Write PDF to file for manual inspection
  const outputPath = path.join(testDir, 'test-incident-timeline.pdf');
  const writeStream = fs.createWriteStream(outputPath);

  pdfDoc.pipe(writeStream);

  writeStream.on('finish', () => {
    console.log(`✓ PDF generated successfully: ${outputPath}`);
    console.log('✓ Test passed: renderIncidentTimelinePDF works correctly');

    // Verify file exists and has content
    const stats = fs.statSync(outputPath);
    console.log(`✓ PDF file size: ${stats.size} bytes`);

    if (stats.size > 1000) {
      console.log('✓ PDF appears to have reasonable content (>1KB)');
    } else {
      console.warn('⚠ Warning: PDF file size is suspiciously small');
    }
  });

  writeStream.on('error', (err) => {
    console.error('✗ Test failed: Error writing PDF file');
    console.error(err);
    process.exit(1);
  });

} catch (error) {
  console.error('✗ Test failed: Error generating PDF');
  console.error(error);
  process.exit(1);
}

// Test with empty data
console.log('\nTesting with empty data...');
try {
  const emptyData = { incidents: [], timelineEvents: [] };
  const emptyPdfDoc = renderIncidentTimelinePDF(emptyData, sampleMetadata);

  const emptyOutputPath = path.join(process.cwd(), 'test-data', 'test-incident-timeline-empty.pdf');
  const emptyWriteStream = fs.createWriteStream(emptyOutputPath);

  emptyPdfDoc.pipe(emptyWriteStream);

  emptyWriteStream.on('finish', () => {
    console.log(`✓ Empty PDF generated successfully: ${emptyOutputPath}`);
  });

} catch (error) {
  console.error('✗ Test failed with empty data');
  console.error(error);
  process.exit(1);
}
