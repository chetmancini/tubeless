import type { PipelineRunEventQuery, PipelineRunEventReader } from "../run-store/run-store.js";
import {
  RUN_EVENT_INSERT_SQL,
  RUN_EVENT_STORE_VERSION,
  RUN_EVENT_TABLE_STATEMENTS,
  RUN_EVENT_TRIGGER_STATEMENTS,
  runEventListQuery,
  runEventRow,
  storedRunEvent,
  type RunEventRecord,
} from "../run-store/run-store-sql.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import {
  decodeAgentTranscriptRecord,
  type AgentTranscriptReader,
  type AgentTranscriptRecord,
} from "../tracing/agent-transcript.js";
import {
  clearAgentTranscriptRows,
  importAgentTranscriptRows,
  listAgentTranscriptRows,
  type TranscriptSql,
} from "../run-store/agent-transcript-sql.js";
import { RUN_EVENT_DROP_TRIGGER_STATEMENTS } from "../run-store/run-store-sql.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

export interface DurableRunStore extends PipelineRunEventReader {
  readonly transcripts: AgentTranscriptReader;
  /** Append events; callers own the surrounding transactionSync. */
  append(events: readonly PipelineTraceEvent[]): void;
  /** Trusted content ingress. Missing structural starts refuse delivery without creating content. */
  appendTranscript(record: AgentTranscriptRecord): boolean;
  /** Caller owns a transaction and must prevent active launches from recreating history. */
  clearHistory(): void;
}

/** Event store over Durable Object SQLite. Schema version lives in a table, not user_version. */
export function openDurableRunStore(
  storage: Pick<DurableStorageLike, "sql" | "transactionSync">
): DurableRunStore {
  const { sql } = storage;
  const content: TranscriptSql = {
    rows: (query, ...bindings) => sql.exec(query, ...bindings).toArray(),
    exec: (query, ...bindings) => {
      sql.exec(query, ...bindings);
    },
  };
  storage.transactionSync(() => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS tubeless_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    const row = sql
      .exec("SELECT value FROM tubeless_meta WHERE key = 'run_event_store_version'")
      .toArray()[0];
    if (row === undefined) {
      for (const statement of [...RUN_EVENT_TABLE_STATEMENTS, ...RUN_EVENT_TRIGGER_STATEMENTS])
        sql.exec(statement);
      sql.exec(
        "INSERT INTO tubeless_meta (key, value) VALUES ('run_event_store_version', ?)",
        String(RUN_EVENT_STORE_VERSION)
      );
    } else if (row.value !== String(RUN_EVENT_STORE_VERSION)) {
      throw new Error(
        `Unsupported pipeline run store schema version ${String(row.value)}; expected ${RUN_EVENT_STORE_VERSION}.`
      );
    }
  });
  return {
    transcripts: {
      async list(query) {
        return storage.transactionSync(() => listAgentTranscriptRows(content, query));
      },
      close() {},
    },
    appendTranscript(value) {
      const record = decodeAgentTranscriptRecord(value);
      return storage.transactionSync(() => {
        const started = sql
          .exec(
            "SELECT pipeline_id, parent_run_id, payload_json FROM pipeline_run_events WHERE run_id = ? AND event_name = 'pipeline.started' ORDER BY id LIMIT 1",
            record.runId
          )
          .toArray()[0];
        if (!started) return false;
        const payload: unknown = JSON.parse(String(started.payload_json));
        if (
          started.pipeline_id !== record.agentId ||
          (started.parent_run_id ?? undefined) !== record.parentRunId ||
          typeof payload !== "object" ||
          payload === null ||
          !("dryRun" in payload) ||
          payload.dryRun !== record.dryRun
        )
          throw new Error("Transcript record disagrees with its structural run identity");
        importAgentTranscriptRows(content, [record]);
        return true;
      });
    },
    clearHistory() {
      clearAgentTranscriptRows(content);
      for (const statement of RUN_EVENT_DROP_TRIGGER_STATEMENTS) sql.exec(statement);
      sql.exec("DELETE FROM pipeline_run_events");
      for (const statement of RUN_EVENT_TRIGGER_STATEMENTS) sql.exec(statement);
    },
    append(events) {
      for (const event of events) sql.exec(RUN_EVENT_INSERT_SQL, ...runEventRow(event));
    },
    async listEvents(query: PipelineRunEventQuery = {}) {
      const { sql: text, params } = runEventListQuery(query);
      // SAFETY: SELECT * over the owned pipeline_run_events table returns RunEventRecord rows.
      const rows = sql.exec(text, ...params).toArray() as unknown as RunEventRecord[];
      return rows.map(storedRunEvent);
    },
    close() {},
  };
}
