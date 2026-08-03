/**
 * Decision note template — ADRs: why we chose X over Y.
 */

export const TEMPLATE_VERSION = 1;
export const TYPE = 'decision';

export const DEFAULT_FRONTMATTER = {
  type: TYPE,
  project: '',
  status: 'accepted',  // proposed | accepted | superseded
  created: '',
  updated: '',
  templateVersion: TEMPLATE_VERSION,
  tags: [],
};

export const SECTIONS = [
  'Context',
  'Decision',
  'Alternatives Considered',
  'Consequences',
  'Notes',
];

export function buildInitial({ project, title, context, decision, alternatives, consequences, tags = [] }) {
  const now = new Date().toISOString();
  const frontmatter = {
    ...DEFAULT_FRONTMATTER,
    project,
    status: 'accepted',
    created: now,
    updated: now,
    tags,
  };

  const sections = {
    Context: context || '',
    Decision: decision || '',
    'Alternatives Considered': alternatives || '',
    Consequences: consequences || '',
    Notes: '',
  };

  return { frontmatter, sections };
}
