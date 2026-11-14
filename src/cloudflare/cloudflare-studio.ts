import type { RunJob, StudioIngest } from "../hosting/run-contract.js";
import type { HostedCommand, HostedOutput } from "../hosting/hosting-commands.js";
import { createStudioHost, type StudioHost } from "../hosting/hosting-studio.js";
import { createSqliteLaunchStore } from "../hosting/launch-registry.js";
import type { HostedLaunchStore } from "../hosting/launch-store.js";
import { HostedRunCoordinator } from "../hosting/run-coordinator.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { openDurableRunStore } from "./cloudflare-run-store.js";
import { HOST_TERMINATED } from "./cloudflare-run-contract.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

const RECONCILE_GRACE_MS = 120_000;
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

/** Singleton Studio object: Durable Object adapters around shared launch coordination. */
export class StudioObjectCore implements StudioIngest {
  readonly #store: HostedLaunchStore;
  readonly #coordinator: HostedRunCoordinator;
  readonly #now: () => number;
  #host: Promise<StudioHost> | undefined;

  constructor(private readonly deps: StudioObjectDependencies) {
    this.#now = deps.now ?? Date.now;
    this.#store = createSqliteLaunchStore(deps.storage, openDurableRunStore(deps.storage));
    this.#coordinator = new HostedRunCoordinator(
      {
        commands: deps.commands,
        output: SILENT_OUTPUT,
        maxRunDurationMs: deps.maxRunDurationMs,
        startTimeoutMs: deps.startTimeoutMs,
        now: this.#now,
        executor: {
          start: (job) => deps.runStub(job.launchId).start(job),
          cancel: async (id) => deps.runStub(id).cancel(),
        },
        scheduleReconcile: () => this.#scheduleReconcile(),
      },
      this.#store
    );
  }

  async #scheduleReconcile(): Promise<void> {
    const pending = await this.deps.storage.getAlarm();
    const target = await this.#store.nextReconcileAt(
      this.deps.maxRunDurationMs + RECONCILE_GRACE_MS
    );
    if (target === undefined) {
      if (pending !== null) await this.deps.storage.deleteAlarm();
    } else if (pending === null || pending <= this.#now() || pending > target) {
      await this.deps.storage.setAlarm(target);
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.#host ??= createStudioHost({
      store: this.#store,
      launcher: this.#coordinator,
      clientScript: this.deps.clientScript,
    });
    return (await this.#host).fetch(request);
  }

  admit(launchId: string) {
    return this.#coordinator.admit(launchId);
  }
  appendEvents(launchId: string, sequence: number, events: PipelineTraceEvent[]) {
    return this.#coordinator.appendEvents(launchId, sequence, events);
  }
  reportFailure(launchId: string, message: string) {
    return this.#coordinator.reportFailure(launchId, message);
  }

  async alarm(): Promise<void> {
    const now = this.#now();
    for (const id of await this.#store.stale(
      now - this.deps.maxRunDurationMs - RECONCILE_GRACE_MS
    )) {
      await this.#coordinator.reportFailure(id, HOST_TERMINATED);
    }
    await this.#scheduleReconcile();
  }
}
