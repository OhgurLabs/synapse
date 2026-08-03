import { strict as assert } from 'assert';
import { parseCampaignCommand } from '../../src/campaigns.js';

const savedLogLevel = process.env.SYNAPSE_LOG_LEVEL;
process.env.SYNAPSE_LOG_LEVEL = 'error';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
    if (err.stack) console.log('    ' + err.stack.split('\n').slice(1, 3).join('\n    '));
  }
}

console.log('test/unit/campaign-command-parser.test.js');

async function runTests() {
  await test('parseCampaignCommand parses /approve milestoneId', () => {
    const result = parseCampaignCommand('/approve ms_1234567890_abc123');
    assert.ok(result, 'Should return a result');
    assert.strictEqual(result.command, 'approve', 'Command should be approve');
    assert.strictEqual(result.args.milestoneId, 'ms_1234567890_abc123', 'Milestone ID should match');
    assert.strictEqual(result.args.projectId, null, 'Project ID should be null when not provided');
  });

  await test('parseCampaignCommand parses /approve milestoneId --project projectId', () => {
    const result = parseCampaignCommand('/approve ms_1234567890_abc123 --project proj-456');
    assert.ok(result, 'Should return a result');
    assert.strictEqual(result.command, 'approve', 'Command should be approve');
    assert.strictEqual(result.args.milestoneId, 'ms_1234567890_abc123', 'Milestone ID should match');
    assert.strictEqual(result.args.projectId, 'proj-456', 'Project ID should match');
  });

  await test('parseCampaignCommand parses /campaign approve milestoneId', () => {
    const result = parseCampaignCommand('/campaign approve ms_1234567890_abc123');
    assert.ok(result, 'Should return a result');
    assert.strictEqual(result.command, 'approve', 'Command should be approve');
    assert.strictEqual(result.args.milestoneId, 'ms_1234567890_abc123', 'Milestone ID should match');
    assert.strictEqual(result.args.projectId, null, 'Project ID should be null when not provided');
  });

  await test('parseCampaignCommand parses /campaign approve milestoneId --project projectId', () => {
    const result = parseCampaignCommand('/campaign approve ms_1234567890_abc123 --project proj-789');
    assert.ok(result, 'Should return a result');
    assert.strictEqual(result.command, 'approve', 'Command should be approve');
    assert.strictEqual(result.args.milestoneId, 'ms_1234567890_abc123', 'Milestone ID should match');
    assert.strictEqual(result.args.projectId, 'proj-789', 'Project ID should match');
  });

  await test('parseCampaignCommand validates milestoneId format for /approve', () => {
    const result = parseCampaignCommand('/approve');
    assert.strictEqual(result, null, 'Should return null when milestoneId is missing');
  });

  await test('parseCampaignCommand validates milestoneId format for /campaign approve', () => {
    const result = parseCampaignCommand('/campaign approve');
    assert.strictEqual(result, null, 'Should return null when milestoneId is missing');
  });

  await test('parseCampaignCommand returns null for invalid milestoneId with extra args', () => {
    const result = parseCampaignCommand('/approve ms_123 extra-args');
    assert.strictEqual(result, null, 'Should return null for malformed /approve command');
  });

  await test('parseCampaignCommand handles milestoneId with underscores and hyphens', () => {
    const result = parseCampaignCommand('/approve ms_1775183352250_2a9667db');
    assert.ok(result, 'Should return a result');
    assert.strictEqual(result.args.milestoneId, 'ms_1775183352250_2a9667db', 'Milestone ID should match');
  });

  await test('parseCampaignCommand handles projectId with underscores and hyphens', () => {
    const result = parseCampaignCommand('/approve ms_123 --project my-project_123');
    assert.ok(result, 'Should return a result');
    assert.strictEqual(result.args.projectId, 'my-project_123', 'Project ID should match');
  });

  await test('parseCampaignCommand ignores case for /campaign subcommand', () => {
    const result1 = parseCampaignCommand('/campaign APPROVE ms_123');
    const result2 = parseCampaignCommand('/campaign Approve ms_123');
    assert.strictEqual(result1.command, 'approve', 'Should handle uppercase APPROVE');
    assert.strictEqual(result2.command, 'approve', 'Should handle mixed case Approve');
  });

  await test('parseCampaignCommand parses /campaign list', () => {
    const result = parseCampaignCommand('/campaign list');
    assert.strictEqual(result.command, 'list', 'Command should be list');
    assert.strictEqual(result.args, null, 'Args should be null for list');
  });

  await test('parseCampaignCommand parses /campaign alone as list', () => {
    const result = parseCampaignCommand('/campaign');
    assert.strictEqual(result.command, 'list', 'Command should be list');
    assert.strictEqual(result.args, null, 'Args should be null for list');
  });

  await test('parseCampaignCommand parses other valid commands', () => {
    const commands = ['create', 'show', 'inject', 'pause', 'resume', 'milestone', 'status', 'decompose', 'replay'];
    for (const cmd of commands) {
      const result = parseCampaignCommand(`/campaign ${cmd}`);
      assert.strictEqual(result.command, cmd, `Command ${cmd} should be parsed correctly`);
    }
  });

  await test('parseCampaignCommand returns null for invalid commands', () => {
    const result = parseCampaignCommand('/campaign invalidcmd');
    assert.strictEqual(result, null, 'Should return null for invalid command');
  });

  await test('parseCampaignCommand returns null for non-campaign text', () => {
    const result = parseCampaignCommand('some random text');
    assert.strictEqual(result, null, 'Should return null for non-campaign text');
  });

  await test('parseCampaignCommand handles whitespace trimming', () => {
    const result = parseCampaignCommand('  /approve ms_123  ');
    assert.ok(result, 'Should handle leading/trailing whitespace');
    assert.strictEqual(result.args.milestoneId, 'ms_123', 'Milestone ID should be extracted');
  });

  await test('parseCampaignCommand handles /approve with --project but no projectId value', () => {
    const result = parseCampaignCommand('/approve ms_123 --project');
    assert.strictEqual(result, null, 'Should return null when --project has no value');
  });

  await test('parseCampaignCommand handles /campaign approve with --project but no projectId value', () => {
    const result = parseCampaignCommand('/campaign approve ms_123 --project');
    assert.strictEqual(result, null, 'Should return null when --project has no value');
  });

  await test('parseCampaignCommand milestoneId is captured as non-whitespace token', () => {
    const milestoneId = 'ms_123456789012345_abcdef12';
    const result = parseCampaignCommand(`/approve ${milestoneId}`);
    assert.strictEqual(result.args.milestoneId, milestoneId, 'Full milestone ID should be captured');
  });

  await test('parseCampaignCommand handles projectId with numbers', () => {
    const result = parseCampaignCommand('/approve ms_123 --project project123');
    assert.strictEqual(result.args.projectId, 'project123', 'Project ID with numbers should work');
  });

  await test('parseCampaignCommand validates --project flag format', () => {
    const result = parseCampaignCommand('/approve ms_123 --project=proj1');
    assert.strictEqual(result, null, 'Should return null for --project= format (not supported)');
  });

  await test('parseCampaignCommand handles multiple spaces between tokens', () => {
    const result = parseCampaignCommand('/approve   ms_123   --project   proj1');
    assert.ok(result, 'Should handle multiple spaces between tokens');
    assert.strictEqual(result.args.milestoneId, 'ms_123', 'Milestone ID should be extracted');
    assert.strictEqual(result.args.projectId, 'proj1', 'Project ID should be extracted');
  });

  await test('parseCampaignCommand /approve standalone returns null', () => {
    const result = parseCampaignCommand('/approve');
    assert.strictEqual(result, null, 'Standalone /approve without milestoneId should return null');
  });

  await test('parseCampaignCommand preserves milestoneId exactly as provided', () => {
    const testCases = [
      'ms_123',
      'ms_1775183352250_2a9667db',
      'milestone_abc123',
      'ms_test-123',
    ];
    for (const msId of testCases) {
      const result = parseCampaignCommand(`/approve ${msId}`);
      assert.strictEqual(result.args.milestoneId, msId, `Milestone ID ${msId} should be preserved exactly`);
    }
  });

  await test('parseCampaignCommand handles edge case: milestoneId starting with numbers', () => {
    const result = parseCampaignCommand('/approve 123ms_abc');
    assert.ok(result, 'Should handle milestoneId starting with numbers');
    assert.strictEqual(result.args.milestoneId, '123ms_abc', 'Milestone ID should be captured');
  });

  await test('parseCampaignCommand handles edge case: very long milestoneId', () => {
    const longId = 'ms_' + 'a'.repeat(100);
    const result = parseCampaignCommand(`/approve ${longId}`);
    assert.ok(result, 'Should handle very long milestoneId');
    assert.strictEqual(result.args.milestoneId, longId, 'Long milestone ID should be captured');
  });

  await test('parseCampaignCommand handles edge case: empty string input', () => {
    const result = parseCampaignCommand('');
    assert.strictEqual(result, null, 'Empty string should return null');
  });

  await test('parseCampaignCommand handles edge case: whitespace only input', () => {
    const result = parseCampaignCommand('   ');
    assert.strictEqual(result, null, 'Whitespace only should return null');
  });

  await test('parseCampaignCommand handles /campaign with no subcommand', () => {
    const result = parseCampaignCommand('/campaign');
    assert.strictEqual(result.command, 'list', 'Should default to list command');
  });

  await test('parseCampaignCommand handles /campaign with trailing whitespace', () => {
    const result = parseCampaignCommand('/campaign   ');
    assert.strictEqual(result.command, 'list', 'Should default to list command with trailing whitespace');
  });

  await test('parseCampaignCommand validates milestoneId is a single token', () => {
    const result = parseCampaignCommand('/approve ms_123 ms_456');
    assert.strictEqual(result, null, 'Should return null when milestoneId has multiple tokens');
  });

  await test('parseCampaignCommand handles --project flag case sensitivity', () => {
    const result = parseCampaignCommand('/approve ms_123 --Project proj1');
    assert.strictEqual(result, null, 'Should return null for --Project (case sensitive)');
  });

  await test('parseCampaignCommand extracts projectId correctly with different formats', () => {
    const testCases = [
      { input: '/approve ms_123 --project proj1', expected: 'proj1' },
      { input: '/approve ms_123 --project project-123', expected: 'project-123' },
      { input: '/approve ms_123 --project my_project', expected: 'my_project' },
      { input: '/approve ms_123 --project PROJECT123', expected: 'PROJECT123' },
    ];
    for (const { input, expected } of testCases) {
      const result = parseCampaignCommand(input);
      assert.strictEqual(result.args.projectId, expected, `Project ID should be ${expected}`);
    }
  });

  await test('parseCampaignCommand /campaign approve extracts args correctly', () => {
    const result = parseCampaignCommand('/campaign approve ms_123456 --project test-project');
    assert.strictEqual(result.command, 'approve', 'Command should be approve');
    assert.strictEqual(result.args.milestoneId, 'ms_123456', 'Milestone ID should match');
    assert.strictEqual(result.args.projectId, 'test-project', 'Project ID should match');
  });

  await test('parseCampaignCommand handles special characters in projectId', () => {
    const result = parseCampaignCommand('/approve ms_123 --project proj_123-test');
    assert.strictEqual(result.args.projectId, 'proj_123-test', 'Project ID with special chars should work');
  });

  await test('parseCampaignCommand validates complete /approve command structure', () => {
    const completeCmd = '/approve ms_1775183352250_2a9667db --project my-project';
    const result = parseCampaignCommand(completeCmd);
    assert.ok(result, 'Should parse complete command');
    assert.strictEqual(result.command, 'approve', 'Command should be approve');
    assert.strictEqual(result.args.milestoneId, 'ms_1775183352250_2a9667db', 'Milestone ID should match');
    assert.strictEqual(result.args.projectId, 'my-project', 'Project ID should match');
  });

  await test('parseCampaignCommand validates complete /campaign approve command structure', () => {
    const completeCmd = '/campaign approve ms_1775183352250_2a9667db --project my-project';
    const result = parseCampaignCommand(completeCmd);
    assert.ok(result, 'Should parse complete command');
    assert.strictEqual(result.command, 'approve', 'Command should be approve');
    assert.strictEqual(result.args.milestoneId, 'ms_1775183352250_2a9667db', 'Milestone ID should match');
    assert.strictEqual(result.args.projectId, 'my-project', 'Project ID should match');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.env.SYNAPSE_LOG_LEVEL = savedLogLevel;
  process.exit(1);
});
