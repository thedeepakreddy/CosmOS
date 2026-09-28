import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Phase H: the certification suite.
 *
 * The audit's most damaging structural finding was not a bug in the code -- it
 * was that the v0.1 certification rested on evidence that COULD NOT FAIL:
 * `tests/resumability.node.js` was in no npm script, was not collected by
 * vitest, swallowed every error, and exited 0. It errored when the auditor ran
 * it, and still reported success.
 *
 * This file exists so that cannot recur. Every claim AgentOS makes is listed
 * here against the test that proves it. If a proving test is deleted, renamed,
 * or quietly skipped, certification FAILS -- the manifest is checked against the
 * real suite, not against itself.
 */
const REPO = path.join(__dirname, '..');

interface Claim {
  /** What AgentOS asserts about itself. */
  claim: string;
  /** Which audit finding this closes. */
  finding: string;
  /** The test file that proves it. */
  file: string;
  /** A distinctive fragment of the proving test's name. */
  test: string;
}

/**
 * The claims. Adding a capability without adding a row here is fine; asserting
 * a capability in a report without a row here is what this prevents.
 */
const CLAIMS: Claim[] = [
  // ---- Phase A ----
  { claim: 'Duplicate task ids within a graph are rejected before persistence',
    finding: 'P0-2 silent task loss', file: 'tests/validation.test.ts',
    test: 'persists nothing' },
  { claim: 'Timeout handles do not accumulate',
    finding: 'P1-5 timer leak', file: 'tests/timeout-handles.test.ts',
    test: 'does not accumulate timeout handles' },
  { claim: 'A zero-valued budget means zero, not unset',
    finding: 'P1-4 zero-budget bypass', file: 'tests/budget.test.ts',
    test: 'zero allowed, so any task is rejected' },
  { claim: 'Concurrent cold boot does not crash workers',
    finding: 'P1-1 migration race', file: 'tests/migration-concurrency.test.ts',
    test: '6 simultaneous processes' },
  { claim: 'The package is importable by an external consumer',
    finding: 'P2 broken package entry point', file: 'tests/package-exports.test.ts',
    test: 'exposes the public API' },

  // ---- Phase B ----
  { claim: 'Task ids are run-scoped; two runs may reuse an id safely',
    finding: 'P0-1 cross-run corruption', file: 'tests/identity.test.ts',
    test: 'without colliding' },
  { claim: 'A task claim is atomic: exactly one winner under real contention',
    finding: 'P0-3 duplicate execution', file: 'tests/claim-protocol.test.ts',
    test: '20 processes race for one task' },
  { claim: 'Multiple OS processes never execute the same task simultaneously',
    finding: 'P0-3 duplicate execution', file: 'tests/multiprocess.test.ts',
    test: 'zero duplicate execution' },
  { claim: 'A healthy worker\'s task is never stolen',
    finding: 'P0-3 blind RUNNING->READY reset', file: 'tests/claim-protocol.test.ts',
    test: 'live lease cannot be stolen' },
  { claim: 'A stale fence cannot overwrite a newer attempt',
    finding: 'P0-3 no fencing', file: 'tests/claim-protocol.test.ts',
    test: 'old fence rejected, new fence canonical' },
  { claim: 'Calling start twice does not redispatch in-flight work',
    finding: 'P0-4 double-start duplication', file: 'tests/lifecycle.test.ts',
    test: 'does NOT redispatch' },
  { claim: 'A crashed worker\'s abandoned work is reclaimed, completed work is not repeated',
    finding: 'P0-3 crash recovery', file: 'tests/multiprocess.test.ts',
    test: 'SIGKILLed worker loses its lease' },
  { claim: 'A v0.1 database migrates forward with no data loss',
    finding: 'B2 forward migration', file: 'tests/migration-forward.test.ts',
    test: 'no data loss' },

  // ---- Phase C ----
  { claim: 'Cancelling a run aborts in-flight work and nothing resurrects',
    finding: 'P0-5 cosmetic cancellation', file: 'tests/cancellation.test.ts',
    test: 'nothing resurrects' },
  { claim: 'A terminal run leaves no task non-terminal',
    finding: 'P1-7 stranded tasks', file: 'tests/cancellation.test.ts',
    test: 'no task is left non-terminal' },
  { claim: 'Retries back off instead of hot-looping',
    finding: 'P1-8 retry storm', file: 'tests/retry-policy.test.ts',
    test: 'measured gaps are no longer' },
  { claim: 'A timed-out task honours its retry policy',
    finding: 'P1-8 timeouts never retried', file: 'tests/retry-policy.test.ts',
    test: 'honours retriesAllowed' },
  { claim: 'Terminal states have no outgoing transitions',
    finding: 'P1-7 unguarded state machine', file: 'tests/state-machines.test.ts',
    test: 'NO outgoing transitions' },
  { claim: 'A malformed executor result yields a diagnostic, not a null error',
    finding: 'P2 swallowed executor faults', file: 'tests/retry-policy.test.ts',
    test: 'readable error' },

  // ---- Phase D ----
  { claim: 'Per-task scheduling cost does not grow with run size',
    finding: 'P1-2 O(n^2) scheduler', file: 'tests/scheduler-scaling.test.ts',
    test: 'no return to quadratic' },
  { claim: 'Scheduling hot paths are index-backed',
    finding: 'P1-2 unindexed table scan', file: 'tests/scheduler-scaling.test.ts',
    test: 'index-backed' },

  // ---- Phase E ----
  { claim: 'Endpoints require authentication when tokens are configured',
    finding: 'P0-6 no authentication', file: 'tests/security.test.ts',
    test: 'rejects a request with no credentials' },
  { claim: 'No error response discloses internals',
    finding: 'P0-6 SQLite error leak', file: 'tests/security.test.ts',
    test: 'leaks nothing' },
  { claim: 'Wrong types are rejected, not coerced',
    finding: 'P1-9 AJV coercion', file: 'tests/security.test.ts',
    test: 'REJECTED, not silently coerced' },
  { claim: 'Task listings are paginated',
    finding: 'P2 unbounded responses', file: 'tests/api-hardening.test.ts',
    test: 'bounded page' },
  { claim: 'The SDK covers every route',
    finding: 'P2 SDK parity gap', file: 'tests/api-hardening.test.ts',
    test: 'every route has an SDK method' },

  // ---- Phase F ----
  { claim: 'Every emitted event is declared, schema-valid and gap-free',
    finding: 'Observability 2/10', file: 'tests/observability.test.ts',
    test: 'no sequence gaps' },
  { claim: 'A failed run is explainable from telemetry alone',
    finding: 'Observability success criterion', file: 'tests/observability.test.ts',
    test: 'SUCCESS CRITERION' },
  { claim: 'Each execution attempt is recorded durably with its duration',
    finding: 'No attempt history', file: 'tests/observability.test.ts',
    test: 'one durable row per real execution' },

  // ---- Phase G ----
  { claim: 'Agent instances are persisted and pinned to a definition version',
    finding: 'Agent lifecycle NOT_FOUND', file: 'tests/agent-runtime.test.ts',
    test: 'pinned to the exact definition version' },
  { claim: 'Definition versions coexist',
    finding: 'Versioning was fiction', file: 'tests/agent-runtime.test.ts',
    test: 'does not destroy v1' },
  { claim: 'maxModelCalls, maxToolCalls and maxCostUsd are enforced',
    finding: 'Budgets declared with zero code references', file: 'tests/agent-runtime.test.ts',
    test: 'maxCostUsd is enforced' },
  { claim: 'Two agent types run from configuration alone',
    finding: 'Phase G success criterion', file: 'tests/agent-runtime.test.ts',
    test: 'SUCCESS CRITERION' },

  // ---- Phase H ----
  { claim: 'A handoff carries context between agents',
    finding: 'messages table had zero code references', file: 'tests/distributed.test.ts',
    test: 'HANDOFF carries context' },
  { claim: 'The rate-limit ceiling is shared across workers',
    finding: 'Phase E limiter was per-process', file: 'tests/distributed.test.ts',
    test: 'shared, not per-process' },
  { claim: 'A standalone worker drains work with no HTTP server',
    finding: 'Distributed workers ARCHITECTURAL', file: 'tests/distributed.test.ts',
    test: 'no HTTP server involved' }
];

