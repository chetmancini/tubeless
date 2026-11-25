import { HostedAttemptConflict } from "../../hosting/attempt/store.js";
import type { SqliteHostedLaunchStore } from "../../hosting/launch-store-sqlite.js";
import {
  RUNNER_DRAIN_MS,
  type RunnerStageJob,
  stageDispatchBinding,
  type RunnerStageRequest,
} from "../../hosting/runner-protocol.js";
import { digestRunnerLease, type CloudflareRunnerClaims } from "../runner/claims.js";
import type { DurableStorageLike } from "../cloudflare-storage.js";
import type { WorkerStageIdentity } from "./run.js";

/**
 * Durable delivery of a Bun root's Worker children through Studio.
 * The outbox retains the next delivery time until the run object acknowledges it.
 * The dispatch lease belongs to that object for the lifetime of the stage.
 */
export class WorkerStageDispatch {
  constructor(
    private readonly deps: {
      readonly storage: DurableStorageLike;
      readonly store: SqliteHostedLaunchStore;
      readonly claims: CloudflareRunnerClaims;
      readonly now: () => number;
      readonly schedule: () => Promise<void>;
      readonly enqueue: (job: RunnerStageJob, binding: string) => void;
      readonly cancel: (launchId: string, id: string) => void;
    }
  ) {}

  get #sql() {
    return this.deps.storage.sql;
  }

  async request(
    owner: { id: string; token: string; deploymentId: string },
    definitions: ReadonlyMap<string, string> | undefined,
    request:
      | { kind: "enqueue"; job: RunnerStageRequest }
      | { kind: "read" | "cancel"; stageId: string }
  ) {
    const { id, token, deploymentId } = owner;
    const [digest, action] = await Promise.all([
      digestRunnerLease(token),
      request.kind === "enqueue"
        ? stageDispatchBinding(request.job).then((binding) => ({ ...request, binding }))
        : request,
    ]);
    return this.deps.storage.transaction(async () => {
      const root = this.deps.claims.active(this.deps.claims.lease(id, digest, deploymentId));
      if (root?.job.kind !== "root" || !root.job.workerChildren) return { accepted: false };
      const status = this.deps.store.executions.status(id);
      if (status?.state !== "running") return { accepted: false };
      if (root.cancelled && action.kind !== "cancel") return { accepted: true, cancelled: true };
      if (action.kind === "enqueue") {
        const { job } = action;
        if (root.deadlineAtMs <= this.deps.now()) return { accepted: false };
        if (
          job.id === id ||
          job.launchId !== id ||
          job.deploymentId !== deploymentId ||
          !Object.hasOwn(root.job.workerChildren, job.pipelineId) ||
          root.job.workerChildren[job.pipelineId] !== job.definitionId ||
          definitions?.get(job.pipelineId) !== job.definitionId
        )
          throw new HostedAttemptConflict("events");
        const attemptId = root.recoveryAttemptId ?? id;
        if (!this.deps.store.attemptLedger.ownsRun(attemptId, job.stage.parentRunId))
          throw new HostedAttemptConflict("events");
        this.deps.enqueue({ ...job, deadlineAtMs: root.deadlineAtMs }, action.binding);
        await this.deps.schedule();
      } else {
        const row = this.#sql
          .exec(
            `SELECT result_json FROM tubeless_runner_queue
           WHERE id = ? AND launch_id = ? AND target = 'cloudflare'`,
            action.stageId,
            id
          )
          .toArray()[0];
        if (!row) return { accepted: false };
        if (action.kind === "read" && typeof row.result_json === "string")
          return { accepted: true, result: JSON.parse(row.result_json) as unknown };
        if (action.kind === "cancel") {
          this.deps.cancel(id, action.stageId);
          await this.deps.schedule();
        }
      }
      return { accepted: true };
    });
  }

  takeDue(now: number, retryAt: number): RunnerStageJob[] {
    return this.#sql
      .exec(
        `UPDATE tubeless_runner_queue
         SET lease_until_ms = deadline_at_ms + ?, worker_dispatch_at_ms = ?
         WHERE id IN (
           SELECT id FROM tubeless_runner_queue
           WHERE job_json IS NOT NULL AND worker_dispatch_at_ms <= ?
             AND cancelled = 0 AND deadline_at_ms > ?
           ORDER BY worker_dispatch_at_ms LIMIT 20
         )
         RETURNING job_json`,
        RUNNER_DRAIN_MS,
        retryAt,
        now,
        now
      )
      .toArray()
      .map((row) => JSON.parse(String(row.job_json)) as RunnerStageJob);
  }

  delivered(id: string): void {
    this.#sql.exec(
      "UPDATE tubeless_runner_queue SET worker_dispatch_at_ms = NULL WHERE id = ?",
      id
    );
  }

  /** Private RPCs identify the stage by its durable object name and admitted deployment. */
  lookup(job: WorkerStageIdentity) {
    return this.#sql
      .exec(
        `SELECT * FROM tubeless_runner_queue
       WHERE target = 'cloudflare' AND id = ? AND launch_id = ? AND deployment_id = ?`,
        job.id,
        job.launchId,
        job.deploymentId
      )
      .toArray()[0];
  }

  status(job: WorkerStageIdentity) {
    const row = this.deps.claims.active(this.lookup(job));
    return {
      active: Boolean(row) && this.deps.store.executions.status(job.launchId)?.state === "running",
      cancelled: row?.cancelled ?? false,
    };
  }
}
