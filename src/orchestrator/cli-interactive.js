#!/usr/bin/env node

import { createInterface } from 'readline';
import { createLogger } from '../logger.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CLIHttpClient } from './cli-http-client.js';

const log = createLogger('cli-interactive');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Interactive CLI daemon for Synapse operator commands.
 *
 * Accepts commands:
 *   pause <agent>       - Pause an agent
 *   resume <agent>      - Resume a paused agent
 *   failover <provider> - Force provider failover
 *   weight <agent> <value> - Override routing weight (0-1)
 *   reset-cb <provider> - Reset circuit breaker for provider
 *   help                - Show this help text
 *   exit                - Exit CLI
 */

const WELCOME_BANNER = `
╔═══════════════════════════════════════════════════════╗
║       Synapse Interactive Operator CLI v1.0.0         ║
║                                                       ║
║  Control agents, providers, and routing in real-time ║
╚═══════════════════════════════════════════════════════╝
`;

const HELP_TEXT = `
Available Commands:
  pause <agent>          Pause an agent (e.g., pause alice)
  resume <agent>         Resume a paused agent (e.g., resume alice)
  approve <projectId> <campaignId> <milestoneId> [reason] Approve a paused milestone (e.g., approve P1 C1 M1 "Ready")
  failover <provider>    Force provider failover (e.g., failover ollama)
  weight <agent> <value> Override routing weight 0-1 (e.g., weight alice 0.8)
  reset-cb <provider>    Reset circuit breaker for provider (e.g., reset-cb claude)
  help                   Show this help text
  exit                   Exit the CLI

Examples:
  > pause alice
  > resume alice
  > approve P1 C1 M1 "Ready for execution"
  > failover ollama
  > weight alice 0.5
  > reset-cb claude

Valid providers: claude, codex, gemini, ollama
`;

const VALID_PROVIDERS = ['claude', 'codex', 'gemini', 'ollama'];

