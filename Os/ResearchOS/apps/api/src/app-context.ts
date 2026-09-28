/**
 * The API's view of a running ResearchOS.
 *
 * The runtime — database, model router, tools, engine — is assembled by
 * `@research-os/research-core`, which both this process and the worker share.
 * This adds only what a network-facing process needs on top of it.
 */
import { buildRuntime, type BuildRuntimeOptions, type Runtime } from "@research-os/research-core";
import type { ApiConfig } from "./config.ts";

export interface AppContext extends Runtime {
  readonly config: ApiConfig;
}

export async function buildContext(config: ApiConfig, options: BuildRuntimeOptions = {}): Promise<AppContext> {
  const runtime = await buildRuntime(config, options);
  return { ...runtime, config };
}
