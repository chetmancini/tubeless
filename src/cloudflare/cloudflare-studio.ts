import type { HostedFailureReason, RunJob, StudioIngest } from "../hosting/run-contract.js";
import type { HostedCommand, HostedOutput } from "../hosting/hosting-commands.js";
import { createStudioHost, type StudioHost } from "../hosting/hosting-studio.js";
import { SqliteHostedLaunchStore } from "../hosting/launch-store-sqlite.js";
import type { HostedRunCoordinator } from "../hosting/run-coordinator.js";
import { admittedStudioLauncher } from "../hosting/admitted-studio-launcher.js";
import type { LaunchActor } from "../studio/shared/launch-metadata.js";
import { createTrustedHostedRun } from "../hosting/trusted-run-coordinator.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { openDurableRunStore, type DurableRunStore } from "./cloudflare-run-store.js";
import type { AgentTranscriptRecord } from "../tracing/agent-transcript.js";
import { PipelineRunStudioHistoryBusyError } from "../studio/server/state.js";
import { HOST_TERMINATED } from "./cloudflare-run-contract.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";
import {
  createHostedLaunchAdmission,
  type HostedLaunchRequest,
  type HostedLaunchResult,
} from "../hosting/launch-admission.js";

const RECONCILE_GRACE_MS = 120_000;
const DELIVERY_RETRY_MS = 2_000;
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
  readonly projectId: string;
  readonly deploymentId?: string;
  readonly inputPolicy?: ReadonlyMap<string, ReadonlySet<string>>;
}

export class StudioObjectCore implements StudioIngest {
  readonly #store: SqliteHostedLaunchStore;
  readonly #events: DurableRunStore;
  readonly #coordinator: HostedRunCoordinator;
  readonly #ingest: StudioIngest;
  readonly #now: () => number;
  readonly #admission: ReturnType<typeof createHostedLaunchAdmission>;
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
          cancel: async (id) =>
            deps.deploymentId === undefined
              ? deps.runStub(id).cancel()
              : (await this.cancelExecution(id))?.cancellationRequested === true,
        },
        scheduleReconcile: () => this.#scheduleReconcile(),
      },
      this.#store
    );
    this.#coordinator = launcher;
    this.#ingest = ingest;
    this.#admission = createHostedLaunchAdmission({
      projectId: deps.projectId,
      deploymentId: deps.deploymentId,
      commands: deps.commands,
      output: SILENT_OUTPUT,
      store: {
        get: (key) => this.#store.admissions.get(key),
        reserve: (request) =>
          deps.storage.transaction(async () => {
            const reservation = await this.#store.admissions.reserve(request);
            if (reservation.created) await this.#scheduleReconcile();
            return reservation;
          }),
      },
      maxRunDurationMs: deps.maxRunDurationMs,
      now: this.#now,
      inputPolicy: deps.inputPolicy,
    });
  }

  async #scheduleReconcile(): Promise<void> {
    const pending = await this.deps.storage.getAlarm();
    const earliest = this.#store.executions.nextAlarm(
      this.deps.maxRunDurationMs,
      RECONCILE_GRACE_MS
    );
    if (earliest === undefined) {
      if (pending !== null) await this.deps.storage.deleteAlarm();
    } else if (pending === null || pending <= this.#now() || pending > earliest) {
      await this.deps.storage.setAlarm(earliest);
    }
  }

  getLaunch(launchId: string) {
    return this.#store.launchStatus(launchId);
  }

  getExecution(launchId: string) {
    return this.#store.executions.status(launchId);
  }

  cancelExecution(launchId: string) {
    return this.deps.storage.transaction(async () => {
      const executions = this.#store.executions;
      if (executions.requestCancellation(launchId, this.#now())) await this.#scheduleReconcile();
      return executions.status(launchId);
    });
  }

  async launch(request: HostedLaunchRequest): Promise<HostedLaunchResult> {
    const decision = await this.#admission(request);
    if (!decision.accepted) return decision;
    return { accepted: true, launchId: decision.launchId };
  }

  async fetch(request: Request, actor?: LaunchActor): Promise<Response> {
    this.#host ??= createStudioHost({
      store: this.#events,
      launcher: admittedStudioLauncher({
        coordinator: this.#coordinator,
        projectId: this.deps.projectId,
        deploymentId: this.deps.deploymentId,
        admit: this.#admission,
        getLaunch: (id) => this.#store.launchStatus(id),
      }),
      launchMetadata: this.#store.metadata,
      clientScript: this.deps.clientScript,
      history: {
        clear: () =>
          this.deps.storage.transactionSync(() => {
            if (this.#store.hasActiveLaunches()) throw new PipelineRunStudioHistoryBusyError();
            this.#events.clearHistory();
            this.#store.metadata.clear();
          }),
      },
    });
    return (await this.#host).fetch(request, actor);
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
  reportFailure(launchId: string, message: string, reason?: HostedFailureReason) {
    return this.#ingest.reportFailure(launchId, message, reason);
  }

  async alarm(): Promise<void> {
    const now = this.#now();
    const executions = this.#store.executions;
    for (const id of executions.stale(now, this.deps.maxRunDurationMs, RECONCILE_GRACE_MS)) {
      await this.#ingest.reportFailure(id, HOST_TERMINATED, "host_terminated");
    }
    // Commit the delivery snapshot and its next alarm before crossing RPC.
    const actions = await this.deps.storage.transaction(async () => {
      const pending = executions.takeDue(now, now + DELIVERY_RETRY_MS);
      await this.#scheduleReconcile();
      return pending;
    });
    await Promise.all(
      actions.map(async (action) => {
        try {
          const run = this.deps.runStub(action.launchId);
          if (action.kind === "dispatch") await run.start(action.job);
          else if (!(await run.cancel())) return;
          executions.delivered(action.launchId, action.kind);
        } catch (error) {
          console.error(error);
        }
      })
    );
  }
}
