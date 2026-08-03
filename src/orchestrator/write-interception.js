import { createLogger } from '../logger.js';
import { join, relative, dirname } from 'path';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { createAuditLogger, AuditLoggerMiddleware } from './audit-logger.js';

const log = createLogger('write-interception');
let auditLoggerInstance = null;
let auditMiddleware = null;

export const DEFAULT_PROTECTED_PATTERNS = [
  '**/.synapse/agents.json',
  '**/.synapse/config.json',
  '**/.synapse/auth.json',
  '**/.synapse/agents/**/persona.md',
  '**/.synapse/projects/**/config.json',
];

export class PermissionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PermissionError';
    this.details = {
      path: details.path || null,
      operation: details.operation || null,
      reason: details.reason || null,
      timestamp: new Date().toISOString(),
      ...details,
    };
  }
}

let advisoryMode = false;
let auditLogCallback = null;
let projectRoot = '';
let protectedPatterns = [...DEFAULT_PROTECTED_PATTERNS];
let blockedAttempts = [];
let auditLogPath = null;
let productionImpactThreshold = 5;
let productionImpactWindowMs = 60000;
let consecutiveBlocks = 0;
let lastBlockTime = null;

export function initWriteInterception(config = {}) {
  advisoryMode = config.advisoryMode || false;
  auditLogCallback = config.auditLogCallback || null;
  projectRoot = config.projectRoot || '';
  productionImpactThreshold = config.productionImpactThreshold || 5;
  productionImpactWindowMs = config.productionImpactWindowMs || 60000;
  
  if (config.protectedPatterns !== undefined) {
    protectedPatterns = [...config.protectedPatterns];
  } else {
    protectedPatterns = [...DEFAULT_PROTECTED_PATTERNS];
  }
  
  if (config.auditLogPath) {
    auditLogPath = config.auditLogPath;
  } else if (projectRoot) {
    auditLogPath = join(projectRoot, '.synapse', 'governance-audit.jsonl');
  }
  
  if (auditLogPath) {
    try {
      mkdirSync(dirname(auditLogPath), { recursive: true });
    } catch (err) {
      // Ignore if directory already exists or other non-critical errors
      if (err.code !== 'EEXIST') {
        log.warn('Failed to create audit log directory', { error: err.message });
      }
    }
  }

  if (config.auditLogger) {
    auditLoggerInstance = config.auditLogger;
  } else if (auditLogPath) {
    auditLoggerInstance = createAuditLogger({ logPath: auditLogPath });
    auditMiddleware = new AuditLoggerMiddleware(auditLoggerInstance);
  }
  
  log.info('Write interception initialized', { 
    advisoryMode, 
    patternCount: protectedPatterns.length,
    auditLogPath,
    productionImpactThreshold,
    auditLoggerInitialized: !!auditLoggerInstance,
  });
}

export function setAdvisoryMode(enabled) {
  const previous = advisoryMode;
  advisoryMode = !!enabled;
  log.info('Advisory mode toggled', { from: previous, to: advisoryMode });
  return advisoryMode;
}

export function getAdvisoryMode() {
  return advisoryMode;
}

export function resetProductionImpactState() {
  const previous = consecutiveBlocks;
  consecutiveBlocks = 0;
  lastBlockTime = null;
  log.info('Production impact state reset', { previousConsecutiveBlocks: previous });
  return { previous, reset: true };
}

export function getProductionImpactState() {
  return {
    consecutiveBlocks,
    lastBlockTime,
    threshold: productionImpactThreshold,
    windowMs: productionImpactWindowMs,
    advisoryMode,
  };
}

export function getBlockedAttempts() {
  return [...blockedAttempts];
}

export function clearBlockedAttempts() {
  blockedAttempts = [];
  consecutiveBlocks = 0;
  lastBlockTime = null;
}

export function queryBlockedAttempts(opts = {}) {
  const { limit = 100, agentId, taskId, campaignId, pathPattern, since } = opts;
  let results = [...blockedAttempts];
  
  if (agentId) results = results.filter(e => e.agentId === agentId);
  if (taskId) results = results.filter(e => e.taskId === taskId);
  if (campaignId) results = results.filter(e => e.campaignId === campaignId);
  if (pathPattern) {
    const regex = new RegExp(pathPattern);
    results = results.filter(e => regex.test(e.path));
  }
  if (since) {
    const sinceDate = new Date(since);
    results = results.filter(e => new Date(e.timestamp) >= sinceDate);
  }
  
  results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return results.slice(0, limit);
}

