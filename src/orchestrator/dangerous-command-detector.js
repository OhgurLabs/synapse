/**
 * DangerousCommandDetector — class-based pattern detection with allowlist support.
 *
 * Detects dangerous command patterns in task descriptions, prompts, and workflow nodes:
 *   - rm -rf / rm -fr (recursive force delete)
 *   - git reset --hard (destructive git operation)
 *   - git push --force / git push -f (force push)
 *   - DROP TABLE / DROP DATABASE / DROP SCHEMA (SQL destructive operations)
 *   - TRUNCATE TABLE (SQL truncate)
 *   - DELETE FROM ... WHERE 1=1 or bare DELETE FROM (SQL mass delete)
 *   - git clean -f / git clean -fd (git clean force)
 *   - git branch -D (force delete branch)
 *   - git checkout -- . (discard all local changes)
 *   - chmod 777/666 (overly permissive file permissions)
 *   - systemctl/service stop synapse (Synapse self-stop)
 *
 * Allowlist:
 *   Loaded from .synapse/dangerous-commands-allowlist.json at construction time.
 *   Supports exact command strings and simple glob-style patterns (prefix/suffix * wildcards).
 *   Allowlist entries may be scoped to specific projectIds or agentIds.
 *
 * Usage:
 *   const detector = new DangerousCommandDetector();
 *   detector.loadAllowlist('/path/to/.synapse/dangerous-commands-allowlist.json');
 *   const result = detector.detectDangerous('rm -rf /tmp/old');
 *   // => { isDangerous: true, pattern: 'Recursive force file deletion (rm -rf)', matches: [...] }
 *
 * Integration points:
 *   - Workflow engine: check node.config content before execution
 *   - Governance: escalate via governanceManager.createProposal
 *   - Checkpoints: create snapshot before any blocked execution
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('dangerous-commands');

/**
 * Obfuscation patterns to detect encoded/hidden commands.
 */
