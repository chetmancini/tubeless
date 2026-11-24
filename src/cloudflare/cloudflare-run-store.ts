import { CHILD_PROGRESS_TRACE_NAMES } from "../core/child-progress.js";
import type {
  PipelineRunEventQuery,
  PipelineRunEventReader,
  StoredPipelineEvent,
} from "../run-store/run-store.js";
import {
  RUN_EVENT_INSERT_SQL,
  RUN_EVENT_STORE_VERSION,
  RUN_EVENT_TABLE_STATEMENTS,
  RUN_EVENT_TRIGGER_STATEMENTS,
  RUN_EVENT_CLEAR_STATEMENTS,
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
import { sameTranscriptRun } from "../run-store/agent-transcript-page.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";

export interface DurableRunStore extends PipelineRunEventReader {
  readonly transcripts: Pick<AgentTranscriptReader, "list">;
  /** Append events; callers own the surrounding transactionSync. */
  append(events: readonly PipelineTraceEvent[]): void;
  listChildProgress(
    runId: string,
    afterId: number
  ): { events: StoredPipelineEvent[]; hasMore: boolean };
  /** Trusted content ingress. Missing structural starts refuse delivery without creating content. */
  appendTranscript(record: AgentTranscriptRecord): boolean;
  /** Caller owns a transaction and must prevent active launches from recreating history. */
  clearHistory(): void;
}

const CHILD_PROGRESS_PAGE_SIZE = 32;
const CHILD_PROGRESS_EVENT_PARAMS = CHILD_PROGRESS_TRACE_NAMES.map(() => "?").join(", ");

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
    },
    appendTranscript(value) {
      const record = decodeAgentTranscriptRecord(value);
      return storage.transactionSync(() => {
        const row = sql
          .exec(
            "SELECT * FROM pipeline_run_events WHERE run_id = ? AND event_name = 'pipeline.started' ORDER BY id LIMIT 1",
            record.runId
          )
          .toArray()[0];
        if (!row) return false;
        const started = storedRunEvent(row as unknown as RunEventRecord);
        if (
          started.name !== "pipeline.started" ||
          !sameTranscriptRun(record, {
            agentId: started.pipelineId,
            parentRunId: started.parentRunId,
            dryRun: started.payload.dryRun,
          })
        )
          throw new Error("Transcript record disagrees with its structural run identity");
        importAgentTranscriptRows(content, [record]);
        return true;
      });
    },
    clearHistory() {
      clearAgentTranscriptRows(content);
      for (const statement of RUN_EVENT_CLEAR_STATEMENTS) sql.exec(statement);
    },
    append(events) {
      for (const event of events) sql.exec(RUN_EVENT_INSERT_SQL, ...runEventRow(event));
    },
    async listEvents(query: PipelineRunEventQuery = {}) {
      const { sql: text, params } = runEventListQuery(query);
      const rows = sql.exec(text, ...params).toArray() as unknown as RunEventRecord[];
      return rows.map(storedRunEvent);
    },
    listChildProgress(runId, afterId) {
      const rows = sql
        .exec(
          `SELECT * FROM pipeline_run_events WHERE run_id = ? AND id > ?
           AND event_name IN (${CHILD_PROGRESS_EVENT_PARAMS}) ORDER BY id LIMIT ?`,
          runId,
          afterId,
          ...CHILD_PROGRESS_TRACE_NAMES,
          CHILD_PROGRESS_PAGE_SIZE + 1
        )
        .toArray() as unknown as RunEventRecord[];
      const hasMore = rows.length > CHILD_PROGRESS_PAGE_SIZE;
      if (hasMore) rows.pop();
      return { events: rows.map(storedRunEvent), hasMore };
    },
    close() {},
  };
}
