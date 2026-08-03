#!/usr/bin/env node

import { createInterface } from 'readline';
import { writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir, userInfo } from 'os';
import { randomBytes } from 'crypto';
import { detectAllHarnesses } from './harnesses/registry.js';
import { PROVIDER_DEFAULT_MODELS } from './model-defaults.js';
import { fileURLToPath } from 'node:url';
import { dirname, join as pathJoin } from 'node:path';

const rl = createInterface({ input: process.stdin, output: process.stdout });

let stdinClosed = false;

function prompt(q) {
  return new Promise((res) => {
    if (stdinClosed || rl.closed) { res(''); return; }
    const timeout = setTimeout(() => { res(''); }, 5000);
    rl.question(q, (answer) => { clearTimeout(timeout); res(answer || ''); });
  });
}

rl.on('close', () => { stdinClosed = true; });
process.stdin.on('end', () => { stdinClosed = true; });

const PROVIDER_COLORS = {
  claude: '#d97706',
  codex: '#10a37f',
  gemini: '#4285f4',
  ollama: '#ff6b35',
  glm: '#1565c0',
  pi: '#8e44ad',
  omp: '#6c3483',
};

const PROVIDER_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  // 'ollama' is the legacy internal key for any local OpenAI-compatible
  // server (Ollama daemon, llama.cpp llama-server, vLLM, LM Studio…).
  // The connection is plain OpenAI /v1 — don't present it as Ollama-only.
  ollama: 'OpenAI-compatible (Ollama, llama.cpp, vLLM…)',
  glm: 'GLM',
  pi: 'Pi',
  omp: 'oh-my-pi (Pi + orchestrator extension)',
};

// Single shared table (src/model-defaults.js) — also feeds
// config.agents.defaults and the onboarding offers. Two hand-maintained
// copies drifted (stale gpt-5.3-codex failed first dispatch); never fork it.
const DEFAULT_MODELS = PROVIDER_DEFAULT_MODELS;

// Model lists refreshed 2026-08-01 — every non-gemini entry is live-probed
// (staging harness parity check) or running in production; gemini entries are
// unverifiable in this lab (paid-tier CLI wall) and mirror the current lineup.
const PROVIDER_MODELS = {
  claude: ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
  gemini: ['gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'],
  ollama: [],
  glm: ['zai-coding-plan/glm-5.2', 'zai-coding-plan/glm-5-turbo', 'glm-5.1'],
  pi: [],  // free-form: BYOK, model list depends on the user's configured providers
  omp: [], // same binary as pi; extension changes behavior, not the model surface
};

const ROLE_SKILLS = {
  architect: ['architecture', 'design', 'plan', 'decompose', 'review'],
  developer: ['code', 'implement', 'fix', 'build', 'debug', 'test'],
  reviewer: ['review', 'audit', 'security', 'test', 'validate'],
};

function getOllamaModels() {
  try {
    const raw = execSync('ollama list 2>/dev/null', { encoding: 'utf-8' });
    return raw.split('\n').slice(1).filter(l => l.trim()).map(l => l.split(/\s+/)[0]);
  } catch { return []; }
}

async function askInput(question, defaultVal = '') {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  const answer = await prompt(`  ${question}${suffix}: `);
  return answer.trim() || defaultVal;
}

async function askYesNo(question, defaultYes = false) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await prompt(`  ${question} (${hint}): `);
  const cleaned = answer.trim().toLowerCase();
  if (cleaned === '') return defaultYes;
  return cleaned === 'y' || cleaned === 'yes';
}

