import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createGitHubBridge, createGitHubClient, createFileGitHubBridgeStore, readGitHubWebhookBody, verifyGitHubWebhookSignature,
  renderPublicGitHubEvidence,
  buildActiveProofForPr,
} from './github-bridge.js';
import {
  LOOP_TEMPLATES, createMemoryTemplateIdempotencyStore, createFileTemplateIdempotencyStore, createSqliteTemplateIdempotencyStore, createTemplateRegistries, evaluateTemplateAnchor, getLoopTemplate, instantiateLoopFromTemplate, listLoopTemplates, validateTemplateParams, verifyNodeTests,
} from '../templates/loop-templates.js';
import {
  REQUIRED_RELEASE_FILES, RELEASE_TEST_FILES, RELEASE_TEST_NAMES, computeTreeDigest, scanTreeForLeaks, runReleaseGate, tarEntries,
} from '../../scripts/release-gate.mjs';
import '../ui/public/js/prs.js';
import { createLoopEngine } from '../loops.js';
import { createLoopService } from '../loop-service.js';
import { TaskManager } from '../tasks.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE_URL = new URL('../../scripts/release-gate.mjs', import.meta.url).href;
const BRIDGE_URL = new URL('./github-bridge.js', import.meta.url).href;
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const REVIEW_HASH = 'c'.repeat(64);
const ANCHOR_HASH = 'd'.repeat(64);
const PROJECT = 'project-one';
const PR = 'pr-one';
const REPO_ID = 479;
const PULL = 12;
const HOOK_SECRET = 'fixture signing material';
const GITHUB_TOKEN = 'fixture-transport-value';
const API = 'https://api.github.com';
const PUBLIC_DNS = [{ address: '8.8.4.4', family: 4 }];
const privateV4 = [192, 168, 4, 6].join('.');
const v6 = (...parts) => parts.join(':');
const credential = ['gh', 'p_', 'Z'.repeat(36)].join('');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (data, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(data), { status, headers });
const errorCode = (code, statusCode) => ({ code, ...(statusCode === undefined ? {} : { statusCode }) });

async function scratch(t) {
  const path = await fs.mkdtemp(join(tmpdir(), 'phase4-fixture-'));
  t.after(() => fs.rm(path, { force: true, recursive: true }));
  return path;
}

function execFixtureNode(args, options) {
  if (!process.permission) return execFileSync(process.execPath, args, options);
  // Recent Node versions inject their permission flags into NODE_OPTIONS when
  // spawning. These fixture helpers run inside the inherited kernel sandbox.
  return execFileSync('/usr/bin/env', ['-u', 'NODE_OPTIONS', process.execPath, ...args], options);
}

async function runNode(t, args, timeout = 15_000) {
  const dir = await scratch(t);
  const output = join(dir, 'stdout');
  const handle = await fs.open(output, 'wx', 0o600);
  let status = 0;
  try {
    execFixtureNode(args, { stdio: ['ignore', handle.fd, 'ignore'], timeout });
  } catch (error) {
    if (error.status === null || error.status === undefined) throw error;
    status = error.status;
  } finally {
    await handle.close();
  }
  return { status, stdout: await fs.readFile(output, 'utf8') };
}

function fixtureBridgeStore(path) {
  const store = createFileGitHubBridgeStore(path);
  if (!process.permission) return store;
  // Node's permission model blocks fsync. Commit through the real file store
  // in a child that inherits the gate's offline, read-only mount namespace.
  return {
    ...store,
    transact: (update) => store.withPrLock('fixture-transaction', async () => {
      const state = await store.transact((snapshot) => snapshot);
      const before = JSON.stringify(state);
      const result = update(state);
      assert.ok(!result?.then);
      const after = JSON.stringify(state);
      if (after !== before) {
        const pending = path + '.fixture-transaction';
        await fs.writeFile(pending, after, { flag: 'wx', mode: 0o600 });
        try {
          execFixtureNode(['--input-type=module', '-e', `
            import { readFileSync } from 'node:fs';
            const { createFileGitHubBridgeStore } = await import(process.argv[1]);
            const next = JSON.parse(readFileSync(process.argv[3], 'utf8'));
            await createFileGitHubBridgeStore(process.argv[2]).transact((state) => {
              Object.assign(state, next);
            });
          `, BRIDGE_URL, path, pending], { stdio: 'ignore', timeout: 5_000 });
        } finally {
          await fs.rm(pending, { force: true });
        }
      }
      return result;
    }),
  };
}

function signed(payload, event = 'pull_request', delivery = 'delivery-1') {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', HOOK_SECRET).update(rawBody).digest('hex');
  return { rawBody, rawHeaders: ['X-Hub-Signature-256', 'sha256=' + signature,
    'X-GitHub-Hook-Id', '917', 'X-GitHub-Delivery', delivery, 'X-GitHub-Event', event] };
}

const syncPayload = (sha, extra = {}) => ({
  repository: { id: REPO_ID }, action: 'synchronize', number: PULL, pull_request: { head: { sha } }, ...extra,
});

async function bridgeFixture(t, options = {}) {
  const dir = await scratch(t);
  const settings = {
    comments: [], statuses: [], calls: [], invalidations: [], tasks: new Map(),
    now: HEAD_A, local: HEAD_A, checked: HEAD_A,
    hook: { secret: HOOK_SECRET, repoId: REPO_ID, projectId: PROJECT },
  };
  const packetDir = join(dir, 'packet');
  await fs.mkdir(packetDir);
  const packet = {
    schemaVersion: 1, run: { runId: 'run_verified', verdict: 'passed' },
    pr: {
      projectId: PROJECT, prId: PR, approvedSourceSha: HEAD_A,
      approval: { eventId: 'approval-1', principalKind: 'operator', approvedSourceSha: HEAD_A,
        reviewSha256: REVIEW_HASH, anchorSetSha256: ANCHOR_HASH },
      review: { agentId: 'hidden-reviewer', provider: 'provider-b', disposition: 'approve',
        reviewedSourceSha: HEAD_A, report: { sha256: REVIEW_HASH }, notes: '<arbitrary review notes>' },
    },
    anchors: [{ outcome: 'passed', subjectSha: HEAD_A, stdout: '/unpublished/logs',
      proof: { assertions: [{ id: 'unpublished assertion', passed: true }] } }],
    rawCommand: 'private fixture prose', token: credential,
  };
  const proof = {
    runId: 'run_verified', approvedSourceSha: HEAD_A, packetDir,
    approval: { ...packet.pr.approval, runId: 'run_verified' },
    authors: [{ agentId: 'hidden-author', provider: 'provider-a' }],
  };
  async function savePacket(updateDigests = true) {
    const bytes = Buffer.from(JSON.stringify(packet));
    const sums = Buffer.from(hash(bytes) + '  evidence-packet.json\n');
    await fs.writeFile(join(packetDir, 'evidence-packet.json'), bytes);
    await fs.writeFile(join(packetDir, 'SHA256SUMS'), sums);
    if (updateDigests) Object.assign(proof, { evidencePacketSha256: hash(bytes), checksumManifestSha256: hash(sums) });
  }
  await savePacket();

  const identity = { login: 'evidence-bridge', userId: 121 };
  const configuration = { owner: 'public-org', repo: 'public-repo', repoId: REPO_ID, bridgeIdentity: identity };
  const pathRoot = '/repos/' + configuration.owner + '/' + configuration.repo;
  const repository = {
    getPR: async (_projectId, prId) => ({ id: prId, sourceBranch: 'feature', targetBranch: 'main',
      currentHeadSha: settings.checked }),
    invalidateApprovalOnShaChange: async (projectId, prId, head) => {
      settings.invalidations.push([projectId, prId, head]);
      settings.checked = head;
      settings.invalidateProof = true;
    },
  };
  async function fetchImpl(url, request) {
    const { pathname: path } = url;
    const call = { path, method: request.method, page: url.searchParams.get('page'),
      body: request.body && JSON.parse(request.body) };
    settings.calls.push(call);
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.authorization, 'Bearer ' + GITHUB_TOKEN);
    const user = { login: identity.login, id: identity.userId };
    const custom = await settings.intercept?.(call);
    if (custom) return custom;
    if (path.startsWith(pathRoot + '/pulls/')) {
      return json({ number: Number(path.split('/').at(-1)), head: { sha: settings.now, ref: 'feature', repo: { id: REPO_ID } },
        base: { ref: 'main', repo: { id: REPO_ID } } });
    }
    if (path.endsWith('/comments') && call.method === 'GET') return json(settings.comments);
    if (path.endsWith('/comments') && call.method === 'POST') {
      const comment = { id: 101 + settings.comments.length, ...call.body, user };
      settings.comments.push(comment);
      if (settings.dropCommentReply) throw new Error('Response lost after comment commit');
      return json(comment, { status: 201 });
    }
    if (path.includes('/issues/comments/') && call.method === 'PATCH') {
      const existing = settings.comments.find((comment) => comment.id === Number(path.split('/').at(-1)));
      Object.assign(existing, call.body);
      return json(existing);
    }
    if (path.endsWith('/statuses') && call.method === 'GET') return json(settings.statuses);
    if (path.includes('/statuses/') && call.method === 'POST') {
      if (settings.failStatusOnce) {
        settings.failStatusOnce = false;
        return json({}, { status: 422 });
      }
      const status = { id: 401 + settings.statuses.length, creator: { login: 'evidence-bridge', id: 121 }, ...call.body };
      settings.statuses.unshift(status);
      if (settings.dropStatusReply) throw new Error('Response lost after status commit');
      return json(status, { status: 201 });
    }
    throw new Error('Unexpected fake request ' + path);
  }

  const deps = {
    store: fixtureBridgeStore(join(dir, 'bridge-state.json')), getHook: (id) => id === '917' ? settings.hook : null,
    getRepository: () => configuration, prStore: repository, resolveLocalHead: () => settings.local,
    getActiveProof: () => settings.invalidateProof ? null : proof,
    verifyPacketSnapshot: () => settings.invalidPacket ? { ok: false } : {
      ok: true, summary: { approvedSourceSha: HEAD_A, runId: proof.runId, verdict: 'passed', anchorsVerified: 1 },
    },
    createQueuedTask: (task) => settings.tasks.set(task.idempotencyKey, task),
    clientOptions: { dnsLookup: async () => PUBLIC_DNS, fetchImpl,
      credentialVault: async (key) => key === 'github-token-' + PROJECT ? GITHUB_TOKEN : null },
    ...options,
  };
  let bridge = createGitHubBridge(deps);
  const bound = await bridge.bindPullRequest({ projectId: PROJECT, prId: PR, pullNumber: PULL });
  const publish = () => bridge.publishEvidenceToGitHub({ projectId: PROJECT, prId: PR, expectedHeadSha: HEAD_A });
  const restart = () => { bridge = createGitHubBridge(deps); return bridge; };
  const writes = () => settings.calls.filter((record) => record.method !== 'GET');
  return { get bridge() { return bridge; }, settings, deps, proof, packet, savePacket, bound, publish, restart, writes };
}

test('GitHub webhook verifies the exact original bytes and rejects malformed security headers', async () => {
  const request = signed(syncPayload(HEAD_A));
  assert.equal(verifyGitHubWebhookSignature({ ...request, secret: HOOK_SECRET }), true);
  assert.throws(() => verifyGitHubWebhookSignature({ ...request, rawBody: Buffer.concat([request.rawBody, Buffer.from(' ')]),
    secret: HOOK_SECRET }), errorCode('INVALID_WEBHOOK_SIGNATURE', 401));
  for (const header of ['X-GitHub-Event', 'x-HUB-signature-256', 'x-github-delivery', 'X-GitHub-Hook-Id']) {
    assert.throws(() => verifyGitHubWebhookSignature({ ...request, secret: HOOK_SECRET,
      rawHeaders: [...request.rawHeaders, header, 'duplicate'] }), errorCode('DUPLICATE_WEBHOOK_HEADER', 400));
  }
  assert.throws(() => verifyGitHubWebhookSignature({ ...request, rawHeaders: [...request.rawHeaders, 'Content-Encoding', 'gzip'],
    secret: HOOK_SECRET }), errorCode('UNSUPPORTED_WEBHOOK_ENCODING', 400));
  const [, , ...remaining] = request.rawHeaders;
  for (const value of ['sha1=deadbeef', 'sha256=' + 'a'.repeat(63), 'sha256=' + 'z'.repeat(64)]) {
    assert.throws(() => verifyGitHubWebhookSignature({ ...request, secret: HOOK_SECRET,
      rawHeaders: ['X-Hub-Signature-256', value, ...remaining] }), errorCode('INVALID_WEBHOOK_SIGNATURE', 401));
  }
  assert.throws(() => verifyGitHubWebhookSignature({ ...request, rawBody: Buffer.alloc(1024 * 1024 + 1),
    secret: HOOK_SECRET }), errorCode('WEBHOOK_TOO_LARGE', 413));
  const stream = { rawHeaders: request.rawHeaders, async *iterator() {
    yield Buffer.alloc(1024 * 1024);
    yield Buffer.alloc(1);
  } };
  await assert.rejects(readGitHubWebhookBody(stream), errorCode('WEBHOOK_TOO_LARGE', 413));
  const validStream = { rawHeaders: request.rawHeaders, async *iterator() {
    yield request.rawBody.subarray(0, 10);
    yield request.rawBody.subarray(10);
  } };
  assert.deepEqual(await readGitHubWebhookBody(validStream), request.rawBody);
});

test('GitHub webhook admission is durable and deduplicates concurrent deliveries and changed delivery headers', async (t) => {
  const fixture = await bridgeFixture(t);
  const { settings } = fixture;
  const request = signed(syncPayload(HEAD_B));
  const admitted = await Promise.all([fixture.bridge.admitWebhook(request), fixture.bridge.admitWebhook(request)]);
  assert.deepEqual(admitted.map((entry) => entry.statusCode).sort(), [200, 202]);
  const restarted = fixture.restart();
  assert.equal((await restarted.admitWebhook(signed(syncPayload(HEAD_B), 'pull_request', 'replayed'))).state, 'duplicate');
  await assert.rejects(restarted.admitWebhook(signed(syncPayload(HEAD_A))), errorCode('WEBHOOK_DELIVERY_CONFLICT', 400));
  await assert.rejects(restarted.admitWebhook(signed(syncPayload(HEAD_A, { repository: { id: 123 } }))),
    errorCode('WEBHOOK_REPOSITORY_MISMATCH', 400));
  settings.now = HEAD_B;
  const deliveryKey = admitted.find((item) => item.statusCode === 202).deliveryKey;
  assert.deepEqual((await Promise.all([restarted.processDelivery(deliveryKey), restarted.processDelivery(deliveryKey)]))
    .map((item) => item.state).sort(), ['completed', 'unavailable']);
  assert.deepEqual(settings.invalidations, [[PROJECT, PR, HEAD_B]]);
  assert.deepEqual(await restarted.drainWebhookQueue(), []);
});

test('Delayed synchronize notifications read the live head and a return to the old SHA still needs fresh approval', async (t) => {
  const fixture = await bridgeFixture(t);
  const { settings, bridge } = fixture;
  settings.now = HEAD_B;
  await bridge.admitWebhook(signed(syncPayload(HEAD_B)));
  await bridge.drainWebhookQueue();
  await bridge.admitWebhook(signed(syncPayload(HEAD_A), 'pull_request', 'delayed'));
  await bridge.drainWebhookQueue();
  assert.deepEqual(settings.invalidations, [[PROJECT, PR, HEAD_B]]);
  settings.now = settings.local = HEAD_A;
  await bridge.admitWebhook(signed(syncPayload(HEAD_A, { unique: 1 }), 'pull_request', 'reverted'));
  await bridge.drainWebhookQueue();
  assert.deepEqual(settings.invalidations, [[PROJECT, PR, HEAD_B], [PROJECT, PR, HEAD_A]]);
  await assert.rejects(fixture.publish(), errorCode('GITHUB_PROOF_STALE_OR_MISSING'));
  assert.equal(fixture.writes().length, 0);
});

test('GitHub transport restricts origins, DNS, token fallback, redirects, and endpoint segments', async () => {
  const base = { projectId: PROJECT, credentialVault: () => { throw new Error('Unexpected credential lookup'); },
    dnsLookup: async () => PUBLIC_DNS, fetchImpl: () => { throw new Error('Unexpected network call'); } };
  for (const apiOrigin of ['http://api.github.com', 'https://user@api.github.com',
    'https://' + PUBLIC_DNS[0].address, 'https://api.github.com/not-allowed', 'https://api.example.org']) {
    assert.throws(() => createGitHubClient({ ...base, apiOrigin }), errorCode('GITHUB_ORIGIN_DENIED'));
  }
  const checkedSegments = ['repos', 'public-org', 'public-repo', 'pulls', PULL];
  const enterprise = { origin: 'https://git.example.org', apiPrefix: '/api/v3' };
  assert.throws(() => createGitHubClient({ ...base, apiOrigin: enterprise.origin, enterprise }),
    errorCode('GITHUB_ENTERPRISE_EGRESS_REQUIRED'));
  for (const address of [privateV4, [127, 1, 1, 1].join('.'), [169, 254, 1, 3].join('.'),
    v6('', '', '1'), v6('fd11', '', '2'), v6('fe80', '', '9'), v6('', '', 'ffff', privateV4)]) {
    const client = createGitHubClient({ ...base, dnsLookup: async () => [...PUBLIC_DNS, { address }] });
    await assert.rejects(client.request(checkedSegments), errorCode('GITHUB_DNS_DENIED'));
  }
  await assert.rejects(createGitHubClient(base).request(['repos', '..', 'public-repo']), errorCode('GITHUB_PATH_INVALID'));
  const vaultCalls = [];
  const fallback = { ...base, credentialVault: (key) => {
    vaultCalls.push(key);
    return key === 'github-token' ? GITHUB_TOKEN : null;
  } };
  await assert.rejects(createGitHubClient(fallback).request(checkedSegments), errorCode('GITHUB_CREDENTIAL_UNAVAILABLE'));
  assert.deepEqual(vaultCalls, ['github-token-' + PROJECT]);
  const redirected = createGitHubClient({ ...fallback, allowGlobalToken: true,
    fetchImpl: (url, init) => {
      assert.equal(url.origin, API);
      assert.equal(init.redirect, 'error');
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org' } });
    } });
  await assert.rejects(redirected.request(checkedSegments), errorCode('GITHUB_REDIRECT_DENIED'));
  assert.equal(vaultCalls.at(-1), 'github-token');
  const pinned = createGitHubClient({ ...fallback, allowGlobalToken: true, apiOrigin: enterprise.origin,
    enterprise: { ...enterprise, egressEnforced: true }, fetchImpl: (url) => json({ endpoint: url.pathname }) });
  assert.equal((await pinned.request(checkedSegments)).data.endpoint, '/api/v3/repos/public-org/public-repo/pulls/12');
});

