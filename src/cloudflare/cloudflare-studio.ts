import type { PipelineRunControls } from "../core/pipeline.js";
import {
  hostedCommandContext,
  type HostedCommand,
  type HostedOutput,
} from "../hosting/hosting-commands.js";
import { createStudioHost, type StudioHost } from "../hosting/hosting-studio.js";
import type {
  PipelineRunStudioCancelResult,
  PipelineRunStudioLauncher,
  PipelineRunStudioLaunchRequest,
  PipelineRunStudioLaunchResult,
} from "../studio/run-store-ui-protocol.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { LaunchRegistry } from "./cloudflare-launches.js";
import { openDurableRunStore, type DurableRunStore } from "./cloudflare-run-store.js";
import type { RunJob, StudioIngest } from "./cloudflare-run.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

const RECONCILE_GRACE_MS = 120_000;
const HOST_TERMINATED = "The Cloudflare run host stopped before the run finished.";
const SILENT_OUTPUT: HostedOutput = {
  cwd: "/tmp",
  stdout: { write: () => {} },
  stderr: { write: () => {} },
};

export interface RunStubLike {
  start(job: RunJob): Promise<void>;
  cancel(): Promise<boolean> | boolean;
}

export interface StudioObjectDependencies {
  readonly storage: DurableStorageLike;
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly clientScript: string;
  readonly maxRunDurationMs: number;
  runStub(launchId: string): RunStubLike;
  readonly now?: () => number;
  readonly startTimeoutMs?: number;
}

class DurableStudioLauncher implements PipelineRunStudioLauncher {
  readonly commands;
  readonly #waiters = new Map<string, (result: PipelineRunStudioLaunchResult) => void>();

  constructor(
    private readonly deps: StudioObjectDependencies,
    private readonly registry: LaunchRegistry,
    private readonly now: () => number
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
    const parsed = entry.command.parseValues(
      values,
      hostedCommandContext(SILENT_OUTPUT, new AbortController().signal)
    );
    if (parsed.kind === "error") return { accepted: false, errors: parsed.errors };
    if (parsed.kind === "help")
      return { accepted: false, errors: ["Help is not a launchable value set."] };
    const launchId = crypto.randomUUID();
    this.registry.create(launchId, commandId, this.now());
    const acknowledged = new Promise<PipelineRunStudioLaunchResult>((resolve) =>
      this.#waiters.set(launchId, resolve)
    );
    const timeoutMs = this.deps.startTimeoutMs ?? 30_000;
    const timeout = setTimeout(
      () =>
        this.settle(launchId, {
          accepted: false,
          errors: [
            `The run did not record a start within ${Math.round(timeoutMs / 1000)} seconds. It may still start; check history before launching again.`,
          ],
        }),
      timeoutMs
    );
    try {
      await this.deps.runStub(launchId).start({
        launchId,
        commandId,
        values,
        maxRunDurationMs: this.deps.maxRunDurationMs,
      });
      await this.deps.storage.setAlarm(
        this.now() + this.deps.maxRunDurationMs + RECONCILE_GRACE_MS
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      this.registry.fail(launchId, "The run host could not start the run.", this.now());
      this.settle(launchId, { accepted: false, errors: ["The run host could not start the run."] });
    }
    try {
      return await acknowledged;
    } finally {
      clearTimeout(timeout);
    }
  }

  settle(launchId: string, result: PipelineRunStudioLaunchResult): void {
    const resolve = this.#waiters.get(launchId);
    if (!resolve) return;
    this.#waiters.delete(launchId);
    resolve(result);
  }

  async cancel(runId: string): Promise<PipelineRunStudioCancelResult> {
    const launchId = this.registry.launchIdForRun(runId);
    if (!launchId) return { cancelled: false };
    return (await this.deps.runStub(launchId).cancel())
      ? { cancelled: true, runId }
      : { cancelled: false };
  }

  liveRunIds(): readonly string[] {
    return this.registry.liveRunIds();
  }
}

/** Singleton Studio object: event store, Studio API and launch registry. */
export class StudioObjectCore implements StudioIngest {
  readonly #store: DurableRunStore;
  readonly #registry: LaunchRegistry;
  readonly #launcher: DurableStudioLauncher;
  readonly #now: () => number;
  #host: Promise<StudioHost> | undefined;

  constructor(private readonly deps: StudioObjectDependencies) {
    this.#now = deps.now ?? Date.now;
    this.#store = openDurableRunStore(deps.storage);
    this.#registry = new LaunchRegistry(deps.storage, this.#store);
    this.#launcher = new DurableStudioLauncher(deps, this.#registry, this.#now);
  }

  async fetch(request: Request): Promise<Response> {
    this.#host ??= createStudioHost({
      store: this.#store,
      launcher: this.#launcher,
      clientScript: this.deps.clientScript,
    });
    return (await this.#host).fetch(request);
  }

  async appendEvents(
    launchId: string,
    sequence: number,
    events: PipelineTraceEvent[]
  ): Promise<void> {
    const outcome = this.#registry.acceptBatch(launchId, sequence, events);
    if (outcome.boundRunId)
      this.#launcher.settle(launchId, { accepted: true, runId: outcome.boundRunId });
  }

  async reportFailure(launchId: string, message: string): Promise<void> {
    this.#registry.fail(launchId, message, this.#now());
    this.#launcher.settle(launchId, { accepted: false, errors: [message] });
  }

  async alarm(): Promise<void> {
    const now = this.#now();
    for (const launchId of this.#registry.stale(
      now - this.deps.maxRunDurationMs - RECONCILE_GRACE_MS
    )) {
      await this.reportFailure(launchId, HOST_TERMINATED);
    }
    if (this.#registry.hasActive()) {
      await this.deps.storage.setAlarm(now + this.deps.maxRunDurationMs + RECONCILE_GRACE_MS);
    }
  }
}
