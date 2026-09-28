/**
 * @research-os/evidence — how much a piece of evidence is worth.
 *
 * Pure functions over contract types, with no I/O and no model calls. That is
 * deliberate: the scoring rules are the part of ResearchOS that most needs to be
 * auditable and regression-tested, so they are kept free of dependencies that
 * would make them hard to test.
 */
export * from "./source-quality.ts";
export * from "./evidence-strength.ts";
export * from "./independence.ts";
