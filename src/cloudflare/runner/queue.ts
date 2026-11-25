import type { WorkerStageIdentity } from "../stage/run.js";
import { initializeRunnerQueue } from "./queue-schema.js";
import { WorkerStageDispatch } from "../stage/dispatch.js";
import { CloudflareRunnerClaims, digestRunnerLease } from "./claims.js";
import type { RunnerStageObservation } from "../../hosting/runner/child-placement.js";
import { HostedAttemptConflict } from "../../hosting/attempt/store.js";
import { decodeRunnerBatch } from "../../hosting/attempt/batch.js";
import type { SqliteHostedLaunchStore } from "../../hosting/launch-store-sqlite.js";
import {
  boundedRunnerJson,
  decodeRunnerReport,
  decodeStageResult,
  RUNNER_INTERRUPTED,
  type RunnerJob,
  type RunnerStageResult,
} from "../../hosting/runner-protocol.js";
import type { HostedExecutionReason } from "../../hosting/execution-status.js";
import type { StudioIngest } from "../../hosting/run-contract.js";
import type { PipelineTraceEvent } from "../../tracing/tracing.js";
import type { DurableStorageLike } from "../cloudflare-storage.js";
import type { DurableRunStore } from "../cloudflare-run-store.js";

const cancelled = { error: "The remote stage was cancelled." } as const;
const workerInterrupted = {
  error: "The Worker stage stopped before confirming its result and may have performed effects.",
  interrupted: true,
} as const;

function workerStageExpiry(
  cancelledByParent: boolean,
  dispatched: boolean
): Extract<RunnerStageResult, { error: string }> {
  if (cancelledByParent) return cancelled;
  if (dispatched) return workerInterrupted;
  return { error: "The Worker stage was not dispatched before its deadline." };
}

const expired = { error: RUNNER_INTERRUPTED, interrupted: true } as const;

export class CloudflareRunnerQueue {
  readonly claims: CloudflareRunnerClaims;
  readonly workerStages: WorkerStageDispatch;

  constructor(
    private readonly deps: {
      storage: DurableStorageLike;
      store: SqliteHostedLaunchStore;
      events: DurableRunStore;
      ingest: StudioIngest;
      now: () => number;
      schedule: () => Promise<void>;
    }
  ) {
    initializeRunnerQueue(deps.storage.sql);
    this.claims = new CloudflareRunnerClaims({
      ...deps,
      activeStageRunIds: (id) => this.activeStageRunIds(id),
    });
    this.workerStages = new WorkerStageDispatch({
      ...deps,
      claims: this.claims,
      enqueue: (job, binding) => this.enqueue(job, binding, "cloudflare"),
      cancel: (launchId, stageId) => this.cancel(launchId, stageId),
    });
  }

