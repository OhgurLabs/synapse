/**
 * @module loops.js
 * @domain Top-Level Loops & Sub-Projects Surface (Phase 2B — Stage 4)
 * @description Renders the top-level Loops sidebar peer view:
 *   - Loops list (scope, frozen loopVersion, next fire + timezone, last verdict)
 *   - Loop detail (versioned DAG nodes & Anchors table — no visual canvas builder)
 *   - Manual "Run now" with resolved scope, version, and typed parameter inputs
 *   - Preset schedule selector (hourly | daily-at | weekly-at | weekdays-at + raw cron)
 *     with overlap/missedRun controls and server-computed next 3 fire slots
 *   - Run history table with verdict badges, Anchor assertion summary, operator
 *     Approve/Cancel actions, and Evidence Packet SHA256 inspector
 *
 * @namespace window.SynapseLoops
 */
(function () {
  'use strict';

  let activeView = 'projects'; // 'projects' | 'loops'
  let scopeFilter = '';        // '' = all, '__global__' = global, else projectId
  let loopsList = [];
  let projectsList = [];
  let selectedLoopId = null;
  let selectedLoopDetail = null;
  let inspectedEvidence = null;
  let selectedRunId = null;
  let selectedRun = null;
  let proofSummary = null;
  let runRequest = 0;
  let statusNotice = '';

  function esc(str) {
    if (window.SynapseHealth && typeof window.SynapseHealth.escapeHtml === 'function') {
      return window.SynapseHealth.escapeHtml(String(str ?? ''));
    }
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function apiFetch(url, opts = {}) {
    if (window.SynapseWebSocket && typeof window.SynapseWebSocket.authFetch === 'function') {
      return window.SynapseWebSocket.authFetch(url, opts);
    }
    return fetch(url, { credentials: 'same-origin', ...opts });
  }

  function verdictBadge(verdict, phase) {
    const label = verdict || phase || 'unknown';
    const cls = verdict ? `verdict-${verdict}` : (phase === 'awaiting_approval' ? 'verdict-awaiting_approval' : '');
    return `<span class="loop-badge ${esc(cls)}">${esc(label)}</span>`;
  }

  function shortSha(sha) {
    if (!sha || typeof sha !== 'string') return '—';
    return sha.slice(0, 10);
  }

  function formatAnchorSummary(anchors) {
    if (!Array.isArray(anchors) || anchors.length === 0) return 'No anchors';
    const passed = anchors.filter(a => a.outcome === 'passed').length;
    const failed = anchors.filter(a => a.outcome === 'failed').length;
    const indet = anchors.filter(a => a.outcome === 'indeterminate').length;
    return `${passed}/${anchors.length} passed${failed ? `, ${failed} failed` : ''}${indet ? `, ${indet} indet` : ''}`;
  }

  function setActiveView(view) {
    activeView = view === 'loops' ? 'loops' : 'projects';
    const tabProjects = document.getElementById('nav-tab-projects');
    const tabLoops = document.getElementById('nav-tab-loops');
    const tabPrs = document.getElementById('nav-tab-prs');
    const loopsView = document.getElementById('loops-view');
    const prsView = document.getElementById('prs-view');
    const messagesEl = document.getElementById('messages');
    const threadBar = document.getElementById('thread-filter-bar');
    const inputArea = document.getElementById('input-area');

    if (tabProjects) {
      tabProjects.classList.toggle('active', activeView === 'projects');
      tabProjects.setAttribute('aria-selected', String(activeView === 'projects'));
    }
    if (tabLoops) {
      tabLoops.classList.toggle('active', activeView === 'loops');
      tabLoops.setAttribute('aria-selected', String(activeView === 'loops'));
    }
    if (tabPrs) {
      tabPrs.classList.remove('active');
      tabPrs.setAttribute('aria-selected', 'false');
    }
    if (prsView) prsView.style.display = 'none';
    if (window.SynapsePrs && typeof window.SynapsePrs.close === 'function') window.SynapsePrs.close();
    if (loopsView) loopsView.style.display = activeView === 'loops' ? 'flex' : 'none';
    if (messagesEl) messagesEl.style.display = activeView === 'loops' ? 'none' : '';
    if (threadBar && activeView === 'loops') threadBar.style.display = 'none';
    if (inputArea) inputArea.style.display = activeView === 'loops' ? 'none' : '';

    if (activeView === 'loops') {
      refreshAll();
    }
  }

  async function refreshAll() {
    statusNotice = '';
    try {
      const [projRes, loopsRes] = await Promise.all([
        apiFetch('/api/projects'),
        apiFetch(buildLoopsQueryUrl()),
      ]);
      if (projRes && projRes.ok) {
        const pData = await projRes.json();
        projectsList = Array.isArray(pData) ? pData : (pData.projects || []);
      }
      if (loopsRes && loopsRes.ok) {
        const lData = await loopsRes.json();
        loopsList = Array.isArray(lData?.loops) ? lData.loops : [];
      } else {
        const errText = loopsRes ? await loopsRes.text() : 'request failed';
        statusNotice = `Failed to load loops: ${errText}`;
      }
      if (selectedLoopId && !loopsList.some(l => l.loopId === selectedLoopId)) {
        selectedLoopId = loopsList[0]?.loopId || null;
        selectedLoopDetail = null;
      } else if (!selectedLoopId && loopsList.length > 0) {
        selectedLoopId = loopsList[0].loopId;
      }
      if (selectedLoopId) {
        await loadLoopDetail(selectedLoopId);
      } else {
        selectedLoopDetail = null;
      }
    } catch (err) {
      statusNotice = `Error loading loops: ${err.message}`;
    }
    render();
  }

  function buildLoopsQueryUrl() {
    if (scopeFilter === '__global__') return '/api/loops?scope=global';
    if (scopeFilter) return `/api/loops?projectId=${encodeURIComponent(scopeFilter)}`;
    return '/api/loops';
  }

  const runUrl = id => `/api/loops/runs/${encodeURIComponent(id)}`;

  async function loadRunDetail(runId) {
    const request = ++runRequest;
    selectedRunId = runId;
    selectedRun = proofSummary = inspectedEvidence = null;
    if (!runId) return;
    try {
      const response = await apiFetch(runUrl(runId));
      if (!response?.ok) throw new Error('Run detail unavailable');
      const run = await response.json();
      if (request !== runRequest) return;
      selectedRun = run;
      render();
      if (!run.proofAvailable) return;
      const proof = await apiFetch(runUrl(runId) + '/evidence');
      if (!proof?.ok) return;
      const data = await proof.json();
      if (request === runRequest && data.verified &&
          (!run._evidence?.evidencePacketSha256 || data.evidencePacketSha256 === run._evidence.evidencePacketSha256)) {
        proofSummary = data.proofSummary;
      }
    } catch {
      if (request === runRequest && !selectedRun) statusNotice = 'Run detail unavailable.';
    }
  }

  async function loadLoopDetail(loopId) {
    selectedLoopId = loopId;
    const request = ++runRequest;
    selectedRun = proofSummary = inspectedEvidence = null;
    try {
      const res = await apiFetch(`/api/loops/${encodeURIComponent(loopId)}`);
      if (!res?.ok) throw new Error('Loop detail unavailable');
      const detail = await res.json();
      if (request !== runRequest) return;
      selectedLoopDetail = detail;
      const runs = detail.runs || [];
      await loadRunDetail(runs.find(r => r.runId === selectedRunId)?.runId ?? runs[0]?.runId);
    } catch {
      if (request === runRequest) selectedLoopDetail = null;
    }
  }

  function renderRunDetail() {
    const run = selectedRun;
    if (!run) return '';
    const wait = run.waitReason;
    const checker = run.attemptLineage?.checker;
    const proof = proofSummary;
    const rows = (run.attemptLineage?.nodes || []).flatMap(node => node.attempts.map(attempt => `<tr>
      <td><code>${esc(node.nodeId)}</code></td>
      <td><code>${esc(attempt.attemptId)}</code>${node.selectedAttemptId === attempt.attemptId ? ' · Selected' : ''}</td>
      <td>${esc([attempt.agentId, attempt.harness].filter(Boolean).join(' · ') || '—')}</td>
      <td><code>${esc(attempt.worktree ?? '—')}</code></td>
      <td>${esc(attempt.status)}${attempt.evictionReason ? ' · ' + esc(attempt.evictionReason) : ''}</td>
      <td>${esc(attempt.fenceToken ?? '—')}</td>
    </tr>`)).join('');
    return `<div class="loops-card">
      <h3>Run <code>${esc(run.runId)}</code> ${verdictBadge(run.verdict, run.phase)}</h3>
      ${wait ? `<p class="loop-list-meta" role="status"><strong>Why It’s Waiting</strong> ${esc(wait.message)}
        ${wait.resetAt ? `<time datetime="${esc(wait.resetAt)}">Cooldown until ${esc(new Date(wait.resetAt).toLocaleString())}</time>` : ''}</p>` : ''}
      ${proof ? `<h4>Verified Proof</h4><div class="loop-list-meta">
        <span>Anchor verdict <strong>${esc(proof.anchorVerdict)}</strong> (${esc(proof.anchorsVerified)})</span>
        ${proof.checker ? `<span>Checker <strong>${esc(proof.checker.agentId ?? '—')}</strong>
          <code title="${esc(proof.checker.sha256)}">${esc(shortSha(proof.checker.sha256))}</code></span>` : ''}
        ${proof.approvedSourceSha ? `<span>Approved source <code>${esc(proof.approvedSourceSha)}</code></span>` : ''}
      </div>` : ''}
      ${run.proofAvailable ? `<button class="loops-btn" data-download-proof="${esc(run.runId)}">Download Proof Bundle</button>` : ''}
      <h4>Attempt Lineage</h4>
      ${checker ? `<p class="loop-list-meta">Independent checker ${esc([checker.agentId, checker.provider, checker.verdict].filter(Boolean).join(' · '))}</p>` : ''}
      ${rows ? `<table class="loops-table"><thead><tr><th>Node</th><th>Attempt</th><th>Agent / harness</th>
        <th>Worktree</th><th>Status</th><th>Fence</th></tr></thead><tbody>${rows}</tbody></table>` :
        '<p class="loop-list-meta">No attempts recorded.</p>'}
    </div>`;
  }

  function comparisonElement(tag, text) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = String(text);
    return element;
  }

  function comparisonTable(heading, rows, { digestCells = false } = {}) {
    const table = comparisonElement('table');
    table.className = 'loops-table';
    const header = comparisonElement('tr');
    for (const text of [heading, 'Run A', 'Run B']) {
      const cell = comparisonElement('th', text);
      cell.scope = 'col';
      header.append(cell);
    }
    const head = comparisonElement('thead');
    head.append(header);
    const body = comparisonElement('tbody');
    for (const [label, a, b] of rows) {
      const row = comparisonElement('tr');
      const cell = comparisonElement('th', label);
      cell.scope = 'row';
      row.append(cell);
      for (const value of [a, b]) {
        const data = comparisonElement('td', (digestCells && value ? shortSha(value) : value) ?? '—');
        if (digestCells && value) data.title = value;
        row.append(data);
      }
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function renderRunComparison(panel, { sharedContext, runA, runB, anchorDeltas, wallClockDeltaMs, outputDiffs }) {
    const context = comparisonElement('p', [
      sharedContext.projectId || 'Global', `Loop v${sharedContext.loopVersion}`, `Base ${shortSha(sharedContext.baseSha)}`,
      `Inputs ${shortSha(sharedContext.inputsDigest)}`,
    ].join(' · '));
    context.className = 'loop-list-meta';
    const checker = run => run.checker && [run.checker.agentId, run.checker.provider, run.checker.verdict].filter(Boolean).join(' · ');
    const workers = run => run.selectedWorkers.map(worker =>
      [worker.nodeId, worker.selectedAttemptId, worker.agentId, worker.harness].filter(Boolean).join(' · ')).join(', ');
    const delta = comparisonElement('p', `Wall-clock change (B − A) ${wallClockDeltaMs > 0 ? '+' : ''}${wallClockDeltaMs} ms · ${anchorDeltas.length} Anchor changes`);
    const summary = comparisonTable('Run summary', [
      ['ID', runA.runId, runB.runId],
      ['Verdict', runA.verdict ?? runA.phase, runB.verdict ?? runB.phase],
      ['Selected attempts', workers(runA) || null, workers(runB) || null],
      ['Wall clock', `${runA.wallClockMs} ms`, `${runB.wallClockMs} ms`],
      ['Checker', checker(runA), checker(runB)],
      ...runA.anchorOutcomes.map((anchor, index) => [
        `Anchor ${anchor.anchorId} · ${anchor.nodeId}`, anchor.outcome, runB.anchorOutcomes[index]?.outcome,
      ]),
    ]);
    const diffRows = [
      ...outputDiffs.added.map(file => [`Added · ${file.nodeId}/${file.path}`, null, file.sha256]),
      ...outputDiffs.removed.map(file => [`Removed · ${file.nodeId}/${file.path}`, file.sha256, null]),
      ...outputDiffs.changed.map(file => [`Changed · ${file.nodeId}/${file.path}`, file.sha256A, file.sha256B]),
    ];
    const diffTable = diffRows.length ? comparisonTable('Output digest changes', diffRows, { digestCells: true })
      : comparisonElement('p', 'No output digest changes.');
    panel.replaceChildren(context, summary, delta, diffTable);
  }

  function mountRunComparison(parent, runs) {
    const candidates = runs.filter(run => ['terminal', 'awaiting_approval'].includes(run.phase));
    if (candidates.length < 2) return;
    const section = comparisonElement('section');
    section.className = 'loops-card';
    const fields = comparisonElement('div');
    fields.className = 'loops-form-grid';
    const selects = ['Run A', 'Run B'].map((name, index) => {
      const label = comparisonElement('label', name);
      const select = comparisonElement('select');
      for (const run of candidates) {
        const option = comparisonElement('option', `${run.runId} · ${run.verdict ?? run.phase}`);
        option.value = run.runId;
        select.append(option);
      }
      select.selectedIndex = index;
      label.append(select);
      fields.append(label);
      return select;
    });
    const button = comparisonElement('button', 'Compare Runs');
    button.className = 'loops-btn';
    button.type = 'button';
    const status = comparisonElement('p');
    status.setAttribute('role', 'status');
    const panel = comparisonElement('div');
    const [a, b] = selects;
    const updateButton = () => { button.disabled = a.value === b.value; };
    for (const select of selects) select.addEventListener('change', () => {
      panel.replaceChildren();
      status.textContent = '';
      updateButton();
    });
    button.addEventListener('click', async () => {
      button.disabled = a.disabled = b.disabled = true;
      panel.replaceChildren();
      status.textContent = 'Comparing runs…';
      try {
        const query = new URLSearchParams({ runA: a.value, runB: b.value });
        const response = await apiFetch(`/api/loops/compare?${query}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Comparison unavailable');
        renderRunComparison(panel, result);
        status.textContent = '';
      } catch (err) {
        status.textContent = err.message;
      } finally {
        a.disabled = b.disabled = false;
        updateButton();
      }
    });
    updateButton();
    section.append(fields, button, status, panel);
    parent.append(section);
  }

  function renderScopeOptions() {
    const opts = [
      `<option value="" ${scopeFilter === '' ? 'selected' : ''}>All scopes</option>`,
      `<option value="__global__" ${scopeFilter === '__global__' ? 'selected' : ''}>Global (Standalone)</option>`,
    ];
    for (const p of projectsList) {
      if (p.sealed) continue;
      const prefix = p.parentProjectId ? '↳ ' : '';
      const label = `${prefix}${p.displayName || p.id}${p.parentProjectId ? ` (${p.parentProjectId})` : ''}`;
      opts.push(`<option value="${esc(p.id)}" ${scopeFilter === p.id ? 'selected' : ''}>${esc(label)}</option>`);
    }
    return opts.join('');
  }

  function renderDetailPane() {
    const d = selectedLoopDetail;
    if (!d) {
      return `<div class="loops-card"><p style="margin:0;color:var(--text-secondary,#9aa4b2)">Select a Loop to inspect its frozen DAG, schedule, runs, and evidence packets.</p></div>`;
    }

    const manifest = d.manifest || {};
    const nodes = Array.isArray(manifest.nodes) ? manifest.nodes : [];
    const anchors = Array.isArray(manifest.anchors) ? manifest.anchors : [];
    const paramsSpec = manifest.paramsSchema?.properties || manifest.params || {};
    const requiredParams = new Set(Array.isArray(manifest.paramsSchema?.required) ? manifest.paramsSchema.required : []);
    const runs = Array.isArray(d.runs) ? d.runs : [];
    const sched = d.schedule || {};
    const schedCadence = manifest.schedule?.cadence || {};
    const currentPreset = schedCadence.cron ? 'cron' : (schedCadence.preset || 'hourly');
    const nextFires = Array.isArray(sched.nextFires) ? sched.nextFires : [];

    // Build typed parameter form inputs
    const paramInputsHtml = Object.entries(paramsSpec).length === 0
      ? '<div style="font-size:12px;color:var(--text-secondary,#9aa4b2);margin-bottom:8px">No typed parameters declared on this Loop.</div>'
      : `<div class="loops-form-grid">${Object.entries(paramsSpec).map(([k, spec]) => {
          const rawDef = manifest.defaults?.[k] !== undefined ? manifest.defaults[k] : spec?.default;
          const defHint = rawDef !== undefined ? `default: ${String(rawDef)}` : (spec?.description || 'override');
          const typeLabel = spec?.type || 'string';
          return `<label>${esc(k)} (${esc(typeLabel)}${(spec?.required || requiredParams.has(k)) ? ', required' : ''})
            <input type="text" data-loop-param="${esc(k)}" data-loop-param-type="${esc(typeLabel)}" value="" placeholder="${esc(defHint)}">
          </label>`;
        }).join('')}</div>`;

    // Target sub-project selector (only shows descendants if bound to a parent, or all workable projects if global)
    const eligibleTargets = projectsList.filter(p => !p.sealed && (!d.projectId || p.id === d.projectId || p.parentProjectId === d.projectId));
    const targetSelectHtml = eligibleTargets.length > 0
      ? `<label>Target scope (optional sub-project)
          <select id="loop-run-target">
            <option value="${esc(d.projectId || '')}">Default (${esc(d.scopeLabel || 'Global')})</option>
            ${eligibleTargets.filter(p => p.id !== d.projectId).map(p =>
              `<option value="${esc(p.id)}">${esc(p.parentProjectId ? '↳ ' : '')}${esc(p.displayName || p.id)}</option>`
            ).join('')}
          </select>
        </label>`
      : '';

    const nodesRows = nodes.map(n => `<tr>
      <td><code>${esc(n.nodeId)}</code></td>
      <td><span class="loop-badge">${esc(n.kind)}</span></td>
      <td>${esc(n.workspace || '—')}</td>
      <td>${esc((n.dependsOn || []).join(', ') || '—')}</td>
      <td>${esc((n.outputs || []).map(o => `${o.path} (${o.storage})`).join(', ') || '—')}</td>
    </tr>`).join('');

    const anchorRows = anchors.length === 0
      ? '<tr><td colspan="4" style="color:var(--text-secondary,#9aa4b2)">No Anchors declared (clean runs conclude as <code>completed_unverified</code>).</td></tr>'
      : anchors.map(a => `<tr>
          <td><code>${esc(a.anchorId)}</code></td>
          <td><code>${esc(a.runnerId)}</code></td>
          <td>${esc((a.requiredAssertions || []).join(', '))}</td>
          <td><code>${esc(shortSha(a.implementationDigest))}</code></td>
        </tr>`).join('');

    const runRows = runs.length === 0
      ? '<tr><td colspan="7" style="color:var(--text-secondary,#9aa4b2)">No runs recorded yet.</td></tr>'
      : runs.map(r => {
          const srcSha = r.provenance?.source?.postIntegrationHeadSha || r.provenance?.source?.baseSha || null;
          const evSha = r._evidence?.evidencePacketSha256 || null;
          const canApprove = r.phase === 'awaiting_approval';
          const canCancel = r.phase === 'queued' || r.phase === 'running';
          return `<tr>
            <td><button class="loops-btn" aria-pressed="${r.runId === selectedRunId}" data-select-run="${esc(r.runId)}"><code>${esc(r.runId)}</code></button></td>
            <td>v${esc(r.pin?.loopVersion ?? '?')}</td>
            <td>${verdictBadge(r.verdict, r.phase)}${r.reasonCode ? `<div style="font-size:10px;color:#f85149">${esc(r.reasonCode)}</div>` : ''}</td>
            <td>${esc(formatAnchorSummary(r.anchors))}</td>
            <td><code>${esc(shortSha(srcSha))}</code></td>
            <td>${r.verdict === 'passed' ? `${evSha ? `<code>${esc(shortSha(evSha))}</code> ` : ''}<button class="loops-btn" data-inspect-evidence="${esc(r.runId)}">Inspect</button>` : '—'}</td>
            <td>
              ${canApprove ? `<button class="loops-btn loops-btn-primary" data-approve-run="${esc(r.runId)}">Approve</button>` : ''}
              ${canCancel ? `<button class="loops-btn" data-cancel-run="${esc(r.runId)}">Cancel</button>` : ''}
            </td>
          </tr>`;
        }).join('');

    const evidencePanel = inspectedEvidence ? `
      <div class="loops-card" style="border-color:var(--accent,#58a6ff)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>Evidence Packet — <code>${esc(inspectedEvidence.runId)}</code></h3>
          <button class="loops-btn" id="btn-close-evidence">Close</button>
        </div>
        <div class="loop-list-meta" style="margin-bottom:8px">
          <span>Verified: <strong style="color:#3fb950">${inspectedEvidence.verified ? 'YES' : 'NO'}</strong></span>
          <span>Packet SHA-256: <code>${esc(inspectedEvidence.evidencePacketSha256)}</code></span>
          <span>SHA256SUMS: <code>${esc(inspectedEvidence.checksumManifestSha256)}</code></span>
        </div>
        <pre class="loops-pre">${esc(inspectedEvidence.checksumManifest || '')}</pre>
        <pre class="loops-pre">${esc(JSON.stringify(inspectedEvidence.evidencePacket || {}, null, 2))}</pre>
      </div>` : '';

    return `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="loops-card">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div>
              <h3 style="margin:0">${esc(d.title || d.loopId)} <span class="loop-badge">v${esc(d.currentVersion)}</span></h3>
              <div class="loop-list-meta">
                <span>ID: <code>${esc(d.loopId)}</code></span>
                <span>Scope: <strong>${esc(d.scopeLabel)}</strong></span>
                <span>Evidence: <code>${esc(d.evidenceMode)}</code></span>
                <span>Hash: <code>${esc(shortSha(d.manifestHash))}</code></span>
              </div>
            </div>
          </div>
          ${d.description ? `<p style="margin:8px 0 0;font-size:12px;color:var(--text-secondary,#9aa4b2)">${esc(d.description)}</p>` : ''}
        </div>

        <div class="loops-card">
          <h3>Run Now (Resolved: ${esc(d.scopeLabel)} @ v${esc(d.currentVersion)})</h3>
          ${targetSelectHtml ? `<div class="loops-form-grid">${targetSelectHtml}</div>` : ''}
          ${paramInputsHtml}
          <button class="loops-btn loops-btn-primary" id="btn-loop-run-now">▶ Run now</button>
        </div>

        <div class="loops-card">
          <h3>Schedule ${sched.enabled ? '<span class="loop-badge verdict-passed">ARMED</span>' : '<span class="loop-badge">DISARMED</span>'}</h3>
          <div class="loops-form-grid">
            <label>Cadence preset
              <select id="sched-preset">
                <option value="hourly" ${currentPreset === 'hourly' ? 'selected' : ''}>Hourly</option>
                <option value="daily-at" ${currentPreset === 'daily-at' ? 'selected' : ''}>Daily at</option>
                <option value="weekdays-at" ${currentPreset === 'weekdays-at' ? 'selected' : ''}>Weekdays at</option>
                <option value="weekly-at" ${currentPreset === 'weekly-at' ? 'selected' : ''}>Weekly at</option>
                <option value="cron" ${currentPreset === 'cron' ? 'selected' : ''}>Raw cron</option>
              </select>
            </label>
            <label>Minute (hourly)
              <input id="sched-minute" type="number" min="0" max="59" value="${esc(schedCadence.minute ?? 0)}">
            </label>
            <label>Time HH:MM (daily/weekly)
              <input id="sched-time" type="text" value="${esc(schedCadence.time || '09:00')}" placeholder="09:00">
            </label>
            <label>Day 0-6 Sun-Sat (weekly)
              <input id="sched-day" type="number" min="0" max="6" value="${esc(schedCadence.day ?? 1)}">
            </label>
            <label>Raw cron (5 fields)
              <input id="sched-cron" type="text" value="${esc(schedCadence.cron || sched.cron || '')}" placeholder="0 9 * * 1-5">
            </label>
            <label>Timezone (IANA)
              <input id="sched-tz" type="text" value="${esc(sched.timezone || manifest.schedule?.timezone || 'UTC')}">
            </label>
            <label>Overlap policy
              <select id="sched-overlap">
                <option value="skip" ${(manifest.schedule?.overlap || 'skip') === 'skip' ? 'selected' : ''}>skip</option>
                <option value="queue" ${manifest.schedule?.overlap === 'queue' ? 'selected' : ''}>queue</option>
                <option value="cancel-prior" ${manifest.schedule?.overlap === 'cancel-prior' ? 'selected' : ''}>cancel-prior</option>
              </select>
            </label>
            <label>Missed-run policy
              <select id="sched-missed">
                <option value="skip" ${(manifest.schedule?.missedRun || 'skip') === 'skip' ? 'selected' : ''}>skip</option>
                <option value="run-once-if-missed" ${manifest.schedule?.missedRun === 'run-once-if-missed' ? 'selected' : ''}>run-once-if-missed</option>
              </select>
            </label>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="loops-btn loops-btn-primary" id="btn-sched-save">Save &amp; Arm Schedule</button>
            ${sched.enabled ? `<button class="loops-btn" id="btn-sched-disarm">Disarm</button>` : ''}
            ${sched.cron ? `<span style="font-size:11px;color:var(--text-secondary,#9aa4b2)">Compiled cron: <code>${esc(sched.cron)}</code> (${esc(sched.timezone || 'UTC')})</span>` : ''}
          </div>
          ${nextFires.length > 0 ? `<div style="margin-top:8px;font-size:11px;color:var(--text-secondary,#9aa4b2)">
            <strong>Next 3 fire slots (UTC):</strong> ${nextFires.map(s => `<code>${esc(s)}</code>`).join(' · ')}
          </div>` : ''}
        </div>

        <div class="loops-card">
          <h3>Frozen DAG — Nodes (${nodes.length}) &amp; Anchors (${anchors.length})</h3>
          <table class="loops-table">
            <thead><tr><th>Node</th><th>Kind</th><th>Workspace</th><th>Depends On</th><th>Outputs</th></tr></thead>
            <tbody>${nodesRows}</tbody>
          </table>
          <table class="loops-table" style="margin-top:10px">
            <thead><tr><th>Anchor</th><th>Runner</th><th>Required Assertions</th><th>Digest</th></tr></thead>
            <tbody>${anchorRows}</tbody>
          </table>
        </div>

        ${renderRunDetail()}
        ${evidencePanel}

        <div class="loops-card">
          <h3>Recent LoopRuns (${runs.length})</h3>
          <table class="loops-table">
            <thead><tr><th>Run ID</th><th>Ver</th><th>Verdict</th><th>Anchors</th><th>Source SHA</th><th>Evidence</th><th>Actions</th></tr></thead>
            <tbody>${runRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function render() {
    const container = document.getElementById('loops-view');
    if (!container) return;

    const listHtml = loopsList.length === 0
      ? '<div class="loops-card"><p style="margin:0;font-size:12px;color:var(--text-secondary,#9aa4b2)">No Loops published for this scope yet. Publish via <code>POST /api/loops</code> or MCP <code>loop.publish</code>.</p></div>'
      : loopsList.map(lp => `
          <div class="loop-list-item ${lp.loopId === selectedLoopId ? 'selected' : ''}" data-select-loop="${esc(lp.loopId)}">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <strong>${esc(lp.title || lp.loopId)}</strong>
              <span class="loop-badge">v${esc(lp.currentVersion)}</span>
            </div>
            <div class="loop-list-meta">
              <span>Scope: ${esc(lp.scopeLabel)}</span>
              <span>${lp.schedule?.enabled && lp.schedule?.nextFireUtc ? `Next: ${esc(lp.schedule.nextFireUtc)} (${esc(lp.schedule.timezone || 'UTC')})` : 'Manual'}</span>
              <span>${lp.lastRun ? verdictBadge(lp.lastRun.verdict, lp.lastRun.phase) : '<span class="loop-badge">never run</span>'}</span>
            </div>
          </div>
        `).join('');

    container.innerHTML = `
      <div class="loops-toolbar">
        <h2>Loops</h2>
        <div class="loops-controls">
          <select id="loops-scope-filter" aria-label="Filter Loops by scope">${renderScopeOptions()}</select>
          <button class="loops-btn" id="btn-loops-refresh">↻ Refresh</button>
        </div>
      </div>
      ${statusNotice ? `<div class="loops-card" style="border-color:#d29922;color:#e3b341;font-size:12px">${esc(statusNotice)}</div>` : ''}
      <div class="loops-layout">
        <div>${listHtml}</div>
        <div>${renderDetailPane()}</div>
      </div>
    `;

    const detail = container.querySelector('.loops-layout > div:last-child > div');
    if (detail && selectedLoopDetail) mountRunComparison(detail, selectedLoopDetail.runs || []);
    bindEvents(container);
  }

  function bindEvents(container) {
    const scopeSel = container.querySelector('#loops-scope-filter');
    if (scopeSel) {
      scopeSel.addEventListener('change', () => {
        scopeFilter = scopeSel.value;
        refreshAll();
      });
    }
    const refBtn = container.querySelector('#btn-loops-refresh');
    if (refBtn) refBtn.addEventListener('click', () => refreshAll());

    container.querySelectorAll('[data-select-loop]').forEach(el => {
      el.addEventListener('click', async () => {
        await loadLoopDetail(el.getAttribute('data-select-loop'));
        render();
      });
    });

    const runBtn = container.querySelector('#btn-loop-run-now');
    if (runBtn && selectedLoopDetail) {
      runBtn.addEventListener('click', async () => {
        const params = {};
        container.querySelectorAll('[data-loop-param]').forEach(inp => {
          const k = inp.getAttribute('data-loop-param');
          const t = inp.getAttribute('data-loop-param-type');
          const raw = inp.value;
          if (raw === '') return;
          if (t === 'number' || t === 'integer') params[k] = Number(raw);
          else if (t === 'boolean') params[k] = raw === 'true';
          else params[k] = raw;
        });
        const targetSel = container.querySelector('#loop-run-target');
        const targetId = targetSel && targetSel.value ? targetSel.value : null;
        const body = { loopVersion: selectedLoopDetail.currentVersion, params };
        if (targetId) body.subProjectId = targetId;
        const res = await apiFetch(`/api/loops/${encodeURIComponent(selectedLoopDetail.loopId)}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res && res.ok) {
          const out = await res.json();
          statusNotice = `Queued run ${out.runId} at v${out.resolvedVersion}`;
        } else {
          statusNotice = `Run failed: ${res ? await res.text() : 'network error'}`;
        }
        await refreshAll();
      });
    }

    const saveSchedBtn = container.querySelector('#btn-sched-save');
    if (saveSchedBtn && selectedLoopDetail) {
      saveSchedBtn.addEventListener('click', async () => {
        const preset = container.querySelector('#sched-preset')?.value || 'hourly';
        let cadence;
        if (preset === 'cron') {
          cadence = { cron: (container.querySelector('#sched-cron')?.value || '').trim() };
        } else if (preset === 'hourly') {
          cadence = { preset: 'hourly', minute: Number(container.querySelector('#sched-minute')?.value || 0) };
        } else if (preset === 'weekly-at') {
          cadence = {
            preset: 'weekly-at',
            day: Number(container.querySelector('#sched-day')?.value || 1),
            time: (container.querySelector('#sched-time')?.value || '09:00').trim(),
          };
        } else {
          cadence = { preset, time: (container.querySelector('#sched-time')?.value || '09:00').trim() };
        }
        const payload = {
          cadence,
          timezone: (container.querySelector('#sched-tz')?.value || 'UTC').trim(),
          overlap: container.querySelector('#sched-overlap')?.value || 'skip',
          missedRun: container.querySelector('#sched-missed')?.value || 'skip',
        };
        const res = await apiFetch(`/api/loops/${encodeURIComponent(selectedLoopDetail.loopId)}/schedules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res && res.ok) {
          const out = await res.json();
          statusNotice = `Armed schedule v${out.loopVersion} (${out.cron} ${out.timezone})`;
        } else {
          statusNotice = `Schedule update failed: ${res ? await res.text() : 'network error'}`;
        }
        await refreshAll();
      });
    }

    const disarmBtn = container.querySelector('#btn-sched-disarm');
    if (disarmBtn && selectedLoopDetail?.schedule?.scheduleId) {
      disarmBtn.addEventListener('click', async () => {
        const res = await apiFetch(`/api/loops/schedules/${encodeURIComponent(selectedLoopDetail.schedule.scheduleId)}`, {
          method: 'DELETE',
        });
        statusNotice = res && res.ok ? 'Schedule disarmed.' : `Disarm failed: ${res ? await res.text() : 'error'}`;
        await refreshAll();
      });
    }

    container.querySelectorAll('[data-select-run]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await loadRunDetail(btn.dataset.selectRun);
        render();
      });
    });

    container.querySelectorAll('[data-download-proof]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.dataset.downloadProof;
        btn.disabled = true;
        try {
          const response = await apiFetch(runUrl(runId) + '/evidence/download');
          if (!response?.ok) throw new Error(`Proof download failed (HTTP ${response?.status ?? 'error'}).`);
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement('a');
          link.href = url;
          link.download = `synapse-evidence-${runId}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
          statusNotice = err.message;
          render();
        } finally {
          btn.disabled = false;
        }
      });
    });

    container.querySelectorAll('[data-inspect-evidence]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.getAttribute('data-inspect-evidence');
        if (runId !== selectedRunId) await loadRunDetail(runId);
        const request = runRequest;
        const res = await apiFetch(runUrl(runId) + '/evidence');
        if (request !== runRequest || runId !== selectedRunId) return;
        if (res && res.ok) {
          inspectedEvidence = await res.json();
        } else {
          statusNotice = `Evidence unavailable: ${res ? await res.text() : 'error'}`;
        }
        render();
      });
    });

    const closeEv = container.querySelector('#btn-close-evidence');
    if (closeEv) {
      closeEv.addEventListener('click', () => {
        inspectedEvidence = null;
        render();
      });
    }

    container.querySelectorAll('[data-cancel-run]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.getAttribute('data-cancel-run');
        const res = await apiFetch(`/api/loops/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        statusNotice = res && res.ok ? `Cancellation requested for ${runId}` : `Cancel failed: ${res ? await res.text() : 'error'}`;
        await refreshAll();
      });
    });

    container.querySelectorAll('[data-approve-run]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.getAttribute('data-approve-run');
        const run = (selectedLoopDetail?.runs || []).find(r => r.runId === runId);
        const summary = run?.approvalSummary || {};
        const sha = summary.approvedSourceSha || run?.provenance?.source?.postIntegrationHeadSha || '';
        const revSha = summary.reviewSha256 || run?._checkerReview?.report?.sha256 || '';
        const defaultAnchorSha = summary.anchorSetSha256 || '';
        const userAnchorSha = window.prompt(`Approve run ${runId} at SHA ${sha}\nReview SHA-256: ${revSha}\nConfirm anchorSetSha256:`, defaultAnchorSha);
        if (!userAnchorSha) return;
        const payload = buildApprovePayload(run, userAnchorSha);
        const res = await apiFetch(`/api/loops/runs/${encodeURIComponent(runId)}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        statusNotice = res && res.ok ? `Approved ${runId}` : `Approval failed: ${res ? await res.text() : 'error'}`;
        await refreshAll();
      });
    });
  }

  function openLoopsForScope(projectId = '') {
    scopeFilter = projectId || '';
    setActiveView('loops');
  }

  function init() {
    const tabProjects = document.getElementById('nav-tab-projects');
    const tabLoops = document.getElementById('nav-tab-loops');
    if (tabProjects) tabProjects.addEventListener('click', () => setActiveView('projects'));
    if (tabLoops) tabLoops.addEventListener('click', () => setActiveView('loops'));

    window.addEventListener('synapse:open-loops', (ev) => {
      openLoopsForScope(ev?.detail?.projectId || '');
    });
    window.addEventListener('synapse:open-projects', () => {
      setActiveView('projects');
    });
  }

  function buildApprovePayload(run, confirmedAnchorSha) {
    const summary = run?.approvalSummary || {};
    return {
      approvedSourceSha: summary.approvedSourceSha || run?.provenance?.source?.postIntegrationHeadSha || '',
      reviewSha256: summary.reviewSha256 || run?._checkerReview?.report?.sha256 || '',
      anchorSetSha256: String(confirmedAnchorSha || '').trim(),
    };
  }

  window.SynapseLoops = {
    init,
    openLoopsForScope,
    setActiveView,
    refreshAll,
    buildApprovePayload,
  };
})();
