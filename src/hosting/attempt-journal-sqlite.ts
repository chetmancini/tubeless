import {
  HostedAttemptConflict,
  type AttemptBatchAcknowledgement,
  type HostedAttemptDefinition,
  type HostedAttemptOwner,
} from "./attempt-store.js";
import type { SqliteLaunchStorage } from "./launch-store-sqlite.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

/** Attempt metadata within the launch adapter's synchronous transaction and connection. */
export class SqliteAttemptJournal {
  constructor(private readonly storage: SqliteLaunchStorage) {
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS tubeless_attempts (
        attempt_id TEXT PRIMARY KEY,
        launch_id TEXT NOT NULL UNIQUE,
        pipeline_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        worker_id TEXT,
        claimed_at_ms INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      )`,
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
      storage.sql.exec(statement);
  }

  hasLaunch(launchId: string): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM tubeless_attempts WHERE launch_id = ?", launchId)
        .toArray().length > 0
    );
  }

  create(definition: HostedAttemptDefinition): void {
    this.storage.sql.exec(
      "INSERT INTO tubeless_attempts (attempt_id, launch_id, pipeline_id, deployment_id) VALUES (?, ?, ?, ?)",
      definition.attemptId,
      definition.launchId,
      definition.pipelineId,
      definition.deploymentId
    );
  }

  claim(owner: HostedAttemptOwner, deploymentId: string, nowMs: number): boolean {
    const row = this.storage.sql
      .exec(
        "SELECT * FROM tubeless_attempts WHERE launch_id = ? AND attempt_id = ?",
        owner.launchId,
        owner.attemptId
      )
      .toArray()[0];
    if (
      !row ||
      row.worker_id !== null ||
      Number(row.revoked) !== 0 ||
      row.deployment_id !== deploymentId
    )
      return false;
    this.storage.sql.exec(
      "UPDATE tubeless_attempts SET worker_id = ?, claimed_at_ms = ? WHERE attempt_id = ?",
      owner.workerId,
      nowMs,
      owner.attemptId
    );
    return true;
  }

  requireOwner(owner: HostedAttemptOwner): { readonly pipelineId: string } {
    const row = this.storage.sql
      .exec(
        "SELECT pipeline_id, worker_id, revoked FROM tubeless_attempts WHERE launch_id = ? AND attempt_id = ?",
        owner.launchId,
        owner.attemptId
      )
      .toArray()[0];
    if (!row || row.worker_id !== owner.workerId || Number(row.revoked) !== 0)
      throw new HostedAttemptConflict("ownership");
    return { pipelineId: String(row.pipeline_id) };
  }

  replay(
    attemptId: string,
    sequence: number,
    digest: string
  ): AttemptBatchAcknowledgement | undefined {
    const row = this.storage.sql
      .exec(
        "SELECT digest, run_id FROM tubeless_attempt_batches WHERE attempt_id = ? AND sequence = ?",
        attemptId,
        sequence
      )
      .toArray()[0];
    if (!row) return undefined;
    if (row.digest !== digest) throw new HostedAttemptConflict("replay");
    return { accepted: true, runId: String(row.run_id) };
  }

  record(attemptId: string, sequence: number, digest: string, runId: string): void {
    this.storage.sql.exec(
      "INSERT INTO tubeless_attempt_batches (attempt_id, sequence, digest, run_id) VALUES (?, ?, ?, ?)",
      attemptId,
      sequence,
      digest,
      runId
    );
  }

  revoke(launchId: string, attemptId: string): void {
    this.storage.sql.exec(
      "UPDATE tubeless_attempts SET revoked = 1 WHERE launch_id = ? AND attempt_id = ?",
      launchId,
      attemptId
    );
  }

  bindEvents(
    owner: HostedAttemptOwner,
    pipelineId: string,
    rootRunId: string | undefined,
    events: readonly PipelineTraceEvent[]
  ): void {
    let root = rootRunId;
    for (const event of events) {
      if (event.name === "pipeline.started") {
        // A run id cannot be stolen from either another attempt or trusted history.
        const recorded = this.storage.sql
          .exec("SELECT 1 FROM pipeline_run_events WHERE run_id = ? LIMIT 1", event.runId)
          .toArray()[0];
        const bound = this.#run(event.runId);
        if (recorded || bound) throw new HostedAttemptConflict("events");
        if (event.parentRunId === undefined) {
          if (root !== undefined || event.pipelineId !== pipelineId)
            throw new HostedAttemptConflict("events");
          root = event.runId;
        } else {
          const parent = this.#run(event.parentRunId);
          if (!parent || parent.attempt_id !== owner.attemptId)
            throw new HostedAttemptConflict("events");
        }
        this.storage.sql.exec(
          "INSERT INTO tubeless_attempt_runs (run_id, attempt_id, pipeline_id, parent_run_id) VALUES (?, ?, ?, ?)",
          event.runId,
          owner.attemptId,
          event.pipelineId,
          event.parentRunId ?? null
        );
      } else {
        const run = this.#run(event.runId);
        if (
          !run ||
          run.attempt_id !== owner.attemptId ||
          run.pipeline_id !== event.pipelineId ||
          run.parent_run_id !== (event.parentRunId ?? null)
        )
          throw new HostedAttemptConflict("events");
      }
    }
  }

  #run(runId: string) {
    return this.storage.sql
      .exec("SELECT * FROM tubeless_attempt_runs WHERE run_id = ?", runId)
      .toArray()[0];
  }
}
