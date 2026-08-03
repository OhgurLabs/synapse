# MCP Tool Circuit Breaker

## Overview

Per-tool circuit breaker for MCP tool invocations. Prevents cascading failures by fast-failing when a tool repeatedly fails.

## State Machine

```
CLOSED ──[N failures]──> OPEN ──[cooldown elapsed]──> HALF_OPEN
  ↑                                                         │
  └───────────────────[success]─────────────────────────────┘
                      [failure] → back to OPEN
```

## Usage

```javascript
import { createToolCircuitBreaker } from './tool-circuit-breaker.js';
import config from '../config.js';

// Create from config
const breaker = createToolCircuitBreaker(config.mcp.toolCircuitBreaker);

// Before tool invocation
const check = breaker.canExecute('filesystem:read_file');
if (!check.allowed) {
  return check.error;  // { status: 'error', code: 'CIRCUIT_OPEN', message: '...' }
}

// After tool invocation
try {
  const result = await invokeTool(...);
  breaker.recordSuccess('filesystem:read_file');
  return result;
} catch (err) {
  breaker.recordFailure('filesystem:read_file');
  throw err;
}
```

## Configuration

From `config.mcp.toolCircuitBreaker`:

- `failureThreshold` (default: 3) — Open circuit after N consecutive failures
- `cooldownMs` (default: 60000) — Wait this long before probing in HALF_OPEN

ENV overrides:
- `SYNAPSE_MCP_TOOL_CB_THRESHOLD`
- `SYNAPSE_MCP_TOOL_CB_COOLDOWN_MS`

## API

### `canExecute(toolName)`

Returns `{ allowed: boolean, error?: {...} }`

### `recordSuccess(toolName)`

Clears failure count. Transitions HALF_OPEN → CLOSED.

### `recordFailure(toolName)`

Increments failure count. Transitions:
- CLOSED → OPEN (if threshold exceeded)
- HALF_OPEN → OPEN (immediate)

### `getState(toolName)`

Returns `{ state, failureCount, openedAt }`

### `getAllStates()`

Returns Map of all tool states.

### `reset(toolName)` / `resetAll()`

Manually reset breakers (testing/debugging only).

## Per-Tool Isolation

Each tool has independent circuit state. One tool opening does not affect others.

Example:
- `filesystem:read_file` opens after 3 failures
- `database:query` remains closed and continues working

## Testing

See inline demo in this file:
```bash
node -e "import('./src/mcp/tool-circuit-breaker.js').then(module => { /* demo code */ })"
```
