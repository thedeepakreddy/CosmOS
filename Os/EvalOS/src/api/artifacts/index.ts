import * as path from 'path';
import * as fs from 'fs/promises';
import { config } from '../../config';

export class ArtifactManager {
  private baseDir: string;

  constructor(baseDir: string = config.ARTIFACT_DIR) {
    this.baseDir = path.resolve(baseDir);
  }

  async ensureReady() {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  getSafePath(requestedPath: string): string {
    const resolvedPath = path.resolve(this.baseDir, requestedPath);
    if (!resolvedPath.startsWith(this.baseDir)) {
      throw new Error('Path traversal detected');
    }
    return resolvedPath;
  }

  async saveArtifact(filename: string, content: Buffer | string): Promise<string> {
    const safePath = this.getSafePath(filename);
    await fs.writeFile(safePath, content);
    return safePath;
  }
}
