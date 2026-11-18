import { wireEnum, wireNumber, wireString } from "../tracing/wire-schema.js";
import type { PipelineRunSummary } from "./run-store-reader.js";
import { sqliteStatement, type SqliteDatabase } from "./sqlite-database.js";

const terminalStatus = wireEnum(["completed", "failed", "cancelled"]);
const id = wireString();
const text = wireString({ allowEmpty: true });
const number = wireNumber();

/**
 * Match RunProjection in insertion order: identity comes from the first event,
 * start time from the first start (or first event), and outcome from the last completion.
 * Inspect the contributing payloads only; detail and event reads validate the full trace.
 */
export function listSqliteRunSummaries(
  database: SqliteDatabase,
  pipelineId?: string
): PipelineRunSummary[] {
  const scoped = pipelineId !== undefined;
  const query = `WITH runs AS (
    SELECT MIN(id) AS first_id,
           MIN(id) FILTER (WHERE event_name = 'pipeline.started') AS start_id,
           MAX(id) FILTER (WHERE event_name = 'pipeline.completed') AS completion_id
    FROM pipeline_run_events ${scoped ? "WHERE pipeline_id = ?" : ""}
    GROUP BY run_id
  )
  SELECT first.run_id, first.pipeline_id, first.correlation_id,
         COALESCE(start.timestamp_ms, first.timestamp_ms) AS started_at_ms,
         json_valid(first.payload_json) AND (start.id IS NULL OR json_valid(start.payload_json)) AS inputs_valid,
         completion.id AS completion_id,
         json_extract(completion.payload_json, '$.status') AS terminal_status, completion.duration_ms
  FROM runs
  JOIN pipeline_run_events first ON first.id = runs.first_id
  LEFT JOIN pipeline_run_events start ON start.id = runs.start_id
  LEFT JOIN pipeline_run_events completion ON completion.id = runs.completion_id
  ORDER BY started_at_ms DESC, first_id ASC`;
  // SAFETY: The statement names these columns. Validate their values before returning a summary.
  const rows = sqliteStatement(database, query).all(...(scoped ? [pipelineId] : [])) as Record<
    string,
    unknown
  >[];
  return rows.map((row) => {
    if (!row.inputs_valid) throw new Error("Invalid JSON in history summary input.");
    return {
      pipelineId: id.decode(row.pipeline_id, "pipelineId"),
      runId: id.decode(row.run_id, "runId"),
      startedAtMs: number.decode(row.started_at_ms, "startedAtMs"),
      status:
        row.completion_id === null
          ? "running"
          : terminalStatus.decode(row.terminal_status, "pipeline.completed.status"),
      ...(row.correlation_id === null
        ? {}
        : { correlationId: text.decode(row.correlation_id, "correlationId") }),
      ...(row.duration_ms === null
        ? {}
        : { durationMs: number.decode(row.duration_ms, "durationMs") }),
    };
  });
}
