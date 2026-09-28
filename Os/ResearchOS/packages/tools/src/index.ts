/**
 * @research-os/tools — capability, not implementation.
 *
 * The port a tool implements, the provider seam an external capability layer
 * attaches through, and the registry that makes every call pass a permission
 * decision, a budget check and an audit record before it happens.
 */
export * from "./tool.ts";
export * from "./permissions.ts";
export * from "./provider.ts";
export * from "./registry.ts";
export * from "./builtin/web-fetch.ts";
