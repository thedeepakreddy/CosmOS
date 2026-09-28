/**
 * A deterministic, offline ModelProvider.
 *
 * BE CLEAR ABOUT WHAT THIS IS: it is not a language model. It is a rule-driven
 * planner that satisfies the same `ModelProvider` contract, so the reason/act
 * loop, the tool permissions, the budget reservations and the usage accounting
 * all run for real against it. What it does NOT do is reason in the way a model
 * would -- it decides which tool to call from the agent's role and the
 * conversation so far.
 *
 * It exists so the demo works with no API key and no network, and so the
 * orchestration can be judged on its own behaviour rather than on a model's.
 * For real reasoning, set ANTHROPIC_API_KEY and AnthropicModel takes over.
 */

import type {
  ModelProvider, ModelRequest, ModelResponse, ModelMessage, ModelToolCall, ToolSpec
} from '../../src/providers/contracts';

/** Rough token estimate. A real adapter reports what the API billed. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

interface Brief {
  /** The text the person actually submitted. */
  brief: string;
  /** Outputs handed over by upstream agents, newest last. */
  upstream: string[];
  /** The whole user turn, for anything that wants it verbatim. */
  raw: string;
}

/**
 * Pull the task input back out of the prompt the runtime built.
 *
 * `GenericLLMAgentExecutor.taskPrompt` renders `Task: <name>\n<description>` and
 * then `Input:\n<json>`. A real model reads that as prose; this stub needs the
 * structure, so it parses the JSON back out.
 */
function readBrief(messages: ModelMessage[]): Brief {
  const raw = messages.find((m) => m.role === 'user')?.content ?? '';
  const marker = raw.indexOf('Input:\n');
  if (marker === -1) return { brief: raw, upstream: [], raw };

  try {
    const parsed = JSON.parse(raw.slice(marker + 'Input:\n'.length)) as {
      brief?: string;
      upstream?: Array<{ output?: { content?: string } | string }>;
    };
    const upstream = (parsed.upstream ?? []).map((h) => {
      const out = h.output;
      if (typeof out === 'string') return out;
      return out?.content ?? JSON.stringify(out ?? '');
    });
    return { brief: parsed.brief ?? raw, upstream, raw };
  } catch {
    return { brief: raw, upstream: [], raw };
  }
}

/** Every tool result seen so far, parsed back into objects. */
function toolResults(messages: ModelMessage[]): Array<{ name: string; data: unknown }> {
  return messages
    .filter((m) => m.role === 'tool')
    .map((m) => {
      try {
        return { name: m.name ?? 'unknown', data: JSON.parse(m.content) };
      } catch {
        return { name: m.name ?? 'unknown', data: m.content };
      }
    });
}

/**
 * Which agent is this?
 *
 * Anchored on the "You are a <kind> agent" declaration, NOT on keywords
 * anywhere in the prompt. Every prompt mentions the other agents -- the
 * writer's says it receives "research and analysis" -- so a loose keyword scan
 * classifies all three as the researcher and the pipeline silently runs the
 * wrong behaviour at every stage. It still looks like it works: three tasks
 * succeed, the events are clean, and the output is subtly wrong.
 *
 * A real model reads the whole prompt and is not confused by this. A keyword
 * matcher has to be told exactly where to look.
 */
function roleOf(messages: ModelMessage[]): string {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const declared = /you are an?\s+([a-z]+)/i.exec(system)?.[1]?.toLowerCase() ?? '';
  if (declared.startsWith('research')) return 'researcher';
  if (declared.startsWith('analy')) return 'analyst';
  if (declared.startsWith('writ') || declared.startsWith('edit')) return 'writer';
  return 'generalist';
}

let callCounter = 0;
const nextCallId = () => `call_${++callCounter}`;

export class LocalReasoningModel implements ModelProvider {
  readonly name = 'local-reasoning-stub';

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { messages, tools } = request;

    // Honour cancellation like a network adapter would.
    if (request.signal?.aborted) {
      return { content: '', finishReason: 'error', usage: { inputTokens: 0, outputTokens: 0 } };
    }

    const inputTokens = estimateTokens(messages.map((m) => m.content).join(' '));
    const role = roleOf(messages);
    const results = toolResults(messages);
    const input = readBrief(messages);
    const available = new Set((tools ?? []).map((t: ToolSpec) => t.name));

    // The researcher works on the brief; everyone downstream works on what the
    // previous agent handed over, falling back to the brief on the first hop.
    const subject = role === 'researcher' || input.upstream.length === 0
      ? input.brief
      : input.upstream.join('\n\n');

