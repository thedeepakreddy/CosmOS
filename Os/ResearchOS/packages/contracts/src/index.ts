/**
 * @research-os/contracts — the stable surface.
 *
 * Every boundary in ResearchOS is described here: the domain model, the agent
 * and tool interfaces, the event stream, the external executor protocol and the
 * HTTP API. Applications (Echo, Aira, anything built later) depend on this
 * package and nothing deeper.
 *
 * Rule of thumb: if changing something here would break a client, it belongs
 * here. If it would not, it belongs in the package that owns the behaviour.
 */
export * from "./primitives.ts";
export * from "./project.ts";
export * from "./source.ts";
export * from "./evidence.ts";
export * from "./claim.ts";
export * from "./agent.ts";
export * from "./task.ts";
export * from "./debate.ts";
export * from "./model.ts";
export * from "./tool.ts";
export * from "./executor.ts";
export * from "./memory.ts";
export * from "./graph.ts";
export * from "./experiment.ts";
export * from "./verification.ts";
export * from "./report.ts";
export * from "./events.ts";
export * from "./api.ts";
