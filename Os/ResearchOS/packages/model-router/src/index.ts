/**
 * @research-os/model-router — model neutrality.
 *
 * Agents ask for a *kind of work*; the router decides which model does it,
 * handles failure, and accounts for the cost. No package above this one names a
 * vendor, which is what makes swapping or adding a provider a configuration
 * change rather than a rewrite.
 */
export * from "./provider.ts";
export * from "./catalog.ts";
export * from "./policy.ts";
export * from "./adaptive.ts";
export * from "./router.ts";
export * from "./anthropic-provider.ts";
export * from "./gemini-provider.ts";
export * from "./unconfigured-provider.ts";
export * from "./scripted-provider.ts";
