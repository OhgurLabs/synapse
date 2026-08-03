/**
 * Campaign note template — campaign lifecycle documentation.
 */

export const TEMPLATE_VERSION = 1;
export const TYPE = 'campaign';

export const DEFAULT_FRONTMATTER = {
  type: TYPE,
  project: '',
  campaignId: '',
  status: 'active',
  created: '',
  updated: '',
  templateVersion: TEMPLATE_VERSION,
  tags: [],
};

export const SECTIONS = [
  'Goal',
  'Milestones',
  'Outcomes',
  'Related Incidents',
  'Related Learnings',
  'Notes',
];

export function buildInitial({ project, campaignId, goal, milestones = [], tags = [], projectIds }) {
  const now = new Date().toISOString();
  const frontmatter = {
    ...DEFAULT_FRONTMATTER,
    project,
    campaignId,
    status: 'active',
    created: now,
    updated: now,
    tags,
  };

  // Include projectIds in frontmatter for multi-project campaigns
  if (Array.isArray(projectIds) && projectIds.length > 1) {
    frontmatter.projectIds = projectIds;
  }

  const checklist = milestones.map(m => `- [ ] ${m.title || m}`).join('\n');

  const sections = {
    Goal: goal || '',
    Milestones: checklist,
    Outcomes: '',
    'Related Incidents': '',
    'Related Learnings': '',
    Notes: '',
  };

  return { frontmatter, sections };
}
