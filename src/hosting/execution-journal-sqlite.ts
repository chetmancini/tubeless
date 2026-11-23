import type { PipelineExecutionJournal } from "../core/pipeline-types.js";
import type { SqliteLaunchStorage } from "./launch-store-sqlite.js";
import { decodeJournalValue, encodeJournalValue } from "./journal-value.js";

const recordKey = (kind: "binding" | "step", path: readonly string[]) =>
  encodeJournalValue([kind, ...path]);

export class SqliteExecutionJournal {
  constructor(private readonly storage: SqliteLaunchStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_run_journal_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL, deadline_at_ms INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_run_journal (
      path TEXT PRIMARY KEY NOT NULL,
      binding TEXT NOT NULL,
      completion TEXT
    )`);
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
    const { sql } = this.storage;
    const fenced = <T>(operation: () => T): T =>
      this.storage.transactionSync(() => {
        if (!this.owns(generation)) throw new Error("This execution journal attempt is stale.");
        return operation();
      });
    const bind = (path: string, input: unknown) => {
      const binding = encodeJournalValue(input);
      const [saved] = sql
        .exec("SELECT binding, completion FROM tubeless_run_journal WHERE path = ?", path)
        .toArray();
      if (!saved) {
        sql.exec("INSERT INTO tubeless_run_journal (path, binding) VALUES (?, ?)", path, binding);
        return { status: "new" } as const;
      }
      if (saved.binding !== binding)
        throw new Error("Execution journal binding differs from the admitted attempt.");
      return typeof saved.completion === "string"
        ? ({ status: "completed", value: decodeJournalValue(saved.completion) } as const)
        : ({ status: "incomplete" } as const);
    };
    return {
      key,
      bind: async (path, input) => {
        fenced(() => bind(recordKey("binding", path), input));
      },
      begin: async (path, input, kind) =>
        fenced(() => bind(recordKey("step", path), { kind, input })),
      complete: async (path, value) =>
        fenced(() => {
          const encoded = encodeJournalValue(value);
          const [saved] = sql
            .exec(
              `UPDATE tubeless_run_journal SET completion = ?
           WHERE path = ? AND (completion IS NULL OR completion = ?)
           RETURNING path`,
              encoded,
              recordKey("step", path),
              encoded
            )
            .toArray();
          if (!saved) throw new Error("Journal completion requires a matching intent and result.");
        }),
    };
  }

  clear(): void {
    this.storage.sql.exec("DELETE FROM tubeless_run_journal");
  }
}
