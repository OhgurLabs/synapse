/**
 * Orchestrator — thin wiring layer.
 *
 * Initializes all subsystems and wires them together.
 * Logic lives in extracted modules under orchestrator/.
 *
 * Refactored: Session 39, #9.
 */

import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';
import * as ws from 'ws';
const log = createLogger('orchestrator');

// ─── Imports ─────────────────────────────────────────────────────
import { agents, EXECUTION_CAPABLE, PROVIDERS, initAgents, loadAgentsConfig, saveAgentsConfig, addAgent, removeAgent, probeAgent, resolvePermissions, setOnAgentsUpdated, setOnAgentIntroduced, retryIntroduce, isAgentPaused } from './orchestrator/agents.js';
import { canBypassPermissions, filterByPermission, hasPermission, auditDispatch, verifyPersonaIntegrity, registerPersonaHash } from './orchestrator/permissions.js';
import { createApiServer, broadcast, broadcastToChannel, sendThinkingState, clientSubs, thinkingAgents, getWss } from './orchestrator/api.js';
import { StateManager, DEFAULT_STARTER_CHANNEL } from './state.js';
import { CompactionManager } from './compaction.js';
import { generateThreadId, updateThreadKeywords, resolveThread, parseThreadCommand, setAgentStopWords } from './threading.js';
import { EventBus } from './events.js';
import { loadPlugins } from './plugins.js';
import config from './config.js';
import { loadSettingsOverrides, applyConfigOverrides, applyPaceOverrides } from './orchestrator/settings-overrides-store.js';
import { initTracing, shutdownTracing } from './tracing.js';
import { createAuth } from './auth.js';
import { createRateLimiter } from './rate-limiter.js';
import { CredentialVault } from './credentials.js';
import { createWebhookDispatcher } from './orchestrator/webhooks.js';
import { AgendaManager } from './agenda.js';
import { classifyMessage, ROUTING_MATRIX, getCloudBudgetStatus, initDispatchLog } from './router.js';
import { DispatchLog } from './dispatch-log.js';
import { parseMentions } from './context.js';
import { PreferencesManager } from './preferences.js';
import { TaskManager, routeSubtask } from './tasks.js';
import { CampaignManager } from './campaigns.js';
import { embed, isPaused as embedIsPaused } from './rag/embedding.js';
import { search as ragSearch } from './rag/retrieval.js';
import { isNoiseResponse } from './orchestrator/conversation.js';
import { createConversationSystem, initOperatorSpeakers } from './orchestrator/conversation.js';
import { createContextSystem } from './orchestrator/context.js';
import { createSessionSystem } from './orchestrator/session.js';
import { createMessagingSystem } from './orchestrator/messaging.js';
import { createLifecycleSystem, canRoleHandleSuggestedRole } from './orchestrator/lifecycle.js';
import { providerMetricsStore } from './orchestrator/provider-metrics-store.js';
import { createStrategistSystem } from './orchestrator/strategist.js';
import { createCommandHandlers } from './orchestrator/commands.js';
import { createAgentInteraction, RATE_LIMIT_SEMANTICS, getCooldownDurationForReason } from './orchestrator/agent-interaction.js';
import { createRolePauseTracker } from './orchestrator/role-pause-tracker.js';
import { createApprovalAuditTrail } from './audit-trail.js';
import { createExecutionSystem } from './orchestrator/execution.js';
import { createPrReviewDispatcher } from './orchestrator/pr-review-dispatcher.js';
import { createPrMergeDispatcher } from './orchestrator/pr-merge-dispatcher.js';
import { ScheduledReportStore } from './orchestrator/scheduled-report-store.js';
import { createRAGOrchestration } from './orchestrator/rag-orchestration.js';
import { createDispatchSystem, createTurnQueue } from './orchestrator/dispatch.js';
import { createShutdownHandler } from './orchestrator/shutdown.js';
import { closeStateDbs } from './orchestrator/state-db.js';
import { createGovernanceWorkflow } from './orchestrator/governance-workflow.js';
import { CircuitBreaker } from './orchestrator/circuit-breaker.js';
import { createGracefulDegradationHandler } from './orchestrator/graceful-degradation.js';
import { CbTransitionStore } from './orchestrator/cb-transition-store.js';
import { ScheduleManager, createSchedulerLoop, parseScheduleCommand } from './scheduler.js';
import { TriggerManager, createTriggerLoop, parseTriggerCommand } from './triggers.js';
import { WorkflowManager, createWorkflowLoop, parseWorkflowCommand } from './workflows.js';
import { ProcessSandbox } from './sandbox.js';
import { AgentScoreboard } from './analytics.js';
import { LearningsManager } from './learnings.js';
import { TelemetryStore } from './telemetry-store.js';
import { PerformanceStore } from './performance-store.js';
import { OperatorAuditStore } from './operator-audit-store.js';
import { WeightOverrides } from './orchestrator/weight-overrides.js';
import { ProviderCostStore } from './orchestrator/provider-cost-store.js';
import { CategoryCostConfigStore } from './orchestrator/category-cost-config-store.js';
import { GovernanceManager, resolveGovernors, lockGovernanceFiles, unlockGovernanceFiles, hashGovernanceFiles, verifyGovernanceIntegrity, lockSourceFiles, unlockSourceFiles } from './governance.js';
import { collectSnapshot } from './snapshots.js';
import { createSnapshotManager } from './snapshot-manager.js';
import { createCheckpointManager } from './checkpoint-manager.js';
import { ingestFromCloseouts } from './closeout-pipeline.js';
import { createAlertMonitor } from './orchestrator/alert-monitor.js';
import { createSLAMonitor } from './orchestrator/sla-monitor.js';
import { createApprovalTimeoutWatcher } from './orchestrator/approval-timeout-watcher.js';
import { createCrossProjectScanner } from './cross-project-patterns.js';
import { recoveryCheck } from './orchestrator/campaign-recovery.js';
import { createAnomalyDetector } from './orchestrator/anomaly-detector.js';
import { computeSubsystemStatuses } from './orchestrator/health-subsystems.js';
import { setCircuitBreakerListeners, setAlertListeners, setRateLimitListeners } from './orchestrator/health-aggregator.js';
import { getScanStatus } from './orchestrator/pattern-scan-state.js';
import { createAgentConfigStore } from './orchestrator/agent-config-store.js';
import * as agentConfigSchema from './orchestrator/agent-config-schema.js';
import { ErrorRegistry, CATEGORIES } from './utils/error-registry.js';
import { bootstrapDefaultRules } from './guardrail-chain.js';
import { createTimelineStore, bindTimelineIngest } from './orchestrator/timeline-ingest.js';
import { TimelineStore as SQLiteTimelineStore } from './orchestrator/timeline-store.js';
import { createDispatchReplayService } from './orchestrator/dispatch-replay-service.js';
import { runMigrations } from './orchestrator/migrations/migration-runner.js';
import { init as initGuardedFetch } from './guarded-fetch.js';
import { ErrorPatternConstraintStore } from './orchestrator/error-pattern-constraint-store.js';
import { ErrorPatternDetector } from './orchestrator/error-pattern-detector.js';
import { VaultWriter } from './vault/writer.js';
import { createPrStore } from './pr-store.js';
import { VaultQuery } from './vault/query.js';
import { SharedStateStore } from './orchestrator/shared-state-store.js';
import { DeliberationProtocol } from './orchestrator/deliberation-protocol.js';
import { DeliberationCoordinator } from './orchestrator/deliberation-coordinator.js';
import { AgentMemoryStore } from './orchestrator/agent-memory-store.js';
import { ToolRegistry } from './registry/tool-registry.js';
import { McpConnectionManager } from './mcp/connection-manager.js';
import { ToolDistributionService } from './registry/tool-distribution-service.js';
import { ToolCircuitBreaker } from './mcp/tool-circuit-breaker.js';
import { TraceStore } from './orchestrator/trace-store.js';
import { createWebSocketDeltaServer } from './orchestrator/websocket-delta-server.js';
import { PubSubChannelService } from './orchestrator/pub-sub-channels.js';
import { MemoryWriteBackService } from './orchestrator/memory-writeback-service.js';
import { parseExplicitMemoryCommands } from './orchestrator/memory-writeback-extractors.js';
import * as memoryWriteBackExtractors from './orchestrator/memory-writeback-extractors.js';
import { registerMemoryWriteBackEventListeners } from './orchestrator/memory-writeback-listeners.js';
import { EventIngestionService } from './orchestrator/event-ingestion-service.js';

