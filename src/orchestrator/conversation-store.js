import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';
import { createDatabaseWithRecovery } from './db-recovery.js';

const log = createLogger('conversation-store');

/**
 * ConversationStore — SQLite persistence layer for agent conversations.
 *
 * Enables structured conversations with mention tracking, participant management,
 * and message threading. Supports the pull-model pattern where agents poll for
 * unacknowledged mentions.
 *
 * Schema ownership is inline: _initTables() initializes new and existing databases.
 *
 * Tables:
 *   - conversations: Top-level conversation metadata
 *   - conversation_messages: Individual messages in conversations
 *   - conversation_mentions: @mentions of agents within messages
 *   - conversation_participants: Agents participating in conversations
 *   - conversation_resolver_states: Terminal resolver outcome and transition history
 */
export class ConversationStore {
  /**
   * @param {Object} options
   * @param {string} options.dbPath - Path to SQLite database file
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new TypeError('dbPath option is required');
    }

    this.dbPath = options.dbPath;
    this._emitter = new EventEmitter();

    this._ensureParentDir();

    // Use recovery-aware database creation
    this.db = createDatabaseWithRecovery(this.dbPath, {
      emitter: this._emitter,
      enableRecovery: true,
    });

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this._initTables();
    this._prepareStatements();
  }

  _ensureParentDir() {
    const dir = dirname(this.dbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  _initTables() {
    // ConversationStore owns this idempotent inline schema; no external SQL migration is used.
    this.db.exec(`
      BEGIN;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        project_id TEXT,
        title TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_channel_id ON conversations(channel_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON conversations(project_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        message_type TEXT NOT NULL,
        thread_id TEXT,
        reply_to TEXT,
        created_at TEXT NOT NULL,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_created ON conversation_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_sender ON conversation_messages(sender_agent_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread ON conversation_messages(thread_id);

      CREATE TABLE IF NOT EXISTS conversation_mentions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        mentioned_agent_id TEXT NOT NULL,
        mention_type TEXT NOT NULL,
        acknowledged_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_mentions_agent_ack ON conversation_mentions(mentioned_agent_id, acknowledged_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_mentions_message ON conversation_mentions(message_id);

      CREATE TABLE IF NOT EXISTS conversation_participants (
        conversation_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_participants_agent ON conversation_participants(agent_id);

      CREATE TABLE IF NOT EXISTS conversation_resolver_states (
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL,
        previous_state TEXT,
        outcome TEXT NOT NULL,
        history TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_resolver_states_state
        ON conversation_resolver_states(state);

      COMMIT;
    `);
  }

  _prepareStatements() {
    // Conversation statements
    this._stmtCreateConversation = this.db.prepare(`
      INSERT INTO conversations (id, channel_id, project_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this._stmtGetConversation = this.db.prepare(`
      SELECT id, channel_id, project_id, title, status, created_at, updated_at
      FROM conversations
      WHERE id = ?
    `);

    this._stmtUpdateConversation = this.db.prepare(`
      UPDATE conversations
      SET status = ?, updated_at = ?
      WHERE id = ?
    `);

    this._stmtListConversations = this.db.prepare(`
      SELECT id, channel_id, project_id, title, status, created_at, updated_at
      FROM conversations
      WHERE (? IS NULL OR channel_id = ?)
        AND (? IS NULL OR project_id = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `);

    this._stmtListConversationsByParticipant = this.db.prepare(`
      SELECT DISTINCT c.id, c.channel_id, c.project_id, c.title, c.status, c.created_at, c.updated_at
      FROM conversations c
      JOIN conversation_participants p ON c.id = p.conversation_id
      WHERE p.agent_id = ?
        AND (? IS NULL OR c.channel_id = ?)
        AND (? IS NULL OR c.project_id = ?)
        AND (? IS NULL OR c.status = ?)
      ORDER BY c.updated_at DESC
      LIMIT ? OFFSET ?
    `);

    // Message statements
    this._stmtAddMessage = this.db.prepare(`
      INSERT INTO conversation_messages (id, conversation_id, sender_agent_id, content, message_type, thread_id, reply_to, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._stmtGetMessage = this.db.prepare(`
      SELECT id, conversation_id, sender_agent_id, content, message_type, thread_id, reply_to, created_at, metadata
      FROM conversation_messages
      WHERE id = ?
    `);

    this._stmtGetConversationHistory = this.db.prepare(`
      SELECT id, conversation_id, sender_agent_id, content, message_type, thread_id, reply_to, created_at, metadata
      FROM conversation_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);

    this._stmtGetConversationHistorySince = this.db.prepare(`
      SELECT id, conversation_id, sender_agent_id, content, message_type, thread_id, reply_to, created_at, metadata
      FROM conversation_messages
      WHERE conversation_id = ? AND created_at > ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);

    this._stmtGetThreadMessages = this.db.prepare(`
      SELECT id, conversation_id, sender_agent_id, content, message_type, thread_id, reply_to, created_at, metadata
      FROM conversation_messages
      WHERE conversation_id = ? AND thread_id = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);

    this._stmtGetThreadMessagesSince = this.db.prepare(`
      SELECT id, conversation_id, sender_agent_id, content, message_type, thread_id, reply_to, created_at, metadata
      FROM conversation_messages
      WHERE conversation_id = ? AND thread_id = ? AND created_at > ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `);

    // Mention statements
    this._stmtAddMention = this.db.prepare(`
      INSERT INTO conversation_mentions (id, message_id, mentioned_agent_id, mention_type, acknowledged_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this._stmtGetMention = this.db.prepare(`
      SELECT id, message_id, mentioned_agent_id, mention_type, acknowledged_at
      FROM conversation_mentions
      WHERE id = ?
    `);

    this._stmtGetMentionsForAgent = this.db.prepare(`
      SELECT m.id, m.message_id, m.mentioned_agent_id, m.mention_type, m.acknowledged_at,
             msg.conversation_id, msg.sender_agent_id, msg.content, msg.created_at
      FROM conversation_mentions m
      JOIN conversation_messages msg ON m.message_id = msg.id
      WHERE m.mentioned_agent_id = ?
        AND m.acknowledged_at IS NULL
      ORDER BY msg.created_at ASC
    `);

    this._stmtGetMentionsForAgentInProject = this.db.prepare(`
      SELECT m.id, m.message_id, m.mentioned_agent_id, m.mention_type, m.acknowledged_at,
             msg.conversation_id, msg.sender_agent_id, msg.content, msg.created_at
      FROM conversation_mentions m
      JOIN conversation_messages msg ON m.message_id = msg.id
      JOIN conversations c ON msg.conversation_id = c.id
      WHERE m.mentioned_agent_id = ?
        AND c.project_id = ?
        AND m.acknowledged_at IS NULL
      ORDER BY msg.created_at ASC
    `);

    this._stmtAcknowledgeMention = this.db.prepare(`
      UPDATE conversation_mentions
      SET acknowledged_at = ?
      WHERE id = ?
    `);

    // Participant statements
    this._stmtAddParticipant = this.db.prepare(`
      INSERT OR IGNORE INTO conversation_participants (conversation_id, agent_id, role, joined_at)
      VALUES (?, ?, ?, ?)
    `);

    this._stmtGetParticipants = this.db.prepare(`
      SELECT conversation_id, agent_id, role, joined_at
      FROM conversation_participants
      WHERE conversation_id = ?
      ORDER BY joined_at ASC
    `);

    // Resolver state statements
    this._stmtGetResolverState = this.db.prepare(`
      SELECT state, previous_state, outcome, history, updated_at
      FROM conversation_resolver_states
      WHERE project_id = ? AND thread_id = ?
    `);

    this._stmtSetResolverState = this.db.prepare(`
      INSERT INTO conversation_resolver_states (
        project_id, thread_id, state, previous_state, outcome, history, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, thread_id) DO UPDATE SET
        state = excluded.state,
        previous_state = excluded.previous_state,
        outcome = excluded.outcome,
        history = excluded.history,
        updated_at = excluded.updated_at
    `);

    // Summary statistics statements
    this._stmtGetMessageCount = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM conversation_messages
      WHERE conversation_id = ?
    `);

    this._stmtGetUnresolvedMentionCount = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM conversation_mentions m
      JOIN conversation_messages msg ON m.message_id = msg.id
      WHERE msg.conversation_id = ?
        AND m.acknowledged_at IS NULL
    `);

    this._stmtGetLastActivityTimestamp = this.db.prepare(`
      SELECT MAX(created_at) as last_activity
      FROM conversation_messages
      WHERE conversation_id = ?
    `);
  }

  // ── helpers ──────────────────────────────────────────────────────

  _now() {
    return new Date().toISOString();
  }

  _parseMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderAgentId: row.sender_agent_id,
      content: row.content,
      messageType: row.message_type,
      threadId: row.thread_id,
      replyTo: row.reply_to,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    };
  }

  _parseConversation(row) {
    if (!row) return null;
    return {
      id: row.id,
      channelId: row.channel_id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _parseMention(row) {
    if (!row) return null;
    return {
      id: row.id,
      messageId: row.message_id,
      mentionedAgentId: row.mentioned_agent_id,
      mentionType: row.mention_type,
      acknowledgedAt: row.acknowledged_at,
      conversationId: row.conversation_id,
      senderAgentId: row.sender_agent_id,
      content: row.content,
      messageCreatedAt: row.created_at,
    };
  }

  _parseParticipant(row) {
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      role: row.role,
      joinedAt: row.joined_at,
    };
  }

  // ── public API ───────────────────────────────────────────────────

  /**
   * Get a conversation by ID.
   *
   * @param {string} conversationId - Conversation ID
   * @returns {Object|null} Conversation object or null if not found
   */
  getConversation(conversationId) {
    const row = this._stmtGetConversation.get(conversationId);
    return this._parseConversation(row);
  }

