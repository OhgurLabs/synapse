// Thread classification engine — keyword-based Jaccard similarity, no LLM calls
import config from './config.js';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her',
  'was', 'one', 'our', 'out', 'has', 'have', 'been', 'from', 'will', 'with',
  'they', 'this', 'that', 'what', 'when', 'make', 'like', 'just', 'over', 'such',
  'take', 'than', 'them', 'very', 'some', 'could', 'would', 'into', 'about',
  'other', 'their', 'which', 'there', 'these', 'then', 'also', 'more', 'only',
  'come', 'its', 'being', 'those', 'after', 'most', 'should', 'how', 'does',
  'each', 'much', 'because', 'here', 'between', 'need', 'think', 'know',
  'want', 'let', 'use', 'try', 'get', 'got', 'did', 'doing', 'done', 'going',
  'yes', 'yeah', 'sure', 'okay', 'right', 'well', 'good', 'great', 'thanks',
  'please', 'look', 'see', 'say', 'said', 'something', 'things', 'thing',
  'way', 'work', 'now', 'still', 'really', 'actually', 'maybe', 'might',
  // Provider/product names — appear in every message, zero discriminative value
  'claude', 'codex', 'gemini', 'ollama', 'system', 'synapse',
]);

const JACCARD_THRESHOLD = config.threading.jaccardThreshold;
const MIN_TOKEN_LENGTH = config.threading.minTokenLength;
const DEFAULT_THREAD_LABEL_MAX = config.threading.labelMaxLength;
const THREAD_LABEL_SOFT_OVERFLOW = config.threading.labelSoftOverflow;
const CONTINUATION_CUE_RE = /\b(we were discussing|as discussed|back to|continue|continuing|still on|pick up|resume|same issue|that issue|sounds like we|we have consensus|consensus on|agreed on|as we said|following up|to summarize|let's proceed|get this done)\b/i;

// Roster agent names, filtered like stop words. Agent names are user-defined
// so a static list can't know them; the orchestrator registers the live
// roster here at boot and on roster changes. Bare-name references ("ask
// the reviewer agent about it") appear constantly and would inflate keyword similarity
// across unrelated threads — the @mention strip below only catches the
// @-prefixed form.
let AGENT_STOP_WORDS = new Set();

/**
 * Register the current roster's agent names for stop-word filtering.
 * Pass the full list each time (replaces, not merges) so removed agents
 * drop out. Names are matched case-insensitively.
 */
export function setAgentStopWords(names) {
  AGENT_STOP_WORDS = new Set([...names].map(n => String(n).toLowerCase()));
}

/**
 * Tokenize text into a set of meaningful keywords.
 */
function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/@\w+/g, '') // Strip @mentions — they appear in every message
      .split(/[\s\p{P}]+/u)
      .filter(t => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t) && !AGENT_STOP_WORDS.has(t))
  );
}

function getMostRecentThread(activeThreads) {
  if (!activeThreads || activeThreads.length === 0) return null;
  return activeThreads.reduce((a, b) =>
    new Date(b.lastActivity) > new Date(a.lastActivity) ? b : a
  );
}

function hasContinuationCue(text) {
  return CONTINUATION_CUE_RE.test(String(text || ''));
}

/**
 * Jaccard similarity between two sets.
 */
function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Generate a thread ID from text content.
 * Format: thread_{timestamp}_{slug}
 */
export function generateThreadId(text) {
  const tokens = text
    .toLowerCase()
    .replace(/@\w+/g, '') // Strip @mentions for cleaner slugs
    .split(/[\s\p{P}]+/u)
    .filter(t => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t))
    .slice(0, config.threading.slugMaxTokens);
  const slug = tokens.join('-') || 'general';
  return `thread_${Date.now()}_${slug}`;
}

/**
 * Build a UI-safe thread label without cutting words mid-token.
 * Keeps labels readable and avoids semantic corruption (e.g. "zero" -> "zer").
 */
export function buildThreadLabel(text, maxLength = DEFAULT_THREAD_LABEL_MAX) {
  const cleaned = String(text || '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return 'New thread';
  if (cleaned.length <= maxLength) return cleaned;
  if (cleaned.length - maxLength <= THREAD_LABEL_SOFT_OVERFLOW) return cleaned;

  let truncated = cleaned.slice(0, maxLength).trimEnd();
  if (cleaned[maxLength] && truncated && !/\s$/.test(cleaned.slice(0, maxLength))) {
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 0) truncated = truncated.slice(0, lastSpace).trimEnd();
  }

  return `${truncated}...`;
}

/**
 * Bound an explicitly-supplied thread label.
 *
 * Thread labels are interpolated into the TRUSTED region of every agent's
 * system prompt for that thread (orchestrator/context.js: ` Thread: "<label>".`),
 * outside the [USER_INPUT_START]/[USER_INPUT_END] markers that fence user text.
 *
 * Auto-created labels go through buildThreadLabel(), which caps length. Labels
 * typed as `/thread start <args>` did not, so a single long command pinned an
 * arbitrarily large string into EVERY prompt in that thread, for the life of
 * the thread. Measured: a 4000-character label was stored verbatim where the
 * auto path produced 63.
 *
 * Length only. Unlike buildThreadLabel this deliberately preserves punctuation,
 * because an explicit label is a deliberate choice and stripping it would turn
 * `Bug #123: fix "foo"` into `Bug 123 fix foo`. Newlines cannot appear here:
 * parseThreadCommand's regex has no `s` or `m` flag, so a multi-line
 * `/thread start` does not parse at all — verified.
 */
