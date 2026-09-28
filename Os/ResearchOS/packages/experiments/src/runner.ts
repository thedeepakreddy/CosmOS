/**
 * The experiment runner port.
 *
 * An experiment is code plus an environment, and running it is the one thing
 * ResearchOS does that executes something a model wrote. That makes the runner
 * a security boundary as much as an execution one, and the port is shaped
 * accordingly: a runner declares what it can run, and a request declares
 * exactly what it needs — never "run this, figure it out".
 *
 * There are two implementations here. `UnavailableExperimentRunner` is the
 * default and refuses everything, because the honest answer on a host with no
 * sandbox is that the experiment is blocked, not that it produced no findings.
 * `LocalProcessRunner` genuinely executes, and has to be asked for explicitly.
 */
import type {
  ExperimentExecutionRequest, ExperimentExecutionResult, ExperimentRuntime,
} from "@research-os/contracts";

export interface ExperimentRunner {
  readonly name: string;
  /** Runtimes this runner can execute. An unsupported runtime is refused, not attempted. */
  readonly supportedRuntimes: readonly ExperimentRuntime[];
  execute(request: ExperimentExecutionRequest): Promise<ExperimentExecutionResult>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Why a runner is refusing, in terms a research report can print.
 *
 * `blocked` is a first-class outcome. An experiment that could not be run is a
 * gap in the research, and saying so is the only honest option — the
 * alternative is a fabricated result, which is worse than no result because it
 * carries the authority of a measurement.
 */
export const BLOCKED_EXIT_CODE = null;

export function blockedResult(runtime: ExperimentRuntime, reason: string): ExperimentExecutionResult {
  return {
    status: "failed",
    stdout: "",
    stderr: "",
    exitCode: BLOCKED_EXIT_CODE,
    metrics: {},
    artifacts: [],
    durationMs: 0,
    errorMessage: `BLOCKED: ${reason}`,
    environment: {
      runtime,
      runtimeVersion: null,
      dependencies: [],
      platform: null,
      envVarNames: [],
      randomSeed: null,
    },
  };
}

/**
 * The default runner: refuses every request, with a reason.
 *
 * A deployment with no execution sandbox gets this one. Every experiment comes
 * back `BLOCKED`, which is exactly what should appear in the report.
 */
export class UnavailableExperimentRunner implements ExperimentRunner {
  readonly name = "unavailable";
  readonly supportedRuntimes: readonly ExperimentRuntime[] = [];
  readonly #reason: string;

  constructor(reason = "No experiment execution backend is configured. Experiments can be designed but not run.") {
    this.#reason = reason;
  }

  async execute(request: ExperimentExecutionRequest): Promise<ExperimentExecutionResult> {
    return blockedResult(request.runtime, this.#reason);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: this.#reason };
  }
}
