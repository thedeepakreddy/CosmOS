/**
 * @research-os/verification — narrow checks that can be trusted.
 *
 * Does the quote appear in the source, do the numbers match, does the arithmetic
 * hold, is the claim traceable to anything, do two accepted claims conflict.
 * Every check here is mechanical and exact. There is deliberately no general
 * "is this correct?" check — a broad judgement from a model is the unearned
 * confidence this package exists to guard against.
 */
export * from "./citation.ts";
export * from "./numeric.ts";
export * from "./verifier.ts";
