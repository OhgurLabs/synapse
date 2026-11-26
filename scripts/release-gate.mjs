#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants, openSync, fchmodSync, closeSync, readdirSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

const RUNTIME_FILES = Object.freeze([
  'package.json', 'src/orchestrator.js', 'src/orchestrator/api.js', 'src/ui/public/index.html', 'src/ui/public/js/main.js',
  'src/ui/public/js/loops.js', 'scripts/release-gate.mjs', 'src/orchestrator/github-bridge.js',
  'src/templates/loop-templates.js', 'src/ui/public/js/prs.js', 'src/ui/public/css/prs.css',
  'scripts/verify-loop-evidence.mjs',
]);
export const RELEASE_TEST_FILES = Object.freeze([
  'src/orchestrator/phase4-release-bridge.test.js', 'src/orchestrator/mcp-task-create.test.js',
]);
export const RELEASE_TEST_NAMES = Object.freeze([
  'github-webhook-auth-and-replay', 'github-head-sync-and-exact-merge', 'github-publication-idempotency',
  'github-egress-and-optional-events', 'pr-dashboard-gates', 'curated-template-packs',
  'gemini-antigravity-only', 'orphan-reconciliation-preserves-daemon', 'release-gate-fail-closed',
]);
export const REQUIRED_RELEASE_FILES = Object.freeze([
  ...RUNTIME_FILES, 'package-lock.json', 'README.md', 'LICENSE', ...RELEASE_TEST_FILES,
]);
const FORBIDDEN_DIRS = new Set([
  '.git', '.synapse', 'vault', 'node_modules', '.ssh', '.aws', '.cache', '.agents', '.codex',
  'worktrees', 'node-logs', 'release-tooling',
]);
const FORBIDDEN_FILES = /^(?:(?!\.env\.example$)\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|credentials(?:[.-].*)?\.json|(?:id_rsa|id_ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|sqlite(?:3)?(?:-wal|-shm)?))$/i;
const CREDENTIAL_RULES = [
  ['private-key', new RegExp('-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----', 'i')],
  ['github-token', /\b(?:gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{30,})\b/i],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack-token', /\bxox[baprs]-[a-z0-9-]{20,}\b/i],
  ['api-token', /\bsk-(?:(?:proj|ant-api\d+)-)?[a-z0-9_-]{20,}\b/i],
  ['authorization-token', /\bbearer[ \t]+(?:[a-z0-9_~/+.-]{24,}={0,2})\b/i],
  ['jwt', /\beyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{10,}\b/i],
  ['assigned-credential', /\b(?:client[_-]?secret|api[_-]?key|access[_-]?token|password)\b["']?\s*[:=]\s*["'][a-z0-9_~+/=.-]{16,}["']/i],
  ['credential-url', /\b[a-z][a-z\d+.-]*:\/\/[^\s:/@]+:[^\s/@]+@[^\s/]+/i],
];
const CHECKS = ['tree', 'leaks', 'requiredFiles', 'package', 'behavioral', 'smokeImport', 'templateDefaults', 'treeUnchanged'];
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const order = (left, right) => left === right ? 0 : left < right ? -1 : 1;

