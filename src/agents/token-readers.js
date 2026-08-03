// token-readers.js — Strategy library for extracting token counts from CLI output.
//
// Each function takes a normalized context object and returns
// { inputTokens, outputTokens, confidence } where confidence is 'exact'
// (we parsed real values) or 'estimated' (fell back to chars/4).
//
// This is the MAINTAINER-SHIPPED strategy library referenced by the
// descriptor schema's tokenSource.type field. Descriptors do not contain
// inline code — they reference one of these names and supply parameters
// (regex patterns, JSON field paths, disk file path templates, etc.)
//
// See src/harnesses/descriptor-schema.js for the schema contract and
// src/agents/cli-runner.js for the runner that dispatches to these.

import { readFileSync, existsSync } from 'fs';
import { estimateTokensFromText } from './token-parsing.js';
import { expandHome } from '../harnesses/descriptor-schema.js';

// ─── Utility: dotted-path access into nested objects ────────────────────────
function getPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// ─── Strategy 1: stderr-regex (claude pattern) ──────────────────────────────
// Source: stderr text. Tries multiple regex patterns to find "Input tokens: N"
// and "Output tokens: N"-style lines.
function readStderrRegex(ctx, source) {
  const stderr = ctx.stderr || '';
  if (!stderr || typeof stderr !== 'string') return null;

  const patterns = source.patterns || {
    input: [
      /Input\s+tokens?:?\s*(\d+)/i,
      /tokens?:?\s*(\d+)\s+input/i,
      /(\d+)\s+input.*token/i,
    ],
    output: [
      /Output\s+tokens?:?\s*(\d+)/i,
      /tokens?:?\s*(\d+)\s+output/i,
      /(\d+)\s+output.*token/i,
    ],
  };

  let inputTokens = null;
  let outputTokens = null;

  const tryPatterns = (text, patList) => {
    for (const pat of patList) {
      const m = text.match(pat);
      if (m && m[1]) return parseInt(m[1], 10);
    }
    return null;
  };

  inputTokens = tryPatterns(stderr, patterns.input || []);
  outputTokens = tryPatterns(stderr, patterns.output || []);

  if (inputTokens !== null && outputTokens !== null) {
    return { inputTokens, outputTokens, confidence: 'exact' };
  }
  return null;
}

// ─── Strategy 2: stdout-json-field (single JSON object response) ────────────
// Source: parses ctx.stdout once as JSON, reads dotted-path fields.
function readStdoutJsonField(ctx, source) {
  const stdout = ctx.stdout || '';
  if (!stdout) return null;
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  let inputTokens = source.inputField ? getPath(parsed, source.inputField) : null;
  let outputTokens = source.outputField ? getPath(parsed, source.outputField) : null;
  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    return { inputTokens, outputTokens, confidence: 'exact' };
  }
  return null;
}

// ─── Strategy 3: stdout-ndjson-event (codex-style event stream) ─────────────
// Source: ctx.stdout is line-delimited JSON. Looks for an event of a given
// type (default 'turn.completed') and reads tokens from a nested usage object.
function readStdoutNdjsonEvent(ctx, source) {
  const stdout = ctx.stdout || '';
  if (!stdout) return null;
  const eventType = source.eventType || 'turn.completed';
  const inputPath = source.inputField || 'usage.input_tokens';
  const outputPath = source.outputField || 'usage.output_tokens';

  let lastInput = null;
  let lastOutput = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || evt.type !== eventType) continue;
    const inVal = getPath(evt, inputPath);
    const outVal = getPath(evt, outputPath);
    if (typeof inVal === 'number') lastInput = inVal;
    if (typeof outVal === 'number') lastOutput = outVal;
  }
  if (lastInput !== null && lastOutput !== null) {
    return { inputTokens: lastInput, outputTokens: lastOutput, confidence: 'exact' };
  }
  return null;
}

// ─── Strategy 4: stdout-event-stream (opencode step_finish events) ──────────
// Source: ctx.stdout is line-delimited JSON of opencode events. The final
// step_finish event carries part.tokens.input / part.tokens.output.
function readStdoutEventStream(ctx, source) {
  const stdout = ctx.stdout || '';
  if (!stdout) return null;
  const eventType = source.eventType || 'step_finish';
  const inputPath = source.inputField || 'part.tokens.input';
  const outputPath = source.outputField || 'part.tokens.output';

  let inputTokens = null;
  let outputTokens = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || evt.type !== eventType) continue;
    const inVal = getPath(evt, inputPath);
    const outVal = getPath(evt, outputPath);
    if (typeof inVal === 'number') inputTokens = inVal;
    if (typeof outVal === 'number') outputTokens = outVal;
  }
  if (inputTokens !== null && outputTokens !== null) {
    return { inputTokens, outputTokens, confidence: 'exact' };
  }
  return null;
}

