import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';
import { setAgentThinking, setAgentIdle } from './health-aggregator.js';
import { CATEGORIES } from '../utils/error-registry.js';
import { startSpan, endSpan, setSpanStatus, addSpanEvent } from '../tracing.js';
import { computeBackoffWithJitter } from '../utils/backoff.js';
import { toProviderError } from '../utils/provider-error.js';

const log = createLogger('agent-interaction');

const RETRY_CONFIG = {
  maxRetries: 3,
  initialBackoffMs: 500,
  maxBackoffMs: 20000,
};

// --- Fallback/Handoff State ---
// Tracks agents temporarily unavailable and who was selected as handoff target.
// Keys: agentName -> { active, originalModel, currentModel, currentProvider, reason, handoffTo }
const fallbackStates = new Map();

// Rate limit cooldown — agents that hit rate limits are skipped until cooldown expires
// Keys: agentName → { until: timestamp, model?: string, reason: string }
// Each provider has different rate limit semantics:
//   - Codex: Single shared bucket for all models + web (propagate per-provider)
//   - Claude: Multiple buckets (Sonnet, all-model, 5-hour, weekly) - NOT per-model
//   - Gemini: Per-model rate limits, web separate from models (NO propagation)
// Model-not-found errors must NOT be treated as rate limits — they are permanent config errors.
const MODEL_NOT_FOUND_RE = /ModelNotFoundError|model.?not.?found|Requested entity was not found/i;
const RATE_LIMIT_RE = /you've hit your(?: usage)? limit|rate limit exceeded|too many requests.*retry|HTTP 429.*retry|status 429|429.*resource_exhausted|exceeded.*quota|quota exceeded|terminal.?quota.?error|exhausted your capacity on this model|limit.*exhausted|try again at \d{1,2}:\d{2}|resets \d{1,2}(?:am|pm)|reset(?:s)? after \d+[hms]|error_code.*130[25]|code.?:.?1302|code.?:.?1305/i;
const TRANSIENT_ERROR_RE = /service unavailable|overloaded|try again later|503|upstream request timeout/i;
// NOTE: This regex intentionally excludes patterns that appear in status/usage output
// to avoid false positives from Codex showing "weekly limit: 70% left" or "resets 16:22"
// as rate limit errors. Only match actual error messages, not informational status.
const HANDOFF_MAX_HOPS = 2;

// Rate limit bucket semantics: cooldowns propagate per provider/model/agent depending on bucket type
// Each provider has different bucket granularity:
//   - Codex: provider-wide bucket (all codex agents share one ChatGPT Plus subscription pool)
//   - Claude: per-model bucket (opus vs sonnet are separate buckets)
//   - Gemini: per-agent bucket (each Gemini agent has independent limits)
//   - GLM: provider-wide bucket (all GLM agents share 5h and weekly limits)
//
// cooldownByReason: when the CB trips, the cooldown duration is selected by the
// dominant failure reason in the recent failure window, NOT a single fallback.
// This prevents 10-minute cloud blips (timeout/empty_response) from triggering
// the 5-hour quota-reset cooldown reserved for actual parsed rate-limit messages.
// fallbackCooldownMs: kept for backward compat when reason is missing/unknown.
const RATE_LIMIT_SEMANTICS = Object.freeze({
  codex: {
    propagate: 'provider',
    fallbackCooldownMs: 60 * 60 * 1000,
    cooldownByReason: {
      rate_limit:     60 * 60 * 1000,   // 1h — parsed quota reset (ChatGPT Plus daily/weekly)
      timeout:        15 * 60 * 1000,   // 15m — codex subprocess hang/SIGKILL
      empty_response: 10 * 60 * 1000,   // 10m — codex returned no content
      transient:       5 * 60 * 1000,   // 5m  — 503/overloaded
      auth_error:      5 * 60 * 1000,   // 5m  — surface fast for operator
      unknown:        30 * 60 * 1000,   // 30m — defensive default
    },
    description: 'Shared bucket — all Codex models on one ChatGPT Plus subscription',
  },
  claude: { propagate: 'model', description: 'Per-model bucket (claude-opus-4-6 vs claude-sonnet)' },
  gemini: { propagate: 'agent', description: 'Per-agent bucket — each Gemini agent has independent limits' },
  glm: {
    propagate: 'provider',
    fallbackCooldownMs: 5 * 60 * 60 * 1000,
    cooldownByReason: {
      rate_limit:     5 * 60 * 60 * 1000, // 5h — confirmed quota message (z.ai weekly/5h bucket)
      timeout:        15 * 60 * 1000,     // 15m — z.ai cloud blip / opencode session never produced content
      empty_response: 10 * 60 * 1000,     // 10m — session opened, model emitted no text
      transient:       5 * 60 * 1000,     // 5m  — 503/overloaded
      auth_error:      5 * 60 * 1000,     // 5m  — surface fast
      unknown:        30 * 60 * 1000,     // 30m — defensive default
    },
    description: 'Shared bucket — all GLM agents share 5h and weekly limits',
  },
  ollama: {
    propagate: 'none',
    noRateLimits: true,
    description: 'Local inference — no provider rate limits, errors are local capacity/timeouts'
  },
});

// ─── CB Failure-Reason Classification ──────────────────────────────────────────
// Pure classifier — given an Error (or string), return one of a small closed set
// of reasons. Used by lifecycle.js dispatch-catch sites to label each
// recordFailure(...) call with a reason; the CB carries that reason forward into
// the circuit_breaker:open event, which the cooldown-setter uses to pick a
// proportional cooldown duration (see RATE_LIMIT_SEMANTICS.cooldownByReason).
//
// Reasons (closed set):
//   'rate_limit'     — message matches RATE_LIMIT_RE (actual quota hit)
//   'timeout'        — subprocess hit max-wall, SIGKILL'd, or got no response in time
//   'empty_response' — process exited cleanly but emitted no usable text
//   'transient'      — 503/overloaded/upstream timeout messages
//   'auth_error'     — 401/403/invalid token
//   'unknown'        — falls through (defensive default; treated as short cooldown)
export function classifyCbFailureReason(err) {
  const msg = err?.message || (typeof err === 'string' ? err : '') || '';
  if (!msg) return 'unknown';
  if (RATE_LIMIT_RE.test(msg)) return 'rate_limit';
  if (/unauthorized|forbidden|invalid.?(?:token|api.?key)|401|403/i.test(msg)) return 'auth_error';
  if (TRANSIENT_ERROR_RE.test(msg)) return 'transient';
  if (/timed?[\s-]?out|timeout|SIGKILL|exit (?:124|137)|exceeded.{0,20}(?:wall|deadline)|opencode.{0,40}(?:no response|never produced)/i.test(msg)) return 'timeout';
  if (/empty (?:response|output|stdout)|no (?:text|content|usable) (?:response|output|content)|0 bytes|^$/i.test(msg)) return 'empty_response';
  return 'unknown';
}

// Lookup the cooldown duration in ms for a (provider, reason) pair.
// Falls back to fallbackCooldownMs, then to a 15-minute global default if the
// provider has no semantics entry. Pure function, safe to call from anywhere.
export function getCooldownDurationForReason(provider, reason) {
  const semantics = RATE_LIMIT_SEMANTICS[provider];
  if (!semantics) return 15 * 60 * 1000; // global default for unknown providers
  if (semantics.cooldownByReason && reason && semantics.cooldownByReason[reason] != null) {
    return semantics.cooldownByReason[reason];
  }
  return semantics.fallbackCooldownMs || 15 * 60 * 1000;
}

// Proactive rate limit cache — tracks when each model bucket resets
// Keys: model → { until: timestamp, reason: string, remaining?: string }
const rateLimitCache = new Map();

// ─── Error Classification ──────────────────────────────────────────────────────
/**
 * Classifies an error and returns a structured error object for the ErrorRegistry.
 * Maps exception types, error messages, and context to predefined error categories
 * with human-readable messages and actionable fixes.
 *
 * @param {Error|string} error - The error object or message
 * @param {string} agentId - The agent identifier
 * @param {object} [context] - Additional context (provider, model, etc.)
 * @returns {object} Classified error object with category, message, suggestedFix
 */