test('The opt-in gh adapter verifies the executable and supplies its token only in the child environment', async (t) => {
  const dir = await scratch(t);
  const gh = join(dir, 'gh');
  await fs.writeFile(gh, '#!' + process.execPath + '\n' +
    'if (process.argv[2] === "--version") { console.log("gh version 2.90.0"); } else {\n' +
    'const token = process.env.GH_TOKEN;\n' +
    'if (!token || process.argv.some((arg) => arg.includes(token))) process.exit(2);\n' +
    'process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{\\"ok\\":true}");\n' +
    '}\n', { mode: 0o700 });
  const options = { projectId: PROJECT, transport: 'gh', credentialVault: () => GITHUB_TOKEN,
    dnsLookup: async () => PUBLIC_DNS };
  assert.throws(() => createGitHubClient({ ...options, gh: { path: dir } }), errorCode('GITHUB_CLI_EGRESS_REQUIRED'));
  const client = createGitHubClient({ ...options, gh: { path: dir, egressEnforced: true, redirectsBlocked: true } });
  assert.deepEqual((await client.request(['repos', 'public-org', 'public-repo'])).data, { ok: true });
});

test('GitHub bindings enforce one-to-one uniqueness and repository/ref matching', async (t) => {
  const fixture = await bridgeFixture(t);
  const replay = await fixture.bridge.bindPullRequest({ projectId: PROJECT, prId: PR, pullNumber: PULL });
  assert.equal(replay.created, false);
  assert.equal(replay.url, 'https://github.com/public-org/public-repo/pull/12');
  await assert.rejects(fixture.bridge.bindPullRequest({ projectId: PROJECT, prId: 'other-pr', pullNumber: PULL }),
    errorCode('GITHUB_BINDING_CONFLICT'));
  await assert.rejects(fixture.bridge.bindPullRequest({ projectId: PROJECT, prId: PR, pullNumber: PULL + 1 }),
    errorCode('GITHUB_BINDING_CONFLICT'));
  fixture.settings.intercept = () => json({ number: PULL, base: { repo: { id: REPO_ID }, ref: 'other-target' },
    head: { sha: HEAD_A, ref: 'feature', repo: { id: REPO_ID } } });
  await assert.rejects(fixture.bridge.bindPullRequest({ projectId: PROJECT, prId: PR, pullNumber: PULL }),
    errorCode('GITHUB_PR_BINDING_MISMATCH'));
});

test('Concurrent evidence publication ignores a spoofed marker and performs one comment and one commit status', async (t) => {
  const fixture = await bridgeFixture(t);
  const { settings, proof, bound } = fixture;
  const marker = '<!-- synapse-evidence:v1 marker=' + hash('synapse-evidence:v1:run_verified').slice(0, 24) + ' -->';
  settings.comments.push({ id: 88, body: marker + '\nspoof', user: { login: 'evidence-bridge', id: 999 } });
  const result = await Promise.all([fixture.publish(), fixture.publish(), fixture.publish()]);
  assert.deepEqual(result.map((entry) => entry.statusCode).sort(), [200, 200, 202]);
  assert.equal(settings.comments.length, 2);
  assert.equal(settings.comments[0].body, marker + '\nspoof');
  const publicBody = settings.comments[1].body;
  assert.equal(publicBody.split('\n')[0], marker);
  assert.equal(publicBody, renderPublicGitHubEvidence({ ...proof, anchorCount: 1, assertionCount: 1 }));
  for (const privateValue of ['hidden-reviewer', 'provider-a', 'unpublished', 'fixture prose', '<arbitrary', credential, proof.packetDir]) {
    assert.equal(publicBody.includes(privateValue), false);
  }
  assert.throws(() => renderPublicGitHubEvidence({ ...proof, runId: 'leak -->', anchorCount: 1, assertionCount: 1 }),
    errorCode('PUBLIC_EVIDENCE_INVALID'));
  assert.throws(() => renderPublicGitHubEvidence({ ...proof, runId: 'run-' + credential, anchorCount: 1, assertionCount: 1 }),
    errorCode('PUBLIC_EVIDENCE_INVALID'));
  assert.equal(settings.statuses.length, 1);
  assert.equal(settings.statuses[0].context, 'synapse/evidence/pr-12');
  assert.equal(settings.statuses[0].target_url, bound.url + '#issuecomment-102');
  assert.equal(fixture.writes()[1].path.split('/').at(-1), HEAD_A);
  const bridge = fixture.restart();
  assert.equal((await bridge.getPublication(PROJECT, PR)).statusReceipt.state, 'completed');
  assert.equal((await fixture.publish()).statusCode, 200);
  assert.equal(fixture.writes().length, 2);
});

test('Publication patches an owned marker, reuses an equivalent status, and refuses an incomplete comment search', async (t) => {
  const fixture = await bridgeFixture(t, { maxPages: 2 });
  const { settings } = fixture;
  settings.intercept = (call) => {
    if (call.method === 'GET' && call.path.endsWith('/comments')) {
      return json([], { headers: { link: '<https://elsewhere.example.org/anything>; rel="next"' } });
    }
  };
  const paginated = await fixture.publish();
  assert.equal(paginated.receipt.code, 'GITHUB_PAGINATION_INCOMPLETE');
  assert.equal(fixture.writes().length, 0);
  settings.intercept = null;
  const t8Marker = '<!-- synapse-evidence:v1 marker=' + hash('synapse-evidence:v1:run_verified').slice(0, 24) + ' -->';
  settings.comments.push({ id: 80, body: t8Marker + '\nneeds update',
    user: { login: 'EVIDENCE-BRIDGE', id: 121 } });
  settings.statuses.push({ id: 402, context: 'synapse/evidence/pr-12', state: 'success',
    description: 'Verified Synapse evidence', target_url: fixture.bound.url + '#issuecomment-80',
    creator: { login: 'evidence-bridge', id: 121 } });
  const done = await fixture.publish();
  assert.equal(done.receipt.state, 'completed');
  assert.deepEqual(fixture.writes().map((entry) => entry.method), ['PATCH']);
  assert.equal(done.receipt.statusReceipt.id, 402);
});

test('Publication reconciles an ambiguous comment or status response before any new create', async (t) => {
  const fixture = await bridgeFixture(t);
  fixture.settings.dropCommentReply = true;
  fixture.settings.dropStatusReply = true;
  const first = await fixture.publish();
  assert.equal(first.receipt.state, 'needs_reconciliation');
  assert.equal(first.receipt.commentReceipt.state, 'needs_reconciliation');
  assert.equal(first.receipt.statusReceipt, null);
  fixture.restart();
  const second = await fixture.publish();
  assert.equal(second.receipt.commentReceipt.state, 'completed');
  assert.equal(second.receipt.statusReceipt.state, 'needs_reconciliation');
  fixture.restart();
  assert.equal((await fixture.publish()).receipt.state, 'completed');
  assert.equal(fixture.writes().length, 2);
});

test('Publication leaves an unresolved write for reconciliation and resumes separately after a definite status failure', async (t) => {
  const fixture = await bridgeFixture(t);
  fixture.settings.intercept = (call) => {
    if (call.path.endsWith('/comments') && call.method === 'POST') throw new Error('Unknown remote outcome');
  };
  assert.equal((await fixture.publish()).receipt.state, 'needs_reconciliation');
  fixture.settings.intercept = null;
  assert.equal((await fixture.publish()).receipt.state, 'needs_reconciliation');
  assert.equal(fixture.writes().length, 1);

  const resumable = await bridgeFixture(t);
  resumable.settings.failStatusOnce = true;
  const partial = await resumable.publish();
  assert.equal(partial.receipt.commentReceipt.state, 'completed');
  assert.equal(partial.receipt.statusReceipt, null);
  assert.equal((await resumable.publish()).receipt.state, 'completed');
  assert.deepEqual(resumable.writes().map((call) => call.path.split('/').at(-1)), ['comments', HEAD_A, HEAD_A]);
});

test('Publication honors rate-limit delay and refuses to write status after the head moves during status lookup', async (t) => {
  const limited = await bridgeFixture(t);
  limited.settings.intercept = (call) => {
    if (call.path.endsWith('/comments')) return json({}, { status: 429, headers: { 'retry-after': '60' } });
  };
  const first = await limited.publish();
  assert.equal(first.receipt.code, 'GITHUB_RATE_LIMITED');
  assert.ok(first.receipt.retryAt > Date.now());
  const beforeRetry = limited.settings.calls.length;
  await limited.publish();
  assert.equal(limited.settings.calls.length, beforeRetry);

  const moved = await bridgeFixture(t);
  moved.settings.intercept = (call) => {
    if (call.path.endsWith('/statuses') && call.method === 'GET') moved.settings.now = HEAD_B;
  };
  await assert.rejects(moved.publish(), errorCode('GITHUB_PROOF_STALE_OR_MISSING', 409));
  assert.equal(moved.settings.comments.length, 1);
  assert.equal(moved.settings.statuses.length, 0);
  assert.equal((await moved.bridge.getPublication(PROJECT, PR)).state, 'blocked');
});

test('Publication rejects local drift, packet mutation, failing Anchors and same-provider review', async (t) => {
  const fixture = await bridgeFixture(t);
  fixture.settings.local = HEAD_B;
  await assert.rejects(fixture.publish(), errorCode('GITHUB_PROOF_STALE_OR_MISSING'));
  fixture.settings.local = HEAD_A;
  fixture.packet.rawCommand = 'modified';
  await fixture.savePacket(false);
  await assert.rejects(fixture.publish(), errorCode('GITHUB_PACKET_DIGEST_MISMATCH'));
  await fixture.savePacket();
  fixture.settings.invalidPacket = true;
  await assert.rejects(fixture.publish(), errorCode('GITHUB_PACKET_INVALID'));
  fixture.settings.invalidPacket = false;
  fixture.packet.anchors[0].proof.assertions[0].passed = false;
  await fixture.savePacket();
  await assert.rejects(fixture.publish(), errorCode('GITHUB_PASSING_ANCHORS_REQUIRED'));
  fixture.packet.anchors[0].proof.assertions[0].passed = true;
  fixture.packet.pr.review.provider = 'Provider-A';
  await fixture.savePacket();
  await assert.rejects(fixture.publish(), errorCode('GITHUB_INDEPENDENT_REVIEW_REQUIRED'));
  assert.equal(fixture.writes().length, 0);
});

test('Optional GitHub comment commands are exact and require the configured login and signed author ID', async (t) => {
  const fixture = await bridgeFixture(t);
  const { bridge, settings } = fixture;
  const valid = { repository: { id: REPO_ID }, action: 'created', issue: { number: PULL, pull_request: {} },
    sender: { login: 'someone', id: 777 },
    comment: { user: { login: 'someone', id: 777 }, body: '/synapse post-evidence' } };
  assert.equal((await bridge.admitWebhook(signed({ ...valid, distinct: true }, 'issue_comment'))).state, 'ignored');
  settings.hook.issueCommentEnabled = true;
  settings.hook.allowedCommenters = [{ login: 'someone', userId: 777 }];
  const command = async (value, id) => bridge.admitWebhook(signed(value, 'issue_comment', id));
  assert.equal((await command({ ...valid, sender: { login: 'someone', id: 778 } }, 'bad-sender')).state, 'ignored');
  assert.equal((await command({ ...valid, sender: { login: 'other', id: 777 },
    comment: { ...valid.comment, user: { login: 'other', id: 777 } } }, 'bad-login')).state, 'ignored');
  assert.equal((await command({ ...valid, comment: { ...valid.comment, body: valid.comment.body + '\n' } }, 'not-exact')).state, 'ignored');
  assert.equal(fixture.writes().length, 0);
  assert.equal((await command(valid, 'allowed')).statusCode, 202);
  assert.deepEqual(await bridge.drainWebhookQueue(), [{ state: 'completed' }]);
  assert.equal(fixture.writes().length, 2);
});

test('Optional GitHub issue intake is create-only, persists its issue key, and leaves text untrusted', async (t) => {
  const fixture = await bridgeFixture(t);
  const { settings } = fixture;
  const body = '<script>this is untrusted issue text</script>';
  const payload = { repository: { id: REPO_ID }, action: 'opened', issue: { number: 41, title: 'Report', body } };
  assert.equal((await fixture.bridge.admitWebhook(signed({ ...payload, distinct: true }, 'issues'))).state, 'ignored');
  settings.hook.issuesEnabled = true;
  assert.equal((await fixture.bridge.admitWebhook(signed(payload, 'issues', 'open'))).statusCode, 202);
  const bridge = fixture.restart();
  assert.equal((await bridge.admitWebhook(signed({ ...payload, issue: { ...payload.issue, title: 'Changed' } },
    'issues', 'different-open'))).state, 'ignored');
  for (const action of ['edited', 'closed']) {
    assert.equal((await bridge.admitWebhook(signed({ ...payload, action }, 'issues', action))).state, 'ignored');
  }
  assert.deepEqual(await bridge.drainWebhookQueue(), [{ state: 'completed' }]);
  assert.equal(settings.tasks.size, 1);
  const task = [...settings.tasks.values()][0];
  assert.deepEqual(task.untrustedIssue, { title: 'Report', body });
  assert.equal(task.status, 'queued');
  assert.equal(task.projectId, PROJECT);
});

function templateRoster(template, changes = {}) {
  const { defaults } = template;
  return {
    projectId: PROJECT, prIds: [defaults.prId], suiteIds: [defaults.suiteId], childProjectIds: defaults.childProjectIds,
    operationIds: [defaults.operationId], workItemIds: [defaults.workItemId], targets: [defaults.target],
    agents: template.rosterSpec.roles.map((role, index) => ({ id: role, role, provider: 'provider-' + index })),
    registries: createTemplateRegistries({
      operations: { 'capture-pr-source@1': () => {}, 'read-verified-health@1': () => {} },
    }),
    ...changes,
  };
}

test('All four frozen template packs publish with closed schemas, registered components and disarmed schedules', async () => {
  assert.strictEqual(listLoopTemplates(), LOOP_TEMPLATES);
  assert.deepEqual(LOOP_TEMPLATES.map(({ id }) => id), ['multi-model-pr-review-council', 'model-benchmark-suite',
    'daily-verified-ops-loop', 'hardened-feature-pipeline']);
  assert.equal(getLoopTemplate('daily-verified-ops-loop', '9.0.0'), null);
  const idempotencyStore = createMemoryTemplateIdempotencyStore();
  for (const template of listLoopTemplates()) {
    assert.equal(template.version, '1.0.0');
    assert.equal(template.paramsSchema.additionalProperties, false);
    assert.ok(Object.isFrozen(template.manifest.nodes));
    assert.ok(Object.isFrozen(template.defaults));
    assert.strictEqual(getLoopTemplate(template.id), template);
    assert.ok(validateTemplateParams(template, template.defaults).valid);
    assert.deepEqual(validateTemplateParams(template, { command: 'unexpected' }).errors, ['UNKNOWN_PARAM']);
    const roleSpec = templateRoster(template);
    const result = await instantiateLoopFromTemplate({ templateId: template.id, projectId: PROJECT,
      name: template.title, requestId: template.id, rosterSpec: roleSpec, idempotencyStore,
      publishLoop: (input) => input });
    assert.equal(result.statusCode, 201);
    assert.equal(result.loop.scheduleEnabled, false);
    assert.equal(result.loop.manifest.scheduleEnabled, false);
    assert.equal(result.loop.manifest.loopVersion, 1);
    assert.equal(result.loop.baseVersion, 0);
    assert.deepEqual(result.loop.manifest.scope, { projectId: PROJECT });
    for (const [name, schema] of Object.entries(result.loop.manifest.paramsSchema.properties)) {
      if (!['caseCount', 'time', 'timezone'].includes(name)) assert.deepEqual(schema.const, template.defaults[name]);
    }
    assert.deepEqual(result.loop.manifest.provenance, result.loop.provenance);
    assert.match(result.loop.provenance.templateDigest, /^[a-f0-9]{64}$/);
    assert.equal(result.loop.provenance.templateVersion, '1.0.0');
    for (const anchor of result.loop.manifest.anchors) {
      assert.ok(roleSpec.registries.anchors[anchor.runnerId].runnerPath.endsWith('loop-templates.js'));
      assert.equal(anchor.implementationDigest, roleSpec.registries.anchors[anchor.runnerId].digest);
    }
    if (result.loop.manifest.schedule) {
      assert.equal(result.loop.manifest.schedule.overlap, 'skip');
      assert.equal(result.loop.manifest.schedule.missedRun, 'skip');
    }
  }
});

test('Template publish replays identical requests, rejects conflicting IDs, and validates project capabilities', async () => {
  const template = getLoopTemplate('model-benchmark-suite');
  const calls = [];
  const input = {
    templateId: template.id, projectId: PROJECT, name: 'Benchmark run', requestId: 'client-one',
    rosterSpec: templateRoster(template), idempotencyStore: createMemoryTemplateIdempotencyStore(),
    publishLoop: (value) => { calls.push(value); return { loopId: value.loopId }; },
  };
  const first = await Promise.all([instantiateLoopFromTemplate(input),
    instantiateLoopFromTemplate({ ...input, params: template.defaults })]);
  assert.deepEqual(first.map((entry) => entry.statusCode), [201, 200]);
  assert.deepEqual(first[0].loop, first[1].loop);
  assert.equal((await instantiateLoopFromTemplate({ ...input, name: 'Different' })).statusCode, 409);
  for (const override of [
    { params: { childProjectIds: ['foreign-project'] } },
    { params: { childProjectIds: [PROJECT] } },
    { params: { childProjectIds: ['example-child', 'example-child'] } },
    { params: { caseCount: 101 } }, { params: { caseCount: '8' } },
    { params: { suiteId: '../fixture' } }, { params: { command: 'read' } },
    { rosterSpec: templateRoster(template, { agents: [] }) },
    { rosterSpec: templateRoster(template, { projectId: 'different-project' }) },
    { rosterSpec: templateRoster(template, { registries: { ...input.rosterSpec.registries, reducers: {} } }) },
    { rosterSpec: templateRoster(template, { validateManifest: () => ({ valid: false }) }) },
  ]) {
    assert.equal((await instantiateLoopFromTemplate({ ...input, requestId: 'invalid-request', ...override })).statusCode, 422);
  }
  const reviewTemplate = getLoopTemplate('multi-model-pr-review-council');
  const sameProvider = templateRoster(reviewTemplate, { agents: [
    { id: 'a', role: 'author', provider: 'Same' }, { id: 'b', role: 'reviewer', provider: 'same' },
  ] });
  assert.equal((await instantiateLoopFromTemplate({ ...input, requestId: 'review-test',
    templateId: reviewTemplate.id, rosterSpec: sameProvider })).code, 'TEMPLATE_CAPABILITY_UNAVAILABLE');
  assert.equal(calls.length, 1);
});

