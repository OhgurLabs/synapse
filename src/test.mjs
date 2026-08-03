import './lifecycle.test';

/**
* Stub test entry point that runs any *.test.js files found in the orchestrator directory.
*/
test('Run all existing orchestrator tests', async ({pass}) => {
  // All tests should have already been run by their individual imports above.
  pass();
});