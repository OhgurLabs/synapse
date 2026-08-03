// Re-export the SQLite-backed DispatchLog from the main module
// This file is imported by integration tests for consistency
export { DispatchLog, createDispatchLog, default } from '../dispatch-log.js';
