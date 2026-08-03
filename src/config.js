// Centralized configuration — single source of truth for all tunable values.
//
// Precedence (highest wins): CLI > ENV > config.js defaults
// Agent-specific overrides live in .synapse/agents.json (loaded by orchestrator).
//
// ENV override convention: SYNAPSE_{CATEGORY}_{KEY} in SCREAMING_SNAKE_CASE
// Example: SYNAPSE_SERVER_PORT=9090, SYNAPSE_ORCHESTRATOR_MAX_TOTAL_TURNS=30
//
// All ENV overrides (113):
//   Server:      SYNAPSE_SERVER_PORT, SYNAPSE_PROJECT_DIR, SYNAPSE_KEEP_ALIVE_TIMEOUT_MS,
//                SYNAPSE_HEADERS_TIMEOUT_MS, SYNAPSE_REQUEST_TIMEOUT_MS, SYNAPSE_SOCKET_TIMEOUT_MS
//   Orchestrator: SYNAPSE_MAX_TOTAL_TURNS, SYNAPSE_BASE_TURN_BUDGET, SYNAPSE_REPETITION_THRESHOLD,
//                 SYNAPSE_INFO_GAIN_THRESHOLD, SYNAPSE_REPETITION_PATIENCE, SYNAPSE_WRAP_UP_BUDGET,
//                 SYNAPSE_MAX_CONSECUTIVE, SYNAPSE_EXECUTION_MAX_TURNS, SYNAPSE_EXECUTION_TIMEOUT_MULTIPLIER,
//                 SYNAPSE_RATE_LIMIT_COOLDOWN_MS, SYNAPSE_TIMEOUT_COOLDOWN_MS, SYNAPSE_VOTE_TIMEOUT_MS,
//                 SYNAPSE_DEFAULT_MESSAGE_LIMIT, SYNAPSE_API_DEFAULT_LIMIT
//   Agents:      SYNAPSE_AGENT_STOP_GRACE_MS, SYNAPSE_AGENT_DEFAULT_MAX_TURNS,
//                 SYNAPSE_TIMEOUT_CLAUDE_MS, SYNAPSE_TIMEOUT_CODEX_MS, SYNAPSE_TIMEOUT_GEMINI_MS, SYNAPSE_TIMEOUT_OLLAMA_MS,
//                 SYNAPSE_CB_FAILURE_THRESHOLD, SYNAPSE_CB_COOLDOWN_MS, SYNAPSE_CB_MAX_FAILURE_AGE_MS,
//                 SYNAPSE_CB_FAILURE_THRESHOLD_CLAUDE, SYNAPSE_CB_FAILURE_THRESHOLD_CODEX, SYNAPSE_CB_FAILURE_THRESHOLD_GEMINI, SYNAPSE_CB_FAILURE_THRESHOLD_OLLAMA,
//                 SYNAPSE_CB_COOLDOWN_MS_CLAUDE, SYNAPSE_CB_COOLDOWN_MS_CODEX, SYNAPSE_CB_COOLDOWN_MS_GEMINI, SYNAPSE_CB_COOLDOWN_MS_OLLAMA,
//                 SYNAPSE_CB_MAX_FAILURE_AGE_MS_CLAUDE, SYNAPSE_CB_MAX_FAILURE_AGE_MS_CODEX, SYNAPSE_CB_MAX_FAILURE_AGE_MS_GEMINI, SYNAPSE_CB_MAX_FAILURE_AGE_MS_OLLAMA,
//                 SYNAPSE_CB_AGENT_THRESHOLDS
//   Compaction:  SYNAPSE_COMPACTION_THRESHOLD, SYNAPSE_COMPACTION_RECENT_KEEP, SYNAPSE_COMPACTION_SUMMARY_MAX
//   Threading:   SYNAPSE_JACCARD_THRESHOLD, SYNAPSE_MIN_TOKEN_LENGTH, SYNAPSE_THREAD_LABEL_MAX,
//                 SYNAPSE_THREAD_LABEL_OVERFLOW, SYNAPSE_DYNAMIC_KEYWORDS_CAP
//   Tasks:       SYNAPSE_TASK_HEARTBEAT_MS, SYNAPSE_HEARTBEAT_STALL_MS, SYNAPSE_TASK_MAX_REQUEUES, SYNAPSE_TASK_PLANNING_MAX_TURNS,
//                 SYNAPSE_TASK_PLANNING_TIMEOUT_MS, SYNAPSE_TASK_EXEC_MAX_TURNS,
//                 SYNAPSE_TASK_TIMEOUT_CLAUDE_MS, SYNAPSE_TASK_TIMEOUT_CODEX_MS,
//                 SYNAPSE_TASK_TIMEOUT_GEMINI_MS, SYNAPSE_TASK_TIMEOUT_OLLAMA_MS,
//                 SYNAPSE_AUDIT_INTERVAL, SYNAPSE_AUDIT_ON_FAILURE,
//                 SYNAPSE_TASK_MAX_CONCURRENT, SYNAPSE_TASK_STUCK_TIMEOUT_MS
//   Router:      SYNAPSE_DIRECTED_ROUTING, SYNAPSE_LOCAL_FIRST, SYNAPSE_CLOUD_BUDGET_MAX_DAY,
//                 SYNAPSE_CLOUD_BUDGET_WINDOW_MS, SYNAPSE_ROUTER_SOLO_BUDGET, SYNAPSE_ROUTER_PAIR_BUDGET,
//                 SYNAPSE_ROUTER_COUNCIL_BUDGET, SYNAPSE_ROUTER_COUNCIL_ROUNDS,
//                 SYNAPSE_ROUTER_CONFIDENCE, SYNAPSE_ROUTER_LOAD_WINDOW_MS, SYNAPSE_ROUTER_AUDIT_INTERVAL,
//                 SYNAPSE_ROUTER_DECAY_HALF_LIFE_MS, SYNAPSE_ROUTER_ALERT_WINDOW_SIZE,
//                 SYNAPSE_ROUTER_FLOOR_WEIGHT, SYNAPSE_ROUTER_SENSITIVITY_THRESHOLD, SYNAPSE_ROUTER_COST_WEIGHT
//   Daemon:      SYNAPSE_DAEMON_SLEEP_MS, SYNAPSE_DAEMON_MAX_DAILY_COST,
//                 SYNAPSE_DAEMON_MAX_PER_CYCLE_COST, SYNAPSE_DAEMON_REPLAN_INTERVAL
//   Campaigns:   SYNAPSE_STRATEGIST_INTERVAL_MS, SYNAPSE_CAMPAIGN_DECOMPOSE_MAX_TURNS,
//                 SYNAPSE_CAMPAIGN_DECOMPOSE_TIMEOUT_MS, SYNAPSE_CAMPAIGN_MAX_MILESTONES,
//                 SYNAPSE_CAMPAIGN_MAX_TASKS_PER_MS, SYNAPSE_CAMPAIGN_AUTO_RETRY, SYNAPSE_CAMPAIGN_MAX_RETRIES,
//                 SYNAPSE_CAMPAIGN_DELIBERATION_ENABLED, SYNAPSE_CAMPAIGN_DELIBERATION_SAMPLING_PERCENTILE,
//                 SYNAPSE_CAMPAIGN_DELIBERATION_CONFIDENCE_THRESHOLD, SYNAPSE_CAMPAIGN_APPROVAL_TIMEOUT_MS
//   ApprovalTimeoutWatcher: SYNAPSE_APPROVAL_TIMEOUT_SCAN_INTERVAL_MS
//   Review:      SYNAPSE_REVIEW_MAX_FIX_CYCLES, SYNAPSE_REVIEW_AND_REVISE_ENABLED,
//                SYNAPSE_REVIEW_AND_REVISE_MAX_ITERATIONS, SYNAPSE_REVIEW_AND_REVISE_TRIGGER_TYPES
//   Tracing:     SYNAPSE_TRACING_ENABLED, SYNAPSE_TRACING_ENDPOINT, SYNAPSE_TRACING_SAMPLING_RATE
//   AlertMonitor: SYNAPSE_ALERT_MONITOR_INTERVAL_MS, SYNAPSE_ALERT_MONITOR_RETENTION_MS
//   AnomalyDetector: SYNAPSE_ANOMALY_RETENTION_MS
//   AnomalyAlerts: SYNAPSE_ANOMALY_ALERTS_MAX_SIZE_BYTES, SYNAPSE_ANOMALY_ALERTS_ARCHIVE_DIR, SYNAPSE_ANOMALY_ALERTS_ROTATION_INTERVAL_MS
//   AnalyticsPipeline: SYNAPSE_ANALYTICS_PIPELINE_ENABLED, SYNAPSE_ANALYTICS_PIPELINE_INTERVAL_MS, SYNAPSE_ANALYTICS_PIPELINE_WINDOW_MS
//   DegradationDetector: SYNAPSE_DEGRADATION_DETECTOR_ENABLED, SYNAPSE_DEGRADATION_MIN_CONSECUTIVE, SYNAPSE_DEGRADATION_WEIGHT_SCALE
//   Timeline:    SYNAPSE_TIMELINE_RETENTION_MS, SYNAPSE_TIMELINE_MAX_SIZE, SYNAPSE_TIMELINE_DB_PATH
//   Syslog:      SYNAPSE_SYSLOG_ENABLED, SYNAPSE_SYSLOG_HOST, SYNAPSE_SYSLOG_PORT, SYNAPSE_SYSLOG_PROTOCOL,
//                 SYNAPSE_SYSLOG_FACILITY, SYNAPSE_SYSLOG_APP_NAME, SYNAPSE_SYSLOG_HOSTNAME, SYNAPSE_SYSLOG_DROP_ON_FAILURE,
//                 SYNAPSE_SYSLOG_TLS_REJECT_UNAUTHORIZED, SYNAPSE_SYSLOG_TLS_CA, SYNAPSE_SYSLOG_TLS_CERT, SYNAPSE_SYSLOG_TLS_KEY
//   Sandbox:     SYNAPSE_SANDBOX, SYNAPSE_SANDBOX_MAX_OUTPUT, SYNAPSE_SANDBOX_MAX_PROCS, SYNAPSE_SANDBOX_ENV_FILTER
//   Auth:        SYNAPSE_AUTH, SYNAPSE_AUTH_TOKEN, SYNAPSE_AUTH_EXPIRY_DAYS, SYNAPSE_AUTH_GRACE_MS, SYNAPSE_PASSWORD
//   Rate Limit:  SYNAPSE_RATE_LIMIT, SYNAPSE_RATE_LIMIT_MAX, SYNAPSE_RATE_LIMIT_WINDOW_MS
//   Permissions:  SYNAPSE_PERMISSIONS_ENFORCE, SYNAPSE_PERMISSIONS_AUDIT
//   Orchestrator (dynamic routing): SYNAPSE_ORCHESTRATOR_DYNAMIC_ROUTING_ENABLED
//   Recovery:    SYNAPSE_RECOVERY_MODE
//   Git:         SYNAPSE_GIT_AUTOCOMMIT, SYNAPSE_GIT_COMMIT_STATE, SYNAPSE_REPO_DIR
//   SLA:         SYNAPSE_SLA_MONITOR_INTERVAL_MS,
//                 SYNAPSE_SLA_LATENCY_P95_THRESHOLD_MS, SYNAPSE_SLA_LATENCY_P95_WINDOW_MIN, SYNAPSE_SLA_LATENCY_P95_ENABLED,
//                 SYNAPSE_SLA_ERROR_RATE_THRESHOLD_PCT, SYNAPSE_SLA_ERROR_RATE_WINDOW_MIN, SYNAPSE_SLA_ERROR_RATE_ENABLED,
//                 SYNAPSE_SLA_HOURLY_COST_THRESHOLD_USD, SYNAPSE_SLA_HOURLY_COST_ENABLED
//   SLA (per-project): Set sla overrides in .synapse/projects/<id>/config.json, e.g.:
//                 { "sla": { "latency_p95": { "thresholdMs": 2000, "enabled": true },
//                            "error_rate":  { "thresholdPct": 10 } } }
//                 Use getSlaConfigForProject(projectSla) to merge with global defaults.
//   Logging:     SYNAPSE_LOG_LEVEL, SYNAPSE_LOG_FILE_ENABLED, SYNAPSE_LOG_FILE_DIR, SYNAPSE_LOG_FILE_NAME,
//                SYNAPSE_LOG_FILE_MAX_SIZE, SYNAPSE_LOG_FILE_MAX_FILES, SYNAPSE_LOG_OUTPUT_TARGETS
//   MCP:         SYNAPSE_MCP_ENABLED, SYNAPSE_MCP_SERVERS (JSON array),
//                 SYNAPSE_MCP_RECONNECT_INITIAL_DELAY_MS, SYNAPSE_MCP_RECONNECT_MAX_DELAY_MS, SYNAPSE_MCP_RECONNECT_MULTIPLIER,
//                 SYNAPSE_MCP_TOOL_TIMEOUT_MS, SYNAPSE_MCP_TOOL_CB_THRESHOLD, SYNAPSE_MCP_TOOL_CB_COOLDOWN_MS,
//                 SYNAPSE_MCP_FALLBACK_ENABLED, SYNAPSE_MCP_FALLBACK_MAX_ATTEMPTS, SYNAPSE_MCP_FALLBACK_TIMEOUT_MS,
//                 SYNAPSE_MCP_FALLBACK_RETRY_ENABLED, SYNAPSE_MCP_FALLBACK_RETRY_MAX, SYNAPSE_MCP_FALLBACK_RETRY_BASE_DELAY_MS,
//                 SYNAPSE_MCP_FALLBACK_RETRY_MAX_DELAY_MS, SYNAPSE_MCP_FALLBACK_RETRY_MULTIPLIER, SYNAPSE_MCP_FALLBACK_RETRY_JITTER_MS,
//                 SYNAPSE_MCP_FALLBACK_STRATEGY, SYNAPSE_MCP_FALLBACK_DIVERSIFY_SERVERS, SYNAPSE_MCP_FALLBACK_SKIP_OPEN_CIRCUITS,
//                 SYNAPSE_MCP_FALLBACK_ON_TIMEOUT, SYNAPSE_MCP_FALLBACK_ON_CONNECTION_ERROR, SYNAPSE_MCP_FALLBACK_ON_TOOL_ERROR, SYNAPSE_MCP_FALLBACK_ON_CIRCUIT_OPEN

