/**
 * @research-os/executors — how an external execution layer attaches.
 *
 * ResearchOS requests a capability; an executor registered for that capability
 * fulfils it in its own environment and posts a result back. Neither side
 * imports the other, and nothing here names a specific host application — the
 * architecture linter fails the build if that ever changes.
 */
export * from "./service.ts";
export * from "./tool-provider.ts";