async function askSelect(question, options, defaultIdx = 0) {
  console.log(`  ${question}`);
  options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt.label}`));
  const answer = await prompt(`  Select [${defaultIdx + 1}]: `);
  const idx = answer.trim() === '' ? defaultIdx : parseInt(answer.trim()) - 1;
  if (idx >= 0 && idx < options.length) return options[idx].value;
  return options[defaultIdx].value;
}

function buildAgentConfig(id, name, provider, model, role, endpoint = null) {
  const agent = {
    id,
    name,
    provider,
    model,
    color: PROVIDER_COLORS[provider] || '#6b7280',
    role,
    status: 'active',
    permissions: [],
    skills: ROLE_SKILLS[role] || ROLE_SKILLS.developer,
  };
  if (endpoint) agent.endpoint = endpoint;
  return agent;
}

function hasHelpFlag(args) {
  return args.some(a => a === '--help' || a === '-h');
}

async function wizard(cwd) {
  if (hasHelpFlag(process.argv.slice(3))) {
    console.log(`
Usage: synapse init

  Interactive first-run setup. Creates .env and .synapse/ in the current
  directory and registers your operator identity.

What it asks:
  - Operator name (your identity in the UI)
  - Admin password (defaults to "synapse" — change for non-localhost)
  - MCP tools (optional filesystem server)

Files created:
  ./.env                    Server config (port, password, MCP)
  ./.synapse/agents.json    Empty agent registry — add agents in the UI

Re-running init on an already-configured directory prompts before
overwriting. To run non-interactively, see the upcoming flag-driven
init mode (planned post-beta).
`);
    process.exit(0);
  }
  console.log(`
