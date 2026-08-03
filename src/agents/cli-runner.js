// cli-runner.js — Unified CLI agent runner (BYOH).
//
// One class replaces the per-CLI agent classes (claude.js, codex.js, etc.)
// by reading a harness descriptor and dispatching according to its named
// strategies. Adding a new CLI is a descriptor entry, not a new class.
//
// Architecture decision: maintainer-shipped strategies only — descriptors
// hold static values + strategy IDs, never inline code. See
// docs/byoh-harness-descriptors.md (to be written) for the full design
// and the 3-agent / 3-round deliberation that converged on it.

import { spawn } from 'child_process';
import globalConfig from '../config.js';
import { ResponseObject } from './token-parsing.js';
import { toProviderError } from '../utils/provider-error.js';
import { executeWithNetworkResilience } from './network-resilience.js';
import { resolveBinary } from './resolve-bin.js';
import { parseResponse } from './response-parsers.js';
import { readTokens } from './token-readers.js';

const STOP_GRACE_MS = globalConfig.agents.stopGraceMs;

/**
 * Build the argv array from descriptor + dispatch parameters.
 *
 * Order: [subcommand?, outputFormatArgs..., modelFlag model, maxTurnsFlag N,
 *         optionalFlags..., bypassPermissionsFlag?, chromeFlag?,
 *         cliArgs..., promptFlag message OR positional-last(message)]
 *
 * Heredoc/stdin promptMode produces argv with NO message; the runner
 * supplies the message via stdin.
 */
export function buildArgs(desc, message, model, extraCliArgs, options, harnessOptions) {
  const args = [];

  if (desc.subcommand) args.push(desc.subcommand);
  if (Array.isArray(desc.outputFormatArgs) && desc.outputFormatArgs.length > 0) {
    args.push(...desc.outputFormatArgs);
  }

  if (model && desc.modelFlag && !shouldOmitModel(desc, model)) {
    args.push(desc.modelFlag, String(model));
  }

  if (options.maxTurns != null && desc.maxTurnsFlag) {
    args.push(desc.maxTurnsFlag, String(options.maxTurns));
  }

  // Optional flags from harnessOptions (descriptor declares which keys)
  const hOpts = harnessOptions || {};
  for (const flagSpec of (desc.optionalFlags || [])) {
    const v = hOpts[flagSpec.sourceKey] ?? options[flagSpec.sourceKey];
    if (v == null || v === false || v === '') continue;
    args.push(flagSpec.flag);
    if (typeof v === 'string') args.push(v);
    else if (typeof v === 'number') args.push(String(v));
    // booleans contribute the flag alone
  }

  // Bypass permissions flag (default true, can be turned off in options)
  const bypass = options.bypassPermissions ?? hOpts.bypassPermissions ?? desc.capabilities?.supportsBypassPermissions ?? false;
  if (bypass && desc.bypassPermissionsFlag) {
    args.push(desc.bypassPermissionsFlag);
  }

  // Chrome support (claude-specific historically; descriptor-driven now)
  if ((options.chrome || hOpts.chrome) && desc.chromeFlag) {
    args.push(desc.chromeFlag);
  }

  // Operator-supplied cliArgs are last before message
  if (Array.isArray(extraCliArgs) && extraCliArgs.length > 0) {
    args.push(...extraCliArgs);
  }

  // The message itself
  if (desc.promptMode === 'flag') {
    args.push(desc.promptFlag, message);
  } else if (desc.promptMode === 'positional-last') {
    args.push(message);
  } else if (desc.promptMode === 'stdin-heredoc') {
    // No message in argv — supplied via stdin/heredoc by the spawner
  }

  return args;
}

function shouldOmitModel(desc, model) {
  // gemini emits no model flag when model is 'auto'. Extend with rules from
  // descriptor.modelFlagOmitWhen if needed.
  if (desc.modelFlagOmitWhen === 'auto' && model === 'auto') return true;
  return false;
}

/**
 * Build the environment passed to the spawn. Starts from process.env,
 * deletes anything in descriptor.envDelete, and injects baseUrl if the
 * descriptor declares a baseUrlEnv and the agent config supplies one.
 */
export function buildEnv(baseEnv, desc, agentBaseUrl) {
  const env = { ...baseEnv };
  for (const k of (desc.envDelete || [])) delete env[k];
  if (desc.baseUrlEnv && agentBaseUrl) env[desc.baseUrlEnv] = agentBaseUrl;
  return env;
}

