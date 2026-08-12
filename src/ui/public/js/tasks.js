/**
 * @module tasks.js
 * @domain Task Management & Display
 * @description Task list rendering, task detail overlay, pause/resume actions.
 *
 * @namespace window.SynapseTasks
 * @exports {
 *   refreshTasks(): void,
 *   renderTasks(): void,
 *   openTaskDetail(projectId: string, taskId: string): void,
 *   closeTaskDetail(): void,
 *   renderTaskDetail(task: Object, projectId: string): void,
 *   tasksCache: Object,
 *   markConversationUnread(threadId: string): void,
 *   clearConversationUnread(threadId: string): void
 * }
 * @depends window.SynapseWebSocket.authFetch
 *          window.SynapseHealth.escapeHtml
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let tasksPanel = null;
  let tasksCache = {};
  const unreadConversationThreads = new Set();

  // --- Constants ---
  const TASK_STATUS_ICONS = {
    daemon: '🎯',
    sleeping: '😴',
    executing: '⚡',
    planning: '🧠',
    reviewing: '👀',
    queued: '⏳',
    completed: '✅',
    failed: '❌',
  };

  const TASK_STATUS_CLASSES = {
    daemon: 'daemon',
    sleeping: 'sleeping',
    executing: 'executing',
    planning: 'planning',
    reviewing: 'reviewing',
    queued: 'queued',
    completed: 'completed',
    failed: 'failed',
  };

  // --- Functions ---

  function findTaskByThreadId(threadId) {
    for (const tasks of Object.values(tasksCache)) {
      for (const t of tasks) {
        if (t.threadId === threadId) return t;
      }
    }
    return null;
  }

  function markConversationUnread(threadId) {
    unreadConversationThreads.add(threadId);
    const task = findTaskByThreadId(threadId);
    if (!task) return;
    const itemEl = document.querySelector(`.task-item[data-task-id="${task.id}"]`);
    if (!itemEl) return;
    const badge = itemEl.querySelector('.task-thread-badge');
    if (badge) {
      badge.classList.add('conv-unread');
      badge.title = 'New messages';
    }
  }

  function clearConversationUnread(threadId) {
    unreadConversationThreads.delete(threadId);
    const task = findTaskByThreadId(threadId);
    if (!task) return;
    const itemEl = document.querySelector(`.task-item[data-task-id="${task.id}"]`);
    if (!itemEl) return;
    const badge = itemEl.querySelector('.task-thread-badge');
    if (badge) {
      badge.classList.remove('conv-unread');
      badge.title = 'Has conversation';
    }
  }

  function refreshTasks() {
    if (!tasksPanel) return;
    fetchAllTasks();
  }

  async function fetchAllTasks() {
    const projects = window.SynapseInput ? window.SynapseInput.projects : [];
    if (!projects.length) return;

    // ONE request for every project. This used to loop and issue one request
    // per project on every 30s poll (and once more on init), so a dashboard's
    // request rate scaled linearly with project count -- against a 120/min
    // budget the rate limiter keys on the TOKEN, meaning every open tab shares
    // the same bucket.
    //
    // The old loop had per-project try/catch specifically so one project's
    // failure could not blank the whole panel. A single request brings back
    // all-or-nothing failure, so on error we keep the PREVIOUS cache and
    // re-render it rather than clearing -- stale tasks beat an empty panel,
    // and the next poll is only 30s away.
    try {
      const res = await window.SynapseWebSocket.authFetch('/api/tasks?status=active');
      if (res.ok) {
        const byProject = await res.json();
        // Replace wholesale so projects that no longer have active tasks are
        // cleared, but only for projects the response actually mentions.
        for (const proj of projects) {
          if (Object.prototype.hasOwnProperty.call(byProject, proj.id)) {
            tasksCache[proj.id] = byProject[proj.id];
          }
        }
      }
    } catch (e) { /* keep the previous cache; render what we already have */ }

    try { renderTasks(); } catch (e) { /* ignore render errors */ }
  }

  // ─── Group-collapse state (persisted in localStorage) ────────────────────
  // Per-campaign collapse state survives reload. Key is campaignId or
  // '__standalone__' for the no-campaign bucket. Operator preference.
  const TASKS_COLLAPSED_KEY = 'synapse:ui:tasks-groups-collapsed';
  function loadCollapsedTaskGroups() {
    try { return new Set(JSON.parse(localStorage.getItem(TASKS_COLLAPSED_KEY) || '[]')); }
    catch (_) { return new Set(); }
  }
  function saveCollapsedTaskGroups(set) {
    try { localStorage.setItem(TASKS_COLLAPSED_KEY, JSON.stringify([...set])); } catch (_) {}
  }
  // Campaigns created AFTER page load (e.g. strategist generations) are not
  // in the campaigns cache — it loads once at init — so their task groups
  // rendered a literal "(campaign campaign_…)" placeholder forever. On a
  // title miss, refresh that project's campaign list ONCE and re-render.
  const requestedCampaignTitles = new Set();

  // Lookup campaign title from campaigns module's exposed cache (read-only).
  function lookupCampaignTitle(projId, campId) {
    try {
      const cache = window.SynapseCampaigns && window.SynapseCampaigns.campaignsCache;
      const list = cache && cache[projId];
      if (!list) return null;
      const c = list.find(x => x.id === campId);
      return c ? (c.title || c.name || null) : null;
    } catch (_) { return null; }
  }

  function renderTasks() {
    if (!tasksPanel) return;
    tasksPanel.innerHTML = '';
    const activeTasks = [];
    for (const [projId, tasks] of Object.entries(tasksCache)) {
      for (const t of tasks) {
        if (['done', 'completed', 'cancelled'].includes(t.status)) continue;
        activeTasks.push({ ...t, _projId: projId });
      }
    }
    if (activeTasks.length === 0) return;

    // Group tasks by campaignId. Tasks without a campaign go under
    // '__standalone__' (rendered as a "Standalone" header at the bottom).
    const groups = new Map();  // key → { title, projId, campaignId, tasks }
    for (const task of activeTasks) {
      const key = task.campaignId || '__standalone__';
      if (!groups.has(key)) {
        let title;
        if (task.campaignId) {
          const looked = lookupCampaignTitle(task._projId, task.campaignId);
          if (!looked && !requestedCampaignTitles.has(task.campaignId)
              && window.SynapseCampaigns?.refreshCampaignList) {
            requestedCampaignTitles.add(task.campaignId); // one refresh per campaign — no loops
            window.SynapseCampaigns.refreshCampaignList(task._projId, () => renderTasks());
          }
          title = looked || `(campaign ${task.campaignId.slice(0, 12)}…)`;
        } else {
          title = 'Standalone';
        }
        groups.set(key, {
          title,
          projId: task._projId,
          campaignId: task.campaignId || null,
          tasks: [],
        });
      }
      groups.get(key).tasks.push(task);
    }

    const collapsed = loadCollapsedTaskGroups();
    const esc = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');

    // Panel-level header (unchanged)
    const header = document.createElement('div');
    header.className = 'tasks-header';
    header.innerHTML = `Tasks <span class="task-count">(${activeTasks.length})</span>`;
    tasksPanel.appendChild(header);

    // Sort: campaigned groups first (alphabetical), '__standalone__' last
    const sortedKeys = [...groups.keys()].sort((a, b) => {
      if (a === '__standalone__') return 1;
      if (b === '__standalone__') return -1;
      return (groups.get(a).title || '').localeCompare(groups.get(b).title || '');
    });

    for (const key of sortedKeys) {
      const group = groups.get(key);
      const isCollapsed = collapsed.has(key);
      const shortTitle = (group.title || '').length > 24
        ? group.title.substring(0, 22) + '…' : group.title;

      const groupEl = document.createElement('div');
      groupEl.className = 'task-group';
      groupEl.dataset.groupId = key;

      const groupHeader = document.createElement('div');
      groupHeader.className = 'task-group-header' + (isCollapsed ? ' collapsed' : '');
      groupHeader.title = group.title;
      groupHeader.innerHTML =
        `<span class="task-group-chevron">${isCollapsed ? '▶' : '▼'}</span>` +
        `<span class="task-group-title">${esc(shortTitle)}</span>` +
        `<span class="task-group-count">${group.tasks.length}</span>`;

      const groupBody = document.createElement('div');
      groupBody.className = 'task-group-body';
      if (isCollapsed) groupBody.style.display = 'none';
      for (const task of group.tasks) {
        groupBody.appendChild(createTaskItem(task, task._projId));
      }

      groupHeader.addEventListener('click', () => {
        const nowCollapsed = !groupHeader.classList.contains('collapsed');
        groupHeader.classList.toggle('collapsed');
        groupBody.style.display = nowCollapsed ? 'none' : '';
        const chev = groupHeader.querySelector('.task-group-chevron');
        if (chev) chev.textContent = nowCollapsed ? '▶' : '▼';
        const s = loadCollapsedTaskGroups();
        if (nowCollapsed) s.add(key); else s.delete(key);
        saveCollapsedTaskGroups(s);
      });

      groupEl.appendChild(groupHeader);
      groupEl.appendChild(groupBody);
      tasksPanel.appendChild(groupEl);
    }

    tasksPanel.querySelectorAll('.task-btn').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        try {
          const res = await window.SynapseWebSocket.authFetch(
            `/api/projects/${btn.dataset.proj}/tasks/${btn.dataset.task}/${btn.dataset.action}`,
            { method: 'POST' }
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'HTTP ' + res.status);
          }
        } catch (err) {
          window.SynapseMessages?.showToast?.(`Task ${btn.dataset.action} failed: ${err.message}`, 'error');
        }
        fetchAllTasks();
      };
    });
  }

  function createTaskItem(task, projectId) {
    const item = document.createElement('div');
    const isDaemon = task.type === 'daemon';
    const statusClass = task.status === 'sleeping' ? 'sleeping'
      : task.status === 'executing' ? 'executing'
      : task.status === 'planning' ? 'planning' : '';
    item.className = `task-item${isDaemon ? ' daemon' : ''}${statusClass ? ' ' + statusClass : ''}`;

    const icon = task.status === 'sleeping' ? '\uD83D\uDCA4'
      : task.status === 'executing' ? '\u25B6'
      : task.status === 'planning' ? '\u23F3'
      : task.status === 'failed' ? '\u2716'
      : task.status === 'completed' || task.status === 'done' ? '\u2714'
      : task.status === 'queued' ? '\u23F8' : '\u2022';

    const esc = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');
    const shortTitle = (task.title || '').length > 30
      ? task.title.substring(0, 28) + '...' : (task.title || 'Untitled');

    let metaHtml = '';
    let btnHtml = '';
    if (isDaemon && task.daemon) {
      const cycle = task.daemon.cycleCount || 0;
      metaHtml = `<span class="task-meta">c${cycle}</span>`;
      if (task.status === 'sleeping' && task.daemon.sleepUntil) {
        const remaining = Math.max(0, Math.round((new Date(task.daemon.sleepUntil) - Date.now()) / 60000));
        metaHtml += `<span class="task-meta">${remaining}m</span>`;
      }
      if (task.daemon.paused) {
        metaHtml += `<span class="task-meta" style="color:var(--danger)">PAUSED</span>`;
        btnHtml = `<button class="task-btn" data-action="resume" data-proj="${esc(projectId)}" data-task="${esc(task.id)}">resume</button>`;
      } else if (task.status !== 'failed') {
        btnHtml = `<button class="task-btn" data-action="pause" data-proj="${esc(projectId)}" data-task="${esc(task.id)}">pause</button>`;
      }
    } else {
      // The list is fed by the bulk /api/tasks poll, which returns the SUMMARY
      // projection — no `subtasks` array, but precomputed counts. Fall back to
      // the array for tasks that arrived from a detail fetch (those are full
      // objects), so both shapes render the same "done/total".
      const done = task.subtasksDone ?? (task.subtasks || []).filter(s => s.status === 'done').length;
      const total = task.subtaskCount ?? (task.subtasks || []).length;
      if (total > 0) metaHtml = `<span class="task-meta">${done}/${total}</span>`;
    }

    if (task.threadId) {
      const unreadClass = unreadConversationThreads.has(task.threadId) ? ' conv-unread' : '';
      metaHtml += `<span class="task-thread-badge${unreadClass}" title="${unreadClass ? 'New messages' : 'Has conversation'}">💬</span>`;
    }

    item.innerHTML = `<span class="task-icon">${icon}</span><span class="task-title" title="${esc(task.title || '')}">${esc(shortTitle)}</span>${metaHtml}${btnHtml}`;
    item.dataset.proj = projectId;
    item.dataset.taskId = task.id;
    item.addEventListener('click', () => openTaskDetail(projectId, task.id));
    return item;
  }


  function closeTaskDetail() {
    const overlay = document.getElementById('task-detail-overlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
  }

  function openTaskDetail(projectId, taskId) {
    const task = tasksCache[projectId]?.find(t => t.id === taskId) || null;

    // A cached entry is not necessarily enough. The bulk poll caches SUMMARIES,
    // which deliberately omit subtasks/reviewFindings — renderTaskDetail needs
    // those arrays, and would silently draw an empty detail pane without them.
    // Presence of a real `subtasks` array is what distinguishes a full task
    // from a summary; fetchTaskDetail() replaces the cache entry with the full
    // object, so this upgrade happens once per task, not once per open.
    if (!task || !Array.isArray(task.subtasks)) {
      fetchTaskDetail(projectId, taskId);
      return;
    }

    renderTaskDetail(task, projectId);
  }

  async function fetchTaskDetail(projectId, taskId) {
    try {
      const resp = await window.SynapseWebSocket.authFetch(
        `/api/projects/${projectId}/tasks/${taskId}`
      );
      if (resp.ok) {
        const task = await resp.json();
        if (!tasksCache[projectId]) tasksCache[projectId] = [];
        const idx = tasksCache[projectId].findIndex(t => t.id === taskId);
        if (idx >= 0) {
          tasksCache[projectId][idx] = task;
        } else {
          tasksCache[projectId].push(task);
        }
        renderTaskDetail(task, projectId);
      }
    } catch (e) {
      window.SynapseMessages?.appendSystem(`Error fetching task: ${e.message}`);
    }
  }

  function renderTaskDetail(task, projectId) {
    const esc = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');

    // Clear conversation unread badge when task detail opens
    if (task.threadId) {
      clearConversationUnread(task.threadId);
    }
    const fmt = window.SynapseHealth ? window.SynapseHealth.formatTimestamp : (s) => String(s || '');

    // Get or create overlay
    let overlay = document.getElementById('task-detail-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'task-detail-overlay';
      document.body.appendChild(overlay);
    }
    // Always set onclick — static HTML element won't have it from the if-branch
    overlay.onclick = (e) => { if (e.target === overlay) closeTaskDetail(); };
    overlay.classList.add('visible');

    // Subtasks — use .td-subtask rows with colored dot icons
    let subtasksHtml = '';
    if (task.subtasks && task.subtasks.length > 0) {
      subtasksHtml = `<div class="td-section">Subtasks</div>`;
      for (const st of task.subtasks) {
        const isDone = st.status === 'done' || st.status === 'completed';
        const iconClass = isDone ? 'done' : st.status === 'failed' ? 'failed' : st.status === 'executing' ? 'executing' : 'pending';
        const label = esc(st.text || st.title || st.description || '');
        subtasksHtml += `<div class="td-subtask">
          <span class="st-icon ${iconClass}">●</span>
          <span class="st-text">${label}</span>
          ${st.suggestedRole ? `<span class="st-role">${esc(st.suggestedRole)}</span>` : ''}
          ${st.verdict ? `<span class="st-verdict st-verdict-${(st.verdict || '').toLowerCase()}">${esc(st.verdict)}</span>` : ''}
          ${st.assignee ? `<span class="st-agent">${esc(st.assignee)}</span>` : ''}
        </div>`;
        // Failed subtask: expose error + last dispatch prompt/response so the
        // operator can see WHY, not just that it failed (lifecycle.js stores
        // truncated previews in meta.lastDispatch).
        if (st.status === 'failed' && (st.error || st.meta?.lastDispatch)) {
          const ld = st.meta?.lastDispatch;
          subtasksHtml += `<details class="td-subtask" style="display:block;padding-left:22px;font-size:11px;opacity:.85">
            <summary style="cursor:pointer">${esc(st.error || ld?.error || 'failure detail')}</summary>`;
          if (ld?.promptPreview) subtasksHtml += `<div style="margin-top:4px"><b>Prompt sent to ${esc(ld.agentId || '?')}:</b><pre style="white-space:pre-wrap;max-height:180px;overflow-y:auto;background:var(--bg-secondary,#1a1a1a);padding:6px;border-radius:4px">${esc(ld.promptPreview)}</pre></div>`;
          if (ld?.responsePreview) subtasksHtml += `<div><b>Response:</b><pre style="white-space:pre-wrap;max-height:180px;overflow-y:auto;background:var(--bg-secondary,#1a1a1a);padding:6px;border-radius:4px">${esc(ld.responsePreview)}</pre></div>`;
          if (ld?.error && st.error !== ld.error) subtasksHtml += `<div><b>Transport error:</b> ${esc(ld.error)}</div>`;
          subtasksHtml += `</details>`;
        }
      }
    }

    // Review findings — use .td-finding divs
    let findingsHtml = '';
    if (task.reviewFindings && task.reviewFindings.length > 0) {
      findingsHtml = `<div class="td-section">Review Findings</div>`;
      for (const f of task.reviewFindings) {
        const raw = (f.severity || 'low').toLowerCase();
        const sevClass = raw === 'critical' ? 'high' : raw === 'serious' ? 'medium' : raw === 'moderate' ? 'medium' : raw === 'high' ? 'high' : 'low';
        const issueText = f.issue || f.description || f.message || '';
        findingsHtml += `<div class="td-finding">
          <span class="finding-severity ${sevClass}">${esc(f.severity || 'low')}</span>
          ${f.file ? ` in <code>${esc(f.file)}</code>` : ''}
          ${issueText ? `<div style="margin-top:3px;font-size:11px;opacity:0.8">${esc(issueText)}</div>` : ''}
        </div>`;
      }
    }

    // Metadata row
    const metaParts = [];
    if (task.channel) metaParts.push(`<span>📁 ${esc(task.channel)}</span>`);
    if (task.createdAt) metaParts.push(`<span>Created: ${fmt(task.createdAt)}</span>`);
    if (task.completedAt) metaParts.push(`<span>Completed: ${fmt(task.completedAt)}</span>`);
    const metaHtml = metaParts.length ? `<div class="td-meta">${metaParts.join('')}</div>` : '';

    // Action buttons — only contextually relevant ones. Pause/resume is a
    // daemon-task capability (server 400s "Not a daemon task" otherwise), so
    // never render the button for regular tasks — it previously showed for
    // any executing task and silently failed on every click.
    const isDaemonTask = task.type === 'daemon';
    const isExecuting = task.status === 'executing' && isDaemonTask;
    const isDaemonPaused = isDaemonTask && task.daemon?.paused;
    const isTerminal = ['done', 'completed', 'failed', 'cancelled'].includes(task.status);
    let actionsHtml = '';
    if (isExecuting) {
      actionsHtml = `<div class="td-actions"><button class="task-action-btn" data-action="pause">⏸ Pause</button></div>`;
    } else if (isDaemonPaused) {
      actionsHtml = `<div class="td-actions"><button class="task-action-btn" data-action="resume">▶ Resume</button></div>`;
    }
    // Cancel — the only cancel UI used to live on the removed operator page,
    // leaving no way to cancel a task from the dashboard at all.
    if (!isTerminal) {
      actionsHtml += `<div class="td-actions"><button class="task-cancel-btn task-action-btn" style="background:var(--danger,#c0392b)">✕ Cancel Task</button></div>`;
    }

    const conversationBtnHtml = task.threadId
      ? `<div class="td-actions"><button class="td-conversation-btn">💬 View Conversation</button></div>`
      : '';

    const statusClass = task.status || 'queued';
    const title = esc(task.title || 'Untitled Task');
    const description = esc(task.description || task.content || '');

    // Project display name for the tag
    const _projList = window.SynapseInput ? (window.SynapseInput.projects || []) : [];
    const _projObj = Array.isArray(_projList) ? _projList.find(p => (p.id || p) === projectId) : null;
    const projDisplay = _projObj ? (_projObj.displayName || _projObj.name || projectId) : (projectId || '');

    overlay.innerHTML = `
      <div id="task-detail-panel">
        <div class="td-header">
          <div class="td-title">${title}</div>
          <button class="td-close" data-task-action="close-detail">✕</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <span class="td-status ${statusClass}" style="margin-bottom:0">${statusClass.toUpperCase()}</span>
          ${projDisplay ? `<span style="font-size:10px;color:var(--text-faint);background:var(--surface-3);padding:2px 8px;border-radius:3px;border:1px solid var(--border)">${esc(projDisplay)}</span>` : ''}
        </div>
        ${description ? `<div class="td-desc">${description}</div>` : ''}
        ${subtasksHtml}
        ${findingsHtml}
        ${metaHtml}
        ${actionsHtml}
        ${conversationBtnHtml}
        <div id="conversation-panel"></div>
      </div>`;

    if (actionsHtml) {
      const btn = overlay.querySelector('.task-action-btn');
      if (btn) btn.onclick = () => {
        window.SynapseWebSocket.authFetch(
          `/api/projects/${projectId}/tasks/${task.id}/${btn.dataset.action}`,
          { method: 'POST' }
        ).then(async res => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            window.SynapseMessages?.showToast?.(`${btn.dataset.action} failed: ${err.error || 'HTTP ' + res.status}`, 'error');
          }
        }).catch(e => {
          window.SynapseMessages?.showToast?.(`${btn.dataset.action} failed: ${e.message}`, 'error');
        }).finally(() => fetchAllTasks());
      };
    }

    const convBtn = overlay.querySelector('.td-conversation-btn');
    if (convBtn) {
      convBtn.onclick = () => {
        if (window.SynapseConversation) {
          window.SynapseConversation.openConversation(task, projectId);
        }
      };
    }

    const cancelBtn = overlay.querySelector('.task-cancel-btn');
    if (cancelBtn) {
      cancelBtn.onclick = async () => {
        const reason = prompt(`Cancel task "${task.title || task.id}"?\n\nEnter a reason (minimum 10 characters):`);
        if (reason === null) return;
        if (reason.trim().length < 10) {
          window.SynapseMessages?.showToast?.('Cancel needs a reason of at least 10 characters', 'error');
          return;
        }
        try {
          const res = await window.SynapseWebSocket.authFetch(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, reason: reason.trim() }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
          window.SynapseMessages?.showToast?.('Task cancelled', 'success');
          closeTaskDetail();
        } catch (err) {
          window.SynapseMessages?.showToast?.(`Cancel failed: ${err.message}`, 'error');
        }
        fetchAllTasks();
      };
    }
  }


  function init() {
    tasksPanel = document.getElementById('tasks-panel');

    // Delegated handler for rendered buttons: inline onclick attributes are
    // blocked by the CSP, so the detail panel's close button carries
    // data-task-action instead. Delegation survives every re-render.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-task-action="close-detail"]');
      if (btn) closeTaskDetail();
    });

    // Start polling
    if (tasksPanel) {
      refreshTasks();
      setInterval(refreshTasks, 30000);
    }
  }

  // --- Public API ---
  window.SynapseTasks = {
    refreshTasks,
    renderTasks,
    openTaskDetail,
    closeTaskDetail,
    renderTaskDetail,
    markConversationUnread,
    clearConversationUnread,
    get tasksCache() { return tasksCache; },
    init,
  };
})();
