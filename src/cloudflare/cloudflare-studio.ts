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
import { CloudflareRunnerQueue } from "./cloudflare-runner-queue.js";
import { serveRunnerRequest } from "./cloudflare-runner-api.js";
import type { RunnerJob } from "../hosting/runner-protocol.js";
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
  readonly localPipelines?: ReadonlyMap<string, string>;
  readonly inputPolicy?: ReadonlyMap<string, ReadonlySet<string>>;
}

export class StudioObjectCore implements StudioIngest {
  readonly #store: SqliteHostedLaunchStore;
  readonly #events: DurableRunStore;
  readonly #coordinator: HostedRunCoordinator;
  readonly #ingest: StudioIngest;
  readonly #runners: CloudflareRunnerQueue;
  readonly #now: () => number;
  readonly #admission: ReturnType<typeof createHostedLaunchAdmission>;
  #host: Promise<StudioHost> | undefined;

  constructor(private readonly deps: StudioObjectDependencies) {
    this.#now = deps.now ?? Date.now;
    this.#events = openDurableRunStore(deps.storage);
    this.#store = new SqliteHostedLaunchStore(deps.storage, this.#events, this.#now);
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
    this.#runners = new CloudflareRunnerQueue({
      storage: deps.storage,
      store: this.#store,
      events: this.#events,
      ingest,
      now: this.#now,
      schedule: () => this.#scheduleReconcile(),
    });
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
            if (!reservation.created) return reservation;
            const { job } = request;
            if (job.target === "local") {
              const definitionId = deps.localPipelines?.get(job.commandId);
              if (job.deploymentId === undefined || definitionId === undefined)
                throw new Error("Cannot queue an unpinned local runner job.");
              this.#runners.enqueue({
                id: job.launchId,
                kind: "root",
                launchId: job.launchId,
                deploymentId: job.deploymentId,
                pipelineId: job.commandId,
                definitionId,
                run: job,
              });
            }
            await this.#scheduleReconcile();
            return reservation;
          }),
      },
      maxRunDurationMs: deps.maxRunDurationMs,
      now: this.#now,
      inputPolicy: deps.inputPolicy,
      localPipelines: deps.localPipelines,
    });
  }

  async #scheduleReconcile(): Promise<void> {
    const pending = await this.deps.storage.getAlarm();
    const earliest = Math.min(
      this.#store.executions.nextAlarm(this.deps.maxRunDurationMs, RECONCILE_GRACE_MS) ?? Infinity,
      this.#runners.nextAlarm() ?? Infinity
    );
    if (earliest === Infinity) {
      if (pending !== null) await this.deps.storage.deleteAlarm();
    } else if (pending === null || pending <= this.#now() || pending > earliest) {
      await this.deps.storage.setAlarm(earliest);
    }
  }

  getLaunch(launchId: string) {
    return this.#store.launchStatus(launchId);
  }

  getExecution(launchId: string) {
    const status = this.#store.executions.status(launchId);
    if (!status) return undefined;
    if (status.target === undefined && this.deps.localPipelines !== undefined)
      return { ...status, target: "cloudflare" as const };
    if (status.target !== "local" || status.state !== "queued") return status;
    return {
      ...status,
      reason: this.#runners.queuedReason(
        launchId,
        this.deps.deploymentId,
        this.deps.localPipelines
      ),
    };
  }

  cancelExecution(launchId: string) {
    return this.deps.storage.transaction(async () => {
      const executions = this.#store.executions;
      if (executions.requestCancellation(launchId, this.#now())) {
        this.#runners.cancel(launchId);
        await this.#scheduleReconcile();
      }
      return this.getExecution(launchId);
    });
  }

  serveRunner(request: Request): Promise<Response> {
    const { projectId, deploymentId, localPipelines } = this.deps;
    if (deploymentId === undefined || localPipelines === undefined)
      throw new Error("Local runner unavailable.");
    return serveRunnerRequest(request, this.#runners, projectId, deploymentId, localPipelines);
  }

  enqueueStage(job: RunnerJob & { kind: "stage" }): Promise<void> {
    return this.deps.storage.transaction(async () => {
      const status = this.getExecution(job.launchId);
      if (
        status?.state !== "running" ||
        status.cancellationRequested ||
        job.deploymentId !== this.deps.deploymentId ||
        job.definitionId !== this.deps.localPipelines?.get(job.pipelineId)
      )
        throw new Error("The execution cannot queue this stage.");
      this.#runners.enqueue(job);
      await this.#scheduleReconcile();
    });
  }

  readStage(launchId: string, id: string, afterId: number) {
    return this.#runners.readStage(launchId, id, afterId);
  }

  cancelStage(launchId: string, id: string): Promise<void> {
    return this.deps.storage.transaction(async () => {
      this.#runners.cancel(launchId, id);
      await this.#scheduleReconcile();
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
    return this.deps.storage.transaction(async () => {
      const result = await this.#ingest.appendEvents(launchId, sequence, events);
      if (
        result.accepted &&
        events.some(
          (event) => event.name === "pipeline.completed" && event.parentRunId === undefined
        )
      )
        this.#runners.clearFinishedLaunch(launchId);
      return result;
    });
  }
  reportFailure(launchId: string, message: string, reason?: HostedFailureReason) {
    return this.deps.storage.transaction(async () => {
      await this.#ingest.reportFailure(launchId, message, reason);
      this.#runners.clearFinishedLaunch(launchId);
    });
  }

  async alarm(): Promise<void> {
    const now = this.#now();
    const executions = this.#store.executions;
    for (const id of executions.stale(now, this.deps.maxRunDurationMs, RECONCILE_GRACE_MS)) {
      await this.reportFailure(id, HOST_TERMINATED, "host_terminated");
    }
    // Commit the delivery snapshot and its next alarm before crossing RPC.
    const actions = await this.deps.storage.transaction(async () => {
      await this.#runners.expire();
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