class GateError extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function ensure(condition, code, exitCode = 1) {
  if (!condition) throw new GateError(code, exitCode);
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function compilePolicy(input) {
  const rules = [];
  for (const [type, list] of [['private-infra', input?.privateInfra], ['private-research', input?.privateResearch]]) {
    ensure(Array.isArray(list) && list.length > 0, 'POLICY_RULES_REQUIRED', 2);
    for (const [index, item] of list.entries()) {
      const source = typeof item === 'string' ? item : item?.pattern;
      // IDs are generated so a protected inventory value cannot appear in the report.
      const id = type + '-' + (index + 1);
      ensure(typeof source === 'string' && source.length > 0 && source.length <= 8192, 'POLICY_REGEX_INVALID', 2);
      try {
        const regex = new RegExp(source, 'i');
        ensure(!regex.test(''), 'POLICY_REGEX_INVALID', 2);
        rules.push([id, regex]);
      } catch {
        throw new GateError('POLICY_REGEX_INVALID', 2);
      }
    }
  }
  ensure(input.requiredFiles === undefined || (Array.isArray(input.requiredFiles) && input.requiredFiles.every(safePath)),
    'POLICY_REQUIRED_FILES_INVALID', 2);
  return { rules, requiredFiles: [...new Set([...REQUIRED_RELEASE_FILES, ...(input.requiredFiles ?? [])])] };
}

function privateV4(parts) {
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

function privateV6(candidate) {
  const address = candidate.split('%', 1)[0];
  if (isIP(address) !== 6) return false;
  const normalized = new URL('https://[' + address + ']').hostname.slice(1, -1);
  const words = normalized.split(':');
  const first = Number.parseInt(words[0], 16);
  const compression = ':'.repeat(2);
  if (normalized === compression + '1' || normalized === compression || (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80) return true;
  if (/^:{2}(?:ffff:)?[a-f\d]+:[a-f\d]+$/.test(normalized)) {
    const [ab, cd] = words.slice(-2).map((word) => Number.parseInt(word, 16));
    return privateV4([ab >> 8, ab & 255, cd >> 8, cd & 255]);
  }
  return false;
}

function hasPrivateV4(text) {
  const candidates = text.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g);
  return [...candidates].some(([value]) => {
    const parts = value.split('.').map(Number);
    return parts.every((part) => part <= 255) && privateV4(parts);
  });
}

function hasPrivateV6(text) {
  // Prefer the longest IPv6-shaped candidate so the scan does not interpret a public address's suffix as loopback.
  const candidates = text.matchAll(/(?<![0-9a-z_:%])(?:[0-9a-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?:%[a-z0-9_.-]+)?(?![0-9a-z_:%])/gi);
  return [...candidates].some(({ 0: value, index }) => {
    if (value !== ':'.repeat(2)) return privateV6(value);
    // An unadorned double colon is also source punctuation. Keep address
    // forms used in bracketed addresses, CIDRs and standalone string literals.
    const before = text[index - 1];
    const after = text[index + 2];
    return (before === '[' && after === ']') || after === '/' ||
      ((before === '"' || before === "'" || before === '`') && after === before) || text.trim() === value;
  });
}

// Exact source lines containing standards-defined addresses or separators.
// Only the IP pass uses these exceptions. Policy and credential scans still
// see the original text, and the same address anywhere else is scanned.
const IP_SOURCE_EXAMPLES = new Map([
  ['src/ssrf-filter.js', new Set([
    '6cfa1b556a6b0bc10e58e70b26931076a0ab092de6fb33e7e2ede1924ba95381',
    '3d3e99cbdf378780c4dc128a1bcd2796cd4b27cec87411ea76d5917902ea05cc',
    'af51e5c981154f0b1ec495e7dccd1b406dfc12e1e443ac691c74db1225715ddf',
    '483e003e27667f833cf91addb898f31f368894e7b126a483a3718468db39e6d1',
    '7ee26613bf986c7c24103866e60aeba1bd09c926befe77bef9e6ac120a11200c',
    'a39d40edb96ca4f45229031fa36061af0a242d638b67e4905808bc15f6c28cca',
    '78c5da4bd0a76008e4c6062263688bd20fc22744d73b9f6480bd9993fe9d895c',
    'aea561f13afe5962c4ad30a6df2c4c25b67df8601092a15c315f803591e71281',
    '7a0714853fd3c3d2640238210e79e1f56b40770443360856eaf687b21ee15af1',
    '32459efda8bf8a6778f57e9dc77987b31c7372b70996db3275eef202003fc3c7',
    'faea5d02173b8914bf43bbf3842df14ffc4352481f7962ecf9aca43e86a334a4',
    'ce1fd40a095d7e1bf0921e16033a765b1610ac611169aa3c757b12a4a3ce0ce7',
    'a5844b3e17a45c621f0645f56f630b8098b6b03b9c64004eee9d131864587bbd',
  ])],
  ['src/ui/public/js/sidebar.js', new Set([
    'dd397a08145c551cbcb15a43735916d61423e81e0866acaa78ce6077f5329d8d',
  ])],
  ['src/auth.js', new Set([
    'a8e9c38ea1110ebc0f57add618612e5c4147d34b6ed32d1f4106479a76860ba2',
  ])],
  // Local CLI instructions
  ['src/cli.js', new Set([
    '574685670d94e91ac26d75bb12987d6e79db1c7a461f0d542be0c42ad1ceeeaa',
  ])],
  // Local MCP connection defaults
  ['src/mcp-init-snippets.js', new Set([
    'eb764068ec4ec8308408a0c857104f3e3a0e202440a14c43cb01d74088386ab5',
    'c13c8f76dd0d6f976fb91986a1a2f323413a3f3b4d46cf28d3821ec092b03425',
  ])],
  // Local connection error example
  ['src/orchestrator/cli-interactive-README.md', new Set([
    '11932335111ffc10dcaf16db7a5c575e1630abc5a78da979e36178b909b7a944',
  ])],
  // Built-in SSRF denylist
  ['src/guarded-fetch.js', new Set([
    '75c38907606ae337858d1bad9cfd5f1873840f798fccaf269c4f51be692c5490',
    '62da64753fc0d8e47dcfe350653270f3ea255e2dfd8df6676c821682c502eb50',
  ])],
  // Built-in SSRF defaults
  ['src/ssrf-config-store.js', new Set([
    'a9e220bb67cde92677d0d00e0db859011877a0d3bf176cb3eac11913a02dae2f',
    '86bbdd526311b671da3ca4d6063dd62cc24e94f82b0ac9e81f99217d86beafc4',
    'fdbdde646807be1dfca9d59869284f2ff02bb0b538e1d2ffc7c88582500e2511',
    '7ee5aaa461103a43fc288521467748fb1ec1f4354bd51195cf5cc301e244b628',
    'acf7c1ef915706fb4bf5bcfad2bf69aba51de8a3f0ae1118bc7d695eedc3e0a9',
    '47b4cc4036282ef59928b71d34817aba3482ed28f5ff95faf6783bc30691560f',
    '21deeafd7414864fe103d55fe2a341cbc3c77ab2ffd00fa877ca032e89883de4',
    '86e8d229900b6d718085660038a9cbf75bf9858fc6464e0762151258902ad7a2',
    '89f43765624932d2438624e650f6db106141924e42c9f81b71676b2a76a56bfc',
  ])],
]);

function forbidden(path, directory) {
  const parts = path.toLowerCase().split('/');
  const leaf = parts.at(-1);
  return (directory && FORBIDDEN_DIRS.has(leaf) && path !== 'src/vault') ||
    (parts.includes('vault') && !((path === 'src/vault' || path.startsWith('src/vault/')) &&
      !parts.slice(2).includes('vault'))) ||
    FORBIDDEN_FILES.test(leaf);
}

function finding(ruleId, path, location) {
  return { ruleId, pathSha256: sha256(path), location };
}

function leakFindings(path, bytes, compiled, directory = false) {
  const result = [];
  if (forbidden(path, directory)) result.push(finding(directory ? 'forbidden-directory' : 'forbidden-file', path, 'path'));
  const views = [['path', path]];
  if (bytes) {
    views.push(['content', bytes.toString('utf8')]);
    // Search UTF-16 text as well, including binaries with no BOM.
    if (bytes.includes(0)) {
      views.push(['content', bytes.toString('utf16le')]);
      const even = bytes.length & ~1;
      const swapped = Buffer.from(bytes.subarray(0, even));
      views.push(['content', swapped.swap16().toString('utf16le')]);
    }
  }
  const seen = new Set();
  for (const [location, value] of views) {
    const matches = [...compiled.rules, ...CREDENTIAL_RULES]
      .filter(([, pattern]) => pattern.test(value)).map(([id]) => id);
    const examples = location === 'content' && IP_SOURCE_EXAMPLES.get(path);
    const ipText = examples ? value.split(/\r?\n/).filter(line => !examples.has(sha256(line))).join('\n') : value;
    if (hasPrivateV4(ipText)) matches.push('private-ipv4');
    if (hasPrivateV6(ipText)) matches.push('private-ipv6');
    for (const id of matches) {
      const unique = location + '/' + id;
      if (seen.has(unique)) continue;
      seen.add(unique);
      result.push(finding(id, path, location));
    }
  }
  return result;
}

async function snapshotTree(target, { ignoreInstalledModules = false } = {}) {
  const entries = new Map();
  const violations = [];
  let size = 0;
  const root = await fs.lstat(target);
  ensure(!root.isSymbolicLink(), 'TARGET_SYMLINK_DENIED');
  ensure(root.isDirectory(), 'TARGET_NOT_DIRECTORY', 2);
  const visit = async (base) => {
    const names = (await fs.readdir(join(target, base))).sort(order);
    for (const name of names) {
      const path = base ? base + '/' + name : name;
      if (ignoreInstalledModules && path === 'node_modules') continue;
      if (!safePath(path)) {
        violations.push(finding('invalid-path', path, 'path'));
        continue;
      }
      const file = join(target, path);
      const node = await fs.lstat(file);
      if (node.isSymbolicLink() || (!node.isFile() && !node.isDirectory()) || (node.isFile() && node.nlink !== 1)) {
        violations.push(finding(node.isSymbolicLink() ? 'symlink' : 'special-file', path, 'path'));
        continue;
      }
      const mode = node.mode & 0o777;
      if (node.isDirectory()) {
        entries.set(path, { directory: true, mode });
        await visit(path);
      } else {
        const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          ensure(opened.isFile() && opened.dev === node.dev && opened.ino === node.ino && opened.nlink === 1,
            'TREE_CHANGED_DURING_SCAN');
          ensure(opened.size <= MAX_FILE && size + opened.size <= MAX_TOTAL, 'TREE_SCAN_LIMIT_EXCEEDED');
          const bytes = await handle.readFile();
          ensure(bytes.length === opened.size && (await handle.stat()).mtimeMs === opened.mtimeMs,
            'TREE_CHANGED_DURING_SCAN');
          size += bytes.length;
          entries.set(path, { mode, bytes });
        } finally {
          await handle.close();
        }
      }
    }
  };
  await visit('');
  return { entries, violations };
}

function treeDigest({ entries, violations }) {
  ensure(violations.length === 0, 'TREE_UNSAFE');
  const records = [...entries].sort(([a], [b]) => order(a, b)).map(([path, entry]) =>
    [path, entry.directory ? 'directory' : 'file', entry.mode, entry.directory ? null : sha256(entry.bytes)]);
  return sha256(JSON.stringify(records));
}

function scanSnapshot({ entries, violations }, compiled) {
  return [...violations, ...[...entries].flatMap(([path, entry]) =>
    leakFindings(path, entry.bytes, compiled, entry.directory))];
}

export async function scanTreeForLeaks(target, policy) {
  const compiled = compilePolicy(policy);
  return scanSnapshot(await snapshotTree(resolve(target)), compiled);
}

export async function computeTreeDigest(target) {
  return treeDigest(await snapshotTree(resolve(target)));
}

async function runChild(command, args, { cwd, env, timeout = 60_000, limit = 4 * 1024 * 1024 }) {
  const outputDir = await fs.mkdtemp(join(env.TMPDIR, 'command-'));
  const output = join(outputDir, 'stdout');
  let stdout;
  try {
    stdout = await fs.open(output, 'wx', 0o600);
    const status = await new Promise((resolveChild, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', stdout.fd, 'ignore'], detached: true });
      let failure;
      function stop(code) {
        if (failure) return;
        failure = code;
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      const timer = setTimeout(() => stop('CHILD_TIMEOUT'), timeout);
      const monitor = setInterval(() => {
        void stdout.stat().then(({ size }) => {
          if (size > limit) stop('CHILD_OUTPUT_LIMIT');
        }, () => {});
      }, 50);
      function cleanup() {
        clearTimeout(timer);
        clearInterval(monitor);
      }
      child.once('close', (code) => {
        cleanup();
        if (failure) reject(new GateError(failure));
        else resolveChild(code);
      });
      child.once('error', () => {
        cleanup();
        reject(new GateError('RUNNER_UNAVAILABLE', 2));
      });
    });
    ensure((await stdout.stat()).size <= limit, 'CHILD_OUTPUT_LIMIT');
    return { status, stdout: await fs.readFile(output) };
  } finally {
    await stdout?.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

async function writeSnapshot(entries, target) {
  for (const [path, entry] of entries) {
    if (entry.directory) await fs.mkdir(join(target, path));
    else await fs.writeFile(join(target, path), entry.bytes, { flag: 'wx', mode: entry.mode });
  }
  for (const [path, entry] of [...entries].reverse()) {
    await fs.chmod(join(target, path), entry.mode);
  }
}

function tarString(header, start, end) {
  const field = header.subarray(start, end);
  const zero = field.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(zero < 0 ? field : field.subarray(0, zero));
}

function tarOctal(header, start, end) {
  const text = tarString(header, start, end).trim();
  ensure(/^[0-7]+$/.test(text), 'TAR_HEADER_INVALID');
  return Number.parseInt(text, 8);
}

const ALLOWED_PAX_KEYS = new Set(['path', 'mtime', 'atime', 'ctime']);

function parsePaxRecordsStrict(buf) {
  const records = {};
  let pos = 0;
  ensure(buf.length > 0, 'TAR_PAX_INVALID');
  while (pos < buf.length) {
    const sp = buf.indexOf(0x20, pos);
    ensure(sp > pos, 'TAR_PAX_INVALID');
    const lenStr = buf.subarray(pos, sp).toString('utf8');
    ensure(/^[1-9]\d*$/.test(lenStr), 'TAR_PAX_INVALID');
    const len = Number.parseInt(lenStr, 10);
    ensure(Number.isSafeInteger(len) && pos + len <= buf.length && buf[pos + len - 1] === 0x0a, 'TAR_PAX_INVALID');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(sp + 1, pos + len - 1));
    const eq = body.indexOf('=');
    ensure(eq > 0, 'TAR_PAX_INVALID');
    const k = body.slice(0, eq);
    const v = body.slice(eq + 1);
    ensure(ALLOWED_PAX_KEYS.has(k), 'TAR_PAX_KEY_DENIED');
    ensure(!Object.hasOwn(records, k), 'TAR_PAX_DUPLICATE_KEY');
    if (k === 'path') ensure(v.length > 0 && !v.includes('\0'), 'TAR_PAX_INVALID');
    else ensure(/^\d+(?:\.\d+)?$/.test(v), 'TAR_PAX_INVALID');
    records[k] = v;
    pos += len;
  }
  return records;
}

export function tarEntries(bytes, compiled = null) {
  const zero = Buffer.alloc(512);
  const entries = new Map();
  let offset = 0;
  let nextPaxPath = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.equals(zero)) {
      ensure(nextPaxPath === null, 'TAR_PAX_DANGLING');
      ensure(bytes.length - offset >= 1024 && bytes.subarray(offset).every((byte) => byte === 0),
        'TAR_END_INVALID');
      return entries;
    }
    ensure(tarString(header, 257, 263) === 'ustar', 'TAR_FORMAT_UNSUPPORTED');
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    ensure(checksum === tarOctal(header, 148, 156), 'TAR_CHECKSUM_INVALID');
    const kind = header[156];
    const size = tarOctal(header, 124, 136);
    const start = offset + 512;
    ensure(Number.isSafeInteger(size) && size <= MAX_FILE && start + size <= bytes.length, 'TAR_MEMBER_SIZE_INVALID');
    ensure(kind !== 103, 'TAR_GLOBAL_PAX_UNSUPPORTED');
    if (kind === 120) {
      ensure(nextPaxPath === null, 'TAR_PAX_DUPLICATE');
      const paxBuf = bytes.subarray(start, start + size);
      if (compiled) {
        ensure(leakFindings('pax-extended-header', paxBuf, compiled).length === 0, 'TAR_PAX_LEAK');
      }
      const pax = parsePaxRecordsStrict(paxBuf);
      ensure(typeof pax.path === 'string' && pax.path.length > 0, 'TAR_PAX_INVALID');
      nextPaxPath = pax.path;
      offset = start + Math.ceil(size / 512) * 512;
      continue;
    }
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 500);
    const full = nextPaxPath ?? (prefix ? prefix + '/' + name : name);
    nextPaxPath = null;
    const directory = kind === 53;
    ensure(directory || kind === 48 || kind === 0, 'TAR_MEMBER_TYPE_DENIED');
    const path = full.slice('package/'.length).replace(directory ? /\/$/ : /$^/, '');
    ensure(full.startsWith('package/') && safePath(path) && !entries.has(path), 'TAR_MEMBER_PATH_DENIED');
    ensure(!directory || !size, 'TAR_MEMBER_SIZE_INVALID');
    entries.set(path, directory ? { directory } : { bytes: bytes.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new GateError('TAR_END_INVALID');
}

function memberFindings(path, entry, compiled) {
  const parents = path.split('/').slice(0, -1);
  const result = leakFindings(path, entry.bytes, compiled, entry.directory);
  for (let depth = 1; depth <= parents.length; depth++) {
    const parent = parents.slice(0, depth).join('/');
    if (forbidden(parent, true)) result.push(finding('forbidden-directory', parent, 'path'));
  }
  return result;
}

function dryMembers(summary) {
  const entry = Array.isArray(summary) && summary.length === 1 ? summary[0] : null;
  ensure(Array.isArray(entry?.files) && entry.files.length > 0, 'NPM_PACK_MANIFEST_INVALID');
  const paths = entry.files.map((file) => file.path);
  ensure(paths.every(safePath) && new Set(paths).size === paths.length, 'NPM_PACK_MEMBER_DENIED');
  return paths.sort(order);
}

async function packageCheck({ cwd, scratch, env, snapshot, compiled, digest, summary, check, runOfflineCmd }) {
  const runNpm = (args, runCwd = cwd) => runOfflineCmd('npm', args, { cwd: runCwd, env, timeout: 120_000 });
  const pkgJson = JSON.parse(snapshot.entries.get('package.json')?.bytes?.toString('utf8') || '{}');
  const hasDeps = Object.keys(pkgJson.dependencies || {}).length > 0 || Object.keys(pkgJson.devDependencies || {}).length > 0;
  if (hasDeps) {
    const install = await runNpm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund']);
    ensure(install.status === 0, 'NPM_INSTALL_FAILED');
    ensure(treeDigest(await snapshotTree(cwd, { ignoreInstalledModules: true })) === digest, 'NPM_SOURCE_DRIFT');
  }
  const dry = await runNpm(['pack', '--dry-run', '--json', '--ignore-scripts', '--offline']);
  ensure(dry.status === 0, 'NPM_PACK_DRY_RUN_FAILED');
  let dryPaths;
  try { dryPaths = dryMembers(JSON.parse(dry.stdout)); } catch { throw new GateError('NPM_PACK_MANIFEST_INVALID'); }
  const packed = await runNpm(['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', scratch]);
  ensure(packed.status === 0, 'NPM_PACK_FAILED');
  const archives = (await fs.readdir(scratch)).filter((path) => path.endsWith('.tgz'));
  ensure(archives.length === 1, 'NPM_PACKAGE_ARCHIVE_MISSING');
  const archive = join(scratch, archives[0]);
  const archiveStat = await fs.lstat(archive);
  ensure(archiveStat.isFile() && archiveStat.nlink === 1 && archiveStat.size <= MAX_TOTAL, 'NPM_PACKAGE_ARCHIVE_INVALID');
  summary.tarballSha256 = sha256(await fs.readFile(archive));
  const extracted = await runChild('gzip', ['-dc', '--', archive], { cwd, env, limit: MAX_TOTAL });
  ensure(extracted.status === 0, 'NPM_PACKAGE_ARCHIVE_INVALID');
  const members = tarEntries(extracted.stdout, compiled);
  check.findings = [ ...dryPaths.flatMap((path) => memberFindings(path, {}, compiled)),
    ...[...members].flatMap(([path, entry]) => memberFindings(path, entry, compiled)) ];
  ensure(!check.findings.length, 'PACKAGE_LEAKS');
  const actualPaths = [...members].filter(([, entry]) => !entry.directory).map(([path]) => path).sort(order);
  ensure(JSON.stringify(actualPaths) === JSON.stringify(dryPaths), 'PACKAGE_MANIFEST_DRIFT');
  ensure(RUNTIME_FILES.every((path) => members.get(path)?.bytes), 'PACKAGE_RUNTIME_FILES_MISSING');
  ensure(actualPaths.every((path) => snapshot.entries.get(path)?.bytes?.equals(members.get(path).bytes)), 'PACKAGE_CONTENT_DRIFT');
  ensure(treeDigest(await snapshotTree(cwd, { ignoreInstalledModules: true })) === digest, 'NPM_SOURCE_DRIFT');
  const extractedDir = join(scratch, 'extracted-package');
  await fs.mkdir(extractedDir, { mode: 0o700 });
  for (const [relPath, entry] of members) {
    const abs = join(extractedDir, relPath);
    const snapMode = snapshot.entries.get(relPath)?.mode;
    if (entry.directory) await fs.mkdir(abs, { recursive: true, mode: 0o700 });
    else {
      await fs.mkdir(dirname(abs), { recursive: true, mode: 0o700 });
      const fileMode = snapMode !== undefined ? ((snapMode & 0o777) | 0o600) : 0o600;
      await fs.writeFile(abs, entry.bytes, { flag: 'wx', mode: fileMode });
      if (snapMode !== undefined) await fs.chmod(abs, snapMode & 0o777);
    }
  }
  if (hasDeps) {
    const extInstall = await runNpm(['install', '--ignore-scripts', '--offline', '--omit=dev', '--no-audit', '--no-fund'], extractedDir);
    ensure(extInstall.status === 0, 'EXTRACTED_NPM_INSTALL_FAILED');
    // Because --ignore-scripts intentionally blocks npm lifecycle hooks for supply-chain safety,
    // hydrate ONLY the native better_sqlite3.node binary from the local npm _prebuilds cache (zero scripts executed).
    const bsqlDir = join(extractedDir, 'node_modules', 'better-sqlite3');
    const bsqlPkgPath = join(bsqlDir, 'package.json');
    const bsqlNodePath = join(bsqlDir, 'build', 'Release', 'better_sqlite3.node');
    const hasBsqlPkg = await fs.stat(bsqlPkgPath).then((s) => s.isFile()).catch(() => false);
    const hasBsqlBin = await fs.stat(bsqlNodePath).then((s) => s.isFile()).catch(() => false);
    if (hasBsqlPkg && !hasBsqlBin) {
      const bsqlPkg = JSON.parse(await fs.readFile(bsqlPkgPath, 'utf8'));
      const ver = typeof bsqlPkg?.version === 'string' ? bsqlPkg.version.trim() : '';
      if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ver)) {
        const prebuildSuffix = `-better-sqlite3-v${ver}-node-v${process.versions.modules}-${process.platform}-${process.arch}.tar.gz`;
        const cacheRoots = [
          env.npm_config_cache || process.env.npm_config_cache,
          join(homedir(), '.npm'),
        ].filter(Boolean);
        let prebuildTar = null;
        for (const root of cacheRoots) {
          const preDir = join(root, '_prebuilds');
          const files = await fs.readdir(preDir).catch(() => []);
          const match = files.find((f) => f.endsWith(prebuildSuffix));
          if (match) {
            prebuildTar = join(preDir, match);
            break;
          }
        }
        if (prebuildTar) {
          const bin = await runChild('tar', ['-xzOf', prebuildTar, 'build/Release/better_sqlite3.node'], { cwd: extractedDir, env, limit: MAX_FILE });
          if (bin.status === 0 && bin.stdout.length > 0) {
            await fs.mkdir(dirname(bsqlNodePath), { recursive: true, mode: 0o700 });
            await fs.writeFile(bsqlNodePath, bin.stdout, { flag: 'wx', mode: 0o555 });
          }
        }
      }
    }
  }
  // Strip ONLY write bits (& ~0o222) across extractedDir INCLUDING node_modules, preserving +x bits and skipping symlinks!
  const stripWriteBits = async (dir) => {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      const p = join(dir, d.name);
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await stripWriteBits(p);
        await fs.chmod(p, (st.mode & 0o777) & ~0o222);
      } else if (st.isFile()) {
        await fs.chmod(p, (st.mode & 0o777) & ~0o222);
      }
    }
  };
  const hashTreeFull = async (rootDir) => {
    const h = createHash('sha256');
    const walk = async (cur, relPrefix) => {
      const names = (await fs.readdir(cur)).sort(order);
      for (const name of names) {
        const rel = relPrefix ? relPrefix + '/' + name : name;
        const abs = join(cur, name);
        const st = await fs.lstat(abs);
        if (st.isSymbolicLink()) {
          h.update(`L\0${rel}\0${await fs.readlink(abs)}\0`);
        } else if (st.isDirectory()) {
          h.update(`D\0${rel}\0${st.mode & 0o777}\0`);
          await walk(abs, rel);
        } else if (st.isFile()) {
          const digestHex = sha256(await fs.readFile(abs));
          h.update(`F\0${rel}\0${st.mode & 0o777}\0${digestHex}\0`);
        }
      }
    };
    await walk(rootDir, '');
    return h.digest('hex');
  };
  await stripWriteBits(extractedDir);
  await fs.chmod(extractedDir, 0o555);
  const extractedDigest = await hashTreeFull(extractedDir);
  return { extractedDir, extractedDigest, stripWriteBits, hashTreeFull };
}

