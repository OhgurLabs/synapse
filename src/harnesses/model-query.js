// Live model discovery — ask the harness ITSELF what models it can serve,
// instead of trusting static tables. Static defaults rot (gpt-5.3-codex
// shipped as an onboarding offer and failed first dispatch); the harness's
// own answer can't.
//
// Only some harnesses are queryable:
//   opencode  → `opencode models` prints agent-ready provider/model lines
//   pi / omp  → `pi --list-models --offline` prints a provider+model table
//               (--offline is LOAD-BEARING: without it pi fetches models.dev
//               at startup and hangs on egress-denied networks)
// claude / codex / gemini expose no list command — callers fall back to the
// descriptor's defaultModels (kept current in src/model-defaults.js).
//
// Results are cached briefly per process: these spawn real CLIs and the
// onboarding UI may ask for several harnesses in quick succession.

import { execFileSync } from 'child_process';

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // harnessId -> { at, models }

function run(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function parseOpencode(out) {
  // One provider/model per line, already in dispatch notation.
  return out.split('\n').map(l => l.trim()).filter(l => /^[\w.-]+\/.+$/.test(l));
}

function parsePi(out) {
  // Table: header line then rows "provider  model  context ...". Join the
  // first two columns into provider/model notation.
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  const models = [];
  for (const line of lines) {
    if (/^provider\s+model/i.test(line)) continue;
    const cols = line.split(/\s{2,}/);
    if (cols.length >= 2 && /^[\w.-]+$/.test(cols[0])) models.push(`${cols[0]}/${cols[1]}`);
  }
  return models;
}

const QUERIES = {
  opencode: () => { const o = run('opencode', ['models']); return o ? parseOpencode(o) : null; },
  pi:       () => { const o = run('pi', ['--list-models', '--offline']); return o ? parsePi(o) : null; },
  omp:      () => QUERIES.pi(), // same binary — same model surface
};

/**
 * Query a harness for its live model list. Returns { models, source } where
 * source is 'queried' on success or null result when the harness has no
 * query command / the command failed (caller falls back to static defaults).
 */
export function queryHarnessModels(harnessId) {
  const q = QUERIES[harnessId];
  if (!q) return null;
  const hit = cache.get(harnessId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { models: hit.models, source: 'queried' };
  const models = q();
  if (!models || models.length === 0) return null;
  cache.set(harnessId, { at: Date.now(), models });
  return { models, source: 'queried' };
}
