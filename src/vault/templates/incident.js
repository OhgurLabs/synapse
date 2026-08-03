/**
 * Incident note template — things that broke.
 * Keyed by taskId+subtaskId (or date+slug for manual).
 */

export const TEMPLATE_VERSION = 1;
export const TYPE = 'incident';

export const DEFAULT_FRONTMATTER = {
  type: TYPE,
  project: '',
  severity: 'serious',
  created: '',
  updated: '',
  templateVersion: TEMPLATE_VERSION,
  tags: [],
};

export const SECTIONS = [
  'Summary',
  'Root Cause',
  'Affected Modules',
  'Fix',
  'Prevention',
  'Notes',
];

export function buildInitial({ project, slug, severity, summary, rootCause, affectedModules = [], fix, tags = [] }) {
  const now = new Date().toISOString();
  const frontmatter = {
    ...DEFAULT_FRONTMATTER,
    project,
    severity: severity || 'serious',
    created: now,
    updated: now,
    tags,
  };

  const sections = {
    Summary: summary || '',
    'Root Cause': rootCause || '',
    'Affected Modules': affectedModules.map(m => `- [[${m}]]`).join('\n'),
    Fix: fix || '',
    Prevention: '',
    Notes: '',
  };

  return { frontmatter, sections };
}
