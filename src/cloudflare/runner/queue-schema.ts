import type { DurableStorageLike } from "../cloudflare-storage.js";

export function initializeRunnerQueue(sql: DurableStorageLike["sql"]): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS tubeless_runner_queue (
      id TEXT PRIMARY KEY NOT NULL,
      launch_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      job_json TEXT,
      deadline_at_ms INTEGER,
      lease_until_ms INTEGER,
      lease_digest TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      incompatible INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      recovery_binding TEXT,
      recovery_attempt_id TEXT,
      worker_dispatch_at_ms INTEGER,
      target TEXT NOT NULL DEFAULT 'local'
    )`);
  const columns = sql.exec("PRAGMA table_info(tubeless_runner_queue)").toArray();
  if (!columns.some(({ name }) => name === "recovery_binding"))
    sql.exec("ALTER TABLE tubeless_runner_queue ADD COLUMN recovery_binding TEXT");
  if (!columns.some(({ name }) => name === "recovery_attempt_id"))
    sql.exec("ALTER TABLE tubeless_runner_queue ADD COLUMN recovery_attempt_id TEXT");
  if (!columns.some(({ name }) => name === "worker_dispatch_at_ms"))
    sql.exec("ALTER TABLE tubeless_runner_queue ADD COLUMN worker_dispatch_at_ms INTEGER");
  if (!columns.some(({ name }) => name === "target"))
    sql.exec("ALTER TABLE tubeless_runner_queue ADD COLUMN target TEXT NOT NULL DEFAULT 'local'");
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tubeless_runner_recovery_attempt
      ON tubeless_runner_queue(recovery_attempt_id) WHERE recovery_attempt_id IS NOT NULL`);
  sql.exec(`CREATE INDEX IF NOT EXISTS tubeless_runner_launch ON tubeless_runner_queue(launch_id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS tubeless_runner_queued
      ON tubeless_runner_queue(deployment_id, pipeline_id, definition_id) WHERE job_json IS NOT NULL AND lease_digest IS NULL`);
}
