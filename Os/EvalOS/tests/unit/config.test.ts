import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config';

describe('Configuration', () => {
  it('should load default configuration successfully', () => {
    const config = loadConfig({});
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.DATABASE_URL).toContain('evalos.db');
  });

  it('should reject invalid PORT type', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow();
  });

  it('should override with valid environment variables', () => {
    const config = loadConfig({ PORT: '8080', NODE_ENV: 'production' });
    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('production');
  });
});
