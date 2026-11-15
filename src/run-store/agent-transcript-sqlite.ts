import type { AgentTranscriptReader, AgentTranscriptRecord } from "../tracing/agent-transcript.js";
import {
  clearAgentTranscriptRows,
  importAgentTranscriptRows,
  listAgentTranscriptRows,
  type TranscriptSql,
} from "./agent-transcript-sql.js";
import {
  sqliteStatement,
  sqliteTransaction,
  type SqliteDatabase,
  type SqliteStatement,
} from "./sqlite-database.js";

function transcriptSql(database: SqliteDatabase): TranscriptSql {
  const statements = new Map<string, SqliteStatement>();
  const prepare = (query: string) => {
    let statement = statements.get(query);
    if (!statement) statements.set(query, (statement = sqliteStatement(database, query)));
    return statement;
  };
  return {
    rows: (query, ...bindings) => prepare(query).all(...bindings),
    exec(query, ...bindings) {
      if (bindings.length) prepare(query).run(...bindings);
      else database.exec(query);
    },
  };
}

export function importSqliteAgentTranscript(
  database: SqliteDatabase,
  records: readonly AgentTranscriptRecord[]
): number {
  if (records.length === 0) return 0;
  return sqliteTransaction(database, () =>
    importAgentTranscriptRows(transcriptSql(database), records)
  );
}

export function listSqliteAgentTranscript(
  database: SqliteDatabase,
  query: Parameters<AgentTranscriptReader["list"]>[0]
) {
  return sqliteTransaction(
    database,
    () => listAgentTranscriptRows(transcriptSql(database), query),
    "DEFERRED"
  );
}

/** The owning history store already holds its deletion transaction. */
export function clearSqliteAgentTranscripts(database: SqliteDatabase): void {
  clearAgentTranscriptRows(transcriptSql(database));
}
