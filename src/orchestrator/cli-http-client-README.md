# CLI HTTP Client Module

HTTP client for Synapse interactive CLI operator commands. Handles all communication with API endpoints for agent control, provider failover, routing weight overrides, and circuit breaker management.

## Usage

```javascript
import { CLIHttpClient } from './cli-http-client.js';

const client = new CLIHttpClient('http://localhost:3000');

// Pause an agent
const result = await client.pauseAgent('alice', 'Testing pause');
if (result.success) {
  console.log('Agent paused:', result.data);
} else {
  console.error('Failed:', result.error);
}
```

## API Methods

### `pauseAgent(agentId, reason?)`
Pause an agent to prevent new task assignments.

**Parameters:**
- `agentId` (string): Agent identifier (e.g., 'alice', 'bob')
- `reason` (string, optional): Reason for pausing

**Returns:** `Promise<{success: boolean, error?: string, data?: object}>`

**API Endpoint:** `POST /api/agents/:id/pause`

---

### `resumeAgent(agentId, reason?)`
Resume a paused agent to allow task assignments.

**Parameters:**
- `agentId` (string): Agent identifier
- `reason` (string, optional): Reason for resuming

**Returns:** `Promise<{success: boolean, error?: string, data?: object}>`

**API Endpoint:** `POST /api/agents/:id/resume`

---

### `failoverProvider(provider)`
Force provider failover by holding its circuit breaker.

**Parameters:**
- `provider` (string): Provider name ('claude', 'ollama', 'codex', 'gemini')

**Returns:** `Promise<{success: boolean, error?: string, data?: object}>`

**API Endpoint:** `POST /api/guard-actions/circuit-breaker/hold`

---

### `setWeightOverride(agentId, weight, ttlMinutes?)`
Override routing weight for an agent with optional TTL.

**Parameters:**
- `agentId` (string): Agent identifier
- `weight` (number): Weight value (0.0 to 1.0)
- `ttlMinutes` (number, optional): Time-to-live in minutes (default: 60)

**Returns:** `Promise<{success: boolean, error?: string, data?: object}>`

**API Endpoint:** `POST /api/guard-actions/weight-override`

---

### `resetCircuitBreaker(provider)`
Reset circuit breaker for a provider to clear failures.

**Parameters:**
- `provider` (string): Provider name ('claude', 'ollama', 'codex', 'gemini')

**Returns:** `Promise<{success: boolean, error?: string, data?: object}>`

**API Endpoint:** `POST /api/guard-actions/circuit-breaker/reset`

---

### `healthCheck()`
Test API connectivity.

**Returns:** `Promise<{success: boolean, error?: string}>`

**API Endpoint:** `GET /health`

## Response Format

All methods return a standardized response object:

```javascript
{
  success: boolean,      // True if request succeeded (HTTP 2xx)
  status?: number,       // HTTP status code
  error?: string,        // Error message if failed
  data?: object          // Response body from API
}
```

## Error Handling

The client handles multiple error scenarios:

1. **Network errors** - Connection failures, timeouts
2. **HTTP errors** - 404 (not found), 400 (bad request), 500 (server error)
3. **Invalid JSON** - Returns raw response text in `data.raw`
4. **Missing endpoints** - Returns appropriate error message

## Correlation & Action IDs

Each request automatically generates:

- **Correlation ID** - Format: `cli-<timestamp>-<uuid>` for tracking operator actions
- **Action ID** - UUID for idempotent guard actions (weight override, circuit breaker operations)

These IDs are included in API audit logs and timeline events.

## Testing

Run unit tests:

```bash
node test/orchestrator/cli-http-client.test.js
```

Tests cover:
- Request formatting for all endpoints
- Success and error response handling
- Network error handling
- Invalid JSON response handling
- URL encoding for special characters
- Unique ID generation
