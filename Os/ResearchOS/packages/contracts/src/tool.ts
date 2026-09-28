import { z } from "zod";
import { IsoDateTime, Metadata } from "./primitives.ts";

/**
 * Tool contracts.
 *
 * A tool is anything the research engine can invoke to affect or observe the
 * world. Tools may run in-process (a PDF parser) or be fulfilled by an external
 * executor over the network (a browser driven by a host application). Callers
 * do not know which, and must not care.
 */

export const TOOL_CAPABILITIES = [
  "web_search",
  "web_fetch",
  "browser",
  "pdf_read",
  "document_parse",
  "filesystem_read",
  "filesystem_write",
  "code_execution",
  "python",
  "terminal",
  "database_query",
  "http_request",
  "vector_search",
  "dataset_access",
  "git",
  "academic_search",
  "computer_control",
  "application_control",
] as const;
export const ToolCapability = z.enum(TOOL_CAPABILITIES);
export type ToolCapability = z.infer<typeof ToolCapability>;

/**
 * Risk tier. Determines whether a call can proceed automatically, needs an
 * explicit grant, or must be surfaced to a human. Model output never decides
 * its own tier — the registry assigns it.
 */
export const TOOL_RISK_LEVELS = ["read_only", "side_effecting", "privileged"] as const;
export const ToolRiskLevel = z.enum(TOOL_RISK_LEVELS);
export type ToolRiskLevel = z.infer<typeof ToolRiskLevel>;

export const ToolDescriptor = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  capability: ToolCapability,
  riskLevel: ToolRiskLevel,
  /** JSON Schema generated from the tool's zod input schema. */
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  /** "local" when executed in-process, otherwise the executor id fulfilling it. */
  provider: z.string().max(100),
  /** Whether results for identical input may be reused. */
  cacheable: z.boolean().default(false),
  estimatedLatencyMs: z.number().int().nonnegative().default(1000),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const ToolCallStatus = z.enum(["succeeded", "failed", "denied", "timed_out"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const ToolCallRecord = z.object({
  id: z.string(),
  projectId: z.string(),
  toolId: z.string(),
  capability: ToolCapability,
  input: z.unknown(),
  output: z.unknown().nullable(),
  status: ToolCallStatus,
  errorMessage: z.string().max(4000).nullable(),
  durationMs: z.number().int().nonnegative(),
  /** Executor that fulfilled the call, when it was not local. */
  executorId: z.string().nullable(),
  requestedByRunId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

/**
 * The permission envelope a tool call is evaluated against.
 *
 * Agents are treated as untrusted actors: a call is denied unless the policy
 * explicitly allows the tool, its capability and its risk level. Default-deny
 * is the whole point.
 */
export const ToolPermissionPolicy = z.object({
  /** Empty means "no tools" — never "all tools". */
  allowedToolIds: z.array(z.string()).default([]),
  allowedCapabilities: z.array(ToolCapability).default([]),
  maxRiskLevel: ToolRiskLevel.default("read_only"),
  /** Host allowlist for network-capable tools. Empty means any host not blocked. */
  allowedDomains: z.array(z.string()).default([]),
  blockedDomains: z.array(z.string()).default([]),
  /** Filesystem roots a filesystem tool may touch. Empty means none. */
  allowedPathRoots: z.array(z.string()).default([]),
  maxCallsPerTask: z.number().int().positive().default(25),
  maxConcurrentCalls: z.number().int().positive().default(4),
  metadata: Metadata.default({}),
});
export type ToolPermissionPolicy = z.infer<typeof ToolPermissionPolicy>;
