/**
 * The ResearchTool port.
 *
 * A tool is anything the engine can invoke to observe or affect the world. It
 * may run in this process or be fulfilled by an external executor over the
 * network; callers cannot tell, and that is the point — it is what lets a host
 * application supply the hands without either codebase importing the other.
 *
 * Two rules hold for every tool:
 *
 *   - **Input is validated before execution**, against the tool's own schema.
 *     A tool's input usually comes from a model, which makes it untrusted.
 *   - **Retrieved content carries its provenance.** A tool that fetches
 *     something returns where it came from and when, so a claim built on it can
 *     be traced back to a source rather than to "the model said so".
 */
import type { ToolCapability, ToolDescriptor, ToolRiskLevel } from "@research-os/contracts";
import type { Logger } from "@research-os/observability";
import type { z } from "zod";
import type { ToolPermissionPolicy } from "@research-os/contracts";

/** Everything a tool is allowed to know about the run invoking it. */
export interface ToolContext {
  readonly projectId: string;
  readonly taskId?: string | null;
  readonly agentRunId?: string | null;
  /** The envelope this call is evaluated against. Tools re-check what they own. */
  readonly policy: ToolPermissionPolicy;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

/**
 * Where a piece of retrieved content came from.
 *
 * Not optional decoration. Provenance is what separates a source-derived fact
 * from a model inference, and a tool that drops it makes that distinction
 * unrecoverable downstream.
 */
export interface ToolProvenance {
  readonly url?: string;
  readonly retrievedAt: string;
  readonly statusCode?: number;
  readonly contentType?: string;
  /** Hash of the normalised content, for deduplication and change detection. */
  readonly contentHash?: string;
  readonly bytes?: number;
}

export interface ResearchTool<Input = unknown, Output = unknown> {
  readonly descriptor: ToolDescriptor;
  /** Validated before `execute` is called. Never trust the caller. */
  readonly inputSchema: z.ZodType<Input>;
  execute(input: Input, context: ToolContext): Promise<Output>;
}

/** A tool outcome as the registry reports it. Denials are outcomes, not exceptions. */
export type ToolOutcome<Output = unknown> =
  | { readonly status: "succeeded"; readonly output: Output; readonly durationMs: number; readonly toolId: string; readonly provider: string }
  | { readonly status: "failed" | "denied" | "timed_out"; readonly errorCode: string; readonly errorMessage: string; readonly durationMs: number; readonly toolId: string; readonly provider: string };

export const RISK_ORDER: Record<ToolRiskLevel, number> = {
  read_only: 0,
  side_effecting: 1,
  privileged: 2,
};

/** Capabilities that reach the network, and therefore need domain checks. */
export const NETWORK_CAPABILITIES: ReadonlySet<ToolCapability> = new Set<ToolCapability>([
  "web_search", "web_fetch", "browser", "http_request", "academic_search",
]);

/** Capabilities that touch the filesystem, and therefore need path-root checks. */
export const FILESYSTEM_CAPABILITIES: ReadonlySet<ToolCapability> = new Set<ToolCapability>([
  "filesystem_read", "filesystem_write", "git",
]);