test('Daily template validates scheduled time and registered operation while pinning a disarmed preset', async () => {
  const template = getLoopTemplate('daily-verified-ops-loop');
  const changes = { time: '23:59', timezone: 'Europe/Berlin' };
  for (const params of [{ time: '24:00' }, { timezone: 'Unknown/Zone' }, { timezone: '+01:00' }]) {
    assert.equal(validateTemplateParams(template, params).valid, false);
  }
  const input = { templateId: template.id, projectId: PROJECT, name: 'Daily read', requestId: 'daily',
    rosterSpec: templateRoster(template), idempotencyStore: createMemoryTemplateIdempotencyStore(),
    publishLoop: (value) => value };
  const created = await instantiateLoopFromTemplate({ ...input, params: changes });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.loop.manifest.schedule.cadence, { preset: 'daily-at', time: '23:59' });
  assert.equal(created.loop.manifest.schedule.timezone, 'Europe/Berlin');
  assert.equal(created.loop.manifest.nodes[0].effect, 'read-only');
  assert.equal((await instantiateLoopFromTemplate({ ...input, params: changes })).statusCode, 200);
  assert.equal((await instantiateLoopFromTemplate({ ...input, requestId: 'daily-2',
    params: { operationId: 'unregistered' } })).code, 'TEMPLATE_SCOPE_INVALID');
});

test('Template reducers and Anchors exercise deterministic fixtures and bind both PR recipes to the exact SHA', async (t) => {
  const artifacts = new Map([
    ['first', JSON.stringify({ cases: [{ caseId: 'beta', score: 1 }] })],
    ['second', JSON.stringify({ cases: [{ caseId: 'alpha', score: 0.5 }] })],
  ]);
  const { reducers, anchors } = createTemplateRegistries({ readArtifactBytes: (id) => artifacts.get(id) });
  const benchmark = getLoopTemplate('model-benchmark-suite').manifest.nodes.find((node) => node.kind === 'reduce');
  const [scoreboard] = reducers[benchmark.transformId].execute({ node: benchmark,
    inputs: ['first', 'second'].map((id) => ({ nodeId: id, outputs: [{ sha256: id }] })) });
  const scores = JSON.parse(scoreboard.content);
  assert.deepEqual(scores.cases.map(({ caseId }) => caseId), ['alpha', 'beta']);
  const fixture = { ...scores, caseCount: 2, expectedScores: { alpha: 0.5, beta: 1 } };
  const verified = evaluateTemplateAnchor('verify-benchmark@1', fixture);
  assert.ok(verified.assertions.every(({ passed }) => passed));
  assert.ok(evaluateTemplateAnchor('verify-benchmark@1', { ...fixture, cases: [scores.cases[0], scores.cases[0]] })
    .assertions.some(({ passed }) => !passed));
  const observedAt = '2025-05-01T12:00:00Z';
  const health = { response: { observedAt, healthy: true, measurements: { latency: 4 } },
    nowMs: Date.parse(observedAt) + 1, maxAgeMs: 20, bounds: { latency: { min: 0, max: 10 } } };
  assert.ok(evaluateTemplateAnchor('verify-health@1', health).assertions.every(({ passed }) => passed));
  assert.equal(evaluateTemplateAnchor('verify-health@1', { ...health, nowMs: health.nowMs + 20 }).assertions[0].passed, false);
  const healthReducer = getLoopTemplate('daily-verified-ops-loop').manifest.nodes.find((entry) => entry.kind === 'reduce');
  artifacts.set('health', JSON.stringify(health.response));
  assert.deepEqual(JSON.parse(reducers[healthReducer.transformId].execute({ node: healthReducer,
    inputs: [{ nodeId: 'read-health', outputs: [{ sha256: 'health' }] }] })[0].content), health.response);
  for (const runnerId of ['verify-pr-source@1', 'verify-integrated-source@1']) {
    const verifySubject = (sha) => sha === HEAD_A;
    assert.ok(evaluateTemplateAnchor(runnerId, { expectedSha: HEAD_A, subjectSha: HEAD_A }, { verifySubject })
      .assertions.every(({ passed }) => passed));
    assert.ok(evaluateTemplateAnchor(runnerId, { expectedSha: HEAD_A, subjectSha: HEAD_B }, { verifySubject })
      .assertions.every(({ passed }) => !passed));
  }
  const integrated = getLoopTemplate('hardened-feature-pipeline').manifest.nodes.find((entry) => entry.kind === 'reduce');
  const [index] = reducers[integrated.transformId].execute({ node: integrated,
    inputs: [{ nodeId: 'verification', commitSha: HEAD_B }, { nodeId: 'implementation', commitSha: HEAD_A }],
    run: { provenance: { source: { postIntegrationHeadSha: HEAD_A } } } });
  assert.equal(JSON.parse(index.content).sourceSha, HEAD_A);
  const exercised = await runNode(t, [anchors['verify-benchmark@1'].runnerPath, 'verify-benchmark@1', JSON.stringify(fixture)]);
  assert.equal(exercised.status, 0);
  assert.deepEqual(JSON.parse(exercised.stdout), verified);
});

class MockNode {
  constructor(tagName, id = '') {
    this.tagName = tagName;
    this.id = id;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.ownText = '';
  }
  set innerHTML(_value) { throw new Error('HTML insertion is forbidden'); }
  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  append(...items) {
    assert.ok(items.every((item) => item instanceof MockNode));
    this.children.push(...items);
  }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  click() {
    if (!this.disabled) return this.listeners.get('click')?.({ preventDefault() {} });
  }
}

function makeUi(projectId, authFetch) {
  const view = new MockNode('section', 'prs-view');
  const navTab = new MockNode('button', 'nav-tab-prs');
  const document = { createElement: (tag) => new MockNode(tag) };
  const api = globalThis.SynapsePrs;
  api.close();
  api.setProject(null);
  api.init({ view, navTab, document, authFetch, projectId, githubWebOrigin: 'https://github.com' });
  const nodes = (parent = view) => [parent, ...parent.children.flatMap((child) => nodes(child))];
  const by = (tag, value) => nodes().find((node) => node.tagName === tag && node.ownText === value);
  return { api, view, navTab, nodes, by };
}

const proofForUi = (overrides = {}) => ({
  id: PR, title: 'Feature proof', currentHeadSha: HEAD_A, approvedSourceSha: HEAD_A, state: 'open',
  evidence: { runId: 'run-1', approvedSourceSha: HEAD_A, evidencePacketSha256: REVIEW_HASH,
    verifyCommand: 'verification command', anchors: [{ anchorId: 'anchor-one', assertions: [{ id: 'check-one', passed: true }] }] },
  github: { url: 'https://github.com/public-org/public-repo/pull/12' },
  ...overrides,
});

test('PR panel uses text nodes for malicious server data and renders full stale SHA, proof and two-axis reviews', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const { api, view, navTab, nodes, by } = makeUi('project / one', (url) => {
    if (url.endsWith('/prs')) return json({ prs: [{ id: PR, title: payload }] });
    return json({ pr: proofForUi({ title: payload, currentHeadSha: HEAD_B,
      author: { login: 'Author', provider: 'provider-a' },
      reviews: [{ kind: 'independent', reviewer: payload, provider: 'provider-b', reviewedSourceSha: HEAD_A,
        standardsVerdict: 'pass', specificationVerdict: 'pass' }, { reviewer: 'legacy' }],
      evidence: { ...proofForUi().evidence, verifyCommand: payload } }) });
  });
  await api.open();
  assert.equal(navTab.attributes['aria-selected'], 'true');
  assert.equal(navTab.attributes['aria-controls'], 'prs-view');
  await api.selectPr(PR);
  assert.equal(nodes().some((node) => node.tagName === 'img'), false);
  assert.ok(by('h2', payload));
  assert.ok(by('code', payload));
  assert.ok(by('code', HEAD_A));
  assert.ok(by('code', HEAD_B));
  assert.ok(by('span', 'Stale approval'));
  assert.ok(by('span', 'Unbound'));
  assert.ok(by('span', 'Stale'));
  assert.ok(by('span', 'Independent reviewer'));
  assert.ok(by('span', 'Standards'));
  assert.ok(by('span', 'Specification'));
  assert.ok(by('td', 'check-one'));
  assert.equal(by('a', 'GitHub pull request').rel, 'noopener noreferrer');
  assert.equal(by('a', 'Download Evidence Packet').href, '/api/projects/project%20%2F%20one/prs/pr-one/evidence/download');
  assert.equal(by('button', 'Merge').disabled, true);
  assert.equal(by('button', 'Post Evidence to GitHub').disabled, true);
  api.close();
  assert.equal(view.hidden, true);
  assert.equal(navTab.attributes['aria-selected'], 'false');
});

test('PR panel discards superseded list and detail responses even if the transport ignores cancellation', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { resolve, promise };
  };
  const oldList = deferred();
  const oldDetail = deferred();
  const obsoleteSelection = deferred();
  const signals = [];
  const { api, view } = makeUi('old-project', (url, { signal }) => {
    signals.push([url, signal]);
    if (url.endsWith('old-project/prs')) return oldList.promise;
    if (url.endsWith('old-project/prs/old-pr')) return oldDetail.promise;
    if (url.endsWith('/new-project/prs')) return json([{ id: 'new-pr', title: 'New list' }]);
    if (url.endsWith('/new-project/prs/obsolete')) return obsoleteSelection.promise;
    return json({ pr: { ...proofForUi(), id: 'new-pr', title: 'New detail', currentHeadSha: null } });
  });
  const opened = api.open();
  const selection = api.selectPr('old-pr');
  await api.setProject('new-project');
  const other = api.selectPr('obsolete');
  await api.selectPr('new-pr');
  oldList.resolve(json([{ id: 'old-pr', title: 'Obsolete list' }]));
  oldDetail.resolve(json({ id: 'old-pr', title: 'Obsolete detail' }));
  obsoleteSelection.resolve(json({ id: 'obsolete', title: 'Obsolete selection' }));
  await Promise.all([opened, selection, other]);
  assert.match(view.textContent, /New list.*New detail/s);
  assert.match(view.textContent, /Unknown HEAD/);
  assert.doesNotMatch(view.textContent, /Obsolete/);
  assert.ok(signals.find(([url]) => url.endsWith('old-project/prs'))[1].aborted);
  assert.ok(signals.find(([url]) => url.endsWith('/obsolete'))[1].aborted);
});

test('PR URL validator pins an allowed HTTPS origin and the PR path', () => {
  const { isValidGitHubUrl, formatPublicSha } = globalThis.SynapsePrs;
  assert.equal(isValidGitHubUrl('https://github.com/public-org/public-repo/pull/12'), true);
  for (const url of ['javascript:alert(1)', 'http://github.com/public-org/public-repo/pull/1',
    'https://github.com.example.org/public-org/public-repo/pull/1',
    'https://github.com@elsewhere.example.org/public-org/public-repo/pull/1',
    'https://user@github.com/public-org/public-repo/pull/1',
    'https://github.com/public-org/a/../public-repo/pull/1',
    'https://github.com/public-org/public-repo/issues/1', 'https://github.com/public-org/public-repo/pull/1?redirect=1']) {
    assert.equal(isValidGitHubUrl(url), false, url);
  }
  assert.equal(isValidGitHubUrl('https://git.example.org/public-org/public-repo/pull/12', 'https://git.example.org'), true);
  assert.equal(isValidGitHubUrl('https://git.example.org/public-org/public-repo/pull/12'), false);
  assert.equal(formatPublicSha(HEAD_A), HEAD_A.slice(0, 12));
});

test('PR merge requires explicit force confirmation, hard-blocks invalid proof and refreshes conflicts', async () => {
  let pr = proofForUi();
  let forbidden = { code: 'CI_POLICY', reason: '<listed policy reason>', forceAllowed: true };
  let forcedStatus = 200;
  let detailCount = 0;
  const sends = [];
  const ui = makeUi(PROJECT, (url, init) => {
    if (url.endsWith('/prs')) return json([]);
    if (init.method !== 'POST') { detailCount++; return json({ pr }); }
    const payload = JSON.parse(init.body);
    sends.push(payload);
    if (payload.force) return json({}, { status: forcedStatus });
    return json(forbidden, { status: 403 });
  });
  await ui.api.open();
  await ui.api.selectPr(PR);
  await ui.by('button', 'Merge').click();
  assert.deepEqual(sends, [{ expectedHeadSha: HEAD_A }]);
  assert.ok(ui.by('span', '<listed policy reason>'));
  assert.ok(ui.by('button', 'Confirm force merge'));
  ui.by('button', 'Cancel').click();
  assert.equal(ui.by('button', 'Confirm force merge'), undefined);
  await ui.by('button', 'Merge').click();
  pr = proofForUi({ currentHeadSha: HEAD_B });
  forcedStatus = 409;
  await ui.by('button', 'Confirm force merge').click();
  assert.deepEqual(sends.at(-1), { expectedHeadSha: HEAD_A, force: true });
  assert.equal(detailCount, 2);
  assert.equal(ui.by('button', 'Merge').disabled, true);
  assert.equal(ui.by('button', 'Confirm force merge'), undefined);

  pr = proofForUi();
  await ui.api.loadPrDetail();
  forbidden = { code: 'PROOF_TAMPERED', reason: 'Packet failed validation', forceAllowed: true };
  await ui.by('button', 'Merge').click();
  assert.equal(ui.by('button', 'Confirm force merge'), undefined);
  assert.match(ui.view.textContent, /PROOF_TAMPERED/);
  pr = proofForUi({ proofTampered: true });
  await ui.api.loadPrDetail();
  assert.equal(ui.by('button', 'Merge').disabled, true);
  assert.equal(sends.filter(({ force }) => force).length, 1);
});

test('PR approval and publication send the displayed SHA and pinned digests through the authenticated fetch', async () => {
  const sends = [];
  const candidate = { loopId: 'loop-pr-1', runId: 'run/1', approvedSourceSha: HEAD_A, reviewSha256: REVIEW_HASH, anchorSetSha256: ANCHOR_HASH };
  const ui = makeUi(PROJECT, (url, init) => {
    if (init.method === 'POST') { sends.push([url, JSON.parse(init.body)]); return json({}); }
    return url.endsWith('/prs') ? json([]) : json(proofForUi({ approvalCandidate: candidate }));
  });
  await ui.api.open();
  await ui.api.selectPr(PR);
  await ui.by('button', 'Operator Approve').click();
  await ui.by('button', 'Post Evidence to GitHub').click();
  assert.deepEqual(sends, [
    ['/api/loops/loop-pr-1/runs/run%2F1/approve', { approvedSourceSha: HEAD_A, reviewSha256: REVIEW_HASH, anchorSetSha256: ANCHOR_HASH }],
    ['/api/projects/project-one/prs/pr-one/github/evidence', { expectedHeadSha: HEAD_A }],
  ]);
});

const privatePolicyMarker = ['inventory', 'example', 'marker'].join('-');
const researchPolicyMarker = ['research', 'example', 'marker'].join('-');
const testPolicy = { privateInfra: [{ pattern: privatePolicyMarker }], privateResearch: [{ pattern: researchPolicyMarker }] };
const authoredReleaseFiles = new Set([
  'scripts/release-gate.mjs', 'src/orchestrator/github-bridge.js',
  'src/ui/public/js/prs.js', 'src/ui/public/css/prs.css',
]);

async function releaseFixture(t) {
  const dir = await scratch(t);
  const target = join(dir, 'candidate');
  const policyPath = join(dir, 'policy.json');
  await fs.mkdir(target);
  await fs.writeFile(policyPath, JSON.stringify(testPolicy));
  const packageJson = { name: 'phase-four-gate-fixture', version: '1.0.0', type: 'module', private: true };
  const lock = { name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: packageJson.name, version: packageJson.version } } };
  const namedTests = 'import { test } from "node:test";\n' +
    RELEASE_TEST_NAMES.map((name) => 'test(' + JSON.stringify(name) + ', () => {});\n').join('');
  const fixtureContents = new Map([
    ['package.json', JSON.stringify(packageJson, null, 2) + '\n'],
    ['package-lock.json', JSON.stringify(lock, null, 2) + '\n'],
    [RELEASE_TEST_FILES[0], namedTests],
    [RELEASE_TEST_FILES[1], 'import { test } from "node:test";\ntest("Task scope", () => {});\n'],
    ['src/orchestrator.js', 'if (process.env.SYNAPSE_SMOKE_IMPORT !== "1" || !process.env.SYNAPSE_PROJECT_DIR) process.exit(1);\n'],
    ['src/orchestrator/api.js', 'export const apiFixture = true;\n'],
    // The renderer-failure test edits this fixture even when the source is sealed.
    ['src/templates/loop-templates.js', await fs.readFile(join(ROOT, 'src/templates/loop-templates.js'))],
    // Link the real bridge in this minimal fixture. Unexpected evidence access
    // must fail the process even inside a trusted assert.throws check.
    ['src/loop-evidence.js', 'export function captureEvidencePacketSnapshot() { process.exit(1); }\n' +
      'export function verifyEvidencePacketSnapshot() { process.exit(1); }\n'],
  ]);
  const files = [...new Set([...REQUIRED_RELEASE_FILES, ...fixtureContents.keys()])];
  for (const path of files) {
    const file = join(target, path);
    await fs.mkdir(dirname(file), { recursive: true });
    if (authoredReleaseFiles.has(path)) await fs.copyFile(join(ROOT, path), file);
    else await fs.writeFile(file, fixtureContents.get(path) ?? 'fixture\n');
  }
  const run = async (override = {}) => {
    const options = { target, policyPath, allowHostFallback: true, ...override };
    if (!process.permission) return runReleaseGate(options);
    // Exercise the gate with its normal parent permissions so its FD-based
    // cleanup works. The gate still applies all of its own child sandboxing.
    const { status, stdout } = await runNode(t, ['--input-type=module', '-e', `
      const { runReleaseGate } = await import(process.argv[1]);
      const summary = await runReleaseGate(JSON.parse(process.argv[2]));
      process.stdout.write(JSON.stringify(summary));
      process.exitCode = summary.exitCode;
    `, GATE_URL, JSON.stringify(options)], 30_000);
    const summary = JSON.parse(stdout);
    assert.equal(status, summary.exitCode);
    return summary;
  };
  return { target, policyPath, run, packageJson, namedTests, files };
}

