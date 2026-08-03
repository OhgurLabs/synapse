import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CampaignManager } from '../../src/campaigns.js';
import { StateManager } from '../../src/state.js';

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

console.log('test/unit/approval-audit-trail.test.js');

function createTestSetup() {
  const testDir = mkdtempSync(join(tmpdir(), 'approval-audit-trail-test-'));
  return { testDir };
}

function createCampaignManager(testDir, projectId) {
  const stateManager = new StateManager(testDir);
  stateManager.init();
  const campaignManager = new CampaignManager(stateManager);
  stateManager.createProject(projectId, { displayName: 'Test Project' });
  return { stateManager, campaignManager };
}

async function runTests() {
  const { testDir } = createTestSetup();

  try {
    await test('_appendEvent writes approval_requested event with correct schema', () => {
      const projectId = 'test-project-schema';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for audit trail tests',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Testing approval request', 'test-operator');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      assert.ok(existsSync(eventsPath), `Events file should exist at ${eventsPath}`);

      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      assert.ok(lines.length > 0, 'Should have at least one event');

      const event = JSON.parse(lines[lines.length - 1]);
      assert.strictEqual(event.action, 'approval_requested', 'Action should be approval_requested');
      assert.strictEqual(event.campaignId, campaign.id, 'Campaign ID should match');
      assert.strictEqual(event.milestoneId, milestone.id, 'Milestone ID should match');
      assert.strictEqual(event.agent, 'test-operator', 'Agent should match operator ID');
      assert.strictEqual(event.reason, 'Testing approval request', 'Reason should match');
      assert.ok(event.eventId, 'Should have eventId');
      assert.ok(event.timestamp, 'Should have timestamp');
      assert.strictEqual(event.project, projectId, 'Project should match');
      assert.ok(event.schemaVersion, 'Should have schemaVersion');
    });

    await test('_appendEvent writes approval_granted event with correct schema', () => {
      const projectId = 'test-project-granted';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for approval granted tests',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting for approval', 'system');
      campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Approved by operator', 'approver-user');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      const approvalGrantedEvent = lines.map(l => JSON.parse(l)).find(e => e.action === 'approval_granted');
      assert.ok(approvalGrantedEvent, 'Should find approval_granted event');
      assert.strictEqual(approvalGrantedEvent.action, 'approval_granted', 'Action should be approval_granted');
      assert.strictEqual(approvalGrantedEvent.campaignId, campaign.id, 'Campaign ID should match');
      assert.strictEqual(approvalGrantedEvent.milestoneId, milestone.id, 'Milestone ID should match');
      assert.strictEqual(approvalGrantedEvent.agent, 'approver-user', 'Agent should be the approver');
      assert.strictEqual(approvalGrantedEvent.reason, 'Approved by operator', 'Reason should match');
      assert.ok(approvalGrantedEvent.eventId, 'Should have eventId');
      assert.ok(approvalGrantedEvent.timestamp, 'Should have timestamp');
      assert.strictEqual(approvalGrantedEvent.project, projectId, 'Project should match');
    });

    await test('_appendEvent writes approval_rejected event with correct schema', () => {
      const projectId = 'test-project-rejected';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for approval rejected tests',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting for approval', 'system');
      campaignManager.rejectMilestone(projectId, campaign.id, milestone.id, 'Needs revision', 'reviewer-user');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      const approvalRejectedEvent = lines.map(l => JSON.parse(l)).find(e => e.action === 'approval_rejected');
      assert.ok(approvalRejectedEvent, 'Should find approval_rejected event');
      assert.strictEqual(approvalRejectedEvent.action, 'approval_rejected', 'Action should be approval_rejected');
      assert.strictEqual(approvalRejectedEvent.campaignId, campaign.id, 'Campaign ID should match');
      assert.strictEqual(approvalRejectedEvent.milestoneId, milestone.id, 'Milestone ID should match');
      assert.strictEqual(approvalRejectedEvent.agent, 'reviewer-user', 'Agent should be the reviewer');
      assert.strictEqual(approvalRejectedEvent.reason, 'Needs revision', 'Reason should match');
      assert.ok(approvalRejectedEvent.eventId, 'Should have eventId');
      assert.ok(approvalRejectedEvent.timestamp, 'Should have timestamp');
      assert.strictEqual(approvalRejectedEvent.project, projectId, 'Project should match');
    });

    await test('approval_requested event includes all required schema fields', () => {
      const projectId = 'test-project-fields';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for field validation',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Field test', 'test-agent');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const event = JSON.parse(lines[lines.length - 1]);

      const requiredFields = ['eventId', 'timestamp', 'project', 'action', 'campaignId', 'milestoneId', 'agent', 'reason'];
      for (const field of requiredFields) {
        assert.ok(field in event, `Event should have ${field} field`);
      }

      assert.strictEqual(typeof event.eventId, 'string', 'eventId should be string');
      assert.strictEqual(typeof event.timestamp, 'string', 'timestamp should be string');
      assert.strictEqual(typeof event.project, 'string', 'project should be string');
      assert.strictEqual(typeof event.action, 'string', 'action should be string');
      assert.strictEqual(typeof event.campaignId, 'string', 'campaignId should be string');
      assert.strictEqual(typeof event.milestoneId, 'string', 'milestoneId should be string');
      assert.strictEqual(typeof event.agent, 'string', 'agent should be string');
      assert.strictEqual(typeof event.reason, 'string', 'reason should be string');
    });

    await test('approval_granted event includes all required schema fields', () => {
      const projectId = 'test-project-granted-fields';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for granted field validation',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting', 'system');
      campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Approved', 'approver');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const event = lines.map(l => JSON.parse(l)).find(e => e.action === 'approval_granted');

      const requiredFields = ['eventId', 'timestamp', 'project', 'action', 'campaignId', 'milestoneId', 'agent', 'reason'];
      for (const field of requiredFields) {
        assert.ok(field in event, `Event should have ${field} field`);
      }
    });

    await test('approval_rejected event includes all required schema fields', () => {
      const projectId = 'test-project-rejected-fields';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for rejected field validation',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting', 'system');
      campaignManager.rejectMilestone(projectId, campaign.id, milestone.id, 'Rejected', 'rejector');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const event = lines.map(l => JSON.parse(l)).find(e => e.action === 'approval_rejected');

      const requiredFields = ['eventId', 'timestamp', 'project', 'action', 'campaignId', 'milestoneId', 'agent', 'reason'];
      for (const field of requiredFields) {
        assert.ok(field in event, `Event should have ${field} field`);
      }
    });

    await test('events are written to campaign-events.jsonl file', () => {
      const projectId = 'test-project-file';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for file path test',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Test', 'test-agent');

      const expectedPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      assert.ok(existsSync(expectedPath), 'Events should be written to campaign-events.jsonl');
    });

    await test('multiple approval events are appended correctly', () => {
      const projectId = 'test-project-multiple';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for multiple events test',
      });

      const ms1 = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Milestone 1',
        requireApproval: true,
      });
      const ms2 = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Milestone 2',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, ms1.id, 'Request 1', 'agent1');
      campaignManager.approveMilestone(projectId, campaign.id, ms1.id, 'Approve 1', 'approver1');
      campaignManager.requestApproval(projectId, campaign.id, ms2.id, 'Request 2', 'agent2');
      campaignManager.rejectMilestone(projectId, campaign.id, ms2.id, 'Reject 2', 'rejector2');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      const events = lines.map(l => JSON.parse(l));
      const approvalEvents = events.filter(e =>
        e.action === 'approval_requested' ||
        e.action === 'approval_granted' ||
        e.action === 'approval_rejected'
      );

      assert.strictEqual(approvalEvents.length, 4, 'Should have 4 approval events');
      assert.strictEqual(approvalEvents[0].action, 'approval_requested', 'First event should be approval_requested');
      assert.strictEqual(approvalEvents[1].action, 'approval_granted', 'Second event should be approval_granted');
      assert.strictEqual(approvalEvents[2].action, 'approval_requested', 'Third event should be approval_requested');
      assert.strictEqual(approvalEvents[3].action, 'approval_rejected', 'Fourth event should be approval_rejected');
    });

    await test('eventId is unique for each event', () => {
      const projectId = 'test-project-unique';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for unique eventId test',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Test 1', 'agent1');
      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Test 2', 'agent2');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const events = lines.map(l => JSON.parse(l));

      const eventIds = events.map(e => e.eventId);
      const uniqueIds = new Set(eventIds);
      assert.strictEqual(uniqueIds.size, eventIds.length, 'All eventIds should be unique');
    });

    await test('timestamp is ISO 8601 format', () => {
      const projectId = 'test-project-timestamp';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for timestamp test',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Test', 'agent');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const event = JSON.parse(lines[lines.length - 1]);

      const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      assert.ok(iso8601Regex.test(event.timestamp), 'Timestamp should be ISO 8601 format');

      const date = new Date(event.timestamp);
      assert.ok(!isNaN(date.getTime()), 'Timestamp should be a valid date');
    });

    await test('default agent is system when userId is null', () => {
      const projectId = 'test-project-default-agent';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for default agent test',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Test', null);

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const event = JSON.parse(lines[lines.length - 1]);

      assert.strictEqual(event.agent, 'system', 'Default agent should be system');
    });

    await test('approval_granted event is logged after approveMilestone', () => {
      const projectId = 'test-project-granted-log';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for granted log test',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting', 'system');
      campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Approved', 'approver');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const events = lines.map(l => JSON.parse(l));

      const grantedEvent = events.find(e => e.action === 'approval_granted');
      assert.ok(grantedEvent, 'Should find approval_granted event');
      assert.strictEqual(grantedEvent.agent, 'approver', 'Agent should be the approver');
      assert.strictEqual(grantedEvent.reason, 'Approved', 'Reason should match');
    });

    await test('approval_rejected event is logged after rejectMilestone', () => {
      const projectId = 'test-project-rejected-log';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for rejected log test',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting', 'system');
      campaignManager.rejectMilestone(projectId, campaign.id, milestone.id, 'Rejected', 'rejector');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const events = lines.map(l => JSON.parse(l));

      const rejectedEvent = events.find(e => e.action === 'approval_rejected');
      assert.ok(rejectedEvent, 'Should find approval_rejected event');
      assert.strictEqual(rejectedEvent.agent, 'rejector', 'Agent should be the rejector');
      assert.strictEqual(rejectedEvent.reason, 'Rejected', 'Reason should match');
    });

    await test('campaign status change events are logged on approval/rejection', () => {
      const projectId = 'test-project-status-change';
      const { campaignManager, stateManager } = createCampaignManager(testDir, projectId);

      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Test Campaign',
        description: 'Campaign for status change test',
      });

      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Test Milestone',
        requireApproval: true,
      });

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting', 'system');
      campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Approved', 'approver');

      const eventsPath = join(stateManager.projectsDir, projectId, 'campaign-events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const events = lines.map(l => JSON.parse(l));

      const statusChangeEvents = events.filter(e => e.action === 'campaign_status_changed');
      assert.ok(statusChangeEvents.length > 0, 'Should have campaign status change events');
    });

  } finally {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    process.env.SYNAPSE_LOG_LEVEL = savedLogLevel;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.env.SYNAPSE_LOG_LEVEL = savedLogLevel;
  process.exit(1);
});
