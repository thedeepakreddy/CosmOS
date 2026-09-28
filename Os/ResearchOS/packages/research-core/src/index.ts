/**
 * @research-os/research-core — the research engine.
 *
 * Agents, the debate engine, the task handlers that connect them to the durable
 * queue, the report builder, and the composition root that wires a deployment
 * together.
 *
 * This is the only layer that knows what research *means*. Everything beneath it
 * knows how to store, route, execute or verify; nothing beneath it knows what a
 * claim is for.
 */
export * from "./agent.ts";
export * from "./deps.ts";
export * from "./debate.ts";
export * from "./report.ts";
export * from "./engine.ts";
export * from "./runtime.ts";
export * from "./evaluate.ts";

export * from "./agents/research-director.ts";
export * from "./agents/evidence-agent.ts";
export * from "./agents/claim-extractor.ts";
export * from "./agents/skeptic.ts";
export * from "./agents/judge.ts";
export * from "./agents/synthesizer.ts";
export * from "./agents/data-analyst.ts";
export * from "./agents/experimenter.ts";
export * from "./agents/hypothesis-generator.ts";
export * from "./agents/question-decomposer.ts";
export * from "./agents/evolution.ts";

export * from "./handlers/support.ts";
export * from "./handlers/planning.ts";
export * from "./handlers/discovery.ts";
export * from "./handlers/evidence.ts";
export * from "./handlers/claims.ts";
export * from "./handlers/report.ts";
export * from "./handlers/evolution.ts";
export * from "./handlers/debate.ts";
export * from "./handlers/experiments.ts";
export * from "./handlers/linking.ts";
