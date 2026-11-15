import {
  decodeAgentTranscriptRecord,
  type AgentTranscriptPage,
  type AgentTranscriptReader,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";
import { transcriptPageQuery } from "./agent-transcript-query.js";
import {
  sqliteStatement as statement,
  sqliteTransaction,
  type SqliteDatabase,
} from "./sqlite-database.js";

// Independent version-1 content records; the structural event schema stays unchanged.
const SCHEMA = `CREATE TABLE IF NOT EXISTS agent_transcript_records (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  record_json TEXT NOT NULL CHECK (length(CAST(record_json AS BLOB)) < 65536),
  PRIMARY KEY (run_id, sequence)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS agent_transcript_records_no_update
BEFORE UPDATE ON agent_transcript_records
BEGIN SELECT RAISE(ABORT, 'agent_transcript_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS agent_transcript_records_no_delete
BEFORE DELETE ON agent_transcript_records
BEGIN SELECT RAISE(ABORT, 'agent_transcript_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS pipeline_run_events_transcript_delete_guard
BEFORE DELETE ON pipeline_run_events
WHEN EXISTS (SELECT 1 FROM agent_transcript_records WHERE run_id = OLD.run_id)
BEGIN
  SELECT RAISE(ABORT, 'Clear stored transcripts with history using a transcript-aware writer');
END;`;

function hasTranscripts(database: SqliteDatabase): boolean {
  return (
    statement(
      database,
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_transcript_records'"
    ).all().length > 0
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

/** Import atomically; identical keys are idempotent, conflicts and orphaned content fail. */
export function importSqliteAgentTranscript(
  database: SqliteDatabase,
  records: readonly AgentTranscriptRecord[]
): number {
  const owned = records.map(decodeAgentTranscriptRecord);
  if (owned.length === 0) return 0;
  return sqliteTransaction(database, () => {
    database.exec(SCHEMA);
    const existing = statement(
      database,
      "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? AND sequence = ?"
    );
    const first = statement(
      database,
      "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? ORDER BY sequence LIMIT 1"
    );
    const run = statement(database, "SELECT 1 FROM pipeline_run_events WHERE run_id = ? LIMIT 1");
    const insert = statement(
      database,
      "INSERT INTO agent_transcript_records (run_id, sequence, record_json) VALUES (?, ?, ?)"
    );
    const identities = new Map<string, AgentTranscriptRecord>();
    let added = 0;
    for (const record of owned) {
      let identity = identities.get(record.runId);
      if (!identity) {
        if (run.all(record.runId).length === 0)
          throw new Error("Transcript run is absent from history");
        const row = first.all(record.runId)[0];
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
      const previous = existing.all(record.runId, record.sequence)[0];
      if (previous) {
        if (JSON.stringify(decodeRow(previous)) !== json)
          throw new Error("Conflicting transcript records share a run ID and sequence");
      } else {
        insert.run(record.runId, record.sequence, json);
        added += 1;
      }
    }
    return added;
  });
}

export function listSqliteAgentTranscript(
  database: SqliteDatabase,
  query: Parameters<AgentTranscriptReader["list"]>[0]
): AgentTranscriptPage {
  const { runId, afterSequence, limit } = transcriptPageQuery(query);
  return sqliteTransaction(
    database,
    () => {
      if (!hasTranscripts(database)) return { runId, records: [], status: "unavailable" };
      // A unique sequence index makes count === max establish a contiguous one-based recording.
      // SAFETY: SQLite aggregates return these named numeric columns.
      const summary = statement(
        database,
        "SELECT COUNT(*) AS count, MAX(sequence) AS last FROM agent_transcript_records WHERE run_id = ?"
      ).all(runId)[0] as { count: number; last: number | null };
      if (Number(summary.count) === 0) return { runId, records: [], status: "unavailable" };
      const last = decodeRow(
        statement(
          database,
          "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? ORDER BY sequence DESC LIMIT 1"
        ).all(runId)[0]
      );
      const status =
        Number(summary.count) !== Number(summary.last)
          ? "partial"
          : "limit" in last
            ? "limited"
            : "event" in last && last.event.kind === "end"
              ? "complete"
              : "partial";
      const records = statement(
        database,
        "SELECT run_id, sequence, record_json FROM agent_transcript_records WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?"
      )
        .all(runId, afterSequence, limit + 1)
        .map(decodeRow);
      const hasMore = records.length > limit;
      if (hasMore) records.pop();
      return {
        runId,
        records,
        status,
        ...(hasMore ? { nextSequence: records.at(-1)!.sequence } : {}),
      };
    },
    "DEFERRED"
  );
}

/** Called inside the owning history store's deletion transaction. */
export function clearSqliteAgentTranscripts(database: SqliteDatabase): void {
  if (!hasTranscripts(database)) return;
  database.exec(`DROP TRIGGER agent_transcript_records_no_update;
DROP TRIGGER agent_transcript_records_no_delete;
DELETE FROM agent_transcript_records;
${SCHEMA}`);
}
