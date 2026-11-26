// Retirement — the process chain for abandoning a campaign or a project.
//
// WHY A CHAIN AND NOT A FLAG. Retiring a project touches four subsystems that can
// race each other, and the order is load-bearing:
//
//   1. QUIESCE MUST PRECEDE CASCADE. `strategist.js` synthesises a brand-new campaign
//      whenever a `continuous` project's queue empties. Cascade-retiring campaigns
//      first would empty the queue and invite the strategist to generate a fresh one
//      mid-chain — retirement that immediately un-retires itself. So allocation goes
//      to 0 and mode to `static` BEFORE any campaign is touched.
//   2. SNAPSHOT MUST PRECEDE MUTATION. Revive restores the prior allocation/mode from
//      a snapshot taken in the precheck. Without it, revive would have to guess
//      (100/static), silently discarding a deliberate configuration.
//   3. ARCHIVE MUST PRECEDE DELETION. A campaign branch can be the only copy of real
//      work: an audit on 2026-08-20 found one carrying 79 commits and 84 source files
//      that existed nowhere else. `archiveCampaignBranch` verifies the archive ref
//      resolves to the same commit before it removes the branch ref.
//
// EVERY STEP IS IDEMPOTENT, so a chain that fails halfway can simply be re-run: an
// already-retired campaign is skipped, quiesce is a no-op at 0/static, and `mark` is
// last so a partially-applied chain never reports success.
//
// RETIREMENT IS NOT FAILURE and NOT DELETION. Nothing is removed from disk or from
// git. `retired` is its own terminal status precisely so abandonment stops polluting
// failure metrics — and it is reversible, because a judgment call deserves a way back.

import { writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { archiveCampaignBranch, restoreCampaignBranch } from './git-branches.js';
import { createLogger } from '../logger.js';

const log = createLogger('retirement');

export const MIN_REASON_LENGTH = 10;

// A campaign in one of these needs no retirement work; it is already closed.
const TERMINAL_CAMPAIGN_STATUSES = new Set(['completed', 'failed', 'retired']);

export function validateReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < MIN_REASON_LENGTH) {
    return { ok: false, error: `reason required (minimum ${MIN_REASON_LENGTH} characters)` };
  }
  return { ok: true, reason: text };
}

function step(chain, name, status, detail) {
  chain.push({ step: name, status, detail: detail ?? null });
  return chain[chain.length - 1];
}

function listCampaignsFor(campaignManager, projectId) {
  if (typeof campaignManager.listCampaigns === 'function') {
    return campaignManager.listCampaigns(projectId) || [];
  }
  const data = campaignManager.load?.(projectId);
  return (data && data.campaigns) || [];
}

function projectGitContext(stateManager, projectId) {
  const project = stateManager.getProject?.(projectId) || null;
  return {
    projectDir: project?.projectDir || null,
    repoConfig: stateManager.getProjectRepoConfig?.(projectId) || null,
  };
}

// ─── Campaign ──────────────────────────────────────────────────────────────

