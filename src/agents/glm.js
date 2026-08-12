import { spawn } from 'child_process';
import { backendKeyFor } from '../provider-capabilities.js';
import globalConfig from '../config.js';
import { ResponseObject, estimateTokensFromText } from './token-parsing.js';
import { toProviderError } from '../utils/provider-error.js';
import { executeWithNetworkResilience } from './network-resilience.js';

const STOP_GRACE_MS = globalConfig.agents.stopGraceMs;

export function parseGlmTokens(output) {
  if (!output || typeof output !== 'string') return null;

  const usagePatterns = [
    /usage.*?input["']?\s*:\s*(\d+).*?output["']?\s*:\s*(\d+)/i,
    /input_tokens["']?\s*:\s*(\d+).*?output_tokens["']?\s*:\s*(\d+)/i,
    /prompt_tokens["']?\s*:\s*(\d+).*?completion_tokens["']?\s*:\s*(\d+)/i,
    /(\d+)\s*tokens?\s+input.*?(\d+)\s*tokens?\s+output/i,
    /Input\s+tokens?:?\s*(\d+).*?Output\s+tokens?:?\s*(\d+)/i,
    /"total_tokens"\s*:\s*(\d+).*?"prompt_tokens"\s*:\s*(\d+)/i,
  ];

  for (const pattern of usagePatterns) {
    const match = output.match(pattern);
    if (match && match[1] && match[2]) {
      return {
        inputTokens: parseInt(match[1], 10),
        outputTokens: parseInt(match[2], 10),
        confidence: 'exact',
      };
    }
  }

  return null;
}

export class GlmAgent {
  constructor(config = {}) {
    const defaults = globalConfig.agents.defaults.glm;
    this.name = config.name || 'GLM';
    this.color = config.color || defaults.color;
    this.model = config.model || defaults.model;
    this.persona = config.persona || null;
    this.projectDir = config.projectDir || process.cwd();
    this.cliPath = config.cliPath || 'opencode';
    this.cliArgs = config.cliArgs || [];
    this.harnessOptions = config.harnessOptions || {};
    this._defaultCliPath = 'opencode';
    this._defaultCliArgs = [];
    this._defaultHarnessOptions = {};
    this.activeChildren = new Set();
    this.sandbox = null;
    this.auditLogger = config.auditLogger || null;
    this.metricsStore = config.metricsStore || null;
  }

  _recordLatency(dispatchId, durationMs, success, campaignId = null) {
    if (!this.metricsStore) return;
    try {
      this.metricsStore.recordProviderLatency({
        provider: 'glm',
        latencyMs: durationMs,
        dispatchId: dispatchId || null,
        agentId: this.name,
        campaignId: campaignId || null,
        success,
      });
    } catch (err) {}
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
          provider: 'glm',
          model: this.model,
          dispatchId: dispatchId || null,
          campaignId: campaignId || null,
          durationMs: durationMs || null,
          error: error || null,
        },
      });
    } catch (err) {}
  }

  async send(message, workingDir = null, options = {}) {
    const dispatchId = options.dispatchId || null;
    const campaignId = options.campaignId || null;

    const cArgs = this.cliArgs || this._defaultCliArgs;
    const args = ['run', '-m', `zai-coding-plan/${this.model}`, ...cArgs, message];
    const cliPath = this.cliPath || this._defaultCliPath;

    return executeWithNetworkResilience(
      () => (this.sandbox
        ? this._sendSandboxedOnce(cliPath, args, workingDir, options)
        : this._sendDirectOnce(args, workingDir, dispatchId, campaignId)),
      { provider: 'glm' }
    );
  }

  _sendDirectOnce(args, workingDir, dispatchId = null, campaignId = null) {
    const startTime = Date.now();
    const promise = new Promise((resolve, reject) => {
      const child = spawn(this.cliPath || this._defaultCliPath, args, {
        cwd: workingDir || this.projectDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      this.activeChildren.add(child);

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);

      child.on('close', (code) => {
        this.activeChildren.delete(child);
        const durationMs = Date.now() - startTime;
        const out = stdout.trim() || stderr.trim();

        if (out) {
          const tokenInfo = parseGlmTokens(out);
          let result;
          if (tokenInfo && tokenInfo.inputTokens !== null && tokenInfo.outputTokens !== null) {
            result = new ResponseObject({
              text: out,
              inputTokens: tokenInfo.inputTokens,
              outputTokens: tokenInfo.outputTokens,
              model: this.model,
              provider: 'glm',
              confidence: tokenInfo.confidence,
            });
          } else {
            const estimated = estimateTokensFromText(out);
            result = new ResponseObject({
              text: out,
              inputTokens: 0,
              outputTokens: estimated,
              model: this.model,
              provider: 'glm',
              confidence: 'estimated',
            });
          }
          this._recordLatency(dispatchId, durationMs, true, campaignId);
          this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
          return resolve(result);
        }

        if (code !== 0) {
          const detail = stderr.trim();
          const errorMessage = detail ? `exit ${code}: ${detail}` : `exit ${code}`;
          this._recordLatency(dispatchId, durationMs, false, campaignId);
          this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
          return reject(toProviderError(errorMessage, { provider: 'glm' }));
        }
        this._recordLatency(dispatchId, durationMs, true, campaignId);
        this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
        resolve(out);
      });

      child.on('error', (err) => {
        this.activeChildren.delete(child);
        const durationMs = Date.now() - startTime;
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, `spawn error: ${err.message}`, campaignId).catch(() => {});
        reject(toProviderError(`spawn error: ${err.message}`, { provider: 'glm', errorType: 'NETWORK_ERROR' }));
      });
    });

    promise.abort = () => {
      for (const child of this.activeChildren) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { continue; }
        const pid = child.pid;
        setTimeout(() => {
          try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL'); } catch {}
        }, STOP_GRACE_MS);
      }
    };
    return promise;
  }

  async _sendSandboxedOnce(cmd, args, workingDir, options) {
    const { child, promise, abort } = this.sandbox.spawn(cmd, args, {
      cwd: workingDir || this.projectDir, env: process.env,
    }, { agent: this.name, provider: 'glm', backend: backendKeyFor({ provider: 'glm', model: this.model, backend: this.backend }), taskId: options.taskId });

    const dispatchId = options.dispatchId || null;
    const campaignId = options.campaignId || null;
    const startTime = Date.now();

    if (!child) {
      const result = promise;
      result.abort = () => {};
      return result;
    }
    this.activeChildren.add(child);

    const resultPromise = promise.then(({ code, stdout, stderr }) => {
      this.activeChildren.delete(child);
      const durationMs = Date.now() - startTime;
      const out = stdout.toString().trim() || stderr.toString().trim();

      if (out) {
        const tokenInfo = parseGlmTokens(out);
        if (tokenInfo && tokenInfo.inputTokens !== null && tokenInfo.outputTokens !== null) {
          this._recordLatency(dispatchId, durationMs, true, campaignId);
          this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
          return new ResponseObject({
            text: out,
            inputTokens: tokenInfo.inputTokens,
            outputTokens: tokenInfo.outputTokens,
            model: this.model,
            provider: 'glm',
            confidence: tokenInfo.confidence,
          });
        } else {
          const estimated = estimateTokensFromText(out);
          this._recordLatency(dispatchId, durationMs, true, campaignId);
          this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
          return new ResponseObject({
            text: out,
            inputTokens: 0,
            outputTokens: estimated,
            model: this.model,
            provider: 'glm',
            confidence: 'estimated',
          });
        }
      }

      if (code !== 0) {
        const detail = stderr.toString().trim();
        const errorMessage = detail ? `exit ${code}: ${detail}` : `exit ${code}`;
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
        throw toProviderError(errorMessage, { provider: 'glm' });
      }
      this._recordLatency(dispatchId, durationMs, true, campaignId);
      this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
      return out;
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

    for (const child of this.activeChildren) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (e) {}
    }

    await new Promise(r => setTimeout(r, STOP_GRACE_MS));
    let forced = 0;
    for (const child of this.activeChildren) {
      try {
        process.kill(-child.pid, 0);
        process.kill(-child.pid, 'SIGKILL');
        forced++;
      } catch (e) {}
    }
    this.activeChildren.clear();
    return { agent: this.name, reason, cleaned: count, forced };
  }
}
