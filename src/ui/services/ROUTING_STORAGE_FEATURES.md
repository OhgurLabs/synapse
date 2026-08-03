# Routing Storage Service - TypeScript Implementation

## Overview
TypeScript implementation of the routing storage service at `src/ui/services/routingStorage.ts`, providing type-safe persistence layer for routing decision data.

## Features Implemented

### 1. Type Safety
- ✅ Uses `DispatchDecision` type from `routing.ts`
- ✅ Uses `DispatchLogResponse` type from `routing.ts`
- ✅ Uses `ServiceError` for error handling
- ✅ Uses `FetchDecisionLogParams` from `routingService.ts`
- ✅ Full TypeScript type coverage for all functions

### 2. Caching Layer
- ✅ In-memory Map for cache storage
- ✅ 5-minute TTL (Time To Live)
- ✅ Cache key generation from normalized parameters
- ✅ Automatic cache expiration
- ✅ Manual cache invalidation via `clearCache()`
- ✅ Per-request cache clearing support

### 3. Request Deduplication
- ✅ Tracks in-flight requests per cache key
- ✅ Prevents duplicate concurrent API calls
- ✅ Returns shared promise for duplicate requests
- ✅ Cleans up pending requests on completion

### 4. Retry Logic
- ✅ 3 maximum retry attempts
- ✅ 1 second base delay
- ✅ Exponential backoff (2^retry * base_delay)
- ✅ Retries on network errors (TypeError, fetch failures)
- ✅ Retries on 5xx server errors
- ✅ Does NOT retry on 4xx client errors

### 5. Error Handling
- ✅ Error tracking per cache key
- ✅ `getError()` API to retrieve last error
- ✅ Falls back to empty array on failure
- ✅ Uses `classifyError()` from routingService
- ✅ Clears error state on successful retry

### 6. Cache Warming
- ✅ `warmCache()` function for pre-fetching
- ✅ Non-blocking initialization
- ✅ Graceful failure handling
- ✅ Can be called on page load

### 7. Public API

```typescript
// Initialize service
init(): void

// Get decisions with caching
getDecisions(params?: FetchDecisionLogParams, forceRefresh?: boolean): Promise<DispatchDecision[]>

// Force refresh and clear cache
refresh(params?: FetchDecisionLogParams): Promise<DispatchDecision[]>

// Clear cache entries
clearCache(params?: FetchDecisionLogParams): void

// Check loading state
isLoading(params?: FetchDecisionLogParams): boolean

// Get last error
getError(params?: FetchDecisionLogParams): string | null

// Pre-fetch data
warmCache(): Promise<void>
```

## Integration with Existing Code

### Leverages routingService.ts
- Reuses `fetchDecisionLog()` for API calls
- Reuses `classifyError()` for error handling
- Reuses `FetchDecisionLogParams` interface

### Consistent with routing.ts types
- Returns `DispatchDecision[]` not generic objects
- Uses `DispatchLogResponse` structure
- Type-safe error handling with `ServiceError`

## Differences from JavaScript Implementation

| Feature | JavaScript (routing-storage.js) | TypeScript (routingStorage.ts) |
|---------|--------------------------------|-------------------------------|
| Type Safety | None | Full TypeScript coverage |
| API Client | `window.SynapseWebSocket.authFetch` | Standard `fetch()` via `fetchDecisionLog()` |
| Error Classification | String messages | Typed `ServiceError` objects |
| Return Types | `Array<object>` | `DispatchDecision[]` |
| Code Reuse | Standalone implementation | Leverages `routingService.ts` |
| Browser Dependency | Requires `window.SynapseWebSocket` | Works in any environment |

## Testing
- Type verification test in `routingStorage.test.ts`
- Compiles without errors
- All type signatures verified

## Usage Example

```typescript
import * as routingStorage from './services/routingStorage';

// Initialize on page load
routingStorage.init();

// Warm cache with default dataset
await routingStorage.warmCache();

// Get decisions with caching
const decisions = await routingStorage.getDecisions({
  agentId: 'agent123',
  limit: 50,
});

// Check loading state
if (routingStorage.isLoading({ agentId: 'agent123' })) {
  console.log('Loading...');
}

// Check for errors
const error = routingStorage.getError({ agentId: 'agent123' });
if (error) {
  console.error('Error:', error);
}

// Force refresh
const fresh = await routingStorage.refresh({ agentId: 'agent123' });

// Clear specific cache entry
routingStorage.clearCache({ agentId: 'agent123' });

// Clear all cache
routingStorage.clearCache();
```

## Cache Key Generation
Cache keys are generated from normalized parameters with consistent ordering:
- Parameters are normalized with defaults (limit=100, offset=0)
- Keys are sorted alphabetically to ensure consistency
- Undefined values are filtered out
- Result is JSON stringified for use as Map key

Example cache keys:
```
{"limit":100,"offset":0}
{"agentId":"agent123","limit":100,"offset":0}
{"campaignId":"camp456","limit":50,"offset":10}
```

## Performance Characteristics
- **Cache hit**: O(1) Map lookup, ~0ms
- **Cache miss**: API call + retry logic, variable latency
- **Deduplication**: O(1) Map lookup, prevents N duplicate calls
- **Cache warming**: Single upfront cost, benefits all subsequent requests

## Future Enhancements
- Implement `init()` with actual cache warming call
- Add metrics/analytics for cache hit/miss rates
- Support cache size limits with LRU eviction
- Add AbortSignal support for cancellable requests
- Integrate with browser storage (localStorage/IndexedDB) for persistence across sessions