// ─── Import-graph smoke test (deploy gate) ───────────────────────
// SYNAPSE_SMOKE_IMPORT=1 exits 0 right after the ESM import graph has fully
// linked, but BEFORE any side effect (no store opens, no port bind, no agent
// dispatch). A broken or missing export in any transitive import throws at
// module link time — before this line is ever reached — so
//   SYNAPSE_SMOKE_IMPORT=1 node src/orchestrator.js; echo $?
// returns non-zero on a broken module graph and 0 on a clean one. `node --check`
// cannot catch missing-export errors (they surface only at link time); that is
// the exact class that crash-looped the orchestrator 208x on 2026-06-10
// (an agent's half-finished `import` of a non-exported symbol). Used as the
// load-validation gate in the dev→runtime promotion step.
if (process.env.SYNAPSE_SMOKE_IMPORT === '1') {
  process.exit(0);
}

// ─── Error Registry ──────────────────────────────────────────────
const errorRegistry = new ErrorRegistry(200);

// ─── Constants ───────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = config.server.port;
const PROJECT_DIR = config.server.projectDir;
const SERVER_START_TIME = Date.now();

// ─── Persisted settings overrides ────────────────────────────────
// Operator tunes from /api/settings PATCH endpoints persist to
// .synapse/settings-overrides.json; re-apply them over config defaults
// before any factory captures config values. Pace overrides need
// lifecycle.setPaceOverride and are applied after lifecycle creation.
const settingsOverrides = loadSettingsOverrides(join(PROJECT_DIR, '.synapse'));
applyConfigOverrides(config, settingsOverrides);

// ─── Tracing ─────────────────────────────────────────────────────
initTracing(config.tracing);

// ─── Auth & Rate Limiting ────────────────────────────────────────
const auth = createAuth(config, PROJECT_DIR);
const rateLimiter = createRateLimiter(config.rateLimit);

// ─── Credential Vault ────────────────────────────────────────────
const credentialVault = new CredentialVault(PROJECT_DIR, auth.getToken());

// ─── Operator Identity ────────────────────────────────────────────
initOperatorSpeakers(config.operator.name);

// ─── Agents ──────────────────────────────────────────────────────
initGuardedFetch({ timelineStore: null, operatorAuditStore: null });
initAgents(config);
// Register roster names as threading stop words — bare agent-name references
// appear in most messages and inflate keyword similarity across unrelated
// threads. Refreshed on roster changes via agents:updated below.
setAgentStopWords(Object.keys(agents));

// ─── Agent Config Store ──────────────────────────────────────────
const agentConfigStore = createAgentConfigStore({
  agents,
  saveAgentsConfig,
  createLogger,
  config,
});

// ─── Tool Registry & MCP Connection Manager ──────────────────────
const toolRegistry = new ToolRegistry({
  dbPath: join(PROJECT_DIR, '.synapse', 'tool-registry.sqlite'),
});

const mcpConnectionManager = config.mcp.enabled ? new McpConnectionManager({
   servers: config.mcp.servers,
   toolRegistry,
   toolCircuitBreaker: new ToolCircuitBreaker({
     failureThreshold: config.mcp.toolCircuitBreaker?.failureThreshold ?? 3,
     cooldownMs: config.mcp.toolCircuitBreaker?.cooldownMs ?? 30000,
   }),
   reconnect: {
     maxAttempts: 5,
     baseDelay: config.mcp.reconnect.initialDelayMs,
     maxDelay: config.mcp.reconnect.maxDelayMs,
     multiplier: config.mcp.reconnect.multiplier,
   },
}) : null;

const toolDistributionService = config.mcp.enabled ? new ToolDistributionService(
  toolRegistry,
  mcpConnectionManager,
  () => agents,
) : null;

// Wire toolDistributionService into mcpConnectionManager for disconnect handling
if (config.mcp.enabled && mcpConnectionManager && toolDistributionService) {
  mcpConnectionManager.setToolDistributionService(toolDistributionService);
}

// ─── Process Sandbox ─────────────────────────────────────────────
const sandbox = new ProcessSandbox({
  enabled: config.sandbox.enabled,
  maxOutputBytes: config.sandbox.maxOutputBytes,
  maxConcurrentProcesses: config.sandbox.maxConcurrentProcesses,
  maxPerProvider: config.sandbox.maxPerProvider,
  envFilter: config.sandbox.envFilter,
  stopGraceMs: config.agents.stopGraceMs,
  maxProcessLifetimeMs: config.sandbox.maxProcessLifetimeMs,  // 45 min — must exceed ollama inference timeout
});

// Inject sandbox into all agents (current + future)
for (const agent of Object.values(agents)) agent.sandbox = sandbox;
setOnAgentsUpdated(() => {
  for (const agent of Object.values(agents)) {
    if (!agent.sandbox) agent.sandbox = sandbox;
  }
});

// ─── State ───────────────────────────────────────────────────────
const stateManager = new StateManager(PROJECT_DIR).init();
stateManager.watchProjects((projectId, event) => {
  if (event === 'created') {
    log.info(`[watcher] New project detected: ${projectId}`);
  }
});
const compactionManager = new CompactionManager(stateManager);
const agendaManager = new AgendaManager(stateManager);
const prefsManager = new PreferencesManager(stateManager);
const taskManager = new TaskManager(stateManager);

// Initialize error pattern constraint store
const errorPatternConstraintStore = new ErrorPatternConstraintStore({
  dbPath: join(PROJECT_DIR, '.synapse', 'projects', '_error-pattern-constraints.sqlite'),
});

const campaignManager = new CampaignManager(stateManager, errorPatternConstraintStore);
const scheduleManager = new ScheduleManager(stateManager);
const triggerManager = new TriggerManager(stateManager);
const workflowManager = new WorkflowManager(stateManager);
const governanceManager = new GovernanceManager(stateManager, PROJECT_DIR);
const learningsManager = new LearningsManager(stateManager);
const approvalAuditTrail = createApprovalAuditTrail({
  projectsDir: stateManager.projectsDir,
  enabled: true,
});
const vaultWriter = config.vault.enabled ? new VaultWriter(stateManager, config.vault).init() : null;

// Note: prStore initialization moved below `events` bus creation so it can
// emit pr:opened events (Phase 2 review dispatcher subscribes there). See
// the createPrStore() call further down.
const vaultQuery = config.vault.enabled ? new VaultQuery(stateManager.projectsDir, config.vault) : null;
if (vaultWriter) {
  learningsManager.onLearningAdded((projectId, learning) => {
    vaultWriter.onLearningCreated({ projectId, learning });
  });
}
initDispatchLog(stateManager.projectsDir);
const sharedDispatchLog = new DispatchLog({
  dbPath: join(PROJECT_DIR, '.synapse', 'projects', '_dispatch-log.sqlite'),
  legacyJsonlPath: join(PROJECT_DIR, '.synapse', 'projects', '_dispatch-log.jsonl'),
});
const telemetryStore = new TelemetryStore(stateManager.projectsDir);
telemetryStore.init(stateManager.listProjects().map(p => p.id || p));
telemetryStore.startCleanupTimer();
providerMetricsStore.setTelemetryStore(telemetryStore);
const timelineDbPath = isAbsolute(config.timeline.dbPath)
  ? config.timeline.dbPath
  : join(PROJECT_DIR, config.timeline.dbPath);
