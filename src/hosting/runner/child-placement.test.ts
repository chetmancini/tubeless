import { afterEach, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "../../core/pipeline.js";
import { placeRunnerChild, type RunnerStageStore } from "./child-placement.js";

const retryable = (error: unknown) =>
  error instanceof Error &&
  "retryable" in error &&
  error.retryable === true &&
  !("overloaded" in error && error.overloaded === true);

async function fixture(readStage: RunnerStageStore["readStage"], generation?: number) {
  const pipeline = definePipeline({
    id: "child",
    implementationVersion: "test",
    steps: [createSteps().step("work", { run: () => "result" })],
  });
  const plan = pipeline.plan();
  const enqueueStage = vi.fn<RunnerStageStore["enqueueStage"]>().mockResolvedValue(undefined);
  const cancelStage = vi.fn<RunnerStageStore["cancelStage"]>().mockResolvedValue(undefined);
  const signal = new AbortController();
  const place = placeRunnerChild({
    definitions: new Map([[pipeline.id, plan.definition!.identity.definitionId]]),
    launchId: "launch",
    deploymentId: "test",
    recover: generation !== undefined,
    shouldRetry: retryable,
    dispatchAttempts: generation === undefined ? 1 : 3,
    interruptedStage: generation === undefined ? "failed" : "outcome_unknown",
    flush: async () => {},
    store: { enqueueStage, cancelStage, readStage },
  });
  const context = { cwd: "/tmp", parentRunId: "parent", signal: signal.signal, log: console };
  return {
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

it("retries an unconfirmed stage dispatch using the same ID", async () => {
  const readStage = vi.fn<RunnerStageStore["readStage"]>();
  const { enqueueStage, run, report } = await fixture(readStage, 2);
  enqueueStage.mockRejectedValueOnce(
    Object.assign(new Error("Studio restarted"), { retryable: true })
  );
  readStage.mockResolvedValue({ events: [], result: { report } });

  await expect(run()).resolves.toEqual(report);
  expect(enqueueStage).toHaveBeenCalledTimes(2);
  expect(enqueueStage.mock.calls[1]).toEqual(enqueueStage.mock.calls[0]);
});

it("retries a transient observation failure without dispatching again", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn<RunnerStageStore["readStage"]>()
    .mockRejectedValueOnce(Object.assign(new Error("Studio restarted"), { retryable: true }));
  const { run, report, enqueueStage } = await fixture(read);
  read.mockResolvedValue({ events: [], result: { report } });

  const result = run();
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toEqual(report);
  expect(enqueueStage).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]).toEqual(read.mock.calls[0]);
});

it("interrupts a stalled result read and cancels the dispatched stage", async () => {
  let markReading!: () => void;
  const reading = new Promise<void>((resolve) => {
    markReading = resolve;
  });
  const read = vi.fn<RunnerStageStore["readStage"]>(() => {
    markReading();
    return new Promise(() => {});
  });
  const { signal, run, cancelStage, enqueueStage } = await fixture(read);
  const result = run();
  await reading;
  const failure = expect(result).rejects.toThrow("Parent stopped");
  signal.abort(new DOMException("Parent stopped", "AbortError"));
  await failure;
  expect(read).toHaveBeenCalledOnce();
  expect(enqueueStage).toHaveBeenCalledOnce();
  expect(cancelStage).toHaveBeenCalledWith("launch", enqueueStage.mock.calls[0][0].id);
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
