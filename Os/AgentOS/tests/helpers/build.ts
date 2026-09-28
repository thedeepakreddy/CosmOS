import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..', '..');
const DIST_ENTRY = path.join(REPO, 'dist', 'index.js');

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/**
 * Ensure `dist/` reflects the current `src/`.
 *
 * Multi-process tests spawn plain `node` against the COMPILED output rather
 * than running TypeScript through `tsx`. That is both stronger evidence (the
 * artifact under test is the one that ships) and far cheaper: `tsx` opens an
 * IPC pipe per process, and spawning ~100 of them exhausted the temp directory
 * with `listen ENOSPC` under full-suite load.
 *
 * Rebuilds only when stale, so the common case costs one stat sweep. A stale
 * dist can never be silently tested.
 */
export function ensureBuilt(): void {
  const srcNewest = newestMtime(path.join(REPO, 'src'));
  const distMtime = fs.existsSync(DIST_ENTRY) ? fs.statSync(DIST_ENTRY).mtimeMs : 0;
  if (distMtime >= srcNewest) return;

  // vitest runs files in parallel forks. Two concurrent `tsc` invocations can
  // leave a half-written dist/, so take an exclusive lock; the loser waits and
  // then finds the build already done.
  const lock = path.join(REPO, 'dist.build.lock');
  for (let i = 0; i < 600; i++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        const current = fs.existsSync(DIST_ENTRY) ? fs.statSync(DIST_ENTRY).mtimeMs : 0;
        if (current < srcNewest) {
          execFileSync('npm', ['run', 'build'], { cwd: REPO, stdio: 'pipe' });
        }
        return;
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lock); } catch { /* already gone */ }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Someone else is building. Wait, then re-check.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      const current = fs.existsSync(DIST_ENTRY) ? fs.statSync(DIST_ENTRY).mtimeMs : 0;
      if (current >= srcNewest) return;
    }
  }
  throw new Error('ensureBuilt: timed out waiting for the build lock');
}

export const DIST_DIR = path.join(REPO, 'dist');
