import { spawn } from 'child_process';
import { backendKeyFor } from '../provider-capabilities.js';
import globalConfig from '../config.js';
import { guardedFetch } from '../guarded-fetch.js';

const STOP_GRACE_MS = globalConfig.agents.stopGraceMs;

export class LlamaAgent {
  constructor(config = {}) {
    const defaults = globalConfig.agents.defaults.ollama;
    this.name = config.name || 'Ollama';
    this.color = config.color || defaults.color;
    this.model = config.model || defaults.model;
    this.persona = config.persona || null;
    this.projectDir = config.projectDir || process.cwd();
    this.endpoint = config.endpoint || process.env.OLLAMA_HOST || null;
    if (!this.endpoint) throw new Error(`Agent "${this.name}" (ollama) requires an endpoint. Set OLLAMA_HOST in .env or pass endpoint in agent config. (Any OpenAI-compatible server works — llama.cpp, vLLM, LM Studio, the Ollama daemon; OLLAMA_HOST is the legacy name of the variable, not a requirement to run Ollama.)`);
    // opencode provider prefix — corresponds to a named provider in opencode.json
    this.opencodeProvider = config.opencodeProvider || 'ollama-local';
    this.cliPath = config.cliPath || 'opencode';
    this.cliArgs = config.cliArgs || [];
    this.harnessOptions = config.harnessOptions || {};
    this._defaultCliPath = 'opencode';
    this._defaultCliArgs = [];
    this._defaultHarnessOptions = {};
    this.activeChildren = new Set();
    this.sandbox = null; // injected by orchestrator
    this.auditLogger = config.auditLogger || null;
    this.metricsStore = config.metricsStore || null;
    this._healthy = null; // null = unknown, true/false = cached
    this._healthCheckedAt = 0;
  }

  _recordLatency(dispatchId, durationMs, success, campaignId = null) {
    if (!this.metricsStore) return;
    try {
      this.metricsStore.recordProviderLatency({
        provider: 'llama',
        latencyMs: durationMs,
        dispatchId: dispatchId || null,
        agentId: this.name,
        campaignId: campaignId || null,
        success,
      });
    } catch (err) {
      // Never throw from metrics recording
    }
  }

  async _logDispatchEvent(dispatchId, success, durationMs, error = null, campaignId = null) {
    if (!this.auditLogger) return;

    try {
      await this.auditLogger.logAction({
        traceId: dispatchId || null,
        agentId: this.name,
        actionType: 'provider_dispatch',
        inputSummary: `Provider dispatch to ${this.model}`,
        outputSummary: success ? 'dispatch completed' : (error || 'dispatch failed'),
        outcome: success ? 'success' : 'failure',
        contextMetadata: {
          provider: 'llama',
          model: this.model,
          dispatchId: dispatchId || null,
          campaignId: campaignId || null,
          durationMs: durationMs || null,
          error: error || null,
        },
      });
    } catch (err) {
      // Never throw from audit logging
    }
  }

