import { shutdownTracing as defaultShutdownTracing } from '../tracing.js';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the orchestrator's ordered, idempotent shutdown sequence.
 *
 * Dependencies are injected so the sequence can be exercised without sending
 * a real process signal or terminating the test process.
 */
export function createShutdownHandler(deps = {}) {
  const {
    sandbox,
    stopHeartbeat,
    stopWatchdog,
    stopStrategist,
    schedulerLoop,
    triggerLoop,
    workflowLoop,
    telemetryStore,
    alertMonitor,
    anomalyDetector,
    performanceStore,
    cbTransitionStore,
    crossProjectScanner,
    approvalTimeoutWatcher,
    stateManager,
    mcpConnectionManager,
    baseDir,
    websocketDeltaServer,
    monitoringAgent,
    gracefulDegradation,
    getWss,
    closeApiServer,
    closeables = [],
    exit = code => process.exit(code),
    shutdownTracing = defaultShutdownTracing,
  } = deps;

  let shutdownPromise = null;
  let installed = false;

  async function runStep(label, operation) {
    if (typeof operation !== 'function') return;
    try {
      await operation();
    } catch (err) {
      console.error(`[shutdown] ${label} failed:`, errorMessage(err));
    }
  }

  async function closeWebSocketServer() {
    const server = typeof getWss === 'function' ? getWss() : null;
    if (!server) return;

    for (const client of server.clients || []) {
      try {
        if (typeof client.terminate === 'function') client.terminate();
        else if (typeof client.close === 'function') client.close(1001, 'Server shutting down');
      } catch {
        // A client may disappear between iteration and close. Continue closing
        // the server so one stale socket cannot block the whole shutdown.
      }
    }

    if (typeof server.close !== 'function') return;
    await new Promise((resolve, reject) => {
      try {
        server.close(err => err ? reject(err) : resolve());
      } catch (err) {
        reject(err);
      }
    });
  }

  async function performShutdown(signal) {
    console.log(`[shutdown] ${signal} received, cleaning up...`);

    // Stop accepting or scheduling new work before draining active resources.
    await runStep('alert monitor stop', () => alertMonitor?.stop?.());
    await runStep('anomaly detector stop', () => anomalyDetector?.stop?.());
    await runStep('graceful degradation stop', () => gracefulDegradation?.stop?.());
    await runStep('cross-project scanner stop', () => crossProjectScanner?.stop?.());
    await runStep('approval timeout watcher stop', () => approvalTimeoutWatcher?.stop?.());
    await runStep('heartbeat stop', stopHeartbeat);
    await runStep('watchdog stop', stopWatchdog);
    await runStep('strategist stop', stopStrategist);
    await runStep('scheduler loop stop', () => schedulerLoop?.stop?.());
    await runStep('trigger loop stop', () => triggerLoop?.stop?.());
    await runStep('workflow loop stop', () => workflowLoop?.stop?.());

    const deltaServer = websocketDeltaServer
      ? (typeof websocketDeltaServer === 'function' ? websocketDeltaServer() : websocketDeltaServer)
      : null;
    await runStep('WebSocket delta server stop', () => deltaServer?.stop?.());
    await runStep('WebSocket server close', closeWebSocketServer);
    await runStep('API server close', closeApiServer);

    // Flush buffered data while its backing stores are still open.
    await runStep('monitoring agent flush', () => monitoringAgent?.flush?.());
    await runStep('monitoring agent stop', () => monitoringAgent?.stop?.());
    await runStep('telemetry cleanup timer stop', () => telemetryStore?.stopCleanupTimer?.());
    await runStep('performance store flush', () => performanceStore?.flush?.());
    await runStep('MCP disconnection', () => mcpConnectionManager?.disconnectAll?.());
    await runStep('sandbox process cleanup', () => sandbox?.killAll?.('shutdown'));

    await runStep('circuit-breaker transition store close', () => cbTransitionStore?.close?.());
    for (const entry of closeables) {
      const label = entry?.label || entry?.name || 'resource';
      const resource = entry?.resource || entry;
      await runStep(`${label} close`, () => resource?.close?.());
    }

    await runStep('tracing shutdown', shutdownTracing);

    const rootDir = baseDir || stateManager?.baseDir;
    if (rootDir) {
      await runStep('recovery marker write', () => {
        const synapseDir = join(rootDir, '.synapse');
        mkdirSync(synapseDir, { recursive: true });
        writeFileSync(join(synapseDir, 'last-shutdown.json'), JSON.stringify({
          shutdownAt: new Date().toISOString(),
          signal,
        }, null, 2));
      });
    }

    exit(0);
  }

  function shutdown(signal = 'manual') {
    if (!shutdownPromise) shutdownPromise = performShutdown(signal);
    return shutdownPromise;
  }

  const onSigterm = () => { void shutdown('SIGTERM'); };
  const onSigint = () => { void shutdown('SIGINT'); };

  return {
    shutdown,
    install() {
      if (installed) return;
      installed = true;
      process.on('SIGTERM', onSigterm);
      process.on('SIGINT', onSigint);
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    },
  };
}
