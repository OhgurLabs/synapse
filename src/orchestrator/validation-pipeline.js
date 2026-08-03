/**
 * Validation pipeline — provider-aware agent validation engine.
 *
 * Runs a 4-step validation sequence for any agent:
 * 1. CLI binary check — resolve and verify the provider's CLI is executable
 * 2. Auth check — run provider-specific auth probe
 * 3. API reachability — lightweight connectivity test
 * 4. Canary task — send trivial prompt using agent dispatch path
 *
 * Each step returns { step, status: 'pass'|'fail'|'skip', message, fixInstruction }
 * Pipeline short-circuits after CLI check failure (no point checking auth if CLI missing).
 */

import { execFileSync, spawn } from 'child_process';
import { ERROR_CATEGORIES } from './error-classifier.js';

// Provider-specific validation configuration
const PROVIDER_CHECKS = {
  claude: {
    // authCommand probes were REMOVED for all providers (2026-08-01): they
    // guessed at third-party CLI subcommands ('claude auth status',
    // 'codex auth whoami') that do not exist in the current CLIs, producing
    // false "auth failed" verdicts on working installs. Synapse plugs into
    // harnesses — it does not diagnose them; the canary dispatch is the
    // honest auth check (a real dispatch either works or it doesn't).
    cliBinary: 'claude',
    authCommand: null,
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: 'https://api.anthropic.com/v1/messages',
  },
  codex: {
    cliBinary: 'codex',
    authCommand: null,
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  },
  gemini: {
    cliBinary: 'gemini',
    authCommand: null,
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: 'https://generativelanguage.googleapis.com/v1/models',
  },
  ollama: {
    cliBinary: 'opencode', // opencode is the CLI for ollama provider
    authCommand: null, // ollama doesn't require auth - endpoint check is sufficient
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: process.env.SYNAPSE_OLLAMA_URL ? `${process.env.SYNAPSE_OLLAMA_URL.replace(/\/$/, '')}/api/tags` : 'http://localhost:11434/api/tags',
  },
  // opencode-routed agents (local llama.cpp defs, GLM via zai-coding-plan):
  // cli + canary are the meaningful checks; endpoints are user-config.
  opencode: {
    cliBinary: 'opencode',
    authCommand: null,
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: null,
  },
  glm: {
    cliBinary: 'opencode',
    authCommand: null,
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: null,
  },
  pi: {
    cliBinary: 'pi',
    authCommand: null,
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: null,
  },
  omp: {
    cliBinary: 'pi', // oh-my-pi is a Pi extension — the CLI is pi itself
    authCommand: null,
    authArgs: null,
    authSuccessPattern: null,
    apiEndpoint: null,
  },
};

/**
 * Factory function for creating validation pipeline with injected dependencies.
 * Follows the project's factory pattern (see agent-config-store.js).
 */
