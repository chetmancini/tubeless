import { storedRunEvent, type RunEventRecord } from "../run-store/run-store-sql.js";
import type { RunnerStageObservation } from "./cloudflare-child-placement.js";
import { HostedAttemptConflict } from "../hosting/attempt-store.js";
import { decodeRunnerBatch } from "../hosting/attempt-batch.js";
import type { SqliteHostedLaunchStore } from "../hosting/launch-store-sqlite.js";
import {
  boundedRunnerJson,
  decodeRunnerReport,
  RUNNER_INTERRUPTED,
  RUNNER_LEASE_MS,
  RUNNER_DRAIN_MS,
  type RunnerClaim,
  type RunnerJob,
  type RunnerStageResult,
  type RunnerStageInput,
} from "../hosting/runner-protocol.js";
import { digestCollectorBody } from "../hosting/collector-protocol.js";
import type { HostedExecutionReason } from "../hosting/execution-status.js";
import type { StudioIngest } from "../hosting/run-contract.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";
import type { DurableRunStore } from "./cloudflare-run-store.js";

type ClaimedJob =
  | Omit<Extract<RunnerJob, { kind: "root" }>, "run">
  | (Omit<Extract<RunnerJob, { kind: "stage" }>, "stage"> & {
      stage: Omit<RunnerStageInput, "input" | "controls"> & { dryRun: boolean };
    });

type QueueRow = {
  job: ClaimedJob;
  deadlineAtMs: number;
  cancelled: boolean;
};

const lost = { active: false } as const;
const cancelled = { error: "The remote stage was cancelled." } as const;
const expired = { error: RUNNER_INTERRUPTED } as const;
const digestLease = (token: string) => digestCollectorBody(new TextEncoder().encode(token));
function claimedJob(job: RunnerJob): ClaimedJob {
  if (job.kind === "root") {
    const { run: _run, ...identity } = job;
    return identity;
  }
  const {
    stage: { input: _input, controls, ...parent },
    ...identity
  } = job;
  return { ...identity, stage: { ...parent, dryRun: controls.dryRun === true } };
}

