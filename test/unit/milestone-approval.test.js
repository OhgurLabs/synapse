import { strict as assert } from 'assert';
import { mkdtempSync, rmSync } from 'fs';
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

console.log('test/unit/milestone-approval.test.js');

function createTestSetup() {
  const testDir = mkdtempSync(join(tmpdir(), 'milestone-approval-test-'));
  const stateManager = new StateManager(testDir);
  stateManager.init();

  const campaignManager = new CampaignManager(stateManager);
  const projectId = 'test-project';
  stateManager.createProject(projectId, { displayName: 'Test Project' });

  return { testDir, stateManager, campaignManager, projectId };
}

function cleanup(setup) {
  try {
    rmSync(setup.testDir, { recursive: true, force: true });
  } catch {}
}

function createApprovalFixture(campaignManager, projectId) {
  const campaign = campaignManager.createCampaign(projectId, {
    title: 'Approval Workflow Campaign',
    description: 'Covers approval workflow lifecycle',
  });

  const milestone = campaignManager.addMilestone(projectId, campaign.id, {
    title: 'Protected Milestone',
    requireApproval: true,
  });

  return { campaign, milestone };
}

function getMilestone(campaignManager, projectId, campaignId, milestoneId) {
  return campaignManager.getCampaign(projectId, campaignId).milestones.find(m => m.id === milestoneId);
}

async function runTests() {
  await test('requestApproval pauses milestone and marks campaign awaiting approval', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      campaignManager.requestApproval(
        projectId,
        campaign.id,
        milestone.id,
        'Operator review required before execution',
        'agent-reviewer'
      );

      const refreshedCampaign = campaignManager.getCampaign(projectId, campaign.id);
      const refreshedMilestone = refreshedCampaign.milestones.find(m => m.id === milestone.id);

      assert.equal(refreshedMilestone.status, 'waiting_approval');
      assert.equal(refreshedMilestone.approvalState, 'pending');
      assert.equal(refreshedMilestone.approverId, null);
      assert.equal(refreshedMilestone.approvalReason, 'Operator review required before execution');
      assert.ok(refreshedMilestone.approvalRequestedAt, 'approvalRequestedAt should be set');
      assert.equal(refreshedCampaign.status, 'awaiting_approval');
    } finally {
      cleanup(setup);
    }
  });

  await test('approveMilestone resumes a waiting milestone back to active', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Ready for operator approval', 'system');
      campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Approved for execution', 'operator-alice');

      const refreshedCampaign = campaignManager.getCampaign(projectId, campaign.id);
      const refreshedMilestone = refreshedCampaign.milestones.find(m => m.id === milestone.id);

      assert.equal(refreshedMilestone.status, 'active');
      assert.equal(refreshedMilestone.approvalState, 'approved');
      assert.equal(refreshedMilestone.approverId, 'operator-alice');
      assert.equal(refreshedMilestone.approvalReason, 'Approved for execution');
      assert.equal(refreshedCampaign.status, 'active');
    } finally {
      cleanup(setup);
    }
  });

  await test('rejectMilestone returns a waiting milestone back to pending', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Needs operator review', 'system');
      campaignManager.rejectMilestone(projectId, campaign.id, milestone.id, 'Rejected pending revisions', 'operator-bob');

      const refreshedCampaign = campaignManager.getCampaign(projectId, campaign.id);
      const refreshedMilestone = refreshedCampaign.milestones.find(m => m.id === milestone.id);

      assert.equal(refreshedMilestone.status, 'pending');
      assert.equal(refreshedMilestone.approvalState, 'rejected');
      assert.equal(refreshedMilestone.approverId, 'operator-bob');
      assert.equal(refreshedMilestone.approvalReason, 'Rejected pending revisions');
      assert.equal(refreshedCampaign.status, 'active');
    } finally {
      cleanup(setup);
    }
  });

  await test('requestApproval rejects milestones that do not require approval', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const campaign = campaignManager.createCampaign(projectId, {
        title: 'Legacy Campaign',
        description: 'Milestone does not require approval',
      });
      const milestone = campaignManager.addMilestone(projectId, campaign.id, {
        title: 'Legacy Milestone',
      });

      assert.throws(
        () => campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Should fail', 'tester'),
        /does not require approval/
      );
    } finally {
      cleanup(setup);
    }
  });

  await test('requestApproval rejects invalid milestone state transitions', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      campaignManager.updateMilestoneStatus(projectId, campaign.id, milestone.id, 'active', 'Start gated work');
      campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Approved after activation', 'operator');
      campaignManager.updateMilestoneStatus(projectId, campaign.id, milestone.id, 'completed', 'Done');

      assert.throws(
        () => campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Cannot reopen completed milestone', 'tester'),
        /Invalid milestone transition|cannot transition/i
      );
    } finally {
      cleanup(setup);
    }
  });

  await test('approveMilestone rejects milestones not waiting for approval', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      assert.throws(
        () => campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Should fail', 'operator'),
        /is not waiting for approval/
      );
    } finally {
      cleanup(setup);
    }
  });

  await test('approveMilestone rejects waiting milestones whose approvalState is not pending', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Waiting for first review', 'system');
      campaignManager._saveWithRetry(projectId, (data) => {
        const targetCampaign = data.campaigns.find(c => c.id === campaign.id);
        const targetMilestone = targetCampaign.milestones.find(m => m.id === milestone.id);
        targetMilestone.approvalState = 'approved';
        return data;
      });

      assert.throws(
        () => campaignManager.approveMilestone(projectId, campaign.id, milestone.id, 'Should fail second approval', 'operator'),
        /approvalState is not 'pending'/
      );
    } finally {
      cleanup(setup);
    }
  });

  await test('rejectMilestone rejects milestones not waiting for approval', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      assert.throws(
        () => campaignManager.rejectMilestone(projectId, campaign.id, milestone.id, 'Should fail', 'operator'),
        /is not waiting for approval/
      );
    } finally {
      cleanup(setup);
    }
  });

  await test('rejectMilestone can reject a milestone that was already awaiting approval before requestApproval is called again', () => {
    const setup = createTestSetup();
    try {
      const { campaignManager, projectId } = setup;
      const { campaign, milestone } = createApprovalFixture(campaignManager, projectId);

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Initial review', 'system');
      const waitingMilestone = getMilestone(campaignManager, projectId, campaign.id, milestone.id);
      assert.equal(waitingMilestone.status, 'waiting_approval');

      campaignManager.requestApproval(projectId, campaign.id, milestone.id, 'Repeated request should stay waiting', 'system');
      campaignManager.rejectMilestone(projectId, campaign.id, milestone.id, 'Need another iteration', 'operator');

      const refreshedMilestone = getMilestone(campaignManager, projectId, campaign.id, milestone.id);
      assert.equal(refreshedMilestone.status, 'pending');
      assert.equal(refreshedMilestone.approvalState, 'rejected');
    } finally {
      cleanup(setup);
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
}).finally(() => {
  process.env.SYNAPSE_LOG_LEVEL = savedLogLevel;
});
