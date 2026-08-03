// response-parsers.js — Strategy library for extracting response text + sessionId
// from CLI output. Maintainer-shipped, closed library referenced by
// descriptor.responseSource.
//
// Each function takes a ctx ({ stdout, stderr }) + descriptor params and
// returns { text, sessionId?, error? }. The runner combines this with the
// token-reader output to produce the final ResponseObject.

// ─── Utility: dotted-path access ────────────────────────────────────────────
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

// ─── Strategy 1: stdout-text (plain text) ───────────────────────────────────
function parseStdoutText(ctx /*, desc */) {
  const stdout = (ctx.stdout || '').trim();
  return { text: stdout, sessionId: null, error: null };
}

// ─── Strategy 2: stdout-text-regex (text with line filtering) ───────────────
function parseStdoutTextRegex(ctx, desc) {
  let stdout = ctx.stdout || '';
  const cleanLines = desc.responseCleanLines || [];
  if (cleanLines.length > 0) {
    const lines = stdout.split('\n');
    const filtered = lines.filter((line) =>
      !cleanLines.some((needle) => line.includes(needle))
    );
    stdout = filtered.join('\n');
  }
  return { text: stdout.trim(), sessionId: null, error: null };
}

// ─── Strategy 3: stdout-json (single JSON object response, grok-style) ─────
// stdout is one JSON object. Pulls text from descriptor.responseTextField
// (default 'text') and sessionId from descriptor.continuation.sessionIdSource.
function parseStdoutJson(ctx, desc) {
  const stdout = (ctx.stdout || '').trim();
  if (!stdout) return { text: '', sessionId: null, error: null };
  let parsed;
  try { parsed = JSON.parse(stdout); } catch (e) {
    return { text: stdout, sessionId: null, error: null };
  }
  const textField = desc.responseTextField || 'text';
  const text = getPath(parsed, textField);

  // Session ID extraction
  let sessionId = null;
  const sidSrc = desc.continuation && desc.continuation.sessionIdSource;
  if (sidSrc && sidSrc.type === 'stdout-json' && sidSrc.field) {
    sessionId = getPath(parsed, sidSrc.field);
  }

  // Top-level error or non-terminal stopReason — surface a useful signal.
  // Grok exits 1 with stopReason='Cancelled' when it hits --max-turns; that
  // shows up here as text='' + no error. The bespoke 4 classes never had this
  // case because they all used different parsers. Without this enrichment,
  // synapse logs "empty response from grok" — useless for the operator. With
  // it, operators see "stopReason=Cancelled" and can raise max-turns or
  // adjust the prompt.
  const textStr = typeof text === 'string' ? text : '';
  let error = null;
  if (parsed.error) {
    error = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error));
  } else if (parsed.stopReason && parsed.stopReason !== 'EndTurn' && !textStr) {
    error = `stopReason=${parsed.stopReason}`;
  }

  return {
    text: textStr,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    error,
  };
}

// ─── Strategy 4: stdout-ndjson (codex-style event log) ──────────────────────
// Each line is a JSON event. The "agent_message" or "item.completed/agent_message"
// event carries the text. The runner only needs the final text, accumulated
// across events of the right type. Schema:
//   { eventType: 'item.completed', textPath: 'item.text', itemTypeField: 'item.type', itemTypeValue: 'agent_message' }
function parseStdoutNdjson(ctx, desc) {
  const stdout = ctx.stdout || '';
  const cfg = (desc.responseParserConfig && desc.responseParserConfig.ndjson) || {};
  const eventType = cfg.eventType || 'item.completed';
  const itemTypeField = cfg.itemTypeField || 'item.type';
  const itemTypeValue = cfg.itemTypeValue || 'agent_message';
  const textPath = cfg.textPath || 'item.text';

  let lastText = '';
  let error = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt) continue;
    if (evt.type === eventType) {
      const itType = getPath(evt, itemTypeField);
      if (itType === itemTypeValue) {
        const t = getPath(evt, textPath);
        if (typeof t === 'string' && t.length > 0) lastText = t;
      }
    }
    if (evt.type === 'error' || evt.error) {
      const eMsg = evt.error?.message || evt.error || evt.message || null;
      if (eMsg) error = String(eMsg);
    }
  }
  return { text: lastText, sessionId: null, error };
}