export function retireCampaign({ campaignManager, taskManager, stateManager },
                               { projectId, campaignId, reason, operatorId = 'operator' }) {
  const chain = [];
  const valid = validateReason(reason);
  if (!valid.ok) return { ok: false, error: valid.error, chain };

  const campaign = campaignManager.getCampaign(projectId, campaignId);
  if (!campaign) return { ok: false, error: `Campaign not found: ${campaignId}`, chain };

  if (campaign.status === 'retired') {
    step(chain, 'precheck', 'skipped', 'campaign is already retired');
    return { ok: true, chain, campaign, alreadyRetired: true };
  }
  step(chain, 'precheck', 'ok', { previousStatus: campaign.status, branch: campaign.branch || null });

  // Archive before the status write: if the archive cannot be verified, nothing has
  // changed yet and the caller can retry without having half-retired anything.
  let archivedBranchRef = campaign.archivedBranchRef || null;
  const { projectDir, repoConfig } = projectGitContext(stateManager, projectId);
  if (projectDir && campaign.branch) {
    const res = archiveCampaignBranch(projectDir, campaignId, repoConfig);
    if (!res.success) {
      step(chain, 'archive', 'failed', res.error);
      return { ok: false, error: `Branch archive failed: ${res.error}`, chain };
    }
    archivedBranchRef = res.archivedRef || archivedBranchRef;
    step(chain, 'archive', res.skipped ? 'skipped' : 'ok', res.skipped ? res.reason : { archivedRef: res.archivedRef, commit: res.commit });
  } else {
    step(chain, 'archive', 'skipped', projectDir ? 'campaign has no branch' : 'project has no working directory');
  }

  // The taskManager argument is what opts this into the child cascade: queued,
  // planning and reviewing children are cancelled; executing children are left to
  // land their output.
  const updated = campaignManager.updateCampaignStatus(
    projectId, campaignId, 'retired', reason, operatorId, taskManager,
    { archivedBranchRef, retiredBy: operatorId, branch: null },
  );
  step(chain, 'retire', 'ok', { status: 'retired', archivedBranchRef });

  log.info('Campaign retired', { projectId, campaignId, archivedBranchRef, operatorId });
  return { ok: true, chain, campaign: updated };
}

export function reviveCampaign({ campaignManager, stateManager },
                               { projectId, campaignId, reason, operatorId = 'operator' }) {
  const chain = [];
  const valid = validateReason(reason);
  if (!valid.ok) return { ok: false, error: valid.error, chain };

  const campaign = campaignManager.getCampaign(projectId, campaignId);
  if (!campaign) return { ok: false, error: `Campaign not found: ${campaignId}`, chain };

  if (campaign.status !== 'retired') {
    step(chain, 'precheck', 'skipped', `campaign is ${campaign.status}, not retired`);
    return { ok: true, chain, campaign, notRetired: true };
  }
  step(chain, 'precheck', 'ok', { archivedBranchRef: campaign.archivedBranchRef || null });

  let branch = null;
  const { projectDir, repoConfig } = projectGitContext(stateManager, projectId);
  if (projectDir && campaign.archivedBranchRef) {
    const res = restoreCampaignBranch(projectDir, campaignId, campaign.archivedBranchRef, repoConfig);
    if (!res.success) {
      step(chain, 'restore', 'failed', res.error);
      return { ok: false, error: `Branch restore failed: ${res.error}`, chain };
    }
    branch = res.branchName || null;
    step(chain, 'restore', res.skipped ? 'skipped' : 'ok', res.skipped ? res.reason : { branch, commit: res.commit });
  } else {
    step(chain, 'restore', 'skipped', campaign.archivedBranchRef ? 'project has no working directory' : 'no archived ref recorded');
  }

  // Lands in `paused`, never `active`: revive restores the option to continue, it does
  // not restart work. The operator resumes deliberately.
  const now = new Date().toISOString();
  const updated = campaignManager.updateCampaignStatus(
    projectId, campaignId, 'paused', reason, operatorId, null,
    { revivedAt: now, revivedReason: reason, revivedBy: operatorId, branch },
  );
  step(chain, 'revive', 'ok', { status: 'paused', branch });

  log.info('Campaign revived', { projectId, campaignId, branch, operatorId });
  return { ok: true, chain, campaign: updated };
}

// ─── Project ───────────────────────────────────────────────────────────────

export function previewProjectRetirement({ campaignManager, taskManager, stateManager }, { projectId }) {
  const project = stateManager.getProject(projectId);
  if (!project) return { error: `Project not found: ${projectId}` };

  const campaigns = listCampaignsFor(campaignManager, projectId)
    .filter(c => !TERMINAL_CAMPAIGN_STATUSES.has(c.status))
    .map(c => ({ id: c.id, title: c.title, status: c.status, branch: c.branch || null }));

  let nonTerminalTasks = 0;
  try {
    const tasks = taskManager?.listTasks?.(projectId) || [];
    const terminal = new Set(['done', 'failed', 'cancelled']);
    nonTerminalTasks = tasks.filter(t => !terminal.has(t.status)).length;
  } catch (err) {
    log.warn('Retirement preview: listTasks failed', { projectId, error: err.message });
  }

  return {
    projectId,
    campaigns,
    nonTerminalTasks,
    branches: campaigns.map(c => c.branch).filter(Boolean),
    allocation: project.allocation ?? 100,
    mode: project.mode || 'static',
    alreadyRetired: project.retired || null,
  };
}

