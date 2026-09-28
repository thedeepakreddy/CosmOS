/**
 * SDK Live Server Test
 *
 * Proves the EvalOS TypeScript SDK communicates correctly with a running server.
 *
 * Usage:
 *   1. Start server:  npm run dev  (or npm start after build)
 *   2. Run test:      npx tsx scripts/sdk_test.ts
 *
 * Expected: All assertions pass, exit 0.
 * On failure: Throws with descriptive error, exit 1.
 */

import { EvalOSClient } from '../sdk';

const BASE_URL = process.env.EVALOS_URL || 'http://127.0.0.1:3000';

async function main() {
  const client = new EvalOSClient({ baseUrl: BASE_URL });

  console.log('SDK Test: Connecting to ' + BASE_URL);

  // 1. Health check
  const healthRes = await fetch(BASE_URL + '/health');
  if (!healthRes.ok) throw new Error('Health check failed: ' + healthRes.statusText);
  const health = await healthRes.json() as any;
  assert(health.status === 'healthy', 'Health status should be healthy');
  console.log('  [PASS] Health check');

  // 2. Create suite via SDK
  const suiteId = 'sdk-test-suite-' + Date.now();
  await client.createSuite({ id: suiteId, name: 'SDK Test Suite', version: '1.0', caseIds: [] });
  console.log('  [PASS] Create suite');

  // 3. Get suite via SDK
  const suite = await client.getSuite(suiteId);
  assert(suite.id === suiteId, 'Suite ID should match');
  assert(suite.name === 'SDK Test Suite', 'Suite name should match');
  console.log('  [PASS] Get suite');

  // 4. Create run via SDK
  const runId = 'sdk-test-run-' + Date.now();
  await client.createRun({
    id: runId,
    suiteId: suiteId,
    suiteVersion: '1.0',
    candidateId: 'sdk-test-candidate',
    candidateVersion: '1.0',
  });
  console.log('  [PASS] Create run');

  // 5. Get scores (should be empty for a new run)
  const results = await client.getRunResults(runId);
  assert(Array.isArray(results.scores), 'Scores should be an array');
  assert(results.scores.length === 0, 'New run should have 0 scores');
  console.log('  [PASS] Get run results');

  // 6. Wrong server test — should fail gracefully
  const badClient = new EvalOSClient({ baseUrl: 'http://127.0.0.1:19999' });
  let didFail = false;
  try {
    await badClient.getSuite('nonexistent');
  } catch {
    didFail = true;
  }
  assert(didFail, 'Request to wrong port should throw');
  console.log('  [PASS] Wrong port fails gracefully');

  console.log('');
  console.log('SDK Test: ALL PASSED');
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error('Assertion failed: ' + message);
}

main().catch((err) => {
  console.error('SDK Test FAILED:', err.message);
  process.exit(1);
});
