import type { BatchAcknowledgement, HostedLaunchStore } from "./launch-store.js";
import type { PipelineRunEventQuery, PipelineRunEventReader } from "../run-store/run-store.js";
import {
  openSubtreeStartsQuery,
  storedRunEvent,
  type RunEventRecord,
} from "../run-store/run-store-sql.js";
import { PIPELINE_TRACE_VERSION } from "../tracing/tracing-constants.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

/** Synchronous SQLite port; adapter and schema initialization remain target-owned. */
export interface SqliteLaunchStorage {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(fn: () => T): T;
}

/** Appends share the adapter's surrounding transaction. */
export interface LaunchEventStore {
  append(events: readonly PipelineTraceEvent[]): void;
}

// A launch may wait for admission before its execution budget begins. Reuse the
// persisted root start through the run-id index, with creation time for old or
// unstarted launches that have no root start event.
const ACTIVE_LAUNCHES = `WITH active_launches AS (
  SELECT launch_id, created_at_ms,
    CASE WHEN state = 'running' THEN COALESCE((
      SELECT timestamp_ms FROM pipeline_run_events AS event
      WHERE event.run_id = launch.run_id
        AND event.event_name = 'pipeline.started'
        AND event.parent_run_id IS NULL
      ORDER BY event.id LIMIT 1
    ), created_at_ms) ELSE created_at_ms END AS started_at_ms
  FROM tubeless_launches AS launch
  WHERE state IN ('starting', 'running')
)`;

type LaunchState = "starting" | "running" | "finished" | "failed";

interface LaunchRecord {
  readonly launchId: string;
  readonly commandId: string;
  readonly runId?: string;
  readonly pipelineId?: string;
  readonly dryRun: boolean;
  readonly stepCount: number;
  readonly state: LaunchState;
  /** The executor was cleared to execute user code; a start failure must not close it. */
  readonly admitted: boolean;
  readonly lastBatch: number;
  readonly createdAtMs: number;
}

const TERMINAL: ReadonlySet<LaunchState> = new Set(["finished", "failed"]);

type PipelineStartedEvent = Extract<PipelineTraceEvent, { name: "pipeline.started" }>;

/** A failed completion mirroring the identity core gives a run's own completion event. */
function hostTerminatedEvent(
  started: PipelineStartedEvent,
  message: string,
  nowMs: number
): PipelineTraceEvent {
  return {
    version: PIPELINE_TRACE_VERSION,
    name: "pipeline.completed",
    runId: started.runId,
    pipelineId: started.pipelineId,
    ...(started.parentRunId === undefined ? {} : { parentRunId: started.parentRunId }),
    ...(started.correlationId === undefined ? {} : { correlationId: started.correlationId }),
    ...(started.itemKey === undefined ? {} : { itemKey: started.itemKey }),
    ...(started.iteration === undefined ? {} : { iteration: started.iteration }),
    timestampMs: nowMs,
    payload: {
      dryRun: started.payload.dryRun,
      errorCount: 1,
      finalized: false,
      status: "failed",
      stepCount: started.payload.stepCount,
    },
    error: { code: "TUBELESS_RUN_CANCELLED", kind: "cancellation", message, phase: "execution" },
  };
}

