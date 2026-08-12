/**
 * WebSocket Delta Server
 *
 * Provides real-time state updates to dashboard clients via WebSocket and
 * Server-Sent Events (SSE) fallback. Emits state deltas (not full snapshots)
 * every 1-2 seconds to minimize bandwidth.
 *
 * Features:
 * - WebSocket connection at /api/dashboard/stream
 * - SSE fallback at /api/dashboard/events
 * - Delta computation (only changed fields)
 * - Client connection lifecycle management
 * - Graceful error handling and reconnection support
 */

import { aggregateDashboardState, computeStateDelta, hasChanges } from './dashboard-state-aggregator.js';
import { createLogger } from '../logger.js';

const log = createLogger('websocket-delta-server');

const DELAY_INTERVAL_MS = 1500; // Emit deltas every 1.5 seconds
const HEARTBEAT_INTERVAL_MS = 30000; // Send heartbeat every 30 seconds

/**
 * Create a WebSocket delta server
 *
 * @param {Object} deps - Dependencies object
 * @param {Object} deps.agents - Agent registry
 * @param {Object} deps.workQueue - Work queue instance
 * @param {Object} deps.handoffStore - Handoff store instance
 * @param {Object} deps.alertStore - Alert store instance
 * @param {Object} deps.circuitBreaker - Circuit breaker instance
 * @param {Object} deps.traceStore - Trace store instance (optional)
 * @param {Object} deps.pubSubChannelService - PubSub channel service instance (optional)
 * @param {http.Server} deps.httpServer - Existing HTTP server instance
 * @param {Object} options - Server options
 * @param {number} options.delayIntervalMs - Interval between delta emissions
 * @param {number} options.maxClients - Maximum concurrent clients
 * @returns {Object} WebSocket server instance with methods
 */
