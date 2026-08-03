/**
 * VaultWriter — writes Obsidian-compatible knowledge notes from agent experience.
 *
 * Notes are Markdown with YAML frontmatter and [[wikilinks]].
 * Storage: .synapse/vault/{projectId}/{type}/{slug}.md
 *
 * Write triggers:
 *   onSubtaskComplete  → module notes from git diff
 *   onReviewFindings   → incident notes on review FAIL
 *   onLearningCreated  → learning notes, pattern detection
 *   onMilestoneComplete → campaign note updates
 *   onCampaignComplete → campaign closeout + archive
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, extname, basename, relative } from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../logger.js';
import { createHash } from 'crypto';
import * as moduleTemplate from './templates/module.js';
import * as incidentTemplate from './templates/incident.js';
import * as learningTemplate from './templates/learning.js';
import * as patternTemplate from './templates/pattern.js';
import * as campaignTemplate from './templates/campaign.js';

const log = createLogger('vault-writer');

/**
 * Convert a file path to a vault slug.
 * executor/maker_daemon.py → executor-maker-daemon
 */
export function pathToSlug(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/\.[^/.]+$/, '')       // drop extension
    .replace(/[/\\]/g, '-')         // slashes → dashes
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Convert a learning/incident description to a slug.
 */
export function textToSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

// ─── Note parsing / rendering ────────────────────────────────────

/**
 * Parse a Markdown note into { frontmatter: object, sections: Map<name, content>, title: string }.
 */
export function parseNote(content) {
  const result = { frontmatter: {}, sections: {}, title: '' };

  // Extract YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    const yamlBlock = fmMatch[1];
    for (const line of yamlBlock.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx).trim();
      let value = line.substring(colonIdx + 1).trim();
      // Parse arrays: [a, b, c]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      }
      result.frontmatter[key] = value;
    }
    content = content.substring(fmMatch[0].length);
  }

  // Extract title (first # heading)
  const titleMatch = content.match(/^# (.+)$/m);
  if (titleMatch) {
    result.title = titleMatch[1].trim();
    content = content.substring(content.indexOf('\n', content.indexOf(titleMatch[0])) + 1);
  }

  // Extract sections (## headings)
  const sectionRegex = /^## (.+)$/gm;
  const sectionNames = [];
  const sectionStarts = [];
  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    sectionNames.push(match[1].trim());
    sectionStarts.push(match.index);
  }

  for (let i = 0; i < sectionNames.length; i++) {
    const start = content.indexOf('\n', sectionStarts[i]) + 1;
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] : content.length;
    result.sections[sectionNames[i]] = content.substring(start, end).trim();
  }

  return result;
}

/**
 * Render a note back to Markdown.
 */
export function renderNote(frontmatter, title, sections, sectionOrder) {
  const lines = ['---'];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('---', '', `# ${title}`, '');

  for (const name of sectionOrder) {
    const content = sections[name] ?? '';
    lines.push(`## ${name}`, content, '');
  }

  return lines.join('\n');
}

// ─── VaultWriter class ──────────────────────────────────────────

export class VaultWriter {
  /**
   * @param {object} stateManager - StateManager instance (for projectsDir)
   * @param {object} config - vault config { staleAfterDays, patternThreshold }
   */
  constructor(stateManager, config = {}) {
    this._stateManager = stateManager;
    this._config = {
      staleAfterDays: config.staleAfterDays ?? 30,
      patternThreshold: config.patternThreshold ?? 3,
    };
    // slug → filePath index for dedup
    this._slugIndex = new Map();
    // contentHash → slug for learning dedup
    this._learningHashes = new Map();
  }

  /**
   * Initialize: scan existing vault dirs, build slug index.
   */
  init() {
    const projectsDir = this._stateManager.projectsDir;
    if (!existsSync(projectsDir)) return this;

    for (const projId of readdirSync(projectsDir)) {
      const vaultDir = join(projectsDir, projId, 'vault');
      if (!existsSync(vaultDir) || !statSync(vaultDir).isDirectory()) continue;
      this._scanDir(vaultDir, projId);
    }

    log.info('Vault writer initialized', { indexSize: this._slugIndex.size });
    return this;
  }

  _scanDir(dir, projectId) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        this._scanDir(join(dir, entry.name), projectId);
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        const slug = entry.name.replace(/\.md$/, '');
        const filePath = join(dir, entry.name);
        this._slugIndex.set(`${projectId}:${slug}`, filePath);