/**
 * The unified CLI agent. Constructor signature matches the existing
 * ClaudeAgent/CodexAgent/etc. classes so the rest of Synapse doesn't need
 * to change.
 */
export class CliAgent {
  constructor(config = {}) {
    if (!config.descriptor) {
      throw new Error('CliAgent: config.descriptor is required');
    }
    this.descriptor = config.descriptor;
    this.provider = this.descriptor.identity?.providers?.[0] || this.descriptor.id;

    this.name = config.name || this.descriptor.label || this.descriptor.id;
    this.color = config.color || '#888';
    this.model = config.model || (this.descriptor.defaultModels || [])[0] || '';
    this.persona = config.persona || null;
    this.projectDir = config.projectDir || process.cwd();
    this.cliPath = config.cliPath || resolveBinary(this.descriptor.binaries, this.descriptor.knownPaths);
    this.cliArgs = config.cliArgs || [];
    this.harnessOptions = config.harnessOptions || {};
    this.baseUrl = config.baseUrl || null;
    this.apiKeyEnv = config.apiKeyEnv || null;

    this._defaultCliPath = this.cliPath;
    this._defaultCliArgs = [];
    this._defaultHarnessOptions = {};
    this.activeChildren = new Set();
    this.sandbox = null; // injected by orchestrator
    this.auditLogger = config.auditLogger || null;
    this.metricsStore = config.metricsStore || null;
  }

  async send(message, workingDir = null, options = {}) {
    const desc = this.descriptor;
    const env = buildEnv(process.env, desc, this.baseUrl);
    const args = buildArgs(desc, message, this.model, this.cliArgs, options, this.harnessOptions);
    const cliPath = this.cliPath || this._defaultCliPath;
    const dispatchId = options.dispatchId || null;
    const campaignId = options.campaignId || null;
    const useHeredoc = desc.promptMode === 'stdin-heredoc';

    // BYOH diagnostic: dump exact prompt + args to a per-dispatch file so we can
    // post-mortem why a descriptor-backed agent fails where bespoke agents succeed.
    // Keyed by descriptor id so multiple harnesses don't collide. Activated only
    // for descriptor-backed agents (CliAgent — bespoke agent classes don't import this).
    if (process.env.SYNAPSE_CLI_TRACE === '1' || process.env.SYNAPSE_CLI_TRACE === 'true') {
      try {
        const fs = await import('fs/promises');
        const path = await import('path');
        const traceDir = path.join(workingDir || this.projectDir, '..', '.synapse-cli-trace');
        try { await fs.mkdir(traceDir, { recursive: true }); } catch (_) {}
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const traceFile = path.join(traceDir, `${stamp}_${this.descriptor.id}_${this.name}.txt`);
        const body = [
          `=== descriptor: ${this.descriptor.id} | agent: ${this.name} | model: ${this.model} ===`,
          `cliPath: ${cliPath}`,
          `cwd: ${workingDir || this.projectDir}`,
          `args: ${JSON.stringify(args)}`,
          `useHeredoc: ${useHeredoc}`,
          `options: ${JSON.stringify(options)}`,
          `--- MESSAGE (length=${message.length}) ---`,
          message,
          `--- END MESSAGE ---`,
        ].join('\n');
        await fs.writeFile(traceFile, body);
        this._lastTracePath = traceFile;
      } catch (e) { /* never throw from trace */ }
    }

    return executeWithNetworkResilience(
      () => (this.sandbox
        ? this._sendSandboxedOnce(cliPath, args, message, useHeredoc, workingDir, env, options)
        : this._sendDirectOnce(cliPath, args, message, useHeredoc, workingDir, env, dispatchId, campaignId)),
      { provider: this.provider },
    );
  }

