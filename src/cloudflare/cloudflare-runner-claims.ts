import { SqliteJournalRecords } from "../hosting/execution-journal-sqlite.js";
import { encodeJournalValue } from "../hosting/journal-value.js";
import type { SqliteHostedLaunchStore } from "../hosting/launch-store-sqlite.js";
import {
  RUNNER_LEASE_MS,
  RUNNER_DRAIN_MS,
  type RunnerClaim,
  type RunnerJob,
  type RunnerStageInput,
  type RunnerJournalOperation,
} from "../hosting/runner-protocol.js";
import { sha256Hex } from "../utilities/sha256.js";
import type { StudioIngest } from "../hosting/run-contract.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

type ClaimedJob =
  | Omit<Extract<RunnerJob, { kind: "root" }>, "run">
  | (Omit<Extract<RunnerJob, { kind: "stage" }>, "stage"> & {
      stage: Omit<RunnerStageInput, "input" | "controls"> & { dryRun: boolean };
    });

type QueueRow = {
  job: ClaimedJob;
  recoveryAttemptId?: string;
  deadlineAtMs: number;
  cancelled: boolean;
};

const lost = { active: false } as const;
export const digestRunnerLease = (token: string) => sha256Hex(new TextEncoder().encode(token));
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

/** Authorize each journal operation with the current runner lease in the same transaction. */
export class CloudflareRunnerClaims {
  readonly #journal: SqliteJournalRecords;

  constructor(
    private readonly deps: {
      storage: DurableStorageLike;
      store: SqliteHostedLaunchStore;
      ingest: StudioIngest;
      now: () => number;
      schedule: () => Promise<void>;
    }
  ) {
    this.#journal = new SqliteJournalRecords(deps.storage);
  }

