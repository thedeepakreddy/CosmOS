/**
 * API configuration.
 *
 * Extends the runtime configuration every ResearchOS process shares with the
 * settings only a network-facing one needs. Split that way so the worker cannot
 * accidentally depend on an HTTP concern, and so both processes read the same
 * variables for the things they have in common.
 */
import { loadRuntimeConfig, type RuntimeConfig } from "@research-os/research-core";
import { readNumber, readOptionalString, readString, readBoolean, type EnvSource } from "@research-os/shared";

export interface ApiConfig extends RuntimeConfig {
  readonly host: string;
  readonly port: number;
  /** Runs a worker in this process. Simpler for small deployments than a separate one. */
  readonly embeddedWorker: boolean;
  readonly corsOrigins: string[];
  /** Bearer tokens accepted on the API. Empty means the API is unauthenticated. */
  readonly apiKeys: string[];
}

export function loadConfig(env: EnvSource = process.env): ApiConfig {
  return {
    ...loadRuntimeConfig(env),
    host: readString(env, "RESEARCH_OS_HOST", "127.0.0.1"),
    port: readNumber(env, "RESEARCH_OS_PORT", 8080),
    embeddedWorker: readBoolean(env, "RESEARCH_OS_EMBEDDED_WORKER", true),
    corsOrigins: splitList(readOptionalString(env, "RESEARCH_OS_CORS_ORIGINS")),
    apiKeys: splitList(readOptionalString(env, "RESEARCH_OS_API_KEYS")),
  };
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}
