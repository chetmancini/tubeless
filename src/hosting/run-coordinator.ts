import type { RunJob } from "./run-contract.js";
import type { PipelineRunControls } from "../core/pipeline.js";
import { MAX_TIMEOUT_DELAY_MS } from "../utilities/abort.js";
import { parseHostedLaunch, type HostedCommand, type HostedOutput } from "./hosting-commands.js";
import type {
  PipelineRunStudioCancelResult,
  PipelineRunStudioLauncher,
  PipelineRunStudioLaunchRequest,
  PipelineRunStudioLaunchResult,
} from "../studio/shared/protocol.js";

/** Target-owned execution and duplicate prevention. start acknowledges dispatch, not completion. */
export interface HostedExecutor {
  start(job: RunJob): Promise<void>;
  /** True acknowledges a cancellation request; it does not confirm termination. */
  cancel(launchId: string): Promise<boolean>;
}

/** Target-owned preparation, dispatch and scoped launch controls. */
export interface HostedRunDriver<TDispatch> {
  prepare(job: RunJob): Promise<TDispatch>;
  start(dispatch: TDispatch): Promise<void>;
  failUnadmitted(launchId: string, message: string): Promise<void>;
  cancel(runId: string): Promise<boolean>;
  liveRunIds(): Promise<readonly string[]>;
}

/** Host-only stage diagnostics; deliberately excludes raw errors, credentials and input values. */
export interface HostedRunDiagnostic {
  readonly code:
    | "TUBELESS_HOST_PREPARATION_FAILED"
    | "TUBELESS_HOST_DISPATCH_FAILED"
    | "TUBELESS_HOST_FAILURE_RECORDING_FAILED";
  readonly launchId: string;
  readonly commandId: string;
}

export interface HostedRunCoordinatorOptions<TDispatch> {
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly driver: HostedRunDriver<TDispatch>;
  readonly output: HostedOutput;
  readonly maxRunDurationMs: number;
  readonly startTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: HostedRunDiagnostic) => void | Promise<void>;
}

const START_FAILED = "The run host could not start the run.";
const START_UNCONFIRMED =
  "The run host could not confirm the run started. It may have started; check history before launching again.";
const formatDuration = (ms: number) =>
  ms === 1000 ? "1 second" : ms > 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
export class HostedRunCoordinator<TDispatch = RunJob> implements PipelineRunStudioLauncher {
  readonly commands;
  readonly #waiters = new Map<string, Set<(result: PipelineRunStudioLaunchResult) => void>>();
  #closed = false;
  readonly #dispatches = new Set<Promise<void>>();
  private readonly deps: HostedRunCoordinatorOptions<TDispatch> & {
    readonly startTimeoutMs: number;
  };

