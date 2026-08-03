/**
 * memory-writeback-extractors.js
 *
 * Extract memory candidates from agent outputs, task completions, and failures.
 */

import { createLogger } from '../logger.js';

const log = createLogger('memory-writeback-extractors');

function normalizeSubtaskResults(subtaskResults) {
  if (!Array.isArray(subtaskResults)) return [];
  return subtaskResults
    .filter(Boolean)
    .map((st) => ({
      id: st.id || st.subtaskId || null,
      status: st.status,
      assignee: st.assignee || st.agentId || null,
      text: st.text || st.summary || null,
      result: st.result || st.output || null,
      error: st.error || null,
    }));
}

function summarizeHighlights(subtasks) {
  const highlights = [];
  for (const st of subtasks) {
    if (st.result) {
      highlights.push(st.result);
    } else if (st.text) {
      highlights.push(st.text.slice(0, 160));
    } else if (st.error) {
      highlights.push(st.error);
    }
    if (highlights.length >= 3) break;
  }
  return highlights;
}

/**
 * Build an experience memory entry from a successfully completed task.
 *
 * @param {string} taskId
 * @param {string} agentId
 * @param {string} taskTitle
 * @param {Array<object>} subtaskResults
 * @returns {Array<{agentId: string, category: string, content: string, source: object, tags: string[], confidence?: number}>}
 */
export function extractFromTaskCompletion(taskId, agentId, taskTitle, subtaskResults = []) {
  if (!taskId || !agentId) {
    log.warn('extractFromTaskCompletion missing taskId/agentId');
    return [];
  }

  const normalized = normalizeSubtaskResults(subtaskResults);
  const successes = normalized.filter(st => st.status === 'done' || st.status === 'completed' || st.status === 'success');
  const failures = normalized.filter(st => st.status === 'failed');

  const total = normalized.length;
  const successCount = successes.length;
  const failedCount = failures.length;
  const highlights = summarizeHighlights(successes.length ? successes : normalized);

  let content = taskTitle ? `Completed task "${taskTitle}"` : `Completed task ${taskId}`;
  content += ` (${successCount}/${total} subtasks succeeded, ${failedCount} failed)`;
  
  if (highlights.length > 0) {
    content += `. Highlights: ${highlights.join(' | ')}`;
  }

  const source = {
    taskId,
    agentId,
    taskTitle: taskTitle || null,
    successCount,
    failedCount,
    totalSubtasks: total,
    failedSubtasks: failures.map(st => st.id || st.text || st.error).filter(Boolean),
  };

  const tags = ['task'];
  if (successCount > 0) {
    tags.push('success');
  } else if (failedCount > 0) {
    tags.push('failure');
  }

  return [
    {
      agentId,
      category: 'experience',
      content,
      source,
      tags,
      confidence: 0.8,
    },
  ];
}
const VALID_CATEGORIES = new Set(['expertise', 'experience', 'preference']);

function normalizeErrorMessage(errorMessage) {
  if (typeof errorMessage === 'string') return errorMessage.trim();
  if (errorMessage === null || errorMessage === undefined) return '';
  return String(errorMessage).trim();
}

function normalizeFailureContext(failureContext) {
  if (!failureContext) return {};
  if (typeof failureContext !== 'object' || Array.isArray(failureContext)) {
    return { failureContext };
  }
  return { ...failureContext };
}

function buildFailureContent(errorMessage, failureContext) {
  if (!failureContext || typeof failureContext !== 'object') {
    return `Encountered error: ${errorMessage}`;
  }

  const contextBits = [];
  if (failureContext.subtaskText) {
    contextBits.push(`while working on "${failureContext.subtaskText}"`);
  } else if (failureContext.taskTitle) {
    contextBits.push(`while working on "${failureContext.taskTitle}"`);
  } else if (failureContext.step) {
    contextBits.push(`during step "${failureContext.step}"`);
  }

  if (contextBits.length > 0) {
    return `Encountered error ${contextBits.join(' ')}: ${errorMessage}`;
  }
  return `Encountered error: ${errorMessage}`;
}

