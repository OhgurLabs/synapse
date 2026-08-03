# POST /api/tools/invoke - Design Document

## Overview
API endpoint for invoking MCP tools on behalf of agents. Routes tool calls through the MCP invocation infrastructure with proper error handling and result normalization.

## Endpoint Specification

### Route
```
POST /api/tools/invoke
```

### Request Body
```json
{
  "agentId": "string",      // Required: Agent ID for permission/audit context
  "toolName": "string",     // Required: Tool name (e.g., "filesystem:read_file")
  "arguments": {}           // Optional: Tool parameters (defaults to {})
}
```

### Response Format (Success)
```json
{
  "status": "ok",
  "toolName": "filesystem:read_file",
  "agentId": "assistant",
  "source": "mcp:filesystem",
  "result": {
    "content": [...]        // MCP tool result
  },
  "error": null,
  "timestamp": "2026-03-31T..."
}
```

### Response Format (Error)
```json
{
  "status": "error",
  "code": "TOOL_NOT_FOUND|VALIDATION_FAILED|SERVER_NOT_CONNECTED|INVOCATION_FAILED",
  "message": "Error description",
  "toolName": "filesystem:read_file",
  "agentId": "assistant",
  "source": "mcp:filesystem",
  "timestamp": "2026-03-31T..."
}
```

## Implementation Details

### Tool Detection & Routing
1. **MCP Tool Detection**: Checks tool source metadata for `mcp:` prefix
2. **Permission Check**: Uses `ToolDistributionService.getToolForAgent()` to verify tool availability
3. **Invocation**: Routes through `ToolDistributionService.invokeTool()` which:
   - Validates parameters against tool schema
   - Routes to correct MCP server via ConnectionManager
   - Applies circuit breaker protection
   - Enforces timeout limits

### Error Handling
| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `VALIDATION_FAILED` | 400 | Request body validation failed |
| `TOOL_NOT_FOUND` | 404 | Tool not available for agent |
| `SERVER_NOT_CONNECTED` | 400 | MCP server unavailable |
| `INVOCATION_FAILED` | 400 | Tool execution failed |
| `SERVICE_UNAVAILABLE` | 503 | Tool distribution service not initialized |
| `NOT_IMPLEMENTED` | 501 | Native tool invocation not supported |

### Result Normalization
MCP tool results are normalized to match native tool interface:
- `status`: "ok" or "error"
- `result`: Normalized content from MCP response
- `error`: Error details if invocation failed
- `timestamp`: ISO 8601 timestamp

## Integration Points

### Dependencies
- `toolDistributionService`: Tool routing and permission checks
- `mcpConnectionManager`: MCP server connections
- `toolRegistry`: Tool metadata lookup

### Architecture Flow
```
HTTP Request
    ↓
POST /api/tools/invoke
    ↓
Validate request body
    ↓
Check tool availability (ToolDistributionService)
    ↓
Detect MCP tool (source starts with "mcp:")
    ↓
Invoke via ToolDistributionService.invokeTool()
    ↓
[Internal: ToolInvocationEngine → McpConnectionManager → MCP Server]
    ↓
Normalize result
    ↓
HTTP Response
```

## Usage Example

```bash
curl -X POST http://localhost:3001/api/tools/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "assistant",
    "toolName": "filesystem:read_file",
    "arguments": {
      "path": "/path/to/file.txt"
    }
  }'
```

## Security Considerations
- Agent ID required for audit trail
- Tool availability checked against agent's role permissions
- Per-agent allowlist/denylist applied automatically
- All invocations logged for audit purposes

## Future Enhancements
- Support for native tool invocation
- Batch tool invocation
- Async tool invocation with webhook callbacks
- Rate limiting per agent/tool