try {
  const migrationResult = runMigrations(null, { dbPath: timelineDbPath });
  if (migrationResult.errors.length > 0) {
    log.error('Timeline migrations failed', { errors: migrationResult.errors });
  } else if (migrationResult.applied.length > 0) {
    log.info('Timeline migrations applied', { applied: migrationResult.applied });
  } else {
    log.info('Timeline migrations up to date');
  }
} catch (err) {
  log.error('Timeline migration runner crashed', { error: err.message });
}
const timelineStore = createTimelineStore({
  retentionMs: config.timeline.retentionMs,
  maxSize: config.timeline.maxSize,
  autoStart: true,
  dispatchLog: sharedDispatchLog,
});

// Initialize SQLite timeline store for persistent event storage
const sqliteTimelineStore = new SQLiteTimelineStore({
  dbPath: timelineDbPath,
});
log.info('SQLite TimelineStore initialized for persistent event storage', { dbPath: timelineDbPath });

// Initialize error pattern detector with constraint store integration
const errorPatternDetector = new ErrorPatternDetector({
  windowMs: config.errorPatternDetector?.windowMs || 3600000, // 1 hour default
  threshold: config.errorPatternDetector?.threshold || 4, // >3 means 4+
  timelineStore,
  constraintStore: errorPatternConstraintStore,
  defaultTtlMs: config.errorPatternDetector?.defaultTtlMs || 7200000, // 2 hours default
});

const events = new EventBus();
setCircuitBreakerListeners(events);
setAlertListeners(events);
setRateLimitListeners(events);

// ─── PR Store (BYOH PR workflow Phase 1 + 2) ──────────────────────────────
// Persistent store for pull-request records. One-file-per-PR + index.json
// manifest under .synapse/projects/<id>/prs/. Atomic temp+rename writes.
// Phase 2: emits pr:opened so the review dispatcher can auto-assign reviewers.
// Design: vault/audit/synapse-pr-workflow-deliberation.md (R3 converged).
const prStore = createPrStore(stateManager.baseDir, { events });
log.info('PR store initialized', { dir: join(stateManager.baseDir, 'projects') });
bindTimelineIngest({ events, timelineStore, sqliteTimelineStore });
const eventIngestionService = new EventIngestionService({
  events,
  timelineStore,
  sqliteTimelineStore,
});
eventIngestionService.start();

// Wire EventBus to providerMetricsStore for latency artifact publishing
providerMetricsStore.setEventBus(events);

// Same wiring for tool invocations. Without it, the service's twelve
// TOOL_INVOCATION_* emissions go nowhere: it used to resolve its bus from the
// EventBus CLASS, whose .emit is undefined because emit lives on the prototype,
// so every emission silently no-opped and tool invocations never reached the
// operator timeline.
//
// Set HERE rather than as a constructor argument: `events` is created at this
// point in the file, well after toolDistributionService is built above, so
// passing it at construction is a temporal-dead-zone ReferenceError that would
// take the orchestrator down at boot. This mirrors the line directly above.
if (toolDistributionService) {
  toolDistributionService.setEventBus(events);
}
log.info('EventBus wired to providerMetricsStore for latency artifact publishing');
log.info('AuditLogger wired to providerMetricsStore for provider event audit trail');

// Create scoreboard with EventBus for provider latency integration
const scoreboard = new AgentScoreboard(PROJECT_DIR, events);
log.info('AgentScoreboard initialized with EventBus for provider latency tracking');
  const performanceStore = new PerformanceStore(PROJECT_DIR);
   const weightOverrides = new WeightOverrides(join(PROJECT_DIR, '.synapse', 'projects'));
   const providerCostStore = new ProviderCostStore(join(PROJECT_DIR, '.synapse', 'projects'));
   const categoryCostConfigStore = new CategoryCostConfigStore(join(PROJECT_DIR, '.synapse', 'projects'));
   const operatorAuditStore = new OperatorAuditStore(stateManager.projectsDir);
operatorAuditStore.init(stateManager.listProjects().map(p => p.id || p));
// Wire AuditLogger to providerMetricsStore for audit trail
providerMetricsStore.setAuditLogger(operatorAuditStore);
log.info('AuditLogger wired to providerMetricsStore for provider event audit trail');

// Initialize shared state store for cross-agent coordination
const sharedStateStore = new SharedStateStore({
  dbPath: join(PROJECT_DIR, '.synapse', 'projects', '_shared-state.sqlite'),
});

// Initialize pub/sub channel service for cross-terminal coordination
const pubSubChannelService = new PubSubChannelService({ sharedStateStore });
log.info('PubSubChannelService initialized');

// Initialize agent memory store for agent-scoped persistent memory
const agentMemoryStore = new AgentMemoryStore(stateManager);

// Initialize memory write-back service
const memoryWriteBackService = new MemoryWriteBackService({
  agentMemoryStore,
  flushIntervalMs: config.orchestrator.memoryWriteBack?.flushIntervalMs,
  maxBatchSize: config.orchestrator.memoryWriteBack?.maxBatchSize,
});

// Initialize trace store for execution trace tracking
const traceStore = new TraceStore(
  join(PROJECT_DIR, '.synapse', 'projects', '_trace-store.sqlite')
);
log.info('TraceStore initialized', { dbPath: join(PROJECT_DIR, '.synapse', 'projects', '_trace-store.sqlite') });

// Initialize deliberation protocol for review-and-revise workflows
const deliberationProtocol = new DeliberationProtocol(sharedStateStore, { events });
log.info('Deliberation protocol initialized');

// Initialize deliberation coordinator for multi-agent task deliberation
const deliberationCoordinator = new DeliberationCoordinator(sharedStateStore, events, { auditStore: operatorAuditStore });
log.info('Deliberation coordinator initialized');

// Inject deliberation protocol into task manager for multi-agent assignment
taskManager.setDeliberationProtocol(deliberationProtocol);

// Initialize guardrail chain with default rules
const guardrailChain = bootstrapDefaultRules();

// Initialize scheduled report store
const scheduledReportStore = new ScheduledReportStore({
  dbPath: join(PROJECT_DIR, '.synapse', 'scheduled-reports.sqlite'),
  reportsDir: join(PROJECT_DIR, '.synapse', 'reports'),
});
log.info('Scheduled report store initialized', { dbPath: scheduledReportStore.dbPath, reportsDir: scheduledReportStore.reportsDir });

// Backfill performance store from existing closeout summaries on boot
stateManager.listProjects().forEach(p => {
  const projectId = p.id || p;
  try {
    ingestFromCloseouts(campaignManager, performanceStore, projectId);
  } catch (err) {
    log.error('Failed to backfill performance store', { projectId, error: err.message });
  }
});

const snapshotManager = createSnapshotManager({ stateManager, campaignManager, taskManager });
const checkpointManager = createCheckpointManager({ stateManager, campaignManager, taskManager, broadcastToChannel, broadcast });

// Wire checkpointManager to campaignManager for pause/resume checkpoint creation
campaignManager.setCheckpointManager(checkpointManager);
log.info('checkpointManager wired to campaignManager for approval gate checkpoints');
const circuitBreakerOverrides = config.agents.circuitBreaker.overrides
  ? new Map(Object.entries(config.agents.circuitBreaker.overrides).map(([provider, thresholds]) => [provider, thresholds]))
  : null;
