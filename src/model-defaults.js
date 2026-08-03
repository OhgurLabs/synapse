// Single source of truth for provider default models.
//
// Consumed by BOTH src/config.js (agents.defaults → onboarding offers +
// wrapper-agent fallbacks) and src/cli.js (wizard DEFAULT_MODELS). These
// used to be two hand-maintained tables and they drifted: config.js served
// gpt-5.3-codex / claude-opus-4-6 while the wizard served the live-probed
// current ids — the stale copy surfaced in onboarding offers and failed the
// agent's first dispatch ("model not recognized", staging validation 2026-08-01).
//
// Update HERE only, and live-probe through the actual CLI before changing
// (assess → approve → probe → apply). Deliberately dependency-free so the
// CLI can import it without dragging in the config runtime.
export const PROVIDER_DEFAULT_MODELS = Object.freeze({
  claude:   'claude-opus-5',      // probed 2026-08-01: live on enclave roster
  codex:    'gpt-5.6-sol',        // probed 2026-08-01: CODEX_56_OK on staging
  gemini:   'gemini-3-flash-preview',
  glm:      'zai-coding-plan/glm-5.2',
  // opencode/ollama: the model id is whatever the user's config/server
  // defines — no meaningful global default.
  opencode: '',
  ollama:   '',
  // pi/omp/aider: BYOK across many providers — user supplies provider/model.
});
