import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollectorWorker } from "../../../dist/workbench/collector/worker.js";
import { workerFixture } from "./worker.test-support.js";
import { createStudioHost } from "../../hosting/hosting-studio.js";

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
  it.each([
    { flags: ["--eval"] },
    { flags: ["-e"] },
    { flags: ["--print"] },
    { flags: ["-p"] },
    { flags: ["--input-type=module", "--eval"] },
  ])("uses the fixed bootstrap when the parent runs with $flags", async ({ flags }) => {
    const { workerOptions, module, state } = await setup();
    const supervisor = new URL("../../../dist/workbench/collector/worker.js", import.meta.url).href;
    const source = `
      if (process.env.TUBELESS_EVAL_REENTRY === '1') {
        // Bound this regression test even if an eval-inheriting worker reruns its parent.
        process.exit(2);
      } else {
        import(${JSON.stringify(supervisor)}).then(({ startCollectorWorker }) => {
          process.once('message', async packet => {
            const worker = startCollectorWorker({
              ...packet, module: new URL(packet.module),
              env: { ...packet.env, TUBELESS_EVAL_REENTRY: '1' },
            });
            const result = await worker.completed;
            process.send(result, () => process.exit(0));
          });
        });
      }
    `;
    const launcher = spawn(process.execPath, [...flags, source], {
      env: workerOptions.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const closed = once(launcher, "close");
    const received = Promise.race([
      once(launcher, "message").then(([result]) => result),
      closed.then(() => {
        throw new Error("Eval launcher closed before its result.");
      }),
    ]);
    cleanups.push(async () => {
      launcher.kill("SIGKILL");
      await closed;
    });
    launcher.send({ ...workerOptions, fetch: undefined, module: module.href });
    expect(await received).toMatchObject({
      code: 0,
      outcome: { status: "history-confirmed" },
      failureReport: "not-needed",
    });
    await closed;
    expect(state.requests.filter((request) => request.operation === "admit")).toHaveLength(1);
    expect(state.fixture.readLaunch("launch")?.state).toBe("finished");
  });

  it("streams a nested run from a separate process, survives collector restart and a lost commit reply, and renders Studio history", async () => {
    const { state, start, effectFile } = await setup();
    state.dropBatchAndRestart = true;
    const worker = start();
    expect(await worker.completed).toMatchObject({
      code: 0,
      failureReport: "not-needed",
      outcome: { status: "history-confirmed" },
    });
    expect(Number((await readFile(effectFile, "utf8")).trim())).not.toBe(process.pid);
    expect(worker.cancel()).toBe(false);
    const batches = state.requests.filter((request) => request.operation === "batches");
    expect(batches[0].body).toEqual(batches[1].body);
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
    expect(results.filter((result) => result.outcome?.status === "history-confirmed")).toHaveLength(
      1
    );
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
      outcome: { status: "history-confirmed" },
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
      outcome: { status: "history-confirmed" },
      failureReport: "not-needed",
    });
    expect(worker.cancel()).toBe(false);
    const completions = (await state.fixture.store.listEvents()).filter(
      (event) => event.name === "pipeline.completed"
    );
    expect(completions).toHaveLength(2);
    expect(completions.every((event) => event.payload.status === "cancelled")).toBe(true);
  });

  it("refuses persisted cancellation before claim without importing user code", async () => {
    const { start, state, importFile } = await setup();
    expect(await state.fixture.store.requestAttemptCancellation("launch", "attempt")).toBe(true);
    expect(await start().completed).toMatchObject({
      outcome: { status: "refused" },
      failureReport: "not-needed",
    });
    await expect(readFile(importFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await state.fixture.store.listEvents()).toEqual([]);
    expect(state.requests.filter((request) => request.operation === "failure")).toEqual([]);
  });

  it("delivers persisted cancellation after collector restart and drains cancelled history", async () => {
    const { writeModule, start, state, effectFile, restartCollector } = await setup();
    await writeModule("wait");
    const worker = start();
    await vi.waitFor(async () =>
      expect((await readFile(effectFile, "utf8")).length).toBeGreaterThan(0)
    );
    await vi.waitFor(() => expect(state.fixture.readLaunch("launch")?.state).toBe("running"));
    expect(await state.fixture.store.requestAttemptCancellation("launch", "attempt")).toBe(true);
    expect(state.fixture.readLaunch("launch")?.state).toBe("running");
    await restartCollector();
    expect(await worker.completed).toMatchObject({
      code: 0,
      outcome: { status: "history-confirmed" },
      failureReport: "not-needed",
    });
    const completions = (await state.fixture.store.listEvents()).filter(
      (event) => event.name === "pipeline.completed"
    );
    expect(completions).toHaveLength(2);
    expect(completions.every((event) => event.payload.status === "cancelled")).toBe(true);
    expect(state.requests.some((request) => request.operation === "control")).toBe(true);
    expect(state.requests.filter((request) => request.operation === "failure")).toEqual([]);
  });

  it("forces a hung worker to exit after persisted cancellation before reporting failure", async () => {
    const { writeModule, start, state, effectFile } = await setup();
    await writeModule("hang");
    const worker = start({ cancelGraceMs: 0 });
    await vi.waitFor(async () =>
      expect((await readFile(effectFile, "utf8")).length).toBeGreaterThan(0)
    );
    await vi.waitFor(() => expect(state.fixture.readLaunch("launch")?.state).toBe("running"));
    expect(await state.fixture.store.requestAttemptCancellation("launch", "attempt")).toBe(true);
    expect(state.fixture.readLaunch("launch")?.state).toBe("running");
    expect(await worker.completed).toMatchObject({ signal: "SIGKILL", failureReport: "recorded" });
    expect(state.failureWhileAlive).toBe(false);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
  });

  it("keeps control outages uncertain and observes cancellation when connectivity returns", async () => {
    const { writeModule, start, state, effectFile } = await setup();
    await writeModule("wait");
    state.unavailableControl = true;
    const worker = start();
    await vi.waitFor(async () =>
      expect((await readFile(effectFile, "utf8")).length).toBeGreaterThan(0)
    );
    await vi.waitFor(() => expect(state.fixture.readLaunch("launch")?.state).toBe("running"));
    await state.fixture.store.requestAttemptCancellation("launch", "attempt");
    await vi.waitFor(
      () =>
        expect(state.requests.filter((request) => request.operation === "control")).toHaveLength(4),
      { timeout: 2000 }
    );
    expect(state.requests.filter((request) => request.operation === "failure")).toEqual([]);
    expect(state.fixture.readLaunch("launch")?.state).toBe("running");
    process.kill(worker.pid!, 0);
    state.unavailableControl = false;
    expect(await worker.completed).toMatchObject({
      code: 0,
      outcome: { status: "history-confirmed" },
      failureReport: "not-needed",
    });
  });

  it("aborts pending control reads on worker exit and observes late transport failures", async () => {
    const { start, workerOptions } = await setup();
    let signal: AbortSignal | undefined;
    let reject!: (error: Error) => void;
    const worker = start({
      fetch: async (input, init) => {
        if (!String(input).endsWith("/control")) return workerOptions.fetch(input, init);
        signal = init!.signal!;
        return new Promise<Response>((_, fail) => {
          reject = fail;
        });
      },
    });
    expect(await worker.completed).toMatchObject({ failureReport: "not-needed" });
    expect(signal?.aborted).toBe(true);
    reject(new Error("late private transport detail"));
    await Promise.resolve();
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
    expect(reports[0].body).toEqual(reports[1].body);
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
      outcome: { status: "unconfirmed" },
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
      outcome: { status: "unconfirmed" },
      failureReport: "recorded",
    });
    const events = await state.fixture.store.listEvents();
    expect(events.map((event) => event.name)).toEqual(["pipeline.started", "pipeline.completed"]);
    expect(events.every((event) => event.pipelineId === "parent")).toBe(true);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
  });

  it("reports partial root history after observing a clean worker exit", async () => {
    const { writeModule, start, state } = await setup();
    await writeModule("partial");
    expect(await start().completed).toMatchObject({
      code: 0,
      outcome: { status: "unconfirmed" },
      failureReport: "recorded",
    });
    expect(state.failureWhileAlive).toBe(false);
    expect(state.fixture.readLaunch("launch")?.state).toBe("failed");
    expect((await state.fixture.store.listEvents()).map((event) => event.name)).toEqual([
      "pipeline.started",
      "pipeline.completed",
    ]);
  });
});
