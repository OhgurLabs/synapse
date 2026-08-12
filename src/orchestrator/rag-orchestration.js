import { join } from 'path';
import { appendFileSync } from 'fs';
import { embed, healthCheck as embedHealthCheck, isPaused as embedIsPaused, resetFailures as embedResetFailures } from '../rag/embedding.js';
import { VectorStore, contentHash } from '../rag/store.js';
import { createLogger } from '../logger.js';
import { assertSafeProjectId } from '../safe-id.js';

const log = createLogger('rag');

export function createRAGOrchestration(deps) {
  const { stateManager, config, PROJECT_DIR, learningsManager } = deps;

  const vectorStores = new Map(); // projectId → VectorStore

  /** Get or create a VectorStore for a project. */
  function getVectorStore(projectId) {
    if (vectorStores.has(projectId)) return vectorStores.get(projectId);
    try {
      assertSafeProjectId(projectId);
    } catch {
      return null;
    }
    const projectData = stateManager.getProject(projectId);
    if (!projectData) return null;
    const baseDir = join(PROJECT_DIR, '.synapse', 'projects', projectId);
    const store = new VectorStore(baseDir);
    store.init();
    vectorStores.set(projectId, store);
    return store;
  }

  // --- RAG startup reindex (background, non-blocking) ---
  async function reindexEmbeddings() {
    const healthy = await embedHealthCheck();
    if (!healthy) {
      log.info('Ollama not reachable — skipping startup reindex');
      return;
    }
    embedResetFailures(); // clear any stale failure state from previous session
    const projects = stateManager.listProjects();
    let totalIndexed = 0;
    let totalBackfilled = 0;

    for (const p of projects) {
      const store = getVectorStore(p.id || p);
      if (!store) continue;
      const projectId = p.id || p;

      // V2: Snippet backfill — populate snippets for entries indexed before V2
      const missingSnippets = store.countMissingSnippets();
      if (missingSnippets > 0) {
        log.info('Backfilling missing snippets', { projectId, count: missingSnippets });
        const backfilled = store.backfillSnippets((msgId, project, channel) => {
          const msgs = stateManager.getMessages(project, channel, 10000);
          const msg = msgs.find(m => m.id === msgId);
          return msg?.content || null;
        });
        totalBackfilled += backfilled;
        if (backfilled > 0) log.info('Snippets backfilled', { projectId, count: backfilled });
      }

      // Check alignment — re-embed tail entries where metadata was written but binary wasn't
      const alignment = store.checkAlignment();
      if (!alignment.aligned) {
        const misaligned = store.getMisalignedEntries();
        log.info('Recovering misaligned entries', { projectId, count: misaligned.length });
        for (const entry of misaligned) {
          const meta = store.getMetadata()[entry.index];
          if (!meta) continue;
          const textToEmbed = `[${meta.speaker}]: ${meta.snippet || meta.msgId}`.slice(0, config.embeddings.maxChars);
          const vec = await embed(textToEmbed);
          if (!vec) continue;
          // Write only the binary vector — metadata already exists
          const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
          appendFileSync(store.vectorsPath, buf);
          store._vectorCount++;
          totalIndexed++;
        }
      }

      // Get all channels for this project
      const projectData = stateManager.getProject(projectId);
      const channels = projectData?.channels || ['general'];
      for (const ch of channels) {
        const msgs = stateManager.getMessages(projectId, ch, 10000);
        const toEmbed = msgs.filter(m => {
          if (m.type !== 'message' || !m.content || m.speaker === 'System') return false;
          if (store.has(m.id)) return false;
          // V2: content-hash dedup — skip if identical content already indexed
          const hash = contentHash(`[${m.speaker}]: ${m.content}`);
          if (store.hasContentHash(hash)) return false;
          return true;
        });
        if (toEmbed.length === 0) continue;
        log.info('Reindexing messages', { projectId, channel: ch, count: toEmbed.length });
        let batch = 0;
        for (const m of toEmbed) {
          const textForEmbed = `[${m.speaker}]: ${m.content}`.slice(0, config.embeddings.maxChars);
          const vec = await embed(textForEmbed);
          if (!vec) continue; // skip on failure
          const snippet = m.content.length > 400 ? m.content.slice(0, 400) + '...' : m.content;
          store.add({
            msgId: m.id,
            project: projectId,
            channel: ch,
            threadId: m.threadId || null,
            speaker: m.speaker,
            timestamp: m.timestamp || new Date().toISOString(),
            charLen: m.content.length,
            snippet,
            contentHash: contentHash(textForEmbed),
          }, vec);
          totalIndexed++;
          batch++;
          // Yield every 10 embeds so event loop isn't starved
          if (batch % 10 === 0) await new Promise(r => setImmediate(r));
        }
      }
    }
    // ─── Index learnings into RAG ──────────────────────────────────
    if (learningsManager) {
      let learningsIndexed = 0;
      for (const p of projects) {
        const store = getVectorStore(p.id || p);
        if (!store) continue;
        const projectId = p.id || p;
        const learnings = learningsManager._loadAll(projectId);
        for (const l of learnings) {
          if (store.has(l.id)) continue;
          const textForEmbed = `${l.pattern}. Why: ${l.why}. Correction: ${l.correction}`.slice(0, config.embeddings.maxChars);
          const hash = contentHash(textForEmbed);
          if (store.hasContentHash(hash)) continue;
          const vec = await embed(textForEmbed);
          if (!vec) continue;
          store.add({
            msgId: l.id,
            project: projectId,
            channel: 'learnings',
            speaker: l.source?.agentId || 'system',
            timestamp: l.timestamp,
            charLen: textForEmbed.length,
            snippet: textForEmbed.length > 400 ? textForEmbed.slice(0, 400) + '...' : textForEmbed,
            contentHash: hash,
            source: 'learning',
          }, vec);
          learningsIndexed++;
          totalIndexed++;
          if (learningsIndexed % 10 === 0) await new Promise(r => setImmediate(r));
        }
      }
      if (learningsIndexed > 0) {
        log.info('Learnings indexed into RAG', { count: learningsIndexed });
      }
    }

    if (totalIndexed > 0 || totalBackfilled > 0) {
      log.info('Startup reindex complete', { totalIndexed, totalBackfilled });
    }
  }

  return { getVectorStore, reindexEmbeddings, embedIsPaused };
}
