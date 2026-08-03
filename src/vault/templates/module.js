/**
 * Module note template — one per source code file/module.
 * Keyed by file path (one note per source file).
 */

export const TEMPLATE_VERSION = 1;
export const TYPE = 'module';

export const DEFAULT_FRONTMATTER = {
  type: TYPE,
  path: '',
  project: '',
  created: '',
  updated: '',
  lastVerified: '',
  templateVersion: TEMPLATE_VERSION,
  tags: [],
};

export const SECTIONS = [
  'Purpose',
  'Contracts',
  'Dependencies',
  'Dependents',
  'Gotchas',
  'Change History',
  'Notes',
];

/**
 * Build initial content for a new module note.
 * @param {object} opts - { path, project, purpose, dependencies, tags }
 */
export function buildInitial({ path, project, purpose, dependencies = [], tags = [] }) {
  const now = new Date().toISOString();
  const frontmatter = {
    ...DEFAULT_FRONTMATTER,
    path,
    project,
    created: now,
    updated: now,
    lastVerified: now.split('T')[0],
    tags,
  };

  const sections = {
    Purpose: purpose || `Source file: \`${path}\``,
    Contracts: '',
    Dependencies: dependencies.map(d => `- [[${d}]]`).join('\n'),
    Dependents: '',
    Gotchas: '',
    'Change History': '',
    Notes: '',
  };

  return { frontmatter, sections };
}
