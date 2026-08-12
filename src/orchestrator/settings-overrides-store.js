/**
 * Persistence for operator-tuned settings (pace, routing, circuit breaker,
 * tasks). The /api/settings PATCH endpoints historically mutated the live
 * config object only, so every tune silently reverted on restart. PATCH
 * handlers now write the override here; orchestrator startup loads and
 * re-applies it over config defaults (and pace overrides via
 * lifecycle.setPaceOverride once lifecycle exists).
 *
 * File shape (.synapse/settings-overrides.json):
 *   { pace: { provider: maxPerWindow|null },
 *     router: { enabled, localFirst, floorWeight, cost_weight },
 *     circuitBreaker: { failureThreshold, cooldownMs, maxFailureAgeMs },
 *     tasks: { pickupSlots, stuckSubtaskTimeoutMs, maxRequeues } }
 * Keys are stored config-shaped (e.g. cost_weight, not costWeight).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('settings-overrides');
const FILE = 'settings-overrides.json';

export function overridesPath(synapseDir) {
  return join(synapseDir, FILE);
}

export function loadSettingsOverrides(synapseDir) {
  try {
    return JSON.parse(readFileSync(overridesPath(synapseDir), 'utf8')) || {};
  } catch {
    return {};
  }
}

// Section names that must never be resolved against config, whatever a file on
// disk says. Reaching Object.prototype through config['__proto__'] and then
// Object.assign-ing a patch onto it is prototype pollution of the whole
// process. The own-property check below already excludes these (they are
// inherited, not own), but naming them makes the intent explicit and survives
// a future refactor that reaches for a different lookup.
const FORBIDDEN_SECTIONS = new Set(['__proto__', 'constructor', 'prototype']);

export function saveSettingsOverride(synapseDir, section, patch) {
  // Defence in depth. Every current caller passes a literal section name, so
  // this is not reachable today — but it keeps a future handler that forwards
  // a request-supplied name from writing a file that the boot path would then
  // have to defend against. The caller (api.js persistSettingsSection) already
  // try/catches, so this degrades to a logged warning, not a failed PATCH.
  if (FORBIDDEN_SECTIONS.has(section)) {
    throw new Error(`Refusing to persist reserved settings section '${section}'`);
  }
  const current = loadSettingsOverrides(synapseDir);
  current[section] = { ...(current[section] || {}), ...patch };
  const p = overridesPath(synapseDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2));
  renameSync(tmp, p);
  return current[section];
}

/**
 * Apply router/circuitBreaker/tasks sections onto the live config object.
 * Each section is applied independently inside a try/catch: a corrupt
 * overrides file or a re-frozen config section must degrade to defaults,
 * never crash-loop startup.
 */
// Sections whose config target is not simply config[name].
// Null prototype ON PURPOSE: a plain object inherits __proto__, constructor,
// toString... so SECTION_TARGETS['__proto__'] would resolve to Object.prototype
// — truthy, not callable — and calling it threw a TypeError out of the boot
// path. See applyConfigOverrides.
const SECTION_TARGETS = Object.assign(Object.create(null), {
  circuitBreaker: (c) => c.agents?.circuitBreaker,
});

// Re-applied by a different mechanism, so silence here is correct.
const HANDLED_ELSEWHERE = new Set(['pace']);

/**
 * Re-apply persisted overrides over config defaults at boot.
 *
 * This used to enumerate three section names explicitly, which meant a newly
 * added setting was written to settings-overrides.json by the PATCH endpoint
 * and then silently DROPPED on every restart — the operator saw the change
 * take effect, and saw it revert later with no error anywhere. Resolution is
 * now generic, and any section that cannot be matched is reported loudly
 * rather than ignored.
 */
export function applyConfigOverrides(config, overrides) {
  const applied = [];
  const unmatched = [];
  for (const [name, patch] of Object.entries(overrides || {})) {
    // EVERYTHING for one section sits inside the try. This function runs
    // unwrapped at orchestrator.js module scope, so anything that escapes here
    // is a boot crash-loop — precisely what the contract above forbids. The
    // section-target lookup used to sit outside it, and a hostile or corrupt
    // name threw straight past the guard.
    try {
      if (HANDLED_ELSEWHERE.has(name)) continue;
      if (FORBIDDEN_SECTIONS.has(name)) { unmatched.push(`${name} (forbidden)`); continue; }
      if (!patch || typeof patch !== 'object') continue;

      // OWN properties only. config['__proto__'] resolves to Object.prototype
      // through the prototype chain, and Object.assign onto that pollutes every
      // object in the process. An own-property check excludes that generically,
      // without needing to enumerate attack names.
      const resolver = Object.prototype.hasOwnProperty.call(SECTION_TARGETS, name)
        ? SECTION_TARGETS[name]
        : null;
      const target = resolver
        ? resolver(config)
        : (Object.prototype.hasOwnProperty.call(config, name) ? config[name] : undefined);
      if (!target || typeof target !== 'object') { unmatched.push(name); continue; }
      Object.assign(target, patch);
      // A frozen section accepts the assignment silently in sloppy mode, so
      // confirm the value actually landed rather than trusting the call.
      const key = Object.keys(patch)[0];
      if (key !== undefined && target[key] !== patch[key]) {
        unmatched.push(`${name} (frozen — value did not apply)`);
        continue;
      }
      applied.push(name);
    } catch (e) {
      log.warn('Failed to apply persisted settings override — using defaults for section', { section: name, error: e.message });
    }
  }
  if (unmatched.length) {
    log.warn('Persisted settings overrides could NOT be applied — the setting will appear to revert on restart',
      { sections: unmatched });
  }
  if (applied.length) log.info('Persisted settings overrides applied', { sections: applied });
  return applied;
}

/** Re-apply persisted pace overrides once lifecycle's setPaceOverride exists. */
export function applyPaceOverrides(overrides, setPaceOverride) {
  const pace = overrides.pace || {};
  let applied = 0;
  for (const [provider, maxPerWindow] of Object.entries(pace)) {
    try {
      setPaceOverride(provider, maxPerWindow);
      applied++;
    } catch (e) {
      log.warn('Failed to re-apply pace override', { provider, error: e.message });
    }
  }
  if (applied) log.info('Persisted pace overrides re-applied', { count: applied });
  return applied;
}
