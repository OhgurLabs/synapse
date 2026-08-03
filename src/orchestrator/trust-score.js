import { createLogger } from '../logger.js';

const log = createLogger('trust-score');

export function calculateTrustScore(task, validationReport = null) {
  let score = 5;
  const signals = [];

  const subtasks = task.subtasks || [];
  const auditSubtasks = subtasks.filter(s => s.meta?.auditTask);
  const hasCrossProviderReview = subtasks.some(s => s.meta?.crossProviderReview && s.status === 'done');

  if (auditSubtasks.length > 0 && auditSubtasks[0].status === 'done') {
    score += 2;
    signals.push({ signal: 'agent_review_passed', points: 2 });
  }

  if (hasCrossProviderReview) {
    score += 1;
    signals.push({ signal: 'cross_provider_review', points: 1 });
  }

  const reviewIterations = task.reviewIterationCount || 0;
  if (reviewIterations === 0) {
    score += 1;
    signals.push({ signal: 'clean_first_pass', points: 1 });
  } else {
    score -= Math.min(reviewIterations * 2, 4);
    signals.push({ signal: 'rejection_cycles', points: -(Math.min(reviewIterations * 2, 4)), count: reviewIterations });
  }

  if (validationReport) {
    if (validationReport.syntax?.pass) {
      score += 1;
      signals.push({ signal: 'syntax_clean', points: 1 });
    }

    if (validationReport.tests && !validationReport.tests.skipped) {
      if (validationReport.tests.pass) {
        score += 2;
        signals.push({ signal: 'tests_pass', points: 2 });
      } else {
        score -= 2;
        signals.push({ signal: 'tests_fail', points: -2 });
      }
    }

    if (validationReport.security?.pass) {
      score += 1;
      signals.push({ signal: 'security_clean', points: 1 });
    } else if (validationReport.security && !validationReport.security.pass) {
      score -= 3;
      signals.push({ signal: 'security_issues', points: -3, count: validationReport.security.issues?.length || 0 });
    }

    const filesChanged = validationReport.stats?.filesChanged || 0;
    if (filesChanged > 0 && filesChanged <= 10) {
      score += 1;
      signals.push({ signal: 'small_changeset', points: 1 });
    } else if (filesChanged > 50) {
      score -= 2;
      signals.push({ signal: 'large_changeset', points: -2, count: filesChanged });
    }

    if (validationReport.scope?.configTouchedCount > 0) {
      score -= 3;
      signals.push({ signal: 'config_touched', points: -3, files: validationReport.scope.configTouched });
    }
  }

  const isSelfReview = auditSubtasks.length > 0 && (() => {
    const reviewerId = auditSubtasks[0].assignee;
    const contributors = subtasks
      .filter(s => s?.assignee && s.assignee !== 'system' && !s.meta?.auditTask)
      .map(s => s.assignee);
    return contributors.includes(reviewerId);
  })();
  if (isSelfReview) {
    score -= 3;
    signals.push({ signal: 'self_review', points: -3 });
  }

  score = Math.max(0, Math.min(10, score));

  const tier = score >= 7 ? 'HIGH_CONFIDENCE' : score >= 4 ? 'NEEDS_REVIEW' : 'HIGH_RISK';
  const autoMergeEligible = score >= 7 &&
    hasCrossProviderReview &&
    (!validationReport || (validationReport.security?.pass && validationReport.scope?.configTouchedCount === 0));

  log.info('Trust score calculated', {
    taskId: task.id, score, tier, autoMergeEligible,
    signalCount: signals.length,
  });

  return { score, tier, autoMergeEligible, signals };
}

export function formatApprovalRequest(campaign, task, trustScore, validationReport = null) {
  const emoji = trustScore.tier === 'HIGH_CONFIDENCE' ? '✓' :
    trustScore.tier === 'NEEDS_REVIEW' ? '⚠' : '✗';
  const lines = [
    `Campaign: "${campaign.title}"`,
    '',
    `Trust Score: ${trustScore.score}/10 — ${trustScore.tier} ${emoji}`,
    '',
  ];

  for (const s of trustScore.signals) {
    const icon = s.points > 0 ? '✓' : s.points < 0 ? '✗' : '⚠';
    lines.push(`${icon} ${s.signal.replace(/_/g, ' ')} (${s.points > 0 ? '+' : ''}${s.points})`);
  }

  if (validationReport?.stats) {
    lines.push('');
    lines.push(`Files: ${validationReport.stats.filesChanged}, +${validationReport.stats.added}/-${validationReport.stats.removed}`);
  }

  if (campaign.branch) {
    lines.push(`Branch: ${campaign.branch}`);
  }

  if (trustScore.autoMergeEligible) {
    lines.push('');
    lines.push('Auto-merge eligible (opt-in required)');
  }

  lines.push('');
  lines.push('Use `/campaign approve <id>` to merge, or `/campaign reject <id>` to reject.');

  return lines.join('\n');
}