    // ---- act: on the first pass, reach for whatever tools the role needs ----
    if (results.length === 0 && available.size > 0) {
      // Arithmetic is always done on the ORIGINAL brief. Computing over the
      // upstream prose instead would pick up the researcher's own word counts
      // and quietly add them to the user's figures.
      const calls = this.planToolCalls(role, subject, input.brief, available);
      if (calls.length > 0) {
        return {
          content: `Gathering evidence with ${calls.map((c) => c.name).join(', ')}.`,
          toolCalls: calls,
          finishReason: 'tool_calls',
          usage: { inputTokens, outputTokens: 24, costUsd: 0 }
        };
      }
    }

    // ---- reason: synthesise an answer from what came back -------------------
    const content = this.compose(role, subject, results);
    return {
      content,
      finishReason: 'stop',
      usage: { inputTokens, outputTokens: estimateTokens(content), costUsd: 0 }
    };
  }

  private planToolCalls(
    role: string,
    subject: string,
    brief: string,
    available: Set<string>
  ): ModelToolCall[] {
    const calls: ModelToolCall[] = [];
    const want = (name: string, args: Record<string, unknown>) => {
      if (available.has(name)) calls.push({ id: nextCallId(), name, arguments: args });
    };

    if (role === 'researcher') {
      want('text_stats', { text: subject });
      want('extract_entities', { text: subject });
      return calls;
    }

    if (role === 'analyst') {
      const numbers = (brief.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).slice(0, 12);
      if (numbers.length >= 2) {
        // The first two figures are usually the comparison the brief is about.
        const [a, b] = numbers;
        want('calculator', { expression: `((${a} - ${b}) / ${b}) * 100` });
      } else if (numbers.length === 1) {
        want('calculator', { expression: `${numbers[0]} * 1` });
      }
      want('current_time', {});
      return calls;
    }

    // A writer works from the handoff it was given; it does not gather more.
    return calls;
  }

  private compose(
    role: string,
    subject: string,
    results: Array<{ name: string; data: unknown }>
  ): string {
    const find = (name: string) => results.find((r) => r.name === name)?.data as
      | Record<string, unknown>
      | undefined;

    if (role === 'researcher') {
      const stats = find('text_stats');
      const entities = find('extract_entities');
      const lines = ['FINDINGS'];
      if (stats) {
        lines.push(
          `- Size: ${stats.words} words across ${stats.sentences} sentence(s), ${stats.characters} characters.`,
          `- Longest term: "${stats.longestWord}" (avg word length ${stats.averageWordLength}).`
        );
      }
      if (entities) {
        const numbers = (entities.numbers as number[]) ?? [];
        const caps = (entities.capitalised as string[]) ?? [];
        lines.push(`- Numeric values present: ${numbers.length ? numbers.join(', ') : 'none'}.`);
        if (caps.length) lines.push(`- Key terms: ${caps.slice(0, 8).join(', ')}.`);
        const urls = (entities.urls as string[]) ?? [];
        if (urls.length) lines.push(`- References: ${urls.join(', ')}.`);
      }
      lines.push(`- Verbatim brief: ${JSON.stringify(subject.slice(0, 240))}`);
      return lines.join('\n');
    }

    if (role === 'analyst') {
      const calc = find('calculator');
      const time = find('current_time');
      const lines = ['ANALYSIS'];
      if (calc) {
        const pct = Number(calc.result);
        lines.push(`- Change between the two leading figures: ${pct.toFixed(1)}%.`);
        lines.push(`- Computed as ${calc.expression}.`);
        lines.push(`- Direction: ${pct > 0 ? 'increase' : pct < 0 ? 'decrease' : 'flat'}.`);
      } else {
        lines.push('- No numeric content to evaluate; assessment is qualitative.');
      }
      const words = subject.split(/\s+/).filter(Boolean).length;
      lines.push(`- Upstream findings carry ${words} words of evidence.`);
      if (time) lines.push(`- Assessed at ${time.utc}.`);
      return lines.join('\n');
    }

    if (role === 'writer') {
      // The writer's material is the handoff chain. Present it as a report
      // rather than echoing the transcript back.
      const sections = subject
        .split(/\n\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const bullets = sections
        .flatMap((s) => s.split('\n'))
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).trim())
        // The reader wrote the brief; quoting it back is not a summary.
        .filter((line) => !line.startsWith('Verbatim brief:'));

      return [
        'SUMMARY',
        '',
        bullets.length
          ? bullets.map((b) => `• ${b}`).join('\n')
          : subject.replace(/\s+/g, ' ').trim().slice(0, 600),
        '',
        'Assembled by three agents in sequence — a researcher gathered evidence with',
        'tools, an analyst evaluated it, and this writer composed the result. Each step',
        'ran as a separately claimed, leased and fenced task.'
      ].join('\n');
    }

    return `Completed. Input was ${subject.length} characters; ${results.length} tool result(s) considered.`;
  }
}
