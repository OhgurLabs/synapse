# Tool Cache Design Document

## Overview

The `ToolCache` class provides local caching of MCP tool metadata with offline mode support, TTL-based expiration, and disk persistence for resilience during server outages.

## Cache Data Structures

### Primary Cache: `cache: Map<cacheKey, CachedToolEntry>`

```javascript
// Cache key format: "${serverId}::${toolName}"
// Example: "filesystem-server::read_file"

CachedToolEntry = {
  tool: ToolSchema,        // The actual tool definition
  serverId: string,        // MCP server identifier
  version: string,         // Schema version for invalidation
  cachedAt: number,        // Timestamp when cached (ms since epoch)
  expiresAt: number,       // Timestamp when entry expires
  ttl: number,             // Time-to-live in milliseconds
  accessCount: number,     // Number of times accessed (for LRU)
  lastAccessed: number     // Last access timestamp
}
```

### Server State Tracking: `serverStates: Map<serverId, ServerCacheState>`

```javascript
ServerCacheState = {
  serverId: string,        // MCP server identifier
  connected: boolean,      // Current connection status
  lastSeen: number,        // Last successful connection timestamp
  toolCount: number,       // Number of tools from this server
  schemaVersion: string,   // Overall schema version from server
  tools: Map<toolName, CachedToolEntry>  // Fast lookup by tool name
}
```

## Invalidation Strategy

### 1. TTL-Based Expiration
- Each entry has a configurable TTL (default: 5 minutes)
- Expired entries are automatically removed on access
- `clearExpired()` method for proactive cleanup

### 2. Server Reconnection Invalidation
```javascript
// When server reconnects with updated schema
cache.invalidateServer(serverId);  // Clears all tools from that server
```

### 3. Version-Based Invalidation
```javascript
// When schema version changes
cache.setMany(serverId, newTools, newSchemaVersion);
// This automatically clears old versions via invalidateServer()
```

### 4. LRU Eviction
```javascript
// When cache reaches maxEntries (default: 1000)
// Least recently used entries are automatically evicted
```

### 5. Manual Invalidation
```javascript
cache.delete(serverId, toolName);  // Single tool
cache.invalidateServer(serverId);  // All tools from server
cache.clear();                     // Full cache reset
```

## Offline Mode Support

### Persistence Configuration
```javascript
const cache = new ToolCache({
  persistenceEnabled: true,
  persistencePath: '/path/to/.tool-cache.json',
  defaultTTL: 300000  // 5 minutes
});
```

### Offline Tool Access
```javascript
// Check if offline tools available
if (cache.hasOfflineTools(serverId)) {
  const tools = cache.getOfflineTools(serverId);
  // Use cached tools while server is unavailable
}

// Check specific server connection status
if (!cache.isServerConnected(serverId)) {
  // Server is disconnected, use cached tools
  const cachedTool = cache.get(serverId, toolName);
}
```

## Integration with MCP Client

### Recommended Client Integration Pattern

```javascript
class MCPClient {
  constructor(options = {}) {
    this.serverId = options.serverId || 'default';
    this._toolCache = options.toolCacheInstance || toolCache;
    this._retryOptions = options.retryOptions || {};
  }

  async listTools() {
    try {
      // Try to fetch from server with retry
      const result = await retry(
        () => this._request('tools/list'),
        this._retryOptions
      );
      
      // Invalidate old cache and populate with fresh data
      this._toolCache.setMany(
        this.serverId,
        result.tools || [],
        result.schemaVersion,
        this._toolCache.defaultTTL
      );
      
      return result.tools || [];
    } catch (err) {
      // Fallback to cached tools (offline mode)
      const cachedTools = this._toolCache.getServerTools(this.serverId);
      if (cachedTools.length === 0) {
        throw new Error('No tools available from server or cache.');
      }
      log.info({ count: cachedTools.length }, 'Using cached tools (offline mode)');
      return cachedTools;
    }
  }

  getToolMetadata(toolName) {
    const tool = this._toolCache.get(this.serverId, toolName);
    if (!tool) return null;
    // Normalize and return metadata...
  }

  async connect() {
    // ... connection logic ...
    
    // Mark server as connected
    this._toolCache.markServerConnected(this.serverId);
    
    // Invalidate cache on reconnection to get fresh schema
    this._toolCache.invalidateServer(this.serverId);
  }

  async disconnect() {
    // Mark server as disconnected
    this._toolCache.markServerDisconnected(this.serverId);
  }
}
```

## Retry Integration

The `retry` utility provides exponential backoff for registration failures:

```javascript
import { retry } from './utils/retry.js';

// Basic retry
const tools = await retry(
  () => fetchToolsFromServer(),
  { maxRetries: 3, initialDelayMs: 1000, backoffFactor: 2 }
);

// With custom error handler
const tools = await retry(
  () => fetchToolsFromServer(),
  {
    maxRetries: 5,
    initialDelayMs: 500,
    backoffFactor: 2,
    jitter: true,  // Prevent thundering herd
    errorHandler: (error, attempt) => {
      // Stop retrying on certain errors
      if (error.code === 'ECONNREFUSED') return false;
      return true;  // Continue retrying
    }
  }
);
```

## Cache Statistics

```javascript
const stats = cache.getStats();
// {
//   totalEntries: 150,
//   activeEntries: 145,
//   expiredEntries: 5,
//   serversCached: 3,
//   hitRate: 0.85,
//   missRate: 0.15,
//   totalHits: 850,
//   totalMisses: 150
// }
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultTTL` | number | 300000 | Default TTL in milliseconds (5 min) |
| `maxEntries` | number | 1000 | Max entries before LRU eviction |
| `persistenceEnabled` | boolean | false | Enable disk persistence |
| `persistencePath` | string | `.tool-cache.json` | Path to cache file |

## Usage Examples

### Basic Caching
```javascript
import { ToolCache } from './cache/toolCache.js';

const cache = new ToolCache();

// Cache a tool
cache.set('server1', {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: {} }
});

// Retrieve cached tool
const tool = cache.get('server1', 'read_file');

// Check if cached
if (cache.has('server1', 'read_file')) {
  // Tool is cached and valid
}
```

### Offline Mode
```javascript
const cache = new ToolCache({ persistenceEnabled: true });

// Server available - cache tools
cache.setMany('filesystem', tools, 'v1.0');

// Server disconnected - use cached tools
const offlineTools = cache.getOfflineTools('filesystem');

// Server reconnected - invalidate and refresh
cache.invalidateServer('filesystem');
cache.setMany('filesystem', newTools, 'v1.1');
```

### Multi-Server Support
```javascript
const cache = new ToolCache();

// Cache tools from multiple servers
cache.setMany('filesystem', fsTools, 'v1.0');
cache.setMany('database', dbTools, 'v1.0');
cache.setMany('web', webTools, 'v1.0');

// Get tools from specific server
const fsTools = cache.getServerTools('filesystem');

// Get all cached tools
const allTools = cache.getAllTools();

// Check server status
console.log(cache.isServerConnected('filesystem'));  // true/false
```

## Chaos Testing Scenarios

1. **Server Flap**: Rapid connect/disconnect cycles
   - Verify cache preserves tools during disconnects
   - Verify cache invalidates on reconnect

2. **Schema Update**: Server returns new tool schema
   - Verify old cached entries are invalidated
   - Verify new schema is cached correctly

3. **Persistence Recovery**: Process restart
   - Verify cache loads from disk
   - Verify expired entries are cleaned up

4. **LRU Pressure**: Cache at capacity
   - Verify least recently used entries are evicted
   - Verify access count updates correctly

## File Location

`src/mcp/cache/toolCache.js`
