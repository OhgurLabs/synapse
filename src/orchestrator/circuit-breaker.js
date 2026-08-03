// Circuit breaker for agent providers.
// Tracks consecutive failures per provider and trips open after threshold.
// States: closed (normal) → open (reject) → half-open (probe one request).
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';
import { emitTelemetry } from '../telemetry.js';

const log = createLogger('circuit-breaker');

export const STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

// Half-open probe admission control. canRequest() is called both as a
// pre-dispatch gate AND as a pure eligibility filter (router, availability,
// role-pause checks) — often twice in the same seek flow — so a strict
// one-slot design would let a filter call starve the actual dispatch and
// livelock the half-open state. Instead: the first admission opens a short
// coalescing window (same-flow re-checks and the immediate burst pass), then
// further admissions are denied until the TTL expires or a probe outcome
// (recordSuccess/recordFailure) resets the window.
const HALF_OPEN_PROBE_COALESCE_MS = 2_000;
const HALF_OPEN_PROBE_TTL_MS = 120_000;

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {number} opts.failureThreshold - consecutive failures before tripping open
   * @param {number} opts.cooldownMs - ms before open→half-open probe
   * @param {number} opts.maxFailureAgeMs - failures older than this are ignored (default 1h)
   * @param {import('../events.js').EventBus} [opts.events] - EventBus for state transition events
   * @param {(transition: object) => (void|Promise<void>)} [opts.onTransition] - Optional direct callback for transition persistence
   * @param {string} [opts.statePath] - Optional path for persisting circuit breaker state
   * @param {Map<string, {failureThreshold?: number, cooldownMs?: number, maxFailureAgeMs?: number}>} [opts.agentThresholds] - Per-agent threshold overrides
   */
  constructor({
    failureThreshold = 3,
    cooldownMs = 30000,
    maxFailureAgeMs = 3600000,
    events = null,
    onTransition = null,
    statePath = null,
    agentThresholds = null,
    resolveProvider = null,
    knownProviders = null,
    providerFallbacks = null,
    approvalTimeoutThreshold = 3,
    approvalTimeoutWindowMs = 24 * 60 * 60 * 1000,
  } = {}) {
    this._failureThreshold = failureThreshold;
    this._cooldownMs = cooldownMs;
    this._maxFailureAgeMs = maxFailureAgeMs;
    this._events = events;
    this._onTransition = onTransition;
    this._statePath = statePath;
    this._agentThresholds = agentThresholds;
    this._resolveProvider = typeof resolveProvider === 'function' ? resolveProvider : null;
    this._knownProviders = new Set(
      (Array.isArray(knownProviders) ? knownProviders : [])
        .map(provider => this._normalizeProviderName(provider))
        .filter(Boolean)
    );
    this._providerFallbacks = this._normalizeFallbacks(providerFallbacks);
    // provider → { state, failureTimestamps, openedAt }
    this._providers = new Map();
    // agentId → { state, failureTimestamps, openedAt }
    this._agents = new Map();
    // campaignId → { state, timeoutTimestamps, openedAt }
    this._campaigns = new Map();
    this._approvalTimeoutThreshold = approvalTimeoutThreshold;
    this._approvalTimeoutWindowMs = approvalTimeoutWindowMs;

    // Load persisted state if statePath is configured
    if (this._statePath) {
      this._loadState();
    }
  }

  _normalizeFallbacks(providerFallbacks) {
    const defaults = {
      claude: ['codex', 'gemini', 'ollama'],
      codex: ['gemini', 'ollama'],
      gemini: ['ollama'],
    };
    const merged = { ...defaults };
    if (providerFallbacks && typeof providerFallbacks === 'object') {
      for (const [provider, chain] of Object.entries(providerFallbacks)) {
        merged[this._normalizeProviderName(provider)] = chain;
      }
    }
    for (const [provider, chain] of Object.entries(merged)) {
      if (!Array.isArray(chain)) {
        merged[provider] = [];
        continue;
      }
      merged[provider] = chain
        .filter(Boolean)
        .map(p => this._normalizeProviderName(p));
    }
    return merged;
  }

  _normalizeProviderName(provider) {
    const normalized = String(provider || '').toLowerCase();
    if (normalized === 'anthropic') return 'claude';
    if (normalized === 'openai') return 'codex';
    return normalized;
  }

  _getOrCreate(provider) {
    provider = this._normalizeProviderName(provider);
    if (!this._providers.has(provider)) {
      this._providers.set(provider, {
        state: STATES.CLOSED,
        failureTimestamps: [],
        failureReasons: [], // parallel array; same length as failureTimestamps
        openedAt: null,
        held: false,
      });
    }
    const entry = this._providers.get(provider);
    // Backward-compat: hydrate failureReasons for entries loaded from older
    // persisted state where the field didn't exist.
    if (!Array.isArray(entry.failureReasons)) entry.failureReasons = [];
    return entry;
  }

  _getOrCreateAgent(agentId) {
    if (!this._agents.has(agentId)) {
      this._agents.set(agentId, {
        state: STATES.CLOSED,
        failureTimestamps: [],
        failureReasons: [],
        openedAt: null,
        held: false,
      });
    }
    const entry = this._agents.get(agentId);
    if (!Array.isArray(entry.failureReasons)) entry.failureReasons = [];
    return entry;
  }

  _getOrCreateCampaign(campaignId) {
    if (!this._campaigns.has(campaignId)) {
      this._campaigns.set(campaignId, {
        state: STATES.CLOSED,
        timeoutTimestamps: [],
        openedAt: null,
        held: false,
      });
    }
    return this._campaigns.get(campaignId);
  }

  /**
   * Count only recent timeouts within the approval timeout window.
   * @private
   */
  _recentTimeouts(entry) {
    const cutoff = Date.now() - this._approvalTimeoutWindowMs;
    entry.timeoutTimestamps = entry.timeoutTimestamps.filter(ts => ts > cutoff);
    return entry.timeoutTimestamps.length;
  }

  /**
   * Update default thresholds on the live instance. Used by the settings
   * PATCH endpoint — without this, operator tunes only landed in config and
   * the running breaker kept its constructor-time snapshot until restart.
   * Per-key overrides in _agentThresholds are unaffected.
   */
  updateSettings({ failureThreshold, cooldownMs, maxFailureAgeMs } = {}) {
    if (Number.isInteger(failureThreshold) && failureThreshold >= 1) this._failureThreshold = failureThreshold;
    if (Number.isFinite(cooldownMs) && cooldownMs >= 1000) this._cooldownMs = cooldownMs;
    if (Number.isFinite(maxFailureAgeMs) && maxFailureAgeMs >= 0) this._maxFailureAgeMs = maxFailureAgeMs;
    return {
      failureThreshold: this._failureThreshold,
      cooldownMs: this._cooldownMs,
      maxFailureAgeMs: this._maxFailureAgeMs,
    };
  }

  /**
   * Get thresholds for a given key (provider or agent).
   * Checks thresholdOverrides Map for key-specific overrides, falls back to defaults.
   * @private
   */
  _getThresholds(key) {
    if (this._agentThresholds && this._agentThresholds.has(key)) {
      const overrides = this._agentThresholds.get(key);
      return {
        failureThreshold: overrides.failureThreshold ?? this._failureThreshold,
        cooldownMs: overrides.cooldownMs ?? this._cooldownMs,
        maxFailureAgeMs: overrides.maxFailureAgeMs ?? this._maxFailureAgeMs,
      };
    }
    return {
      failureThreshold: this._failureThreshold,
      cooldownMs: this._cooldownMs,
      maxFailureAgeMs: this._maxFailureAgeMs,
    };
  }

  /**
   * Kept for backward compatibility. Delegates to _getThresholds.
   * @private
   * @deprecated Use _getThresholds instead
   */
  _getAgentThresholds(agentId) {
    return this._getThresholds(agentId);
  }

  /**
   * Count only recent failures (within the given maxFailureAgeMs threshold).
   * Trims the parallel failureReasons array to match the kept timestamps so
   * reason ↔ timestamp pairing survives across age-out evictions.
   * @private
   */
  _recentFailures(entry, maxFailureAgeMs) {
    const cutoff = Date.now() - maxFailureAgeMs;
    // Build keep-mask once, apply to both arrays — preserves index alignment.
    const keep = entry.failureTimestamps.map(ts => ts > cutoff);
    entry.failureTimestamps = entry.failureTimestamps.filter((_, i) => keep[i]);
    if (Array.isArray(entry.failureReasons)) {
      entry.failureReasons = entry.failureReasons.filter((_, i) => keep[i]);
    } else {
      entry.failureReasons = [];
    }
    return entry.failureTimestamps.length;
  }

  /**
   * Compute the dominant (most-frequent) reason from the entry's failureReasons.
   * Tie-break by recency (most recent wins). Returns 'unknown' on empty.
   * Pure read; does not mutate.
   * @private
   */
  _dominantReason(entry) {
    const reasons = Array.isArray(entry.failureReasons) ? entry.failureReasons : [];
    if (reasons.length === 0) return 'unknown';
    const counts = new Map();
    for (const r of reasons) counts.set(r, (counts.get(r) || 0) + 1);
    let best = null, bestCount = -1;
    // Iterate in original order so the first-encountered max stays; then override
    // if a tie appears with a more recent occurrence.
    for (const [reason, count] of counts) {
      if (count > bestCount) { best = reason; bestCount = count; }
    }
    // Tie-break: if the LAST reason has the same count as best, prefer the last
    // (recency bias). This biases toward the actual current failure mode.
    const lastReason = reasons[reasons.length - 1];
    if (counts.get(lastReason) === bestCount && lastReason !== best) {
      best = lastReason;
    }
    return best || 'unknown';
  }

  _emitTransition(
    provider,
    newState,
    previousState,
    {
      trigger = null,
      failureCount = null,
      timestamp = null,
      agentId = null,
      correlationKeys = null,
      dispatchId = null,
      traceId = null,
      campaignId = null,
    } = {}
  ) {
    const eventName = `circuit_breaker:${newState}`;
    const key = agentId !== null ? agentId : provider;
    const entry = agentId !== null ? this._getOrCreateAgent(agentId) : this._getOrCreate(provider);
    const thresholds = this._getThresholds(key);
    const correlation = (correlationKeys && typeof correlationKeys === 'object' && !Array.isArray(correlationKeys))
      ? correlationKeys
      : {};
    const resolvedDispatchId = correlation.dispatchId ?? dispatchId ?? null;
    const resolvedTraceId = correlation.traceId ?? traceId ?? null;
    const resolvedCampaignId = correlation.campaignId ?? campaignId ?? null;
    // We do not currently read a global correlation context; callers must pass
    // correlationKeys/dispatchId/traceId/campaignId for observability. If they
    // don't, we keep these fields as explicit nulls to preserve the event shape
    // expected by timeline/audit consumers.
    const computedFailureCount = failureCount ?? this._recentFailures(entry, thresholds.maxFailureAgeMs);
    // dominantReason: the most-frequent reason in the recent failure window.
    // Consumed by the orchestrator cooldown-setter to pick a proportional cooldown.
    // Always present in payload (defaults to 'unknown'); cooldown-setter must
    // tolerate missing/unknown values for backward compatibility.
    const dominantReason = this._dominantReason(entry);
    const payload = {
      provider,
      agentId,
      state: newState,
      newState,
      previousState,
      failureCount: computedFailureCount,
      trigger: trigger ?? { reason: 'unspecified' },
      dominantReason,
      timestamp: timestamp ?? Date.now(),
      // Correlation IDs are optional. If callers do not pass correlation context,
      // these remain null to preserve the event schema for audit/timeline consumers.
      dispatchId: resolvedDispatchId,
      traceId: resolvedTraceId,
      campaignId: resolvedCampaignId,
    };
    log.info('Circuit breaker transition', payload);
    if (this._onTransition) {
      try {
        const maybePromise = this._onTransition(payload);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch(() => {});
        }
      } catch {
        // Ignore persistence callback errors to avoid breaking CB flow.
      }
    }
    if (this._events) {
      this._events.emit(eventName, payload).catch(() => {});
      const telemetryAgentId = agentId ?? provider;
      emitTelemetry(this._events, 'circuit_breaker_warning', {
        agentId: telemetryAgentId,
        phase: 'system',
        payload: {
          provider,
          agentId,
          state: newState,
          previousState,
          failures: payload.failureCount,
          trigger: payload.trigger,
          dispatchId: resolvedDispatchId,
          traceId: resolvedTraceId,
          campaignId: resolvedCampaignId,
        },
      });
    }
  }

  /**
   * Get the effective state for a provider.
   * If currently open and cooldown has elapsed, transitions to half-open.
   * If open but all failures have aged out, transitions directly to closed.
   */
  getStateProvider(provider) {
    provider = this._normalizeProviderName(provider);
    return this._getStateProviderOrAgent(provider, true);
  }

  /**
   * Get the effective state for an agent or provider (internal helper).
   * @private
   */
  _getStateProviderOrAgent(key, isProvider = false) {
    const entry = isProvider ? this._getOrCreate(key) : this._getOrCreateAgent(key);
    const thresholds = isProvider ? this._getThresholds(key) : this._getAgentThresholds(key);

    if (entry.held) {
      return STATES.OPEN;
    }

    if (entry.state === STATES.OPEN && entry.openedAt !== null) {
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      if (recentCount < thresholds.failureThreshold) {
        entry.state = STATES.CLOSED;
        entry.openedAt = null;
        this._emitTransition(isProvider ? key : null, STATES.CLOSED, STATES.OPEN, {
          trigger: { reason: 'failures_aged_out', source: 'getState' },
          failureCount: recentCount,
          agentId: isProvider ? null : key,
        });
        this._persistState();
      } else if (Date.now() - entry.openedAt >= thresholds.cooldownMs) {
        entry.state = STATES.HALF_OPEN;
        entry.probeStartedAt = null; // fresh half-open window — no probe in flight yet
        this._emitTransition(isProvider ? key : null, STATES.HALF_OPEN, STATES.OPEN, {
          trigger: { reason: 'cooldown_elapsed', source: 'getState' },
          failureCount: recentCount,
          agentId: isProvider ? null : key,
        });
        this._persistState();
      }
    }
    return entry.state;
  }

  /**
   * Check if a request can be dispatched to this provider.
   * Returns true for closed and half-open states; false for open.
   */
  canRequestProvider(provider) {
    provider = this._normalizeProviderName(provider);
    const state = this.getStateProvider(provider);
    if (state === STATES.OPEN) return false;
    if (state === STATES.HALF_OPEN) {
      // Half-open admits one probe burst, not every waiting caller — a
      // thundering herd re-fails a barely-recovered provider. See the
      // HALF_OPEN_PROBE_* constants for why this is a window, not a slot.
      const entry = this._getOrCreate(provider);
      const now = Date.now();
      if (entry.probeStartedAt) {
        const elapsed = now - entry.probeStartedAt;
        if (elapsed < HALF_OPEN_PROBE_COALESCE_MS) return true;
        if (elapsed < HALF_OPEN_PROBE_TTL_MS) return false;
      }
      entry.probeStartedAt = now;
    }
    return true;
  }

  /**
   * Record a successful response from the provider.
   * Resets failure timestamps in closed state.
   * Transitions half-open → closed on success.
   */
  recordSuccessProvider(provider, correlationKeys = null) {
    provider = this._normalizeProviderName(provider);
    const entry = this._getOrCreate(provider);
    if (entry.held) {
      return;
    }
    entry.probeStartedAt = null; // probe (if any) resolved
    const prevState = entry.state;

    if (prevState === STATES.HALF_OPEN) {
      entry.state = STATES.CLOSED;
      entry.failureTimestamps = [];
      entry.failureReasons = [];
      entry.openedAt = null;
      this._emitTransition(provider, STATES.CLOSED, STATES.HALF_OPEN, {
        trigger: { reason: 'probe_success', source: 'recordSuccess' },
        failureCount: 0,
        correlationKeys,
      });
      this._persistState();
    } else if (prevState === STATES.CLOSED) {
      entry.failureTimestamps = [];
      entry.failureReasons = [];
      this._persistState();
    }
  }

  /**
   * Record a failure from the provider.
   * In closed state: records timestamp, trips open at threshold.
   * In half-open state: probe failed, re-open immediately.
   *
   * @param {string} provider
   * @param {object|null} correlationKeys - dispatch/trace/campaign IDs (or legacy null)
   * @param {string} [failureReason='unknown'] - one of: 'rate_limit'|'timeout'|
   *   'empty_response'|'transient'|'auth_error'|'unknown'. The reason is stored
   *   in the entry's failureReasons ring buffer (in lockstep with failureTimestamps)
   *   and surfaces as `dominantReason` on the circuit_breaker:open event payload.
   *   Callers that pre-date the failure-reason fix omit this arg → defaults to
   *   'unknown', which the cooldown-setter treats as a defensive short cooldown.
   */
  recordFailureProvider(provider, correlationKeys = null, failureReason = 'unknown') {
    provider = this._normalizeProviderName(provider);
    const entry = this._getOrCreate(provider);
    if (entry.held) {
      return;
    }
    entry.probeStartedAt = null; // probe (if any) resolved
    const thresholds = this._getThresholds(provider);
    const currentState = this.getStateProvider(provider);
    const reason = (typeof failureReason === 'string' && failureReason) ? failureReason : 'unknown';

    if (currentState === STATES.HALF_OPEN) {
      entry.state = STATES.OPEN;
      entry.openedAt = Date.now();
      // Synthesize a full failure window seeded with the probe-failure reason
      // so dominantReason on the re-open event reflects the actual current mode,
      // not the stale pre-probe history.
      entry.failureTimestamps = Array.from({ length: thresholds.failureThreshold }, () => Date.now());
      entry.failureReasons = Array.from({ length: thresholds.failureThreshold }, () => reason);
      this._emitTransition(provider, STATES.OPEN, STATES.HALF_OPEN, {
        trigger: { reason: 'probe_failure', source: 'recordFailure', failureReason: reason },
        failureCount: entry.failureTimestamps.length,
        correlationKeys,
      });
      this._persistState();
    } else if (currentState === STATES.CLOSED) {
      entry.failureTimestamps.push(Date.now());
      entry.failureReasons.push(reason);
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      if (recentCount >= thresholds.failureThreshold) {
        entry.state = STATES.OPEN;
        entry.openedAt = Date.now();
        this._emitTransition(provider, STATES.OPEN, STATES.CLOSED, {
          trigger: { reason: 'failure_threshold', source: 'recordFailure', failureReason: reason },
          failureCount: recentCount,
          correlationKeys,
        });
        this._persistState();
      } else {
        // Failure recorded but threshold not reached yet
        this._persistState();
      }
    }
    // If already OPEN (cooldown not yet elapsed), no-op
  }

  /**
   * Get the recent failure count for a provider (useful for monitoring).
   */
  getFailuresProvider(provider) {
    provider = this._normalizeProviderName(provider);
    const thresholds = this._getThresholds(provider);
    return this._recentFailures(this._getOrCreate(provider), thresholds.maxFailureAgeMs);
  }

  /**
   * Resolve whether a key targets provider-level or agent-level state.
   * String keys are provider-scoped for backward compatibility.
   * Object keys may specify `{ agentId }` or `{ provider }`.
   * @private
   */
  _resolveScopeKey(key) {
    if (key && typeof key === 'object' && !Array.isArray(key)) {
      if (typeof key.agentId === 'string' && key.agentId.length > 0) {
        return { scope: 'agent', id: key.agentId };
      }
      if (typeof key.provider === 'string' && key.provider.length > 0) {
        return { scope: 'provider', id: this._normalizeProviderName(key.provider) };
      }
    }
    return { scope: 'provider', id: this._normalizeProviderName(key) };
  }

  _resolveRequestKey(key) {
    if (key && typeof key === 'object' && !Array.isArray(key)) {
      if (typeof key.agentId === 'string' && key.agentId.length > 0) {
        const resolvedProvider = typeof key.provider === 'string'
          ? this._normalizeProviderName(key.provider)
          : this._normalizeProviderName(this._resolveProvider?.(key.agentId) || null);
        return { scope: 'agent', id: key.agentId, provider: resolvedProvider };
      }
      if (typeof key.provider === 'string' && key.provider.length > 0) {
        return { scope: 'provider', id: this._normalizeProviderName(key.provider) };
      }
    }
    if (typeof key === 'string') {
      const normalizedKey = this._normalizeProviderName(key);
      if (this._knownProviders.has(normalizedKey)) return { scope: 'provider', id: normalizedKey };
      const resolvedProvider = this._normalizeProviderName(this._resolveProvider?.(key) || null);
      if (resolvedProvider) return { scope: 'agent', id: key, provider: resolvedProvider };
      return { scope: 'provider', id: normalizedKey };
    }
    return { scope: 'provider', id: this._normalizeProviderName(key) };
  }

  /**
   * Backward-compatible non-suffixed helpers.
   * - String key: provider scope (legacy behavior)
   * - Object key with `agentId`: agent scope
   * - Object key with `provider`: provider scope
   */
  getState(key) {
    const resolved = this._resolveScopeKey(key);
    return resolved.scope === 'agent'
      ? this.getAgentState(resolved.id)
      : this.getStateProvider(resolved.id);
  }

  canRequest(key) {
    const resolved = this._resolveRequestKey(key);
    return resolved.scope === 'agent'
      ? (this.canAgentRequest(resolved.id)
        && (resolved.provider ? this.canRequestProvider(resolved.provider) : true))
      : this.canRequestProvider(resolved.id);
  }

  recordSuccess(key, correlationKeys = null) {
    const resolved = this._resolveScopeKey(key);
    return resolved.scope === 'agent'
      ? this.recordAgentSuccess(resolved.id, correlationKeys)
      : this.recordSuccessProvider(resolved.id, correlationKeys);
  }

  /**
   * Backward-compatible dispatcher. Forwards optional failureReason to whichever
   * variant (agent vs provider) is resolved.
   */
  recordFailure(key, correlationKeys = null, failureReason = 'unknown') {
    const resolved = this._resolveScopeKey(key);
    return resolved.scope === 'agent'
      ? this.recordAgentFailure(resolved.id, correlationKeys, failureReason)
      : this.recordFailureProvider(resolved.id, correlationKeys, failureReason);
  }

  getFailures(key) {
    const resolved = this._resolveScopeKey(key);
    return resolved.scope === 'agent'
      ? this.getFailuresAgent(resolved.id)
      : this.getFailuresProvider(resolved.id);
  }

  /**
   * Return fallback providers for a given primary provider, in priority order.
   * Defaults: claude → codex → gemini.
   */
  getFallbackProviders(provider, { includeSelf = false } = {}) {
    const normalized = this._normalizeProviderName(provider);
    const chain = this._providerFallbacks?.[normalized] || [];
    if (includeSelf) return [normalized, ...chain];
    return [...chain];
  }

  /**
   * Pick the next available fallback provider for a given primary provider.
   * Returns null if none are available.
   */
  getNextFallbackProvider(provider, { exclude = [], requireAvailable = true } = {}) {
    const excluded = new Set((exclude || []).map(p => this._normalizeProviderName(p)));
    const chain = this.getFallbackProviders(provider);
    for (const candidate of chain) {
      if (excluded.has(candidate)) continue;
      if (!requireAvailable || this.canRequestProvider(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Get the recent failure count for an agent (useful for monitoring).
   */
  getFailuresAgent(agentId) {
    const thresholds = this._getAgentThresholds(agentId);
    return this._recentFailures(this._getOrCreateAgent(agentId), thresholds.maxFailureAgeMs);
  }

  /**
   * Get the effective state for an agent.
   * If currently open and cooldown has elapsed, transitions to half-open.
   * If open but all failures have aged out, transitions directly to closed.
   */
  getAgentState(agentId) {
    const entry = this._getOrCreateAgent(agentId);
    const thresholds = this._getAgentThresholds(agentId);

    if (entry.held) {
      return STATES.OPEN;
    }

    if (entry.state === STATES.OPEN && entry.openedAt !== null) {
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      if (recentCount < thresholds.failureThreshold) {
        entry.state = STATES.CLOSED;
        entry.openedAt = null;
        this._emitTransition(null, STATES.CLOSED, STATES.OPEN, {
          trigger: { reason: 'failures_aged_out', source: 'getState' },
          failureCount: recentCount,
          agentId,
        });
        this._persistState();
      } else if (Date.now() - entry.openedAt >= thresholds.cooldownMs) {
        entry.state = STATES.HALF_OPEN;
        this._emitTransition(null, STATES.HALF_OPEN, STATES.OPEN, {
          trigger: { reason: 'cooldown_elapsed', source: 'getState' },
          failureCount: recentCount,
          agentId,
        });
        this._persistState();
      }
    }
    return entry.state;
  }

  /**
   * Check if a request can be dispatched to this agent.
   * Returns true for closed and half-open states; false for open.
   */
  canAgentRequest(agentId) {
    return this.getAgentState(agentId) !== STATES.OPEN;
  }

  /**
   * Record a successful response from the agent.
   * Resets failure timestamps in closed state.
   * Transitions half-open → closed on success.
   */
  recordAgentSuccess(agentId, correlationKeys = null) {
    const entry = this._getOrCreateAgent(agentId);
    if (entry.held) {
      return;
    }
    const prevState = entry.state;

    if (prevState === STATES.HALF_OPEN) {
      entry.state = STATES.CLOSED;
      entry.failureTimestamps = [];
      entry.failureReasons = [];
      entry.openedAt = null;
      this._emitTransition(null, STATES.CLOSED, STATES.HALF_OPEN, {
        trigger: { reason: 'probe_success', source: 'recordSuccess' },
        failureCount: 0,
        agentId,
        correlationKeys,
      });
      this._persistState();
    } else if (prevState === STATES.CLOSED) {
      entry.failureTimestamps = [];
      entry.failureReasons = [];
      this._persistState();
    }
  }

  /**
   * Record a failure from the agent.
   * In closed state: records timestamp, trips open at threshold.
   * In half-open state: probe failed, re-open immediately.
   */
  recordAgentFailure(agentId, correlationKeys = null, failureReason = 'unknown') {
    const entry = this._getOrCreateAgent(agentId);
    if (entry.held) {
      return;
    }
    const thresholds = this._getAgentThresholds(agentId);
    const currentState = this.getAgentState(agentId);
    const reason = (typeof failureReason === 'string' && failureReason) ? failureReason : 'unknown';

    if (currentState === STATES.HALF_OPEN) {
      entry.state = STATES.OPEN;
      entry.openedAt = Date.now();
      entry.failureTimestamps = Array.from({ length: thresholds.failureThreshold }, () => Date.now());
      entry.failureReasons = Array.from({ length: thresholds.failureThreshold }, () => reason);
      this._emitTransition(null, STATES.OPEN, STATES.HALF_OPEN, {
        trigger: { reason: 'probe_failure', source: 'recordFailure', failureReason: reason },
        failureCount: entry.failureTimestamps.length,
        agentId,
        correlationKeys,
      });
      this._persistState();
    } else if (currentState === STATES.CLOSED) {
      entry.failureTimestamps.push(Date.now());
      entry.failureReasons.push(reason);
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      if (recentCount >= thresholds.failureThreshold) {
        entry.state = STATES.OPEN;
        entry.openedAt = Date.now();
        this._emitTransition(null, STATES.OPEN, STATES.CLOSED, {
          trigger: { reason: 'failure_threshold', source: 'recordFailure', failureReason: reason },
          failureCount: recentCount,
          agentId,
          correlationKeys,
        });
        this._persistState();
      } else {
        this._persistState();
      }
    }
  }

  /**
   * Reset a specific agent back to closed with zero failures.
   */
  resetAgent(agentId) {
    const hadState = this._agents.has(agentId);
    const prevState = hadState ? this._agents.get(agentId).state : null;
    this._agents.delete(agentId);
    if (hadState && prevState !== STATES.CLOSED) {
      log.info('Circuit breaker manually reset', { agentId, previousState: prevState });
      this._emitTransition(null, STATES.CLOSED, prevState, {
        trigger: { reason: 'manual_reset', source: 'resetAgent' },
        failureCount: 0,
        agentId,
      });
    }
    this._persistState();
  }

  /**
   * Reset all agents.
   */
  resetAllAgents() {
    this._agents.clear();
    this._persistState();
  }

  /**
   * Get the timestamp when an open circuit will transition to half-open.
   * Returns null if the provider is not open or has no openedAt.
   */
  getRecoveryTimeProvider(provider) {
    const entry = this._providers.get(provider);
    if (!entry || entry.state !== STATES.OPEN || !entry.openedAt) return null;
    if (entry.held) return null;
    const thresholds = this._getThresholds(provider);
    return entry.openedAt + thresholds.cooldownMs;
  }

  /**
   * Backward-compatible provider recovery helper.
   */
  getRecoveryTime(provider) {
    return this.getRecoveryTimeProvider(provider);
  }

  /**
   * Get the timestamp when an open circuit will transition to half-open.
   * Returns null if the agent is not open or has no openedAt.
   */
  getAgentRecoveryTime(agentId) {
    const entry = this._agents.get(agentId);
    if (!entry || entry.state !== STATES.OPEN || !entry.openedAt) return null;
    if (entry.held) return null;
    const thresholds = this._getAgentThresholds(agentId);
    return entry.openedAt + thresholds.cooldownMs;
  }

  /**
   * Reset a specific provider back to closed with zero failures.
   */
  reset(key) {
    const resolved = this._resolveScopeKey(key);
    if (resolved.scope === 'agent') {
      return this.resetAgent(resolved.id);
    }

    const provider = resolved.id;
    const hadState = this._providers.has(provider);
    const prevState = hadState ? this._providers.get(provider).state : null;
    this._providers.delete(provider);
    if (hadState && prevState !== STATES.CLOSED) {
      log.info('Circuit breaker manually reset', { provider, previousState: prevState });
      this._emitTransition(provider, STATES.CLOSED, prevState, {
        trigger: { reason: 'manual_reset', source: 'reset' },
        failureCount: 0,
      });
    }
    this._persistState();
  }

  /**
   * Reset all providers.
   */
  resetAll() {
    this._providers.clear();
    this._persistState();
  }

  /**
   * Force a circuit breaker into an open, held state (manual hold).
   * Held circuits remain open until reset.
   */
  hold(key, { correlationKeys = null } = {}) {
    const resolved = this._resolveScopeKey(key);
    if (resolved.scope === 'agent') {
      return this.holdAgent(resolved.id, { correlationKeys });
    }
    return this.holdProvider(resolved.id, { correlationKeys });
  }

  holdProvider(provider, { correlationKeys = null } = {}) {
    const entry = this._getOrCreate(provider);
    const prevState = entry.state;
    const thresholds = this._getThresholds(provider);
    if (entry.held && prevState === STATES.OPEN) {
      this._persistState();
      return;
    }
    entry.state = STATES.OPEN;
    entry.held = true;
    entry.openedAt = Date.now();
    entry.failureTimestamps = Array.from({ length: thresholds.failureThreshold }, () => Date.now());
    this._emitTransition(provider, STATES.OPEN, prevState, {
      trigger: { reason: 'manual_hold', source: 'hold' },
      failureCount: entry.failureTimestamps.length,
      correlationKeys,
    });
    this._persistState();
  }

  holdAgent(agentId, { correlationKeys = null } = {}) {
    const entry = this._getOrCreateAgent(agentId);
    const prevState = entry.state;
    const thresholds = this._getAgentThresholds(agentId);
    if (entry.held && prevState === STATES.OPEN) {
      this._persistState();
      return;
    }
    entry.state = STATES.OPEN;
    entry.held = true;
    entry.openedAt = Date.now();
    entry.failureTimestamps = Array.from({ length: thresholds.failureThreshold }, () => Date.now());
    this._emitTransition(null, STATES.OPEN, prevState, {
      trigger: { reason: 'manual_hold', source: 'holdAgent' },
      failureCount: entry.failureTimestamps.length,
      agentId,
      correlationKeys,
    });
    this._persistState();
  }

  /**
   * Force a circuit breaker to a specific state, bypassing normal transition rules.
   * This is an operator intervention that allows manual control of circuit breaker state.
   * @param {string|object} key - Provider string or object with {agentId} or {provider}
   * @param {string} targetState - One of STATES.CLOSED, STATES.OPEN, or STATES.HALF_OPEN
   * @returns {object} { serviceName, previousState, newState }
   */
  forceState(key, targetState) {
    // Validate targetState
    const validStates = [STATES.CLOSED, STATES.OPEN, STATES.HALF_OPEN];
    if (!validStates.includes(targetState)) {
      throw new Error(`Invalid target state: ${targetState}. Must be one of: ${validStates.join(', ')}`);
    }

    const resolved = this._resolveScopeKey(key);
    if (resolved.scope === 'agent') {
      return this.forceStateAgent(resolved.id, targetState);
    }
    return this.forceStateProvider(resolved.id, targetState);
  }

  /**
   * Force a provider's circuit breaker to a specific state.
   * @private
   */
  forceStateProvider(provider, targetState) {
    // Validate service exists - we need to check both maps
    if (!this._providers.has(provider)) {
      throw new Error(`Service not found: ${provider}`);
    }

    const entry = this._getOrCreate(provider);
    const previousState = entry.state;
    const thresholds = this._getThresholds(provider);

    // If already in target state, no-op
    if (previousState === targetState) {
      return { serviceName: provider, previousState, newState: targetState };
    }

    // Update state
    entry.state = targetState;

    // Reset counters appropriately based on target state
    if (targetState === STATES.CLOSED) {
      // CLOSED: clear failures and recovery time
      entry.failureTimestamps = [];
      entry.failureReasons = [];
      entry.openedAt = null;
      entry.held = false;
    } else if (targetState === STATES.OPEN) {
      // OPEN: set recoveryAt (openedAt + cooldownMs)
      entry.openedAt = Date.now();
      // Ensure there are enough failures to keep it OPEN (to prevent auto-recovery)
      // Fill up to threshold if current count is below. Reasons get backfilled
      // with 'operator_force' so dominantReason reflects the forced trip.
      if (entry.failureTimestamps.length < thresholds.failureThreshold) {
        entry.failureTimestamps = Array.from({ length: thresholds.failureThreshold }, () => Date.now());
        entry.failureReasons = Array.from({ length: thresholds.failureThreshold }, () => 'operator_force');
      }
      // Don't set held flag - this is a forced state, not a manual hold
    } else if (targetState === STATES.HALF_OPEN) {
      // HALF_OPEN: reset half-open request counter (this is implicit in the state machine)
      // Keep openedAt for recovery timing
      if (!entry.openedAt) {
        entry.openedAt = Date.now() - thresholds.cooldownMs; // Set as if cooldown just elapsed
      }
    }

    // Emit standard circuit_breaker events
    this._emitTransition(provider, targetState, previousState, {
      trigger: { reason: 'operator_force', source: 'forceState' },
      failureCount: this._recentFailures(entry, thresholds.maxFailureAgeMs),
    });

    // Persist state
    this._persistState();

    return { serviceName: provider, previousState, newState: targetState };
  }

  /**
   * Force an agent's circuit breaker to a specific state.
   * @private
   */
  forceStateAgent(agentId, targetState) {
    // Validate service exists
    if (!this._agents.has(agentId)) {
      throw new Error(`Service not found: ${agentId}`);
    }

    const entry = this._getOrCreateAgent(agentId);
    const previousState = entry.state;
    const thresholds = this._getAgentThresholds(agentId);

    // If already in target state, no-op
    if (previousState === targetState) {
      return { serviceName: agentId, previousState, newState: targetState };
    }

    // Update state
    entry.state = targetState;

    // Reset counters appropriately based on target state
    if (targetState === STATES.CLOSED) {
      // CLOSED: clear failures and recovery time
      entry.failureTimestamps = [];
      entry.failureReasons = [];
      entry.openedAt = null;
      entry.held = false;
    } else if (targetState === STATES.OPEN) {
      // OPEN: set recoveryAt (openedAt + cooldownMs)
      entry.openedAt = Date.now();
      // Ensure there are enough failures to keep it OPEN (to prevent auto-recovery)
      // Fill up to threshold if current count is below.
      if (entry.failureTimestamps.length < thresholds.failureThreshold) {
        entry.failureTimestamps = Array.from({ length: thresholds.failureThreshold }, () => Date.now());
        entry.failureReasons = Array.from({ length: thresholds.failureThreshold }, () => 'operator_force');
      }
      // Don't set held flag - this is a forced state, not a manual hold
    } else if (targetState === STATES.HALF_OPEN) {
      // HALF_OPEN: reset half-open request counter (this is implicit in the state machine)
      // Keep openedAt for recovery timing
      if (!entry.openedAt) {
        entry.openedAt = Date.now() - thresholds.cooldownMs; // Set as if cooldown just elapsed
      }
    }

    // Emit standard circuit_breaker events
    this._emitTransition(null, targetState, previousState, {
      trigger: { reason: 'operator_force', source: 'forceState' },
      failureCount: this._recentFailures(entry, thresholds.maxFailureAgeMs),
      agentId,
    });

    // Persist state
    this._persistState();

    return { serviceName: agentId, previousState, newState: targetState };
  }

  /**
   * Get status of all tracked providers, agents, and campaigns (for API/monitoring).
   * @returns {Object} { providers: { provider → status }, agents: { agentId → status }, campaignApprovals: { campaignId → status } }
   */
  getStatus(key = undefined) {
    if (key !== undefined) {
      const resolved = this._resolveScopeKey(key);
      if (resolved.scope === 'agent') {
        return this.getAgentStatus()[resolved.id] || null;
      }
      return this.getProviderStatus()[resolved.id] || null;
    }

    const result = {
      providers: {},
      agents: {},
      campaignApprovals: {},
    };

    for (const [provider, entry] of this._providers) {
      const thresholds = this._getThresholds(provider);
      const state = this.getStateProvider(provider);
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      const lastFailure = entry.failureTimestamps.length > 0
        ? new Date(entry.failureTimestamps[entry.failureTimestamps.length - 1]).toISOString()
        : null;
      result.providers[provider] = {
        state,
        failures: recentCount,
        lastFailure,
        openedAt: entry.openedAt ? new Date(entry.openedAt).toISOString() : null,
        recoveryAt: this.getRecoveryTimeProvider(provider)
          ? new Date(this.getRecoveryTimeProvider(provider)).toISOString()
          : null,
        held: !!entry.held,
      };
    }

    for (const [agentId, entry] of this._agents) {
      const state = this.getAgentState(agentId);
      const thresholds = this._getAgentThresholds(agentId);
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      const lastFailure = entry.failureTimestamps.length > 0
        ? new Date(entry.failureTimestamps[entry.failureTimestamps.length - 1]).toISOString()
        : null;
      const recoveryAt = entry.state === STATES.OPEN && entry.openedAt
        ? new Date(entry.openedAt + thresholds.cooldownMs).toISOString()
        : null;
      result.agents[agentId] = {
        state,
        failures: recentCount,
        lastFailure,
        openedAt: entry.openedAt ? new Date(entry.openedAt).toISOString() : null,
        recoveryAt,
        held: !!entry.held,
      };
    }

    for (const [campaignId, entry] of this._campaigns) {
      const state = this.getCampaignApprovalState(campaignId);
      const recentCount = this._recentTimeouts(entry);
      const lastTimeout = entry.timeoutTimestamps.length > 0
        ? new Date(entry.timeoutTimestamps[entry.timeoutTimestamps.length - 1]).toISOString()
        : null;
      result.campaignApprovals[campaignId] = {
        state,
        timeouts: recentCount,
        lastTimeout,
        openedAt: entry.openedAt ? new Date(entry.openedAt).toISOString() : null,
        held: !!entry.held,
        threshold: this._approvalTimeoutThreshold,
        windowMs: this._approvalTimeoutWindowMs,
      };
    }

    return result;
  }

  /**
   * Get status of all tracked providers only.
   * @returns {Object} { provider -> status }
   */
  getProviderStatus() {
    const result = {};
    for (const [provider, entry] of this._providers) {
      const thresholds = this._getThresholds(provider);
      const state = this.getStateProvider(provider);
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      const lastFailure = entry.failureTimestamps.length > 0
        ? new Date(entry.failureTimestamps[entry.failureTimestamps.length - 1]).toISOString()
        : null;
      result[provider] = {
        state,
        failures: recentCount,
        lastFailure,
        openedAt: entry.openedAt ? new Date(entry.openedAt).toISOString() : null,
        recoveryAt: this.getRecoveryTimeProvider(provider)
          ? new Date(this.getRecoveryTimeProvider(provider)).toISOString()
          : null,
        held: !!entry.held,
      };
    }
    return result;
  }

  /**
   * Get status of all tracked agents only.
   * @returns {Object} { agentId → status }
   */
  getAgentStatus() {
    const result = {};
    for (const [agentId, entry] of this._agents) {
      const state = this.getAgentState(agentId);
      const thresholds = this._getAgentThresholds(agentId);
      const recentCount = this._recentFailures(entry, thresholds.maxFailureAgeMs);
      const lastFailure = entry.failureTimestamps.length > 0
        ? new Date(entry.failureTimestamps[entry.failureTimestamps.length - 1]).toISOString()
        : null;
      const recoveryAt = entry.state === STATES.OPEN && entry.openedAt
        ? new Date(entry.openedAt + thresholds.cooldownMs).toISOString()
        : null;
      result[agentId] = {
        state,
        failures: recentCount,
        lastFailure,
        openedAt: entry.openedAt ? new Date(entry.openedAt).toISOString() : null,
        recoveryAt,
        held: !!entry.held,
      };
    }
    return result;
  }

  /**
   * Get the effective state for a campaign's approval timeout circuit breaker.
   * If currently open and all timeouts have aged out, transitions to closed.
   */
  getCampaignApprovalState(campaignId) {
    const entry = this._getOrCreateCampaign(campaignId);

    if (entry.held) {
      return STATES.OPEN;
    }

    if (entry.state === STATES.OPEN && entry.openedAt !== null) {
      const recentCount = this._recentTimeouts(entry);
      if (recentCount < this._approvalTimeoutThreshold) {
        entry.state = STATES.CLOSED;
        entry.openedAt = null;
        this._emitTransition(null, STATES.CLOSED, STATES.OPEN, {
          trigger: { reason: 'timeouts_aged_out', source: 'getCampaignApprovalState' },
          failureCount: recentCount,
          campaignId,
        });
        this._persistState();
      }
    }
    return entry.state;
  }

  /**
   * Check if a campaign can create new requireApproval milestones.
   * Returns true for closed state; false for open.
   */
  canCampaignRequestApproval(campaignId) {
    return this.getCampaignApprovalState(campaignId) !== STATES.OPEN;
  }

  /**
   * Record an approval timeout for a campaign.
   * In closed state: records timestamp, trips open at threshold.
   */
  recordApprovalTimeout(campaignId, { milestoneId = null, correlationKeys = null } = {}) {
    const entry = this._getOrCreateCampaign(campaignId);
    if (entry.held) {
      return;
    }
    const currentState = this.getCampaignApprovalState(campaignId);

    if (currentState === STATES.CLOSED) {
      entry.timeoutTimestamps.push(Date.now());
      const recentCount = this._recentTimeouts(entry);
      if (recentCount >= this._approvalTimeoutThreshold) {
        entry.state = STATES.OPEN;
        entry.openedAt = Date.now();
        this._emitTransition(null, STATES.OPEN, STATES.CLOSED, {
          trigger: { reason: 'approval_timeout_threshold', source: 'recordApprovalTimeout' },
          failureCount: recentCount,
          campaignId,
          correlationKeys,
        });
        log.warn('Campaign approval timeout circuit breaker opened', {
          campaignId,
          milestoneId,
          timeoutCount: recentCount,
          threshold: this._approvalTimeoutThreshold,
          windowMs: this._approvalTimeoutWindowMs,
        });
      }
      this._persistState();
    }
  }

  /**
   * Reset a campaign's approval timeout circuit breaker back to closed with zero timeouts.
   * This is the manual reset endpoint for operators.
   */
  resetCampaignApprovalBreaker(campaignId, { userId = null } = {}) {
    const hadState = this._campaigns.has(campaignId);
    const prevState = hadState ? this._campaigns.get(campaignId).state : null;
    this._campaigns.delete(campaignId);
    if (hadState && prevState !== STATES.CLOSED) {
      log.info('Campaign approval timeout circuit breaker manually reset', {
        campaignId,
        previousState: prevState,
        userId,
      });
      this._emitTransition(null, STATES.CLOSED, prevState, {
        trigger: { reason: 'manual_reset', source: 'resetCampaignApprovalBreaker' },
        failureCount: 0,
        campaignId,
      });
    }
    this._persistState();
  }

  /**
   * Get status of all tracked campaigns for approval timeout circuit breaker.
   * @returns {Object} { campaignId → status }
   */
  getCampaignApprovalStatus(campaignId = undefined) {
    if (campaignId !== undefined) {
      return this.getCampaignApprovalStatusInternal()[campaignId] || null;
    }
    return this.getCampaignApprovalStatusInternal();
  }

  /**
   * Internal helper to get all campaign approval timeout status.
   * @private
   */
  getCampaignApprovalStatusInternal() {
    const result = {};
    for (const [campaignId, entry] of this._campaigns) {
      const state = this.getCampaignApprovalState(campaignId);
      const recentCount = this._recentTimeouts(entry);
      const lastTimeout = entry.timeoutTimestamps.length > 0
        ? new Date(entry.timeoutTimestamps[entry.timeoutTimestamps.length - 1]).toISOString()
        : null;
      result[campaignId] = {
        state,
        timeouts: recentCount,
        lastTimeout,
        openedAt: entry.openedAt ? new Date(entry.openedAt).toISOString() : null,
        held: !!entry.held,
        threshold: this._approvalTimeoutThreshold,
        windowMs: this._approvalTimeoutWindowMs,
      };
    }
    return result;
  }

  /**
   * Load circuit breaker state from disk.
   * Handles missing file (starts fresh), corrupt JSON (logs warning + starts fresh).
   * Ensures parent directory exists.
   * Supports version 1 (providers only), version 2 (providers + agents), and version 3 (unified) with migration.
   * @private
   */
  _loadState() {
    // Known provider names for distinguishing providers from agents during v3 load
    const KNOWN_PROVIDERS = ['claude', 'codex', 'gemini', 'ollama'];

    try {
      // Ensure parent directory exists
      const dir = dirname(this._statePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // If state file doesn't exist, start fresh
      if (!existsSync(this._statePath)) {
        return;
      }

      const data = JSON.parse(readFileSync(this._statePath, 'utf8'));

      // Handle v3 (unified entries + threshold overrides)
      if (data.version === 3) {
        log.info('Loading circuit breaker state from v3 format');

        // Validate entries field
        if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
          log.warn('Circuit breaker state file has invalid or missing entries field, starting fresh', {
            entriesType: data.entries === null ? 'null' : Array.isArray(data.entries) ? 'array' : typeof data.entries,
          });
          return;
        }

        const now = Date.now();

        // Load entries into appropriate Maps (providers, agents, or campaigns based on key name)
        for (const [key, entry] of Object.entries(data.entries)) {
          // Validate entry structure
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            log.warn('Skipping malformed entry (not an object)', { key });
            continue;
          }

          // Validate state field
          const validStates = [STATES.CLOSED, STATES.OPEN, STATES.HALF_OPEN];
          if (!validStates.includes(entry.state)) {
            log.warn('Skipping entry with invalid state', { key, state: entry.state });
            continue;
          }

          // Determine entry type: provider, agent, or campaign
          const isProvider = KNOWN_PROVIDERS.includes(key);
          const isCampaign = entry.entryType === 'campaign' || key.startsWith('campaign-');

          if (isCampaign) {
            // Load campaign approval timeout circuit breaker entry
            if (entry.timeoutTimestamps !== undefined && !Array.isArray(entry.timeoutTimestamps)) {
              log.warn('Skipping campaign entry with invalid timeoutTimestamps', { key, type: typeof entry.timeoutTimestamps });
              continue;
            }

            if (entry.openedAt !== undefined && entry.openedAt !== null && typeof entry.openedAt !== 'number') {
              log.warn('Skipping campaign entry with invalid openedAt', { key, type: typeof entry.openedAt });
              continue;
            }

            const cutoff = now - this._approvalTimeoutWindowMs;
            const timeoutTimestamps = (entry.timeoutTimestamps || []).filter(ts => ts > cutoff);
            let state = entry.state;
            let openedAt = entry.openedAt || null;
            const held = Boolean(entry.held);

            if (state === STATES.OPEN && openedAt !== null) {
              // If pruned timeouts fall below threshold, close immediately
              if (timeoutTimestamps.length < this._approvalTimeoutThreshold) {
                state = STATES.CLOSED;
                openedAt = null;
              }
            }

            // On startup, reset non-held entries to closed
            if (!held && state !== STATES.CLOSED) {
              log.info('Resetting pre-restart campaign approval breaker to closed', { key, previousState: state, timeouts: timeoutTimestamps.length });
              state = STATES.CLOSED;
              timeoutTimestamps.length = 0;
              openedAt = null;
            }

            this._campaigns.set(key, { state: held ? STATES.OPEN : state, timeoutTimestamps, openedAt, held });
          } else {
            // Load provider or agent entry (existing logic)
            // Validate failureTimestamps field
            if (entry.failureTimestamps !== undefined && !Array.isArray(entry.failureTimestamps)) {
              log.warn('Skipping entry with invalid failureTimestamps', { key, type: typeof entry.failureTimestamps });
              continue;
            }

            // Validate openedAt field
            if (entry.openedAt !== undefined && entry.openedAt !== null && typeof entry.openedAt !== 'number') {
              log.warn('Skipping entry with invalid openedAt', { key, type: typeof entry.openedAt });
              continue;
            }

            const thresholds = isProvider ? this._getThresholds(key) : this._getAgentThresholds(key);
            const cutoff = now - thresholds.maxFailureAgeMs;

            // Prune failure timestamps older than maxFailureAgeMs
            const failureTimestamps = (entry.failureTimestamps || []).filter(ts => ts > cutoff);
            let state = entry.state;
            let openedAt = entry.openedAt || null;
            const held = Boolean(entry.held);

            if (state === STATES.OPEN && openedAt !== null) {
              // If pruned failures fall below threshold, close immediately
              if (failureTimestamps.length < thresholds.failureThreshold) {
                state = STATES.CLOSED;
                openedAt = null;
              // Else if cooldown has elapsed, transition to half-open
              } else if (now - openedAt >= thresholds.cooldownMs) {
                state = STATES.HALF_OPEN;
              }
            }

            // On startup, reset non-held entries to closed.
            // Pre-restart failures are stale — a clean restart is not an agent malfunction.
            // Only operator-held breakers survive the restart.
            if (!held && state !== STATES.CLOSED) {
              log.info('Resetting pre-restart circuit breaker to closed', { key, previousState: state, failures: failureTimestamps.length });
              state = STATES.CLOSED;
              failureTimestamps.length = 0;
              openedAt = null;
            }

            // Store in appropriate Map
            const targetMap = isProvider ? this._providers : this._agents;
            targetMap.set(key, { state: held ? STATES.OPEN : state, failureTimestamps, openedAt, held });
          }
        }

        // Note: v3 thresholdOverrides are read from config, not from persisted state
        // The persisted thresholdOverrides are informational only

        log.info('Circuit breaker state loaded from disk (v3)', {
          providers: this._providers.size,
          agents: this._agents.size,
          campaigns: this._campaigns.size,
        });
        return;
      }

      // Handle v1 (providers only) and v2 (providers + agents) - migrate to internal Maps
      if (data.version === 1) {
        log.info('Migrating circuit breaker state from v1 to v3');
      } else if (data.version === 2) {
        log.info('Migrating circuit breaker state from v2 to v3');
      } else {
        log.warn('Circuit breaker state file has unknown version, starting fresh', { version: data.version });
        return;
      }

      // Validate providers field — must be a plain object (not array, not missing)
      if (!data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) {
        log.warn('Circuit breaker state file has invalid or missing providers field, starting fresh', {
          providersType: data.providers === null ? 'null' : Array.isArray(data.providers) ? 'array' : typeof data.providers,
        });
        return;
      }

      // Restore providers Map from persisted object
      {
        const now = Date.now();
        const cutoff = now - this._maxFailureAgeMs;

        for (const [name, entry] of Object.entries(data.providers)) {
          // Validate provider entry structure
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            log.warn('Skipping malformed provider entry (not an object)', { provider: name });
            continue;
          }

          // Validate state field
          const validStates = [STATES.CLOSED, STATES.OPEN, STATES.HALF_OPEN];
          if (!validStates.includes(entry.state)) {
            log.warn('Skipping provider with invalid state', { provider: name, state: entry.state });
            continue;
          }

          // Validate failureTimestamps field
          if (entry.failureTimestamps !== undefined && !Array.isArray(entry.failureTimestamps)) {
            log.warn('Skipping provider with invalid failureTimestamps', { provider: name, type: typeof entry.failureTimestamps });
            continue;
          }

          // Validate openedAt field
          if (entry.openedAt !== undefined && entry.openedAt !== null && typeof entry.openedAt !== 'number') {
            log.warn('Skipping provider with invalid openedAt', { provider: name, type: typeof entry.openedAt });
            continue;
          }

          // (1) Prune failure timestamps older than maxFailureAgeMs
          const failureTimestamps = (entry.failureTimestamps || []).filter(ts => ts > cutoff);
          let state = entry.state;
          let openedAt = entry.openedAt || null;

          if (state === STATES.OPEN && openedAt !== null) {
            // (2) If pruned failures fall below threshold, close immediately
            if (failureTimestamps.length < this._failureThreshold) {
              state = STATES.CLOSED;
              openedAt = null;
            // (3) Else if cooldown has elapsed, transition to half-open
            } else if (now - openedAt >= this._cooldownMs) {
              state = STATES.HALF_OPEN;
            }
          }

          this._providers.set(name, { state, failureTimestamps, openedAt, held: false });
        }
      }

      // Restore agents Map from persisted object (v2 only)
      if (data.version === 2 && data.agents) {
        const now = Date.now();
        const cutoff = now - this._maxFailureAgeMs;

        for (const [agentId, entry] of Object.entries(data.agents)) {
          // Validate agent entry structure
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            log.warn('Skipping malformed agent entry (not an object)', { agentId });
            continue;
          }

          // Validate state field
          const validStates = [STATES.CLOSED, STATES.OPEN, STATES.HALF_OPEN];
          if (!validStates.includes(entry.state)) {
            log.warn('Skipping agent with invalid state', { agentId, state: entry.state });
            continue;
          }

          // Validate failureTimestamps field
          if (entry.failureTimestamps !== undefined && !Array.isArray(entry.failureTimestamps)) {
            log.warn('Skipping agent with invalid failureTimestamps', { agentId, type: typeof entry.failureTimestamps });
            continue;
          }

          // Validate openedAt field
          if (entry.openedAt !== undefined && entry.openedAt !== null && typeof entry.openedAt !== 'number') {
            log.warn('Skipping agent with invalid openedAt', { agentId, type: typeof entry.openedAt });
            continue;
          }

          // Get agent-specific thresholds for validation
          const thresholds = this._getAgentThresholds(agentId);

          // (1) Prune failure timestamps older than maxFailureAgeMs
          const failureTimestamps = (entry.failureTimestamps || []).filter(ts => ts > cutoff);
          let state = entry.state;
          let openedAt = entry.openedAt || null;

          if (state === STATES.OPEN && openedAt !== null) {
            // (2) If pruned failures fall below threshold, close immediately
            if (failureTimestamps.length < thresholds.failureThreshold) {
              state = STATES.CLOSED;
              openedAt = null;
            // (3) Else if cooldown has elapsed, transition to half-open
            } else if (now - openedAt >= thresholds.cooldownMs) {
              state = STATES.HALF_OPEN;
            }
          }

          this._agents.set(agentId, { state, failureTimestamps, openedAt, held: false });
        }
        log.info('Circuit breaker state loaded from disk', { providers: this._providers.size, agents: this._agents.size });
      } else {
        log.info('Circuit breaker state loaded from disk', { providers: this._providers.size, agents: 0 });
      }
    } catch (err) {
      log.warn('Failed to load circuit breaker state, starting fresh', { error: err.message });
      this._providers.clear();
      this._agents.clear();
    }
  }

  /**
   * Persist circuit breaker state to disk atomically.
   * Uses tmp+rename pattern to prevent corruption on crash.
   * @private
   */
  _persistState() {
    if (!this._statePath) return;

    try {
      // Ensure parent directory exists
      const dir = dirname(this._statePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Serialize providers, agents, and campaigns Maps into a unified entries object
      const entries = {};
      for (const [name, entry] of this._providers) {
        entries[name] = {
          state: entry.state,
          failureTimestamps: entry.failureTimestamps,
          openedAt: entry.openedAt,
          held: !!entry.held,
        };
      }
      for (const [agentId, entry] of this._agents) {
        entries[agentId] = {
          state: entry.state,
          failureTimestamps: entry.failureTimestamps,
          openedAt: entry.openedAt,
          held: !!entry.held,
        };
      }
      for (const [campaignId, entry] of this._campaigns) {
        entries[campaignId] = {
          entryType: 'campaign',
          state: entry.state,
          timeoutTimestamps: entry.timeoutTimestamps,
          openedAt: entry.openedAt,
          held: !!entry.held,
        };
      }

      // Serialize threshold overrides if present
      const thresholdOverrides = {};
      if (this._agentThresholds) {
        for (const [key, overrides] of this._agentThresholds) {
          if (overrides && Object.keys(overrides).length > 0) {
            thresholdOverrides[key] = { ...overrides };
          }
        }
      }

      const payload = {
        version: 3,
        entries,
        thresholdOverrides,
      };

      // Atomic write: tmp + rename
      const tmp = this._statePath + '.tmp.' + process.pid;
      try {
        writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        renameSync(tmp, this._statePath);
      } catch (err) {
        // Clean up tmp on failure
        try { unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      }
    } catch (err) {
      log.error('Failed to persist circuit breaker state', { error: err.message });
    }
  }
}
