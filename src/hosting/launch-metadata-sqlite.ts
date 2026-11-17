import type { SqliteLaunchStorage } from "./launch-store-sqlite.js";
import {
  studioLaunchMetadataSchema,
  type StudioLaunchMetadata,
} from "../studio/shared/launch-metadata.js";

export function createSqliteLaunchMetadataStore(storage: SqliteLaunchStorage) {
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
          `SELECT metadata.metadata_json FROM tubeless_launch_metadata AS metadata
        JOIN tubeless_launches AS launch ON launch.launch_id = metadata.launch_id
        WHERE launch.run_id = ?`,
          runId
        )
        .toArray()[0];
      return row
        ? studioLaunchMetadataSchema.decode(
            JSON.parse(String(row.metadata_json)),
            "Stored launch metadata"
          )
        : undefined;
    },
    /** Caller must refuse active launches and clear events in the same transaction. */
    clear(): void {
      storage.sql.exec("DELETE FROM tubeless_launch_metadata");
    },
  };
}