export function createWebSocketDeltaServer(deps, options = {}) {
  const {
    agents,
    workQueue,
    handoffStore,
    alertStore,
    circuitBreaker,
    traceStore,
    pubSubChannelService,
    httpServer,
    auth,
  } = deps;

  const {
    delayIntervalMs = DELAY_INTERVAL_MS,
    maxClients = 1000,
  } = options;

  // Client connections set
  const clients = new Set();

  // Previous snapshot for delta computation
  let previousSnapshot = null;

  // Timer for emitting deltas
  let emitTimer = null;

  // Underlying ws.Server instance so stop() can fully detach it
  let wss = null;

  // The 'upgrade' listener function (to allow removal in stop())
  let onUpgrade = null;

  // Track heartbeat timers per client
  const clientHeartbeatTimers = new Map();

  // Track whether clients have received their initial snapshot
  const clientInitialSent = new Map();

  // Rolling buffer for trace timestamps - only fetch traces newer than this
  let lastTraceTimestamp = null;

  /**
   * Compute and emit state deltas to all connected clients
   */
  function emitDeltas() {
    try {
      const currentSnapshot = aggregateDashboardState({
        agents,
        workQueue,
        handoffStore,
        alertStore,
        circuitBreaker,
        traceStore,
        pubSubChannelService,
      }, {
        traceOptions: {
          sinceISO: lastTraceTimestamp,
        },
      });

      // Update rolling buffer timestamp with the most recent span
      if (currentSnapshot.traces && currentSnapshot.traces.length > 0) {
        const mostRecentSpan = currentSnapshot.traces.reduce((latest, span) => {
          if (!latest || (span.startedAt && span.startedAt > latest.startedAt)) {
            return span;
          }
          return latest;
        }, null);

        if (mostRecentSpan && mostRecentSpan.startedAt) {
          lastTraceTimestamp = mostRecentSpan.startedAt;
        }
      }

      const delta = computeStateDelta(previousSnapshot, currentSnapshot);
      previousSnapshot = currentSnapshot;

      // Only emit if there are changes or force heartbeat
      const hasAnyChanges = hasChanges(delta);

      for (const client of clients) {
        if (client.readyState === 1 && clientInitialSent.get(client)) {
          try {
            const payload = {
              type: 'delta',
              timestamp: delta.timestamp,
              ...delta,
            };

            if (client.type === 'sse') {
              client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
            } else {
              client.send(JSON.stringify(payload));
            }
          } catch (error) {
            console.warn('Failed to send delta to client:', error.message);
          }
        }
      }

      if (!hasAnyChanges) {
        for (const client of clients) {
          if (client.readyState === 1 && clientInitialSent.get(client)) {
            try {
              if (client.type === 'sse') {
                client.res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
              } else {
                client.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
              }
            } catch (error) {
              // Ignore heartbeat failures
            }
          }
        }
      }
    } catch (error) {
      console.error('Error emitting deltas:', error);
    }
  }

  /**
   * Start the delta emission timer
   */
  function startEmitTimer() {
    if (emitTimer) {
      clearInterval(emitTimer);
    }

    // Emit immediately on start
    emitDeltas();

    // Then emit at regular intervals
    emitTimer = setInterval(emitDeltas, delayIntervalMs);
  }

  /**
   * Stop the delta emission timer
   */
  function stopEmitTimer() {
    if (emitTimer) {
      clearInterval(emitTimer);
      emitTimer = null;
    }
  }

  /**
   * Clean up a client connection
   *
   * @param {WebSocket} client - WebSocket client to remove
   */
  function cleanupClient(client) {
    clients.delete(client);

    const heartbeatTimer = clientHeartbeatTimers.get(client);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      clientHeartbeatTimers.delete(client);
    }

    clientInitialSent.delete(client);

    if (typeof client.removeAllListeners === 'function') {
      client.removeAllListeners('close');
      client.removeAllListeners('error');
      client.removeAllListeners('message');
    }
  }

  /**
   * Handle WebSocket upgrade request
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {net.Socket} socket - Upgrade socket
   * @param {Buffer} head - First packet of body
   */
  function handleUpgrade(req, socket, head) {
    if (!onUpgrade) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    return onUpgrade(req, socket, head);
  }

  /**
   * Create SSE response for a client
   *
   * @param {http.IncomingMessage} req - HTTP request
   * @param {http.ServerResponse} res - HTTP response
   */
  function handleSSE(req, res) {
    if (!req.url || !req.url.startsWith('/api/dashboard/events')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const clientId = `sse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const sseClient = { id: clientId, type: 'sse', res, readyState: 1 };
    clients.add(sseClient);

    log.debug('SSE client connected', { clientId, totalClients: clients.size });

    const cleanup = () => {
      log.debug('SSE client disconnected', { clientId, totalClients: clients.size });
      cleanupClient(sseClient);
    };

    res.on('close', cleanup);
    res.on('error', cleanup);

    try {
      // Initial snapshot for SSE clients should include all recent traces (no rolling buffer filter)
      const snapshot = aggregateDashboardState({
        agents,
        workQueue,
        handoffStore,
        alertStore,
        circuitBreaker,
        traceStore,
        pubSubChannelService,
      }, {
        traceOptions: {
          sinceISO: null,
        },
      });

      const delta = {
        timestamp: snapshot.timestamp,
        agents: {
          updated: snapshot.agents.map(a => ({ id: a.id, ...a })),
          added: [],
          removed: [],
        },
        queues: {
          updated: snapshot.queues.map(q => ({ agent_id: q.agent_id, ...q })),
          added: [],
          removed: [],
        },
        handoffs: {
          updated: snapshot.handoffs.map(h => ({ handoffId: h.handoffId, ...h })),
          added: [],
          removed: [],
        },
        channels: {
          updated: snapshot.channels.map(c => ({ channelName: c.channelName, ...c })),
          added: [],
          removed: [],
        },
        alerts: {
          added: snapshot.alerts,
        },
        traces: {
          added: snapshot.traces,
        },
      };

      const payload = JSON.stringify({
        type: 'initial',
        ...delta,
      });

      res.write(`data: ${payload}\n\n`);
      clientInitialSent.set(sseClient, true);
    } catch (error) {
      console.error('Error sending initial SSE snapshot:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    }

    // Set up heartbeat for SSE client
    const heartbeatTimer = setInterval(() => {
      try {
        res.write(`:\n\n`); // SSE comment for heartbeat
      } catch (error) {
        // Ignore heartbeat failures
      }
    }, HEARTBEAT_INTERVAL_MS);

    clientHeartbeatTimers.set(sseClient, heartbeatTimer);
  }

  /**
   * Inject ws library and start server
   *
   * @param {Object} wsModule - ws module (for testing)
   */
  function start(wsModule) {
    if (!wsModule) {
      console.error('WebSocket server requires ws module');
      return;
    }

    if (wss) {
      throw new Error('WebSocket server already started');
    }

    const WebSocketServer = wsModule.WebSocketServer || wsModule.Server || wsModule.default?.WebSocketServer;

    // Create WebSocket server with noServer: true to avoid conflict with main WebSocket server
    wss = new WebSocketServer({ noServer: true });

    // Store the upgrade listener for later removal
    onUpgrade = (req, socket, head) => {
      const url = new URL(req.url || '', 'http://localhost');
      if (url.pathname !== '/api/dashboard/stream') {
        return; // Let main WebSocket server handle other paths
      }

      const authResult = auth?.checkUpgrade?.(req) || { authenticated: false };
      if (!authResult.authenticated || !authResult.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      req.userId = authResult.userId;

      // Enforcement of max clients
      if (clients.size >= maxClients) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      if (wss) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (wss) wss.emit('connection', ws, req);
        });
      }
    };

    // Register upgrade handler for delta server
    // httpServer.on('upgrade', onUpgrade);

    wss.on('connection', (ws, req) => {
      const clientId = `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      clients.add(ws);

      log.debug('WebSocket delta client connected', { clientId, clientCount: clients.size });

      try {
        // Initial snapshot for WebSocket clients should include all recent traces (no rolling buffer filter)
        const snapshot = aggregateDashboardState({
          agents,
          workQueue,
          handoffStore,
          alertStore,
          circuitBreaker,
          traceStore,
          pubSubChannelService,
        }, {
          traceOptions: {
            sinceISO: null,
          },
        });

        // Build initial delta explicitly to match SSE format — computeStateDelta(null, snapshot)
        // returns the raw snapshot which has flat arrays instead of {added: []} structure.
        const delta = {
          timestamp: snapshot.timestamp,
          agents: {
            updated: (snapshot.agents || []).map(a => ({ id: a.id, ...a })),
            added: [],
            removed: [],
          },
          queues: {
            updated: (snapshot.queues || []).map(q => ({ agent_id: q.agent_id, ...q })),
            added: [],
            removed: [],
          },
          handoffs: {
            updated: (snapshot.handoffs || []).map(h => ({ handoffId: h.handoffId, ...h })),
            added: [],
            removed: [],
          },
          channels: {
            updated: (snapshot.channels || []).map(c => ({ channelName: c.channelName, ...c })),
            added: [],
            removed: [],
          },
          alerts: {
            added: snapshot.alerts || [],
          },
          traces: {
            added: snapshot.traces || [],
          },
        };

        const payload = {
          type: 'initial',
          ...delta,
        };

        ws.send(JSON.stringify(payload));
        clientInitialSent.set(ws, true);
      } catch (error) {
        console.error('Error sending initial WebSocket snapshot:', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: error.message,
        }));
      }

      // Handle incoming messages (ping/pong, client commands)
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          } else if (message.type === 'subscribe' || message.type === 'unsubscribe') {
            // Future: support selective subscription to event types
            ws.send(JSON.stringify({
              type: 'subscription_ack',
              subscribed: message.type === 'subscribe',
            }));
          }
        } catch (error) {
          // Ignore parse errors
        }
      });

      // Handle close
      ws.on('close', () => {
        log.debug('WebSocket client disconnected', { clientId, totalClients: clients.size });
        cleanupClient(ws);
      });

      // Handle error
      ws.on('error', (error) => {
        console.error(`WebSocket client error (${clientId}):`, error.message);
        // Don't remove client on error - let close handler do it
      });
    });

    wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });

    log.info('WebSocket delta server listening', { path: '/api/dashboard/stream' });

    // Start emitting deltas to all connected clients
    startEmitTimer();
  }

  /**
   * Get current client count
   *
   * @returns {number} Number of connected clients
   */
  function getClientCount() {
    return clients.size;
  }

  /**
   * Broadcast a manual delta (e.g., from operator action)
   *
   * @param {Object} delta - Delta object to broadcast
   */
  function broadcastDelta(delta) {
    const payload = {
      type: 'manual',
      timestamp: new Date().toISOString(),
      ...delta,
    };

    for (const client of clients) {
      if (client.readyState === 1) {
        try {
          client.send(JSON.stringify(payload));
        } catch (error) {
          // Ignore send failures
        }
      }
    }
  }

  /**
   * Stop the server
   */
  async function stop() {
    stopEmitTimer();

    // Remove the upgrade listener to avoid leaks on restart
    if (onUpgrade && httpServer) {
      httpServer.removeListener('upgrade', onUpgrade);
      onUpgrade = null;
    }

    // Close all clients
    for (const client of [...clients]) {
      try {
        if (client.type === 'sse' && client.res) {
          client.res.end();
          cleanupClient(client);
        } else if (typeof client.terminate === 'function') {
          client.terminate();
        } else if (client.readyState === 1 && typeof client.close === 'function') {
          client.close();
        }
      } catch (error) {
        // Ignore
      }
    }
    clients.clear();

    const serverToClose = wss;
    wss = null;

    if (serverToClose) {
      for (const client of serverToClose.clients) {
        try {
          client.terminate();
        } catch (error) {
          // Ignore
        }
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        serverToClose.close(finish);

        const timeout = setTimeout(finish, 500);
        if (typeof timeout.unref === 'function') {
          timeout.unref();
        }
      });
    }

    log.info('WebSocket delta server stopped');
  }

  return {
    start,
    stop,
    getClientCount,
    broadcastDelta,
    handleSSE,
    handleUpgrade,
  };
}

export default createWebSocketDeltaServer;