╔═════════════════════════════════════════════════════════╗
║            Synapse Init — First Run Setup               ║
║                                                         ║
║  Synapse is a project-oriented multi-agent orchestrator.║
║  This wizard sets up the server. Agents are registered  ║
║  through the web UI after startup.                      ║
╚═════════════════════════════════════════════════════════╝
`);

  const envPath = join(cwd, '.env');
  const synapseDir = join(cwd, '.synapse');
  const agentsPath = join(synapseDir, 'agents.json');

  if (existsSync(envPath) && existsSync(agentsPath)) {
    const overwrite = await askYesNo('Found existing configuration. Reinitialize?', false);
    if (!overwrite) {
      console.log('\nAborted.');
      rl.close();
      return;
    }
  }

  // ── Step 1: Identity ──
  console.log('Step 1/4: Identity\n');
  const operatorName = await askInput('Your name (used as operator identity)', 'operator');

  // ── Step 2: Server ──
  console.log('\nStep 2/4: Server\n');
  const port = await askInput('Port', '8080');

  console.log('  Admin password — used to log into the web UI.');
  console.log('  Default is "synapse" (easy for first-run review on a trusted network).');
  console.log('  Type "random" for a secure 32-char password, or type your own.\n');
  let password;
  const pwInput = await askInput('Password', 'synapse');
  if (pwInput === 'random') {
    password = randomBytes(16).toString('hex');
    console.log(`  Generated password: ${password}`);
    console.log('  (Save this — it won\'t be shown again.)');
  } else if (pwInput === 'synapse') {
    password = 'synapse';
    console.log('  Using default password "synapse". Change it before exposing the server beyond localhost.');
  } else {
    const confirm = await askInput('Confirm password', '');
    if (confirm !== pwInput) {
      console.log('\n  Passwords did not match. Aborting.');
      rl.close();
      return;
    }
    password = pwInput;
  }

  // ── Step 3: MCP Tools ──
  console.log('\nStep 3/4: MCP Tools\n');
  const mcpEnabled = await askYesNo('Enable default MCP filesystem tools for agents?', true);

  // ── Step 4: Installed harnesses (read-only scan) ──
  console.log('\nStep 4/4: Installed harnesses\n');
  console.log('  Synapse does not install harnesses. This scan just shows what\'s');
  console.log('  available on this system. You\'ll build agents in the web UI after');
  console.log('  starting the server.\n');

  const detections = detectAllHarnesses();
  for (const d of detections) {
    if (d.found) {
      console.log(`  ✓ ${d.id.padEnd(14)} ${d.path}`);
    } else {
      console.log(`  ✗ ${d.id.padEnd(14)} not found`);
    }
  }

  const anyDetected = detections.some(d => d.found);
  if (!anyDetected) {
    console.log('\n  No harnesses detected. Install one (claude-code, codex, opencode,');
    console.log('  gemini-cli, aider, etc.) using the vendor\'s own installation docs,');
    console.log('  then run `synapse init` again or add the agent from the web UI.');
  }

  // ── Generate config ──
  console.log('\n── Generating configuration ──\n');

  mkdirSync(synapseDir, { recursive: true });

  const envLines = [
    `SYNAPSE_OPERATOR_NAME=${operatorName}`,
    `SYNAPSE_PASSWORD=${password}`,
    `NODE_ENV=production`,
    `SYNAPSE_SERVER_PORT=${port}`,
  ];

  if (mcpEnabled) {
    envLines.push(`SYNAPSE_MCP_ENABLED=true`);
    // Write the concrete project dir into the MCP server config instead of a
    // shell-style `${SYNAPSE_PROJECT_DIR}` placeholder. Synapse doesn't run a
    // shell on this string before parsing the JSON, so a literal ${VAR}
    // reaches the filesystem-server's args list and the npx invocation fails
    // with `MCP error -32000` / `Failed to connect` every reconnect cycle.
    // The wizard already knows cwd; pinning the absolute path here makes the
    // config concrete, debuggable, and survives env-var changes later.
    // Scope the filesystem MCP root to <cwd>/workspace, NOT cwd. cwd is the
    // Synapse base dir which contains the `.synapse/` control plane; rooting
    // the fs server there would let an agent read/write/delete Synapse's own
    // config/state via an absolute path (the Iter4 self-destruct class, by a
    // different vector than cwd-containment). `<cwd>/workspace` is the parent
    // of every contained per-project workspace (<base>/workspace/<id>) and a
    // SIBLING of `.synapse/`, so the fs server structurally cannot reach the
    // control plane. Created here so the server has a valid root before the
    // first project (and thus first workspace subdir) exists.
    const mcpRoot = join(cwd, 'workspace');
    mkdirSync(mcpRoot, { recursive: true });
    const mcpServers = [{
      id: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', mcpRoot],
    }];
    envLines.push(`SYNAPSE_MCP_SERVERS=${JSON.stringify(mcpServers)}`);
  }

  writeFileSync(envPath, envLines.join('\n') + '\n');
  console.log('  Created .env');

  // Empty agents.json — user builds agents in the UI after startup.
  const agentConfig = {
    agents: [],
    roles: {
      architect: { description: 'Designs systems, decomposes work, reviews architecture' },
      developer: { description: 'Implements code, fixes bugs, builds features' },
      reviewer: { description: 'Reviews code, audits security, validates quality' },
    },
    onboarding: { completed: true, completedAt: new Date().toISOString() },
  };

  writeFileSync(agentsPath, JSON.stringify(agentConfig, null, 2) + '\n');
  console.log('  Created .synapse/agents.json (0 agents — add them in the web UI)');

  mkdirSync(join(synapseDir, 'logs'), { recursive: true });
  console.log('  (A default starter project will be created on first server startup.)');

  // Setup-complete banner. Each content row pads its value so the closing ║
  // lands at the same column (total inner width = 57). The label widths vary
  // (URL has the longest prefix), so per-row padding lengths differ.
  const W = 57; // inner content width (chars between the two ║)
  const row = (label, value) => `║${(label + value).padEnd(W)}║`;
  console.log(`
