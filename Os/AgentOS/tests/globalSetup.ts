import { ensureBuilt } from './helpers/build';

/**
 * Build once, before any test file runs.
 *
 * Several suites spawn plain `node` against the compiled artifact. Letting each
 * suite build on demand races: vitest runs files in parallel forks, so two of
 * them can invoke `tsc` concurrently and one observes a half-written `dist/`.
 * globalSetup runs exactly once in the main process.
 */
export default function setup(): void {
  ensureBuilt();
}