  /**
   * Create a new conversation.
   *
   * @param {string} channelId - Channel ID the conversation belongs to
   * @param {string} [projectId] - Optional project ID
   * @param {string} [title] - Optional conversation title
   * @param {Array<{agentId: string, role?: string}>} [participants] - Optional initial participants
   * @returns {{ id: string }} The created conversation ID
   */
  createConversation(channelId, projectId = null, title = null, participants = []) {
    const id = `conv-${randomUUID()}`;
    const now = this._now();
    const status = 'active';

    const create = this.db.transaction(() => {
      this._stmtCreateConversation.run(
        id,
        channelId,
        projectId,
        title,
        status,
        now,
        now
      );

      for (const p of participants) {
        this._stmtAddParticipant.run(id, p.agentId, p.role || 'participant', now);
      }
    });

    create();

    log.info({ conversationId: id, channelId, projectId, participantCount: participants.length }, 'conversation created');

    return { id };
  }

  /**
   * Add a message to a conversation.
   *
   * @param {string} conversationId - Conversation ID
   * @param {string} senderId - Agent ID of the sender
   * @param {string} content - Message content
   * @param {string} messageType - Type of message (e.g., 'comment', 'finding', 'response')
   * @param {Object} [metadata] - Optional metadata object
   * @returns {{ id: string, messageId: string }} The created message ID
   */
  addMessage(conversationId, senderId, content, messageType, metadata = {}) {
    const id = `msg-${randomUUID()}`;
    const now = this._now();

    this._stmtAddMessage.run(
      id,
      conversationId,
      senderId,
      content,
      messageType,
      null, // thread_id
      null, // reply_to
      now,
      JSON.stringify(metadata)
    );

    // Update conversation's updated_at timestamp without changing status
    const conv = this._stmtGetConversation.get(conversationId);
    if (conv) {
      this._stmtUpdateConversation.run(conv.status, now, conversationId);
    }

    log.info(
      { messageId: id, conversationId, senderId, messageType },
      'message added'
    );

    return { id, messageId: id };
  }

