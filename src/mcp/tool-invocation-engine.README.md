# Tool Invocation Engine - Input/Output Serialization & Result Wrapping

## Overview

The Tool Invocation Engine in `tool-invocation-engine.js` provides:
1. **Parameter validation** against tool JSON Schema
2. **Input/output serialization** for MCP protocol
3. **Typed response envelope** for all tool invocations

## Result Format

### Success Response
```javascript
{
  status: 'ok',
  result: <payload>  // Raw result from MCP server
}
```

### Error Responses

All errors return:
```javascript
{
  status: 'error',
  code: <error_code>,
  message: <human_readable_message>,
  error?: <error_details>  // Optional, only for INVOCATION_FAILED
}
```

## Parameter Validation & Serialization

### Validation Phase (Before Invocation)

**Step 2 in invoke() method** (lines 90-110):
1. Extract `inputSchema` from `tool.metadata`
2. If schema exists, validate params using `ParameterValidator`
3. If validation fails, return `VALIDATION_FAILED` error immediately
4. If no schema, skip validation and proceed

**Why validate before serialization?**
- Fail fast with detailed field-level errors
- Prevent invalid requests from reaching MCP servers
- Reduce network round-trips for invalid params

### Serialization Phase (During Invocation)

**Step 6 in invoke() method** (lines 142-152):
- Parameters passed to `client.callTool(originalToolName, params)`
- MCP client constructs JSON-RPC envelope internally
- Request serialized with `JSON.stringify()` in `McpClient._request()`
- Response deserialized with `JSON.parse()` in `McpClient._handleStdioData()`

**Serialization is transparent** — caller doesn't need to stringify params or parse results.

### Null/Undefined Normalization

Both `null` and `undefined` params are normalized to `{}` (lines 78-80):
```javascript
if (params == null) {
  params = {};
}
```

This ensures consistent behavior and prevents type errors in validation.

## Error Codes

### VALIDATION_FAILED
**Trigger**: Parameters fail inputSchema validation
**Location**: Lines 97-105
**Example**:
```javascript
{
  status: 'error',
  code: 'VALIDATION_FAILED',
  message: 'Parameter validation failed for tool: filesystem:read_file',
  details: [
    { field: 'path', constraint: 'required', message: 'Missing required field: path' }
  ]
}
```

### TOOL_NOT_FOUND
**Trigger**: Tool name doesn't exist in ToolRegistry
**Location**: Lines 78-82
**Example**:
```javascript
{
  status: 'error',
  code: 'TOOL_NOT_FOUND',
  message: 'Tool not found: unknown_tool'
}
```

### SERVER_NOT_CONNECTED
**Trigger**: MCP server is not available/connected
**Location**: Lines 103-107
**Example**:
```javascript
{
  status: 'error',
  code: 'SERVER_NOT_CONNECTED',
  message: 'MCP server not connected: filesystem'
}
```

### INVOCATION_FAILED
**Trigger**: Tool execution failed (network error, timeout, runtime error)
**Location**: Lines 135-144
**Example**:
```javascript
{
  status: 'error',
  code: 'INVOCATION_FAILED',
  message: 'Tool invocation failed: Connection timeout',
  error: {
    type: 'Error',
    message: 'Connection timeout',
    stack: '...'
  }
}
```

### INVALID_SOURCE (bonus defensive check)
**Trigger**: Tool source format is malformed (not "mcp:*")
**Location**: Lines 90-94
**Example**:
```javascript
{
  status: 'error',
  code: 'INVALID_SOURCE',
  message: 'Invalid tool source format: http://bad'
}
```

## Implementation Details

### originalToolName Handling
**Critical**: MCP servers expect unprefixed tool names, but the registry stores namespaced names (e.g., `filesystem:read_file`).

The implementation correctly extracts the original name:
```javascript
const originalToolName = tool.metadata?.originalToolName || toolName;
const result = await client.callTool(originalToolName, params);
```

This prevents the incident documented in `.synapse/projects/synapse/vault/incidents/2026-03-31-invoketool-passes-namespaced-toolname-e-g-filesystem-read-fi.md`.

### Error Preservation
INVOCATION_FAILED responses preserve the original error details including:
- Error type/constructor name
- Original error message
- Full stack trace

This aids debugging without losing error context.

## Testing

Unit tests in `src/mcp/tool-invocation-engine.test.js` cover:
- ✓ Parameter validation against inputSchema
- ✓ Validation failure handling (VALIDATION_FAILED)
- ✓ Schema-less tool pass-through
- ✓ Serialization flow (params passed unchanged to MCP client)
- ✓ Response deserialization (result extraction)
- ✓ Null/undefined normalization
- ✓ Extra parameter pass-through
- ✓ Error codes: TOOL_NOT_FOUND, SERVER_NOT_CONNECTED, INVOCATION_FAILED
- ✓ Constructor validation

Run tests:
```bash
node --test src/mcp/tool-invocation-engine.test.js
```

Integration tests in `test/integration/tool-invocation-e2e.test.js` (planned) will exercise the full path with mock MCP server.
