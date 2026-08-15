/**
 * @module agents.js
 * @domain Agent Badge Management & Status
 * @description Agent badge rendering, status updates, agent health monitoring,
 *   and the agent settings modal (open/edit/save/revert).
 *
 * @namespace window.SynapseAgents
 * @exports {
 *   initAgentBadges(agentList: Object[]): void,
 *   refreshAgentHealth(): void,
 *   updateAgentStatus(speaker: string, status: string): void,
 *   updateBadgeModel(agentName: string, newModel: string): void,
 *   shortModel(model: string): string,
 *   openAgentSettings(agent: Object): void,
 *   closeAgentSettings(): void,
 *   saveAgentSettings(): void
 * }
 * @depends window.SynapseWebSocket.authFetch
 *          window.SynapseModals.openModal, closeModal
 *          window.SynapseHealth.escapeHtml, inferProviderFromAgent
 *          window.SynapseMessages.appendSystem, showToast
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- Dependencies (imported from other modules) ---
  const getAuthFetch = () => window.SynapseWebSocket?.authFetch;
  const getOpenModal = () => window.SynapseModals?.openModal;
  const getCloseModal = () => window.SynapseModals?.closeModal;
  const getEscapeHtml = () => window.SynapseHealth?.escapeHtml;
  const getInferProvider = () => window.SynapseHealth?.inferProviderFromAgent;
  const getAppendSystem = () => window.SynapseMessages?.appendSystem;
  const getDismissSystem = () => window.SynapseMessages?.dismissSystem;
  const getShowToast = () => window.SynapseMessages?.showToast;

  // Single transport for agent lifecycle actions (pause/resume/activate/
  // deactivate). Three surfaces used to each hand-roll this fetch with three
  // different error behaviors (P3) — every caller now shares one path that
  // checks res.ok and toasts failures. Returns true on success.
  async function requestAgentAction(agentId, action, body = null) {
    const af = getAuthFetch();
    if (!af) return false;
    try {
      const res = await af(`/api/agents/${encodeURIComponent(agentId)}/${encodeURIComponent(action)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'HTTP ' + res.status);
      }
      return true;
    } catch (err) {
      console.warn(`Agent ${action} failed:`, err);
      getShowToast()?.(`${action} failed for ${agentId}: ${err.message}`, 'error');
      return false;
    }
  }

  // --- State ---
  let agentColors = {};
  let agentBadges = {};
  let agentModels = {};
  let agentDisplayModels = {};
  let agentProviders = {};
  let badgesEl = null;
  let contextLabel = null;
  let agentsList = [];

  // Agent settings modal state
  let currentAgentId = null;
  let originalAgentConfig = null;
  let availableRoles = [];

  // --- Constants ---
  const PROVIDER_COLORS = {
    antigravity: 'provider-antigravity',
    claude: 'provider-claude',
    codex: 'provider-codex',
    gemini: 'provider-gemini',
    ollama: 'provider-ollama',
    llama: 'provider-llama',
    opencode: 'provider-ollama'  // opencode mapped to ollama styling
  };

  // Only actions with real enforcement behind them. conversation:respond
  // (mapped to "any agent"), research:web, and research:codebase had zero
  // enforcement sites — checkboxes for them were decorative and were removed
  // rather than shipped as placebo controls.
  const KNOWN_ACTIONS = [
    'code:execute',   // bypass flags + execution filtering
    'task:plan',      // planner eligibility
    'task:execute',   // subtask pickup eligibility
    'code:review',    // reviewer selection (grant = preferred, deny = excluded)
  ];

  // --- Badge Management Functions ---

  function initAgentBadges(agentList) {
    // No-arg call = re-render from the cached list. The delete handler used
    // to call this bare, and `[...undefined]` below threw "agentList is not
    // iterable" — making every successful delete report as a failure.
    if (!Array.isArray(agentList)) agentList = agentsList || [];
    agentsList = agentList || [];
    const escapeHtml = getEscapeHtml();
    const inferProviderFromAgent = getInferProvider();

    const BADGE_ORDER = ['ollama', 'claude', 'codex', 'gemini'];
    const badgeRank = a => {
      const provider = (a.provider || inferProviderFromAgent(a.id, a.model)).toLowerCase();
      const i = BADGE_ORDER.indexOf(provider);
      return i === -1 ? 99 : i;
    };

    agentList = [...agentList].filter(a => !(a.id || '').toLowerCase().startsWith('governor') && a.role !== 'governor').sort((a, b) => badgeRank(a) - badgeRank(b));

    // Strip scaling tiers (Block #17). The strip stays a constant header
    // height; layout adapts to count via these classes (see layout.css):
    //   ≤20    → no extra class (1-row, full badge)
    //   21-40  → .compact (2-row stack, model hidden)
    //   41-66  → .compact.triple (3-row stack, 11px name)
    //   67-72  → + .dense (65px badge width)
    //   73+    → + .very-dense (55px badge width)
    const n = agentList.length;
    badgesEl.classList.toggle('compact', n > 20);
    badgesEl.classList.toggle('triple', n > 40);
    badgesEl.classList.toggle('dense', n > 66);
    badgesEl.classList.toggle('very-dense', n > 72);

    badgesEl.innerHTML = '';

    for (const a of agentList) {
      const badge = document.createElement('div');
      const provider = (a.provider || inferProviderFromAgent(a.id, a.model)).toLowerCase();
      const provClass = PROVIDER_COLORS[provider] || '';
      // Initial-paint lifecycle classification — must match the cases in
      // refreshAgentHealth() so the first paint and the next health tick agree.
      // /api/agents.status is the runtime _status (api.js:1578).
      let lifecycleCls, dotClass, titleStatus;
      switch (a.status) {
        case 'inactive':   lifecycleCls = 'unavailable'; dotClass = 'unavailable'; titleStatus = 'inactive'; break;
        case 'failed':     lifecycleCls = 'failed';      dotClass = 'failed';      titleStatus = a.lastValidationError ? `failed: ${a.lastValidationError}` : 'failed'; break;
        case 'paused':     lifecycleCls = 'paused';      dotClass = 'paused';      titleStatus = 'paused'; break;
        case 'registered': lifecycleCls = 'registered';  dotClass = 'registered';  titleStatus = 'starting'; break;
        default:           lifecycleCls = '';            dotClass = 'idle';        titleStatus = 'idle';
      }
      badge.className = `agent-badge ${provClass}${lifecycleCls ? ' ' + lifecycleCls : ''}`;
      badge.innerHTML = `<div class="badge-text"><span class="badge-name">${escapeHtml(a.name)}</span><span class="status-bar ${dotClass}"></span><span class="badge-model">${shortModel(a.model, a.provider, a.displayModel)}</span></div>`;
      badge.id = `badge-${a.id}`;
      badge.title = `${a.name} — ${a.model} — ${titleStatus}`;
      badge.dataset.agentId = a.id;

      badge.style.cursor = 'pointer';
      badge.addEventListener('click', () => openAgentSettings(a));
      badge.addEventListener('contextmenu', (e) => { e.preventDefault(); showBadgeMenu(e, a); });

      badgesEl.appendChild(badge);
      agentBadges[a.name.toLowerCase()] = badge;
      agentBadges[a.name] = badge;
      agentModels[a.name.toLowerCase()] = a.model;
      agentModels[a.name] = a.model;
      agentDisplayModels[a.name.toLowerCase()] = a.displayModel || null;
      agentDisplayModels[a.name] = a.displayModel || null;
      agentDisplayModels[a.id] = a.displayModel || null;  // routing event uses id
      agentProviders[a.name.toLowerCase()] = a.provider || null;
      agentProviders[a.name] = a.provider || null;
      agentProviders[a.id] = a.provider || null;
      agentColors[a.name] = a.color;
      agentColors[a.name.toLowerCase()] = a.color;
    }
    refreshAgentHealth();
  }

  let activeMenu = null;
  document.addEventListener('click', () => { if (activeMenu) { activeMenu.remove(); activeMenu = null; } });

  function showBadgeMenu(e, agent) {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
    const af = getAuthFetch();
    if (!af) return;
    const menu = document.createElement('div');
    menu.className = 'badge-menu';
    const agentId = agent.id;
    const badge = document.getElementById(`badge-${agentId}`);
    const bar = badge?.querySelector('.status-bar');
    const status = bar ? (bar.classList.contains('thinking') ? 'thinking' : bar.classList.contains('unavailable') ? 'inactive' : 'idle') : 'idle';
    const isPaused = badge?.classList.contains('paused');
    const isFailed = badge?.classList.contains('failed');
    const isInactive = status === 'inactive';

    // Menu shape follows the agent's lifecycle state. Failed agents have
    // a different action vocabulary than running ones — Pause/Deactivate
    // are nonsense for an agent that isn't running, and the user's actual
    // path is fix-via-Settings (Block #14's settings-save retry) or give
    // up via Delete (Block #19).
    const items = [];
    if (isFailed) {
      items.push({ label: 'Settings', action: 'settings' });
      items.push({ label: 'Delete', action: 'delete', cls: 'danger' });
    } else {
      if (isPaused) {
        items.push({ label: 'Resume', action: 'resume' });
      } else if (status !== 'inactive') {
        items.push({ label: 'Pause', action: 'pause' });
      }
      if (isInactive) {
        items.push({ label: 'Activate', action: 'activate' });
      } else {
        items.push({ label: 'Deactivate', action: 'deactivate', cls: 'danger' });
      }
      items.push({ label: 'Settings', action: 'settings' });
    }

    for (const item of items) {
      const btn = document.createElement('button');
      btn.className = `badge-menu-item ${item.cls || ''}`;
      btn.textContent = item.label;
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        menu.remove();
        activeMenu = null;
        if (item.action === 'settings') { openAgentSettings(agent); return; }
        if (item.action === 'delete') {
          if (!confirm(`Delete agent "${agent.name || agent.id}"? This cannot be undone.`)) return;
          try {
            const res = await af(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            // agents_updated WS broadcast handles strip refresh.
          } catch (err) {
            console.warn('Agent delete failed:', err);
            getShowToast()?.(`Failed to delete ${agent.name || agentId}: ${err.message}`, 'error');
          }
          return;
        }
        if (await requestAgentAction(agentId, item.action)) refreshAgentHealth();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    activeMenu = menu;
    const rect = badge?.getBoundingClientRect();
    if (rect) {
      menu.style.top = (rect.bottom + 4) + 'px';
      menu.style.left = Math.min(rect.left, window.innerWidth - 170) + 'px';
    }
  }

  async function refreshAgentHealth() {
    const authFetch = getAuthFetch();
    if (!authFetch) return;

    try {
      const res = await authFetch('/api/health');
      if (!res.ok) return;
      const health = await res.json();
      if (!health.agents) return;

      // Sync the header Pause All / Resume All toggle with reality — it
      // previously only tracked its own clicks, so a page load into an
      // all-paused system showed "Pause All" and the first click no-opped.
      const agentEntries = Object.values(health.agents);
      if (agentEntries.length > 0 && window.SynapseSettings?.updateAllPauseButton) {
        window.SynapseSettings.updateAllPauseButton(agentEntries.every(a => a.status === 'paused'));
      }
      // Alerts panel piggybacks on the same refresh cadence — its
      // refreshAlerts() previously had zero callers and rendered empty forever.
      window.SynapseHealth?.refreshAlerts?.();

      for (const [id, info] of Object.entries(health.agents)) {
        const badge = document.getElementById(`badge-${id}`);
        if (!badge) continue;
        const bar = badge.querySelector('.status-bar');
        if (bar) {
          bar.className = 'status-bar';
          bar.innerHTML = '';
          // _status (lifecycle) takes priority over status (operational) —
          // a failed agent is failed regardless of what its routine is doing.
          if (info._status === 'inactive') {
            bar.classList.add('unavailable');
          } else if (info._status === 'failed') {
            bar.classList.add('failed');
          } else if (info._status === 'paused') {
            bar.classList.add('paused');
          } else if (info._status === 'registered') {
            bar.classList.add('registered');
          } else if (info.status === 'thinking') {
            bar.classList.add('thinking');
          } else if (info.status.startsWith('rate_limited')) {
            const isSoft = info.status.includes('(est.)');
            bar.classList.add(isSoft ? 'rate_limited_soft' : 'rate_limited', 'has-label');
            let label;
            if (isSoft) {
              const m = info.status.match(/rate_limited\s+(~\S+)/);
              label = m ? m[1] : '~?';
            } else {
              const m = info.status.match(/\(([^)]+)\)/);
              label = m ? m[1] : 'rl';
            }
            bar.innerHTML = `<span class="bar-half"></span><span class="bar-label">${label}</span><span class="bar-half"></span>`;
          } else if (info.status.startsWith('fallback')) {
            const fm = info.status.match(/(\d+[mhds])/);
            if (fm) {
              bar.classList.add('fallback', 'has-label');
              bar.innerHTML = `<span class="bar-half"></span><span class="bar-label">${fm[1]}</span><span class="bar-half"></span>`;
            } else {
              bar.classList.add('fallback');
            }
          } else {
            bar.classList.add('idle');
          }
        }
        badge.classList.toggle('unavailable', info._status === 'inactive');
        badge.classList.toggle('failed', info._status === 'failed');
        badge.classList.toggle('paused', info._status === 'paused');
        badge.classList.toggle('registered', info._status === 'registered');
        const isRateLimited = info.status.startsWith('rate_limited') || info.status.startsWith('fallback');
        const isSoftLimit = info.status.startsWith('rate_limited') && info.status.includes('(est.)');
        badge.classList.toggle('rate-limited-soft', isSoftLimit);
        badge.classList.toggle('rate-limited', isRateLimited && !isSoftLimit);
        // Title shows lifecycle state when notable; otherwise operational status.
        // For failed agents, append the validation error so hover answers "why?".
        let titleStatus;
        if (info._status === 'failed') {
          titleStatus = info.lastValidationError ? `failed: ${info.lastValidationError}` : 'failed';
        } else if (info._status === 'paused') {
          titleStatus = 'paused';
        } else if (info._status === 'registered') {
          titleStatus = 'starting';
        } else if (info._status === 'inactive') {
          titleStatus = 'inactive';
        } else {
          titleStatus = info.status;
        }
        // Show the user's display name, not the lowercased route id (Block #18).
        // initAgentBadges renders title with a.name; this path overrides on
        // every health tick and was reverting case ("DataAnalyst" → "dataanalyst").
        const displayName = agentsList.find(a => a.id === id)?.name || id;
        badge.title = `${displayName} — ${info.model} — ${titleStatus}`;
      }

      // Sandbox info
      if (health.sandbox && health.sandbox.enabled) {
        const procs = health.sandbox.activeProcesses || 0;
        const max = health.sandbox.maxConcurrent || 0;
        if (contextLabel && procs > 0) {
          contextLabel.textContent = `${procs}/${max} processes`;
        } else if (contextLabel && contextLabel.textContent.includes('processes')) {
          contextLabel.textContent = '';
        }
      }
    } catch (e) {
      // Silently ignore health check errors
    }
  }

  function shortModel(model, provider, displayModel) {
    if (displayModel) return displayModel;
    if (!model) return '';
    if (model === 'auto' && provider === 'gemini') return 'gem-3-auto';
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
      .replace(/Qwen[\d.]*-(\d+B)(?:-[A-Z0-9]+)?-UD-.*\.gguf/i, 'Qwen 3.5 $1')
      .replace(/\.gguf$/i, '')
      .replace('gemini-', 'gem-')
      .replace('llama-3.3-70b', 'Llama 3.3 70B')
      .replace('qwen2.5-coder-32b', 'Qwen2.5 32B')
      .replace('deepseek-r1:70b', 'DeepSeek R1 70B')
      .replace('deepseek-r1:32b', 'DeepSeek R1 32B')
      .replace('deepseek-r1:14b', 'DeepSeek R1 14B')
      .replace('deepseek-r1:8b', 'DeepSeek R1 8B')
      .replace('deepseek-r1:7b', 'DeepSeek R1 7B')
      .replace('deepseek-r1:1.5b', 'DeepSeek R1 1.5B');
  }

  function updateBadgeModel(agentName, newModel, newProvider, newDisplayModel) {
    const badge = agentBadges[agentName] || agentBadges[agentName.toLowerCase()];
    if (!badge) return;
    // Fall back to cached displayModel/provider when the caller (e.g. `routing` WebSocket event)
    // only passes (agentName, model). Without this, cached displayModel overrides like
    // "MyLocal-27B" get clobbered by the raw-model regex chain on every routing update.
    const displayModel = newDisplayModel ?? agentDisplayModels[agentName] ?? agentDisplayModels[agentName.toLowerCase()] ?? null;
    const provider = newProvider ?? agentProviders[agentName] ?? agentProviders[agentName.toLowerCase()] ?? null;
    const modelSpan = badge.querySelector('.badge-model');
    if (modelSpan) {
      modelSpan.textContent = shortModel(newModel, provider, displayModel);
    }
    agentModels[agentName] = newModel;
    agentModels[agentName.toLowerCase()] = newModel;
  }

  function updateAgentStatus(speaker, status) {
    const appendSystem = getAppendSystem();
    const dismissSystem = getDismissSystem();
    const badge = agentBadges[speaker] || agentBadges[speaker.toLowerCase()];
    if (!badge) return;
    const transientKey = `agent-status:${speaker.toLowerCase()}`;

    badge.classList.remove('thinking', 'executing', 'active', 'rate-limited', 'timed-out', 'fallback');
    const dot = badge.querySelector('.status-dot');
    if (dot) {
      dot.className = 'status-dot';
      dot.classList.add(
        status === 'thinking' ? 'thinking' :
        status === 'rate_limited' ? 'rate_limited' :
        status === 'fallback' ? 'rate_limited' :
        'idle'
      );
    }

    if (status === 'thinking') {
      badge.classList.add('thinking');
      if (appendSystem) appendSystem(`${speaker} is thinking...`, null, { transientKey });
    } else if (status === 'executing') {
      badge.classList.add('executing');
      if (appendSystem) appendSystem(`${speaker} is executing...`, null, { transientKey });
    } else if (status === 'passed') {
      if (dismissSystem) dismissSystem(transientKey);
      badge.classList.add('active');
    } else if (status === 'fallback') {
      if (dismissSystem) dismissSystem(transientKey);
      badge.classList.add('fallback');
    } else if (status === 'rate_limited') {
      if (dismissSystem) dismissSystem(transientKey);
      badge.classList.add('rate-limited');
    } else if (status === 'timeout') {
      if (dismissSystem) dismissSystem(transientKey);
      badge.classList.add('timed-out');
      if (appendSystem) appendSystem(`${speaker} timed out`);
    } else if (status === 'error') {
      if (dismissSystem) dismissSystem(transientKey);
      badge.classList.add('active');
      if (appendSystem) appendSystem(`${speaker} encountered an error`);
    } else {
      if (dismissSystem) dismissSystem(transientKey);
      badge.classList.add('active');
    }
  }

  // --- Agent Settings Modal Functions ---

  async function openAgentSettings(agent) {
    const authFetch = getAuthFetch();
    const openModal = getOpenModal();
    const showToast = getShowToast();

    if (!authFetch || !openModal) {
      console.error('Dependencies not loaded');
      return;
    }

    const isCreateMode = !agent;
    currentAgentId = agent?.id || null;

    const tplSection = document.getElementById('agent-template-section');
    const tplSelect = document.getElementById('agent-template-select');
    const deleteBtn = document.getElementById('agent-settings-delete-btn');
    const templateBtn = document.getElementById('agent-settings-template-btn');
    const statusSection = document.getElementById('agent-status-section');
    const toggleBtn = document.getElementById('agent-header-toggle');
    const pauseBtn = document.getElementById('agent-header-pause');

    if (deleteBtn) deleteBtn.style.display = isCreateMode ? 'none' : '';
    if (templateBtn) templateBtn.style.display = isCreateMode ? 'none' : '';
    // Status section (Pause/Deactivate) is hidden in create mode AND for
    // failed agents — same vocabulary rule as the right-click menu (Block
    // #19): a failed agent's path is fix-via-Settings (save retries) or
    // Delete (bottom bar), not Pause/Deactivate. Real visibility is set
    // below once we know the agent's status.
    if (statusSection) statusSection.style.display = isCreateMode ? 'none' : '';

    // Update Save button label so create mode reads as "Create Agent" not
    // "Save Changes" (the latter implies an existing agent is being edited).
    const saveBtn = document.getElementById('agent-settings-save-btn');
    if (saveBtn) saveBtn.textContent = isCreateMode ? 'Create Agent' : 'Save Changes';

    if (!isCreateMode && agent) {
      const af = getAuthFetch();
      let agentStatus = 'idle';
      if (af) {
        try {
          const hRes = await af('/api/health');
          if (hRes.ok) {
            const hData = await hRes.json();
            const aInfo = hData.agents?.[agent.id];
            if (aInfo) agentStatus = aInfo._status || aInfo.status || 'idle';
          }
        } catch {}
      }
      const isInactive = agentStatus === 'inactive';
      const isPaused = agentStatus === 'paused';
      const isFailed = agentStatus === 'failed';
      // Hide Pause/Deactivate row entirely for failed agents — Delete button
      // at the bottom of the modal handles their action vocabulary.
      if (statusSection) statusSection.style.display = isFailed ? 'none' : '';
      if (toggleBtn) {
        toggleBtn.textContent = isInactive ? 'Activate' : 'Deactivate';
        toggleBtn.className = `badge-menu-item ${isInactive ? '' : 'danger'}`;
        toggleBtn.onclick = async () => {
          const endpoint = isInactive ? 'activate' : 'deactivate';
          // keep the modal open on failure — the state didn't change
          if (!(await requestAgentAction(agent.id, endpoint))) return;
          closeAgentSettings();
          setTimeout(() => { if (window.SynapseAgents?.refreshAgentHealth) window.SynapseAgents.refreshAgentHealth(); }, 500);
        };
      }
      if (pauseBtn) {
        pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
        pauseBtn.onclick = async () => {
          const endpoint = isPaused ? 'resume' : 'pause';
          if (!(await requestAgentAction(agent.id, endpoint))) return;
          closeAgentSettings();
          setTimeout(() => { if (window.SynapseAgents?.refreshAgentHealth) window.SynapseAgents.refreshAgentHealth(); }, 500);
        };
      }
    }

    if (isCreateMode && tplSection && tplSelect) {
      tplSection.style.display = '';
      tplSelect.innerHTML = '<option value="">-- Select a template --</option>';
      try {
        const af = getAuthFetch();
        const res = await af('/api/agent-templates');
        if (res.ok) {
          const templates = await res.json();
          for (const t of templates) {
            const opt = document.createElement('option');
            opt.value = JSON.stringify(t);
            opt.textContent = `${t.name} (${t.provider}${t.model ? ', ' + t.model : ''})`;
            tplSelect.appendChild(opt);
          }
        }
      } catch {}
      // Template delete (P5): the DELETE route existed with no UI — templates
      // could only accumulate. Button acts on the currently selected template.
      let tplDeleteBtn = document.getElementById('agent-template-delete-btn');
      if (!tplDeleteBtn) {
        tplDeleteBtn = document.createElement('button');
        tplDeleteBtn.id = 'agent-template-delete-btn';
        tplDeleteBtn.type = 'button';
        tplDeleteBtn.className = 'badge-menu-item danger';
        tplDeleteBtn.textContent = 'Delete template';
        tplDeleteBtn.style.cssText = 'margin-top:4px;display:none';
        tplSelect.insertAdjacentElement('afterend', tplDeleteBtn);
      }
      tplDeleteBtn.style.display = 'none';
      tplDeleteBtn.onclick = async () => {
        const val = tplSelect.value;
        if (!val) return;
        const t = JSON.parse(val);
        if (!t.id) { getShowToast()?.('Template has no id — cannot delete', 'error'); return; }
        if (!confirm(`Delete template "${t.name}"?`)) return;
        const af2 = getAuthFetch();
        try {
          const dres = await af2(`/api/agent-templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
          if (!dres.ok) throw new Error('HTTP ' + dres.status);
          tplSelect.querySelector(`option[value=${CSS.escape(val)}]`)?.remove();
          tplSelect.value = '';
          tplDeleteBtn.style.display = 'none';
          getShowToast()?.(`Template "${t.name}" deleted`, 'success');
        } catch (e) { getShowToast()?.(`Template delete failed: ${e.message}`, 'error'); }
      };
      tplSelect.onchange = () => {
        const val = tplSelect.value;
        tplDeleteBtn.style.display = val ? '' : 'none';
        if (!val) return;
        const t = JSON.parse(val);
        const nameField = document.getElementById('agent-field-name');
        const modelField = document.getElementById('agent-field-model');
        const providerField = document.getElementById('agent-field-provider');
        const roleField = document.getElementById('agent-field-role');
        const cliPathField = document.getElementById('agent-field-clipath');
        const cliArgsField = document.getElementById('agent-field-cliargs');
        const harnessOptionsField = document.getElementById('agent-field-harnessoptions');
        if (nameField) nameField.value = t.name || '';
        if (modelField) modelField.value = t.model || '';
        if (providerField) providerField.value = t.provider || '';
        if (roleField) roleField.value = t.role || '';
        if (cliPathField) cliPathField.value = t.cliPath || '';
        if (cliArgsField) cliArgsField.value = Array.isArray(t.cliArgs) ? t.cliArgs.join(', ') : (t.cliArgs || '');
        if (harnessOptionsField) harnessOptionsField.value = t.harnessOptions ? JSON.stringify(t.harnessOptions, null, 2) : '';
        updateSaveButtonState();
      };
    } else if (tplSection) {
      tplSection.style.display = 'none';
    }

    // Set header info
    const header = document.getElementById('agent-settings-header');
    if (header) {
      if (isCreateMode) {
        header.className = 'agent-settings-header provider-new';
      } else {
        header.className = `agent-settings-header provider-${agent.provider}`;
      }
    }

    const nameEl = document.getElementById('agent-settings-name');
    const providerEl = document.getElementById('agent-settings-provider');
    const modelEl = document.getElementById('agent-settings-model');

    if (nameEl) nameEl.textContent = isCreateMode ? 'Create New Agent' : agent.name;
    if (providerEl) {
      if (isCreateMode) {
        providerEl.textContent = 'New Agent';
        providerEl.className = 'provider-badge provider-new';
      } else {
        providerEl.textContent = agent.provider;
        providerEl.className = `provider-badge provider-${agent.provider}`;
      }
    }
    if (modelEl) modelEl.textContent = isCreateMode ? 'Select Model' : (agent.model || 'Default');

    // Fetch providers and roles
    try {
      const [providersRes, rolesRes] = await Promise.all([
        authFetch('/api/providers'),
        authFetch('/api/roles'),
      ]);

      if (!providersRes.ok) throw new Error('Failed to fetch providers');
      const providers = await providersRes.json();

      if (!rolesRes.ok) throw new Error('Failed to fetch roles');
      const roles = await rolesRes.json();

      // Populate provider dropdown
      const providerField = document.getElementById('agent-field-provider');
      if (providerField) {
        if (isCreateMode) {
          providerField.disabled = false;
          providerField.value = providers[0]?.id || '';
        } else {
          providerField.disabled = true;
          providerField.value = agent.provider;
        }
      }

      // For create mode, use empty config
      if (isCreateMode) {
        originalAgentConfig = null;
        populateAgentSettingsPanel({}, roles, providers);
      } else {
        // Fetch full config
        const configRes = await authFetch(`/api/agents/${currentAgentId}/config`);
        if (!configRes.ok) throw new Error('Failed to fetch agent config');
        const config = await configRes.json();
        originalAgentConfig = config;
        populateAgentSettingsPanel(config, roles, providers);
      }
    } catch (err) {
      console.error('Error loading agent settings:', err);
      if (showToast) showToast('Error loading agent settings: ' + err.message, 'error');
      return;
    }

    openModal('modal-agent-settings');
  }

  function populateAgentSettingsPanel(config, roles, providers = []) {
    const escapeHtml = getEscapeHtml();

    // Clear validation errors from previous modal opens
    clearAllFieldErrors();

    // Store available roles for validation
    availableRoles = roles && Object.keys(roles).length > 0 ? Object.keys(roles) : [];

    // Validation banner — shows the last probe/smoke-test failure reason
    const banner = document.getElementById('agent-validation-banner');
    const bannerText = document.getElementById('agent-validation-banner-text');
    if (banner && bannerText) {
      if (config.lastValidationError) {
        bannerText.textContent = ' ' + config.lastValidationError;
        banner.style.display = 'block';
      } else {
        banner.style.display = 'none';
        bannerText.textContent = '';
      }
    }

    // Basic Info
    const nameField = document.getElementById('agent-field-name');
    const modelField = document.getElementById('agent-field-model');
    const displayModelField = document.getElementById('agent-field-displaymodel');
    const providerField = document.getElementById('agent-field-provider');
    const colorField = document.getElementById('agent-field-color');

    if (nameField) nameField.value = config.name || '';
    if (modelField) modelField.value = config.model || '';
    if (displayModelField) displayModelField.value = config.displayModel || '';
    if (providerField) {
      // Populate provider dropdown in create mode. /api/providers already
      // returns descriptor-backed BYOH harnesses (alongside the bespoke 4)
      // because of CREATABLE in api.js — so adding a new harness via
      // descriptor automatically lights up this dropdown without code changes.
      // Populate options in BOTH modes — edit mode previously assigned
      // providerField.value against an empty <select> (index.html ships no
      // <option>s), so opening an existing agent showed a blank Harness.
      if (providers && providers.length > 0) {
        providerField.innerHTML = '';
        for (const p of providers) {
          const option = document.createElement('option');
          option.value = p.id;
          // Prefer descriptor label when present (e.g. "Aider", "Grok Build") —
          // falls back to provider id for the bespoke 4 (claude/codex/gemini/opencode).
          option.textContent = p.label && p.label !== p.id ? `${p.label} (${p.id})` : p.id;
          providerField.appendChild(option);
        }
      }
      if (providers && providers.length > 0 && !config.provider) {
        providerField.disabled = false;

        // Auto-fill model + color when the user changes harness selection.
        // Lets descriptor defaults surface without operator typing the model name.
        // Bound once; the inline-handler avoids leaking listeners across modal opens
        // because populateAgentSettingsPanel runs each time.
        const onHarnessChange = () => {
          const selected = providers.find(p => p.id === providerField.value);
          const modelField = document.getElementById('agent-field-model');
          const colorField = document.getElementById('agent-field-color');
          if (selected?.defaultModel && modelField && !modelField.value.trim()) {
            modelField.value = selected.defaultModel;
          }
          if (selected?.defaultColor && colorField) {
            colorField.value = selected.defaultColor;
          }
        };
        providerField.onchange = onHarnessChange;
        // Trigger once so the initial selection prefills (model field is empty in create mode).
        onHarnessChange();
      } else {
        // Ensure the agent's provider is selectable even if it's not in the
        // current /api/providers list (legacy or removed harness).
        if (config.provider && ![...providerField.options].some(o => o.value === config.provider)) {
          const opt = document.createElement('option');
          opt.value = config.provider;
          opt.textContent = config.provider;
          providerField.appendChild(opt);
        }
        providerField.value = config.provider || '';
        providerField.disabled = true;
        providerField.onchange = null;
      }
    }
    if (colorField) colorField.value = config.color || '#888888';

    // Role
    const roleSelect = document.getElementById('agent-field-role');
    if (roleSelect) {
      roleSelect.innerHTML = '<option value="">No role</option>';
      if (roles && Object.keys(roles).length > 0) {
        for (const roleName of Object.keys(roles)) {
          const option = document.createElement('option');
          option.value = roleName;
          option.textContent = roleName;
          if (config.role === roleName) option.selected = true;
          roleSelect.appendChild(option);
        }
      }
    }

    // Permissions checkboxes
    const permissionsGroup = document.getElementById('agent-permissions-group');
    if (permissionsGroup) {
      permissionsGroup.innerHTML = '<span class="field-hint" style="grid-column: 1/-1; margin-top: 4px;">Grant actions beyond the role’s defaults. Leaving all unchecked inherits the role’s permissions.</span>';
      // Always render — the old `if (config.permissions)` guard hid the
      // checkboxes entirely for agents inheriting from their role (the
      // common case), making customization unreachable.
      {
        const currentPerms = Array.isArray(config.permissions) ? config.permissions : [];
        for (const action of KNOWN_ACTIONS) {
          const item = document.createElement('div');
          item.className = 'agent-settings-checkbox-item';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.id = `perm-${action}`;
          checkbox.value = action;
          checkbox.checked = currentPerms.includes(action);
          checkbox.addEventListener('change', () => {
            validateField('permissions');
            updateSaveButtonState();
          });
          const label = document.createElement('label');
          label.htmlFor = `perm-${action}`;
          label.className = 'checkbox-label';
          label.textContent = action.replace(':', ' ').replace(/([A-Z])/g, ' $1').trim();
          item.appendChild(checkbox);
          item.appendChild(label);
          permissionsGroup.appendChild(item);
        }
      }
    }

    // Deny Actions checkboxes
    const denyActionsGroup = document.getElementById('agent-denyactions-group');
    if (denyActionsGroup) {
      denyActionsGroup.innerHTML = '<span class="field-hint" style="grid-column: 1/-1; margin-top: 4px;">Select actions to explicitly block (overrides role permissions)</span>';
      {
        const currentDeny = Array.isArray(config.denyActions) ? config.denyActions : [];
        for (const action of KNOWN_ACTIONS) {
          const item = document.createElement('div');
          item.className = 'agent-settings-checkbox-item';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.id = `deny-${action}`;
          checkbox.value = action;
          checkbox.checked = currentDeny.includes(action);
          checkbox.addEventListener('change', () => {
            validateField('denyactions');
            updateSaveButtonState();
          });
          const label = document.createElement('label');
          label.htmlFor = `deny-${action}`;
          label.className = 'checkbox-label';
          label.textContent = action.replace(':', ' ').replace(/([A-Z])/g, ' $1').trim();
          item.appendChild(checkbox);
          item.appendChild(label);
          denyActionsGroup.appendChild(item);
        }
      }
    }

    // Skills. Clearing and input wiring run UNCONDITIONALLY — the old
    // `config.skills` guard (a) left the previous agent's tags in the DOM
    // (which were then submitted onto the next agent saved) and (b) never
    // bound the Enter/comma handler in create mode, so new agents could not
    // be given skills at all. onkeydown assignment (not addEventListener)
    // keeps re-opens idempotent.
    const skillsContainer = document.getElementById('agent-skills-container');
    const skillsInput = document.getElementById('agent-skills-input');
    if (skillsContainer && skillsInput) {
      skillsContainer.querySelectorAll('.agent-settings-tag').forEach(tag => tag.remove());
      skillsInput.value = '';

      for (const skill of (Array.isArray(config.skills) ? config.skills : [])) {
        addSkillTag(skill);
      }

      skillsInput.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const skill = skillsInput.value.trim();
          if (skill) {
            addSkillTag(skill);
            skillsInput.value = '';
            updateSaveButtonState();
          }
        }
      };
    }

    // Persona
    const personaField = document.getElementById('agent-field-persona');
    const personaFileField = document.getElementById('agent-field-personafile');
    if (personaField) personaField.value = config.persona || '';
    if (personaFileField) personaFileField.value = config.personaFile || '';

    // Timeouts & Limits
    const timeoutField = document.getElementById('agent-field-timeout');
    const sandboxLimitsField = document.getElementById('agent-field-sandboxlimits');
    if (timeoutField) timeoutField.value = config.timeout || 30000;
    if (sandboxLimitsField) {
      sandboxLimitsField.value = config.sandboxLimits ? JSON.stringify(config.sandboxLimits, null, 2) : '';
    }

    // Harness & CLI
    const cliPathField = document.getElementById('agent-field-clipath');
    const endpointField = document.getElementById('agent-field-endpoint');
    const baseUrlField = document.getElementById('agent-field-baseurl');
    const apiKeyEnvField = document.getElementById('agent-field-apikeyenv');
    const cliArgsField = document.getElementById('agent-field-cliargs');
    const harnessOptionsField = document.getElementById('agent-field-harnessoptions');
    if (cliPathField) cliPathField.value = config.cliPath || '';
    if (endpointField) endpointField.value = config.endpoint || '';
    if (baseUrlField) baseUrlField.value = config.baseUrl || '';
    if (apiKeyEnvField) apiKeyEnvField.value = config.apiKeyEnv || '';
    if (cliArgsField) cliArgsField.value = Array.isArray(config.cliArgs) ? config.cliArgs.join(', ') : '';
    if (harnessOptionsField) harnessOptionsField.value = (config.harnessOptions && Object.keys(config.harnessOptions).length > 0) ? JSON.stringify(config.harnessOptions, null, 2) : '';

    // Bypass toggle. All handlers below use onX property assignment, not
    // addEventListener — populateAgentSettingsPanel runs on EVERY modal open
    // and addEventListener on these persistent nodes accumulated duplicates
    // (N opens → N handlers per keystroke, duplicate skill tags per Enter).
    const bypassCheckbox = document.getElementById('agent-bypass-checkbox');
    if (bypassCheckbox) {
      bypassCheckbox.checked = config.bypassCodeExecutionCheck || false;
      bypassCheckbox.onchange = updateSaveButtonState;
    }

    // Wire up field change handlers
    ['agent-field-name', 'agent-field-model', 'agent-field-displaymodel', 'agent-field-color',
     'agent-field-provider',
     'agent-field-persona', 'agent-field-personafile',
     'agent-field-timeout', 'agent-field-sandboxlimits',
     'agent-field-clipath', 'agent-field-endpoint', 'agent-field-baseurl', 'agent-field-apikeyenv',
     'agent-field-cliargs', 'agent-field-harnessoptions'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = updateSaveButtonState;
    });

    const roleField = document.getElementById('agent-field-role');
    if (roleField) {
      roleField.onchange = updateSaveButtonState;
      roleField.onblur = () => validateField('role');
    }

    // Wire up validation on blur
    if (nameField) nameField.onblur = () => validateField('name');
    if (modelField) modelField.onblur = () => validateField('model');
    if (timeoutField) timeoutField.onblur = () => validateField('timeout');
    if (colorField) colorField.onblur = () => validateField('color');

    updateSaveButtonState();
  }

  function addSkillTag(skill) {
    const container = document.getElementById('agent-skills-container');
    const input = document.getElementById('agent-skills-input');
    if (!container || !input) return;

    const tag = document.createElement('span');
    tag.className = 'agent-settings-tag';
    tag.textContent = skill;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'agent-settings-tag-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      tag.remove();
      updateSaveButtonState();
    });

    tag.appendChild(removeBtn);
    container.insertBefore(tag, input);
  }

  function updateSkillsFromTags() {
    const container = document.getElementById('agent-skills-container');
    if (!container) return [];
    const tags = container.querySelectorAll('.agent-settings-tag');
    return Array.from(tags).map(tag => tag.textContent.replace('×', '').trim());
  }

  function snapshotAgentForm() {
    // Not needed in current implementation - form data is read on-demand
  }

  function getChangedFields() {
    if (!originalAgentConfig) return {};
    const formData = getAgentSettingsFormData();
    const changes = {};

    for (const key in formData) {
      if (JSON.stringify(formData[key]) !== JSON.stringify(originalAgentConfig[key])) {
        changes[key] = formData[key];
      }
    }

    return changes;
  }

  function updateSaveButtonState() {
    const saveBtn = document.getElementById('agent-settings-save-btn');
    if (!saveBtn) return;

    // Create mode: enable as soon as the minimum required fields are filled.
    // getChangedFields() compares against originalAgentConfig which is null
    // during create — without this branch the button stays permanently
    // disabled and no agent can ever be created via the UI.
    if (!currentAgentId) {
      const formData = getAgentSettingsFormData();
      const providerVal = document.getElementById('agent-field-provider')?.value;
      const minimumFilled = !!(formData.name && formData.model && providerVal);
      saveBtn.disabled = !minimumFilled;
      return;
    }

    const changes = getChangedFields();
    const hasChanges = Object.keys(changes).length > 0;
    saveBtn.disabled = !hasChanges;
  }

  function getAgentSettingsFormData() {
    const sandboxValue = document.getElementById('agent-field-sandboxlimits')?.value.trim();
    let sandboxLimits = null;
    if (sandboxValue) {
      try {
        sandboxLimits = JSON.parse(sandboxValue);
      } catch (e) {
        sandboxLimits = null;
      }
    }

    const permissions = [];
    KNOWN_ACTIONS.forEach(action => {
      const checkbox = document.getElementById(`perm-${action}`);
      if (checkbox && checkbox.checked) permissions.push(action);
    });

    const denyActions = [];
    KNOWN_ACTIONS.forEach(action => {
      const checkbox = document.getElementById(`deny-${action}`);
      if (checkbox && checkbox.checked) denyActions.push(action);
    });

    return {
      name: document.getElementById('agent-field-name')?.value.trim(),
      model: document.getElementById('agent-field-model')?.value.trim(),
      displayModel: document.getElementById('agent-field-displaymodel')?.value.trim() || null,
      color: document.getElementById('agent-field-color')?.value,
      role: document.getElementById('agent-field-role')?.value || null,
      permissions: permissions.length > 0 ? permissions : null,
      denyActions: denyActions.length > 0 ? denyActions : null,
      skills: updateSkillsFromTags(),
      persona: document.getElementById('agent-field-persona')?.value.trim() || null,
      personaFile: document.getElementById('agent-field-personafile')?.value.trim() || null,
      timeout: parseInt(document.getElementById('agent-field-timeout')?.value, 10) || 30000,
      sandboxLimits,
      bypassCodeExecutionCheck: document.getElementById('agent-bypass-checkbox')?.checked || false,
      cliPath: document.getElementById('agent-field-clipath')?.value.trim() || null,
      endpoint: document.getElementById('agent-field-endpoint')?.value.trim() || null,
      baseUrl: document.getElementById('agent-field-baseurl')?.value.trim() || null,
      apiKeyEnv: document.getElementById('agent-field-apikeyenv')?.value.trim() || null,
      cliArgs: (document.getElementById('agent-field-cliargs')?.value.trim() || '').split(',').map(s => s.trim()).filter(Boolean),
      harnessOptions: (() => { try { return JSON.parse(document.getElementById('agent-field-harnessoptions')?.value.trim() || 'null'); } catch { return null; } })(),
    };
  }

  async function saveAgentSettings() {
    const authFetch = getAuthFetch();
    const closeModal = getCloseModal();
    const showToast = getShowToast();

    // Validate all fields
    if (!validateAllFields()) {
      if (showToast) showToast('Please fix validation errors before saving', 'error');
      return;
    }

    // JSON fields fail loudly here — getAgentSettingsFormData() coerces a
    // malformed value to null, which would silently WIPE the stored config
    // instead of erroring.
    for (const [fieldId, label] of [['agent-field-sandboxlimits', 'Sandbox Limits'], ['agent-field-harnessoptions', 'Harness Options']]) {
      const raw = document.getElementById(fieldId)?.value.trim();
      if (raw) {
        try { JSON.parse(raw); } catch {
          if (showToast) showToast(`${label} is not valid JSON — fix it or clear the field`, 'error');
          return;
        }
      }
    }

    const formData = getAgentSettingsFormData();

    // Refresh the badge strip from /api/agents and close the modal. Used for
    // both happy and post-create-failure paths so modal/server state can't
    // diverge: if the agent exists server-side, the user must see it.
    async function refreshAndClose() {
      try {
        const agentsResp = await authFetch('/api/agents');
        if (agentsResp.ok) {
          const agentList = await agentsResp.json();
          initAgentBadges(agentList);
        }
      } catch (e) {
        console.warn('Failed to refresh agents after save:', e);
      }
      if (closeModal) closeModal('modal-agent-settings');
    }

    // Format a validator error response into a single human-readable line.
    function formatErrorDetail(error) {
      if (!error) return '';
      const head = error.error || '';
      if (Array.isArray(error.details) && error.details.length > 0) {
        return head ? `${head}: ${error.details[0]}` : error.details[0];
      }
      return head;
    }

    try {
      // Determine if this is create or edit mode
      const isCreateMode = !currentAgentId;

      if (isCreateMode) {
        // Beta: every agent dispatches through a CLI harness. Synapse spawns
        // the harness binary; the harness owns its own provider connection
        // (auth, endpoint, API key) outside Synapse's config. So Synapse only
        // needs harness + model. The wrapper-HTTP path (LlamaAgent/GlmAgent)
        // is deferred past first beta — those fields stay in the data model
        // for back-compat but aren't surfaced via the create flow.
        const providerVal = document.getElementById('agent-field-provider')?.value;
        if (!formData.name || !providerVal || !formData.model) {
          showToast('Name, harness, and model are required', 'error');
          return;
        }
        const createResp = await authFetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...formData,
            id: formData.name.toLowerCase().replace(/\s+/g, '-'),
            provider: providerVal,
          }),
        });

        if (!createResp.ok) {
          const error = await createResp.json().catch(() => ({}));
          showToast(formatErrorDetail(error) || 'Failed to create agent', 'error');
          return;
        }

        const createdAgent = await createResp.json();
        currentAgentId = createdAgent.id;

        // Save config for new agent. The agent now EXISTS server-side, so any
        // failure from here must still leave the UI honest: show the badge,
        // close the modal, and tell the user the config patch didn't stick.
        const configResp = await authFetch(`/api/agents/${currentAgentId}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        });

        if (!configResp.ok) {
          const error = await configResp.json().catch(() => ({}));
          const detail = formatErrorDetail(error) || 'unknown error';
          showToast(`Agent ${createdAgent.id} created, but config patch failed (${detail}). Edit the agent to retry.`, 'error');
          await refreshAndClose();
          return;
        }
      } else {
        // Update existing agent config
        const resp = await authFetch(`/api/agents/${currentAgentId}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        });

        if (!resp.ok) {
          const error = await resp.json().catch(() => ({}));
          showToast(formatErrorDetail(error) || 'Failed to save agent settings', 'error');
          return;
        }
      }

      if (showToast) showToast('Agent settings saved successfully', 'success');
      await refreshAndClose();
    } catch (err) {
      console.error('Error saving agent settings:', err);
      if (showToast) showToast('Error saving agent settings: ' + err.message, 'error');
      // If we crashed mid-create (agent exists but PUT threw), still reconcile
      // the UI with reality — better to show the badge with a warning than
      // leave a phantom modal hiding a real agent.
      if (currentAgentId) {
        await refreshAndClose();
      }
    }
  }

  function closeAgentSettings() {
    const closeModal = getCloseModal();
    if (closeModal) closeModal('modal-agent-settings');
    resetAgentModalState();
  }

  // Called by modals.js closeModal() so Esc/backdrop closes reset the modal
  // state too — previously only the explicit Close button did, leaving
  // currentAgentId/originalAgentConfig/field errors to leak into the next open.
  function resetAgentModalState() {
    currentAgentId = null;
    originalAgentConfig = null;
    clearAllFieldErrors();
  }

  // --- Validation Functions ---

  function showFieldError(fieldName, errorMessage) {
    const errorEl = document.getElementById(`error-${fieldName}`);
    if (errorEl) {
      errorEl.textContent = errorMessage;
      errorEl.style.display = 'block';
    }
  }

  function clearFieldError(fieldName) {
    const errorEl = document.getElementById(`error-${fieldName}`);
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
  }

  function clearAllFieldErrors() {
    document.querySelectorAll('.field-error').forEach(el => {
      el.textContent = '';
      el.style.display = 'none';
    });
  }

  function validateName(name) {
    if (!name || name.trim() === '') {
      return 'Agent name is required';
    }
    // Mirrors agent-config-schema.js. 12 is the hard cap (≤8 displays cleanly
    // on the standard badge; 9-12 truncates with ellipsis + full name in
    // tooltip). Governors get 18 to fit "governor-<9-char>" convention.
    const trimmed = name.trim();
    const isGovernor = /^governor-/i.test(trimmed);
    const max = isGovernor ? 18 : 12;
    if (trimmed.length > max) {
      return `Agent name must be ${max} characters or fewer`;
    }
    return null;
  }

  function validateModel(model) {
    if (!model || model.trim() === '') {
      return 'Model is required';
    }
    return null;
  }

  function validateTimeout(timeout) {
    const num = parseInt(timeout, 10);
    if (isNaN(num) || num < 1000) {
      return 'Timeout must be at least 1000ms';
    }
    return null;
  }

  function validateColor(color) {
    if (!color || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return 'Color must be a valid hex code (e.g., #888888)';
    }
    return null;
  }

  function validateRole(role) {
    if (role && !availableRoles.includes(role)) {
      return `Invalid role. Available roles: ${availableRoles.join(', ')}`;
    }
    return null;
  }

  function validatePermissionsAndDenyActions(permissions, denyActions) {
    if (!permissions || !denyActions) return null;

    const overlap = permissions.filter(p => denyActions.includes(p));
    if (overlap.length > 0) {
      return `Cannot have same action in both permissions and deny actions: ${overlap.join(', ')}`;
    }
    return null;
  }

  function validateField(fieldName) {
    clearFieldError(fieldName);

    let error = null;

    if (fieldName === 'name') {
      const value = document.getElementById('agent-field-name')?.value;
      error = validateName(value);
    } else if (fieldName === 'model') {
      const value = document.getElementById('agent-field-model')?.value;
      error = validateModel(value);
    } else if (fieldName === 'timeout') {
      const value = document.getElementById('agent-field-timeout')?.value;
      error = validateTimeout(value);
    } else if (fieldName === 'color') {
      const value = document.getElementById('agent-field-color')?.value;
      error = validateColor(value);
    } else if (fieldName === 'role') {
      const value = document.getElementById('agent-field-role')?.value;
      error = validateRole(value);
    } else if (fieldName === 'permissions' || fieldName === 'denyactions') {
      const formData = getAgentSettingsFormData();
      error = validatePermissionsAndDenyActions(formData.permissions, formData.denyActions);
      if (error) {
        showFieldError('permissions', error);
        showFieldError('denyactions', error);
      }
      return error;
    }

    if (error) {
      showFieldError(fieldName, error);
    }

    return error;
  }

  function validateAllFields() {
    clearAllFieldErrors();

    const formData = getAgentSettingsFormData();
    let isValid = true;

    // Validate name
    const nameError = validateName(formData.name);
    if (nameError) {
      showFieldError('name', nameError);
      isValid = false;
    }

    // Validate model
    const modelError = validateModel(formData.model);
    if (modelError) {
      showFieldError('model', modelError);
      isValid = false;
    }

    // Validate timeout
    const timeoutError = validateTimeout(formData.timeout);
    if (timeoutError) {
      showFieldError('timeout', timeoutError);
      isValid = false;
    }

    // Validate color
    const colorError = validateColor(formData.color);
    if (colorError) {
      showFieldError('color', colorError);
      isValid = false;
    }

    // Validate role
    const roleError = validateRole(formData.role);
    if (roleError) {
      showFieldError('role', roleError);
      isValid = false;
    }

    // Validate permissions/denyActions overlap
    const overlapError = validatePermissionsAndDenyActions(formData.permissions, formData.denyActions);
    if (overlapError) {
      showFieldError('permissions', overlapError);
      showFieldError('denyactions', overlapError);
      isValid = false;
    }

    return isValid;
  }

  // --- Initialization ---

  function init() {
    badgesEl = document.getElementById('agent-badges');
    contextLabel = document.getElementById('context-label');

    // Start health polling
    setInterval(refreshAgentHealth, 15000);

    // Wire up agent settings panel buttons
    const closeBtn = document.getElementById('agent-settings-close-btn');
    const cancelBtn = document.getElementById('agent-settings-cancel-btn');
    const saveBtn = document.getElementById('agent-settings-save-btn');

    if (closeBtn) closeBtn.addEventListener('click', closeAgentSettings);
    if (cancelBtn) cancelBtn.addEventListener('click', closeAgentSettings);
    if (saveBtn) saveBtn.addEventListener('click', saveAgentSettings);

    const deleteBtn = document.getElementById('agent-settings-delete-btn');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      const af = getAuthFetch();
      if (!af || !currentAgentId) return;
      if (!confirm(`Delete agent "${currentAgentId}"? This cannot be undone.`)) return;
      try {
        const res = await af(`/api/agents/${encodeURIComponent(currentAgentId)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        closeAgentSettings();
        // Refetch so the deleted badge disappears — the old bare
        // initAgentBadges() call threw "agentList is not iterable" and made
        // every successful delete alert as a failure.
        try {
          const listRes = await af('/api/agents');
          if (listRes.ok) initAgentBadges(await listRes.json());
        } catch { /* agents_updated WS broadcast will repaint */ }
      } catch (e) { alert('Failed to delete: ' + e.message); }
    });

    const templateBtn = document.getElementById('agent-settings-template-btn');
    if (templateBtn) templateBtn.addEventListener('click', async () => {
      const af = getAuthFetch();
      if (!af || !currentAgentId) return;
      const agent = agentsList.find(a => a.id === currentAgentId);
      if (!agent) return;
      const tpl = { name: agent.name, provider: agent.provider, model: agent.model, color: agent.color, role: agent.role, skills: agent.skills || [], persona: agent.persona || null, cliPath: agent.cliPath || null, cliArgs: agent.cliArgs || null, harnessOptions: agent.harnessOptions || null };
      try {
        const res = await af('/api/agent-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tpl) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        alert('Template saved: ' + agent.name);
      } catch (e) { alert('Failed to save template: ' + e.message); }
    });
  }

  // --- Public API ---
  window.SynapseAgents = {
    get agentColors() { return agentColors; },
    get agentBadges() { return agentBadges; },
    get agentModels() { return agentModels; },
    initAgentBadges,
    refreshAgentHealth,
    requestAgentAction,
    resetAgentModalState,
    shortModel,
    updateBadgeModel,
    updateAgentStatus,
    openAgentSettings,
    populateAgentSettingsPanel,
    addSkillTag,
    updateSkillsFromTags,
    snapshotAgentForm,
    getChangedFields,
    updateSaveButtonState,
    getAgentSettingsFormData,
    saveAgentSettings,
    closeAgentSettings,
    showFieldError,
    clearFieldError,
    clearAllFieldErrors,
    validateName,
    validateModel,
    validateTimeout,
    validateColor,
    validateRole,
    validatePermissionsAndDenyActions,
    validateField,
    validateAllFields,
    init,
  };
})();
