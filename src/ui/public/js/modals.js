/**
 * @module modals.js
 * @domain Modal Management & Overlay System
 * @description Modal open/close infrastructure, webhooks, credentials,
 *   workflows, project/channel/agent creation forms.
 *
 * @namespace window.SynapseModals
 * @exports {
 *   openModal(id: string): void,
 *   closeModal(id: string): void,
 *   initWebhookEventsGrid(): void,
 *   refreshWebhookList(): void,
 *   refreshCredentialList(): void,
 *   deleteCredential(name: string): void,
 *   refreshWorkflowList(): void,
 *   loadWorkflowRuns(workflowId: string): void
 * }
 * @depends window.SynapseWebSocket.authFetch, wsSend
 *          window.SynapseInput.activeProject
 *          window.SynapseHealth.escapeHtml
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- Webhook Management State ---
  // Keep in sync with VALID_EVENTS in src/orchestrator/webhooks-store.js.
  const WEBHOOK_EVENTS = ['message', 'session:start', 'session:end', 'agent:dispatch', 'vote:completed', 'project:created', 'channel:created', 'agents:updated', 'task:created', 'task:status_changed', 'task:completed', 'campaign:created', 'campaign:status_changed', 'campaign:milestone_completed', 'campaign:paused', 'campaign:resumed', 'schedule:fired', 'thread:created', 'alert:firing', 'alert:resolved', 'alert:sla_breach', 'alert:sla_resolved', 'timeline:insert', '*'];
  let selectedWhEvents = new Set();

  // --- Focus Management State ---
  // Store the previously focused element for each modal so we can restore focus on close
  const modalPreviousFocus = new Map();

  // --- Functions ---
  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;

    // Store previously focused element for focus restoration on close
    modalPreviousFocus.set(id, document.activeElement);

    el.classList.add('visible');

    // Delegation logic (consistent with ModalBase)
    if (window.SynapseModalBase) {
      window.SynapseModalBase.applyScrollLock();
    } else {
      document.body.style.overflow = 'hidden';
    }

    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');

    // Try to find a title for ARIA
    const title = el.querySelector('h1, h2, h3, .modal-title');
    if (title && !el.getAttribute('aria-labelledby')) {
      if (!title.id) title.id = id + '-title';
      el.setAttribute('aria-labelledby', title.id);
    }

    // Focus first input or button
    const firstInput = el.querySelector('input, button, select, textarea');
    if (firstInput) firstInput.focus();
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('visible');

    // Restore scroll if no other modals are open
    if (window.SynapseModalBase) {
      window.SynapseModalBase.removeScrollLock();
    } else {
      const allModals = document.querySelectorAll('.modal-overlay.visible');
      if (allModals.length === 0) {
        document.body.style.overflow = '';
      }
    }

    // Restore focus to the element that had focus before the modal opened
    const previousElement = modalPreviousFocus.get(id);
    if (previousElement && typeof previousElement.focus === 'function') {
      previousElement.focus();
    }
    modalPreviousFocus.delete(id);

    // Agent-settings modal keeps per-open state (currentAgentId, original
    // config, field errors) — reset it on EVERY close path, not just the
    // explicit Close button (Esc/backdrop used to leak it into the next open).
    if (id === 'modal-agent-settings') {
      window.SynapseAgents?.resetAgentModalState?.();
    }
  }

  /**
   * Focus trap handler for Tab/Shift+Tab within a modal.
   * Cycles through focusable elements, matching the pattern in modal-base.js
   * @param {KeyboardEvent} e - The keyboard event
   * @param {HTMLElement} modalEl - The modal element
   */
  function handleModalFocusTrap(e, modalEl) {
    if (e.key !== 'Tab') return;

    // Exclude disabled and hidden nodes — with them included, a modal whose
    // last matching element is disabled (e.g. the disabled Save button in
    // agent settings) could never satisfy the wrap condition and Tab escaped
    // the dialog entirely.
    const focusableElements = [...modalEl.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter(el => !el.disabled && el.offsetParent !== null);

    if (focusableElements.length === 0) {
      e.preventDefault();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey) {
      // Shift+Tab: if focus is on first element, move to last
      if (document.activeElement === firstElement) {
        lastElement.focus();
        e.preventDefault();
      }
    } else {
      // Tab: if focus is on last element, move to first
      if (document.activeElement === lastElement) {
        firstElement.focus();
        e.preventDefault();
      }
    }
  }

  function initWebhookEventsGrid() {
    const grid = document.getElementById('wh-events-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const evt of WEBHOOK_EVENTS) {
      const chip = document.createElement('span');
      chip.className = 'wh-event-chip' + (selectedWhEvents.has(evt) ? ' selected' : '');
      chip.textContent = evt;
      chip.onclick = () => {
        if (evt === '*') {
          if (selectedWhEvents.has('*')) { selectedWhEvents.clear(); } else { selectedWhEvents = new Set(['*']); }
        } else {
          selectedWhEvents.delete('*');
          if (selectedWhEvents.has(evt)) selectedWhEvents.delete(evt); else selectedWhEvents.add(evt);
        }
        initWebhookEventsGrid();
      };
      grid.appendChild(chip);
    }
  }

  async function refreshWebhookList() {
    const activeProject = window.SynapseInput?.activeProject;
    if (!activeProject) return;
    const container = document.getElementById('wh-list-container');
    if (!container) return;

    const authFetch = window.SynapseWebSocket?.authFetch;
    const escapeHtml = window.SynapseHealth?.escapeHtml;
    if (!authFetch || !escapeHtml) return;

    try {
      const res = await authFetch(`/api/projects/${activeProject}/webhooks`);
      const hooks = await res.json();
      if (!hooks.length) {
        container.innerHTML = '<div class="wh-empty">No webhooks registered</div>';
        return;
      }
      container.innerHTML = '';
      for (const h of hooks) {
        const item = document.createElement('div');
        item.className = 'wh-item';
        const evtText = h.events?.join(', ') || '';
        item.innerHTML = `
          <span class="wh-dot ${h.active !== false ? 'active' : 'inactive'}"></span>
          <span class="wh-url" title="${escapeHtml(h.url)}">${escapeHtml(h.url)}</span>
          <span class="wh-events" title="${escapeHtml(evtText)}">${escapeHtml(evtText)}</span>
          <div class="wh-actions">
            <button class="wh-btn" data-action="test" data-id="${h.id}">test</button>
            <button class="wh-btn danger" data-action="delete" data-id="${h.id}">delete</button>
          </div>`;
        container.appendChild(item);
      }
      container.querySelectorAll('.wh-btn').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const whId = btn.dataset.id;
          if (action === 'test') {
            btn.textContent = '...';
            try {
              const r = await authFetch(`/api/projects/${activeProject}/webhooks/${whId}/test`, { method: 'POST' });
              const result = await r.json();
              btn.textContent = result.success ? 'ok' : 'fail';
            } catch { btn.textContent = 'err'; }
            setTimeout(() => { btn.textContent = 'test'; }, 2000);
          } else if (action === 'delete') {
            if (!confirm('Delete this webhook? Deliveries to it will stop immediately.')) return;
            try {
              const r = await authFetch(`/api/projects/${activeProject}/webhooks/${whId}`, { method: 'DELETE' });
              if (!r.ok) throw new Error('HTTP ' + r.status);
            } catch (err) {
              window.SynapseMessages?.showToast?.('Webhook delete failed: ' + err.message, 'error');
            }
            refreshWebhookList();
          }
        };
      });
    } catch (e) {
      container.innerHTML = '<div class="wh-empty">Failed to load webhooks</div>';
    }
  }

  async function refreshCredentialList() {
    const activeProject = window.SynapseInput?.activeProject;
    if (!activeProject) return;
    const container = document.getElementById('cred-list-container');
    if (!container) return;

    const authFetch = window.SynapseWebSocket?.authFetch;
    const escapeHtml = window.SynapseHealth?.escapeHtml;
    if (!authFetch || !escapeHtml) return;

    try {
      const res = await authFetch(`/api/projects/${activeProject}/credentials`);
      const creds = await res.json();
      if (!Array.isArray(creds) || !creds.length) {
        container.innerHTML = '<div class="wh-empty">No credentials stored</div>';
        return;
      }
      container.innerHTML = '';
      for (const c of creds) {
        const item = document.createElement('div');
        item.className = 'wh-item';
        item.innerHTML = `
          <span class="wh-url">${escapeHtml(c.name)}</span>
          <span class="wh-events">${escapeHtml(c.description || '')}</span>
          <div class="wh-actions">
            <button class="wh-btn danger" data-action="delete" data-name="${escapeHtml(c.name)}">delete</button>
          </div>`;
        container.appendChild(item);
      }
      container.querySelectorAll('.wh-btn[data-action="delete"]').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          await deleteCredential(btn.dataset.name);
        };
      });
    } catch (e) {
      container.innerHTML = '<div class="wh-empty">Failed to load credentials</div>';
    }
  }

  async function deleteCredential(name) {
    const activeProject = window.SynapseInput?.activeProject;
    const authFetch = window.SynapseWebSocket?.authFetch;
    if (!activeProject || !authFetch) return;
    if (!confirm(`Delete credential "${name}"? Workflows that reference it will fail.`)) return;
    try {
      const r = await authFetch(`/api/projects/${activeProject}/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      refreshCredentialList();
    } catch (e) {
      const appendSystem = window.SynapseMessages?.appendSystem;
      if (appendSystem) appendSystem(`Failed to delete credential: ${name} (${e.message})`);
    }
  }

  async function refreshWorkflowList() {
    const activeProject = window.SynapseInput?.activeProject;
    const authFetch = window.SynapseWebSocket?.authFetch;
    const escapeHtml = window.SynapseHealth?.escapeHtml;
    const container = document.getElementById('wfl-list-container');
    if (!activeProject || !authFetch || !escapeHtml || !container) return;

    try {
      const resp = await authFetch(`/api/projects/${encodeURIComponent(activeProject)}/workflows`);
      if (!resp.ok) {
        container.innerHTML = '<div style="color:var(--text-faint);font-size:12px">Failed to load</div>';
        return;
      }
      const workflows = await resp.json();
      if (workflows.length === 0) {
        container.innerHTML = '<div style="color:var(--text-faint);font-size:12px">No workflows. Create via /workflow CLI or REST API.</div>';
        return;
      }
      let html = '';
      for (const wf of workflows) {
        const nodeCount = wf.nodes?.length || 0;
        const statusClass = wf.status === 'active' ? 'active' : 'paused';
        const isPaused = wf.status === 'paused';
        html += `<div class="wfl-item" data-wfid="${escapeHtml(wf.id)}">
          <div class="wfl-header">
            <span class="wfl-title">${escapeHtml(wf.title)}</span>
            <span class="wfl-status ${statusClass}">${escapeHtml(wf.status)}</span>
          </div>
          <div class="wfl-nodes">${nodeCount} node${nodeCount !== 1 ? 's' : ''}</div>
          <div class="wh-actions" style="margin:4px 0">
            <button class="wh-btn" data-wfaction="run" data-wfid="${escapeHtml(wf.id)}">run</button>
            <button class="wh-btn" data-wfaction="${isPaused ? 'resume' : 'pause'}" data-wfid="${escapeHtml(wf.id)}">${isPaused ? 'resume' : 'pause'}</button>
          </div>
          <div class="wfl-runs" id="wfl-runs-${escapeHtml(wf.id)}">Loading runs...</div>
        </div>`;
      }
      container.innerHTML = html;
      // Workflow actions (P5): run/pause/resume routes existed with no UI —
      // the panel told operators to use the CLI for everything.
      container.querySelectorAll('.wh-btn[data-wfaction]').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const wfId = btn.dataset.wfid;
          const action = btn.dataset.wfaction;
          btn.disabled = true;
          try {
            const r = await authFetch(`/api/projects/${encodeURIComponent(activeProject)}/workflows/${encodeURIComponent(wfId)}/${action}`, { method: 'POST' });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || d.error) throw new Error(d.error || 'HTTP ' + r.status);
            window.SynapseMessages?.showToast?.(`Workflow ${action} ok`, 'success');
            refreshWorkflowList();
          } catch (err) {
            window.SynapseMessages?.showToast?.(`Workflow ${action} failed: ${err.message}`, 'error');
            btn.disabled = false;
          }
        };
      });
      // Load runs for each workflow
      for (const wf of workflows) {
        loadWorkflowRuns(activeProject, authFetch, escapeHtml, wf.id);
      }
    } catch {
      container.innerHTML = '<div style="color:var(--text-faint);font-size:12px">Error loading workflows</div>';
    }
  }

  async function loadWorkflowRuns(activeProject, authFetch, escapeHtml, workflowId) {
    if (!activeProject || !authFetch || !escapeHtml) return;
    const el = document.getElementById(`wfl-runs-${workflowId}`);
    if (!el) return;
    try {
      const resp = await authFetch(`/api/projects/${encodeURIComponent(activeProject)}/workflows/${encodeURIComponent(workflowId)}/runs`);
      if (!resp.ok) {
        el.textContent = 'Failed to load runs';
        return;
      }
      const runs = await resp.json();
      if (runs.length === 0) {
        el.innerHTML = '<div style="font-size:10px;color:var(--text-faint)">No runs yet</div>';
        return;
      }
      // Show last 5 runs
      const recent = runs.slice(-5).reverse();
      el.innerHTML = recent.map(r => {
        const dotClass = r.status || 'running';
        const shortId = r.id.slice(0, 20) + '...';
        const time = r.startedAt ? new Date(r.startedAt).toLocaleString() : '';
        const nodes = r.nodeStates ? Object.values(r.nodeStates) : [];
        const done = nodes.filter(n => n.status === 'completed').length;
        const fail = nodes.filter(n => n.status === 'failed').length;
        const total = nodes.length;
        return `<div class="wfl-run">
          <span class="wfl-run-dot ${dotClass}"></span>
          <span class="wfl-run-id" title="${escapeHtml(r.id)}">${escapeHtml(shortId)}</span>
          <span style="font-size:10px;color:var(--text-faint)">${done}/${total}${fail ? ` (${fail} failed)` : ''}</span>
          <span class="wfl-run-time">${escapeHtml(time)}</span>
        </div>`;
      }).join('');
    } catch {
      el.textContent = 'Error loading runs';
    }
  }

  function init() {
    // Delegated close-button handler. Inline onclick attributes are blocked
    // by the CSP (script-src has no 'unsafe-inline'), so close buttons carry
    // data-close-modal="<id>" instead — delegation survives re-renders.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-close-modal]');
      if (btn) closeModal(btn.getAttribute('data-close-modal'));
    });

    // Bind overlay click handlers on all .modal-overlay elements
    // (clicking the backdrop closes the modal)
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        // Only close if clicking the overlay itself, not its children
        if (e.target === overlay) {
          closeModal(overlay.id);
        }
      });
    });

    // Cancel/close buttons use data-close-modal="<overlay-id>" so we avoid
    // inline onclick= (CSP-hostile). Without this, index.html cancel buttons
    // would no longer close modals after the onclick→data-attr migration.
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-close-modal');
        if (id) closeModal(id);
      });
    });

    // Bind Escape key handler and focus trap
    document.addEventListener('keydown', (e) => {
      // Find all visible legacy modals
      const visibleLegacyModals = Array.from(document.querySelectorAll('.modal-overlay.visible'));

      if (visibleLegacyModals.length > 0) {
        // Topmost is the last one in DOM order
        const topmost = visibleLegacyModals[visibleLegacyModals.length - 1];

        if (e.key === 'Escape') {
          closeModal(topmost.id);
          return; // Don't close other things if a legacy modal was open
        }

        if (e.key === 'Tab') {
          handleModalFocusTrap(e, topmost);
          return; // Don't let Tab escape the modal
        }

        return; // If a modal is open, don't handle other global shortcuts
      }

      // No modal is open - handle other global shortcuts
      if (e.key === 'Escape') {
        // Close task and campaign detail panels if they exist
        if (window.SynapseTasks && window.SynapseTasks.closeTaskDetail) {
          window.SynapseTasks.closeTaskDetail();
        }
        if (window.SynapseCampaigns && window.SynapseCampaigns.closeCampaignDetail) {
          window.SynapseCampaigns.closeCampaignDetail();
        }
      }
    });

    // Bind button click handlers to open corresponding modals.
    // (btn-new-project / btn-new-channel / the timeline + routing-audit panel
    // toggles were removed: their elements no longer exist in index.html —
    // the panels themselves were stripped in the dashboard consolidation.)
    const buttonModalMap = {
      'btn-add-agent': 'modal-agent-settings',
      'btn-webhooks': 'modal-webhooks',
      'btn-credentials': 'modal-credentials',
      'btn-workflows': 'modal-workflows'
    };

    Object.entries(buttonModalMap).forEach(([buttonId, modalId]) => {
      const btn = document.getElementById(buttonId);
      if (btn) {
        btn.addEventListener('click', () => {
          // Header "+ Add Agent" needs create-mode initialization. The shared
          // modal is also used for editing an existing agent; without a fresh
          // openAgentSettings(null) call, currentAgentId retains the previous
          // edit target and the modal silently stays in edit mode (clicks on
          // Save just resave the wrong agent and the new fields go nowhere).
          if (modalId === 'modal-agent-settings') {
            if (window.SynapseAgents?.openAgentSettings) {
              window.SynapseAgents.openAgentSettings(null);
              return;
            }
          }
          openModal(modalId);
          // Initialize webhook events grid when opening webhooks modal
          if (modalId === 'modal-webhooks') {
            initWebhookEventsGrid();
            refreshWebhookList();
          }
          // Refresh credential list when opening credentials modal
          if (modalId === 'modal-credentials') {
            refreshCredentialList();
          }
          // Refresh workflow list when opening workflows modal
          if (modalId === 'modal-workflows') {
            refreshWorkflowList();
          }
        });
      }
    });

    // Bind form submit: project creation
    const projCreateBtn = document.getElementById('proj-create-btn');
    // Roster picker: lazily populated when "Selected agents" is chosen.
    // Choice is REQUIRED (operator ruling): a project created without a
    // roster defaults to ALL agents and any idle agent may claim its work.
    document.querySelectorAll('input[name="proj-roster"]').forEach(radio => {
      radio.addEventListener('change', async () => {
        const picker = document.getElementById('proj-roster-picker');
        if (!picker) return;
        if (radio.value !== 'pick' || !radio.checked) { picker.style.display = 'none'; return; }
        picker.style.display = 'block';
        picker.textContent = 'Loading agents…';
        const authFetch = window.SynapseWebSocket?.authFetch;
        const esc = window.SynapseHealth ? window.SynapseHealth.escapeHtml : (s) => String(s || '');
        try {
          const [agents, classes] = await Promise.all([
            authFetch('/api/agents').then(r => r.json()),
            authFetch('/api/agent-classes').then(r => r.json()).catch(() => []),
          ]);
          picker.innerHTML =
            '<div style="opacity:.65;margin-bottom:2px">Agents</div>' +
            (Array.isArray(agents) ? agents : []).map(a =>
              `<label style="display:block;cursor:pointer"><input type="checkbox" data-kind="agent" value="${esc(a.id)}"> ${esc(a.name || a.id)} <span style="opacity:.55">${esc(a.provider || '')}</span></label>`
            ).join('') +
            ((Array.isArray(classes) && classes.length)
              ? '<div style="opacity:.65;margin:6px 0 2px">Model classes</div>' +
                classes.map(c => `<label style="display:block;cursor:pointer"><input type="checkbox" data-kind="class" value="${esc(c.class)}"> All ${esc(c.class)} <span style="opacity:.55">(${c.agentIds.length})</span></label>`).join('')
              : '');
        } catch {
          picker.textContent = 'Could not load agents — try again.';
        }
      });
    });

    if (projCreateBtn) {
      projCreateBtn.addEventListener('click', () => {
        const id = document.getElementById('proj-id')?.value.trim();
        const displayName = document.getElementById('proj-display')?.value.trim();
        const projectDir = document.getElementById('proj-dir')?.value.trim();
        const modeRadio = document.querySelector('input[name="proj-mode"]:checked');
        const mode = modeRadio?.value || 'static';
        if (!id) return;
        // Required roster choice — block create until one is made.
        const rosterRadio = document.querySelector('input[name="proj-roster"]:checked');
        if (!rosterRadio) {
          window.SynapseMessages?.showToast?.('Choose which agents may work this project (All agents, or pick some)', 'error');
          return;
        }
        let rosterValue = null; // 'all' → explicitly all agents
        if (rosterRadio.value === 'pick') {
          const picker = document.getElementById('proj-roster-picker');
          const agentsSel = [...(picker?.querySelectorAll('input[data-kind="agent"]:checked') || [])].map(i => i.value);
          const classesSel = [...(picker?.querySelectorAll('input[data-kind="class"]:checked') || [])].map(i => i.value);
          if (!agentsSel.length && !classesSel.length) {
            window.SynapseMessages?.showToast?.('Pick at least one agent or model class (or choose All agents)', 'error');
            return;
          }
          rosterValue = {
            agents: agentsSel.length ? agentsSel : undefined,
            classes: classesSel.length ? classesSel : undefined,
          };
        }
        // HTTP, not WS: the create_project WS message had no error path — a
        // duplicate id or invalid dir failed server-side while the modal
        // closed as if it succeeded. The HTTP route broadcasts the same
        // project_created event, so live refresh behavior is unchanged.
        const authFetch = window.SynapseWebSocket?.authFetch;
        if (!authFetch) return;
        authFetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, displayName: displayName || id, projectDir: projectDir || undefined, mode, agents: rosterValue }),
        }).then(async res => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'HTTP ' + res.status);
          }
        }).catch(err => {
          window.SynapseMessages?.showToast?.(`Project create failed: ${err.message}`, 'error');
        });
        document.getElementById('proj-id').value = '';
        document.getElementById('proj-display').value = '';
        document.getElementById('proj-dir').value = '';
        const staticRadio = document.querySelector('input[name="proj-mode"][value="static"]');
        if (staticRadio) staticRadio.checked = true;
        // Reset the required roster choice for the next open.
        document.querySelectorAll('input[name="proj-roster"]').forEach(r => { r.checked = false; });
        const rosterPicker = document.getElementById('proj-roster-picker');
        if (rosterPicker) { rosterPicker.style.display = 'none'; rosterPicker.innerHTML = ''; }
        closeModal('modal-project');
      });
    }

    // Bind form submit: channel creation
    const chanCreateBtn = document.getElementById('chan-create-btn');
    if (chanCreateBtn) {
      chanCreateBtn.addEventListener('click', () => {
        const id = document.getElementById('chan-id')?.value.trim();
        if (!id) return;
        const activeProject = window.SynapseInput?.activeProject;
        const authFetch = window.SynapseWebSocket?.authFetch;
        if (!activeProject || !authFetch) return;
        authFetch(`/api/projects/${encodeURIComponent(activeProject)}/channels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        }).then(async res => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'HTTP ' + res.status);
          }
        }).catch(err => {
          window.SynapseMessages?.showToast?.(`Channel create failed: ${err.message}`, 'error');
        });
        document.getElementById('chan-id').value = '';
        closeModal('modal-channel');
      });
    }

    // Bind form submit: credential creation
    const credCreateBtn = document.getElementById('cred-create-btn');
    if (credCreateBtn) {
      credCreateBtn.addEventListener('click', async () => {
        const name = document.getElementById('cred-name')?.value.trim();
        const value = document.getElementById('cred-value')?.value.trim();
        const description = document.getElementById('cred-desc')?.value.trim();
        if (!name || !value) return;
        const activeProject = window.SynapseInput?.activeProject;
        const authFetch = window.SynapseWebSocket?.authFetch;
        const appendSystem = window.SynapseMessages?.appendSystem;
        if (!activeProject || !authFetch) return;
        try {
          const res = await authFetch(`/api/projects/${activeProject}/credentials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, value, description: description || undefined }),
          });
          const result = await res.json();
          if (result.error) {
            if (appendSystem) appendSystem(`Credential error: ${result.error}`);
            return;
          }
          document.getElementById('cred-name').value = '';
          document.getElementById('cred-value').value = '';
          document.getElementById('cred-desc').value = '';
          refreshCredentialList();
        } catch (e) {
          const appendSystem = window.SynapseMessages?.appendSystem;
          if (appendSystem) appendSystem('Failed to create credential');
        }
      });
    }

    // Bind webhook create button handler
    const whCreateBtn = document.getElementById('wh-create-btn');
    if (whCreateBtn) {
      whCreateBtn.onclick = async () => {
        const urlInput = document.getElementById('wh-url');
        const descInput = document.getElementById('wh-desc');
        const url = urlInput?.value.trim();
        const description = descInput?.value.trim();
        const events = [...selectedWhEvents];

        if (!url) return;
        if (events.length === 0) {
          // First click with nothing selected auto-picks "all events" and
          // waits for a confirming click — say so instead of doing it
          // silently (settings-pass polish note).
          selectedWhEvents.add('*');
          initWebhookEventsGrid();
          window.SynapseSettings?.toast?.('No events selected — defaulted to ALL events (*). Click Add Webhook again to confirm.', 'info');
          return;
        }

        const activeProject = window.SynapseInput?.activeProject;
        const authFetch = window.SynapseWebSocket?.authFetch;
        const appendSystem = window.SynapseMessages?.appendSystem;

        if (!activeProject || !authFetch || !appendSystem) return;

        try {
          const res = await authFetch(`/api/projects/${activeProject}/webhooks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, events, description: description || undefined }),
          });
          const result = await res.json();
          if (result.error) {
            appendSystem(`Webhook error: ${result.error}`);
            return;
          }
          // Show secret once — in a selectable prompt so it can be copied
          // (P8: a chat-pane line scrolled away and was easy to lose).
          if (result.secret) {
            appendSystem('Webhook created. The signing secret was shown once in a copy dialog.');
            window.prompt('Webhook signing secret — copy it now, it is shown only once:', result.secret);
          }
          urlInput.value = '';
          descInput.value = '';
          selectedWhEvents.clear();
          initWebhookEventsGrid();
          refreshWebhookList();
        } catch (e) {
          appendSystem('Failed to create webhook');
        }
      };
    }
  }

  // --- Public API ---
  window.SynapseModals = {
    openModal,
    closeModal,
    initWebhookEventsGrid,
    refreshWebhookList,
    refreshCredentialList,
    deleteCredential,
    refreshWorkflowList,
    loadWorkflowRuns,
    init,
  };
  // Expose as bare globals for inline onclick="closeModal(...)" handlers in index.html
  window.closeModal = closeModal;
  window.openModal = openModal;
})();
