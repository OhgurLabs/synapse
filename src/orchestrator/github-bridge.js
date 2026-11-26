import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs, constants as fsConstants, accessSync, closeSync, mkdtempSync, openSync,
  readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, delimiter } from 'node:path';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { captureEvidencePacketSnapshot, verifyEvidencePacketSnapshot } from '../loop-evidence.js';

const PUBLIC_API = 'https://api.github.com';
const WEBHOOK_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;
const STATUS_DESCRIPTION = 'Verified Synapse evidence';
const SECURITY_HEADERS = new Set([
  'x-hub-signature-256', 'x-hub-signature', 'x-github-delivery', 'x-github-hook-id',
  'x-github-event', 'content-encoding', 'content-length', 'transfer-encoding', 'content-type',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = (...parts) => JSON.stringify(parts);

export class GitHubBridgeError extends Error {
  constructor(code, statusCode = 503, { ambiguous = false, retryAt } = {}) {
    super(code);
    this.name = 'GitHubBridgeError';
    this.code = code;
    this.statusCode = statusCode;
    this.ambiguous = ambiguous;
    this.retryAt = retryAt;
  }
}

function requireThat(condition, code, statusCode) {
  if (!condition) throw new GitHubBridgeError(code, statusCode);
}

function headerMap(rawHeaders) {
  // Use IncomingMessage.rawHeaders so coalesced headers cannot conceal duplicates.
  requireThat(Array.isArray(rawHeaders) && rawHeaders.length % 2 === 0, 'INVALID_WEBHOOK_HEADERS', 400);
  const headers = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]).toLowerCase();
    if (!SECURITY_HEADERS.has(name)) continue;
    requireThat(!headers.has(name), 'DUPLICATE_WEBHOOK_HEADER', 400);
    headers.set(name, String(rawHeaders[i + 1]));
  }
  requireThat(!headers.has('content-encoding') || headers.get('content-encoding').toLowerCase() === 'identity',
    'UNSUPPORTED_WEBHOOK_ENCODING', 400);
  requireThat(!(headers.has('content-length') && headers.has('transfer-encoding')), 'INVALID_WEBHOOK_HEADERS', 400);
  if (headers.has('content-length')) {
    const length = headers.get('content-length');
    requireThat(/^\d+$/.test(length), 'INVALID_WEBHOOK_HEADERS', 400);
    requireThat(Number(length) <= WEBHOOK_LIMIT, 'WEBHOOK_TOO_LARGE', 413);
  }
  return headers;
}

