import { afterEach, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { placeCloudflareChild, type RunnerStageStore } from "./cloudflare-child-placement.js";

async function fixture(readStage: RunnerStageStore["readStage"], generation?: number) {
  const pipeline = definePipeline({
    id: "child",
    implementationVersion: "test",
    steps: [createSteps().step("work", { run: () => "result" })],
  });
  const plan = pipeline.plan();
  const enqueueStage = vi.fn<RunnerStageStore["enqueueStage"]>().mockResolvedValue(undefined);
  const cancelStage = vi.fn<RunnerStageStore["cancelStage"]>().mockResolvedValue(undefined);
  const store = vi.fn(() => ({ enqueueStage, cancelStage, readStage }));
  const signal = new AbortController();
  const place = placeCloudflareChild({
    definitions: new Map([[pipeline.id, plan.definition!.identity.definitionId]]),
    launchId: "launch",
    deploymentId: "test",
    generation,
    deadlineAtMs: Date.now() + 5_000,
    flush: async () => {},
    store,
  });
  const context = { cwd: "/tmp", parentRunId: "parent", signal: signal.signal, log: console };
  return {
    store,
    enqueueStage,
    cancelStage,
    signal,
    run: () =>
      place({
        pipeline,
        plan,
        options: {},
        controls: {},
        context,
        stepId: "stage",
        journalPath: generation === undefined ? undefined : ["v1", "execution", "launch", "stage"],
        reportProgress() {},
      })!,
    report: await pipeline.run({}, undefined, context),
  };
}

afterEach(() => vi.useRealTimers());

it("retries an unconfirmed stage dispatch using the same ID and generation", async () => {
  const readStage = vi.fn<RunnerStageStore["readStage"]>();
  const { enqueueStage, run, report, store } = await fixture(readStage, 2);
  enqueueStage.mockRejectedValueOnce(
    Object.assign(new Error("Studio restarted"), { retryable: true })
  );
  readStage.mockResolvedValue({ events: [], result: { report } });

  await expect(run()).resolves.toEqual(report);
  expect(enqueueStage).toHaveBeenCalledTimes(2);
  expect(enqueueStage.mock.calls[1]).toEqual(enqueueStage.mock.calls[0]);
  expect(enqueueStage.mock.calls[0][1]).toBe(2);
  expect(store).toHaveBeenCalledTimes(3);
});

it("recreates the Studio stub for a retryable read and queues the child once", async () => {
  vi.useFakeTimers();
  const fixtureRead = vi.fn<RunnerStageStore["readStage"]>();
  const { store, run, report, enqueueStage } = await fixture(fixtureRead);
  const firstStubRead = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("Studio restarted"), { retryable: true }));
  store.mockImplementationOnce(() => ({
    enqueueStage,
    readStage: firstStubRead,
    cancelStage: vi.fn(),
  }));
  store.mockImplementationOnce(() => ({
    enqueueStage,
    readStage: firstStubRead,
    cancelStage: vi.fn(),
  }));
  fixtureRead.mockResolvedValue({ events: [], result: { report } });

  const result = run();
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toEqual(report);
  expect(enqueueStage).toHaveBeenCalledOnce();
  expect(firstStubRead).toHaveBeenCalledOnce();
  expect(store).toHaveBeenCalledTimes(3);
  expect(fixtureRead).toHaveBeenCalledWith(...firstStubRead.mock.calls[0]);
});

it("interrupts a stalled result read on parent abort and cancels through a fresh stub", async () => {
  const read = vi
    .fn<RunnerStageStore["readStage"]>()
    .mockImplementation(() => new Promise(() => {}));
  const { signal, run, store, cancelStage, enqueueStage } = await fixture(read);
  const result = run();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  const failure = expect(result).rejects.toThrow("Parent stopped");
  signal.abort(new DOMException("Parent stopped", "AbortError"));
  await failure;
  expect(enqueueStage).toHaveBeenCalledOnce();
  expect(cancelStage).toHaveBeenCalledWith("launch", enqueueStage.mock.calls[0][0].id, undefined);
  expect(store).toHaveBeenCalledTimes(3);
});

it.each([
  Object.assign(new Error("Overloaded"), { retryable: true, overloaded: true }),
  Object.assign(new Error("Permanent failure"), { remote: true }),
])("reports $message immediately", async (error) => {
  const read = vi.fn<RunnerStageStore["readStage"]>().mockRejectedValue(error);
  const { run } = await fixture(read);
  await expect(run()).rejects.toBe(error);
  expect(read).toHaveBeenCalledOnce();
});