import { PROVIDER_DEFAULT_MODELS } from './model-defaults.js';

function envInt(key, fallback, min, max) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function envFloat(key, fallback, min, max) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function envStr(key, fallback) {
  return process.env[key] || fallback;
}

function envBool(key, fallback) {
  const v = process.env[key];
  if (v === undefined) return fallback;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

// Helper for per-provider circuit breaker overrides: only return a value if ENV var is set
function envIntOverride(key, min, max) {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return undefined;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

// Build per-provider circuit breaker overrides from ENV vars
// ENV format: SYNAPSE_CB_FAILURE_THRESHOLD_CLAUDE, SYNAPSE_CB_COOLDOWN_MS_CODEX, etc.
function buildCircuitBreakerOverrides() {
  const providers = ['claude', 'codex', 'gemini', 'glm', 'ollama'];
  const overrides = {};

  for (const provider of providers) {
    const providerUpper = provider.toUpperCase();
    const failureThreshold = envIntOverride(`SYNAPSE_CB_FAILURE_THRESHOLD_${providerUpper}`, 1, 100);
    const cooldownMs = envIntOverride(`SYNAPSE_CB_COOLDOWN_MS_${providerUpper}`, 1000, 600000);
    const maxFailureAgeMs = envIntOverride(`SYNAPSE_CB_MAX_FAILURE_AGE_MS_${providerUpper}`, 60000, 86400000);

    // Only add override if at least one ENV var is set for this provider
    if (failureThreshold !== undefined || cooldownMs !== undefined || maxFailureAgeMs !== undefined) {
      const override = {};
      if (failureThreshold !== undefined) override.failureThreshold = failureThreshold;
      if (cooldownMs !== undefined) override.cooldownMs = cooldownMs;
      if (maxFailureAgeMs !== undefined) override.maxFailureAgeMs = maxFailureAgeMs;
      overrides[provider] = Object.freeze(override);
    }
  }

  return Object.freeze(overrides);
}

// Build per-agent circuit breaker thresholds from SYNAPSE_CB_AGENT_THRESHOLDS env var
// ENV format: JSON string mapping agentId → {failureThreshold, cooldownMs, maxFailureAgeMs}
// Example: SYNAPSE_CB_AGENT_THRESHOLDS='{"agent-1": {"failureThreshold": 5}, "agent-2": {"cooldownMs": 120000}}'
function buildAgentThresholds() {
  const raw = process.env.SYNAPSE_CB_AGENT_THRESHOLDS;
  if (!raw) return Object.freeze({});

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[config] SYNAPSE_CB_AGENT_THRESHOLDS must be a JSON object');
      return Object.freeze({});
    }

    const validated = {};
    const bounds = {
      failureThreshold: { min: 1, max: 100 },
      cooldownMs: { min: 1000, max: 600000 },
      maxFailureAgeMs: { min: 60000, max: 86400000 },
    };

    for (const [agentId, thresholds] of Object.entries(parsed)) {
      if (typeof agentId !== 'string' || agentId.trim() === '') {
        console.warn(`[config] Skipping agent with invalid id: "${agentId}"`);
        continue;
      }

      if (typeof thresholds !== 'object' || thresholds === null) {
        console.warn(`[config] Skipping agent "${agentId}" - thresholds must be an object`);
        continue;
      }

      const validatedThresholds = {};
      let hasValidOverride = false;

      for (const [key, value] of Object.entries(thresholds)) {
        if (!bounds[key]) {
          console.warn(`[config] Unknown threshold key "${key}" for agent "${agentId}"`);
          continue;
        }

        if (typeof value !== 'number' || !Number.isFinite(value)) {
          console.warn(`[config] Invalid numeric value for ${key} on agent "${agentId}"`);
          continue;
        }

        // Clamp to bounds
        const clamped = Math.max(bounds[key].min, Math.min(bounds[key].max, value));
        if (clamped !== value) {
          console.log(`[config] Clamped ${key} from ${value} to ${clamped} for agent "${agentId}"`);
        }
        validatedThresholds[key] = clamped;
        hasValidOverride = true;
      }

      if (hasValidOverride) {
        validated[agentId] = Object.freeze(validatedThresholds);
      }
    }

    const result = Object.freeze(validated);
    if (Object.keys(result).length > 0) {
      console.log('[config] Per-agent circuit breaker thresholds configured:');
      for (const [agentId, thresholds] of Object.entries(result)) {
        console.log(`  - ${agentId}: ${JSON.stringify(thresholds)}`);
      }
    } else {
      console.log('[config] No valid per-agent circuit breaker thresholds configured (SYNAPSE_CB_AGENT_THRESHOLDS was empty or invalid)');
    }

    return result;
  } catch (err) {
    console.warn(`[config] Failed to parse SYNAPSE_CB_AGENT_THRESHOLDS JSON: ${err.message}`);
    return Object.freeze({});
  }
}

