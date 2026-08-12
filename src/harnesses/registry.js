// Harness registry — catalog of CLI agent harnesses Synapse knows how to
// detect and inject endpoint overrides for.
//
// Two axes represented here:
//   - harness  = the binary Synapse spawns (claudecode, codex, opencode, ...)
//   - provider = the routing/backend label already used across the codebase
//                (claude, codex, glm, ollama, llama, gemini).
// One harness can back multiple providers — opencode backs glm + ollama + llama.
//
// This module is pure data + detection. No spawn logic (lives in src/agents/*.js),
// no install/update/diagnostic behavior (explicitly out of scope — see
// docs/init-wizard-design.md decision #9), no auth handling.

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Catalog of recognized harnesses. Each entry:
 *   id            — stable identifier for the harness itself
 *   label         — human-readable name
 *   binaries      — candidate binary names to look for on PATH (first match wins)
 *   knownPaths    — fallback install directories to check if PATH lookup fails;
 *                   populated per user at detect time via expandPath()
 *   baseUrlEnv    — env var Synapse injects when an agent has a baseUrl override,
 *                   null if harness manages its own endpoints (e.g., opencode)
 *   providers     — routing/backend labels this harness can back. Multi-value
 *                   harnesses (opencode) carry the full set.
 *   defaultModels — suggested model IDs for the UI dropdown. NOT a gate —
 *                   users can type anything. Suggestions only.
 */
export const HARNESSES = [
  {
    id: 'claudecode',
    label: 'Claude Code',
    binaries: ['claudecode', 'claude'],
    knownPaths: ['~/.claude/local/claudecode', '/usr/local/bin/claudecode'],
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    providers: ['claude'],
    defaultModels: ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    binaries: ['codex'],
    knownPaths: ['~/.codex/bin/codex', '/usr/local/bin/codex'],
    baseUrlEnv: 'OPENAI_BASE_URL',
    providers: ['codex'],
    defaultModels: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    binaries: ['gemini'],
    knownPaths: ['~/.gemini/bin/gemini', '/usr/local/bin/gemini'],
    baseUrlEnv: null, // Gemini CLI does not take an OpenAI-compatible baseUrl override
    providers: ['gemini'],
    defaultModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview'],
  },
  {
    id: 'opencode',
    label: 'opencode',
    binaries: ['opencode'],
    knownPaths: ['~/.opencode/bin/opencode', '/usr/local/bin/opencode'],
    baseUrlEnv: null, // opencode manages providers internally via opencode.json
    providers: ['glm', 'ollama', 'llama', 'openai', 'anthropic', 'google'],
    defaultModels: [], // Users pick from their opencode.json; no global suggestions
  },
  {
    id: 'pi',
    label: 'Pi',
    binaries: ['pi'],
    knownPaths: ['/usr/local/bin/pi', '~/.local/bin/pi', '~/.npm-global/bin/pi'],
    // Lab-verified 2026-08-01: pi does NOT honor OPENAI_BASE_URL (401 to
    // api.openai.com). Custom endpoints go via ~/.pi/agent/models.json.
    baseUrlEnv: null,
    providers: ['pi'],
    defaultModels: [], // BYOK across 20+ providers; users pick provider/model
  },
  {
    // oh-my-pi is a Pi EXTENSION (installed via `pi install npm:oh-my-pi`),
    // not a separate binary — detection keys on the pi binary. The user
    // picks this harness when their Pi install has the extension loaded.
    id: 'omp',
    label: 'oh-my-pi',
    binaries: ['pi'],
    knownPaths: ['/usr/local/bin/pi', '~/.local/bin/pi', '~/.npm-global/bin/pi'],
    baseUrlEnv: null, // same as pi — endpoint override only via ~/.pi/agent/models.json
    providers: ['omp'],
    defaultModels: [],
  },
  {
    id: 'droid',
    label: 'Droid',
    binaries: ['droid'],
    knownPaths: ['/opt/droid/bin/droid', '~/.droid/bin/droid'],
    baseUrlEnv: null, // Factory-managed, no documented override
    providers: ['droid'],
    defaultModels: [],
  },
  {
    id: 'aider',
    label: 'Aider',
    binaries: ['aider'],
    knownPaths: ['~/.local/bin/aider', '/usr/local/bin/aider'],
    baseUrlEnv: 'OPENAI_API_BASE',
    providers: ['aider'],
    defaultModels: [],
  },
  {
    id: 'goose',
    label: 'Goose',
    binaries: ['goose'],
    knownPaths: ['~/.local/bin/goose', '/usr/local/bin/goose'],
    baseUrlEnv: null, // Goose uses provider config file
    providers: ['goose'],
    defaultModels: [],
  },
  {
    id: 'plandex',
    label: 'Plandex',
    binaries: ['plandex'],
    knownPaths: ['~/.local/bin/plandex', '/usr/local/bin/plandex'],
    baseUrlEnv: null,
    providers: ['plandex'],
    defaultModels: [],
  },
  {
    id: 'amp',
    label: 'Amp Code',
    binaries: ['amp'],
    knownPaths: ['~/.local/bin/amp', '/usr/local/bin/amp'],
    baseUrlEnv: null, // Sourcegraph-managed
    providers: ['amp'],
    defaultModels: [],
  },
];

