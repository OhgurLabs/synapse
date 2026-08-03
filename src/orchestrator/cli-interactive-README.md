# Interactive CLI Daemon

## Overview

The Interactive CLI daemon (`cli-interactive.js`) provides a readline-based command interface for Synapse operators to control agents, providers, and routing in real-time.

## Features

### Implemented (Subtask 1)
- ✅ Readline-based interactive interface
- ✅ Welcome banner and help text on startup
- ✅ Command loop accepting multiple commands per session
- ✅ Graceful exit handling (exit command, Ctrl+D, Ctrl+C)
- ✅ Empty line handling (no crash on whitespace)
- ✅ Configurable API base URL and agents.json path
- ✅ Error handling for uncaught exceptions

### Implemented (Subtask 2)
- ✅ Command parser with validation logic
- ✅ Parse 5 command types (pause, resume, failover, weight, reset-cb)
- ✅ Validate agent exists by reading `.synapse/agents.json`
- ✅ Validate provider is in ['claude','codex','gemini','ollama']
- ✅ Validate weight is 0-1 float
- ✅ Return structured command object or error with reason
- ✅ Unit tests with 17 test cases (all passing)

### Implemented (Subtask 3)
- ✅ HTTP client module (`cli-http-client.js`)
- ✅ API calls for all 5 command types
- ✅ Correlation ID and Action ID generation
- ✅ Error handling and response parsing
- ✅ Health check endpoint support

### Implemented (Subtask 4)
- ✅ Color-coded terminal output (success/error/info/warning)
- ✅ Enhanced help text formatting
- ✅ Context-aware error messages
- ✅ API response formatting with metadata display
- ✅ Startup health check with connection status
- ✅ Actionable tips for common API errors

### Pending (Future Subtasks)
- ⏳ Integration tests for CLI→API flow (Subtask 6)

## Usage

### Run as standalone script
```bash
node src/orchestrator/cli-interactive.js
# or
./src/orchestrator/cli-interactive.js
```

### Import as module
```javascript
import { InteractiveCLI } from './src/orchestrator/cli-interactive.js';

const cli = new InteractiveCLI({
  apiBaseUrl: 'http://localhost:3000',
  agentsJsonPath: '.synapse/agents.json'
});

cli.start();
```

## Commands (Planned)

- `pause <agent>` - Pause an agent
- `resume <agent>` - Resume a paused agent
- `failover <provider>` - Force provider failover
- `weight <agent> <value>` - Override routing weight (0-1)
- `reset-cb <provider>` - Reset circuit breaker for provider
- `help` - Show help text
- `exit` / `quit` - Exit the CLI

## Architecture

### Class: InteractiveCLI

**Constructor Options:**
- `apiBaseUrl` (string) - Base URL for Synapse API (default: 'http://localhost:3000')
- `agentsJsonPath` (string) - Path to agents.json (default: relative to module)

**Methods:**
- `start()` - Initialize readline and start command loop
- `stop()` - Gracefully close readline and exit
- `isRunning()` - Check if CLI is active
- `displayWelcome()` - Show banner and help
- `processCommand(input)` - Process command string (placeholder)

**Event Handling:**
- `line` - Command input received
- `SIGINT` - Ctrl+C pressed
- `close` - Readline closed (Ctrl+D)

## Testing

### Manual Testing
```bash
# Test basic flow
echo -e "help\nexit" | node src/orchestrator/cli-interactive.js

# Test empty lines
echo -e "\n\nhelp\n\nexit" | node src/orchestrator/cli-interactive.js

# Test command placeholders
echo -e "pause lola\nresume alice\nexit" | node src/orchestrator/cli-interactive.js
```

### Verification Points
1. ✅ Welcome banner displays on startup
2. ✅ Help text shows all commands and examples
3. ✅ Prompt appears and accepts input
4. ✅ Empty lines don't crash (just re-prompt)
5. ✅ `help` command redisplays help text
6. ✅ `exit` command terminates gracefully
7. ✅ Ctrl+C shows exit message and terminates
8. ✅ Ctrl+D triggers close event
9. ✅ Commands are logged (placeholder)

## Command Parser (Subtask 2)

### Validation Logic

**Agent Validation:**
- Loads agent IDs from `.synapse/agents.json` (cached after first load)
- Checks if the provided agent ID exists in the list
- Returns descriptive error with list of valid agents if invalid

**Provider Validation:**
- Checks if provider is in the hardcoded list: `['claude', 'codex', 'gemini', 'ollama']`
- Returns descriptive error with list of valid providers if invalid

