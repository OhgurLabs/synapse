/**
 * VaultQuery — scores vault notes by relevance and injects compact context into agent prompts.
 *
 * Scoring factors:
 *   fileMatch (40): note is about a file the subtask touches
 *   recency  (20): note was recently updated
 *   severity (20): high-severity incidents/learnings
 *   links    (10): notes with more [[wikilinks]] = more connected
 *   roleWeight(10): role-specific boost (reviewer→severity, developer→recency, architect→patterns)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';
import { parseNote, pathToSlug } from './writer.js';
import { assertSafeProjectId } from '../safe-id.js';

const log = createLogger('vault-query');

export class VaultQuery {
  /**
   * @param {string} projectsDir - path to .synapse/projects/
   * @param {object} config - { maxChars: { claude: 2000, ... }, scoreThreshold: 5 }
   */
  constructor(projectsDir, config = {}) {
    this._projectsDir = projectsDir;
    this._config = {
      maxChars: {
        claude: 2000,
        codex: 1500,
        gemini: 1500,
        ollama: 800,
        ...config.maxChars,
      },
      scoreThreshold: config.scoreThreshold ?? 5,
    };
    // Cache: slug → { frontmatter, sections, mtime }
    this._noteCache = new Map();
  }

  // ─── Main query method ────────────────────────────────────

  /**
   * Find relevant vault notes for a subtask.
   * @param {object} opts - { projectId, subtaskText, taskFiles, agentRole, provider }
   * @returns {object[]} Scored notes: [{ slug, score, frontmatter, sections, ... }]
   */
  findRelevant({ projectId, subtaskText = '', taskFiles = [], agentRole = 'developer', provider = 'claude' }) {
    assertSafeProjectId(projectId);
    const vaultDir = join(this._projectsDir, projectId, 'vault');
    if (!existsSync(vaultDir)) return [];

    // Build context for scoring
    const fileSlugs = new Set(
      taskFiles.map(f => pathToSlug(typeof f === 'string' ? f : f.path))
    );

    // Extract keywords from subtask text for tag matching
    const keywords = this._extractKeywords(subtaskText);

    // Scan all notes and score them
    const scoredNotes = [];
    this._scanAndScore(vaultDir, { fileSlugs, keywords, agentRole }, scoredNotes);

    // Sort by score descending, filter by threshold
    scoredNotes.sort((a, b) => b.score - a.score);
    return scoredNotes.filter(n => n.score >= this._config.scoreThreshold);
  }

  /**
   * Format scored notes into an injectable context string within budget.
   * @param {object[]} scoredNotes - from findRelevant()
   * @param {number} budgetChars - max characters
   * @returns {string} formatted vault context
   */
  formatForContext(scoredNotes, budgetChars) {
    if (scoredNotes.length === 0) return '';

    const lines = ['=== VAULT CONTEXT (institutional knowledge) ==='];
    let used = lines[0].length;

    for (const note of scoredNotes) {
      const block = this._compactRender(note);
      if (used + block.length + 2 > budgetChars) break;
      lines.push(block);
      used += block.length + 1;
    }

    lines.push('=== END VAULT ===');
    return lines.join('\n');
  }

  /**
   * Convenience: find + format in one call.
   */
  buildContext({ projectId, subtaskText, taskFiles, agentRole, provider }) {
    const prov = provider || 'claude';
    const budget = this._config.maxChars[prov] ?? this._config.maxChars.claude;
    const notes = this.findRelevant({ projectId, subtaskText, taskFiles, agentRole, provider: prov });
    return this.formatForContext(notes, budget);
  }

  // ─── Scoring ──────────────────────────────────────────────

  _scanAndScore(dir, context, results) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('_')) {
        this._scanAndScore(join(dir, entry.name), context, results);
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        const filePath = join(dir, entry.name);
        const note = this._loadNote(filePath);
        if (!note) continue;

        const score = this._score(note, context);
        if (score > 0) {
          results.push({ ...note, score, filePath });
        }
      }
    }
  }

  _loadNote(filePath) {
    const slug = filePath.split('/').pop().replace(/\.md$/, '');
    const cacheKey = filePath;

    try {
      const stat = statSync(filePath);
      const cached = this._noteCache.get(cacheKey);
      if (cached && cached.mtime >= stat.mtimeMs) {
        return cached;
      }

      const content = readFileSync(filePath, 'utf8');
      const parsed = parseNote(content);
      const entry = {
        slug,
        frontmatter: parsed.frontmatter,
        sections: parsed.sections,
        title: parsed.title,
        mtime: stat.mtimeMs,
      };
      this._noteCache.set(cacheKey, entry);
      return entry;
    } catch {
      return null;
    }
  }

  _score(note, { fileSlugs, keywords, agentRole }) {
    let score = 0;
    const fm = note.frontmatter;
    const type = fm.type;

    // ── fileMatch (0-40) ────────────────────────────────
    // Module note whose slug matches a task file
    if (type === 'module' && fm.path) {
      const noteSlug = pathToSlug(fm.path);
      if (fileSlugs.has(noteSlug)) {
        score += 40;
      }
    }
    // Incident/learning referencing an affected module
    if (type === 'incident' || type === 'learning') {
      const affectedMods = note.sections['Affected Modules'] || note.sections['Related Modules'] || '';
      for (const slug of fileSlugs) {
        if (affectedMods.includes(slug)) {
          score += 30;
          break;
        }
      }
    }

    // ── recency (0-20) ──────────────────────────────────
    const updated = fm.updated ? new Date(fm.updated).getTime() : 0;
    if (updated > 0) {
      const ageHours = (Date.now() - updated) / (1000 * 60 * 60);
      if (ageHours < 24) score += 20;
      else if (ageHours < 72) score += 15;
      else if (ageHours < 168) score += 10;
      else if (ageHours < 720) score += 5;
    }

    // ── severity (0-20) ─────────────────────────────────
    const severity = fm.severity;
    if (severity === 'critical') score += 20;
    else if (severity === 'serious') score += 15;
    else if (severity === 'important') score += 10;

    // ── tag/keyword match (0-10) ────────────────────────
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    let tagMatches = 0;
    for (const kw of keywords) {
      if (tags.some(t => t.toLowerCase().includes(kw))) {
        tagMatches++;
      }
    }
    score += Math.min(tagMatches * 3, 10);

    // ── link density (0-10) ─────────────────────────────
    const allContent = Object.values(note.sections).join('\n');
    const linkCount = (allContent.match(/\[\[/g) || []).length;
    score += Math.min(linkCount * 2, 10);

    // ── role weight (0-10) ──────────────────────────────
    if (agentRole === 'reviewer') {
      // Reviewers care about severity — double the severity component
      if (severity === 'critical' || severity === 'serious') score += 10;
    } else if (agentRole === 'developer' || agentRole === 'implementer') {
      // Developers care about recency
      if (updated > 0 && (Date.now() - updated) < 72 * 60 * 60 * 1000) score += 10;
    } else if (agentRole === 'architect') {
      // Architects care about patterns and decisions
      if (type === 'pattern' || type === 'decision') score += 10;
    }

    return score;
  }

  // ─── Compact rendering ────────────────────────────────────

  _compactRender(note) {
    const type = note.frontmatter.type || '?';
    const lines = [`[${type}] ${note.title || note.slug}`];

    // Show Gotchas for modules (most actionable section)
    if (note.sections.Gotchas) {
      lines.push(`  Gotchas: ${note.sections.Gotchas.substring(0, 300)}`);
    }

    // Show Contracts for modules
    if (note.sections.Contracts) {
      lines.push(`  Contracts: ${note.sections.Contracts.substring(0, 300)}`);
    }

    // Show Summary for incidents
    if (note.sections.Summary) {
      lines.push(`  Summary: ${note.sections.Summary.substring(0, 300)}`);
    }

    // Show Pattern + Correction for learnings
    if (note.sections.Pattern) {
      lines.push(`  Pattern: ${note.sections.Pattern.substring(0, 200)}`);
    }
    if (note.sections.Correction) {
      lines.push(`  Fix: ${note.sections.Correction.substring(0, 200)}`);
    }

    // Show Description for patterns
    if (note.sections.Description && type === 'pattern') {
      lines.push(`  Description: ${note.sections.Description.substring(0, 200)}`);
    }

    // Dependencies for modules
    if (note.sections.Dependencies) {
      lines.push(`  Deps: ${note.sections.Dependencies.substring(0, 150)}`);
    }

    return lines.join('\n');
  }

  // ─── Keyword extraction ───────────────────────────────────

  _extractKeywords(text) {
    if (!text) return [];
    // Extract meaningful words (3+ chars, lowercase)
    const words = text.toLowerCase()
      .replace(/[^a-z0-9_-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3);
    // Deduplicate, keep first 20
    return [...new Set(words)].slice(0, 20);
  }
}
