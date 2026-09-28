#!/usr/bin/env node
/**
 * Preload that loads `.env` into `process.env`.
 *
 * Used as `node --import ./scripts/register.mjs <script>`, so the environment
 * is populated before any module that reads it is evaluated.
 *
 * Real environment variables always win over the dotfile. A value exported in
 * a shell, set by a container or injected by a secret manager must not be
 * silently overridden by a stale `.env` that happens to be lying in the
 * working directory — that failure is invisible and costs an afternoon.
 *
 * Precedence, lowest to highest: `.env`, then `.env.local`, then the real
 * environment.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "@research-os/shared";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const filename of [".env", ".env.local"]) {
  const path = join(root, filename);
  if (!existsSync(path)) continue;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(path, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