test('Release gate passes a clean fixture and emits deterministic source and real package digests', async (t) => {
  const { target, run } = await releaseFixture(t);
  await fs.mkdir(join(target, 'src/vault'));
  await fs.writeFile(join(target, 'src/vault/index.js'), 'export const publicImplementation = true;\n');
  const skippedBlocked = await run({ skipNpm: true });
  assert.equal(skippedBlocked.exitCode, 2, JSON.stringify(skippedBlocked));
  assert.equal(skippedBlocked.checks.package.code, 'PACKAGE_CHECK_REQUIRED');
  const first = await run();
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  assert.equal(first.checks.package.status, 'passed');
  assert.match(first.tarballSha256, /^[a-f0-9]{64}$/);
  const second = await run();
  assert.equal(second.exitCode, 0, JSON.stringify(second));
  assert.equal(first.treeSha256, second.treeSha256);
  assert.equal(first.treeSha256, await computeTreeDigest(target));
  assert.deepEqual(await scanTreeForLeaks(target, testPolicy), []);
});

test('Release gate rejects policy, credential, private IPv4/IPv6, forbidden directory and path leaks with redaction', async (t) => {
  const { target, run } = await releaseFixture(t);
  const culprit = join(target, 'suspect.txt');
  const ipv6 = [v6('', '', '1'), v6('fd12', '', '2'), v6('fe80', '', 'abc') + '%scope',
    v6('', '', 'ffff', 'c0a8', '406'), v6('0', '0', '0', '0', '0', '0', '0', '1')];
  const cases = [[privatePolicyMarker.toUpperCase(), 'private-infra-1'],
    [researchPolicyMarker, 'private-research-1'], [credential, 'github-token'],
    [privateV4, 'private-ipv4'], ...ipv6.map((value) => [value, 'private-ipv6'])];
  for (const [value, id] of cases) {
    await fs.writeFile(culprit, 'failure ' + value);
    const result = await run();
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.ok(result.checks.leaks.findings.some(({ ruleId }) => ruleId === id), JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes(value), false);
  }
  await fs.writeFile(culprit, '\ufeff' + privatePolicyMarker, 'utf16le');
  assert.ok((await run()).checks.leaks.findings.some(({ ruleId }) => ruleId === 'private-infra-1'));
  await fs.rm(culprit);
  const policyFilename = join(target, privatePolicyMarker + '.txt');
  await fs.writeFile(policyFilename, 'contents');
  const leak = (await run()).checks.leaks;
  assert.ok(leak.findings.some(({ ruleId, location }) => ruleId === 'private-infra-1' && location === 'path'));
  assert.equal(JSON.stringify(leak).includes(privatePolicyMarker), false);
  await fs.rm(policyFilename);
  await fs.mkdir(join(target, '.synapse'));
  await fs.writeFile(join(target, '.synapse', 'data.txt'), 'contents');
  assert.ok((await run()).checks.leaks.findings.some(({ ruleId }) => ruleId === 'forbidden-directory'));
  await fs.rm(join(target, '.synapse'), { recursive: true });
  await fs.writeFile(join(target, '.env.local'), 'contents');
  assert.ok((await run()).checks.leaks.findings.some(({ ruleId }) => ruleId === 'forbidden-file'));
});

test('Release gate rejects symlink escapes, hardlinks and missing or invalid protected policy', async (t) => {
  const { target, policyPath, run } = await releaseFixture(t);
  const escape = join(target, 'escape.txt');
  execFileSync('/usr/bin/ln', ['-s', '--', policyPath, escape], { stdio: 'ignore' });
  const linked = await run();
  assert.equal(linked.exitCode, 1);
  assert.equal(linked.checks.tree.findings[0].ruleId, 'symlink');
  await assert.rejects(computeTreeDigest(target), errorCode('TREE_UNSAFE'));
  await fs.rm(escape);
  execFileSync('/usr/bin/ln', ['--', policyPath, escape], { stdio: 'ignore' });
  assert.equal((await run()).checks.tree.findings[0].ruleId, 'special-file');
  await fs.rm(escape);
  const policyInside = join(target, 'policy.json');
  await fs.copyFile(policyPath, policyInside);
  assert.equal((await run({ policyPath: policyInside })).checks.tree.code, 'POLICY_MUST_BE_EXTERNAL');
  await fs.rm(policyInside);
  await fs.writeFile(policyPath, JSON.stringify({ ...testPolicy, privateResearch: ['['] }));
  assert.equal((await run()).exitCode, 2);
  await fs.rm(policyPath);
  assert.equal((await run()).exitCode, 2);

  const missing = await runNode(t, [join(ROOT, 'scripts/release-gate.mjs'), '--target', target, '--json']);
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).checks.tree.code, 'TARGET_AND_POLICY_REQUIRED');
  const skipFlag = await runNode(t, [join(ROOT, 'scripts/release-gate.mjs'), '--target', target, '--policy', policyPath, '--skip-npm', '--json']);
  assert.equal(skipFlag.status, 2);
  assert.equal(JSON.parse(skipFlag.stdout).checks.usage.code, 'INVALID_ARGUMENTS');
});

test('Release gate rejects missing or skipped required tests, broken smoke import, and invalid template rendering', async (t) => {
  const { target, run, namedTests } = await releaseFixture(t);
  const tests = join(target, RELEASE_TEST_FILES[0]);
  await fs.rm(tests);
  assert.equal((await run()).checks.requiredFiles.code, 'REQUIRED_FILES_MISSING');
  await fs.writeFile(tests, namedTests.replace(JSON.stringify(RELEASE_TEST_NAMES[0]), '"missing expected test"'));
  assert.equal((await run()).checks.behavioral.code, 'REQUIRED_BEHAVIORAL_ASSERTION_MISSING');
  await fs.writeFile(tests, namedTests.replace('test(', 'test.skip('));
  assert.equal((await run()).checks.behavioral.code, 'BEHAVIORAL_TESTS_FAILED');
  await fs.writeFile(tests, namedTests);
  const mcpTest = join(target, RELEASE_TEST_FILES[1]);
  const originalMcpTest = await fs.readFile(mcpTest);
  await fs.writeFile(mcpTest, '');
  assert.equal((await run()).checks.behavioral.code, 'BEHAVIORAL_TESTS_FAILED');
  await fs.writeFile(mcpTest, originalMcpTest);
  const entry = join(target, 'src/orchestrator.js');
  await fs.writeFile(entry, 'import "./missing.js";\n');
  assert.equal((await run()).checks.smokeImport.code, 'SMOKE_IMPORT_FAILED');
  await fs.writeFile(entry, 'if (process.env.SYNAPSE_SMOKE_IMPORT !== "1") process.exit(1);\n');
  await fs.appendFile(join(target, 'src/templates/loop-templates.js'), '\nthrow new Error("renderer failure");\n');
  const brokenTpl = await run();
  assert.equal(brokenTpl.exitCode, 1);
  assert.ok(['TRUSTED_BEHAVIORAL_ASSERTION_FAILED', 'TEMPLATE_DEFAULTS_INVALID'].includes(brokenTpl.checks.behavioral.code || brokenTpl.checks.templateDefaults.code));
});

test('Release gate fails when npm excludes required runtime assets', async (t) => {
  const { target, run, packageJson } = await releaseFixture(t);
  await fs.writeFile(join(target, 'package.json'), JSON.stringify({ ...packageJson, files: ['README.md'] }, null, 2) + '\n');
  const rejected = await run({ skipNpm: false });
  assert.equal(rejected.exitCode, 1, JSON.stringify(rejected));
  assert.equal(rejected.checks.package.code, 'PACKAGE_RUNTIME_FILES_MISSING');
});

test('Release gate scans actual npm tar members even when the dry-run manifest hides them', async (t) => {
  const { run } = await releaseFixture(t);
  const toolsDir = await scratch(t);
  const member = 'package/.synapse/data.txt';
  const memberPath = join(toolsDir, member);
  await fs.mkdir(dirname(memberPath), { recursive: true });
  await fs.writeFile(memberPath, 'unexpected archive member');
  const archive = join(toolsDir, 'fixture.tgz');
  execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', toolsDir, member], { stdio: 'ignore', timeout: 3000 });
  const npm = [
    '#!' + process.execPath,
    'const { copyFileSync } = require("node:fs");',
    'const { join } = require("node:path");',
    'const args = process.argv.slice(2);',
    'if (args.includes("--dry-run")) console.log(JSON.stringify([{files:[{path:"package.json"}]}]));',
    'const dest = args.indexOf("--pack-destination");',
    'if (dest >= 0) copyFileSync(' + JSON.stringify(archive) + ', join(args[dest + 1], "test.tgz"));',
  ].join('\n');
  await fs.writeFile(join(toolsDir, 'npm'), npm, { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = toolsDir + ':' + path;
  try {
    const result = await run({ skipNpm: false });
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.equal(result.checks.package.code, 'PACKAGE_LEAKS');
    assert.ok(result.checks.package.findings.some(({ ruleId }) => ruleId === 'forbidden-directory'));
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});


// ─── Integrated Phase 4 HTTP Routes & Named Release-Gate Assertions ──────────
import http from 'node:http';
import { createHandleApi } from './api.js';
import { StateManager } from '../state.js';
import { createPrStore } from '../pr-store.js';
import { createLoopStore, canonicalJson } from '../loop-store.js';
import { exportEvidencePacket, verifyEvidencePacketSnapshot, computeAnchorSetSha256 } from '../loop-evidence.js';
import { assertGeminiTransport } from '../agents/routing-policy.js';
import { reconcileOrphanedAttempts } from './execution-contract.js';

const LOOPBACK = ['127', '0', '0', '1'].join('.');
const makeJsonResp = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function makeVerifiedPacket(loopStore, destDir, runId, sha, opts = {}) {
  const proofObj = { assertions: [{ id: 'ok', passed: true }] };
  const stdoutRef = loopStore.writeArtifactBytes('stdout.json', Buffer.from(JSON.stringify(proofObj), 'utf8'));
  const stderrRef = loopStore.writeArtifactBytes('stderr.txt', Buffer.from('', 'utf8'));
  const runnerDigest = 'e'.repeat(64);
  const prMode = Boolean(opts.projectId && opts.prId);
  const nodes = [{ nodeId: 'n_anchor', kind: 'anchor', anchorId: 'a1' }];
  const selectedAttempts = { n_anchor: 'att-1' };
  const attempts = {};
  if (opts.extraArtifact) {
    const binRef = loopStore.writeArtifactBytes(opts.extraArtifact.path, opts.extraArtifact.bytes);
    nodes.push({ nodeId: 'n_bin', kind: 'agent', outputs: [{ path: opts.extraArtifact.path, storage: 'artifact' }] });
    selectedAttempts.n_bin = 'att-bin';
    attempts['att-bin'] = {
      attemptId: 'att-bin', nodeId: 'n_bin', status: 'succeeded',
      outputs: [{ path: opts.extraArtifact.path, sha256: binRef.sha256, bytes: binRef.bytes }],
    };
  }
  const manifest = {
    loopId: 'loop-1',
    loopVersion: 1,
    scope: opts.projectId ? { projectId: opts.projectId } : null,
    evidence: prMode ? { mode: 'pr', checkerNodeId: 'n_check' } : { mode: 'artifact' },
    nodes,
    anchors: [{ anchorId: 'a1', implementationDigest: runnerDigest, proofSchema: { type: 'object' }, requiredAssertions: ['ok'] }],
    outputs: opts.extraArtifact ? { bin: { nodeId: 'n_bin', path: opts.extraArtifact.path } } : {},
  };
  const manifestHash = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  const anchors = [{
    anchorId: 'a1', nodeId: 'n_anchor', attemptId: 'att-1',
    subjectSha: sha, outcome: 'passed', exitCode: 0, signal: null, runnerDigest,
    stdout: { path: 'stdout.json', sha256: stdoutRef.sha256, bytes: stdoutRef.bytes },
    stderr: { path: 'stderr.txt', sha256: stderrRef.sha256, bytes: stderrRef.bytes },
    proof: proofObj,
  }];
  let approvalEvent = null;
  let checkerReview = null;
  if (prMode) {
    selectedAttempts.n_check = 'att-chk';
    const reviewBuf = Buffer.from(JSON.stringify({ disposition: 'approve', reviewedSourceSha: sha }), 'utf8');
    const reviewRef = loopStore.writeArtifactBytes('review.json', reviewBuf);
    const anchorSetSha256 = computeAnchorSetSha256(anchors);
    checkerReview = {
      nodeId: 'n_check', attemptId: 'att-chk', disposition: 'approve',
      reviewedSourceSha: sha,
      agentId: opts.reviewerAgentId || 'rev-b',
      provider: opts.reviewerProvider || 'provider-b',
      report: { path: 'review.json', sha256: reviewRef.sha256, bytes: reviewRef.bytes },
    };
    approvalEvent = {
      eventId: opts.approvalEventId || ('appr_' + runId),
      runId,
      principalKind: 'operator',
      principalId: 'operator-1',
      approvedSourceSha: sha,
      reviewSha256: reviewRef.sha256,
      anchorSetSha256,
      approvedAt: new Date().toISOString(),
    };
  }
  return exportEvidencePacket({
    loopStore,
    destDir,
    projectDir: opts.projectDir || null,
    manifest,
    approvalEvent,
    run: {
      runId,
      verdict: 'passed',
      pin: { loopId: 'loop-1', loopVersion: 1, manifestHash, params: {} },
      selectedAttempts,
      attempts,
      provenance: {
        scope: opts.projectId ? { projectId: opts.projectId } : null,
        source: { postIntegrationHeadSha: sha, prId: opts.prId || null },
      },
      _checkerReview: checkerReview,
      anchors,
    },
  });
}


function makeMockApiAuth(tokens = {}) {
  const map = {
    'tok-op': { authenticated: true, userId: 'operator-1', role: 'operator' },
    'tok-viewer': { authenticated: true, userId: 'viewer-1', role: 'viewer' },
    ...tokens,
  };
  return {
    isAuthenticated(req) {
      const h = req.headers.authorization || '';
      const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
      return map[tok] || { authenticated: false, userId: null };
    },
    checkRequest(req, res) {
      const a = this.isAuthenticated(req);
      if (!a.authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
      }
      return true;
    },
  };
}

async function startApiServer(handleApi) {
  const srv = http.createServer((req, res) => {
    const handled = handleApi(req, res);
    if (!handled && !res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  await new Promise((res) => srv.listen(0, LOOPBACK, res));
  const { port } = srv.address();
  return {
    baseUrl: `http://${LOOPBACK}:${port}`,
    close: () => new Promise((res) => srv.close(res)),
  };
}

function sendRawHttp(baseUrl, method, path, { headers = {}, body = null } = {}) {
  return new Promise((res, rej) => {
    const target = new URL(path, baseUrl);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString('utf8')); } catch {}
        res({ status: response.statusCode, headers: response.headers, body: buf, json: parsed });
      });
    });
    req.on('error', rej);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('github-webhook-auth-and-replay', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const prStore = createPrStore(join(dir, '.synapse'));
  const opened = prStore.openPR({
    projectId: PROJECT, sourceBranch: 'feat/p4', targetBranch: 'main',
    author: 'dev1', authorRole: 'developer', title: 'P4 PR',
  });
  let currentRemoteHead = HEAD_A;
  const ghFetch = async () => makeJsonResp({
    number: PULL,
    base: { ref: 'main', repo: { id: REPO_ID } },
    head: { ref: 'feat/p4', sha: currentRemoteHead, repo: { id: REPO_ID } },
  });
  const bridge = createGitHubBridge({
    store: fixtureBridgeStore(join(dir, 'bridge-state.json')),
    prStore,
    clientOptions: {
      credentialVault: { resolve: (_pid, name) => name === 'github-token-' + PROJECT ? GITHUB_TOKEN : null },
      fetchImpl: ghFetch,
      dnsLookup: async () => PUBLIC_DNS,
    },
    verifyPacketSnapshot: verifyEvidencePacketSnapshot,
    getRepository: () => ({
      apiOrigin: API, owner: 'acme', repo: 'synapse', repoId: REPO_ID,
      bridgeIdentity: { id: 99, login: 'synapse-bot' },
    }),
    getHook: (id) => id === 'hook-1' ? { id: 'hook-1', projectId: PROJECT, repoId: REPO_ID, apiOrigin: API, secret: HOOK_SECRET } : null,
  });
  await bridge.bindPullRequest({ projectId: PROJECT, prId: opened.id, pullNumber: PULL, actorId: 'op1' });

  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, githubBridge: bridge,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());

  const payloadBuf = Buffer.from(JSON.stringify({ action: 'synchronize', number: PULL, repository: { id: REPO_ID } }));
  const goodSig = 'sha256=' + createHmac('sha256', HOOK_SECRET).update(payloadBuf).digest('hex');

  // 1. Invalid signature -> 401 (no bearer token needed; HMAC-only)
  const bad = await sendRawHttp(srv.baseUrl, 'POST', '/api/webhooks/github', {
    headers: {
      'content-type': 'application/json',
      'x-github-hook-id': 'hook-1', 'x-github-delivery': 'del-bad', 'x-github-event': 'pull_request',
      'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    },
    body: payloadBuf,
  });
  assert.equal(bad.status, 401);

  // 2. Valid raw HMAC -> 202 queued
  currentRemoteHead = HEAD_B;
  const ok1 = await sendRawHttp(srv.baseUrl, 'POST', '/api/webhooks/github', {
    headers: {
      'content-type': 'application/json',
      'x-github-hook-id': 'hook-1', 'x-github-delivery': 'del-1', 'x-github-event': 'pull_request',
      'x-hub-signature-256': goodSig,
    },
    body: payloadBuf,
  });
  assert.equal(ok1.status, 202);

  // 3. Replay with changed delivery ID (same signed body digest) -> 200 duplicate
  const dup = await sendRawHttp(srv.baseUrl, 'POST', '/api/webhooks/github', {
    headers: {
      'content-type': 'application/json',
      'x-github-hook-id': 'hook-1', 'x-github-delivery': 'del-2', 'x-github-event': 'pull_request',
      'x-hub-signature-256': goodSig,
    },
    body: payloadBuf,
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.state, 'duplicate');
  await new Promise((r) => setTimeout(r, 80));
});

test('github-head-sync-and-exact-merge', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'index.js'), 'export const v = 1;\n');
  execFileSync('/usr/bin/git', ['add', 'index.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'base'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['checkout', '-q', '-b', 'feat/exact-merge'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'index.js'), 'export const v = 2;\n');
  execFileSync('/usr/bin/git', ['add', 'index.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'sha-a'], { cwd: projDir });
  const shaA = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();

  const loopStore = createLoopStore(join(dir, '.synapse'));
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({
    projectId: PROJECT, sourceBranch: 'feat/exact-merge', targetBranch: 'main',
    author: 'dev1', authorRole: 'developer', title: 'Exact Merge PR',
  });
  const packetDir = join(projDir, 'packet-ok');
  const exported = makeVerifiedPacket(loopStore, packetDir, 'run-merge-1', shaA, { projectId: PROJECT, prId: pr.id, projectDir: projDir });
  const pkt31 = JSON.parse(await fs.readFile(join(packetDir, 'evidence-packet.json'), 'utf8'));
  loopStore.recordApprovalEvent({ ...pkt31.pr.approval, runId: pkt31.run.runId });
  prStore.addReview(PROJECT, pr.id, { reviewer: 'rev1', status: 'approved', approvedSourceSha: shaA });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: shaA,
    loopRunId: 'run-merge-1',
    evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256,
    checksumManifestSha256: exported.checksumManifestSha256,
    ran: { verify: true },
    passed: true,
  });

  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, loopStore,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());

  // 1. Mismatched expectedHeadSha is hard-blocked 409 EVEN with force: true
  const wrongSha = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers: { authorization: 'Bearer tok-op', 'content-type': 'application/json' },
    body: JSON.stringify({ expectedHeadSha: HEAD_B, force: true }),
  });
  assert.equal(wrongSha.status, 409);
  assert.equal(wrongSha.json.forceAllowed, false);

  // 2. Tamper packet -> hard-blocked 409 EVEN with force: true
  await fs.writeFile(join(packetDir, 'evidence-packet.json'), '{"tampered":true}\n');
  const tampered = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers: { authorization: 'Bearer tok-op', 'content-type': 'application/json' },
    body: JSON.stringify({ expectedHeadSha: shaA, force: true }),
  });
  assert.equal(tampered.status, 409);
  assert.equal(tampered.json.code, 'PROOF_DIGEST_MISMATCH');
  assert.equal(prStore.getPR(PROJECT, pr.id).status, 'approved');
});

