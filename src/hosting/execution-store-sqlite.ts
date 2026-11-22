import {
  HOSTED_EXECUTION_REASONS,
  HOSTED_EXECUTION_STATES,
  type HostedExecutionReason,
  type HostedExecutionState,
  type HostedExecutionStatus,
} from "./execution-status.js";
import type { SqliteLaunchStorage } from "./launch-store-sqlite.js";
import type { RunJob } from "./run-contract.js";

type ExecutionAction =
  | { readonly launchId: string; readonly kind: "dispatch"; readonly job: RunJob }
  | { readonly launchId: string; readonly kind: "cancel" };

type ExecutionOutcome = Exclude<HostedExecutionState, "queued" | "running">;

export const TRUSTED_LAUNCHES = `WITH trusted_launches AS (
  SELECT launch.* FROM tubeless_launches AS launch
  WHERE NOT EXISTS (
    SELECT 1 FROM tubeless_attempts AS attempt WHERE attempt.launch_id = launch.launch_id
  )
)`;

// The watchdog starts at the recorded root start, or at first delivery for
// pinned launches that haven't recorded a root. Unoffered work can stay queued.
const WATCHDOGS = `${TRUSTED_LAUNCHES}, watchdogs AS (
  SELECT launch.launch_id, created_at_ms,
    COALESCE(CASE WHEN state = 'running' THEN (
      SELECT timestamp_ms FROM pipeline_run_events AS event
      WHERE event.run_id = launch.run_id AND event.event_name = 'pipeline.started'
        AND event.parent_run_id IS NULL
      ORDER BY event.id LIMIT 1
    ) END, execution.offered_at_ms, created_at_ms)
    + COALESCE(execution.max_run_duration_ms, ?) + ? AS deadline
  FROM trusted_launches AS launch
  LEFT JOIN tubeless_executions AS execution ON launch.launch_id = execution.launch_id
  WHERE state IN ('starting', 'running')
    AND COALESCE(execution.target, 'cloudflare') = 'cloudflare'
    AND (execution.job_json IS NULL OR execution.offered_at_ms IS NOT NULL)
)`;

