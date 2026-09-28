/**
 * @research-os/evaluation — was this research conducted well?
 *
 * A rubric over stored artifacts: traceability, verification, breadth, scrutiny,
 * contradiction handling, calibration, transparency, reproducibility.
 *
 * Deliberately *not* an answer to "is the conclusion correct?" — nothing here
 * knows that, and a component claiming to would be the most dangerous in the
 * codebase. Pure arithmetic, no models: a model grading research produced by
 * models mostly measures how convincing the output reads.
 */
export * from "./rubric.ts";
