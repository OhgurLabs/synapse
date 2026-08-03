/**
 * @module messages.js
 * @domain Message Rendering & Threading
 * @description Message display, thread visualization, vote results, system
 *   messages, markdown rendering, and toast notifications.
 *
 * @namespace window.SynapseMessages
 * @exports {
 *   appendMessage(msg: Object): void,
 *   appendSystem(text: string, threadId?: string): void,
 *   appendVoteResult(msg: Object): void,
 *   appendDeadlockNotice(msg: Object): void,
 *   clearMessages(): void,
 *   setThreadFilter(threadId: string): void,
 *   clearThreadFilter(): void,
 *   setReplyTo(ref: Object): void,
 *   clearReplyTo(): void,
 *   showToast(message: string, variant?: string): void,
 *   renderMarkdown(text: string): string,
 *   messageCache: Map,
 *   pendingReplyTo: Object|null
 * }
 * @depends window.SynapseAgents.agentColors
 *          window.SynapseAgents.agentModels
 *          window.SynapseHealth.escapeHtml
 *          window.SynapseHealth.formatTimestamp
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let messagesEl = null;
  let threadFilterBar = null;
  let threadFilterLabel = null;
  let closeThreadFilter = null;
  let replyPreview = null;
  let replyPreviewSpeaker = null;
  let replyPreviewText = null;
  let closeReplyBtn = null;
  let toastContainer = null;

  let messageCache = new Map();
  let transientSystemMessages = new Map();
  let pendingReplyTo = null;
  let activeThreadFilter = null;
  let lastRenderedThreadId = null;

  // Thread color palette for thread labels
  const threadColors = ['#d97706','#10a37f','#4285f4','#e11d48','#8b5cf6','#06b6d4','#f59e0b','#ec4899'];
  const threadColorMap = {}; // threadId → color
  let threadColorIdx = 0;

  // --- Utility Functions ---
  function getThreadColor(threadId) {
    if (!threadId) return '#555';
    if (!threadColorMap[threadId]) {
      threadColorMap[threadId] = threadColors[threadColorIdx % threadColors.length];
      threadColorIdx++;
    }
    return threadColorMap[threadId];
  }

  function shortModel(model) {
    return model
      .replace('claude-opus-4-6', 'Opus 4.6')
      .replace('claude-sonnet-4-6', 'Sonnet 4.6')
      .replace('claude-sonnet-4-5-20250929', 'Sonnet 4.5')
      .replace('claude-sonnet-4-5', 'Sonnet 4.5')
      .replace('claude-', 'Claude ')
      .replace('gpt-5.4-codex', 'gpt-5.4c')
      .replace('gpt-5.3-codex-spark', 'gpt-5.3-spark')
      .replace('gpt-5.2-codex', 'gpt-5.2c')
      .replace('gpt-5.1-codex-max', 'gpt-5.1-max')
      .replace('gpt-5.1-codex-mini', 'gpt-5.1m')
      .replace('gemini-3-auto', 'gem-3-auto')
      .replace('gemini-3-flash-preview', 'gem-3-flash')
      .replace('gemini-3-pro-preview', 'gem-3-pro')
      .replace('gemini-2.5-flash', 'gem-2.5-f')
      .replace('gemini-2.5-pro', 'gem-2.5-pro')
      .replace(/Qwen[\d.]*-(\d+B)(?:-[A-Z0-9]+)?-UD-.*\.gguf/i, 'Qwen3.5-$1')
      .replace(/\.gguf$/i, '')
      .replace('qwen3-72b', 'Qwen3 72B');
  }

  function renderMarkdown(text) {
    // Simple markdown → HTML. Handles: code blocks, inline code, bold, italic,
    // headers, lists, blockquotes, links. NOT a full parser — good enough for agent output.
    const escapeHtml = window.SynapseHealth?.escapeHtml || ((t) => t);
    let html = escapeHtml(text);

    // Fenced code blocks (```lang\n...\n```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code>${code.replace(/\n$/, '')}</code></pre>`
    );
    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    // Paragraphs — wrap remaining loose lines
    html = html.replace(/\n\n/g, '</p><p>');
    // Single newlines within paragraphs
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  // --- Message Rendering ---
  function appendMessage(msg) {
    if (!messagesEl) return;
    removeEmptyState();

    const escapeHtml = window.SynapseHealth?.escapeHtml || ((t) => t);
    const formatTimestamp = window.SynapseHealth?.formatTimestamp || ((t) => '');
    const agentColors = window.SynapseAgents?.agentColors || {};

    const div = document.createElement('div');
    const isUser = msg.speaker === (window.SynapseOperatorName || 'operator');
    const isSystem = msg.speaker === 'System';
    if (isSystem) { appendSystem(msg.content, msg.threadId, { timestamp: msg.timestamp }); return; }

    div.className = `message ${isUser ? 'user' : 'agent'}`;
    if (msg.id) div.dataset.msgId = msg.id;
    if (msg.threadId) div.dataset.threadId = msg.threadId;

    // Thread-colored left border
    if (msg.threadId) {
      const tColor = getThreadColor(msg.threadId);
      div.classList.add('threaded');
      div.style.setProperty('--thread-color', tColor);
    }

    // Thread separator when thread changes between messages
    if (msg.threadId && lastRenderedThreadId && msg.threadId !== lastRenderedThreadId) {
      const sepColor = getThreadColor(msg.threadId);
      const sepSlug = msg.threadId.replace(/^thread_\d+_/, '').replace(/-/g, ' ');
      const sep = document.createElement('div');
      sep.className = 'thread-separator';
      if (activeThreadFilter && msg.threadId !== activeThreadFilter) sep.classList.add('thread-hidden');
      sep.innerHTML = `<span class="sep-label"><span class="sep-dot" style="background:${sepColor}"></span>${escapeHtml(sepSlug)}</span>`;
      messagesEl.appendChild(sep);
    }
    if (msg.threadId) lastRenderedThreadId = msg.threadId;

    // Cache by id so later replyTo lookups can build quote bubbles — the
    // cache was declared and read but never written, making the reply-quote
    // branch below unreachable.
    if (msg.id) messageCache.set(msg.id, msg);

    // Thread filter: hide messages not in the active thread
    if (activeThreadFilter && msg.threadId && msg.threadId !== activeThreadFilter) {
      div.classList.add('thread-hidden');
    }

    let inner = '';

    // Reply quote bubble (explicit replyTo)
    if (msg.replyTo) {
      const ref = messageCache.get(msg.replyTo);
      if (ref) {
        const preview = (ref.content || '').slice(0, 80) + ((ref.content || '').length > 80 ? '...' : '');
        inner += `<div class="reply-bubble" data-reply-to="${escapeHtml(msg.replyTo)}"><span class="reply-speaker">${escapeHtml(ref.speaker)}</span>${escapeHtml(preview)}</div>`;
      }
    }
    // Thread context bar for agent messages without explicit replyTo
    else if (!isUser && msg.threadId) {
      const tColor = getThreadColor(msg.threadId);
      const slug = msg.threadId.replace(/^thread_\d+_/, '').replace(/-/g, ' ');
      inner += `<div class="thread-context" style="--thread-color:${tColor}"><span class="thread-ctx-dot" style="background:${tColor}"></span>in thread <span class="thread-ctx-label">${escapeHtml(slug)}</span></div>`;
    }

    const color = agentColors[msg.speaker] || '#888';
    const model = msg.model || '';
    const fallbackTag = msg.fallback ? ` <span class="fallback-tag" title="Fallback from ${escapeHtml(msg.fallbackFrom || 'primary')}">fallback</span>` : '';
    const modelTag = (!isUser && model) ? ` <span class="model-tag">${shortModel(model)}</span>${fallbackTag}` : '';
    const ts = formatTimestamp(msg.timestamp);
    const tsTag = ts ? `<span class="timestamp">${ts}</span>` : '';

    // Thread label pill
    let threadLabelHtml = '';
    if (msg.threadId) {
      const tColor = getThreadColor(msg.threadId);
      const slug = msg.threadId.replace(/^thread_\d+_/, '').replace(/-/g, ' ');
      const label = slug.length > 20 ? slug.slice(0, 20) + '...' : slug;
      threadLabelHtml = `<span class="thread-label" style="background:${tColor}22;color:${tColor};border:1px solid ${tColor}44" data-thread-id="${escapeHtml(msg.threadId)}">${escapeHtml(label)}</span>`;
    }

    const contentHtml = isUser ? escapeHtml(msg.content) : renderMarkdown(msg.content);
    inner += `<div class="speaker" style="color: ${color}">${escapeHtml(msg.speaker)}${modelTag}${threadLabelHtml}${tsTag}</div><div class="content">${contentHtml}</div>`;

    // Reply action button
    if (msg.id) {
      inner += `<button class="reply-btn" data-msg-id="${escapeHtml(msg.id)}" data-speaker="${escapeHtml(msg.speaker)}" data-thread-id="${escapeHtml(msg.threadId || '')}">Reply</button>`;
    }

    div.innerHTML = inner;

    // Click handlers for thread label
    const tlEl = div.querySelector('.thread-label');
    if (tlEl) {
      tlEl.onclick = (e) => {
        e.stopPropagation();
        setThreadFilter(tlEl.dataset.threadId);
      };
    }

    // Click handler for reply bubble (scroll to original)
    const rbEl = div.querySelector('.reply-bubble');
    if (rbEl) {
      rbEl.onclick = () => {
        const target = messagesEl.querySelector(`[data-msg-id="${rbEl.dataset.replyTo}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    }

    // Click handler for reply button
    const replyBtn = div.querySelector('.reply-btn');
    if (replyBtn) {
      replyBtn.onclick = (e) => {
        e.stopPropagation();
        setReplyTo({
          id: replyBtn.dataset.msgId,
          speaker: replyBtn.dataset.speaker,
          content: (msg.content || '').slice(0, 80),
          threadId: replyBtn.dataset.threadId || null,
        });
      };
    }

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ─── System messages — now rendered in the right-side #system-column ──────
  // Previously these were interleaved into #messages alongside agent and
  // operator messages. The operator pain was that high-volume system events
  // (cross-project pattern detected / anomaly stats / allocation summaries)
  // crowded out the agent transcript and made "scroll back to the last agent
  // message" tedious. Move semantics: system messages now go ONLY to the
  // right column, never to #messages. The right column resets on channel
  // switch via clearMessages() so each channel has its own scrollback.
  function appendSystem(text, threadId, opts = {}) {
    const systemBody = document.getElementById('system-column-body');
    if (!systemBody) return;

    const transientKey = opts && opts.transientKey;
    if (transientKey) {
      const existing = transientSystemMessages.get(transientKey);
      if (existing && existing.isConnected) {
        const contentEl = existing.querySelector('.system-msg-content') || existing;
        contentEl.innerHTML = renderMarkdown(text);
        if (threadId) existing.dataset.threadId = threadId;
        else delete existing.dataset.threadId;
        return;
      }
    }

    const div = document.createElement('div');
    div.className = 'system-msg';
    if (threadId) div.dataset.threadId = threadId;
    // Use the message's own timestamp when replaying history — stamping
    // render time made old notices (e.g. an hours-old introduction failure)
    // look like they just happened. Falls back to now for live notices.
    const parsed = opts.timestamp ? new Date(opts.timestamp) : new Date();
    const when = isNaN(parsed.getTime()) ? new Date() : parsed;
    const sameDay = when.toDateString() === new Date().toDateString();
    const time = sameDay
      ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    div.innerHTML =
      `<span class="system-msg-time">${time}</span>` +
      `<div class="system-msg-content">${renderMarkdown(text)}</div>`;
    systemBody.appendChild(div);
    if (transientKey) transientSystemMessages.set(transientKey, div);

    // Scroll the column to keep the newest message in view
    systemBody.scrollTop = systemBody.scrollHeight;

    // Update the count badge
    updateSystemCount();
  }

  function dismissSystem(transientKey) {
    if (!transientKey) return;
    const existing = transientSystemMessages.get(transientKey);
    if (!existing) return;
    transientSystemMessages.delete(transientKey);
    if (existing.parentNode) existing.parentNode.removeChild(existing);
    updateSystemCount();
  }

  function updateSystemCount() {
    const body = document.getElementById('system-column-body');
    const count = document.getElementById('system-column-count');
    if (body && count) count.textContent = body.children.length;
  }

  function clearSystemColumn() {
    const body = document.getElementById('system-column-body');
    if (body) body.innerHTML = '';
    transientSystemMessages.clear();
    updateSystemCount();
  }

  function appendVoteResult(msg) {
    if (!messagesEl) return;

    const escapeHtml = window.SynapseHealth?.escapeHtml || ((t) => t);

    const div = document.createElement('div');
    div.className = 'vote-card';
    if (msg.threadId) div.dataset.threadId = msg.threadId;
    if (activeThreadFilter && msg.threadId && msg.threadId !== activeThreadFilter) {
      div.classList.add('thread-hidden');
    }
    const resultClass = (msg.result || '').toLowerCase().replace(/\s+/g, '-');
    const details = (msg.details || []).map(d => {
      const posMatch = d.match(/^(\w+):\s*(YES|NO|ABSTAIN)/);
      if (!posMatch) return `<div class="vote-detail">${escapeHtml(d)}</div>`;
      const posClass = posMatch[2].toLowerCase();
      return `<div class="vote-detail"><span class="vote-pos ${posClass}">${escapeHtml(posMatch[2])}</span> ${escapeHtml(posMatch[1])}${escapeHtml(d.slice(posMatch[0].length))}</div>`;
    }).join('');
    div.innerHTML = `
      <div class="vote-question">${escapeHtml(msg.question)}</div>
      <span class="vote-result ${resultClass}">${escapeHtml(msg.result)}</span>
      <div class="vote-tally">YES: ${msg.tally?.YES || 0} / NO: ${msg.tally?.NO || 0} / ABSTAIN: ${msg.tally?.ABSTAIN || 0}</div>
      ${details}
    `;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendDeadlockNotice(msg) {
    if (!messagesEl) return;

    const div = document.createElement('div');
    div.className = 'deadlock-notice';
    if (msg.threadId) div.dataset.threadId = msg.threadId;
    div.innerHTML = `
      <div class="deadlock-title">Stalemate detected</div>
      <div class="deadlock-hint">Agents debated for ${msg.responseCount || '?'} responses without converging. Try <code>/vote "question"</code> to force a decision.</div>
    `;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearMessages() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    messageCache.clear();
    transientSystemMessages.clear();
    activeThreadFilter = null;
    lastRenderedThreadId = null;
    if (threadFilterBar) threadFilterBar.classList.remove('visible');
    renderEmptyState();
    // Per-channel system column scrollback. Each channel switch reloads from
    // scratch — historical system messages come back through the same
    // appendSystem path when the server replays them.
    clearSystemColumn();
  }

  // ─── System column UX: toggle, resize, clear, persistence ─────────────────
  const SYS_COL_HIDDEN_KEY = 'synapse:ui:system-column-hidden';
  const SYS_COL_WIDTH_KEY = 'synapse:ui:system-column-width';

  function initSystemColumn() {
    // Restore persisted width
    try {
      const w = parseInt(localStorage.getItem(SYS_COL_WIDTH_KEY) || '320', 10);
      if (w >= 200 && w <= 800) {
        document.body.style.setProperty('--system-column-width', w + 'px');
      }
    } catch (_) {}

    // Restore persisted hidden state
    try {
      if (localStorage.getItem(SYS_COL_HIDDEN_KEY) === '1') {
        document.body.classList.add('system-hidden');
      }
    } catch (_) {}
    updateToggleButton();

    // Toggle button
    const toggle = document.getElementById('system-column-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const nowHidden = !document.body.classList.contains('system-hidden');
        document.body.classList.toggle('system-hidden', nowHidden);
        try { localStorage.setItem(SYS_COL_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch (_) {}
        updateToggleButton();
      });
    }

    // Resize handle — drag the left edge of the column to widen/narrow
    const handle = document.getElementById('system-column-resize');
    if (handle) {
      handle.addEventListener('mousedown', startResize);
    }

    // Clear button — wipes the COLUMN, not the server. Server messages remain
    // available; next replay will repopulate. Useful for operator triage.
    const clearBtn = document.getElementById('system-column-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearSystemColumn);
    }
  }

  function updateToggleButton() {
    const toggle = document.getElementById('system-column-toggle');
    if (!toggle) return;
    const hidden = document.body.classList.contains('system-hidden');
    toggle.textContent = hidden ? '‹' : '›';
    toggle.title = hidden ? 'Show system messages' : 'Hide system messages';
  }

  let resizeStartX = 0;
  let resizeStartWidth = 0;
  function startResize(e) {
    e.preventDefault();
    const col = document.getElementById('system-column');
    if (!col) return;
    resizeStartX = e.clientX;
    resizeStartWidth = col.offsetWidth;
    document.body.classList.add('resizing-system-column');
    const handle = document.getElementById('system-column-resize');
    if (handle) handle.classList.add('dragging');
    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', endResize);
  }
  function doResize(e) {
    // System column grows when dragged LEFTWARD (its left edge moves left)
    const delta = resizeStartX - e.clientX;
    let newWidth = resizeStartWidth + delta;
    newWidth = Math.max(200, Math.min(800, newWidth));
    document.body.style.setProperty('--system-column-width', newWidth + 'px');
  }
  function endResize() {
    document.removeEventListener('mousemove', doResize);
    document.removeEventListener('mouseup', endResize);
    document.body.classList.remove('resizing-system-column');
    const handle = document.getElementById('system-column-resize');
    if (handle) handle.classList.remove('dragging');
    // Persist the final width
    try {
      const w = parseInt(getComputedStyle(document.body).getPropertyValue('--system-column-width'), 10) || 320;
      localStorage.setItem(SYS_COL_WIDTH_KEY, String(w));
    } catch (_) {}
  }

  function renderEmptyState() {
    if (!messagesEl) return;
    // Count rendered agent badges — initAgentBadges runs before
    // clearMessages on the init handshake (websocket.js init handler
    // order), so this read is accurate.
    const agentCount = document.querySelectorAll('#agent-badges .agent-badge').length;
    const div = document.createElement('div');
    div.className = 'chat-empty-state';
    if (agentCount === 0) {
      div.innerHTML = '<strong>No agents yet</strong>'
        + 'Click <span class="kbd-hint">+ Add Agent</span> in the header to register one. '
        + 'Agents respond to messages here.';
    } else {
      // U1: in a continuous-mode project, the first message you type becomes
      // the project's vision and Synapse plans a campaign from it. Nothing in
      // the UI says so — surface it here instead of leaving a dead "type a
      // message" prompt.
      let continuousHint = '';
      try {
        const SI = window.SynapseInput;
        const proj = SI?.projects?.find(p => p.id === SI.activeProject);
        if (proj && proj.mode === 'continuous' && proj.sealed !== true) {
          continuousHint = '<span class="chat-empty-vision-hint">This is a <strong>continuous</strong> project — '
            + 'describe your goal here and Synapse will set it as the vision and plan a campaign to deliver it.</span>';
        }
      } catch { /* defensive — fall back to the generic prompt */ }
      div.innerHTML = '<strong>No messages yet</strong>'
        + (continuousHint || 'Type below or use <code>@agent-name</code> to start a conversation.');
    }
    messagesEl.appendChild(div);
  }

  function removeEmptyState() {
    if (!messagesEl) return;
    const ph = messagesEl.querySelector('.chat-empty-state');
    if (ph) ph.remove();
  }

  // --- Thread Filter ---
  function setThreadFilter(threadId) {
    if (!messagesEl || !threadFilterBar || !threadFilterLabel) return;

    const escapeHtml = window.SynapseHealth?.escapeHtml || ((t) => t);

    activeThreadFilter = threadId;
    const slug = threadId.replace(/^thread_\d+_/, '').replace(/-/g, ' ');
    threadFilterLabel.textContent = slug;
    threadFilterBar.classList.add('visible');

    // Show/hide messages and separators
    for (const el of messagesEl.children) {
      if (el.classList.contains('thread-separator')) {
        el.classList.add('thread-hidden'); // hide all separators in filter mode
        continue;
      }
      const elThread = el.dataset?.threadId;
      if (!elThread) { el.classList.remove('thread-hidden'); continue; }
      el.classList.toggle('thread-hidden', elThread !== threadId);
    }
  }

  function clearThreadFilter() {
    if (!messagesEl || !threadFilterBar) return;

    activeThreadFilter = null;
    threadFilterBar.classList.remove('visible');
    for (const el of messagesEl.children) {
      el.classList.remove('thread-hidden');
    }
  }

  // --- Reply-to ---
  function setReplyTo(ref) {
    if (!replyPreview || !replyPreviewSpeaker || !replyPreviewText) return;

    pendingReplyTo = ref;
    replyPreviewSpeaker.textContent = ref.speaker;
    replyPreviewText.textContent = ref.content + (ref.content.length >= 80 ? '...' : '');
    replyPreview.classList.add('visible');

    const inputEl = document.getElementById('input');
    if (inputEl) inputEl.focus();
  }

  function clearReplyTo() {
    if (!replyPreview) return;

    pendingReplyTo = null;
    replyPreview.classList.remove('visible');
  }


  // --- Toast notification system ---
  function showToast(message, variant = 'info', options = {}) {
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast ${variant}`;

    // Support HTML content if explicitly allowed
    if (options.allowHtml) {
      toast.innerHTML = message;
    } else {
      toast.textContent = message;
    }

    // Click dismisses — stacked error toasts could previously only be
    // waited out.
    toast.style.cursor = 'pointer';
    toast.title = 'Dismiss';
    toast.addEventListener('click', () => toast.remove());

    toastContainer.appendChild(toast);

    // Auto-dismiss after 4 seconds (or custom duration)
    const duration = options.duration || 4000;
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300); // Wait for fade-out animation to complete
    }, duration);
  }

  function init() {
    messagesEl = document.getElementById('messages');
    threadFilterBar = document.getElementById('thread-filter-bar');
    threadFilterLabel = document.getElementById('thread-filter-label');
    closeThreadFilter = document.getElementById('close-thread-filter');
    replyPreview = document.getElementById('reply-preview');
    replyPreviewSpeaker = document.getElementById('reply-preview-speaker');
    replyPreviewText = document.getElementById('reply-preview-text');
    closeReplyBtn = document.getElementById('close-reply');
    toastContainer = document.getElementById('toast-container');

    // Wire the new system-messages column (toggle, resize, clear, persistence)
    initSystemColumn();

    // Bind close handlers (click + keyboard for role="button" spans)
    if (closeThreadFilter) {
      closeThreadFilter.onclick = clearThreadFilter;
      closeThreadFilter.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clearThreadFilter(); }
      });
    }
    if (closeReplyBtn) {
      closeReplyBtn.onclick = clearReplyTo;
      closeReplyBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clearReplyTo(); }
      });
    }
  }

  // --- Public API ---
  window.SynapseMessages = {
    appendMessage,
    appendSystem,
    dismissSystem,
    appendVoteResult,
    appendDeadlockNotice,
    clearMessages,
    setThreadFilter,
    clearThreadFilter,
    setReplyTo,
    clearReplyTo,
    showToast,
    renderMarkdown,
    get messageCache() { return messageCache; },
    get pendingReplyTo() { return pendingReplyTo; },
    set lastRenderedThreadId(value) { lastRenderedThreadId = value; },
    init,
  };
})();
