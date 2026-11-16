import type { HostedLaunchAdmissionStore, StoredLaunchAdmission } from "./launch-admission.js";
import type { SqliteLaunchStorage } from "./launch-store-sqlite.js";
import type { StudioLaunchMetadata } from "../studio/shared/launch-metadata.js";

/** Compose key persistence with the launch adapter's synchronous creation operation. */
export function createSqliteLaunchAdmissionStore(
  storage: SqliteLaunchStorage,
  createLaunch: (
    launchId: string,
    commandId: string,
    createdAtMs: number,
    metadata?: StudioLaunchMetadata
  ) => void
): HostedLaunchAdmissionStore {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_launch_admissions (
    idempotency_key TEXT PRIMARY KEY NOT NULL,
    launch_id TEXT NOT NULL UNIQUE,
    intent_digest TEXT NOT NULL,
    deployment_id TEXT NOT NULL
  )`);
  const get = (idempotencyKey: string): StoredLaunchAdmission | undefined => {
    const row = storage.sql
      .exec(
        `SELECT admission.launch_id, admission.intent_digest, admission.deployment_id, launch.command_id
       FROM tubeless_launch_admissions AS admission
       JOIN tubeless_launches AS launch ON launch.launch_id = admission.launch_id
       WHERE admission.idempotency_key = ?`,
        idempotencyKey
      )
      .toArray()[0];
    return row
      ? {
          launchId: String(row.launch_id),
          commandId: String(row.command_id),
          intentDigest: String(row.intent_digest),
          deploymentId: String(row.deployment_id),
        }
      : undefined;
  };
  return {
    async get(idempotencyKey) {
      return get(idempotencyKey);
    },
    async reserve(request) {
      return storage.transactionSync(() => {
        const previous = get(request.idempotencyKey);
        if (previous) return { created: false, admission: previous };
        const { launchId, commandId, intentDigest, deploymentId, createdAtMs, idempotencyKey } =
          request;
        createLaunch(launchId, commandId, createdAtMs, request.metadata);
        storage.sql.exec(
          "INSERT INTO tubeless_launch_admissions (idempotency_key, launch_id, intent_digest, deployment_id) VALUES (?, ?, ?, ?)",
          idempotencyKey,
          launchId,
          intentDigest,
          deploymentId
        );
        return { created: true, admission: { launchId, commandId, intentDigest, deploymentId } };
      });
    },
  };
}
