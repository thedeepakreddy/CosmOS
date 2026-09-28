import { Task, AgentInstance } from '../domain/types';
import { AgentMessage, MessageType } from '../persistence/contracts';

// Re-exported so that the executor contract can be consumed from a single
// module -- both by implementors inside this repo and by external packages
// importing from the package entry point.
export type { Task, AgentInstance, AgentMessage };

/** A message an executing agent wants to send (Phase H). */
export interface OutgoingMessage {
  type: MessageType;
  payload: unknown;
  /** Address it to a specific task, or leave both unset to broadcast in the run. */
  toTaskId?: string;
  toAgentDefinitionId?: string;
}

export interface AgentExecutionContext {
  runId: string;
  taskId: string;
  /** Which attempt this is. Monotonic; covers retries and crash reclaims. */
  attempt: number;
  /** Phase G: the persisted agent instance executing this task. */
  agentInstanceId: string;

  /**
   * Phase H: messages addressed to this task, its agent definition, or broadcast.
   *
   * This is how one agent's output reaches another. A HANDOFF message carries
   * context from a completed agent to the one taking over.
   */
  inbox: AgentMessage[];

  /**
   * Send a message to another task in this run, or broadcast it.
   *
   * Scope note: this delivers context BETWEEN EXISTING tasks in the graph. It
   * does not create new work -- dynamic task creation remains out of scope and
   * is not implied by a HANDOFF.
   */
  send(message: OutgoingMessage): void;

  /**
   * Phase C: cancellation.
   *
   * Aborted when the run is cancelled, when the task exceeds its timeout, or
   * when this worker loses the lease to a reclaim. An executor that honours it
   * stops promptly; one that ignores it still cannot corrupt state, because the
   * fencing check rejects its late write -- but it will keep burning resources,
   * so long-running executors should check `signal.aborted` or pass it through
   * to whatever they call.
   *
   * v0.1 had no signal at all: cancelRun flipped a row and the work ran on,
   * eventually writing SUCCEEDED into a CANCELLED run.
   */
  signal: AbortSignal;

  // Phase G will carry ModelProvider / ToolProvider / MemoryProvider here.
}

export interface AgentExecutionResult {
  status: 'SUCCEEDED' | 'FAILED';
  output?: unknown;
  error?: string;
}

export interface AgentExecutor {
  execute(
    agent: AgentInstance,
    task: Task,
    context: AgentExecutionContext
  ): Promise<AgentExecutionResult>;
}
