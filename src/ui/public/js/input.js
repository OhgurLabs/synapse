/**
 * @module input.js
 * @domain Input Handling & Message Sending
 * @description User input, @-autocomplete, /command autocomplete, message
 *   sending, mode selection (auto/solo/pair/council), context label, sidebar
 *   project/channel tree rendering, and unread badge management.
 *
 * @namespace window.SynapseInput
 * @exports {
 *   send(): void,
 *   renderSidebar(): void,
 *   switchChannel(projectId: string, channelId: string): void,
 *   updateContextLabel(): void,
 *   updateUnreadBadge(projectId: string, channelId: string): void,
 *   activeProject: string|null,
 *   activeChannel: string|null,
 *   projects: Object[],
 *   unreadCounts: Object
 * }
 * @depends window.SynapseWebSocket.wsSend
 *          window.SynapseMessages.clearMessages
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  let inputEl = null;
  let activeProject = null;
  let activeChannel = null;
  let projects = [];
  let unreadCounts = {};

  // --- Sidebar rendering ---
  function renderSidebar() {
    const tree = document.getElementById('project-tree');
    if (!tree) return;
    const authFetch = window.SynapseWebSocket && window.SynapseWebSocket.authFetch;
    tree.innerHTML = '';

    for (const proj of projects) {
      const section = document.createElement('div');
      section.className = 'sidebar-section';

      const header = document.createElement('div');
      header.className = 'sidebar-project';
      header.dataset.project = proj.id;
      header.setAttribute('role', 'treeitem');
      header.setAttribute('aria-level', '1');
      header.setAttribute('aria-expanded', 'true'); // Default expanded
      const alloc = proj.allocation != null ? proj.allocation : 100;
      // A sealed project (the `default` init chat surface) has no allocation
      // and cannot run work — it is NOT "paused", it is a chat-only landing.
      // Show neither a PAUSED badge nor the allocation row for it.
      const isSealed = proj.sealed === true;
      const pausedBadge = (!isSealed && alloc === 0) ? ' <span class="proj-paused-badge">PAUSED</span>' : '';
      const sealedTag = isSealed ? ' <span class="proj-chat-tag">chat</span>' : '';
      const esc = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');
      header.innerHTML = `<span class="arrow">&#9662;</span> ${esc(proj.displayName || proj.id)}${pausedBadge}${sealedTag}`;
      header.addEventListener('click', () => {
        const chans = section.querySelector('.sidebar-channels');
        const arrow = header.querySelector('.arrow');
        if (chans) {
          const isHidden = chans.classList.toggle('hidden');
          header.setAttribute('aria-expanded', !isHidden);
        }
        if (arrow) arrow.classList.toggle('collapsed', chans ? chans.classList.contains('hidden') : false);
      });
      section.appendChild(header);

      // Power allocation row — never for a sealed chat-only project.
      if (authFetch && !isSealed) {
        const powerRow = document.createElement('div');
        powerRow.className = 'sidebar-power-row';
        powerRow.innerHTML = `<span class="power-icon">&#9889;</span><span class="power-label">${alloc}%</span>`;
        for (const pct of [0, 25, 50, 75, 100]) {
          const btn = document.createElement('button');
          btn.className = 'power-btn' + (alloc === pct ? ' active' : '');
          btn.textContent = pct === 0 ? 'Off' : pct + '%';
          btn.title = pct === 0 ? 'Pause project (queue only)' : `Set allocation to ${pct}%`;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Optimistic UI: flip active class immediately so the user
            // sees their click landed; revert if the API rejects. Without
            // this, slow networks gave no feedback for the round-trip
            // duration and silent failures left the UI completely stale.
            const prevAlloc = proj.allocation;
            powerRow.querySelectorAll('.power-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const labelEl = powerRow.querySelector('.power-label');
            if (labelEl) labelEl.textContent = `${pct}%`;
            authFetch(`/api/projects/${proj.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ allocation: pct }),
            }).then(res => {
              if (!res || !res.ok) throw new Error('PATCH failed');
              const idx = projects.findIndex(p => p.id === proj.id);
              if (idx !== -1) projects[idx].allocation = pct;
              renderSidebar();
            }).catch(() => {
              // Revert: restore previous active button + label
              proj.allocation = prevAlloc;
              renderSidebar();
            });
          });
          powerRow.appendChild(btn);
        }
        // Per-project agent roster — RosterSpec: explicit agents AND/OR
        // model-tier classes ("all opus-5 + all gpt-5.6-sol"), union
        // semantics. null = all agents (default). A roles matrix set via
        // the API is preserved untouched by this control.
        const rosterBtn = document.createElement('button');
        const spec = (proj.agents && typeof proj.agents === 'object' && !Array.isArray(proj.agents))
          ? proj.agents
          : (Array.isArray(proj.agents) && proj.agents.length ? { agents: proj.agents } : null);
        const pinnedBits = spec ? [...(spec.agents || []), ...(spec.classes || []).map(c => `class:${c}`)] : [];
        const pinned = !!spec;
        rosterBtn.className = 'power-btn' + (pinned ? ' active' : '');
        rosterBtn.textContent = 'Agents';
        rosterBtn.title = pinned
          ? `Pinned to: ${pinnedBits.join(', ') || '(role matrix only)'} — click to edit`
          : 'All agents may work this project — click to pin agents or model classes';
        rosterBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const existing = section.querySelector('.agent-roster-pop');
          if (existing) { existing.remove(); return; }
          const [all, classes] = await Promise.all([
            authFetch('/api/agents').then(r => r.json()).catch(() => []),
            authFetch('/api/agent-classes').then(r => r.json()).catch(() => []),
          ]);
          const pop = document.createElement('div');
          pop.className = 'agent-roster-pop';
          pop.style.cssText = 'margin:4px 0 4px 18px;padding:6px;border:1px solid var(--border,#333);border-radius:6px;background:var(--bg-elevated,#151515);font-size:12px';
          const curAgents = spec?.agents || [];
          const curClasses = spec?.classes || [];
          const escA = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');
          const agentRows = (Array.isArray(all) ? all : []).map(a =>
            `<label style="display:block;cursor:pointer"><input type="checkbox" data-kind="agent" value="${escA(a.id)}" ${curAgents.includes(a.id) ? 'checked' : ''}> ${escA(a.name || a.id)} <span style="opacity:.55">${escA(a.provider || '')}</span></label>`
          ).join('');
          const classRows = (Array.isArray(classes) ? classes : []).map(c =>
            `<label style="display:block;cursor:pointer"><input type="checkbox" data-kind="class" value="${escA(c.class)}" ${curClasses.includes(c.class) ? 'checked' : ''}> All ${escA(c.class)} <span style="opacity:.55">(${c.agentIds.length} agent${c.agentIds.length === 1 ? '' : 's'})</span></label>`
          ).join('');
          pop.innerHTML = `<div style="opacity:.65;margin-bottom:2px">Agents</div>` + agentRows
            + (classRows ? `<div style="opacity:.65;margin:6px 0 2px">Model classes</div>` + classRows : '')
            + `<div style="margin-top:6px;display:flex;gap:6px">
              <button class="power-btn roster-apply">Apply</button>
              <button class="power-btn roster-all">All agents</button>
            </div>`;
          pop.addEventListener('click', ev => ev.stopPropagation());
          const applyRoster = (newSpec) => authFetch(`/api/projects/${proj.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agents: newSpec }),
          }).then(res => {
            if (!res || !res.ok) throw new Error('PATCH failed');
            return res.json();
          }).then(body => {
            const idx = projects.findIndex(p => p.id === proj.id);
            if (idx !== -1) projects[idx].agents = body.agents ?? null;
            renderSidebar();
          }).catch(() => pop.remove());
          pop.querySelector('.roster-apply').addEventListener('click', () => {
            const agentsSel = [...pop.querySelectorAll('input[data-kind="agent"]:checked')].map(i => i.value);
            const classesSel = [...pop.querySelectorAll('input[data-kind="class"]:checked')].map(i => i.value);
            const roles = spec?.roles || undefined; // preserve API-set role matrix
            const next = (agentsSel.length || classesSel.length || roles)
              ? { agents: agentsSel.length ? agentsSel : undefined,
                  classes: classesSel.length ? classesSel : undefined,
                  roles }
              : null;
            applyRoster(next);
          });
          pop.querySelector('.roster-all').addEventListener('click', () => applyRoster(null));
          powerRow.after(pop);
        });
        powerRow.appendChild(rosterBtn);
        section.appendChild(powerRow);
      }

      const channels = document.createElement('div');
      channels.className = 'sidebar-channels'; // No 'hidden' — all expanded by default
      channels.setAttribute('role', 'group');
      const chList = Array.isArray(proj.channels) ? proj.channels : [];
      for (const ch of chList) {
        const chId = typeof ch === 'string' ? ch : ch.id;
        const isActiveCh = proj.id === activeProject && chId === activeChannel;
        const key = `${proj.id}/${chId}`;
        const count = unreadCounts[key] || 0;
        const chEl = document.createElement('div');
        chEl.className = 'sidebar-channel' + (isActiveCh ? ' active' : '');
        chEl.dataset.project = proj.id;
        chEl.dataset.channel = chId;
        chEl.setAttribute('role', 'treeitem');
        chEl.setAttribute('aria-level', '2');
        if (isActiveCh) {
          chEl.setAttribute('aria-current', 'page');
        }
        const esc = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');
        chEl.innerHTML = `<span class="hash">#</span> ${esc(chId)}<span class="unread-badge ${count > 0 ? 'visible' : ''}" data-key="${key}">${count > 0 ? count : ''}</span>`;
        if (chId !== 'general') {
          const delBtn = document.createElement('span');
          delBtn.className = 'chan-delete';
          delBtn.textContent = '\u00d7';
          delBtn.title = 'Delete channel';
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirm(`Delete #${chId}? This removes all messages.`)) return;
            if (authFetch) authFetch(`/api/projects/${proj.id}/channels/${chId}`, { method: 'DELETE' })
              .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); })
              .catch(err => window.SynapseMessages?.showToast?.(`Failed to delete #${chId}: ${err.message}`, 'error'));
          });
          chEl.appendChild(delBtn);
        }
        chEl.addEventListener('click', () => switchChannel(proj.id, chId));
        channels.appendChild(chEl);
      }
      // "+ channel" opener — the New Channel modal lost its only opener when
      // the header buttons were deduplicated (Block #21), leaving channel
      // creation unreachable in the UI.
      if (!isSealed) {
        const addCh = document.createElement('div');
        addCh.className = 'sidebar-channel sidebar-add-channel';
        addCh.setAttribute('role', 'button');
        addCh.setAttribute('tabindex', '0');
        addCh.innerHTML = '<span class="hash">+</span> channel';
        const openChannelModal = () => {
          // Anchor the modal to this project: chan-create-btn reads
          // activeProject, so switch context first.
          if (proj.id !== activeProject) switchChannel(proj.id, 'general');
          if (window.openModal) window.openModal('modal-channel');
        };
        addCh.addEventListener('click', (e) => { e.stopPropagation(); openChannelModal(); });
        addCh.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChannelModal(); }
        });
        channels.appendChild(addCh);
      }
      section.appendChild(channels);
      tree.appendChild(section);
    }

    var addBtn = document.createElement('div');
    addBtn.className = 'sidebar-add-project';
    var esc2 = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');
    addBtn.innerHTML = '<span class="add-icon">+</span> <span class="add-label">Add Project</span>';
    addBtn.setAttribute('role', 'button');
    addBtn.setAttribute('tabindex', '0');
    addBtn.setAttribute('aria-label', 'Add new project');
    // Open the canonical New Project modal directly. The bottom-of-sidebar
    // "+ New Project" button was removed in Block #21 (duplicate path), so
    // this inline button is now the single entry point for project create.
    addBtn.addEventListener('click', function () {
      if (window.openModal) window.openModal('modal-project');
    });
    // role=button demands keyboard operability — Tab could focus this but
    // Enter/Space did nothing.
    addBtn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (window.openModal) window.openModal('modal-project');
      }
    });
    tree.appendChild(addBtn);
  }
  function updateUnreadBadge(projectId, channelId) {
    const key = `${projectId}/${channelId}`;
    const badge = document.querySelector(`.unread-badge[data-key="${key}"]`);
    if (!badge) return;
    const count = unreadCounts[key] || 0;
    badge.textContent = count || '';
    badge.classList.toggle('visible', count > 0);
  }

  function switchChannel(projectId, channelId) {
    activeProject = projectId;
    activeChannel = channelId;
    // Persist for next page load — restored from websocket.js init handler.
    try {
      localStorage.setItem('synapse_last_channel', JSON.stringify({ project: projectId, channel: channelId }));
    } catch { /* localStorage may be disabled — non-fatal */ }
    renderSidebar();
    updateContextLabel();
    if (window.SynapseMessages) window.SynapseMessages.clearMessages();
    if (window.SynapseWebSocket) {
      window.SynapseWebSocket.wsSend({ type: 'subscribe', project: projectId, channel: channelId });
    }
  }

  function updateContextLabel() {
    const label = document.getElementById('context-label');
    if (!label) return;
    if (activeProject && activeChannel) {
      // Render as clickable spans so users can locate the current
      // project/channel in the sidebar with one click. Both halves
      // scroll-into-view the matching sidebar entry; clicking the
      // channel half also flashes a brief highlight so the eye can
      // catch it on long sidebars.
      const projEl = document.createElement('span');
      projEl.className = 'project-name context-clickable';
      projEl.textContent = activeProject;
      projEl.title = 'Locate in sidebar';
      projEl.addEventListener('click', () => scrollSidebarTo(activeProject, activeChannel));
      const sep = document.createTextNode(' / #');
      const chanEl = document.createElement('span');
      chanEl.className = 'channel-name context-clickable';
      chanEl.textContent = activeChannel;
      chanEl.title = 'Locate in sidebar';
      chanEl.addEventListener('click', () => scrollSidebarTo(activeProject, activeChannel));
      label.replaceChildren(projEl, sep, chanEl);
    } else {
      label.textContent = '';
    }
  }

  function scrollSidebarTo(projectId, channelId) {
    if (!projectId) return;
    const selector = channelId
      ? `[data-project="${CSS.escape(projectId)}"][data-channel="${CSS.escape(channelId)}"]`
      : `[data-project="${CSS.escape(projectId)}"]`;
    const el = document.querySelector(`#sidebar ${selector}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('sidebar-flash');
    setTimeout(() => el.classList.remove('sidebar-flash'), 1200);
  }

  // --- Message sending ---
  function send() {
    if (!inputEl) return;
    const content = inputEl.value.trim();
    if (!content || !activeProject || !activeChannel) return;

    const activeMode = document.querySelector('#mode-selector .mode-btn.active');
    const mode = activeMode?.dataset.mode || null;

    // Reply chain: the reply preview set pendingReplyTo but send() never read
    // it, so the server (which accepts replyTo/replyToThreadId) never got it
    // and the preview was never cleared — Reply was a complete no-op.
    const replyRef = window.SynapseMessages?.pendingReplyTo || null;

    if (window.SynapseWebSocket) {
      window.SynapseWebSocket.wsSend({
        type: 'user_message',
        content,
        project: activeProject,
        channel: activeChannel,
        mode: mode || undefined,
        replyTo: replyRef?.id || undefined,
        replyToThreadId: replyRef?.threadId || undefined,
      });
    }
    if (replyRef && window.SynapseMessages?.clearReplyTo) window.SynapseMessages.clearReplyTo();
    inputEl.value = '';
    inputEl.style.height = 'auto';
  }

  function init() {
    inputEl = document.getElementById('input');

    // Send button
    const sendBtn = document.getElementById('send');
    if (sendBtn) sendBtn.addEventListener('click', send);

    // Enter to send (Shift+Enter for newline)
    if (inputEl) {
      // U2: slash-command autocomplete. The placeholder advertised commands
      // but typing "/" showed nothing. This is a lightweight menu — filters
      // as you type "/", arrow/Tab/Enter to complete, Esc to dismiss.
      const SLASH_COMMANDS = [
        { cmd: '/task', desc: 'Create or manage a task' },
        { cmd: '/campaign', desc: 'Create or manage a campaign' },
        { cmd: '/project', desc: 'Project settings' },
        { cmd: '/agenda', desc: 'Manage the agenda' },
        { cmd: '/prefs', desc: 'Preferences' },
        { cmd: '/schedule', desc: 'Schedule a recurring action' },
        { cmd: '/trigger', desc: 'Event triggers' },
        { cmd: '/workflow', desc: 'Multi-step workflow' },
        { cmd: '/thread', desc: 'Start or switch a thread' },
        { cmd: '/session', desc: 'Session controls' },
        { cmd: '/steer-stream', desc: 'Steer a running stream' },
      ];
      let slashItems = [];
      let slashSel = 0;
      const slashMenu = document.createElement('div');
      slashMenu.id = 'slash-menu';
      slashMenu.hidden = true;
      (inputEl.parentElement || document.body).appendChild(slashMenu);
      const slashOpen = () => !slashMenu.hidden;

      function renderSlashMenu() {
        slashMenu.innerHTML = slashItems.map((it, i) =>
          `<div class="slash-item${i === slashSel ? ' sel' : ''}" data-cmd="${it.cmd}">`
          + `<span class="slash-cmd">${it.cmd}</span><span class="slash-desc">${it.desc}</span></div>`
        ).join('');
        Array.from(slashMenu.children).forEach(el => {
          el.addEventListener('mousedown', ev => { ev.preventDefault(); completeSlash(el.dataset.cmd); });
        });
      }
      function updateSlashMenu() {
        const v = inputEl.value;
        const m = /^\/(\S*)$/.exec(v);
        if (!m) { slashMenu.hidden = true; return; }
        const q = m[1].toLowerCase();
        slashItems = SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(q));
        if (slashItems.length === 0) { slashMenu.hidden = true; return; }
        slashSel = 0;
        renderSlashMenu();
        const r = inputEl.getBoundingClientRect();
        slashMenu.style.position = 'fixed';
        slashMenu.style.left = r.left + 'px';
        slashMenu.style.width = r.width + 'px';
        slashMenu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        slashMenu.hidden = false;
      }
      function completeSlash(cmd) {
        inputEl.value = cmd + ' ';
        slashMenu.hidden = true;
        inputEl.focus();
        inputEl.dispatchEvent(new Event('input'));
      }

      inputEl.addEventListener('keydown', e => {
        if (slashOpen()) {
          if (e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % slashItems.length; renderSlashMenu(); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel - 1 + slashItems.length) % slashItems.length; renderSlashMenu(); return; }
          if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); completeSlash(slashItems[slashSel].cmd); return; }
          if (e.key === 'Escape') { e.preventDefault(); slashMenu.hidden = true; return; }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });

      inputEl.addEventListener('input', () => {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
        updateSlashMenu();
      });
      inputEl.addEventListener('blur', () => { setTimeout(() => { slashMenu.hidden = true; }, 120); });
    }

    // Mode buttons — selection persists across reloads (P6: it silently
    // reset to Auto before, which surprised operators mid-session).
    const MODE_KEY = 'synapse:ui:message-mode';
    const savedMode = localStorage.getItem(MODE_KEY);
    if (savedMode) {
      // Auto's button carries data-mode="" — 'auto' is our storage alias.
      const savedBtn = savedMode === 'auto'
        ? document.querySelector('#mode-selector .mode-btn[data-mode=""]')
        : document.querySelector(`#mode-selector .mode-btn[data-mode="${CSS.escape(savedMode)}"]`);
      if (savedBtn) {
        document.querySelectorAll('#mode-selector .mode-btn').forEach(b => b.classList.remove('active'));
        savedBtn.classList.add('active');
      }
    }
    document.querySelectorAll('#mode-selector .mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mode-selector .mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        try { localStorage.setItem(MODE_KEY, btn.dataset.mode || 'auto'); } catch {}
      });
    });
  }

  // --- Public API ---
  window.SynapseInput = {
    send,
    renderSidebar,
    switchChannel,
    updateContextLabel,
    updateUnreadBadge,
    get activeProject() { return activeProject; },
    set activeProject(v) { activeProject = v; },
    get activeChannel() { return activeChannel; },
    set activeChannel(v) { activeChannel = v; },
    get projects() { return projects; },
    set projects(v) { projects = v; },
    get unreadCounts() { return unreadCounts; },
    init,
  };
})();
