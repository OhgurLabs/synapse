// Graceful shutdown handler — stub until full implementation lands.
// TODO: implement pre-shutdown snapshots, ordered subsystem teardown

import { shutdownTracing } from '../tracing.js';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';

export function createShutdownHandler(deps = {}) {
  const { sandbox, stopHeartbeat, stopWatchdog, stopStrategist,
          schedulerLoop, triggerLoop, workflowLoop, telemetryStore, alertMonitor, anomalyDetector, performanceStore,
          cbTransitionStore, crossProjectScanner, approvalTimeoutWatcher, stateManager, mcpConnectionManager, baseDir, websocketDeltaServer, monitoringAgent, gracefulDegradation } = deps;

  async function shutdown(signal) {
    console.log(`[shutdown] ${signal} received, cleaning up...`);
    if (alertMonitor) alertMonitor.stop();
    if (anomalyDetector) anomalyDetector.stop();
    if (gracefulDegradation) gracefulDegradation.stop();
    if (crossProjectScanner) crossProjectScanner.stop();
    if (approvalTimeoutWatcher) approvalTimeoutWatcher.stop();
    if (monitoringAgent) {
      await monitoringAgent.flush();
      monitoringAgent.stop();
    }

    // Stop WebSocket Delta Server before other teardown
    const deltaServer = websocketDeltaServer ? (typeof websocketDeltaServer === 'function' ? websocketDeltaServer() : websocketDeltaServer) : null;
    if (deltaServer?.stop) {
      try {
        await deltaServer.stop();
        console.log('[shutdown] WebSocket Delta Server stopped');
      } catch (err) {
        console.error('[shutdown] Delta server stop error:', err.message);
      }
    }

    if (stopHeartbeat) stopHeartbeat();
    if (stopWatchdog) stopWatchdog();
    if (stopStrategist) stopStrategist();
    if (schedulerLoop?.stop) schedulerLoop.stop();
    if (triggerLoop?.stop) triggerLoop.stop();
    if (workflowLoop?.stop) workflowLoop.stop();
    if (telemetryStore?.stopCleanupTimer) telemetryStore.stopCleanupTimer();
    if (performanceStore?.flush) performanceStore.flush();
    if (cbTransitionStore?.close) cbTransitionStore.close();
    if (mcpConnectionManager) {
      try {
        await mcpConnectionManager.disconnectAll();
      } catch (err) {
        console.error('[shutdown] MCP disconnection error:', err.message);
      }
    }
    if (sandbox) await sandbox.killAll('shutdown');
    await shutdownTracing();

    // Write last-shutdown.json for campaign recovery
    if (baseDir || stateManager?.baseDir) {
      const synapseDir = join(baseDir || stateManager.baseDir, '.synapse');
      try {
        mkdirSync(synapseDir, { recursive: true });
        const shutdownPath = join(synapseDir, 'last-shutdown.json');
        writeFileSync(shutdownPath, JSON.stringify({
          shutdownAt: new Date().toISOString(),
          signal
        }, null, 2));
        console.log(`[shutdown] Wrote last-shutdown.json for recovery tracking`);
      } catch (err) {
        console.error(`[shutdown] Failed to write last-shutdown.json:`, err.message);
      }
    }

    process.exit(0);
  }

  return {
    install() {
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    },
  };
}