export function queryAuditLog(projectId, opts = {}) {
  if (!auditLogPath || !existsSync(auditLogPath)) return [];
  
  const { limit = 100, agentId, taskId, campaignId, since, action } = opts;
  const results = [];
  
  try {
    const content = readFileSync(auditLogPath, 'utf-8');
    const sinceDate = since ? new Date(since) : null;
    
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (agentId && entry.agentId !== agentId) continue;
        if (taskId && entry.taskId !== taskId) continue;
        if (campaignId && entry.campaignId !== campaignId) continue;
        if (sinceDate && new Date(entry.timestamp) < sinceDate) continue;
        if (action && entry.type !== action) continue;
        results.push(entry);
      } catch { /* skip corrupt lines */ }
    }
    
    results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return results.slice(0, limit);
  } catch (err) {
    log.error('Failed to query audit log', { error: err.message });
    return [];
  }
}

export function exportBlockedAttempts(format = 'json') {
  const data = {
    timestamp: new Date().toISOString(),
    advisoryMode,
    totalBlocked: blockedAttempts.length,
    consecutiveBlocks,
    attempts: blockedAttempts,
  };
  
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  } else if (format === 'csv') {
    const headers = ['timestamp', 'path', 'operation', 'reason', 'agentId', 'taskId', 'campaignId', 'blocked'];
    const rows = blockedAttempts.map(e => 
      headers.map(h => JSON.stringify(e[h] || '')).join(',')
    );
    return [headers.join(','), ...rows].join('\n');
  }
  return data;
}

export function addProtectedPattern(pattern) {
  if (!protectedPatterns.includes(pattern)) {
    protectedPatterns.push(pattern);
    log.info('Protected pattern added', { pattern });
  }
}

export function removeProtectedPattern(pattern) {
  const index = protectedPatterns.indexOf(pattern);
  if (index !== -1) {
    protectedPatterns.splice(index, 1);
    log.info('Protected pattern removed', { pattern });
  }
}

export function isProtectedPath(filePath) {
  if (!projectRoot || protectedPatterns.length === 0) return false;
  const relativePath = relative(projectRoot, filePath);
  return protectedPatterns.some(pattern => {
    // Replace ** with placeholder, then * with [^/]*, then placeholder with .*
    const regexPattern = pattern
      .replace(/\*\*/g, '\x00')  // placeholder for **
      .replace(/\*/g, '[^/]*')   // * matches anything except /
      .replace(/\x00/g, '.*');   // ** matches anything including /
    // Make leading .*/ optional for patterns starting with **/ (e.g., .*/.synapse/...)
    // This allows matching both .synapse/agents.json and subdir/.synapse/agents.json
    const match = regexPattern.match(/^(\.\*\/)/);
    const flexiblePattern = match ? '(?:' + match[1] + ')?' + regexPattern.slice(match[0].length) : regexPattern;
    const regex = new RegExp('^' + flexiblePattern + '$');
    return regex.test(relativePath);
  });
}

export function interceptWrite(filePath, operation = 'write', reason = 'governance', context = {}) {
  if (isProtectedPath(filePath)) {
    const now = Date.now();
    const timeSinceLastBlock = lastBlockTime ? (now - lastBlockTime) : Infinity;
    
    if (timeSinceLastBlock < productionImpactWindowMs) {
      consecutiveBlocks++;
    } else {
      consecutiveBlocks = 1;
    }
    lastBlockTime = now;
    
    const potentialProductionImpact = consecutiveBlocks >= productionImpactThreshold;
    
    if (potentialProductionImpact && !advisoryMode) {
      log.warn('Production impact detected, switching to advisory mode', {
        consecutiveBlocks,
        threshold: productionImpactThreshold,
        windowMs: productionImpactWindowMs,
      });
      advisoryMode = true;
    }
    
    const message = `Blocked ${operation} to protected path: ${filePath} (Reason: ${reason})`;
    const auditEvent = {
      type: 'write_blocked',
      path: filePath,
      operation,
      reason,
      advisoryMode,
      blocked: !advisoryMode,
      timestamp: new Date().toISOString(),
      agentId: context.agentId || null,
      taskId: context.taskId || null,
      subtaskId: context.subtaskId || null,
      campaignId: context.campaignId || null,
      projectId: context.projectId || null,
      traceId: context.traceId || null,
      dispatchId: context.dispatchId || null,
      productionImpactDetected: potentialProductionImpact,
      consecutiveBlocks,
    };

    blockedAttempts.push(auditEvent);
    
    if (auditLogCallback) {
      auditLogCallback(auditEvent);
    }

    if (auditMiddleware) {
      auditMiddleware.interceptWrite(
        filePath,
        operation,
        reason,
        {
          agentId: context.agentId || null,
          taskId: context.taskId || null,
          subtaskId: context.subtaskId || null,
          campaignId: context.campaignId || null,
          projectId: context.projectId || null,
          traceId: context.traceId || null,
          dispatchId: context.dispatchId || null,
          advisoryMode,
          blocked: !advisoryMode,
          productionImpactDetected: potentialProductionImpact,
          consecutiveBlocks,
        }
      );
    } else if (auditLoggerInstance) {
      auditLoggerInstance.logAction(auditEvent);
    }
    
    if (auditLogPath && !auditLoggerInstance) {
      try {
        appendFileSync(auditLogPath, JSON.stringify(auditEvent) + '\n');
      } catch (err) {
        log.error('Failed to persist audit event', { error: err.message, auditEvent });
      }
    }

    if (advisoryMode) {
      log.warn(`[ADVISORY MODE] ${message}`, { 
        agentId: context.agentId,
        productionImpactDetected: potentialProductionImpact,
      });
      return { blocked: false, advisory: true, auditEvent };
    }

    log.error(message, { agentId: context.agentId, taskId: context.taskId });
    throw new PermissionError(message, {
      path: filePath,
      operation,
      reason,
      agentId: context.agentId,
      taskId: context.taskId,
      campaignId: context.campaignId,
      projectId: context.projectId,
    });
  }
  return { blocked: false, advisory: false };
}