╔═════════════════════════════════════════════════════════╗
║                  Setup Complete                         ║
║                                                         ║
${row('  Operator:  ', operatorName)}
${row('  URL:       ', `http://localhost:${port}`)}
${row('  Password:  ', password)}
${row('  Tools:     ', mcpEnabled ? 'Filesystem (MCP)' : 'none')}
║                                                         ║
║  Next steps:                                            ║
║    1. synapse start                                     ║
${row('    2. Open  ', `http://localhost:${port}`)}
║    3. Click "+ Add Agent" in the header                 ║
║                                                         ║
╚═════════════════════════════════════════════════════════╝
`);

  rl.close();
}

async function agentAdd(cwd) {
  console.log('\n── Add Agent ──\n');
  console.log('  BYOH: Install and authenticate the CLI yourself.');
  console.log('  Synapse will use whatever your CLI is already logged into.\n');

  // pi appended last: harness parity with src/harnesses/registry.js (launch
  // default), and stable indices for anything driving this wizard via stdin.
  const providers = ['claude', 'codex', 'gemini', 'ollama', 'glm', 'pi', 'omp'];
  const provider = await askSelect('Provider', providers.map(p => ({
    label: `${PROVIDER_LABELS[p]} (${p})`,
    value: p,
  })));

  const defaultName = provider.charAt(0).toUpperCase() + provider.slice(1);
  const name = await askInput('Agent name', defaultName);
  if (!name) { console.log('\nAborted.'); rl.close(); return; }

  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  const agentsPath = join(cwd, '.synapse', 'agents.json');
  if (existsSync(agentsPath)) {
    const config = JSON.parse(readFileSync(agentsPath, 'utf-8'));
    if (config.agents?.some(a => a.id === id)) {
      console.log(`\nAgent "${id}" already exists.`);
      rl.close();
      return;
    }
  }

  let models;
  if (provider === 'ollama') {
    models = getOllamaModels();
  } else {
    models = PROVIDER_MODELS[provider] || [];
  }

  let model;
  if (models.length > 1) {
    const defaultModel = DEFAULT_MODELS[provider] || models[0];
    const defaultIdx = models.indexOf(defaultModel);
    model = await askSelect('Model', models.map(m => ({ label: m, value: m })), defaultIdx >= 0 ? defaultIdx : 0);
  } else if (models.length === 1) {
    model = models[0];
    console.log(`  Model: ${model}`);
  } else {
    model = await askInput('Model', DEFAULT_MODELS[provider] || '');
    if (!model) { console.log('\nAborted.'); rl.close(); return; }
  }

  const roles = ['developer', 'architect', 'reviewer'];
  const role = await askSelect('Role', roles.map(r => ({
    label: `${r} (${ROLE_SKILLS[r]?.slice(0, 3).join(', ') || 'general'})`,
    value: r,
  })), 0);

  let endpoint = null;
  if (provider === 'ollama') {
    // Any OpenAI-compatible /v1 server works here. 11434 = Ollama daemon,
    // 8080 = llama.cpp llama-server, 8000 = vLLM — no universal default.
    endpoint = await askInput('OpenAI-compatible endpoint (e.g. http://localhost:11434, :8080 for llama.cpp)', 'http://localhost:11434');
  }

  const agent = buildAgentConfig(id, name, provider, model, role, endpoint);

  if (!existsSync(agentsPath)) {
    mkdirSync(join(cwd, '.synapse'), { recursive: true });
    const config = {
      agents: [agent],
      roles: {},
      onboarding: { completed: true, completedAt: new Date().toISOString() },
    };
    writeFileSync(agentsPath, JSON.stringify(config, null, 2) + '\n');
  } else {
    const config = JSON.parse(readFileSync(agentsPath, 'utf-8'));
    if (!config.agents) config.agents = [];
    config.agents.push(agent);
    writeFileSync(agentsPath, JSON.stringify(config, null, 2) + '\n');
  }

  console.log(`\n  Added: ${name} (${provider}/${model}) as ${role}`);
  console.log('  Restart Synapse to pick up the new agent.\n');
  rl.close();
}

async function agentList(cwd) {
  const agentsPath = join(cwd, '.synapse', 'agents.json');
  if (!existsSync(agentsPath)) {
    console.log('No agents configured. Run: synapse init');
    rl.close();
    return;
  }
  const config = JSON.parse(readFileSync(agentsPath, 'utf-8'));
  const agents = config.agents || [];
  if (agents.length === 0) {
    console.log('No agents configured. Run: synapse agent add');
  } else {
    console.log(`\n${agents.length} agent(s):\n`);
    for (const a of agents) {
      console.log(`  ${a.name.padEnd(16)} ${a.provider}/${a.model.padEnd(28)} ${a.role}`);
    }
    console.log('');
  }
  rl.close();
}

async function agentPause(cwd, agentId) {
  const { baseUrl } = loadEnv(cwd);
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/pause`, { method: 'POST' });
  const data = await res.json();
  if (data.ok) console.log(`Agent "${agentId}" paused.`);
  else console.log(`Failed: ${data.error || res.statusText}`);
  rl.close();
}