const OBFUSCATION_PATTERNS = [
  // Base64 encoded commands: echo 'base64string' | base64 -d | bash
  // Minimum 8 characters to avoid false positives but catch real encoded commands
  {
    pattern: /echo\s+['"]([A-Za-z0-9+/=]{8,})['"].*base64\s+-d/gi,
    type: 'base64',
  },
  {
    pattern: /base64\s+-d.*['"]([A-Za-z0-9+/=]{8,})['"]/gi,
    type: 'base64',
  },
  // Command substitution patterns
  {
    pattern: /\$\(([^)]+)\)/g,
    type: 'command_substitution',
  },
  {
    pattern: /`([^`]+)`/g,
    type: 'backtick_substitution',
  },
  // URL encoding patterns
  {
    pattern: /%[0-9A-Fa-f]{2}/g,
    type: 'url_encoded',
  },
  // Hex encoding patterns
  {
    pattern: /\\x[0-9A-Fa-f]{2}/g,
    type: 'hex_encoded',
  },
];

/**
 * Command chaining patterns that could hide dangerous commands.
 */
const CHAINING_PATTERNS = [
  /&&/g,
  /\|\|/g,
  /;/g,
  /\|/g,
];

/**
 * Decode base64 string safely.
 * @param {string} encoded
 * @returns {string|null}
 */
function decodeBase64Safe(encoded) {
  try {
    // Validate that string only contains valid base64 characters
    if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
      return null;
    }

    // Decode
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');

    // Validate that decoded output is valid UTF-8 (no control characters except whitespace/newline)
    // This helps catch invalid base64 that produces garbage
    if (/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/.test(decoded)) {
      return null;
    }

    return decoded;
  } catch (err) {
    return null;
  }
}

/**
 * Decode URL-encoded string.
 * @param {string} encoded
 * @returns {string}
 */
function decodeURL(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch (err) {
    return encoded;
  }
}

/**
 * Decode hex-encoded string.
 * @param {string} hexStr - e.g., "\\x72\\x6d"
 * @returns {string}
 */
function decodeHex(hexStr) {
  return hexStr.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

/**
 * Pre-process command string to expand obfuscated/hidden commands.
 * Returns an array of command variants to check.
 * @param {string} commandString
 * @returns {string[]} - array of command strings to scan (original + decoded variants)
 */
function expandObfuscatedCommands(commandString) {
  const variants = [commandString];
  const stringsToProcess = [commandString];

  // Extract and decode base64 encoded commands FIRST (before splitting)
  for (const obfPattern of OBFUSCATION_PATTERNS.filter(p => p.type === 'base64')) {
    obfPattern.pattern.lastIndex = 0;
    let match;
    while ((match = obfPattern.pattern.exec(commandString)) !== null) {
      const encoded = match[1];
      const decoded = decodeBase64Safe(encoded);
      if (decoded) {
        variants.push(decoded);
        stringsToProcess.push(decoded);
        log.debug('Detected base64 encoded command', { encoded: encoded.slice(0, 50), decoded });
      }
    }
  }

  // Extract command substitution content from all strings
  for (const str of stringsToProcess) {
    for (const obfPattern of OBFUSCATION_PATTERNS.filter(p => p.type === 'command_substitution' || p.type === 'backtick_substitution')) {
      obfPattern.pattern.lastIndex = 0;
      let match;
      while ((match = obfPattern.pattern.exec(str)) !== null) {
        const innerCommand = match[1];
        variants.push(innerCommand);
        log.debug('Detected command substitution', { type: obfPattern.type, command: innerCommand });
      }
    }
  }

  // Decode URL encoding
  if (/%[0-9A-Fa-f]{2}/.test(commandString)) {
    const urlDecoded = decodeURL(commandString);
    if (urlDecoded !== commandString) {
      variants.push(urlDecoded);
      stringsToProcess.push(urlDecoded);
      log.debug('Detected URL encoding', { original: commandString.slice(0, 100), decoded: urlDecoded.slice(0, 100) });
    }
  }

  // Decode hex encoding
  if (/\\x[0-9A-Fa-f]{2}/.test(commandString)) {
    const hexDecoded = decodeHex(commandString);
    if (hexDecoded !== commandString) {
      variants.push(hexDecoded);
      stringsToProcess.push(hexDecoded);
      log.debug('Detected hex encoding', { original: commandString.slice(0, 100), decoded: hexDecoded.slice(0, 100) });
    }
  }

  // Split on command chaining operators to check each segment (for all processed strings)
  for (const str of stringsToProcess) {
    for (const chainPattern of CHAINING_PATTERNS) {
      const segments = str.split(chainPattern);
      if (segments.length > 1) {
        variants.push(...segments.map(s => s.trim()).filter(s => s.length > 0));
      }
    }
  }

  // Deduplicate
  return [...new Set(variants)];
}

/**
 * Dangerous command patterns with risk levels.
 * Each entry: pattern (RegExp), risk, description, category.
 */
const DANGEROUS_PATTERNS = [
  // Filesystem — recursive force delete
  {
    pattern: /\brm\s+(-[a-z]*r[a-z]*f|--recursive\s+--force|-[a-z]*f[a-z]*r)\s+/gi,
    risk: 'high',
    description: 'Recursive force file deletion (rm -rf)',
    category: 'filesystem',
  },
  {
    pattern: /\brm\s+(-[a-z]*r[a-z]*f|--recursive\s+--force|-[a-z]*f[a-z]*r)$/gi,
    risk: 'high',
    description: 'Recursive force file deletion at end of command (rm -rf)',
    category: 'filesystem',
  },

  // Git — destructive operations
  {
    pattern: /\bgit\s+reset\s+--hard\b/gi,
    risk: 'high',
    description: 'Destructive git reset (git reset --hard)',
    category: 'git',
  },
  {
    pattern: /\bgit\s+push\s+(-[a-z]*f|--force)\b/gi,
    risk: 'medium',
    description: 'Force push to remote (git push --force)',
    category: 'git',
  },
  {
    pattern: /\bgit\s+clean\s+(-[a-z]*f[a-z]*d?|--force)\b/gi,
    risk: 'medium',
    description: 'Force clean untracked files (git clean -f)',
    category: 'git',
  },
  {
    pattern: /\bgit\s+branch\s+(-[a-z]*D|--delete\s+--force)\b/gi,
    risk: 'medium',
    description: 'Force delete git branch (git branch -D)',
    category: 'git',
  },
  {
    pattern: /\bgit\s+checkout\s+--\s*\./gi,
    risk: 'medium',
    description: 'Discard all local changes (git checkout -- .)',
    category: 'git',
  },

  // SQL — destructive operations
  {
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\s+/gi,
    risk: 'high',
    description: 'SQL drop operation (DROP TABLE/DATABASE/SCHEMA)',
    category: 'sql',
  },
  {
    pattern: /\bTRUNCATE\s+TABLE\s+/gi,
    risk: 'high',
    description: 'SQL truncate table operation (TRUNCATE TABLE)',
    category: 'sql',
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+\s*(?:WHERE\s+1\s*=\s*1|;)/gi,
    risk: 'high',
    description: 'SQL delete without proper WHERE clause',
    category: 'sql',
  },

  // Filesystem — overly permissive permissions
  {
    pattern: /\bchmod\s+(777|666)\b/gi,
    risk: 'medium',
    description: 'Setting overly permissive file permissions (chmod 777/666)',
    category: 'filesystem',
  },
  {
    pattern: /\bchmod\s+-R\s+(777|666)\b/gi,
    risk: 'medium',
    description: 'Setting overly permissive file permissions recursively (chmod -R 777/666)',
    category: 'filesystem',
  },

  // Service control — Synapse-spawned agents must not stop their supervisor
  {
    pattern: /\b(?:sudo\s+)?(?:\/usr\/bin\/|\/bin\/)?systemctl(?:\s+--[\w=.-]+)*\s+stop(?:\s+--now)?\s+synapse(?:\.service)?\b/gi,
    risk: 'high',
    description: 'Synapse service self-stop (systemctl stop synapse)',
    category: 'service-control',
  },
  {
    pattern: /\b(?:sudo\s+)?(?:\/usr\/sbin\/|\/sbin\/)?service\s+synapse\s+stop\b/gi,
    risk: 'high',
    description: 'Synapse service self-stop (service synapse stop)',
    category: 'service-control',
  },

  // Raw device operations
  {
    pattern: /\bdd\s+if=\/dev\//gi,
    risk: 'high',
    description: 'Raw device write operation (dd if=/dev/)',
    category: 'filesystem',
  },

  // Find with destructive operations
  {
    pattern: /\bfind\s+.*-exec\s+rm\b/gi,
    risk: 'high',
    description: 'Find with recursive delete (find -exec rm)',
    category: 'filesystem',
  },
];

/**
 * Risk level priority for comparison.
 */
const RISK_PRIORITY = { high: 3, medium: 2, low: 1 };

/**
 * Convert a simple allowlist glob pattern to a RegExp.
 * Supports leading and trailing * wildcards only.
 * e.g. "rm -rf ./.tmp*" matches "rm -rf ./.tmpXYZ"
 */
function allowlistPatternToRegex(pattern) {
  // Escape all regex special chars, then restore * as .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Normalise a command string for allowlist comparison.
 * Collapses internal whitespace so "rm  -rf" matches "rm -rf".
 */
function normalise(str) {
  return str.trim().replace(/\s+/g, ' ');
}

class DangerousCommandDetector {
  constructor() {
    /** @type {Array<{command?: string, pattern?: string, reason: string, projectIds: string[], agentIds: string[]}>} */
    this._allowlistEntries = [];
    /** @type {Array<{regex: RegExp, reason: string, projectIds: string[], agentIds: string[]}>} */
    this._allowlistPatterns = [];
  }

  /**
   * Load allowlist from a JSON file.
   * Safe to call multiple times — reloads each time.
   * @param {string} [allowlistPath] - absolute path; defaults to <cwd>/.synapse/dangerous-commands-allowlist.json
   */
  loadAllowlist(allowlistPath) {
    const resolved = allowlistPath || path.join(process.cwd(), '.synapse', 'dangerous-commands-allowlist.json');

    this._allowlistEntries = [];
    this._allowlistPatterns = [];

    if (!fs.existsSync(resolved)) {
      log.debug('No allowlist file found, all dangerous commands will require governance approval', { path: resolved });
      return;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (err) {
      log.warn('Failed to parse allowlist file — treating as empty', { path: resolved, error: err.message });
      return;
    }

    // Exact/glob command entries
    for (const entry of data.entries || []) {
      if (!entry.command) continue;
      this._allowlistEntries.push({
        command: normalise(entry.command),
        reason: entry.reason || '',
        projectIds: entry.projectIds || [],
        agentIds: entry.agentIds || [],
      });
    }

    // Glob pattern entries
    for (const entry of data.patterns || []) {
      if (!entry.pattern) continue;
      try {
        this._allowlistPatterns.push({
          regex: allowlistPatternToRegex(normalise(entry.pattern)),
          reason: entry.reason || '',
          projectIds: entry.projectIds || [],
          agentIds: entry.agentIds || [],
        });
      } catch (err) {
        log.warn('Invalid allowlist pattern — skipping', { pattern: entry.pattern, error: err.message });
      }
    }

    log.debug('Allowlist loaded', {
      path: resolved,
      exactEntries: this._allowlistEntries.length,
      patternEntries: this._allowlistPatterns.length,
    });
  }

  /**
   * Check whether a command string appears in the allowlist.
   * @param {string} commandString - the raw command/text to check
   * @param {Object} [context] - optional context for scoped allowlist entries
   * @param {string} [context.projectId]
   * @param {string} [context.agentId]
   * @returns {{ isAllowlisted: boolean, reason?: string }}
   */
  isAllowlisted(commandString, context = {}) {
    if (!commandString || typeof commandString !== 'string') {
      return { isAllowlisted: false };
    }

    const normalised = normalise(commandString);
    const { projectId, agentId } = context;

    const scopeMatches = (entry) => {
      if (entry.projectIds && entry.projectIds.length > 0) {
        if (!projectId || !entry.projectIds.includes(projectId)) return false;
      }
      if (entry.agentIds && entry.agentIds.length > 0) {
        if (!agentId || !entry.agentIds.includes(agentId)) return false;
      }
      return true;
    };

    // Check exact matches (substring: the allowlist command appears inside the full text)
    for (const entry of this._allowlistEntries) {
      if (!scopeMatches(entry)) continue;
      // Allow if the allowlisted command appears verbatim within the input
      if (normalised.includes(entry.command)) {
        return { isAllowlisted: true, reason: entry.reason };
      }
    }

    // Check glob patterns against entire normalised string
    for (const entry of this._allowlistPatterns) {
      if (!scopeMatches(entry)) continue;
      if (entry.regex.test(normalised)) {
        return { isAllowlisted: true, reason: entry.reason };
      }
    }

    return { isAllowlisted: false };
  }

  /**
   * Detect dangerous command patterns in text.
   * @param {string} commandString - text to scan (task description, prompt, node config, etc.)
   * @param {Object} [context] - additional context preserved in the result
   * @returns {{
   *   isDangerous: boolean,
   *   pattern: string|null,        // description of the first/highest-risk pattern detected
   *   matches: Array<Object>,      // all match details
   *   risk: 'high'|'medium'|'low'|null,
   *   recommendation: string|null,
   *   context: Object,
   *   detectedAt: string,
   *   obfuscationDetected: boolean
   * }}
   */
  detectDangerous(commandString, context = {}) {
    if (!commandString || typeof commandString !== 'string') {
      return {
        isDangerous: false,
        pattern: null,
        matches: [],
        risk: null,
        recommendation: null,
        context,
        detectedAt: new Date().toISOString(),
        obfuscationDetected: false,
      };
    }

    // Expand obfuscated commands before pattern matching
    const commandVariants = expandObfuscatedCommands(commandString);
    let obfuscationDetected = false;
    for (const obfPattern of OBFUSCATION_PATTERNS) {
      if (obfPattern.pattern.test(commandString)) {
        obfuscationDetected = true;
        break;
      }
    }
    // Also consider it obfuscated if expandObfuscatedCommands produced more than one variant
    // which typically happens with command chaining or multiple distinct obfuscations.
    if (commandVariants.length > 1) {
      obfuscationDetected = true;
    }

    if (obfuscationDetected) {
      log.warn('Command obfuscation detected — scanning all variants', {
        variantCount: commandVariants.length,
        context,
      });
    }

    const matches = [];
    const matchMap = new Map(); // Deduplicate matches, preferring obfuscated ones

    // Check all command variants against dangerous patterns
    for (const variant of commandVariants) {
      for (const patternDef of DANGEROUS_PATTERNS) {
        // Reset lastIndex — all patterns use the global flag
        patternDef.pattern.lastIndex = 0;

        let match;
        while ((match = patternDef.pattern.exec(variant)) !== null) {
          const start = Math.max(0, match.index - 50);
          const end = Math.min(variant.length, match.index + match[0].length + 50);
          const snippet = variant.slice(start, end).trim();

          // Track whether this match came from an obfuscated variant
          const isObfuscated = variant !== commandString;

          // Deduplicate: use pattern description + matched text as key
          const matchKey = `${patternDef.description}:${match[0].trim()}`;

          const matchObj = {
            pattern: patternDef.description,
            matched: match[0].trim(),
            risk: patternDef.risk,
            category: patternDef.category,
            snippet,
            position: match.index,
            obfuscated: isObfuscated,
            variant: isObfuscated ? variant : undefined,
          };

          // If we haven't seen this match, or if this is obfuscated and previous wasn't, keep this one
          const existing = matchMap.get(matchKey);
          if (!existing || (isObfuscated && !existing.obfuscated)) {
            matchMap.set(matchKey, matchObj);
          }
        }
      }
    }

    // Convert map to array
    matches.push(...matchMap.values());

    const isDangerous = matches.length > 0;

    // Highest-risk match wins for the summary fields
    let topMatch = null;
    if (isDangerous) {
      topMatch = matches.reduce((best, m) => {
        return (RISK_PRIORITY[m.risk] || 0) > (RISK_PRIORITY[best.risk] || 0) ? m : best;
      }, matches[0]);
    }

    const overallRisk = topMatch ? topMatch.risk : null;

    let recommendation = null;
    if (isDangerous) {
      if (overallRisk === 'high') {
        recommendation = 'governance_approval_required';
      } else if (overallRisk === 'medium') {
        recommendation = 'checkpoint_and_review';
      } else {
        recommendation = 'operator_notification';
      }
    }

    const result = {
      isDangerous,
      pattern: topMatch ? topMatch.pattern : null,
      matches,
      risk: overallRisk,
      recommendation,
      context,
      detectedAt: new Date().toISOString(),
      obfuscationDetected,
    };

    if (isDangerous) {
      log.warn('Dangerous command detected', {
        risk: overallRisk,
        matchCount: matches.length,
        categories: [...new Set(matches.map(m => m.category))],
        obfuscationDetected,
        obfuscatedMatches: matches.filter(m => m.obfuscated).length,
        context,
      });
    }

    return result;
  }

  /**
   * Convenience method: detect AND check allowlist in one call.
   * @param {string} commandString
   * @param {Object} [context] - context passed to both detectDangerous and isAllowlisted
   * @returns {{ isDangerous: boolean, blocked: boolean, allowlistMatch?: Object, detection: Object }}
   *   blocked = isDangerous && NOT allowlisted
   */
  checkCommand(commandString, context = {}) {
    const detection = this.detectDangerous(commandString, context);

    if (!detection.isDangerous) {
      return { isDangerous: false, blocked: false, detection };
    }

    const allowlistResult = this.isAllowlisted(commandString, context);

    return {
      isDangerous: true,
      blocked: !allowlistResult.isAllowlisted,
      allowlistMatch: allowlistResult.isAllowlisted ? allowlistResult : undefined,
      detection,
    };
  }
}

export {
  DangerousCommandDetector,
  DANGEROUS_PATTERNS,
  OBFUSCATION_PATTERNS,
  expandObfuscatedCommands,
  decodeBase64Safe,
  decodeURL,
  decodeHex,
};
export default DangerousCommandDetector;
