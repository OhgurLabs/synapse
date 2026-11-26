import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from '../../src/orchestrator/conversation-store.js';

const EXPECTED_TABLES = [
  'conversation_mentions',
  'conversation_messages',
  'conversation_participants',
  'conversation_resolver_states',
  'conversations',
];

const EXPECTED_INDEXES = [
  'idx_conversation_mentions_agent_ack',
  'idx_conversation_mentions_message',
  'idx_conversation_messages_conversation_created',
  'idx_conversation_messages_sender',
  'idx_conversation_messages_thread',
  'idx_conversation_participants_agent',
  'idx_conversation_resolver_states_state',
  'idx_conversations_channel_id',
  'idx_conversations_project_id',
  'idx_conversations_status',
];

const tempDirs = new Set();
const openStores = new Set();

function createStore(filename = 'conversations.sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-conversation-store-'));
  const dbPath = join(dir, filename);
  const store = new ConversationStore({ dbPath });
  tempDirs.add(dir);
  openStores.add(store);
  return { dbPath, store };
}

function closeStore(store) {
  if (store.db.open) store.close();
  openStores.delete(store);
}

function installMonotonicClock(store) {
  let tick = 0;
  store._now = () => new Date(Date.UTC(2026, 7, 15, 12, 0, tick++)).toISOString();
}

afterEach(() => {
  for (const store of openStores) closeStore(store);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test('initializes the complete inline schema in a fresh database', () => {
  const { dbPath, store } = createStore();

  assert.equal(existsSync(dbPath), true);

  const tables = store.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'conversation%'
    ORDER BY name
  `).all().map(({ name }) => name);

  const indexes = store.db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'idx_conversation%'
    ORDER BY name
  `).all().map(({ name }) => name);

  assert.deepEqual(tables, EXPECTED_TABLES);
  assert.deepEqual(indexes, EXPECTED_INDEXES);
});

test('creates, reads, lists, and updates conversations and participants', () => {
  const { store } = createStore();
  installMonotonicClock(store);

  const created = store.createConversation(
    'channel-alpha',
    'project-alpha',
    'Persistence review',
    [
      { agentId: 'agent-author', role: 'implementer' },
      { agentId: 'agent-reviewer', role: 'reviewer' },
    ],
  );
  store.createConversation('channel-beta', 'project-beta', 'Out of scope');

  assert.deepEqual(store.getConversation(created.id), {
    id: created.id,
    channelId: 'channel-alpha',
    projectId: 'project-alpha',
    title: 'Persistence review',
    status: 'active',
    createdAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:00:00.000Z',
  });
  assert.deepEqual(
    store.getParticipants(created.id).map(({ agentId, role }) => ({ agentId, role })),
    [
      { agentId: 'agent-author', role: 'implementer' },
      { agentId: 'agent-reviewer', role: 'reviewer' },
    ],
  );
  assert.deepEqual(
    store.listConversations({ projectId: 'project-alpha', participant: 'agent-reviewer' })
      .map(({ id }) => id),
    [created.id],
  );

  assert.equal(store.updateConversationStatus(created.id, 'resolved'), true);
  assert.equal(store.getConversation(created.id).status, 'resolved');
  assert.equal(store.updateConversationStatus('conv-missing', 'active'), false);
  assert.throws(
    () => store.updateConversationStatus(created.id, 'pending'),
    /Invalid status: pending/,
  );
});

test('persists message metadata and filters threads in SQL', () => {
  const { store } = createStore();
  installMonotonicClock(store);
  const { id: conversationId } = store.createConversation('channel-1', 'project-1');

  const first = store.postMessage({
    conversationId,
    senderAgentId: 'agent-1',
    content: 'Thread A first',
    messageType: 'finding',
    threadId: 'thread-a',
    metadata: { severity: 'serious' },
  });
  const cutoff = store.getConversationHistory(conversationId)[0].createdAt;
  const second = store.postMessage({
    conversationId,
    senderAgentId: 'agent-2',
    content: 'Thread B only',
    messageType: 'comment',
    threadId: 'thread-b',
  });
  const third = store.postMessage({
    conversationId,
    senderAgentId: 'agent-3',
    content: 'Thread A reply',
    messageType: 'response',
    threadId: 'thread-a',
    replyTo: first.messageId,
  });

  assert.deepEqual(
    store.getConversationHistory(conversationId).map(({ id }) => id),
    [first.messageId, second.messageId, third.messageId],
  );
  assert.deepEqual(
    store.getThreadMessages(conversationId, 'thread-a').map(({ id }) => id),
    [first.messageId, third.messageId],
  );
  assert.deepEqual(
    store.getThreadMessages(conversationId, 'thread-a', { since: cutoff }).map(({ id }) => id),
    [third.messageId],
  );
  assert.deepEqual(
    store.getThreadMessages(conversationId, 'thread-a', { limit: 1, offset: 1 })
      .map(({ id }) => id),
    [third.messageId],
  );
  assert.deepEqual(store.getMessages(conversationId)[0].metadata, { severity: 'serious' });
  assert.equal(store.getMessages(conversationId)[2].replyTo, first.messageId);
});

test('tracks and acknowledges mentions and aggregates conversation summaries', () => {
  const { store } = createStore();
  installMonotonicClock(store);
  const { id: conversationId } = store.createConversation(
    'channel-1',
    'project-1',
    'Mention review',
    [{ agentId: 'agent-1', role: 'author' }],
  );

  const first = store.postMessage({
    conversationId,
    senderAgentId: 'agent-1',
    content: '@agent-2 and @agent-3 please review',
    messageType: 'finding',
    mentions: [
      { agentId: 'agent-2', mentionType: 'review-request' },
      { agentId: 'agent-3' },
    ],
  });
  store.addMessage(conversationId, 'agent-2', 'Reviewing now', 'comment');

  assert.equal(store.getMentionsForAgent('agent-2').length, 1);
  assert.equal(store.getMentions('agent-3')[0].mentionType, 'tag');
  assert.equal(store.getMention(first.mentionIds[0]).acknowledgedAt, null);

  const summary = store.getConversationSummary(conversationId);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.unresolvedMentionCount, 2);
  assert.equal(summary.status, 'active');
  assert.equal(summary.participants[0].agentId, 'agent-1');
  assert.equal(summary.lastActivityAt, '2026-08-15T12:00:02.000Z');

  assert.equal(store.acknowledgeMention(first.mentionIds[0]), true);
  assert.equal(store.acknowledgeMessage('mention-missing'), false);
  assert.equal(store.getMentionsForAgent('agent-2').length, 0);
  assert.ok(store.getMention(first.mentionIds[0]).acknowledgedAt);
  assert.equal(store.getConversationSummary(conversationId).unresolvedMentionCount, 1);
  assert.equal(store.getConversationSummary('conv-missing'), null);

  // projectId scopes the listing to conversations owned by that project.
  const { id: otherConversationId } = store.createConversation(
    'channel-2',
    'project-2',
    'Other project mention',
    [{ agentId: 'agent-9', role: 'author' }],
  );
  store.postMessage({
    conversationId: otherConversationId,
    senderAgentId: 'agent-9',
    content: 'project-2 ping',
    messageType: 'comment',
    mentions: [{ agentId: 'agent-2', mentionType: 'direct' }],
  });
  assert.equal(store.getMentionsForAgent('agent-2').length, 1, 'unfiltered listing spans projects');
  assert.equal(
    store.getMentionsForAgent('agent-2', { projectId: 'project-1' }).length,
    0,
    'project-1 mention was acknowledged; project-2 mention stays out of its listing',
  );
  const scoped = store.getMentionsForAgent('agent-2', { projectId: 'project-2' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].content, 'project-2 ping');
  assert.equal(scoped[0].conversationId, otherConversationId);
  assert.equal(store.getMentionsForAgent('agent-2', { projectId: 'project-none' }).length, 0);
});

