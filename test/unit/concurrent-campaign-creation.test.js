import { strict as assert } from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTestCampaign, createTestMilestone } from '../integration/concurrent-campaign-tester.js';
import { StateManager } from '../../src/state.js';
import { CampaignManager } from '../../src/campaigns.js';
import { createSessionManager } from '../../src/orchestrator/session.js';

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

console.log('test/unit/concurrent-campaign-creation.test.js');

function createTestSetup() {
  const testDir = mkdtempSync(join(tmpdir(), 'concurrent-campaign-creation-test-'));
  const projectDir = join(testDir, 'projects', 'test-project');
  rmSync(projectDir, { recursive: true, force: true });

  const stateManager = new StateManager(testDir);
  stateManager.init();

  const campaignManager = new CampaignManager(stateManager);

  const sessionManager = createSessionManager({
    config: { maxTurns: 50 },
    rateLimiter: {
      isLimited: () => false,
      registerSessionCallback: () => {},
    },
    thinkingAgents: new Map(),
    busyAgents: new Map(),
  });

  return { testDir, projectDir, stateManager, campaignManager, sessionManager };
}

function cleanup(setup) {
  try {
    rmSync(setup.testDir, { recursive: true, force: true });
  } catch {}
}

function createProjectEnv(setup, projectId = 'test-project') {
  const { stateManager, campaignManager, projectDir, sessionManager } = setup;
  
  if (!stateManager.getProject(projectId)) {
    stateManager.createProject(projectId, {
      displayName: `Test Project ${projectId}`,
      projectDir,
    });
  }

  return {
    projectId,
    testDir: setup.testDir,
    projectDir,
    stateManager,
    campaignManager,
    sessionManager,
  };
}

