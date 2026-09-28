/**
 * @research-os/events — the domain event layer.
 *
 * Port plus in-process adapter. Deliberately not backed by a message broker:
 * the abstraction exists so one can be introduced when there is a reason,
 * without that decision being forced now.
 */
export * from "./bus.ts";
export * from "./store.ts";
export * from "./stream.ts";
