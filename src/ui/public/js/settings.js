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

  function switchTab(tab) {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.settings-tab-panel').forEach(p => p.style.display = p.id === `settings-panel-${tab}` ? '' : 'none');
    const loaders = { projects: loadProjects, pacing: loadPacing, routing: loadRouting, circuitbreaker: loadCircuitBreaker, tasks: loadTasks, apikeys: loadApiKeys };
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
        html += `</div>`;
        html += `</td></tr>`;
      }
      html += '</tbody></table>';
      container.innerHTML = html;

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
        </tbody></table>`;
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