async function agentResume(cwd, agentId) {
  const { baseUrl } = loadEnv(cwd);
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/resume`, { method: 'POST' });
  const data = await res.json();
  if (data.ok) console.log(`Agent "${agentId}" resumed.`);
  else console.log(`Failed: ${data.error || res.statusText}`);
  rl.close();
}

function loadEnv(cwd) {
  const envPath = join(cwd, '.env');
  let port = '8080';
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    // SYNAPSE_SERVER_PORT is the canonical var (matches config.js). Anchored
    // to a line start so SYNAPSE_SERVER_PORT is not accidentally matched by
    // a loose PORT= regex. PORT= is still accepted as a legacy fallback.
    const portMatch = envContent.match(/^SYNAPSE_SERVER_PORT=(\d+)/m)
      || envContent.match(/^PORT=(\d+)/m);
    if (portMatch) port = portMatch[1];
  }
  return { port, baseUrl: `http://localhost:${port}` };
}

async function startServer(cwd) {
  if (hasHelpFlag(process.argv.slice(3))) {
    console.log(`
Usage: synapse start

  Start the Synapse server. Reads ./.env (created by \`synapse init\`)
  and listens on the configured port (default 8080).

  Run \`synapse init\` first if no .env exists in the current directory.

  The server runs in the foreground. Press Ctrl-C to stop.
  Open the URL printed at startup to access the web UI.
`);
    process.exit(0);
  }

  // Pre-flight: snap-confined node breaks child-process pipes that the
  // orchestrator uses to dispatch every harness CLI (claude, codex, gemini,
  // opencode). The symptom at runtime is silent — every dispatch exits 1
  // with 0 bytes captured, which looks like a per-provider bug and takes
  // hours to diagnose. Ubuntu 24.04's default `apt install nodejs` lands
  // on snap, so this is the most common fresh-install failure mode. Refuse
  // here before any of that surfaces.
  try {
    const nodePath = realpathSync(process.execPath);
    if (nodePath.startsWith('/snap/')) {
      console.error('');
      console.error('  Synapse cannot run under snap-confined node.');
      console.error('');
      console.error(`  Detected:  ${nodePath}`);
      console.error('');
      console.error('  Snap-packaged node breaks the child-process pipes Synapse uses');
      console.error('  to talk to harness CLIs. Every agent dispatch silently exits');
      console.error('  with no output, and the failure looks like an auth / model bug.');
      console.error('');
      console.error('  Install a non-snap node (>= 18, 22+ recommended). Options:');
      console.error('    NodeSource:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -');
      console.error('                 sudo apt-get install -y nodejs');
      console.error('    Standalone:  see https://nodejs.org/dist/  (download, untar, prepend to PATH)');
      console.error('    nvm:         https://github.com/nvm-sh/nvm#installing-and-updating');
      console.error('');
      console.error('  Then `which node` should print a path that does NOT start with /snap.');
      console.error('  Rerun `synapse start` once that is true.');
      console.error('');
      process.exit(1);
    }
  } catch {
    // realpathSync failure should not block startup on a stat hiccup.
  }

  // Pre-flight: .env is created by `synapse init`. Without it, node's
  // --env-file flag fails with a cryptic "node: .env: not found" error
  // that gives the user no idea Synapse needs setup. Catch it here and
  // print an actionable message instead.
  const envPath = pathJoin(cwd, '.env');
  if (!existsSync(envPath)) {
    console.error('');
    console.error('  Synapse is not initialized in this directory.');
    console.error('');
    console.error('  Expected to find .env at:');
    console.error(`    ${envPath}`);
    console.error('');
    console.error('  Run `synapse init` first to create the configuration,');
    console.error('  or change to the directory where you ran init.');
    console.error('');
    process.exit(1);
  }

  const { spawn } = await import('child_process');
  // Resolve orchestrator.js path relative to this CLI's install location so
  // `synapse start` works whether the package is run from a dev checkout or
  // installed globally via npm (where the user's cwd doesn't contain src/).
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const orchestratorPath = pathJoin(cliDir, 'orchestrator.js');
  // --env-file=.env still resolves against the spawned process's cwd (the
  // user's project dir), so user-level env stays intact. Use process.execPath
  // (the node binary that's already validated above) instead of a fresh PATH
  // lookup — otherwise a `/snap/bin/node` ahead of the non-snap node on PATH
  // would silently win the spawn even though the CLI itself is running fine.
  const child = spawn(process.execPath, ['--env-file=.env', orchestratorPath], {
    cwd,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.kill('SIGINT'); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
}

// ── Service install ──────────────────────────────────────────────────────
// Productizes the unit pattern proven on the production deployment: a
// systemd service with Restart=always (crash recovery) + WantedBy target
// (reboot recovery) + an ExecStartPre orphan sweep. Without this, `synapse
// start` is a bare foreground process that dies on logout/reboot/crash with
// no supervision — the gap that let a test host stay down after an OOM.

function detectPrivilege() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { mode: 'system', sudo: '' };
  }
  try {
    execSync('sudo -n true 2>/dev/null', { stdio: 'ignore' });
    return { mode: 'system', sudo: 'sudo ' };
  } catch {
    return { mode: 'user', sudo: '' };
  }
}