// Validate circuit breaker overrides at startup
// Ensures override keys match known providers and values are within acceptable bounds
function validateCircuitBreakerOverrides(overrides) {
  // Known providers must match PROVIDERS registry in src/orchestrator/agents.js (lines 17-22)
  // Hardcoded here to avoid circular dependency (agents.js imports config.js)
  // MAINTENANCE: Keep in sync with PROVIDERS registry when adding/removing providers
  const knownProviders = ['claude', 'codex', 'gemini', 'glm', 'ollama'];
  const bounds = {
    failureThreshold: { min: 1, max: 100 },
    cooldownMs: { min: 1000, max: 600000 },
    maxFailureAgeMs: { min: 60000, max: 86400000 },
  };

  const warnings = [];
  const validated = [];

  // Check for unknown provider keys
  for (const provider of Object.keys(overrides)) {
    if (!knownProviders.includes(provider)) {
      warnings.push(`Unknown provider "${provider}" in circuit breaker overrides (known: ${knownProviders.join(', ')})`);
      continue;
    }

    const override = overrides[provider];
    const details = [];

    // Validate each override value
    for (const [key, value] of Object.entries(override)) {
      const bound = bounds[key];
      if (!bound) {
        warnings.push(`Unknown override key "${key}" for provider "${provider}"`);
        continue;
      }

      // Values should already be clamped by envIntOverride, but verify
      if (value < bound.min || value > bound.max) {
        warnings.push(`Override ${key}=${value} for provider "${provider}" outside bounds [${bound.min}, ${bound.max}]`);
      }

      details.push(`${key}=${value}`);
    }

    if (details.length > 0) {
      validated.push(`${provider}: ${details.join(', ')}`);
    }
  }

  // Log warnings
  if (warnings.length > 0) {
    console.warn('[config] Circuit breaker override validation warnings:');
    for (const warning of warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  // Log validated config
  if (validated.length > 0) {
    console.log('[config] Circuit breaker provider overrides:');
    for (const entry of validated) {
      console.log(`  - ${entry}`);
    }
  } else {
    console.log('[config] No circuit breaker provider overrides configured (using global defaults)');
  }
}

const config = Object.freeze({

  server: Object.freeze({
    port:               envInt('SYNAPSE_SERVER_PORT', 8080),
    projectDir:         envStr('SYNAPSE_PROJECT_DIR', process.cwd()),
    keepAliveTimeoutMs: envInt('SYNAPSE_KEEP_ALIVE_TIMEOUT_MS', 65000),   // slightly > typical LB 60s
    headersTimeoutMs:   envInt('SYNAPSE_HEADERS_TIMEOUT_MS', 66000),      // must be > keepAliveTimeout
    requestTimeoutMs:   envInt('SYNAPSE_REQUEST_TIMEOUT_MS', 30000),      // max time for request body
    socketTimeoutMs:    envInt('SYNAPSE_SOCKET_TIMEOUT_MS', 120000),      // overall socket timeout
  }),

  auth: Object.freeze({
    enabled: process.env.SYNAPSE_AUTH !== 'false',  // default: on
    tokenExpiryDays: envInt('SYNAPSE_AUTH_EXPIRY_DAYS', 30, 0, 365),  // 0 = never expire
    graceMs: envInt('SYNAPSE_AUTH_GRACE_MS', 3600000),  // 1 hour grace after rotation
    // Role mapping: userId -> role. If userId not found, defaults to 'operator'.
    userRoles: Object.freeze({}),
    // Available roles in the system
    roles: Object.freeze({
      OPERATOR: 'operator',
      VIEWER: 'viewer',
    }),
  }),

  operator: Object.freeze({
    name: envStr('SYNAPSE_OPERATOR_NAME', 'operator'),
  }),

  rateLimit: Object.freeze({
    enabled: process.env.SYNAPSE_RATE_LIMIT !== 'false',  // default: on
    maxRequests: envInt('SYNAPSE_RATE_LIMIT_MAX', 120, 1, 10000),  // per window
    windowMs: envInt('SYNAPSE_RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000),  // 1 min default
  }),

  orchestrator: Object.freeze({
    maxTotalTurns:          envInt('SYNAPSE_MAX_TOTAL_TURNS', 30),
    baseTurnBudget:         envInt('SYNAPSE_BASE_TURN_BUDGET', 15, 1, 30),
    repetitionThreshold:    envFloat('SYNAPSE_REPETITION_THRESHOLD', 0.65, 0, 1),
    infoGainThreshold:      envFloat('SYNAPSE_INFO_GAIN_THRESHOLD', 0.15, 0, 1),
    repetitionPatience:     envInt('SYNAPSE_REPETITION_PATIENCE', 2, 1, 10),
    wrapUpBudget:           envInt('SYNAPSE_WRAP_UP_BUDGET', 2, 1, 10),
    maxConsecutivePerAgent: envInt('SYNAPSE_MAX_CONSECUTIVE', 2),
    executionMaxTurns:      envInt('SYNAPSE_EXECUTION_MAX_TURNS', 30),
    executionTimeoutMultiplier: envFloat('SYNAPSE_EXECUTION_TIMEOUT_MULTIPLIER', 2),
    rateLimitCooldownMs:    envInt('SYNAPSE_RATE_LIMIT_COOLDOWN_MS', 15 * 60 * 1000),
    timeoutCooldownMs:      envInt('SYNAPSE_TIMEOUT_COOLDOWN_MS', 60000),
    voteTimeoutMs:          envInt('SYNAPSE_VOTE_TIMEOUT_MS', 45000),
    defaultMessageLimit:    envInt('SYNAPSE_DEFAULT_MESSAGE_LIMIT', 50),
    apiDefaultLimit:        envInt('SYNAPSE_API_DEFAULT_LIMIT', 50),
    dynamicRoutingEnabled:  process.env.SYNAPSE_ORCHESTRATOR_DYNAMIC_ROUTING_ENABLED !== 'false',  // default: on
  }),

  agents: Object.freeze({
    stopGraceMs: envInt('SYNAPSE_AGENT_STOP_GRACE_MS', 5000),
    defaultMaxTurns: envInt('SYNAPSE_AGENT_DEFAULT_MAX_TURNS', 20),
    networkResilience: Object.freeze({
      maxAttempts: envInt('SYNAPSE_NETWORK_RETRY_MAX_ATTEMPTS', 3, 1, 10),
      initialBackoffMs: envInt('SYNAPSE_NETWORK_RETRY_INITIAL_BACKOFF_MS', 1000, 1, 60000),
      maxBackoffMs: envInt('SYNAPSE_NETWORK_RETRY_MAX_BACKOFF_MS', 10000, 1, 120000),
    }),
    timeouts: Object.freeze({
      claude:   envInt('SYNAPSE_TIMEOUT_CLAUDE_MS', 900000),   // 15 min
      codex:    envInt('SYNAPSE_TIMEOUT_CODEX_MS', 360000),    // 6 min
      gemini:   envInt('SYNAPSE_TIMEOUT_GEMINI_MS', 270000),   // 4.5 min
      // opencode wraps any provider — local llama.cpp inference + tool use
      // can run long; default to the broad 15-min envelope.
      opencode: envInt('SYNAPSE_TIMEOUT_OPENCODE_MS', 900000), // 15 min
      ollama:   envInt('SYNAPSE_TIMEOUT_OLLAMA_MS', 900000),   // 15 min (legacy wrapper-HTTP path)
      glm:      envInt('SYNAPSE_TIMEOUT_GLM_MS', 900000),      // 15 min (legacy wrapper-HTTP path)
    }),
    defaults: Object.freeze({
      // Models come from src/model-defaults.js — the SINGLE table shared
      // with the CLI wizard. (Two hand-maintained copies drifted; the stale
      // one surfaced as onboarding offers and failed first dispatch.)
      claude:   Object.freeze({ model: PROVIDER_DEFAULT_MODELS.claude, color: '#d97706' }),
      codex:    Object.freeze({ model: PROVIDER_DEFAULT_MODELS.codex,  color: '#10a37f' }),
      gemini:   Object.freeze({ model: PROVIDER_DEFAULT_MODELS.gemini, color: '#4285f4' }),
      // opencode dispatches to whatever provider/model the user has configured
      // via `opencode auth`; the model string is in opencode's `provider/model`
      // form. No meaningful default — the user supplies it.
      opencode: Object.freeze({ model: PROVIDER_DEFAULT_MODELS.opencode, color: '#a855f7' }),
      glm:      Object.freeze({ model: PROVIDER_DEFAULT_MODELS.glm,      color: '#1565c0' }),
      // Local llama-server model names vary per install — no meaningful
      // default; the user supplies the exact model their server hosts.
      ollama:   Object.freeze({ model: PROVIDER_DEFAULT_MODELS.ollama,   color: '#ff6b35' }),
    }),
    circuitBreaker: ({ // not frozen — operator-tunable (see router comment)
      failureThreshold:  envInt('SYNAPSE_CB_FAILURE_THRESHOLD', 3, 1, 100),
      cooldownMs:        envInt('SYNAPSE_CB_COOLDOWN_MS', 60000, 1000, 600000),
      maxFailureAgeMs:   envInt('SYNAPSE_CB_MAX_FAILURE_AGE_MS', 3600000, 60000, 86400000),  // 1h default, failures older than this are ignored
      // Per-provider threshold overrides: allows customizing circuit breaker behavior per provider.
      // Each key is a provider name (claude, codex, gemini, ollama) with optional overrides for failureThreshold, cooldownMs, maxFailureAgeMs.
      // Missing keys inherit from the defaults above.
      // Set via ENV: SYNAPSE_CB_FAILURE_THRESHOLD_CLAUDE, SYNAPSE_CB_COOLDOWN_MS_CODEX, SYNAPSE_CB_MAX_FAILURE_AGE_MS_GEMINI, etc.
      overrides: buildCircuitBreakerOverrides(),
      // Per-agent threshold overrides: allows customizing circuit breaker behavior per agent.
      // Each key is an agentId with optional overrides for failureThreshold, cooldownMs, maxFailureAgeMs.
      // Set via ENV: SYNAPSE_CB_AGENT_THRESHOLDS='{"agent-1": {"failureThreshold": 5}, "agent-2": {"cooldownMs": 120000}}'
      agentThresholds: buildAgentThresholds(),
    }),
  }),

  compaction: Object.freeze({
    threshold:        envFloat('SYNAPSE_COMPACTION_THRESHOLD', 0.7),
    recentMessagesKeep: envInt('SYNAPSE_COMPACTION_RECENT_KEEP', 20),
    summaryMaxChars:  envInt('SYNAPSE_COMPACTION_SUMMARY_MAX', 8000),
    contextLimits: Object.freeze({
      claude: 200000 * 4,    // ~200K tokens * 4 chars/token
      codex:  128000 * 4,    // ~128K tokens
      gemini: 1000000 * 4,   // ~1M tokens
      glm:   200000 * 4,     // ~200K tokens
    }),
  }),

  threading: Object.freeze({
    jaccardThreshold:    envFloat('SYNAPSE_JACCARD_THRESHOLD', 0.20),
    minTokenLength:      envInt('SYNAPSE_MIN_TOKEN_LENGTH', 3),
    labelMaxLength:      envInt('SYNAPSE_THREAD_LABEL_MAX', 60),
    labelSoftOverflow:   envInt('SYNAPSE_THREAD_LABEL_OVERFLOW', 12),
    slugMaxTokens:       4,
    shortMessageThreshold: 2,
    dynamicKeywordsCap:  envInt('SYNAPSE_DYNAMIC_KEYWORDS_CAP', 80),
  }),

  // Fallback chains: when a paid agent hits rate limit, try this free-tier alternative.
  // provider = which agent wrapper to use, model = which model to request.
  // null = no fallback (already free tier). Single hop only in v1.
  fallback: Object.freeze({
    chains: Object.freeze({
      claude: Object.freeze({ provider: 'ollama', model: envStr('SYNAPSE_FALLBACK_MODEL', 'Qwen3.5-27B-UD-Q4_K_XL.gguf') }),
      codex:  Object.freeze({ provider: 'ollama', model: envStr('SYNAPSE_FALLBACK_MODEL', 'Qwen3.5-27B-UD-Q4_K_XL.gguf') }),
      glm:   Object.freeze({ provider: 'ollama', model: envStr('SYNAPSE_FALLBACK_MODEL', 'Qwen3.5-27B-UD-Q4_K_XL.gguf') }),
      gemini: Object.freeze({ provider: 'ollama', model: envStr('SYNAPSE_FALLBACK_MODEL', 'Qwen3.5-27B-UD-Q4_K_XL.gguf') }),
      ollama: null,
    }),
  }),

  embeddings: Object.freeze({
    endpoint:    envStr('SYNAPSE_EMBED_ENDPOINT', null),
    model:       envStr('SYNAPSE_EMBED_MODEL', 'nomic-embed-text'),
    dimensions:  768,
    maxChars:    envInt('SYNAPSE_EMBED_MAX_CHARS', 4000),
    topK:        envInt('SYNAPSE_EMBED_TOP_K', 5),
    threshold:   envFloat('SYNAPSE_EMBED_THRESHOLD', 0.3, 0, 1),
    timeoutMs:   envInt('SYNAPSE_EMBED_TIMEOUT_MS', 10000),
    ragBudget:   envInt('SYNAPSE_EMBED_RAG_BUDGET', 4000),
    retries:     3,
    retryDelays: [1000, 2000, 4000],
    maxConsecutiveFailures: 3,
  }),

  // Directed routing — classify messages and route to optimal agent(s)
  // NOT frozen: router/tasks/agents.circuitBreaker/pace are operator-tunable
  // at runtime via the gated /api/settings PATCH endpoints (persisted in
  // .synapse/settings-overrides.json). Object.freeze here made every PATCH
  // throw "Cannot assign to read only property" → 400, silently breaking the
  // Settings UI. Nested maps that are NOT PATCHable stay frozen.
  router: ({
    enabled:             process.env.SYNAPSE_DIRECTED_ROUTING !== 'false',
    localFirst:          process.env.SYNAPSE_LOCAL_FIRST !== 'false',       // prefer ollama for low/medium complexity
    // Per-provider rate windows — dispatches allowed within rolling window.
    // Subscription rate limits: Claude Max ~45/5h, ChatGPT Plus ~80/3h, Gemini free ~30/1h.
    // Override via env: SYNAPSE_RATE_MAX_CLAUDE=45, SYNAPSE_RATE_WINDOW_CLAUDE_MS=18000000, etc.
    rateWindows: Object.freeze({
      claude:  { max: envInt('SYNAPSE_RATE_MAX_CLAUDE', 45),  windowMs: envInt('SYNAPSE_RATE_WINDOW_CLAUDE_MS', 5 * 3600000),  label: '5h' },
      codex:   { max: envInt('SYNAPSE_RATE_MAX_CODEX', 80),   windowMs: envInt('SYNAPSE_RATE_WINDOW_CODEX_MS', 3 * 3600000),   label: '3h' },
      gemini:  { max: envInt('SYNAPSE_RATE_MAX_GEMINI', 30),   windowMs: envInt('SYNAPSE_RATE_WINDOW_GEMINI_MS', 3600000),      label: '1h' },
      glm:    { max: envInt('SYNAPSE_RATE_MAX_GLM', 400),     windowMs: envInt('SYNAPSE_RATE_WINDOW_GLM_MS', 5 * 3600000),  label: '5h' },
      ollama:  null, // local — unlimited
    }),
    soloBudget:          envInt('SYNAPSE_ROUTER_SOLO_BUDGET', 2),
    pairBudget:          envInt('SYNAPSE_ROUTER_PAIR_BUDGET', 4),
    confidenceThreshold: envFloat('SYNAPSE_ROUTER_CONFIDENCE', 0.6, 0, 1),
    loadWindowMs:        envInt('SYNAPSE_ROUTER_LOAD_WINDOW_MS', 60000),
    // Production default: 5 (was 3)
    auditInterval:       envInt('SYNAPSE_ROUTER_AUDIT_INTERVAL', 5),
    decayHalfLife:       envInt('SYNAPSE_ROUTER_DECAY_HALF_LIFE_MS', 10000),
    alertWindowSize:     envInt('SYNAPSE_ROUTER_ALERT_WINDOW_SIZE', 10),
    // Proportional routing weight config — passed to computeRoutingWeights()
    floorWeight:         envFloat('SYNAPSE_ROUTER_FLOOR_WEIGHT', 0.05, 0, 0.5),           // min weight (5% preserves exploration)
    sensitivityThreshold: envFloat('SYNAPSE_ROUTER_SENSITIVITY_THRESHOLD', 0.001, 0, 0.1), // if max-min rate < threshold, use uniform
    cost_weight:         envFloat('SYNAPSE_ROUTER_COST_WEIGHT', 0.0, 0, 1.0),              // cost blending (0=perf only, 1=cost only)
  }),

  state: Object.freeze({
    maxIdLength:         100,
    defaultChannel:      'general',
    defaultMessageLimit: 50,
    defaultThreadLimit:  50,
  }),

  tasks: ({ // not frozen — operator-tunable (see router comment)
    heartbeatIntervalMs: envInt('SYNAPSE_TASK_HEARTBEAT_MS', 30000),
    heartbeatStallMs:    envInt('SYNAPSE_HEARTBEAT_STALL_MS', 300000),
    maxRequeues:         envInt('SYNAPSE_TASK_MAX_REQUEUES', 1),
    // Pull model: agents seek work themselves via idle loops; pickup slots limit simultaneous grabs.
    // maxConcurrentTasks / dispatchStaggerMs are replaced by this token-bucket approach.
    pickupSlots:         envInt('SYNAPSE_TASK_PICKUP_SLOTS', 3),      // max simultaneous grab attempts
    agentIdlePollMs:     envInt('SYNAPSE_AGENT_IDLE_POLL_MS', 10000), // how often idle agents scan for work
    // Kept for backward-compat env vars but no longer drives dispatch cap:
    maxConcurrentTasks:  envInt('SYNAPSE_TASK_MAX_CONCURRENT', 20),
    dispatchStaggerMs:   envInt('SYNAPSE_TASK_DISPATCH_STAGGER_MS', 2000),
    stuckSubtaskTimeoutMs: envInt('SYNAPSE_TASK_STUCK_TIMEOUT_MS', 600000), // 10 min (global default)
    // Per-provider overrides — local inference is much slower than cloud APIs
    stuckSubtaskTimeoutMsByProvider: Object.freeze({
      ollama: envInt('SYNAPSE_TASK_STUCK_TIMEOUT_OLLAMA_MS', 1800000), // 30 min (9-35B local inference + large context)
    }),
    // DEPRECATED: implementerPriority is no longer used.
    // Routing now uses cheapestOf(allImplementers()) — cost tier is the priority.
    // Complexity gates (below) control what tasks each agent can pick up.
    implementerPriority: ['codex', 'claude', 'gemini'],
    // Max complexity per provider for implementation tasks
    // Agents exceeding their gate are excluded from routing
    complexityGate: Object.freeze({
      ollama: envStr('SYNAPSE_TASK_OLLAMA_MAX_COMPLEXITY', 'high'),
      // codex and claude have no gate (unrestricted)
    }),
    // Per-provider concurrent cap — pull model: agents are their own throttle.
    // Only ollama is capped (one slot per GPU). All other providers: missing key = unlimited.
    // Agents' own busy state prevents double-execution; no artificial cap needed.
    maxConcurrentPerProvider: Object.freeze({
      ollama: envInt('SYNAPSE_TASK_MAX_CONCURRENT_OLLAMA', 3), // 2 GPUs (Ollie + Olive) + 1 strategist queue slot
      claude: envInt('SYNAPSE_TASK_MAX_CONCURRENT_CLAUDE', 4), // cap=4: Anthropic Max allows ~3 concurrent sessions; SIGTERMs requeue cleanly so marginal overshoot is OK
      glm:   envInt('SYNAPSE_TASK_MAX_CONCURRENT_GLM', 3),     // cap=3: GLM Coding Plan concurrent request limit
    }),
    // Autonomous task execution — agents need room to work
    planningMaxTurns:    envInt('SYNAPSE_TASK_PLANNING_MAX_TURNS', 30),
    planningTimeoutMs:   envInt('SYNAPSE_TASK_PLANNING_TIMEOUT_MS', 600000),  // 10 min (architect explores code before planning)
    executionMaxTurns:   envInt('SYNAPSE_TASK_EXEC_MAX_TURNS', 50),           // 50 turns per subtask
    auditMaxTurns:       envInt('SYNAPSE_TASK_AUDIT_MAX_TURNS', 40),          // 40 turns for post-task audit review
    // Verbatim one-shot dispatches (A/B parity mode): the outside one-shot
    // runs uncapped, so wall-clock must be a RESULT, not a parameter. 24h is
    // "effectively uncapped" while keeping withTimeout() well-defined. The
    // dispatch also passes this as the sandbox per-process lifetime so the
    // 45-min reaper default doesn't kill a long build mid-run.
    oneshotTimeoutMs:    envInt('SYNAPSE_ONESHOT_TIMEOUT_MS', 86400000),
    executionTimeouts: Object.freeze({
      claude: envInt('SYNAPSE_TASK_TIMEOUT_CLAUDE_MS', 600000),   // 10 min
      codex:  envInt('SYNAPSE_TASK_TIMEOUT_CODEX_MS', 600000),    // 10 min
      gemini: envInt('SYNAPSE_TASK_TIMEOUT_GEMINI_MS', 1800000),  // 30 min (capacity/long-context planner/research runs)
      glm:   envInt('SYNAPSE_TASK_TIMEOUT_GLM_MS',   600000),   // 10 min
      ollama: envInt('SYNAPSE_TASK_TIMEOUT_OLLAMA_MS', 2400000),  // 40 min (local qwen via opencode/llama.cpp)
    }),
    // Audit: periodically dispatch a reviewer to check completed work
    audit: Object.freeze({
      interval:    envInt('SYNAPSE_AUDIT_INTERVAL', 1, 1, 100),    // audit every task (was 3 — too lax for unattended)
      onFailure:   true,                                            // always audit when subtasks failed
    }),
    // Review fix cycle — structured findings + auto-fix loop
    review: Object.freeze({
      maxFixCycles:       envInt('SYNAPSE_REVIEW_MAX_FIX_CYCLES', 2),   // max fix→re-review loops before failing
      structuredFindings: true,                                          // request JSON findings from reviewers
    }),
   // Review-and-Revise: Multi-agent deliberation workflow for iterative refinement
    reviewAndRevise: Object.freeze({
      enabled:           envBool('SYNAPSE_REVIEW_AND_REVISE_ENABLED', true), // enabled by default for audit tasks
      maxIterations:     envInt('SYNAPSE_REVIEW_AND_REVISE_MAX_ITERATIONS', 3), // max revision cycles
      triggerTaskTypes:  (process.env.SYNAPSE_REVIEW_AND_REVISE_TRIGGER_TYPES || 'code-review,architecture-design,architecture_design,architecture_decision')
                            .split(',').map(s => s.trim()).filter(Boolean),
    }),
    // Daemon task defaults
    daemon: Object.freeze({
      defaultSleepMs:      envInt('SYNAPSE_DAEMON_SLEEP_MS', 60 * 60 * 1000),       // 1 hour between cycles
      maxDailyCostUsd:     envFloat('SYNAPSE_DAEMON_MAX_DAILY_COST', 10.0),          // $10/day default cap
      maxPerCycleCostUsd:  envFloat('SYNAPSE_DAEMON_MAX_PER_CYCLE_COST', 2.0),       // $2/cycle default cap
      rePlanInterval:      envInt('SYNAPSE_DAEMON_REPLAN_INTERVAL', 5),              // re-plan every 5 cycles
    }),
  }),

  // Dispatch rate gate — spreads usage evenly across the weekly subscription allotment.
  // Stamps are recorded ONLY on successful CAS claim (not on seek/check).
  // Window = 1 hour; limits set to weekly_budget / (7 * 24) so quota never exhausts early.
  // LOCAL providers are ALWAYS uncapped. Gemini is paced per-model (each model has its own quota).
  pace: Object.freeze({
    enabled: envBool('SYNAPSE_PACE_ENABLED', true),
    windowMs: envInt('SYNAPSE_PACE_WINDOW_MS', 3_600_000),   // 1-hour rolling window
    // Providers that run locally (no rate limits, no cloud quotas) — never pace-gated.
    // ENV: SYNAPSE_PACE_LOCAL_PROVIDERS=ollama,llama-cpp (comma-separated, overrides default)
    localProviders: new Set(
      (process.env.SYNAPSE_PACE_LOCAL_PROVIDERS ?? 'ollama,llama-cpp,llamacpp,local').split(',').map(s => s.trim()).filter(Boolean)
    ),
    // Cloud provider caps per rolling window (hourly). Tune to spread weekly allotment.
    // Gemini uses maxPerModel (below) instead — provider-level entry kept for unknown Gemini models.
    maxPerProvider: Object.freeze({
      claude: envInt('SYNAPSE_PACE_MAX_CLAUDE', 15),   // ~2520 subtasks/week max (Claude Max subscription)
      codex:  envInt('SYNAPSE_PACE_MAX_CODEX',  10),   // ~1680 subtasks/week max (ChatGPT Plus)
      gemini: envInt('SYNAPSE_PACE_MAX_GEMINI', 15),   // fallback for unknown Gemini models
      glm:   envInt('SYNAPSE_PACE_MAX_GLM', 70),     // ~400 prompts/5h spread across hourly windows
    }),
    // Gemini: per-model rate limits (each model has its own quota bucket).
    // Flash models have higher limits; Pro models are more restricted.
    // Override via ENV: SYNAPSE_PACE_MAX_GEMINI_MODEL_<SLUG>=N (dots/dashes → underscores, uppercase)
    maxPerModel: Object.freeze({
      'gemini-3-flash-preview':  envInt('SYNAPSE_PACE_MAX_GEMINI_FLASH3',    20),
      'gemini-2.5-flash':        envInt('SYNAPSE_PACE_MAX_GEMINI_FLASH25',   20),
      'gemini-2.5-pro':          envInt('SYNAPSE_PACE_MAX_GEMINI_PRO25',      8),
      'gemini-3-pro-preview':    envInt('SYNAPSE_PACE_MAX_GEMINI_PRO3',       8),
      'GLM-5.1':                 envInt('SYNAPSE_PACE_MAX_GLM_51',             6),
      'GLM-5':                   envInt('SYNAPSE_PACE_MAX_GLM_5',              6),
      'GLM-4.7':                 envInt('SYNAPSE_PACE_MAX_GLM_47',            15),
      'GLM-4.6':                 envInt('SYNAPSE_PACE_MAX_GLM_46',            15),
      'GLM-4.5-Air':             envInt('SYNAPSE_PACE_MAX_GLM_45_AIR',        20),
    }),
  }),

  permissions: Object.freeze({
    enforce:  process.env.SYNAPSE_PERMISSIONS_ENFORCE !== 'false',  // default: on
    auditLog: process.env.SYNAPSE_PERMISSIONS_AUDIT !== 'false',    // log dispatch decisions
  }),

  git: Object.freeze({
    autoCommit:       process.env.SYNAPSE_GIT_AUTOCOMMIT !== 'false',   // default: on
    commitStateFiles: process.env.SYNAPSE_GIT_COMMIT_STATE === 'true',  // opt-in: state files no longer tracked by git
    synapseRepoDir:   envStr('SYNAPSE_REPO_DIR', process.cwd()),        // platform repo root
    commitGuard: Object.freeze({
      enabled:      envBool('SYNAPSE_COMMIT_GUARD_ENABLED', true),
      maxFiles:     parseInt(envStr('SYNAPSE_COMMIT_GUARD_MAX_FILES', '10'), 10),
      syntaxCheck:  envBool('SYNAPSE_COMMIT_GUARD_SYNTAX_CHECK', true),
      auditLogDir:  envStr('SYNAPSE_COMMIT_GUARD_AUDIT_DIR', ''),
      blockedPatterns: (process.env.SYNAPSE_COMMIT_GUARD_BLOCKED || '.env,credentials,secret,key.pem,.pem,.key').split(',').filter(Boolean),
    }),
  }),

  runtimeGuardrails: Object.freeze({
    enabled: envBool('SYNAPSE_GUARDRAILS_ENABLED', true),
    // Default strict branch requirement on enclave runtime only.
    requireNonProtectedBranch: envBool('SYNAPSE_GUARDRAILS_REQUIRE_BRANCH', false),
    failOnDirtyProtectedBranch: envBool('SYNAPSE_GUARDRAILS_FAIL_DIRTY_PROTECTED', false),
    failOnTrackedRuntimeState: envBool('SYNAPSE_GUARDRAILS_FAIL_TRACKED_STATE', true),
    protectedBranches: envStr('SYNAPSE_GUARDRAILS_PROTECTED_BRANCHES', 'main,master'),
  }),

  recovery: Object.freeze({
    mode: ['safe', 'fast'].includes(envStr('SYNAPSE_RECOVERY_MODE', 'safe'))
      ? envStr('SYNAPSE_RECOVERY_MODE', 'safe')
      : 'safe',  // safe = full validation + git-based dedup; fast = skip git checks for quicker startup
    campaignStaleMs: envInt('SYNAPSE_RECOVERY_CAMPAIGN_STALE_MS', 600000),  // 10 min threshold for interrupted campaigns
    skipCampaignRecovery: process.env.SYNAPSE_SKIP_CAMPAIGN_RECOVERY === 'true' || process.argv.includes('--skip-recovery'),
  }),

  scheduler: Object.freeze({
    checkIntervalMs: envInt('SYNAPSE_SCHEDULER_CHECK_MS', 30000),   // check due schedules every 30s
  }),

  triggers: Object.freeze({
    checkIntervalMs: envInt('SYNAPSE_TRIGGER_CHECK_MS', 60000),     // heartbeat every 60s
  }),

  workflows: Object.freeze({
    checkIntervalMs: envInt('SYNAPSE_WORKFLOW_CHECK_MS', 10000),   // advance ready nodes every 10s
  }),

  alertMonitor: Object.freeze({
    intervalMs:  envInt('SYNAPSE_ALERT_MONITOR_INTERVAL_MS', 60000),              // 60s default check interval
    retentionMs: envInt('SYNAPSE_ALERT_MONITOR_RETENTION_MS', 7 * 24 * 60 * 60 * 1000), // 7 days default retention
  }),

  sla: Object.freeze({
    intervalMs: envInt('SYNAPSE_SLA_MONITOR_INTERVAL_MS', 60000),              // 60s default check interval
    latency_p95: Object.freeze({
      type:        'latency_p95',
      thresholdMs: envInt('SYNAPSE_SLA_LATENCY_P95_THRESHOLD_MS', 5000),      // 5s default p95 latency threshold
      windowMinutes: envInt('SYNAPSE_SLA_LATENCY_P95_WINDOW_MIN', 15),        // 15min rolling window
      enabled:     envBool('SYNAPSE_SLA_LATENCY_P95_ENABLED', false),          // disabled by default
    }),
    error_rate: Object.freeze({
      type:          'error_rate',
      thresholdPct:  envFloat('SYNAPSE_SLA_ERROR_RATE_THRESHOLD_PCT', 5.0),   // 5% default error rate threshold
      windowMinutes: envInt('SYNAPSE_SLA_ERROR_RATE_WINDOW_MIN', 15),         // 15min rolling window
      enabled:       envBool('SYNAPSE_SLA_ERROR_RATE_ENABLED', false),        // disabled by default
    }),
    hourly_cost: Object.freeze({
      type:          'hourly_cost',
      thresholdUsd:  envFloat('SYNAPSE_SLA_HOURLY_COST_THRESHOLD_USD', 10.0), // $10 default hourly cost threshold
      windowMinutes: 60,                                                       // 60min rolling window (fixed)
      enabled:       envBool('SYNAPSE_SLA_HOURLY_COST_ENABLED', false),       // disabled by default
    }),
  }),

  anomalyDetector: Object.freeze({
    retentionMs: envInt('SYNAPSE_ANOMALY_RETENTION_MS', 604800000), // 7 days default retention (604800000ms = 7 * 24 * 60 * 60 * 1000)
  }),

  anomalyAlerts: Object.freeze({
    maxSizeBytes: envInt('SYNAPSE_ANOMALY_ALERTS_MAX_SIZE_BYTES', 10 * 1024 * 1024),
    archiveDir:   envStr('SYNAPSE_ANOMALY_ALERTS_ARCHIVE_DIR', '.synapse/alerts-archive'),
    rotationIntervalMs: envInt('SYNAPSE_ANOMALY_ALERTS_ROTATION_INTERVAL_MS', 86400000),
  }),

  analyticsPipeline: Object.freeze({
    enabled:    envBool('SYNAPSE_ANALYTICS_PIPELINE_ENABLED', true),
    intervalMs: envInt('SYNAPSE_ANALYTICS_PIPELINE_INTERVAL_MS', 86400000), // 24h default
    windowMs:   envInt('SYNAPSE_ANALYTICS_PIPELINE_WINDOW_MS', 86400000),   // 24h default
  }),

  degradationDetector: Object.freeze({
    enabled:            envBool('SYNAPSE_DEGRADATION_DETECTOR_ENABLED', true),
    minConsecutiveDeclines: envInt('SYNAPSE_DEGRADATION_MIN_CONSECUTIVE', 3, 2, 10),
    declineThreshold:   envFloat('SYNAPSE_DEGRADATION_DECLINE_THRESHOLD', 0.03, 0.01, 0.5),
    weightReductionScale: envFloat('SYNAPSE_DEGRADATION_WEIGHT_SCALE', 0.5, 0.01, 1.0),
    defaultTtlMs:       envInt('SYNAPSE_DEGRADATION_PROPOSAL_TTL_MS', 604800000, 86400000, 2592000000), // 7 days default (1-30 days)
  }),

  autoresearchBridge: Object.freeze({
    enabled:              envBool('SYNAPSE_AUTORESEARCH_BRIDGE_ENABLED', true),
    proposalTtlMs:        envInt('SYNAPSE_AUTORESEARCH_PROPOSAL_TTL_MS', 14 * 24 * 60 * 60 * 1000, 86400000, 2592000000), // 14 days default (1-30 days)
    minRelativeImprovement: envFloat('SYNAPSE_AUTORESEARCH_MIN_RELATIVE_IMPROVEMENT', 0.15, 0.01, 1.0), // 15% default relative improvement
    minSampleSize:        envInt('SYNAPSE_AUTORESEARCH_MIN_SAMPLE_SIZE', 10, 5, 100), // 10 data points default
  }),

  timeline: Object.freeze({
    // Production default: 14 days (was 7 days)
    retentionMs: envInt('SYNAPSE_TIMELINE_RETENTION_MS', 14 * 24 * 60 * 60 * 1000, 1),
    maxSize:     envInt('SYNAPSE_TIMELINE_MAX_SIZE', 10000, 100, 100000),
    dbPath:      envStr('SYNAPSE_TIMELINE_DB_PATH', '.synapse/projects/_timeline-events.sqlite'),
  }),

  syslog: Object.freeze({
    enabled:  envBool('SYNAPSE_SYSLOG_ENABLED', false),                               // default: off (opt-in)
    host:     envStr('SYNAPSE_SYSLOG_HOST', 'localhost'),                             // syslog receiver hostname/IP
    port:     envInt('SYNAPSE_SYSLOG_PORT', 514, 1, 65535),                           // syslog receiver port (default: 514)
    protocol: envStr('SYNAPSE_SYSLOG_PROTOCOL', 'udp'),                               // transport: udp, tcp, or tls
    facility: envInt('SYNAPSE_SYSLOG_FACILITY', 16, 0, 23),                           // syslog facility (default: LOCAL0 = 16)
    appName:  envStr('SYNAPSE_SYSLOG_APP_NAME', 'synapse'),                           // application name tag
    hostname: envStr('SYNAPSE_SYSLOG_HOSTNAME', ''),                                  // originator hostname (default: os.hostname())
    dropOnFailure: envBool('SYNAPSE_SYSLOG_DROP_ON_FAILURE', true),                   // swallow send errors (default: true)
    // TLS options (only used when protocol='tls')
    tlsOptions: Object.freeze({
      rejectUnauthorized: envBool('SYNAPSE_SYSLOG_TLS_REJECT_UNAUTHORIZED', true),   // verify server certificate (default: true)
      ca:   envStr('SYNAPSE_SYSLOG_TLS_CA', ''),                                      // CA certificate path
      cert: envStr('SYNAPSE_SYSLOG_TLS_CERT', ''),                                    // client certificate path
      key:  envStr('SYNAPSE_SYSLOG_TLS_KEY', ''),                                     // client private key path
    }),
  }),

  sandbox: Object.freeze({
    enabled:               process.env.SYNAPSE_SANDBOX !== 'false',         // default: on
    maxOutputBytes:        envInt('SYNAPSE_SANDBOX_MAX_OUTPUT', 10 * 1024 * 1024),  // 10MB default
    maxConcurrentProcesses: envInt('SYNAPSE_SANDBOX_MAX_PROCS', 20),        // pull model: all non-gov agents can run concurrently (15 non-gov + headroom)
    envFilter:             process.env.SYNAPSE_SANDBOX_ENV_FILTER !== 'false',  // strip sensitive env vars
    maxProcessLifetimeMs:  envInt('SYNAPSE_SANDBOX_MAX_LIFETIME_MS', 2700000),   // 45 min — must exceed longest execution timeout (ollama 40 min)
    // Per-provider concurrency caps
    // ENV override: SYNAPSE_SANDBOX_MAX_PER_PROVIDER_OLLAMA=2
    maxPerProvider: Object.freeze({
      ollama: envInt('SYNAPSE_SANDBOX_MAX_PER_PROVIDER_OLLAMA', 2),
    }),
  }),

  vault: Object.freeze({
    enabled:         envBool('SYNAPSE_VAULT_ENABLED', true),
    staleAfterDays:  envInt('SYNAPSE_VAULT_STALE_AFTER_DAYS', 30, 1, 365),
    patternThreshold: envInt('SYNAPSE_VAULT_PATTERN_THRESHOLD', 3, 2, 20),
    scoreThreshold:  envInt('SYNAPSE_VAULT_SCORE_THRESHOLD', 5, 0, 100),
    maxChars: Object.freeze({
      claude:  envInt('SYNAPSE_VAULT_MAX_CHARS_CLAUDE', 2000, 200, 8000),
      codex:   envInt('SYNAPSE_VAULT_MAX_CHARS_CODEX', 1500, 200, 8000),
      gemini:  envInt('SYNAPSE_VAULT_MAX_CHARS_GEMINI', 1500, 200, 8000),
      glm:     envInt('SYNAPSE_VAULT_MAX_CHARS_GLM',   1500, 200, 8000),
      ollama:  envInt('SYNAPSE_VAULT_MAX_CHARS_OLLAMA', 800, 200, 4000),
    }),
  }),

  crossProjectScan: Object.freeze({
    intervalMs: envInt('SYNAPSE_CROSS_PROJECT_SCAN_INTERVAL_MS', 4 * 60 * 60 * 1000),  // 4 hours
    minProjectsForPattern: envInt('SYNAPSE_CROSS_PROJECT_MIN_PROJECTS', 2),
  }),

  campaigns: Object.freeze({
    strategistIntervalMs:    envInt('SYNAPSE_STRATEGIST_INTERVAL_MS', 300000),           // 5 min periodic review
    decomposeMaxTurns:       envInt('SYNAPSE_CAMPAIGN_DECOMPOSE_MAX_TURNS', 30),         // architect turns for decomposition
    decomposeTimeoutMs:      envInt('SYNAPSE_CAMPAIGN_DECOMPOSE_TIMEOUT_MS', 600000),    // 10 min timeout
    maxMilestonesPerCampaign: envInt('SYNAPSE_CAMPAIGN_MAX_MILESTONES', 20),             // sanity cap
    maxTasksPerMilestone:    envInt('SYNAPSE_CAMPAIGN_MAX_TASKS_PER_MS', 10),            // sanity cap
    autoRetryFailedTasks:    process.env.SYNAPSE_CAMPAIGN_AUTO_RETRY !== 'false',        // auto-retry on partial failure
    maxAutoRetries:          envInt('SYNAPSE_CAMPAIGN_MAX_RETRIES', 3),                  // retry up to 3x with escalation before giving up
    maxActiveCampaigns:      envInt('SYNAPSE_MAX_ACTIVE_CAMPAIGNS', 2),                  // 2 active per project: Campaign 1 has priority; Campaign 2 absorbs capacity during time-gates
    // Approval gate timeout — milestones with requireApproval flag pause execution until operator /approve or timeout
    approvalTimeoutMs:       envInt('SYNAPSE_CAMPAIGN_APPROVAL_TIMEOUT_MS', 86400000),   // 24h default timeout for pending approvals (auto-resume with circuit breaker)
    // Deliberation gate configuration for campaign-level task quality control
    deliberation: Object.freeze({
      enabled: envBool('SYNAPSE_CAMPAIGN_DELIBERATION_ENABLED', true), // enable deliberation for qualifying tasks
      samplingPercentile: envInt('SYNAPSE_CAMPAIGN_DELIBERATION_SAMPLING_PERCENTILE', 20, 1, 100), // top N% complexity
      confidenceThreshold: envFloat('SYNAPSE_CAMPAIGN_DELIBERATION_CONFIDENCE_THRESHOLD', 0.7, 0, 1), // max confidence to trigger
    }),
  }),

  // Approval timeout watcher — scans for milestones pending approval > timeout and auto-resumes them
  // Implements circuit breaker pattern to prevent system overload during timeout events
  approvalTimeoutWatcher: Object.freeze({
    scanIntervalMs: envInt('SYNAPSE_APPROVAL_TIMEOUT_SCAN_INTERVAL_MS', 300000), // 5 min scan interval (default)
  }),

  // MCP (Model Context Protocol) server connections
  // Configure external MCP servers for tool discovery and integration
  // Env override: SYNAPSE_MCP_ENABLED, SYNAPSE_MCP_SERVERS (JSON array),
  //               SYNAPSE_MCP_TOOL_TIMEOUT_MS, SYNAPSE_MCP_TOOL_CB_THRESHOLD, SYNAPSE_MCP_TOOL_CB_COOLDOWN_MS,
  //               SYNAPSE_MCP_FALLBACK_ENABLED, SYNAPSE_MCP_FALLBACK_MAX_ATTEMPTS, SYNAPSE_MCP_FALLBACK_TIMEOUT_MS,
  //               SYNAPSE_MCP_FALLBACK_RETRY_MAX, SYNAPSE_MCP_FALLBACK_RETRY_BASE_DELAY_MS, SYNAPSE_MCP_FALLBACK_RETRY_MAX_DELAY_MS
  mcp: Object.freeze({
    enabled: envBool('SYNAPSE_MCP_ENABLED', false),  // default: off (opt-in)
    servers: (() => {
      const envServers = process.env.SYNAPSE_MCP_SERVERS;
      if (envServers) {
        try {
          const parsed = JSON.parse(envServers);
          if (!Array.isArray(parsed)) {
            console.warn('[config] SYNAPSE_MCP_SERVERS must be a JSON array');
            return [];
          }
          return parsed;
        } catch (err) {
          console.warn('[config] Failed to parse SYNAPSE_MCP_SERVERS:', err.message);
          return [];
        }
      }
      // Default: empty array (no MCP servers configured)
      return [];
    })(),
    reconnect: Object.freeze({
      initialDelayMs: envInt('SYNAPSE_MCP_RECONNECT_INITIAL_DELAY_MS', 1000, 100, 60000),  // 1s default
      maxDelayMs:     envInt('SYNAPSE_MCP_RECONNECT_MAX_DELAY_MS', 60000, 1000, 300000),   // 60s default
      multiplier:     envFloat('SYNAPSE_MCP_RECONNECT_MULTIPLIER', 2.0, 1.0, 5.0),         // 2x default
    }),
    // Tool invocation timeout (default 30s, min 1s, max 300s)
    toolInvocationTimeoutMs: envInt('SYNAPSE_MCP_TOOL_TIMEOUT_MS', 30000, 1000, 300000),
    // Per-tool circuit breaker configuration
    toolCircuitBreaker: Object.freeze({
      failureThreshold: envInt('SYNAPSE_MCP_TOOL_CB_THRESHOLD', 3, 1, 20),              // Open breaker after N consecutive failures
      cooldownMs:       envInt('SYNAPSE_MCP_TOOL_CB_COOLDOWN_MS', 60000, 5000, 600000),  // 60s cooldown, min 5s, max 10m
    }),
    // Fallback policy configuration
    fallback: Object.freeze({
      // Global fallback settings
      default: Object.freeze({
        enabled: envBool('SYNAPSE_MCP_FALLBACK_ENABLED', true),
        maxAttempts: envInt('SYNAPSE_MCP_FALLBACK_MAX_ATTEMPTS', 3, 1, 10),
        timeoutMs: envInt('SYNAPSE_MCP_FALLBACK_TIMEOUT_MS', 30000, 1000, 300000),
        retry: Object.freeze({
          enabled: envBool('SYNAPSE_MCP_FALLBACK_RETRY_ENABLED', true),
          maxRetries: envInt('SYNAPSE_MCP_FALLBACK_RETRY_MAX', 2, 0, 5),
          baseDelayMs: envInt('SYNAPSE_MCP_FALLBACK_RETRY_BASE_DELAY_MS', 1000, 100, 10000),
          maxDelayMs: envInt('SYNAPSE_MCP_FALLBACK_RETRY_MAX_DELAY_MS', 10000, 1000, 60000),
          multiplier: envFloat('SYNAPSE_MCP_FALLBACK_RETRY_MULTIPLIER', 2.0, 1.0, 5.0),
          jitterMs: envInt('SYNAPSE_MCP_FALLBACK_RETRY_JITTER_MS', 500, 0, 5000)
        }),
        selection: Object.freeze({
          strategy: envStr('SYNAPSE_MCP_FALLBACK_STRATEGY', 'ranked'),
          diversifyServers: envBool('SYNAPSE_MCP_FALLBACK_DIVERSIFY_SERVERS', true),
          skipOpenCircuits: envBool('SYNAPSE_MCP_FALLBACK_SKIP_OPEN_CIRCUITS', true)
        }),
        triggers: Object.freeze({
          onTimeout: envBool('SYNAPSE_MCP_FALLBACK_ON_TIMEOUT', true),
          onConnectionError: envBool('SYNAPSE_MCP_FALLBACK_ON_CONNECTION_ERROR', true),
          onToolError: envBool('SYNAPSE_MCP_FALLBACK_ON_TOOL_ERROR', true),
          onCircuitOpen: envBool('SYNAPSE_MCP_FALLBACK_ON_CIRCUIT_OPEN', true)
        })
      }),
      // Category-specific policy overrides (loaded from fallback-policy.js defaults)
      categories: {}
    })
  }),

  logging: Object.freeze({
    level: envStr('SYNAPSE_LOG_LEVEL', 'info'),
    file: Object.freeze({
      enabled: process.env.SYNAPSE_LOG_FILE_ENABLED !== 'false',
      directory: envStr('SYNAPSE_LOG_FILE_DIR', process.cwd() + '/.synapse/logs'),
      filename: envStr('SYNAPSE_LOG_FILE_NAME', 'synapse.log'),
      maxSizeBytes: envInt('SYNAPSE_LOG_FILE_MAX_SIZE', 10 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
      maxFiles: envInt('SYNAPSE_LOG_FILE_MAX_FILES', 5, 1, 100),
    }),
    outputTargets: Object.freeze(
      (process.env.SYNAPSE_LOG_OUTPUT_TARGETS || 'console,file').split(',').map(t => t.trim()).filter(Boolean)
    ),
  }),

  tracing: Object.freeze({
    enabled:      process.env.SYNAPSE_TRACING_ENABLED === 'true',               // default: off (opt-in for production)
    endpoint:     envStr('SYNAPSE_TRACING_ENDPOINT', 'http://localhost:4318/v1/traces'),  // OTLP HTTP endpoint
    // Production default: 0.1 (10% sampling, was 1.0)
    samplingRate: envFloat('SYNAPSE_TRACING_SAMPLING_RATE', 0.1, 0, 1),
  }),
});

// Validate circuit breaker overrides at startup
validateCircuitBreakerOverrides(config.agents.circuitBreaker.overrides);

// Validate SLA configuration at startup
// Ensures SLA types are known and thresholds are within valid ranges
function validateSlaConfig(slaConfig) {
  const knownTypes = ['latency_p95', 'error_rate', 'hourly_cost'];
  const bounds = {
    thresholdMs: { min: 100, max: 300000 },      // 100ms to 5min
    thresholdPct: { min: 0, max: 100 },          // 0% to 100%
    thresholdUsd: { min: 0.01, max: 10000 },     // $0.01 to $10,000
    windowMinutes: { min: 1, max: 1440 },        // 1min to 24hrs
  };

  const warnings = [];
  const validated = [];

  for (const slaType of knownTypes) {
    const config = slaConfig[slaType];
    if (!config) {
      warnings.push(`Missing SLA configuration for type "${slaType}"`);
      continue;
    }

    const details = [];

    // Validate thresholdMs for latency_p95
    if (slaType === 'latency_p95') {
      if (config.thresholdMs < bounds.thresholdMs.min || config.thresholdMs > bounds.thresholdMs.max) {
        warnings.push(`SLA ${slaType} thresholdMs=${config.thresholdMs} outside bounds [${bounds.thresholdMs.min}, ${bounds.thresholdMs.max}]`);
      }
      if (config.windowMinutes < bounds.windowMinutes.min || config.windowMinutes > bounds.windowMinutes.max) {
        warnings.push(`SLA ${slaType} windowMinutes=${config.windowMinutes} outside bounds [${bounds.windowMinutes.min}, ${bounds.windowMinutes.max}]`);
      }
      details.push(`thresholdMs=${config.thresholdMs}ms, window=${config.windowMinutes}min, enabled=${config.enabled}`);
    }

    // Validate thresholdPct for error_rate
    if (slaType === 'error_rate') {
      if (config.thresholdPct < bounds.thresholdPct.min || config.thresholdPct > bounds.thresholdPct.max) {
        warnings.push(`SLA ${slaType} thresholdPct=${config.thresholdPct} outside bounds [${bounds.thresholdPct.min}, ${bounds.thresholdPct.max}]`);
      }
      if (config.windowMinutes < bounds.windowMinutes.min || config.windowMinutes > bounds.windowMinutes.max) {
        warnings.push(`SLA ${slaType} windowMinutes=${config.windowMinutes} outside bounds [${bounds.windowMinutes.min}, ${bounds.windowMinutes.max}]`);
      }
      details.push(`thresholdPct=${config.thresholdPct}%, window=${config.windowMinutes}min, enabled=${config.enabled}`);
    }

    // Validate thresholdUsd for hourly_cost
    if (slaType === 'hourly_cost') {
      if (config.thresholdUsd < bounds.thresholdUsd.min || config.thresholdUsd > bounds.thresholdUsd.max) {
        warnings.push(`SLA ${slaType} thresholdUsd=${config.thresholdUsd} outside bounds [${bounds.thresholdUsd.min}, ${bounds.thresholdUsd.max}]`);
      }
      details.push(`thresholdUsd=$${config.thresholdUsd}, window=60min, enabled=${config.enabled}`);
    }

    if (details.length > 0) {
      validated.push(`${slaType}: ${details.join(', ')}`);
    }
  }

  // Log warnings
  if (warnings.length > 0) {
    console.warn('[config] SLA configuration validation warnings:');
    for (const warning of warnings) {
      console.warn(`  - ${warning}`);
    }
  }

  // Log validated config
  if (validated.length > 0) {
    console.log('[config] SLA configuration:');
    for (const entry of validated) {
      console.log(`  - ${entry}`);
    }
  }
}

validateSlaConfig(config.sla);

// Merge per-project SLA overrides with global defaults.
// Called by orchestrator when initializing SLAMonitor per project.
//
// projectSla is the `sla` field from a project's config.json, e.g.:
//   { "sla": { "latency_p95": { "thresholdMs": 2000, "enabled": true } } }
//
// Only fields present in projectSla override the global value; omitted
// fields fall back to the global default.  The caller receives a plain
// (non-frozen) object suitable for passing into createSLAMonitor().
//
// Supported per-project fields (all optional):
//   latency_p95:  { thresholdMs, windowMinutes, enabled }
//   error_rate:   { thresholdPct, windowMinutes, enabled }
//   hourly_cost:  { thresholdUsd, enabled }
export function getSlaConfigForProject(projectSla = {}) {
  const global = config.sla;

  function merge(globalCfg, overrides = {}) {
    if (!overrides || typeof overrides !== 'object') return { ...globalCfg };
    return { ...globalCfg, ...overrides };
  }

  return {
    latency_p95: merge(global.latency_p95, projectSla.latency_p95),
    error_rate:  merge(global.error_rate,  projectSla.error_rate),
    hourly_cost: merge(global.hourly_cost, projectSla.hourly_cost),
    intervalMs:  projectSla.intervalMs ?? global.intervalMs,
  };
}

export default config;
