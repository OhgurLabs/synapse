/**
 * Learning note template — reusable wisdom from agent experience.
 * Keyed by contentHash (deduplication via learnings system).
 */

export const TEMPLATE_VERSION = 1;
export const TYPE = 'learning';

export const DEFAULT_FRONTMATTER = {
  type: TYPE,
  project: '',
  category: '',
  severity: 'minor',
  created: '',
  updated: '',
  templateVersion: TEMPLATE_VERSION,
  tags: [],
};

export const SECTIONS = [
  'Pattern',
  'Why',
  'Correction',
  'Related Incidents',
  'Related Modules',
  'Notes',
];

export function buildInitial({ project, category, severity, pattern, why, correction, relatedModules = [], relatedIncidents = [], tags = [] }) {
  const now = new Date().toISOString();
  const frontmatter = {
    ...DEFAULT_FRONTMATTER,
    project,
    category: category || 'pattern_detected',
    severity: severity || 'minor',
    created: now,
    updated: now,
    tags,
  };

  const sections = {
    Pattern: pattern || '',
    Why: why || '',
    Correction: correction || '',
    'Related Incidents': relatedIncidents.map(i => `- [[${i}]]`).join('\n'),
    'Related Modules': relatedModules.map(m => `- [[${m}]]`).join('\n'),
    Notes: '',
  };

  return { frontmatter, sections };
}
