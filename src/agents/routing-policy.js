// Instance-level transport restrictions, checked before any CLI dispatch.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function loadRoutingPolicy(projectDir) {
  let raw;
  try {
    raw = readFileSync(join(projectDir, '.synapse', 'routing-policy.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const policy = JSON.parse(raw);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || policy.geminiTransport !== 'antigravity-only') {
    throw new Error('Invalid routing policy: geminiTransport must be "antigravity-only".');
  }
  return policy;
}

export function assertGeminiTransport(agent, policy) {
  if (policy.geminiTransport !== 'antigravity-only') return;
  const harness = agent.descriptor?.id;
  const model = String(agent.model || '').trim();
  const modelIsGemini = value => /^google(?:-gemini-cli|-generative-ai)?\//.test(value)
    || /^gemini(?:[-_. :\d]|$)/i.test(value.split('/').at(-1));
  const extraArgs = agent.cliArgs || [];
  let overrideSelectsGemini = false;
  let incompleteOverride = false;
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i];
    const flag = /^(--model|--provider|-m)$/.exec(arg);
    const attached = /^(--model=|--provider=|-m)(.*)$/.exec(arg);
    if (!flag && !attached) continue;
    const value = flag ? extraArgs[++i] : attached[2];
    if (!value || value.startsWith('-')) { incompleteOverride = true; continue; }
    if ((flag?.[1] === '--provider' || attached?.[1] === '--provider=')
        ? ['google', 'google-gemini-cli', 'gemini'].includes(value)
        : modelIsGemini(value)) overrideSelectsGemini = true;
  }
  const binary = basename(agent.cliPath || agent._defaultCliPath || '').toLowerCase();
  const gemini = ['gemini', 'google', 'google-gemini-cli'].includes(agent.provider)
    || ['gemini', 'gemini-cli'].includes(harness)
    || ['gemini', 'gemini.exe'].includes(binary)
    || modelIsGemini(model) || overrideSelectsGemini || incompleteOverride;
  if (!gemini) return;

  const ompAntigravity = harness === 'omp'
    && model.startsWith('google-antigravity/') && ['omp', 'omp.exe'].includes(binary);
  const nativeAntigravity = harness === 'antigravity'
    && ['agy', 'agy.exe', 'antigravity', 'antigravity.exe'].includes(binary);
  // Extra config/provider/model flags can replace the descriptor's route.
  const routeOverride = extraArgs.some(arg =>
    /^(?:--(?:model|provider|config|extension|plugin-dir|api-key)(?:=|$)|-m|-e)/.test(arg));
  if ((!ompAntigravity && !nativeAntigravity) || routeOverride) {
    const error = new Error('Gemini dispatch blocked: this instance requires Antigravity. Use omp with google-antigravity/<model> or the Antigravity CLI, without transport overrides.');
    error.code = 'GEMINI_TRANSPORT_BLOCKED';
    throw error;
  }
}
