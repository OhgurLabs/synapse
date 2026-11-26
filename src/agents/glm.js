import { spawn } from 'child_process';
import { backendKeyFor } from '../provider-capabilities.js';
import globalConfig from '../config.js';
import { ResponseObject, estimateTokensFromText } from './token-parsing.js';
import { toProviderError } from '../utils/provider-error.js';
import { executeWithNetworkResilience } from './network-resilience.js';
import { attachProcessAbort, terminateProcessGroup } from './process-abort.js';

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

// Rate-limit line as opencode logs it on stderr (Z.AI via ai-sdk):
//   error.error="AI_APICallError: Usage limit reached for 5 hour. Your limit will reset at 2026-08-16 03:51:58"
// plus generic 429 / Z.AI error-code shapes. Extract the human message so the
// cooldown parser (agent-interaction RATE_LIMIT_RE / parseRateLimitReset) sees it.
export const GLM_RATE_LIMIT_LINE_RE = /(?:AI_APICallError:\s*)?((?:usage|rate)\s*limit\s*(?:reached|exceeded)[^"\n]*|too many requests[^"\n]*|(?:status(?::| code)?|http)\s*429[^"\n]*|error[_ ]?code[^"\n]{0,10}130[25][^"\n]*|"code":"?130[25]"?[^"\n]*)/i;
export function extractGlmRateLimitLine(stderr) {
  const m = String(stderr || '').match(GLM_RATE_LIMIT_LINE_RE);
  return m ? m[1].trim() : null;
}
// With --print-logs stderr is diagnostics, not the answer: only stdout is the
// response. Legacy fallback: an opencode build that wrote the answer to stderr
// (no log lines present) still works.
export function glmResponseText(stdout, stderr) {
  const so = String(stdout || '').trim();
  if (so) return so;
  const se = String(stderr || '').trim();
  if (!se) return '';
  if (/^timestamp=\S+ level=|(?:^|\n)level=(?:INFO|WARN|ERROR|DEBUG)\b/m.test(se)) return '';
  return se;
}
export function glmStderrDetail(stderr) {
  const se = String(stderr || '');
  const errs = [...se.matchAll(/error\.error="([^"]{1,400})"/g)].map(x => x[1]);
  if (errs.length) return errs[errs.length - 1];
  const lines = se.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/^timestamp=\S+ level=(?:INFO|DEBUG)/.test(l));
  return lines.slice(-3).join(' | ').slice(0, 400);
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
    // --print-logs: opencode streams its internal log to STDERR (stdout stays the
    // clean model response). Without it a Z.AI 429 is swallowed by opencode's
    // silent retry loop and Synapse only ever sees a timeout — the actual text
    // ("Usage limit reached for 5 hour. Your limit will reset at …") lived only
    // in ~/.local/share/opencode/log. With it we can abort at the first limit
    // line and hand the message to the cooldown parser (audit 2026-08-16).
    this._defaultCliArgs = ['--print-logs'];
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
      () => {
        options.signal?.throwIfAborted();
        return this.sandbox
          ? this._sendSandboxedOnce(cliPath, args, workingDir, options)
          : this._sendDirectOnce(args, workingDir, dispatchId, campaignId, options.signal);
      },
      { provider: 'glm' }
    );
  }

  _sendDirectOnce(args, workingDir, dispatchId = null, campaignId = null, signal = null) {
    const startTime = Date.now();
    let runningChild;
    const promise = new Promise((resolve, reject) => {
      const child = spawn(this.cliPath || this._defaultCliPath, args, {
        cwd: workingDir || this.projectDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      runningChild = child;
      this.activeChildren.add(child);

      let stdout = '';
      let stderr = '';
      let rateLimitLine = null;
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => {
        stderr += d;
        // Abort at the FIRST provider-limit line: opencode would otherwise retry
        // with backoff and hang until our timeout, hiding the reset time.
        if (!rateLimitLine) {
          const line = extractGlmRateLimitLine(stderr);
          if (line) {
            rateLimitLine = line;
            try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
            setTimeout(() => { try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch { /* dead */ } }, 3000).unref?.();
          }
        }
      });

      child.on('close', (code) => {
        this.activeChildren.delete(child);
        const durationMs = Date.now() - startTime;
        if (rateLimitLine) {
          const errorMessage = `rate limit: ${rateLimitLine}`;
          this._recordLatency(dispatchId, durationMs, false, campaignId);
          this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
          return reject(toProviderError(errorMessage, { provider: 'glm', errorType: 'RATE_LIMIT', httpStatus: 429 }));
        }
        const out = glmResponseText(stdout, stderr);

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
          const detail = glmStderrDetail(stderr);
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

    promise.abort = () => terminateProcessGroup(runningChild, STOP_GRACE_MS);
    return attachProcessAbort(promise, signal);
  }

  async _sendSandboxedOnce(cmd, args, workingDir, options) {
    const { child, promise, abort } = this.sandbox.spawn(cmd, args, {
      cwd: workingDir || this.projectDir, env: process.env,
    }, {
      agent: this.name, agentId: options.chatAgentId, provider: 'glm',
      backend: backendKeyFor({ provider: 'glm', model: this.model, backend: this.backend }),
      taskId: options.taskId, maxLifetimeMs: options.timeoutMs,
    });

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
      const rateLimitLine = extractGlmRateLimitLine(stderr.toString());
      if (rateLimitLine) {
        const errorMessage = `rate limit: ${rateLimitLine}`;
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
        throw toProviderError(errorMessage, { provider: 'glm', errorType: 'RATE_LIMIT', httpStatus: 429 });
      }
      const out = glmResponseText(stdout.toString(), stderr.toString());

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
        const detail = glmStderrDetail(stderr.toString());
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

    return attachProcessAbort(resultPromise, options.signal, abort);
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
