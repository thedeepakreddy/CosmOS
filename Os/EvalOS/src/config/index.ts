import { z } from 'zod';
import * as path from 'path';

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().default(path.join(process.cwd(), 'evalos.db')),
  ARTIFACT_DIR: z.string().default(path.join(process.cwd(), 'artifacts/runtime')),
  MAX_CONCURRENCY: z.coerce.number().default(4),
  PAYLOAD_LIMIT: z.coerce.number().default(10485760), // 10MB
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse(env);
}

export const config = loadConfig(process.env);
