// test/unit/role-config.test.js — loadRoleConfig() unit tests
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as agentsModule from '../../src/orchestrator/agents.js';
import {
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_TOOL_ACCESS,
  DEFAULT_TOOL_ACCESS_ROLE,
  TOOL_ACCESS_ROLES,
} from '../../src/orchestrator/role-config-schema.js';

function makeConfig(projectDir) {
  return { server: { projectDir } };
}

function makeSynapseDir(projectDir) {
  const synapseDir = join(projectDir, '.synapse');
  mkdirSync(synapseDir, { recursive: true });
  return synapseDir;
}

describe('loadRoleConfig', () => {
  let tmpDir;
  let synapseDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'role-config-test-'));
    synapseDir = makeSynapseDir(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('missing role-config.json uses default role configuration', () => {
    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist in rolesConfig`);
      assert.ok(Array.isArray(rc[roleName].permissions), `${roleName}.permissions should be an array`);
      assert.ok(rc[roleName].toolAccessRole, `${roleName}.toolAccessRole should be set`);
      assert.ok(TOOL_ACCESS_ROLES.includes(rc[roleName].toolAccessRole),
        `${roleName}.toolAccessRole '${rc[roleName].toolAccessRole}' should be a valid tool-access role`);
    }
  });

  it('valid role-config.json loads custom roles merged with defaults', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        developer: { permissions: ['code:execute', 'task:execute', 'task:plan'], toolAccessRole: 'executor' },
        auditor: { permissions: ['audit:read'], toolAccessRole: 'reviewer' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    assert.deepStrictEqual(rc.developer.permissions, ['code:execute', 'task:execute', 'task:plan']);
    assert.strictEqual(rc.developer.toolAccessRole, 'executor');
    assert.deepStrictEqual(rc.auditor.permissions, ['audit:read']);
    assert.strictEqual(rc.auditor.toolAccessRole, 'reviewer');
    // Default roles still present (merged)
    assert.ok(rc.architect, 'architect default role should still be present after merge');
    assert.ok(rc.researcher, 'researcher default role should still be present after merge');
  });

  it('invalid JSON in role-config.json falls back to default configuration', () => {
    writeFileSync(join(synapseDir, 'role-config.json'), 'this is not json { broken');

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist in rolesConfig after invalid JSON`);
    }
  });

  it('role-config.json with invalid schema falls back to default configuration', () => {
    const invalidConfig = {
      schemaVersion: '1',
      roles: {
        developer: { permissions: 'not-an-array', toolAccessRole: 'executor' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(invalidConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist in rolesConfig after schema error`);
    }
    assert.ok(Array.isArray(rc.developer.permissions), 'developer.permissions should be array after fallback');
  });

  it('role missing toolAccessRole uses DEFAULT_ROLE_TOOL_ACCESS mapping', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        developer: { permissions: ['code:execute', 'task:execute', 'task:plan'] },
        architect: { permissions: ['code:execute', 'task:execute', 'task:plan'] },
        researcher: { permissions: ['code:execute'] },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    assert.strictEqual(rc.developer.toolAccessRole, DEFAULT_ROLE_TOOL_ACCESS.developer,
      'developer should get toolAccessRole from DEFAULT_ROLE_TOOL_ACCESS');
    assert.strictEqual(rc.architect.toolAccessRole, DEFAULT_ROLE_TOOL_ACCESS.architect,
      'architect should get toolAccessRole from DEFAULT_ROLE_TOOL_ACCESS');
    assert.strictEqual(rc.researcher.toolAccessRole, DEFAULT_ROLE_TOOL_ACCESS.researcher,
      'researcher should get toolAccessRole from DEFAULT_ROLE_TOOL_ACCESS');
  });

  it('role with invalid toolAccessRole enum fails schema validation and uses defaults', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        developer: { permissions: ['code:execute'], toolAccessRole: 'nonExistentRole' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist after invalid toolAccessRole`);
    }
    assert.ok(TOOL_ACCESS_ROLES.includes(rc.developer.toolAccessRole),
      `developer.toolAccessRole '${rc.developer.toolAccessRole}' should be valid after fallback`);
  });

  it('custom role whose name matches a TOOL_ACCESS_ROLES entry gets that as toolAccessRole', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        executor: { permissions: ['code:execute'] },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    assert.strictEqual(rc.executor.toolAccessRole, 'executor',
      'role named executor should get toolAccessRole=executor');
  });

  it('custom role with unknown name gets DEFAULT_TOOL_ACCESS_ROLE as toolAccessRole', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        auditor: { permissions: ['audit:read'] },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    assert.strictEqual(rc.auditor.toolAccessRole, DEFAULT_TOOL_ACCESS_ROLE,
      `unknown role name should fall back to DEFAULT_TOOL_ACCESS_ROLE ('${DEFAULT_TOOL_ACCESS_ROLE}')`);
  });

  it('unsupported schemaVersion falls back to default configuration', () => {
    const customConfig = {
      schemaVersion: '2',
      roles: {
        developer: { permissions: ['code:execute'], toolAccessRole: 'executor' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist after unsupported schemaVersion`);
    }
  });

  it('missing schemaVersion field falls back to default configuration', () => {
    const customConfig = {
      roles: {
        developer: { permissions: ['code:execute'], toolAccessRole: 'executor' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist after missing schemaVersion`);
    }
  });

  it('role entry that is not an object falls back to default configuration', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        developer: 'not-an-object',
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist after non-object role entry`);
    }
  });

  it('permissions array with empty string falls back to default configuration', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        developer: { permissions: ['code:execute', ''], toolAccessRole: 'executor' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    for (const roleName of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
      assert.ok(rc[roleName], `Role ${roleName} should exist after empty string permission`);
    }
  });

  it('role with empty permissions array uses empty array (valid config)', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        developer: { permissions: [], toolAccessRole: 'executor' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    assert.deepStrictEqual(rc.developer.permissions, [], 'developer.permissions should be empty array');
    assert.strictEqual(rc.developer.toolAccessRole, 'executor');
  });

  it('role with omitted permissions uses empty array', () => {
    const customConfig = {
      schemaVersion: '1',
      roles: {
        auditor: { toolAccessRole: 'reviewer' },
      },
    };
    writeFileSync(join(synapseDir, 'role-config.json'), JSON.stringify(customConfig));

    agentsModule.loadRoleConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    assert.deepStrictEqual(rc.auditor.permissions, [], 'auditor.permissions should default to empty array');
    assert.strictEqual(rc.auditor.toolAccessRole, 'reviewer');
  });

  it('getRoleConfig returns the current rolesConfig', () => {
    agentsModule.loadRoleConfig(makeConfig(tmpDir));
    assert.strictEqual(agentsModule.getRoleConfig(), agentsModule.rolesConfig,
      'getRoleConfig should return the current rolesConfig');
  });

  it('loadAgentsConfig deep-merges legacy roles without overwriting toolAccessRole', () => {
    // First, normalize roles via loadRoleConfig (sets toolAccessRole)
    agentsModule.loadRoleConfig(makeConfig(tmpDir));
    const originalTar = agentsModule.rolesConfig.developer.toolAccessRole;
    assert.ok(originalTar, 'developer should have toolAccessRole after loadRoleConfig');

    // Simulate agents.json with legacy roles (permissions only, no toolAccessRole)
    const legacyRoles = {
      developer: { permissions: ['code:execute', 'task:execute'] },
      architect: { permissions: ['code:execute'] },
    };

    // Write an agents.json that has a legacy roles field
    const agentsJson = {
      agents: [],
      roles: legacyRoles,
    };
    writeFileSync(join(synapseDir, 'agents.json'), JSON.stringify(agentsJson));

    // Call loadAgentsConfig — the deep merge should preserve toolAccessRole
    agentsModule.loadAgentsConfig(makeConfig(tmpDir));

    const rc = agentsModule.rolesConfig;
    // Permissions from legacy config should be applied
    assert.deepStrictEqual(rc.developer.permissions, ['code:execute', 'task:execute'],
      'developer.permissions should come from legacy agentsCfg.roles');
    // toolAccessRole should be preserved from loadRoleConfig normalization
    assert.strictEqual(rc.developer.toolAccessRole, originalTar,
      'developer.toolAccessRole should be preserved from loadRoleConfig');
    assert.ok(rc.architect.toolAccessRole,
      'architect.toolAccessRole should be preserved from loadRoleConfig');
  });
});
