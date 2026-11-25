import { createRunnerAttempt } from "../../hosting/runner/trace.js";
import { executeHostedStage } from "../../hosting/runner/run-stage.js";
import type { HostedCommand } from "../../hosting/hosting-commands.js";
import type { RunnerStageJob } from "../../hosting/runner-protocol.js";
import type { AnyProjectPipeline } from "../../project/pipeline-project.js";
import type { PipelineTraceExporterOptions } from "../../tracing/tracing.js";
import { abortableSleep, awaitWithAbort, throwIfAborted } from "../../utilities/abort.js";
import { withRetry } from "../../utilities/retry.js";
import type { CloudflareRunTraceContext } from "../cloudflare-run-contract.js";
import type { DurableStorageLike } from "../cloudflare-storage.js";
import { boundCloudflareTraceExporter, retryableCloudflareRpc } from "../cloudflare-tracing.js";

export type WorkerStageIdentity = Pick<RunnerStageJob, "id" | "launchId" | "deploymentId">;

export interface WorkerStageIngest {
  workerStageStatus(stage: WorkerStageIdentity): Promise<{ active: boolean; cancelled: boolean }>;
  appendWorkerStage(stage: WorkerStageIdentity, body: Uint8Array): Promise<{ accepted: boolean }>;
  settleWorkerStage(stage: WorkerStageIdentity, message?: string): Promise<void>;
}

type StoredStage = { state: "pending" | "running"; job: RunnerStageJob } | { state: "finished" };

/** One durable stage receipt. An alarm retry can confirm settlement, but cannot repeat user code. */
export class WorkerStageCore {
  constructor(
    private readonly deps: {
      readonly storage: DurableStorageLike;
      readonly deploymentId: string | undefined;
      readonly definitions: ReadonlyMap<string, string> | undefined;
      readonly commands: ReadonlyMap<string, HostedCommand>;
      readonly getPipeline: (id: string) => AnyProjectPipeline;
      readonly ingest: () => WorkerStageIngest;
      readonly tracing?: PipelineTraceExporterOptions<CloudflareRunTraceContext>;
    }
  ) {}

  start(job: RunnerStageJob): Promise<void> {
    const { storage } = this.deps;
    return storage.transaction(async () => {
      if (await storage.get<StoredStage>("workerStage")) return;
      await Promise.all([
        storage.put("workerStage", { state: "pending", job } satisfies StoredStage),
        storage.setAlarm(Date.now()),
      ]);
    });
  }

  async alarm(): Promise<boolean> {
    const { storage, definitions, deploymentId, ingest } = this.deps;
    const delivery = await storage.get<StoredStage>("workerStage");
    if (!delivery) return false;
    if (delivery.state === "finished") return true;
    const { job, state } = delivery;
    const identity = { id: job.id, launchId: job.launchId, deploymentId: job.deploymentId };
    await storage.setAlarm(Date.now() + 2_000);
    try {
      const status = await ingest().workerStageStatus(identity);
      if (status.active) {
        if (status.cancelled || state === "running") {
          await ingest().settleWorkerStage(identity);
        } else if (
          definitions?.get(job.pipelineId) !== job.definitionId ||
          deploymentId !== job.deploymentId
        ) {
          await ingest().settleWorkerStage(
            identity,
            "The Worker stage definition does not match the admitted release."
          );
        } else if (Date.now() >= job.deadlineAtMs) {
          await ingest().settleWorkerStage(
            identity,
            "The Worker stage deadline expired before it started."
          );
        } else {
          await storage.put("workerStage", { state: "running", job } satisfies StoredStage);
          await this.#execute(job, identity);
        }
      }
      await storage.transaction(async () => {
        await Promise.all([
          storage.put("workerStage", { state: "finished" } satisfies StoredStage),
          storage.deleteAlarm(),
        ]);
      });
    } catch (error) {
      // The alarm rechecks the durable result or marks the interrupted stage without replaying effects.
      console.error(error);
    }
    return true;
  }

  async #execute(job: RunnerStageJob, identity: WorkerStageIdentity): Promise<void> {
    const { ingest, tracing, commands, getPipeline } = this.deps;
    const controller = new AbortController();
    const done = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(new DOMException("The Worker stage deadline expired.", "TimeoutError")),
      Math.max(0, job.deadlineAtMs - Date.now())
    );
    const check = async () => {
      const state = await ingest().workerStageStatus(identity);
      if (!state.active || state.cancelled)
        controller.abort(
          new DOMException("The Worker stage was cancelled or lost its dispatch.", "AbortError")
        );
    };
    const monitor = async () => {
      while (!done.signal.aborted && !controller.signal.aborted) {
        await abortableSleep(1_000, done.signal, "Check Worker stage ownership");
        await awaitWithAbort(check(), done.signal, "Check Worker stage ownership");
      }
    };
    let watching: Promise<void> | undefined;
    const { exporter, prepareCompletion, send } = createRunnerAttempt({
      id: job.id,
      onFailure: (error) => controller.abort(error),
      async send(bytes) {
        const { accepted } = await withRetry(() => ingest().appendWorkerStage(identity, bytes), {
          shouldRetry: retryableCloudflareRpc,
        });
        if (!accepted) throw new Error("Studio no longer accepts this Worker stage.");
      },
    });
    try {
      await check();
      throwIfAborted(controller.signal, "Start Worker stage");
      watching = monitor().catch((error: unknown) => {
        if (!done.signal.aborted) controller.abort(error);
      });
      const { completion, report } = await executeHostedStage({
        job,
        pipeline: getPipeline(job.pipelineId),
        cwd: "/tmp",
        signal: controller.signal,
        exporter,
        confirmStart: true,
        configurations: [commands.get(job.pipelineId)?.tracing, tracing],
        wrapExporter: (destination) => boundCloudflareTraceExporter(destination, job.deadlineAtMs),
      });
      await send(prepareCompletion(completion, report));
    } finally {
      clearTimeout(timeout);
      done.abort();
      await watching;
    }
  }
}