/** Pending work and terminal receipts share the launch and history transactions. */
export class SqliteExecutionStore {
  constructor(private readonly storage: SqliteLaunchStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_executions (
      launch_id TEXT PRIMARY KEY NOT NULL,
      job_json TEXT,
      wake_at_ms INTEGER,
      offered_at_ms INTEGER,
      max_run_duration_ms INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      reason TEXT,
      target TEXT NOT NULL DEFAULT 'cloudflare'
    )`);
    if (
      !storage.sql
        .exec("PRAGMA table_info(tubeless_executions)")
        .toArray()
        .some((row) => row.name === "target")
    ) {
      storage.sql.exec(
        "ALTER TABLE tubeless_executions ADD COLUMN target TEXT NOT NULL DEFAULT 'cloudflare'"
      );
    }
    storage.sql.exec(`CREATE INDEX IF NOT EXISTS tubeless_executions_wake_idx
      ON tubeless_executions(wake_at_ms, launch_id) WHERE wake_at_ms IS NOT NULL`);
  }

  enqueue(job: RunJob, nowMs: number): void {
    this.storage.sql.exec(
      `INSERT INTO tubeless_executions (launch_id, job_json, wake_at_ms, max_run_duration_ms, target)
        VALUES (?, ?, ?, ?, ?)`,
      job.launchId,
      job.target === "local" ? null : JSON.stringify(job),
      job.target === "local" ? null : nowMs,
      job.maxRunDurationMs,
      job.target ?? "cloudflare"
    );
  }

  #launch(launchId: string) {
    return this.storage.sql
      .exec(
        `${TRUSTED_LAUNCHES}
         SELECT launch.command_id, launch.state, launch.admitted, launch.run_id,
           execution.outcome, execution.reason, execution.cancel_requested, execution.target
         FROM trusted_launches AS launch
         LEFT JOIN tubeless_executions AS execution ON execution.launch_id = launch.launch_id
         WHERE launch.launch_id = ?`,
        launchId
      )
      .toArray()[0];
  }

  status(launchId: string): HostedExecutionStatus | undefined {
    const row = this.#launch(launchId);
    if (!row) return undefined;
    const runId = typeof row.run_id === "string" ? row.run_id : undefined;
    const saved = HOSTED_EXECUTION_STATES.find((state) => state === row.outcome);
    const { state, reason } = saved
      ? { state: saved, reason: HOSTED_EXECUTION_REASONS.find((reason) => reason === row.reason) }
      : this.#observedStatus(row.state, Number(row.admitted) === 1, runId);
    return {
      executionId: launchId,
      commandId: String(row.command_id),
      state,
      ...(row.target === "local" ? { target: "local" as const } : {}),
      cancellationRequested: Number(row.cancel_requested) === 1,
      ...(runId === undefined ? {} : { runId }),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  #observedStatus(
    state: unknown,
    admitted: boolean,
    runId?: string
  ): Pick<HostedExecutionStatus, "state" | "reason"> {
    if (state === "failed") return { state: admitted ? "outcome_unknown" : "failed" };
    if (state !== "finished")
      return { state: admitted || state === "running" ? "running" : "queued" };
    const terminal = this.storage.sql
      .exec(
        `SELECT json_extract(payload_json, '$.status') AS status FROM pipeline_run_events
       WHERE run_id = ? AND event_name = 'pipeline.completed' ORDER BY id DESC LIMIT 1`,
        runId ?? null
      )
      .toArray()[0]?.status;
    if (terminal === "completed" || terminal === "failed" || terminal === "cancelled")
      return { state: terminal };
    return { state: "outcome_unknown", reason: "history_unavailable" };
  }

  /** Called within the launch transaction before granting execution. */
  claim(launchId: string, alreadyAdmitted: boolean): boolean {
    const row = this.storage.sql
      .exec("SELECT cancel_requested FROM tubeless_executions WHERE launch_id = ?", launchId)
      .toArray()[0];
    if (!row) return true; // Legacy trusted launches retain repeatable consent.
    if (alreadyAdmitted || Number(row.cancel_requested) === 1) return false;
    this.delivered(launchId, "dispatch");
    return true;
  }

  /** Select and defer this batch inside the same storage transaction as the next alarm. */
  takeDue(nowMs: number, retryAtMs: number): ExecutionAction[] {
    return this.storage.sql
      .exec(
        `UPDATE tubeless_executions SET wake_at_ms = ?,
          offered_at_ms = CASE WHEN cancel_requested = 0 THEN COALESCE(offered_at_ms, ?) ELSE offered_at_ms END
         WHERE launch_id IN (
           SELECT launch_id FROM tubeless_executions
           WHERE wake_at_ms <= ? ORDER BY wake_at_ms, launch_id LIMIT 20
         ) RETURNING launch_id, job_json, cancel_requested`,
        retryAtMs,
        nowMs,
        nowMs
      )
      .toArray()
      .map<ExecutionAction>((row) => {
        const launchId = String(row.launch_id);
        if (Number(row.cancel_requested) === 1) return { launchId, kind: "cancel" };
        // SAFETY: enqueue encodes bounded RunJob values validated by launch admission.
        const job = JSON.parse(String(row.job_json)) as RunJob;
        return { launchId, kind: "dispatch", job };
      });
  }

  delivered(launchId: string, kind: ExecutionAction["kind"]): void {
    this.storage.sql.exec(
      `UPDATE tubeless_executions SET job_json = NULL, wake_at_ms = NULL
       WHERE launch_id = ? AND cancel_requested = ?`,
      launchId,
      kind === "cancel" ? 1 : 0
    );
  }

  /** Called within a storage transaction so the fence and cancellation wake commit together. */
  requestCancellation(launchId: string, nowMs: number): boolean {
    const row = this.#launch(launchId);
    if (row?.state !== "starting" && row?.state !== "running") return false;
    this.storage.sql.exec(
      `INSERT INTO tubeless_executions (launch_id, wake_at_ms, cancel_requested) VALUES (?, ?, 1)
       ON CONFLICT(launch_id) DO UPDATE SET wake_at_ms = excluded.wake_at_ms,
         cancel_requested = 1, job_json = NULL`,
      launchId,
      row.target === "local" ? null : nowMs
    );
    if (Number(row.admitted) !== 1) {
      this.storage.sql.exec(
        "UPDATE tubeless_launches SET state = 'failed' WHERE launch_id = ?",
        launchId
      );
      this.settle(launchId, "cancelled");
    }
    return true;
  }

  settle(launchId: string, outcome: ExecutionOutcome, reason?: HostedExecutionReason): void {
    this.storage.sql.exec(
      `UPDATE tubeless_executions SET outcome = ?, reason = ?, job_json = NULL,
        wake_at_ms = NULL WHERE launch_id = ?`,
      outcome,
      reason ?? null,
      launchId
    );
  }

  stale(nowMs: number, fallbackDelayMs = 0, graceMs = 0): readonly string[] {
    return this.storage.sql
      .exec(
        `${WATCHDOGS} SELECT launch_id FROM watchdogs WHERE deadline <= ? ORDER BY created_at_ms`,
        fallbackDelayMs,
        graceMs,
        nowMs
      )
      .toArray()
      .map((row) => String(row.launch_id));
  }

  nextAlarm(fallbackDelayMs: number, graceMs = 0): number | undefined {
    const row = this.storage.sql
      .exec(
        `${WATCHDOGS} SELECT MIN(next_at) AS next_at FROM (
          SELECT MIN(deadline) AS next_at FROM watchdogs
          UNION ALL
          SELECT MIN(wake_at_ms) FROM tubeless_executions WHERE wake_at_ms IS NOT NULL
        )`,
        fallbackDelayMs,
        graceMs
      )
      .toArray()[0];
    return typeof row?.next_at === "number" ? row.next_at : undefined;
  }
}
