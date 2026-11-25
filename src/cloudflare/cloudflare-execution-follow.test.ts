import { expect, it } from "vitest";
import { createSqliteLaunchMetadataStore } from "../hosting/launch-metadata-sqlite.js";
import type { HostedExecutionStatus } from "../hosting/execution-status.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { executionFollowResponse } from "./cloudflare-execution-follow.js";
import { readExecutionFollowPage } from "../hosting/execution/follow-store.js";
import { openDurableRunStore } from "./cloudflare-run-store.js";
import { createFakeDurableStorage } from "./cloudflare-storage.test-support.js";

const status: HostedExecutionStatus = {
  executionId: "execution",
  commandId: "task",
  state: "completed",
  cancellationRequested: false,
  runId: "latest",
};
const base = { version: 3 as const, pipelineId: "task", timestampMs: 1 };
const start = (runId: string, parentRunId?: string): PipelineTraceEvent => ({
  ...base,
  name: "pipeline.started",
  runId,
  parentRunId,
  payload: { dryRun: false, planOk: true, stepCount: 1, targetIds: [] },
});
const log = (runId: string, message: string): PipelineTraceEvent => ({
  ...base,
  name: "pipeline.log",
  runId,
  payload: { level: "log", message },
});

it("pages both attempts, isolates other runs and reports cleared history before the terminal snapshot", async () => {
  const storage = createFakeDurableStorage();
  const store = openDurableRunStore(storage);
  createSqliteLaunchMetadataStore(storage);
  storage.sql.exec("INSERT INTO tubeless_recovery_runs VALUES ('earlier', 'execution')");
  store.append([
    start("earlier"),
    start("stage", "earlier"),
    start("latest"),
    start("unrelated"),
    ...Array.from({ length: 101 }, (_, index) => log("stage", String(index))),
    log("unrelated", "must not appear"),
    log("latest", "last"),
  ]);
  const page = (cursor: number) => readExecutionFollowPage(storage.sql, status, cursor);
  const read = async (cursor: number) => {
    const response = executionFollowResponse("execution", cursor, page(cursor), async (_, after) =>
      page(after)
    );
    return (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const first = await read(0);
  expect(first.at(-1)).toMatchObject({ type: "end" });
  const next = await read(first.at(-1).cursor);
  const messages = [...first, ...next]
    .filter(({ type }) => type === "log")
    .map(({ payload }) => payload.message);
  expect(messages).toEqual([...Array.from({ length: 101 }, (_, index) => String(index)), "last"]);
  expect(next.at(-1)).toMatchObject({ type: "terminal", payload: status });
  storage.transactionSync(() => store.clearHistory());
  expect((await read(next.at(-1).cursor)).map(({ type }) => type)).toEqual([
    "snapshot",
    "gap",
    "terminal",
  ]);
});