// ─── Harness descriptors (BYOH Phase 1+) ────────────────────────────────────
// The new descriptor-driven path. These are consumed by CliAgent in
// src/agents/cli-runner.js — no per-CLI JavaScript needed.
//
// Schema: see src/harnesses/descriptor-schema.js for full field reference.
//
// Phase 1: grok-cli only. Phase 2 will migrate claude/codex/gemini/opencode
// from their bespoke classes into descriptors here. Phase 3 exposes the UI
// dropdown sourced from this array.
//
// To add a new harness: drop a descriptor entry. No code changes elsewhere.
export const DESCRIPTORS = [

  // ─── Phase 2 — bespoke 4 migrated to descriptors ──────────────────────────
  // claude.js / codex.js / gemini.js / opencode.js still exist on disk for
  // back-compat. The PROVIDERS map in src/orchestrator/agents.js prefers the
  // descriptor-backed wrapper when present (see DESCRIPTOR_PROVIDERS spread).
  // Phase 4 will delete the bespoke .js files once parity has soaked.

  // CLAUDE — Anthropic's Claude Code CLI (mirrors src/agents/claude.js)
  {
    id: 'claude',
    label: 'Claude Code',
    binaries: ['claudecode', 'claude'],
    knownPaths: ['~/.claude/local/claudecode', '~/.local/bin/claude', '/usr/local/bin/claude'],
    subcommand: null,
    promptMode: 'flag',
    promptFlag: '-p',
    modelFlag: '--model',
    outputFormatArgs: [],                    // Claude Code prints plain text by default
    bypassPermissionsFlag: '--dangerously-skip-permissions',
    maxTurnsFlag: '--max-turns',
    chromeFlag: '--chrome',
    optionalFlags: [],
    envDelete: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    responseSource: 'stdout-text',
    responseTextField: null,
    responseCleanLines: [],
    tokenSource: { type: 'estimate' },        // bespoke claude.js also estimates
    exitCodeBehavior: 'strict-fail',
    // Synapse MINTS the id rather than parsing one out. Verified from
    // `claude --help`: `--session-id <uuid>` ("Use a specific session ID for the
    // conversation (must be a valid UUID)") and `-r, --resume [value]`
    // ("Resume a conversation by session ID"). That is why claude needs no
    // sessionIdSource and no --output-format change: its stdout stays plain
    // text and the parse path is untouched.
    continuation: {
      strategy: 'session-id-provided',
      sessionIdSource: null,
      idFlag: '--session-id',
      resumeFlag: '--resume',
    },
    capabilities: {
      execution: true, streaming: false, tokenReporting: 'estimated',
      synapseSandboxCompatible: true, supportsBypassPermissions: true,
      baseUrlOverride: 'ANTHROPIC_BASE_URL',
    },
    identity: { mode: 'routable', providers: ['claude'], promotionStatus: 'validated' },
    adapter: null,
    defaultModels: ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
  },

  // CODEX — OpenAI Codex CLI (mirrors src/agents/codex.js)
  {
    id: 'codex',
    label: 'Codex CLI',
    binaries: ['codex'],
    knownPaths: ['~/.codex/bin/codex', '~/.local/bin/codex', '/usr/local/bin/codex'],
    subcommand: 'exec',
    promptMode: 'positional-last',
    promptFlag: null,
    modelFlag: '-m',
    outputFormatArgs: ['--json'],
    bypassPermissionsFlag: '--dangerously-bypass-approvals-and-sandbox',
    maxTurnsFlag: null,                       // codex exec has no turn cap flag
    chromeFlag: null,
    optionalFlags: [],
    envDelete: [],
    // Codex emits NDJSON event stream — the existing 'stdout-ndjson' parser
    // walks each line, picks events of type=item.completed with item.type=agent_message,
    // extracts item.text. Defaults in response-parsers.js already match codex's shape.
    responseSource: 'stdout-ndjson',
    responseTextField: null,
    responseCleanLines: [],
    tokenSource: { type: 'estimate' },        // bespoke codex.js uses estimates too
    exitCodeBehavior: 'lenient-if-parsed',
    continuation: { strategy: 'none', sessionIdSource: null, resumeFlag: null },
    capabilities: {
      execution: true, streaming: false, tokenReporting: 'estimated',
      synapseSandboxCompatible: true, supportsBypassPermissions: true,
      baseUrlOverride: 'OPENAI_BASE_URL',
    },
    identity: { mode: 'routable', providers: ['codex'], promotionStatus: 'validated' },
    adapter: null,
    defaultModels: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
    baseUrlEnv: 'OPENAI_BASE_URL',
  },

  // GEMINI — Google Gemini CLI (mirrors src/agents/gemini.js)
  {
    id: 'gemini',
    label: 'Gemini CLI',
    binaries: ['gemini'],
    knownPaths: ['~/.gemini/bin/gemini', '~/.local/bin/gemini', '/usr/local/bin/gemini'],
    subcommand: null,
    promptMode: 'flag',
    promptFlag: '-p',
    modelFlag: '-m',
    modelFlagOmitWhen: 'auto',                // bespoke gemini omits -m when model==='auto'
    outputFormatArgs: [],
    bypassPermissionsFlag: '--yolo',
    maxTurnsFlag: null,
    chromeFlag: null,
    optionalFlags: [],
    envDelete: [],
    responseSource: 'stdout-text-regex',
    responseTextField: null,
    // Match bespoke gemini.js's cleanLines filter
    responseCleanLines: ['Loaded cached credentials', '--prompt (-p) flag has been deprecated'],
    tokenSource: { type: 'estimate' },        // bespoke parses tokens via parseGeminiTokens
                                              // but estimate is safe fallback; refine in Phase 4
    exitCodeBehavior: 'lenient-if-parsed',
    continuation: { strategy: 'none', sessionIdSource: null, resumeFlag: null },
    capabilities: {
      execution: true, streaming: false, tokenReporting: 'estimated',
      synapseSandboxCompatible: true, supportsBypassPermissions: true,
      baseUrlOverride: null,                  // gemini CLI doesn't take OpenAI-compat baseUrl
    },
    identity: { mode: 'routable', providers: ['gemini'], promotionStatus: 'validated' },
    adapter: null,
    defaultModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview'],
    baseUrlEnv: null,
  },

  // OPENCODE — Sourcegraph/Anysphere opencode (mirrors src/agents/opencode.js)
  // NOTE: bespoke opencode.js uses a heredoc-via-sh trampoline because of
  // bun-runtime EBADF stdin issues + multi-word positional argv failures.
  // CliAgent supports this via promptMode: 'stdin-heredoc' which produces
  // the same `sh -c "cat <<SENT | opencode run ... \n<message>\nSENT"` shape.
  {
    id: 'opencode',
    label: 'opencode',
    binaries: ['opencode'],
    knownPaths: ['~/.opencode/bin/opencode', '~/.local/bin/opencode', '/usr/local/bin/opencode'],
    subcommand: 'run',
    promptMode: 'stdin-heredoc',
    promptFlag: null,
    modelFlag: '--model',
    outputFormatArgs: ['--format', 'json'],
    bypassPermissionsFlag: null,              // opencode has no bypass flag — auth lives in opencode.json
    maxTurnsFlag: null,
    chromeFlag: null,
    optionalFlags: [
      { flag: '--variant', sourceKey: 'variant' },
      { flag: '--continue', sourceKey: 'continue' },
      { flag: '--session', sourceKey: 'session' },
      { flag: '--thinking', sourceKey: 'thinking' },
    ],
    envDelete: [],
    responseSource: 'stdout-event-stream',    // opencode emits {type:'text',part:{text:...}} events
    responseTextField: null,
    responseCleanLines: [],
    tokenSource: { type: 'estimate' },
    exitCodeBehavior: 'lenient-if-parsed',
    continuation: { strategy: 'session-id-flag', sessionIdSource: { type: 'stdout-event-stream', field: 'sessionID' }, resumeFlag: '--continue' },
    capabilities: {
      execution: true, streaming: true, tokenReporting: 'estimated',
      synapseSandboxCompatible: true, supportsBypassPermissions: false,
      baseUrlOverride: null,
    },
    // opencode backs MULTIPLE providers because its opencode.json defines them.
    // Synapse's existing config has provider IDs glm/ollama/llama/openai/anthropic/google
    // routed via opencode. The descriptor identity reflects that fan-out.
    identity: { mode: 'routable', providers: ['opencode', 'glm', 'ollama', 'llama'], promotionStatus: 'validated' },
    adapter: null,
    defaultModels: [],
    baseUrlEnv: null,
  },

  // ─── Beyond-bespoke BYOH harnesses ────────────────────────────────────────

  // Hermes Agent (Nous Research) — Python harness with multi-provider OAuth
  // pooling. Validated 2026-06-01 against gpt-5.5 via OpenAI Codex OAuth.
  // Tests:
  //   - 'chat' subcommand (NOT positional; hermes 0.15+ deprecated -z at top
  //     level in favor of the chat subcommand with -q query)
  //   - venv-installed binary path
  //   - Programmatic-mode output via -Q quiet flag (clean stdout only)
  //   - Different vendor (Nous) reusing existing OAuth credentials
  // Smoke test: hermes chat -q "say only OK" --yolo -Q → stdout='OK', exit 0
  {
    id: 'hermes',
    label: 'Hermes Agent',
    binaries: ['hermes'],
    knownPaths: ['~/.local/bin/hermes', '~/hermes-venv/bin/hermes', '/usr/local/bin/hermes'],
    subcommand: 'chat',
    promptMode: 'flag',
    promptFlag: '-q',
    modelFlag: '-m',
    // -Q (quiet) suppresses banner/spinner/tool-previews — outputs only the
    // final response on stdout. Without this Hermes emits boxed UI to stdout
    // which is hard to parse. -Q is the canonical 'programmatic use' flag.
    outputFormatArgs: ['-Q'],
    bypassPermissionsFlag: '--yolo',
    maxTurnsFlag: '--max-turns',
    chromeFlag: null,
    optionalFlags: [
      { flag: '-s', sourceKey: 'skills' },           // preload skills for the session
      { flag: '-t', sourceKey: 'toolsets' },         // comma-separated toolsets to enable
      { flag: '--accept-hooks', sourceKey: 'acceptHooks' }, // auto-approve shell hooks
    ],
    envDelete: [],
    // Hermes -Q outputs ONLY the final response on stdout — no banners,
    // no THINKING block, no token line. Plain text. (Tokens go to a request
    // dump in ~/.hermes/sessions/, not stdout.)
    responseSource: 'stdout-text',
    responseTextField: null,
    responseCleanLines: [],
    // Token info isn't on stdout; could read from session dump on disk
    // (~/.hermes/sessions/request_dump_*.json) — defer that to a follow-up
    // since estimate is good enough for cost tracking and the dump path
    // has a runtime-generated timestamp that complicates disk-file strategy.
    tokenSource: { type: 'estimate' },
    exitCodeBehavior: 'lenient-if-parsed',
    continuation: {
      // Hermes prints `session_id: <id>` to stderr at end; can resume with -r.
      // Defer continuation wiring to a follow-up (needs a new sessionIdSource
      // strategy 'stderr-regex' which doesn't exist yet — same pattern as
      // the token reader gap aider needed).
      strategy: 'none',
      sessionIdSource: null,
      resumeFlag: null,
    },
    capabilities: {
      execution: true,
      streaming: false,
      tokenReporting: 'estimated',
      synapseSandboxCompatible: true,
      supportsBypassPermissions: true,
      baseUrlOverride: null,   // Hermes manages providers internally via `hermes auth add`
    },
    identity: {
      mode: 'routable',
      providers: ['hermes'],
      promotionStatus: 'validated',
    },
    adapter: null,
    defaultModels: ['gpt-5.5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'nous/hermes-3-llama-3.1-405b'],
    baseUrlEnv: null,
  },

  // Aider — Python CLI agent harness, openai-compatible. Tests:
  //   - Different output shape from grok (text not JSON, structured markers)
  //   - baseUrlEnv path (OPENAI_API_BASE → points at any openai-compat server)
  //   - venv-installed binary path resolution
  // Updated 2026-06-01 to use the two new schema strategies that this
  // harness motivated:
  //   - responseSource: 'stdout-text-marker'  (extract the ANSWER block)
  //   - tokenSource: 'stdout-text-regex'      (parse Tokens: line on stdout)
  // Replaces the prior cleanLines-everywhere + 'estimate' workaround. Exact
  // token counts now flow back to ProviderMetricsStore for accurate cost
  // tracking, and the response is just the answer (no THINKING/banner noise).
  {
    id: 'aider',
    label: 'Aider',
    binaries: ['aider'],
    knownPaths: ['~/.local/bin/aider', '~/aider-venv/bin/aider', '/usr/local/bin/aider'],
    subcommand: null,
    promptMode: 'flag',
    promptFlag: '--message',
    modelFlag: '--model',
    outputFormatArgs: ['--no-stream', '--no-pretty', '--no-show-model-warnings', '--no-restore-chat-history', '--no-check-update', '--no-auto-commits'],
    bypassPermissionsFlag: '--yes-always',
    maxTurnsFlag: null,
    chromeFlag: null,
    optionalFlags: [],
    envDelete: [],
    // New schema strategy: extract text between aider's ► **ANSWER** marker
    // and the trailing Tokens: line. Falls back to whole-stdout if markers
    // aren't found (forward-compat with aider output changes).
    responseSource: 'stdout-text-marker',
    responseStartMarker: '► **ANSWER**',
    responseEndMarker: 'Tokens:',
    responseCleanLines: [],
    // New schema strategy: parse aider's "Tokens: N sent, M received" line
    // from stdout. K/M suffixes supported. Falls back to estimate if regex
    // doesn't match (forward-compat).
    tokenSource: {
      type: 'stdout-text-regex',
      inputRegex: 'Tokens:\\s+(\\d+(?:\\.\\d+)?[KkMm]?)\\s+sent',
      outputRegex: '(\\d+(?:\\.\\d+)?[KkMm]?)\\s+received',
    },
    exitCodeBehavior: 'lenient-if-parsed',
    continuation: {
      strategy: 'none',
      sessionIdSource: null,
      resumeFlag: null,
    },
    capabilities: {
      execution: true,
      streaming: false,
      tokenReporting: 'estimated',
      synapseSandboxCompatible: true,
      supportsBypassPermissions: true,
      baseUrlOverride: 'OPENAI_API_BASE',
    },
    identity: {
      mode: 'routable',
      providers: ['aider'],
      promotionStatus: 'validated',
    },
    adapter: null,
    // BYOK across litellm's provider space — no meaningful global default.
    // (Previously seeded with a lab-local GGUF, which leaked into the UI.)
    defaultModels: [],
    baseUrlEnv: 'OPENAI_API_BASE',
  },

  // PI — Mario Zechner's minimal BYOK coding-agent harness (pi.dev,
  // @earendil-works/pi-coding-agent). Four-tool core (Read/Write/Edit/Bash),
  // lazy-loading skills, 20+ providers via the unified pi-ai API.
  // Invocation contract from the package README: `pi -p "<prompt>"` prints
  // the response and exits; `--model provider/model` selects both provider
  // and model in one flag (e.g. anthropic/claude-sonnet-4-6, openai/gpt-5.4,
  // or model:high for thinking level).
  {
    id: 'pi',
    label: 'Pi',
    binaries: ['pi'],
    knownPaths: ['/usr/local/bin/pi', '~/.local/bin/pi', '~/.npm-global/bin/pi'],

    // ── Invocation ──
    subcommand: null,
    promptMode: 'flag',
    promptFlag: '-p',
    modelFlag: '--model',
    // Plain text mode: pi's --mode json emits an event-stream protocol we
    // have not contract-tested; -p print mode is the stable documented path.
    // --offline is LOAD-BEARING: pi fetches the models.dev catalog at startup
    // and hangs indefinitely on egress-denied networks (the enclave). Verified
    // 2026-08-01: without it, dispatch hangs even on the laptop; with it, a
    // real dispatch through llama-server returned in seconds.
    // --no-session keeps dispatches ephemeral (continuation strategy 'none').
    outputFormatArgs: ['--offline', '--no-session'],
    bypassPermissionsFlag: null,
    maxTurnsFlag: null,
    chromeFlag: null,
    optionalFlags: [],
    envDelete: [],

    // ── Extraction ──
    responseSource: 'stdout-text',
    tokenSource: { type: 'estimate' },
    exitCodeBehavior: 'lenient-if-parsed',

    // ── Continuation ──
    // `pi -c` continues the most recent session in cwd — no session ID to
    // thread through, so model as one-shot until session-file support is
    // contract-tested.
    continuation: {
      strategy: 'none',
      sessionIdSource: null,
      resumeFlag: null,
    },

    // ── Capabilities ──
    capabilities: {
      execution: true,
      streaming: false,
      tokenReporting: 'estimated',
      synapseSandboxCompatible: true,
      supportsBypassPermissions: false,
      // pi ignores OPENAI_BASE_URL (verified 2026-08-01); custom endpoints
      // are configured in ~/.pi/agent/models.json, outside Synapse's reach.
      baseUrlOverride: null,
    },

    // ── Governance ──
    identity: {
      mode: 'routable',
      providers: ['pi'],
      promotionStatus: 'validated',
    },

    adapter: null,

    // ── Metadata ──
    defaultModels: [],
    baseUrlEnv: null, // models.json, not env — see capabilities comment
  },

  // OH-MY-PI — Pi with the oh-my-pi extension (npm:oh-my-pi) loaded. NOT a
  // separate binary: the extension installs into Pi via `pi install
  // npm:oh-my-pi` and swaps in a Sisyphus-style orchestrator system prompt
  // plus an oh_my_pi_subagent tool; on any extension error it degrades to
  // vanilla Pi. Invocation contract is identical to Pi's — lab-verified
  // 2026-08-01 (`pi -p ... --offline --no-session` with the extension
  // loaded returned OMP_SYNAPSE_OK through a llama-server backend).
  // CAVEAT for local models: the orchestrator prompt is ~13.5k tokens, so
  // prefill dominates latency (minutes on a 27B GGUF vs seconds vanilla);
  // cloud providers are unaffected. Slow ≠ hung — budget dispatch timeouts
  // accordingly.
  {
    id: 'omp',
    label: 'oh-my-pi',
    binaries: ['pi'],
    knownPaths: ['/usr/local/bin/pi', '~/.local/bin/pi', '~/.npm-global/bin/pi'],

    // ── Invocation ── (mirrors pi — same binary, same flags)
    subcommand: null,
    promptMode: 'flag',
    promptFlag: '-p',
    modelFlag: '--model',
    outputFormatArgs: ['--offline', '--no-session'],
    bypassPermissionsFlag: null,
    maxTurnsFlag: null,
    chromeFlag: null,
    optionalFlags: [],
    envDelete: [],

    // ── Extraction ──
    responseSource: 'stdout-text',
    tokenSource: { type: 'estimate' },
    exitCodeBehavior: 'lenient-if-parsed',

    // ── Continuation ──
    continuation: {
      strategy: 'none',
      sessionIdSource: null,
      resumeFlag: null,
    },

    // ── Capabilities ──
    capabilities: {
      execution: true,
      streaming: false,
      tokenReporting: 'estimated',
      synapseSandboxCompatible: true,
      supportsBypassPermissions: false,
      // pi ignores OPENAI_BASE_URL (verified 2026-08-01); custom endpoints
      // are configured in ~/.pi/agent/models.json, outside Synapse's reach.
      baseUrlOverride: null,
    },

    // ── Governance ──
    identity: {
      mode: 'routable',
      providers: ['omp'],
      promotionStatus: 'validated',
    },

    adapter: null,

    // ── Metadata ──
    defaultModels: [],
    baseUrlEnv: null, // models.json, not env — see capabilities comment
  },

  {
    id: 'grok',
    label: 'Grok Build',
    binaries: ['grok'],
    knownPaths: ['~/.grok/bin/grok', '/usr/local/bin/grok'],

    // ── Invocation ──
    subcommand: null,
    promptMode: 'flag',
    promptFlag: '-p',
    modelFlag: '--model',
    outputFormatArgs: ['--output-format', 'json'],
    bypassPermissionsFlag: '--always-approve',
    maxTurnsFlag: '--max-turns',
    chromeFlag: null,
    optionalFlags: [
      { flag: '--disable-web-search', sourceKey: 'disableWebSearch' },
      { flag: '--effort', sourceKey: 'effort' },
      { flag: '--reasoning-effort', sourceKey: 'reasoningEffort' },
    ],
    envDelete: [],

    // ── Extraction ──
    responseSource: 'stdout-json',
    responseTextField: 'text',

    // Grok writes a session-state directory after each dispatch with token info.
    // signals.json contains `contextTokensUsed` (combined). Path template uses
    // ${cwd} (URL-encoded by the runner) and ${sessionId} (from parsed JSON).
    tokenSource: {
      type: 'disk-file',
      path: '~/.grok/sessions/${cwd}/${sessionId}/signals.json',
      combinedField: 'contextTokensUsed',
    },

    // Grok-build occasionally cancels with non-zero on timeout but the
    // text is still in stdout — lenient parse wins.
    exitCodeBehavior: 'lenient-if-parsed',

    // ── Continuation ──
    continuation: {
      strategy: 'session-id-flag',
      sessionIdSource: { type: 'stdout-json', field: 'sessionId' },
      resumeFlag: '-r',
    },

    // ── Capabilities ──
    capabilities: {
      execution: true,
      streaming: false,
      tokenReporting: 'exact', // signals.json gives exact counts
      synapseSandboxCompatible: true,
      supportsBypassPermissions: true,
      baseUrlOverride: null,
    },

    // ── Governance ──
    // Synapse-shipped descriptors are pre-validated against the spawn
    // protocol and can be 'routable' out of the box. User-added descriptors
    // (Phase 3 form) default to 'isolated'.
    identity: {
      mode: 'routable',
      providers: ['grok'],
      promotionStatus: 'validated',
    },

    adapter: null, // no escape hatch needed for grok-build

    // ── Metadata ──
    defaultModels: ['grok-build'],
    baseUrlEnv: null,
  },
];

// Convenience lookup by id (or one of its providers).
export function getDescriptor(idOrProvider) {
  if (!idOrProvider) return null;
  for (const d of DESCRIPTORS) {
    if (d.id === idOrProvider) return d;
    if (Array.isArray(d.identity?.providers) && d.identity.providers.includes(idOrProvider)) return d;
  }
  return null;
}


/**
 * Expand ~ to the user's home directory.
 */
function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

/**
 * Look for a binary on PATH. Returns the resolved path or null.
 */
function whichBinary(name) {
  try {
    const out = execSync(`command -v ${name} 2>/dev/null`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Detect a single harness. Returns:
 *   { id, label, found: true,  path: '...' }  on hit
 *   { id, label, found: false, path: null }   on miss
 *
 * Detection order: PATH lookup by each candidate binary name, then
 * fallback to knownPaths. No version parsing (per decision #9).
 */
export function detectHarness(harness) {
  for (const name of harness.binaries) {
    const path = whichBinary(name);
    if (path) return { id: harness.id, label: harness.label, found: true, path };
  }
  for (const rawPath of harness.knownPaths) {
    const path = expandPath(rawPath);
    if (existsSync(path)) return { id: harness.id, label: harness.label, found: true, path };
  }
  return { id: harness.id, label: harness.label, found: false, path: null };
}

/**
 * Detect every harness in the catalog. Pure function — no side effects
 * beyond reading the filesystem and spawning `command -v` synchronously.
 *
 * Returns an array of detection records in catalog order, each with
 * { id, label, found, path }.
 */
export function detectAllHarnesses() {
  return HARNESSES.map(detectHarness);
}

/**
 * Look up a harness by id. Returns the catalog entry or null.
 */
export function getHarness(id) {
  return HARNESSES.find((h) => h.id === id) || null;
}

/**
 * Return the list of harness ids that can back a given provider.
 * Useful for: "if the user picks provider=ollama, which harnesses are candidates?"
 */
export function harnessesForProvider(providerId) {
  return HARNESSES.filter((h) => h.providers.includes(providerId)).map((h) => h.id);
}

/**
 * Get the env-var name Synapse should inject for a baseUrl override,
 * given a harness id. Returns null if the harness does not support
 * env-based endpoint override (e.g., opencode, gemini-cli).
 */
export function baseUrlEnvForHarness(harnessId) {
  const h = getHarness(harnessId);
  return h ? h.baseUrlEnv : null;
}

/**
 * All provider ids the descriptor registry knows (identity.providers union,
 * falling back to the harness id for identity-less descriptors). Pure data —
 * no detection, no I/O — safe to import from config.js at boot (this module
 * imports only node builtins; de-ollama Phase 3, #103). Consumers that need
 * the LEGACY minimum set should union this with their own floor.
 * @returns {string[]}
 */
export function knownProviderIds() {
  return [...new Set(DESCRIPTORS.flatMap(d =>
    (d.identity?.providers && d.identity.providers.length) ? d.identity.providers : [d.id]
  ))];
}
