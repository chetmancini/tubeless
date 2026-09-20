import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_MODEL_VERSION } from "../core/pipeline.js";
import type { StoredPipelineRun } from "../run-store/run-store.js";
import type {
  StudioApi,
  StudioRunDetail,
  StudioSnapshot,
} from "./run-store-ui-client-transport.js";
import { StudioDataController } from "./run-store-ui-data-controller.js";

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function run(runId: string, eventCount = 1): StoredPipelineRun {
  return {
    dryRun: false,
    eventCount,
    logCount: 0,
    logs: [],
    pipelineId: runId,
    runId,
    startedAtMs: 1,
    status: "completed",
    steps: [],
    version: RUN_MODEL_VERSION,
  };
}

function snapshot(runs: readonly StoredPipelineRun[]): StudioSnapshot {
  return {
    activeRunCount: runs.filter((item) => item.status === "running").length,
    completedRunCount: runs.filter((item) => item.status === "completed").length,
    definitions: [],
    failedRunCount: runs.filter((item) => item.status === "failed").length,
    generatedAtMs: 1,
    lastEventId: runs.reduce((total, item) => total + item.eventCount, 0),
    runs: [...runs],
  };
}

function api(overrides: Partial<StudioApi>): StudioApi {
  return {
    cancelRun: vi.fn(async () => {}),
    clearHistory: vi.fn(async () => ({ eventCount: 0 })),
    loadCapabilities: vi.fn(async () => ({ canCancel: false, canClearHistory: false })),
    loadCommands: vi.fn(async () => []),
    loadRunDetail: vi.fn(async () => null),
    loadSnapshot: vi.fn(async () => snapshot([])),
    launch: vi.fn(async () => "run"),
    previewPlan: vi.fn(async () => {
      throw new Error("unused");
    }),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("StudioDataController", () => {
  it("queues a refresh requested while a snapshot request is still loading", async () => {
    const requests: Deferred<StudioSnapshot>[] = [];
    const loadSnapshot = vi.fn(() => {
      const request = deferred<StudioSnapshot>();
      requests.push(request);
      return request.promise;
    });
    const controller = new StudioDataController(api({ loadSnapshot }));

    controller.refresh();
    controller.refresh(true);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getState().manualRefreshing).toBe(true);

    requests[0]!.resolve(snapshot([run("first")]));
    await settle();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(controller.getState().snapshot?.runs.map((item) => item.runId)).toEqual(["first"]);

    requests[1]!.resolve(snapshot([run("second")]));
    await settle();
    expect(controller.getState().snapshot?.runs.map((item) => item.runId)).toEqual(["second"]);
    expect(controller.getState().manualRefreshing).toBe(false);
  });

  it("does not restore cleared history from a delayed snapshot response", async () => {
    const requests: Deferred<StudioSnapshot>[] = [];
    const loadSnapshot = vi.fn(() => {
      const request = deferred<StudioSnapshot>();
      requests.push(request);
      return request.promise;
    });
    const controller = new StudioDataController(api({ loadSnapshot }));

    controller.refresh();
    requests[0]!.resolve(snapshot([run("recorded")]));
    await settle();
    controller.refresh();
    controller.invalidate({ resetHistory: true });
    expect(controller.getState().snapshot?.runs).toEqual([]);

    requests[1]!.resolve(snapshot([run("stale")]));
    await settle();
    expect(controller.getState().snapshot?.runs).toEqual([]);
    expect(loadSnapshot).toHaveBeenCalledTimes(3);

    requests[2]!.resolve(snapshot([]));
    await settle();
    expect(controller.getState().snapshot?.runs).toEqual([]);
  });

  it("ignores a delayed detail response after the selected run changes", async () => {
    const requests = new Map<string, Deferred<StudioRunDetail | null>>();
    const loadRunDetail = vi.fn((runId: string) => {
      const request = deferred<StudioRunDetail | null>();
      requests.set(runId, request);
      return request.promise;
    });
    const controller = new StudioDataController(api({ loadRunDetail }));

    controller.selectRun("first", "first:1:completed");
    controller.selectRun("second", "second:1:completed");
    requests.get("second")!.resolve({ run: run("second") });
    await settle();
    expect(controller.getState().detail?.run.runId).toBe("second");

    requests.get("first")!.resolve({ run: run("first") });
    await settle();
    expect(controller.getState().detail?.run.runId).toBe("second");
  });

  it("invalidates delayed detail responses and reloads the current selection", async () => {
    vi.useFakeTimers();
    const requests: Deferred<StudioRunDetail | null>[] = [];
    const loadRunDetail = vi.fn(() => {
      const request = deferred<StudioRunDetail | null>();
      requests.push(request);
      return request.promise;
    });
    const controller = new StudioDataController(api({ loadRunDetail }));

    controller.selectRun("selected", "selected:1:running");
    controller.invalidate({ delayMs: 50 });
    requests[0]!.resolve({ run: run("stale") });
    await settle();
    expect(controller.getState().detail).toBeNull();

    await vi.advanceTimersByTimeAsync(50);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    requests[1]!.resolve({ run: run("selected", 2) });
    await settle();
    expect(controller.getState().detail?.run.eventCount).toBe(2);
  });

  it("retries missing details only while the same selection remains current", async () => {
    vi.useFakeTimers();
    const requests: { request: Deferred<StudioRunDetail | null>; runId: string }[] = [];
    const loadRunDetail = vi.fn((runId: string) => {
      const request = deferred<StudioRunDetail | null>();
      requests.push({ request, runId });
      return request.promise;
    });
    const controller = new StudioDataController(api({ loadRunDetail }), 50);

    controller.selectRun("first", "first:1:completed");
    requests[0]!.request.resolve(null);
    await settle();
    controller.selectRun("second", "second:1:completed");
    await vi.advanceTimersByTimeAsync(50);
    expect(loadRunDetail.mock.calls.map(([runId]) => runId)).toEqual(["first", "second"]);

    requests[1]!.request.resolve(null);
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    expect(loadRunDetail.mock.calls.map(([runId]) => runId)).toEqual(["first", "second", "second"]);
    requests[2]!.request.resolve({ run: run("second") });
    await settle();
    expect(controller.getState().detail?.run.runId).toBe("second");
  });
});
