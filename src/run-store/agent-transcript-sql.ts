import {
  decodeAgentTranscriptRecord,
  MAX_TRANSCRIPT_RECORD_BYTES,
  type AgentTranscriptPage,
  type AgentTranscriptReader,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";
import { transcriptPageQuery, transcriptRecordingStatus } from "./agent-transcript-page.js";

/** Target-owned synchronous SQL. Callers own transactions; every exec is one statement. */
export interface TranscriptSql {
  rows(query: string, ...bindings: unknown[]): unknown[];
  exec(query: string, ...bindings: unknown[]): void;
}
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_transcript_runs (
  run_id TEXT PRIMARY KEY,
  record_count INTEGER NOT NULL CHECK (record_count > 0)
) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS agent_transcript_records (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  record_json TEXT NOT NULL CHECK (length(CAST(record_json AS BLOB)) < ${MAX_TRANSCRIPT_RECORD_BYTES}),
  PRIMARY KEY (run_id, sequence)
) WITHOUT ROWID`,
  `CREATE TRIGGER IF NOT EXISTS agent_transcript_records_count_insert
AFTER INSERT ON agent_transcript_records
BEGIN
  INSERT INTO agent_transcript_runs (run_id, record_count) VALUES (NEW.run_id, 1)
  ON CONFLICT (run_id) DO UPDATE SET record_count = record_count + 1;
END`,
  `CREATE TRIGGER IF NOT EXISTS agent_transcript_records_no_update
BEFORE UPDATE ON agent_transcript_records
BEGIN SELECT RAISE(ABORT, 'agent_transcript_records is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS agent_transcript_records_no_delete
BEFORE DELETE ON agent_transcript_records
BEGIN SELECT RAISE(ABORT, 'agent_transcript_records is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pipeline_run_events_transcript_delete_guard
BEFORE DELETE ON pipeline_run_events
WHEN EXISTS (SELECT 1 FROM agent_transcript_records WHERE run_id = OLD.run_id)
BEGIN
  SELECT RAISE(ABORT, 'Clear stored transcripts with history using a transcript-aware writer');
END`,
];

function hasTranscripts(sql: TranscriptSql): boolean {
  return (
    sql.rows(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_transcript_records'"
    ).length > 0
  );
}
function decodeRow(row: unknown): AgentTranscriptRecord {
  // SAFETY: Queries select the owned table's record_json column.
  const { run_id, sequence, record_json } = row as {
    run_id: string;
    sequence: number;
    record_json: string;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(record_json);
  } catch {
    throw new Error("Stored transcript record is not valid JSON");
  }
  const record = decodeAgentTranscriptRecord(parsed);
  if (record.runId !== run_id || record.sequence !== Number(sequence))
    throw new Error("Transcript record disagrees with its storage key");
  return record;
}

/** Inside the caller's transaction: identical keys are idempotent; conflicts and orphans fail. */
export function importAgentTranscriptRows(
  sql: TranscriptSql,
  records: readonly AgentTranscriptRecord[]
): number {
  const owned = records.map(decodeAgentTranscriptRecord);
  if (owned.length === 0) return 0;
  for (const query of SCHEMA) sql.exec(query);
  const identities = new Map<string, AgentTranscriptRecord>();
  let added = 0;
  for (const record of owned) {
    let identity = identities.get(record.runId);
    if (!identity) {
      if (
        sql.rows("SELECT 1 FROM pipeline_run_events WHERE run_id = ? LIMIT 1", record.runId)
          .length === 0
      )
        throw new Error("Transcript run is absent from history");
      const row = sql.rows(
        "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? ORDER BY sequence LIMIT 1",
        record.runId
      )[0];
      identity = row ? decodeRow(row) : record;
      identities.set(record.runId, identity);
    }
    if (
      identity.agentId !== record.agentId ||
      identity.parentRunId !== record.parentRunId ||
      identity.dryRun !== record.dryRun
    )
      throw new Error("Transcript run identity changes within the store");
    const json = JSON.stringify(record);
    const previous = sql.rows(
      "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? AND sequence = ?",
      record.runId,
      record.sequence
    )[0];
    if (previous) {
      if (JSON.stringify(decodeRow(previous)) !== json)
        throw new Error("Conflicting transcript records share a run ID and sequence");
    } else {
      sql.exec(
        "INSERT INTO agent_transcript_records (run_id, sequence, record_json) VALUES (?, ?, ?)",
        record.runId,
        record.sequence,
        json
      );
      added += 1;
    }
  }
  return added;
}

/** Consume every query synchronously inside the caller's read transaction. */
export function listAgentTranscriptRows(
  sql: TranscriptSql,
  query: Parameters<AgentTranscriptReader["list"]>[0]
): AgentTranscriptPage {
  const { runId, afterSequence, limit } = transcriptPageQuery(query);
  if (!hasTranscripts(sql)) return { runId, records: [], status: "unavailable" };
  // SAFETY: The insert trigger maintains the owned numeric summary column.
  const summary = sql.rows(
    "SELECT record_count FROM agent_transcript_runs WHERE run_id = ?",
    runId
  )[0] as { record_count: number } | undefined;
  if (!summary) return { runId, records: [], status: "unavailable" };
  const last = decodeRow(
    sql.rows(
      "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
      runId
    )[0]
  );
  const records = sql
    .rows(
      "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      runId,
      afterSequence,
      limit + 1
    )
    .map(decodeRow);
  const hasMore = records.length > limit;
  if (hasMore) records.pop();
  return {
    runId,
    records,
    status: transcriptRecordingStatus(Number(summary.record_count), last),
    ...(hasMore ? { nextSequence: records.at(-1)!.sequence } : {}),
  };
}

/** Called inside the owning history store's deletion transaction. */
export function clearAgentTranscriptRows(sql: TranscriptSql): void {
  if (!hasTranscripts(sql)) return;
  for (const query of [
    "DROP TRIGGER agent_transcript_records_no_update",
    "DROP TRIGGER agent_transcript_records_no_delete",
    "DELETE FROM agent_transcript_records",
    "DELETE FROM agent_transcript_runs",
    ...SCHEMA,
  ])
    sql.exec(query);
}
