import { expect, it, vi } from "vitest";
import { createSqliteLaunchMetadataStore } from "../hosting/launch-metadata-sqlite.js";
import type { HostedExecutionStatus } from "../hosting/execution-status.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { executionFollowResponse } from "./cloudflare-execution-follow.js";
import { createExecutionFollowReader } from "../hosting/execution/follow-store.js";
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
  const firstLogs = Array.from({ length: 51 }, (_, index) => String(index));
  const laterLogs = Array.from({ length: 50 }, (_, index) => String(index + 51));
  store.append([
    start("earlier"),
    start("stage", "earlier"),
    start("latest"),
    start("unrelated"),
    ...firstLogs.map((message) => log("stage", message)),
    log("latest", "interleaved"),
    ...laterLogs.map((message) => log("stage", message)),
    log("unrelated", "must not appear"),
    log("latest", "last"),
  ]);
  const follow = createExecutionFollowReader(storage);
  const exec = vi.spyOn(storage.sql, "exec");
  const page = (cursor: number) => follow(status, cursor);
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
  expect(messages).toEqual([...firstLogs, "interleaved", ...laterLogs, "last"]);
  expect(next.at(-1)).toMatchObject({ type: "terminal", payload: status });
  const treeReads = () =>
    exec.mock.calls.filter(([query]) => query.includes("WITH RECURSIVE runs")).length;
  expect(treeReads()).toBe(1);
  const cursor = next.at(-1).cursor;
  expect(page(cursor).events).toEqual([]);
  expect(treeReads()).toBe(1);
  store.append([log("stage", "new log")]);
  expect(page(cursor).events[0]?.payload).toMatchObject({ message: "new log" });
  expect(treeReads()).toBe(1);
  store.append([start("nested", "stage"), log("nested", "nested log")]);
  expect(page(cursor).events.map(({ payload }) => payload)).toEqual([
    expect.objectContaining({ message: "new log" }),
    expect.objectContaining({ message: "nested log" }),
  ]);
  expect(treeReads()).toBe(2);
  storage.transactionSync(() => store.clearHistory());
  expect((await read(next.at(-1).cursor)).map(({ type }) => type)).toEqual([
    "snapshot",
    "gap",
    "terminal",
  ]);
  expect(treeReads()).toBe(3);
});