  get #sql() {
    return this.deps.storage.sql;
  }

  clearJournal(launchId: string): void {
    this.#journal.clear(launchId);
  }

  isWaitingForRecovery(launchId: string): boolean {
    return (
      this.#sql
        .exec(
          `SELECT 1 FROM tubeless_runner_queue WHERE id = ? AND recovery_attempt_id IS NOT NULL
       AND job_json IS NOT NULL AND lease_digest IS NULL`,
          launchId
        )
        .toArray().length > 0
    );
  }

  async claim(
    deploymentId: string,
    manifest: ReadonlyMap<string, string>,
    supportsRecovery: boolean
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
          `SELECT q.job_json, q.deadline_at_ms FROM tubeless_runner_queue q
         JOIN json_each(?) m ON m.key = q.pipeline_id AND m.value = q.definition_id
         WHERE q.deployment_id = ? AND q.job_json IS NOT NULL AND q.lease_digest IS NULL AND q.cancelled = 0
           AND (q.deadline_at_ms IS NULL OR q.deadline_at_ms > ?)
           AND (? OR json_extract(q.job_json, '$.run.recoveryDefinitionId') IS NULL)
         ORDER BY q.rowid LIMIT 1`,
          entries,
          deploymentId,
          now,
          supportsRecovery ? 1 : 0
        )
        .toArray()[0];
      if (!row) {
        const waiting = this.#sql
          .exec(
            `SELECT deployment_id, pipeline_id, incompatible,
                    json_extract(job_json, '$.run.recoveryDefinitionId') AS requires_recovery FROM tubeless_runner_queue
           WHERE job_json IS NOT NULL AND lease_digest IS NULL ORDER BY rowid LIMIT 1`
          )
          .toArray()[0];
        return waiting
          ? {
              diagnostic:
                waiting.deployment_id !== deploymentId
                  ? "Waiting work requires a different deployment revision."
                  : !supportsRecovery &&
                      waiting.requires_recovery !== null &&
                      waiting.incompatible === 0
                    ? "Waiting work requires a runner with execution journal support."
                    : `Runner is missing the compatible definition for ${String(waiting.pipeline_id)}.`,
            }
          : {};
      }
      const job = JSON.parse(String(row.job_json)) as RunnerJob;
      const token = crypto.randomUUID();
      const recoveryAttemptId =
        job.kind === "root" && job.run.recoveryDefinitionId !== undefined
          ? crypto.randomUUID()
          : undefined;
      const deadlineAtMs =
        typeof row.deadline_at_ms === "number"
          ? row.deadline_at_ms
          : job.kind === "stage"
            ? job.deadlineAtMs
            : now + job.run.maxRunDurationMs;
      if (job.kind === "root") {
        const admitted =
          recoveryAttemptId === undefined
            ? (await this.deps.ingest.admit(job.launchId)).admitted
            : this.deps.store.admitRecovery(job.launchId, undefined, []) === "admitted";
        if (!admitted) {
          this.#sql.exec(
            "UPDATE tubeless_runner_queue SET job_json = NULL, deadline_at_ms = NULL WHERE id = ?",
            job.id
          );
          this.#journal.clear(job.launchId);
          await this.deps.schedule();
          return {};
        }
      }
      this.#sql.exec(
        `UPDATE tubeless_runner_queue SET job_json = ?, lease_digest = ?, lease_until_ms = ?,
         deadline_at_ms = ?, recovery_attempt_id = ? WHERE id = ?`,
        JSON.stringify(recoveryAttemptId === undefined ? claimedJob(job) : job),
        await digestRunnerLease(token),
        Math.min(now + RUNNER_LEASE_MS, deadlineAtMs + RUNNER_DRAIN_MS),
        deadlineAtMs,
        recoveryAttemptId ?? null,
        job.id
      );
      await this.deps.schedule();
      return { claim: { job, token, remainingMs: deadlineAtMs - now, recoveryAttemptId } };
    });
  }

  lease(id: string, leaseDigest: string, deploymentId: string) {
    return this.#sql
      .exec(
        "SELECT * FROM tubeless_runner_queue WHERE id = ? AND lease_digest = ? AND deployment_id = ?",
        id,
        leaseDigest,
        deploymentId
      )
      .toArray()[0];
  }

  active(row: Record<string, unknown> | undefined): QueueRow | undefined {
    if (!row || row.job_json === null || Number(row.lease_until_ms) <= this.deps.now())
      return undefined;
    return {
      job: JSON.parse(String(row.job_json)) as ClaimedJob,
      recoveryAttemptId:
        typeof row.recovery_attempt_id === "string" ? row.recovery_attempt_id : undefined,
      cancelled: row.cancelled === 1,
      deadlineAtMs: Number(row.deadline_at_ms),
    };
  }

  async journal(id: string, token: string, deploymentId: string, message: RunnerJournalOperation) {
    const leaseDigest = await digestRunnerLease(token);
    return this.deps.storage.transactionSync(() => {
      const row = this.active(this.lease(id, leaseDigest, deploymentId));
      if (!row?.recoveryAttemptId) return { accepted: false };
      const { operation, path, value } = message;
      if (operation === "complete") {
        this.#journal.complete(path, value);
        return { accepted: true };
      }
      if (row.cancelled || row.deadlineAtMs <= this.deps.now()) return { accepted: false };
      if (operation === "bind") {
        this.#journal.bind(id, path, value);
        return { accepted: true };
      }
      const { boundary, intentId } = message;
      const result = this.#journal.begin(id, path, value, boundary, `${leaseDigest}:${intentId}`);
      return {
        accepted: true,
        status: result.status,
        ...(result.status === "completed" ? { data: encodeJournalValue(result.value) } : {}),
      };
    });
  }

  async heartbeat(id: string, token: string, deploymentId: string) {
    const leaseDigest = await digestRunnerLease(token);
    return this.deps.storage.transaction(async () => {
      const row = this.active(this.lease(id, leaseDigest, deploymentId));
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
}
