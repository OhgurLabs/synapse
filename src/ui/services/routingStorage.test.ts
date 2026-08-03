// src/ui/services/routingStorage.test.ts
// Basic integration test for TypeScript routing storage service

import * as routingStorage from './routingStorage';
import { DispatchDecision } from '../types/routing';

/**
 * Test that the TypeScript API surface matches expectations.
 * This is a compile-time verification test - if it compiles, the types are correct.
 */
function verifyTypeSignatures() {
  // Verify init() returns Promise<void>
  const initResult: Promise<void> = routingStorage.init();

  // Verify getDecisions() returns Promise<DispatchDecision[]>
  const decisionsPromise: Promise<DispatchDecision[]> = routingStorage.getDecisions();

  // Verify getDecisions() accepts optional params
  const filteredPromise: Promise<DispatchDecision[]> = routingStorage.getDecisions({
    agentId: 'agent123',
    campaignId: 'camp456',
    limit: 50,
    offset: 10,
    category: 'analysis',
    since: '2026-03-01T00:00:00Z',
  });

  // Verify getDecisions() accepts forceRefresh parameter
  const refreshedPromise: Promise<DispatchDecision[]> = routingStorage.getDecisions({}, true);

  // Verify refresh() returns Promise<DispatchDecision[]>
  const refreshPromise: Promise<DispatchDecision[]> = routingStorage.refresh();

  // Verify clearCache() returns void
  const clearResult: void = routingStorage.clearCache();

  // Verify clearCache() accepts optional params
  const clearWithParamsResult: void = routingStorage.clearCache({ agentId: 'agent123' });

  // Verify isLoading() returns boolean
  const loadingState: boolean = routingStorage.isLoading();

  // Verify isLoading() accepts optional params
  const loadingStateWithParams: boolean = routingStorage.isLoading({ campaignId: 'camp1' });

  // Verify getError() returns string | null
  const error: string | null = routingStorage.getError();

  // Verify getError() accepts optional params
  const errorWithParams: string | null = routingStorage.getError({ agentId: 'agent1' });

  // Verify warmCache() returns Promise<void>
  const warmPromise: Promise<void> = routingStorage.warmCache();

  // Verify ready() returns Promise<void> | null
  const readyPromise: Promise<void> | null = routingStorage.ready();

  console.log('Type verification complete');
}

/**
 * Runtime test to verify basic functionality (requires mock or live API).
 * This would be expanded in a full test suite with proper mocking.
 */
async function basicFunctionalityTest() {
  console.log('Running basic functionality test...');

  // Initialize (returns a promise; await it so cache warming finishes)
  await routingStorage.init();

  // Verify initial state
  const isLoadingBefore = routingStorage.isLoading();
  console.log(`Initial loading state: ${isLoadingBefore}`);

  const errorBefore = routingStorage.getError();
  console.log(`Initial error state: ${errorBefore}`);

  // Clear cache
  routingStorage.clearCache();
  console.log('Cache cleared successfully');

  console.log('Basic functionality test complete');
}

// Export test functions for integration testing
export { verifyTypeSignatures, basicFunctionalityTest };

// If run directly (for manual testing)
if (require.main === module) {
  verifyTypeSignatures();
  basicFunctionalityTest().catch(console.error);
}