export class CloudflareRunnerQueue {
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
    deps.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_runner_queue (
      id TEXT PRIMARY KEY NOT NULL,
      launch_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      job_json TEXT,
      deadline_at_ms INTEGER,
      lease_until_ms INTEGER,
      lease_digest TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      incompatible INTEGER NOT NULL DEFAULT 0,
      result_json TEXT
    )`);
    deps.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS tubeless_runner_launch ON tubeless_runner_queue(launch_id)`
    );
    deps.storage.sql.exec(`CREATE INDEX IF NOT EXISTS tubeless_runner_queued
      ON tubeless_runner_queue(deployment_id, pipeline_id, definition_id) WHERE job_json IS NOT NULL AND lease_digest IS NULL`);
  }

  get #sql() {
    return this.deps.storage.sql;
  }

  enqueue(job: RunnerJob): void {
    this.#sql.exec(
      `INSERT INTO tubeless_runner_queue
        (id, launch_id, deployment_id, pipeline_id, definition_id, job_json, deadline_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.launchId,
      job.deploymentId,
      job.pipelineId,
      job.definitionId,
      JSON.stringify(job),
      job.kind === "stage" ? job.deadlineAtMs : null
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

  async claim(
    deploymentId: string,
    manifest: ReadonlyMap<string, string>
  ): Promise<{ claim?: RunnerClaim; diagnostic?: string }> {
    return this.deps.storage.transaction(async () => {
      const now = this.deps.now();
      const entries = JSON.stringify(Object.fromEntries(manifest));
      this.#sql.exec(
        `WITH compatibility AS (
          SELECT q.id, CAST(NOT EXISTS (
            SELECT 1 FROM json_each(?) m WHERE m.key = q.pipeline_id AND m.value = q.definition_id
          ) AS INTEGER) AS incompatible
          FROM tubeless_runner_queue q WHERE q.deployment_id = ? AND q.job_json IS NOT NULL AND q.lease_digest IS NULL
        )
        UPDATE tubeless_runner_queue
        SET incompatible = compatibility.incompatible FROM compatibility
        WHERE tubeless_runner_queue.id = compatibility.id AND tubeless_runner_queue.incompatible <> compatibility.incompatible`,
        entries,
        deploymentId
      );
      const row = this.#sql
        .exec(
          `SELECT q.job_json FROM tubeless_runner_queue q
         JOIN json_each(?) m ON m.key = q.pipeline_id AND m.value = q.definition_id
         WHERE q.deployment_id = ? AND q.job_json IS NOT NULL AND q.lease_digest IS NULL
           AND (q.deadline_at_ms IS NULL OR q.deadline_at_ms > ?)
         ORDER BY q.rowid LIMIT 1`,
          entries,
          deploymentId,
          now
        )
        .toArray()[0];
      if (!row) {
        const waiting = this.#sql
          .exec(
            `SELECT deployment_id, pipeline_id FROM tubeless_runner_queue
           WHERE job_json IS NOT NULL AND lease_digest IS NULL ORDER BY rowid LIMIT 1`
          )
          .toArray()[0];
        return waiting
          ? {
              diagnostic:
                waiting.deployment_id !== deploymentId
                  ? "Waiting work requires a different deployment revision."
                  : `Runner is missing the compatible definition for ${String(waiting.pipeline_id)}.`,
            }
          : {};
      }
      const job = JSON.parse(String(row.job_json)) as RunnerJob;
      const token = crypto.randomUUID();
      const deadlineAtMs = job.kind === "stage" ? job.deadlineAtMs : now + job.run.maxRunDurationMs;
      if (job.kind === "root" && !(await this.deps.ingest.admit(job.launchId)).admitted) {
        this.#close(job.id);
        return {};
      }
      this.#sql.exec(
        `UPDATE tubeless_runner_queue SET job_json = ?, lease_digest = ?, lease_until_ms = ?, deadline_at_ms = ? WHERE id = ?`,
        // Retain attempt metadata and drop the offered inputs as soon as the claim commits.
        JSON.stringify(claimedJob(job)),
        await digestLease(token),
        Math.min(now + RUNNER_LEASE_MS, deadlineAtMs + RUNNER_DRAIN_MS),
        deadlineAtMs,
        job.id
      );
      await this.deps.schedule();
      return { claim: { job, token, remainingMs: deadlineAtMs - now } };
    });
  }

  #lease(id: string, leaseDigest: string, deploymentId: string) {
    return this.#sql
      .exec(
        "SELECT * FROM tubeless_runner_queue WHERE id = ? AND lease_digest = ? AND deployment_id = ?",
        id,
        leaseDigest,
        deploymentId
      )
      .toArray()[0];
  }

  #active(row: Record<string, unknown> | undefined): QueueRow | undefined {
    if (!row || row.job_json === null || Number(row.lease_until_ms) <= this.deps.now())
      return undefined;
    return {
      job: JSON.parse(String(row.job_json)) as ClaimedJob,
      cancelled: row.cancelled === 1,
      deadlineAtMs: Number(row.deadline_at_ms),
    };
  }

  async heartbeat(id: string, token: string, deploymentId: string) {
    const leaseDigest = await digestLease(token);
    return this.deps.storage.transaction(async () => {
      const row = this.#active(this.#lease(id, leaseDigest, deploymentId));
      if (!row) return lost;
      const leaseUntil = Math.min(
        this.deps.now() + RUNNER_LEASE_MS,
        row.deadlineAtMs + RUNNER_DRAIN_MS
      );
      this.#sql.exec(
        "UPDATE tubeless_runner_queue SET lease_until_ms = ? WHERE id = ?",
        leaseUntil,
        id
      );
      await this.deps.schedule();
      return { active: true, cancelled: row.cancelled } as const;
    });
  }

  async append(
    token: string,
    deploymentId: string,
    bytes: Uint8Array
  ): Promise<{ accepted: boolean }> {
    const [batch, leaseDigest] = await Promise.all([decodeRunnerBatch(bytes), digestLease(token)]);
    return this.deps.storage.transaction(async () => {
      const lease = this.#lease(batch.attemptId, leaseDigest, deploymentId);
      const row = this.#active(lease);
      // A sealed receipt proves an already committed batch, even after the parent consumes the result.
      const ledger = this.deps.store.attemptLedger;
      if (!row && lease?.job_json !== null) return { accepted: false };
      if (ledger.replay(batch) !== undefined) return { accepted: true };
      if (!row) return { accepted: false };

      const latest = ledger.latest(batch.attemptId);
      if (batch.sequence !== (latest?.sequence ?? -1) + 1) return { accepted: false };
      const { job } = row;
      const stage = job.kind === "stage" ? job.stage : undefined;
      if (stage && this.deps.store.executions.status(job.launchId)?.state !== "running")
        return { accepted: false };
      const root = ledger.bind(
        {
          attemptId: job.id,
          pipelineId: job.pipelineId,
          definitionId: job.definitionId,
          parentRunId: stage?.parentRunId,
          stepId: stage?.stepId,
        },
        latest?.runId,
        batch.events
      );
      const events =
        latest === undefined ? this.#withRunnerLog(batch.events, job.id, root) : [...batch.events];

      if (!stage) {
        if (batch.report !== undefined)
          throw new TypeError("A root attempt does not carry a stage report.");
        // Rejected writes roll back their new run bindings.
        if (!(await this.deps.ingest.appendEvents(job.launchId, batch.sequence, events)).accepted)
          throw new HostedAttemptConflict("events");
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
          latest === undefined ||
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
          report.dryRun !== stage.dryRun ||
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
      ledger.record(batch, root);
      if (batch.report !== undefined) await this.deps.schedule();
      return { accepted: true };
    });
  }

  #withRunnerLog(
    events: readonly PipelineTraceEvent[],
    attemptId: string,
    root: string
  ): PipelineTraceEvent[] {
    const index = events.findIndex(
      (event) => event.runId === root && event.name === "pipeline.started"
    );
    const started = events[index];
    const { payload: _payload, ...identity } = started;
    const log: PipelineTraceEvent = {
      ...identity,
      name: "pipeline.log",
      payload: { level: "log", message: `Runner local · attempt ${attemptId}` },
    };
    return [...events.slice(0, index + 1), log, ...events.slice(index + 1)];
  }

  async finish(id: string, token: string, deploymentId: string, result: unknown) {
    const leaseDigest = await digestLease(token);
    return this.deps.storage.transaction(async () => {
      const row = this.#active(this.#lease(id, leaseDigest, deploymentId));
      if (!row) return { accepted: false };
      const { job } = row;
      if (job.kind === "root") {
        if (result !== null && typeof result !== "string")
          throw new TypeError("Invalid root completion.");
        const error =
          typeof result === "string"
            ? result.slice(0, 2_000)
            : "The local runner did not record a terminal run.";
        if (this.deps.store.executions.status(job.launchId)?.state === "running")
          await this.deps.ingest.reportFailure(job.launchId, error);
        this.#close(id);
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
      `UPDATE tubeless_runner_queue SET job_json = NULL, lease_until_ms = NULL, deadline_at_ms = NULL,
       lease_digest = CASE WHEN ? = 1 THEN lease_digest ELSE NULL END, result_json = ? WHERE id = ?`,
      sealed ? 1 : 0,
      result === undefined ? null : boundedRunnerJson(result, "Remote stage result"),
      id
    );
  }

  #interruptStage(id: string, message: string): void {
    const runId = this.deps.store.attemptLedger.latest(id)?.runId;
    if (runId !== undefined)
      this.deps.events.append(this.deps.store.interruptSubtree(runId, message, this.deps.now()));
  }

  #failStage(launchId: string, id: string, result: { readonly error: string }): void {
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
    // Only the bound root drives parent progress. Keep each RPC page bounded and skip log rows.
    const rows =
      runId === undefined
        ? []
        : (this.#sql
            .exec(
              `SELECT * FROM pipeline_run_events WHERE run_id = ? AND id > ?
       AND event_name IN ('step.running', 'step.complete', 'step.skipped', 'step.cancelled', 'step.failed')
       ORDER BY id LIMIT 32`,
              runId,
              afterId
            )
            .toArray() as unknown as RunEventRecord[]);
    const events = rows.map(storedRunEvent);
    if (typeof row.result_json !== "string") return { events };
    const result = JSON.parse(row.result_json) as RunnerStageResult;
    return {
      events,
      result: "error" in result ? result : { report: decodeRunnerReport(result.report) },
    };
  }

  cancel(launchId: string, stageId?: string): void {
    this.#sql.exec(
      `UPDATE tubeless_runner_queue SET cancelled = 1,
        job_json = CASE WHEN lease_digest IS NOT NULL THEN job_json END,
        deadline_at_ms = CASE WHEN lease_digest IS NOT NULL THEN deadline_at_ms END,
        result_json = CASE WHEN lease_digest IS NULL THEN ? ELSE result_json END
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
        "The parent execution ended before the local stage confirmed completion."
      );
    this.#sql.exec(
      "UPDATE tubeless_runner_queue SET result_json = NULL WHERE launch_id = ? AND id <> launch_id AND job_json IS NULL AND lease_digest IS NOT NULL",
      launchId
    );
    this.#sql.exec(
      "DELETE FROM tubeless_runner_queue WHERE launch_id = ? AND id <> launch_id AND job_json IS NULL AND lease_digest IS NULL",
      launchId
    );
  }

  nextAlarm(): number | undefined {
    const row = this.#sql
      .exec(
        "SELECT MIN(COALESCE(lease_until_ms, deadline_at_ms)) AS at FROM tubeless_runner_queue WHERE job_json IS NOT NULL"
      )
      .toArray()[0];
    return typeof row?.at === "number" ? row.at : undefined;
  }

  async expire(): Promise<void> {
    const now = this.deps.now();
    const due = this.#sql
      .exec(
        `SELECT id, launch_id, json_extract(job_json, '$.kind') AS kind, lease_digest FROM tubeless_runner_queue
       WHERE job_json IS NOT NULL AND COALESCE(lease_until_ms, deadline_at_ms) <= ?`,
        now
      )
      .toArray();
    for (const row of due) {
      const id = String(row.id);
      const launchId = String(row.launch_id);
      if (row.kind === "root") {
        await this.deps.ingest.reportFailure(launchId, RUNNER_INTERRUPTED, "runner_interrupted");
        this.#close(id);
      } else {
        this.#failStage(
          launchId,
          id,
          row.lease_digest === null
            ? { error: "The local runner did not claim the stage before its deadline." }
            : expired
        );
      }
    }
  }
}
