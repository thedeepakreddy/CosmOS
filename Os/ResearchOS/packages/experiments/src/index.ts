/**
 * @research-os/experiments — computational research.
 *
 * The runner port and its adapters, the marker-line convention experiments
 * report metrics through, and the arithmetic that decides whether a result
 * replicated.
 *
 * The default runner refuses to execute. That is deliberate: on a host with no
 * sandbox, `BLOCKED` is the truthful outcome.
 */
export * from "./runner.ts";
export * from "./metrics.ts";
export * from "./local-runner.ts";
export * from "./replication.ts";