  /**
   * Post a message to a conversation with automatic mention creation.
   *
   * @param {Object} params - Message parameters
   * @param {string} params.conversationId - Conversation ID
   * @param {string} params.senderAgentId - Agent ID of the sender
   * @param {string} params.content - Message content
   * @param {string} params.messageType - Type of message (e.g., 'comment', 'finding', 'response')
   * @param {string} [params.threadId] - Optional thread ID
   * @param {string} [params.replyTo] - Optional message ID being replied to
   * @param {Array<Object>} [params.mentions] - Array of mention objects { agentId, mentionType }
   * @param {Object} [params.metadata] - Optional metadata object
   * @returns {{ messageId: string, mentionIds: Array<string> }} The created message and mention IDs
   */
  postMessage(params) {
    const {
      conversationId,
      senderAgentId,
      content,
      messageType,
      threadId = null,
      replyTo = null,
      mentions = [],
      metadata = {}
    } = params;

    // Validate required fields
    if (!conversationId) {
      throw new TypeError('conversationId is required');
    }
    if (!senderAgentId) {
      throw new TypeError('senderAgentId is required');
    }
    if (!content) {
      throw new TypeError('content is required');
    }
    if (!messageType) {
      throw new TypeError('messageType is required');
    }

    const messageId = `msg-${randomUUID()}`;
    const now = this._now();
    const mentionIds = [];

    const post = this.db.transaction(() => {
      this._stmtAddMessage.run(
        messageId,
        conversationId,
        senderAgentId,
        content,
        messageType,
        threadId,
        replyTo,
        now,
        JSON.stringify(metadata)
      );

      // Update conversation's updated_at timestamp without changing status
      const conv = this._stmtGetConversation.get(conversationId);
      if (conv) {
        this._stmtUpdateConversation.run(conv.status, now, conversationId);
      }

      for (const mention of mentions) {
        const mentionId = `mention-${randomUUID()}`;
        this._stmtAddMention.run(
          mentionId,
          messageId,
          mention.agentId,
          mention.mentionType || 'tag',
          null
        );
        mentionIds.push(mentionId);
        log.info({ mentionId, messageId, mentionedAgentId: mention.agentId }, 'mention created');
      }
    });

    post();

    log.info(
      { messageId, conversationId, senderAgentId, messageType, mentionCount: mentions.length },
      'message posted'
    );

    return { messageId, mentionIds };
  }

