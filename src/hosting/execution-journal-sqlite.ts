import type { PipelineExecutionJournal } from "../core/pipeline-types.js";
import type { SqliteStorage } from "./sqlite-storage.js";
import { decodeJournalValue, encodeJournalValue } from "./journal-value.js";

const recordKey = (kind: "binding" | "step", path: readonly string[]) =>
  encodeJournalValue([kind, ...path]);

export class HostedJournalConflict extends Error {}

/** Records are scoped by the caller's execution path. The caller owns the write fence. */
export class SqliteJournalRecords {
  constructor(private readonly storage: SqliteStorage) {
    const { sql } = storage;
    sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_run_journal (
      path TEXT PRIMARY KEY NOT NULL,
      binding TEXT NOT NULL,
      completion TEXT,
      launch_id TEXT,
      intent_id TEXT
    )`);
    const columns = sql.exec("PRAGMA table_info(tubeless_run_journal)").toArray();
    if (!columns.some(({ name }) => name === "launch_id"))
      sql.exec("ALTER TABLE tubeless_run_journal ADD COLUMN launch_id TEXT");
    if (!columns.some(({ name }) => name === "intent_id"))
      sql.exec("ALTER TABLE tubeless_run_journal ADD COLUMN intent_id TEXT");
    sql.exec(
      "CREATE INDEX IF NOT EXISTS tubeless_run_journal_launch ON tubeless_run_journal(launch_id)"
    );
  }

  #record(key: string, path: string, input: unknown, intentId?: string) {
    const { sql } = this.storage;
    const binding = encodeJournalValue(input);
    const [saved] = sql
      .exec("SELECT binding, completion, intent_id FROM tubeless_run_journal WHERE path = ?", path)
      .toArray();
    if (!saved) {
      sql.exec(
        "INSERT INTO tubeless_run_journal (path, binding, launch_id, intent_id) VALUES (?, ?, ?, ?)",
        path,
        binding,
        key,
        intentId ?? null
      );
      return { status: "new" } as const;
    }
    if (saved.binding !== binding)
      throw new HostedJournalConflict(
        "Execution journal binding differs from the admitted attempt."
      );
    if (typeof saved.completion === "string")
      return { status: "completed", value: decodeJournalValue(saved.completion) } as const;
    // Only a replay of the intent that granted execution can recover a lost new acknowledgement.
    return {
      status: intentId !== undefined && saved.intent_id === intentId ? "new" : "incomplete",
    } as const;
  }

  bind(key: string, path: readonly string[], input: unknown): void {
    this.#record(key, recordKey("binding", path), input);
  }

  begin(
    key: string,
    path: readonly string[],
    input: unknown,
    kind: "effect" | "orchestration",
    intentId?: string
  ) {
    return this.#record(key, recordKey("step", path), { kind, input }, intentId);
  }

  complete(path: readonly string[], value: unknown): void {
    const encoded = encodeJournalValue(value);
    const [saved] = this.storage.sql
      .exec(
        `UPDATE tubeless_run_journal SET completion = ?
         WHERE path = ? AND (completion IS NULL OR completion = ?)
         RETURNING path`,
        encoded,
        recordKey("step", path),
        encoded
      )
      .toArray();
    if (!saved)
      throw new HostedJournalConflict("Journal completion requires a matching intent and result.");
  }

  clear(launchId?: string): void {
    if (launchId === undefined) this.storage.sql.exec("DELETE FROM tubeless_run_journal");
    else this.storage.sql.exec("DELETE FROM tubeless_run_journal WHERE launch_id = ?", launchId);
  }
}

export class SqliteExecutionJournal {
  readonly #records: SqliteJournalRecords;

  constructor(private readonly storage: SqliteStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_run_journal_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL, deadline_at_ms INTEGER NOT NULL
    )`);
    this.#records = new SqliteJournalRecords(storage);
  }

  /** The alarm persists the new generation and watchdog together. */
  advance(deadlineAtMs: number): { generation: number; deadlineAtMs: number } {
    const [row] = this.storage.sql
      .exec(
        `INSERT INTO tubeless_run_journal_owner VALUES (1, 1, ?)
       ON CONFLICT(singleton) DO UPDATE SET generation = generation + 1
       RETURNING generation, deadline_at_ms`,
        deadlineAtMs
      )
      .toArray();
    return { generation: Number(row.generation), deadlineAtMs: Number(row.deadline_at_ms) };
  }

  owns(generation: number): boolean {
    return (
      this.storage.sql.exec("SELECT generation FROM tubeless_run_journal_owner").toArray()[0]
        ?.generation === generation
    );
  }

  open(key: string, generation: number): PipelineExecutionJournal {
    const fenced = <T>(operation: () => T): T =>
      this.storage.transactionSync(() => {
        if (!this.owns(generation)) throw new Error("This execution journal attempt is stale.");
        return operation();
      });
    return {
      key,
      bind: async (path, input) => fenced(() => this.#records.bind(key, path, input)),
      begin: async (path, input, kind) => fenced(() => this.#records.begin(key, path, input, kind)),
      complete: async (path, value) => fenced(() => this.#records.complete(path, value)),
    };
  }

  clear(): void {
    this.#records.clear();
  }
}
