// test/unit/policy-enforce.test.js
// Unit test for PolicyEngine.enforce() method

import { strict as assert } from 'assert';
import { PolicyEngine } from '../../src/orchestrator/policy.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

console.log('test/unit/policy-enforce.test.js');

const mockAuditStore = { append: () => {}, record: () => {} };

// Test configurations
const VIEWER_CONFIG = {
  auth: { userRoles: { 'test-user': 'viewer' } },
};

const OPERATOR_CONFIG = {
  auth: { userRoles: {} }, // Empty means default to operator
};

const ADMIN_CONFIG = {
  auth: { userRoles: { 'test-user': 'admin' } },
};

const REVIEWER_CONFIG = {
  auth: { userRoles: { 'test-user': 'reviewer' } },
};

const SUPPORT_CONFIG = {
  auth: { userRoles: { 'test-user': 'support' } },
};

// ─── Tests: viewer role ─────────────────────────────────────────

test('viewer is denied routing:rollback', () => {
  const engine = new PolicyEngine({ config: VIEWER_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing:rollback',
    resource: 'routing_weights',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, false, 'viewer should be denied');
  assert.ok(result.reason, 'should have reason for denial');
});

test('viewer is allowed routing_recommendation', () => {
  const engine = new PolicyEngine({ config: VIEWER_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing_recommendation',
    resource: 'routing',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, true, 'viewer should be allowed to read routing recommendations');
  assert.ok(!result.reason, 'should not have reason when allowed');
});

// ─── Tests: operator role (default) ─────────────────────────────

test('operator (default) is allowed routing:rollback', () => {
  const engine = new PolicyEngine({ config: OPERATOR_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing:rollback',
    resource: 'routing_weights',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, true, 'operator should be allowed');
  assert.ok(!result.reason, 'should not have reason when allowed');
});

test('operator is allowed campaign_pause', () => {
  const engine = new PolicyEngine({ config: OPERATOR_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'campaign_pause',
    resource: 'campaign',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, true, 'operator should be allowed');
});

// ─── Tests: admin role ──────────────────────────────────────────

test('admin is allowed routing:rollback', () => {
  const engine = new PolicyEngine({ config: ADMIN_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing:rollback',
    resource: 'routing_weights',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, true, 'admin should be allowed');
});

test('admin is allowed all actions', () => {
  const engine = new PolicyEngine({ config: ADMIN_CONFIG, operatorAuditStore: mockAuditStore });
  const actions = ['routing:rollback', 'campaign_pause', 'provider_pause', 'checkpoint_replay'];
  for (const action of actions) {
    const result = engine.enforce({
      action,
      resource: 'test',
      operatorId: 'test-user',
    });
    assert.equal(result.allowed, true, `admin should be allowed ${action}`);
  }
});

// ─── Tests: reviewer role ───────────────────────────────────────

test('reviewer is denied routing:rollback', () => {
  const engine = new PolicyEngine({ config: REVIEWER_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing:rollback',
    resource: 'routing_weights',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, false, 'reviewer should be denied');
  assert.ok(result.reason, 'should have reason for denial');
});

test('reviewer is allowed campaign_pause', () => {
  const engine = new PolicyEngine({ config: REVIEWER_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'campaign_pause',
    resource: 'campaign',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, true, 'reviewer should be allowed to pause campaigns');
});

test('reviewer is allowed routing_recommendation', () => {
  const engine = new PolicyEngine({ config: REVIEWER_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing_recommendation',
    resource: 'routing',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, true, 'reviewer should be allowed routing recommendations');
});

// ─── Tests: support role ────────────────────────────────────────

test('support is denied routing:rollback', () => {
  const engine = new PolicyEngine({ config: SUPPORT_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing:rollback',
    resource: 'routing_weights',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, false, 'support should be denied');
  assert.ok(result.reason, 'should have reason for denial');
});

test('support is allowed routing_recommendation', () => {
  const engine = new PolicyEngine({ config: SUPPORT_CONFIG, operatorAuditStore: mockAuditStore });
  const result = engine.enforce({
    action: 'routing_recommendation',
    resource: 'routing',
    operatorId: 'test-user',
  });
  assert.equal(result.allowed, true, 'support should be allowed routing recommendations');
});

// ─── Summary ────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