const circuitBreakerAgentThresholds = config.agents.circuitBreaker.agentThresholds
  ? new Map(Object.entries(config.agents.circuitBreaker.agentThresholds).map(([agentId, thresholds]) => [agentId, thresholds]))
  : null;
const knownProviders = Object.keys(config.agents.defaults || {});
// Serves ONLY the manual provider-failover endpoint (operator-triggered
// reroute). AUTOMATIC failover no longer reads this: it follows the
// operator's priority ranks within the project roster (#103 rank-walk).
const providerFallbacks = {
  claude: ['codex', 'gemini', 'ollama'],
  codex: ['gemini', 'ollama'],
  gemini: ['ollama'],
};
const circuitBreaker = new CircuitBreaker({
  failureThreshold: config.agents.circuitBreaker.failureThreshold,
  cooldownMs: config.agents.circuitBreaker.cooldownMs,
  maxFailureAgeMs: config.agents.circuitBreaker.maxFailureAgeMs,
  statePath: join(PROJECT_DIR, '.synapse/circuit-breaker-state.json'),
  events,
  overrides: circuitBreakerOverrides,
  agentThresholds: circuitBreakerAgentThresholds,
  resolveProvider: (agentId) => agents?.[agentId]?.provider || null,
  knownProviders,
  providerFallbacks,
});

const cbTransitionStore = new CbTransitionStore({
  dbPath: join(PROJECT_DIR, '.synapse/projects/_circuit-breaker-transitions.sqlite'),
});

const gracefulDegradation = createGracefulDegradationHandler({
  circuitBreaker,
  onPauseWork: (category) => {
    log.warn('Graceful degradation: pausing work', { category });
  },
  onResumeWork: (category) => {
    log.info('Graceful degradation: resuming work', { category });
  },
});

// Startup validation: verify CbTransitionStore is healthy and queryable immediately after init
const storeHealth = cbTransitionStore.healthCheck();
if (!storeHealth.healthy) {
  log.error('CbTransitionStore health check failed', { error: storeHealth.error });
} else {
  log.info('CbTransitionStore initialized and queryable', { transitionCount: storeHealth.transitionCount });
}

// Subscribe to circuit breaker transitions for persistence and cooldown setting
for (const eventName of ['circuit_breaker:open', 'circuit_breaker:half_open', 'circuit_breaker:closed']) {
  events.on(eventName, (data) => {
    try {
      cbTransitionStore.append({
        provider: data.provider,
        previousState: data.previousState,
        newState: data.newState,
        failureCount: data.failureCount,
        timestamp: typeof data.timestamp === 'number' ? new Date(data.timestamp).toISOString() : data.timestamp,
      });
    } catch (err) {
      log.warn('Circuit breaker transition persistence failed', {
        event: eventName,
        provider: data.provider,
        error: err.message
      });
    }
    
    // When a provider circuit breaker opens, set cooldowns for all agents of that provider.
    // The cooldown duration is picked by FAILURE REASON (data.dominantReason from CB),
    // not by a single fallback per provider. A 10-minute z.ai blip (timeout/empty_response)
    // gets a 10-15min cooldown; an actual parsed rate-limit message gets the full reset
    // window. This prevents one bad subprocess hang from blocking the provider for hours.
    if (eventName === 'circuit_breaker:open' && data.provider) {
      try {
        const semantics = RATE_LIMIT_SEMANTICS[data.provider];
        if (semantics?.propagate === 'provider') {
          // dominantReason is included by the CB on every transition event.
          // Older entries / probe re-opens default to 'unknown', which maps to the
          // defensive 30-min default — short enough to recover from blips, long
          // enough to absorb a flapping provider without thrashing.
          const reason = data.dominantReason || 'unknown';
          const cooldownMs = getCooldownDurationForReason(data.provider, reason);
          const until = Date.now() + cooldownMs;

          for (const [agentId, agent] of Object.entries(agents)) {
            if (agent.provider === data.provider) {
              const existing = agentCooldowns.get(agentId);
              if (!existing || existing.until < until) {
                agentCooldowns.set(agentId, {
                  until,
                  reason: `${data.provider}_provider_circuit_breaker:${reason}`,
                  model: agent.model,
                  confidence: 'hard',
                  source: 'circuit_breaker',
                  failureReason: reason,
                });
                persistCooldowns();
                log.info('Circuit breaker opened, set cooldown for agent', {
                  agent: agentId,
                  provider: data.provider,
                  failureReason: reason,
                  cooldownMinutes: Math.round(cooldownMs / 60000),
                });
              }
            }
          }
        }
      } catch (err) {
        log.warn('Failed to set cooldowns for circuit breaker open', {
          provider: data.provider,
          error: err.message,
        });
      }
    }
  });
}

// Wire event hooks for webhook dispatch
taskManager.setOnEvent((event, data) => events.emit(event, data).catch(err => log.warn('EventBus emission failed', { event, error: err.message })));
campaignManager.setConfig(config);
campaignManager.setOnEvent((event, data) => events.emit(event, data).catch(err => log.warn('EventBus emission failed', { event, error: err.message })));
workflowManager.setOnEvent((event, data) => events.emit(event, data).catch(err => log.warn('EventBus emission failed', { event, error: err.message })));
governanceManager.setOnEvent((event, data) => events.emit(event, data).catch(err => log.warn('EventBus emission failed', { event, error: err.message })));
sandbox.setOnEvent((event, data) => {
  events.emit(event, data).catch(err => log.warn('EventBus emission failed', { event, error: err.message }));
  // When sandbox kills a zombie process, log it so operators can investigate.
  // Routine housekeeping reaps (orphan cleanup, abandoned probes, shutdown)
  // log at WARN — the 2026-08 soak showed ERROR here made expected reaps
  // indistinguishable from real failures in monitoring.
  if (event === 'sandbox:process_killed') {
    const routineReap = /orphan|probe_timeout|shutdown/i.test(data.reason || '');
    log[routineReap ? 'warn' : 'error']('Sandbox killed agent process', {
      agent: data.agent, taskId: data.taskId, reason: data.reason, runningMs: data.runningMs,
    });

    let category = CATEGORIES.SPAWN_FAILURE;
    let message = `Sandbox killed process for agent '${data.agent}' for reason: ${data.reason}.`;
    let suggestedFix = `Review agent '${data.agent}' code and execution environment. Check for infinite loops, excessive memory usage, or external command failures.`;

    if (data.reason && /timeout|exceeded max running time/i.test(data.reason)) {
      category = CATEGORIES.TIMEOUT;
      message = `Sandbox terminated agent '${data.agent}' due to timeout after ${data.runningMs}ms.`;
      suggestedFix = `Increase timeout settings for agent '${data.agent}' or optimize its task to complete within the allowed time.`;
    } else if (data.reason && /memory|resource limits/i.test(data.reason)) {
      category = CATEGORIES.SPAWN_FAILURE;
      message = `Sandbox terminated agent '${data.agent}' due to exceeding resource limits (${data.reason}).`;
      suggestedFix = `Optimize agent '${data.agent}' for lower resource consumption or adjust sandbox resource limits.`;
    }

    errorRegistry.record({
      agentId: data.agent || 'unknown',
      category: category,
      message: message,
      suggestedFix: suggestedFix,
      context: {
        taskId: data.taskId,
        reason: data.reason,
        runningMs: data.runningMs,
      },
    });
  }
});

registerMemoryWriteBackEventListeners({
  events,
  taskManager,
  memoryWriteBackService,
  extractors: memoryWriteBackExtractors,
});