export function retireProject({ campaignManager, taskManager, stateManager },
                              { projectId, reason, operatorId = 'operator' }) {
  const chain = [];
  const valid = validateReason(reason);
  if (!valid.ok) return { ok: false, error: valid.error, chain };

  const project = stateManager.getProject(projectId);
  if (!project) return { ok: false, error: `Project not found: ${projectId}`, chain };

  if (project.retired) {
    step(chain, 'precheck', 'skipped', 'project is already retired');
    return { ok: true, chain, retired: project.retired, alreadyRetired: true };
  }

  // STEP 1 — snapshot before anything moves, so revive restores instead of guessing.
  const snapshot = { allocation: project.allocation ?? 100, mode: project.mode || 'static' };
  step(chain, 'precheck', 'ok', { snapshot });

  // STEP 2 — quiesce FIRST. Pin allocation to 0 and mode to static so the strategist
  // cannot synthesise a replacement campaign while the cascade is running.
  try {
    stateManager.setProjectAllocation(projectId, 0);
    stateManager.setProjectMode(projectId, 'static');
    step(chain, 'quiesce', 'ok', { allocation: 0, mode: 'static' });
  } catch (err) {
    step(chain, 'quiesce', 'failed', err.message);
    return { ok: false, error: `Quiesce failed: ${err.message}`, chain };
  }

  // STEP 3 — cascade. Each campaign runs the full campaign chain (archive + cascade
  // to its children), so a project retirement never leaves an unarchived branch.
  const retiredCampaigns = [];
  const failures = [];
  for (const c of listCampaignsFor(campaignManager, projectId)) {
    if (TERMINAL_CAMPAIGN_STATUSES.has(c.status)) continue;
    const res = retireCampaign(
      { campaignManager, taskManager, stateManager },
      { projectId, campaignId: c.id, reason: `Project retired: ${reason}`, operatorId },
    );
    if (res.ok) {
      retiredCampaigns.push({ id: c.id, title: c.title, previousStatus: c.status });
    } else {
      failures.push({ id: c.id, error: res.error });
    }
  }
  if (failures.length > 0) {
    step(chain, 'cascade', 'failed', { retired: retiredCampaigns, failures });
    return {
      ok: false,
      error: `Cascade incomplete: ${failures.length} campaign(s) could not be retired. The project stays quiesced; fix and re-run.`,
      chain,
    };
  }
  step(chain, 'cascade', 'ok', { retiredCampaigns });

  // STEP 4 — mark. Last, so a half-run chain never reports a retired project.
  let retired;
  try {
    retired = stateManager.setProjectRetired(projectId, {
      by: operatorId, reason, snapshot,
      chain: retiredCampaigns.map(c => c.id),
    });
    step(chain, 'mark', 'ok', retired);
  } catch (err) {
    step(chain, 'mark', 'failed', err.message);
    return { ok: false, error: `Mark failed: ${err.message}`, chain };
  }

  // STEP 5 — record. Best effort: a courtesy file for anyone reading the repo without
  // the control plane. Never fails the chain.
  // A courtesy file so anyone reading the repo without the control plane knows.
  // State is authoritative; this never fails the chain.
  if (project.projectDir) {
    try {
      const lines = [
        '# RETIRED',
        '',
        `- **Retired**: ${retired.at}`,
        `- **By**: ${retired.by}`,
        `- **Reason**: ${reason}`,
        `- **Prior allocation/mode**: ${snapshot.allocation} / ${snapshot.mode} (restored on revive)`,
        `- **Campaigns retired**: ${retiredCampaigns.length}`,
        '',
        ...retiredCampaigns.map(c => `  - \`${c.id}\` ${c.title || ''} (was ${c.previousStatus})`),
        '',
        'Retirement is reversible and destroys nothing. Campaign branches are archived',
        'under `refs/archive/` and restored on revive.',
        '',
        `Revive: \`POST /api/projects/${projectId}/revive\` with a reason of at least ${MIN_REASON_LENGTH} characters.`,
        '',
      ];
      writeFileSync(join(project.projectDir, 'RETIRED.md'), lines.join('\n'), 'utf8');
      step(chain, 'record', 'ok', { file: 'RETIRED.md' });
    } catch (err) {
      step(chain, 'record', 'failed', `RETIRED.md not written: ${err.message}`);
    }
  } else {
    step(chain, 'record', 'skipped', 'project has no working directory');
  }

  log.info('Project retired', { projectId, operatorId, campaigns: retiredCampaigns.length, snapshot });
  return { ok: true, chain, retired, retiredCampaigns };
}