export function capThreadLabel(label, maxLength = DEFAULT_THREAD_LABEL_MAX) {
  const trimmed = String(label ?? '').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength).trimEnd()}...`;
}

/**
 * Classify a message against active threads using keyword overlap.
 * Returns { threadId, confidence, isNew }
 */
export function classifyThread(text, activeThreads) {
  const tokens = tokenize(text);
  const mostRecent = getMostRecentThread(activeThreads);

  // Continuation cues should stick to the latest active thread in auto mode.
  // This avoids accidental thread fragmentation for redirects like:
  // "we were discussing X..." or "back to the previous issue".
  if (hasContinuationCue(text) && mostRecent) {
    return { threadId: mostRecent.id, confidence: 0.6, isNew: false };
  }

  // Short messages (< 2 meaningful tokens): fall back to most recently active thread
  // instead of creating accidental new threads for "yes", "ok", "do it", etc.
  if (tokens.size < config.threading.shortMessageThreshold && mostRecent) {
    return { threadId: mostRecent.id, confidence: 0.5, isNew: false };
  }
  if (tokens.size === 0) return { threadId: null, confidence: 0, isNew: true };

  let bestThread = null;
  let bestScore = 0;

  for (const thread of activeThreads) {
    const threadKeywords = new Set(thread.keywords || []);
    const score = jaccard(tokens, threadKeywords);

    // Anti-absorption check: if the thread has grown large (many dynamic keywords),
    // also check overlap with anchor keywords. Long threads absorb many terms and
    // produce false positive matches. If there's zero overlap with the original
    // topic anchors, this is likely a new topic regardless of dynamic keyword overlap.
    const anchors = new Set(thread.anchorKeywords || []);
    let anchorOverlap = 0;
    if (anchors.size > 0) {
      for (const t of tokens) { if (anchors.has(t)) anchorOverlap++; }
    }
    const hasAnchorMatch = anchors.size === 0 || anchorOverlap > 0;

    if (score > bestScore && hasAnchorMatch) {
      bestScore = score;
      bestThread = thread;
    }
  }

  if (bestScore >= JACCARD_THRESHOLD && bestThread) {
    return { threadId: bestThread.id, confidence: bestScore, isNew: false };
  }

  return { threadId: null, confidence: bestScore, isNew: true };
}

/**
 * Update a thread's keyword set with new message tokens.
 * Anchor keywords (from thread creation) are permanent and can't be evicted.
 * Dynamic keywords cap at 80 to prevent unbounded growth.
 */
export function updateThreadKeywords(thread, messageText, isAnchor = false) {
  const newTokens = tokenize(messageText);
  const anchors = new Set(thread.anchorKeywords || []);
  const dynamic = new Set((thread.keywords || []).filter(k => !anchors.has(k)));

  if (isAnchor) {
    // First message — these keywords define the thread's identity
    for (const token of newTokens) anchors.add(token);
    return { keywords: [...anchors, ...dynamic], anchorKeywords: [...anchors] };
  }

  // Subsequent messages — add as dynamic keywords
  for (const token of newTokens) {
    if (!anchors.has(token)) dynamic.add(token);
  }
  // Cap dynamic keywords (anchors are always preserved)
  const dynamicArr = [...dynamic].slice(-config.threading.dynamicKeywordsCap);
  return { keywords: [...anchors, ...dynamicArr], anchorKeywords: [...anchors] };
}

/**
 * Parse /thread commands from user input.
 * Returns { command, args } or null if no thread command.
 *
 * Supported:
 *   /thread start [label]  — create a new thread
 *   /thread switch <slug>  — switch to an existing thread
 *   /thread list           — list active threads
 *   /thread end            — end/close the active thread
 *   /thread auto           — return to auto-classification
 */
export function parseThreadCommand(text) {
  const match = text.trim().match(/^\/thread\s+(\w+)(?:\s+(.+))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = match[2]?.trim() || null;
  if (!['start', 'switch', 'list', 'end', 'auto'].includes(command)) return null;
  return { command, args };
}

/**
 * Main entry point: resolve which thread a message belongs to.
 *
 * Priority:
 *   1. /thread command (highest)
 *   2. replyTo inheritance
 *   3. Channel's pinned active thread
 *   4. Auto-classify against active threads
 *   5. Create new thread
 *
 * Returns { threadId, isNew, isCommand, command }
 */
export function resolveThread(text, activeThreads, { replyToThreadId = null, channelActiveThread = null } = {}) {
  // 1. /thread command
  const cmd = parseThreadCommand(text);
  if (cmd) {
    return { threadId: null, isNew: false, isCommand: true, command: cmd };
  }

  // 2. replyTo inheritance
  if (replyToThreadId) {
    return { threadId: replyToThreadId, isNew: false, isCommand: false, command: null };
  }

  // 3. Channel's pinned active thread (set by /thread switch or /thread start)
  if (channelActiveThread) {
    return { threadId: channelActiveThread, isNew: false, isCommand: false, command: null };
  }

  // 4. Auto-classify
  const classification = classifyThread(text, activeThreads);
  if (!classification.isNew && classification.threadId) {
    return { threadId: classification.threadId, isNew: false, isCommand: false, command: null };
  }

  // 5. New thread
  const newId = generateThreadId(text);
  return { threadId: newId, isNew: true, isCommand: false, command: null };
}

export { tokenize, jaccard, JACCARD_THRESHOLD, hasContinuationCue };
