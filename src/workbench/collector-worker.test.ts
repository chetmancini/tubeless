import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollectorWorker } from "../../dist/workbench/collector-worker.js";
import { workerFixture } from "./collector-worker.test-support.js";
import { createStudioHost } from "../hosting/hosting-studio.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
});
async function setup() {
  const fixture = await workerFixture();
  cleanups.push(() => fixture.close());
  const start = (overrides: Partial<Parameters<typeof startCollectorWorker>[0]> = {}) => {
    const worker = startCollectorWorker({ ...fixture.workerOptions, ...overrides });
    fixture.state.pid = worker.pid;
    cleanups.push(async () => {
      worker.cancel();
      await worker.completed;
    });
    return worker;
  };
  return { ...fixture, start };
}

describe("supervised collector workers over HTTPS", { timeout: 15_000 }, () => {
  it("streams a nested run from a separate process, survives collector restart and a lost commit reply, and renders Studio history", async () => {
    const { state, start, effectFile } = await setup();
    state.dropBatchAndRestart = true;
    const worker = start();
    expect(await worker.completed).toMatchObject({
      code: 0,
      failureReport: "not-needed",
      outcome: { status: "finished", recorded: true, delivered: true },
    });
    expect(Number((await readFile(effectFile, "utf8")).trim())).not.toBe(process.pid);
    const batches = state.requests.filter((request) => request.operation === "batches");
    expect(batches[0]!.body).toEqual(batches[1]!.body);
    const events = await state.fixture.store.listEvents();
    const starts = events.filter((event) => event.name === "pipeline.started");
    expect(starts).toHaveLength(2);
    expect(events.filter((event) => event.name === "pipeline.completed")).toHaveLength(2);
    const root = starts.find((event) => event.parentRunId === undefined)!;
    const host = await createStudioHost({ store: state.fixture.store, clientScript: "" });
    const detail = await (
      await host.fetch(new Request(`https://studio.test/api/runs/${root.runId}`))
    ).json();
    expect(detail.run).toMatchObject({ runId: root.runId, status: "completed" });
    const children = await (
      await host.fetch(new Request(`https://studio.test/api/runs/${root.runId}/children`))
    ).json();
    expect(children.childCount).toBe(1);
    expect(children.children[0]).toMatchObject({ pipelineId: "child", status: "completed" });
    const lengths = batches.map((request) => request.body.byteLength);
    expect(Math.max(...lengths)).toBeLessThan(1_048_576);
  });

  it("allows one execution across duplicate OS processes and later redelivery, before loading the module", async () => {
    const { start, importFile, effectFile, state } = await setup();
    const workers = [start(), start()];
    const results = await Promise.all(workers.map((worker) => worker.completed));
    expect(results.filter((result) => result.outcome?.status === "finished")).toHaveLength(1);
    expect(results.filter((result) => result.outcome?.status === "refused")).toHaveLength(1);
    expect((await start().completed).outcome?.status).toBe("refused");
    expect((await readFile(importFile, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readFile(effectFile, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(state.requests.filter((request) => request.operation === "failure")).toEqual([]);
  });

  it("does not load user code when a committed claim reply is lost", async () => {
    const { state, start, importFile } = await setup();
    state.dropClaim = true;
    expect(await start().completed).toMatchObject({
      outcome: { status: "unconfirmed" },
      failureReport: "unconfirmed",
    });
    expect(state.fixture.readLaunch("launch")?.admitted).toBe(1);
    expect((await start().completed).outcome?.status).toBe("refused");
    await expect(readFile(importFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await state.fixture.store.listEvents()).toEqual([]);
  });

  it("rejects a mismatched deployment before importing application code", async () => {
    const { start, importFile } = await setup();
    expect((await start({ deploymentId: "other-revision" }).completed).outcome?.status).toBe(
      "refused"
    );
    await expect(readFile(importFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores unrelated and malformed application IPC", async () => {
    const { writeModule, start } = await setup();
    await writeModule("ipc-noise");
    expect(await start().completed).toMatchObject({
      code: 0,
      outcome: { status: "finished", delivered: true },
      failureReport: "not-needed",
    });
  });

  it("flushes cancellation history through an independent delivery lifetime", async () => {
    const { writeModule, start, effectFile, state } = await setup();
    await writeModule("wait");
    const worker = start();
    await vi.waitFor(async () =>
      expect((await readFile(effectFile, "utf8")).length).toBeGreaterThan(0)
    );
    expect(worker.cancel()).toBe(true);
    expect(await worker.completed).toMatchObject({
      code: 0,
      outcome: { delivered: true },
      failureReport: "not-needed",
    });
    expect(worker.cancel()).toBe(false);
    const completions = (await state.fixture.store.listEvents()).filter(
      (event) => event.name === "pipeline.completed"
    );
    expect(completions).toHaveLength(2);
    expect(completions.every((event) => event.payload.status === "cancelled")).toBe(true);
  });

  it("forces an uncooperative worker to exit on deadline, then idempotently reports failure", async () => {
    const { writeModule, start, state } = await setup();
    await writeModule("hang");
    state.dropFailure = true;
    const worker = start({
      job: {
        launchId: "launch",
        attemptId: "attempt",
        commandId: "parent",
        values: {},
        maxRunDurationMs: 300,
      },
      cancelGraceMs: 0,
    });
    expect(await worker.completed).toMatchObject({ signal: "SIGKILL", failureReport: "recorded" });
    expect(state.failureWhileAlive).toBe(false);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
    const reports = state.requests.filter((request) => request.operation === "failure");
    expect(reports).toHaveLength(2);
    expect(reports[0]!.body).toEqual(reports[1]!.body);
  });

  it("leaves lost-contact history uncertain until termination is actually observed", async () => {
    const { writeModule, start, effectFile, state } = await setup();
    await writeModule("stall");
    state.unavailableBatches = true;
    const worker = start({ cancelGraceMs: 0 });
    await vi.waitFor(async () =>
      expect((await readFile(effectFile, "utf8")).length).toBeGreaterThan(0)
    );
    await vi.waitFor(
      () =>
        expect(state.requests.filter((request) => request.operation === "batches")).toHaveLength(4),
      { timeout: 2000 }
    );
    expect(state.requests.filter((request) => request.operation === "failure")).toEqual([]);
    expect(state.fixture.readLaunch("launch")?.state).not.toBe("failed");
    worker.cancel();
    expect((await worker.completed).failureReport).toBe("recorded");
    expect(state.failureWhileAlive).toBe(false);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
    expect((await readFile(effectFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("covers application module loading with the post-claim hard deadline", async () => {
    const { writeModule, start, state, effectFile } = await setup();
    await writeModule("setup-hang");
    const worker = start({
      job: {
        launchId: "launch",
        attemptId: "attempt",
        commandId: "parent",
        values: {},
        maxRunDurationMs: 300,
      },
      cancelGraceMs: 0,
    });
    expect(await worker.completed).toMatchObject({ signal: "SIGKILL", failureReport: "recorded" });
    expect(state.failureWhileAlive).toBe(false);
    expect(await state.fixture.store.listEvents()).toEqual([]);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
    await expect(readFile(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an abrupt worker crash only after observing its exit", async () => {
    const { writeModule, start, state } = await setup();
    await writeModule("crash");
    expect(await start().completed).toMatchObject({ signal: "SIGKILL", failureReport: "recorded" });
    expect(state.failureWhileAlive).toBe(false);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
  });

  it("keeps a failed failure-report delivery unconfirmed instead of retrying execution", async () => {
    const { start, state, module } = await setup();
    state.unavailableFailure = true;
    const missing = new URL("missing.mjs", module);
    expect(await start({ module: missing }).completed).toMatchObject({
      outcome: { status: "finished", recorded: false },
      failureReport: "unconfirmed",
    });
    expect(state.fixture.readLaunch("launch")?.state).toBe("starting");
    expect((await start().completed).outcome?.status).toBe("refused");
    expect(state.requests.filter((request) => request.operation === "failure")).toHaveLength(4);
  });

  it("rejects an oversized child definition snapshot while retaining and closing the real root", async () => {
    const { writeModule, start, state } = await setup();
    await writeModule("oversized");
    expect(await start().completed).toMatchObject({
      outcome: { status: "finished", delivered: false },
      failureReport: "recorded",
    });
    const events = await state.fixture.store.listEvents();
    expect(events.map((event) => event.name)).toEqual(["pipeline.started", "pipeline.completed"]);
    expect(events.every((event) => event.pipelineId === "parent")).toBe(true);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
  });
});