export function createValidationPipeline(deps) {
  const {
    agents,
    probeAgent,
    createLogger,
    // Allow injection of child_process functions for testing
    execFileSyncFn = execFileSync,
    spawnFn = spawn,
    fetchFn = globalThis.fetch,
  } = deps;
  const log = createLogger('validation-pipeline');

  /**
   * Step 1: CLI binary check
   * Resolves the provider's CLI binary via 'which' and verifies it's executable.
   *
   * @param {string} provider - Provider name (claude, codex, gemini, ollama)
   * @param {object} providerConfig - Provider config from PROVIDER_CHECKS
   * @returns {object} { step, status, message, fixInstruction }
   */
  function checkCli(provider, providerConfig) {
    const step = 'cli_binary';
    const binary = providerConfig.cliBinary;

    try {
      const binaryPath = execFileSyncFn('which', [binary], { encoding: 'utf-8' }).trim();
      if (!binaryPath) {
        return {
          step,
          status: 'fail',
          message: `CLI binary '${binary}' not found in PATH`,
          fixInstruction: `Install the ${provider} CLI tool and ensure it's in your system PATH. Verify with: which ${binary}`,
        };
      }

      return {
        step,
        status: 'pass',
        message: `CLI binary '${binary}' found at ${binaryPath}`,
        fixInstruction: null,
      };
    } catch (err) {
      return {
        step,
        status: 'fail',
        message: `CLI binary '${binary}' not found: ${err.message}`,
        fixInstruction: `Install the ${provider} CLI tool and ensure it's in your system PATH. Verify with: which ${binary}`,
      };
    }
  }

  /**
   * Step 2: Auth check
   * Runs provider-specific auth command and parses output against success pattern.
   *
   * @param {string} provider - Provider name
   * @param {object} providerConfig - Provider config from PROVIDER_CHECKS
   * @returns {Promise<object>} { step, status, message, fixInstruction }
   */
  function checkAuth(provider, providerConfig) {
    const step = 'auth';

    // No provider has an authCommand anymore — auth is exercised by the
    // canary dispatch (see PROVIDER_CHECKS comment). Kept as a step so the
    // UI timeline stays stable.
    if (!providerConfig.authCommand) {
      return Promise.resolve({
        step,
        status: 'skip',
        message: `Auth is verified by the canary dispatch (Synapse plugs into your authenticated CLI; it doesn't probe it)`,
        fixInstruction: null,
      });
    }

    return new Promise((resolve) => {
      const proc = spawnFn(providerConfig.authCommand, providerConfig.authArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        resolve({
          step,
          status: 'fail',
          message: `Auth check timed out after 5s`,
          fixInstruction: `Run '${providerConfig.authCommand} ${providerConfig.authArgs.join(' ')}' manually to diagnose auth issues`,
        });
      }, 5000);

      proc.on('close', (code) => {
        clearTimeout(timeout);

        const output = stdout + stderr;
        const isAuthenticated = providerConfig.authSuccessPattern.test(output);

        if (code !== 0 || !isAuthenticated) {
          resolve({
            step,
            status: 'fail',
            message: `Authentication check failed for ${provider}`,
            fixInstruction: `Run '${providerConfig.authCommand} login' to authenticate with ${provider}. Verify credentials are valid.`,
          });
        } else {
          resolve({
            step,
            status: 'pass',
            message: `Successfully authenticated with ${provider}`,
            fixInstruction: null,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          step,
          status: 'fail',
          message: `Failed to run auth command: ${err.message}`,
          fixInstruction: `Run '${providerConfig.authCommand} login' to authenticate with ${provider}. Verify credentials are valid.`,
        });
      });
    });
  }

  /**
   * Step 3: API reachability check
   * Performs lightweight connectivity test to provider's API endpoint with 5s timeout.
   *
   * @param {string} provider - Provider name
   * @param {object} providerConfig - Provider config from PROVIDER_CHECKS
   * @param {object} agent - Agent instance (for ollama custom endpoint)
   * @returns {Promise<object>} { step, status, message, fixInstruction }
   */
  async function checkApiReachability(provider, providerConfig, agent) {
    const step = 'api_reachability';

    // For ollama, use agent's custom endpoint if configured
    let endpoint = providerConfig.apiEndpoint;
    if (provider === 'ollama' && agent?.endpoint) {
      endpoint = `${agent.endpoint}/api/tags`;
    }

    // Providers whose endpoints are user-config (opencode/glm/pi) have no
    // global endpoint to check — the canary exercises the real path.
    if (!endpoint) {
      return {
        step,
        status: 'skip',
        message: `No global endpoint for '${provider}' — reachability is exercised by the canary dispatch`,
        fixInstruction: null,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetchFn(endpoint, {
        signal: controller.signal,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timeout);

      // For API health checks, we just care that the endpoint responds
      // Even 401/403 means the API is reachable
      if (response.status < 500) {
        return {
          step,
          status: 'pass',
          message: `API endpoint ${endpoint} is reachable (HTTP ${response.status})`,
          fixInstruction: null,
        };
      } else {
        return {
          step,
          status: 'fail',
          message: `API endpoint returned HTTP ${response.status}`,
          fixInstruction: `Check ${provider} service status and network connectivity. Endpoint: ${endpoint}`,
        };
      }
    } catch (err) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        return {
          step,
          status: 'fail',
          message: `API endpoint ${endpoint} timed out after 5s`,
          fixInstruction: `Check ${provider} service status and network connectivity. Verify endpoint: ${endpoint}`,
        };
      }

      return {
        step,
        status: 'fail',
        message: `Failed to reach API endpoint: ${err.message}`,
        fixInstruction: `Check ${provider} service status and network connectivity. Verify endpoint: ${endpoint}`,
      };
    }
  }

  /**
   * Step 4: Canary task execution
   * Sends trivial prompt using existing agent dispatch path with 30s timeout.
   * Reuses probeAgent pattern from agents.js.
   *
   * @param {string} agentId - Agent ID
   * @param {string} projectDir - Project directory for execution
   * @returns {Promise<object>} { step, status, message, fixInstruction }
   */
  async function runCanary(agentId, projectDir) {
    const step = 'canary_task';

    try {
      const result = await probeAgent(agentId, projectDir);

      if (result.ok) {
        return {
          step,
          status: 'pass',
          message: `Canary task completed successfully`,
          fixInstruction: null,
        };
      } else {
        // Timeout/SIGTERM artifacts ('Probe timed out', 'exit null') mean the
        // backend never answered — say that, not the process plumbing.
        const raw = String(result.response || '');
        const noResponse = /probe timed out|exit null/i.test(raw);
        return {
          step,
          status: 'fail',
          message: noResponse
            ? `Canary got no response before the timeout — the model backend is down, overloaded, or still loading (raw: ${raw.slice(0, 80)})`
            : `Canary task failed: ${raw}`,
          fixInstruction: noResponse
            ? `Verify the agent's model backend is running and responsive, then Retry Validation.`
            : `Agent is configured but cannot execute tasks. Check agent configuration, permissions, and sandbox settings.`,
        };
      }
    } catch (err) {
      return {
        step,
        status: 'fail',
        message: `Canary task error: ${err.message}`,
        fixInstruction: `Agent execution failed. Review agent logs and verify provider configuration.`,
      };
    }
  }

  /**
   * Main validation pipeline function.
   * Validates an agent through 4 sequential steps, short-circuiting on CLI failure.
   *
   * @param {string} agentId - Agent ID to validate
   * @param {object} options - Validation options
   * @param {boolean} options.skipCanary - If true, skip live canary task execution
   * @param {string} options.projectDir - Project directory for canary execution (defaults to agent's projectDir)
   * @returns {Promise<object>} { agentId, provider, steps: StepResult[], overallStatus: 'pass'|'fail' }
   */
  async function validateAgent(agentId, options = {}) {
    const { skipCanary = false, projectDir } = options;

    // Look up agent instance and provider from registry
    const agent = agents[agentId];
    if (!agent) {
      return {
        agentId,
        provider: null,
        steps: [{
          step: 'lookup',
          status: 'fail',
          message: `Agent '${agentId}' not found in registry`,
          fixInstruction: `Verify agent ID is correct and agent is configured in .synapse/agents.json`,
        }],
        overallStatus: 'fail',
      };
    }

    // Determine provider - check for _provider field first (used in agent instances),
    // then fall back to detecting from class name
    let provider = agent._provider || agent.provider;
    if (!provider) {
      const className = agent.constructor?.name || '';
      if (className.includes('Claude')) provider = 'claude';
      else if (className.includes('Codex')) provider = 'codex';
      else if (className.includes('Gemini')) provider = 'gemini';
      else if (className.includes('Llama')) provider = 'ollama';
    }

    if (!provider || !PROVIDER_CHECKS[provider]) {
      return {
        agentId,
        provider: provider || 'unknown',
        steps: [{
          step: 'provider_detection',
          status: 'fail',
          message: `Unknown or unsupported provider: ${provider || 'N/A'}`,
          fixInstruction: `Agent must use one of: ${Object.keys(PROVIDER_CHECKS).join(', ')}`,
        }],
        overallStatus: 'fail',
      };
    }

    const providerConfig = PROVIDER_CHECKS[provider];
    const steps = [];
    const workDir = projectDir || agent.projectDir || process.cwd();

    // Step 1: CLI binary check
    log.info('Running CLI binary check', { agentId, provider });
    const cliResult = checkCli(provider, providerConfig);
    steps.push(cliResult);

    // Short-circuit on CLI failure - remaining steps get status:'skip'
    if (cliResult.status === 'fail') {
      log.warn('CLI check failed, short-circuiting validation', { agentId, provider });

      steps.push({
        step: 'auth',
        status: 'skip',
        message: 'Skipped due to CLI check failure',
        fixInstruction: null,
      });

      steps.push({
        step: 'api_reachability',
        status: 'skip',
        message: 'Skipped due to CLI check failure',
        fixInstruction: null,
      });

      steps.push({
        step: 'canary_task',
        status: 'skip',
        message: 'Skipped due to CLI check failure',
        fixInstruction: null,
      });

      return {
        agentId,
        provider,
        steps,
        overallStatus: 'fail',
      };
    }

    // Step 2: Auth check
    log.info('Running auth check', { agentId, provider });
    const authResult = await checkAuth(provider, providerConfig);
    steps.push(authResult);

    // Step 3: API reachability check
    log.info('Running API reachability check', { agentId, provider });
    const apiResult = await checkApiReachability(provider, providerConfig, agent);
    steps.push(apiResult);

    // Step 4: Canary task (optional)
    if (skipCanary) {
      log.info('Skipping canary task (skipCanary=true)', { agentId });
      steps.push({
        step: 'canary_task',
        status: 'skip',
        message: 'Canary task skipped by request',
        fixInstruction: null,
      });
    } else {
      log.info('Running canary task', { agentId, provider });
      const canaryResult = await runCanary(agentId, workDir);
      steps.push(canaryResult);
    }

    // Determine overall status - 'pass' only if all non-skipped steps passed
    const hasFailures = steps.some(s => s.status === 'fail');
    const overallStatus = hasFailures ? 'fail' : 'pass';

    log.info('Validation complete', { agentId, provider, overallStatus });

    return {
      agentId,
      provider,
      steps,
      overallStatus,
    };
  }

  // Export public API
  return {
    validateAgent,
    // Expose step functions for testing
    checkCli,
    checkAuth,
    checkApiReachability,
    runCanary,
    // Expose PROVIDER_CHECKS for testing
    PROVIDER_CHECKS,
  };
}
