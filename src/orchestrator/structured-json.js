/**
 * Helpers for extracting/parsing structured JSON from LLM responses that may
 * include markdown fences or extra prose.
 */

function extractBalancedJson(text, openCh, closeCh, startIndex = 0) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let started = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (!started) {
      if (ch !== openCh) continue;
      started = true;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

export function extractStructuredJson(text, kind = 'array') {
  if (!text) return null;
  if (typeof text !== 'string') text = String(text);
  const openCh = kind === 'object' ? '{' : '[';
  const closeCh = kind === 'object' ? '}' : ']';
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of text.matchAll(fenceRe)) {
    const body = (m[1] || '').trim();
    const start = body.indexOf(openCh);
    if (start < 0) continue;
    const found = extractBalancedJson(body, openCh, closeCh, start);
    if (found) return found;
  }
  const start = text.indexOf(openCh);
  if (start < 0) return null;
  return extractBalancedJson(text, openCh, closeCh, start);
}

function repairJsonText(candidate) {
  if (typeof candidate !== 'string') return candidate;
  let out = candidate;
  // Remove trailing commas before closing delimiters: {"a":1,} / [1,2,]
  out = out.replace(/,\s*([}\]])/g, '$1');
  // Strip BOM / zero-width chars occasionally emitted around JSON blocks.
  out = out.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\u2060]/g, '');
  return out;
}

export function parseStructuredJson(text, kind = 'array') {
  const jsonText = extractStructuredJson(text, kind);
  if (!jsonText) {
    return { ok: false, reason: 'not_found', jsonText: null, value: null };
  }
  try {
    return { ok: true, repaired: false, jsonText, value: JSON.parse(jsonText) };
  } catch (error) {
    const repairedText = repairJsonText(jsonText);
    if (repairedText !== jsonText) {
      try {
        return { ok: true, repaired: true, jsonText: repairedText, value: JSON.parse(repairedText) };
      } catch (repairError) {
        return { ok: false, reason: 'invalid_json', jsonText, repairedText, error: repairError };
      }
    }
    return { ok: false, reason: 'invalid_json', jsonText, error };
  }
}