        // Index learning hashes
        try {
          const content = readFileSync(filePath, 'utf8');
          const note = parseNote(content);
          if (note.frontmatter.type === 'learning' && note.frontmatter.contentHash) {
            this._learningHashes.set(`${projectId}:${note.frontmatter.contentHash}`, slug);
          }
        } catch { /* skip corrupt */ }
      }
    }
  }

  // ─── Directory helpers ──────────────────────────────────────

  _vaultDir(projectId) {
    return join(this._stateManager.projectsDir, projectId, 'vault');
  }

  _typeDir(projectId, type) {
    const dir = join(this._vaultDir(projectId), type === 'pattern' ? 'patterns' : `${type}s`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ─── Atomic write ──────────────────────────────────────────

  _atomicWrite(filePath, content) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, filePath);
  }

  // ─── Resolve / create note path ────────────────────────────

  _resolveNote(projectId, type, slug) {
    const key = `${projectId}:${slug}`;
    if (this._slugIndex.has(key)) {
      return this._slugIndex.get(key);
    }
    const dir = this._typeDir(projectId, type);
    const filePath = join(dir, `${slug}.md`);
    this._slugIndex.set(key, filePath);
    return filePath;
  }

  // ─── Extract imports → [[dependency]] links ────────────────

  _extractDependencies(sourceContent, filePath) {
    const deps = [];
    const ext = extname(filePath);

    if (['.js', '.mjs', '.ts'].includes(ext)) {
      // ES import: import { X } from './foo.js'
      const importRe = /(?:import|from)\s+['"]([^'"]+)['"]/g;
      let m;
      while ((m = importRe.exec(sourceContent)) !== null) {
        const importPath = m[1];
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
          deps.push(pathToSlug(importPath));
        }
      }
      // require()
      const requireRe = /require\(['"]([^'"]+)['"]\)/g;
      while ((m = requireRe.exec(sourceContent)) !== null) {
        const importPath = m[1];
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
          deps.push(pathToSlug(importPath));
        }
      }
    } else if (['.py'].includes(ext)) {
      // Python imports: from foo import bar, import foo
      const pyImportRe = /(?:from|import)\s+([a-zA-Z0-9_.]+)/g;
      let m;
      while ((m = pyImportRe.exec(sourceContent)) !== null) {
        const mod = m[1];
        // Only local imports (relative or project-local)
        if (!mod.includes('.') || mod.startsWith('.')) continue;
        deps.push(pathToSlug(mod.replace(/\./g, '/')));
      }
    }

    return [...new Set(deps)];
  }

  // ─── Git diff helper ──────────────────────────────────────

  _getChangedFiles(workingDir) {
    try {
      const output = execSync(
        'git diff HEAD~1 HEAD --name-only --diff-filter=ACMR 2>/dev/null || git diff --cached --name-only --diff-filter=ACMR 2>/dev/null',
        { cwd: workingDir, encoding: 'utf8', timeout: 5000 }
      );
      return output.trim().split('\n').filter(f => f.trim().length > 0);
    } catch {
      return [];
    }
  }

  // ─── Write Path: Subtask Complete ─────────────────────────

  /**
   * Create/update module notes from git diff after subtask completion.
   * @param {object} opts - { projectId, taskId, subtaskId, agentId, result, workingDir }
   */
  onSubtaskComplete({ projectId, taskId, subtaskId, agentId, result, workingDir }) {
    try {
      const changedFiles = this._getChangedFiles(workingDir);
      if (changedFiles.length === 0) return;

      const today = new Date().toISOString().split('T')[0];
      let notesWritten = 0;

      for (const filePath of changedFiles) {
        // Skip non-code files
        const ext = extname(filePath);
        if (['.md', '.json', '.jsonl', '.lock', '.log', '.sqlite'].includes(ext)) continue;
        if (filePath.startsWith('.synapse/') || filePath.startsWith('node_modules/')) continue;

        const slug = pathToSlug(filePath);
        const notePath = this._resolveNote(projectId, 'module', slug);

        if (existsSync(notePath)) {
          // Update existing note
          this._updateModuleNote(notePath, filePath, agentId, today, result, workingDir);
        } else {
          // Create new module note
          this._createModuleNote(notePath, filePath, projectId, agentId, today, result, workingDir);
        }
        notesWritten++;
      }

      // Regenerate module map
      if (notesWritten > 0) {
        this._updateModuleMap(projectId);
      }

      log.info('Vault: subtask complete', { projectId, taskId, subtaskId, notesWritten, files: changedFiles.length });
    } catch (err) {
      log.warn('Vault write failed on subtask complete', { projectId, taskId, error: err.message });
    }
  }

  _createModuleNote(notePath, filePath, projectId, agentId, today, result, workingDir) {
    // Try to read source file for import extraction
    let deps = [];
    try {
      const fullPath = join(workingDir, filePath);
      if (existsSync(fullPath)) {
        const sourceContent = readFileSync(fullPath, 'utf8');
        deps = this._extractDependencies(sourceContent, filePath);
      }
    } catch { /* source read failed, skip deps */ }

    const { frontmatter, sections } = moduleTemplate.buildInitial({
      path: filePath,
      project: projectId,
      dependencies: deps,
      tags: this._inferTags(filePath),
    });

    const summary = (result || '').substring(0, 200);
    if (summary) {
      sections['Change History'] = `- ${today}: ${summary} — @${agentId}`;
    }

    const content = renderNote(frontmatter, basename(filePath), sections, moduleTemplate.SECTIONS);
    this._atomicWrite(notePath, content);
  }

  _updateModuleNote(notePath, filePath, agentId, today, result, workingDir) {
    const existing = readFileSync(notePath, 'utf8');
    const note = parseNote(existing);

    // Bump lastVerified + updated
    note.frontmatter.lastVerified = today;
    note.frontmatter.updated = new Date().toISOString();

    // Re-extract dependencies if source readable
    try {
      const fullPath = join(workingDir, filePath);
      if (existsSync(fullPath)) {
        const sourceContent = readFileSync(fullPath, 'utf8');
        const deps = this._extractDependencies(sourceContent, filePath);
        if (deps.length > 0) {
          note.sections.Dependencies = deps.map(d => `- [[${d}]]`).join('\n');
        }
      }
    } catch { /* skip */ }

    // Append to change history
    const summary = (result || '').substring(0, 200);
    if (summary) {
      const historyLine = `- ${today}: ${summary} — @${agentId}`;
      const existing_history = note.sections['Change History'] || '';
      // Keep last 20 entries
      const historyLines = existing_history.split('\n').filter(l => l.startsWith('- '));
      historyLines.unshift(historyLine);
      note.sections['Change History'] = historyLines.slice(0, 20).join('\n');
    }

    const content = renderNote(note.frontmatter, note.title, note.sections, moduleTemplate.SECTIONS);
    this._atomicWrite(notePath, content);
  }

  // ─── Write Path: Review Findings (Incident) ──────────────

  /**
   * Create incident notes on review FAIL.
   * @param {object} opts - { projectId, taskId, subtaskId, agentId, findings, severity }
   */
  onReviewFindings({ projectId, taskId, subtaskId, agentId, findings }) {
    try {
      if (!findings || findings.length === 0) return;

      const today = new Date().toISOString().split('T')[0];

      // Group findings by severity — only create incidents for critical/serious
      const significant = findings.filter(f =>
        f.severity === 'critical' || f.severity === 'serious'
      );
      if (significant.length === 0) return;

      // Build incident slug from first finding
      const issueText = significant[0].issue || 'review-failure';
      const slug = `${today}-${textToSlug(issueText)}`;
      const notePath = this._resolveNote(projectId, 'incident', slug);

      // Affected modules
      const affectedModules = [...new Set(
        significant.map(f => f.file).filter(Boolean).map(f => pathToSlug(f))
      )];

      const summary = significant.map(f =>
        `- **${f.severity}**: ${f.issue}${f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : ''}`
      ).join('\n');

      const fix = significant.map(f =>
        f.fix ? `- ${f.file || '?'}: ${f.fix}` : null
      ).filter(Boolean).join('\n');

      const tags = [
        ...this._inferTagsFromFindings(significant),
        `reviewer:${agentId}`,
      ];

      const { frontmatter, sections } = incidentTemplate.buildInitial({
        project: projectId,
        slug,
        severity: significant[0].severity,
        summary,
        rootCause: '',
        affectedModules,
        fix,
        tags,
      });
      frontmatter.taskId = taskId;
      frontmatter.subtaskId = subtaskId;

      const content = renderNote(frontmatter, slug, sections, incidentTemplate.SECTIONS);
      this._atomicWrite(notePath, content);

      // Update affected module notes' Gotchas section
      for (const modSlug of affectedModules) {
        this._appendModuleGotcha(projectId, modSlug, slug, significant);
      }

      log.info('Vault: incident created', { projectId, slug, findings: significant.length, modules: affectedModules.length });
    } catch (err) {
      log.warn('Vault write failed on review findings', { projectId, taskId, error: err.message });
    }
  }

  _appendModuleGotcha(projectId, moduleSlug, incidentSlug, findings) {
    const key = `${projectId}:${moduleSlug}`;
    const notePath = this._slugIndex.get(key);
    if (!notePath || !existsSync(notePath)) return;

    try {
      const existing = readFileSync(notePath, 'utf8');
      const note = parseNote(existing);

      const gotchaLine = `- See [[${incidentSlug}]]: ${findings.map(f => f.issue).join('; ').substring(0, 200)}`;
      const existingGotchas = note.sections.Gotchas || '';
      if (existingGotchas.includes(incidentSlug)) return; // already linked

      note.sections.Gotchas = existingGotchas
        ? `${existingGotchas}\n${gotchaLine}`
        : gotchaLine;

      note.frontmatter.updated = new Date().toISOString();

      const content = renderNote(note.frontmatter, note.title, note.sections, moduleTemplate.SECTIONS);
      this._atomicWrite(notePath, content);
    } catch { /* skip corrupt */ }
  }

  // ─── Write Path: Learning Created ─────────────────────────

  /**
   * Create learning note, detect patterns.
   * @param {object} opts - { projectId, learning } (learning is the record from LearningsManager.add())
   */
  onLearningCreated({ projectId, learning }) {
    try {
      if (!learning) return;

      // Dedup check
      const hashKey = `${projectId}:${learning.contentHash}`;
      if (this._learningHashes.has(hashKey)) return;

      const slug = textToSlug(learning.pattern || learning.id);
      const notePath = this._resolveNote(projectId, 'learning', slug);

      // Find related modules from tags
      const relatedModules = (learning.tags || [])
        .filter(t => t.startsWith('file:'))
        .map(t => pathToSlug(t.replace('file:', '')));

      const { frontmatter, sections } = learningTemplate.buildInitial({
        project: projectId,
        category: learning.category,
        severity: learning.severity,
        pattern: learning.pattern,
        why: learning.why,
        correction: learning.correction,
        relatedModules,
        tags: learning.tags || [],
      });
      frontmatter.contentHash = learning.contentHash;
      frontmatter.learningId = learning.id;

      const content = renderNote(frontmatter, slug, sections, learningTemplate.SECTIONS);
      this._atomicWrite(notePath, content);
      this._learningHashes.set(hashKey, slug);

      // Pattern detection: check if 3+ learnings share tag clusters
      this._detectPatterns(projectId, learning);

      log.info('Vault: learning noted', { projectId, slug, category: learning.category });
    } catch (err) {
      log.warn('Vault write failed on learning created', { projectId, error: err.message });
    }
  }

  _detectPatterns(projectId, learning) {
    const threshold = this._config.patternThreshold;
    const tags = (learning.tags || []).filter(t => !t.startsWith('provider:'));
    if (tags.length === 0) return;

    // Count how many learnings share each tag
    const tagCounts = new Map();
    const learningsDir = this._typeDir(projectId, 'learning');

    try {
      for (const file of readdirSync(learningsDir)) {
        if (!file.endsWith('.md')) continue;
        const content = readFileSync(join(learningsDir, file), 'utf8');
        const note = parseNote(content);
        const noteTags = note.frontmatter.tags || [];
        if (!Array.isArray(noteTags)) continue;

        for (const tag of tags) {
          if (noteTags.includes(tag)) {
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          }
        }
      }
    } catch { return; }

    // Find tags at threshold
    for (const [tag, count] of tagCounts) {
      if (count < threshold) continue;

      const patternSlug = `anti-${textToSlug(tag)}`;
      const patternPath = this._resolveNote(projectId, 'pattern', patternSlug);
      if (existsSync(patternPath)) continue; // already created

      // Create pattern note
      const { frontmatter, sections } = patternTemplate.buildInitial({
        project: projectId,
        kind: 'anti',
        description: `Recurring pattern detected: ${count}+ learnings tagged "${tag}"`,
        learnings: [], // will be populated lazily
        tags: [tag],
      });

      const content = renderNote(frontmatter, patternSlug, sections, patternTemplate.SECTIONS);
      this._atomicWrite(patternPath, content);
      log.info('Vault: pattern detected', { projectId, tag, count, slug: patternSlug });
    }
  }

  // ─── Write Path: Milestone Complete ───────────────────────

  /**
   * Update campaign note with milestone completion.
   * @param {object} opts - { projectId, campaignId, milestoneId, milestoneTitle, projectIds }
   */
  onMilestoneComplete({ projectId, campaignId, milestoneId, milestoneTitle, projectIds }) {
    try {
      const slug = campaignId.substring(0, 20).replace(/[^a-zA-Z0-9_-]/g, '-');
      const notePath = this._resolveNote(projectId, 'campaign', slug);

      if (!existsSync(notePath)) {
        // Create campaign note if it doesn't exist yet
        const { frontmatter, sections } = campaignTemplate.buildInitial({
          project: projectId,
          campaignId,
          tags: [],
          projectIds,
        });
        const content = renderNote(frontmatter, `Campaign ${slug}`, sections, campaignTemplate.SECTIONS);
        this._atomicWrite(notePath, content);
      }

      // Update: check the milestone checkbox
      const existing = readFileSync(notePath, 'utf8');
      const note = parseNote(existing);
      note.frontmatter.updated = new Date().toISOString();

      const milestones = note.sections.Milestones || '';
      const titleEscaped = (milestoneTitle || milestoneId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (titleEscaped) {
        note.sections.Milestones = milestones.replace(
          new RegExp(`- \\[ \\] (.*${titleEscaped}.*)`),
          '- [x] $1'
        );
      }

      const content = renderNote(note.frontmatter, note.title, note.sections, campaignTemplate.SECTIONS);
      this._atomicWrite(notePath, content);

      log.info('Vault: milestone complete', { projectId, campaignId, milestoneTitle });
    } catch (err) {
      log.warn('Vault write failed on milestone complete', { projectId, campaignId, error: err.message });
    }
  }

  // ─── Write Path: Campaign Complete ────────────────────────

  /**
   * Campaign closeout — populate outcomes, archive.
   * @param {object} opts - { projectId, campaignId, outcomes }
   */
  onCampaignComplete({ projectId, campaignId, outcomes }) {
    try {
      const slug = campaignId.substring(0, 20).replace(/[^a-zA-Z0-9_-]/g, '-');
      const notePath = this._resolveNote(projectId, 'campaign', slug);

      if (!existsSync(notePath)) return;

      const existing = readFileSync(notePath, 'utf8');
      const note = parseNote(existing);
      note.frontmatter.status = 'completed';
      note.frontmatter.updated = new Date().toISOString();
      note.sections.Outcomes = outcomes || 'Campaign completed.';

      const content = renderNote(note.frontmatter, note.title, note.sections, campaignTemplate.SECTIONS);
      this._atomicWrite(notePath, content);

      // Archive: move to _archive/ directory
      const archiveDir = join(this._vaultDir(projectId), '_archive');
      if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
      const archivePath = join(archiveDir, `${slug}.md`);
      renameSync(notePath, archivePath);

      // Update index
      const key = `${projectId}:${slug}`;
      this._slugIndex.set(key, archivePath);

      log.info('Vault: campaign archived', { projectId, campaignId, slug });
    } catch (err) {
      log.warn('Vault write failed on campaign complete', { projectId, campaignId, error: err.message });
    }
  }

  // ─── Module Map ───────────────────────────────────────────

  _updateModuleMap(projectId) {
    const modulesDir = this._typeDir(projectId, 'module');
    const files = readdirSync(modulesDir).filter(f => f.endsWith('.md') && f !== '_map.md');

    const lines = ['# Module Map', '', `*Auto-generated — ${files.length} modules*`, ''];
    for (const file of files.sort()) {
      const slug = file.replace(/\.md$/, '');
      lines.push(`- [[${slug}]]`);
    }

    const mapPath = join(modulesDir, '_map.md');
    this._atomicWrite(mapPath, lines.join('\n') + '\n');
  }

  // ─── Tag inference helpers ────────────────────────────────

  _inferTags(filePath) {
    const tags = [];
    const lower = filePath.toLowerCase();
    if (lower.includes('test')) tags.push('testing');
    if (lower.includes('websocket') || lower.includes('ws')) tags.push('websocket');
    if (lower.includes('api') || lower.includes('route')) tags.push('api');
    if (lower.includes('daemon') || lower.includes('service')) tags.push('daemon');
    if (lower.includes('config')) tags.push('configuration');
    // Extract directory as domain tag
    const parts = filePath.split('/');
    if (parts.length > 1) tags.push(`dir:${parts[0]}`);
    return tags;
  }

  _inferTagsFromFindings(findings) {
    const tags = new Set();
    for (const f of findings) {
      if (f.file) {
        for (const tag of this._inferTags(f.file)) {
          tags.add(tag);
        }
      }
      // Extract domain tags from issue text
      const words = (f.issue || '').toLowerCase();
      if (words.includes('import') || words.includes('caller')) tags.add('dependency-tracking');
      if (words.includes('signature') || words.includes('parameter')) tags.add('api-contract');
      if (words.includes('missing') || words.includes('undefined')) tags.add('missing-reference');
    }
    return [...tags];
  }

  // ─── Staleness check (for heartbeat) ──────────────────────

  /**
   * Scan vault for stale notes.
   * @param {string} projectId
   * @returns {{ staleCount: number, totalCount: number, staleNotes: string[] }}
   */
  checkStaleness(projectId) {
    const vaultDir = this._vaultDir(projectId);
    if (!existsSync(vaultDir)) return { staleCount: 0, totalCount: 0, staleNotes: [] };

    const staleAfterDays = this._config.staleAfterDays;
    const cutoff = Date.now() - (staleAfterDays * 24 * 60 * 60 * 1000);
    const staleNotes = [];
    let totalCount = 0;

    const scanDir = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('_')) {
          scanDir(join(dir, entry.name));
        } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
          totalCount++;
          try {
            const content = readFileSync(join(dir, entry.name), 'utf8');
            const note = parseNote(content);
            const lastVerified = note.frontmatter.lastVerified;
            if (lastVerified) {
              const verifiedDate = new Date(lastVerified).getTime();
              if (verifiedDate < cutoff) {
                staleNotes.push(entry.name.replace(/\.md$/, ''));
              }
            }
          } catch { /* skip */ }
        }
      }
    };

    scanDir(vaultDir);
    return { staleCount: staleNotes.length, totalCount, staleNotes };
  }

  /**
   * Bump lastVerified on module notes whose files were touched.
   * @param {string} projectId
   * @param {string[]} touchedFiles - file paths from git diff
   */
  bumpVerified(projectId, touchedFiles) {
    const today = new Date().toISOString().split('T')[0];
    for (const filePath of touchedFiles) {
      const slug = pathToSlug(filePath);
      const key = `${projectId}:${slug}`;
      const notePath = this._slugIndex.get(key);
      if (!notePath || !existsSync(notePath)) continue;

      try {
        const existing = readFileSync(notePath, 'utf8');
        const note = parseNote(existing);
        if (note.frontmatter.lastVerified === today) continue;

        note.frontmatter.lastVerified = today;
        note.frontmatter.updated = new Date().toISOString();
        const content = renderNote(note.frontmatter, note.title, note.sections, moduleTemplate.SECTIONS);
        this._atomicWrite(notePath, content);
      } catch { /* skip */ }
    }
  }

  // ─── Health metrics ───────────────────────────────────────

  /**
   * Get vault health stats for /api/vault/health.
   */
  getHealth(projectId) {
    const vaultDir = this._vaultDir(projectId);
    if (!existsSync(vaultDir)) {
      return { exists: false, noteCount: 0, byType: {}, staleness: { staleCount: 0, totalCount: 0 }, notesGrowth: {} };
    }

    const byType = { module: 0, incident: 0, learning: 0, pattern: 0, campaign: 0, decision: 0 };
    const notesGrowth = {}; // notes with large ## Notes section
    let noteCount = 0;

    const scanDir = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('_')) {
          scanDir(join(dir, entry.name));
        } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
          noteCount++;
          try {
            const content = readFileSync(join(dir, entry.name), 'utf8');
            const note = parseNote(content);
            const type = note.frontmatter.type;
            if (type && byType[type] !== undefined) byType[type]++;

            // Check ## Notes section growth
            const notesSection = note.sections.Notes || '';
            if (notesSection.length > 200) {
              notesGrowth[entry.name.replace(/\.md$/, '')] = notesSection.length;
            }
          } catch { /* skip */ }
        }
      }
    };

    scanDir(vaultDir);
    const staleness = this.checkStaleness(projectId);

    return { exists: true, noteCount, byType, staleness, notesGrowth };
  }
}