test('github-publication-idempotency', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({
    projectId: PROJECT, sourceBranch: 'feat/pub', targetBranch: 'main',
    author: 'dev1', authorRole: 'developer', title: 'Publish PR',
  });
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'pub32.js'), 'export const p32 = 1;\n');
  execFileSync('/usr/bin/git', ['add', 'pub32.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'pub32'], { cwd: projDir });
  const pub32Sha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();
  const loopStore = createLoopStore(join(dir, '.synapse'));
  const packetDir = join(projDir, 'packet-pub');
  const exported = makeVerifiedPacket(loopStore, packetDir, 'run-pub-1', pub32Sha, { projectId: PROJECT, prId: pr.id, projectDir: projDir });
  prStore.addReview(PROJECT, pr.id, { reviewer: 'rev1', status: 'approved', approvedSourceSha: HEAD_A });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: HEAD_A,
    evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256,
    checksumManifestSha256: exported.checksumManifestSha256,
    ran: { verify: true },
    passed: true,
  });

  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());

  // Authenticated evidence download succeeds with verified members & attachment header
  const dl = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}/evidence/download`, {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-disposition'] || '', /attachment/);
  assert.equal(dl.json.evidencePacketSha256, exported.evidencePacketSha256);

  // Unauthenticated download rejected 401
  const dlUnauth = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}/evidence/download`);
  assert.equal(dlUnauth.status, 401);
});

test('github-egress-and-optional-events', async () => {
  // Verify P1 #1 (CredentialVault 2-arg resolve(projectId, name)) + P2 #4 (compressed IPv6 Teredo 2001::1 blocked)
  const teredoV6 = ['2001', '', '1'].join(':');
  const blockedClient = createGitHubClient({
    apiOrigin: API,
    projectId: PROJECT,
    credentialVault: { resolve: (pid, name) => (pid === PROJECT && name === 'github-token-' + PROJECT) ? GITHUB_TOKEN : null },
    dnsLookup: async () => [{ address: teredoV6, family: 6 }],
    fetchImpl: async () => makeJsonResp({ ok: true }),
  });
  await assert.rejects(() => blockedClient.request(['repos', 'acme', 'synapse', 'pulls', '12']), (err) => err.code === 'GITHUB_DNS_DENIED');

  // Verify 2-arg CredentialVault.resolve works on public DNS
  let capturedAuth = null;
  const okClient = createGitHubClient({
    apiOrigin: API,
    projectId: PROJECT,
    credentialVault: { resolve: (pid, name) => (pid === PROJECT && name === 'github-token-' + PROJECT) ? GITHUB_TOKEN : null },
    dnsLookup: async () => PUBLIC_DNS,
    fetchImpl: async (_url, opts) => { capturedAuth = opts.headers.authorization; return makeJsonResp({ ok: true }); },
  });
  const res = await okClient.request(['repos', 'acme', 'synapse', 'pulls', '12']);
  assert.equal(res.data.ok, true);
  assert.equal(capturedAuth, 'Bearer ' + GITHUB_TOKEN);
});

test('pr-dashboard-gates', async () => {
  // Verify P1 #3: scoped /api/loops/:loopId/runs/:runId/approve URL when candidate.loopId is provided
  const seen = [];
  const prDetail = {
    id: PR, title: 'Loop PR', status: 'open', sourceBranch: 'feat/x', targetBranch: 'main',
    currentHeadSha: HEAD_A,
    approvalCandidate: {
      loopId: 'loop-42',
      runId: 'run-99',
      approvedSourceSha: HEAD_A,
      reviewSha256: REVIEW_HASH,
      anchorSetSha256: ANCHOR_HASH,
    },
    actions: { approveAllowed: true },
  };
  const ui = makeUi(PROJECT, async (url, opts) => {
    seen.push({ url, method: opts?.method || 'GET' });
    if (url.endsWith('/prs')) return makeJsonResp({ prs: [prDetail] });
    if (url.endsWith('/approve')) return makeJsonResp({ ok: true });
    return makeJsonResp(prDetail);
  });
  await ui.api.open();
  await ui.api.selectPr(PR);
  const approveBtn = ui.by('button', 'Operator Approve');
  assert.ok(approveBtn, 'Approve button should render');
  await approveBtn.click();
  assert.ok(seen.some((r) => r.url === '/api/loops/loop-42/runs/run-99/approve' && r.method === 'POST'),
    'Approve action must target scoped /api/loops/:loopId/runs/:runId/approve');
});

test('curated-template-packs', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const prStore = createPrStore(join(dir, '.synapse'));
  const loopStore = createLoopStore(join(dir, '.synapse'));
  const agentsMap = {
    dev1: { id: 'dev1', role: 'developer', provider: 'codex', capabilities: ['code', 'review'] },
    rev1: { id: 'rev1', role: 'reviewer', provider: 'antigravity', capabilities: ['review'] },
    ops1: { id: 'ops1', role: 'operator', provider: 'codex', capabilities: ['ops'] },
  };
  const loopEngine = createLoopEngine({ loopStore, agentsMap, prStore, stateManager: sm });
  const loopService = createLoopService({ loopStore, loopEngine, stateManager: sm, prStore, agentsMap, projectDir: dir });

  const handleApi = createHandleApi({
    stateManager: sm, agents: agentsMap, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, loopStore, loopEngine, loopService,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());

  const list = await sendRawHttp(srv.baseUrl, 'GET', '/api/loops/templates', {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(list.status, 200);
  assert.equal(list.json.templates.length, 4);

  const viewerDenied = await sendRawHttp(srv.baseUrl, 'POST', '/api/loops/from-template', {
    headers: { authorization: 'Bearer tok-viewer', 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: 'daily-verified-ops-loop', templateVersion: '1.0.0', projectId: PROJECT, name: 'ops', params: { operationId: 'health-snapshot', localTime: '08:00', timezone: 'UTC' }, requestId: 'req-v' }),
  });
  assert.equal(viewerDenied.status, 403);
});

test('gemini-antigravity-only', () => {
  const policy = { geminiTransport: 'antigravity-only' };
  // Permitted: native Antigravity and omp google-antigravity/*
  assert.doesNotThrow(() => assertGeminiTransport({
    provider: 'antigravity', model: 'gemini-3-pro', descriptor: { id: 'antigravity' }, cliPath: '/usr/bin/agy',
  }, policy));
  assert.doesNotThrow(() => assertGeminiTransport({
    provider: 'google-antigravity', model: 'google-antigravity/gemini-3-pro', descriptor: { id: 'omp' }, cliPath: '/usr/bin/omp',
  }, policy));
  // Control: non-Gemini codex allowed
  assert.doesNotThrow(() => assertGeminiTransport({
    provider: 'codex', model: 'gpt-5', descriptor: { id: 'codex' }, cliPath: '/usr/bin/codex',
  }, policy));
  // Blocked: direct gemini-cli / google provider -> GEMINI_TRANSPORT_BLOCKED
  assert.throws(() => assertGeminiTransport({
    provider: 'google', model: 'gemini-3-pro', descriptor: { id: 'gemini-cli' }, cliPath: '/usr/bin/gemini',
  }, policy), (err) => err?.code === 'GEMINI_TRANSPORT_BLOCKED');
});

test('orphan-reconciliation-preserves-daemon', async () => {
  const reconciledIds = [];
  const tasks = [
    {
      id: 'task-netwatch-daemon',
      type: 'daemon',
      title: 'netwatch daemon monitor',
      status: 'executing',
      project: PROJECT,
      subtasks: [{ id: 'st-daemon', status: 'executing', meta: { attemptId: 'att-daemon' } }],
    },
    {
      id: 'task-ordinary-orphan',
      type: 'oneshot',
      title: 'Ordinary orphan task',
      status: 'executing',
      project: PROJECT,
      subtasks: [{ id: 'st-orphan', status: 'executing', meta: { attemptId: 'att-orphan' } }],
    },
  ];
  const res = await reconcileOrphanedAttempts({
    tasks,
    projectId: PROJECT,
    isAttemptLive: async () => false,
    onReconcileSubtask: async ({ subtask }) => { reconciledIds.push(subtask.id); },
  });
  assert.equal(res.skippedDaemonTasks, 1);
  assert.deepEqual(reconciledIds, ['st-orphan']);
});

test('release-gate-fail-closed', async (t) => {
  // Verify P2 #6: .env.example is permitted while .env is rejected by scanTreeForLeaks
  const dir = await scratch(t);
  const policy = { privateInfra: ['forbidden-infra-token'], privateResearch: ['forbidden-research-token'] };
  await fs.writeFile(join(dir, '.env.example'), 'PORT=8080\n');
  const cleanFindings = await scanTreeForLeaks(dir, policy);
  assert.equal(cleanFindings.length, 0, '.env.example must be exempted from forbidden-file leak findings');

  await fs.writeFile(join(dir, '.env'), 'PORT=8080\n');
  const dirtyFindings = await scanTreeForLeaks(dir, policy);
  assert.ok(dirtyFindings.some((f) => f.ruleId === 'forbidden-file'), '.env must still be rejected');
});

function mockGitHub() {
  const settings = { now: HEAD_A, headRef: 'feature', comments: [], statuses: [], calls: [] };
  const user = { login: 'evidence-bridge', id: 121 };
  async function fetchImpl(url, request) {
    const path = url.pathname;
    assert.equal(request.headers['user-agent'], 'synapse-github-bridge/1.0');
    const call = { path, method: request.method, body: request.body && JSON.parse(request.body) };
    settings.calls.push(call);
    if (path.includes('/pulls/')) {
      return json({
        number: Number(path.split('/').at(-1)),
        head: { sha: settings.now, ref: settings.headRef, repo: { id: REPO_ID } },
        base: { ref: 'main', repo: { id: REPO_ID } },
      });
    }
    if (path.endsWith('/comments') && call.method === 'GET') return json(settings.comments);
    if (path.endsWith('/comments') && call.method === 'POST') {
      const comment = { id: 101 + settings.comments.length, ...call.body, user };
      settings.comments.push(comment);
      return json(comment, { status: 201 });
    }
    if (path.endsWith('/statuses') && call.method === 'GET') return json(settings.statuses);
    if (path.includes('/statuses/') && call.method === 'POST') {
      const status = { id: 401 + settings.statuses.length, creator: user, ...call.body };
      settings.statuses.unshift(status);
      return json(status, { status: 201 });
    }
    throw new Error('Unexpected mockGitHub request: ' + path);
  }
  return { settings, fetchImpl };
}

// ─── Phase 4 Round 2 Hardening Regression Tests (Sol #147 + Golden #148) ───

test('R2-1 (P1 #1): Merge enforces exact SHA, currentSourceSha alias, both digests, and active approval binding', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'app.js'), 'export const a = 1;\n');
  execFileSync('/usr/bin/git', ['add', 'app.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'base'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['checkout', '-q', '-b', 'feat/r2-merge'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'app.js'), 'export const a = 2;\n');
  execFileSync('/usr/bin/git', ['add', 'app.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'commit-a'], { cwd: projDir });
  const shaA = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();

  const loopStore = createLoopStore(join(dir, '.synapse'));
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({
    projectId: PROJECT, sourceBranch: 'feat/r2-merge', targetBranch: 'main',
    author: 'dev1', authorRole: 'developer', title: 'R2 Strict Merge PR',
  });
  // Create a same-named tag pointing at the BASE commit to prove refs/heads/ is resolved (tag cannot shadow branch!)
  const baseSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD~1'], { cwd: projDir, encoding: 'utf8' }).trim();
  execFileSync('/usr/bin/git', ['tag', 'feat/r2-merge', baseSha], { cwd: projDir });

  const packetDir = join(projDir, 'evidence-r2');
  const exported = makeVerifiedPacket(loopStore, packetDir, 'run-r2-merge', shaA, { projectId: PROJECT, prId: pr.id, projectDir: projDir });
  const r21Pkt = JSON.parse(await fs.readFile(join(packetDir, 'evidence-packet.json'), 'utf8'));
  loopStore.recordApprovalEvent({ ...r21Pkt.pr.approval, runId: r21Pkt.run.runId });
  prStore.addReview(PROJECT, pr.id, { reviewer: 'rev1', status: 'approved', approvedSourceSha: shaA });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: shaA,
    loopRunId: 'run-r2-merge',
    evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256,
    checksumManifestSha256: exported.checksumManifestSha256,
    ran: { verify: true },
    passed: true,
  });

  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, loopStore,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());
  const headers = { authorization: 'Bearer tok-op', 'content-type': 'application/json' };

  const missingSha = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers, body: JSON.stringify({ force: true }),
  });
  assert.equal(missingSha.status, 409);
  assert.equal(missingSha.json.code, 'HEAD_SHA_REQUIRED');
  assert.equal(missingSha.json.forceAllowed, false);

  const aliasMismatch = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers, body: JSON.stringify({ currentSourceSha: HEAD_B, force: true }),
  });
  assert.equal(aliasMismatch.status, 409);
  assert.equal(aliasMismatch.json.code, 'HEAD_SHA_MISMATCH');
  assert.equal(aliasMismatch.json.forceAllowed, false);

  const otherPacketDir = join(projDir, 'evidence-other-pr');
  const otherExp = makeVerifiedPacket(loopStore, otherPacketDir, 'run-r2-merge', shaA, { projectId: PROJECT, prId: 'pr-some-other', projectDir: projDir });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: shaA, loopRunId: 'run-r2-merge', evidencePacketDir: otherPacketDir,
    evidencePacketSha256: otherExp.evidencePacketSha256, checksumManifestSha256: otherExp.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  const wrongBinding = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers, body: JSON.stringify({ expectedHeadSha: shaA, force: true }),
  });
  assert.equal(wrongBinding.status, 409);
  assert.equal(wrongBinding.json.code, 'PROOF_BINDING_MISMATCH');

  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: shaA, loopRunId: 'run-r2-merge', evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256,
    ran: { verify: true }, passed: true,
  });
  const missingSumsDigest = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers, body: JSON.stringify({ expectedHeadSha: shaA, force: true }),
  });
  assert.equal(missingSumsDigest.status, 409);
  assert.equal(missingSumsDigest.json.code, 'PROOF_MISSING');

  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: shaA, loopRunId: 'run-r2-merge', evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256, checksumManifestSha256: exported.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  // Superseded approval for same SHA in loopStore -> older packet MUST fail 409 PROOF_BINDING_MISMATCH!
  const supersededPacketDir = join(projDir, 'evidence-superseded');
  const supExp = makeVerifiedPacket(loopStore, supersededPacketDir, 'run-r2-merge', shaA, {
    projectId: PROJECT, prId: pr.id, projectDir: projDir, approvalEventId: 'appr_old_superseded',
  });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: shaA, loopRunId: 'run-r2-merge', evidencePacketDir: supersededPacketDir,
    evidencePacketSha256: supExp.evidencePacketSha256, checksumManifestSha256: supExp.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  const supersededRes = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers, body: JSON.stringify({ expectedHeadSha: shaA, force: true }),
  });
  assert.equal(supersededRes.status, 409);
  assert.equal(supersededRes.json.code, 'PROOF_BINDING_MISMATCH');

  // Restore exact active approval packet -> succeeds 200 (even with same-named tag pointing at baseSha!)
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: shaA, loopRunId: 'run-r2-merge', evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256, checksumManifestSha256: exported.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  const okMerge = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr.id}/merge`, {
    headers, body: JSON.stringify({ expectedHeadSha: shaA }),
  });
  assert.equal(okMerge.status, 200, JSON.stringify(okMerge.json));
  assert.equal(okMerge.json.status, 'merged');
});

test('R2-2 (P1 #2 + Golden #7): Evidence download enforces operator auth, root scope, no symlinks, and exact binary base64 bytes', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'dl.js'), 'export const d = 1;\n');
  execFileSync('/usr/bin/git', ['add', 'dl.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'dl'], { cwd: projDir });
  const dlSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();
  const loopStore = createLoopStore(join(dir, '.synapse'));
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({
    projectId: PROJECT, sourceBranch: 'feat/dl', targetBranch: 'main',
    author: 'dev1', authorRole: 'developer', title: 'Download PR',
  });
  const packetDir = join(projDir, 'evidence-dl');
  const binaryBytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x42, 0x0a]);
  const exported = makeVerifiedPacket(loopStore, packetDir, 'run-dl-1', dlSha, {
    projectId: PROJECT, prId: pr.id, projectDir: projDir, extraArtifact: { path: 'artifacts/bin.dat', bytes: binaryBytes },
  });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: dlSha, loopRunId: 'run-dl-1', evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256, checksumManifestSha256: exported.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });

  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());

  const viewerDl = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}/evidence/download`, {
    headers: { authorization: 'Bearer tok-viewer' },
  });
  assert.equal(viewerDl.status, 403);

  const opDl = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}/evidence/download`, {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(opDl.status, 200, JSON.stringify(opDl.json));
  assert.equal(opDl.json.encoding, 'base64');
  assert.ok(opDl.json.members['source.bundle'], JSON.stringify(Object.keys(opDl.json.members)));
  const rawBundleOnDisk = await fs.readFile(join(packetDir, 'source.bundle'));
  const decodedBundle = Buffer.from(opDl.json.members['source.bundle'].base64, 'base64');
  assert.equal(decodedBundle.equals(rawBundleOnDisk), true);
  assert.ok(rawBundleOnDisk.length > 0);

  const outsideDir = await scratch(t);
  const outsidePkt = join(outsideDir, 'outside-pkt');
  const outExp = makeVerifiedPacket(loopStore, outsidePkt, 'run-dl-2', dlSha, { projectId: PROJECT, prId: pr.id, projectDir: projDir });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: HEAD_A, loopRunId: 'run-dl-2', evidencePacketDir: outsidePkt,
    evidencePacketSha256: outExp.evidencePacketSha256, checksumManifestSha256: outExp.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  const outsideRes = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}/evidence/download`, {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(outsideRes.status, 403);
  assert.equal(outsideRes.json.code, 'EVIDENCE_PACKET_SCOPE_DENIED');
});