function classifyError(error, agentId, context = {}) {
  const errorMessage = error?.message || String(error);
  const errorStack = error?.stack || '';

  // Permission denied errors
  if (/permission denied|not permitted|unauthorized|forbidden/i.test(errorMessage)) {
    return {
      category: CATEGORIES.PERMISSION_DENIED,
      agentId,
      timestamp: Date.now(),
      message: `Agent ${agentId} lacks required permissions to execute this operation`,
      suggestedFix: 'Grant the agent necessary permissions in config/permissions.json or enable bypass mode for this agent',
      context,
    };
  }

  // CLI not found errors (ENOENT on spawn, command not found)
  if (/ENOENT|command not found|cannot find|executable not found|no such file or directory.*claude|no such file or directory.*codex/i.test(errorMessage)) {
    const provider = context.provider || 'the provider';
    return {
      category: CATEGORIES.CLI_NOT_FOUND,
      agentId,
      timestamp: Date.now(),
      message: `CLI tool for ${provider} not found on system`,
      suggestedFix: `Install the ${provider} CLI tool (e.g., 'npm install -g @anthropic-ai/claude-cli') and ensure it's in PATH`,
      context,
    };
  }

  // Spawn failure errors (process failed to start, exit code on spawn)
  if (/spawn.*failed|process exited|exit code|child process error|EACCES/i.test(errorMessage) && !errorMessage.includes('ENOENT')) {
    return {
      category: CATEGORIES.SPAWN_FAILURE,
      agentId,
      timestamp: Date.now(),
      message: `Failed to spawn agent process: ${errorMessage.slice(0, 100)}`,
      suggestedFix: 'Check CLI tool permissions (chmod +x), verify PATH configuration, and ensure no conflicting processes',
      context,
    };
  }

  // Circuit breaker open
  if (/circuit.*open|circuit breaker|too many failures|provider unavailable/i.test(errorMessage)) {
    const provider = context.provider || 'provider';
    return {
      category: CATEGORIES.CIRCUIT_BREAKER_OPEN,
      agentId,
      timestamp: Date.now(),
      message: `Circuit breaker open for ${provider} due to repeated failures`,
      suggestedFix: `Wait for circuit breaker to reset (check provider health), or manually reset via health dashboard`,
      context,
    };
  }

  // Persona invalid/tampered
  if (/persona.*tampered|persona.*invalid|integrity.*failed|hash.*mismatch/i.test(errorMessage)) {
    return {
      category: CATEGORIES.PERSONA_INVALID,
      agentId,
      timestamp: Date.now(),
      message: `Agent persona integrity check failed — possible tampering detected`,
      suggestedFix: 'Restore agent persona from backup or re-deploy agent configuration. Check file permissions on persona files.',
      context,
    };
  }

  // Authentication expired
  if (/auth.*expired|token.*expired|credentials.*expired|session.*expired|authentication.*failed|401|unauthenticated/i.test(errorMessage)) {
    const provider = context.provider || 'the provider';
    return {
      category: CATEGORIES.AUTH_EXPIRED,
      agentId,
      timestamp: Date.now(),
      message: `Authentication expired or invalid for ${provider}`,
      suggestedFix: `Re-authenticate using the ${provider} CLI (e.g., 'claude login' or 'codex auth') and verify API credentials`,
      context,
    };
  }

  // Timeout errors
  if (/timed out|timeout|deadline exceeded|took too long/i.test(errorMessage)) {
    const timeoutSecs = context.timeout ? Math.round(context.timeout / 1000) : 90;
    return {
      category: CATEGORIES.TIMEOUT,
      agentId,
      timestamp: Date.now(),
      message: `Agent request timed out after ${timeoutSecs}s`,
      suggestedFix: `Increase timeout in config/agents.timeouts or reduce task complexity. Consider breaking task into smaller subtasks.`,
      context,
    };
  }

  // Fallback for unclassified errors — should be rare if instrumentation is complete
  // Return null to indicate no classification (caller should handle as generic error)
  return null;
}

/**
 * Convenience wrapper that classifies and logs an error.
 * Returns the classified error object or null if error couldn't be classified.
 *
 * @param {Error|string} error - The error to classify
 * @param {string} agentId - Agent identifier
 * @param {object} [context] - Additional context
 * @returns {object|null} Classified error or null
 */
function classifyAndLog(error, agentId, context = {}) {
  const classified = classifyError(error, agentId, context);
  if (classified) {
    log.error('Classified error', {
      category: classified.category,
      agent: agentId,
      message: classified.message,
      ...context,
    });
  }
  return classified;
}

