// mcp-task-create.test.js — the agent write path.
//
// Every MCP tool an agent could reach was read-only apart from chat, so an
// agent that found real work could only describe it in channel and hope a human
// transcribed it. An agent demonstrated this on 2026-08-19: it read state directly,
// correctly refused to borrow operator credentials, and stalled.
//
// These tests pin the tool AND its deliberate limits. The scope is create-only:
// there is intentionally no status/verdict write, because taskManager exposes
// only a general updateTaskStatus. Exposing it would let agents mark tasks
// `done` before review or after failing verification.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createMcpServer } from './mcp-server.js';

function makeDeps({ taskManager, campaignManager } = {}) {
  const created = [];
  return {
    created,
    deps: {
      credentialVault: null,
      stateManager: {
        listProjects: () => [{ id: 'synapse' }],
        getProject: id => ({ id, projectDir: `/tmp/${id}` }),
        getMessages: () => [],
      },
      campaignManager: campaignManager ?? { getCampaign: () => null },
      taskManager: taskManager ?? {
        getTask: () => null,
        createTask: (projectId, args) => {
          const task = {
            id: 'task_test_0001',
            status: 'queued',
            project: projectId,
            campaignId: args.campaignId ?? null,
            ...args,
          };
          created.push({ projectId, args, task });
          return task;
        },
      },
      addMessage: () => {},
      agents: {},
      // auth null => authenticate() returns the operator identity, which is the
      // documented no-auth path. That keeps these tests about the tool.
      auth: null,
      config: { operator: { name: 'operator' } },
      mergeCampaignBranch: () => ({ success: true }),
      rollbackLastMerge: () => ({ success: true }),
      queueTurn: null,
      handleUserMessage: null,
    },
  };
}

/** Drive the real handleRequest entry point rather than a private function. */
async function rpc(server, body) {
  // readBody does Buffer.concat(chunks), so the stream must emit Buffers --
  // a string-emitting Readable throws ERR_INVALID_ARG_TYPE. Real HTTP delivers
  // Buffers, so this mirrors production rather than working around it.
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]), {
    headers: {}, method: 'POST', url: '/mcp',
  });
  let status = null; let payload = '';
  const res = {
    writeHead(code) { status = code; },
    end(chunk) { payload = chunk || ''; },
  };
  await server.handleRequest(req, res);
  return { status, body: payload ? JSON.parse(payload) : null };
}

function toolResult(rpcResponse) {
  const content = rpcResponse.body?.result?.content?.[0]?.text ?? '';
  return { isError: !!rpcResponse.body?.result?.isError, text: content };
}

test('task.create is advertised to operator and agent_operator roles', async () => {
  const { deps } = makeDeps();
  const server = createMcpServer(deps);

  assert.ok(server.TOOLS['task.create'], 'the tool must exist in the table');
  assert.deepEqual(
    server.TOOLS['task.create'].roles, ['operator', 'agent_operator'],
    'an agent identity (agent_operator) must be able to call it — that is the entire point',
  );

  const listed = await rpc(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = listed.body.result.tools.map(t => t.name);
  assert.ok(names.includes('task.create'), 'tools/list must advertise it');
});

test('task.create files a queued task attributed to the caller, not system', async () => {
  const { deps, created } = makeDeps();
  const server = createMcpServer(deps);

  const res = await rpc(server, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'task.create', arguments: {
      project: 'synapse', title: '  Fix the thing  ',
      description: 'detail', doneCriteria: 'it is fixed',
    } },
  });
  const out = toolResult(res);
  assert.equal(out.isError, false, `expected success, got: ${out.text}`);

  assert.equal(created.length, 1, 'exactly one task must be created');
  const { args } = created[0];
  assert.equal(args.title, 'Fix the thing', 'the title must be trimmed');
  assert.equal(args.owner, 'operator',
    'owner must be the calling identity so the queue shows who raised it, never "system"');
  assert.equal(args.type, 'oneshot');
  assert.equal(args.channel, 'general', 'channel must default to general');
  assert.equal(args.campaignId, null);

  const parsed = JSON.parse(out.text);
  assert.equal(parsed.status, 'queued',
    'a filed task enters the normal queue — the tool cannot mint an active task');
  assert.equal(parsed.owner, 'operator');
});

test('task.create rejects a missing or blank title instead of persisting undefined', async () => {
  const { deps, created } = makeDeps();
  const server = createMcpServer(deps);

  for (const args of [{ project: 'synapse' }, { project: 'synapse', title: '   ' }]) {
    const out = toolResult(await rpc(server, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'task.create', arguments: args },
    }));
    assert.equal(out.isError, true, 'a titleless task must be refused');
    assert.match(out.text, /title is required/);
  }
  assert.equal(created.length, 0,
    'createTask does not validate title, so nothing may reach it without one');
});

test('task.create refuses an unknown campaign rather than orphaning the task', async () => {
  const { deps, created } = makeDeps({
    campaignManager: { getCampaign: () => null },
  });
  const server = createMcpServer(deps);

  const out = toolResult(await rpc(server, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'task.create', arguments: {
      project: 'synapse', title: 'orphan', campaign: 'campaign_does_not_exist',
    } },
  }));
  assert.equal(out.isError, true);
  assert.match(out.text, /Campaign not found/);
  assert.equal(created.length, 0, 'no task may be created against a missing campaign');
});

test('task.create attaches to a real campaign when one is given', async () => {
  const { deps, created } = makeDeps({
    campaignManager: { getCampaign: (_p, id) => ({ id, title: 'real' }) },
  });
  const server = createMcpServer(deps);

  const out = toolResult(await rpc(server, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'task.create', arguments: {
      project: 'synapse', title: 'attached', campaign: 'campaign_real_1',
    } },
  }));
  assert.equal(out.isError, false, out.text);
  assert.equal(created[0].args.campaignId, 'campaign_real_1');
});

test('SCOPE PIN: the MCP surface grants no task status or verdict write', () => {
  const { deps } = makeDeps();
  const server = createMcpServer(deps);
  const names = Object.keys(server.TOOLS);

  for (const forbidden of ['task.update', 'task.status', 'task.complete', 'task.verdict', 'task.review']) {
    assert.equal(names.includes(forbidden), false,
      `${forbidden} must not exist: taskManager only offers a general updateTaskStatus, and letting `
      + 'agents set their own status would let them bypass review.');
  }
  // The read side stays available.
  assert.ok(names.includes('task.read'), 'agents must still be able to read tasks');
});
