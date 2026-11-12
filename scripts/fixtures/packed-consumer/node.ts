// Type-checked only: never executed.
import { defineAgent, type AgentModel } from "tubeless/agent";
import {
  createNodeAgentEnvironment,
  openSqliteAgentCheckpointStore,
  type SqliteAgentCheckpointStore,
} from "tubeless/agent/node";
import {
  createWorkerThreadAdapter,
  definePaths,
  openCheckpoint,
  readJson,
  requireEnv,
  resetDir,
  withCheckpointedBatch,
  writeJson,
  type CheckpointStore,
  type WorkerThreadAdapter,
} from "tubeless/node";

declare const cwd: string;
declare const checkpointFile: string;
declare const nodeModel: AgentModel;

const checkpoint: CheckpointStore<{ summary: string }> = openCheckpoint(checkpointFile);
const paths = definePaths({ data: "data", reports: "reports" })(cwd);
const rows: readonly string[] = readJson<readonly string[]>(paths.data);
writeJson(paths.reports, { rows });
resetDir(paths.data);
const token: string = requireEnv("PACKED_CONSUMER_TOKEN", "the packed-consumer fixture");

const adapter: WorkerThreadAdapter<number> = createWorkerThreadAdapter<number>({
  module: new URL("data:text/javascript,export function double(value) { return value * 2; }"),
  exportName: "double",
  poolSize: 2,
});
const checkpointed: Promise<void> = withCheckpointedBatch(
  checkpoint,
  rows,
  (row) => row,
  async () => undefined
);

const environmentAgent = defineAgent({
  id: "packed-node-environment-agent",
  model: nodeModel,
  environment: () => createNodeAgentEnvironment({ id: "packed-consumer" }),
  projectContext: false,
});
const listed: Promise<{ answer: string }> = environmentAgent.runOrThrow({
  task: "list the workspace",
});

const store: Promise<SqliteAgentCheckpointStore> = openSqliteAgentCheckpointStore(checkpointFile);