  /**
   * Get a single mention by ID.
   *
   * @param {string} mentionId - Mention ID
   * @returns {Object|null} Mention object or null if not found
   */
  getMention(mentionId) {
    const row = this._stmtGetMention.get(mentionId);
    if (!row) return null;
    return {
      id: row.id,
      messageId: row.message_id,
      mentionedAgentId: row.mentioned_agent_id,
      mentionType: row.mention_type,
      acknowledgedAt: row.acknowledged_at,
    };
  }

  /**
   * Get unacknowledged mentions for a specific agent.
   *
   * Mention rows carry the joined message content and conversation id, so
   * callers serving one project must pass projectId — the unfiltered form
   * returns mentions from every project's conversations.
   *
   * @param {string} agentId - Agent ID to query mentions for
   * @param {Object} [options]
   * @param {string} [options.projectId] - Only mentions in conversations owned by this project
   * @returns {Array<Object>} Array of mention objects with message context
   */
  getMentionsForAgent(agentId, { projectId } = {}) {
    const rows = projectId
      ? this._stmtGetMentionsForAgentInProject.all(agentId, projectId)
      : this._stmtGetMentionsForAgent.all(agentId);
    return rows.map(row => this._parseMention(row));
  }

  /**
   * Get unacknowledged mentions for a specific agent (alias for getMentionsForAgent).
   *
   * @param {string} agentId - Agent ID to query mentions for
   * @param {Object} [options]
   * @param {string} [options.projectId] - Only mentions in conversations owned by this project
   * @returns {Array<Object>} Array of mention objects with message context
   */
  getMentions(agentId, options) {
    return this.getMentionsForAgent(agentId, options);
  }

  /**
   * Acknowledge a mention (mark it as read).
   *
   * @param {string} mentionId - Mention ID to acknowledge
   * @returns {boolean} True if the mention was acknowledged
   */
  acknowledgeMessage(mentionId) {
    const now = this._now();
    const result = this._stmtAcknowledgeMention.run(now, mentionId);

    if (result.changes > 0) {
      log.info({ mentionId }, 'mention acknowledged');
      return true;
    }

    return false;
  }

