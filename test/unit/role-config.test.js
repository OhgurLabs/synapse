import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getEffectiveRoles, loadAgentsConfig } from '../../src/orchestrator/agents.js';
import {
  ROLE_CONFIG_SCHEMA_VERSION,
  TOOL_ACCESS_ROLES,
  DEFAULT_TOOL_ACCESS_ROLE,
  DEFAULT_ROLE_TOOL_ACCESS,
  DEFAULT_ROLE_CONFIG,
  resolveToolAccessRole,
} from '../../src/orchestrator/role-config-schema.js';

function makeConfig(dir) {
  return { server: { projectDir: dir } };
}

function writeAgentsJson(dir, obj) {
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.synapse', 'agents.json'), JSON.stringify(obj));
}

test('role-config: module loads with expected surface', () => {
  assert.equal(typeof getEffectiveRoles, 'function');
  assert.equal(typeof loadAgentsConfig, 'function');
  assert.equal(ROLE_CONFIG_SCHEMA_VERSION, '1');
});

test('getEffectiveRoles returns built-in defaults with expected shape', () => {
  const roles = getEffectiveRoles();
  assert.ok(roles && typeof roles === 'object');
  for (const name of ['developer', 'architect', 'reviewer', 'governor', 'researcher']) {
    assert.ok(Array.isArray(roles[name].permissions), `role ${name} has permissions`);
  }
  assert.deepEqual([...roles.governor.permissions].sort(), ['code:execute', 'task:execute']);
  assert.deepEqual([...roles.developer.permissions].sort(), ['code:execute', 'task:execute', 'task:plan']);
});

test('getEffectiveRoles reflects schema defaults for each known role', () => {
  const roles = getEffectiveRoles();
  for (const [name, def] of Object.entries(DEFAULT_ROLE_CONFIG)) {
    assert.deepEqual(roles[name].permissions, def.permissions, `${name} permissions match schema defaults`);
  }
});

test('loadAgentsConfig merges custom additions and overrides from agents.json', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-config-test-'));
  writeAgentsJson(dir, {
    roles: {
      scribe: { permissions: ['task:plan'] },
      developer: { permissions: ['code:execute'] },
    },
    agents: [],
  });

  const originalDeveloper = getEffectiveRoles().developer;
  t.after(() => {
    writeAgentsJson(dir, { agents: [], roles: { developer: originalDeveloper } });
    loadAgentsConfig(makeConfig(dir));
    delete getEffectiveRoles().scribe;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = makeConfig(dir);
  const loaded = loadAgentsConfig(cfg);
  assert.equal(loaded.roles.developer.permissions[0], 'code:execute');

  const roles = getEffectiveRoles();
  assert.deepEqual(roles.scribe.permissions, ['task:plan'], 'custom role added');
  assert.deepEqual(roles.developer.permissions, ['code:execute'], 'built-in role overridden');
  // Other built-ins untouched by shallow top-level merge.
  assert.deepEqual([...roles.governor.permissions].sort(), ['code:execute', 'task:execute']);
});

test('loadAgentsConfig throws on corrupt agents.json and leaves file in place', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  const configPath = path.join(dir, '.synapse', 'agents.json');
  fs.writeFileSync(configPath, '{ "roles": , trailing comma');

  assert.throws(() => loadAgentsConfig(makeConfig(dir)), /agents\.json is corrupt/);
  assert.ok(fs.existsSync(configPath), 'corrupt file retained on non-quarantine load');
  const quarantined = fs.readdirSync(path.join(dir, '.synapse')).filter((f) => f.includes('corrupt'));
  assert.equal(quarantined.length, 0, 'no quarantine copy made outside boot');
});

test('loadAgentsConfig quarantines corrupt agents.json at boot', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  const configPath = path.join(dir, '.synapse', 'agents.json');
  fs.writeFileSync(configPath, 'not json at all');

  assert.throws(
    () => loadAgentsConfig(makeConfig(dir), { quarantineCorrupt: true }),
    /preserved at/
  );
  assert.ok(!fs.existsSync(configPath), 'corrupt file moved off live path');
  const leftovers = fs.readdirSync(path.join(dir, '.synapse')).filter((f) => f.startsWith('agents.json.corrupt-'));
  assert.equal(leftovers.length, 1, 'corrupt file preserved as quarantine copy');
});

test('loadAgentsConfig succeeds when agents.json is absent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const loaded = loadAgentsConfig(makeConfig(dir));
  assert.ok(Array.isArray(loaded.agents));
  assert.ok(getEffectiveRoles().developer, 'defaults still served');
});

test('resolveToolAccessRole resolves explicit tool-access roles case-insensitively', () => {
  for (const role of TOOL_ACCESS_ROLES) {
    assert.equal(resolveToolAccessRole(role), role);
    assert.equal(resolveToolAccessRole(role.toUpperCase()), role);
    assert.equal(resolveToolAccessRole(`  ${role}  `), role);
  }
});

test('resolveToolAccessRole maps config role names to tool-access roles', () => {
  assert.equal(resolveToolAccessRole('developer'), 'executor');
  assert.equal(resolveToolAccessRole('architect'), 'architect');
  assert.equal(resolveToolAccessRole('reviewer'), 'reviewer');
  assert.equal(resolveToolAccessRole('governor'), 'governor');
  assert.equal(resolveToolAccessRole('researcher'), 'researcher');
  for (const [role, mapped] of Object.entries(DEFAULT_ROLE_TOOL_ACCESS)) {
    assert.equal(resolveToolAccessRole(role), mapped);
  }
});

test('resolveToolAccessRole falls back for invalid/empty input', () => {
  assert.equal(resolveToolAccessRole(undefined), DEFAULT_TOOL_ACCESS_ROLE);
  assert.equal(resolveToolAccessRole(null), DEFAULT_TOOL_ACCESS_ROLE);
  assert.equal(resolveToolAccessRole(''), DEFAULT_TOOL_ACCESS_ROLE);
  assert.equal(resolveToolAccessRole(123), DEFAULT_TOOL_ACCESS_ROLE);
});

test('resolveToolAccessRole passes through unknown normalized names', () => {
  assert.equal(resolveToolAccessRole('CustomRole  '), 'customrole');
  assert.equal(resolveToolAccessRole('ops'), 'ops');
});
