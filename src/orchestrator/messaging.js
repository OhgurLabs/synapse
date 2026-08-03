/**
 * Message handling — adds messages to state, broadcasts to WebSocket clients,
 * fires events, and handles background RAG indexing.
 *
 * Extracted from orchestrator.js. Depends on injected services.
 */
import { createLogger } from '../logger.js';
import { contentHash } from '../rag/store.js';

const log = createLogger('messaging');

/**
 * Create the messaging system. Returns addMessage and getSessionMessageCount.
 *
 * @param {Object} deps - Injected dependencies
 * @param {Object}  deps.stateManager       - StateManager instance
 * @param {Function} deps.broadcastToChannel - (projectId, channelId, msg) => void
 * @param {Function} deps.getWss            - () => WebSocketServer | null
 * @param {Function} deps.getClientSubs     - () => WeakMap (ws → { project, channel })
 * @param {Object}  deps.events             - EventBus instance
 * @param {Function} deps.getVectorStore    - (projectId) => VectorStore | null
 * @param {Function} deps.embed             - (text) => Promise<Float32Array | null>
 * @param {Object}  deps.config             - Config object (needs embeddings.maxChars)
 */
export function createMessagingSystem(deps) {
  const { stateManager, broadcastToChannel, getWss, getClientSubs, events, getVectorStore, embed, config } = deps;

  let sessionMessageCount = 0;

   function addMessage(projectId, channelId, speaker, content, type = 'message', meta = {}) {
     sessionMessageCount++;
     const msg = stateManager.addMessage(projectId, channelId, {
       type, speaker, content, model: meta.model,
       threadId: meta.threadId, replyTo: meta.replyTo,
       fallback: meta.fallback, fallbackFrom: meta.fallbackFrom,
       userId: meta.userId || 'default',
     });
     broadcastToChannel(projectId, channelId, msg);

    // Send unread notification to clients NOT on this channel
    if (type === 'message' && speaker !== 'System') {
      const wss = getWss();
      const clientSubs = getClientSubs();
      if (wss) {
        for (const client of wss.clients) {
          if (client.readyState !== 1) continue;
          const sub = clientSubs.get(client);
          if (!sub || sub.project !== projectId || sub.channel !== channelId) {
            client.send(JSON.stringify({
              type: 'unread', project: projectId, channel: channelId,
            }));
          }
        }
      }
    }

    // Fire event (non-blocking)
    events.emit('message', { ...msg, projectId, channelId }).catch(() => {});

    // Background RAG indexing — fire-and-forget, never blocks
    if (type === 'message' && content && speaker !== 'System') {
      const store = getVectorStore(projectId);
      if (store && !store.has(msg.id)) {
        const textForEmbed = `[${speaker}]: ${content}`.slice(0, config.embeddings.maxChars);
        const hash = contentHash(textForEmbed);
        // V2: content-hash dedup — skip if identical content already indexed
        if (!store.hasContentHash(hash)) {
          embed(textForEmbed).then(vec => {
            if (!vec) return; // embedding failed or queue paused
            const snippet = content.length > 400 ? content.slice(0, 400) + '...' : content;
            store.add({
              msgId: msg.id,
              project: projectId,
              channel: channelId,
              threadId: meta.threadId || null,
              speaker,
              timestamp: msg.timestamp || new Date().toISOString(),
              charLen: content.length,
              snippet,
              contentHash: hash,
            }, vec);
          }).catch(err => log.error('Background RAG index failed', { error: err.message }));
        }
      }
    }

    return msg;
  }

  function getSessionMessageCount() {
    return sessionMessageCount;
  }

  return { addMessage, getSessionMessageCount };
}
