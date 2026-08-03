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

export function saveSettingsOverride(synapseDir, section, patch) {
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
export function applyConfigOverrides(config, overrides) {
  const applied = [];
  const tryApply = (name, target, patch) => {
    if (!patch || !target) return;
    try {
      Object.assign(target, patch);
      applied.push(name);
    } catch (e) {
      log.warn('Failed to apply persisted settings override — using defaults for section', { section: name, error: e.message });
    }
  };
  tryApply('router', config.router, overrides.router);
  tryApply('circuitBreaker', config.agents?.circuitBreaker, overrides.circuitBreaker);
  tryApply('tasks', config.tasks, overrides.tasks);
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
