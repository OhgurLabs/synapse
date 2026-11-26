// test/integration/concurrent-campaign-tester.js
// Concurrent campaign test harness with project isolation for cross-project isolation validation
// Supports running multiple campaigns in parallel across different projects and monitoring state leakage

import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StateManager } from '../../src/state.js';
import { CampaignManager } from '../../src/campaigns.js';
import { StateIsolationMonitor } from '../../src/test-utils/state-isolation-monitor.js';
import { createSessionManager } from '../../src/orchestrator/session.js';
import { createLogger } from '../../src/logger.js';

const log = createLogger('concurrent-campaign-tester');

// Suppress noise during tests
const savedLogLevel = process.env.SYNAPSE_LOG_LEVEL;
process.env.SYNAPSE_LOG_LEVEL = 'error';

let passed = 0;
let failed = 0;

// ─── Test harness ────────────────────────────────────────────────────

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
    if (err.stack) {
      console.log('    ' + err.stack.split('\n').slice(1, 3).join('\n    '));
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Create isolated test environment for a single project
 * @param {string} testDir - Base test directory
 * @param {string} projectId - Project identifier
 * @returns {Object} Test environment with StateManager, CampaignManager, and isolation monitor
 */
function createIsolatedProjectEnv(testDir, projectId) {
  const projectDir = join(testDir, 'projects', projectId);
  mkdirSync(projectDir, { recursive: true });

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

  const isolationMonitor = new StateIsolationMonitor(stateManager, {
    trackSessionLeakage: true,
    trackMemoryLeakage: true,
    trackFileSystemAccess: false,
    trackAgentContext: true,
    sessionManager,
  });

  return {
    projectId,
    testDir,
    projectDir,
    stateManager,
    campaignManager,
    isolationMonitor,
    sessionManager,
  };
}

/**
 * Create multiple isolated project environments
 * @param {string} baseTestDir - Base test directory
 * @param {string[]} projectIds - Array of project IDs to create
 * @returns {Map} Map of projectId -> project environment
 */
function createMultiProjectEnvs(baseTestDir, projectIds) {
  const envs = new Map();

  for (const projectId of projectIds) {
    const env = createIsolatedProjectEnv(baseTestDir, projectId);
    envs.set(projectId, env);
  }

  return envs;
}

/**
 * Create a test campaign in a project
 * @param {Object} projectEnv - Project environment
 * @param {Object} campaignConfig - Campaign configuration
 * @returns {Object} Created campaign
 */
function createTestCampaign(projectEnv, campaignConfig = {}) {
  const { stateManager, campaignManager, projectId } = projectEnv;

  if (!stateManager.getProject(projectId)) {
    stateManager.createProject(projectId, {
      displayName: `Test Project ${projectId}`,
      projectDir: projectEnv.projectDir,
    });
  }

  const defaultConfig = {
    title: `Test Campaign ${projectId}`,
    doneCriteria: 'Campaign completion criteria',
    type: 'standard',
    priority: 'normal',
  };

  const campaign = campaignManager.createCampaign(projectId, {
    ...defaultConfig,
    ...campaignConfig,
  });

  return campaign;
}

/**
 * Create a test milestone in a campaign
 * @param {Object} projectEnv - Project environment
 * @param {string} campaignId - Campaign ID
 * @param {Object} milestoneConfig - Milestone configuration
 * @returns {Object} Created milestone
 */
function createTestMilestone(projectEnv, campaignId, milestoneConfig = {}) {
  const { campaignManager, projectId } = projectEnv;

  const defaultConfig = {
    title: 'Test Milestone',
    doneCriteria: 'Milestone completion criteria',
    requireApproval: false,
  };

  return campaignManager.addMilestone(projectId, campaignId, {
    ...defaultConfig,
    ...milestoneConfig,
  });
}

/**
 * Concurrent campaign runner
 * Executes multiple campaigns in parallel across different projects
 * @param {Map} projectEnvs - Map of project environments
 * @param {Array} campaignSpecs - Array of campaign specifications
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} Execution results with isolation report
 */
async function runConcurrentCampaigns(projectEnvs, campaignSpecs, options = {}) {
  const {
    durationMs = 60000,
    monitorIntervalMs = 5000,
  } = options;

  const results = {
    campaigns: new Map(),
    startTime: Date.now(),
    endTime: null,
    isolationViolations: [],
    completed: false,
  };

  const promises = [];

  for (const spec of campaignSpecs) {
    const { projectId, campaignConfig, milestones } = spec;
    const env = projectEnvs.get(projectId);

    if (!env) {
      throw new Error(`Project environment not found: ${projectId}`);
    }

    const campaignPromise = (async () => {
      await env.isolationMonitor.startMonitoring();

      try {
        const campaign = createTestCampaign(env, campaignConfig);
        results.campaigns.set(campaign.id, {
          campaignId: campaign.id,
          projectId,
          status: 'created',
          milestones: [],
        });

        if (milestones && milestones.length > 0) {
          for (const msConfig of milestones) {
            const milestone = createTestMilestone(env, campaign.id, msConfig);
            results.campaigns.get(campaign.id).milestones.push({
              milestoneId: milestone.id,
              status: milestone.status,
            });
          }
        }

        results.campaigns.get(campaign.id).status = 'completed';
        return campaign;
      } catch (err) {
        results.campaigns.forEach(c => {
          if (c.projectId === projectId) {
            c.status = 'failed';
            c.error = err.message;
          }
        });
        throw err;
      } finally {
        const violations = await env.isolationMonitor.stopMonitoring();
        if (violations.length > 0) {
          results.isolationViolations.push({
            projectId,
            violations,
            timestamp: new Date().toISOString(),
          });
        }
      }
    })();

    promises.push(campaignPromise);
  }

  const monitoringPromise = (async () => {
    const startTime = Date.now();
    
    while (Date.now() - startTime < durationMs) {
      await new Promise(resolve => setTimeout(resolve, monitorIntervalMs));

      for (const [projectId, env] of projectEnvs) {
        const snapshot = env.isolationMonitor.captureSnapshot();
        const violations = env.isolationMonitor.detectLeakage(snapshot);

        if (violations.length > 0) {
          results.isolationViolations.push({
            projectId,
            violations,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  })();

  await Promise.all([...promises, monitoringPromise]);

  results.endTime = Date.now();
  results.completed = true;

  return results;
}

/**
 * Verify no cross-project state leakage
 * @param {Object} results - Execution results
 * @returns {boolean} True if no leakage detected
 */
function verifyNoLeakage(results) {
  if (results.isolationViolations.length === 0) {
    return true;
  }

  console.error('\n  State leakage detected:');
  for (const violation of results.isolationViolations) {
    console.error(`    Project: ${violation.projectId}`);
    for (const v of violation.violations) {
      console.error(`      - ${v.type}: ${v.description}`);
      if (v.details) {
        console.error(`        Details: ${JSON.stringify(v.details)}`);
      }
    }
  }

  return false;
}

/**
 * Verify campaigns completed successfully
 * @param {Object} results - Execution results
 * @returns {boolean} True if all campaigns completed
 */
function verifyCampaignsCompleted(results) {
  const campaigns = Array.from(results.campaigns.values());
  const completed = campaigns.filter(c => c.status === 'completed');
  const failed = campaigns.filter(c => c.status === 'failed');

  if (failed.length > 0) {
    console.error('\n  Failed campaigns:');
    for (const c of failed) {
      console.error(`    - Campaign ${c.campaignId} in project ${c.projectId}: ${c.error}`);
    }
  }

  return completed.length === campaigns.length;
}

/**
 * Cleanup test environments
 * @param {string} testDir - Test directory to clean up
 */
function cleanupTestEnv(testDir) {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`  Failed to cleanup test directory: ${err.message}`);
  }
}

/**
 * Generate isolation report
 * @param {Object} results - Execution results
 * @returns {Object} Formatted report
 */
function generateIsolationReport(results) {
  const report = {
    summary: {
      totalCampaigns: results.campaigns.size,
      completed: Array.from(results.campaigns.values()).filter(c => c.status === 'completed').length,
      failed: Array.from(results.campaigns.values()).filter(c => c.status === 'failed').length,
      isolationViolations: results.isolationViolations.length,
      durationMs: results.endTime - results.startTime,
    },
    campaigns: Array.from(results.campaigns.entries()).map(([id, data]) => ({
      campaignId: id,
      projectId: data.projectId,
      status: data.status,
      milestoneCount: data.milestones.length,
      error: data.error,
    })),
    violations: results.isolationViolations,
    isolationVerified: results.isolationViolations.length === 0,
  };

  return report;
}

/**
 * Print isolation report to console
 * @param {Object} report - Isolation report
 */
function printIsolationReport(report) {
  console.log('\n  === Isolation Report ===');
  console.log(`  Total Campaigns: ${report.summary.totalCampaigns}`);
  console.log(`  Completed: ${report.summary.completed}`);
  console.log(`  Failed: ${report.summary.failed}`);
  console.log(`  Isolation Violations: ${report.summary.isolationViolations}`);
  console.log(`  Duration: ${(report.summary.durationMs / 1000).toFixed(2)}s`);
  console.log(`  Isolation Verified: ${report.isolationVerified ? '✓' : '✗'}`);

  if (report.violations.length > 0) {
    console.log('\n  Violation Details:');
    for (const v of report.violations) {
      console.log(`    Project: ${v.projectId} at ${v.timestamp}`);
      for (const violation of v.violations) {
        console.log(`      - ${violation.type}: ${violation.description}`);
      }
    }
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────

async function runTests() {
  console.log('test/integration/concurrent-campaign-tester.js');

  const testDir = mkdtempSync(join(tmpdir(), 'synapse-concurrent-campaign-test-'));

  try {
    // ─── Test 1: Single project baseline ───
    await test('Single project baseline - campaign creation and completion', async () => {
      const envs = createMultiProjectEnvs(testDir, ['project-a']);
      
      const campaignSpecs = [
        {
          projectId: 'project-a',
          campaignConfig: {
            title: 'Baseline Campaign',
            doneCriteria: 'Complete baseline',
          },
          milestones: [
            { title: 'Milestone 1', doneCriteria: 'First milestone' },
            { title: 'Milestone 2', doneCriteria: 'Second milestone' },
          ],
        },
      ];

      const results = await runConcurrentCampaigns(envs, campaignSpecs, {
        durationMs: 10000,
        monitorIntervalMs: 1000,
      });

      assert.strictEqual(results.completed, true, 'Execution should complete');
      assert.strictEqual(verifyNoLeakage(results), true, 'No leakage should be detected');
      assert.strictEqual(verifyCampaignsCompleted(results), true, 'All campaigns should complete');
    });

    // ─── Test 2: Two concurrent campaigns in separate projects ───
    await test('Two concurrent campaigns in separate projects', async () => {
      const envs = createMultiProjectEnvs(testDir, ['project-a', 'project-b']);
      
      const campaignSpecs = [
        {
          projectId: 'project-a',
          campaignConfig: {
            title: 'Project A Campaign',
            doneCriteria: 'Complete project A',
          },
          milestones: [
            { title: 'Project A Milestone 1', doneCriteria: 'First milestone in A' },
          ],
        },
        {
          projectId: 'project-b',
          campaignConfig: {
            title: 'Project B Campaign',
            doneCriteria: 'Complete project B',
          },
          milestones: [
            { title: 'Project B Milestone 1', doneCriteria: 'First milestone in B' },
          ],
        },
      ];

      const results = await runConcurrentCampaigns(envs, campaignSpecs, {
        durationMs: 15000,
        monitorIntervalMs: 1000,
      });

      assert.strictEqual(results.completed, true, 'Execution should complete');
      assert.strictEqual(verifyNoLeakage(results), true, 'No leakage should be detected between projects');
      assert.strictEqual(verifyCampaignsCompleted(results), true, 'All campaigns should complete');
      
      const report = generateIsolationReport(results);
      assert.strictEqual(report.isolationVerified, true, 'Isolation should be verified');
    });

    // ─── Test 3: Three concurrent campaigns with approval gates ───
    await test('Three concurrent campaigns with approval gates', async () => {
      const envs = createMultiProjectEnvs(testDir, ['project-a', 'project-b', 'project-c']);
      
      const campaignSpecs = [
        {
          projectId: 'project-a',
          campaignConfig: {
            title: 'Project A Campaign with Approval',
            doneCriteria: 'Complete project A with approvals',
          },
          milestones: [
            { 
              title: 'Project A Approval Milestone', 
              doneCriteria: 'Needs approval',
              requireApproval: true,
            },
          ],
        },
        {
          projectId: 'project-b',
          campaignConfig: {
            title: 'Project B Campaign with Approval',
            doneCriteria: 'Complete project B with approvals',
          },
          milestones: [
            { 
              title: 'Project B Approval Milestone', 
              doneCriteria: 'Needs approval',
              requireApproval: true,
            },
          ],
        },
        {
          projectId: 'project-c',
          campaignConfig: {
            title: 'Project C Campaign with Approval',
            doneCriteria: 'Complete project C with approvals',
          },
          milestones: [
            { 
              title: 'Project C Approval Milestone', 
              doneCriteria: 'Needs approval',
              requireApproval: true,
            },
          ],
        },
      ];

      const results = await runConcurrentCampaigns(envs, campaignSpecs, {
        durationMs: 20000,
        monitorIntervalMs: 1000,
      });

      assert.strictEqual(results.completed, true, 'Execution should complete');
      assert.strictEqual(verifyNoLeakage(results), true, 'No leakage should be detected');
      assert.strictEqual(verifyCampaignsCompleted(results), true, 'All campaigns should complete');
    });

    // ─── Test 4: Project isolation verification ───
    await test('Project isolation verification - no shared state', async () => {
      const envs = createMultiProjectEnvs(testDir, ['project-x', 'project-y']);
      
      const projectAEnv = envs.get('project-x');
      const projectBEnv = envs.get('project-y');

      const campaignA = createTestCampaign(projectAEnv, {
        title: 'Project X Campaign',
      });

      const campaignB = createTestCampaign(projectBEnv, {
        title: 'Project Y Campaign',
      });

      const milestoneA = createTestMilestone(projectAEnv, campaignA.id, {
        title: 'Project X Milestone',
      });

      const milestoneB = createTestMilestone(projectBEnv, campaignB.id, {
        title: 'Project Y Milestone',
      });

      projectAEnv.isolationMonitor.startMonitoring();
      projectBEnv.isolationMonitor.startMonitoring();

      const snapshotA = projectAEnv.isolationMonitor.captureSnapshot();
      const snapshotB = projectBEnv.isolationMonitor.captureSnapshot();

      const violationsA = projectAEnv.isolationMonitor.detectLeakage(snapshotA);
      const violationsB = projectBEnv.isolationMonitor.detectLeakage(snapshotB);

      projectAEnv.isolationMonitor.stopMonitoring();
      projectBEnv.isolationMonitor.stopMonitoring();

      assert.strictEqual(violationsA.length, 0, 'Project X should have no violations');
      assert.strictEqual(violationsB.length, 0, 'Project Y should have no violations');

      assert.notStrictEqual(campaignA.id, campaignB.id, 'Campaigns should have different IDs');
      assert.notStrictEqual(milestoneA.id, milestoneB.id, 'Milestones should have different IDs');
    });

    // ─── Test 5: Report generation ───
    await test('Isolation report generation', async () => {
      const envs = createMultiProjectEnvs(testDir, ['project-a', 'project-b']);
      
      const campaignSpecs = [
        {
          projectId: 'project-a',
          campaignConfig: { title: 'Campaign A' },
          milestones: [{ title: 'Milestone A' }],
        },
        {
          projectId: 'project-b',
          campaignConfig: { title: 'Campaign B' },
          milestones: [{ title: 'Milestone B' }],
        },
      ];

      const results = await runConcurrentCampaigns(envs, campaignSpecs, {
        durationMs: 10000,
      });

      const report = generateIsolationReport(results);

      assert.ok(report.summary, 'Report should have summary');
      assert.strictEqual(report.summary.totalCampaigns, 2, 'Should have 2 campaigns');
      assert.ok(report.campaigns, 'Report should have campaigns array');
      assert.strictEqual(report.campaigns.length, 2, 'Should have 2 campaign entries');
      assert.strictEqual(report.isolationVerified, true, 'Isolation should be verified');
    });

  } finally {
    cleanupTestEnv(testDir);
  }

  console.log('\n====================================');
  console.log(`Concurrent Campaign Tests passed: ${passed}`);
  console.log(`Concurrent Campaign Tests failed: ${failed}`);
  console.log(`Total tests: ${passed + failed}`);
  console.log('====================================');

  process.env.SYNAPSE_LOG_LEVEL = savedLogLevel;

  if (failed > 0) {
    process.exit(1);
  }
}

// ─── Exports for use in other test files ───────────────────────────────

export {
  createIsolatedProjectEnv,
  createMultiProjectEnvs,
  createTestCampaign,
  createTestMilestone,
  runConcurrentCampaigns,
  verifyNoLeakage,
  verifyCampaignsCompleted,
  cleanupTestEnv,
  generateIsolationReport,
  printIsolationReport,
};

// ─── Run tests if executed directly ─────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(err => {
    console.error('Unhandled error in main:', err);
    process.exit(1);
  });
}
