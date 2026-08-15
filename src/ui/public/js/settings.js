export function initSettings() {
  const authFetch = () => window.SynapseWebSocket?.authFetch;
  const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  function toast(msg, type = 'info') {
    const tc = document.getElementById('toast-container');
    if (!tc) return;
    const t = document.createElement('div');
    // `toast ${type}` — the loaded stylesheet keys severity off `.toast.error`
    // etc.; the old `toast-${type}` form matched nothing and every settings
    // toast rendered uncoloured.
    t.className = `toast ${type}`;
    t.textContent = msg;
    tc.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  function openSettingsModal() {
    // Delegate to the shared modal machinery so scroll-lock, initial focus,
    // and focus-restore all apply (direct classList toggling bypassed them).
    if (window.openModal) { window.openModal('modal-settings'); }
    else {
      const overlay = document.getElementById('modal-settings');
      if (!overlay) return;
      overlay.classList.add('visible');
    }
    switchTab('projects');
  }

  function closeSettingsModal() {
    if (window.closeModal) { window.closeModal('modal-settings'); return; }
    const overlay = document.getElementById('modal-settings');
    if (overlay) overlay.classList.remove('visible');
  }

  // #105 shared agent-priority editor (vault/design/project-agent-priority.md).
  // Used by the Routing tab (global default) and each project block (override).
  // Up/Down + Rank/Unrank buttons — no drag dependency; matches the table
  // conventions of this modal. state lives in closure; Save posts
  // { ranks, strict } (or null when nothing is ranked), Clear posts null.
  function priorityEditor(mount, { current, agentIds, title, hint, onSave, onClear }) {
    let ranks = (current?.ranks || []).filter(id => agentIds.includes(id));
    let strict = current?.strict === true;
    const render = () => {
      const unranked = agentIds.filter(id => !ranks.includes(id));
      let h = `<div class="repo-config-title" style="margin-top:8px">${esc(title)}</div>`;
      h += `<div class="settings-hint">${esc(hint)}</div>`;
      if (ranks.length === 0) h += `<div class="settings-hint" style="font-style:italic">No ranks set — legacy default ordering applies.</div>`;
      ranks.forEach((id, i) => {
        h += `<div class="prio-row" style="display:flex;gap:6px;align-items:center;padding:2px 0">`
          + `<span style="width:28px;opacity:.7">#${i + 1}</span><span style="flex:1">${esc(id)}</span>`
          + `<button class="pace-save-btn prio-up" data-id="${esc(id)}"${i === 0 ? ' disabled' : ''}>&#8593;</button>`
          + `<button class="pace-save-btn prio-down" data-id="${esc(id)}"${i === ranks.length - 1 ? ' disabled' : ''}>&#8595;</button>`
          + `<button class="pace-save-btn prio-remove" data-id="${esc(id)}">Unrank</button></div>`;
      });
      if (unranked.length) {
        h += `<div class="settings-hint" style="margin-top:4px">Unranked (follow ranked agents in default order):</div>`;
        unranked.forEach(id => {
          h += `<div class="prio-row" style="display:flex;gap:6px;align-items:center;padding:2px 0;opacity:.75">`
            + `<span style="width:28px"></span><span style="flex:1">${esc(id)}</span>`
            + `<button class="pace-save-btn prio-add" data-id="${esc(id)}">Rank</button></div>`;
        });
      }
      h += `<div style="margin-top:6px;display:flex;gap:8px;align-items:center">`
        + `<label>Strict <select class="settings-select prio-strict">`
        + `<option value="false"${!strict ? ' selected' : ''}>Off — fall through ranks</option>`
        + `<option value="true"${strict ? ' selected' : ''}>On — queue for top-ranked</option>`
        + `</select></label>`
        + `<button class="pace-save-btn prio-save">Save Priority</button>`
        + `<button class="pace-save-btn prio-clear">Clear</button></div>`;
      mount.innerHTML = h;
      const move = (id, d) => { const i = ranks.indexOf(id); const j = i + d; if (i < 0 || j < 0 || j >= ranks.length) return; [ranks[i], ranks[j]] = [ranks[j], ranks[i]]; render(); };
      mount.querySelectorAll('.prio-up').forEach(b => b.addEventListener('click', () => move(b.dataset.id, -1)));
      mount.querySelectorAll('.prio-down').forEach(b => b.addEventListener('click', () => move(b.dataset.id, 1)));
      mount.querySelectorAll('.prio-remove').forEach(b => b.addEventListener('click', () => { ranks = ranks.filter(x => x !== b.dataset.id); render(); }));
      mount.querySelectorAll('.prio-add').forEach(b => b.addEventListener('click', () => { ranks.push(b.dataset.id); render(); }));
      mount.querySelector('.prio-strict')?.addEventListener('change', (e) => { strict = e.target.value === 'true'; });
      mount.querySelector('.prio-save')?.addEventListener('click', () => onSave(ranks.length ? { ranks: [...ranks], strict } : null));
      mount.querySelector('.prio-clear')?.addEventListener('click', () => { ranks = []; strict = false; onClear(); render(); });
    };
    render();
  }

  function switchTab(tab) {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.settings-tab-panel').forEach(p => p.style.display = p.id === `settings-panel-${tab}` ? '' : 'none');
    const loaders = { projects: loadProjects, pacing: loadPacing, routing: loadRouting, circuitbreaker: loadCircuitBreaker, tasks: loadTasks, timezone: loadTimezone, apikeys: loadApiKeys };
    if (loaders[tab]) loaders[tab]();
  }

  async function loadProjects() {
    const af = authFetch();
    if (!af) return;
    const container = document.getElementById('settings-panel-projects');
    if (!container) return;
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await af('/api/projects');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const projects = (await res.json()).filter(p => p.sealed !== true);
      let html = '<div class="settings-section-title">Projects</div>';
      html += '<div class="settings-hint">Continuous projects auto-generate new campaigns from the vision when all milestones complete. Static projects pause when campaigns finish.</div>';
      html += '<table class="settings-pace-table"><thead><tr><th>Project</th><th>Mode</th><th>Allocation</th><th></th></tr></thead><tbody>';
      // Sealed projects (the `default` chat surface) are excluded — the
      // sidebar already hides their allocation controls; rendering mode/repo
      // editors for them here offered knobs that don't apply.
      for (const p of projects) {
        const mode = p.mode || 'static';
        const rc = p.repoConfig || { mode: 'local', branch: 'main', autoInit: true };
        const rcMode = rc.mode || 'local';
        const rcBranch = esc(rc.branch || 'main');
        const rcRemote = esc(rc.remote || '');
        const rcAutoInit = rc.autoInit !== false;
        html += `<tr><td>${esc(p.id || p.name)}</td>`;
        html += `<td><select class="settings-select" data-project="${esc(p.id)}" data-field="mode"><option value="static"${mode==='static'?' selected':''}>Static</option><option value="continuous"${mode==='continuous'?' selected':''}>Continuous</option></select></td>`;
        html += `<td><input type="number" class="pace-input" data-project="${esc(p.id)}" data-field="allocation" value="${p.allocation ?? 0}" min="0" max="100" step="5" style="width:60px"></td>`;
        html += `<td><button class="pace-save-btn" data-project="${esc(p.id)}">Save</button></td></tr>`;
        // Repository sub-row — repoConfig editor. Lives directly under each
        // project so the operator never has to hunt for the gate that
        // controls "where does this project's code land."
        html += `<tr class="repo-config-row" data-project="${esc(p.id)}"><td colspan="4">`;
        html += `<div class="repo-config-block">`;
        html += `<div class="repo-config-title">Repository</div>`;
        html += `<div class="repo-config-row-fields">`;
        html += `<label class="repo-mode-label"><input type="radio" name="repo-mode-${esc(p.id)}" value="none"${rcMode==='none'?' checked':''}> None <span class="repo-mode-hint">— no git ops</span></label>`;
        html += `<label class="repo-mode-label"><input type="radio" name="repo-mode-${esc(p.id)}" value="local"${rcMode==='local'?' checked':''}> Local <span class="repo-mode-hint">— branch + commit, no push</span></label>`;
        html += `<label class="repo-mode-label"><input type="radio" name="repo-mode-${esc(p.id)}" value="github"${rcMode==='github'?' checked':''}> GitHub <span class="repo-mode-hint">— local + push to remote (beta: push gated)</span></label>`;
        html += `</div>`;
        html += `<div class="repo-config-detail">`;
        html += `<label class="repo-field-label">Base branch:</label>`;
        html += `<input type="text" class="repo-input" data-project="${esc(p.id)}" data-field="branch" value="${rcBranch}" placeholder="main">`;
        html += `<label class="repo-field-label repo-remote-label">Remote (github only):</label>`;
        html += `<input type="text" class="repo-input repo-remote-input" data-project="${esc(p.id)}" data-field="remote" value="${rcRemote}" placeholder="owner/repo or full URL">`;
        html += `<label class="repo-field-label"><input type="checkbox" class="repo-autoinit" data-project="${esc(p.id)}"${rcAutoInit?' checked':''}> Auto-init repo if missing</label>`;
        html += `<button class="repo-save-btn" data-project="${esc(p.id)}">Save Repository</button>`;
        html += `</div>`;
        // Vision editor — continuous mode generates campaigns FROM this text;
        // the hint above referenced it but no UI could set it (P1).
        html += `<div class="repo-config-title" style="margin-top:8px">Vision</div>`;
        html += `<div class="settings-hint">Continuous projects generate new campaigns from this vision when milestones complete.</div>`;
        html += `<textarea class="vision-input" data-project="${esc(p.id)}" rows="3" placeholder="What should this project become? Continuous mode plans campaigns toward this." style="width:100%;font-size:12px">${esc(p.vision || '')}</textarea>`;
        html += `<button class="pace-save-btn vision-save-btn" data-project="${esc(p.id)}" style="margin-top:4px">Save Vision</button>`;
        // #105 per-project agent priority override (falls back to the global
        // default from the Routing tab when cleared).
        html += `<div class="prio-project-mount" data-project="${esc(p.id)}"></div>`;
        // Review policy (operator ruling 2026-08-15): architects and reviewers
        // review; developers are workers. This opt-in lets a developer take a
        // review ONLY when no reviewer/architect is available on this project.
        html += `<div class="repo-config-title" style="margin-top:8px">Review Policy</div>`;
        html += `<label class="repo-field-label"><input type="checkbox" class="review-dev-fallback" data-project="${esc(p.id)}"${p.reviewDeveloperFallback?' checked':''}> Allow developers to review when no reviewer/architect is available</label>`;
        html += `<div class="settings-hint">Off (default): reviews go to reviewers, then architects; if none is free the audit is skipped rather than handed to a worker.</div>`;
        html += `</div>`;
        html += `</td></tr>`;
      }
      html += '</tbody></table>';
      container.innerHTML = html;

      // #105 per-project priority editors. Offer all agents; the API enforces
      // roster membership (400 with the offending ids) — server-side
      // validation stays authoritative.
      try {
        const agentsRes = await af('/api/agents');
        const agentIds = agentsRes.ok ? (await agentsRes.json()).map(a => a.id) : [];
        if (agentIds.length) {
          for (const p of projects) {
            const mount = container.querySelector(`.prio-project-mount[data-project="${CSS.escape(p.id)}"]`);
            if (!mount) continue;
            const patchProject = async (agentPriority) => {
              try {
                const res = await af(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentPriority }) });
                if (!res.ok) throw new Error((await res.json()).error || 'HTTP ' + res.status);
                toast(agentPriority ? `Priority override saved for ${p.id}` : `Priority override cleared for ${p.id} (inherits global)`, 'success');
              } catch (e) { toast('Priority save failed: ' + e.message, 'error'); }
            };
            priorityEditor(mount, {
              current: p.agentPriority || null,
              agentIds,
              title: 'Agent Priority (override)',
              hint: p.agentPriority ? 'Overriding the global default from the Routing tab.' : 'Inheriting the global default (Routing tab). Rank agents here to override for this project only.',
              onSave: patchProject,
              onClear: () => patchProject(null),
            });
          }
        }
      } catch { /* additive — project controls still work */ }

      // Review policy toggle — saves immediately (single boolean, no form).
      container.querySelectorAll('.review-dev-fallback').forEach(cb => {
        cb.addEventListener('change', async () => {
          const proj = cb.dataset.project;
          const value = cb.checked;
          cb.disabled = true;
          try {
            const res = await af(`/api/projects/${encodeURIComponent(proj)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewDeveloperFallback: value }) });
            if (!res.ok) throw new Error((await res.json()).error || 'HTTP ' + res.status);
            toast(value ? `Developer review fallback enabled for ${proj}` : `Developer review fallback disabled for ${proj}`, 'success');
          } catch (e) {
            cb.checked = !value;
            toast('Review policy save failed: ' + e.message, 'error');
          } finally { cb.disabled = false; }
        });
      });

      // :not(.vision-save-btn) — the vision button shares .pace-save-btn for
      // styling; without the exclusion one Save Vision click ALSO fired this
      // handler and re-PATCHed mode + allocation.
      container.querySelectorAll('.pace-save-btn:not(.vision-save-btn)').forEach(btn => {
        btn.addEventListener('click', async () => {
          const proj = btn.dataset.project;
          const modeSelect = container.querySelector(`select[data-project="${proj}"][data-field="mode"]`);
          const allocInput = container.querySelector(`input[data-project="${proj}"][data-field="allocation"]`);
          const mode = modeSelect?.value || 'static';
          const allocation = parseInt(allocInput?.value || '0', 10);
          if (!Number.isFinite(allocation) || allocation < 0 || allocation > 100) {
            toast('Allocation must be a number 0–100', 'error');
            return;
          }
          btn.disabled = true;
          btn.textContent = '...';
          try {
            const modeRes = await af(`/api/projects/${proj}/mode`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
            if (!modeRes.ok) throw new Error('mode: ' + modeRes.status);
            const allocRes = await af(`/api/projects/${proj}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allocation }) });
            if (!allocRes.ok) throw new Error('alloc: ' + allocRes.status);
            toast(`${proj} updated`, 'success');
            btn.disabled = false;
            btn.textContent = 'Save';
          } catch (e) { toast('Failed: ' + e.message, 'error'); btn.disabled = false; btn.textContent = 'Save'; }
        });
      });

      // Repository config save — PATCH /api/projects/:id with { repoConfig }.
      // Branch and remote fields are always sent; the backend's normalizer
      // discards `remote` when mode != github, so it's safe to send everything.
      container.querySelectorAll('.repo-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const proj = btn.dataset.project;
          const modeRadio = container.querySelector(`input[name="repo-mode-${proj}"]:checked`);
          const branchIn = container.querySelector(`.repo-input[data-project="${proj}"][data-field="branch"]`);
          const remoteIn = container.querySelector(`.repo-input[data-project="${proj}"][data-field="remote"]`);
          const autoInit = container.querySelector(`.repo-autoinit[data-project="${proj}"]`);
          const repoConfig = {
            mode: modeRadio?.value || 'local',
            branch: (branchIn?.value || '').trim() || 'main',
            remote: (remoteIn?.value || '').trim(),
            autoInit: autoInit?.checked === true,
          };
          btn.disabled = true;
          btn.textContent = '...';
          try {
            const res = await af(`/api/projects/${proj}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ repoConfig }),
            });
            if (!res.ok) {
              const errBody = await res.text().catch(() => '');
              throw new Error(errBody || ('HTTP ' + res.status));
            }
            toast(`${proj} repo: ${repoConfig.mode}`, 'success');
            btn.disabled = false;
            btn.textContent = 'Save Repository';
          } catch (e) {
            toast('Repo save failed: ' + e.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Save Repository';
          }
        });
      });

      container.querySelectorAll('.vision-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const proj = btn.dataset.project;
          const ta = container.querySelector(`.vision-input[data-project="${proj}"]`);
          const vision = (ta?.value || '').trim();
          btn.disabled = true;
          btn.textContent = '...';
          try {
            const res = await af(`/api/projects/${proj}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ vision }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.error || 'HTTP ' + res.status);
            }
            toast(`${proj} vision saved`, 'success');
          } catch (e) { toast('Vision save failed: ' + e.message, 'error'); }
          btn.disabled = false;
          btn.textContent = 'Save Vision';
        });
      });

      // Show/hide the remote field based on selected mode (github only).
      const refreshRemoteVisibility = (proj) => {
        const checked = container.querySelector(`input[name="repo-mode-${proj}"]:checked`);
        const label = container.querySelector(`.repo-config-row[data-project="${proj}"] .repo-remote-label`);
        const input = container.querySelector(`.repo-config-row[data-project="${proj}"] .repo-remote-input`);
        const show = checked?.value === 'github';
        if (label) label.style.display = show ? '' : 'none';
        if (input) input.style.display = show ? '' : 'none';
      };
      container.querySelectorAll('.repo-config-row').forEach(row => {
        const proj = row.dataset.project;
        refreshRemoteVisibility(proj);
        row.querySelectorAll(`input[name="repo-mode-${proj}"]`).forEach(r => {
          r.addEventListener('change', () => refreshRemoteVisibility(proj));
        });
      });
    } catch (e) { container.innerHTML = `<div class="settings-error">Failed: ${esc(e.message)}</div>`; }
  }

  async function loadPacing() {
    const af = authFetch();
    if (!af) return;
    const container = document.getElementById('settings-panel-pacing');
    if (!container) return;
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await af('/api/settings/pace');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      renderPacing(data, container);
    } catch (e) { container.innerHTML = `<div class="settings-error">Failed: ${esc(e.message)}</div>`; }
  }

  function renderPacing(data, container) {
    const defaults = data.defaults || {};
    const pace = data.pace || {};
    const localProviders = data.localProviders || [];
    const windowMs = data.windowMs || 3600000;
    const windowLabel = windowMs >= 3600000 ? `${windowMs / 3600000}h` : `${Math.round(windowMs / 60000)}m`;

    let html = `<div class="settings-section-title">Per-Provider Dispatch Cap (rolling ${windowLabel} window)</div>`;
    html += '<div class="settings-hint">Max dispatches per rolling time window. Cloud providers are capped; local providers are unlimited.</div>';
    html += '<table class="settings-pace-table"><thead><tr><th>Provider</th><th>Usage</th><th>Max</th><th>Status</th><th></th></tr></thead><tbody>';
    // Derive the provider rows from the API response instead of a hardcoded
    // list — descriptor-added harnesses were previously invisible (and
    // therefore uncappable) here.
    const provSet = new Set(['claude', 'codex', 'gemini', 'glm', 'ollama']);
    Object.keys(defaults).forEach(p => provSet.add(p));
    Object.keys(pace).forEach(p => provSet.add(p));
    localProviders.forEach(p => provSet.add(p));
    for (const prov of [...provSet].sort()) {
      const isLocal = localProviders.includes(prov);
      const paceInfo = pace[prov];
      const used = paceInfo?.used ?? 0;
      const max = paceInfo?.max ?? (isLocal ? Infinity : (defaults[prov] ?? 0));
      const blocked = paceInfo?.blocked ?? false;
      if (isLocal) {
        html += `<tr class="pace-local"><td>${esc(prov)}</td><td>${used}</td><td>Unlimited</td><td><span class="pace-badge pace-unlimited">local</span></td><td></td></tr>`;
      } else {
        html += `<tr><td>${esc(prov)}</td><td>${used} / ${max}</td>`;
        html += `<td><input type="number" class="pace-input" data-provider="${esc(prov)}" value="${max}" min="0" max="1000" step="1" style="width:70px"></td>`;
        html += `<td><span class="pace-badge ${blocked ? 'pace-blocked' : 'pace-ok'}">${blocked ? 'blocked' : 'ok'}</span></td>`;
        html += `<td><button class="pace-save-btn" data-provider="${esc(prov)}">Save</button></td></tr>`;
      }
    }
    html += '</tbody></table>';
    container.innerHTML = html;

    container.querySelectorAll('.pace-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const prov = btn.dataset.provider;
        const input = container.querySelector(`.pace-input[data-provider="${prov}"]`);
        const val = parseInt(input?.value, 10);
        if (isNaN(val) || val < 0) { toast('Invalid value', 'error'); return; }
        btn.disabled = true; btn.textContent = '...';
        try {
          const af = authFetch();
          const res = await af('/api/settings/pace', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: prov, maxPerWindow: val }) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          toast(`${prov}: ${val}/${windowLabel}`, 'success');
          loadPacing();
        } catch (e) { toast('Failed: ' + e.message, 'error'); btn.disabled = false; btn.textContent = 'Save'; }
      });
    });
  }

  async function loadRouting() {
    const af = authFetch();
    if (!af) return;
    const container = document.getElementById('settings-panel-routing');
    if (!container) return;
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await af('/api/settings/routing');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const enabled = data.enabled !== false;
      const localFirst = data.localFirst !== false;
      const floorWeight = data.floorWeight ?? 0.05;
      const costWeight = data.costWeight ?? 0;
      container.innerHTML = `
        <div class="settings-section-title">Routing</div>
        <div class="settings-hint">Controls how Synapse selects agents for dispatch.</div>
        <table class="settings-pace-table"><thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead><tbody>
        <tr><td>Directed Routing</td><td><select class="settings-select" id="routing-enabled"><option value="true"${enabled?' selected':''}>Enabled</option><option value="false"${!enabled?' selected':''}>Disabled</option></select></td><td></td></tr>
        <tr><td>Local-First Preference</td><td><select class="settings-select" id="routing-localfirst"><option value="true"${localFirst?' selected':''}>Enabled</option><option value="false"${!localFirst?' selected':''}>Disabled</option></select></td><td></td></tr>
        <tr><td>Floor Weight (min %)</td><td><input type="number" class="pace-input" id="routing-floor" value="${floorWeight}" min="0.01" max="0.5" step="0.01" style="width:70px"></td><td rowspan="2"><button class="pace-save-btn" id="routing-save">Save</button></td></tr>
        <tr><td>Cost Weight<div class="settings-hint" style="margin:2px 0 0">0 = performance only, 1 = cost only</div></td><td><input type="number" class="pace-input" id="routing-costweight" value="${costWeight}" min="0" max="1" step="0.05" style="width:70px"></td></tr>
        </tbody></table>
        <div id="routing-priority-mount"></div>`;
      document.getElementById('routing-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('routing-save');
        btn.disabled = true; btn.textContent = '...';
        try {
          const payload = { enabled: document.getElementById('routing-enabled')?.value === 'true', localFirst: document.getElementById('routing-localfirst')?.value === 'true', floorWeight: parseFloat(document.getElementById('routing-floor')?.value || '0.05'), costWeight: parseFloat(document.getElementById('routing-costweight')?.value || '0') };
          if (!Number.isFinite(payload.floorWeight) || !Number.isFinite(payload.costWeight)) { toast('Weights must be numbers', 'error'); btn.disabled = false; btn.textContent = 'Save'; return; }
          const res = await af('/api/settings/routing', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          toast('Routing settings saved', 'success');
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
        btn.disabled = false; btn.textContent = 'Save';
      });
      // #105 global default rank ("set it once and call it a day");
      // per-project overrides live in the Projects tab.
      try {
        const [prioRes, agentsRes] = await Promise.all([af('/api/settings/agent-priority'), af('/api/agents')]);
        const current = prioRes.ok ? (await prioRes.json()).agentPriority : null;
        const agentIds = agentsRes.ok ? (await agentsRes.json()).map(a => a.id) : [];
        const mount = document.getElementById('routing-priority-mount');
        if (mount && agentIds.length) {
          const patchGlobal = async (agentPriority) => {
            try {
              const res = await af('/api/settings/agent-priority', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentPriority }) });
              if (!res.ok) throw new Error((await res.json()).error || 'HTTP ' + res.status);
              toast(agentPriority ? 'Default agent priority saved' : 'Default agent priority cleared', 'success');
            } catch (e) { toast('Priority save failed: ' + e.message, 'error'); }
          };
          priorityEditor(mount, {
            current, agentIds,
            title: 'Agent Priority — Default Rank Order',
            hint: 'Replaces cost tiers for task routing: rank agents in the order you want them assigned work. Chat replies still route by relevance and roster. Projects can override this in the Projects tab.',
            onSave: patchGlobal,
            onClear: () => patchGlobal(null),
          });
        }
      } catch { /* priority editor is additive — routing controls still work */ }
    } catch (e) { container.innerHTML = `<div class="settings-error">Failed: ${esc(e.message)}</div>`; }
  }

  async function loadCircuitBreaker() {
    const af = authFetch();
    if (!af) return;
    const container = document.getElementById('settings-panel-circuitbreaker');
    if (!container) return;
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await af('/api/settings/circuitbreaker');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const threshold = data.failureThreshold ?? 5;
      const cooldown = Math.round((data.cooldownMs ?? 60000) / 1000);
      const failureAgeMin = Math.round((data.maxFailureAgeMs ?? 3600000) / 60000);
      container.innerHTML = `
        <div class="settings-section-title">Circuit Breaker</div>
        <div class="settings-hint">Protects against cascading failures. When an agent fails N times, it enters cooldown before retry.</div>
        <table class="settings-pace-table"><thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead><tbody>
        <tr><td>Failure Threshold</td><td><input type="number" class="pace-input" id="cb-threshold" value="${threshold}" min="1" max="50" step="1" style="width:70px"></td><td rowspan="3"><button class="pace-save-btn" id="cb-save">Save</button></td></tr>
        <tr><td>Cooldown (seconds)</td><td><input type="number" class="pace-input" id="cb-cooldown" value="${cooldown}" min="5" max="600" step="5" style="width:70px"></td></tr>
        <tr><td>Failure Memory (minutes)<div class="settings-hint" style="margin:2px 0 0">Failures older than this are ignored when counting toward the threshold</div></td><td><input type="number" class="pace-input" id="cb-failureage" value="${failureAgeMin}" min="1" max="1440" step="1" style="width:70px"></td></tr>
        </tbody></table>`;
      document.getElementById('cb-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('cb-save');
        btn.disabled = true; btn.textContent = '...';
        try {
          const payload = { failureThreshold: parseInt(document.getElementById('cb-threshold')?.value || '5', 10), cooldownMs: parseInt(document.getElementById('cb-cooldown')?.value || '60', 10) * 1000, maxFailureAgeMs: parseInt(document.getElementById('cb-failureage')?.value || '60', 10) * 60000 };
          const res = await af('/api/settings/circuitbreaker', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          toast('Circuit breaker settings saved', 'success');
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
        btn.disabled = false; btn.textContent = 'Save';
      });
    } catch (e) { container.innerHTML = `<div class="settings-error">Failed: ${esc(e.message)}</div>`; }
  }

  async function loadTasks() {
    const af = authFetch();
    if (!af) return;
    const container = document.getElementById('settings-panel-tasks');
    if (!container) return;
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await af('/api/settings/tasks');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const pickupSlots = data.pickupSlots ?? 3;
      const stuckTimeout = Math.round((data.stuckSubtaskTimeoutMs ?? 600000) / 1000);
      const maxRequeues = data.maxRequeues ?? 1;
      container.innerHTML = `
        <div class="settings-section-title">Tasks & Lifecycle</div>
        <div class="settings-hint">Controls task execution concurrency and timeouts.</div>
        <table class="settings-pace-table"><thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead><tbody>
        <tr><td>Pickup Slots (concurrent)</td><td><input type="number" class="pace-input" id="task-slots" value="${pickupSlots}" min="1" max="20" step="1" style="width:70px"></td><td rowspan="3"><button class="pace-save-btn" id="task-save">Save</button></td></tr>
        <tr><td>Stuck Timeout (seconds)<div class="settings-hint" style="margin:2px 0 0">Local OpenAI-compatible servers use a longer built-in override (30 min) — this value applies to cloud providers.</div></td><td><input type="number" class="pace-input" id="task-stuck" value="${stuckTimeout}" min="60" max="3600" step="30" style="width:70px"></td></tr>
        <tr><td>Max Requeues</td><td><input type="number" class="pace-input" id="task-requeues" value="${maxRequeues}" min="0" max="5" step="1" style="width:70px"></td></tr>
        </tbody></table>`;
      document.getElementById('task-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('task-save');
        btn.disabled = true; btn.textContent = '...';
        try {
          const payload = { pickupSlots: parseInt(document.getElementById('task-slots')?.value || '3', 10), stuckSubtaskTimeoutMs: parseInt(document.getElementById('task-stuck')?.value || '600', 10) * 1000, maxRequeues: parseInt(document.getElementById('task-requeues')?.value || '1', 10) };
          const res = await af('/api/settings/tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          toast('Task settings saved', 'success');
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
        btn.disabled = false; btn.textContent = 'Save';
      });
    } catch (e) { container.innerHTML = `<div class="settings-error">Failed: ${esc(e.message)}</div>`; }
  }


  // ── Timezone — the zone schedules are evaluated and displayed in ───────
  // The server's own zone is not necessarily the operator's: a host on
  // Etc/UTC evaluated "0 9 * * *" as 09:00 UTC while the operator meant their
  // own 9am. This surfaces the setting AND what it currently resolves to, so
  // the zone in play is never a guess.
  async function loadTimezone() {
    const af = authFetch();
    if (!af) return;
    const container = document.getElementById('settings-panel-timezone');
    if (!container) return;
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await af('/api/settings/timezone');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      // The server sends the list from the host's tzdata — the same
      // zone1970.tab + iso3166.tab that Ubuntu's own picker uses. That table
      // is curated (312 populated-place zones, not Intl's 418 which include
      // aliases), already uses modern names (Kyiv, Kolkata — ICU still reports
      // the legacy spellings as canonical), and carries country codes plus the
      // tzdb's own descriptors ("Pacific", "most of Ukraine"), which is what
      // lets this read the way people actually name zones.
      const zones = Array.isArray(data.zones) ? data.zones : [];
      const current = data.timezone || '';

      const offsetOf = (z) => {
        try {
          const p = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' })
            .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
          return p ? p.value.replace(/^GMT$/, 'GMT+0') : '';
        } catch { return ''; }
      };
      const opt = (value, label) =>
        `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;

      // Group by country. A zone can serve several (Asia/Dubai covers five),
      // so it appears under each — that is how someone in Oman finds it.
      const byCountry = {};
      for (const z of zones) {
        const names = z.countryNames?.length ? z.countryNames : ['Other'];
        for (const name of names) (byCountry[name] ||= []).push(z);
      }

      // City + the tzdb's own note, which is where "Pacific" comes from.
      //
      // The note is scoped to the COUNTRY GROUP it is rendered in, per the
      // zone1970.tab header: comments are "present if and only if countries
      // have multiple timezones, and useful only for those countries."
      // Asia/Dubai carries "Crozet" because it also serves the French Southern
      // Territories — showing that under United Arab Emirates (a single-zone
      // country) labels Dubai with an island 5,000km away. Same trap put
      // "AST - QC (Lower North Shore)" — a Canadian note — on Puerto Rico.
      const labelFor = (z, country) => {
        const city = z.id.split('/').slice(1).join('/').replace(/_/g, ' ') || z.id;
        const off = offsetOf(z.id);
        const disambiguating = (byCountry[country] || []).length > 1;
        // Antarctica/Casey's note is just "Casey" — no point in "Casey — Casey".
        const useful = disambiguating && z.note && z.note.toLowerCase() !== city.toLowerCase();
        return useful ? `${city} — ${z.note} (${off})` : `${city} (${off})`;
      };

      // Fixed offsets for anyone whose situation is not covered by a named
      // zone. NOTE the POSIX inversion: Etc/GMT+5 is really UTC-5, so labels
      // show the TRUE offset.
      const utcOffsets = [];
      for (let h = 14; h >= -12; h--) {
        utcOffsets.push([
          h === 0 ? 'UTC' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`,
          h === 0 ? 'UTC+00:00' : `UTC${h > 0 ? '+' : '-'}${String(Math.abs(h)).padStart(2, '0')}:00`,
        ]);
      }

      const picker = zones.length
        ? `<select class="pace-input" id="tz-select" style="width:340px">
             <option value=""${current ? '' : ' selected'}>Follow server (${esc(data.hostTimezone)})</option>
             ${Object.keys(byCountry).sort().map((country) => `<optgroup label="${esc(country)}">${
                 byCountry[country].map((z) => opt(z.id, labelFor(z, country))).join('')
               }</optgroup>`).join('')}
             <optgroup label="Fixed UTC offset (no daylight saving)">${utcOffsets.map(([id, l]) => opt(id, l)).join('')}</optgroup>
           </select>`
        : `<input type="text" class="pace-input" id="tz-select" value="${esc(current)}" placeholder="e.g. Europe/Berlin, Asia/Tokyo, UTC (blank = follow server)" style="width:340px">`;

      const sourceNote = data.zoneSource === 'tzdata'
        ? `${zones.length} zones from system tzdata`
        : `${zones.length} zones from the JS runtime (host has no tzdata; names may be outdated)`;

      container.innerHTML = `
        <div class="settings-section-title">Timezone</div>
        <div class="settings-hint">The zone cron schedules are evaluated in and times are shown in. Leave on "Follow server" to use the host zone. A schedule can still pin its own zone with <code>--tz</code>.</div>
        <table class="settings-pace-table"><thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead><tbody>
        <tr><td>Instance timezone</td><td>${picker}</td><td><button class="pace-save-btn" id="tz-save">Save</button></td></tr>
        <tr><td>Currently effective<div class="settings-hint" style="margin:2px 0 0">What the setting resolves to right now.</div></td><td colspan="2"><strong id="tz-effective">${esc(data.effective)}</strong> &mdash; <span id="tz-now">${esc(data.nowInEffective)}</span></td></tr>
        <tr><td>Server (host) zone</td><td colspan="2">${esc(data.hostTimezone)}</td></tr>
        <tr><td>Zone list source</td><td colspan="2"><span class="settings-hint">${esc(sourceNote)}</span></td></tr>
        </tbody></table>`;

      document.getElementById('tz-save')?.addEventListener('click', async () => {
        const btn = document.getElementById('tz-save');
        btn.disabled = true; btn.textContent = '...';
        try {
          const value = document.getElementById('tz-select')?.value || '';
          const res = await af('/api/settings/timezone', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timezone: value === '' ? null : value }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
          // Reflect the new zone immediately — a save that changes nothing
          // visible is indistinguishable from one that failed.
          const effEl = document.getElementById('tz-effective');
          const nowEl = document.getElementById('tz-now');
          if (effEl && body.effective) effEl.textContent = body.effective;
          if (nowEl && body.nowInEffective) nowEl.textContent = body.nowInEffective;
          toast(`Timezone set to ${body.effective || 'server default'}`, 'success');
        } catch (e) { toast('Failed: ' + e.message, 'error'); }
        btn.disabled = false; btn.textContent = 'Save';
      });
    } catch (e) { container.innerHTML = `<div class="settings-error">Failed: ${esc(e.message)}</div>`; }
  }

  // ── API keys — bearer credentials for external harnesses ──────────────
  async function loadApiKeys() {
    const af = authFetch();
    if (!af) return;
    const container = document.getElementById('settings-panel-apikeys');
    if (!container) return;
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await af('/api/keys');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const keys = await res.json();
      let html = '<div class="settings-section-title">API Keys</div>';
      html += '<div class="settings-hint">Feed a key to an external harness (Hermes, OpenClaw, scripts) as <code>Authorization: Bearer syn_…</code> — it can drive everything this UI can, scoped by role. Keys are shown once at creation.</div>';
      html += '<div style="display:flex;gap:8px;align-items:center;margin:8px 0">';
      html += '<input type="text" class="pace-input" id="apikey-name" placeholder="key name (e.g. hermes-laptop)" style="flex:1">';
      html += '<select class="settings-select" id="apikey-role"><option value="operator">operator — full control</option><option value="reviewer">reviewer — approvals only</option><option value="viewer">viewer — read only</option></select>';
      html += '<button class="pace-save-btn" id="apikey-create-btn">Create Key</button></div>';
      if (keys.length === 0) {
        html += '<div class="settings-hint">No keys yet.</div>';
      } else {
        html += '<table class="settings-pace-table"><thead><tr><th>Name</th><th>Role</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>';
        for (const k of keys) {
          const created = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : '';
          const used = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never';
          html += `<tr${k.revokedAt ? ' style="opacity:.45"' : ''}><td>${esc(k.name)}</td><td>${esc(k.role)}</td><td><code>${esc(k.prefix)}…</code></td><td>${esc(created)}</td><td>${esc(used)}</td>`;
          html += `<td>${k.revokedAt ? 'revoked' : `<button class="pace-save-btn apikey-revoke-btn" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>`}</td></tr>`;
        }
        html += '</tbody></table>';
      }
      container.innerHTML = html;

      document.getElementById('apikey-create-btn')?.addEventListener('click', async () => {
        const name = document.getElementById('apikey-name')?.value.trim();
        const role = document.getElementById('apikey-role')?.value || 'operator';
        if (!name) { toast('Key name required', 'error'); return; }
        try {
          const cres = await af('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, role }) });
          const data = await cres.json().catch(() => ({}));
          if (!cres.ok || data.error) throw new Error(data.error || 'HTTP ' + cres.status);
          // Shown exactly once — copyable prompt, same pattern as webhook secrets.
          window.prompt(`API key "${name}" (${role}) — copy it now, it is shown only once:`, data.key);
          toast(`Key "${name}" created`, 'success');
          loadApiKeys();
        } catch (e) { toast('Key create failed: ' + e.message, 'error'); }
      });
      container.querySelectorAll('.apikey-revoke-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Revoke key "${btn.dataset.name}"? Harnesses using it lose access immediately.`)) return;
          try {
            const rres = await af(`/api/keys/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
            if (!rres.ok) throw new Error('HTTP ' + rres.status);
            toast('Key revoked', 'success');
            loadApiKeys();
          } catch (e) { toast('Revoke failed: ' + e.message, 'error'); }
        });
      });
    } catch (e) { container.innerHTML = `<div class="settings-error">Failed: ${esc(e.message)}</div>`; }
  }

  async function toggleAllPause(pause) {
    const af = authFetch();
    if (!af) return;
    try {
      const res = await af(pause ? '/api/agents/all/pause' : '/api/agents/all/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pause ? JSON.stringify({ reason: 'Operator all-pause' }) : '{}' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const count = (data.results || []).filter(r => r.paused || r.resumed).length;
      const noun = count === 1 ? 'agent' : 'agents';
      toast(pause ? `Paused ${count} ${noun}` : `Resumed ${count} ${noun}`, 'success');
      // After a successful pause, allPaused should reflect the new state
      // (true if we just paused, false if we just resumed). The previous
      // !pause inverted this, leaving the button stuck in pause mode after
      // every pause action — second click ran pause again instead of
      // flipping to resume.
      updateAllPauseButton(pause);
      if (window.SynapseAgents?.refreshAgentHealth) window.SynapseAgents.refreshAgentHealth();
      // Header "X ready" widget reads from /api/health and must be refreshed
      // explicitly — refreshAgentHealth only updates the per-agent badges.
      if (window.SynapseBudget?.updateBudgetWidget) window.SynapseBudget.updateBudgetWidget();
    } catch (e) { toast('Failed: ' + e.message, 'error'); }
  }

  function updateAllPauseButton(allPaused) {
    const btn = document.getElementById('btn-all-pause');
    if (!btn) return;
    btn.textContent = allPaused ? '\u25B6' : '\u275A\u275A';
    btn.title = allPaused ? 'Resume All Agents' : 'Pause All Agents';
    btn.dataset.action = allPaused ? 'resume' : 'pause';
    btn.classList.toggle('all-resume', allPaused);
  }

  document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);
  document.getElementById('settings-close-btn')?.addEventListener('click', closeSettingsModal);
  // Sign out — POST /api/auth/logout existed with zero UI callers; there was
  // no way to end a session short of clearing the cookie by hand.
  document.getElementById('settings-logout-btn')?.addEventListener('click', async () => {
    try {
      const af = authFetch();
      if (af) await af('/api/auth/logout', { method: 'POST' });
    } catch { /* cookie may already be gone */ }
    window.location.href = '/login';
  });
  document.getElementById('modal-settings')?.addEventListener('click', (e) => { if (e.target.id === 'modal-settings') closeSettingsModal(); });
  document.getElementById('btn-all-pause')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-all-pause');
    toggleAllPause((btn?.dataset.action || 'pause') === 'pause');
  });
  document.querySelectorAll('.settings-tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  return { openSettingsModal, toggleAllPause, updateAllPauseButton, toast };
}
