/**
 * @research-os/shared — foundation utilities.
 *
 * Layer 0: depends on nothing else in ResearchOS. Anything added here is
 * visible to every other package, so the bar for inclusion is that it must be
 * genuinely universal and free of domain knowledge.
 */
export * from "./ids.ts";
export * from "./errors.ts";
export * from "./result.ts";
export * from "./clock.ts";
export * from "./retry.ts";
export * from "./assert.ts";
export * from "./json.ts";
export * from "./text.ts";
export * from "./env.ts";