  _sendDirectOnce(cliPath, args, message, useHeredoc, workingDir, env, dispatchId, campaignId) {
    const startTime = Date.now();
    const desc = this.descriptor;

    const promise = new Promise((resolve, reject) => {
      let actualCmd = cliPath;
      let actualArgs = args;

      if (useHeredoc) {
        // opencode-style: spawn /bin/sh and pipe the message via heredoc.
        const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        const argString = [cliPath, ...args].map(shellQuote).join(' ');
        const sentinel = 'SYN_HDOC_' + Math.random().toString(36).slice(2, 12).toUpperCase();
        const shellCmd = `cat <<'${sentinel}' | ${argString}\n${message}\n${sentinel}\n`;
        actualCmd = '/bin/sh';
        actualArgs = ['-c', shellCmd];
      }

      const child = spawn(actualCmd, actualArgs, {
        cwd: workingDir || this.projectDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      this.activeChildren.add(child);

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => stdout += d);
      child.stderr.on('data', (d) => stderr += d);

      child.on('close', (code) => {
        this.activeChildren.delete(child);
        const durationMs = Date.now() - startTime;

        let parsed;
        try {
          parsed = parseResponse({ stdout, stderr }, desc);
        } catch (e) {
          this._recordLatency(dispatchId, durationMs, false, campaignId);
          this._logDispatchEvent(dispatchId, false, durationMs, `parse error: ${e.message}`, campaignId).catch(() => {});
          return reject(toProviderError(`parse error: ${e.message}`, { provider: this.provider }));
        }

        // Exit-code handling per descriptor
        const lenient = desc.exitCodeBehavior === 'lenient-if-parsed';
        if (code !== 0 && (!lenient || (!parsed.text && !parsed.error))) {
          const detail = parsed.error || stderr.trim();
          const errorMessage = detail ? `exit ${code}: ${detail}` : `exit ${code}`;
          this._recordLatency(dispatchId, durationMs, false, campaignId);
          this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
          return reject(toProviderError(errorMessage, { provider: this.provider }));
        }

        if (parsed.error && !parsed.text) {
          this._recordLatency(dispatchId, durationMs, false, campaignId);
          this._logDispatchEvent(dispatchId, false, durationMs, parsed.error, campaignId).catch(() => {});
          return reject(toProviderError(parsed.error, { provider: this.provider }));
        }

        const tokenCtx = {
          stdout, stderr,
          workingDir: workingDir || this.projectDir,
          sessionId: parsed.sessionId,
          message,
          inputText: message,
          outputText: parsed.text,
        };
        const tok = readTokens(tokenCtx, desc.tokenSource);

        this._recordLatency(dispatchId, durationMs, true, campaignId);
        this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});

        resolve(new ResponseObject({
          text: parsed.text,
          inputTokens: tok.inputTokens,
          outputTokens: tok.outputTokens,
          model: this.model,
          provider: this.provider,
          confidence: tok.confidence,
        }));
      });

      child.on('error', (err) => {
        this.activeChildren.delete(child);
        const durationMs = Date.now() - startTime;
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, `spawn error: ${err.message}`, campaignId).catch(() => {});
        reject(toProviderError(`spawn error: ${err.message}`, { provider: this.provider, errorType: 'NETWORK_ERROR' }));
      });
    });

    promise.abort = () => {
      for (const child of this.activeChildren) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already dead */ }
        const pid = child.pid;
        setTimeout(() => {
          try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL'); } catch { /* dead */ }
        }, STOP_GRACE_MS);
      }
    };

    return promise;
  }

  async _sendSandboxedOnce(cliPath, args, message, useHeredoc, workingDir, env, options) {
    // The existing sandbox.spawn API doesn't accept stdin/heredoc — for
    // sandboxed dispatch we fall back to non-heredoc spawn. opencode's
    // heredoc-via-sh path also works through the sandbox because the
    // sandbox just sees /bin/sh as the binary. So we re-shape the same way.
    let actualCmd = cliPath;
    let actualArgs = args;
    if (useHeredoc) {
      const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const argString = [cliPath, ...args].map(shellQuote).join(' ');
      const sentinel = 'SYN_HDOC_' + Math.random().toString(36).slice(2, 12).toUpperCase();
      const shellCmd = `cat <<'${sentinel}' | ${argString}\n${message}\n${sentinel}\n`;
      actualCmd = '/bin/sh';
      actualArgs = ['-c', shellCmd];
    }

    const { child, promise, abort } = this.sandbox.spawn(actualCmd, actualArgs, {
      cwd: workingDir || this.projectDir,
      env,
    }, { agent: this.name, provider: this.provider, taskId: options.taskId, kind: options.probe ? 'probe' : null, maxLifetimeMs: options.maxLifetimeMs || null });

    const dispatchId = options.dispatchId || null;
    const campaignId = options.campaignId || null;
    const startTime = Date.now();
    const desc = this.descriptor;

    if (!child) {
      const result = promise;
      result.abort = () => {};
      return result;
    }
    this.activeChildren.add(child);

    const resultPromise = promise.then(({ code, stdout, stderr }) => {
      this.activeChildren.delete(child);
      const durationMs = Date.now() - startTime;
      const outStr = stdout?.toString?.() || '';
      const errStr = stderr?.toString?.() || '';

      // BYOH diagnostic: append raw exit/stdout/stderr to the trace file paired
      // with the prompt that produced them. Lets us read prompt+response as one
      // unit when post-mortemming why a harness fails.
      if ((process.env.SYNAPSE_CLI_TRACE === '1' || process.env.SYNAPSE_CLI_TRACE === 'true') && this._lastTracePath) {
        try {
          // fire-and-forget; never block on diag
          import('fs/promises').then(fs => fs.appendFile(this._lastTracePath, [
            '',
            `--- RESULT (durationMs=${durationMs}, exit=${code}) ---`,
            `--- STDOUT (length=${outStr.length}) ---`,
            outStr,
            `--- STDERR (length=${errStr.length}) ---`,
            errStr,
            `--- END RESULT ---`,
          ].join('\n')).catch(() => {}));
        } catch (_) {}
      }

      let parsed;
      try {
        parsed = parseResponse({ stdout: outStr, stderr: errStr }, desc);
      } catch (e) {
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, `parse error: ${e.message}`, campaignId).catch(() => {});
        throw toProviderError(`parse error: ${e.message}`, { provider: this.provider });
      }

      const lenient = desc.exitCodeBehavior === 'lenient-if-parsed';
      if (code !== 0 && (!lenient || (!parsed.text && !parsed.error))) {
        const detail = parsed.error || errStr.trim();
        const errorMessage = detail ? `exit ${code}: ${detail}` : `exit ${code}`;
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, errorMessage, campaignId).catch(() => {});
        throw toProviderError(errorMessage, { provider: this.provider });
      }
      if (parsed.error && !parsed.text) {
        this._recordLatency(dispatchId, durationMs, false, campaignId);
        this._logDispatchEvent(dispatchId, false, durationMs, parsed.error, campaignId).catch(() => {});
        throw toProviderError(parsed.error, { provider: this.provider });
      }

      const tokenCtx = {
        stdout: outStr, stderr: errStr,
        workingDir: workingDir || this.projectDir,
        sessionId: parsed.sessionId,
        message,
        inputText: message,
        outputText: parsed.text,
      };
      const tok = readTokens(tokenCtx, desc.tokenSource);
      this._recordLatency(dispatchId, durationMs, true, campaignId);
      this._logDispatchEvent(dispatchId, true, durationMs, null, campaignId).catch(() => {});
      return new ResponseObject({
        text: parsed.text,
        inputTokens: tok.inputTokens,
        outputTokens: tok.outputTokens,
        model: this.model,
        provider: this.provider,
        confidence: tok.confidence,
      });
    }).catch((err) => {
      this.activeChildren.delete(child);
      const durationMs = Date.now() - startTime;
      this._recordLatency(dispatchId, durationMs, false, campaignId);
      this._logDispatchEvent(dispatchId, false, durationMs, err.message, campaignId).catch(() => {});
      throw err;
    });

    resultPromise.abort = abort;
    return resultPromise;
  }

  _recordLatency(dispatchId, durationMs, success, campaignId = null) {
    if (!this.metricsStore) return;
    try {
      this.metricsStore.recordProviderLatency({
        provider: this.provider,
        latencyMs: durationMs,
        dispatchId: dispatchId || null,
        agentId: this.name,
        campaignId: campaignId || null,
        success,
      });
    } catch { /* never throw */ }
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
          provider: this.provider,
          model: this.model,
          dispatchId: dispatchId || null,
          campaignId: campaignId || null,
          durationMs: durationMs || null,
          error: error || null,
        },
      });
    } catch { /* never throw */ }
  }

  async stop(reason = 'unknown') {
    if (this.activeChildren.size === 0) return { agent: this.name, reason, cleaned: 0, forced: 0 };
    const count = this.activeChildren.size;
    for (const child of this.activeChildren) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    await new Promise((r) => setTimeout(r, STOP_GRACE_MS));
    let forced = 0;
    for (const child of this.activeChildren) {
      try {
        process.kill(-child.pid, 0);
        process.kill(-child.pid, 'SIGKILL');
        forced++;
      } catch { /* dead */ }
    }
    this.activeChildren.clear();
    return { agent: this.name, reason, cleaned: count - forced, forced };
  }
}