// ─── Strategy 5b: stdout-text-marker (aider-style structured-text output) ─
// stdout is plain text with structural markers like:
//   ...banner...
//   ► **THINKING**
//   ...inner thought...
//   ► **ANSWER**
//   <the actual answer the operator wants>
//   Tokens: N sent, M received.
//
// Extract the text BETWEEN startMarker and endMarker (or to end-of-string
// if endMarker is null). cleanLines (line-substring filtering) optionally
// further trims noise inside the extracted block.
//
// Descriptor fields:
//   responseSource: 'stdout-text-marker'
//   responseStartMarker: '► **ANSWER**'   (required — substring that marks block start)
//   responseEndMarker:   'Tokens:'         (optional — substring that marks block end)
//   responseCleanLines:  [...]             (optional — line-substring filter for inside)
function parseStdoutTextMarker(ctx, desc) {
  const stdout = ctx.stdout || '';
  const startMarker = desc.responseStartMarker;
  const endMarker = desc.responseEndMarker; // optional
  if (!startMarker) return { text: stdout.trim(), sessionId: null, error: null };

  const startIdx = stdout.indexOf(startMarker);
  if (startIdx === -1) {
    // start marker not found — fall back to whole stdout (don't lose data)
    return { text: stdout.trim(), sessionId: null, error: null };
  }
  let blockStart = startIdx + startMarker.length;
  let blockEnd = stdout.length;
  if (endMarker) {
    const endIdx = stdout.indexOf(endMarker, blockStart);
    if (endIdx !== -1) blockEnd = endIdx;
  }
  let block = stdout.slice(blockStart, blockEnd);

  // Optional line-level cleanup inside the extracted block
  const cleanLines = desc.responseCleanLines || [];
  if (cleanLines.length > 0) {
    const lines = block.split('\n');
    block = lines.filter((line) =>
      !cleanLines.some((needle) => line.includes(needle))
    ).join('\n');
  }
  return { text: block.trim(), sessionId: null, error: null };
}

// ─── Strategy 6: stdout-event-stream (opencode-style events) ───────────────
// Accumulates `text` events' `part.text` field. Surfaces `error` events.
// Pulls tokens from `step_finish` events (handled separately by token-reader).
function parseStdoutEventStream(ctx /*, desc */) {
  const stdout = ctx.stdout || '';
  let text = '';
  let error = null;
  let sessionId = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || !evt.type) continue;
    if (evt.type === 'text') {
      const t = evt.part?.text;
      if (typeof t === 'string') text += t;
      if (!sessionId && evt.sessionID) sessionId = evt.sessionID;
    } else if (evt.type === 'error') {
      const eMsg = evt.error?.data?.message || evt.error?.name || null;
      if (eMsg) error = String(eMsg);
    } else if (evt.type === 'step_start' && evt.sessionID && !sessionId) {
      sessionId = evt.sessionID;
    }
  }
  return { text, sessionId, error };
}

// ─── Dispatch table ─────────────────────────────────────────────────────────
const STRATEGIES = {
  'stdout-text': parseStdoutText,
  'stdout-text-regex': parseStdoutTextRegex,
  'stdout-text-marker': parseStdoutTextMarker,
  'stdout-json': parseStdoutJson,
  'stdout-ndjson': parseStdoutNdjson,
  'stdout-event-stream': parseStdoutEventStream,
};

/**
 * Parse a CLI dispatch's stdout/stderr into a response payload.
 * @param {object} ctx - { stdout, stderr }
 * @param {object} desc - the full harness descriptor
 * @returns { text, sessionId, error }
 */
export function parseResponse(ctx, desc) {
  const strat = STRATEGIES[desc.responseSource];
  if (!strat) {
    // Fall back to plain text — never throw, never return undefined.
    return parseStdoutText(ctx, desc);
  }
  return strat(ctx, desc);
}

export const REGISTERED_RESPONSE_PARSERS = Object.freeze(Object.keys(STRATEGIES));
