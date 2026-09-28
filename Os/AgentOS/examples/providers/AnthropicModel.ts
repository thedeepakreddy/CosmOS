/**
 * A real model adapter, written against the HTTP API with `fetch`.
 *
 * NO SDK DEPENDENCY ON PURPOSE. `tests/certification.test.ts` asserts that
 * AgentOS's runtime dependencies contain no model vendor, and an example that
 * quietly added one would make that claim false. Node 26 has global fetch, so
 * an adapter needs nothing extra.
 *
 * This is also the reference for writing your own adapter: everything
 * vendor-specific -- message shape, tool encoding, stop reasons, pricing --
 * is confined to this file. AgentOS sees only the neutral contract.
 *
 * Activated when ANTHROPIC_API_KEY is set; otherwise the demo runs against
 * LocalReasoningModel.
 */

import type {
  ModelProvider, ModelRequest, ModelResponse, ModelMessage, ModelToolCall
} from '../../src/providers/contracts';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Claude 5 family. Override with AGENTOS_DEMO_MODEL. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

type OutBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface OutMessage { role: 'user' | 'assistant'; content: OutBlock[] }

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  /**
   * USD per MILLION tokens. Left undefined by default: this adapter will not
   * invent a price, and AgentOS never hardcodes one. Supply the rate your
   * account is billed at to make `maxCostUsd` budgets meaningful.
   */
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
}

export class AnthropicModel implements ModelProvider {
  readonly name = 'anthropic';
  private readonly model: string;
  private readonly maxOutputTokens: number;

  /**
   * Tool calls this adapter has issued, by id.
   *
   * Needed because the neutral transcript is lossy in one specific way:
   * GenericLLMAgentExecutor records the assistant's tool turn as TEXT ONLY
   * (`{ role: 'assistant', content: response.content }`), dropping the calls
   * themselves. Anthropic requires every `tool_result` to reference a
   * `tool_use` block in the preceding assistant turn, so without this the
   * second round of any tool conversation is rejected.
   *
   * The adapter saw those calls when it produced them, so it can put them back.
   * This is the correct place for the fix -- the loss is vendor-visible only.
   */
  private readonly issued = new Map<string, { name: string; input: Record<string, unknown> }>();

  constructor(private readonly options: AnthropicModelOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 1024;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { system, messages } = this.toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
      messages
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
    }

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': API_VERSION
        },
        body: JSON.stringify(body),
        signal: request.signal
      });
    } catch (e) {
      // A transport failure is a provider error; the runtime turns it into a
      // FAILED task rather than a crash.
      if ((e as Error).name === 'AbortError') throw e;
      return {
        content: `transport error: ${(e as Error).message}`,
        finishReason: 'error',
        usage: { inputTokens: 0, outputTokens: 0 }
      };
    }

    const json = (await res.json().catch(() => ({}))) as AnthropicResponse;

    if (!res.ok) {
      return {
        content: `HTTP ${res.status}: ${json.error?.message ?? 'request failed'}`,
        finishReason: 'error',
        usage: { inputTokens: 0, outputTokens: 0 }
      };
    }

    const blocks = json.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const toolCalls: ModelToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id ?? '', name: b.name ?? '', arguments: b.input ?? {} }));

    // Remember them so the next turn can reconstruct the assistant tool blocks.
    for (const call of toolCalls) {
      this.issued.set(call.id, { name: call.name, input: call.arguments });
    }

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;

    return {
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: this.mapStopReason(json.stop_reason, toolCalls.length > 0),
      usage: { inputTokens, outputTokens, costUsd: this.cost(inputTokens, outputTokens) }
    };
  }

  private cost(inputTokens: number, outputTokens: number): number | undefined {
    const { pricePerMTokIn, pricePerMTokOut } = this.options;
    if (pricePerMTokIn === undefined && pricePerMTokOut === undefined) return undefined;
    return (
      (inputTokens / 1_000_000) * (pricePerMTokIn ?? 0) +
      (outputTokens / 1_000_000) * (pricePerMTokOut ?? 0)
    );
  }

  private mapStopReason(reason: string | undefined, hasToolCalls: boolean): ModelResponse['finishReason'] {
    if (hasToolCalls || reason === 'tool_use') return 'tool_calls';
    if (reason === 'max_tokens') return 'length';
    if (reason === 'refusal') return 'content_filter';
    return 'stop';
  }

  /**
   * Neutral messages -> Anthropic's shape.
   *
   * Three rules matter:
   *  1. System prompts move to a top-level `system` field.
   *  2. Tool results are user-role `tool_result` blocks, and CONSECUTIVE ones
   *     must merge into a single user message or the turn order is rejected.
   *  3. Each `tool_result` must reference a `tool_use` in the assistant turn
   *     before it -- restored here from `issued`, since the neutral transcript
   *     does not carry it.
   */
  private toAnthropicMessages(input: ModelMessage[]): { system: string; messages: OutMessage[] } {
    const system = input.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages: OutMessage[] = [];

    for (const message of input) {
      if (message.role === 'system') continue;

      if (message.role === 'tool') {
        const id = message.toolCallId ?? '';

        // Put the matching tool_use back on the assistant turn it belongs to.
        const assistant = messages[messages.length - 1]?.role === 'assistant'
          ? messages[messages.length - 1]
          : messages[messages.length - 2]?.role === 'assistant'
            ? messages[messages.length - 2]
            : undefined;
        const call = this.issued.get(id);
        if (assistant && call && !assistant.content.some((b) => b.type === 'tool_use' && b.id === id)) {
          assistant.content.push({ type: 'tool_use', id, name: call.name, input: call.input });
        }

        const block: OutBlock = { type: 'tool_result', tool_use_id: id, content: message.content };
        const tail = messages[messages.length - 1];
        if (tail && tail.role === 'user' && tail.content.every((b) => b.type === 'tool_result')) {
          tail.content.push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
        continue;
      }

      // An assistant turn that only requested tools has empty text. Anthropic
      // rejects an empty text block, so such a turn starts with no content and
      // is filled by the tool_use blocks above.
      const text = message.content?.trim() ?? '';
      if (message.role === 'assistant') {
        messages.push({ role: 'assistant', content: text ? [{ type: 'text', text }] : [] });
      } else {
        messages.push({ role: 'user', content: [{ type: 'text', text: text || '(no content)' }] });
      }
    }

    // Drop any assistant turn that ended up completely empty.
    return { system, messages: messages.filter((m) => m.content.length > 0) };
  }
}
