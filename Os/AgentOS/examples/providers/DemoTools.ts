/**
 * A ToolProvider with real, dependency-free tools.
 *
 * These exist so the reason/act loop in GenericLLMAgentExecutor has something
 * genuine to act on. Nothing here is mocked: the calculator really parses and
 * evaluates, the text tools really measure the input you type into the UI.
 *
 * This file lives in examples/ on purpose. AgentOS itself ships no tools --
 * `tests/certification.test.ts` asserts the package depends on no vendor.
 */

import type {
  ToolProvider, ToolSpec, ToolResult, ToolInvocationContext
} from '../../src/providers/contracts';

// ---- a small arithmetic evaluator -------------------------------------------
// Recursive descent, not `eval`: the model chooses the expression, so it is
// untrusted input and must never reach an interpreter.

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9._]/.test(input[j])) j++;
      const raw = input.slice(i, j).replace(/_/g, '');
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`not a number: ${raw}`);
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    if ('+-*/%()^'.includes(ch)) { tokens.push({ kind: 'op', value: ch }); i++; continue; }
    throw new Error(`unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

/** expr := term (('+'|'-') term)* ; term := power (('*'|'/'|'%') power)* */
function evaluate(tokens: Token[]): number {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (op: string) => {
    const t = peek();
    if (t && t.kind === 'op' && t.value === op) { pos++; return true; }
    return false;
  };

  const primary = (): number => {
    if (eat('(')) {
      const value = expr();
      if (!eat(')')) throw new Error('unbalanced parentheses');
      return value;
    }
    if (eat('-')) return -primary();
    if (eat('+')) return primary();
    const t = peek();
    if (!t || t.kind !== 'num') throw new Error('expected a number');
    pos++;
    return t.value;
  };

  const power = (): number => {
    const base = primary();
    // Right-associative, so 2^3^2 is 2^(3^2).
    if (eat('^')) return Math.pow(base, power());
    return base;
  };

  const term = (): number => {
    let value = power();
    for (;;) {
      if (eat('*')) value *= power();
      else if (eat('/')) {
        const d = power();
        if (d === 0) throw new Error('division by zero');
        value /= d;
      } else if (eat('%')) {
        const d = power();
        if (d === 0) throw new Error('modulo by zero');
        value %= d;
      } else return value;
    }
  };

  function expr(): number {
    let value = term();
    for (;;) {
      if (eat('+')) value += term();
      else if (eat('-')) value -= term();
      else return value;
    }
  }

  const result = expr();
  if (pos !== tokens.length) throw new Error('trailing input after expression');
  return result;
}

export function calculate(expression: string): number {
  if (expression.length > 500) throw new Error('expression too long');
  return evaluate(tokenize(expression));
}

// ---- the provider ------------------------------------------------------------

const SPECS: ToolSpec[] = [
  {
    name: 'calculator',
    description: 'Evaluate an arithmetic expression. Supports + - * / % ^ and parentheses.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "(120 * 3) / 4"' } },
      required: ['expression']
    }
  },
  {
    name: 'text_stats',
    description: 'Measure a piece of text: characters, words, sentences, longest word, average word length.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'extract_entities',
    description: 'Pull structured items out of text: numbers, emails, URLs, and capitalised terms.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  {
    name: 'current_time',
    description: 'The current UTC time in ISO-8601.',
    parameters: { type: 'object', properties: {} }
  }
];

export class DemoTools implements ToolProvider {
  readonly name = 'demo-tools';

  /** Track invocations so the UI can show what the agents actually did. */
  readonly calls: Array<{ tool: string; args: unknown; taskId: string; at: string }> = [];

  async list(permitted?: string[]): Promise<ToolSpec[]> {
    if (!permitted) return SPECS;
    return SPECS.filter((s) => permitted.includes(s.name));
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolInvocationContext
  ): Promise<ToolResult> {
    this.calls.push({ tool: name, args, taskId: ctx.taskId, at: new Date().toISOString() });

    // Honour cancellation: a tool that ignores the signal keeps burning work
    // after a run is cancelled.
    if (ctx.signal.aborted) return { content: 'ERROR: aborted', isError: true };

    switch (name) {
      case 'calculator': {
        const expression = String(args.expression ?? '');
        try {
          return { content: JSON.stringify({ expression, result: calculate(expression) }) };
        } catch (e) {
          return { content: `ERROR: ${(e as Error).message}`, isError: true };
        }
      }

      case 'text_stats': {
        const text = String(args.text ?? '');
        const words = text.split(/\s+/).filter(Boolean);
        const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
        const longest = words.reduce((a, b) => (b.length > a.length ? b : a), '');
        return {
          content: JSON.stringify({
            characters: text.length,
            words: words.length,
            sentences: sentences.length,
            longestWord: longest,
            averageWordLength: words.length
              ? Number((words.join('').length / words.length).toFixed(2))
              : 0
          })
        };
      }

      case 'extract_entities': {
        const text = String(args.text ?? '');
        const numbers = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        return {
          content: JSON.stringify({
            numbers,
            emails: text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [],
            urls: text.match(/https?:\/\/[^\s)]+/g) ?? [],
            capitalised: Array.from(
              new Set((text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? []))
            ).slice(0, 20)
          })
        };
      }

      case 'current_time':
        return { content: JSON.stringify({ utc: new Date().toISOString() }) };

      default:
        return { content: `ERROR: unknown tool '${name}'`, isError: true };
    }
  }
}