/** SQLite launch/history adapter; event appends and launch transitions share one connection. */
export class SqliteHostedLaunchStore implements HostedLaunchStore {
  constructor(
    private readonly storage: SqliteLaunchStorage,
    private readonly events: LaunchEventStore & PipelineRunEventReader
  ) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_launches (
      launch_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      run_id TEXT,
      pipeline_id TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      admitted INTEGER NOT NULL DEFAULT 0,
      last_batch INTEGER NOT NULL DEFAULT -1,
      created_at_ms INTEGER NOT NULL
    )`);
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS tubeless_launches_run_id_idx ON tubeless_launches(run_id)"
    );
  }

  async create(launchId: string, commandId: string, nowMs: number): Promise<void> {
    this.storage.sql.exec(
      "INSERT INTO tubeless_launches (launch_id, command_id, state, created_at_ms) VALUES (?, ?, 'starting', ?)",
      launchId,
      commandId,
      nowMs
    );
  }

  #get(launchId: string): LaunchRecord | undefined {
    const row = this.storage.sql
      .exec("SELECT * FROM tubeless_launches WHERE launch_id = ?", launchId)
      .toArray()[0];
    if (!row) return undefined;
    return {
      launchId: String(row.launch_id),
      commandId: String(row.command_id),
      ...(row.run_id == null ? {} : { runId: String(row.run_id) }),
      ...(row.pipeline_id == null ? {} : { pipelineId: String(row.pipeline_id) }),
      dryRun: Number(row.dry_run) === 1,
      stepCount: Number(row.step_count),
      // SAFETY: state is only ever written from LaunchState literals in this class.
      state: row.state as LaunchState,
      admitted: Number(row.admitted) === 1,
      lastBatch: Number(row.last_batch),
      createdAtMs: Number(row.created_at_ms),
    };
  }

  /** Clear an open launch to execute; a closed or unknown launch must never run user code. */
  async admit(launchId: string): Promise<boolean> {
    return this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (!launch || TERMINAL.has(launch.state)) return false;
      this.storage.sql.exec(
        "UPDATE tubeless_launches SET admitted = 1 WHERE launch_id = ?",
        launchId
      );
      return true;
    });
  }

  /**
   * Open launches require the next committed sequence. Replays return the persisted
   * root identity; closed launches reject new batches without changing that sequence.
   */
  async acceptBatch(
    launchId: string,
    sequence: number,
    events: readonly PipelineTraceEvent[]
  ): Promise<BatchAcknowledgement> {
    return this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (!launch) throw new Error(`Unknown launch ${JSON.stringify(launchId)}.`);
      if (sequence <= launch.lastBatch)
        return { accepted: true, ...(launch.runId === undefined ? {} : { runId: launch.runId }) };
      // Closed launches reject every new batch. Do not advance the committed
      // sequence for dropped writes, so their retries keep the same acknowledgement.
      if (TERMINAL.has(launch.state)) return { accepted: false };
      if (sequence > launch.lastBatch + 1)
        throw new Error(
          `Launch ${launchId} expected batch ${launch.lastBatch + 1} but received ${sequence}.`
        );
      this.events.append(events);
      let { runId, pipelineId, dryRun, stepCount, state } = launch;
      for (const event of events) {
        if (
          runId === undefined &&
          event.name === "pipeline.started" &&
          event.parentRunId === undefined
        ) {
          runId = event.runId;
          pipelineId = event.pipelineId;
          dryRun = event.payload.dryRun;
          stepCount = event.payload.stepCount;
          state = "running";
        } else if (
          runId !== undefined &&
          event.name === "pipeline.completed" &&
          event.runId === runId
        ) {
          state = "finished";
        }
      }
      this.storage.sql.exec(
        `UPDATE tubeless_launches
         SET run_id = ?, pipeline_id = ?, dry_run = ?, step_count = ?, state = ?, last_batch = ?
         WHERE launch_id = ?`,
        runId ?? null,
        pipelineId ?? null,
        dryRun ? 1 : 0,
        stepCount,
        state,
        sequence,
        launchId
      );
      return {
        accepted: true,
        ...(runId === undefined ? {} : { runId }),
      };
    });
  }

  async failUnadmitted(launchId: string, message: string, nowMs: number): Promise<void> {
    this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (launch && !launch.admitted) this.#fail(launch, message, nowMs);
    });
  }

  async fail(launchId: string, message: string, nowMs: number): Promise<void> {
    this.storage.transactionSync(() => {
      const launch = this.#get(launchId);
      if (launch) this.#fail(launch, message, nowMs);
    });
  }

  #fail(launch: LaunchRecord, message: string, nowMs: number): void {
    if (TERMINAL.has(launch.state)) return;
    if (launch.runId)
      this.events.append(this.#openSubtreeCompletions(launch.runId, message, nowMs));
    this.storage.sql.exec(
      "UPDATE tubeless_launches SET state = 'failed' WHERE launch_id = ?",
      launch.launchId
    );
  }

  /** Close the bound run and every nested run it left open, children before parents. */
  #openSubtreeCompletions(rootRunId: string, message: string, nowMs: number) {
    const { sql, params } = openSubtreeStartsQuery(rootRunId);
    // SAFETY: SELECT * over the owned pipeline_run_events table returns RunEventRecord rows.
    const rows = this.storage.sql.exec(sql, ...params).toArray() as unknown as RunEventRecord[];
    const closed = new Set<string>();
    const completions: PipelineTraceEvent[] = [];
    for (const row of rows) {
      const started = storedRunEvent(row);
      if (started.name !== "pipeline.started" || closed.has(started.runId)) continue;
      closed.add(started.runId);
      completions.push(hostTerminatedEvent(started, message, nowMs));
    }
    return completions;
  }

  async liveRunIds(): Promise<readonly string[]> {
    return this.storage.sql
      .exec(
        "SELECT run_id FROM tubeless_launches WHERE state = 'running' AND run_id IS NOT NULL ORDER BY created_at_ms"
      )
      .toArray()
      .map((row) => String(row.run_id));
  }

  async launchIdForRun(runId: string): Promise<string | undefined> {
    const row = this.storage.sql
      .exec("SELECT launch_id FROM tubeless_launches WHERE run_id = ? AND state = 'running'", runId)
      .toArray()[0];
    return row ? String(row.launch_id) : undefined;
  }

  async stale(cutoffMs: number): Promise<readonly string[]> {
    return this.storage.sql
      .exec(
        `${ACTIVE_LAUNCHES} SELECT launch_id FROM active_launches WHERE started_at_ms <= ? ORDER BY created_at_ms`,
        cutoffMs
      )
      .toArray()
      .map((row) => String(row.launch_id));
  }

  async nextReconcileAt(delayMs: number): Promise<number | undefined> {
    const row = this.storage.sql
      .exec(`${ACTIVE_LAUNCHES} SELECT MIN(started_at_ms) AS started_at_ms FROM active_launches`)
      .toArray()[0];
    return row?.started_at_ms == null ? undefined : Number(row.started_at_ms) + delayMs;
  }

  listEvents(query?: PipelineRunEventQuery) {
    return this.events.listEvents(query);
  }

  close() {
    return this.events.close();
  }
}
