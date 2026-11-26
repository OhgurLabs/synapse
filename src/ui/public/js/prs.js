(function () {
  'use strict';

  const host = typeof window === 'undefined' ? globalThis : window;
  const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const DIGEST = /^[a-f0-9]{64}$/;
  const PUBLIC_WEB = 'https://github.com';
  const config = {};
  let projectId = null;
  let selectedId = null;
  let items = [];
  let detail = null;
  let draftEditor = null;
  let listRequest = null;
  let detailRequest = null;
  let actionRequest = null;
  let downloadRequest = null;
  let pendingForce = null;
  let openView = false;
  let message = '';
  let navigationTab;
  let ownedView;

  function element(tag, value, className) {
    const item = (config.document || host.document).createElement(tag);
    if (value != null) item.textContent = String(value);
    if (className) item.className = className;
    return item;
  }

  function formatPublicSha(value, full = false) {
    return typeof value === 'string' && SHA.test(value) ? (full ? value : value.slice(0, 12)) : 'Unknown HEAD';
  }

  function isValidGitHubUrl(value, allowedOrigin = PUBLIC_WEB) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return false;
    try {
      const origin = new URL(allowedOrigin);
      const url = new URL(value);
      return origin.protocol === 'https:' && origin.origin === allowedOrigin && !origin.username && !origin.password &&
        !/^\[|^[\d.]+$/.test(origin.hostname) && origin.hostname.includes('.') && !origin.hostname.endsWith('.') &&
        url.protocol === 'https:' && url.origin === origin.origin && !url.username && !url.password &&
        !url.search && !url.hash && value === url.href &&
        /^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/pull\/[1-9][0-9]*\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function authFetch(url, opts) {
    const request = config.authFetch || host.SynapseWebSocket?.authFetch ||
      ((url, opts) => fetch(url, { credentials: 'same-origin', ...opts }));
    return request.call(host.SynapseWebSocket, url, opts);
  }

  const collectionUrl = (id) => '/api/projects/' + encodeURIComponent(id) + '/prs';
  const detailUrl = (id, prId) => collectionUrl(id) + '/' + encodeURIComponent(prId);
  const selectionKey = (id) => 'synapse-selected-pr:' + id;
  function rememberPr(id) {
    try { host.sessionStorage?.setItem(selectionKey(projectId), id); } catch { /* Optional UI state. */ }
  }
  function rememberedPr(id) {
    try { return id && host.sessionStorage?.getItem(selectionKey(id)); } catch { return null; }
  }
  const idOf = (pr) => pr?.id ?? pr?.prId;
  const currentHead = (pr) => pr?.currentHeadSha ?? null;
  const approvedSha = (pr) => pr?.approvedSourceSha ?? pr?.lastApprovedSourceSha ?? pr?.evidence?.approvedSourceSha ??
    pr?.verificationProof?.approvedSourceSha ?? null;

  function cancel(slot) {
    slot?.controller.abort();
  }

  function cancelDetail() {
    cancel(detailRequest);
    cancel(actionRequest);
    cancel(downloadRequest);
    detailRequest = actionRequest = downloadRequest = pendingForce = null;
  }

  function startRequest() {
    return { controller: new AbortController(), projectId, selectedId };
  }

  function current(request) {
    return request.projectId === projectId && request.selectedId === selectedId && !request.controller.signal.aborted;
  }

  async function responseData(response) {
    if (response.status === 204) return {};
    try { return await response.json(); } catch { return {}; }
  }

  async function loadPrList() {
    if (!projectId) return;
    cancel(listRequest);
    const request = startRequest();
    listRequest = request;
    render();
    try {
      const response = await authFetch(collectionUrl(request.projectId), { signal: request.controller.signal });
      const data = await responseData(response);
      if (listRequest !== request || request.projectId !== projectId) return;
      if (!response.ok) throw new Error('Unable to load pull requests.');
      items = (Array.isArray(data) ? data : Array.isArray(data.prs) ? data.prs : []).filter((pr) =>
        typeof idOf(pr) === 'string' && idOf(pr));
    } catch {
      if (listRequest === request && !request.controller.signal.aborted) message = 'Unable to load pull requests.';
    } finally {
      if (listRequest === request) {
        listRequest = null;
        render();
      }
    }
    return items;
  }

  async function loadPrDetail() {
    if (!projectId || !selectedId) return;
    cancel(detailRequest);
    pendingForce = null;
    const request = startRequest();
    detailRequest = request;
    render();
    try {
      const url = detailUrl(request.projectId, request.selectedId);
      const options = { signal: request.controller.signal };
      const response = await authFetch(url, options);
      const data = await responseData(response);
      if (detailRequest !== request || !current(request)) return;
      if (!response.ok) throw new Error('Unable to load pull request details.');
      const pr = data.pr ?? data;
      if (!pr || typeof pr !== 'object' || Array.isArray(pr) || (idOf(pr) && idOf(pr) !== selectedId)) {
        throw new Error('Invalid pull request details.');
      }
      let saved = null;
      if (Object.hasOwn(data, 'draft')) saved = { draft: data.draft };
      else if (Object.hasOwn(pr, 'reviewDraft')) saved = { draft: pr.reviewDraft };
      detail = pr;
      if (saved && !draftEditor?.dirty && !draftEditor?.saving) {
        draftEditor = {
          url: url + '/draft',
          draft: saved.draft,
          body: saved.draft?.body ?? '',
          inlineComments: saved.draft?.inlineComments ?? [],
          dirty: false,
          status: '',
          timer: null,
          saving: null,
          busy: false,
        };
      } else if (!saved && !draftEditor?.dirty) {
        draftEditor = null;
      }
    } catch {
      if (detailRequest === request && current(request)) {
        detail = null;
        message = 'Unable to load pull request details.';
      }
    } finally {
      if (detailRequest === request) {
        detailRequest = null;
        render();
      }
    }
    return detail;
  }

  function selectPr(prId) {
    if (!projectId || typeof prId !== 'string' || !prId) return;
    if (draftEditor?.dirty) void saveReviewDraft(draftEditor);
    cancelDetail();
    selectedId = prId;
    rememberPr(prId);
    detail = draftEditor = null;
    message = '';
    return loadPrDetail();
  }

  function setProject(id) {
    const next = typeof id === 'string' && id ? id : null;
    if (next === projectId) return;
    cancel(listRequest);
    listRequest = null;
    if (draftEditor?.dirty) void saveReviewDraft(draftEditor);
    cancelDetail();
    projectId = next;
    selectedId = rememberedPr(next);
    detail = draftEditor = null;
    items = [];
    message = '';
    render();
    if (openView && projectId) return Promise.all([loadPrList(), loadPrDetail()]);
  }

  function syncTab() {
    if (ownedView) ownedView.hidden = !openView;
    if (navigationTab) {
      navigationTab.setAttribute('aria-selected', String(openView));
      navigationTab.tabIndex = openView ? 0 : -1;
    }
  }

  function open(nextProjectId) {
    if (arguments.length > 0) {
      const normalized = typeof nextProjectId === 'string' && nextProjectId ? nextProjectId : null;
      if (normalized !== projectId) {
        openView = true;
        syncTab();
        return setProject(normalized);
      }
    }
    if (openView) return;
    openView = true;
    syncTab();
    render();
    return Promise.all([loadPrList(), loadPrDetail()]);
  }

  function close() {
    openView = false;
    cancel(listRequest);
    listRequest = null;
    cancelDetail();
    syncTab();
  }

  function warnUnsavedDraft(event) {
    if (!draftEditor?.dirty && !draftEditor?.saving && !draftEditor?.busy) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function onTabClick() {
    if (typeof config.activateTab === 'function') config.activateTab();
    else void open();
  }

  function init(options = {}) {
    Object.assign(config, options);
    host.addEventListener?.('beforeunload', warnUnsavedDraft);
    const document = config.document || host.document;
    ownedView = config.view || document?.getElementById('prs-view');
    const tab = config.navTab || document?.getElementById('nav-tab-prs');
    if (tab !== navigationTab) {
      navigationTab?.removeEventListener('click', onTabClick);
      navigationTab = tab;
      navigationTab?.addEventListener('click', onTabClick);
    }
    if (navigationTab && ownedView?.id) navigationTab.setAttribute('aria-controls', ownedView.id);
    syncTab();
    if (Object.hasOwn(options, 'projectId')) void setProject(options.projectId);
    render();
    return api;
  }

  function badge(label, tone = '') {
    return element('span', label, ['prs-badge', tone && 'prs-badge--' + tone].filter(Boolean).join(' '));
  }

  function button(label, callback, disabled = false) {
    const item = element('button', label, 'prs-button');
    item.type = 'button';
    item.disabled = disabled;
    item.addEventListener('click', callback);
    return item;
  }

  function line(label, value, monospace = false) {
    const row = element('div', null, 'prs-field');
    row.append(element('span', label, 'prs-label'), element(monospace ? 'code' : 'span', value));
    return row;
  }

  function freshness(pr) {
    const head = currentHead(pr);
    const approved = approvedSha(pr);
    if (formatPublicSha(head) === 'Unknown HEAD') return 'Unknown HEAD';
    if (pr.approvalFreshness === 'stale' || pr.approvalStale === true || (approved && approved !== head)) return 'Stale approval';
    return approved ? 'Current approval' : 'Awaiting approval';
  }

  function proofRequired(pr) {
    return pr.requiresProof === true || pr.proofRequired === true || pr.evidenceRequired === true || pr.loopManaged === true ||
      Boolean(pr.loopRunId || pr.evidence?.runId || pr.verificationProof?.kind === 'loop-evidence-v1');
  }

  function proofHardBlocked(pr) {
    const proof = pr.evidence ?? pr.verificationProof;
    return pr.hardMergeBlocked === true || pr.proofTampered === true || pr.proofValid === false ||
      proof?.tampered === true || proof?.valid === false || proof?.verifyPass === false || proof?.overallPass === false ||
      ['tampered', 'invalid', 'stale', 'missing', 'unverified'].includes(proof?.integrity) ||
      (proofRequired(pr) && (freshness(pr) !== 'Current approval' ||
        !DIGEST.test(proof?.evidencePacketSha256 ?? '') || (proof?.approvedSourceSha && proof.approvedSourceSha !== currentHead(pr))));
  }

  function canMerge(pr) {
    return ['open', 'approved', 'ready', undefined].includes(pr.state ?? pr.status) &&
      SHA.test(currentHead(pr) ?? '') && freshness(pr) !== 'Stale approval' &&
      !proofHardBlocked(pr) && pr.actions?.mergeAllowed !== false && pr.mergeAllowed !== false;
  }

  function rejectedHard(data) {
    return data.hardBlocked === true || data.proofValid === false || data.stale === true || data.tampered === true ||
      /(?:STALE|SHA|HEAD|TAMPER|PROOF|ANCHOR|DIGEST|EVIDENCE|INTEGRITY)/i.test(String(data.code ?? ''));
  }

  async function performAction(action, path, payload, force = false) {
    if (!detail || detailRequest || actionRequest) return;
    const request = startRequest();
    actionRequest = request;
    const snapshot = detail;
    pendingForce = null;
    message = '';
    render();
    try {
      const response = await authFetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: request.controller.signal,
      });
      const data = await responseData(response);
      if (actionRequest !== request || !current(request) || detail !== snapshot) return;
      if (response.status === 403 && action === 'merge' && !force && data.forceAllowed === true &&
        !rejectedHard(data) && canMerge(snapshot)) {
        pendingForce = { snapshot, expectedHeadSha: payload.expectedHeadSha, code: data.code, reason: data.reason };
        return;
      }
      if (response.status === 409 || response.ok) {
        if (response.status === 409) message = data.error || data.reason || data.message || 'The pull request changed. Review the refreshed details.';
        else message = action === 'publish' ? 'Evidence publication requested.' : 'Pull request updated.';
        actionRequest = null;
        await loadPrDetail();
      } else {
        const code = data.code ? String(data.code) + ' · ' : '';
        message = code + String(data.error || data.reason || data.message || 'The requested action was blocked.');
      }
    } catch {
      if (current(request)) message = 'Unable to complete the requested action.';
    } finally {
      if (actionRequest === request) actionRequest = null;
      if (current(request)) render();
    }
  }

  function merge(force = false) {
    if (!canMerge(detail ?? {})) return;
    const expectedHeadSha = currentHead(detail);
    if (force && (pendingForce?.snapshot !== detail || pendingForce.expectedHeadSha !== expectedHeadSha)) return;
    return performAction('merge', detailUrl(projectId, selectedId) + '/merge',
      { expectedHeadSha, ...(force ? { force: true } : {}) }, force);
  }

  function approve(pr) {
    const candidate = pr.approvalCandidate ?? pr.proofCandidate;
    const authorized = pr.actions?.approveAllowed ?? pr.approveAllowed;
    if (authorized === false || !candidate || !candidate.loopId || !candidate.runId || !DIGEST.test(candidate.reviewSha256 ?? '') ||
      !DIGEST.test(candidate.anchorSetSha256 ?? '') || !SHA.test(candidate.approvedSourceSha ?? '') ||
      candidate.approvedSourceSha !== currentHead(pr) || candidate.valid === false || candidate.tampered === true) return null;
    const approveUrl = '/api/loops/' + encodeURIComponent(candidate.loopId) + '/runs/' + encodeURIComponent(candidate.runId) + '/approve';
    return () => performAction('approve', approveUrl, {
      approvedSourceSha: candidate.approvedSourceSha, reviewSha256: candidate.reviewSha256,
      anchorSetSha256: candidate.anchorSetSha256,
    });
  }

  async function downloadEvidence(event, path) {
    event.preventDefault();
    cancel(downloadRequest);
    const request = startRequest();
    downloadRequest = request;
    try {
      const response = await authFetch(path, { signal: request.controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error('Download blocked');
      const packet = await response.blob();
      if (downloadRequest !== request || !current(request) || !openView) return;
      const objectUrl = host.URL.createObjectURL(packet);
      const link = element('a');
      link.href = objectUrl;
      link.download = 'synapse-evidence-packet';
      try { link.click(); } finally { setTimeout(() => host.URL.revokeObjectURL(objectUrl), 1000); }
    } catch {
      if (downloadRequest === request && current(request) && openView) {
        message = 'Unable to download the evidence packet.';
        render();
      }
    } finally {
      if (downloadRequest === request) downloadRequest = null;
    }
  }

  function renderEvidence(pr, panel) {
    const proof = pr.evidence ?? pr.verificationProof;
    if (!proof) return;
    const section = element('section', null, 'prs-section');
    section.append(element('h3', 'Evidence'));
    if (proof.verifyCommand) section.append(line('Verify command', proof.verifyCommand, true));
    if (proof.evidencePacketSha256) section.append(line('Evidence packet SHA-256', proof.evidencePacketSha256, true));
    if (proof.approvedSourceSha) section.append(line('Packet source SHA', formatPublicSha(proof.approvedSourceSha, true), true));
    if (proof.approvedSourceSha && proof.approvedSourceSha !== currentHead(pr)) {
      section.append(badge('Stale', 'warning'));
    }
    if (Array.isArray(proof.anchors) && proof.anchors.length) {
      const table = element('table', null, 'prs-table');
      const header = element('thead');
      const labels = element('tr');
      for (const label of ['Anchor', 'Assertion', 'Verdict']) {
        const th = element('th', label);
        th.scope = 'col';
        labels.append(th);
      }
      header.append(labels);
      const rows = element('tbody');
      for (const entry of proof.anchors) {
        if (!entry) continue;
        const assertions = entry.assertions ?? entry.proof?.assertions;
        const checks = Array.isArray(assertions) && assertions.length ? assertions : [null];
        for (const assertion of checks) {
          const row = element('tr');
          const verdict = assertion?.passed === true ? 'Passed' : assertion?.passed === false ? 'Failed' :
            assertion?.verdict ?? entry.outcome ?? 'Unknown';
          row.append(element('td', entry.anchorId ?? entry.id ?? 'Anchor'),
            element('td', assertion?.id ?? '—'), element('td', verdict));
          rows.append(row);
        }
      }
      table.append(header, rows);
      section.append(table);
    }
    if ((proof.evidencePacketSha256 || proof.downloadAvailable === true) && proof.downloadAllowed !== false) {
      const path = detailUrl(projectId, selectedId) + '/evidence/download';
      const link = element('a', 'Download Evidence Packet', 'prs-link');
      link.href = path;
      link.addEventListener('click', (event) => void downloadEvidence(event, path));
      section.append(link);
    }
    panel.append(section);
  }

  function renderReviews(pr, panel) {
    const reviews = Array.isArray(pr.reviews) ? [...pr.reviews] : [];
    const proofReview = pr.evidence?.review ?? pr.verificationProof?.review ?? pr.independentReview;
    if (proofReview && !reviews.includes(proofReview)) reviews.push({ kind: 'independent', ...proofReview });
    const author = pr.author ?? pr.evidence?.author;
    if (!reviews.length && !author) return;
    const section = element('section', null, 'prs-section');
    section.append(element('h3', 'Reviews'));
    if (author) section.append(line('Author', [author.login ?? author.name ?? author.agentId ?? author.id ??
      (typeof author === 'string' ? author : 'Unknown'), author.provider].filter(Boolean).join(' · ')));
    for (const review of reviews) {
      if (!review) continue;
      const group = element('div', null, 'prs-review');
      const role = review.independent === true || review.kind === 'independent' ? 'Independent reviewer' :
        review.kind === 'author' ? 'Author review' : 'Reviewer';
      group.append(line(role, [review.reviewer ?? review.login ?? review.agentId ?? review.name ?? 'Unknown',
        review.provider].filter(Boolean).join(' · ')));
      const sha = review.reviewedSourceSha ?? review.approvedSourceSha ?? review.sourceSha;
      if (!sha) group.append(badge('Unbound', 'warning'));
      else if (review.stale === true || (currentHead(pr) && sha !== currentHead(pr))) group.append(badge('Stale', 'warning'));
      group.append(line('Standards', review.standards?.verdict ?? review.standardsVerdict ??
        (typeof review.standards === 'string' ? review.standards : '—')),
      line('Specification', review.specification?.verdict ?? review.specificationVerdict ??
        (typeof review.specification === 'string' ? review.specification : '—')));
      if (review.status === 'commented' && review.summary) group.append(element('p', review.summary));
      for (const comment of Array.isArray(review.inlineComments) ? review.inlineComments : []) {
        group.append(line(`${comment.path}:${comment.line}`, comment.body));
      }
      section.append(group);
    }
    panel.append(section);
  }

  function draftRequest(url, method, payload) {
    return authFetch(url, {
      method,
      ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}),
    }).then(async response => {
      const data = await responseData(response);
      if (!response.ok) throw Object.assign(new Error(data.error || 'Draft request failed.'), { status: response.status });
      return data;
    });
  }

  function setDraftStatus(editor, message) {
    editor.status = message;
    if (editor.statusNode?.isConnected) editor.statusNode.textContent = message;
  }

  async function saveReviewDraft(editor) {
    clearTimeout(editor.timer);
    if (editor.saving) await editor.saving;
    if (!editor.dirty) return true;
    const payload = { headSha: editor.editHead, body: editor.body, inlineComments: editor.inlineComments };
    editor.dirty = false;
    setDraftStatus(editor, 'Saving draft…');
    editor.saving = (async () => {
      try {
        const data = await draftRequest(editor.url, 'PUT', payload);
        editor.draft = data.draft;
        setDraftStatus(editor, 'Draft saved.');
        return true;
      } catch (err) {
        editor.dirty = true;
        setDraftStatus(editor, err.message);
        if (err.status === 409 && draftEditor === editor) {
          editor.headConflict = true;
          await loadPrDetail();
        }
        return false;
      }
    })();
    const saved = await editor.saving;
    editor.saving = null;
    return saved;
  }

  function queueDraftSave(editor, headSha) {
    editor.editHead = headSha;
    editor.dirty = true;
    clearTimeout(editor.timer);
    editor.timer = setTimeout(() => void saveReviewDraft(editor), 400);
  }

  async function applyDraftAction(editor, action, headSha) {
    if (draftEditor !== editor || editor.busy) return;
    editor.busy = true;
    render();
    try {
      if (action === 'reanchor') {
        if (editor.saving) await editor.saving;
        if (editor.draft) {
          const { draft } = await draftRequest(editor.url + '/reanchor', 'POST', { headSha });
          editor.draft = draft;
        }
        editor.editHead = headSha;
        editor.headConflict = false;
        if (editor.dirty && !await saveReviewDraft(editor)) return;
        setDraftStatus(editor, 'Draft re-anchored. Check the inline positions against this diff.');
      } else if (action === 'discard') {
        clearTimeout(editor.timer);
        if (editor.saving) await editor.saving;
        await draftRequest(editor.url, 'DELETE');
        editor.draft = null;
        editor.dirty = editor.headConflict = false;
        editor.inlineComments = [];
        editor.body = '';
        setDraftStatus(editor, 'Draft discarded.');
      } else if (action === 'publish') {
        if (!editor.body.trim() && editor.inlineComments.length === 0) {
          setDraftStatus(editor, 'Enter a review comment before posting.');
          return;
        }
        if (!await saveReviewDraft(editor)) return;
        await draftRequest(editor.url.slice(0, -'/draft'.length) + '/review', 'POST', { draftHeadSha: headSha });
        if (draftEditor !== editor) return;
        editor.draft = null;
        message = 'Review comment posted.';
        await loadPrDetail();
      }
    } catch (err) {
      setDraftStatus(editor, err.message);
      if (err.status === 409 && draftEditor === editor) await loadPrDetail();
    } finally {
      editor.busy = false;
      render();
    }
  }

  function renderDraft(pr, panel) {
    const editor = draftEditor;
    if (!editor || ['merged', 'closed'].includes(pr.status)) return;
    const headSha = currentHead(pr);
    const hasHead = SHA.test(headSha ?? '');
    const stale = (editor.draft && editor.draft.headSha !== headSha) ||
      (editor.dirty && editor.editHead !== headSha) || editor.headConflict === true;
    const disabled = editor.busy || !hasHead || stale;
    const section = element('section', null, 'prs-section');
    section.append(element('h3', 'Review Comment Draft'));
    if (stale) {
      const warning = element('p', 'Head moved — review the updated diff and explicitly re-anchor the draft.', 'prs-confirm');
      warning.setAttribute('role', 'alert');
      section.append(warning);
      section.append(button('Re-anchor to new HEAD', () => applyDraftAction(editor, 'reanchor', headSha), !hasHead || editor.busy));
    }

    const body = element('textarea');
    body.setAttribute('aria-label', 'Review comment');
    body.rows = 5;
    body.maxLength = 65536;
    body.value = editor.body;
    body.disabled = disabled;
    body.addEventListener('input', () => {
      editor.body = body.value;
      queueDraftSave(editor, headSha);
    });
    section.append(body);

    const list = element('ul');
    editor.inlineComments.forEach((comment, index) => {
      const item = element('li', `${comment.path}:${comment.line} — ${comment.body} `);
      item.append(button('Remove', () => {
        editor.inlineComments = editor.inlineComments.filter((_, i) => i !== index);
        queueDraftSave(editor, headSha);
        render();
      }, disabled));
      list.append(item);
    });
    if (editor.inlineComments.length) section.append(list);
    const actions = element('div', null, 'prs-actions');
    const path = element('input');
    path.type = 'text';
    path.placeholder = 'Relative file path';
    path.setAttribute('aria-label', 'Inline comment file');
    path.maxLength = 512;
    const lineNumber = element('input');
    lineNumber.type = 'number';
    lineNumber.min = '1';
    lineNumber.placeholder = 'Line';
    lineNumber.setAttribute('aria-label', 'Inline comment line');
    const inlineBody = element('input');
    inlineBody.type = 'text';
    inlineBody.placeholder = 'Inline comment';
    inlineBody.setAttribute('aria-label', 'Inline comment text');
    inlineBody.maxLength = 65536;
    path.disabled = lineNumber.disabled = inlineBody.disabled = disabled;
    const add = button('Add Inline Comment', () => {
      const number = Number(lineNumber.value);
      if (!path.value || !Number.isSafeInteger(number) || number < 1 || !inlineBody.value.trim()) {
        setDraftStatus(editor, 'Enter a file path, positive line number, and comment.');
        return;
      }
      editor.inlineComments = [...editor.inlineComments, { path: path.value, line: number, body: inlineBody.value }];
      queueDraftSave(editor, headSha);
      render();
    }, disabled || editor.inlineComments.length >= 100);
    actions.append(path, lineNumber, inlineBody, add);
    section.append(actions);

    editor.statusNode = element('p', editor.status, 'prs-status');
    editor.statusNode.setAttribute('role', 'status');
    const buttons = element('div', null, 'prs-actions');
    buttons.append(button('Save Draft', () => void saveReviewDraft(editor), disabled),
      button('Post Review Comment', () => applyDraftAction(editor, 'publish', headSha), disabled),
      button('Discard Draft', () => applyDraftAction(editor, 'discard', headSha), editor.busy));
    section.append(buttons, editor.statusNode);
    panel.append(section);
  }

  function renderActions(pr, panel) {
    const actions = element('div', null, 'prs-actions');
    const busy = Boolean(actionRequest || detailRequest);
    const approveAction = approve(pr);
    if (approveAction || pr.approvalCandidate || pr.proofCandidate) {
      actions.append(button('Operator Approve', () => approveAction?.(), busy || !approveAction));
    }
    actions.append(button('Merge', () => merge(), busy || !canMerge(pr) || Boolean(pendingForce)));

    const github = pr.github ?? pr.githubBinding;
    if (github) {
      const url = github.url ?? github.htmlUrl;
      if (isValidGitHubUrl(url, config.githubWebOrigin ?? PUBLIC_WEB)) {
        const link = element('a', 'GitHub pull request', 'prs-link');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.append(link);
      }
      const allowed = (pr.actions?.postEvidenceAllowed ?? github.postEvidenceAllowed) !== false &&
        freshness(pr) === 'Current approval' && !proofHardBlocked(pr);
      actions.append(button('Post Evidence to GitHub', () => {
        if (!allowed || detail !== pr) return;
        return performAction('publish', detailUrl(projectId, selectedId) + '/github/evidence',
          { expectedHeadSha: currentHead(pr) });
      }, busy || !allowed));
      if (!allowed) panel.append(element('p', github.postEvidenceReason ||
        'Posting requires current approved proof and publication permission.'));
      const receipt = github.publication ?? pr.publication;
      if (receipt?.state) panel.append(line('GitHub publication', [receipt.state, receipt.code].filter(Boolean).join(' · ')));
    }
    if (pendingForce) {
      const prompt = element('div', null, 'prs-confirm');
      prompt.setAttribute('role', 'alert');
      prompt.append(element('strong', 'Confirm force merge'),
        line('Code', pendingForce.code ?? 'MERGE_BLOCKED'),
        line('Reason', pendingForce.reason ?? 'The server requires explicit confirmation.'),
        line('Force allowed', 'Yes'),
        button('Confirm force merge', () => merge(true), busy),
        button('Cancel', () => { pendingForce = null; render(); }));
      panel.append(prompt);
    }
    panel.append(actions);
    if (!canMerge(pr) && (pr.mergeBlockedReason || proofHardBlocked(pr) || freshness(pr) === 'Stale approval')) {
      panel.append(element('p', pr.mergeBlockedReason || 'Merge is blocked until current proof is verified.'));
    }
  }

  function render() {
    if (!ownedView) return;
    const layout = element('div', null, 'prs-layout');
    const list = element('section', null, 'prs-list');
    list.append(element('h2', 'Pull requests'));
    if (!projectId) list.append(element('p', 'Select a project.'));
    else if (listRequest) list.append(element('p', 'Loading pull requests…'));
    else if (!items.length) list.append(element('p', 'No pull requests.'));
    for (const pr of items) {
      const id = idOf(pr);
      const item = button(pr.title || id, () => selectPr(id));
      item.className = 'prs-list-item';
      item.setAttribute('aria-pressed', String(id === selectedId));
      item.append(element('span', (pr.sourceRef ?? pr.sourceBranch ?? '—') + ' → ' + (pr.targetRef ?? pr.targetBranch ?? '—')),
        badge(pr.state ?? pr.status ?? 'Unknown'), badge(freshness(pr)));
      list.append(item);
    }
    const panel = element('section', null, 'prs-detail');
    if (detailRequest && !detail) panel.append(element('p', 'Loading pull request…'));
    else if (detail) {
      panel.append(element('h2', detail.title || selectedId), badge(freshness(detail),
        freshness(detail) === 'Current approval' ? 'success' : 'warning'));
      panel.append(line('Approved source SHA', approvedSha(detail) ? formatPublicSha(approvedSha(detail), true) : '—', true),
        line('Current HEAD', formatPublicSha(currentHead(detail), true), true));
      renderEvidence(detail, panel);
      renderReviews(detail, panel);
      renderDraft(detail, panel);
      renderActions(detail, panel);
    } else if (projectId && !selectedId) panel.append(element('p', 'Select a pull request.'));
    if (message) {
      const status = element('p', message, 'prs-status');
      status.setAttribute('role', 'status');
      panel.append(status);
    }
    layout.append(list, panel);
    ownedView.replaceChildren(layout);
    return ownedView;
  }

  const api = { init, open, close, setProject, render, selectPr, loadPrList, loadPrDetail, formatPublicSha, isValidGitHubUrl };
  host.SynapsePrs = api;
}());
