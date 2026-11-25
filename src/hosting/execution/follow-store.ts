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

export function readExecutionFollowPage(
  sql: SqliteStorage["sql"],
  status: HostedExecutionStatus,
  cursor: number
): ExecutionFollowPage {
  const { runId, executionId } = status;
  if (runId === undefined)
    return {
      status,
      events: [],
      hasMore: false,
      historyMissing: status.reason === "history_unavailable",
    };
  // The current root and every journaled root attempt form one execution's forest.
  const rows = sql
    .exec(
      `WITH RECURSIVE runs(run_id) AS (
       SELECT ?
       UNION SELECT run_id FROM tubeless_recovery_runs WHERE launch_id = ?
       UNION SELECT event.run_id FROM pipeline_run_events AS event
         JOIN runs AS parent ON event.parent_run_id = parent.run_id
         WHERE event.event_name = 'pipeline.started'
     )
     SELECT * FROM pipeline_run_events
     WHERE run_id IN (SELECT run_id FROM runs) AND id > ?
       AND (event_name = 'pipeline.log' OR
         (event_name = 'step.running' AND json_type(payload_json, '$.progress') = 'object'))
     ORDER BY id LIMIT ?`,
      runId,
      executionId,
      cursor,
      PAGE_SIZE + 1
    )
    .toArray() as unknown as RunEventRecord[];
  const hasMore = rows.length > PAGE_SIZE;
  if (hasMore) rows.pop();
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
  const historyMissing =
    !executionIsActive(status) &&
    sql.exec("SELECT 1 FROM pipeline_run_events WHERE run_id = ? LIMIT 1", runId).toArray()
      .length === 0;
  return { status, events, hasMore, historyMissing };
}
