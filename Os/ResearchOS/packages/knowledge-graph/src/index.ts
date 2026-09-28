/**
 * @research-os/knowledge-graph — provenance you can walk.
 *
 * Projects research state into a uniform node/edge graph, traverses it to answer
 * "where did this conclusion come from?", and projects the research tree that
 * records what each finding opened up.
 *
 * Pure throughout: state in, graph out. Storage lives behind `GraphStore`.
 */
export * from "./store.ts";
export * from "./identity.ts";
export * from "./project.ts";
export * from "./traverse.ts";
export * from "./tree.ts";
