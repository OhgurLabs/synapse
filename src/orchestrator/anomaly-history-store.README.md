# AnomalyHistoryStore - SQLite Backend

## Overview

SQLite-backed persistence for anomaly detector alert history. Replaces the legacy JSONL format with a queryable database that supports efficient filtering, pagination, and indexing.

## Features

- **SQLite with WAL mode** for better concurrency
- **Automatic migration** from legacy JSONL format
- **Efficient indexes** for timestamp, agent, and type queries
- **Full query API** with filtering and pagination
- **Preserves all data fields** from legacy format

## Schema

```sql
CREATE TABLE anomaly_history (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  agentId TEXT,
  taskCategory TEXT,
  severity TEXT,
  data TEXT NOT NULL  -- JSON blob with additional fields
)

-- Indexes for efficient queries
CREATE INDEX idx_anomaly_timestamp_desc ON anomaly_history(timestamp DESC);
CREATE INDEX idx_anomaly_agent_timestamp ON anomaly_history(agentId, timestamp DESC);
CREATE INDEX idx_anomaly_type_timestamp ON anomaly_history(type, timestamp DESC);
```

## Usage

### Basic Usage

```javascript
import AnomalyHistoryStore from './anomaly-history-store.js';

// Create store (with optional JSONL migration)
const store = new AnomalyHistoryStore({
  dbPath: './data/anomaly-history.db',
  legacyJsonlPath: './data/anomaly-alerts.jsonl'  // Optional
});

// Append an alert
store.append({
  type: 'fired',
  agentId: 'agent1',
  taskCategory: 'implementer',
  severity: 'critical',
  firedAt: '2026-03-03T10:00:00Z',
  rollingSuccessRate: 0.2,
  detail: 'Agent anomaly detected'
});

// Query all entries
const all = store.query();
console.log(`Total: ${all.total}, Entries: ${all.entries.length}`);

// Close when done
store.close();
```

### Filtering

```javascript
// Filter by agent
const agentAlerts = store.query({
  agentId: 'agent1',
  limit: 10
});

// Filter by type
const firedAlerts = store.query({
  type: 'fired',
  limit: 20
});

// Filter by timestamp
const recentAlerts = store.query({
  since: '2026-03-03T00:00:00Z',
  limit: 50
});

// Combined filters with pagination
const results = store.query({
  agentId: 'agent1',
  type: 'fired',
  since: '2026-03-01T00:00:00Z',
  limit: 10,
  offset: 0
});
```

### API Reference

#### Constructor

```javascript
new AnomalyHistoryStore(options)
```

**Options:**
- `dbPath` (required): Path to SQLite database file
- `legacyJsonlPath` (optional): Path to legacy JSONL file for one-time migration

#### append(entry)

Append an alert entry to the history.

**Parameters:**
- `entry.type` (string): Entry type ('fired', 'resolved', etc.)
- `entry.agentId` (string): Agent identifier
- `entry.taskCategory` (string): Task category
- `entry.severity` (string): Alert severity
- `entry.firedAt` (string): ISO timestamp when alert fired
- `entry.resolvedAt` (string): ISO timestamp when alert resolved
- `entry.*`: Additional fields stored in data blob

**Returns:** Persisted entry with generated `id`

#### query(filters)

Query alert history with optional filtering.

**Filters:**
- `agentId` (string): Filter by agent ID
- `type` (string): Filter by type
- `category` or `taskCategory` (string): Filter by category
- `since` (string): ISO timestamp lower bound (inclusive)
- `limit` (number): Max results (default 100, max 500)
- `offset` (number): Pagination offset (default 0)

**Returns:** `{ entries: Object[], total: number }`

#### close()

Close the database connection.

## Migration

The store automatically migrates from legacy JSONL format on first open when `legacyJsonlPath` is provided:

1. Checks if JSONL file exists
2. Only migrates if SQLite table is empty
3. Parses JSONL entries and inserts into SQLite
4. Skips malformed lines with warnings
5. Renames JSONL file to `.jsonl.migrated` after success

## Performance

All queries use indexes for efficient access:

- **Timestamp queries**: Use `idx_anomaly_timestamp_desc`
- **Agent queries**: Use `idx_anomaly_agent_timestamp`
- **Type queries**: Use `idx_anomaly_type_timestamp`
- **Combined filters**: Use appropriate composite index

Query plans confirmed with `EXPLAIN QUERY PLAN` show all queries use index SEARCH (not SCAN).

## Testing

Run tests with:

```bash
node src/orchestrator/anomaly-history-store.test.js
```

Tests cover:
- Basic append and query
- Filtering (agentId, type, timestamp)
- Pagination
- JSONL migration
- Data field preservation
- Index efficiency
