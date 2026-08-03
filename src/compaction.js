import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import config from './config.js';

// Pull compaction settings from centralized config
const CONTEXT_LIMITS = config.compaction.contextLimits;
const COMPACTION_THRESHOLD = config.compaction.threshold;
const RECENT_MESSAGES_KEEP = config.compaction.recentMessagesKeep;
const SUMMARY_MAX_CHARS = config.compaction.summaryMaxChars;

export class CompactionManager {
  constructor(stateManager) {
    this.stateManager = stateManager;
  }

  /**
   * Check if compaction is needed for an agent in a channel (or thread).
   * When threadId is provided, checks per-thread context size.
   * Returns true if the context would exceed the threshold.
   */
  needsCompaction(agentName, projectId, channelId, threadId = null) {
    const limit = CONTEXT_LIMITS[agentName.toLowerCase()] || CONTEXT_LIMITS.claude;
    const threshold = limit * COMPACTION_THRESHOLD;

    const messages = threadId
      ? this.stateManager.getThreadMessages(projectId, channelId, threadId, 200)
      : this.stateManager.getMessages(projectId, channelId, 200);
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);

    return totalChars > threshold;
  }

  /**
   * Get the compaction file path for an agent in a project.
   * When threadId is provided, stores per-thread: compactions/{agent}-{threadSlug}.md
   * Otherwise falls back to per-channel: compactions/{agent}.md
   */
  _compactionPath(projectId, agentName, threadId = null) {
    const dir = join(this.stateManager.projectsDir, projectId, 'compactions');
    mkdirSync(dir, { recursive: true });
    if (threadId) {
      const slug = threadId.replace(/^thread_\d+_/, '').replace(/[^a-z0-9-]/g, '').slice(0, 40);
      return join(dir, `${agentName.toLowerCase()}-${slug}.md`);
    }
    return join(dir, `${agentName.toLowerCase()}.md`);
  }

  /**
   * Load existing compaction summary for an agent (optionally per-thread).
   */
  getExistingSummary(projectId, agentName, threadId = null) {
    const path = this._compactionPath(projectId, agentName, threadId);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  /**
   * Save compaction summary for an agent (optionally per-thread).
   */
  saveSummary(projectId, agentName, summary, threadId = null) {
    const path = this._compactionPath(projectId, agentName, threadId);
    writeFileSync(path, summary);
  }

  /**
   * Build the compaction prompt — asks an agent to summarize older messages.
   * When threadId is provided, compacts per-thread.
   * Returns a prompt string that the orchestrator sends to the agent.
   */
  buildCompactionPrompt(agentName, projectId, channelId, threadId = null) {
    const messages = threadId
      ? this.stateManager.getThreadMessages(projectId, channelId, threadId, 200)
      : this.stateManager.getMessages(projectId, channelId, 200);

    if (messages.length <= RECENT_MESSAGES_KEEP) {
      return null; // not enough messages to compact
    }

    const olderMessages = messages.slice(0, -RECENT_MESSAGES_KEEP);
    const existingSummary = this.getExistingSummary(projectId, agentName, threadId);

    const olderText = olderMessages
      .filter(m => m.type === 'message' && m.content)
      .map(m => `[${m.speaker}]: ${m.content}`)
      .join('\n');

    const threadContext = threadId ? ` (thread: ${threadId})` : '';
    let prompt = `You are performing context compaction for the ${agentName} agent working on project "${projectId}" in channel #${channelId}${threadContext}.

Summarize the following conversation into a structured summary. Be thorough but concise. Preserve all decisions, technical details, file paths, and action items.

Format your summary EXACTLY like this:

## Goal
What the team is trying to accomplish.

## Decisions Made
- Decision 1 (who proposed, who agreed)
- Decision 2 ...

## Progress
- What has been done so far
- Key findings or results

## Key Technical Details
- File paths, commands, configurations mentioned
- Architecture decisions, patterns used

## Open Questions / Blockers
- Anything unresolved

## Next Steps
- What needs to happen next
- Who is responsible for what

---

CONVERSATION TO SUMMARIZE:
${olderText}
`;

    if (existingSummary) {
      prompt += `
---

PREVIOUS COMPACTION (merge new information into this):
${existingSummary}
`;
    }

    prompt += `
---

Write the updated structured summary now. Keep it under ${SUMMARY_MAX_CHARS} characters.`;

    return prompt;
  }

  /**
   * Build context for an agent, using compacted summary + recent messages.
   * When threadId is provided, uses per-thread compaction and messages.
   * This replaces the raw message history when compaction has occurred.
   */
  buildCompactedContext(agentName, projectId, channelId, threadId = null) {
    const summary = this.getExistingSummary(projectId, agentName, threadId);
    if (!summary) return null; // no compaction yet, use normal context

    const recent = threadId
      ? this.stateManager.getThreadMessages(projectId, channelId, threadId, RECENT_MESSAGES_KEEP)
      : this.stateManager.getMessages(projectId, channelId, RECENT_MESSAGES_KEEP);
    const lines = [];

    const threadLabel = threadId ? ` (thread: ${threadId.replace(/^thread_\d+_/, '').replace(/-/g, ' ')})` : '';
    lines.push(`=== COMPACTED CONTEXT${threadLabel} ===`);
    lines.push(summary);
    lines.push('=== END COMPACTED CONTEXT ===\n');
    lines.push('=== RECENT MESSAGES ===');
    for (const m of recent) {
      if (m.type === 'message' && m.content) {
        lines.push(`[${m.speaker}]: ${m.content}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get thread summaries for session end context generation.
   * Returns an array of { threadId, label, status, participants, summary } objects.
   */
  getThreadSummaries(projectId, channelId) {
    const threads = this.stateManager.getActiveThreads(projectId, channelId);
    // Also include recently closed threads
    const allThreadData = this.stateManager.loadThreads(projectId);
    const channelThreads = Object.values(allThreadData.threads).filter(t => t.channel === channelId);

    return channelThreads.map(t => {
      const msgs = this.stateManager.getThreadMessages(projectId, channelId, t.id, 9999);
      const msgText = msgs
        .filter(m => m.type === 'message' && m.content)
        .map(m => `[${m.speaker}]: ${m.content.slice(0, 200)}`)
        .join('\n');
      return {
        threadId: t.id,
        label: t.label || t.id.replace(/^thread_\d+_/, '').replace(/-/g, ' '),
        status: t.status,
        participants: t.participants || [],
        messageCount: msgs.length,
        preview: msgText.slice(0, 2000),
      };
    });
  }
}

export { RECENT_MESSAGES_KEEP, COMPACTION_THRESHOLD, CONTEXT_LIMITS };