// ANSI color codes for terminal formatting
const COLORS = {
  RESET: '\x1b[0m',
  BRIGHT: '\x1b[1m',
  DIM: '\x1b[2m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  CYAN: '\x1b[36m',
  GRAY: '\x1b[90m',
};

/**
 * Format success message for terminal display
 * @param {string} message - Success message
 * @returns {string} Formatted message
 */
function formatSuccess(message) {
  return `${COLORS.GREEN}✓${COLORS.RESET} ${COLORS.BRIGHT}${message}${COLORS.RESET}`;
}

/**
 * Format error message for terminal display
 * @param {string} message - Error message
 * @returns {string} Formatted message
 */
function formatError(message) {
  return `${COLORS.RED}✗${COLORS.RESET} ${COLORS.BRIGHT}${message}${COLORS.RESET}`;
}

/**
 * Format info message for terminal display
 * @param {string} message - Info message
 * @returns {string} Formatted message
 */
function formatInfo(message) {
  return `${COLORS.CYAN}ℹ${COLORS.RESET} ${message}`;
}

/**
 * Format warning message for terminal display
 * @param {string} message - Warning message
 * @returns {string} Formatted message
 */
function formatWarning(message) {
  return `${COLORS.YELLOW}⚠${COLORS.RESET} ${message}`;
}

/**
 * Format API response for terminal display
 * @param {{success: boolean, status?: number, error?: string, data?: object}} response
 * @param {string} action - Action description (e.g., "Agent paused", "Weight override set")
 * @returns {string} Formatted response message
 */
function formatApiResponse(response, action) {
  if (response.success) {
    let message = formatSuccess(action);

    // Add relevant data details if available
    if (response.data) {
      if (response.data.correlationId) {
        message += `\n  ${COLORS.GRAY}Correlation ID: ${response.data.correlationId}${COLORS.RESET}`;
      }
      if (response.data.actionId) {
        message += `\n  ${COLORS.GRAY}Action ID: ${response.data.actionId}${COLORS.RESET}`;
      }
      if (response.data.expiresAt) {
        message += `\n  ${COLORS.GRAY}Expires: ${new Date(response.data.expiresAt).toLocaleString()}${COLORS.RESET}`;
      }
    }

    return message;
  } else {
    let errorMsg = response.error || 'Unknown error occurred';

    // Add helpful context for common errors
    if (response.status === 404) {
      errorMsg += '\n  Tip: Check that the API server is running and the endpoint exists';
    } else if (response.status === 503) {
      errorMsg += '\n  Tip: The service may be temporarily unavailable. Try again in a few seconds.';
    } else if (errorMsg.includes('ECONNREFUSED')) {
      errorMsg += '\n  Tip: Ensure the Synapse API server is running at the configured base URL';
    } else if (response.status >= 500) {
      errorMsg += '\n  Tip: This is a server error. Check the API logs for details.';
    }

    let message = formatError(`${action} failed`);
    message += `\n  ${COLORS.RED}${errorMsg}${COLORS.RESET}`;

    if (response.status) {
      message += `\n  ${COLORS.GRAY}HTTP Status: ${response.status}${COLORS.RESET}`;
    }

    return message;
  }
}

/**
 * InteractiveCLI - Readline-based command interface for Synapse operators
 */
export class InteractiveCLI {
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || process.env.SYNAPSE_SERVER_URL || 'http://localhost:8080';
    this.agentsJsonPath = options.agentsJsonPath || join(__dirname, '../../.synapse/agents.json');
    this.httpClient = options.httpClient || new CLIHttpClient(this.apiBaseUrl);
    this.rl = null;
    this.running = false;
    this.agentIds = null; // Lazy-loaded agent IDs cache
  }

  /**
   * Display welcome banner and help text
   */
  displayWelcome() {
    console.log(WELCOME_BANNER);
    console.log(HELP_TEXT);
  }

  /**
   * Start the interactive CLI daemon
   */
  async start() {
    if (this.running) {
      log.warn('CLI already running');
      return;
    }

    this.running = true;
    this.displayWelcome();

    // Test API connectivity
    console.log(formatInfo(`Connecting to Synapse API at ${this.apiBaseUrl}...`));
    const healthCheck = await this.httpClient.healthCheck();
    if (healthCheck.success) {
      console.log(formatSuccess('Connected to Synapse API\n'));
    } else {
      console.log(formatWarning(`Could not connect to API: ${healthCheck.error}`));
      console.log(formatInfo('Commands will be processed but may fail if API is not available\n'));
    }

    // Create readline interface
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'synapse> ',
      terminal: true,
    });

    // Handle Ctrl+C gracefully
    this.rl.on('SIGINT', () => {
      console.log('\n\nReceived Ctrl+C. Exiting gracefully...');
      this.stop();
    });

    // Handle line input
    this.rl.on('line', async (input) => {
      const trimmed = input.trim();

      if (trimmed === '') {
        this.rl.prompt();
        return;
      }

      if (trimmed === 'exit' || trimmed === 'quit') {
        this.stop();
        return;
      }

      if (trimmed === 'help') {
        console.log(HELP_TEXT);
        this.rl.prompt();
        return;
      }

      // Process command (parsing logic will be implemented in next subtask)
      await this.processCommand(trimmed);
      this.rl.prompt();
    });

    // Handle EOF (Ctrl+D)
    this.rl.on('close', () => {
      if (this.running) {
        console.log('\nGoodbye!');
        this.stop();
      }
    });

    // Display initial prompt
    this.rl.prompt();

    log.info('Interactive CLI started');
  }

  /**
   * Load and cache agent IDs from agents.json
   * @returns {string[]} Array of valid agent IDs
   */
  loadAgentIds() {
    if (this.agentIds !== null) {
      return this.agentIds;
    }

    try {
      const agentsData = JSON.parse(readFileSync(this.agentsJsonPath, 'utf-8'));
      this.agentIds = agentsData.agents.map(a => a.id);
      log.debug(`Loaded ${this.agentIds.length} agent IDs from agents.json`);
      return this.agentIds;
    } catch (error) {
      log.error('Failed to load agents.json', { error });
      throw new Error(`Failed to load agents.json: ${error.message}`);
    }
  }

  /**
   * Parse and validate a command
   * @param {string} input - Raw command string
   * @returns {{success: true, command: object} | {success: false, error: string}}
   */
  parseCommand(input) {
    const parts = input.trim().split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case 'pause':
        return this.parsePauseCommand(parts);
      case 'resume':
        return this.parseResumeCommand(parts);
      case 'failover':
        return this.parseFailoverCommand(parts);
      case 'weight':
        return this.parseWeightCommand(parts);
      case 'reset-cb':
        return this.parseResetCbCommand(parts);
      case 'approve':
        return this.parseApproveCommand(parts);
      default:
        return {
          success: false,
          error: `Unknown command: ${command}. Type 'help' for available commands.`
        };
    }
  }

  /**
   * Parse pause <agent> command
   * @param {string[]} parts - Command parts
   * @returns {{success: boolean, command?: object, error?: string}}
   */
  parsePauseCommand(parts) {
    if (parts.length !== 2) {
      return {
        success: false,
        error: 'Usage: pause <agent>. Example: pause alice'
      };
    }

    const agentId = parts[1];
    const validationError = this.validateAgent(agentId);
    if (validationError) {
      return { success: false, error: validationError };
    }

    return {
      success: true,
      command: {
        type: 'pause',
        agentId
      }
    };
  }

  /**
   * Parse resume <agent> command
   * @param {string[]} parts - Command parts
   * @returns {{success: boolean, command?: object, error?: string}}
   */
  parseResumeCommand(parts) {
    if (parts.length !== 2) {
      return {
        success: false,
        error: 'Usage: resume <agent>. Example: resume alice'
      };
    }

    const agentId = parts[1];
    const validationError = this.validateAgent(agentId);
    if (validationError) {
      return { success: false, error: validationError };
    }

    return {
      success: true,
      command: {
        type: 'resume',
        agentId
      }
    };
  }

  /**
   * Parse failover <provider> command
   * @param {string[]} parts - Command parts
   * @returns {{success: boolean, command?: object, error?: string}}
   */
  parseFailoverCommand(parts) {
    if (parts.length !== 2) {
      return {
        success: false,
        error: 'Usage: failover <provider>. Example: failover ollama'
      };
    }

    const provider = parts[1];
    const validationError = this.validateProvider(provider);
    if (validationError) {
      return { success: false, error: validationError };
    }

    return {
      success: true,
      command: {
        type: 'failover',
        provider
      }
    };
  }

  /**
   * Parse weight <agent> <value> command
   * @param {string[]} parts - Command parts
   * @returns {{success: boolean, command?: object, error?: string}}
   */
  parseWeightCommand(parts) {
    if (parts.length !== 3) {
      return {
        success: false,
        error: 'Usage: weight <agent> <value>. Example: weight alice 0.5'
      };
    }

    const agentId = parts[1];
    const weightStr = parts[2];

    const agentError = this.validateAgent(agentId);
    if (agentError) {
      return { success: false, error: agentError };
    }

    const weightError = this.validateWeight(weightStr);
    if (weightError) {
      return { success: false, error: weightError };
    }

    return {
      success: true,
      command: {
        type: 'weight',
        agentId,
        weight: parseFloat(weightStr)
      }
    };
  }

  /**
   * Parse reset-cb <provider> command
   * @param {string[]} parts - Command parts
   * @returns {{success: boolean, command?: object, error?: string}}
   */
  parseResetCbCommand(parts) {
    if (parts.length !== 2) {
      return {
        success: false,
        error: 'Usage: reset-cb <provider>. Example: reset-cb claude'
      };
    }

    const provider = parts[1];
    const validationError = this.validateProvider(provider);
    if (validationError) {
      return { success: false, error: validationError };
    }

    return {
      success: true,
      command: {
        type: 'reset-cb',
        provider
      }
    };
  }

  /**
   * Parse approve <projectId> <campaignId> <milestoneId> [reason] command
   * @param {string[]} parts - Command parts
   * @returns {{success: boolean, command?: object, error?: string}}
   */
  parseApproveCommand(parts) {
    if (parts.length < 4) {
      return {
        success: false,
        error: 'Usage: approve <projectId> <campaignId> <milestoneId> [reason]. Example: approve P1 C1 M1 "Ready for execution"'
      };
    }

    const projectId = parts[1].trim();
    const campaignId = parts[2].trim();
    const milestoneId = parts[3].trim();

    // Strip quotes from IDs if present, as split might preserve them for empty strings like '""'
    if (projectId.startsWith('"') && projectId.endsWith('"')) {
      projectId = projectId.substring(1, projectId.length - 1);
    }
    if (campaignId.startsWith('"') && campaignId.endsWith('"')) {
      campaignId = campaignId.substring(1, campaignId.length - 1);
    }
    if (milestoneId.startsWith('"') && milestoneId.endsWith('"')) {
      milestoneId = milestoneId.substring(1, milestoneId.length - 1);
    }

    if (!projectId) {
      return { success: false, error: 'Project ID is required.' };
    }
    if (!campaignId) {
      return { success: false, error: 'Campaign ID is required.' };
    }
    if (!milestoneId) {
      return { success: false, error: 'Milestone ID is required.' };
    }

    // Join remaining parts for reason, remove outer quotes if present
    let reason = parts.slice(4).join(' ').trim();
    if (reason.startsWith('"') && reason.endsWith('"')) {
      reason = reason.substring(1, reason.length - 1);
    }
    if (reason === '') {
      reason = null; // If reason is empty after trimming, set to null
    }

    return {
      success: true,
      command: {
        type: 'approve',
        projectId,
        campaignId,
        milestoneId,
        reason
      }
    };
  }

  /**
   * Validate agent ID exists in agents.json
   * @param {string} agentId - Agent ID to validate
   * @returns {string|null} Error message or null if valid
   */
  validateAgent(agentId) {
    try {
      const validAgents = this.loadAgentIds();
      if (!validAgents.includes(agentId)) {
        return `Unknown agent: ${agentId}. Valid agents: ${validAgents.join(', ')}`;
      }
      return null;
    } catch (error) {
      return `Failed to validate agent: ${error.message}`;
    }
  }

  /**
   * Validate provider is in allowed list
   * @param {string} provider - Provider name to validate
   * @returns {string|null} Error message or null if valid
   */
  validateProvider(provider) {
    if (!VALID_PROVIDERS.includes(provider)) {
      return `Unknown provider: ${provider}. Valid providers: ${VALID_PROVIDERS.join(', ')}`;
    }
    return null;
  }

  /**
   * Validate weight is a float between 0 and 1
   * @param {string} weightStr - Weight value as string
   * @returns {string|null} Error message or null if valid
   */
  validateWeight(weightStr) {
    const weight = parseFloat(weightStr);

    if (isNaN(weight)) {
      return `Invalid weight: ${weightStr}. Weight must be a number.`;
    }

    if (weight < 0 || weight > 1) {
      return `Invalid weight: ${weight}. Weight must be between 0 and 1.`;
    }

    return null;
  }

  /**
   * Process a command input
   * @param {string} input - Raw command string
   */
  async processCommand(input) {
    log.debug(`Received command: ${input}`);

    const parseResult = this.parseCommand(input);

    if (!parseResult.success) {
      console.log(formatError(parseResult.error));
      return;
    }

    const cmd = parseResult.command;

    try {
      let apiResponse;
      let actionDescription;

      switch (cmd.type) {
        case 'pause':
          actionDescription = `Agent '${cmd.agentId}' paused`;
          apiResponse = await this.httpClient.pauseAgent(cmd.agentId);
          break;

        case 'resume':
          actionDescription = `Agent '${cmd.agentId}' resumed`;
          apiResponse = await this.httpClient.resumeAgent(cmd.agentId);
          break;

        case 'failover':
          actionDescription = `Provider '${cmd.provider}' failover initiated`;
          apiResponse = await this.httpClient.failoverProvider(cmd.provider);
          break;

        case 'weight':
          actionDescription = `Routing weight set for '${cmd.agentId}' to ${cmd.weight}`;
          apiResponse = await this.httpClient.setWeightOverride(cmd.agentId, cmd.weight);
          break;

        case 'reset-cb':
          actionDescription = `Circuit breaker reset for '${cmd.provider}'`;
          apiResponse = await this.httpClient.resetCircuitBreaker(cmd.provider);
          break;

        case 'approve':
          actionDescription = `Milestone '${cmd.milestoneId}' approved`;
          apiResponse = await this.httpClient.approveMilestone(cmd.projectId, cmd.campaignId, cmd.milestoneId, cmd.reason);
          break;

        default:
          console.log(formatError(`Unknown command type: ${cmd.type}`));
          return;
      }

      // Display formatted API response
      console.log(formatApiResponse(apiResponse, actionDescription));

    } catch (error) {
      console.log(formatError(`Command execution failed: ${error.message}`));
      log.error('Command execution error', { error, input });
    }
  }

  /**
   * Stop the CLI daemon gracefully
   */
  stop() {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    log.info('Interactive CLI stopped');
    process.exit(0);
  }

  /**
   * Check if CLI is running
   */
  isRunning() {
    return this.running;
  }
}

/**
 * Main entry point when run as standalone script
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = new InteractiveCLI();

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (err) => {
    console.error(formatError(`Unexpected error: ${err.message}`));
    log.error('Uncaught exception', { error: err });
    cli.stop();
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error(formatError(`Unhandled promise rejection: ${reason}`));
    log.error('Unhandled rejection', { reason, promise });
  });

  // Start the CLI (async)
  cli.start().catch((err) => {
    console.error(formatError(`Failed to start CLI: ${err.message}`));
    log.error('Startup error', { error: err });
    process.exit(1);
  });
}
