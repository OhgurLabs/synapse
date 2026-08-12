/**
 * RETIRED path — do not use.
 *
 * There used to be two classes named `AgentMemoryStore`:
 *   - this file (legacy, no cross-process locks, different hash shape)
 *   - src/orchestrator/agent-memory-store.js (production)
 *
 * Same-name dual classes already caused a production incident class of bug
 * (see e69a94a0 / 0db86534). Production and all tests import the orchestrator
 * module. This file now fails hard so a mistaken import cannot silently write
 * to the wrong storage semantics.
 *
 * @deprecated Import from `src/orchestrator/agent-memory-store.js` instead.
 */

export class AgentMemoryStore {
  constructor() {
    throw new Error(
      'src/agents/memory-store.js is retired. ' +
      'Import AgentMemoryStore from src/orchestrator/agent-memory-store.js',
    );
  }
}