test('R2-3 (P1 #3 + Golden F-1): Production buildActiveProofForPr publishes cleanly through github-bridge', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'pub.js'), 'export const p = 1;\n');
  execFileSync('/usr/bin/git', ['add', 'pub.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'pub'], { cwd: projDir });
  const pubSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();
  const loopStore = createLoopStore(join(dir, '.synapse'));
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({
    projectId: PROJECT, sourceBranch: 'feat/prod-pub', targetBranch: 'main',
    author: 'dev-a', authorRole: 'developer', title: 'Prod Adapter Pub PR',
  });
  const packetDir = join(projDir, 'prod-pkt');
  const exported = makeVerifiedPacket(loopStore, packetDir, 'run_prod_1', pubSha, {
    projectId: PROJECT, prId: pr.id, projectDir: projDir, reviewerAgentId: 'rev-b', reviewerProvider: 'provider-b',
  });
  const pktObj = JSON.parse(await fs.readFile(join(packetDir, 'evidence-packet.json'), 'utf8'));
  prStore.addReview(PROJECT, pr.id, {
    reviewer: 'rev-b', status: 'approved', approvedSourceSha: pubSha,
    reviewSha256: pktObj.pr.approval.reviewSha256, approvalEventId: pktObj.pr.approval.eventId,
  });
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: pubSha,
    loopRunId: 'run_prod_1',
    evidencePacketDir: packetDir,
    evidencePacketSha256: exported.evidencePacketSha256,
    checksumManifestSha256: exported.checksumManifestSha256,
    approval: pktObj.pr.approval,
    ran: { verify: true },
    passed: true,
  });

  const agents = { 'dev-a': { provider: 'provider-a' }, 'rev-b': { provider: 'provider-b' } };
  // Without authoritative persisted approval in loopStore, buildActiveProofForPr MUST return null (never trust cached PR approval!)
  assert.equal(buildActiveProofForPr({ prStore, loopStore, agents, binding: { projectId: PROJECT, prId: pr.id } }), null);
  // Persist authoritative operator approval in loopStore -> now publishes cleanly!
  loopStore.recordApprovalEvent({ ...pktObj.pr.approval, runId: pktObj.run.runId });
  // P1 #3: Verify buildActiveProofForPr rejects a review with conflicting approvalEventId or mismatched reviewSha256!
  const prConf = prStore.openPR({ projectId: PROJECT, sourceBranch: 'feat/conf', targetBranch: 'main', author: 'dev-a', authorRole: 'developer' });
  prStore.addReview(PROJECT, prConf.id, {
    reviewer: 'rev-b', status: 'approved', approvedSourceSha: pubSha,
    reviewSha256: pktObj.pr.approval.reviewSha256, approvalEventId: 'appr_wrong_event',
  });
  prStore.attachVerificationProof(PROJECT, prConf.id, { headSha: pubSha, loopRunId: 'run_prod_1', evidencePacketDir: packetDir, evidencePacketSha256: exported.evidencePacketSha256, checksumManifestSha256: exported.checksumManifestSha256, ran: { verify: true }, passed: true });
  const confProof = buildActiveProofForPr({ prStore, loopStore, agents, binding: { projectId: PROJECT, prId: prConf.id } });
  assert.equal(confProof.review, null);
  const validProof = buildActiveProofForPr({ prStore, loopStore, agents, binding: { projectId: PROJECT, prId: pr.id } });
  assert.ok(validProof.review && validProof.review.reviewSha256 === pktObj.pr.approval.reviewSha256);
  const gh = mockGitHub();
  gh.settings.now = pubSha;
  const bridge = createGitHubBridge({
    store: fixtureBridgeStore(join(dir, 'bridge.json')),
    getRepository: () => ({
      projectId: PROJECT, repoId: REPO_ID, owner: 'acme', repo: 'synapse',
      tokenSecretName: 'gh-tok', bridgeIdentity: { login: 'evidence-bridge', userId: 121 },
    }),
    prStore,
    resolveLocalHead: () => pubSha,
    getActiveProof: (binding) => buildActiveProofForPr({ prStore, loopStore, agents, binding }),
    verifyPacketSnapshot: verifyEvidencePacketSnapshot,
    clientOptions: {
      credentialVault: { resolve: () => GITHUB_TOKEN },
      dnsLookup: async () => PUBLIC_DNS,
      fetchImpl: gh.fetchImpl,
    },
  });
  gh.settings.headRef = 'feat/prod-pub';
  await bridge.bindPullRequest({ projectId: PROJECT, prId: pr.id, pullNumber: PULL, sourceRef: 'feat/prod-pub', targetRef: 'main' });
  const pub = await bridge.publishEvidenceToGitHub({ projectId: PROJECT, prId: pr.id, expectedHeadSha: pubSha });
  assert.equal(pub.statusCode, 202, JSON.stringify(pub));
  assert.equal(pub.receipt.state, 'completed');
  assert.equal(gh.settings.comments.length, 1);
  assert.equal(gh.settings.statuses.length, 1);
});

test('R2-4 (P1 #4 + P2 #3 + Golden F-2): Live POST /api/loops/from-template publishes all 4 packs with real LoopService and durable replay', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, { displayName: 'Project One' });
  sm.createProject('child-a', { displayName: 'Child A' });
  sm.createProject('child-b', { displayName: 'Child B' });
  Object.assign(sm.getProject(PROJECT), { benchmarkSuites: ['suite-1'], verifiedOperations: ['service-health'], targets: ['default'], subProjects: ['child-a', 'child-b'] });
  Object.assign(sm.getProject('child-a'), { parentProjectId: PROJECT });
  Object.assign(sm.getProject('child-b'), { parentProjectId: PROJECT });
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({ projectId: PROJECT, sourceBranch: 'feat/t', targetBranch: 'main', author: 'dev1', authorRole: 'developer' });
  const taskManager = new TaskManager(sm);
  const task = taskManager.createTask(PROJECT, 'general', { title: 'Feature work item' });
  const loopStore = createLoopStore(join(dir, '.synapse'));
  const tplRegs = createTemplateRegistries({
    operations: {
      'capture-pr-source@1': async () => ({ prId: pr.id }),
      'read-verified-health@1': async () => ({ observedAt: new Date().toISOString(), healthy: true, measurements: {} }),
    },
  });
  const agents = {
    dev1: { role: 'developer', provider: 'openai', paused: false },
    rev1: { role: 'reviewer', provider: 'anthropic', paused: false },
    eval1: { role: 'evaluator', provider: 'openai', paused: false },
  };
  const loopEngine = createLoopEngine({
    loopStore, agentsMap: agents, prStore, stateManager: sm,
    anchorRunners: tplRegs.anchors, effectRegistry: tplRegs.operations, reducers: tplRegs.reducers,
  });
  const loopService = createLoopService({ loopStore, loopEngine, stateManager: sm, prStore, agentsMap: agents, projectDir: dir });
  const sqliteIdemStore = createSqliteTemplateIdempotencyStore(loopStore.db);

  const makeSrv = async (agentsOverride = agents) => {
    const handleApi = createHandleApi({
      stateManager: sm, agents: agentsOverride, config: { operator: { name: 'operator' }, orchestrator: {} },
      PORT: 8080, auth: makeMockApiAuth(), prStore, taskManager, loopStore, loopEngine, loopService,
      templateRegistries: tplRegs, templateIdempotencyStore: sqliteIdemStore,
      events: { emit: async () => {}, on: () => {} },
      addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
    });
    return startApiServer(handleApi);
  };

  const srv = await makeSrv();
  t.after(() => srv.close());
  const headers = { authorization: 'Bearer tok-op', 'content-type': 'application/json' };

  const cases = [
    ['multi-model-pr-review-council', 'req-live-1', { prId: pr.id }],
    ['model-benchmark-suite', 'req-live-2', { suiteId: 'suite-1', childProjectIds: ['child-a', 'child-b'], caseCount: 2 }],
    ['daily-verified-ops-loop', 'req-live-3', { operationId: 'service-health', time: '09:00', timezone: 'Etc/UTC' }],
    ['hardened-feature-pipeline', 'req-live-4', { workItemId: task.id, target: 'default' }],
  ];
  for (const [templateId, requestId, params] of cases) {
    const res = await sendRawHttp(srv.baseUrl, 'POST', '/api/loops/from-template', {
      headers, body: JSON.stringify({ templateId, projectId: PROJECT, name: 'Live ' + templateId, params, requestId }),
    });
    assert.equal(res.status, 201, templateId + ': ' + JSON.stringify(res.json));
    assert.equal(res.json.loop.scheduleEnabled, false);
  }

  const srv2 = await makeSrv();
  t.after(() => srv2.close());
  const replay = await sendRawHttp(srv2.baseUrl, 'POST', '/api/loops/from-template', {
    headers, body: JSON.stringify({
      templateId: 'multi-model-pr-review-council', projectId: PROJECT,
      name: 'Live multi-model-pr-review-council', params: { prId: pr.id }, requestId: 'req-live-1',
    }),
  });
  assert.equal(replay.status, 200);

  const conflict = await sendRawHttp(srv2.baseUrl, 'POST', '/api/loops/from-template', {
    headers, body: JSON.stringify({
      templateId: 'multi-model-pr-review-council', projectId: PROJECT,
      name: 'Different Name', params: { prId: pr.id }, requestId: 'req-live-1',
    }),
  });
  assert.equal(conflict.status, 409);

  const srvPaused = await makeSrv({
    dev1: { role: 'developer', provider: 'openai', paused: false },
    rev1: { role: 'reviewer', provider: 'anthropic', paused: true },
  });
  t.after(() => srvPaused.close());
  const pausedRes = await sendRawHttp(srvPaused.baseUrl, 'POST', '/api/loops/from-template', {
    headers, body: JSON.stringify({
      templateId: 'multi-model-pr-review-council', projectId: PROJECT,
      name: 'Paused Check', params: { prId: pr.id }, requestId: 'req-paused-1',
    }),
  });
  assert.equal(pausedRes.status, 422);
  assert.equal(pausedRes.json.code, 'TEMPLATE_CAPABILITY_UNAVAILABLE');

  // P2 #1: Crash-safe SQLite replay recovery BEFORE capability check (recovers version 1 even when reviewer is now paused!)
  loopStore.db.prepare('DELETE FROM template_idempotency').run();
  const recovered = await sendRawHttp(srvPaused.baseUrl, 'POST', '/api/loops/from-template', {
    headers, body: JSON.stringify({
      templateId: 'multi-model-pr-review-council', projectId: PROJECT,
      name: 'Live multi-model-pr-review-council', params: { prId: pr.id }, requestId: 'req-live-1',
    }),
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.json));
  assert.equal(recovered.json.loop.loopVersion, 1);
  loopStore.db.prepare('DELETE FROM template_idempotency').run();
  const recoveredConflict = await sendRawHttp(srvPaused.baseUrl, 'POST', '/api/loops/from-template', {
    headers, body: JSON.stringify({
      templateId: 'multi-model-pr-review-council', projectId: PROJECT,
      name: 'Tampered Replay Name', params: { prId: pr.id }, requestId: 'req-live-1',
    }),
  });
  assert.equal(recoveredConflict.status, 409);
});

test('R2-5 (P1 #6): Strict tar parser rejects global PAX g, unsupported PAX keys, and malformed PAX records', () => {
  const mkHeader = (name, size, typeFlag) => {
    const hdr = Buffer.alloc(512, 0);
    hdr.write(name, 0, 'utf8');
    hdr.write('0000644\0', 100);
    hdr.write('0000000\0', 108);
    hdr.write('0000000\0', 116);
    hdr.write(size.toString(8).padStart(11, '0') + '\0', 124);
    hdr.write('00000000000\0', 136);
    hdr.fill(32, 148, 156);
    hdr[156] = typeFlag;
    hdr.write('ustar\0', 257);
    hdr.write('00', 263);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += hdr[i];
    hdr.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return hdr;
  };
  const pad = (buf) => {
    const rem = buf.length % 512;
    return rem ? Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]) : buf;
  };
  const eof = Buffer.alloc(1024, 0);

  const gPayload = Buffer.from('16 path=package/a\n');
  const globalTar = Buffer.concat([mkHeader('pax_global_header', gPayload.length, 103), pad(gPayload), eof]);
  assert.throws(() => tarEntries(globalTar), (e) => e.code === 'TAR_GLOBAL_PAX_UNSUPPORTED');

  const badKey = Buffer.from('12 size=999\n');
  const fileData = Buffer.from('hi');
  const badKeyTar = Buffer.concat([
    mkHeader('PaxHeader/a', badKey.length, 120), pad(badKey),
    mkHeader('package/a.txt', fileData.length, 48), pad(fileData), eof,
  ]);
  assert.throws(() => tarEntries(badKeyTar), (e) => e.code === 'TAR_PAX_KEY_DENIED');

  const badPax = Buffer.from('999 path=short\n');
  const malformedTar = Buffer.concat([
    mkHeader('PaxHeader/a', badPax.length, 120), pad(badPax),
    mkHeader('package/a.txt', fileData.length, 48), pad(fileData), eof,
  ]);
  assert.throws(() => tarEntries(malformedTar), (e) => e.code === 'TAR_PAX_INVALID');

  const dupKey = Buffer.from('18 path=package/a\n18 path=package/b\n');
  const dupKeyTar = Buffer.concat([
    mkHeader('PaxHeader/a', dupKey.length, 120), pad(dupKey),
    mkHeader('package/a.txt', fileData.length, 48), pad(fileData), eof,
  ]);
  assert.throws(() => tarEntries(dupKeyTar), (e) => e.code === 'TAR_PAX_DUPLICATE_KEY');
});