**Weight Validation:**
- Parses string to float using `parseFloat()`
- Checks for NaN (non-numeric input)
- Validates range: 0 ≤ weight ≤ 1
- Returns descriptive error if invalid

### Parser Output Format

**Success:**
```javascript
{
  success: true,
  command: {
    type: 'pause' | 'resume' | 'failover' | 'weight' | 'reset-cb',
    agentId?: string,      // for pause, resume, weight
    provider?: string,     // for failover, reset-cb
    weight?: number        // for weight (0-1 float)
  }
}
```

**Error:**
```javascript
{
  success: false,
  error: string  // Descriptive error message with usage example
}
```

### Parser Methods

- `parseCommand(input)` - Main parsing entry point
- `parsePauseCommand(parts)` - Parse pause <agent>
- `parseResumeCommand(parts)` - Parse resume <agent>
- `parseFailoverCommand(parts)` - Parse failover <provider>
- `parseWeightCommand(parts)` - Parse weight <agent> <value>
- `parseResetCbCommand(parts)` - Parse reset-cb <provider>
- `validateAgent(agentId)` - Validate agent exists
- `validateProvider(provider)` - Validate provider is valid
- `validateWeight(weightStr)` - Validate weight range
- `loadAgentIds()` - Lazy-load and cache agent IDs

### Parser Tests

Unit tests in `test/orchestrator/cli-interactive-parser.test.js` verify:
- ✓ All 5 command types parse correctly (17/17 tests passing)
- ✓ Invalid agent IDs are rejected
- ✓ Invalid providers are rejected
- ✓ Out-of-range weights are rejected (negative, >1)
- ✓ Non-numeric weights are rejected
- ✓ Malformed syntax is rejected (too few/many args)
- ✓ Boundary values are accepted (weight = 0, weight = 1)
- ✓ Error messages are descriptive and list valid options

Run tests:
```bash
node test/orchestrator/cli-interactive-parser.test.js
```

## Help Text and Error Message Formatting (Subtask 4)

### Color-Coded Output

All terminal output uses ANSI color codes for better readability:

- ✓ **Success** (green) - Successful operations
- ✗ **Error** (red) - Failures and validation errors
- ℹ **Info** (cyan) - Informational messages
- ⚠ **Warning** (yellow) - Non-critical issues

### Formatting Functions

```javascript
formatSuccess(message)   // Green checkmark + bold message
formatError(message)     // Red X + bold message
formatInfo(message)      // Cyan info icon + message
formatWarning(message)   // Yellow warning icon + message
formatApiResponse(response, action)  // Context-aware API response formatter
```

### Error Message Types

#### Command Parsing Errors
- **Unknown command**: Suggests typing 'help' for available commands
- **Invalid syntax**: Shows correct usage pattern with example
- **Unknown agent**: Lists all valid agent IDs from `.synapse/agents.json`
- **Unknown provider**: Lists valid providers (claude, codex, gemini, ollama)
- **Invalid weight**: Explains weight must be a number between 0 and 1

Example:
```
✗ Unknown agent: olivia. Valid agents: lola, loco, carl, kai, alice
```

#### API Response Errors
- **Connection errors**: Suggests checking API server is running
- **404 errors**: Hints that endpoint may not exist
- **503 errors**: Indicates temporary unavailability
- **500+ errors**: Directs operator to check API logs

Example:
```
✗ Provider 'ollama' failover initiated failed
  ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3000
  Tip: Ensure the Synapse API server is running at the configured base URL
  HTTP Status: undefined
```

### Success Message Display

Successful API responses show:
- Action description (what was done)
- Correlation ID (for tracing)
- Action ID (for idempotency)
- Expiration time (for time-limited overrides)

Example:
```
✓ Routing weight set for 'lola' to 0.8
  Correlation ID: cli-1234567890-def456
  Action ID: 550e8400-e29b-41d4-a716-446655440000
  Expires: 3/31/2026, 2:30:00 PM
```

### Startup Health Check

On CLI startup:
1. Tests connectivity to Synapse API
2. Displays connection status with colored output
3. Warns if API unavailable but continues (allows retry)

Example:
```
ℹ Connecting to Synapse API at http://localhost:3000...
✓ Connected to Synapse API
```

Or if unavailable:
```
ℹ Connecting to Synapse API at http://localhost:3000...
⚠ Could not connect to API: Unable to connect to Synapse API at http://localhost:3000: fetch failed
ℹ Commands will be processed but may fail if API is not available
```

## Next Steps

**Subtask 5:** Write unit tests for command parser validation
**Subtask 6:** Write integration tests for CLI→API flow