test('retains conversations, participants, messages, mentions, and status after reopen', () => {
  const { dbPath, store } = createStore();
  installMonotonicClock(store);
  const { id: conversationId } = store.createConversation(
    'channel-durable',
    'project-durable',
    'Durable conversation',
    [{ agentId: 'agent-1', role: 'owner' }],
  );
  const posted = store.postMessage({
    conversationId,
    senderAgentId: 'agent-1',
    content: '@agent-2 persistence check',
    messageType: 'comment',
    threadId: 'durable-thread',
    mentions: [{ agentId: 'agent-2', mentionType: 'tag' }],
    metadata: { durable: true },
  });
  store.updateConversationStatus(conversationId, 'resolved');
  closeStore(store);

  const reopened = new ConversationStore({ dbPath });
  openStores.add(reopened);

  assert.equal(reopened.getConversation(conversationId).status, 'resolved');
  assert.equal(reopened.getParticipants(conversationId)[0].role, 'owner');
  assert.equal(reopened.getThreadMessages(conversationId, 'durable-thread')[0].id, posted.messageId);
  assert.deepEqual(reopened.getMessages(conversationId)[0].metadata, { durable: true });
  assert.equal(reopened.getMentionsForAgent('agent-2')[0].messageId, posted.messageId);
  assert.equal(reopened.getConversationSummary(conversationId).messageCount, 1);
});

test('persists resolver terminal state and history for ConversationStore consumers', () => {
  const { dbPath, store } = createStore();
  const record = {
    state: 'escalated',
    previousState: 'active',
    outcome: {
      resolved: false,
      resolution: null,
      shouldEscalate: true,
      reason: 'Max conversation turns exceeded (4/3)',
    },
    history: [{
      from: 'active',
      to: 'escalated',
      reason: 'Max conversation turns exceeded (4/3)',
      at: '2026-08-16T12:00:00.000Z',
    }],
    updatedAt: '2026-08-16T12:00:00.000Z',
  };

  assert.equal(store.getResolverState('project-1', 'thread-1'), null);
  store.setResolverState('project-1', 'thread-1', record);
  assert.deepEqual(store.getResolverState('project-1', 'thread-1'), record);
  assert.equal(store.getResolverState('project-1', 'thread-other'), null);

  closeStore(store);
  const reopened = new ConversationStore({ dbPath });
  openStores.add(reopened);
  assert.deepEqual(reopened.getResolverState('project-1', 'thread-1'), record);
});
