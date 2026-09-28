/**
 * The ToolProvider port — where an external capability layer attaches.
 *
 * ResearchOS asks for `browser` or `python`; it does not know or care which
 * process performs the work. A provider is whatever can fulfil a capability:
 * this package ships `LocalToolProvider` for in-process tools, and a future
 * ToolOS adapter implements the same three methods to translate these requests
 * into ToolOS capability requests.
 *
 * Nothing here names a specific host application. That is enforced, not merely
 * intended — `scripts/lint-architecture.mjs` fails the build if a product name
 * appears in this package's code.
 */
import type { ToolDescriptor } from "@research-os/contracts";
import { err } from "@research-os/shared";
import type { ResearchTool, ToolContext } from "./tool.ts";

export interface ToolProvider {
  /** Stable name, recorded on every tool call for audit. */
  readonly name: string;
  /** What this provider can currently do. May change as executors come and go. */
  listCapabilities(): Promise<ToolDescriptor[]>;
  execute(toolId: string, input: unknown, context: ToolContext): Promise<unknown>;
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
}

/** Runs tools in this process. */
export class LocalToolProvider implements ToolProvider {
  readonly name = "local";
  readonly #tools = new Map<string, ResearchTool>();

  constructor(tools: readonly ResearchTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: ResearchTool): this {
    if (this.#tools.has(tool.descriptor.id)) {
      throw err.conflict(`A tool with id "${tool.descriptor.id}" is already registered.`, { toolId: tool.descriptor.id });
    }
    this.#tools.set(tool.descriptor.id, tool);
    return this;
  }

  get(toolId: string): ResearchTool | undefined {
    return this.#tools.get(toolId);
  }

  async listCapabilities(): Promise<ToolDescriptor[]> {
    return [...this.#tools.values()].map((tool) => tool.descriptor);
  }

  async execute(toolId: string, input: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.#tools.get(toolId);
    if (!tool) throw err.notFound("Tool", toolId);

    // Input usually originates from a model, so it is validated here rather
    // than trusted. A tool's own `execute` may then assume a valid shape.
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw err.validation(
        `Input to tool "${toolId}" is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
        { toolId },
      );
    }
    return tool.execute(parsed.data, context);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: `${this.#tools.size} local tool(s)` };
  }
}