function passedTestNames(report) {
  return [...report.matchAll(/^\s*ok \d+ - (.+)$/gm)].map(([, name]) => name.trim());
}

const RENDER_DEFAULTS = `
import { LOOP_TEMPLATES, createTemplateRegistries, createMemoryTemplateIdempotencyStore,
  instantiateLoopFromTemplate, validateTemplateParams } from './src/templates/loop-templates.js';
if (!Array.isArray(LOOP_TEMPLATES) || LOOP_TEMPLATES.length !== 4) process.exit(1);
const rendered = [];
for (const template of LOOP_TEMPLATES) {
  const defaults = template.defaults;
  if (!validateTemplateParams(template, defaults).valid) process.exit(1);
  const result = await instantiateLoopFromTemplate({
    templateId: template.id, templateVersion: template.version, projectId: 'example-project',
    name: template.title, params: defaults, requestId: template.id,
    rosterSpec: {
      projectId: 'example-project', prIds: [defaults.prId], suiteIds: [defaults.suiteId],
      childProjectIds: defaults.childProjectIds, operationIds: [defaults.operationId],
      workItemIds: [defaults.workItemId], targets: [defaults.target],
      agents: template.rosterSpec.roles.map((role, index) => ({ role, id: role, provider: 'provider-' + index })),
      registries: createTemplateRegistries({ operations: {
        'capture-pr-source@1': () => {}, 'read-verified-health@1': () => {},
      } }),
    },
    idempotencyStore: createMemoryTemplateIdempotencyStore(),
    publishLoop: ({ manifest }) => ({ manifest }),
  });
  if (result.statusCode !== 201 || result.loop.scheduleEnabled !== false) process.exit(1);
  rendered.push(result.loop.manifest);
}
process.stdout.write(JSON.stringify(rendered));
`;