  /**
   * Acknowledge a mention (alias for acknowledgeMessage).
   *
   * @param {string} mentionId - Mention ID to acknowledge
   * @returns {boolean} True if the mention was acknowledged
   */
  acknowledgeMention(mentionId) {
    return this.acknowledgeMessage(mentionId);
  }

  /**
   * Get conversation message history.
   *
   * @param {string} conversationId - Conversation ID
   * @param {Object} [opts] - Options
   * @param {string} [opts.since] - Return only messages created after this ISO timestamp
   * @param {number} [opts.limit=100] - Maximum number of messages to return
   * @param {number} [opts.offset=0] - Offset for pagination
   * @returns {Array<Object>} Array of message objects
   */
  getConversationHistory(conversationId, opts = {}) {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const since = opts.since ?? null;

    const rows = since
      ? this._stmtGetConversationHistorySince.all(conversationId, since, limit, offset)
      : this._stmtGetConversationHistory.all(conversationId, limit, offset);
    return rows.map(row => this._parseMessage(row));
  }

  /**
   * Get messages from a conversation (alias for getConversationHistory).
   *
   * @param {string} conversationId - Conversation ID
   * @param {Object} [opts] - Options
   * @param {number} [opts.limit=100] - Maximum number of messages to return
   * @param {number} [opts.offset=0] - Offset for pagination
   * @returns {Array<Object>} Array of message objects
   */
  getMessages(conversationId, opts = {}) {
    return this.getConversationHistory(conversationId, opts);
  }

  /**
   * Get messages from a specific thread within a conversation.
   * Filters and paginates at the SQL level for correct behavior.
   *
   * @param {string} conversationId - Conversation ID
   * @param {string} threadId - Thread ID to filter by
   * @param {Object} [opts] - Options
   * @param {string} [opts.since] - Return only messages created after this ISO timestamp
   * @param {number} [opts.limit=100] - Maximum number of messages to return
   * @param {number} [opts.offset=0] - Offset for pagination
   * @returns {Array<Object>} Array of message objects
   */
  getThreadMessages(conversationId, threadId, opts = {}) {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const since = opts.since ?? null;

    const rows = since
      ? this._stmtGetThreadMessagesSince.all(conversationId, threadId, since, limit, offset)
      : this._stmtGetThreadMessages.all(conversationId, threadId, limit, offset);
    return rows.map(row => this._parseMessage(row));
  }

  /**
   * List conversations matching filters.
   *
   * @param {Object} [filters] - Filter options
   * @param {string} [filters.channelId] - Filter by channel ID
   * @param {string} [filters.projectId] - Filter by project ID
   * @param {string} [filters.status] - Filter by status
   * @param {string} [filters.participant] - Filter by participant agent ID
   * @param {number} [filters.limit=50] - Maximum number of results
   * @param {number} [filters.offset=0] - Offset for pagination
   * @returns {Array<Object>} Array of conversation objects
   */
  listConversations(filters = {}) {
    const channelId = filters.channelId ?? null;
    const projectId = filters.projectId ?? null;
    const status = filters.status ?? null;
    const participant = filters.participant ?? null;
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    let rows;
    if (participant) {
      rows = this._stmtListConversationsByParticipant.all(
        participant,
        channelId, channelId,
        projectId, projectId,
        status, status,
        limit, offset
      );
    } else {
      rows = this._stmtListConversations.all(
        channelId, channelId,
        projectId, projectId,
        status, status,
        limit, offset
      );
    }

    return rows.map(row => this._parseConversation(row));
  }

