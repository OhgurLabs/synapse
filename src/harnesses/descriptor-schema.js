// descriptor-schema.js — Harness Descriptor schema + validation for BYOH.
//
// This is the data contract that lets users (and Synapse's own registry)
// describe a CLI agent harness as configuration. The unified CliAgentRunner
// in src/agents/cli-runner.js consumes a descriptor + agent config and
// dispatches; no per-harness JavaScript is needed.
//
// Design principles (converged via 3-agent / 3-round deliberation on
// 2026-05-31, captured in noble-popping-metcalfe.md):
//
//   1. Descriptors hold STATIC VALUES + NAMED STRATEGY IDs only. No inline
//      code, no eval, no shell snippets.
//   2. Strategies are MAINTAINER-SHIPPED. The runner ships a closed library
//      of strategies (prompt modes, response sources, token sources). Adding
//      a new strategy is a code change in Synapse, reviewed normally.
//   3. The ESCAPE HATCH is a named adapter module loaded from a known path
//      with a typed interface — bounded extension, not arbitrary scripts.
//   4. Provider participation is OPT-IN. A descriptor starts isolated (runs
//      as an agent but doesn't join routing/failover/circuit-breakers).
//      Routable promotion requires capability declarations + smoke test.
//
// This module is pure data + validation. The runner imports it for schema
// checks; the registry uses it to declare known harnesses.

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Strategy catalogs ──────────────────────────────────────────────────────
// These are the values the runner KNOWS how to consume. Anything outside
// these enums must use a named adapter module instead.

export const PROMPT_MODES = Object.freeze([
  'flag',                  // claude/gemini/grok: `-p <msg>`
  'positional-last',       // codex: args end with the message
  'stdin-heredoc',         // opencode: `sh -c 'cat <<X | binary args\n<msg>\nX\n'`
]);

export const RESPONSE_SOURCES = Object.freeze([
  'stdout-text',           // plain text on stdout (claude default)
  'stdout-json',           // single JSON object on stdout (grok)
  'stdout-ndjson',         // newline-delimited JSON events (codex)
  'stdout-event-stream',   // typed event stream with text/step_finish/error (opencode)
  'stdout-text-regex',     // plain text plus line-substring filtering (gemini)
  'stdout-text-marker',    // extract text BETWEEN start/end markers (aider's ► **ANSWER** ... Tokens:)
]);

export const TOKEN_SOURCES = Object.freeze([
  'stderr-regex',          // grep tokens out of stderr lines (claude)
  'stdout-text-regex',     // grep tokens out of stdout text via regex (aider's "Tokens: X sent, Y received")
  'stdout-json-field',     // pull tokens from a known JSON field path
  'stdout-ndjson-event',   // pull tokens from a typed event in NDJSON stream
  'stdout-event-stream',   // pull tokens from a typed event in the opencode-style stream
  'disk-file',             // read tokens from a session-state file on disk after dispatch (grok)
  'estimate',              // fall back to chars/4 estimate from text length
]);

export const EXIT_CODE_BEHAVIORS = Object.freeze([
  'strict-fail',           // non-zero exit -> error
  'lenient-if-parsed',     // ignore non-zero if we already parsed a response
]);

export const CONTINUATION_STRATEGIES = Object.freeze([
  'none',                  // CLI is one-shot, no session state
  'session-file',          // CLI writes a session file at a known path
  'session-id-flag',       // CLI returns a session ID; pass back via flag
  'history-dir',           // CLI maintains a history directory we point at
]);

export const IDENTITY_MODES = Object.freeze([
  'isolated',              // default: runs as agent, NOT a routable provider
  'routable',              // opted-in: participates in failover/circuit-breakers/analytics
]);

export const TOKEN_REPORTING = Object.freeze(['exact', 'estimated', 'none']);

// ─── Strategy library reference ─────────────────────────────────────────────
// The runner attaches its actual implementations; this is just the names
// the validator accepts. Strategies live in src/agents/response-parsers.js
// and src/agents/token-readers.js.

/**
 * Expand `~` and basic `${...}` placeholders in a descriptor path.
 * Placeholders supported: `${cwd}`, `${sessionId}`, `${home}`.
 * Returns the literal path otherwise — placeholder substitution happens
 * at dispatch time by the runner, not here.
 */
export function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

// ─── Schema field-by-field validation ───────────────────────────────────────

function isStr(v) { return typeof v === 'string'; }
function isBool(v) { return typeof v === 'boolean'; }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function isStrArr(v) { return Array.isArray(v) && v.every(isStr); }

