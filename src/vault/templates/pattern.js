/**
 * Pattern note template — recurring pro/anti patterns detected from clustered learnings.
 * Auto-created when 3+ learnings share a tag cluster.
 */

export const TEMPLATE_VERSION = 1;
export const TYPE = 'pattern';

export const DEFAULT_FRONTMATTER = {
  type: TYPE,
  project: '',
  kind: 'anti',  // 'pro' or 'anti'
  created: '',
  updated: '',
  templateVersion: TEMPLATE_VERSION,
  tags: [],
};

export const SECTIONS = [
  'Description',
  'Examples',
  'Related Learnings',
  'Prevention',
  'Notes',
];

export function buildInitial({ project, kind, description, learnings = [], tags = [] }) {
  const now = new Date().toISOString();
  const frontmatter = {
    ...DEFAULT_FRONTMATTER,
    project,
    kind: kind || 'anti',
    created: now,
    updated: now,
    tags,
  };

  const sections = {
    Description: description || '',
    Examples: '',
    'Related Learnings': learnings.map(l => `- [[${l}]]`).join('\n'),
    Prevention: '',
    Notes: '',
  };

  return { frontmatter, sections };
}