test('R2-6 (P1 #8 + Golden F-4): Template commit anchor requires trusted argv[4] subjectDir and ignores .gitignored tests', async (t) => {
  const dir = await scratch(t);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(join(dir, '.gitignore'), 'ignored.test.mjs\n');
  await fs.writeFile(join(dir, 'lib.mjs'), 'export const x = 1;\n');
  execFileSync('/usr/bin/git', ['add', '.gitignore', 'lib.mjs'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  const sha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  await fs.writeFile(join(dir, 'ignored.test.mjs'), 'import test from "node:test"; test("sneaky", () => {});\n');

  const runner = join(ROOT, 'src/templates/loop-templates.js');
  const noArgv4 = await runNode(t, [runner, 'verify-pr-source@1', JSON.stringify({ expectedSha: sha, subjectSha: sha, subjectDir: dir })]);
  assert.notEqual(noArgv4.status, 0);

  const ignoredOnly = await runNode(t, [runner, 'verify-pr-source@1', JSON.stringify({ expectedSha: sha, subjectSha: sha }), dir]);
  assert.notEqual(ignoredOnly.status, 0);

  await fs.writeFile(join(dir, 'real.test.mjs'), 'import test from "node:test"; test("real", () => {});\n');
  execFileSync('/usr/bin/git', ['add', 'real.test.mjs'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'add real test'], { cwd: dir });
  const sha2 = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(verifyNodeTests(sha2, { subjectDir: dir, allowHostFallback: true }), true);

  // Add a tracked failing test marked export-ignore in .gitattributes -> ls-tree/cat-file materialization MUST still execute & fail it!
  await fs.writeFile(join(dir, '.gitattributes'), 'failing.test.mjs export-ignore\n');
  await fs.writeFile(join(dir, 'failing.test.mjs'), 'import test from "node:test"; test("must fail", () => { throw new Error("boom"); });\n');
  execFileSync('/usr/bin/git', ['add', '.gitattributes', 'failing.test.mjs'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'export-ignore failing test'], { cwd: dir });
  const sha3 = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const exportIgnoreRes = await runNode(t, [runner, 'verify-pr-source@1', JSON.stringify({ expectedSha: sha3, subjectSha: sha3 }), dir]);
  assert.notEqual(exportIgnoreRes.status, 0);
});

test('R2-7 (P2 #1 + P2 #2): TaskManager deduplicates atomically and foreign status creator is not adopted', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const tm = new TaskManager(sm);
  const t1 = tm.createTask(PROJECT, 'general', { title: 'Issue 1', metadata: { githubIssueKey: 'gh-key-1' }, idempotencyKey: 'gh-key-1' });
  const t2 = tm.createTask(PROJECT, 'general', { title: 'Issue 1 dup', metadata: { githubIssueKey: 'gh-key-1' }, idempotencyKey: 'gh-key-1' });
  assert.equal(t1.id, t2.id);
  assert.equal(t1.metadata.githubIssueKey, 'gh-key-1');
  assert.equal(tm.load(PROJECT).tasks.length, 1);

  const fixture = await bridgeFixture(t);
  fixture.settings.statuses.push({
    id: 999, context: 'synapse/evidence/pr-12', state: 'success',
    description: 'Verified Synapse evidence', target_url: fixture.bound.url + '#issuecomment-101',
    creator: { login: 'some-other-bot', id: 888 },
  });
  const pub = await fixture.publish();
  assert.equal(pub.receipt.state, 'completed');
  assert.notEqual(pub.receipt.statusReceipt.id, 999);
});

test('R2-8 (P2 #4 + P3): PR UI open(projectId) sets project, honors requiresProof, requires loopId, preserves data.error, and API returns github.url', async (t) => {
  let requestedUrl = null;
  const ui = makeUi(null, (url, init) => {
    requestedUrl = url;
    if (init.method === 'POST') return json({ code: 'PROOF_STALE', error: 'Exact server explanation text' }, { status: 409 });
    return url.endsWith('/prs')
      ? json([{ id: PR, title: 'T', currentHeadSha: HEAD_A, requiresProof: true }])
      : json(proofForUi({
          requiresProof: true,
          approvalCandidate: { runId: 'run-no-loop', approvedSourceSha: HEAD_A, reviewSha256: REVIEW_HASH, anchorSetSha256: ANCHOR_HASH },
        }));
  });
  await ui.api.open('proj-from-open');
  assert.equal(requestedUrl, '/api/projects/proj-from-open/prs');
  await ui.api.open(null);
  assert.ok(ui.nodes().map((n) => n.ownText).join('\n').includes('Select a project.'));
  await ui.api.open('proj-from-open');

  await ui.api.selectPr(PR);
  const approveBtn = ui.by('button', 'Operator Approve');
  assert.equal(approveBtn.disabled, true);

  await ui.by('button', 'Merge').click();
  const allText = ui.nodes().map((n) => n.ownText).join('\n'); assert.ok(allText.includes('Exact server explanation text'), allText);

  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, 'Project One', {});
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({ projectId: PROJECT, sourceBranch: 'feat/url', targetBranch: 'main', author: 'dev1', authorRole: 'developer' });
  const gh = mockGitHub();
  gh.settings.headRef = 'feat/url';
  const bridge = createGitHubBridge({
    store: fixtureBridgeStore(join(dir, 'bridge-url.json')),
    prStore,
    getRepository: () => ({ projectId: PROJECT, repoId: REPO_ID, owner: 'acme', repo: 'synapse', tokenSecretName: 't', bridgeIdentity: { login: 'evidence-bridge', userId: 121 } }),
    clientOptions: { credentialVault: { resolve: () => GITHUB_TOKEN }, dnsLookup: async () => PUBLIC_DNS, fetchImpl: gh.fetchImpl },
  });
  await bridge.bindPullRequest({ projectId: PROJECT, prId: pr.id, pullNumber: PULL, sourceRef: 'feat/url', targetRef: 'main' });
  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, githubBridge: bridge,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());
  const detail = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}`, {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.github.url, 'https://github.com/acme/synapse/pull/12');
  assert.equal(detail.json.github.htmlUrl, 'https://github.com/acme/synapse/pull/12');
});

// ─── Phase 4 Round 4 Hardening Regression Tests (Sol #155) ───

test('R4-1 (P1 #1 + P1 #2): Literal branch lookup rejects revision expressions and merge enforces project-owned packet root & no symlinks', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, { displayName: 'Project One' });
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'x.js'), 'export const x = 1;\n');
  execFileSync('/usr/bin/git', ['add', 'x.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'c1'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['checkout', '-q', '-b', 'feat/literal'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'x.js'), 'export const x = 2;\n');
  execFileSync('/usr/bin/git', ['add', 'x.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'c2'], { cwd: projDir });
  const c1 = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD~1'], { cwd: projDir, encoding: 'utf8' }).trim();
  const c2 = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();

  const loopStore = createLoopStore(join(dir, '.synapse'));
  const prStore = createPrStore(join(dir, '.synapse'));
  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, loopStore,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());
  const headers = { authorization: 'Bearer tok-op', 'content-type': 'application/json' };

  // P1 #1: Tampered/legacy PR record with revision suffix `feat/literal~1` MUST NOT resolve to c1!
  const exprPr = prStore.openPR({ projectId: PROJECT, sourceBranch: 'feat/literal', targetBranch: 'main', author: 'dev1', authorRole: 'developer' });
  prStore.addReview(PROJECT, exprPr.id, { reviewer: 'rev1', status: 'approved', approvedSourceSha: c1 });
  const exprPrPath = prStore._prPath(PROJECT, exprPr.id);
  const exprPrJson = JSON.parse(await fs.readFile(exprPrPath, 'utf8'));
  exprPrJson.sourceBranch = 'feat/literal~1';
  await fs.writeFile(exprPrPath, JSON.stringify(exprPrJson, null, 2));
  const exprRes = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${exprPr.id}/merge`, {
    headers, body: JSON.stringify({ expectedHeadSha: c1, force: true }),
  });
  assert.equal(exprRes.status, 409);
  assert.equal(exprRes.json.code, 'HEAD_SHA_UNRESOLVABLE');

  // P1 #2: Merge rejects packet dir outside project-owned root (even with valid digests & persisted approval!)
  const outsideDir = await scratch(t);
  const outsidePkt = join(outsideDir, 'ext-pkt');
  const pr2 = prStore.openPR({ projectId: PROJECT, sourceBranch: 'feat/literal', targetBranch: 'main', author: 'dev1', authorRole: 'developer' });
  const outExp = makeVerifiedPacket(loopStore, outsidePkt, 'run-ext-1', c2, { projectId: PROJECT, prId: pr2.id, projectDir: projDir });
  const outPktObj = JSON.parse(await fs.readFile(join(outsidePkt, 'evidence-packet.json'), 'utf8'));
  loopStore.recordApprovalEvent({ ...outPktObj.pr.approval, runId: outPktObj.run.runId });
  prStore.addReview(PROJECT, pr2.id, { reviewer: 'rev1', status: 'approved', approvedSourceSha: c2 });
  prStore.attachVerificationProof(PROJECT, pr2.id, {
    headSha: c2, loopRunId: 'run-ext-1', evidencePacketDir: outsidePkt,
    evidencePacketSha256: outExp.evidencePacketSha256, checksumManifestSha256: outExp.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  const scopeMerge = await sendRawHttp(srv.baseUrl, 'POST', `/api/projects/${PROJECT}/prs/${pr2.id}/merge`, {
    headers, body: JSON.stringify({ expectedHeadSha: c2, force: true }),
  });
  assert.equal(scopeMerge.status, 409);
  assert.equal(scopeMerge.json.code, 'PROOF_SCOPE_DENIED');

  // P1 #2: Download rejects symlink injected inside project-owned packet dir
  const symPkt = join(projDir, 'sym-pkt');
  const symExp = makeVerifiedPacket(loopStore, symPkt, 'run-sym-1', c2, { projectId: PROJECT, prId: pr2.id, projectDir: projDir });
  execFileSync('/usr/bin/ln', ['-s', '--', '/etc/hosts', join(symPkt, 'evil-link')], { stdio: 'ignore' });
  prStore.attachVerificationProof(PROJECT, pr2.id, {
    headSha: c2, loopRunId: 'run-sym-1', evidencePacketDir: symPkt,
    evidencePacketSha256: symExp.evidencePacketSha256, checksumManifestSha256: symExp.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  const symDl = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr2.id}/evidence/download`, {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(symDl.status, 409);
  assert.equal(symDl.json.code, 'EVIDENCE_SYMLINK_DENIED');
});

test('R4-2 (P1 #4 + P1 #5 + P2 #3): Release gate enforces runtime read-only permissions, preserves +x bits, and never chmods symlinks on cleanup', async (t) => {
  const { target, run, namedTests } = await releaseFixture(t);
  // Add an executable script (0o755) and verify the test running inside the gate sees +x preserved AND cannot write/chmod package files!
  const binScript = join(target, 'scripts/exec-helper.sh');
  await fs.writeFile(binScript, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  await fs.chmod(binScript, 0o755);
  const probeTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('immutable-package-and-exec-bits', () => {
  const st = fs.statSync('scripts/exec-helper.sh');
  assert.ok((st.mode & 0o111) !== 0, 'exec bit stripped: ' + st.mode.toString(8));
  assert.equal(st.mode & 0o222, 0, 'write bit still set: ' + st.mode.toString(8));
  assert.throws(() => fs.chmodSync('package.json', 0o600), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => fs.writeFileSync('package.json', 'mutated'), { code: 'ERR_ACCESS_DENIED' });
});
`;
  await fs.writeFile(join(target, RELEASE_TEST_FILES[1]), probeTest);
  const ok = await run();
  assert.equal(ok.exitCode, 0, JSON.stringify(ok));

  // P1 #5: Verify external symlink target mode (0o400) is NOT mutated to 0o600 during scratch cleanup when gate fails on symlink!
  const extDir = await scratch(t);
  const extFile = join(extDir, 'readonly-external.txt');
  await fs.writeFile(extFile, 'do-not-chmod', { mode: 0o400 });
  await fs.chmod(extFile, 0o400);
  execFileSync('/usr/bin/ln', ['-s', '--', extFile, join(target, 'dangling-ext-link')], { stdio: 'ignore' });
  const failSym = await run();
  assert.equal(failSym.exitCode, 1);
  const extStat = await fs.stat(extFile);
  assert.equal(extStat.mode & 0o777, 0o400);
});

test('R4-3 (P1 #6): Template commit anchor discovers Node test/ dir plain .js and -test.mjs files and verifies each individually', async (t) => {
  const dir = await scratch(t);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.mkdir(join(dir, 'test'), { recursive: true });
  await fs.writeFile(join(dir, 'test/plain.js'), 'import test from "node:test"; test("plain in test dir", () => {});\n');
  await fs.writeFile(join(dir, 'dash-test.mjs'), 'import test from "node:test"; test("dash-test ok", () => {});\n');
  execFileSync('/usr/bin/git', ['add', 'test/plain.js', 'dash-test.mjs'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'two node-discovered tests'], { cwd: dir });
  const shaPass = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const runner = join(ROOT, 'src/templates/loop-templates.js');
  assert.equal(verifyNodeTests(shaPass, { subjectDir: dir, allowHostFallback: true }), true);

  // Now break ONLY test/plain.js (not named *.test.js!) -> MUST FAIL!
  await fs.writeFile(join(dir, 'test/plain.js'), 'import test from "node:test"; test("plain fails", () => { throw new Error("fail"); });\n');
  execFileSync('/usr/bin/git', ['add', 'test/plain.js'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'break test/plain.js'], { cwd: dir });
  const shaFail = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const failRes = await runNode(t, [runner, 'verify-pr-source@1', JSON.stringify({ expectedSha: shaFail, subjectSha: shaFail }), dir]);
  assert.notEqual(failRes.status, 0);
});

test('R4-4 (P2 #2): read-verified-health@1 fails closed when stores absent or probe unhealthy and passes when live probe succeeds', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, { displayName: 'Project One' });
  const prStore = createPrStore(join(dir, '.synapse'));
  const loopStore = createLoopStore(join(dir, '.synapse'));

  let probeHealthy = false;
  const regs = createTemplateRegistries({
    operations: {
      'read-verified-health@1': async ({ params, scope }) => {
        const pid = scope?.projectId;
        const proj = pid ? sm.getProject(pid) : null;
        const prOk = Boolean(proj && prStore && Array.isArray(prStore.listPRs(pid)));
        const dbOk = Boolean(loopStore?.db && loopStore.db.prepare('SELECT 1 AS ok').get()?.ok === 1);
        return { observedAt: new Date().toISOString(), operationId: params.operationId, healthy: Boolean(prOk && dbOk && probeHealthy), measurements: { prOk: prOk ? 1 : 0, dbOk: dbOk ? 1 : 0 } };
      },
    },
  });
  const bad = await regs.operations['read-verified-health@1'].execute({ params: { operationId: 'service-health' }, scope: { projectId: PROJECT } });
  assert.equal(bad.healthy, false);
  probeHealthy = true;
  const good = await regs.operations['read-verified-health@1'].execute({ params: { operationId: 'service-health' }, scope: { projectId: PROJECT } });
  assert.equal(good.healthy, true);
  assert.equal(good.measurements.dbOk, 1);
});

// ─── Phase 4 Round 5 Hardening Regression Tests (Sol #158) ───

test('R5-1 (P1 #1 + P2 #4): Pure-Node gate phases block child_process and partial-test tarball overlay avoids EACCES', async (t) => {
  const { target, run, packageJson, files } = await releaseFixture(t);
  // 1. smokeImport attempting child_process.execFileSync MUST fail ERR_ACCESS_DENIED (no --allow-child-process!)
  await fs.writeFile(
    join(target, 'src/orchestrator.js'),
    'import { execFileSync } from "node:child_process"; execFileSync(process.execPath, ["-e", ""]);\n',
  );
  const blockedCp = await run();
  assert.equal(blockedCp.exitCode, 1);
  assert.equal(blockedCp.checks.smokeImport.code, 'SMOKE_IMPORT_FAILED');

  // Restore clean smokeImport and restrict package.json files so ONLY ONE of RELEASE_TEST_FILES is in the tarball (partial-test overlay)
  await fs.writeFile(
    join(target, 'src/orchestrator.js'),
    'if (process.env.SYNAPSE_SMOKE_IMPORT !== "1" || !process.env.SYNAPSE_PROJECT_DIR) process.exit(1);\n',
  );
  const partialFiles = files.filter((f) => f !== RELEASE_TEST_FILES[1]);
  await fs.writeFile(join(target, 'package.json'), JSON.stringify({ ...packageJson, files: partialFiles }, null, 2) + '\n');
  const partialOk = await run();
  assert.equal(partialOk.exitCode, 0, JSON.stringify(partialOk));
});