/**
 * Validate a harness descriptor. Returns { ok: true, descriptor: normalized }
 * on success; { ok: false, errors: [string] } on failure. NEVER throws.
 *
 * Normalization applies defaults for fields the caller omitted so the runner
 * can rely on every field being present.
 */
export function validateDescriptor(input) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (!isObj(input)) return { ok: false, errors: ['descriptor must be an object'] };

  const d = { ...input }; // shallow clone so we can fill defaults

  // ── Identity (required) ──
  if (!isStr(d.id) || d.id.length === 0) push('id: required string');
  if (!isStr(d.label) || d.label.length === 0) push('label: required string');

  // ── Binary discovery ──
  if (!isStrArr(d.binaries) || d.binaries.length === 0) {
    push('binaries: required non-empty string array');
  }
  if (d.knownPaths != null && !isStrArr(d.knownPaths)) {
    push('knownPaths: must be string array');
  }
  d.knownPaths = d.knownPaths || [];
  if (d.minVersion != null && !isStr(d.minVersion)) push('minVersion: must be string');
  if (d.maxVersion != null && !isStr(d.maxVersion)) push('maxVersion: must be string');

  // ── Invocation ──
  if (d.subcommand != null && !isStr(d.subcommand)) push('subcommand: must be string or null');
  if (!PROMPT_MODES.includes(d.promptMode)) {
    push(`promptMode: must be one of ${PROMPT_MODES.join(', ')}`);
  }
  if (d.promptMode === 'flag') {
    if (!isStr(d.promptFlag)) push('promptFlag: required when promptMode=flag');
  }
  if (d.modelFlag != null && !isStr(d.modelFlag)) push('modelFlag: must be string or null');
  if (d.outputFormatArgs != null && !isStrArr(d.outputFormatArgs)) {
    push('outputFormatArgs: must be string array');
  }
  d.outputFormatArgs = d.outputFormatArgs || [];

  // Optional flags + defaults
  if (d.bypassPermissionsFlag != null && !isStr(d.bypassPermissionsFlag)) {
    push('bypassPermissionsFlag: must be string or null');
  }
  if (d.maxTurnsFlag != null && !isStr(d.maxTurnsFlag)) {
    push('maxTurnsFlag: must be string or null');
  }
  if (d.chromeFlag != null && !isStr(d.chromeFlag)) {
    push('chromeFlag: must be string or null');
  }
  if (d.optionalFlags != null) {
    if (!Array.isArray(d.optionalFlags)) push('optionalFlags: must be array');
    else d.optionalFlags.forEach((f, i) => {
      if (!isObj(f)) push(`optionalFlags[${i}]: must be object`);
      else if (!isStr(f.flag) || !isStr(f.sourceKey)) {
        push(`optionalFlags[${i}]: must have { flag: string, sourceKey: string }`);
      }
    });
  }
  d.optionalFlags = d.optionalFlags || [];
  if (d.envDelete != null && !isStrArr(d.envDelete)) push('envDelete: must be string array');
  d.envDelete = d.envDelete || [];

  // ── Extraction ──
  if (!RESPONSE_SOURCES.includes(d.responseSource)) {
    push(`responseSource: must be one of ${RESPONSE_SOURCES.join(', ')}`);
  }
  if (d.responseTextField != null && !isStr(d.responseTextField)) {
    push('responseTextField: must be string or null');
  }
  if (d.responseCleanLines != null && !isStrArr(d.responseCleanLines)) {
    push('responseCleanLines: must be string array');
  }
  d.responseCleanLines = d.responseCleanLines || [];
  // stdout-text-marker requires a start marker; end marker optional
  if (d.responseSource === 'stdout-text-marker') {
    if (!isStr(d.responseStartMarker) || !d.responseStartMarker) {
      push('responseStartMarker: required non-empty string when responseSource is stdout-text-marker');
    }
    if (d.responseEndMarker != null && !isStr(d.responseEndMarker)) {
      push('responseEndMarker: must be string or null');
    }
  }

  if (!isObj(d.tokenSource)) {
    push('tokenSource: required object');
  } else {
    if (!TOKEN_SOURCES.includes(d.tokenSource.type)) {
      push(`tokenSource.type: must be one of ${TOKEN_SOURCES.join(', ')}`);
    }
    // type-specific field checks
    if (d.tokenSource.type === 'stderr-regex') {
      if (d.tokenSource.patterns != null && !isObj(d.tokenSource.patterns)) {
        push('tokenSource.patterns: must be object with input/output regex arrays');
      }
    } else if (d.tokenSource.type === 'stdout-text-regex') {
      // Token reader expects inputRegex + outputRegex strings (not the
      // multi-pattern object stderr-regex accepts). Both required so we
      // know the descriptor isn't half-configured.
      if (!isStr(d.tokenSource.inputRegex) || !isStr(d.tokenSource.outputRegex)) {
        push('tokenSource: stdout-text-regex requires inputRegex + outputRegex strings');
      }
    } else if (d.tokenSource.type === 'stdout-json-field') {
      if (!isStr(d.tokenSource.inputField) && !isStr(d.tokenSource.outputField)) {
        push('tokenSource: stdout-json-field requires inputField and/or outputField');
      }
    } else if (d.tokenSource.type === 'disk-file') {
      if (!isStr(d.tokenSource.path)) push('tokenSource.path: required for disk-file');
      if (!isStr(d.tokenSource.inputField) && !isStr(d.tokenSource.combinedField)) {
        push('tokenSource: disk-file requires inputField or combinedField');
      }
    }
  }

  if (!EXIT_CODE_BEHAVIORS.includes(d.exitCodeBehavior)) {
    push(`exitCodeBehavior: must be one of ${EXIT_CODE_BEHAVIORS.join(', ')}`);
  }

  // ── Continuation (optional but recommended) ──
  if (d.continuation != null) {
    if (!isObj(d.continuation)) push('continuation: must be object');
    else if (!CONTINUATION_STRATEGIES.includes(d.continuation.strategy)) {
      push(`continuation.strategy: must be one of ${CONTINUATION_STRATEGIES.join(', ')}`);
    }
  }
  d.continuation = d.continuation || { strategy: 'none' };

  // ── Capabilities ──
  if (d.capabilities != null && !isObj(d.capabilities)) push('capabilities: must be object');
  d.capabilities = {
    execution: true,
    streaming: false,
    tokenReporting: 'estimated',
    synapseSandboxCompatible: true,
    supportsBypassPermissions: false,
    baseUrlOverride: null,
    ...(d.capabilities || {}),
  };
  if (!TOKEN_REPORTING.includes(d.capabilities.tokenReporting)) {
    push(`capabilities.tokenReporting: must be one of ${TOKEN_REPORTING.join(', ')}`);
  }

  // ── Identity / governance ──
  if (d.identity != null && !isObj(d.identity)) push('identity: must be object');
  d.identity = {
    mode: 'isolated',
    providers: [],
    promotionStatus: 'local-only',
    ...(d.identity || {}),
  };
  if (!IDENTITY_MODES.includes(d.identity.mode)) {
    push(`identity.mode: must be one of ${IDENTITY_MODES.join(', ')}`);
  }
  if (d.identity.mode === 'routable') {
    if (!Array.isArray(d.identity.providers) || d.identity.providers.length === 0) {
      push('identity.mode=routable requires at least one identity.providers entry');
    }
  }

  // ── Adapter (escape hatch — NAMED MODULE ONLY, never inline code) ──
  if (d.adapter != null) {
    if (!isObj(d.adapter)) push('adapter: must be object or null');
    else {
      if (!isStr(d.adapter.module)) push('adapter.module: required string (path or local:// URL)');
      if (!isStr(d.adapter.export)) push('adapter.export: required string (named export)');
      // hard rule: no inline code fields allowed
      for (const banned of ['script', 'code', 'eval', 'fn', 'callback']) {
        if (banned in d.adapter) {
          push(`adapter.${banned}: descriptors must NOT contain inline code; use adapter.module + adapter.export instead`);
        }
      }
    }
  }
  d.adapter = d.adapter || null;

  // ── Metadata ──
  if (d.defaultModels != null && !isStrArr(d.defaultModels)) {
    push('defaultModels: must be string array');
  }
  d.defaultModels = d.defaultModels || [];
  if (d.baseUrlEnv != null && !isStr(d.baseUrlEnv)) push('baseUrlEnv: must be string or null');
  d.baseUrlEnv = d.baseUrlEnv ?? null;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, descriptor: d };
}

/**
 * Probe whether a descriptor's binary is reachable on the current host.
 * Returns { found, path, version? }. Used at registration time to refuse
 * routable promotion when the binary doesn't actually resolve.
 *
 * This is a thin wrapper around the existing resolveBinary in src/agents/resolve-bin.js
 * — we duplicate the path-walking here so descriptor-schema.js stays in the harnesses
 * tree (no circular deps with agents/).
 */
export function probeBinary(desc) {
  for (const name of desc.binaries) {
    // Try as absolute / relative path first
    if (name.includes('/')) {
      const abs = expandHome(name);
      if (existsSync(abs)) return { found: true, path: abs };
    }
  }
  for (const fallback of desc.knownPaths) {
    const abs = expandHome(fallback);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return { found: true, path: abs };
    } catch { /* swallow */ }
  }
  return { found: false, path: null };
}
