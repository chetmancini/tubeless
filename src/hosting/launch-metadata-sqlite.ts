import type { SqliteStorage } from "./sqlite-storage.js";
import {
  studioLaunchMetadataSchema,
  type StudioLaunchMetadata,
} from "../studio/shared/launch-metadata.js";

export function createSqliteLaunchMetadataStore(storage: SqliteStorage) {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_recovery_runs (
    run_id TEXT PRIMARY KEY NOT NULL, launch_id TEXT NOT NULL
  )`);
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS tubeless_recovery_runs_launch ON tubeless_recovery_runs(launch_id)"
  );
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_launch_metadata (
    launch_id TEXT PRIMARY KEY NOT NULL,
    metadata_json TEXT NOT NULL
  )`);
  return {
    /** Caller owns the surrounding launch/admission transaction. */
    record(metadata: StudioLaunchMetadata): void {
      const encoded = JSON.stringify(
        studioLaunchMetadataSchema.decode(metadata, "Launch metadata")
      );
      if (new TextEncoder().encode(encoded).byteLength > 131_072)
        throw new Error("Launch metadata exceeds 128 KiB.");
      storage.sql.exec(
        "INSERT INTO tubeless_launch_metadata (launch_id, metadata_json) VALUES (?, ?)",
        metadata.launchId,
        encoded
      );
    },
    async forRun(runId: string): Promise<StudioLaunchMetadata | undefined> {
      const row = storage.sql
        .exec(
          `SELECT metadata_json, launch_id FROM tubeless_launch_metadata
        WHERE launch_id IN (
          SELECT launch_id FROM tubeless_launches WHERE run_id = ?
          UNION ALL
          SELECT launch_id FROM tubeless_recovery_runs WHERE run_id = ?
        )`,
          runId,
          runId
        )
        .toArray()[0];
      if (!row) return undefined;
      const metadata = studioLaunchMetadataSchema.decode(
        JSON.parse(String(row.metadata_json)),
        "Stored launch metadata"
      );
      const runIds = storage.sql
        .exec(
          "SELECT run_id FROM tubeless_recovery_runs WHERE launch_id = ? ORDER BY rowid DESC LIMIT 64",
          row.launch_id
        )
        .toArray()
        .map((attempt) => String(attempt.run_id));
      return runIds.length > 0 ? { ...metadata, recoveryRunIds: runIds } : metadata;
    },
    /** Caller must refuse active launches and clear events in the same transaction. */
    clear(): void {
      storage.sql.exec("DELETE FROM tubeless_launch_metadata");
      storage.sql.exec("DELETE FROM tubeless_recovery_runs");
    },
  };
}
