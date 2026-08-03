/**
 * Cross-Project Pattern Detection — periodic system-level scanner.
 * Detects shared failure patterns, provider reliability issues, campaign velocity
 * anomalies, recurring review findings, and vision/strategy drift across projects.
 *
 * No LLM calls — purely deterministic analysis on learnings + campaign data.
 */

import { createLogger } from './logger.js';

const log = createLogger('cross-project');

export function createCrossProjectScanner({ stateManager, learningsManager, campaignManager, taskManager, addMessage, config }) {
  const intervalMs = config.crossProjectScan?.intervalMs ?? 4 * 60 * 60 * 1000;
  const minProjects = config.crossProjectScan?.minProjectsForPattern ?? 2;

  let timer = null;
  let findings = [];

  function getProjectIds() {
    return stateManager.listProjects().map(p => p.id || p);
  }

  /**
   * Detect shared failure patterns — same pattern text appearing in 2+ projects.
   */
  function detectSharedFailures(allLearnings) {
    const patternProjects = new Map(); // pattern text → Set<projectId>
    for (const [projectId, entries] of allLearnings) {
      for (const entry of entries) {
        if (!entry.pattern) continue;
        // Normalize: lowercase, trim, collapse whitespace
        const normalized = entry.pattern.toLowerCase().trim().replace(/\s+/g, ' ');
        if (!patternProjects.has(normalized)) patternProjects.set(normalized, new Set());
        patternProjects.get(normalized).add(projectId);
      }
    }

    const results = [];
    for (const [pattern, projects] of patternProjects) {
      if (projects.size >= minProjects) {
        results.push({
          type: 'shared_failure',
          pattern,
          projects: [...projects],
          severity: 'important',
          message: `Same failure pattern detected in ${projects.size} projects: "${pattern.substring(0, 100)}"`,
        });
      }
    }
    return results;
  }

  /**
   * Detect provider reliability issues — same provider failing across projects.
   */
  function detectProviderIssues(allLearnings) {
    const providerFailures = new Map(); // provider → { projects: Set, count }
    for (const [projectId, entries] of allLearnings) {
      for (const entry of entries) {
        if (entry.category !== 'escalation_failure') continue;
        const provider = entry.source?.provider || entry.tags?.find(t => t.startsWith('provider:'))?.replace('provider:', '');
        if (!provider) continue;
        if (!providerFailures.has(provider)) providerFailures.set(provider, { projects: new Set(), count: 0 });
        const pf = providerFailures.get(provider);
        pf.projects.add(projectId);
        pf.count++;
      }
    }

    const results = [];
    for (const [provider, data] of providerFailures) {
      if (data.projects.size >= minProjects) {
        results.push({
          type: 'provider_reliability',
          provider,
          projects: [...data.projects],
          failureCount: data.count,
          severity: data.count >= 10 ? 'critical' : 'important',
          message: `Provider "${provider}" failing across ${data.projects.size} projects (${data.count} total failures)`,
        });
      }
    }
    return results;
  }

  /**
   * Detect campaign velocity anomalies — one project dramatically slower or faster.
   */
  function detectVelocityAnomalies() {
    const projectIds = getProjectIds();
    const velocities = []; // { projectId, completedPerWeek }

    for (const pid of projectIds) {
      const campaigns = campaignManager.listCampaigns(pid);
      const completed = campaigns.filter(c => c.status === 'completed' && c.completedAt);
      if (completed.length < 2) continue;

      const sortedByDate = completed
        .map(c => ({ ...c, completedMs: new Date(c.completedAt).getTime() }))
        .sort((a, b) => a.completedMs - b.completedMs);

      const spanMs = sortedByDate.at(-1).completedMs - sortedByDate[0].completedMs;
      const spanWeeks = Math.max(1, spanMs / (7 * 24 * 60 * 60 * 1000));
      velocities.push({ projectId: pid, completedPerWeek: completed.length / spanWeeks });
    }

    if (velocities.length < minProjects) return [];

    const mean = velocities.reduce((sum, v) => sum + v.completedPerWeek, 0) / velocities.length;
    const results = [];
    for (const v of velocities) {
      const ratio = mean > 0 ? v.completedPerWeek / mean : 1;
      if (ratio > 3 || ratio < 0.33) {
        results.push({
          type: 'velocity_anomaly',
          projectId: v.projectId,
          completedPerWeek: Math.round(v.completedPerWeek * 100) / 100,
          mean: Math.round(mean * 100) / 100,
          ratio: Math.round(ratio * 100) / 100,
          severity: 'minor',
          message: ratio > 3
            ? `Project "${v.projectId}" completing campaigns ${ratio.toFixed(1)}x faster than average`
            : `Project "${v.projectId}" completing campaigns ${(1/ratio).toFixed(1)}x slower than average`,
        });
      }
    }
    return results;
  }

  /**
   * Detect recurring review corrections across projects.
   */
  function detectRecurringCorrections(allLearnings) {
    const correctionProjects = new Map();
    for (const [projectId, entries] of allLearnings) {
      for (const entry of entries) {
        if (entry.category !== 'review_finding' || !entry.correction) continue;
        const normalized = entry.correction.toLowerCase().trim().replace(/\s+/g, ' ').substring(0, 120);
        if (!correctionProjects.has(normalized)) correctionProjects.set(normalized, new Set());
        correctionProjects.get(normalized).add(projectId);
      }
    }

    const results = [];
    for (const [correction, projects] of correctionProjects) {
      if (projects.size >= minProjects) {
        results.push({
          type: 'recurring_correction',
          correction,
          projects: [...projects],
          severity: 'important',
          message: `Same review correction appearing in ${projects.size} projects: "${correction.substring(0, 80)}"`,
        });
      }
    }
    return results;
  }

  /**
   * Detect vision/strategy drift — projects whose recent campaign activity
   * has diverged from their stated vision.
   */
  function detectDrift() {
    const projectIds = getProjectIds();
    const results = [];

    for (const pid of projectIds) {
      const vision = stateManager.getProjectVision(pid);
      if (!vision) continue;

      const visionWords = new Set(
        vision.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3)
      );
      if (visionWords.size < 3) continue;

      // Check recent campaigns (last 5) for vision alignment
      const allCampaigns = campaignManager.listCampaigns(pid);
      const recentCampaigns = allCampaigns
        .filter(c => c.status === 'completed' || c.status === 'active')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);

      if (recentCampaigns.length === 0) continue;

      // Calculate overlap between campaign titles/descriptions and vision keywords
      for (const campaign of recentCampaigns) {
        const campaignText = `${campaign.title} ${campaign.description || ''} ${campaign.doneCriteria || ''}`.toLowerCase();
        const campaignWords = new Set(
          campaignText.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3)
        );

        const overlap = [...visionWords].filter(w => campaignWords.has(w)).length;
        const overlapRatio = overlap / visionWords.size;

        if (overlapRatio < 0.1 && campaignWords.size > 5) {
          results.push({
            type: 'vision_drift',
            projectId: pid,
            campaignId: campaign.id,
            campaignTitle: campaign.title,
            overlapRatio: Math.round(overlapRatio * 100) / 100,
            severity: 'important',
            message: `Campaign "${campaign.title}" in project "${pid}" has <10% keyword overlap with project vision — possible drift`,
          });
        }
      }

      // Staleness check: how long since vision was last updated?
      const project = stateManager.getProject(pid);
      const visionUpdatedAt = project?.visionUpdatedAt;
      if (visionUpdatedAt) {
        const staleMs = Date.now() - new Date(visionUpdatedAt).getTime();
        const staleDays = staleMs / (24 * 60 * 60 * 1000);
        if (staleDays > 30 && recentCampaigns.length >= 3) {
          results.push({
            type: 'stale_vision',
            projectId: pid,
            daysSinceUpdate: Math.round(staleDays),
            campaignsSince: recentCampaigns.length,
            severity: 'minor',
            message: `Project "${pid}" vision unchanged for ${Math.round(staleDays)} days across ${recentCampaigns.length} recent campaigns — consider refreshing`,
          });
        }
      }

      // Strategy recency check: do any campaigns reference strategies with zero recency?
      // This catches the go-live gate pattern where 68 strategies had zero recency
      const learnings = learningsManager?.query(pid, { category: 'pattern_detected' }) || [];
      const staleStrategyLearnings = learnings.filter(l =>
        l.pattern && /zero recency|stale.*strateg|no.*recent.*data/i.test(l.pattern)
      );
      if (staleStrategyLearnings.length >= 3) {
        results.push({
          type: 'stale_strategies',
          projectId: pid,
          count: staleStrategyLearnings.length,
          severity: 'important',
          message: `Project "${pid}" has ${staleStrategyLearnings.length} learnings about stale/zero-recency strategies — systemic data freshness issue`,
        });
      }
    }

    return results;
  }

  /**
   * Run all detection patterns.
   */
  async function scan() {
    const projectIds = getProjectIds();
    if (projectIds.length < minProjects) {
      log.debug('Not enough projects for cross-project scan', { count: projectIds.length, min: minProjects });
      return [];
    }

    log.info('Starting cross-project pattern scan', { projectCount: projectIds.length });
    const startMs = Date.now();

    const allLearnings = learningsManager.loadAllProjects(projectIds);

    const detected = [
      ...detectSharedFailures(allLearnings),
      ...detectProviderIssues(allLearnings),
      ...detectVelocityAnomalies(),
      ...detectRecurringCorrections(allLearnings),
      ...detectDrift(),
    ];

    findings = detected.map(f => ({
      ...f,
      detectedAt: new Date().toISOString(),
    }));

    const elapsed = Date.now() - startMs;
    log.info('Cross-project scan complete', { findingCount: findings.length, elapsedMs: elapsed });

    // Surface critical/important findings as operator messages in each affected project
    for (const finding of findings) {
      if (finding.severity === 'minor') continue;
      const affectedProjects = finding.projects || (finding.projectId ? [finding.projectId] : []);
      for (const pid of affectedProjects) {
        try {
          addMessage(pid, 'general', 'System',
            `Cross-project pattern detected: ${finding.message}`, 'system');
        } catch (err) {
          log.debug('Failed to post cross-project finding', { projectId: pid, error: err.message });
        }
      }
    }

    return findings;
  }

  function getFindings() {
    return findings;
  }

  function start() {
    if (timer) return;
    // Initial scan after 60s (let system stabilize)
    timer = setTimeout(() => {
      scan().catch(err => log.error('Initial cross-project scan failed', { error: err.message }));
      // Then periodic
      timer = setInterval(() => {
        scan().catch(err => log.error('Periodic cross-project scan failed', { error: err.message }));
      }, intervalMs);
    }, 60000);
    log.info('Cross-project scanner started', { intervalMs });
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, scan, getFindings };
}
