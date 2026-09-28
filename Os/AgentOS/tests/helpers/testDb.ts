import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A10: test databases live in the OS temp directory, never the repository root.
 * Previously they accumulated as untracked `agentos-*.db*` files next to the
 * source tree.
 */
export function testDbPath(name: string): string {
  // The pid makes the path unique per test process.
  //
  // With a fixed path, two concurrent runs of the suite (a second CI job, or a
  // developer running `npm test` while another run is in flight) share the same
  // database file. Observed consequence: 78 executions for 50 tasks and zero
  // claim winners -- test-harness cross-contamination that reads exactly like a
  // catastrophic ownership regression.
  return path.join(os.tmpdir(), `agentos-test-${name}-${process.pid}.db`);
}

/** A scratch file path, unique per test process, for non-database artefacts. */
export function testArtifactPath(name: string): string {
  return path.join(os.tmpdir(), `agentos-test-${name}-${process.pid}`);
}

/** Remove a SQLite database and its WAL/SHM sidecars. */
export function removeDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* not present */
    }
  }
}
