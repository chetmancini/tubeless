import type { RunJob } from "./run-contract.js";
import type { PipelineRunControls } from "../core/pipeline.js";
import { hostedCommandContext, type HostedCommand, type HostedOutput } from "./hosting-commands.js";
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

export interface HostedRunCoordinatorOptions<TDispatch> {
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly driver: HostedRunDriver<TDispatch>;
  readonly output: HostedOutput;
  readonly maxRunDurationMs: number;
  readonly startTimeoutMs?: number;
}

const START_FAILED = "The run host could not start the run.";
const START_UNCONFIRMED =
  "The run host could not confirm the run started. It may have started; check history before launching again.";
const formatDuration = (ms: number) =>
  ms === 1000 ? "1 second" : ms > 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
export class HostedRunCoordinator<TDispatch = RunJob> implements PipelineRunStudioLauncher {
  readonly commands;
  readonly #waiters = new Map<string, (result: PipelineRunStudioLaunchResult) => void>();
  #closed = false;
  readonly #dispatches = new Set<Promise<void>>();

  constructor(private readonly deps: HostedRunCoordinatorOptions<TDispatch>) {
    this.commands = [...deps.commands.values()].map((entry) => entry.descriptor);
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
    const entry = this.deps.commands.get(commandId);
    if (!entry) return { accepted: false, errors: ["Pipeline command not found."] };
    let parsed: ReturnType<HostedCommand["command"]["parseValues"]>;
    const submitted = structuredClone(values);
    try {
      parsed = entry.command.parseValues(
        submitted,
        hostedCommandContext(this.deps.output, new AbortController().signal)
      );
    } catch (error) {
      return { accepted: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
    if (parsed.kind === "error") return { accepted: false, errors: parsed.errors };
    if (parsed.kind === "help")
      return { accepted: false, errors: ["Help is not a launchable value set."] };
    const launchId = crypto.randomUUID();
    const acknowledged = new Promise<PipelineRunStudioLaunchResult>((resolve) =>
      this.#waiters.set(launchId, resolve)
    );
    const timeoutMs = this.deps.startTimeoutMs ?? 30_000;
    const timeout = setTimeout(
      () =>
        this.acknowledge(launchId, {
          accepted: false,
          errors: [
            `The run did not record a start within ${formatDuration(timeoutMs)}. It may still start; check history before launching again.`,
          ],
        }),
      timeoutMs
    );
    const dispatch = this.#dispatch({
      launchId,
      commandId,
      values: submitted,
      maxRunDurationMs: this.deps.maxRunDurationMs,
    });
    this.#dispatches.add(dispatch);
    void dispatch.then(
      () => this.#dispatches.delete(dispatch),
      () => this.#dispatches.delete(dispatch)
    );
    try {
      return await acknowledged;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Observe the whole dispatch task without holding the acknowledgement response open. */
  async #dispatch(job: RunJob): Promise<void> {
    let dispatch: TDispatch;
    try {
      dispatch = await this.deps.driver.prepare(job);
      if (this.#closed) throw new Error("The run host is stopping.");
    } catch {
      await this.#failStart(job.launchId, START_FAILED);
      return;
    }
    try {
      await this.deps.driver.start(dispatch);
    } catch {
      await this.#failStart(job.launchId, START_UNCONFIRMED);
    }
  }

  /** Runs inside a voided promise chain, so it must never throw. */
  async #failStart(launchId: string, message: string): Promise<void> {
    try {
      // An admitted run is executing user code; it records its own outcome or is reconciled.
      await this.deps.driver.failUnadmitted(launchId, message);
    } catch {
      // Target-owned recovery must reconcile the launch later.
      console.error("The run host could not persist launch failure.");
    }
    this.acknowledge(launchId, { accepted: false, errors: [message] });
  }

  /** Notify only after the corresponding history/failure transaction committed. */
  acknowledge(launchId: string, result: PipelineRunStudioLaunchResult): void {
    const resolve = this.#waiters.get(launchId);
    if (!resolve) return;
    this.#waiters.delete(launchId);
    resolve(result);
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