const TRUSTED_PACKAGE_BEHAVIOR = `
import assert from 'node:assert/strict';
import { verifyGitHubWebhookSignature, renderPublicGitHubEvidence } from './src/orchestrator/github-bridge.js';
import { LOOP_TEMPLATES, listLoopTemplates, validateTemplateParams, createTemplateRegistries,
  createMemoryTemplateIdempotencyStore, instantiateLoopFromTemplate, evaluateTemplateAnchor } from './src/templates/loop-templates.js';

assert.equal(listLoopTemplates().length, 4);
assert.equal(LOOP_TEMPLATES.every((t) => t.manifest.scheduleEnabled === false), true);
const badParam = validateTemplateParams(LOOP_TEMPLATES[0], { prId: 'pr-1', unknownKey: 1 });
assert.equal(badParam.valid, false);
assert.throws(() => verifyGitHubWebhookSignature({
  rawBody: Buffer.from('{"ok":true}'),
  rawHeaders: ['x-hub-signature-256', 'sha256=' + '0'.repeat(64), 'x-github-delivery', 'd-1', 'x-github-event', 'ping', 'x-github-hook-id', '1'],
  secret: 'secret-val',
}));
assert.throws(() => renderPublicGitHubEvidence({
  runId: 'ghp_' + 'a'.repeat(30),
  approvedSourceSha: 'a'.repeat(40),
  evidencePacketSha256: 'b'.repeat(64),
  checksumManifestSha256: 'c'.repeat(64),
  assertionCount: 2,
  anchorCount: 1,
}));
const scopedFail = await instantiateLoopFromTemplate({
  templateId: 'multi-model-pr-review-council',
  projectId: 'proj-a',
  name: 'Bad Scope',
  params: { prId: 'pr-unauthorized' },
  requestId: 'req-gate-1',
  rosterSpec: { projectId: 'proj-a', prIds: ['pr-allowed'], agents: [
    { id: 'a', role: 'author', provider: 'p1' }, { id: 'b', role: 'reviewer', provider: 'p2' },
  ], registries: createTemplateRegistries({ operations: { 'capture-pr-source@1': async () => ({}) } }) },
  idempotencyStore: createMemoryTemplateIdempotencyStore(),
  publishLoop: async ({ manifest }) => ({ loopId: manifest.loopId, loopVersion: 1, manifest }),
});
assert.equal(scopedFail.statusCode, 422);
const forgedAnchor = evaluateTemplateAnchor('verify-pr-source@1', {
  expectedSha: 'a'.repeat(40), subjectSha: 'b'.repeat(40),
}, { verifySubject: () => true });
assert.equal(forgedAnchor.assertions.every((a) => a.passed), false);
process.stdout.write('TRUSTED_BEHAVIOR_OK');
`;