// ─── Snapshot persistence (debounced per-project) ─────────────
const _pendingSnapshots = new Map();
function scheduleSnapshot(projectId) {
  if (_pendingSnapshots.has(projectId)) clearTimeout(_pendingSnapshots.get(projectId));
  _pendingSnapshots.set(projectId, setTimeout(() => {
    _pendingSnapshots.delete(projectId);
    try {
      collectSnapshot(projectId, { stateManager, campaignManager, taskManager, workflowManager, baseDir: PROJECT_DIR });
    } catch (err) {
      log.warn('Snapshot write failed', { projectId, error: err.message });
    }
  }, 1000));
}
// taskManager.setAfterSave(scheduleSnapshot);
// campaignManager.setAfterSave(scheduleSnapshot);

// ─── EventBus → WebSocket Bridge ─────────────────────────────────
const WS_EVENT_MAP = {
  'task:created':                  'task_created',
  'task:status_changed':           'task_updated',
  'task:completed':                'task_completed',
  'campaign:created':              'campaign_created',
  'campaign:status_changed':       'campaign_updated',
  'campaign:milestone_completed':  'campaign_milestone_completed',
  'campaign:milestone_activated':  'campaign_milestone_activated',
  'campaign:constraint_batched':   'constraint_batched',
  'campaign:constraint_applied':   'constraint_applied',
  'campaign:constraint_removed':   'constraint_removed',
  'campaign:cycling':              'campaign_cycling',
  'workflow:run_started':          'workflow_run_started',
  'workflow:node_completed':       'workflow_node_completed',
  'workflow:run_completed':        'workflow_run_completed',
  'workflow:run_failed':           'workflow_run_failed',
  'schedule:fired':                'schedule_fired',
  'governance:proposal_created':   'governance_proposal_created',
  'governance:proposal_applied':   'governance_proposal_applied',
  'governance:proposal_rejected':  'governance_proposal_rejected',
  'circuit_breaker:open':          'circuit_breaker_open',
  'circuit_breaker:half_open':     'circuit_breaker_half_open',
  'circuit_breaker:closed':        'circuit_breaker_closed',
  'snapshot:created':              'snapshot_created',
  'snapshot:restored':             'snapshot_restored',
  'alert:firing':                  'alert_firing',
  'alert:resolved':                'alert_resolved',
  'agent:validation_complete':     'validation_complete',
  'campaign:recovered':            'campaign_recovered',
  'campaign:needs_review':         'campaign_needs_review',
  // Role-pause signals are global (no projectId): telemetry persistence
  // skips them, the WS broadcast still reaches every dashboard client.
  // Before this they had ZERO consumers — a log line was the only output.
  'task_queue:role_paused':        'role_paused',
  'task_queue:role_resumed':       'role_resumed',
};

// ─── EventBus → Telemetry Persistence ─────────────────────────
// Register BEFORE WS broadcast so eventId is assigned before forwarding.
// Persist all system events to per-project telemetry.jsonl.
for (const eventName of Object.keys(WS_EVENT_MAP)) {
  events.on(eventName, (data) => {
    const projectId = data.projectId || data.project;
    if (!projectId) return;
    const eventId = telemetryStore.append(projectId, eventName, data);
    return { ...data, eventId };
  });
}

for (const [eventName, wsType] of Object.entries(WS_EVENT_MAP)) {
  events.on(eventName, (data) => broadcast({ type: wsType, ...data }));
}

// Keep threading's agent-name stop words in sync with the live roster.
events.on('agents:updated', () => setAgentStopWords(Object.keys(agents)));

// ─── Webhooks ────────────────────────────────────────────────────
const webhookDispatcher = createWebhookDispatcher({
  events, stateManager, config, baseDir: PROJECT_DIR,
});

// ─── RAG / Embeddings ────────────────────────────────────────────
const { getVectorStore, reindexEmbeddings } = createRAGOrchestration({
  stateManager, config, PROJECT_DIR, learningsManager,
});

// ─── Messaging ───────────────────────────────────────────────────
const { addMessage, getSessionMessageCount } = createMessagingSystem({
  stateManager, broadcastToChannel, getWss,
  getClientSubs: () => clientSubs,
  events, getVectorStore, embed, config,
});

// Wire the agent-introduction callback now that addMessage is available.
// When a freshly-registered agent completes its introduction probe, post the
// response into whichever project is currently the user's "home" — either the
// configured defaultProject, or the first project in the list as fallback.
// Failures post a system message with the error + a hint to retry. See
// task 10d in docs/init-wizard-design.md.
function resolveHomeChannel() {
  const projects = stateManager.listProjects();
  if (!projects.length) return null; // No projects — agent intro silently drops
  const configured = stateManager.config.defaultProject;
  const home = (configured && stateManager.getProject(configured)) ? configured : projects[0].id;
  const proj = stateManager.getProject(home);
  const channel = proj?.defaultChannel || DEFAULT_STARTER_CHANNEL;
  return { projectId: home, channelId: channel };
}

setOnAgentIntroduced((agentId, agentName, response, errorText) => {
  const target = resolveHomeChannel();
  if (!target) {
    log.warn('No project available for agent intro — skipping', { agentId, agentName });
    return;
  }
  try {
    if (response) {
      addMessage(target.projectId, target.channelId, agentName, response, 'message');
    } else {
      addMessage(
        target.projectId,
        target.channelId,
        'System',
        `Agent **${agentName}** couldn't introduce itself. Error: ${errorText || 'unknown'}. Click the agent's badge to open settings, fix the issue, and save to retry.`,
        'system',
      );
    }
  } catch (e) {
    log.warn('addMessage failed during agent introduction', { agentId, agentName, error: e.message });
  }
});