  get #sql() {
    return this.deps.storage.sql;
  }

  enqueue(job: RunnerJob, binding?: string, target: "local" | "cloudflare" = "local"): void {
    if (binding !== undefined) {
      const [saved] = this.#sql
        .exec("SELECT recovery_binding FROM tubeless_runner_queue WHERE id = ?", job.id)
        .toArray();
      if (saved) {
        if (saved.recovery_binding !== binding)
          throw new Error("Recovered stage differs from its admitted input, version, or controls.");
        return;
      }
    }
    this.#sql.exec(
      `INSERT INTO tubeless_runner_queue
        (id, launch_id, deployment_id, pipeline_id, definition_id, job_json, deadline_at_ms, recovery_binding, target, worker_dispatch_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.launchId,
      job.deploymentId,
      job.pipelineId,
      job.definitionId,
      JSON.stringify(job),
      job.kind === "stage" ? job.deadlineAtMs : null,
      binding ?? null,
      target,
      target === "cloudflare" ? this.deps.now() : null
    );
  }

  queuedReason(
    launchId: string,
    deploymentId: string | undefined,
    definitions: ReadonlyMap<string, string> | undefined
  ): HostedExecutionReason {
    const row = this.#sql
      .exec(
        "SELECT deployment_id, pipeline_id, definition_id, incompatible FROM tubeless_runner_queue WHERE id = ?",
        launchId
      )
      .toArray()[0];
    if (!row || row.deployment_id !== deploymentId) return "deployment_unavailable";
    if (definitions?.get(String(row.pipeline_id)) !== row.definition_id || row.incompatible === 1)
      return "runner_incompatible";
    return "runner_waiting";
  }

  settleWorkerStage(job: WorkerStageIdentity, message?: string): Promise<void> {
    return this.deps.storage.transaction(async () => {
      const row = this.claims.active(this.workerStages.lookup(job));
      if (!row) return;
      this.#failStage(
        job.launchId,
        job.id,
        row.cancelled ? cancelled : message === undefined ? workerInterrupted : { error: message }
      );
      await this.deps.schedule();
    });
  }

  async append(
    source: WorkerStageIdentity | { token: string; deploymentId: string },
    bytes: Uint8Array
  ): Promise<{ accepted: boolean }> {
    const [batch, owner] = await Promise.all([
      decodeRunnerBatch(bytes),
      "token" in source
        ? digestRunnerLease(source.token).then((digest) => ({
            digest,
            deploymentId: source.deploymentId,
          }))
        : source,
    ]);
    return this.deps.storage.transaction(async () => {
      const local = "digest" in owner;
      if (!local && batch.attemptId !== owner.id) return { accepted: false };
      const lease = local
        ? this.claims.leaseForAttempt(batch.attemptId, owner.digest, owner.deploymentId)
        : this.workerStages.lookup(owner);
      const row = this.claims.active(lease);
      // A sealed receipt proves an already committed batch, even after the parent consumes the result.
      if (!row && !(lease?.job_json === null && (lease.lease_digest || lease.lease_until_ms)))
        return { accepted: false };
      const ledger = this.deps.store.attemptLedger;
      const status = ledger.check(batch);
      if (status.kind === "replay") return { accepted: true };
      if (!row || status.kind === "gap") return { accepted: false };
      const { job } = row;
      const stage = job.kind === "stage" ? job.stage : undefined;
      if (stage && this.deps.store.executions.status(job.launchId)?.state !== "running")
        return { accepted: false };
      const root = ledger.bindBatch(
        batch,
        {
          pipelineId: job.pipelineId,
          definitionId: job.definitionId,
          parentRunId: stage?.parentRunId,
          stepId: stage?.stepId,
        },
        status.runId
      );
      const firstBatch = status.runId === undefined;
      const events = firstBatch
        ? this.#withRunnerLog(batch.events, batch.attemptId, root, local ? "local" : "Cloudflare")
        : [...batch.events];

      if (!stage) {
        if (batch.report !== undefined)
          throw new TypeError("A root attempt does not carry a stage report.");
        // Rejected writes roll back their new run bindings.
        if (!(await this.deps.ingest.appendEvents(job.launchId, batch.sequence, events)).accepted)
          throw new HostedAttemptConflict("events");
        if (events.some((event) => event.name === "pipeline.completed" && event.runId === root)) {
          if (row.recoveryAttemptId) {
            this.#close(job.id, undefined, true);
            this.claims.clearJournal(job.launchId);
          }
          this.clearFinishedLaunch(job.launchId);
          await this.deps.schedule();
        }
      } else if (batch.report === undefined) {
        if (
          batch.events.some((event) => event.name === "pipeline.completed" && event.runId === root)
        )
          throw new TypeError("Remote stage completion requires its result.");
        this.deps.events.append(events);
      } else {
        // Progress and nested histories arrive first. The terminal batch holds one event.
        const completion = batch.events[0];
        if (
          firstBatch ||
          batch.events.length !== 1 ||
          completion.name !== "pipeline.completed" ||
          completion.runId !== root
        )
          throw new TypeError("Remote stage result requires its terminal event.");
        const report = decodeRunnerReport(batch.report);
        if (
          report.runId !== root ||
          report.pipelineId !== job.pipelineId ||
          report.parentRunId !== stage.parentRunId ||
          report.dryRun !== ("controls" in stage ? stage.controls.dryRun === true : stage.dryRun) ||
          report.definitionIdentity?.definitionId !== job.definitionId ||
          report.correlationId !== stage.correlationId ||
          completion.payload.status !== report.status ||
          completion.payload.finalized !== report.finalized ||
          completion.payload.dryRun !== report.dryRun
        )
          throw new TypeError("Remote stage result does not match its completion.");
        if (row.cancelled && report.status !== "cancelled")
          this.#interruptStage(job.id, cancelled.error);
        else this.deps.events.append(events);
        this.#close(job.id, row.cancelled ? cancelled : { report }, true);
      }
      if (batch.report !== undefined) await this.deps.schedule();
      return { accepted: true };
    });
  }

  #withRunnerLog(
    events: readonly PipelineTraceEvent[],
    attemptId: string,
    root: string,
    runner: "local" | "Cloudflare"
  ): PipelineTraceEvent[] {
    const index = events.findIndex(
      (event) => event.runId === root && event.name === "pipeline.started"
    );
    const started = events[index];
    const { payload: _payload, ...identity } = started;
    const log: PipelineTraceEvent = {
      ...identity,
      name: "pipeline.log",
      payload: {
        level: "log",
        message: `Runner ${runner} · attempt ${attemptId}`,
      },
    };
    return [...events.slice(0, index + 1), log, ...events.slice(index + 1)];
  }

  async finish(id: string, token: string, deploymentId: string, result: unknown) {
    const leaseDigest = await digestRunnerLease(token);
    return this.deps.storage.transaction(async () => {
      const row = this.claims.active(this.claims.lease(id, leaseDigest, deploymentId));
      if (!row) return { accepted: false };
      const { job } = row;
      if (job.kind === "root") {
        if (result !== null && typeof result !== "string")
          throw new TypeError("Invalid root completion.");
        const error =
          typeof result === "string"
            ? result.slice(0, 2_000)
            : "The local runner did not record a terminal run.";
        if (row.recoveryAttemptId && row.cancelled)
          this.deps.store.admitRecovery(job.launchId, undefined, []);
        if (this.deps.store.executions.status(job.launchId)?.state === "running")
          await this.deps.ingest.reportFailure(job.launchId, error);
        this.#close(id);
        if (row.recoveryAttemptId) this.claims.clearJournal(job.launchId);
        this.clearFinishedLaunch(job.launchId);
      } else {
        if (typeof result !== "string")
          throw new TypeError("Remote stage results belong in the terminal trace batch.");
        this.#failStage(
          job.launchId,
          id,
          row.cancelled ? cancelled : { error: result.slice(0, 2_000) }
        );
      }
      await this.deps.schedule();
      return { accepted: true };
    });
  }

  #close(id: string, result?: RunnerStageResult, sealed = false): void {
    this.#sql.exec(
      `UPDATE tubeless_runner_queue SET job_json = NULL, deadline_at_ms = NULL, worker_dispatch_at_ms = NULL,
       lease_until_ms = CASE WHEN ? AND target = 'cloudflare' THEN lease_until_ms END,
       lease_digest = CASE WHEN ? THEN lease_digest END, result_json = ? WHERE id = ?`,
      sealed ? 1 : 0,
      sealed ? 1 : 0,
      result === undefined ? null : boundedRunnerJson(result, "Remote stage result"),
      id
    );
  }

  #interruptStage(id: string, message: string): void {
    const runId = this.deps.store.attemptLedger.latest(id)?.runId;
    if (runId !== undefined)
      this.deps.events.append(this.deps.store.interruptRuns(runId, message, this.deps.now()));
  }

  #failStage(
    launchId: string,
    id: string,
    result: Extract<RunnerStageResult, { error: string }>
  ): void {
    this.#interruptStage(id, result.error);
    this.#close(
      id,
      this.deps.store.executions.status(launchId)?.state === "running" ? result : undefined
    );
  }

  readStage(launchId: string, id: string, afterId: number): RunnerStageObservation {
    const row = this.#sql
      .exec(
        "SELECT result_json FROM tubeless_runner_queue WHERE id = ? AND launch_id = ?",
        id,
        launchId
      )
      .toArray()[0];
    if (!row) return { result: { error: "Unknown remote stage." }, events: [] };
    const runId = this.deps.store.attemptLedger.latest(id)?.runId;
    const { events, hasMore } =
      runId === undefined
        ? { events: [], hasMore: false }
        : this.deps.events.listChildProgress(runId, afterId);
    if (hasMore) return { events, hasMore };
    if (typeof row.result_json !== "string") return { events };
    return { events, result: decodeStageResult(JSON.parse(row.result_json)) };
  }

  activeStageRunIds(launchId: string): string[] {
    const stages = this.#sql
      .exec(
        `SELECT id FROM tubeless_runner_queue
         WHERE launch_id = ? AND id <> launch_id
           AND job_json IS NOT NULL AND lease_until_ms IS NOT NULL`,
        launchId
      )
      .toArray();
    return this.deps.store.attemptLedger.runIds(stages.map(({ id }) => String(id)));
  }

  cancel(launchId: string, stageId?: string): void {
    if (stageId === undefined && this.claims.isWaitingForRecovery(launchId)) {
      this.deps.store.admitRecovery(launchId, undefined, []);
      this.claims.clearJournal(launchId);
    }
    this.#sql.exec(
      `UPDATE tubeless_runner_queue SET cancelled = 1,
        job_json = CASE WHEN lease_until_ms IS NOT NULL THEN job_json END,
        deadline_at_ms = CASE WHEN lease_until_ms IS NOT NULL THEN deadline_at_ms END,
        result_json = CASE WHEN lease_until_ms IS NULL THEN ? ELSE result_json END
       WHERE launch_id = ? AND job_json IS NOT NULL AND (? IS NULL OR id = ?)`,
      JSON.stringify(cancelled),
      launchId,
      stageId ?? null,
      stageId ?? null
    );
  }

  clearFinishedLaunch(launchId: string): void {
    this.cancel(launchId);
    const activeStages = this.#sql
      .exec(
        "SELECT id FROM tubeless_runner_queue WHERE launch_id = ? AND id <> launch_id AND job_json IS NOT NULL",
        launchId
      )
      .toArray();
    for (const stage of activeStages)
      this.#interruptStage(
        String(stage.id),
        "The parent execution ended before the remote stage confirmed completion."
      );
    this.#sql.exec(
      "UPDATE tubeless_runner_queue SET result_json = NULL, recovery_binding = NULL WHERE launch_id = ? AND id <> launch_id AND job_json IS NULL AND COALESCE(lease_digest, lease_until_ms) IS NOT NULL",
      launchId
    );
    this.#sql.exec(
      "DELETE FROM tubeless_runner_queue WHERE launch_id = ? AND id <> launch_id AND job_json IS NULL AND COALESCE(lease_digest, lease_until_ms) IS NULL",
      launchId
    );
  }

  nextAlarm(): number | undefined {
    const row = this.#sql
      .exec(
        `SELECT MIN(at) AS at FROM (
          SELECT COALESCE(lease_until_ms, deadline_at_ms) AS at FROM tubeless_runner_queue WHERE job_json IS NOT NULL
          UNION ALL
          SELECT worker_dispatch_at_ms AS at FROM tubeless_runner_queue
          WHERE job_json IS NOT NULL AND cancelled = 0 AND worker_dispatch_at_ms IS NOT NULL
        )`
      )
      .toArray()[0];
    return typeof row?.at === "number" ? row.at : undefined;
  }

  async expire(): Promise<void> {
    const now = this.deps.now();
    const due = this.#sql
      .exec(
        `SELECT id, launch_id, json_extract(job_json, '$.kind') AS kind, lease_until_ms,
                recovery_attempt_id, deadline_at_ms, cancelled, target FROM tubeless_runner_queue
       WHERE job_json IS NOT NULL AND COALESCE(lease_until_ms, deadline_at_ms) <= ?`,
        now
      )
      .toArray();
    for (const row of due) {
      const id = String(row.id);
      const launchId = String(row.launch_id);
      if (row.kind === "root") {
        await this.#expireRoot(
          id,
          launchId,
          row.recovery_attempt_id,
          Number(row.deadline_at_ms),
          row.cancelled === 1,
          now
        );
      } else {
        this.#failStage(
          launchId,
          id,
          row.target === "cloudflare"
            ? workerStageExpiry(row.cancelled === 1, row.lease_until_ms !== null)
            : row.lease_until_ms === null
              ? { error: "The local runner did not claim the stage before its deadline." }
              : expired
        );
      }
    }
  }

  async #expireRoot(
    id: string,
    launchId: string,
    recoveryAttemptId: unknown,
    deadlineAtMs: number,
    cancelled: boolean,
    now: number
  ): Promise<void> {
    if (typeof recoveryAttemptId === "string") {
      if (cancelled) this.deps.store.admitRecovery(launchId, undefined, []);
      if (this.deps.store.executions.status(launchId)?.state === "running" && deadlineAtMs > now) {
        const previous = this.deps.store.attemptLedger.latest(recoveryAttemptId)?.runId;
        if (previous)
          this.deps.events.append(
            this.deps.store.interruptRuns(
              previous,
              RUNNER_INTERRUPTED,
              now,
              this.activeStageRunIds(launchId)
            )
          );
        this.#sql.exec(
          "UPDATE tubeless_runner_queue SET lease_digest = NULL, lease_until_ms = NULL WHERE id = ?",
          id
        );
        return;
      }
    }
    await this.deps.ingest.reportFailure(launchId, RUNNER_INTERRUPTED, "runner_interrupted");
    this.#close(id);
    if (typeof recoveryAttemptId === "string") this.claims.clearJournal(launchId);
    this.clearFinishedLaunch(launchId);
  }
}
