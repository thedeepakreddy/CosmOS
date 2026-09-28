/**
 * Sortable, prefixed, branded identifiers.
 *
 * Every ResearchOS entity carries a ULID with a type prefix (`clm_01J9...`).
 * Three properties matter and all three are load-bearing:
 *   - lexicographically sortable by creation time, so `ORDER BY id` is a valid
 *     chronological order and cursor pagination needs no secondary sort key;
 *   - self-describing, so an ID in a log line or an LLM transcript identifies
 *     its own table without a lookup;
 *   - branded at the type level, so a SourceId cannot be passed where a ClaimId
 *     is expected even though both are strings at runtime.
 */
import { randomBytes } from "node:crypto";

declare const brandSymbol: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export const ID_PREFIXES = {
  project: "prj",
  objective: "obj",
  question: "qst",
  hypothesis: "hyp",
  source: "src",
  document: "doc",
  chunk: "chk",
  evidence: "evd",
  claim: "clm",
  contradiction: "ctr",
  task: "tsk",
  agentRun: "run",
  debate: "dbt",
  experiment: "exp",
  experimentRun: "exr",
  dataset: "dst",
  report: "rpt",
  event: "evt",
  memory: "mem",
  node: "nod",
  edge: "edg",
  executor: "exc",
  executorRequest: "exq",
  modelCall: "mcl",
  trace: "trc",
  span: "spn",
  finding: "fnd",
  failure: "flr",
  verification: "vrf",
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;
export type Id<K extends EntityKind> = Brand<string, K>;

export type ProjectId = Id<"project">;
export type ObjectiveId = Id<"objective">;
export type QuestionId = Id<"question">;
export type HypothesisId = Id<"hypothesis">;
export type SourceId = Id<"source">;
export type DocumentId = Id<"document">;
export type ChunkId = Id<"chunk">;
export type EvidenceId = Id<"evidence">;
export type ClaimId = Id<"claim">;
export type ContradictionId = Id<"contradiction">;
export type TaskId = Id<"task">;
export type AgentRunId = Id<"agentRun">;
export type DebateId = Id<"debate">;
export type ExperimentId = Id<"experiment">;
export type ExperimentRunId = Id<"experimentRun">;
export type DatasetId = Id<"dataset">;
export type ReportId = Id<"report">;
export type EventId = Id<"event">;
export type MemoryId = Id<"memory">;
export type NodeId = Id<"node">;
export type EdgeId = Id<"edge">;
export type ExecutorId = Id<"executor">;
export type ExecutorRequestId = Id<"executorRequest">;
export type ModelCallId = Id<"modelCall">;
export type TraceId = Id<"trace">;
export type SpanId = Id<"span">;
export type FindingId = Id<"finding">;
export type FailureId = Id<"failure">;
export type VerificationId = Id<"verification">;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = "";
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (b) => b % 32);
}

/**
 * Increments the random component in place so that two IDs minted in the same
 * millisecond still sort in creation order. Without this, ordering by ID would
 * be unstable exactly when events are most closely related.
 */
function incrementRandom(chars: number[]): number[] {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    const value = next[i] ?? 0;
    if (value < 31) {
      next[i] = value + 1;
      return next;
    }
    next[i] = 0;
  }
  // Overflowed all 80 random bits within one millisecond. Astronomically
  // unlikely; restarting from fresh entropy is the only correct recovery.
  return freshRandom();
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(now) + lastRandom.map((c) => CROCKFORD[c]).join("");
}

export function newId<K extends EntityKind>(kind: K, now?: number): Id<K> {
  return `${ID_PREFIXES[kind]}_${ulid(now)}` as Id<K>;
}

export function isId<K extends EntityKind>(kind: K, value: unknown): value is Id<K> {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return body.length === TIME_LEN + RANDOM_LEN && [...body].every((c) => CROCKFORD.includes(c));
}

/** Narrowing cast for values that have already been validated (e.g. by zod or the DB). */
export function asId<K extends EntityKind>(kind: K, value: string): Id<K> {
  if (!isId(kind, value)) {
    throw new TypeError(`Expected a ${kind} id (prefix "${ID_PREFIXES[kind]}_"), received: ${value}`);
  }
  return value;
}

/** Milliseconds encoded in a ULID's time component. Useful for ordering without a DB round trip. */
export function timestampFromId(value: string): number {
  const body = value.includes("_") ? value.slice(value.indexOf("_") + 1) : value;
  let t = 0;
  for (const char of body.slice(0, TIME_LEN)) {
    const index = CROCKFORD.indexOf(char);
    if (index < 0) throw new TypeError(`Not a valid ULID: ${value}`);
    t = t * 32 + index;
  }
  return t;
}
