// Harness config scanner — reads each installed harness's OWN config files
// to discover what the user has already wired up (providers, models, auth),
// so onboarding can offer first agents built from the exact identifiers the
// harness itself resolves. This kills the #1 setup foot-gun: hand-typed
// model strings that don't resolve (the agents-json-integrity incident
// class — a display name in the model field crashed an agent for 4 days).
//
// PRIVACY CONTRACT: this module NEVER returns secret material. Auth files
// are checked for existence and provider-name keys only; token/key VALUES
// are never read into the result. Anything returned here may be shown in
// the UI and must stay safe to render.
//
// BYOH positioning: Synapse plugs into what the user already configured —
// it does not install harnesses, run their auth flows, or edit their
// configs. Scan results are read-only observations.

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const HOME = homedir();
const expand = (p) => (p.startsWith('~/') ? join(HOME, p.slice(2)) : p);

function readJson(path) {
  try { return JSON.parse(readFileSync(expand(path), 'utf-8')); } catch { return null; }
}

function fileExists(path) {
  try { return existsSync(expand(path)); } catch { return false; }
}

/**
 * Scan all known harness config surfaces. Returns a map keyed by harness id:
 *   {
 *     authenticated: boolean|undefined       — credentials file present
 *     authenticatedProviders: string[]       — provider NAMES from auth stores (no values)
 *     configuredModels: [{ model, source }]  — exact harness-resolvable model ids
 *     ompInstalled: boolean (pi only)        — oh-my-pi package discoverable
 *   }
 * Missing/unreadable files simply yield absent fields — never throws.
 */
export function scanHarnessConfigs() {
  const out = {};

  // ── opencode ─────────────────────────────────────────────────────────
  // ~/.config/opencode/opencode.json holds user provider defs with model
  // lists in exactly the `<provider>/<model>` notation opencode dispatches.
  // ~/.local/share/opencode/auth.json keys are the authenticated providers.
  {
    const entry = {};
    const oc = readJson('~/.config/opencode/opencode.json');
    if (oc && oc.provider && typeof oc.provider === 'object') {
      const models = [];
      for (const [defId, def] of Object.entries(oc.provider)) {
        for (const modelId of Object.keys(def?.models || {})) {
          models.push({ model: `${defId}/${modelId}`, source: '~/.config/opencode/opencode.json' });
        }
      }
      if (models.length) entry.configuredModels = models;
    }
    const ocAuth = readJson('~/.local/share/opencode/auth.json');
    if (ocAuth && typeof ocAuth === 'object') {
      entry.authenticatedProviders = Object.keys(ocAuth);
      entry.authenticated = entry.authenticatedProviders.length > 0;
    }
    if (Object.keys(entry).length) out.opencode = entry;
  }

  // ── pi (and omp, which is pi + the oh-my-pi extension) ───────────────
  // ~/.pi/agent/models.json defines custom providers/models (the ONLY
  // custom-endpoint mechanism — pi ignores OPENAI_BASE_URL).
  // ~/.pi/agent/settings.json packages reveal the oh-my-pi extension.
  {
    const entry = {};
    const pm = readJson('~/.pi/agent/models.json');
    if (pm && pm.providers && typeof pm.providers === 'object') {
      const models = [];
      for (const [provId, prov] of Object.entries(pm.providers)) {
        for (const m of (Array.isArray(prov?.models) ? prov.models : [])) {
          if (m && m.id) models.push({ model: `${provId}/${m.id}`, source: '~/.pi/agent/models.json' });
        }
      }
      if (models.length) entry.configuredModels = models;
    }
    const piAuth = readJson('~/.pi/agent/auth.json');
    if (piAuth && typeof piAuth === 'object') {
      entry.authenticatedProviders = Object.keys(piAuth);
      entry.authenticated = entry.authenticatedProviders.length > 0;
    }
    const piSettings = readJson('~/.pi/agent/settings.json');
    entry.ompInstalled = Array.isArray(piSettings?.packages)
      && piSettings.packages.includes('npm:oh-my-pi');
    if (Object.keys(entry).length) out.pi = entry;
    // omp mirrors pi's model surface but is only offerable when installed.
    if (entry.ompInstalled) {
      out.omp = {
        ompInstalled: true,
        ...(entry.configuredModels ? { configuredModels: entry.configuredModels } : {}),
        ...(entry.authenticatedProviders ? { authenticatedProviders: entry.authenticatedProviders, authenticated: entry.authenticated } : {}),
      };
    }
  }

  // ── claude code ──────────────────────────────────────────────────────
  // Existence check ONLY — .credentials.json holds tokens; never parse it.
  if (fileExists('~/.claude/.credentials.json')) {
    out.claude = { authenticated: true };
  }

  // ── codex ────────────────────────────────────────────────────────────
  // auth.json existence + the `model = "…"` line from config.toml (regex —
  // no TOML dependency; the value is the exact id codex dispatches).
  {
    const entry = {};
    if (fileExists('~/.codex/auth.json')) entry.authenticated = true;
    try {
      const toml = readFileSync(expand('~/.codex/config.toml'), 'utf-8');
      const m = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (m) entry.configuredModels = [{ model: m[1], source: '~/.codex/config.toml' }];
    } catch { /* no config.toml — fine */ }
    if (Object.keys(entry).length) out.codex = entry;
  }

  // ── gemini ───────────────────────────────────────────────────────────
  if (fileExists('~/.gemini/oauth_creds.json')) {
    out.gemini = { authenticated: true };
  }

  return out;
}