  /**
   * Update conversation status.
   *
   * @param {string} conversationId - Conversation ID
   * @param {string} status - New status ('active', 'resolved', 'escalated')
   * @returns {boolean} True if the status was updated
   */
  updateConversationStatus(conversationId, status) {
    const validStatuses = ['active', 'resolved', 'escalated'];
    if (!validStatuses.includes(status)) {
      throw new TypeError(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    const now = this._now();
    const result = this._stmtUpdateConversation.run(status, now, conversationId);

    if (result.changes > 0) {
      log.info({ conversationId, status }, 'conversation status updated');
      return true;
    }

    return false;
  }

  /**
   * Add a participant to a conversation.
   *
   * @param {string} conversationId - Conversation ID
   * @param {string} agentId - Agent ID
   * @param {string} role - Participant role (e.g., 'implementer', 'reviewer')
   * @returns {void}
   */
  addParticipant(conversationId, agentId, role) {
    const now = this._now();
    this._stmtAddParticipant.run(conversationId, agentId, role, now);
    log.info({ conversationId, agentId, role }, 'participant added');
  }

  /**
   * Get all participants in a conversation.
   *
   * @param {string} conversationId - Conversation ID
   * @returns {Array<Object>} Array of participant objects
   */
  getParticipants(conversationId) {
    const rows = this._stmtGetParticipants.all(conversationId);
    return rows.map(row => this._parseParticipant(row));
  }

  /**
   * Read the persisted resolver terminal state for a project thread.
   *
   * @param {string} projectId
   * @param {string} threadId
   * @returns {Object|null}
   */
  getResolverState(projectId, threadId) {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new TypeError('projectId is required');
    }
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('threadId is required');
    }
    const row = this._stmtGetResolverState.get(projectId, threadId);
    if (!row) return null;
    return {
      state: row.state,
      previousState: row.previous_state,
      outcome: JSON.parse(row.outcome),
      history: JSON.parse(row.history),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Persist the resolver state and full append-only transition history.
   * State-machine validation remains in ConversationResolverState; this method
   * owns the durable representation and makes resolver outcomes visible to
   * ConversationStore consumers.
   *
   * @param {string} projectId
   * @param {string} threadId
   * @param {Object} record
   */
  setResolverState(projectId, threadId, record) {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new TypeError('projectId is required');
    }
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new TypeError('threadId is required');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('resolver state record must be an object');
    }
    if (!Array.isArray(record.history)) {
      throw new TypeError('resolver state history must be an array');
    }
    this._stmtSetResolverState.run(
      projectId,
      threadId,
      record.state,
      record.previousState ?? null,
      JSON.stringify(record.outcome),
      JSON.stringify(record.history),
      record.updatedAt,
    );
  }

  /**
   * Add a mention to a message.
   *
   * @param {string} messageId - Message ID
   * @param {string} mentionedAgentId - Agent ID being mentioned
   * @param {string} mentionType - Type of mention (e.g., 'tag', 'assignment')
   * @returns {{ id: string }} The created mention ID
   */
  addMention(messageId, mentionedAgentId, mentionType) {
    const id = `mention-${randomUUID()}`;

    this._stmtAddMention.run(
      id,
      messageId,
      mentionedAgentId,
      mentionType,
      null // acknowledged_at (NULL = not yet acknowledged)
    );

    log.info({ mentionId: id, messageId, mentionedAgentId }, 'mention created');

    return { id };
  }

  /**
   * Get conversation summary with participant list, message count, unresolved mention count,
   * current status, and last activity timestamp.
   *
   * @param {string} conversationId - Conversation ID
   * @returns {Object|null} Summary object or null if conversation not found
   */
  getConversationSummary(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    const participants = this.getParticipants(conversationId);
    const messageCountRow = this._stmtGetMessageCount.get(conversationId);
    const unresolvedMentionCountRow = this._stmtGetUnresolvedMentionCount.get(conversationId);
    const lastActivityRow = this._stmtGetLastActivityTimestamp.get(conversationId);

    return {
      id: conversation.id,
      channelId: conversation.channelId,
      projectId: conversation.projectId,
      title: conversation.title,
      status: conversation.status,
      participants: participants.map(p => ({
        agentId: p.agentId,
        role: p.role,
        joinedAt: p.joinedAt,
      })),
      messageCount: messageCountRow?.count || 0,
      unresolvedMentionCount: unresolvedMentionCountRow?.count || 0,
      lastActivityAt: lastActivityRow?.last_activity || conversation.createdAt,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  /**
   * Subscribe to corruption detection events.
   * @param {string} event - Event name ('database:corruption-detected')
   * @param {Function} handler - Event handler
   */
  on(event, handler) {
    this._emitter.on(event, handler);
  }

  /**
   * Close the database connection.
   */
  close() {
    this.db.close();
  }
}
