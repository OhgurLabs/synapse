// Single source of truth for provider default models.
//
// Shared by the configuration and the setup wizard. Verify changed defaults
// through the corresponding provider CLI before updating this table.
// Keep this module dependency-free so both entry points can import it.
export const PROVIDER_DEFAULT_MODELS = Object.freeze({
  claude:   'claude-opus-5',
  codex:    'gpt-5.6-sol',
  gemini:   'gemini-3-flash-preview',
  glm:      'zai-coding-plan/glm-5.2',
  // opencode/ollama: the model id is whatever the user's config/server
  // defines — no meaningful global default.
  opencode: '',
  ollama:   '',
  // pi/omp/aider: BYOK across many providers — user supplies provider/model.
});
