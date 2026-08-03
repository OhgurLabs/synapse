# MCP Client Integration Test Infrastructure

This document describes the test harness and helper functions available in `client-integration.test.js`.

## Test Harness

### Custom Test Runner
- `test(name, fn)` - Runs a test with automatic cleanup tracking
- Tests track pass/fail counts and provide summary output
- Automatic cleanup handlers run in reverse order after each test

### Assert Helpers
- `assertEqual(actual, expected, message)` - Strict equality
- `assertDeepEqual(actual, expected, message)` - Deep object equality
- `assertOk(value, message)` - Truthiness check
- `assertThrows(fn, expectedError, message)` - Error throwing validation
- `assertIncludes(array, value, message)` - Array inclusion check

## Helper Functions

### Test Data Creation
- `createTestTool(namePrefix)` - Create a single test tool with unique name
- `createTestTools(count, prefix)` - Create multiple test tools
- Both functions create tools with:
  - Unique names (via generateToolName)
  - Standard inputSchema with param1 (string, required) and param2 (number)
  - Annotations (readOnly: true, destructive: false, idempotent: true)

### Client Creation Helpers

#### Stdio Transport
```javascript
const { client, mockServer, cleanup } = await createStdioClient(tools, options);
```
- `tools` - Array of tool definitions
- `options.timeout` - Request timeout (default: 5000ms)
- `options.reconnectDelay` - Delay before reconnect (default: 100ms)
- `options.maxReconnectAttempts` - Max reconnect attempts (default: 3)
- `options.protocolVersion` - MCP protocol version (default: '2024-11-05')
- `options.serverInfo` - Custom server info for initialize response
- `options.capabilities` - Custom capabilities for initialize response
- `options.onCall` - Custom tool call handler

Returns:
- `client` - MCPClient instance (stdio transport)
- `mockServer` - Mock server handle
- `cleanup` - Async cleanup function

#### HTTP Transport
```javascript
const { client, mockServer, url, port, cleanup } = await createHttpClient(tools, options);
```
- Same options as stdio, plus:
- `options.port` - Server port (default: 0 for random)
- `options.auth` - Authentication configuration

Returns:
- `client` - MCPClient instance (HTTP transport)
- `mockServer` - Mock server handle
- `url` - Server URL (e.g., 'http://localhost:12345/mcp')
- `port` - Server port number
- `cleanup` - Async cleanup function

### Utility Functions
- `waitFor(conditionFn, timeoutMs, intervalMs)` - Poll until condition is true
- `delay(ms)` - Async sleep

## Usage Pattern

```javascript
await test('test name', async (registerCleanup) => {
  // Create client with automatic cleanup
  const { client, cleanup } = await createStdioClient(tools);
  registerCleanup(cleanup);

  // Test assertions
  await client.connect();
  assertEqual(client.getHealth().connected, true);
});
```

## Test Structure

The test file is organized into sections:
1. **Stdio Transport Tests** - Connection, handshake, basic operations
2. **HTTP Transport Tests** - Connection, POST requests, SSE handling
3. **Tool Discovery Tests** - Metadata extraction, tool listing
4. **Tool Registration Tests** - Pending approval state, registry integration
5. **Connection Failure Tests** - Process crashes, connection refused, timeouts
6. **Reconnection Tests** - Exponential backoff, max retries, recovery
7. **Malformed Response Tests** - Invalid JSON-RPC, protocol violations

Each section uses placeholder comments for tests to be added in subsequent subtasks.

## Running Tests

```bash
node src/mcp/client-integration.test.js
```

Expected output:
```
=== MCP Client Integration Tests ===
--- Stdio Transport ---
  ✓ test name
...
=== Summary ===
Passed: N
Failed: 0
Total:  N
```