  constructor(deps: HostedRunCoordinatorOptions<TDispatch>) {
    const startTimeoutMs = deps.startTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(startTimeoutMs) ||
      startTimeoutMs <= 0 ||
      startTimeoutMs > MAX_TIMEOUT_DELAY_MS
    )
      throw new Error("Invalid hosted start acknowledgement budget.");
    this.deps = {
      commands: new Map(deps.commands),
      driver: deps.driver,
      output: deps.output,
      maxRunDurationMs: deps.maxRunDurationMs,
      startTimeoutMs,
      onDiagnostic: deps.onDiagnostic?.bind(deps),
    };
    this.commands = [...this.deps.commands.values()].map((entry) => entry.descriptor);
  }

  plan(commandId: string, input: PipelineRunControls) {
    const entry = this.deps.commands.get(commandId);
    if (!entry) throw new Error("Pipeline planning is not available for this command.");
    return entry.command.plan(input);
  }

  async launch(
    commandId: string,
    values: PipelineRunStudioLaunchRequest["values"]
  ): Promise<PipelineRunStudioLaunchResult> {
    if (this.#closed) return { accepted: false, errors: ["The run host is stopping."] };
    const submitted = structuredClone(values);
    const parsed = parseHostedLaunch(
      this.deps.commands.get(commandId),
      submitted,
      this.deps.output
    );
    if ("errors" in parsed) return { accepted: false, errors: parsed.errors };
    const launchId = crypto.randomUUID();
    const acknowledged = this.waitForStart(launchId);
    void this.#track(
      this.#dispatch({
        launchId,
        commandId,
        values: submitted,
        maxRunDurationMs: this.deps.maxRunDurationMs,
      })
    );
    return acknowledged;
  }

  /** Register before reading persisted state, so a concurrent start cannot be missed. */
  waitForStart(launchId: string): Promise<PipelineRunStudioLaunchResult> {
    if (this.#closed)
      return Promise.resolve({ accepted: false, errors: ["The run host is stopping."] });
    const waiters = this.#waiters.get(launchId) ?? new Set();
    this.#waiters.set(launchId, waiters);
    const timeoutMs = this.deps.startTimeoutMs;
    return new Promise((resolve) => {
      const settle = (result: PipelineRunStudioLaunchResult) => {
        clearTimeout(timeout);
        waiters.delete(settle);
        if (waiters.size === 0) this.#waiters.delete(launchId);
        resolve(result);
      };
      const timeout = setTimeout(
        () =>
          settle({
            accepted: false,
            errors: [
              `The run did not record a start within ${formatDuration(timeoutMs)}. It may still start; check history before launching again.`,
            ],
          }),
        timeoutMs
      );
      waiters.add(settle);
    });
  }

  async #dispatch(job: RunJob): Promise<void> {
    let dispatch: TDispatch;
    try {
      dispatch = await this.deps.driver.prepare(job);
    } catch {
      this.#diagnose(job, "TUBELESS_HOST_PREPARATION_FAILED");
      await this.#failStart(job, START_FAILED);
      return;
    }
    return this.#start(job, dispatch);
  }

  /** Dispatch a target's already-persisted launch after it has arranged recovery. */
  startPrepared(job: RunJob, dispatch: TDispatch): Promise<void> {
    return this.#track(this.#start(job, dispatch));
  }

  #track(dispatch: Promise<void>): Promise<void> {
    this.#dispatches.add(dispatch);
    void dispatch.then(
      () => this.#dispatches.delete(dispatch),
      () => this.#dispatches.delete(dispatch)
    );
    return dispatch;
  }

  async #start(job: RunJob, dispatch: TDispatch): Promise<void> {
    if (this.#closed) return this.#failStart(job, START_FAILED);
    try {
      await this.deps.driver.start(dispatch);
    } catch {
      this.#diagnose(job, "TUBELESS_HOST_DISPATCH_FAILED");
      await this.#failStart(job, START_UNCONFIRMED);
    }
  }

  /** Runs inside a voided promise chain, so it must never throw. */
  async #failStart(job: RunJob, message: string): Promise<void> {
    try {
      // An admitted run is executing user code; it records its own outcome or is reconciled.
      await this.deps.driver.failUnadmitted(job.launchId, message);
    } catch {
      this.#diagnose(job, "TUBELESS_HOST_FAILURE_RECORDING_FAILED");
      // Target-owned recovery must reconcile the launch later.
      console.error("The run host could not persist launch failure.");
    }
    this.acknowledge(job.launchId, { accepted: false, errors: [message] });
  }

  #diagnose(job: RunJob, code: HostedRunDiagnostic["code"]): void {
    try {
      // oxlint-disable-next-line landmines/no-silent-catch -- The optional observer must not interrupt launch acknowledgement.
      void Promise.resolve(
        this.deps.onDiagnostic?.({ code, launchId: job.launchId, commandId: job.commandId })
      ).catch(() => {});
    } catch {
      // Diagnostics must not interrupt failure fencing or launch acknowledgement.
    }
  }

  /** Notify only after the corresponding history/failure transaction committed. */
  acknowledge(launchId: string, result: PipelineRunStudioLaunchResult): void {
    const waiters = this.#waiters.get(launchId);
    if (!waiters) return;
    for (const resolve of waiters) resolve(result);
  }

  async cancel(runId: string): Promise<PipelineRunStudioCancelResult> {
    return (await this.deps.driver.cancel(runId))
      ? { cancelled: true, runId }
      : { cancelled: false };
  }

  liveRunIds(): Promise<readonly string[]> {
    return this.deps.driver.liveRunIds();
  }

  async drain(): Promise<void> {
    while (this.#dispatches.size > 0) await Promise.all(this.#dispatches);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const launchId of this.#waiters.keys())
      this.acknowledge(launchId, { accepted: false, errors: ["The run host is stopping."] });
    await this.drain();
  }
}