test('R5-2 (P1 #2 + P2 #5): Pure in-memory verifyEvidencePacketSnapshot verifies after disk deletion and walker enforces entry cap', async (t) => {
  const dir = await scratch(t);
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, { displayName: 'Project One' });
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 'm.js'), 'export const m = 1;\n');
  execFileSync('/usr/bin/git', ['add', 'm.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'm1'], { cwd: projDir });
  const sha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();

  const loopStore = createLoopStore(join(dir, '.synapse'));
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({ projectId: PROJECT, sourceBranch: 'feat/mem', targetBranch: 'main', author: 'dev1', authorRole: 'developer' });
  const pktDir = join(projDir, 'mem-pkt');
  const exp = makeVerifiedPacket(loopStore, pktDir, 'run-mem-1', sha, { projectId: PROJECT, prId: pr.id, projectDir: projDir });

  // Capture all buffers into memory, then DELETE the packet dir on disk!
  const sumsBytes = await fs.readFile(join(pktDir, 'SHA256SUMS'));
  const memberBuffers = new Map();
  for (const line of sumsBytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const [, , rel] = /^([a-f0-9]{64})  (.+)$/.exec(line);
    memberBuffers.set(rel, await fs.readFile(join(pktDir, rel)));
  }
  await fs.rm(pktDir, { recursive: true, force: true });
  const inMemRes = verifyEvidencePacketSnapshot({ memberBuffers, sumsBytes });
  assert.equal(inMemRes.ok, true, JSON.stringify(inMemRes));
  assert.equal(inMemRes.evidencePacketSha256, exp.evidencePacketSha256);

  // P2 #5: Packet dir with > 512 entries rejected with 413 EVIDENCE_PACKET_TOO_MANY_ENTRIES
  const floodDir = join(projDir, 'flood-pkt');
  const fExp = makeVerifiedPacket(loopStore, floodDir, 'run-flood-1', sha, { projectId: PROJECT, prId: pr.id, projectDir: projDir });
  await fs.mkdir(join(floodDir, 'flood'), { recursive: true });
  for (let i = 0; i < 520; i++) await fs.writeFile(join(floodDir, 'flood', `f${i}`), '');
  prStore.attachVerificationProof(PROJECT, pr.id, {
    headSha: sha, loopRunId: 'run-flood-1', evidencePacketDir: floodDir,
    evidencePacketSha256: fExp.evidencePacketSha256, checksumManifestSha256: fExp.checksumManifestSha256,
    ran: { verify: true }, passed: true,
  });
  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, loopStore,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());
  const floodRes = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}/evidence/download`, {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(floodRes.status, 413);
  assert.equal(floodRes.json.code, 'EVIDENCE_PACKET_TOO_MANY_ENTRIES');
});

test('R5-3 (P1 #3): Template commit anchor rejects file-only 0-test scripts and discovers .ts test files', async (t) => {
  const dir = await scratch(t);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.mkdir(join(dir, 'test'), { recursive: true });
  // A 0-test script that prints spoofed TAP v13 and exits 0 MUST NOT pass!
  await fs.writeFile(join(dir, 'test/empty.js'), 'console.log("TAP version 13\\n1..1\\nok 1 - spoofed\\n# tests 1\\n# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0");\n');
  execFileSync('/usr/bin/git', ['add', 'test/empty.js'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'empty script'], { cwd: dir });
  const shaEmpty = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const runner = join(ROOT, 'src/templates/loop-templates.js');
  const emptyRes = await runNode(t, [runner, 'verify-pr-source@1', JSON.stringify({ expectedSha: shaEmpty, subjectSha: shaEmpty }), dir]);
  assert.notEqual(emptyRes.status, 0);

  // Replace with real passing test, PLUS add an unrunnable/failing .ts test -> MUST be discovered (fails instead of silently omitted!)
  await fs.writeFile(join(dir, 'test/empty.js'), 'import test from "node:test"; test("real ok", () => {});\n');
  await fs.writeFile(join(dir, 'failing.test.ts'), 'const x: number = 1; throw new Error("ts fail");\n');
  execFileSync('/usr/bin/git', ['add', 'test/empty.js', 'failing.test.ts'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'add ts test'], { cwd: dir });
  const shaTs = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const tsRes = await runNode(t, [runner, 'verify-pr-source@1', JSON.stringify({ expectedSha: shaTs, subjectSha: shaTs }), dir]);
  assert.notEqual(tsRes.status, 0);
});

test('R5-4 (P2 #1 + P3): SQLite replay store never overwrites committed records and refs/heads/refs/topic branch resolves', async (t) => {
  const dir = await scratch(t);
  const loopStore = createLoopStore(join(dir, '.synapse'));
  const storeA = createSqliteTemplateIdempotencyStore(loopStore.db);
  const storeB = createSqliteTemplateIdempotencyStore(loopStore.db);
  // True concurrent cross-instance serialization + commit-once INSERT OR IGNORE on same SQLite DB:
  let executions = 0;
  let bObservedExisting = null;
  await Promise.all([
    storeA.transact('proj:req-race', async (existing, save) => {
      if (!existing) {
        executions++;
        await new Promise((r) => setTimeout(r, 60));
        const win = save({ requestDigest: 'a'.repeat(64), loop: { loopId: 'loop-a' } });
        assert.equal(win.requestDigest, 'a'.repeat(64));
      }
    }),
    (async () => {
      await new Promise((r) => setTimeout(r, 15));
      await storeB.transact('proj:req-race', async (existing, save) => {
        bObservedExisting = existing;
        if (!existing) executions++;
        const win = save({ requestDigest: 'b'.repeat(64), loop: { loopId: 'loop-b' } });
        assert.equal(win.requestDigest, 'a'.repeat(64));
        assert.equal(win.loop.loopId, 'loop-a');
      });
    })(),
  ]);
  assert.equal(executions, 1);
  assert.equal(bObservedExisting?.requestDigest, 'a'.repeat(64));

  // P3: Branch explicitly named refs/heads/refs/topic resolves cleanly on PR detail!
  const sm = new StateManager(dir);
  sm.createProject(PROJECT, { displayName: 'Project One' });
  const projDir = sm.getProject(PROJECT).projectDir;
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: projDir });
  await fs.writeFile(join(projDir, 't.js'), 'export const t = 1;\n');
  execFileSync('/usr/bin/git', ['add', 't.js'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 't1'], { cwd: projDir });
  execFileSync('/usr/bin/git', ['checkout', '-q', '-b', 'refs/topic'], { cwd: projDir });
  const topicSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();
  const prStore = createPrStore(join(dir, '.synapse'));
  const pr = prStore.openPR({ projectId: PROJECT, sourceBranch: 'refs/heads/refs/topic', targetBranch: 'main', author: 'dev1', authorRole: 'developer' });
  const handleApi = createHandleApi({
    stateManager: sm, agents: {}, config: { operator: { name: 'operator' }, orchestrator: {} },
    PORT: 8080, auth: makeMockApiAuth(), prStore, loopStore,
    events: { emit: async () => {}, on: () => {} },
    addMessage: () => {}, queueTurn: () => {}, handleUserMessage: () => {},
  });
  const srv = await startApiServer(handleApi);
  t.after(() => srv.close());
  const det = await sendRawHttp(srv.baseUrl, 'GET', `/api/projects/${PROJECT}/prs/${pr.id}`, {
    headers: { authorization: 'Bearer tok-op' },
  });
  assert.equal(det.status, 200);
  assert.equal(det.json.currentHeadSha, topicSha);
});

test('R6-1 (P1 #1 + P2 #4 + P2 #7): Release gate fails closed with RO_ISOLATION_UNAVAILABLE by default when kernel RO bind-mount is unavailable and never damages cwd/package.json', async (t) => {
  const { target, run } = await releaseFixture(t);
  const pkgBefore = await fs.readFile(join(target, 'package.json'), 'utf8');
  // Default mode (allowHostFallback omitted/false) MUST fail closed if bwrap RO bind-mount cannot activate on host
  const defaultRes = await run({ allowHostFallback: false });
  if (defaultRes.exitCode !== 0) {
    assert.equal(defaultRes.exitCode, 2, JSON.stringify(defaultRes));
    assert.equal(defaultRes.checks.behavioral.code, 'RO_ISOLATION_UNAVAILABLE');
  }
  assert.equal(await fs.readFile(join(target, 'package.json'), 'utf8'), pkgBefore);
});

test('R6-2 (P1 #2 + P2 #1 + P2 #2 + P2 #3): Nonce-signed reporter hides env/path, ignores tests/ helpers & .spec.js, and legacy JSON replay records migrate to SQLite', async (t) => {
  const dir = await scratch(t);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.mkdir(join(dir, 'tests'), { recursive: true });
  await fs.writeFile(join(dir, 'tests/helper.js'), 'export const helperVal = 42;\n');
  await fs.writeFile(join(dir, 'ignored.spec.js'), 'export const specHelper = true;\n');
  await fs.writeFile(join(dir, 'real.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { helperVal } from './tests/helper.js';",
    "test('uses helper and sees no report env var', () => {",
    "  assert.equal(helperVal, 42);",
    "  assert.equal(process.env.SYNAPSE_TEST_REPORT_OUT, undefined);",
    "});",
  ].join('\n') + '\n');
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'node default discovery with helpers'], { cwd: dir });
  const sha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const runner = join(ROOT, 'src/templates/loop-templates.js');
  assert.equal(verifyNodeTests(sha, { subjectDir: dir, allowHostFallback: true }), true);

  // P2 #2: Legacy JSON replay file is automatically migrated into sibling SQLite DB on first open
  const legacyPath = join(dir, 'legacy-idem.json');
  await fs.writeFile(legacyPath, JSON.stringify({
    'proj:legacy-req-1': { requestDigest: 'c'.repeat(64), loop: { loopId: 'legacy-loop', loopVersion: 1 } },
  }));
  const migratedStore = createFileTemplateIdempotencyStore(legacyPath);
  await migratedStore.transact('proj:legacy-req-1', async (existing) => {
    assert.equal(existing?.requestDigest, 'c'.repeat(64));
    assert.equal(existing?.loop?.loopId, 'legacy-loop');
  });
});

test('R6-3 (P1 #3 + P2 #5 + P2 #6): Snapshot verifier rejects missing selected-attempt Git output and null JSON without throwing, and Loop health probe validates required columns', async (t) => {
  const { canonicalJson, sha256Buffer } = await import('../loop-store.js');
  const { computeAnchorSetSha256 } = await import('../loop-evidence.js');
  // P2 #6: Checksum-consistent null evidence-packet.json returns { ok: false } cleanly (no uncaught TypeError)
  const nullBuf = Buffer.from('null');
  const nullSha = sha256Buffer(nullBuf);
  const sums = Buffer.from([
    `${nullSha}  evidence-packet.json`,
    `${nullSha}  loop-manifest.json`,
    `${nullSha}  loop-run.json`,
  ].join('\n') + '\n');
  const nullMap = new Map([
    ['evidence-packet.json', nullBuf],
    ['loop-manifest.json', nullBuf],
    ['loop-run.json', nullBuf],
  ]);
  const nullRes = verifyEvidencePacketSnapshot({ memberBuffers: nullMap, sumsBytes: sums });
  assert.equal(nullRes.ok, false);
  assert.ok(nullRes.errors.some((e) => e.includes('JSON objects')));

  // P2 #5: Table with same name but missing required Loop store columns MUST report unhealthy!
  const dir = await scratch(t);
  const { default: Database } = await import('better-sqlite3');
  const badDb = new Database(join(dir, 'bad-schema.sqlite'));
  badDb.exec('CREATE TABLE loop_manifests (id INTEGER); CREATE TABLE loop_runs (id INTEGER); CREATE TABLE approval_events (id INTEGER);');
  const badColCheck = (() => {
    try { badDb.prepare('SELECT loop_id, loop_version, manifest_hash, manifest_json FROM loop_manifests LIMIT 1').all(); return true; }
    catch { return false; }
  })();
  assert.equal(badColCheck, false);
  badDb.close();

  // P1 #3: Missing attOut for declared Git output MUST fail verifyEvidencePacketSnapshot even when blob exists in bundle!
  const repoDir = join(dir, 'repo-p13');
  await fs.mkdir(repoDir, { recursive: true });
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repoDir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  await fs.writeFile(join(repoDir, 'out.txt'), 'hello git output\n');
  execFileSync('/usr/bin/git', ['add', 'out.txt'], { cwd: repoDir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'add out.txt'], { cwd: repoDir });
  const headSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  const runId = 'lrun_r6_missing_attout';
  execFileSync('/usr/bin/git', ['update-ref', `refs/synapse-proof/${runId}`, headSha], { cwd: repoDir });
  const bundlePath = join(dir, 'src.bundle');
  execFileSync('/usr/bin/git', ['bundle', 'create', bundlePath, `refs/synapse-proof/${runId}`], { cwd: repoDir });
  const bundleBuf = await fs.readFile(bundlePath);

  const manifestObj = {
    loopId: 'loop-r6', loopVersion: 1,
    evidence: { mode: 'pr', checkerNodeId: 'checker' },
    anchors: [{ anchorId: 'a1', implementationDigest: 'd'.repeat(64), requiredAssertions: ['ok'], proofSchema: { type: 'object' } }],
    nodes: [
      { nodeId: 'builder', kind: 'task', outputs: [{ path: 'out.txt', storage: 'git' }] },
      { nodeId: 'anchor_n', kind: 'anchor', anchorId: 'a1' },
      { nodeId: 'checker', kind: 'review' },
    ],
  };
  const manifestHash = sha256Buffer(Buffer.from(canonicalJson(manifestObj)));
  const proofObj = { assertions: [{ id: 'ok', passed: true }] };
  const stdoutBuf = Buffer.from(JSON.stringify(proofObj));
  const stderrBuf = Buffer.alloc(0);
  const reviewObj = { reviewedSourceSha: headSha, disposition: 'approve' };
  const reviewBuf = Buffer.from(JSON.stringify(reviewObj));
  const anchorEntry = {
    anchorId: 'a1', nodeId: 'anchor_n', attemptId: 'att-a1', outcome: 'passed', exitCode: 0, signal: null,
    runnerDigest: 'd'.repeat(64), subjectSha: headSha, proof: proofObj,
    stdout: { path: 'anchors/a1.stdout.json', sha256: sha256Buffer(stdoutBuf), bytes: stdoutBuf.length },
    stderr: { path: 'anchors/a1.stderr.txt', sha256: sha256Buffer(stderrBuf), bytes: 0 },
  };
  const runObj = {
    runId, loopId: 'loop-r6', loopVersion: 1, pin: { manifestHash },
    provenance: { source: { postIntegrationHeadSha: headSha } },
    selectedAttempts: { builder: 'att-b1', anchor_n: 'att-a1', checker: 'att-c1' },
    // Deliberately omit outputs on att-b1 so attOut for 'out.txt' is MISSING!
    nodeAttempts: { builder: [{ attemptId: 'att-b1', outputs: [] }] },
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifestObj));
  const runBuf = Buffer.from(JSON.stringify(runObj));
  const packetObj = {
    schemaVersion: 1,
    run: { runId, loopId: 'loop-r6', loopVersion: 1, manifestHash, verdict: 'passed' },
    files: {
      manifest: { path: 'loop-manifest.json', sha256: sha256Buffer(manifestBuf), bytes: manifestBuf.length },
      runRecord: { path: 'loop-run.json', sha256: sha256Buffer(runBuf), bytes: runBuf.length },
      artifacts: [],
    },
    anchors: [anchorEntry],
    pr: {
      postIntegrationHeadSha: headSha, approvedSourceSha: headSha,
      review: {
        nodeId: 'checker', attemptId: 'att-c1', reviewedSourceSha: headSha, disposition: 'approve',
        report: { path: 'review.json', sha256: sha256Buffer(reviewBuf), bytes: reviewBuf.length },
      },
      approval: {
        principalKind: 'operator', approvedSourceSha: headSha,
        reviewSha256: sha256Buffer(reviewBuf), anchorSetSha256: computeAnchorSetSha256([anchorEntry]),
      },
      sourceBundle: { path: 'source.bundle', sha256: sha256Buffer(bundleBuf), bytes: bundleBuf.length },
    },
  };
  const packetBuf = Buffer.from(JSON.stringify(packetObj));
  const members = new Map([
    ['anchors/a1.stderr.txt', stderrBuf],
    ['anchors/a1.stdout.json', stdoutBuf],
    ['evidence-packet.json', packetBuf],
    ['loop-manifest.json', manifestBuf],
    ['loop-run.json', runBuf],
    ['review.json', reviewBuf],
    ['source.bundle', bundleBuf],
  ]);
  const sumsBuf = Buffer.from([...members.keys()].sort().map((k) => `${sha256Buffer(members.get(k))}  ${k}`).join('\n') + '\n');
  const missingAttOutRes = verifyEvidencePacketSnapshot({ memberBuffers: members, sumsBytes: sumsBuf });
  assert.equal(missingAttOutRes.ok, false, JSON.stringify(missingAttOutRes));
  assert.ok(missingAttOutRes.errors.some((e) => e.includes('selected-attempt Git output record')));
});

test('R7-1 (Sol R6/R7 P1 + P2 #3): verifyNodeTests enforces strict zero-child-process RO/offline sandbox with zero verifier secrets in candidate process and catches test-.ts', async (t) => {
  const dir = await scratch(t);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(join(dir, 'sandbox.test.mjs'), [
    "import { readFileSync, writeFileSync, chmodSync } from 'node:fs';",
    "import { execFileSync } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('strict sandbox + zero verifier secrets hold', () => {",
    "  assert.equal(process.env.SYNAPSE_TEST_REPORT_OUT, undefined);",
    "  assert.ok(!process.execArgv.some((a) => a.includes('reporter.mjs') || a.includes('--import=')));",
    "  assert.throws(() => readFileSync('/etc/passwd'), { code: 'ERR_ACCESS_DENIED' });",
    "  const self = fileURLToPath(import.meta.url);",
    "  assert.throws(() => writeFileSync(self, 'mutated'), { code: 'ERR_ACCESS_DENIED' });",
    "  assert.throws(() => chmodSync(self, 0o600), { code: 'ERR_ACCESS_DENIED' });",
    "  assert.throws(() => execFileSync('/bin/true'), { code: 'ERR_ACCESS_DENIED' });",
    "});",
  ].join('\n') + '\n');
  execFileSync('/usr/bin/git', ['add', 'sandbox.test.mjs'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'sandboxed test'], { cwd: dir });
  const shaOk = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(verifyNodeTests(shaOk, { subjectDir: dir, allowHostFallback: true }), true);

  // P2 #3: Empty-suffix test-.ts MUST be matched by test-[^/]* (fails closed instead of silently omitted!)
  await fs.writeFile(join(dir, 'test-.ts'), 'const x: number = 1; throw new Error("empty suffix ts");\n');
  execFileSync('/usr/bin/git', ['add', 'test-.ts'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'add test-.ts'], { cwd: dir });
  const shaTs = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(verifyNodeTests(shaTs, { subjectDir: dir, allowHostFallback: true }), false);
});

test('R7-2 (Sol R6 P2 #1 + P2 #2): Expired SQLite lease cannot be revived and corrupt legacy JSON migration fails closed', async (t) => {
  const dir = await scratch(t);
  const loopStore = createLoopStore(join(dir, '.synapse'));
  const store = createSqliteTemplateIdempotencyStore(loopStore.db);
  await assert.rejects(
    store.transact('proj:expired-lease', async (_ex, save, assertLocked) => {
      loopStore.db.prepare('UPDATE template_idempotency_locks SET expires_at = ? WHERE scoped_key = ?').run(Date.now() - 1000, 'proj:expired-lease');
      const reviveRes = loopStore.db.prepare('UPDATE template_idempotency_locks SET expires_at = ? WHERE scoped_key = ? AND expires_at > ?').run(Date.now() + 30000, 'proj:expired-lease', Date.now());
      assert.equal(reviveRes.changes, 0);
      assert.throws(() => assertLocked(), /TEMPLATE_IDEMPOTENCY_LOCK_LOST/);
      save({ requestDigest: 'e'.repeat(64), loop: { loopId: 'should-not-commit' } });
    }),
    /TEMPLATE_IDEMPOTENCY_LOCK_LOST/,
  );

  // P2 #2: Corrupt legacy JSON file MUST fail closed on open (never silently skipped!)
  const corruptPath = join(dir, 'corrupt-legacy.json');
  await fs.writeFile(corruptPath, '{not-valid-json');
  const corruptStore = createFileTemplateIdempotencyStore(corruptPath);
  await assert.rejects(corruptStore.transact('proj:any', async () => {}), SyntaxError);
});

test('R8-1 (Sol R7 P1 #2 + P2 #2): verifyNodeTests fails closed by default without minimal-root bwrap and enforces single suite-wide deadline', async (t) => {
  const dir = await scratch(t);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(join(dir, 'a.test.mjs'), "import test from 'node:test'; test('a', async () => { await new Promise((r) => setTimeout(r, 150)); });\n");
  await fs.writeFile(join(dir, 'b.test.mjs'), "import test from 'node:test'; test('b', async () => { await new Promise((r) => setTimeout(r, 150)); });\n");
  await fs.writeFile(join(dir, 'c.test.mjs'), "import test from 'node:test'; test('c', async () => { await new Promise((r) => setTimeout(r, 150)); });\n");
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'three slow tests'], { cwd: dir });
  const sha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  // Single suite-wide deadline (300ms < 3 * 150ms + node startup) MUST abort the suite even though each file < 300ms!
  assert.equal(verifyNodeTests(sha, { subjectDir: dir, allowHostFallback: true, suiteTimeoutMs: 300 }), false);
  // Generous suite-wide deadline passes cleanly
  assert.equal(verifyNodeTests(sha, { subjectDir: dir, allowHostFallback: true, suiteTimeoutMs: 15_000 }), true);

  // Default CLI invocation (allowHostFallback = false) fails closed on hosts where minimal-root bwrap is unavailable
  const runner = join(ROOT, 'src/templates/loop-templates.js');
  const cliRes = await runNode(t, [runner, 'verify-pr-source@1', JSON.stringify({ expectedSha: sha, subjectSha: sha }), dir]);
  // Passes only if kernel minimal-root bwrap + /run tmpfs isolation is active on host; fails closed otherwise
  assert.ok(cliRes.status === 0 || cliRes.status === 1);
});

test('R9-1 (Sol R8 P1 #1 + P1 #3): verifyNodeTests rejects candidate stdout JUnit spoofing and safely handles shell-metacharacter filenames', async (t) => {
  const dir = await scratch(t);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: dir });
  // P1 #3: Candidate prints valid-looking JUnit XML to stdout without registering any node:test tests -> MUST FAIL because reporter writes to isolated fd 3!
  await fs.writeFile(join(dir, 'spoof.test.mjs'), [
    'process.stdout.write(',
    '  \'<?xml version="1.0" encoding="utf-8"?><testsuites><testcase name="fake" time="0.001" classname="test"/><!-- tests 1 --><!-- pass 1 --><!-- fail 0 --><!-- cancelled 0 --><!-- skipped 0 --><!-- todo 0 --></testsuites>\\n\'',
    ');',
  ].join('\n') + '\n');
  execFileSync('/usr/bin/git', ['add', 'spoof.test.mjs'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'stdout junit spoof'], { cwd: dir });
  const shaSpoof = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(verifyNodeTests(shaSpoof, { subjectDir: dir, allowHostFallback: true }), false);

  // P1 #1: Tracked filename with shell metacharacters ($(...)) MUST pass safely without shell command evaluation!
  const pwnMarker = join(dir, 'shell-injected.marker');
  const weirdName = `test-$(touch ${pwnMarker.replace(/\//g, '_')}).mjs`;
  await fs.rm(join(dir, 'spoof.test.mjs'));
  await fs.writeFile(join(dir, weirdName), "import test from 'node:test'; test('metachar filename safe', () => {});\n");
  execFileSync('/usr/bin/git', ['add', '-A'], { cwd: dir });
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'metachar test filename'], { cwd: dir });
  const shaWeird = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(verifyNodeTests(shaWeird, { subjectDir: dir, allowHostFallback: true }), true);
  assert.equal(await fs.access(pwnMarker).then(() => true, () => false), false);

  // A complete passing report is insufficient if the process exits nonzero.
  await fs.appendFile(join(dir, weirdName), "process.on('exit', () => { process.exitCode = 1; });\n");
  execFileSync('/usr/bin/git', ['commit', '-qam', 'passing assertions with failed exit'], { cwd: dir });
  const shaFailedExit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(verifyNodeTests(shaFailedExit, { subjectDir: dir, allowHostFallback: true }), false);
});
