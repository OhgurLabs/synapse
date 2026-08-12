/**
 * Path-safe ID validation shared across stores that join IDs into filesystem paths.
 *
 * Callers that build `.synapse/projects/{projectId}/…` (or agent dirs) must reject
 * `..`, slashes, and other unsafe characters before join(). Prefer this module over
 * ad-hoc regexes so max length and charset stay consistent.
 *
 * Note: StateManager.validateId also consults config.state.maxIdLength; the default
 * there is 100. We hardcode the same cap here to avoid a config import cycle from
 * leaf stores.
 */

export const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
export const MAX_SAFE_ID_LEN = 100;

/**
 * @param {unknown} id
 * @param {string} [label]
 * @returns {string} the same id if valid
 * @throws {Error} when id is missing, wrong type, overlong, or charset-unsafe
 */
export function assertSafeId(id, label = 'ID') {
  if (
    !id ||
    typeof id !== 'string' ||
    !SAFE_ID_RE.test(id) ||
    id.length > MAX_SAFE_ID_LEN
  ) {
    throw new Error(
      `Invalid ${label}: "${String(id).slice(0, 80)}" — alphanumeric/hyphens/underscores only, max ${MAX_SAFE_ID_LEN} chars`,
    );
  }
  return id;
}

/** @param {unknown} projectId */
export function assertSafeProjectId(projectId) {
  return assertSafeId(projectId, 'project ID');
}