function buildUnit({ runUser, cwd, nodeBin, orchestratorPath, killOrphans, memoryMax, mode }) {
  const nodeDir = dirname(nodeBin);
  const pathEnv = [nodeDir, `${homedir()}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin']
    .filter((v, i, a) => a.indexOf(v) === i).join(':');
  const lines = [
    '[Unit]',
    'Description=Synapse Multi-Agent Orchestrator',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
  ];
  // A system unit runs as root unless User= is set. The agents need the
  // invoking user's HOME (their authenticated harness CLIs live in
  // ~/.claude, ~/.codex, ~/.gemini, ~/.config/opencode) — so a system unit
  // MUST run as that user, not root.
  if (mode === 'system') {
    lines.push(`User=${runUser}`, `Group=${runUser}`);
  }
  lines.push(
    `WorkingDirectory=${cwd}`,
    `EnvironmentFile=${join(cwd, '.env')}`,
    `Environment=PATH=${pathEnv}`,
    `ExecStartPre=-/usr/bin/env bash ${killOrphans}`,
    `ExecStart=${nodeBin} --env-file=.env ${orchestratorPath}`,
    'Restart=always',
    'RestartSec=10',
    'KillMode=control-group',
    'TimeoutStopSec=30',
    'LimitNOFILE=65536',
  );
  if (memoryMax) lines.push(`MemoryMax=${memoryMax}`);
  lines.push(
    'StandardOutput=journal',
    'StandardError=journal',
    'SyslogIdentifier=synapse',
    '',
    '[Install]',
    mode === 'system' ? 'WantedBy=multi-user.target' : 'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

function serviceInstall(cwd) {
  if (hasHelpFlag(process.argv.slice(3))) {
    console.log(`
Usage: synapse service install [--memory-max=SIZE]

  Install Synapse as a systemd service so it starts on boot and is
  restarted on crash. Run this from your initialized Synapse directory
  (where .env lives). Uses a system unit if you have root/sudo, otherwise
  a systemd --user unit.

  --memory-max=SIZE   Optional cgroup memory ceiling (e.g. 12G). Omitted
                      by default. On a dedicated host leave unset; on a
                      shared/small host set it to avoid a swap spiral.
`);
    process.exit(0);
  }

  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) {
    console.error('\n  No .env in this directory. Run `synapse init` first, then');
    console.error(`  install the service from that directory.\n  (looked in: ${cwd})\n`);
    process.exit(1);
  }

  let nodeBin = process.execPath;
  try {
    if (realpathSync(nodeBin).startsWith('/snap/')) {
      console.error('\n  Refusing to install a service that runs snap-confined node');
      console.error('  (it breaks the child-process pipes Synapse needs). Install a');
      console.error('  non-snap node and re-run from that node.\n');
      process.exit(1);
    }
  } catch { /* stat hiccup — don't block */ }

  const cliDir = dirname(fileURLToPath(import.meta.url));
  const orchestratorPath = pathJoin(cliDir, 'orchestrator.js');
  const killOrphans = pathJoin(cliDir, '..', 'scripts', 'kill-orphans.sh');
  const runUser = process.env.SUDO_USER || userInfo().username;
  const memArg = process.argv.slice(3).find(a => a.startsWith('--memory-max='));
  const memoryMax = memArg ? memArg.split('=')[1] : '';

  const { mode, sudo } = detectPrivilege();
  const unit = buildUnit({ runUser, cwd, nodeBin, orchestratorPath, killOrphans, memoryMax, mode });

  console.log(`\n  Installing Synapse systemd ${mode} service...`);
  console.log(`    user:        ${runUser}`);
  console.log(`    working dir: ${cwd}`);
  console.log(`    node:        ${nodeBin}`);
  console.log(`    memory cap:  ${memoryMax || '(unset)'}\n`);

  try {
    if (mode === 'system') {
      const unitPath = '/etc/systemd/system/synapse.service';
      execSync(`${sudo}tee ${unitPath} > /dev/null`, { input: unit });
      execSync(`${sudo}systemctl daemon-reload`, { stdio: 'inherit' });
      execSync(`${sudo}systemctl enable --now synapse`, { stdio: 'inherit' });
      console.log(`\n  Installed: ${unitPath} (enabled — starts on boot, restarts on crash)`);
      console.log('  Status:  systemctl status synapse');
      console.log('  Logs:    journalctl -u synapse -f');
      console.log('  Stop:    sudo systemctl stop synapse\n');
    } else {
      const userUnitDir = join(homedir(), '.config', 'systemd', 'user');
      mkdirSync(userUnitDir, { recursive: true });
      writeFileSync(join(userUnitDir, 'synapse.service'), unit);
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      execSync('systemctl --user enable --now synapse', { stdio: 'inherit' });
      let linger = '';
      try { linger = execSync(`loginctl show-user ${runUser} -p Linger --value 2>/dev/null`).toString().trim(); } catch {}
      console.log(`\n  Installed: ${join(userUnitDir, 'synapse.service')} (systemd --user)`);
      console.log('  Status:  systemctl --user status synapse');
      console.log('  Logs:    journalctl --user -u synapse -f');
      console.log('  Stop:    systemctl --user stop synapse');
      if (linger !== 'yes') {
        console.log('\n  ⚠ Reboot persistence is OFF. A --user service stops at logout');
        console.log('    and does NOT start on boot until lingering is enabled:');
        console.log(`      sudo loginctl enable-linger ${runUser}`);
        console.log('    (needs admin once; without it the service is crash-resilient');
        console.log('     but NOT reboot-resilient).');
      }
      console.log('');
    }
  } catch (e) {
    console.error(`\n  Service install failed: ${e.message}`);
    console.error('  (systemd may be unavailable, or the unit could not be written.)\n');
    process.exit(1);
  }
}

function serviceUninstall() {
  const { mode, sudo } = detectPrivilege();
  const userUnit = join(homedir(), '.config', 'systemd', 'user', 'synapse.service');
  try {
    if (mode !== 'user' && !existsSync(userUnit)) {
      execSync(`${sudo}systemctl disable --now synapse 2>/dev/null`, { stdio: 'ignore' });
      execSync(`${sudo}rm -f /etc/systemd/system/synapse.service`);
      execSync(`${sudo}systemctl daemon-reload`, { stdio: 'inherit' });
    } else {
      execSync('systemctl --user disable --now synapse 2>/dev/null', { stdio: 'ignore' });
      execSync(`rm -f ${userUnit}`);
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    }
    console.log('\n  Synapse service removed.\n');
  } catch (e) {
    console.error(`\n  Uninstall failed: ${e.message}\n`);
    process.exit(1);
  }
}

function serviceStatus() {
  const userUnit = join(homedir(), '.config', 'systemd', 'user', 'synapse.service');
  const useUser = existsSync(userUnit);
  try {
    execSync(`systemctl ${useUser ? '--user ' : ''}status synapse --no-pager`, { stdio: 'inherit' });
  } catch {
    // systemctl exits non-zero when the service is inactive/dead — that
    // status output is itself the answer, so this is not an error path.
  }
}

const command = process.argv[2];
const cwd = process.cwd();

switch (command) {
  case 'init':
    await wizard(cwd);
    break;
  case 'start':
    await startServer(cwd);
    break;
  case 'service': {
    // Non-interactive commands must release the module-scope readline or the
    // open stdin handle keeps node alive forever — `synapse service install`
    // hung every terminal (and every scripted/ssh invocation) on success.
    const sub = process.argv[3];
    if (sub === 'install') { serviceInstall(cwd); rl.close(); }
    else if (sub === 'uninstall') { serviceUninstall(); rl.close(); }
    else if (sub === 'status') { serviceStatus(); rl.close(); }
    else {
      console.log(`
Usage: synapse service <install|uninstall|status>

  install    Install + enable a systemd service (boot + crash recovery)
  uninstall  Stop, disable, and remove the service
  status     Show the service status

  Run \`synapse service install\` from your initialized directory
  (the one containing .env). System unit if root/sudo, else --user.
`);
      process.exit(sub ? 1 : 0);
    }
    break;
  }
  case 'agent':
    const subcmd = process.argv[3];
    if (subcmd === '--help' || subcmd === '-h') {
      console.log(`
Usage: synapse agent <subcommand>

Subcommands:
  add         Interactively register a new agent (detects installed CLIs)
  list        Show currently configured agents
  pause ID    Pause an agent — no restart needed
  resume ID   Resume a paused agent
`);
      process.exit(0);
    }
    if (subcmd === 'add') await agentAdd(cwd);
    else if (subcmd === 'list') await agentList(cwd);
    else if (subcmd === 'pause') await agentPause(cwd, process.argv[4]);
    else if (subcmd === 'resume') await agentResume(cwd, process.argv[4]);
    else {
      console.log('Usage: synapse agent <add|list|pause|resume>');
      process.exit(1);
    }
    break;
  default:
    console.log(`
Synapse CLI — Multi-agent orchestration
BYOH: Bring Your Own Harness. Synapse connects the agents you already have.

Usage:
  synapse init             First-run setup wizard
  synapse start            Start the server (foreground)
  synapse service install  Install as a systemd service (boot + crash recovery)
  synapse agent add        Add an agent (detects your installed CLIs)
  synapse agent list       List configured agents
  synapse agent pause ID   Pause an agent (hot, no restart)
  synapse agent resume ID  Resume a paused agent

Getting started:
  synapse init             # Creates .env, .synapse/, agents.json
  synapse start            # Starts the Synapse server
`);
    process.exit(0);
}
