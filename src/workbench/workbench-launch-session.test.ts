import { describe, expect, it, vi } from "vitest";
import type { PipelineRunEventStore } from "../run-store/run-store.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { WorkbenchLaunchSession } from "./workbench-launch-session.js";

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next, fail) => {
    reject = fail;
    resolve = next;
  });
  return { promise, reject, resolve };
}

function startedEvent(runId = "run-1"): PipelineTraceEvent {
  return {
    name: "pipeline.started",
    payload: { dryRun: false, planOk: true, stepCount: 0, targetIds: [] },
    pipelineId: "fixture",
    runId,
    timestampMs: 1,
    version: 2,
  };
}

function fakeStore(overrides: Partial<PipelineRunEventStore> = {}): PipelineRunEventStore {
  return {
    close: () => undefined,
    export: () => undefined,
    listEvents: async () => [],
    ...overrides,
  };
}

describe("WorkbenchLaunchSession", () => {
  it("acknowledges with the real run id only after the start event is flushed", async () => {
    const flushed = deferred<void>();
    const execution = deferred<number>();
    const stopping = deferred<void>();
    const recorded: string[] = [];
    const exported: PipelineTraceEvent[] = [];
    const session = new WorkbenchLaunchSession({
      onRunRecorded: (runId) => recorded.push(runId),
      signal: new AbortController().signal,
      stopping: stopping.promise,
      store: fakeStore({
        export: (event) => {
          exported.push(event);
        },
        flush: () => flushed.promise,
      }),
    });
    const tracked = session.track(execution.promise, vi.fn());
    let acknowledged = false;
    void tracked.acknowledgement.then(() => {
      acknowledged = true;
    });

    const exportStart = session.pipelineContext.tracing!.exporter.export(startedEvent());
    await Promise.resolve();
    expect(exported).toEqual([startedEvent()]);
    expect(recorded).toEqual([]);
    expect(acknowledged).toBe(false);

    flushed.resolve(undefined);
    await exportStart;
    await expect(tracked.acknowledgement).resolves.toEqual({ accepted: true, runId: "run-1" });
    expect(recorded).toEqual(["run-1"]);
    expect(session.runId).toBe("run-1");

    execution.resolve(0);
    await tracked.settled;
  });

  it("surfaces start-event persistence failure instead of acknowledging the launch", async () => {
    const failure = new Error("start event was not persisted");
    const execution = deferred<number>();
    const stopping = deferred<void>();
    const onRunRecorded = vi.fn();
    const session = new WorkbenchLaunchSession({
      onRunRecorded,
      signal: new AbortController().signal,
      stopping: stopping.promise,
      store: fakeStore({
        flush: () => {
          throw failure;
        },
      }),
    });
    const tracked = session.track(execution.promise, vi.fn());

    await expect(session.pipelineContext.tracing!.exporter.export(startedEvent())).rejects.toBe(
      failure
    );
    await expect(tracked.acknowledgement).rejects.toBe(failure);
    expect(onRunRecorded).not.toHaveBeenCalled();
    expect(session.runId).toBeUndefined();

    execution.resolve(1);
    await tracked.settled;
  });

  it("reports a command rejection that occurs after acknowledgement exactly once", async () => {
    const failure = new Error("late output failure");
    const execution = deferred<number>();
    const stopping = deferred<void>();
    const reportLateFailure = vi.fn();
    const session = new WorkbenchLaunchSession({
      onRunRecorded: vi.fn(),
      signal: new AbortController().signal,
      stopping: stopping.promise,
      store: fakeStore(),
    });
    const tracked = session.track(execution.promise, reportLateFailure);

    await session.pipelineContext.tracing!.exporter.export(startedEvent());
    await expect(tracked.acknowledgement).resolves.toEqual({ accepted: true, runId: "run-1" });
    execution.reject(failure);
    await tracked.settled;

    expect(reportLateFailure).toHaveBeenCalledOnce();
    expect(reportLateFailure).toHaveBeenCalledWith(failure);
  });
});