  async _checkHealth() {
    const check = async (path) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await guardedFetch(`${this.endpoint}${path}`, { signal: controller.signal });
        return res.ok;
      } finally {
        clearTimeout(timeout);
      }
    };

    try {
      // Try lightweight /health endpoint first (doesn't consume inference slot)
      // Fall back to /api/tags or /v1/models for compatibility
      this._healthy = await check('/health') || await check('/api/tags') || await check('/v1/models');
      this._healthCheckedAt = Date.now();
      return this._healthy;
    } catch (e) {
      this._healthy = false;
      this._healthCheckedAt = Date.now();
      return false;
    }
  }

  async send(message, workingDir = null, options = {}) {
    const dispatchId = options.dispatchId || null;
    const campaignId = options.campaignId || null;
    const startTime = Date.now();

    // Health check: on first call, after failure, or if cache expired (60s TTL)
    const HEALTH_TTL_MS = 60000;
    if (this._healthy !== true || (Date.now() - this._healthCheckedAt > HEALTH_TTL_MS)) {
      const ok = await this._checkHealth();
      if (!ok) {
        const durationMs = Date.now() - startTime;
        this._logDispatchEvent(dispatchId, false, durationMs, 'llama.cpp unavailable (health check failed)', campaignId).catch(() => {});
        throw new Error('llama.cpp unavailable (health check failed)');
      }
    }

    // Use opencode run with the ollama-local provider for full tool use.
    // Unlike Claude/Gemini/Codex CLIs, opencode does not expose a per-run
    // sandbox/approval "yolo" flag here, so Synapse's ProcessSandbox remains the
    // authoritative sandbox layer for local llama agents.
    const modelId = `${this.opencodeProvider}/${this.model}`;
    const args = ['run', '--auto', '-m', modelId];
    const cArgs = this.cliArgs || this._defaultCliArgs;
    args.push(...cArgs);
    const cliPath = this.cliPath || this._defaultCliPath;

    // Use sandbox if available, otherwise direct spawn
    if (this.sandbox) {
      return this._sendSandboxed(cliPath, args, workingDir, options, dispatchId, campaignId, startTime, message);
    }

    const promise = new Promise((resolve, reject) => {
      const child = spawn(this.cliPath || this._defaultCliPath, args, {
        cwd: workingDir || this.projectDir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      child.stdin.write(message);
      child.stdin.end();
      this.activeChildren.add(child);

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);

      child.on('close', (code) => {
        this.activeChildren.delete(child);
        const durationMs = Date.now() - startTime;
        // opencode run outputs the agent's final text to stdout
        // Strip ANSI escape codes and tool-use log lines (prefixed with |)
        const cleaned = this._cleanOutput(stdout);
        if (cleaned) {
          this._recordLatency(dispatchId, durationMs, true, campaignId);
          this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
          return resolve(cleaned);
        }
        if (code !== 0) {
          const detail = stderr.trim() ? `\nstderr: ${stderr.trim().slice(0, 500)}` : '';
          const errorMessage = `llama.cpp/opencode error: exit ${code}${detail}`;
          this._recordLatency(dispatchId, durationMs, false, campaignId);
          this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
          return reject(new Error(errorMessage));
        }
        this._recordLatency(dispatchId, durationMs, true, campaignId);
        this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
        resolve(cleaned);
      });

      child.on('error', (err) => {
        this.activeChildren.delete(child);
        const durationMs = Date.now() - startTime;
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, `llama.cpp/opencode spawn error: ${err.message}`, campaignId).catch(() => {});
        reject(new Error(`llama.cpp/opencode spawn error: ${err.message}`));
      });
    });

    promise.abort = () => {
      for (const child of this.activeChildren) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* already dead */ continue; }
        // SIGKILL fallback after grace period
        const pid = child.pid;
        setTimeout(() => {
          try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL'); } catch { /* dead */ }
        }, STOP_GRACE_MS);
      }
    };
    return promise;
  }

  async _sendSandboxed(cmd, args, workingDir, options, dispatchId = null, campaignId = null, startTime = Date.now(), stdinMessage = null) {
    const { child, promise, abort } = this.sandbox.spawn(cmd, args, {
      cwd: workingDir || this.projectDir, env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }, { agent: this.name, provider: 'ollama', backend: backendKeyFor({ provider: 'ollama', model: this.model, backend: this.backend }), taskId: options.taskId });

    if (child && child.stdin && stdinMessage) {
      child.stdin.write(stdinMessage);
      child.stdin.end();
    }

    if (!child) {
      const result = promise;
      result.abort = () => {};
      return result;
    }
    this.activeChildren.add(child);

    const resultPromise = promise.then(({ code, stdout, stderr }) => {
      this.activeChildren.delete(child);
      const durationMs = Date.now() - startTime;
      const cleaned = this._cleanOutput(stdout.toString());
      if (cleaned) {
        this._recordLatency(dispatchId, durationMs, true, campaignId);
        this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
        return cleaned;
      }
      if (code !== 0) {
        const detail = stderr.toString().trim();
        const errorMessage = `llama.cpp/opencode error: exit ${code}${detail ? `\nstderr: ${detail.slice(0, 500)}` : ''}`;
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
        throw new Error(errorMessage);
      }
      this._recordLatency(dispatchId, durationMs, true, campaignId);
      this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
      return cleaned;
    }).catch(err => {
      this.activeChildren.delete(child);
      const durationMs = Date.now() - startTime;
      this._recordLatency(dispatchId, durationMs, false, campaignId);
      this._logDispatchEvent(dispatchId, false, durationMs, err.message, campaignId).catch(() => {});
      throw err;
    });

    resultPromise.abort = abort;
    return resultPromise;
  }

  async stop(reason = 'unknown') {
    if (this.activeChildren.size === 0) return { agent: this.name, reason, cleaned: 0, forced: 0 };
    const count = this.activeChildren.size;

    // Phase 1: SIGTERM the process groups
    for (const child of this.activeChildren) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { /* already dead */ }
    }

    // Phase 2: Wait grace period, then SIGKILL survivors
    await new Promise(r => setTimeout(r, STOP_GRACE_MS));
    let forced = 0;
    for (const child of this.activeChildren) {
      try {
        process.kill(-child.pid, 0); // check if still alive
        process.kill(-child.pid, 'SIGKILL');
        forced++;
      } catch (e) { /* already dead */ }
    }
    this.activeChildren.clear();
    this._healthy = null;
    return { agent: this.name, reason, cleaned: count, forced };
  }

  _cleanOutput(raw) {
    // Strip ANSI escape codes
    const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
    // opencode run outputs tool-use log lines prefixed with "| " — filter those
    const lines = stripped.split('\n');
    const content = lines.filter(line => {
      const trimmed = line.trim();
      // Skip tool-use indicator lines (e.g., "| Read     package.json")
      if (trimmed.startsWith('|')) return false;
      // Skip empty lines at start/end (we'll trim later)
      return true;
    });
    return content.join('\n').trim();
  }
}