export async function readGitHubWebhookBody(request) {
  headerMap(request.rawHeaders);
  const chunks = [];
  let size = 0;
  const iterable = typeof request.iterator === 'function' ? request.iterator({ destroyOnReturn: false }) : request;
  for await (const chunk of iterable) {
    requireThat(Buffer.isBuffer(chunk), 'RAW_WEBHOOK_BODY_REQUIRED', 400);
    size += chunk.length;
    requireThat(size <= WEBHOOK_LIMIT, 'WEBHOOK_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function verifyGitHubWebhookSignature({ rawBody, rawHeaders, secret }) {
  requireThat(Buffer.isBuffer(rawBody), 'RAW_WEBHOOK_BODY_REQUIRED', 400);
  requireThat(rawBody.length <= WEBHOOK_LIMIT, 'WEBHOOK_TOO_LARGE', 413);
  const headers = headerMap(rawHeaders);
  const signature = /^sha256=([a-fA-F0-9]{64})$/.exec(headers.get('x-hub-signature-256') ?? '');
  requireThat(signature && (typeof secret === 'string' || Buffer.isBuffer(secret)) && secret.length,
    'INVALID_WEBHOOK_SIGNATURE', 401);
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  requireThat(timingSafeEqual(expected, Buffer.from(signature[1], 'hex')), 'INVALID_WEBHOOK_SIGNATURE', 401);
  return true;
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const normalized = new URL('https://[' + address + ']').hostname.slice(1, -1);
  const halves = normalized.split(':'.repeat(2));
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return false;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part || '0', 16));
  if (groups.length !== 8 || groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return false;
  const [first, second] = groups;
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x3fff;
}

function apiConfig(apiOrigin, enterprise) {
  let url;
  try { url = new URL(apiOrigin); } catch { throw new GitHubBridgeError('GITHUB_ORIGIN_DENIED', 422); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  requireThat(url.protocol === 'https:' && !url.username && !url.password &&
    !url.search && !url.hash && !isIP(hostname) && hostname.includes('.') && !hostname.endsWith('.') &&
    apiOrigin === url.origin + (url.pathname === '/' ? '' : url.pathname), 'GITHUB_ORIGIN_DENIED', 422);
  if (apiOrigin === PUBLIC_API) return { origin: PUBLIC_API, prefix: '', hostname };
  const prefix = enterprise?.apiPrefix;
  requireThat(enterprise?.origin === url.origin && typeof prefix === 'string' &&
    /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) &&
    (url.pathname === '/' || url.pathname === prefix), 'GITHUB_ORIGIN_DENIED', 422);
  requireThat(enterprise.egressEnforced === true, 'GITHUB_ENTERPRISE_EGRESS_REQUIRED');
  return { origin: url.origin, prefix, hostname };
}

async function boundedJson(response) {
  if (response.status === 204) return null;
  const reader = response.body?.getReader();
  requireThat(reader, 'GITHUB_INVALID_RESPONSE');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        void reader.cancel().catch(() => {});
        throw new GitHubBridgeError('GITHUB_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

function retryAtFrom(headers, status) {
  const retry = headers.get('retry-after');
  if (retry && /^\d+$/.test(retry)) return Date.now() + 1000 * Math.min(Number(retry), 86400);
  if (retry && Number.isFinite(Date.parse(retry))) return Date.parse(retry);
  const rateReset = headers.get('x-ratelimit-reset');
  if (headers.get('x-ratelimit-remaining') === '0' && rateReset && /^\d+$/.test(rateReset)) {
    return Number(rateReset) * 1000;
  }
  return status === 429 ? Date.now() + 60_000 : undefined;
}

function verifiedGh({ egressEnforced, redirectsBlocked, path = process.env.PATH } = {}) {
  // The deployment must impose these controls on the CLI process, which follows redirects itself.
  requireThat(egressEnforced === true && redirectsBlocked === true && typeof path === 'string',
    'GITHUB_CLI_EGRESS_REQUIRED');
  const env = { PATH: path, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' };
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const file = realpathSync(join(directory, 'gh'));
      const stat = statSync(file);
      if (!stat.isFile() || (stat.mode & 0o022)) continue;
      accessSync(file, fsConstants.X_OK);
      const scratch = mkdtempSync(join(tmpdir(), 'synapse-gh-check-'));
      try {
        const path = join(scratch, 'version');
        const output = openSync(path, 'wx', 0o600);
        try { execFileSync(file, ['--version'], { env, stdio: ['ignore', output, 'ignore'], timeout: 2000 }); }
        finally { closeSync(output); }
        if (statSync(path).size <= 4096 && /^gh version \d+\.\d+\.\d+\b/.test(readFileSync(path, 'utf8'))) {
          return { file, env };
        }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    } catch { /* Try the next PATH entry. */ }
  }
  throw new GitHubBridgeError('GITHUB_CLI_UNAVAILABLE');
}

async function ghRequest(cli, url, token, method, body, timeoutMs) {
  const scratch = await fs.mkdtemp(join(tmpdir(), 'synapse-gh-request-'));
  let input;
  let output;
  try {
    const args = ['api', '--hostname', url.origin === PUBLIC_API ? 'github.com' : url.hostname,
      '--method', method, '--include', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28', url.href];
    if (body !== undefined) {
      const inputPath = join(scratch, 'input');
      await fs.writeFile(inputPath, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
      input = await fs.open(inputPath, 'r');
      args.push('-H', 'Content-Type: application/json', '--input', '-');
    }
    const tokenKey = url.origin === PUBLIC_API ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
    const outputPath = join(scratch, 'output');
    output = await fs.open(outputPath, 'wx', 0o600);
    const exit = await new Promise((finish, reject) => {
      const child = spawn(cli.file, args, {
        env: { ...cli.env, GH_CONFIG_DIR: scratch, [tokenKey]: token },
        stdio: [input?.fd ?? 'ignore', output.fd, 'ignore'], timeout: timeoutMs, killSignal: 'SIGKILL',
      });
      const monitor = setInterval(() => {
        void output.stat().then(({ size }) => {
          if (size > RESPONSE_LIMIT) child.kill('SIGKILL');
        }, () => {});
      }, 50);
      child.once('close', (code) => { clearInterval(monitor); finish(code); });
      child.once('error', (error) => { clearInterval(monitor); reject(error); });
    });
    requireThat(exit !== null && (await output.stat()).size <= RESPONSE_LIMIT, 'GITHUB_CLI_REQUEST_FAILED');
    const text = await fs.readFile(outputPath, 'utf8');
    const separator = /\r?\n\r?\n/.exec(text);
    const match = /^HTTP\/\S+ ([2-5]\d{2})\b/.exec(text);
    requireThat(match && separator && (exit === 0 || Number(match[1]) >= 300), 'GITHUB_CLI_REQUEST_FAILED');
    const status = Number(match[1]);
    const headers = new Headers();
    for (const line of text.slice(0, separator.index).split(/\r?\n/).slice(1)) {
      const split = line.indexOf(':');
      if (split > 0) headers.append(line.slice(0, split), line.slice(split + 1).trim());
    }
    return new Response([204, 205, 304].includes(status) ? null :
      text.slice(separator.index + separator[0].length), { status, headers });
  } finally {
    await Promise.all([input?.close(), output?.close()]);
    await fs.rm(scratch, { recursive: true, force: true });
  }
}


async function pinnedHttpsRequest(url, { method, headers, body, timeoutMs, answers, signal }) {
  const chosen = answers[0];
  const family = isIP(chosen.address) === 6 ? 6 : 4;
  return new Promise((resolveReq, rejectReq) => {
    const req = https.request({
      agent: false,
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: url.pathname + url.search,
      method,
      headers,
      servername: url.hostname,
      lookup: (_host, opts, cb) => {
        if (typeof opts === 'function') return opts(null, chosen.address, family);
        if (opts?.all) return cb(null, answers.map((a) => ({ address: a.address, family: isIP(a.address) === 6 ? 6 : 4 })));
        return cb(null, chosen.address, family);
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const respHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) respHeaders.set(k, v.join(', '));
        else if (typeof v === 'string') respHeaders.set(k, v);
      }
      const stream = new ReadableStream({
        start(controller) {
          res.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
          res.on('end', () => controller.close());
          res.on('error', (err) => controller.error(err));
        },
        cancel() { res.destroy(); },
      });
      resolveReq({
        ok: status >= 200 && status < 300,
        status,
        redirected: status >= 300 && status < 400,
        headers: respHeaders,
        body: stream,
      });
    });
    const onAbort = () => {
      req.destroy(new Error('GITHUB_REQUEST_TIMEOUT'));
      rejectReq(new Error('GITHUB_REQUEST_TIMEOUT'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', onAbort);
    req.on('error', rejectReq);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function createGitHubClient({
  apiOrigin = PUBLIC_API, enterprise, projectId, credentialVault, allowGlobalToken = false,
  dnsLookup = lookup, fetchImpl = null, transport = 'fetch', gh, timeoutMs = 10_000,
}) {
  const config = apiConfig(apiOrigin, enterprise);
  requireThat(ID.test(projectId ?? '') && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000 &&
    (transport === 'fetch' || transport === 'gh'), 'GITHUB_CLIENT_CONFIG_INVALID', 422);
  const cli = transport === 'gh' ? verifiedGh(gh) : null;

  return {
    apiOrigin: config.origin + config.prefix,
    async request(segments, { method = 'GET', query, body, beforeWrite } = {}) {
      requireThat(Array.isArray(segments) && segments.length && segments.every((segment) =>
        (typeof segment === 'string' || Number.isSafeInteger(segment)) && SEGMENT.test(String(segment))),
      'GITHUB_PATH_INVALID', 422);
      const writing = method !== 'GET';
      requireThat(['GET', 'POST', 'PATCH'].includes(method), 'GITHUB_METHOD_INVALID', 422);
      const url = new URL(config.prefix + '/' + segments.map(encodeURIComponent).join('/'), config.origin);
      if (query) url.search = new URLSearchParams(query).toString();
      let answers;
      let timer;
      try {
        answers = await Promise.race([
          dnsLookup(config.hostname, { all: true }),
          new Promise((_, reject) => { timer = setTimeout(reject, timeoutMs); }),
        ]);
      } catch {
        throw new GitHubBridgeError('GITHUB_DNS_FAILED');
      } finally {
        clearTimeout(timer);
      }
      requireThat(Array.isArray(answers) && answers.length && answers.every((answer) => isPublicAddress(answer?.address)),
        'GITHUB_DNS_DENIED');
      let token;
      try {
        const resolveCred = async (name) => {
          if (typeof credentialVault === 'function') return credentialVault(name, projectId);
          if (typeof credentialVault?.resolve === 'function') return credentialVault.resolve(projectId, name);
          const read = (credentialVault?.getSecret ?? credentialVault?.get)?.bind(credentialVault);
          return read?.(name);
        };
        token = await resolveCred('github-token-' + projectId);
        if (!token && allowGlobalToken) {
          token = await resolveCred('github-token');
          if (!token && typeof credentialVault?.resolve === 'function') {
            token = await credentialVault.resolve('_global', 'github-token');
          }
        }
      } catch {
        throw new GitHubBridgeError('GITHUB_CREDENTIAL_UNAVAILABLE');
      }
      requireThat(typeof token === 'string' && /^[\x21-\x7e]+$/.test(token),
        'GITHUB_CREDENTIAL_UNAVAILABLE');
      // Callers can recheck the live head after DNS and credential resolution and immediately before a write.
      if (writing) await beforeWrite?.();
      const signal = AbortSignal.timeout(timeoutMs);
      let response;
      const reqHeaders = {
        accept: 'application/vnd.github+json', authorization: 'Bearer ' + token,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'synapse-github-bridge/1.0',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      };
      const reqBody = body === undefined ? undefined : JSON.stringify(body);
      try {
        response = cli ? await ghRequest(cli, url, token, method, body, timeoutMs) :
          (typeof fetchImpl === 'function'
            ? await fetchImpl(url, {
                method, redirect: 'error', signal, headers: reqHeaders,
                ...(reqBody === undefined ? {} : { body: reqBody }),
              })
            : await pinnedHttpsRequest(url, { method, headers: reqHeaders, body: reqBody, timeoutMs, answers, signal }));
      } catch {
        throw new GitHubBridgeError('GITHUB_REQUEST_FAILED', 503, { ambiguous: writing });
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        throw new GitHubBridgeError('GITHUB_REDIRECT_DENIED', 503, { ambiguous: writing });
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const retryAt = retryAtFrom(response.headers, response.status);
        throw new GitHubBridgeError(retryAt ? 'GITHUB_RATE_LIMITED' : 'GITHUB_HTTP_ERROR', 503,
          { ambiguous: writing && (response.status >= 500 || response.status === 408), retryAt });
      }
      try {
        return { data: await boundedJson(response), link: response.headers.get('link') };
      } catch {
        throw new GitHubBridgeError('GITHUB_INVALID_RESPONSE', 503, { ambiguous: writing });
      }
    },
  };
}

function serialQueue() {
  const tails = new Map();
  return async (id, fn) => {
    const tail = tails.get(id) ?? Promise.resolve();
    const result = tail.then(fn);
    const settled = result.catch(() => {});
    tails.set(id, settled);
    try { return await result; } finally {
      if (tails.get(id) === settled) tails.delete(id);
    }
  };
}

const fileQueue = serialQueue();
const prQueue = serialQueue();

// One process owns the JSON store. A shared deployment can provide transactional storage and an exclusive
// withPrLock(key, fn) implementation through the same interface.
export function createFileGitHubBridgeStore(filePath) {
  requireThat(typeof filePath === 'string' && filePath.length, 'GITHUB_STORE_PATH_REQUIRED');
  const file = resolve(filePath);
  return {
    withPrLock: (bindingKey, fn) => prQueue(key(file, bindingKey), fn),
    transact: (update) => fileQueue(file, async () => {
      let state;
      try {
        state = JSON.parse(await fs.readFile(file, 'utf8'));
        requireThat(state.version === 1 && ['bindings', 'prKeys', 'receipts', 'deliveries', 'bodyKeys', 'issues']
          .every((name) => state[name] && typeof state[name] === 'object' && !Array.isArray(state[name])),
        'GITHUB_STORE_CORRUPT');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { version: 1, bindings: {}, prKeys: {}, receipts: {}, deliveries: {}, bodyKeys: {}, issues: {} };
      }
      const before = JSON.stringify(state);
      const result = update(state);
      requireThat(!result?.then, 'GITHUB_STORE_TRANSACTION_MUST_BE_SYNCHRONOUS');
      const after = JSON.stringify(state);
      if (before !== after) {
        const temporary = file + '.' + randomUUID() + '.tmp';
        await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try { await handle.writeFile(after + '\n'); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, file);
          const parent = await fs.open(dirname(file), 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
      return result;
    }),
  };
}

const validNumber = (value) => Number.isSafeInteger(value) && value > 0;
const repoPath = (binding, ...parts) => ['repos', binding.owner, binding.repo, ...parts];
const sameRef = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  left.replace(/^refs\/heads\//, '') === right.replace(/^refs\/heads\//, '');
const sameLogin = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  left.toLowerCase() === right.toLowerCase();

function webOrigin(binding) {
  if (binding.apiOrigin === PUBLIC_API) return 'https://github.com';
  return new URL(binding.apiOrigin).origin;
}

function livePrMatches(live, binding) {
  return live?.number === binding.pullNumber && live.base?.repo?.id === binding.repoId &&
    sameRef(live.base.ref, binding.targetRef) && sameRef(live.head?.ref, binding.sourceRef) &&
    live.head?.repo?.id === (binding.sourceRepoId ?? binding.repoId) && SHA.test(live.head.sha ?? '');
}

async function searchPages(client, path, select, maxPages) {
  for (let page = 1; page <= maxPages; page++) {
    const { data, link } = await client.request(path, { query: { per_page: '100', page: String(page) } });
    requireThat(Array.isArray(data) && data.length <= 100, 'GITHUB_INVALID_LIST');
    const match = data.find(select);
    if (match) return match;
    if (data.length < 100 && !/(?:^|[,;])\s*rel\s*=\s*"?next\b/i.test(link ?? '')) return null;
  }
  throw new GitHubBridgeError('GITHUB_PAGINATION_INCOMPLETE');
}

export function renderPublicGitHubEvidence({
  runId, approvedSourceSha, evidencePacketSha256, checksumManifestSha256, assertionCount, anchorCount,
}) {
  requireThat(typeof runId === 'string' && ID.test(runId) &&
    !/(?:gh[pousr]_\w{24,}|github_pat_\w{24,}|sk-[a-z0-9_-]{24,})/i.test(runId) &&
    typeof approvedSourceSha === 'string' && SHA.test(approvedSourceSha) &&
    typeof evidencePacketSha256 === 'string' && DIGEST.test(evidencePacketSha256) &&
    typeof checksumManifestSha256 === 'string' && DIGEST.test(checksumManifestSha256) &&
    validNumber(anchorCount) && validNumber(assertionCount) && assertionCount >= anchorCount,
  'PUBLIC_EVIDENCE_INVALID', 409);
  const opaqueMarker = hash('synapse-evidence:v1:' + runId).slice(0, 24);
  return [
    '<!-- synapse-evidence:v1 marker=' + opaqueMarker + ' -->',
    '## Synapse evidence',
    '',
    '- Source commit: `' + approvedSourceSha + '`',
    '- Anchors: passed (' + anchorCount + ' executed, ' + assertionCount + ' assertions passed)',
    '- Independent cross-provider review: approved',
    '- Evidence packet SHA-256: `' + evidencePacketSha256 + '`',
    '- Checksum manifest SHA-256: `' + checksumManifestSha256 + '`',
    '',
    'Verify the extracted packet with `node scripts/verify-loop-evidence.mjs <extracted-packet-dir>`.',
  ].join('\n');
}

async function verifiedProjection({ binding, live, expectedHeadSha, resolveLocalHead, getActiveProof, verifyPacketSnapshot }) {
  // getActiveProof reads the current operator approval, attachment, immutable packet path and pinned author assignments.
  const head = await resolveLocalHead(binding);
  const proof = await getActiveProof(binding);
  requireThat(proof?.approval && SHA.test(expectedHeadSha ?? '') && head === expectedHeadSha &&
    live === head && proof.approvedSourceSha === head && proof.approval.approvedSourceSha === head &&
    ID.test(proof.runId ?? '') && proof.approval.runId === proof.runId &&
    DIGEST.test(proof.approval.reviewSha256 ?? '') && DIGEST.test(proof.approval.anchorSetSha256 ?? ''),
  'GITHUB_PROOF_STALE_OR_MISSING', 409);
  let packet;
  let verdict;
  let evidencePacketSha256;
  let checksumManifestSha256;
  try {
    const snapshot = captureEvidencePacketSnapshot(proof.packetDir, { authorizeRoot: proof.authorizePacketRoot });
    const packetBytes = snapshot.memberBuffers.get('evidence-packet.json');
    const sums = snapshot.sumsBytes;
    evidencePacketSha256 = hash(packetBytes);
    checksumManifestSha256 = hash(sums);
    requireThat(evidencePacketSha256 === proof.evidencePacketSha256 &&
      checksumManifestSha256 === proof.checksumManifestSha256, 'GITHUB_PACKET_DIGEST_MISMATCH', 409);
    verdict = await verifyPacketSnapshot(snapshot, { archivePrivatePaths: proof.archivePrivatePaths });
    packet = JSON.parse(packetBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof GitHubBridgeError) throw error;
    throw new GitHubBridgeError('GITHUB_PACKET_INVALID', 409);
  }
  const review = packet?.pr?.review;
  const approval = packet?.pr?.approval;
  requireThat(verdict?.ok === true && verdict.summary?.approvedSourceSha === head &&
    verdict.summary?.runId === proof.runId && verdict.summary?.verdict === 'passed' &&
    packet.schemaVersion === 1 && packet.run?.verdict === 'passed' && packet.run.runId === proof.runId &&
    packet.pr?.projectId === binding.projectId && packet.pr.prId === binding.prId &&
    packet.pr.approvedSourceSha === head && approval?.approvedSourceSha === head &&
    approval.principalKind === 'operator' && ID.test(approval.eventId ?? '') &&
    approval.eventId === proof.approval.eventId &&
    approval.reviewSha256 === proof.approval.reviewSha256 && review?.report?.sha256 === approval.reviewSha256 &&
    approval.anchorSetSha256 === proof.approval.anchorSetSha256,
  'GITHUB_PACKET_INVALID', 409);

  const authors = proof.authors;
  requireThat(review?.disposition === 'approve' && review.reviewedSourceSha === head &&
    typeof review.agentId === 'string' && review.agentId && typeof review.provider === 'string' && review.provider &&
    Array.isArray(authors) && authors.length && authors.every((author) =>
      typeof author.agentId === 'string' && author.agentId && author.agentId !== review.agentId &&
      (!author.agentInstanceId || author.agentInstanceId !== review.agentInstanceId) &&
      (!author.sessionId || author.sessionId !== review.sessionId) &&
      typeof author.provider === 'string' && author.provider && !sameLogin(author.provider, review.provider)),
  'GITHUB_INDEPENDENT_REVIEW_REQUIRED', 409);

  const anchors = packet.anchors;
  requireThat(Array.isArray(anchors) && anchors.length && verdict.summary.anchorsVerified === anchors.length,
    'GITHUB_PASSING_ANCHORS_REQUIRED', 409);
  let assertionCount = 0;
  for (const anchor of anchors) {
    const assertions = anchor?.proof?.assertions;
    requireThat(anchor?.outcome === 'passed' && anchor.subjectSha === head &&
      Array.isArray(assertions) && assertions.length && assertions.every((assertion) => assertion?.passed === true),
    'GITHUB_PASSING_ANCHORS_REQUIRED', 409);
    assertionCount += assertions.length;
  }
  return { runId: proof.runId, approvedSourceSha: head, evidencePacketSha256, checksumManifestSha256,
    assertionCount, anchorCount: anchors.length };
}

export async function publishEvidenceToGitHub({
  binding, store, client, identity, expectedHeadSha, resolveLocalHead, getActiveProof,
  verifyPacketSnapshot = verifyEvidencePacketSnapshot, maxPages = 5,
}) {
  requireThat(typeof identity?.login === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(identity.login) &&
    (identity.userId === undefined || validNumber(identity.userId)),
  'GITHUB_BRIDGE_IDENTITY_REQUIRED');
  const own = (item) => sameLogin(item?.user?.login, identity.login) &&
    (identity.userId === undefined || item.user.id === identity.userId);
  return store.withPrLock(binding.bindingKey, async () => {
    const deferred = await store.transact((state) => Object.values(state.receipts).find((receipt) =>
      receipt.bindingKey === binding.bindingKey && receipt.approvedSourceSha === expectedHeadSha &&
      receipt.state !== 'completed' && receipt.retryAt > Date.now()));
    if (deferred) return { statusCode: 202, receipt: deferred };

    async function liveHead() {
      const { data } = await client.request(repoPath(binding, 'pulls', binding.pullNumber));
      requireThat(livePrMatches(data, binding), 'GITHUB_PR_BINDING_CHANGED', 409);
      return data.head.sha;
    }
    const checkpoint = async () => {
      return verifiedProjection({
        binding, live: await liveHead(), expectedHeadSha, resolveLocalHead, getActiveProof, verifyPacketSnapshot,
      });
    };
    const projection = await checkpoint();
    const body = renderPublicGitHubEvidence(projection);
    const marker = body.split('\n', 1)[0];
    const receiptKey = key(binding.bindingKey, projection.runId, projection.approvedSourceSha, projection.evidencePacketSha256);
    const update = (changes) => store.transact((state) => Object.assign(state.receipts[receiptKey], changes));
    let receipt = await store.transact((state) => state.receipts[receiptKey] ??= {
      receiptKey, bindingKey: binding.bindingKey, ...projection, state: 'queued',
      commentReceipt: null, statusReceipt: null,
    });
    const result = (statusCode) => ({ statusCode, receipt });
    if (receipt.state === 'completed') return result(200);

    async function guard() {
      const fresh = await checkpoint();
      requireThat(renderPublicGitHubEvidence(fresh) === body &&
        fresh.checksumManifestSha256 === projection.checksumManifestSha256, 'GITHUB_PROOF_STALE_OR_MISSING', 409);
      // Packet verification can take time. Sample both refs again at the write boundary.
      const [remote, local] = await Promise.all([liveHead(), resolveLocalHead(binding)]);
      requireThat(remote === expectedHeadSha && local === expectedHeadSha, 'GITHUB_PROOF_STALE_OR_MISSING', 409);
    }

    // Persist the intent before sending. A crash can leave the effect unknown even if GitHub committed it.
    async function write(field, path, method, payload, extract) {
      let attempted = false;
      try {
        const { data } = await client.request(path, {
          method, body: payload, beforeWrite: async () => {
            await guard();
            receipt = await update({ [field]: { state: 'pending' }, state: 'publishing', retryAt: null, code: null });
            attempted = true;
          },
        });
        const remote = extract(data);
        if (!validNumber(remote)) throw new GitHubBridgeError('GITHUB_WRITE_RESPONSE_INVALID', 503, { ambiguous: true });
        receipt = await update({ [field]: { state: 'completed', id: remote }, state: 'publishing' });
      } catch (error) {
        if (!attempted) throw error;
        const uncertain = error.ambiguous || !(error instanceof GitHubBridgeError);
        receipt = await update({
          [field]: uncertain ? { state: 'needs_reconciliation' } : null,
          state: uncertain ? 'needs_reconciliation' : 'queued',
          retryAt: error.retryAt ?? null,
          code: uncertain ? 'GITHUB_WRITE_UNCERTAIN' : error.code,
        });
        return false;
      }
      return true;
    }

    try {
      if (receipt.commentReceipt?.state !== 'completed') {
        const path = repoPath(binding, 'issues', binding.pullNumber, 'comments');
        const comment = await searchPages(client, path, (item) =>
          own(item) && typeof item.body === 'string' && item.body.split(/\r?\n/, 1)[0] === marker, maxPages);
        if (comment) requireThat(validNumber(comment.id), 'GITHUB_INVALID_COMMENT');
        if (comment?.body === body) {
          receipt = await update({ commentReceipt: { state: 'completed', id: comment.id }, state: 'publishing',
            retryAt: null, code: null });
        } else if (receipt.commentReceipt) {
          receipt = await update({ state: 'needs_reconciliation', code: 'GITHUB_WRITE_UNCERTAIN' });
          return result(202);
        } else {
          const pathToWrite = comment ? repoPath(binding, 'issues', 'comments', comment.id) : path;
          const written = await write('commentReceipt', pathToWrite, comment ? 'PATCH' : 'POST', { body },
            (data) => data?.body === body && own(data) ? data.id : null);
          if (!written) return result(202);
        }
      }

      await guard();
      const context = 'synapse/evidence/pr-' + binding.pullNumber;
      const targetUrl = new URL('/' + binding.owner + '/' + binding.repo + '/pull/' +
        binding.pullNumber + '#issuecomment-' + receipt.commentReceipt.id, webOrigin(binding)).href;
      const statusBody = { context, state: 'success', description: STATUS_DESCRIPTION, target_url: targetUrl };
      const ownStatus = (item) => Boolean(item?.creator) && sameLogin(item.creator?.login, identity.login) && (identity.userId === undefined || item.creator?.id === identity.userId);
      const equivalent = (item) => item?.context === context && item.state === statusBody.state &&
        item.description === statusBody.description && item.target_url === targetUrl && ownStatus(item);
      const latest = await searchPages(client, repoPath(binding, 'commits', expectedHeadSha, 'statuses'),
        (item) => item?.context === context, maxPages);
      if (equivalent(latest)) {
        requireThat(validNumber(latest.id), 'GITHUB_INVALID_STATUS');
        receipt = await update({ statusReceipt: { state: 'completed', id: latest.id } });
      } else if (receipt.statusReceipt) {
        receipt = await update({ state: 'needs_reconciliation', code: 'GITHUB_WRITE_UNCERTAIN' });
        return result(202);
      } else {
        const written = await write('statusReceipt', repoPath(binding, 'statuses', expectedHeadSha), 'POST',
          statusBody, (data) => equivalent(data) ? data.id : null);
        if (!written) return result(202);
      }
      receipt = await update({ state: 'completed', code: null, retryAt: null });
      return result(202);
    } catch (error) {
      const ambiguous = [receipt.commentReceipt, receipt.statusReceipt]
        .some((effect) => effect && effect.state !== 'completed');
      receipt = await update({
        state: ambiguous ? 'needs_reconciliation' : error.statusCode === 409 ? 'blocked' : 'queued',
        code: error instanceof GitHubBridgeError ? error.code : 'GITHUB_PUBLICATION_FAILED',
        retryAt: error.retryAt ?? null,
      });
      if (error.statusCode === 409) throw error;
      return result(202);
    }
  });
}

/** Resolve exactly one webhook from private project configurations. */
export function resolveConfiguredGitHubHook(stateManager, hookId) {
  let match = null;
  for (const { id } of stateManager.listProjects()) {
    const github = stateManager.getProject(id)?.github;
    if (!github?.hook || String(github.hook.id) !== String(hookId)) continue;
    if (match) return null;
    match = { ...github.hook, projectId: id, repoId: github.repoId, apiOrigin: github.apiOrigin };
  }
  return match;
}

/**
 * HTTP integration supplies deployment-owned repository and hook config, the PR store, a local
 * source-ref resolver, and an active-proof loader. The proof loader returns the attached run ID,
 * approved SHA, packet directory and digests, the active operator approval and canonical authors.
 * Mount admitWebhook before JSON parsing and run drainWebhookQueue from the durable worker.
 */
export function createGitHubBridge({
  store, storePath, getRepository, getHook, prStore, resolveLocalHead, getActiveProof,
  verifyPacketSnapshot, createQueuedTask, clientOptions = {}, maxPages = 5, leaseMs = 120_000,
}) {
  store ??= createFileGitHubBridgeStore(storePath);
  requireThat(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 20 &&
    Number.isSafeInteger(leaseMs) && leaseMs > 0, 'GITHUB_BRIDGE_CONFIG_INVALID', 422);

  const getBinding = (projectId, prId) => store.transact((state) =>
    state.bindings[state.prKeys[key(projectId, prId)]] ?? null);
  const getBindingByRemote = (apiOrigin, repoId, number) => store.transact((state) =>
    state.bindings[key(apiOrigin, repoId, number)] ?? null);

  async function repository(projectId) {
    const config = await getRepository(projectId);
    requireThat(config && SEGMENT.test(config.owner ?? '') && SEGMENT.test(config.repo ?? '') &&
      validNumber(config.repoId) && (config.sourceRepoId === undefined || validNumber(config.sourceRepoId)),
    'GITHUB_REPOSITORY_NOT_CONFIGURED', 422);
    const client = createGitHubClient({
      ...clientOptions,
      apiOrigin: config.apiOrigin ?? PUBLIC_API,
      enterprise: config.enterprise,
      projectId,
    });
    return { config, client };
  }

  function bindingMatchesConfig(binding, config, client) {
    return binding.apiOrigin === client.apiOrigin && binding.repoId === config.repoId &&
      binding.sourceRepoId === (config.sourceRepoId ?? config.repoId) &&
      sameLogin(binding.owner, config.owner) && sameLogin(binding.repo, config.repo);
  }

  async function bindPullRequest({ projectId, prId, pullNumber }) {
    requireThat(ID.test(projectId ?? '') && ID.test(prId ?? '') && validNumber(pullNumber),
      'GITHUB_BINDING_INVALID', 400);
    const { config, client } = await repository(projectId);
    const pr = await prStore.getPR(projectId, prId);
    requireThat(pr, 'GITHUB_LOCAL_PR_NOT_FOUND', 404);
    const bindingKey = key(client.apiOrigin, config.repoId, pullNumber);
    const binding = {
      bindingKey, apiOrigin: client.apiOrigin, repoId: config.repoId, projectId, prId, pullNumber,
      owner: config.owner, repo: config.repo, sourceRepoId: config.sourceRepoId ?? config.repoId,
      sourceRef: pr.sourceRef ?? pr.sourceBranch, targetRef: pr.targetRef ?? pr.targetBranch,
    };
    return store.withPrLock(bindingKey, async () => {
      const { data } = await client.request(repoPath(binding, 'pulls', pullNumber));
      requireThat(livePrMatches(data, binding), 'GITHUB_PR_BINDING_MISMATCH', 409);
      return store.transact((state) => {
        const prKey = key(projectId, prId);
        const existing = state.bindings[bindingKey];
        requireThat((!state.prKeys[prKey] || state.prKeys[prKey] === bindingKey) &&
          (!existing || (existing.projectId === projectId && existing.prId === prId &&
            JSON.stringify(existing) === JSON.stringify(binding))),
        'GITHUB_BINDING_CONFLICT', 409);
        state.prKeys[prKey] = bindingKey;
        state.bindings[bindingKey] = binding;
        return { binding, created: !existing, url: webOrigin(binding) + '/' + binding.owner + '/' + binding.repo + '/pull/' + pullNumber };
      });
    });
  }

  async function publish({ projectId, prId, expectedHeadSha }) {
    const binding = await getBinding(projectId, prId);
    requireThat(binding, 'GITHUB_BINDING_NOT_FOUND', 409);
    const { config, client } = await repository(projectId);
    requireThat(bindingMatchesConfig(binding, config, client), 'GITHUB_PR_BINDING_CHANGED', 409);
    return publishEvidenceToGitHub({
      binding, store, client, identity: config.bridgeIdentity, expectedHeadSha, resolveLocalHead,
      getActiveProof, verifyPacketSnapshot, maxPages,
    });
  }

  async function admitWebhook({ rawBody, rawHeaders }) {
    requireThat(Buffer.isBuffer(rawBody), 'RAW_WEBHOOK_BODY_REQUIRED', 400);
    requireThat(rawBody.length <= WEBHOOK_LIMIT, 'WEBHOOK_TOO_LARGE', 413);
    const headers = headerMap(rawHeaders);
    const hookId = headers.get('x-github-hook-id');
    const deliveryId = headers.get('x-github-delivery');
    const event = headers.get('x-github-event');
    requireThat(ID.test(hookId ?? '') && ID.test(deliveryId ?? '') && ID.test(event ?? ''),
      'INVALID_WEBHOOK_HEADERS', 400);
    const hook = await getHook(hookId);
    verifyGitHubWebhookSignature({ rawBody, rawHeaders, secret: hook?.secret });
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); }
    catch { throw new GitHubBridgeError('INVALID_WEBHOOK_JSON', 400); }
    requireThat(ID.test(hook.projectId ?? '') && validNumber(hook.repoId) &&
      payload?.repository?.id === hook.repoId, 'WEBHOOK_REPOSITORY_MISMATCH', 400);
    const { config, client } = await repository(hook.projectId);
    requireThat(config.repoId === hook.repoId && (!hook.apiOrigin || hook.apiOrigin === client.apiOrigin),
      'WEBHOOK_REPOSITORY_MISMATCH', 400);
    const apiOrigin = client.apiOrigin;
    let work = null;
    if (event === 'pull_request' && payload.action === 'synchronize') {
      requireThat(validNumber(payload.number), 'INVALID_WEBHOOK_PR', 400);
      const binding = await getBindingByRemote(apiOrigin, hook.repoId, payload.number);
      if (binding?.projectId === hook.projectId) work = { kind: 'sync', bindingKey: binding.bindingKey };
    } else if (event === 'issue_comment' && payload.action === 'created' && hook.issueCommentEnabled === true) {
      const author = payload.comment?.user;
      if (payload.issue?.pull_request && validNumber(payload.issue.number) &&
        payload.comment?.body === '/synapse post-evidence' && validNumber(author?.id) &&
        payload.sender?.id === author.id && sameLogin(payload.sender.login, author.login) &&
        hook.allowedCommenters?.some((entry) => entry.userId === author.id && sameLogin(entry.login, author.login))) {
        const binding = await getBindingByRemote(apiOrigin, hook.repoId, payload.issue.number);
        if (binding?.projectId === hook.projectId) {
          work = { kind: 'publish', bindingKey: binding.bindingKey, author: { id: author.id, login: author.login } };
        }
      }
    } else if (event === 'issues' && payload.action === 'opened' && hook.issuesEnabled === true) {
      const issue = payload.issue;
      requireThat(validNumber(issue?.number) && typeof issue.title === 'string' &&
        (issue.body == null || typeof issue.body === 'string'), 'INVALID_WEBHOOK_ISSUE', 400);
      work = { kind: 'issue', issueKey: key(apiOrigin, hook.repoId, issue.number), issueNumber: issue.number,
        title: issue.title.slice(0, 256), body: (issue.body ?? '').slice(0, 16_384) };
    }
    const deliveryKey = key(hookId, deliveryId);
    const signedBodyDigest = hash(rawBody);
    const bodyKey = key(hookId, signedBodyDigest);
    return store.transact((state) => {
      const existing = state.deliveries[deliveryKey];
      requireThat(!existing || existing.signedBodyDigest === signedBodyDigest, 'WEBHOOK_DELIVERY_CONFLICT', 400);
      if (existing || state.bodyKeys[bodyKey]) return { statusCode: 200, state: 'duplicate' };
      const shouldQueue = work && (work.kind !== 'issue' || !state.issues[work.issueKey]);
      if (shouldQueue && work.kind === 'issue') state.issues[work.issueKey] = { deliveryKey };
      state.bodyKeys[bodyKey] = deliveryKey;
      state.deliveries[deliveryKey] = {
        hookId, deliveryId, signedBodyDigest, projectId: hook.projectId, repoId: hook.repoId,
        apiOrigin, work: shouldQueue ? work : null, state: shouldQueue ? 'queued' : 'ignored',
      };
      return { statusCode: shouldQueue ? 202 : 200, state: shouldQueue ? 'queued' : 'ignored', deliveryKey };
    });
  }

  async function processDelivery(deliveryKey) {
    const lease = randomUUID();
    const job = await store.transact((state) => {
      const item = state.deliveries[deliveryKey];
      if (!item?.work || item.state === 'completed' || item.leaseUntil > Date.now() || item.retryAt > Date.now()) return null;
      return Object.assign(item, { state: 'working', lease, leaseUntil: Date.now() + leaseMs });
    });
    if (!job) return { state: 'unavailable' };
    const finish = (changes) => store.transact((state) => {
      const item = state.deliveries[deliveryKey];
      if (item.lease !== lease) return { state: 'lease_lost' };
      Object.assign(item, changes, { lease: null, leaseUntil: null });
      return { state: item.state };
    });
    try {
      const hook = await getHook(job.hookId);
      if (hook?.projectId !== job.projectId || hook.repoId !== job.repoId ||
        (hook.apiOrigin && hook.apiOrigin !== job.apiOrigin)) return finish({ state: 'completed' });
      const { config, client } = await repository(job.projectId);
      requireThat(client.apiOrigin === job.apiOrigin && config.repoId === job.repoId, 'WEBHOOK_REPOSITORY_CHANGED', 409);
      const work = job.work;
      if (work.kind === 'issue') {
        if (hook.issuesEnabled === true) {
          // The task store must enforce idempotencyKey transactionally with the queued insert.
          await createQueuedTask({ projectId: job.projectId, status: 'queued', idempotencyKey: work.issueKey,
            source: { kind: 'github-issue', repoId: job.repoId, issueNumber: work.issueNumber },
            untrustedIssue: { title: work.title, body: work.body } });
        }
      } else {
        const binding = await store.transact((state) => state.bindings[work.bindingKey]);
        requireThat(binding?.projectId === job.projectId && bindingMatchesConfig(binding, config, client),
          'GITHUB_PR_BINDING_CHANGED', 409);
        if (work.kind === 'sync') {
          await store.withPrLock(binding.bindingKey, async () => {
            const { data } = await client.request(repoPath(binding, 'pulls', binding.pullNumber));
            requireThat(livePrMatches(data, binding), 'GITHUB_PR_BINDING_CHANGED', 409);
            const pr = await prStore.getPR(binding.projectId, binding.prId);
            requireThat(pr, 'GITHUB_LOCAL_PR_NOT_FOUND', 404);
            const current = pr.currentHeadSha ?? pr.headSha ?? pr.verificationProof?.headSha ?? pr.approvedSourceSha;
            if (current !== data.head.sha) {
              await prStore.invalidateApprovalOnShaChange(binding.projectId, binding.prId, data.head.sha);
            }
          });
        } else if (hook.issueCommentEnabled === true && hook.allowedCommenters?.some((entry) =>
          entry.userId === work.author.id && sameLogin(entry.login, work.author.login))) {
          const proof = await getActiveProof(binding);
          const outcome = await publish({ projectId: binding.projectId, prId: binding.prId,
            expectedHeadSha: proof?.approvedSourceSha });
          if (outcome.receipt.state !== 'completed') {
            return finish({ state: 'queued', retryAt: outcome.receipt.retryAt ?? Date.now() + 1000 });
          }
        }
      }
      return finish({ state: 'completed', retryAt: null });
    } catch (error) {
      if (error instanceof GitHubBridgeError && [404, 409].includes(error.statusCode)) {
        return finish({ state: 'completed', code: error.code, retryAt: null });
      }
      return finish({ state: 'queued', retryAt: error.retryAt ?? Date.now() + 1000,
        code: error instanceof GitHubBridgeError ? error.code : 'GITHUB_WEBHOOK_WORK_FAILED' });
    }
  }

  async function drainWebhookQueue({ limit = 25 } = {}) {
    requireThat(Number.isInteger(limit) && limit > 0 && limit <= 100, 'GITHUB_QUEUE_LIMIT_INVALID', 422);
    const keys = await store.transact((state) => Object.keys(state.deliveries).filter((id) => {
      const item = state.deliveries[id];
      return item.work && item.state !== 'completed' && !(item.leaseUntil > Date.now()) && !(item.retryAt > Date.now());
    }).slice(0, limit));
    const results = [];
    for (const id of keys) results.push(await processDelivery(id));
    return results;
  }

  async function getPublication(projectId, prId) {
    const binding = await getBinding(projectId, prId);
    if (!binding) return null;
    return store.transact((state) => Object.values(state.receipts)
      .filter((receipt) => receipt.bindingKey === binding.bindingKey).at(-1) ?? null);
  }

  return { getBinding, bindPullRequest, admitWebhook, processDelivery, drainWebhookQueue,
    publishEvidenceToGitHub: publish, getPublication };
}

export function buildActiveProofForPr({ prStore, loopStore, agents, binding }) {
  const pr = prStore?.getPR?.(binding.projectId, binding.prId);
  if (!pr) return null;
  const runId = pr.verificationProof?.loopRunId || pr.loopRunId || null;
  if (!runId || !loopStore || typeof loopStore.getLatestApprovalForRun !== 'function') return null;
  const persistedApproval = loopStore.getLatestApprovalForRun(runId);
  if (!persistedApproval || typeof persistedApproval !== 'object') return null;
  const approval = {
    eventId: persistedApproval.eventId ?? null,
    runId: persistedApproval.runId ?? null,
    approvedSourceSha: persistedApproval.approvedSourceSha ?? null,
    reviewSha256: persistedApproval.reviewSha256 ?? null,
    anchorSetSha256: persistedApproval.anchorSetSha256 ?? null,
    principalKind: persistedApproval.principalKind ?? null,
  };
  const boundReview = (pr.reviews || []).find((r) => {
    if (!r || r.status !== 'approved') return false;
    if (!approval.approvedSourceSha || r.approvedSourceSha !== approval.approvedSourceSha) return false;
    const reviewDigest = r.reviewSha256 || r.report?.sha256 || null;
    if (!approval.reviewSha256 || reviewDigest !== approval.reviewSha256) return false;
    if (r.approvalEventId && r.approvalEventId !== approval.eventId) return false;
    return true;
  }) || null;
  const rawAuthors = Array.isArray(pr.authors) && pr.authors.length
    ? pr.authors
    : (Array.isArray(pr.verificationProof?.authors) && pr.verificationProof.authors.length
        ? pr.verificationProof.authors
        : (pr.author ? [{
            agentId: pr.author,
            provider: pr.authorProvider || agents?.[pr.author]?.provider || null,
            agentInstanceId: pr.authorInstanceId || null,
            sessionId: pr.authorSessionId || null,
          }] : []));
  const authors = rawAuthors
    .filter((a) => a && typeof a.agentId === 'string' && a.agentId && typeof a.provider === 'string' && a.provider.trim())
    .map((a) => ({
      agentId: a.agentId,
      provider: a.provider,
      ...(a.agentInstanceId ? { agentInstanceId: a.agentInstanceId } : {}),
      ...(a.sessionId ? { sessionId: a.sessionId } : {}),
    }));
  return {
    runId,
    approvedSourceSha: approval.approvedSourceSha,
    packetDir: pr.verificationProof?.evidencePacketDir || pr.evidencePacketDir || null,
    evidencePacketSha256: pr.verificationProof?.evidencePacketSha256 || null,
    checksumManifestSha256: pr.verificationProof?.checksumManifestSha256 || null,
    approval,
    authors,
    anchors: pr.verificationProof?.anchors || [],
    review: boundReview,
    authorProvider: authors[0]?.provider || null,
  };
}