function normalizeWhitespace(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeQuotedString(token) {
  const trimmed = normalizeWhitespace(token);
  if (trimmed.length < 2) return trimmed;

  const quote = trimmed[0];
  const endQuote = trimmed[trimmed.length - 1];
  if ((quote !== '"' && quote !== '\'' && quote !== '`') || quote !== endQuote) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(trimmed);
    } catch {
      return inner.replace(/\\"/g, '"');
    }
  }

  const escapedQuote = new RegExp(`\\\\${quote}`, 'g');
  return inner
    .replace(escapedQuote, quote)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

function normalizeCategory(value) {
  const normalized = decodeQuotedString(String(value ?? '')).trim().toLowerCase();
  return VALID_CATEGORIES.has(normalized) ? normalized : null;
}

function normalizeContent(value) {
  const content = decodeQuotedString(String(value ?? '')).trim();
  return content || null;
}

function splitTopLevel(input, delimiter = ',') {
  const parts = [];
  let current = '';
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote = null;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quote) {
      current += char;
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') depthParen++;
    else if (char === ')') depthParen = Math.max(0, depthParen - 1);
    else if (char === '[') depthBracket++;
    else if (char === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (char === '{') depthBrace++;
    else if (char === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (
      char === delimiter &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0
    ) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function parseTagArray(rawValue) {
  const trimmed = normalizeWhitespace(rawValue);
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return trimmed ? [trimmed] : [];
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner);
}

function normalizeTags(value) {
  if (!value) return [];

  const rawTags = Array.isArray(value)
    ? value
    : parseTagArray(String(value));

  const seen = new Set();
  const normalized = [];

  for (const rawTag of rawTags) {
    const tag = decodeQuotedString(String(rawTag ?? '')).trim();
    if (!tag) continue;
    const dedupKey = tag.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    normalized.push(tag);
  }

  return normalized;
}

function buildExplicitCandidate(agentId, input, format, position, fallbackConfidence = 1) {
  const category = normalizeCategory(input.category);
  const content = normalizeContent(input.content);
  if (!category || !content) return null;

  const confidence = typeof input.confidence === 'number'
    ? Math.max(0, Math.min(1, input.confidence))
    : fallbackConfidence;

  return {
    agentId,
    category,
    content,
    source: {
      type: 'explicit_memory_save',
      format,
      command: 'memory.save',
      position,
    },
    tags: normalizeTags(input.tags),
    confidence,
  };
}

function extractCallExpression(text, startIndex) {
  const openParenIndex = text.indexOf('(', startIndex);
  if (openParenIndex === -1) return null;

  let depth = 1;
  let quote = null;
  let escape = false;

  for (let i = openParenIndex + 1; i < text.length; i++) {
    const char = text[i];

    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth--;
      if (depth === 0) {
        return {
          argsText: text.slice(openParenIndex + 1, i),
          endIndex: i,
        };
      }
    }
  }

  return null;
}

function parseObjectLikeArgument(rawText) {
  const trimmed = normalizeWhitespace(rawText);
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseMemorySaveCall(agentId, argsText, position) {
  const args = splitTopLevel(argsText);
  if (args.length === 0) return null;

  if (args.length === 1) {
    const structuredArg = parseObjectLikeArgument(args[0]);
    if (!structuredArg) return null;
    return buildExplicitCandidate(agentId, structuredArg, 'function_call', position);
  }

  return buildExplicitCandidate(
    agentId,
    {
      category: args[0],
      content: args[1],
      tags: args[2],
    },
    'function_call',
    position
  );
}

function* iterateFunctionCalls(agentOutput) {
  const marker = 'memory.save(';
  let searchIndex = 0;

  while (searchIndex < agentOutput.length) {
    const startIndex = agentOutput.indexOf(marker, searchIndex);
    if (startIndex === -1) {
      return;
    }

    const extracted = extractCallExpression(agentOutput, startIndex + marker.length - 1);
    if (!extracted) {
      searchIndex = startIndex + marker.length;
      continue;
    }

    yield {
      startIndex,
      argsText: extracted.argsText,
      endIndex: extracted.endIndex,
    };
    searchIndex = extracted.endIndex + 1;
  }
}

function normalizeStructuredPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.memories)) return payload.memories;
  if (Array.isArray(payload.memorySave)) return payload.memorySave;
  if (Array.isArray(payload.memory_save)) return payload.memory_save;
  if (payload.memory && typeof payload.memory === 'object') return [payload.memory];
  if (payload.command === 'memory.save' && payload.arguments && typeof payload.arguments === 'object') {
    return [payload.arguments];
  }
  if ('category' in payload && 'content' in payload) return [payload];
  return [];
}

function extractJsonBlockCandidates(agentOutput, agentId) {
  const candidates = [];
  const fencePattern = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let match;

  while ((match = fencePattern.exec(agentOutput)) !== null) {
    const block = match[1].trim();
    if (!block) continue;

    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }

    const entries = normalizeStructuredPayload(parsed);
    for (const entry of entries) {
      const candidate = buildExplicitCandidate(agentId, entry, 'json_block', match.index, 1);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

/**
 * Extract explicit memory candidates from agent output.
 *
 * Supports `memory.save(category, "content", [tags])` calls and fenced JSON blocks.
 *
 * @param {string} agentOutput
 * @param {string} agentId
 * @returns {Array<{agentId: string, category: string, content: string, source: object, tags: string[], confidence: number}>}
 */
export function parseExplicitMemoryCommands(agentOutput, agentId) {
  if (typeof agentOutput !== 'string' || agentOutput.trim() === '') return [];
  if (typeof agentId !== 'string' || agentId.trim() === '') return [];

  const candidates = [];

  for (const call of iterateFunctionCalls(agentOutput)) {
    const candidate = parseMemorySaveCall(agentId, call.argsText, call.startIndex);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.push(...extractJsonBlockCandidates(agentOutput, agentId));
  return candidates;
}

/**
 * Extract error patterns from task failures into memory candidates.
 *
 * @param {string} taskId
 * @param {string} agentId
 * @param {string} errorMessage
 * @param {object} [failureContext]
 * @returns {Array<{agentId: string, category: string, content: string, source: object, tags: string[], confidence: number}>}
 */
export function extractFromTaskFailure(taskId, agentId, errorMessage, failureContext = {}) {
  if (!taskId || !agentId) {
    log.warn('extractFromTaskFailure missing taskId/agentId');
    return [];
  }

  const normalizedError = normalizeErrorMessage(errorMessage);
  if (!normalizedError) {
    log.warn('extractFromTaskFailure missing errorMessage', { taskId, agentId });
    return [];
  }

  const normalizedContext = normalizeFailureContext(failureContext);
  const content = buildFailureContent(normalizedError, normalizedContext);

  const source = {
    taskId,
    agentId,
    errorMessage: normalizedError,
    ...normalizedContext,
  };

  return [
    {
      agentId,
      category: 'experience',
      content,
      source,
      tags: ['error', 'failure'],
      confidence: 0.3,
    },
  ];
}