async function runTests() {
  await test('createTestCampaign creates campaign with default values', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);

      assert.ok(campaign.id, 'Campaign should have an ID');
      assert.ok(campaign.id.startsWith('campaign_'), 'Campaign ID should start with campaign_');
      assert.strictEqual(campaign.title, `Test Campaign ${env.projectId}`, 'Title should use default');
      assert.strictEqual(campaign.doneCriteria, 'Campaign completion criteria', 'Done criteria should use default');
      assert.strictEqual(campaign.type, 'standard', 'Type should default to standard');
      assert.strictEqual(campaign.priority, 'normal', 'Priority should default to normal');
      assert.strictEqual(campaign.status, 'active', 'Status should be active');
      assert.ok(campaign.createdAt, 'CreatedAt should be set');
      assert.ok(campaign.updatedAt, 'UpdatedAt should be set');
      assert.strictEqual(campaign.milestones.length, 0, 'Should have no milestones initially');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign allows custom campaign configuration', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Custom Campaign',
        doneCriteria: 'Custom completion criteria',
        type: 'evergreen',
        priority: 'critical',
      });

      assert.strictEqual(campaign.title, 'Custom Campaign', 'Title should be custom');
      assert.strictEqual(campaign.doneCriteria, 'Custom completion criteria', 'Done criteria should be custom');
      assert.strictEqual(campaign.type, 'evergreen', 'Type should be evergreen');
      assert.strictEqual(campaign.priority, 'critical', 'Priority should be critical');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign normalizes invalid priority to valid values', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Priority Test',
        priority: 'high',
      });

      assert.strictEqual(campaign.priority, 'critical', 'high should normalize to critical');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign normalizes medium priority to normal', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Priority Test',
        priority: 'medium',
      });

      assert.strictEqual(campaign.priority, 'normal', 'medium should normalize to normal');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign normalizes low priority to normal', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Priority Test',
        priority: 'low',
      });

      assert.strictEqual(campaign.priority, 'normal', 'low should normalize to normal');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign creates socratic campaign with domain', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Socratic Campaign',
        type: 'socratic',
        domain: 'machine-learning',
      });

      assert.strictEqual(campaign.type, 'socratic', 'Type should be socratic');
      assert.strictEqual(campaign.domain, 'machine-learning', 'Domain should be set');
      assert.strictEqual(campaign.status, 'created', 'Socratic campaigns should start in created status');
      assert.ok(Array.isArray(campaign.questions), 'Questions should be an array');
      assert.strictEqual(campaign.questionCount, 0, 'Question count should be 0');
      assert.ok(campaign.socraticConfig, 'Socratic config should be set');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign throws error for socratic campaign without domain', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      
      assert.throws(
        () => createTestCampaign(env, {
          title: 'Socratic Campaign',
          type: 'socratic',
        }),
        /Socratic campaigns require a domain field/,
        'Should throw error about missing domain'
      );
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone creates milestone with default values', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id);

      assert.ok(milestone.id, 'Milestone should have an ID');
      assert.ok(milestone.id.startsWith('ms_'), 'Milestone ID should start with ms_');
      assert.strictEqual(milestone.title, 'Test Milestone', 'Title should use default');
      assert.strictEqual(milestone.doneCriteria, 'Milestone completion criteria', 'Done criteria should use default');
      assert.strictEqual(milestone.status, 'pending', 'Status should be pending');
      assert.strictEqual(milestone.requireApproval, false, 'requireApproval should default to false');
      assert.strictEqual(milestone.approvalState, null, 'approvalState should be null by default');
      assert.strictEqual(milestone.approverId, null, 'approverId should be null by default');
      assert.ok(milestone.createdAt, 'CreatedAt should be set');
      assert.ok(milestone.updatedAt, 'UpdatedAt should be set');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone allows custom milestone configuration', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Custom Milestone',
        doneCriteria: 'Custom criteria',
        order: 5,
        blockedBy: ['ms_other'],
      });

      assert.strictEqual(milestone.title, 'Custom Milestone', 'Title should be custom');
      assert.strictEqual(milestone.doneCriteria, 'Custom criteria', 'Done criteria should be custom');
      assert.strictEqual(milestone.order, 5, 'Order should be custom');
      assert.deepStrictEqual(milestone.blockedBy, ['ms_other'], 'BlockedBy should be custom');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone with requireApproval true sets approval flag', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Approval Milestone',
        requireApproval: true,
      });

      assert.strictEqual(milestone.requireApproval, true, 'requireApproval should be true');
      assert.strictEqual(milestone.approvalState, null, 'approvalState should be null initially');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone with requireApproval false defaults to false', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'No Approval Milestone',
        requireApproval: false,
      });

      assert.strictEqual(milestone.requireApproval, false, 'requireApproval should be false');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone without requireApproval flag defaults to false', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Legacy Milestone',
      });

      assert.strictEqual(milestone.requireApproval, false, 'requireApproval should default to false');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone adds milestone to campaign', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id);

      const refreshedCampaign = env.campaignManager.getCampaign(env.projectId, campaign.id);
      assert.strictEqual(refreshedCampaign.milestones.length, 1, 'Campaign should have 1 milestone');
      assert.strictEqual(refreshedCampaign.milestones[0].id, milestone.id, 'Milestone should be in campaign');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone throws error for non-existent campaign', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      
      assert.throws(
        () => createTestMilestone(env, 'non-existent-campaign'),
        /Campaign not found/,
        'Should throw error about campaign not found'
      );
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone with description uses provided description', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Milestone Title',
        description: 'Detailed description of the milestone',
      });

      assert.strictEqual(milestone.title, 'Milestone Title', 'Title should be set');
      assert.strictEqual(milestone.description, 'Detailed description of the milestone', 'Description should be set');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone without description defaults to title', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Milestone Title',
      });

      assert.strictEqual(milestone.description, 'Milestone Title', 'Description should default to title');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone with contingency stores contingency', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Milestone with Contingency',
        contingency: 'Fallback plan if milestone fails',
      });

      assert.strictEqual(milestone.contingency, 'Fallback plan if milestone fails', 'Contingency should be stored');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone without contingency defaults to null', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Milestone without Contingency',
      });

      assert.strictEqual(milestone.contingency, null, 'Contingency should be null');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone without order defaults to 0', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Milestone without Order',
      });

      assert.strictEqual(milestone.order, 0, 'Order should default to 0');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone without blockedBy defaults to empty array', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Milestone without BlockedBy',
      });

      assert.deepStrictEqual(milestone.blockedBy, [], 'BlockedBy should default to empty array');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone with approval gate has all approval fields initialized', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const milestone = createTestMilestone(env, campaign.id, {
        title: 'Approval Gate Milestone',
        requireApproval: true,
      });

      assert.strictEqual(milestone.requireApproval, true, 'requireApproval should be true');
      assert.strictEqual(milestone.approvalState, null, 'approvalState should be null');
      assert.strictEqual(milestone.approverId, null, 'approverId should be null');
      assert.strictEqual(milestone.approvalRequestedAt, null, 'approvalRequestedAt should be null');
      assert.strictEqual(milestone.approvalReason, null, 'approvalReason should be null');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign and createTestMilestone work together for approval workflow', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Approval Workflow Campaign',
        doneCriteria: 'Complete with approvals',
      });

      const milestone1 = createTestMilestone(env, campaign.id, {
        title: 'First Milestone',
        requireApproval: true,
        order: 1,
      });

      const milestone2 = createTestMilestone(env, campaign.id, {
        title: 'Second Milestone',
        requireApproval: false,
        order: 2,
        blockedBy: [milestone1.id],
      });

      const refreshedCampaign = env.campaignManager.getCampaign(env.projectId, campaign.id);
      
      assert.strictEqual(refreshedCampaign.milestones.length, 2, 'Campaign should have 2 milestones');
      assert.strictEqual(refreshedCampaign.milestones[0].id, milestone1.id, 'First milestone should be in order');
      assert.strictEqual(refreshedCampaign.milestones[1].id, milestone2.id, 'Second milestone should be in order');
      assert.strictEqual(refreshedCampaign.milestones[0].requireApproval, true, 'First milestone should require approval');
      assert.strictEqual(refreshedCampaign.milestones[1].requireApproval, false, 'Second milestone should not require approval');
      assert.deepStrictEqual(refreshedCampaign.milestones[1].blockedBy, [milestone1.id], 'Second milestone should be blocked by first');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign with multiple milestones maintains milestone order', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);

      const ms1 = createTestMilestone(env, campaign.id, { title: 'First', order: 1 });
      const ms2 = createTestMilestone(env, campaign.id, { title: 'Second', order: 2 });
      const ms3 = createTestMilestone(env, campaign.id, { title: 'Third', order: 3 });

      const refreshedCampaign = env.campaignManager.getCampaign(env.projectId, campaign.id);
      
      assert.strictEqual(refreshedCampaign.milestones.length, 3, 'Should have 3 milestones');
      assert.strictEqual(refreshedCampaign.milestones[0].id, ms1.id, 'First milestone should be first');
      assert.strictEqual(refreshedCampaign.milestones[1].id, ms2.id, 'Second milestone should be second');
      assert.strictEqual(refreshedCampaign.milestones[2].id, ms3.id, 'Third milestone should be third');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign creates unique IDs for multiple campaigns', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign1 = createTestCampaign(env, { title: 'Campaign 1' });
      const campaign2 = createTestCampaign(env, { title: 'Campaign 2' });
      const campaign3 = createTestCampaign(env, { title: 'Campaign 3' });

      assert.notStrictEqual(campaign1.id, campaign2.id, 'Campaign 1 and 2 should have different IDs');
      assert.notStrictEqual(campaign2.id, campaign3.id, 'Campaign 2 and 3 should have different IDs');
      assert.notStrictEqual(campaign1.id, campaign3.id, 'Campaign 1 and 3 should have different IDs');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestMilestone creates unique IDs for multiple milestones', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env);
      const ms1 = createTestMilestone(env, campaign.id, { title: 'Milestone 1' });
      const ms2 = createTestMilestone(env, campaign.id, { title: 'Milestone 2' });
      const ms3 = createTestMilestone(env, campaign.id, { title: 'Milestone 3' });

      assert.notStrictEqual(ms1.id, ms2.id, 'Milestone 1 and 2 should have different IDs');
      assert.notStrictEqual(ms2.id, ms3.id, 'Milestone 2 and 3 should have different IDs');
      assert.notStrictEqual(ms1.id, ms3.id, 'Milestone 1 and 3 should have different IDs');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign with outputMode sets output mode correctly', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Research Campaign',
        outputMode: 'research',
      });

      assert.strictEqual(campaign.outputMode, 'research', 'Output mode should be research');
    } finally {
      cleanup(setup);
    }
  });

  await test('createTestCampaign with invalid outputMode defaults to implementation', () => {
    const setup = createTestSetup();
    try {
      const env = createProjectEnv(setup);
      const campaign = createTestCampaign(env, {
        title: 'Campaign',
        outputMode: 'invalid-mode',
      });

      assert.strictEqual(campaign.outputMode, 'implementation', 'Invalid output mode should default to implementation');
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
