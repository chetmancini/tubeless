import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { HostedRunCoordinator } from "./run-coordinator.js";
import { createStudioHost } from "./hosting-studio.js";
import { createSqliteLaunchStoreFixture } from "./launch-store-sqlite.test-support.js";
import { commands, job, sideEffect } from "./run.test-support.js";
import { createProcessHostedExecutor } from "./process-executor.test-support.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  sideEffect.mockClear();
});

function setup(options: { filename?: string; startTimeoutMs?: number } = {}) {
  const fixture = createSqliteLaunchStoreFixture(options.filename);
  cleanups.push(() => fixture.store.close());
  let coordinator!: HostedRunCoordinator;
  const output = { cwd: process.cwd(), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
  const executor = createProcessHostedExecutor({ commands, output, ingest: () => coordinator });
  cleanups.push(() => executor.close());
  const scheduleReconcile = vi.fn(async () => {});
  coordinator = new HostedRunCoordinator(
    {
      commands,
      output,
      executor,
      maxRunDurationMs: 60_000,
      scheduleReconcile,
      startTimeoutMs: options.startTimeoutMs,
    },
    fixture.store
  );
  return { ...fixture, coordinator, executor, scheduleReconcile };
}

function request(path: string, body?: unknown) {
  return new Request(
    `https://studio.test${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://studio.test",
            "x-tubeless-studio-launch": "1",
          },
          body: JSON.stringify(body),
        }
  );
}

describe("process hosted executor through the shared coordinator", () => {
  it("launches through Studio and keeps completed history across a collector reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-hosted-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "runs.sqlite");
    const { coordinator, executor, store } = setup({ filename });
    const batches = vi.spyOn(store, "acceptBatch");
    const host = await createStudioHost({
      store,
      launcher: coordinator,
      clientScript: "",
    });
    const response = await host.fetch(
      request("/api/commands/greeting/runs", { values: { name: "Ada" } })
    );
    expect(response.status).toBe(202);
    const result = (await response.json()) as { accepted: boolean; runId: string };
    expect(result.accepted).toBe(true);
    await executor.drain();
    expect(await coordinator.liveRunIds()).toEqual([]);
    const snapshot = await (await host.fetch(request("/api/snapshot"))).json();
    expect(snapshot.liveRunIds).toEqual([]);
    const events = await store.listEvents();
    expect(events.find((event) => event.name === "pipeline.completed")?.payload.status).toBe(
      "completed"
    );
    await executor.close();
    await store.close();
    const reopened = createSqliteLaunchStoreFixture(filename);
    try {
      expect(await reopened.store.listEvents()).toEqual(events);
      const [id, sequence, batch] = batches.mock.calls[0]!;
      expect(await reopened.store.acceptBatch(id, sequence, batch)).toEqual({
        accepted: true,
        runId: result.runId,
      });
      expect(await reopened.store.listEvents()).toEqual(events);
      expect(await reopened.store.launchIdForRun(result.runId)).toBeUndefined();
    } finally {
      reopened.store.close();
    }
  });

  it("cancels by run identity and drains the recorded terminal event", async () => {
    const { coordinator, executor, store } = setup();
    const result = await coordinator.launch("waiting", { name: "Ada" });
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("Expected a recorded run.");
    expect(await coordinator.liveRunIds()).toEqual([result.runId]);
    expect(await coordinator.cancel(result.runId)).toEqual({
      cancelled: true,
      runId: result.runId,
    });
    await executor.drain();
    expect(
      (await store.listEvents()).find((event) => event.name === "pipeline.completed")?.payload
        .status
    ).toBe("cancelled");
    expect(await coordinator.cancel(result.runId)).toEqual({ cancelled: false });
  });

  it("prevents duplicate dispatch within its lifetime, including after completion", async () => {
    const { executor, store } = setup();
    await store.create("l1", "effect", Date.now());
    const run = { ...job({ name: "Ada" }), commandId: "effect" };
    await Promise.all([executor.start(run), executor.start(run)]);
    await executor.drain();
    await executor.start(run);
    await executor.drain();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(
      (await store.listEvents()).filter((event) => event.name === "pipeline.started")
    ).toHaveLength(1);
    await executor.close();
    await expect(executor.start({ ...run, launchId: "l2" })).rejects.toThrow("closed");
  });

  it("refuses a terminal launch before executing user code", async () => {
    const { store, executor } = setup();
    await store.create("l1", "effect", Date.now());
    await store.fail("l1", "No longer executable", Date.now());
    await executor.start({ ...job({ name: "Ada" }), commandId: "effect" });
    await executor.drain();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(await store.listEvents()).toEqual([]);
  });

  it("protects admitted work from a delayed dispatch failure", async () => {
    const { store, readLaunch } = setup();
    await store.create("l1", "effect", Date.now());
    expect(await store.admit("l1")).toBe(true);
    await store.failUnadmitted("l1", "Dispatch response was lost", Date.now());
    expect(readLaunch("l1")?.state).toBe("starting");
    await store.create("l2", "effect", Date.now());
    await store.failUnadmitted("l2", "Never dispatched", Date.now());
    expect(await store.admit("l2")).toBe(false);
  });

  it("records cancellation before closing and refuses subsequent dispatch", async () => {
    const { coordinator, executor, store } = setup();
    await coordinator.launch("waiting", { name: "Ada" });
    await executor.close();
    expect(
      (await store.listEvents()).find((event) => event.name === "pipeline.completed")?.payload
        .status
    ).toBe("cancelled");
    expect(await store.liveRunIds()).toEqual([]);
  });
});

describe("hosted acknowledgement failures", () => {
  it("acknowledges a committed start after its store reply was lost", async () => {
    vi.useFakeTimers();
    const { coordinator, executor, store } = setup({ startTimeoutMs: 1000 });
    const accept = store.acceptBatch.bind(store);
    vi.spyOn(store, "acceptBatch").mockImplementationOnce(async (...args) => {
      await accept(...args);
      throw new Error("Committed, but the reply was lost");
    });
    const launched = coordinator.launch("greeting", { name: "Ada" });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await launched;
    expect(result.accepted).toBe(true);
    await executor.drain();
    const events = await store.listEvents();
    expect(events.filter((event) => event.name === "pipeline.started")).toHaveLength(1);
    expect(events.find((event) => event.name === "pipeline.completed")?.payload.status).toBe(
      "completed"
    );
  });

  it("acknowledges a retried batch that already completed its launch", async () => {
    const { coordinator, executor, store } = setup();
    const accept = store.acceptBatch.bind(store);
    vi.spyOn(store, "acceptBatch").mockImplementationOnce(async (...args) => {
      await accept(...args);
      throw new Error("Committed, but the reply was lost");
    });
    const batch: PipelineTraceEvent[] = [
      {
        version: 3,
        name: "pipeline.started",
        pipelineId: "greeting",
        runId: "root",
        timestampMs: 1,
        payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
      },
      {
        version: 3,
        name: "pipeline.completed",
        pipelineId: "greeting",
        runId: "root",
        timestampMs: 2,
        payload: {
          dryRun: false,
          errorCount: 0,
          finalized: true,
          status: "completed",
          stepCount: 0,
        },
      },
    ];
    vi.spyOn(executor, "start").mockImplementation(async (job) => {
      await coordinator.admit(job.launchId);
      await expect(coordinator.appendEvents(job.launchId, 0, batch)).rejects.toThrow(
        "reply was lost"
      );
      expect(await coordinator.appendEvents(job.launchId, 0, batch)).toEqual({ accepted: true });
    });
    expect(await coordinator.launch("greeting", { name: "Ada" })).toEqual({
      accepted: true,
      runId: "root",
    });
    expect(await store.listEvents()).toHaveLength(2);
    expect(await coordinator.liveRunIds()).toEqual([]);
  });

  it.each(["create", "scheduleReconcile", "start", "failUnadmitted"] as const)(
    "returns the acknowledgement timeout when %s stalls",
    async (operation) => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { coordinator, executor, store, scheduleReconcile } = setup({ startTimeoutMs: 10 });
      const dispatched = vi.spyOn(executor, "start");
      const never = new Promise<never>(() => {});
      if (operation === "create") vi.spyOn(store, "create").mockReturnValue(never);
      else if (operation === "scheduleReconcile") scheduleReconcile.mockReturnValue(never);
      else if (operation === "start") dispatched.mockReturnValue(never);
      else {
        scheduleReconcile.mockRejectedValue(new Error("Recovery unavailable"));
        vi.spyOn(store, "failUnadmitted").mockReturnValue(never);
      }
      const launched = coordinator.launch("greeting", { name: "Ada" });
      await vi.advanceTimersByTimeAsync(10);
      expect(await launched).toMatchObject({
        accepted: false,
        errors: [expect.stringContaining("within 10 ms")],
      });
      expect(dispatched).toHaveBeenCalledTimes(operation === "start" ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("dispatches only after delayed recovery setup succeeds, even after the response times out", async () => {
    vi.useFakeTimers();
    const { coordinator, executor, store, scheduleReconcile } = setup({ startTimeoutMs: 10 });
    let recover!: () => void;
    scheduleReconcile.mockReturnValue(
      new Promise<void>((resolve) => {
        recover = resolve;
      })
    );
    const dispatched = vi.spyOn(executor, "start");
    const launched = coordinator.launch("greeting", { name: "Ada" });
    await vi.advanceTimersByTimeAsync(10);
    expect(await launched).toMatchObject({ accepted: false });
    expect(dispatched).not.toHaveBeenCalled();
    recover();
    await vi.advanceTimersByTimeAsync(0);
    await executor.drain();
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(
      (await store.listEvents()).find((event) => event.name === "pipeline.completed")?.payload
        .status
    ).toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