function parseRateLimitReset(text) {
  const now = new Date();
  const textLower = String(text || '').toLowerCase();

  // Parse Gemini's machine-readable retryDelayMs (most precise — try first)
  const retryDelayMatch = String(text || '').match(/retryDelayMs:\s*([\d.]+)/);
  if (retryDelayMatch) {
    const ms = parseFloat(retryDelayMatch[1]);
    if (ms > 0) {
      const until = Date.now() + ms;
      const totalSec = Math.round(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const remaining = h > 0 ? `${h}h ${m}m` : `${m}m`;
      return { until, remaining };
    }
  }

  const monthMap = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  // Parse "until March 6th" or "until march 3rd"
  const monthDayMatch = textLower.match(/until\s+(?:the\s+)?(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?/i);
  if (monthDayMatch) {
    const monthName = monthDayMatch[1];
    const day = parseInt(monthDayMatch[2]);
    const month = monthMap[monthName.substring(0, 3).toLowerCase()];
    if (month !== undefined && day >= 1 && day <= 31) {
      const retryAt = new Date(now.getFullYear(), month, day, 0, 0, 0);
      if (retryAt <= now) retryAt.setFullYear(retryAt.getFullYear() + 1);
      return { until: retryAt.getTime(), remaining: `${monthName.substring(0, 3)} ${day}` };
    }
  }

  // Parse Claude-style "resets Mar 9, 7pm (UTC)" or "resets Mar 9 at 7:30pm"
  const resetsMonthDayTimeMatch = textLower.match(
    /resets?\s+([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:,|at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i
  );
  if (resetsMonthDayTimeMatch) {
    const monthName = resetsMonthDayTimeMatch[1];
    const day = parseInt(resetsMonthDayTimeMatch[2]);
    const month = monthMap[monthName.substring(0, 3).toLowerCase()];
    if (month !== undefined && day >= 1 && day <= 31) {
      let hour = resetsMonthDayTimeMatch[3] ? parseInt(resetsMonthDayTimeMatch[3]) : 0;
      const minute = resetsMonthDayTimeMatch[4] ? parseInt(resetsMonthDayTimeMatch[4]) : 0;
      const meridiem = resetsMonthDayTimeMatch[5] ? resetsMonthDayTimeMatch[5].toLowerCase() : null;
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;

      const hasUtc = /\butc\b/i.test(textLower);
      let until;
      if (hasUtc) {
        let year = now.getUTCFullYear();
        let retryAt = Date.UTC(year, month, day, hour, minute, 0, 0);
        if (retryAt <= Date.now()) retryAt = Date.UTC(year + 1, month, day, hour, minute, 0, 0);
        until = retryAt;
      } else {
        const retryAt = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
        if (retryAt <= now) retryAt.setFullYear(retryAt.getFullYear() + 1);
        until = retryAt.getTime();
      }

      const labelTime = resetsMonthDayTimeMatch[3]
        ? `${resetsMonthDayTimeMatch[3]}${resetsMonthDayTimeMatch[4] ? `:${resetsMonthDayTimeMatch[4]}` : ''}${meridiem || ''}${hasUtc ? ' UTC' : ''}`
        : '';
      const remaining = `${monthName.substring(0, 3)} ${day}${labelTime ? ` ${labelTime}` : ''}`;
      return { until, remaining };
    }
  }
  
  // Parse "try again at 3:45", "try again at 10:21 PM", "try again at 10:21 pm"
  const retryMatch = String(text || '').match(/try again at (\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
  if (retryMatch) {
    let hour = parseInt(retryMatch[1]);
    const meridiem = retryMatch[3] ? retryMatch[3].toLowerCase() : null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const retryAt = new Date(now);
    retryAt.setHours(hour, parseInt(retryMatch[2]), 0, 0);
    if (retryAt <= now) retryAt.setDate(retryAt.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    return { until: retryAt.getTime(), remaining: `${retryAt.getHours()}:${pad(retryAt.getMinutes())}` };
  }
  
  const resetMatch = String(text || '').match(/resets? (\d{1,2})(am|pm)/i);
  if (resetMatch) {
    let hour = parseInt(resetMatch[1]);
    if (resetMatch[2].toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (resetMatch[2].toLowerCase() === 'am' && hour === 12) hour = 0;
    const retryAt = new Date(now);
    retryAt.setHours(hour, 0, 0, 0);
    if (retryAt <= now) retryAt.setDate(retryAt.getDate() + 1);
    return { until: retryAt.getTime(), remaining: `${retryAt.getHours()}:${String(retryAt.getMinutes()).padStart(2, '0')}` };
  }
  
  // Parse "reset after 3h 15m" or "resets in 2h"
  const afterMatch = String(text || '').match(/after\s+((?:\d+h)?(?:\d+m)?(?:\d+s)?)/i);
  if (afterMatch) {
    let totalMs = 0;
    const parts = afterMatch[1];
    const h = parts.match(/(\d+)h/i);
    const min = parts.match(/(\d+)m/i);
    const s = parts.match(/(\d+)s/i);
    if (h) totalMs += Number(h[1]) * 60 * 60 * 1000;
    if (min) totalMs += Number(min[1]) * 60 * 1000;
    if (s) totalMs += Number(s[1]) * 1000;
    if (totalMs > 0) {
      return { until: Date.now() + totalMs, remaining: afterMatch[1] };
    }
  }
  
  // Parse "tomorrow" → next day midnight
  if (/\btomorrow\b/i.test(text)) {
    const retryAt = new Date(now);
    retryAt.setDate(retryAt.getDate() + 1);
    retryAt.setHours(0, 0, 0, 0);
    return { until: retryAt.getTime(), remaining: 'tomorrow' };
  }

  // Parse "in X hours" or "in X minutes" or "in X seconds"
  const inMatch = String(text || '').match(/in\s+(\d+(?:\.\d+)?)\s*(hour|minute|second|hr|min|sec)s?/i);
  if (inMatch) {
    const amount = parseFloat(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith('hour') || unit === 'hr') ms = amount * 3600000;
    else if (unit.startsWith('minute') || unit === 'min') ms = amount * 60000;
    else if (unit.startsWith('second') || unit === 'sec') ms = amount * 1000;
    if (ms > 0) {
      const remaining = amount >= 60 ? `${Math.round(amount / 60)}h` : `${Math.round(amount)}${unit[0]}`;
      return { until: Date.now() + ms, remaining };
    }
  }

  // Parse "retry after N" (seconds, from HTTP 429 Retry-After header style)
  const retryAfterMatch = String(text || '').match(/retry.?after\s+(\d+)/i);
  if (retryAfterMatch) {
    const secs = parseInt(retryAfterMatch[1]);
    if (secs > 0) {
      return { until: Date.now() + secs * 1000, remaining: `${Math.ceil(secs / 60)}m` };
    }
  }

  // Parse GLM-style datetime "YYYY-MM-DD HH:MM:SS" (space instead of T)
  const glmDateTimeMatch = String(text || '').match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/);
  if (glmDateTimeMatch) {
    const parsed = new Date(glmDateTimeMatch[1].replace(' ', 'T'));
    if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
      return { until: parsed.getTime(), remaining: `${parsed.getMonth() + 1}/${parsed.getDate()} ${parsed.getHours()}:${String(parsed.getMinutes()).padStart(2, '0')}` };
    }
  }
  
  // Parse ISO date "YYYY-MM-DD" or ISO datetime "YYYY-MM-DDTHH:MM"
  const isoMatch = String(text || '').match(/(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?Z?)/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[1]);
    if (!isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
      return { until: parsed.getTime(), remaining: parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    }
  }

  return null;
}

function cacheRateLimit(model, text) {
  const resetInfo = parseRateLimitReset(text);
  if (resetInfo) {
    rateLimitCache.set(model, { ...resetInfo, cachedAt: Date.now() });
    log.info('Rate limit cached', { model, ...resetInfo });
    return true;
  }
  return false;
}

function getCachedRateLimit(model) {
  const entry = rateLimitCache.get(model);
  if (!entry) return null;
  if (Date.now() >= entry.until) {
    rateLimitCache.delete(model);
    return null;
  }
  return entry;
}

function isModelRateLimited(model) {
  return getCachedRateLimit(model) !== null;
}

function getRateLimitStatus() {
  const status = {};
  for (const [model, entry] of rateLimitCache.entries()) {
    status[model] = {
      until: new Date(entry.until).toISOString(),
      remaining: entry.remaining,
      ageMs: Date.now() - entry.cachedAt,
    };
  }
  return status;
}

function roleProviderFallbackRank(role, provider, candidateId) {
  // Role-specific fallback order (operator preference).
  // Weights are spaced to outrank the generic provider/model diversity bonuses.
  if (role === 'developer') {
    if (provider === 'ollama') return 90;   // local & free first
    if (provider === 'codex') return 70;
    if (provider === 'claude') return 50;
    if (provider === 'gemini') return 20;
    return 0;
  }
  if (role === 'reviewer') {
    if (provider === 'codex') return 90;
    if (provider === 'claude') return 70;
    if (provider === 'ollama') return 20;
    return 0;
  }
  if (role === 'architect') {
    if (provider === 'claude') return 90;
    if (provider === 'codex') return 70;
    if (provider === 'ollama') return 20;
    return 0;
  }
  if (role === 'governor') {
    if (provider === 'codex') return 90;
    if (provider === 'claude') return 70;
    if (provider === 'ollama') return 20;
    return 0;
  }
  if (provider === 'claude') return 70;
  if (provider === 'codex') return 50;
  if (provider === 'gemini') return 20;
  return 0;
}

export function createAgentInteraction(deps) {
  const {
    agents, config, addMessage, broadcastToChannel, events,
    stateManager, formatContext, isNoiseResponse,
    compactionManager, runCompaction, PROJECT_DIR,
    verifyPersonaIntegrity, registerPersonaHash, auditDispatch, resolvePermissions,
    circuitBreaker, errorRegistry, memoryWriteBackService, parseExplicitMemoryCommands,
  } = deps;

  const RATE_LIMIT_COOLDOWN_MS = config.orchestrator.rateLimitCooldownMs;
  const AGENT_TIMEOUTS = config.agents.timeouts;
  const agentCooldowns = new Map();
  const cooldownStatePath = stateManager?.projectsDir
    ? join(stateManager.projectsDir, '_agent-cooldowns.json')
    : null;

  function persistCooldowns() {
    if (!cooldownStatePath) return;
    try {
      if (stateManager?.projectsDir) mkdirSync(stateManager.projectsDir, { recursive: true });
      const now = Date.now();
      // .map() must stay on the Array — Object.fromEntries() returns a plain object with no .map()
      const entries = Object.fromEntries(
        [...agentCooldowns.entries()]
          .filter(([, entry]) => entry && typeof entry.until === 'number' && entry.until > now)
          .map(([k, v]) => [k, {
            until: v.until,
            reason: v.reason || 'rate_limit',
            model: v.model,
            resetRemaining: v.resetInfo?.remaining || null,
            confidence: v.confidence || 'hard',
            source: v.source || 'unknown',
          }])
      );
      writeFileSync(cooldownStatePath, JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2) + '\n');
    } catch (err) {
      log.warn('Cooldown persistence failed', { error: err.message });
    }
  }

  function loadCooldowns() {
    if (!cooldownStatePath || !existsSync(cooldownStatePath)) return;
    try {
      const data = JSON.parse(readFileSync(cooldownStatePath, 'utf8'));
      const now = Date.now();
      for (const [agentName, entry] of Object.entries(data?.entries || {})) {
        // Skip Ollama cooldowns - Ollama has no provider rate limits
        const agent = agents[agentName];
        if (agent && agent.provider === 'ollama') {
          log.info('Skipping Ollama cooldown (no provider limits)', { agent: agentName });
          continue;
        }
        
        // Support both legacy (number) and new (object with until) formats
        const until = typeof entry === 'number' ? entry : entry?.until;
        if (typeof until === 'number' && until > now) {
          agentCooldowns.set(agentName, {
            until,
            reason: (typeof entry === 'object' && entry.reason) || 'persisted',
            model: (typeof entry === 'object' && entry.model) || null,
            resetInfo: (typeof entry === 'object' && entry.resetRemaining)
              ? { remaining: entry.resetRemaining }
              : null,
            confidence: (typeof entry === 'object' && entry.confidence) || 'hard',
            source: (typeof entry === 'object' && entry.source) || 'persisted',
          });
        }
      }
      if (agentCooldowns.size > 0) {
        log.info('Loaded cooldowns', {
          agents: [...agentCooldowns.keys()], count: agentCooldowns.size,
        });
      }
    } catch (err) {
      log.warn('Cooldown state load failed', { error: err.message });
    }
  }

  function setCooldownUntil(agentName, until, reason = 'rate_limit', logMeta = null) {
    const agent = agents[agentName];
    if (!agent) return until;
    
    const provider = agent.provider;
    const model = agent.model;
    const semantics = RATE_LIMIT_SEMANTICS[provider];
    
    // Propagate only true rate-limit signals to shared buckets.
    // Other cooldown reasons (timeouts, local capacity pressure, generic errors)
    // should stay local to the agent.
    const isRateLimitReason = /(?:^|_)rate_limit(?:$|_)|_bucket$/.test(String(reason || ''));
    const confidence = logMeta?.confidence || (isRateLimitReason ? 'hard' : 'soft');
    const source = logMeta?.source || (isRateLimitReason ? 'unknown' : 'fallback');

    if (semantics?.propagate === 'model' && provider && confidence === 'hard' && isRateLimitReason) {
      for (const [id, a] of Object.entries(agents)) {
        if (id !== agentName && a.model === model) {
          const existing = agentCooldowns.get(id);
          if (!existing || existing.until < until) {
            agentCooldowns.set(id, { until, reason: `${model}_bucket`, propagatedFrom: agentName, model, confidence, source: 'propagated' });
            log.info('Rate limit propagated (same model)', {
              agent: id,
              from: agentName,
              provider,
              model,
              ...logMeta
            });
          }
        }
      }
    } else if (semantics?.propagate === 'provider' && provider && isRateLimitReason) {
      // Propagate all cooldowns (hard and soft) provider-wide for shared buckets
      // Codex and GLM share provider-wide rate limit buckets (ChatGPT Plus, 5h/weekly limits)
      for (const [id, a] of Object.entries(agents)) {
        if (id !== agentName && a.provider === provider) {
          const existing = agentCooldowns.get(id);
          if (!existing || existing.until < until) {
            agentCooldowns.set(id, { until, reason: `${provider}_provider_bucket`, propagatedFrom: agentName, model: a.model, confidence, source: 'propagated' });
            log.info('Rate limit propagated (same provider)', { agent: id, from: agentName, provider, model: a.model, confidence });
          }
        }
      }
    }
    // propagate: 'agent' — no propagation

    agentCooldowns.set(agentName, { until, reason, model, ...logMeta });
    persistCooldowns();
    if (logMeta) log.info('Agent cooldown', { agent: agentName, ...logMeta });
    return until;
  }

  loadCooldowns();

  // Re-propagate loaded cooldowns to enforce provider-bucket semantics on restart.
  // (Persisted file only stores per-agent entries; propagation must be re-applied.)
  (function propagateLoadedCooldowns() {
    for (const [agentName, entry] of agentCooldowns.entries()) {
      const agent = agents[agentName];
      if (!agent) continue;
      const provider = agent.provider;
      const semantics = RATE_LIMIT_SEMANTICS[provider];
      if (semantics?.propagate !== 'provider') continue;
      for (const [id, a] of Object.entries(agents)) {
        if (id !== agentName && a.provider === provider && !agentCooldowns.has(id)) {
          agentCooldowns.set(id, { until: entry.until, reason: `${provider}_provider_bucket`, propagatedFrom: agentName, model: a.model });
          log.info('Rate limit propagated on load (same provider)', { agent: id, from: agentName, provider });
        }
      }
    }
  })();

  // On startup: immediately probe unchecked siblings of per-agent cooling agents.
  // Detects e.g. Gale/Gordon rate limits when Garnet/Gem are already in cooldown,
  // without waiting for the 10-minute probe interval or a natural dispatch attempt.
  setTimeout(() => {
    for (const [agentName] of agentCooldowns.entries()) {
      const agent = agents[agentName];
      if (!agent) continue;
      const semantics = RATE_LIMIT_SEMANTICS[agent.provider];
      if (semantics?.propagate !== 'agent') continue;
      for (const [id, a] of Object.entries(agents)) {
        if (id !== agentName && a.provider === agent.provider && !agentCooldowns.has(id)) {
          discoverRateLimit(id).catch(() => {});
        }
      }
    }
  }, 3000);

  // ─── Rate Limit Probe ──────────────────────────────────────────────────────
  // Every 10 minutes, probe cooling-down agents for fresh reset times.
  // A probe against a rate-limited provider costs nothing (instant 429 rejection)
  // but gives us the current reset time. If it succeeds, the cooldown clears.
  const RATE_LIMIT_PROBE_INTERVAL_HARD_MS = 10 * 60 * 1000;
  const RATE_LIMIT_PROBE_INTERVAL_SOFT_MS = 5 * 60 * 1000;
  const agentProbeTimes = new Map();
  let _probeIntervalId = null;

  async function probeRateLimitedAgent(agentName) {
    if (!isAgentCoolingDown(agentName)) return;
    const agent = agents[agentName];
    if (!agent || typeof agent.send !== 'function') return;
    try {
      const response = await Promise.race([
        agent.send('Reply with exactly: RATE_PROBE_OK', PROJECT_DIR, { bypassPermissions: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 25_000)),
      ]);
      if (response && RATE_LIMIT_RE.test(response)) {
        // Still rate limited — parse fresh reset time
        const mins = setAgentCooldown(agentName, response);
        log.info('Rate limit probe: refreshed (still limited)', { agent: agentName, cooldownMins: mins });
      } else {
        // Agent appears to have recovered — but guard against false positives.
        // Codex CLI (and others) can respond to lightweight probes through a separate
        // capacity tier even when the main quota is exhausted. If the provider gave us
        // a specific reset timestamp, trust it over the probe result.
        const entry = agentCooldowns.get(agentName);
        if (entry?.until && Date.now() < entry.until && entry.confidence !== 'soft') {
          // Hard cooldown: trust the provider-given reset time over the probe result
          log.info('Rate limit probe: ignoring apparent recovery — reset time not yet reached', {
            agent: agentName, remainingMins: Math.round((entry.until - Date.now()) / 60000),
          });
          return;
        }
        // Reset time has passed, or soft estimate — confirmed recovered
        agentCooldowns.delete(agentName);
        fallbackStates.delete(agentName);
        persistCooldowns();
        log.info('Rate limit probe: agent recovered', { agent: agentName });
      }
    } catch (err) {
      const errText = err.message || '';
      if (RATE_LIMIT_RE.test(errText)) {
        const mins = setAgentCooldown(agentName, errText);
        log.info('Rate limit probe: refreshed via error', { agent: agentName, cooldownMins: mins });
      }
      // Non-rate-limit error (network, timeout) — leave existing cooldown unchanged
    }
  }

  // Probe an agent for rate limit discovery without requiring it to already be in cooldown.
  // Used to detect per-agent provider siblings (e.g. Gale/Gordon when Garnet/Gem are cooling).
  async function discoverRateLimit(agentName) {
    if (isAgentCoolingDown(agentName)) return; // already known
    const agent = agents[agentName];
    if (!agent || typeof agent.send !== 'function') return;
    try {
      const response = await Promise.race([
        agent.send('Reply with exactly: RATE_PROBE_OK', PROJECT_DIR, { bypassPermissions: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 25_000)),
      ]);
      if (response && RATE_LIMIT_RE.test(response)) {
        const mins = setAgentCooldown(agentName, response);
        log.info('Rate limit discovery: sibling is limited', { agent: agentName, cooldownMins: mins });
      }
    } catch (err) {
      const errText = err.message || '';
      if (RATE_LIMIT_RE.test(errText)) {
        const mins = setAgentCooldown(agentName, errText);
        log.info('Rate limit discovery: sibling is limited (via error)', { agent: agentName, cooldownMins: mins });
      }
    }
  }

  function startRateLimitProbe() {
    if (_probeIntervalId) return;
    _probeIntervalId = setInterval(() => {
      const cooling = [...agentCooldowns.keys()];
      if (cooling.length === 0) return;
      log.info('Rate limit probe: scanning', { agents: cooling });
      const now = Date.now();
      // Track per-provider stagger so probes don't all fire simultaneously.
      // Probe processes are real CLI sessions that count against Anthropic's concurrent
      // session limit even though they aren't in busyAgents. Staggering prevents a burst
      // of N cooling agents all probing at the same time as existing workers → SIGTERM.
      const providerProbeDelay = new Map(); // provider → next scheduled delay ms
      for (const name of cooling) {
        const entry = agentCooldowns.get(name);
        // Soft cooldowns probe at 5min; hard cooldowns probe at 10min
        const probeIntervalMs = entry?.confidence === 'soft'
          ? RATE_LIMIT_PROBE_INTERVAL_SOFT_MS
          : RATE_LIMIT_PROBE_INTERVAL_HARD_MS;
        const lastProbe = agentProbeTimes.get(name) || 0;
        if (now - lastProbe >= probeIntervalMs) {
          agentProbeTimes.set(name, now);
          const provider = agents[name]?.provider || name;
          const delay = providerProbeDelay.get(provider) || 0;
          providerProbeDelay.set(provider, delay + 4000); // stagger 4s between same-provider probes
          setTimeout(() =>
            probeRateLimitedAgent(name).catch(err =>
              log.warn('Rate limit probe error', { agent: name, error: err.message })
            ),
            delay
          );
        }
      }
      // For per-agent providers, also discover unchecked siblings
      for (const name of cooling) {
        const a = agents[name];
        if (!a) continue;
        const sem = RATE_LIMIT_SEMANTICS[a.provider];
        if (sem?.propagate !== 'agent') continue;
        for (const [id, peer] of Object.entries(agents)) {
          if (id !== name && peer.provider === a.provider && !agentCooldowns.has(id)) {
            discoverRateLimit(id).catch(() => {});
          }
        }
      }
    }, RATE_LIMIT_PROBE_INTERVAL_SOFT_MS);  // 5min tick (shortest interval)
    log.info('Rate limit probe started', { hardIntervalMs: RATE_LIMIT_PROBE_INTERVAL_HARD_MS, softIntervalMs: RATE_LIMIT_PROBE_INTERVAL_SOFT_MS });
  }

  function stopRateLimitProbe() {
    if (_probeIntervalId) { clearInterval(_probeIntervalId); _probeIntervalId = null; }
  }

  // ─── Fallback State Cleanup ──────────────────────────────────────────────────
  // Periodically clean up stale fallback state entries to prevent unbounded growth
  // during long-running sessions. Entries older than TTL are removed.
  const FALLBACK_STATE_TTL_MS = 60 * 60 * 1000; // 1 hour
  const FALLBACK_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  let _fallbackCleanupIntervalId = null;

  function cleanupStaleFallbackStates() {
    const now = Date.now();
    let cleaned = 0;
    for (const [agentName, state] of fallbackStates.entries()) {
      if (state.createdAt && now - state.createdAt > FALLBACK_STATE_TTL_MS) {
        fallbackStates.delete(agentName);
        cleaned++;
        log.debug('Cleaned stale fallback state', { agent: agentName, ageMs: now - state.createdAt });
      }
    }
    if (cleaned > 0) {
      log.info('Fallback state cleanup completed', { entriesRemoved: cleaned, remaining: fallbackStates.size });
    }
  }

  function startFallbackCleanup() {
    if (_fallbackCleanupIntervalId) return;
    _fallbackCleanupIntervalId = setInterval(cleanupStaleFallbackStates, FALLBACK_CLEANUP_INTERVAL_MS);
    log.info('Fallback state cleanup started', { ttlMs: FALLBACK_STATE_TTL_MS, intervalMs: FALLBACK_CLEANUP_INTERVAL_MS });
  }

  function stopFallbackCleanup() {
    if (_fallbackCleanupIntervalId) {
      clearInterval(_fallbackCleanupIntervalId);
      _fallbackCleanupIntervalId = null;
    }
  }


  function isAgentCoolingDown(agentName) {
    const entry = agentCooldowns.get(agentName);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      agentCooldowns.delete(agentName);
      fallbackStates.delete(agentName);
      persistCooldowns();
      return false;
    }
    return true;
  }

  function parseRelativeResetMs(text) {
    const m = String(text || '').match(/reset(?:s)? after\s+((?:\d+h)?(?:\d+m)?(?:\d+s)?)/i);
    if (!m?.[1]) return null;
    let totalMs = 0;
    const parts = m[1];
    const h = parts.match(/(\d+)h/i);
    const min = parts.match(/(\d+)m/i);
    const s = parts.match(/(\d+)s/i);
    if (h) totalMs += Number(h[1]) * 60 * 60 * 1000;
    if (min) totalMs += Number(min[1]) * 60 * 1000;
    if (s) totalMs += Number(s[1]) * 1000;
    return totalMs > 0 ? totalMs : null;
  }

  function setAgentCooldown(agentName, response) {
    const agent = agents[agentName];
    if (!agent) return 0;
    
    // Ollama has no provider rate limits — skip rate limit cooldown entirely
    const semantics = RATE_LIMIT_SEMANTICS[agent.provider];
    if (semantics?.noRateLimits) {
      log.warn('Rate limit skip: Ollama has no provider limits', { agent: agentName, provider: agent.provider, sample: String(response || '').slice(0, 250) });
      return 0;
    }
    
    const model = agent.model;
    
    // Parse rate limit reset time and cache it
    const resetInfo = parseRateLimitReset(response);
    let cooldownMs = semantics?.fallbackCooldownMs ?? RATE_LIMIT_COOLDOWN_MS;
    let confidence;
    let source;

    if (resetInfo) {
      // Use the exact reset time from the provider
      cooldownMs = resetInfo.until - Date.now();
      // Cache the rate limit information
      cacheRateLimit(model, response);
      confidence = 'hard';
      source = 'parsed_reset';
    } else {
      // Fallback: parse relative reset time
      const relativeResetMs = parseRelativeResetMs(response);
      if (relativeResetMs) {
        cooldownMs = relativeResetMs + 30_000;
        confidence = 'hard';
        source = 'relative_reset';
      } else {
        // No parseable reset time — soft estimate, probed at 5min intervals
        log.warn('Rate limit: no parseable reset time', { agent: agentName, provider: agent.provider, sample: String(response || '').slice(0, 250) });
        confidence = 'soft';
        source = 'fallback';

        // Apply jitter to soft/fallback cooldowns
        // This is the first "retry" for this cooldown, so retryNum is 0.
        // The maxDelayMs for jitter will be 2x the base cooldown for now, ensuring a good spread.
        const baseDelayForJitter = cooldownMs;
        const minMaxDelay = 5 * 60 * 1000; // At least 5 minutes max delay
        const maxDelayForJitter = Math.max(baseDelayForJitter * 2, minMaxDelay); 
        cooldownMs = computeBackoffWithJitter(0, baseDelayForJitter, maxDelayForJitter);
        log.debug('Applied jitter to fallback cooldown', { agent: agentName, originalCooldownMs: baseDelayForJitter, jitteredCooldownMs: cooldownMs });
      }
    }

    const until = Date.now() + cooldownMs;
    const provider = agent.provider;

    setCooldownUntil(agentName, until, `${model}_rate_limit`, {
      minutes: Math.round(cooldownMs / 60000),
      provider,
      model,
      resetInfo,
      confidence,
      source,
    });
    
    const mins = Math.round(cooldownMs / 60000);
    log.info('Rate limit cooldown', { 
      agent: agentName, 
      model,
      provider,
      minutes: mins,
      resetInfo: resetInfo?.remaining || 'unknown',
    });
    
    return mins;
  }

  // Resolve timeout for an agent — check provider first, then ID, then default
  function getAgentTimeout(agentId) {
    const agent = agents[agentId];
    const provider = agent?.provider;
    return (provider && AGENT_TIMEOUTS[provider]) || AGENT_TIMEOUTS[agentId] || 90000;
  }

  function withTimeout(promise, ms, label) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (typeof promise.abort === 'function') promise.abort();
        reject(new Error(`${label} timed out after ${ms / 1000}s`));
      }, ms);
    });
    return Promise.race([
      promise.then(
        v => { clearTimeout(timer); return v; },
        e => { clearTimeout(timer); throw e; },
      ),
      timeoutPromise,
    ]);
  }

  function selectHandoffAgent(name, agent, attempted = new Set()) {
    const candidates = Object.entries(agents)
      .filter(([id, a]) => id !== name
        && a
        && a.role !== 'governor'
        && (!a._status || a._status === 'active')
        && !isAgentCoolingDown(id)
        && !attempted.has(id)
        && (!circuitBreaker || circuitBreaker.canRequest(id)));

    if (candidates.length === 0) return null;

    const scored = candidates.map(([id, a]) => {
      let score = 0;
      if (a.role === agent.role) score += 100;
      else if (a.provider === 'ollama' && ['architect', 'reviewer', 'governor'].includes(agent.role)) score += 5;
      score += roleProviderFallbackRank(agent.role, a.provider, id);
      if (a.provider !== agent.provider) score += 20;
      if (a.model !== agent.model) score += 10;
      return { id, score };
    });

    scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    return scored[0]?.id || null;
  }

  async function handoffToPeer(name, agent, reason, projectId, channelId, userMessage, crossRef, contextOverride, threadMeta = {}) {
    // An explicitly-addressed turn is never delegated — not on busy, not on
    // error, not on rate-limit. Answering in a named agent's place is
    // impersonation (operator: "it was not sol's place to do so"). The busy
    // branch guards earlier with a friendly note; this catches EVERY caller.
    if (threadMeta._noHandoff || threadMeta._explicitlyAddressed) return null;
    const hops = threadMeta._handoffHops || 0;
    if (hops >= HANDOFF_MAX_HOPS) return null;

    const attempted = new Set(threadMeta._handoffTried || []);
    attempted.add(name);
    const handoffId = selectHandoffAgent(name, agent, attempted);
    if (!handoffId) return null;

    // Track who actually responds so callers can attribute the message correctly.
    // Uses a mutable ref object — survives threadMeta spread in recursive calls.
    if (threadMeta._respondentRef) threadMeta._respondentRef.id = handoffId;

    const handoffAgent = agents[handoffId];
    fallbackStates.set(name, {
      active: true,
      originalModel: agent.model,
      currentModel: handoffAgent.model,
      currentProvider: handoffAgent.provider,
      reason,
      handoffTo: handoffId,
      createdAt: Date.now(),
    });

    log.info('Agent handoff', { from: name, to: handoffId, reason });
    addMessage(projectId, channelId, 'System',
      `${agent.name} unavailable (${reason}) — handing off to @${handoffId}.`,
      'system', { threadId: threadMeta.threadId });
    broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'fallback' });

    return getAgentResponse(
      handoffId, handoffAgent, projectId, channelId, userMessage, crossRef, contextOverride,
      { ...threadMeta, _handoffHops: hops + 1, _handoffTried: [...attempted] },
    );
  }

  /**
   * Dispatch a message to an agent and return the response with token/cost metadata.
   *
   * @returns {Object} Response object with structure:
   *   - response: string - The agent's response text or status ('rate_limited', 'error', etc.)
   *   - inputTokens: number|null - Input token count (null if not available)
   *   - outputTokens: number|null - Output token count (null if not available)
   *   - model: string - Model identifier used for the response
   *   - provider: string - Provider name (claude, codex, gemini, ollama)
   *   - confidence: string|null - Token count confidence ('exact', 'estimated', or null)
   *
   * BREAKING CHANGE (Cost Attribution Campaign): Previously returned a plain string.
   * Now returns structured object to enable cost tracking. Callers must access .response
   * property for the response text and can optionally access token/cost fields.
   */
  async function getAgentResponse(name, agent, projectId, channelId, userMessage, crossRef = null, contextOverride = null, threadMeta = {}) {
    // Create dispatch.agent span for tracing
    const dispatchSpan = startSpan('dispatch.agent', {
      agentId: name,
      provider: agent.provider || 'unknown',
      model: agent.model || 'unknown',
      projectId,
      channelId,
    }, threadMeta.parentSpanContext);
    const startTime = Date.now();

    if (isAgentCoolingDown(name)) {
      const handoff = await handoffToPeer(
        name, agent, 'cooldown', projectId, channelId, userMessage, crossRef, contextOverride, threadMeta,
      );
      if (handoff) {
        const durationMs = Date.now() - startTime;
        dispatchSpan.setAttribute('durationMs', durationMs);
        dispatchSpan.setAttribute('success', false);
        dispatchSpan.setAttribute('errorCategory', 'cooldown');
        dispatchSpan.setAttribute('handoffTo', threadMeta._respondentRef?.id || 'unknown');
        endSpan(dispatchSpan, { success: false });
        return handoff;
      }
      const durationMs = Date.now() - startTime;
      dispatchSpan.setAttribute('durationMs', durationMs);
      dispatchSpan.setAttribute('success', false);
      dispatchSpan.setAttribute('errorCategory', 'cooldown');
      setSpanStatus(dispatchSpan, { code: 'error', message: 'Agent is cooling down' });
      endSpan(dispatchSpan, { success: false });
      broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'rate_limited' });
      return {
        response: 'rate_limited',
        inputTokens: null,
        outputTokens: null,
        model: agent.model,
        provider: agent.provider || 'unknown',
        confidence: null,
      };
    }

    // Circuit breaker check — reject if agent circuit is open
    const provider = agent.provider || name;
    if (circuitBreaker && !circuitBreaker.canRequest({ agentId: name, provider })) {
      // Record classified error
      if (errorRegistry) {
        const classified = classifyError(
          new Error(`Circuit breaker open for ${provider} due to repeated failures`),
          name,
          { provider, projectId, channelId }
        );
        if (classified) {
          errorRegistry.record(classified);
        }
      }

      const handoff = await handoffToPeer(
        name, agent, 'circuit breaker open', projectId, channelId, userMessage, crossRef, contextOverride, threadMeta,
      );
      if (handoff) {
        const durationMs = Date.now() - startTime;
        dispatchSpan.setAttribute('durationMs', durationMs);
        dispatchSpan.setAttribute('success', false);
        dispatchSpan.setAttribute('errorCategory', CATEGORIES.CIRCUIT_BREAKER_OPEN);
        dispatchSpan.setAttribute('handoffTo', threadMeta._respondentRef?.id || 'unknown');
        endSpan(dispatchSpan, { success: false });
        return handoff;
      }
      const durationMs = Date.now() - startTime;
      dispatchSpan.setAttribute('durationMs', durationMs);
      dispatchSpan.setAttribute('success', false);
      dispatchSpan.setAttribute('errorCategory', CATEGORIES.CIRCUIT_BREAKER_OPEN);
      setSpanStatus(dispatchSpan, { code: 'error', message: `Circuit breaker open for ${provider}` });
      endSpan(dispatchSpan, { success: false });
      broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'circuit_open' });
      return {
        response: 'circuit_open',
        inputTokens: null,
        outputTokens: null,
        model: agent.model,
        provider: agent.provider || provider,
        confidence: null,
      };
    }

    // Persona integrity check (Layer 3)
    if (config.permissions.enforce && verifyPersonaIntegrity) {
      const integrity = verifyPersonaIntegrity(name, agent.persona);
      if (!integrity.ok) {
        // Auto-heal: if disk content matches in-memory persona, only the hash registration is stale — not a tamper.
        let isStaleHash = false;
        if (registerPersonaHash && agent.persona) {
          try {
            const personaPath = join(PROJECT_DIR, `.synapse/agents/${name}/persona.md`);
            const diskContent = readFileSync(personaPath, 'utf-8').trim();
            if (diskContent === agent.persona) {
              registerPersonaHash(name, agent.persona);
              log.warn('Persona hash was stale — auto-healed (no tamper detected)', { agent: name });
              isStaleHash = true;
            }
          } catch { /* can't read disk — treat conservatively as tamper */ }
        }

        if (!isStaleHash) {
          // Record classified error
          if (errorRegistry) {
            const classified = classifyError(
              new Error(`Persona integrity failed — hash mismatch detected`),
              name,
              { provider, expectedHash: integrity.expected, projectId, channelId }
            );
            if (classified) {
              errorRegistry.record(classified);
            }
          }

          const durationMs = Date.now() - startTime;
          dispatchSpan.setAttribute('durationMs', durationMs);
          dispatchSpan.setAttribute('success', false);
          dispatchSpan.setAttribute('errorCategory', CATEGORIES.PERSONA_INVALID);
          setSpanStatus(dispatchSpan, { code: 'error', message: 'Persona integrity check failed' });
          addSpanEvent(dispatchSpan, 'persona.integrity.failed', {
            expectedHash: integrity.expected,
          });
          endSpan(dispatchSpan, { success: false });

          addMessage(projectId, channelId, 'System',
            `[security] ${agent.name} persona tampered — refusing dispatch. Expected hash: ${integrity.expected}`,
            'system', { threadId: threadMeta.threadId });
          return {
            response: 'persona_tampered',
            inputTokens: null,
            outputTokens: null,
            model: agent.model,
            provider: agent.provider || provider,
            confidence: null,
          };
        }
      }
    }

    // Audit logging
    if (config.permissions.auditLog && auditDispatch) {
      auditDispatch(stateManager.projectsDir, projectId, {
        action: 'dispatch', agent: name, channelId,
        permissions: resolvePermissions ? resolvePermissions(name) : [],
        threadId: threadMeta.threadId,
      });
    }

    if (compactionManager.needsCompaction(agent.provider || name, projectId, channelId, threadMeta.threadId)) {
      await runCompaction(name, agent, projectId, channelId, threadMeta.threadId);
    }

    const workingDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
    const context = contextOverride || await formatContext(projectId, channelId, agent.name, userMessage, crossRef, null, threadMeta.threadId, threadMeta.threadLabel);
    const thinkingKey = `${projectId}#${channelId}#${name}`;
    setAgentThinking(deps.thinkingAgents, thinkingKey);
    broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'thinking' });

    const timeout = getAgentTimeout(name);

    events.emit('agent:dispatch', { agent: name, projectId, channelId, threadId: threadMeta.threadId }).catch(() => {});

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const perms = resolvePermissions ? resolvePermissions(name) : [];
        // Same rule as canBypassPermissions(): unscoped operator agents
        // (wizard default `permissions: []`) are trusted to execute; only an
        // explicit non-empty scope without code:execute restricts.
        const bypass = !perms || perms.length === 0 || perms.includes('*') || perms.includes('code:execute');
        const rawResponse = await withTimeout(agent.send(context, workingDir, { bypassPermissions: bypass, maxTurns: threadMeta.maxTurns }), timeout, agent.name);
        setAgentIdle(deps.thinkingAgents, thinkingKey);

        let response, inputTokens, outputTokens, model, responseProvider, confidence;
        if (rawResponse && typeof rawResponse === 'object' && 'text' in rawResponse) {
          response = rawResponse.text;
          inputTokens = rawResponse.inputTokens ?? null;
          outputTokens = rawResponse.outputTokens ?? null;
          model = rawResponse.model || agent.model;
          responseProvider = rawResponse.provider || provider;
          confidence = rawResponse.confidence || null;
        } else {
          response = rawResponse;
          inputTokens = null;
          outputTokens = null;
          model = agent.model;
          responseProvider = provider;
          confidence = null;
        }

        // --- Memory Write-Back: Explicit Memory.save() ---
        if (memoryWriteBackService && parseExplicitMemoryCommands) {
          try {
            const memoryCandidates = parseExplicitMemoryCommands(response, name);
            for (const candidate of memoryCandidates) {
              memoryWriteBackService.add(
                candidate.agentId,
                candidate.category,
                candidate.content,
                candidate.source,
                candidate.tags,
                candidate.confidence
              );
            }
            if (memoryCandidates.length > 0) {
              log.debug('Explicit memory candidates added to write-back service', { agent: name, count: memoryCandidates.length });
            }
          } catch (memErr) {
            log.warn('Failed to parse or add explicit memory from agent response', { agent: name, error: memErr.message });
          }
        }
        // --- End Memory Write-Back ---

        if (fallbackStates.has(name)) {
          log.info('Fallback cleared, back on primary', { agent: name, model: agent.model });
          fallbackStates.delete(name);
        }

        if (response && MODEL_NOT_FOUND_RE.test(response)) {
          throw new Error(`Model not found: ${model}`);
        }

        if (response && RATE_LIMIT_RE.test(response)) {
          throw new Error(`Rate limit exceeded: ${response}`);
        }
        
        if (response && TRANSIENT_ERROR_RE.test(response)) {
            throw new Error(`Transient error: ${response}`);
        }

        if (circuitBreaker) {
          circuitBreaker.recordSuccess(provider);
          circuitBreaker.recordAgentSuccess(name);
        }

        const successDurationMs = Date.now() - startTime;
        dispatchSpan.setAttribute('durationMs', successDurationMs);
        dispatchSpan.setAttribute('success', true);
        endSpan(dispatchSpan, { success: true });

        if (response && !isNoiseResponse(response)) {
          if (!threadMeta.silent) {
            addMessage(projectId, channelId, agent.name, response, 'message', {
              model: agent.model,
              threadId: threadMeta.threadId,
              replyTo: threadMeta.replyTo,
            });
          }
        } else {
          broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'passed' });
        }
        return {
          response: response || null,
          inputTokens,
          outputTokens,
          model,
          provider: responseProvider,
          confidence,
        };
      } catch (err) {
        const providerError = toProviderError(err, { provider });
        const errMessage = providerError.message || err.message || String(err);
        const isTransient = providerError.isTransient() || TRANSIENT_ERROR_RE.test(errMessage) || RATE_LIMIT_RE.test(errMessage);
        if (isTransient && attempt < RETRY_CONFIG.maxRetries) {
          const backoffMs = computeBackoffWithJitter(attempt, RETRY_CONFIG.initialBackoffMs, RETRY_CONFIG.maxBackoffMs);
          log.warn(`Transient error for agent ${name}. Retrying in ${backoffMs}ms (attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries})`, { error: errMessage });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        
        setAgentIdle(deps.thinkingAgents, thinkingKey);
        // non-transient error or retries exhausted
        const isTimeout = errMessage.includes('timed out') || /timeout/i.test(errMessage);
        const isModelError = MODEL_NOT_FOUND_RE.test(errMessage);
        const isRateLimit = !isModelError && (providerError.isRateLimited() || RATE_LIMIT_RE.test(errMessage));
        const isSigterm = /exit 143/.test(errMessage);
        const isSandboxLimit = /per-provider limit reached/.test(errMessage);
        const isSandboxDuplicate = /already has an active process/.test(errMessage);
        const isTransientError = !isModelError && !isRateLimit && (
          TRANSIENT_ERROR_RE.test(errMessage) ||
          (providerError.errorType === 'NETWORK_ERROR' && providerError.isTransient())
        );

        if (circuitBreaker && !isRateLimit && !isSigterm && !isSandboxLimit && !isSandboxDuplicate) {
          // isRateLimit is guarded out above (rate-limit errors don't trip the CB
          // here — they set a cooldown directly). So the remaining failure modes
          // are: model-not-found (auth/config), timeout, transient, or unknown.
          const cbReason = isModelError ? 'auth_error'
            : isTimeout ? 'timeout'
            : isTransientError ? 'transient'
            : 'unknown';
          circuitBreaker.recordFailure(provider, null, cbReason);
          circuitBreaker.recordAgentFailure(name, null, cbReason);
        }

        if (isModelError) {
          log.error('Agent model not found — config error, not a rate limit', { agent: name, provider, error: errMessage.slice(0, 200) });

          const durationMs = Date.now() - startTime;
          dispatchSpan.setAttribute('durationMs', durationMs);
          dispatchSpan.setAttribute('success', false);
          dispatchSpan.setAttribute('errorCategory', 'model_not_found');
          setSpanStatus(dispatchSpan, { code: 'error', message: 'Model not found' });
          endSpan(dispatchSpan, { error: err });

          addMessage(projectId, channelId, 'System',
            `${agent.name}: model not found error — check agent model config.`, 'system', { threadId: threadMeta.threadId });
          return {
            response: 'model_error',
            inputTokens: null,
            outputTokens: null,
            model: agent.model,
            provider: agent.provider || provider,
            confidence: null,
          };
        } else if (isSandboxDuplicate) {
          // A turn that belongs to THIS agent must never be voiced by a peer:
          // conversation rounds and explicit @mentions set _noHandoff, and a
          // busy agent is skipped with an honest note instead (operator
          // ruling 2026-08-02 — "it was not sol's place to do so").
          if (threadMeta._noHandoff || threadMeta._explicitlyAddressed) {
            addMessage(projectId, channelId, 'System',
              `${agent.name} is busy right now${threadMeta._explicitlyAddressed ? ' — your message stays addressed to them; mention them again when they free up' : ' — skipping this round'}.`,
              'system', { threadId: threadMeta.threadId });
            broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'busy' });
            return {
              response: 'busy_skipped',
              inputTokens: null,
              outputTokens: null,
              model: agent.model,
              provider: agent.provider || provider,
              confidence: null,
            };
          }
          const handoff = await handoffToPeer(
            name, agent, 'busy (already running)', projectId, channelId, userMessage, crossRef, contextOverride, threadMeta,
          );
          if (handoff) {
            return handoff;
          }
          return {
            response: 'error',
            inputTokens: null,
            outputTokens: null,
            model: agent.model,
            provider: agent.provider || provider,
            confidence: null,
          };
        } else if (isSigterm) {
          const cooldownMs = 2 * 60 * 1000;
          setCooldownUntil(name, Date.now() + cooldownMs, 'sigterm_capacity', {
            confidence: 'soft',
            source: 'sigterm',
          });
          log.warn('Agent killed by SIGTERM (concurrent session limit) — 2m cooldown', { agent: name, provider });
          broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'rate_limited' });
          return {
            response: 'rate_limited',
            inputTokens: null,
            outputTokens: null,
            model: agent.model,
            provider: agent.provider || provider,
            confidence: null,
          };
        } else if (isRateLimit) {
          const mins = setAgentCooldown(name, errMessage);
          const handoff = await handoffToPeer(
            name, agent, `rate limit (${mins}m cooldown)`,
            projectId, channelId, userMessage, crossRef, contextOverride, threadMeta,
          );
          if (handoff) {
            return handoff;
          }
          addMessage(projectId, channelId, 'System',
            `${agent.name} hit rate limit — cooling down for ${mins}m.`, 'system', { threadId: threadMeta.threadId });
          broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'rate_limited' });
          return {
            response: 'rate_limited',
            inputTokens: null,
            outputTokens: null,
            model: agent.model,
            provider: agent.provider || provider,
            confidence: null,
          };
        } else if (isTransientError) {
          const handoff = await handoffToPeer(
            name, agent, 'transient error', projectId, channelId, userMessage, crossRef, contextOverride, threadMeta,
          );
          if (handoff) {
            return handoff;
          }
          broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'error', error: 'Provider temporarily unavailable.' });
          return {
            response: 'transient_error',
            inputTokens: null,
            outputTokens: null,
            model: agent.model,
            provider: agent.provider || provider,
            confidence: null,
          };
        }

        log.error(isTimeout ? 'Agent timeout' : 'Agent error', { agent: name, error: errMessage });

        if (isTimeout) {
          const timeoutSecs = Math.round(timeout / 1000);
          setCooldownUntil(name, Date.now() + config.orchestrator.timeoutCooldownMs, 'timeout', {
            confidence: 'soft',
            source: 'timeout',
          });
          const handoff = await handoffToPeer(
            name, agent, `timeout (${timeoutSecs}s)`,
            projectId, channelId, userMessage, crossRef, contextOverride, threadMeta,
          );
          if (handoff) {
            return handoff;
          }
          broadcastToChannel(projectId, channelId, {
            type: 'status', speaker: name, status: 'timeout', error: errMessage,
          });
          addMessage(projectId, channelId, 'System',
            `${agent.name} timed out (${timeoutSecs}s). Consider retrying or reducing task complexity.`,
            'system', { threadId: threadMeta.threadId });
          return {
            response: 'timed_out',
            inputTokens: null,
            outputTokens: null,
            model: agent.model,
            provider: agent.provider || provider,
            confidence: null,
          };
        }

        setCooldownUntil(name, Date.now() + config.orchestrator.timeoutCooldownMs, 'error_cooldown', {
          confidence: 'soft',
          source: 'error',
        });
        const handoff = await handoffToPeer(
          name, agent, `error (${errMessage})`,
          projectId, channelId, userMessage, crossRef, contextOverride, threadMeta,
        );
        if (handoff) {
          return handoff;
        }

        broadcastToChannel(projectId, channelId, {
          type: 'status', speaker: name, status: 'error', error: errMessage,
        });
        addMessage(projectId, channelId, 'System',
          `${agent.name} error: ${errMessage}`,
          'system', { threadId: threadMeta.threadId });
        return {
          response: 'error',
          inputTokens: null,
          outputTokens: null,
          model: agent.model,
          provider: agent.provider || provider,
          confidence: null,
        };
      }
    }
  }


  // Check if any agent in provider's shared bucket is rate limited (Codex only)
  function isModelBucketLimited(model) {
    for (const [id, entry] of agentCooldowns.entries()) {
      const a = agents[id];
      if (a?.model === model && entry && Date.now() < entry.until) {
        return true;
      }
    }
    return false;
  }

  return {
    getAgentResponse,
    isAgentCoolingDown,
    setAgentCooldown,
    agentCooldowns,
    persistCooldowns,
    fallbackStates,
    getAgentTimeout,
    withTimeout,
    isModelBucketLimited,
    isModelRateLimited,
    getCachedRateLimit,
    getRateLimitStatus,
    startRateLimitProbe,
    stopRateLimitProbe,
    startFallbackCleanup,
    stopFallbackCleanup,
    RATE_LIMIT_RE,
    MODEL_NOT_FOUND_RE,
    RATE_LIMIT_SEMANTICS,
  };
}

// Export error classification utilities and regex patterns for use across orchestrator
export { classifyError, classifyAndLog, CATEGORIES, RATE_LIMIT_RE, MODEL_NOT_FOUND_RE, TRANSIENT_ERROR_RE, RATE_LIMIT_SEMANTICS };
