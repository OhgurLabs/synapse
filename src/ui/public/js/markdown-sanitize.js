/**
 * Pure markdown/HTML helpers for the chat UI.
 * Safe to import from browser modules and from Node tests.
 */

/**
 * Escape HTML special characters. Never falls back to identity.
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str == null || str === false) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Allow only http(s) absolute URLs and path-absolute same-origin paths.
 * Rejects javascript:, data:, vbscript:, protocol-relative //, etc.
 * @param {string} href
 * @returns {boolean}
 */
export function isSafeHref(href) {
  if (typeof href !== 'string') return false;
  const trimmed = href.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  // Path-absolute, same origin (no scheme). Disallow //evil.com
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    // Block control chars and whitespace in path
    if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return false;
    // Block backslashes: browsers parse \ as / for http(s) URLs, so
    // '/\evil.com' resolves to https://evil.com/ — a cross-origin hop
    // dressed as a same-origin path.
    if (trimmed.includes('\\')) return false;
    return true;
  }
  // Absolute http(s) only
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Reject credentials in URL (user:pass@host)
  if (url.username || url.password) return false;
  return true;
}

/**
 * Render a markdown [label](href) as safe HTML.
 * Unsafe schemes become plain escaped text of the original markdown.
 * @param {string} label - already HTML-escaped label text
 * @param {string} href - raw href (may be entity-encoded from prior escapeHtml pass)
 * @returns {string}
 */
export function formatSafeMarkdownLink(label, href) {
  // reverse the most common entity encodings that escapeHtml applied to the URL
  const rawHref = String(href || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");

  if (!isSafeHref(rawHref)) {
    // Keep readable plain text; do not emit an anchor
    return `[${label}](${escapeHtml(rawHref)})`;
  }

  // Re-escape href for attribute context
  const safeAttr = escapeHtml(rawHref);
  return `<a href="${safeAttr}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * Apply link transform to already-escaped markdown HTML source.
 * @param {string} html
 * @returns {string}
 */
export function applySafeMarkdownLinks(html) {
  return String(html).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) =>
    formatSafeMarkdownLink(label, href)
  );
}
