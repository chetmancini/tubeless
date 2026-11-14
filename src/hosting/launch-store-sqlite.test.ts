import { afterEach, describe, expect, it } from "vitest";
import { createRunHistoryIndex } from "../run-store/run-history.js";
import { projectPipelineRunStore } from "../run-store/run-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { SqliteHostedLaunchStore } from "./launch-store-sqlite.js";

const base = { version: 3 as const, pipelineId: "demo", timestampMs: 1 };
const started = (runId: string, parentRunId?: string, stepCount = 2): PipelineTraceEvent => ({
  ...base,
  runId,
  ...(parentRunId ? { parentRunId } : {}),
  name: "pipeline.started",
  payload: { dryRun: false, planOk: true, stepCount, targetIds: [] },
});
const completed = (runId: string): PipelineTraceEvent => ({
  ...base,
  runId,
  name: "pipeline.completed",
  payload: { dryRun: false, errorCount: 0, finalized: true, status: "completed", stepCount: 2 },
});

const fixtures: ReturnType<typeof createSqliteLaunchStoreFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.store.close();
});
function setup() {
  const fixture = createSqliteLaunchStoreFixture();
  fixtures.push(fixture);
  return fixture;
}

describe("SQLite hosted launch store", () => {
  it("binds the top-level run, ignores child starts, and tracks liveness", async () => {
    const { store, readLaunch } = setup();
    await store.create("l1", "demo", 100);
    expect(await store.acceptBatch("l1", 0, [started("r1")])).toEqual({
      accepted: true,
      runId: "r1",
    });
    await store.acceptBatch("l1", 1, [started("child", "r1")]);
    expect(readLaunch("l1")).toMatchObject({ run_id: "r1", state: "running", step_count: 2 });
    expect(await store.liveRunIds()).toEqual(["r1"]);
    expect(await store.launchIdForRun("r1")).toBe("l1");
    expect(await store.acceptBatch("l1", 2, [completed("r1")])).toEqual({
      accepted: true,
      runId: "r1",
    });
    expect(await store.liveRunIds()).toEqual([]);
  });

  it("applies a retried batch at most once", async () => {
    const { store } = setup();
    await store.create("l1", "demo", 100);
    await store.acceptBatch("l1", 0, [started("r1")]);
    expect(await store.acceptBatch("l1", 0, [started("r1")])).toEqual({
      accepted: true,
      runId: "r1",
    });
    expect(await store.listEvents()).toHaveLength(1);
  });

  it("rolls back a batch that fails validation", async () => {
    const { store, readLaunch } = setup();
    await store.create("l1", "demo", 100);
    const invalid = { ...started("r1"), payload: {} } as unknown as PipelineTraceEvent;
    await expect(store.acceptBatch("l1", 0, [started("r1"), invalid])).rejects.toThrow();
    expect(await store.listEvents()).toEqual([]);
    expect(readLaunch("l1")).toMatchObject({ last_batch: -1, state: "starting" });
  });

  it("records a host-terminated failure once and drops late events", async () => {
    const { store, readLaunch } = setup();
    await store.create("l1", "demo", 100);
    await store.acceptBatch("l1", 0, [started("r1")]);
    await store.fail("l1", "The Cloudflare run host stopped before the run finished.", 500);
    await store.fail("l1", "again", 600);
    expect(await store.acceptBatch("l1", 1, [completed("r1")])).toEqual({
      accepted: false,
    });
    const events = await store.listEvents();
    expect(events.map((event) => event.name)).toEqual(["pipeline.started", "pipeline.completed"]);
    expect(events[1]).toMatchObject({
      payload: { status: "failed", errorCount: 1, stepCount: 2 },
      error: { code: "TUBELESS_RUN_CANCELLED", kind: "cancellation", phase: "execution" },
    });
    expect(readLaunch("l1")?.state).toBe("failed");
    expect(readLaunch("l1")?.last_batch).toBe(0);
    expect(await store.acceptBatch("l1", 1, [completed("r1")])).toEqual({
      accepted: false,
    });
    // Late queued batches remain rejected without sequence-gap retries.
    expect(await store.acceptBatch("l1", 99, [completed("r1")])).toEqual({ accepted: false });
    expect(readLaunch("l1")?.last_batch).toBe(0);
    expect(await store.listEvents()).toHaveLength(2);
  });

  it("drops the first batch of a launch that failed before it started", async () => {
    const { store } = setup();
    await store.create("l1", "demo", 100);
    await store.fail("l1", "The run host could not confirm the run started.", 200);
    expect(await store.acceptBatch("l1", 0, [started("r1")])).toEqual({
      accepted: false,
    });
    expect(await store.acceptBatch("l1", 0, [started("r1")])).toEqual({ accepted: false });
    expect(await store.listEvents()).toEqual([]);
    expect(await store.launchIdForRun("r1")).toBeUndefined();
  });

  it("requires strictly serial batches", async () => {
    const { store, readLaunch } = setup();
    await store.create("l1", "demo", 100);
    await store.acceptBatch("l1", 0, [started("r1")]);
    await expect(store.acceptBatch("l1", 2, [completed("r1")])).rejects.toThrow(
      "Launch l1 expected batch 1 but received 2."
    );
    expect(await store.listEvents()).toHaveLength(1);
    expect(readLaunch("l1")).toMatchObject({ last_batch: 0, state: "running" });
    expect(await store.acceptBatch("l1", 1, [completed("r1")])).toEqual({
      accepted: true,
      runId: "r1",
    });
  });

  it("stops resolving a run to its launch once the launch is finished", async () => {
    const { store } = setup();
    await store.create("l1", "demo", 100);
    await store.acceptBatch("l1", 0, [started("r1")]);
    expect(await store.launchIdForRun("r1")).toBe("l1");
    await store.acceptBatch("l1", 1, [completed("r1")]);
    expect(await store.launchIdForRun("r1")).toBeUndefined();
  });

  it("admits a known, open launch and refuses unknown or closed ones", async () => {
    const { store, readLaunch } = setup();
    expect(await store.admit("missing")).toBe(false);
    await store.create("l1", "demo", 100);
    expect(readLaunch("l1")?.admitted).toBe(0);
    expect(await store.admit("l1")).toBe(true);
    expect(readLaunch("l1")).toMatchObject({ admitted: 1, state: "starting" });
    expect(await store.admit("l1")).toBe(true);
    await store.create("closed", "demo", 100);
    await store.fail("closed", "The run host could not confirm the run started.", 200);
    expect(await store.admit("closed")).toBe(false);
    expect(readLaunch("closed")?.admitted).toBe(0);
    await store.create("done", "demo", 100);
    await store.acceptBatch("done", 0, [started("r1"), completed("r1")]);
    expect(await store.admit("done")).toBe(false);
  });

  it("closes every open run in the launch subtree, children before the root", async () => {
    const { store } = setup();
    await store.create("l1", "demo", 100);
    const child: PipelineTraceEvent = {
      ...started("child", "r1", 3),
      pipelineId: "nested",
      correlationId: "corr-1",
      itemKey: "item-1",
    };
    const grandchild: PipelineTraceEvent = {
      ...started("grandchild", "child", 5),
      pipelineId: "leaf",
      iteration: { runId: "child", stepId: "loop", attemptId: "a1", index: 1 },
    };
    const finishedChild: PipelineTraceEvent = {
      ...completed("done-child"),
      parentRunId: "r1",
    };
    await store.acceptBatch("l1", 0, [started("r1")]);
    await store.acceptBatch("l1", 1, [
      child,
      grandchild,
      started("done-child", "r1"),
      finishedChild,
    ]);
    const before = (await store.listEvents()).length;
    await store.fail("l1", "The Cloudflare run host stopped before the run finished.", 900);
    const events = await store.listEvents();
    const appended = events.slice(before);
    expect(appended.map((event) => [event.name, event.runId])).toEqual([
      ["pipeline.completed", "grandchild"],
      ["pipeline.completed", "child"],
      ["pipeline.completed", "r1"],
    ]);
    const cancelled = {
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      message: "The Cloudflare run host stopped before the run finished.",
      phase: "execution",
    };
    expect(appended[0]).toMatchObject({
      pipelineId: "leaf",
      parentRunId: "child",
      iteration: { runId: "child", stepId: "loop", attemptId: "a1", index: 1 },
      timestampMs: 900,
      payload: { status: "failed", errorCount: 1, finalized: false, stepCount: 5, dryRun: false },
      error: cancelled,
    });
    expect(appended[1]).toMatchObject({
      pipelineId: "nested",
      parentRunId: "r1",
      correlationId: "corr-1",
      itemKey: "item-1",
      payload: { status: "failed", stepCount: 3 },
      error: cancelled,
    });
    expect(appended[2]).toMatchObject({
      pipelineId: "demo",
      payload: { status: "failed", stepCount: 2 },
      error: cancelled,
    });
    expect(appended[2]).not.toHaveProperty("parentRunId");
    const { runs } = projectPipelineRunStore(events);
    expect(runs.filter((run) => run.status === "running")).toEqual([]);
    expect(createRunHistoryIndex(runs).subtreeIsRunning("r1")).toBe(false);
  });

  it("ages running launches from their persisted root start instead of launch creation", async () => {
    const { store, storage, events } = setup();
    await store.create("late", "demo", 0);
    await store.create("waiting", "demo", 0);
    await store.acceptBatch("late", 0, [{ ...started("root"), timestampMs: 150_000 }]);
    await store.acceptBatch("late", 1, [{ ...started("child", "root"), timestampMs: 160_000 }]);
    expect(await store.stale(1)).toEqual(["waiting"]);
    expect(await store.nextReconcileAt(180_000)).toBe(180_000);
    await store.fail("waiting", "Host stopped", 180_001);
    const recreated = new SqliteHostedLaunchStore(storage, events);
    expect(await recreated.nextReconcileAt(180_000)).toBe(330_000);
    expect(await recreated.stale(149_999)).toEqual([]);
    expect(await recreated.stale(150_000)).toEqual(["late"]);
  });

  it("falls back to creation time for old running records without a root start", async () => {
    const { store, storage } = setup();
    await store.create("legacy", "demo", 10);
    storage.sql.exec(
      "UPDATE tubeless_launches SET state = 'running', run_id = 'missing' WHERE launch_id = ?",
      "legacy"
    );
    expect(await store.stale(10)).toEqual(["legacy"]);
    expect(await store.nextReconcileAt(180_000)).toBe(180_010);
    await store.fail("legacy", "Host stopped", 180_010);
    expect(await store.nextReconcileAt(180_000)).toBeUndefined();
  });

  it("fails unbound launches without inventing history and lists stale launches", async () => {
    const { store, readLaunch } = setup();
    await store.create("old", "demo", 100);
    await store.create("edge", "demo", 5_000);
    await store.create("new", "demo", 10_000);
    expect(await store.stale(5_000)).toEqual(["old", "edge"]);
    expect(await store.nextReconcileAt(0)).toBe(100);
    await store.fail("old", "Pipeline command exited (2) before recording a run.", 6_000);
    expect(await store.listEvents()).toEqual([]);
    expect(readLaunch("old")?.state).toBe("failed");
  });
});
