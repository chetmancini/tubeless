import { storedRunEvent, type RunEventRecord } from "../../run-store/run-store-sql.js";
import { executionIsActive, type HostedExecutionStatus } from "../execution-status.js";
import type { SqliteStorage } from "../sqlite-storage.js";
import { EXECUTION_FOLLOW_CAPABILITY, type ExecutionFollowOutput } from "./follow.js";

export interface ExecutionFollowPage {
  readonly status: HostedExecutionStatus;
  readonly events: ExecutionFollowOutput[];
  readonly hasMore: boolean;
  readonly historyMissing: boolean;
}
export type ReadExecutionFollowPage = (
  id: string,
  cursor: number
) => Promise<ExecutionFollowPage | undefined>;

const PAGE_SIZE = 8;
const MESSAGE_LIMIT = 4000;
const MAX_CACHED_EXECUTIONS = 16;
const MAX_CACHED_RUNS = 128;
const START = "event_name = 'pipeline.started'";
const OUTPUT = `(event_name = 'pipeline.log' OR
  (event_name = 'step.running' AND json_type(payload_json, '$.progress') = 'object'))`;

export function createExecutionFollowReader(storage: SqliteStorage) {
  const { sql } = storage;
  storage.transactionSync(() => {
    sql.exec(`CREATE INDEX IF NOT EXISTS tubeless_follow_start_id_idx
      ON pipeline_run_events(id) WHERE ${START}`);
    sql.exec(`CREATE INDEX IF NOT EXISTS tubeless_follow_parent_idx
      ON pipeline_run_events(parent_run_id, run_id) WHERE ${START}`);
    sql.exec(`CREATE INDEX IF NOT EXISTS tubeless_follow_output_idx
      ON pipeline_run_events(run_id, id) WHERE ${OUTPUT}`);
  });

  // Only new starts and history clearing change the run tree. Log writes leave it reusable.
  let latestStart = 0;
  const cachedRuns = new Map<string, { root: string; json: string }>();
  function runIds(executionId: string, root: string): string {
    const latest = Number(
      sql
        .exec(`SELECT MAX(id) AS id
        FROM pipeline_run_events INDEXED BY tubeless_follow_start_id_idx WHERE ${START}`)
        .toArray()[0]?.id ?? 0
    );
    if (latest !== latestStart) {
      cachedRuns.clear();
      latestStart = latest;
    }
    const saved = cachedRuns.get(executionId);
    if (saved?.root === root) return saved.json;
    const runs = sql
      .exec(
        `WITH RECURSIVE runs(run_id) AS (
         SELECT ?
         UNION SELECT run_id FROM tubeless_recovery_runs WHERE launch_id = ?
           UNION SELECT event.run_id
             FROM pipeline_run_events AS event INDEXED BY tubeless_follow_parent_idx
           JOIN runs AS parent ON event.parent_run_id = parent.run_id
           WHERE event.${START}
       )
       SELECT run_id FROM runs`,
        root,
        executionId
      )
      .toArray();
    const json = JSON.stringify(runs.map(({ run_id }) => run_id));
    if (runs.length <= MAX_CACHED_RUNS) {
      if (cachedRuns.size >= MAX_CACHED_EXECUTIONS) {
        const oldest = cachedRuns.keys().next();
        if (!oldest.done) cachedRuns.delete(oldest.value);
      }
      cachedRuns.set(executionId, { root, json });
    }
    return json;
  }

  return (status: HostedExecutionStatus, cursor: number): ExecutionFollowPage => {
    const { runId, executionId } = status;
    if (runId === undefined)
      return {
        status,
        events: [],
        hasMore: false,
        historyMissing: status.reason === "history_unavailable",
      };
    // Merge one page of IDs per branch before loading any event payloads.
    const rows = sql
      .exec(
        `WITH next_events(id) AS MATERIALIZED (
         SELECT output.value FROM json_each(?) AS run
         JOIN json_each((
           SELECT json_group_array(id) FROM (
             SELECT id FROM pipeline_run_events INDEXED BY tubeless_follow_output_idx
             WHERE run_id = run.value AND id > ? AND ${OUTPUT}
             ORDER BY id LIMIT ?
           )
         )) AS output
         ORDER BY output.value LIMIT ?
       )
       SELECT event.* FROM next_events
       JOIN pipeline_run_events AS event ON event.id = next_events.id
       ORDER BY event.id`,
        runIds(executionId, runId),
        cursor,
        PAGE_SIZE + 1,
        PAGE_SIZE + 1
      )
      .toArray() as unknown as RunEventRecord[];
    const historyMissing =
      !executionIsActive(status) &&
      sql.exec("SELECT 1 FROM pipeline_run_events WHERE run_id = ? LIMIT 1", runId).toArray()
        .length === 0;
    return {
      status,
      events: projectOutput(rows.slice(0, PAGE_SIZE), executionId),
      hasMore: rows.length > PAGE_SIZE,
      historyMissing,
    };
  };
}

function projectOutput(rows: RunEventRecord[], executionId: string): ExecutionFollowOutput[] {
  const events: ExecutionFollowOutput[] = [];
  const envelope = { version: EXECUTION_FOLLOW_CAPABILITY.version, executionId };
  for (const row of rows) {
    const event = storedRunEvent(row);
    const progress = event.name === "step.running" ? event.payload.progress : undefined;
    const message = event.name === "pipeline.log" ? event.payload.message : progress?.message;
    const attribution = {
      runId: event.runId,
      parentRunId: event.parentRunId,
      pipelineId: event.pipelineId.slice(0, 512),
      stepId: event.stepId?.slice(0, 512),
      attemptId: event.attemptId?.slice(0, 512),
      truncated: message !== undefined && message.length > MESSAGE_LIMIT ? true : undefined,
    };
    if (event.name === "pipeline.log")
      events.push({
        ...envelope,
        cursor: event.id,
        type: "log",
        payload: {
          ...attribution,
          message: event.payload.message.slice(0, MESSAGE_LIMIT),
          level: event.payload.level,
        },
      });
    if (progress)
      events.push({
        ...envelope,
        cursor: event.id,
        type: "progress",
        payload: {
          ...attribution,
          completed: progress.completed,
          total: progress.total,
          message: message?.slice(0, MESSAGE_LIMIT),
        },
      });
  }
  return events;
}