// ─── Utilities ───────────────────────────────────────────────────
function timeSince(date) {
  const secs = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function runCompaction(name, agent, projectId, channelId, threadId = null) {
  const threadLabel = threadId ? ` thread:${threadId.replace(/^thread_\d+_/, '')}` : '';
  log.info('Compaction triggered', { agent: name, projectId, channelId, threadId });
  broadcastToChannel(projectId, channelId, { type: 'status', speaker: name, status: 'thinking' });
  const prompt = compactionManager.buildCompactionPrompt(agent.name, projectId, channelId, threadId);
  if (!prompt) return;
  return (async () => {
    try {
      const workingDir = stateManager.getProject(projectId)?.projectDir || PROJECT_DIR;
      const rawSummary = await agent.send(prompt, workingDir);
      // Normalize ResponseObject → string. Without this, the .length check
      // returns undefined (falsy) so the compaction is silently skipped for
      // descriptor-backed agents; if the check did pass, summary would be
      // stored as the literal '[object Object]'. Same pattern as
      // lifecycle.js:2046 and execution.js (3 sites).
      const summary = typeof rawSummary === 'string' ? rawSummary
        : (rawSummary?.text != null ? String(rawSummary.text) : String(rawSummary ?? ''));
      if (summary && summary.length > 100) {
        compactionManager.saveSummary(projectId, agent.name, summary, threadId);
        log.info('Compaction saved', { agent: name, projectId, threadId, chars: summary.length });
        addMessage(projectId, channelId, 'System',
          `Context compacted for ${agent.name}${threadLabel} (${summary.length} chars summarized)`, 'system');
      }
    } catch (err) {
      log.error('Compaction error', { agent: name, error: err.message });
    }
  })();
}

// ─── Context System ──────────────────────────────────────────────
const { agentSystemPrompt, formatContext, formatFollowUp } = createContextSystem({
  getAgents: () => agents,
  stateManager, agendaManager, getVectorStore, ragSearch, embedIsPaused,
  config, timeSince, PROJECT_DIR, toolDistributionService, agentMemoryStore,
});

// ─── Agent Interaction ───────────────────────────────────────────
const agentInteraction = createAgentInteraction({
  agents, config, addMessage, broadcastToChannel, events,
  stateManager, formatContext, isNoiseResponse,
  compactionManager, runCompaction, PROVIDERS, PROJECT_DIR, thinkingAgents,
  verifyPersonaIntegrity, registerPersonaHash, auditDispatch, resolvePermissions, circuitBreaker,
  errorRegistry, CATEGORIES, memoryWriteBackService, parseExplicitMemoryCommands,
});
const { getAgentResponse, isAgentCoolingDown, setAgentCooldown,
  agentCooldowns, persistCooldowns, fallbackStates, getAgentTimeout, withTimeout, RATE_LIMIT_RE, MODEL_NOT_FOUND_RE,
  startRateLimitProbe, stopRateLimitProbe, startFallbackCleanup, stopFallbackCleanup } = agentInteraction;

// ─── Role-Pause Tracker ──────────────────────────────────────────
const { isRolePaused, getPausedRoles, markRolePaused, markRoleResumed } = createRolePauseTracker({
  agents, isAgentCoolingDown, circuitBreaker,
  // Same capability matrix as dispatch eligibility: queued roles arrive as
  // suggestedRole vocabulary ('implementer'), agents carry roster roles
  // ('developer'). Exact matching made the pause signal fire never (#94).
  canHandle: canRoleHandleSuggestedRole,
});

// ─── Session Management ──────────────────────────────────────────
const { startSession, resumeSession, sessionStatus, endSession } = createSessionSystem({
  addMessage, stateManager, compactionManager, agendaManager, events,
  broadcastToChannel, getAgents: () => agents, PROJECT_DIR,
});

// ─── Conversation System ─────────────────────────────────────────
const { dispatchSolo, dispatchPair, conversationLoop } = createConversationSystem({
  config, getAgents: () => agents, execCapable: EXECUTION_CAPABLE, stateManager,
  addMessage, broadcastToChannel, formatContext, formatFollowUp, agentSystemPrompt,
  getAgentResponse, isAgentCoolingDown, taskManager,
  auditDispatch, filterByPermission, PROJECT_DIR, errorRegistry, CATEGORIES,
});

// ─── Strategist System ───────────────────────────────────────────
const strategist = createStrategistSystem({
  campaignManager, taskManager, stateManager, agents,
  addMessage, broadcastToChannel, withTimeout, config, PROJECT_DIR,
  thinkingAgents,
  getVectorStore, ragSearch, learningsManager, performanceStore,
  isAgentCoolingDown, circuitBreaker, setAgentCooldown, MODEL_NOT_FOUND_RE, RATE_LIMIT_RE,
  vaultWriter,
});
const {
  strategistEvaluate, strategistDecompose, strategistDecomposeCampaign,
  strategistInject, startStrategist, stopStrategist, strategistTick,
} = strategist;

// ─── Event-driven decomposition ─────────────────────────────────
// Campaign → milestones: when a campaign becomes active with no milestones
events.on('campaign:status_changed', ({ projectId, campaignId, status }) => {
  if (status !== 'active') return;
  const campaign = campaignManager.getCampaign(projectId, campaignId);
  if (campaign && campaign.milestones.length === 0) {
    strategistDecomposeCampaign(projectId, campaignId).catch(err => {
      log.error('Event-driven campaign decomposition failed', { projectId, campaignId, error: err.message });
    });
  }
});
events.on('campaign:created', ({ projectId, campaignId }) => {
  const campaign = campaignManager.getCampaign(projectId, campaignId);
  if (campaign?.status === 'active' && campaign.milestones.length === 0) {
    strategistDecomposeCampaign(projectId, campaignId).catch(err => {
      log.error('Event-driven campaign decomposition failed', { projectId, campaignId, error: err.message });
    });
  }
});
// Milestone → tasks: when a milestone becomes active with no tasks
events.on('campaign:milestone_activated', ({ projectId, campaignId, milestoneId }) => {
  const campaign = campaignManager.getCampaign(projectId, campaignId);
  const milestone = campaign?.milestones?.find(m => m.id === milestoneId);
  if (milestone && (!milestone.tasks || milestone.tasks.length === 0)) {
    strategistDecompose(projectId, campaignId, milestoneId).catch(err => {
      log.error('Event-driven milestone decomposition failed', { projectId, campaignId, milestoneId, error: err.message });
    });
  }
});

// ─── Governance Workflow ─────────────────────────────────────────
const governanceWorkflow = createGovernanceWorkflow({
  governanceManager, agents, events, addMessage, broadcastToChannel,
  withTimeout, config, PROJECT_DIR, stateManager,
  timelineStore, weightOverrides, operatorAudit: operatorAuditStore,
});
governanceWorkflow.start();

// ─── Lifecycle System ────────────────────────────────────────────
const lifecycle = createLifecycleSystem({
  taskManager, stateManager, campaignManager, agents,
  addMessage, broadcastToChannel, withTimeout, config,
  routeSubtask, getAgentResponse, isAgentCoolingDown, setAgentCooldown,
  agentCooldowns, RATE_LIMIT_RE, MODEL_NOT_FOUND_RE, thinkingAgents, PROJECT_DIR,
  canBypassPermissions, filterByPermission, hasPermission, auditDispatch, registerPersonaHash,
  lockGovernanceFiles, unlockGovernanceFiles, hashGovernanceFiles, verifyGovernanceIntegrity, lockSourceFiles, unlockSourceFiles,
  isRolePaused, getPausedRoles, markRolePaused, markRoleResumed,
  eventBus: events, scoreboard, circuitBreaker, learningsManager, checkpointManager, dispatchLog: sharedDispatchLog, providerMetricsStore, operatorAuditStore,
  vaultWriter, vaultQuery, deliberationProtocol, deliberationCoordinator, performanceStore, sandbox, agentMemoryStore, timelineStore, scheduledReportStore,
  prStore,                                            // BYOH PR workflow Phase 1.3 — auto-open PR on subtask claim
});
lifecycle.setStrategistEvaluate(strategistEvaluate);
applyPaceOverrides(settingsOverrides, lifecycle.setPaceOverride);
const { recoverTasks, startHeartbeat, stopHeartbeat, startWatchdog, stopWatchdog } = lifecycle;

// ─── Alert Monitor ──────────────────────────────────────────────
const alertMonitor = createAlertMonitor({
  events,
  stateManager,
  computeSubsystemStatuses,
  healthDeps: {
    agents, isAgentCoolingDown, circuitBreaker,
    getVectorStore, stateManager, lifecycle,
    taskManager, isAgentPaused, // #103 architect-starvation check
    projectDir: PROJECT_DIR,
  },
  config,
  performanceStore,
  filePath: join(PROJECT_DIR, '.synapse/alert-monitor.jsonl'),
});
alertMonitor.start();

// ─── Approval Timeout Watcher ────────────────────────────────────
const approvalTimeoutWatcher = createApprovalTimeoutWatcher({
  campaignManager,
  stateManager,
  events,
  config,
  alertMonitor,
  circuitBreaker,
});
approvalTimeoutWatcher.start();

// ─── SLA Monitor ────────────────────────────────────────────────
const slaMonitor = createSLAMonitor({
  events,
  config,
  performanceStore,
  timelineStore,
  filePath: join(PROJECT_DIR, '.synapse/sla-monitor.jsonl'),
});
slaMonitor.start();

// ─── Anomaly Detector ────────────────────────────────────────
const anomalyDetector = createAnomalyDetector({
  events,
  performanceStore,
  config,
  filePath: join(PROJECT_DIR, '.synapse/anomaly-alerts.jsonl'),
});
anomalyDetector.start();

gracefulDegradation.start();

// ─── Cross-Project Pattern Scanner ───────────────────────────────
const crossProjectScanner = createCrossProjectScanner({
  stateManager, learningsManager, campaignManager, taskManager,
  addMessage, config,
});
crossProjectScanner.start();
// ─── Execution System ────────────────────────────────────────────
const { dispatchExecution } = createExecutionSystem({
  getAgents: () => agents, stateManager, config, addMessage, broadcastToChannel,
  thinkingAgents, getAgentTimeout, withTimeout, isNoiseResponse,
  PROJECT_DIR, EXECUTION_CAPABLE,
  canBypassPermissions, auditDispatch, isAgentCoolingDown,
  errorRegistry, CATEGORIES,
  guardrailChain, operatorAuditStore, dispatchLog: sharedDispatchLog, events,
  toolDistributionService,
  taskManager,
  prStore,                                            // BYOH PR workflow Phase 1.4 — chat-execute auto-PR
});

// ─── PR Review Dispatcher (BYOH PR workflow Phase 2) ──────────────────────
// Subscribes to pr:opened from PrStore. On each event: picks an eligible
// reviewer agent, computes the diff, dispatches the reviewer, parses the
// verdict, and persists the review via prStore.addReview. Direct .send()
// dispatch (strategist pattern), not subtask-routed. Soft-fails throughout.
const { dispatchReview } = createPrReviewDispatcher({
  getAgents: () => agents, prStore, events, stateManager, addMessage,
  PROJECT_DIR,
  busyAgents: lifecycle.getAgentCookies(),  // alias to agentCookies; .has(id) works
  isAgentCoolingDown, withTimeout, config,
});

// ─── PR Merge Dispatcher (BYOH PR workflow Phase 3) ───────────────────────
// Subscribes to pr:approved. Evaluates merge policy (synapse-project hard-
// block, requiresOperatorApproval, autoMergePolicy, stale-approval check).
// If policy allows, runs `git merge --no-ff` in the project's workingDir,
// captures the merge commit, calls prStore.markMerged. Per-project mutex
// serializes concurrent merges. Soft-fails on conflict (git merge --abort).
const { dispatchMerge } = createPrMergeDispatcher({
  prStore, events, stateManager, addMessage, PROJECT_DIR,
});

// ─── Turn Queue ──────────────────────────────────────────────────
const { queueTurn, turnQueues } = createTurnQueue();

// ─── Scheduler Loop ──────────────────────────────────────────────
const schedulerLoop = createSchedulerLoop({
  scheduleManager, addMessage, broadcastToChannel, taskManager, events, config, workflowManager,
});

// ─── Command Handlers ────────────────────────────────────────────
const commandHandlers = createCommandHandlers({
  stateManager, agendaManager, prefsManager, taskManager, campaignManager, checkpointManager, scheduleManager, triggerManager, workflowManager,
  addMessage, broadcast, broadcastToChannel,
  strategistDecomposeCampaign, strategistInject, strategistEvaluate,
  agents, thinkingAgents, fallbackStates, agentCooldowns,
  getSessionMessageCount, SERVER_START_TIME, PROJECT_DIR, config,
  startSession, resumeSession, sessionStatus, endSession,
  isAgentCoolingDown, generateThreadId, updateThreadKeywords, resolveThread,
  auth,
  operatorAuditStore,
  approvalAuditTrail,
});

// ─── Dispatch System ─────────────────────────────────────────────
const { handleUserMessage, dispatchLog } = createDispatchSystem({
  agents, stateManager, config, events,
  addMessage, broadcast, broadcastToChannel,
  commandHandlers, getWss,
  dispatchSolo, dispatchPair, conversationLoop, dispatchExecution,
  EXECUTION_CAPABLE, isAgentCoolingDown, performanceStore,
  taskManager, campaignManager, anomalyDetector, circuitBreaker,
  dispatchLog: sharedDispatchLog,
  weightOverrides,
  errorPatternDetector,
});

// ─── Trigger Loop ────────────────────────────────────────────────
const triggerLoop = createTriggerLoop({
  triggerManager, stateManager, addMessage, broadcastToChannel,
  taskManager, queueTurn, handleUserMessage, events, workflowManager, campaignManager, credentialVault,
});

// ─── Workflow Loop ───────────────────────────────────────────────
const workflowLoop = createWorkflowLoop({
  workflowManager, stateManager, taskManager, addMessage, broadcastToChannel,
  queueTurn, handleUserMessage, events, config, credentialVault, governanceManager,
});

// ─── API Server ──────────────────────────────────────────────────
// ─── Dispatch Replay ─────────────────────────────────────────────
// Wires POST /api/timeline/replay/:dispatch_id, which has answered 503 since
// it shipped because this dependency was never provided (#54). Built after the
// dispatch system, because it needs handleUserMessage and dispatchLog from it,
// and it takes sqliteTimelineStore specifically — the persistent store the API
// is handed and the one operator_action events are written to.
//
// Guarded: createDispatchReplayService THROWS a TypeError if any dependency is
// missing, and this runs unwrapped at module scope. An unguarded throw here
// would turn "replay is misconfigured" into "the orchestrator does not boot".
// On failure the service stays undefined and the endpoint's existing 503 guard
// answers honestly — replay degrades, nothing else does.
let dispatchReplayService = null;
try {
  dispatchReplayService = createDispatchReplayService({
    dispatchLog,
    timelineStore: sqliteTimelineStore,
    handleUserMessage,
  });
} catch (err) {
  console.error(`[orchestrator] dispatch replay unavailable: ${err.message}`);
}

const { startServer, getServer, setUpgradeHandler, close: closeApiServer } = createApiServer({
  dispatchReplayService,
  stateManager, agents, config, PORT, auth, webhookDispatcher, slaMonitor,
  handleUserMessage, queueTurn,
  parseMentions, classifyMessage, ROUTING_MATRIX,
  recoverTasks, startHeartbeat, startWatchdog, startStrategist, reindexEmbeddings, startRateLimitProbe,
  startFallbackCleanup, stopFallbackCleanup,
  loadAgentsConfig, saveAgentsConfig, addAgent, removeAgent, probeAgent,
  retryIntroduce,
  resolvePermissions, PROVIDERS,
  fallbackStates, isAgentCoolingDown, agentCooldowns,
  turnQueues, taskManager, campaignManager,
  scheduleManager, schedulerLoop,
  triggerManager, triggerLoop,
  workflowManager, workflowLoop,
  prefsManager, agendaManager, getSessionMessageCount,
  strategistDecomposeCampaign, strategistInject, strategistEvaluate, strategistTick,
  addMessage, SERVER_START_TIME, getCloudBudgetStatus, getVectorStore,
  getPaceGateStatus: lifecycle.getPaceGateStatus,
  setPaceOverride: lifecycle.setPaceOverride,
  sandbox, rateLimiter, credentialVault, events, telemetryStore, WS_EVENT_MAP,
  circuitBreaker, circuitBreakerHistoryStore: cbTransitionStore, snapshotManager, checkpointManager, alertMonitor, anomalyDetector, performanceStore, dispatchLog, operatorAuditStore,
   agentConfigStore, agentConfigSchema, errorRegistry,
   weightOverrides, providerCostStore, categoryCostConfigStore,
   errorPatternConstraintStore,
   timelineStore: sqliteTimelineStore,
   recoveryCheck,
   crossProjectScanner,
   getPatternScanStatus: getScanStatus,
   vaultWriter,
   prStore,                                          // BYOH PR workflow Phase 1 — surfaced to api.js
   sharedStateStore,
   scheduledReportStore,
    mcpConnectionManager,
    toolRegistry,
    toolDistributionService,
    traceStore,
   agentCookies: lifecycle.getAgentCookies(),
});

// ─── WebSocket Delta Server ─────────────────────────────────────
// Created after API server but before startup to ensure HTTP server is available
let websocketDeltaServer = null;

// ─── Campaign Recovery ──────────────────────────────────────────
// ─── Plugins & Startup ──────────────────────────────────────────
log.info('Loop thresholds', { baseTurnBudget: config.orchestrator.baseTurnBudget, repetitionThreshold: config.orchestrator.repetitionThreshold, infoGainThreshold: config.orchestrator.infoGainThreshold, repetitionPatience: config.orchestrator.repetitionPatience, wrapUpBudget: config.orchestrator.wrapUpBudget });

const pluginDir = join(PROJECT_DIR, '.synapse', 'plugins');
const pluginApi = {
  on: (event, handler) => events.on(event, handler),
  off: (event, handler) => events.off(event, handler),
  getAgents: () => Object.entries(agents).map(([k, v]) => ({ id: k, name: v.name, model: v.model })),
  getProjects: () => stateManager.listProjects(),
  addMessage: (projectId, channelId, speaker, content, meta) =>
    addMessage(projectId, channelId, speaker, content, 'message', meta || {}),
  broadcast: (projectId, channelId, msg) => broadcastToChannel(projectId, channelId, msg),
};

// Run campaign recovery before loading plugins and starting server
(async () => {
  // Scan for campaigns interrupted by previous shutdown and resume or flag for review
  if (!config.recovery.skipCampaignRecovery) {
    try {
      const recoveryResult = await recoveryCheck({
        stateManager,
        campaignManager,
        eventBus: events,
        config: {
          skipRecovery: config.recovery.skipCampaignRecovery,
          campaignStaleMs: config.recovery.campaignStaleMs,
          baseDir: join(PROJECT_DIR, '.synapse'),
        },
      });

      if (recoveryResult.recovered.length > 0 || recoveryResult.needsReview.length > 0) {
        log.info('Campaign recovery complete', {
          recovered: recoveryResult.recovered.length,
          needsReview: recoveryResult.needsReview.length,
          campaigns: {
            recovered: recoveryResult.recovered,
            needsReview: recoveryResult.needsReview,
          },
        });
      } else if (!recoveryResult.clean) {
        log.info('Campaign recovery check complete', { status: 'no action needed' });
      }
    } catch (err) {
      log.error('Campaign recovery failed', { error: err.message, stack: err.stack });
    }
  } else {
    log.info('Campaign recovery skipped', { reason: '--skip-recovery flag set' });
  }

 // Connect to MCP servers
   if (mcpConnectionManager) {
     try {
       const connectionResult = await mcpConnectionManager.connectAll();
       if (connectionResult.successful > 0 || connectionResult.failed > 0) {
         log.info('MCP connection batch complete', {
           successful: connectionResult.successful,
           failed: connectionResult.failed,
           skipped: connectionResult.skipped,
         });
       }

       // Distribute discovered tools to agents after successful connections
       if (toolDistributionService && connectionResult.successful > 0) {
         try {
           const distributionResult = await toolDistributionService.distributeToAllAgents();
           const totalTools = Object.values(distributionResult).reduce((sum, r) => sum + (r.count || 0), 0);
           log.info('MCP tools distributed to agents', { totalTools, agentCount: Object.keys(distributionResult).length });
         } catch (distErr) {
           log.error('Tool distribution error', { error: distErr.message });
         }
       }
     } catch (err) {
       log.error('MCP connection error', { error: err.message, stack: err.stack });
     }
   }

  // Load plugins and start server
  try {
    const loaded = await loadPlugins(pluginDir, pluginApi);
    if (loaded.length > 0) log.info('Plugins loaded', { plugins: loaded });
    
    // Start main HTTP/API server
    startServer();

    // Initialize WebSocket Delta Server after HTTP server is ready
    const httpServer = getServer();
    if (httpServer && !websocketDeltaServer) {
      websocketDeltaServer = createWebSocketDeltaServer({
        agents,
        workQueue: turnQueues,
        handoffStore: undefined, // Not yet implemented
        alertStore: alertMonitor,
        circuitBreaker,
        traceStore,
        pubSubChannelService,
        httpServer,
        auth,
        SERVER_START_TIME,
      });
      websocketDeltaServer.start(ws); setUpgradeHandler(websocketDeltaServer.handleUpgrade);
      log.info('WebSocket Delta Server initialized and started');
    }
  } catch (err) {
    log.error('Plugin loading error', { error: err.message });
    
    // Attempt to start server even on plugin failure (if not already started)
    const currentServer = getServer();
    if (!currentServer) {
      startServer();
    }

    // Initialize WebSocket Delta Server even on plugin failure
    const httpServer = getServer();
    if (httpServer && !websocketDeltaServer) {
      websocketDeltaServer = createWebSocketDeltaServer({
        agents,
        workQueue: turnQueues,
        handoffStore: undefined,
        alertStore: alertMonitor,
        circuitBreaker,
        traceStore,
        pubSubChannelService,
        httpServer,
        auth,
        SERVER_START_TIME,
      });
      websocketDeltaServer.start(ws); setUpgradeHandler(websocketDeltaServer.handleUpgrade);
      log.info('WebSocket Delta Server initialized and started (fallback)');
    }
  }
})();

// ─── Graceful Shutdown ───────────────────────────────────────────
const shutdown = createShutdownHandler({
  config, sandbox, rateLimiter, events, thinkingAgents, getWss,
  stopHeartbeat, stopWatchdog, stopStrategist, schedulerLoop, triggerLoop, workflowLoop,
  scoreboard, telemetryStore, performanceStore, operatorAuditStore, alertMonitor, anomalyDetector, slaMonitor,
  cbTransitionStore, crossProjectScanner, approvalTimeoutWatcher, gracefulDegradation,
  stateManager, campaignManager, taskManager, workflowManager, mcpConnectionManager, baseDir: PROJECT_DIR,
  websocketDeltaServer: () => websocketDeltaServer, // Provide getter to access delta server
  closeApiServer,
  closeables: [
    { label: 'scheduled report store', resource: scheduledReportStore },
    { label: 'tool registry', resource: toolRegistry },
    { label: 'dispatch log', resource: sharedDispatchLog },
    { label: 'trace store', resource: traceStore },
    { label: 'timeline store', resource: sqliteTimelineStore },
    { label: 'shared state store', resource: sharedStateStore },
    { label: 'error pattern constraint store', resource: errorPatternConstraintStore },
    { label: 'project state databases', resource: { close: closeStateDbs } },
  ],
});
shutdown.install();

// ─── Module Exports ──────────────────────────────────────────────
export {
  deliberationCoordinator,
  deliberationProtocol,
  sharedStateStore,
  events,
  taskManager,
  campaignManager,
  stateManager,
  agents,
  config,
  PROJECT_DIR,
  SERVER_START_TIME,
  auth,
  rateLimiter,
  credentialVault,
  timelineStore,
  errorRegistry,
  guardrailChain,
  scoreboard,
  performanceStore,
  operatorAuditStore,
  telemetryStore,
  compactionManager,
  agendaManager,
  prefsManager,
  snapshotManager,
  checkpointManager,
  circuitBreaker,
  cbTransitionStore,
  sandbox,
  webhookDispatcher,
  scheduledReportStore,
  toolRegistry,
  mcpConnectionManager,
  toolDistributionService,
  errorPatternDetector,
  errorPatternConstraintStore,
  vaultWriter,
  vaultQuery,
  strategist,
  lifecycle,
  alertMonitor,
  slaMonitor,
  anomalyDetector,
  crossProjectScanner,
  approvalTimeoutWatcher,
  gracefulDegradation,
  shutdown,
  shutdownTracing,
};