export function createWriteInterceptor(stateManager, options = {}) {
  const {
    projectRoot: root,
    auditLogger,
    context = {},
  } = options;

  if (root || auditLogger) {
    initWriteInterception({
      advisoryMode: options.advisoryMode || false,
      auditLogCallback: auditLogger || null,
      projectRoot: root || '',
    });
  }

  const writeMethods = new Set([
    '_saveConfig',
    '_saveProjectConfig',
    'createProject',
    'setProjectVision',
    'setProjectAllocation',
    'createChannel',
    'deleteChannel',
    'addMessage',
    'saveThreads',
    'updateThread',
    'setChannelActiveThread',
    'saveUserState',
    'saveProjectContext',
  ]);

  const handler = {
    get(target, propKey, receiver) {
      const originalMethod = target[propKey];
      if (typeof originalMethod === 'function' && writeMethods.has(propKey)) {
        return function (...args) {
          let filePath = null;
          const operation = propKey;
          const [projectId, channelId, userId, threadId] = args;

          switch (propKey) {
            case '_saveConfig':
              filePath = target.configPath;
              break;
            case '_saveProjectConfig':
            case 'createProject':
            case 'setProjectVision':
            case 'setProjectAllocation':
              filePath = join(target.projectsDir, projectId, 'config.json');
              break;
            case 'createChannel':
            case 'deleteChannel':
              filePath = join(target.projectsDir, projectId, 'channels', channelId);
              break;
            case 'addMessage':
              filePath = target._transcriptPath?.(projectId, channelId);
              break;
            case 'saveThreads':
            case 'updateThread':
              filePath = target._threadsPath?.(projectId);
              break;
            case 'setChannelActiveThread':
              filePath = userId
                ? target._userActiveThreadsPath?.(projectId, userId)
                : join(target.projectsDir, projectId, 'threads.json');
              break;
            case 'saveUserState':
              filePath = join(target._userDir?.(projectId, userId) || '', 'state.json');
              break;
            case 'saveProjectContext':
              filePath = target._contextPath?.(projectId);
              break;
          }

          if (filePath) {
            interceptWrite(filePath, operation, 'governance', context);
          }
          return originalMethod.apply(target, args);
        };
      }
      return Reflect.get(target, propKey, receiver);
    },
  };

  return new Proxy(stateManager, handler);
}

export function createDispatchInterceptor(dispatchFn, options = {}) {
  const { context = {} } = options;

  return function interceptedDispatch(...args) {
    const [task] = args;
    if (task && task.actions) {
      for (const action of task.actions) {
        if (action.type === 'write' && action.path) {
          interceptWrite(action.path, action.type || 'write', action.reason || 'task_execution', context);
        }
      }
    }
    return dispatchFn.apply(this, args);
  };
}

export function getAuditLogger() {
  return auditLoggerInstance;
}

export function getAuditMiddleware() {
  return auditMiddleware;
}

export { createAuditLogger, AuditLoggerMiddleware } from './audit-logger.js';
