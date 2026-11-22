import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { HostedAttemptConflict } from "./attempt-store.js";
import type { SqliteLaunchStorage } from "./launch-store-sqlite.js";

interface AttemptBatchIdentity {
  readonly attemptId: string;
  readonly sequence: number;
  readonly digest: string;
}

/** Both owners authenticate first, then bind, append and record under one storage transaction. */
export class SqliteAttemptLedger {
  constructor(private readonly sql: SqliteLaunchStorage["sql"]) {
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

  replay(batch: AttemptBatchIdentity): string | undefined {
    const row = this.sql
      .exec(
        "SELECT digest, run_id FROM tubeless_attempt_batches WHERE attempt_id = ? AND sequence = ?",
        batch.attemptId,
        batch.sequence
      )
      .toArray()[0];
    if (!row) return undefined;
    if (row.digest !== batch.digest) throw new HostedAttemptConflict("replay");
    return String(row.run_id);
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

  record(batch: AttemptBatchIdentity, runId: string): void {
    this.sql.exec(
      "INSERT INTO tubeless_attempt_batches (attempt_id, sequence, digest, run_id) VALUES (?, ?, ?, ?)",
      batch.attemptId,
      batch.sequence,
      batch.digest,
      runId
    );
  }

  bind(
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
    // Every accepted owned batch belongs to a bound root, including the first batch.
    if (root === undefined) throw new HostedAttemptConflict("events");
    return root;
  }
}