describe('Certification manifest (Phase H)', () => {
  const sourceOf = new Map<string, string>();
  const read = (file: string): string => {
    if (!sourceOf.has(file)) {
      sourceOf.set(file, fs.readFileSync(path.join(REPO, file), 'utf-8'));
    }
    return sourceOf.get(file)!;
  };

  it('every claim names a test file that exists', () => {
    for (const c of CLAIMS) {
      expect(fs.existsSync(path.join(REPO, c.file)), `${c.claim}: missing ${c.file}`).toBe(true);
    }
  });

  it('every claim maps to a test that actually exists in that file', () => {
    const missing = CLAIMS.filter((c) => !read(c.file).includes(c.test));
    expect(
      missing.map((c) => `${c.file} has no test matching "${c.test}" (claim: ${c.claim})`)
    ).toEqual([]);
  });

  it('no proving test is skipped', () => {
    // A claim proven by `it.skip` is not proven.
    for (const c of CLAIMS) {
      const src = read(c.file);
      for (const skipped of ['it.skip(', 'describe.skip(', 'it.todo(']) {
        expect(src.includes(skipped), `${c.file} contains ${skipped}`).toBe(false);
      }
    }
  });

  it('every proving test file is collected by the test runner', () => {
    // `tests/resumability.node.js` was in NO npm script and outside vitest's
    // include pattern -- which is precisely how it became uncertifiable.
    for (const c of CLAIMS) {
      expect(c.file.endsWith('.test.ts'), `${c.file} is not collected by vitest`).toBe(true);
    }
  });

  it('the crash-recovery script is wired into a gating script and can fail', () => {
    const pkg = JSON.parse(read('package.json'));
    // It must be runnable...
    expect(pkg.scripts['test:recovery']).toContain('resumability.node.js');
    // ...included in the composed gate...
    expect(pkg.scripts.verify).toContain('test:recovery');
    // ...and it must NOT swallow errors the way v0.1 did. Comments are stripped
    // first: this file and that one both DESCRIBE the old anti-pattern, and
    // matching prose would be a false positive.
    const src = read('tests/resumability.node.js');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code, 'the recovery script still swallows errors').not.toContain('.catch(console.error)');
    expect(code).toContain('process.exit(1)');
    expect(code).toContain('assert');
  });

  it('verify composes the mandatory gates and is not decorative', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const gate of ['build', 'typecheck', 'lint', 'test']) {
      expect(pkg.scripts.verify, `verify omits ${gate}`).toContain(gate);
    }
  });

  it('the manifest covers every phase', () => {
    const byFile = new Set(CLAIMS.map((c) => c.file));
    for (const required of [
      'tests/validation.test.ts',      // A
      'tests/claim-protocol.test.ts',  // B
      'tests/multiprocess.test.ts',    // B
      'tests/cancellation.test.ts',    // C
      'tests/scheduler-scaling.test.ts', // D
      'tests/security.test.ts',        // E
      'tests/observability.test.ts',   // F
      'tests/agent-runtime.test.ts',   // G
      'tests/distributed.test.ts'      // H
    ]) {
      expect(byFile, `no claim is proven by ${required}`).toContain(required);
    }
    expect(CLAIMS.length).toBeGreaterThanOrEqual(35);
  });

  it('AgentOS depends on no model or tool vendor', () => {
    // The audit's strongest architectural finding was provider neutrality.
    const pkg = JSON.parse(read('package.json'));
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const vendor of ['openai', '@anthropic-ai/sdk', 'langchain', 'cohere-ai', 'ollama', '@mistralai/mistralai']) {
      expect(deps, `runtime dependency on ${vendor}`).not.toContain(vendor);
    }
    // And the boundary is enforced, not merely observed.
    expect(read('.eslintrc.js')).toContain('provider-neutral');
  });

  it('SELF-TEST: the manifest detects a claim whose test has vanished', () => {
    // Without this, the manifest could pass vacuously. A claim pointing at a
    // test name that does not exist MUST be detected.
    const bogus: Claim = {
      claim: 'a claim nobody proves', finding: 'none',
      file: 'tests/validation.test.ts', test: 'this test name does not exist anywhere'
    };
    expect(read(bogus.file).includes(bogus.test)).toBe(false);
  });
});
