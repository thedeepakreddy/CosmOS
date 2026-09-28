import { describe, it, expect } from 'vitest';
import { ArtifactManager } from '../../src/api/artifacts';

describe('ArtifactManager', () => {
  it('prevents path traversal', () => {
    const manager = new ArtifactManager('/tmp/evalos-artifacts');
    expect(() => manager.getSafePath('../out.txt')).toThrow('Path traversal detected');
    expect(() => manager.getSafePath('../../etc/passwd')).toThrow('Path traversal detected');
  });

  it('allows safe paths', () => {
    const manager = new ArtifactManager('/tmp/evalos-artifacts');
    const p = manager.getSafePath('run-1/log.txt');
    expect(p).toBe('/tmp/evalos-artifacts/run-1/log.txt');
  });
});
