import type { RunJob, StudioIngest } from "./run-contract.js";
import type { PipelineRunControls } from "../core/pipeline.js";
import { hostedCommandContext, type HostedCommand, type HostedOutput } from "./hosting-commands.js";
import type { HostedLaunchStore } from "./launch-store.js";
import type {
  PipelineRunStudioCancelResult,
  PipelineRunStudioLauncher,
  PipelineRunStudioLaunchRequest,
  PipelineRunStudioLaunchResult,
} from "../studio/shared/protocol.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

/** Target-owned execution and duplicate prevention. start acknowledges dispatch, not completion. */
export interface HostedExecutor {
  start(job: RunJob): Promise<void>;
  /** True acknowledges a cancellation request; it does not confirm termination. */
  cancel(launchId: string): Promise<boolean>;
}

export interface HostedRunCoordinatorOptions {
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly executor: HostedExecutor;
  readonly output: HostedOutput;
  readonly maxRunDurationMs: number;
  /** Arrange target-owned recovery before dispatch. Failure prevents dispatch. */
  scheduleReconcile(): Promise<void>;
  readonly now?: () => number;
  readonly startTimeoutMs?: number;
}

const START_FAILED = "The run host could not start the run.";
const START_UNCONFIRMED =
  "The run host could not confirm the run started. It may have started; check history before launching again.";
const formatDuration = (ms: number) =>
  ms === 1000 ? "1 second" : ms > 1000 && ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
export class HostedRunCoordinator implements PipelineRunStudioLauncher, StudioIngest {
  readonly commands;
  readonly #waiters = new Map<string, (result: PipelineRunStudioLaunchResult) => void>();

  constructor(
    private readonly deps: HostedRunCoordinatorOptions,
    private readonly store: HostedLaunchStore
  ) {
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
    const entry = this.deps.commands.get(commandId);
    if (!entry) return { accepted: false, errors: ["Pipeline command not found."] };
    let parsed: ReturnType<HostedCommand["command"]["parseValues"]>;
    try {
      parsed = entry.command.parseValues(
        values,
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
        this.#settle(launchId, {
          accepted: false,
          errors: [
            `The run did not record a start within ${formatDuration(timeoutMs)}. It may still start; check history before launching again.`,
          ],
        }),
      timeoutMs
    );
    void this.#dispatch({
      launchId,
      commandId,
      values,
      maxRunDurationMs: this.deps.maxRunDurationMs,
    });
    try {
      return await acknowledged;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Observe the whole dispatch task without holding the acknowledgement response open. */
  async #dispatch(job: RunJob): Promise<void> {
    try {
      await this.store.create(job.launchId, job.commandId, (this.deps.now ?? Date.now)());
      // Recovery must be arranged before the executor can run user code.
      await this.deps.scheduleReconcile();
    } catch (error) {
      await this.#failStart(job.launchId, error, START_FAILED);
      return;
    }
    try {
      await this.deps.executor.start(job);
    } catch (error) {
      await this.#failStart(job.launchId, error, START_UNCONFIRMED);
    }
  }

  /** Runs inside a voided promise chain, so it must never throw. */
  async #failStart(launchId: string, error: unknown, message: string): Promise<void> {
    console.error(error);
    try {
      // An admitted run is executing user code; it records its own outcome or is reconciled.
      await this.store.failUnadmitted(launchId, message, (this.deps.now ?? Date.now)());
    } catch (failError) {
      // Target-owned recovery must reconcile the launch later.
      console.error(failError);
    }
    this.#settle(launchId, { accepted: false, errors: [message] });
  }

  #settle(launchId: string, result: PipelineRunStudioLaunchResult): void {
    const resolve = this.#waiters.get(launchId);
    if (!resolve) return;
    this.#waiters.delete(launchId);
    resolve(result);
  }

  async cancel(runId: string): Promise<PipelineRunStudioCancelResult> {
    const launchId = await this.store.launchIdForRun(runId);
    if (!launchId) return { cancelled: false };
    return (await this.deps.executor.cancel(launchId))
      ? { cancelled: true, runId }
      : { cancelled: false };
  }

  liveRunIds(): Promise<readonly string[]> {
    return this.store.liveRunIds();
  }

  async admit(launchId: string): Promise<{ admitted: boolean }> {
    return { admitted: await this.store.admit(launchId) };
  }

  async appendEvents(
    launchId: string,
    sequence: number,
    events: PipelineTraceEvent[]
  ): Promise<{ accepted: boolean }> {
    const acknowledgement = await this.store.acceptBatch(launchId, sequence, events);
    if (acknowledgement.accepted && acknowledgement.runId !== undefined)
      this.#settle(launchId, { accepted: true, runId: acknowledgement.runId });
    return { accepted: acknowledgement.accepted };
  }

  async reportFailure(launchId: string, message: string): Promise<void> {
    await this.store.fail(launchId, message, (this.deps.now ?? Date.now)());
    this.#settle(launchId, { accepted: false, errors: [message] });
  }
}