export async function runReleaseGate({ target, policyPath, skipNpm = false, allowHostFallback = false } = {}) {
  const summary = {
    exitCode: 0, treeSha256: null, tarballSha256: null,
    checks: Object.fromEntries(CHECKS.map((id) => [id, { status: 'not_run' }])),
  };
  let active = 'tree';
  let scratch;
  const check = (id) => {
    active = id;
    return summary.checks[id];
  };
  const pass = () => { summary.checks[active].status = 'passed'; };

  try {
    ensure(typeof target === 'string' && target && typeof policyPath === 'string' && policyPath,
      'TARGET_AND_POLICY_REQUIRED', 2);
    target = resolve(target);
    policyPath = resolve(policyPath);
    let policy;
    try {
      const actualPolicy = await fs.realpath(policyPath);
      const actualTarget = await fs.realpath(target);
      const within = relative(actualTarget, actualPolicy);
      ensure(within.startsWith('../'), 'POLICY_MUST_BE_EXTERNAL', 2);
      policy = JSON.parse(await fs.readFile(actualPolicy, 'utf8'));
    } catch (error) {
      throw error instanceof GateError ? error : new GateError('TARGET_OR_POLICY_UNAVAILABLE', 2);
    }
    const compiled = compilePolicy(policy);
    const snapshot = await snapshotTree(target);
    const tree = check('tree');
    tree.findings = snapshot.violations;
    ensure(!tree.findings.length, 'TREE_UNSAFE');
    summary.treeSha256 = treeDigest(snapshot);
    pass();

    const leaks = check('leaks');
    leaks.findings = scanSnapshot(snapshot, compiled);
    ensure(!leaks.findings.length, 'TREE_LEAKS');
    pass();

    const required = check('requiredFiles');
    required.missing = compiled.requiredFiles.filter((path) => !snapshot.entries.get(path)?.bytes).map(sha256);
    ensure(!required.missing.length, 'REQUIRED_FILES_MISSING');
    pass();

    scratch = await fs.mkdtemp(join(tmpdir(), 'synapse-release-gate-'));
    const cwd = join(scratch, 'candidate');
    const projectDir = join(scratch, 'empty-project');
    const home = join(scratch, 'home');
    await Promise.all([fs.mkdir(cwd), fs.mkdir(projectDir), fs.mkdir(home)]);
    await writeSnapshot(snapshot.entries, cwd);
    const runnerTmp = join(scratch, 'runner-tmp');
    await fs.mkdir(runnerTmp, { mode: 0o700 });
    const npmCache = process.env.npm_config_cache || (process.env.HOME ? join(process.env.HOME, '.npm') : join(home, '.npm'));
    const baseEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', NO_COLOR: '1' };
    const env = { ...baseEnv, HOME: home,
      TMPDIR: scratch, npm_config_cache: npmCache,
      npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'global-npmrc') };
    // Nested gate fixtures need npm's writable cache even for offline dry-run packs.
    // With the package-phase npm config omitted, they default to runnerTmp/.npm.
    const runnerEnv = { ...baseEnv, TMPDIR: runnerTmp, HOME: runnerTmp };
    let unshareFlags = ['--user', '--map-root-user', '--net'];
    const runOfflineCmd = (cmd, args, options = {}) => runChild('unshare',
      [...unshareFlags, '--', cmd, ...args],
      { cwd, env, ...options });
    const runOffline = (args, options = {}) => runOfflineCmd(process.execPath, args, options);

    // Probe offline network-namespace isolation BEFORE running ANY npm or candidate code.
    check('package');
    ensure(!skipNpm, 'PACKAGE_CHECK_REQUIRED', 2);
    let isolated = null;
    for (const flags of [['--user', '--map-root-user', '--net'], ['--user', '--net']]) {
      unshareFlags = flags;
      try {
        const probe = await runOffline(['-e', ''], { timeout: 5000 });
        if (probe.status === 0) { isolated = probe; break; }
      } catch { /* try next network-namespace unshare invocation */ }
    }
    ensure(isolated && isolated.status === 0, 'OFFLINE_RUNNER_UNAVAILABLE', 2);

    // Strict read-only permission profile for pure-Node phases: NO --allow-child-process, NO --allow-worker!
    const strictRoPermFlags = [
      process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission',
      '--allow-fs-read=*',
      `--allow-fs-write=${runnerTmp}`,
      `--allow-fs-write=${projectDir}`,
    ];
    // Test-runner profile (for RELEASE_TEST_FILES that spawn node/git and load native SQLite addons): NO --allow-worker; paired with kernel bwrap EROFS when available and per-file full-tree digest verification
    const suiteRoPermFlags = [
      ...strictRoPermFlags,
      '--allow-child-process',
      ...(process.allowedNodeEnvironmentFlags.has('--allow-addons') ? ['--allow-addons'] : []),
    ];
    const suiteRunnerEnv = { ...runnerEnv, SYNAPSE_PROJECT_DIR: projectDir };

    // FD-based race-free directory unlock helper (NEVER calls pathname chmod; refuses symlinks via O_NOFOLLOW!)
    const unlockDirTreeFd = (rootPath, unlinkSymlinks = false) => {
      const walkFd = (dirFd) => {
        try { fchmodSync(dirFd, 0o700); } catch {}
        let items = [];
        try { items = readdirSync(`/proc/self/fd/${dirFd}`); } catch { return; }
        for (const name of items) {
          const childPath = `/proc/self/fd/${dirFd}/${name}`;
          let st;
          try { st = lstatSync(childPath); } catch { continue; }
          if (st.isSymbolicLink()) {
            if (unlinkSymlinks) { try { unlinkSync(childPath); } catch {} }
          } else if (st.isDirectory()) {
            let subFd = -1;
            try {
              subFd = openSync(childPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
              walkFd(subFd);
            } catch { /* ignore raced/non-dir */ } finally {
              if (subFd >= 0) try { closeSync(subFd); } catch {}
            }
          }
        }
      };
      let rootFd = -1;
      try {
        rootFd = openSync(rootPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        walkFd(rootFd);
      } catch { /* ignore */ } finally {
        if (rootFd >= 0) try { closeSync(rootFd); } catch {}
      }
    };

    // Active permission enforcement probe against an expendable canary file outside runnerTmp/projectDir (NEVER touches cwd/package.json!)
    const permProbeCanary = join(scratch, 'perm-probe-canary.txt');
    await fs.writeFile(permProbeCanary, 'canary\n', { mode: 0o400 });
    const activePermProbe = `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const assert = require('node:assert/strict');
      assert.throws(() => fs.writeFileSync(${JSON.stringify(permProbeCanary)}, 'x'), { code: 'ERR_ACCESS_DENIED' });
      assert.throws(() => fs.chmodSync(${JSON.stringify(permProbeCanary)}, 0o600), { code: 'ERR_ACCESS_DENIED' });
      assert.throws(() => cp.execFileSync(process.execPath, ['-e', '']), { code: 'ERR_ACCESS_DENIED' });
      process.stdout.write('PERM_ENFORCED_OK');
    `;
    const permProbe = await runOffline([...strictRoPermFlags, '-e', activePermProbe], { timeout: 5000, env: runnerEnv });
    ensure(permProbe.status === 0 && permProbe.stdout.toString('utf8').includes('PERM_ENFORCED_OK'), 'READONLY_PERMISSION_MODEL_UNAVAILABLE', 2);

    const runOfflineStrictRO = (args, options = {}) => runOffline([...strictRoPermFlags, ...args], { env: runnerEnv, ...options });

    const { extractedDir, extractedDigest, stripWriteBits, hashTreeFull } = await packageCheck({
      cwd, scratch, env, snapshot, compiled, digest: summary.treeSha256, summary, check: summary.checks.package, runOfflineCmd,
    });
    pass();

    // Run ALL pure-Node strict-RO phases FIRST against immutable extractedDir (ZERO child_process, ZERO worker!)
    check('smokeImport');
    const smoke = await runOfflineStrictRO(['src/orchestrator.js'], {
      cwd: extractedDir,
      timeout: 15_000, env: { ...runnerEnv, SYNAPSE_SMOKE_IMPORT: '1', SYNAPSE_PROJECT_DIR: projectDir },
    });
    ensure(smoke.status === 0, 'SMOKE_IMPORT_FAILED');
    pass();

    check('behavioral');
    // 1. Run gate-owned trusted behavioral assertions with ZERO child-process / worker access against IMMUTABLE extractedDir!
    const trustedRes = await runOfflineStrictRO(['--input-type=module', '-e', TRUSTED_PACKAGE_BEHAVIOR], { cwd: extractedDir, timeout: 20_000 });
    ensure(trustedRes.status === 0 && trustedRes.stdout.toString('utf8').includes('TRUSTED_BEHAVIOR_OK'), 'TRUSTED_BEHAVIORAL_ASSERTION_FAILED');
    ensure((await hashTreeFull(extractedDir)) === extractedDigest, 'TREE_DRIFT');

    // 2. Always materialize a SEPARATE immutable suiteCwd copy (never shares extractedDir; handles partial tests without EACCES)
    const suiteCwd = join(scratch, 'extracted-suite');
    await fs.cp(extractedDir, suiteCwd, { recursive: true, verbatimSymlinks: true });
    unlockDirTreeFd(suiteCwd, false);
    for (const f of RELEASE_TEST_FILES) {
      const entry = snapshot.entries.get(f);
      ensure(entry?.bytes, 'REQUIRED_FILES_MISSING');
      const dest = join(suiteCwd, f);
      let alreadyPresent = false;
      try {
        const existingStat = await fs.lstat(dest);
        ensure(existingStat.isFile(), 'PACKAGE_CONTENT_DRIFT');
        ensure((await fs.readFile(dest)).equals(entry.bytes), 'PACKAGE_CONTENT_DRIFT');
        alreadyPresent = true;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      if (!alreadyPresent) {
        await fs.mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await fs.writeFile(dest, entry.bytes, { mode: (entry.mode & 0o777) & ~0o222 });
      }
    }
    await stripWriteBits(suiteCwd);
    await fs.chmod(suiteCwd, 0o555);
    const suiteDigest = await hashTreeFull(suiteCwd);

    // Probe kernel read-only bind-mount via bwrap with active chmod-denial proof (EROFS across all subprocesses when kernel allows it)
    let useBwrapRo = false;
    try {
      const bwrapProbe = await runChild('bwrap', [
        '--ro-bind', '/', '/',
        '--bind', runnerTmp, runnerTmp,
        '--bind', projectDir, projectDir,
        '--ro-bind', suiteCwd, suiteCwd,
        '--dev', '/dev', '--proc', '/proc',
        '--unshare-net', '--', '/bin/sh', '-c', `chmod u+w "${join(suiteCwd, 'package.json')}" 2>/dev/null && exit 1 || exit 0`,
      ], { cwd: suiteCwd, env: suiteRunnerEnv, timeout: 5000 });
      if (bwrapProbe.status === 0) useBwrapRo = true;
    } catch { /* probe failed */ }
    // P1 #1: Fail closed in default CLI/gate mode unless kernel read-only bind-mount (bwrap --ro-bind) is active!
    ensure(useBwrapRo || allowHostFallback === true, 'RO_ISOLATION_UNAVAILABLE', 2);

    const runSuiteTest = (args, options = {}) => {
      if (useBwrapRo) {
        return runChild('bwrap', [
          '--ro-bind', '/', '/',
          '--bind', runnerTmp, runnerTmp,
          '--bind', projectDir, projectDir,
          '--ro-bind', suiteCwd, suiteCwd,
          '--dev', '/dev', '--proc', '/proc',
          '--unshare-net', '--', process.execPath, ...suiteRoPermFlags, ...args,
        ], { cwd: suiteCwd, env: suiteRunnerEnv, ...options });
      }
      return runOffline([...suiteRoPermFlags, ...args], { cwd: suiteCwd, env: suiteRunnerEnv, ...options });
    };

    for (const file of RELEASE_TEST_FILES) {
      const tests = await runSuiteTest(['--test', '--test-reporter=tap', file], { timeout: 90_000 });
      const report = tests.stdout.toString('utf8');
      const names = passedTestNames(report);
      ensure(tests.status === 0 && names.some((name) => name !== file && name !== join(suiteCwd, file)) &&
        /^# pass [1-9]\d*$/m.test(report) &&
        !/^# (?:skipped|todo) [1-9]\d*$/m.test(report) && !/^\s*(?:not )?ok .+ # (?:SKIP|TODO)\b/im.test(report),
      'BEHAVIORAL_TESTS_FAILED');
      if (file === RELEASE_TEST_FILES[0]) {
        ensure(RELEASE_TEST_NAMES.every((name) => names.includes(name)), 'REQUIRED_BEHAVIORAL_ASSERTION_MISSING');
      }
      // Verify FULL suiteCwd tree (including node_modules) immediately after every test file!
      ensure((await hashTreeFull(suiteCwd)) === suiteDigest && (await hashTreeFull(extractedDir)) === extractedDigest, 'TREE_DRIFT');
    }
    pass();

    const defaults = check('templateDefaults');
    const rendered = await runOfflineStrictRO(['--input-type=module', '-e', RENDER_DEFAULTS], { cwd: extractedDir, timeout: 15_000 });
    ensure(rendered.status === 0, 'TEMPLATE_DEFAULTS_INVALID');
    try {
      const manifests = JSON.parse(rendered.stdout);
      ensure(Array.isArray(manifests) && manifests.length === 4, 'TEMPLATE_DEFAULTS_INVALID');
    } catch { throw new GateError('TEMPLATE_DEFAULTS_INVALID'); }
    defaults.findings = leakFindings('rendered-template-defaults', rendered.stdout, compiled);
    ensure(!defaults.findings.length, 'TEMPLATE_DEFAULTS_LEAKS');
    pass();

    check('treeUnchanged');
    ensure((await hashTreeFull(extractedDir)) === extractedDigest &&
      (await hashTreeFull(suiteCwd)) === suiteDigest &&
      treeDigest(await snapshotTree(cwd, { ignoreInstalledModules: true })) === summary.treeSha256 &&
      await computeTreeDigest(target) === summary.treeSha256, 'TREE_DRIFT');
    pass();
  } catch (error) {
    summary.exitCode = error instanceof GateError ? error.exitCode : scratch ? 1 : 2;
    Object.assign(summary.checks[active], { status: 'failed',
      code: error instanceof GateError ? error.code : 'GATE_IO_OR_FORMAT_ERROR' });
  } finally {
    if (scratch) {
      try {
        // 100% FD-anchored recursive removal (zero pathname chmod/rimraf; symlinks unlinked directly without ever descending!)
        const removeDirFd = (dirFd) => {
          fchmodSync(dirFd, 0o700);
          const items = readdirSync(`/proc/self/fd/${dirFd}`);
          for (const name of items) {
            const childPath = `/proc/self/fd/${dirFd}/${name}`;
            let st;
            try { st = lstatSync(childPath); } catch (err) {
              if (err?.code === 'ENOENT') continue;
              throw err;
            }
            if (st.isDirectory()) {
              let subFd = -1;
              try {
                subFd = openSync(childPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
                removeDirFd(subFd);
              } finally {
                if (subFd >= 0) try { closeSync(subFd); } catch {}
              }
              rmdirSync(childPath);
            } else {
              unlinkSync(childPath);
            }
          }
        };
        let rootScratchFd = -1;
        try {
          rootScratchFd = openSync(scratch, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
          removeDirFd(rootScratchFd);
        } finally {
          if (rootScratchFd >= 0) try { closeSync(rootScratchFd); } catch {}
        }
        rmdirSync(scratch);
      }
      catch {
        summary.exitCode ||= 2;
        summary.checks.treeUnchanged = { status: 'failed', code: 'SCRATCH_CLEANUP_FAILED' };
      }
    }
  }
  return summary;
}

function parseArgs(args) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) return null;
    seen.add(arg);
    if (arg === '--json') options.json = true;
    else if (arg === '--target' || arg === '--policy') {
      const value = args[++index];
      if (!value || value.startsWith('--')) return null;
      options[arg === '--target' ? 'target' : 'policyPath'] = value;
    } else return null;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = parseArgs(args);
  const summary = options ? await runReleaseGate(options) :
    { exitCode: 2, treeSha256: null, tarballSha256: null, checks: { usage: { status: 'failed', code: 'INVALID_ARGUMENTS' } } };
  if (args.includes('--json')) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  else if (summary.exitCode === 2) {
    process.stderr.write('Usage: node scripts/release-gate.mjs --target <dir> --policy <path> [--json]\n');
    for (const [id, result] of Object.entries(summary.checks)) {
      if (result.code) process.stderr.write(id + ' ' + result.code + '\n');
    }
  } else {
    for (const [id, result] of Object.entries(summary.checks)) {
      process.stdout.write(id + ' ' + result.status + (result.code ? ' ' + result.code : '') + '\n');
    }
    if (summary.treeSha256) process.stdout.write('treeSha256 ' + summary.treeSha256 + '\n');
    if (summary.tarballSha256) process.stdout.write('tarballSha256 ' + summary.tarballSha256 + '\n');
  }
  process.exitCode = summary.exitCode;
}
