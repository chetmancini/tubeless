import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { HostedAttemptConflict } from "./attempt-store.js";
import type { SqliteStorage } from "./sqlite-storage.js";

interface AttemptBatchIdentity {
  readonly attemptId: string;
  readonly sequence: number;
  readonly digest: string;
}

interface AttemptBatch extends AttemptBatchIdentity {
  readonly events: readonly PipelineTraceEvent[];
}

type AttemptBatchStatus =
  | { readonly kind: "replay"; readonly runId: string }
  | { readonly kind: "gap"; readonly expectedSequence: number }
  | { readonly kind: "next"; readonly runId: string | undefined };

/** Both owners authenticate first and commit their trace and receipt in one transaction. */
export class SqliteAttemptLedger {
  constructor(private readonly sql: SqliteStorage["sql"]) {
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS tubeless_attempt_batches (
        attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        digest TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (attempt_id, sequence)
      )`,
      `CREATE TABLE IF NOT EXISTS tubeless_attempt_runs (
        run_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        parent_run_id TEXT
      )`,
    ])
      sql.exec(statement);
  }

  check(batch: AttemptBatchIdentity): AttemptBatchStatus {
    const row = this.sql
      .exec(
        "SELECT digest, run_id FROM tubeless_attempt_batches WHERE attempt_id = ? AND sequence = ?",
        batch.attemptId,
        batch.sequence
      )
      .toArray()[0];
    if (row) {
      if (row.digest !== batch.digest) throw new HostedAttemptConflict("replay");
      return { kind: "replay", runId: String(row.run_id) };
    }
    const latest = this.latest(batch.attemptId);
    const expectedSequence = (latest?.sequence ?? -1) + 1;
    return batch.sequence === expectedSequence
      ? { kind: "next", runId: latest?.runId }
      : { kind: "gap", expectedSequence };
  }

  latest(attemptId: string): { sequence: number; runId: string } | undefined {
    const row = this.sql
      .exec(
        "SELECT sequence, run_id FROM tubeless_attempt_batches WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1",
        attemptId
      )
      .toArray()[0];
    return row && { sequence: Number(row.sequence), runId: String(row.run_id) };
  }

  runIds(attemptIds: readonly string[]): string[] {
    if (attemptIds.length === 0) return [];
    return this.sql
      .exec(
        `SELECT (
           SELECT batch.run_id FROM tubeless_attempt_batches AS batch
           WHERE batch.attempt_id = attempt.value ORDER BY batch.sequence DESC LIMIT 1
         ) AS run_id FROM json_each(?) AS attempt`,
        JSON.stringify(attemptIds)
      )
      .toArray()
      .flatMap(({ run_id }) => (typeof run_id === "string" ? [run_id] : []));
  }

  /** Call after sequence validation. A failed append must roll back the surrounding transaction. */
  bindBatch(
    batch: AttemptBatch,
    owner: { pipelineId: string; parentRunId?: string; stepId?: string; definitionId?: string },
    previousRunId: string | undefined
  ): string {
    const runId = this.#bind({ ...owner, attemptId: batch.attemptId }, previousRunId, batch.events);
    this.sql.exec(
      "INSERT INTO tubeless_attempt_batches (attempt_id, sequence, digest, run_id) VALUES (?, ?, ?, ?)",
      batch.attemptId,
      batch.sequence,
      batch.digest,
      runId
    );
    return runId;
  }

  #bind(
    owner: {
      attemptId: string;
      pipelineId: string;
      parentRunId?: string;
      stepId?: string;
      definitionId?: string;
    },
    rootRunId: string | undefined,
    events: readonly PipelineTraceEvent[]
  ): string {
    const runBinding = (runId: string) =>
      this.sql.exec("SELECT * FROM tubeless_attempt_runs WHERE run_id = ?", runId).toArray()[0];
    let root = rootRunId;
    for (const event of events) {
      if (event.name === "pipeline.started") {
        // A run id cannot be stolen from either another attempt or trusted history.
        const recorded = this.sql
          .exec("SELECT 1 FROM pipeline_run_events WHERE run_id = ? LIMIT 1", event.runId)
          .toArray()[0];
        const bound = runBinding(event.runId);
        if (recorded || bound) throw new HostedAttemptConflict("events");
        if (event.parentRunId === owner.parentRunId) {
          if (
            root !== undefined ||
            event.pipelineId !== owner.pipelineId ||
            (owner.stepId !== undefined && event.payload.parentStepId !== owner.stepId) ||
            (owner.definitionId !== undefined &&
              event.payload.definitionIdentity?.definitionId !== owner.definitionId)
          )
            throw new HostedAttemptConflict("events");
          root = event.runId;
        } else {
          const parent =
            event.parentRunId === undefined ? undefined : runBinding(event.parentRunId);
          if (!parent || parent.attempt_id !== owner.attemptId)
            throw new HostedAttemptConflict("events");
        }
        this.sql.exec(
          "INSERT INTO tubeless_attempt_runs (run_id, attempt_id, pipeline_id, parent_run_id) VALUES (?, ?, ?, ?)",
          event.runId,
          owner.attemptId,
          event.pipelineId,
          event.parentRunId ?? null
        );
      } else {
        const run = runBinding(event.runId);
        if (
          !run ||
          run.attempt_id !== owner.attemptId ||
          run.pipeline_id !== event.pipelineId ||
          run.parent_run_id !== (event.parentRunId ?? null)
        )
          throw new HostedAttemptConflict("events");
      }
    }
    if (root === undefined) throw new HostedAttemptConflict("events");
    return root;
  }
}
