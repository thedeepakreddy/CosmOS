/**
 * @research-os/sdk — the client applications code against.
 *
 * Types come from `@research-os/contracts`, the same definitions the server
 * validates with, so an API change breaks compilation rather than production.
 * An application needs nothing from ResearchOS but this package.
 */
export * from "./client.ts";