export function reviveProject({ campaignManager, stateManager },
                              { projectId, reason, operatorId = 'operator', reviveCampaigns = true }) {
  const chain = [];
  const valid = validateReason(reason);
  if (!valid.ok) return { ok: false, error: valid.error, chain };

  const project = stateManager.getProject(projectId);
  if (!project) return { ok: false, error: `Project not found: ${projectId}`, chain };
  if (!project.retired) {
    step(chain, 'precheck', 'skipped', 'project is not retired');
    return { ok: true, chain, notRetired: true };
  }

  const snapshot = project.retired.snapshot || {};
  const campaignIds = Array.isArray(project.retired.chain) ? project.retired.chain : [];
  step(chain, 'precheck', 'ok', { snapshot, campaigns: campaignIds.length });

  // Reverse order: campaigns first, so the project is not live while its campaigns
  // are still retired. Each lands in `paused`, so nothing dispatches on revive.
  const revived = [];
  const failures = [];
  if (reviveCampaigns) {
    for (const id of campaignIds) {
      const res = reviveCampaign({ campaignManager, stateManager },
        { projectId, campaignId: id, reason: `Project revived: ${reason}`, operatorId });
      if (res.ok) revived.push(id); else failures.push({ id, error: res.error });
    }
    if (failures.length > 0) {
      step(chain, 'revive-campaigns', 'failed', { revived, failures });
      return { ok: false, error: `Revive incomplete: ${failures.length} campaign(s) failed. Project stays retired; fix and re-run.`, chain };
    }
    step(chain, 'revive-campaigns', 'ok', { revived });
  } else {
    step(chain, 'revive-campaigns', 'skipped', 'caller opted out');
  }

  try {
    if (typeof snapshot.allocation === 'number') stateManager.setProjectAllocation(projectId, snapshot.allocation);
    if (snapshot.mode) stateManager.setProjectMode(projectId, snapshot.mode);
    step(chain, 'restore', 'ok', { allocation: snapshot.allocation ?? null, mode: snapshot.mode || null });
  } catch (err) {
    step(chain, 'restore', 'failed', err.message);
    return { ok: false, error: `Restore failed: ${err.message}`, chain };
  }

  stateManager.setProjectRetired(projectId, null);
  step(chain, 'unmark', 'ok', null);

  if (project.projectDir) {
    const marker = join(project.projectDir, 'RETIRED.md');
    try {
      if (existsSync(marker)) { rmSync(marker); step(chain, 'unrecord', 'ok', { removed: 'RETIRED.md' }); }
      else step(chain, 'unrecord', 'skipped', 'no RETIRED.md present');
    } catch (err) {
      step(chain, 'unrecord', 'failed', err.message);
    }
  }

  log.info('Project revived', { projectId, operatorId, revived: revived.length, snapshot });
  return {
    ok: true, chain,
    restored: { allocation: snapshot.allocation ?? null, mode: snapshot.mode || null },
    revivedCampaigns: revived,
  };
}