// ─── Strategy 5: disk-file (grok signals.json pattern) ──────────────────────
// Source: after dispatch, read a file at a path derived from the descriptor
// template + dispatch context (sessionId, cwd). Pull tokens from a configured
// field. Some CLIs (grok-build) report a combined "context tokens used" value
// rather than split input/output — supported via combinedField.
function readDiskFile(ctx, source) {
  if (!source.path) return null;
  // Substitute placeholders: ${sessionId}, ${cwd}, ${home}
  const sessionId = ctx.sessionId || '';
  const cwd = encodeURIComponent(ctx.workingDir || process.cwd());
  let path = source.path
    .replace(/\$\{sessionId\}/g, sessionId)
    .replace(/\$\{cwd\}/g, cwd);
  path = expandHome(path);
  if (!existsSync(path)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (source.combinedField) {
    const total = getPath(parsed, source.combinedField);
    if (typeof total === 'number') {
      // Grok-build reports total context tokens; split heuristically as input.
      // The accounting is "exact" for total but synthetic for input/output.
      return { inputTokens: total, outputTokens: 0, confidence: 'exact' };
    }
    return null;
  }
  const inputTokens = source.inputField ? getPath(parsed, source.inputField) : null;
  const outputTokens = source.outputField ? getPath(parsed, source.outputField) : null;
  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    return { inputTokens, outputTokens, confidence: 'exact' };
  }
  return null;
}

// ─── Strategy 5b: stdout-text-regex (aider's "Tokens: X sent, Y received") ─
// Source: ctx.stdout text. Apply user-supplied regex patterns to extract
// input + output token counts. Mirrors stderr-regex but reads stdout —
// needed for harnesses that print token info on stdout (aider, possibly
// future text-output CLIs).
//
// Descriptor fields:
//   tokenSource: {
//     type: 'stdout-text-regex',
//     inputRegex: 'Tokens:\\s+(\\d+(?:\\.\\d+)?[KkMm]?)\\s+sent',
//     outputRegex: '(\\d+(?:\\.\\d+)?[KkMm]?)\\s+received',
//   }
//
// Supports K/M suffixes (e.g. "1.2K" → 1200) since some CLIs use them.
function readStdoutTextRegex(ctx, source) {
  const stdout = ctx.stdout || '';
  if (!stdout || typeof stdout !== 'string') return null;
  const parseSuffixed = (s) => {
    if (!s) return null;
    const m = String(s).match(/^([\d.]+)([KkMm]?)$/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === 'K' || m[2] === 'k') n *= 1000;
    else if (m[2] === 'M' || m[2] === 'm') n *= 1000000;
    return Math.round(n);
  };
  const tryPattern = (text, patternStr) => {
    if (!patternStr) return null;
    try {
      const re = new RegExp(patternStr, 'i');
      const m = text.match(re);
      return m && m[1] ? parseSuffixed(m[1]) : null;
    } catch { return null; }
  };
  const inputTokens = tryPattern(stdout, source.inputRegex);
  const outputTokens = tryPattern(stdout, source.outputRegex);
  if (inputTokens !== null && outputTokens !== null) {
    return { inputTokens, outputTokens, confidence: 'exact' };
  }
  return null;
}

// ─── Strategy 6: estimate (always-available fallback) ──────────────────────
function readEstimate(ctx /*, source */) {
  const inText = ctx.inputText || ctx.message || '';
  const outText = ctx.outputText || '';
  return {
    inputTokens: estimateTokensFromText(inText),
    outputTokens: estimateTokensFromText(outText),
    confidence: 'estimated',
  };
}

// ─── Dispatch table ─────────────────────────────────────────────────────────
const STRATEGIES = {
  'stderr-regex': readStderrRegex,
  'stdout-text-regex': readStdoutTextRegex,
  'stdout-json-field': readStdoutJsonField,
  'stdout-ndjson-event': readStdoutNdjsonEvent,
  'stdout-event-stream': readStdoutEventStream,
  'disk-file': readDiskFile,
  'estimate': readEstimate,
};

/**
 * Read tokens from a CLI dispatch using the strategy named in
 * descriptor.tokenSource.type. Falls back to 'estimate' when the named
 * strategy returns null (no data found).
 *
 * @param {object} ctx - { stdout, stderr, workingDir, sessionId, message, outputText }
 * @param {object} tokenSource - the descriptor.tokenSource block
 * @returns { inputTokens, outputTokens, confidence }
 */
export function readTokens(ctx, tokenSource) {
  if (!tokenSource || !tokenSource.type) {
    return readEstimate(ctx);
  }
  const fn = STRATEGIES[tokenSource.type];
  if (!fn) return readEstimate(ctx);
  const result = fn(ctx, tokenSource);
  if (result) return result;
  return readEstimate(ctx);
}

export const REGISTERED_TOKEN_STRATEGIES = Object.freeze(Object.keys(STRATEGIES));
