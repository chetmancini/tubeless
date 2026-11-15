import type { RunJob, StudioIngest } from "../hosting/run-contract.js";
import type { HostedCommand, HostedOutput } from "../hosting/hosting-commands.js";
import { createStudioHost, type StudioHost } from "../hosting/hosting-studio.js";
import { SqliteHostedLaunchStore } from "../hosting/launch-store-sqlite.js";
import type { HostedRunCoordinator } from "../hosting/run-coordinator.js";
import { createTrustedHostedRun } from "../hosting/trusted-run-coordinator.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { openDurableRunStore, type DurableRunStore } from "./cloudflare-run-store.js";
import type { AgentTranscriptRecord } from "../tracing/agent-transcript.js";
import { PipelineRunStudioHistoryBusyError } from "../studio/server/state.js";
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
  readonly #store: SqliteHostedLaunchStore;
  readonly #events: DurableRunStore;
  readonly #coordinator: HostedRunCoordinator;
  readonly #ingest: StudioIngest;
  readonly #now: () => number;
  #host: Promise<StudioHost> | undefined;

  constructor(private readonly deps: StudioObjectDependencies) {
    this.#now = deps.now ?? Date.now;
    this.#events = openDurableRunStore(deps.storage);
    this.#store = new SqliteHostedLaunchStore(deps.storage, this.#events);
    const { launcher, ingest } = createTrustedHostedRun(
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
    this.#coordinator = launcher;
    this.#ingest = ingest;
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
      store: this.#events,
      launcher: this.#coordinator,
      clientScript: this.deps.clientScript,
      history: {
        clear: () =>
          this.deps.storage.transactionSync(() => {
            if (this.#store.hasActiveLaunches()) throw new PipelineRunStudioHistoryBusyError();
            this.#events.clearHistory();
          }),
      },
    });
    return (await this.#host).fetch(request);
  }

  async appendTranscript(record: AgentTranscriptRecord): Promise<{ accepted: boolean }> {
    return { accepted: this.#events.appendTranscript(record) };
  }

  admit(launchId: string) {
    return this.#ingest.admit(launchId);
  }
  appendEvents(launchId: string, sequence: number, events: PipelineTraceEvent[]) {
    return this.#ingest.appendEvents(launchId, sequence, events);
  }
  reportFailure(launchId: string, message: string) {
    return this.#ingest.reportFailure(launchId, message);
  }

  async alarm(): Promise<void> {
    const now = this.#now();
    for (const id of await this.#store.stale(
      now - this.deps.maxRunDurationMs - RECONCILE_GRACE_MS
    )) {
      await this.#ingest.reportFailure(id, HOST_TERMINATED);
    }
    await this.#scheduleReconcile();
  }
}
