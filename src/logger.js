// src/logger.js

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LOG_LEVEL = 'info';

function getConfiguredLevel() {
  return LOG_LEVELS[process.env.SYNAPSE_LOG_LEVEL?.toLowerCase()] || LOG_LEVELS[DEFAULT_LOG_LEVEL];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fileHandle = null;
let currentFileSize = 0;

function getLogConfig() {
  return {
    enabled: process.env.SYNAPSE_LOG_FILE_ENABLED !== 'false',
    directory: process.env.SYNAPSE_LOG_FILE_DIR || path.join(process.cwd(), '.synapse', 'logs'),
    filename: process.env.SYNAPSE_LOG_FILE_NAME || 'synapse.log',
    maxSizeBytes: parseInt(process.env.SYNAPSE_LOG_FILE_MAX_SIZE || '10485760', 10),
    maxFiles: parseInt(process.env.SYNAPSE_LOG_FILE_MAX_FILES || '5', 10),
    outputTargets: (process.env.SYNAPSE_LOG_OUTPUT_TARGETS || 'console,file').split(',').map(t => t.trim()),
  };
}

// Credential patterns to redact from all log output.
// Ordered from most-specific to least-specific to avoid partial matches.
const REDACT_PATTERNS = [
  /sk-ant-[a-zA-Z0-9\-_]{20,}/g,          // Anthropic API keys
  /sk-proj-[a-zA-Z0-9\-_]{20,}/g,         // OpenAI project keys
  /sk-[a-zA-Z0-9]{40,}/g,                 // OpenAI legacy keys
  /AIza[a-zA-Z0-9\-_]{35}/g,             // Google API keys
  /xox[bpoa]-[a-zA-Z0-9\-]{10,}/g,       // Slack tokens (bot/person/oauth/app)
  /gh[pousr]_[a-zA-Z0-9]{36,}/g,         // GitHub tokens
  /Bearer\s+[a-zA-Z0-9\-_.~+/]+=*/g,     // Generic Bearer tokens
];

function redactString(s) {
  return REDACT_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), s);
}

function redactSensitive(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSensitive(v);
    return out;
  }
  return value;
}

async function ensureLogDirectory() {
  const config = getLogConfig();
  try {
    await fs.mkdir(config.directory, { recursive: true });
  } catch (err) {
    console.error(`[logger] Failed to create log directory ${config.directory}: ${err.message}`);
  }
}

async function rotateLogs() {
  const config = getLogConfig();
  if (!config.enabled) return;

  const logPath = path.join(config.directory, config.filename);
  
  for (let i = config.maxFiles - 1; i >= 1; i--) {
    const oldPath = `${logPath}.${i}`;
    const newPath = `${logPath}.${i + 1}`;
    try {
      await fs.rename(oldPath, newPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[logger] Failed to rotate log file ${oldPath}: ${err.message}`);
      }
    }
  }

  try {
    await fs.rename(logPath, `${logPath}.1`);
    currentFileSize = 0;
    if (fileHandle) {
      await fileHandle.close();
      fileHandle = null;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[logger] Failed to rotate log file: ${err.message}`);
    }
  }
}

async function writeToFile(logEntry) {
  const config = getLogConfig();
  if (!config.enabled) return;

  await ensureLogDirectory();

  const logPath = path.join(config.directory, config.filename);
  const line = JSON.stringify(logEntry) + '\n';
  const lineBytes = Buffer.byteLength(line, 'utf8');

  if (currentFileSize + lineBytes > config.maxSizeBytes) {
    await rotateLogs();
  }

  if (!fileHandle) {
    try {
      fileHandle = await fs.open(logPath, 'a');
    } catch (err) {
      console.error(`[logger] Failed to open log file ${logPath}: ${err.message}`);
      return;
    }
  }

  try {
    await fileHandle.write(line);
    currentFileSize += lineBytes;
  } catch (err) {
    console.error(`[logger] Failed to write to log file: ${err.message}`);
    if (fileHandle) {
      await fileHandle.close();
      fileHandle = null;
    }
  }
}

/**
 * Logs a message with structured JSON output to configured targets.
 * All string values are scrubbed for known credential patterns before output.
 * @param {string} level - The log level (e.g., 'debug', 'info', 'warn', 'error').
 * @param {string} module - The module tag for the log entry (e.g., 'webhooks', 'lifecycle').
 * @param {string} message - The main log message.
 * @param {object} [data={}] - Additional data to include in the log entry.
 */
async function log(level, module, message, data = {}) {
  if (LOG_LEVELS[level] < getConfiguredLevel()) {
    return;
  }

  const logEntry = redactSensitive({
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    module: module,
    message: message,
    ...data,
  });

  const config = getLogConfig();
  const line = JSON.stringify(logEntry) + '\n';

  if (config.outputTargets.includes('console')) {
    process.stdout.write(line);
  }

  if (config.outputTargets.includes('file')) {
    await writeToFile(logEntry);
  }
}

/**
 * Creates a logger instance for a specific module.
 * @param {string} module - The name of the module (e.g., 'webhooks', 'lifecycle').
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
export { redactSensitive };

export async function shutdownLogger() {
  if (fileHandle) {
    try {
      await fileHandle.close();
      fileHandle = null;
    } catch (err) {
      console.error(`[logger] Failed to close log file: ${err.message}`);
    }
  }
}

/**
 * Normalize logger call args to Synapse's convention `(message: string, data: object)`.
 *
 * 527+ call sites in src/mcp/, src/registry/, and src/orchestrator/ accidentally
 * use the pino convention `(meta: object, message: string)`. Without this
 * normalizer, the string slot gets serialized as an iterable — producing
 * char-by-char output like `{"0":"F","1":"a","2":"i",...}` for what should
 * have been "Failed to connect". The logger now detects either calling style
 * and forwards a consistent `(string, object)` pair to `log()`.
 *
 * Detection: if arg1 is non-null object AND arg2 is string, it's pino-style.
 * Anything else falls through to the documented `(message, data)` convention.
 */
function normalizeArgs(a, b) {
  if (a && typeof a === 'object' && !Array.isArray(a) && typeof b === 'string') {
    return [b, a];
  }
  return [a, b];
}

export function createLogger(module) {
  return {
    debug: (a, b) => { const [m, d] = normalizeArgs(a, b); return log('debug', module, m, d); },
    info:  (a, b) => { const [m, d] = normalizeArgs(a, b); return log('info',  module, m, d); },
    warn:  (a, b) => { const [m, d] = normalizeArgs(a, b); return log('warn',  module, m, d); },
    error: (a, b) => { const [m, d] = normalizeArgs(a, b); return log('error', module, m, d); },
  };
}

