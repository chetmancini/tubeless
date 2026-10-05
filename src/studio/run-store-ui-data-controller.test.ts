import { studioSnapshot as snapshot, studioRunDetail } from "./run-store-ui.test-support.js";
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

function api(overrides: Partial<StudioApi>): StudioApi {
  return {
    cancelRun: vi.fn(async () => {}),
    clearHistory: vi.fn(async () => ({ eventCount: 0 })),
    loadCapabilities: vi.fn(async () => ({ canCancel: false, canClearHistory: false })),
    loadCommands: vi.fn(async () => []),
    loadDefinition: vi.fn(async () => {
      throw new Error("unused");
    }),
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
  it("retires a slow history page when search or selection changes", async () => {
    const pending = [deferred<StudioSnapshot>(), deferred<StudioSnapshot>()];
    const loadSnapshot = vi
      .fn()
      .mockReturnValueOnce(pending[0]!.promise)
      .mockReturnValueOnce(pending[1]!.promise);
    const controller = new StudioDataController(api({ loadSnapshot }));
    controller.setHistoryQuery({ offset: 50 });
    controller.setHistoryQuery({ query: "child", offset: 0, selectedRunId: "nested" });
    pending[0]!.resolve(snapshot([run("old-page")]));
    await settle();
    expect(controller.getState().snapshot).toBeNull();
    expect(loadSnapshot).toHaveBeenLastCalledWith({
      query: "child",
      offset: 0,
      selectedRunId: "nested",
    });
    pending[1]!.resolve(snapshot([run("new-page")]));
    await settle();
    expect(controller.getState().snapshot?.runs[0]?.runId).toBe("new-page");
    controller.dispose();
  });

  it("retains live details and coalesces same-run revisions while a read is pending", async () => {
    const requests: Deferred<StudioRunDetail | null>[] = [];
    const loadRunDetail = vi.fn(() => {
      const request = deferred<StudioRunDetail | null>();
      requests.push(request);
      return request.promise;
    });
    const controller = new StudioDataController(api({ loadRunDetail }));

    controller.selectRun("live", "live:1:running");
    requests[0]!.resolve(studioRunDetail(run("live", 1)));
    await settle();
    controller.selectRun("live", "live:2:running");
    controller.selectRun("live", "live:3:running");
    controller.selectRun("live", "live:4:running");
    expect(controller.getState().detail?.run.eventCount).toBe(1);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);

    requests[1]!.resolve(studioRunDetail(run("live", 2)));
    await settle();
    expect(controller.getState().detail?.run.eventCount).toBe(2);
    expect(loadRunDetail).toHaveBeenCalledTimes(3);
    requests[2]!.resolve(studioRunDetail(run("live", 4)));
    await settle();
    expect(controller.getState().detail?.run.eventCount).toBe(4);
    expect(loadRunDetail).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it.each(["missing", "failed"] as const)(
    "retains details and retries the latest revision after a %s refresh",
    async (outcome) => {
      vi.useFakeTimers();
      const requests: Deferred<StudioRunDetail | null>[] = [];
      const loadRunDetail = vi.fn(() => {
        const request = deferred<StudioRunDetail | null>();
        requests.push(request);
        return request.promise;
      });
      const controller = new StudioDataController(api({ loadRunDetail }), 50);
      controller.selectRun("live", "live:1:running");
      requests[0]!.resolve(studioRunDetail(run("live", 1)));
      await settle();
      controller.selectRun("live", "live:2:running");
      if (outcome === "missing") requests[1]!.resolve(null);
      else requests[1]!.reject(new Error("offline"));
      await settle();
      controller.selectRun("live", "live:3:running");
      expect(controller.getState().detail?.run.eventCount).toBe(1);
      expect(loadRunDetail).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(loadRunDetail).toHaveBeenCalledTimes(3);
      requests[2]!.resolve(studioRunDetail(run("live", 3)));
      await settle();
      expect(controller.getState().detail?.run.eventCount).toBe(3);
      controller.dispose();
    }
  );

  it("rejects old detail responses after switching away and back to the same run", async () => {
    const requests: Deferred<StudioRunDetail | null>[] = [];
    const loadRunDetail = vi.fn(() => {
      const request = deferred<StudioRunDetail | null>();
      requests.push(request);
      return request.promise;
    });
    const controller = new StudioDataController(api({ loadRunDetail }));
    controller.selectRun("first", "first:1:running");
    controller.selectRun("second", "second:1:running");
    controller.selectRun("first", "first:2:running");
    requests[2]!.resolve(studioRunDetail(run("first", 2)));
    await settle();
    requests[0]!.resolve(studioRunDetail(run("first", 1)));
    requests[1]!.resolve(studioRunDetail(run("second", 1)));
    await settle();
    expect(controller.getState().detail?.run).toMatchObject({ runId: "first", eventCount: 2 });
    controller.dispose();
  });

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

    controller.refresh();
    requests[1]!.resolve(snapshot([run("second")]));
    await settle();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
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
    requests.get("second")!.resolve(studioRunDetail(run("second")));
    await settle();
    expect(controller.getState().detail?.run.runId).toBe("second");

    requests.get("first")!.resolve(studioRunDetail(run("first")));
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
    requests[0]!.resolve(studioRunDetail(run("stale")));
    await settle();
    expect(controller.getState().detail).toBeNull();

    await vi.advanceTimersByTimeAsync(50);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    requests[1]!.resolve(studioRunDetail(run("selected", 2)));
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
    requests[2]!.request.resolve(studioRunDetail(run("second")));
    await settle();
    expect(controller.getState().detail?.run.runId).toBe("second");
  });
});

it.each([401, 403] as const)(
  "clears retained data and retires reads, timers and invalidation after %s",
  async (status) => {
    vi.useFakeTimers();
    const snapshots: Deferred<StudioSnapshot>[] = [];
    const details: Deferred<StudioRunDetail | null>[] = [];
    let deny!: (status: 401 | 403) => void;
    const unsubscribe = vi.fn();
    const service = api({
      subscribeAccessDenied: (listener) => {
        deny = listener;
        return unsubscribe;
      },
      loadSnapshot: vi.fn(() => {
        const request = deferred<StudioSnapshot>();
        snapshots.push(request);
        return request.promise;
      }),
      loadRunDetail: vi.fn(() => {
        const request = deferred<StudioRunDetail | null>();
        details.push(request);
        return request.promise;
      }),
    });
    const controller = new StudioDataController(service, 50);
    controller.refresh();
    snapshots[0]!.resolve(snapshot([run("secret")]));
    controller.selectRun("secret", "secret:1");
    details[0]!.resolve(studioRunDetail(run("secret")));
    await settle();
    expect(controller.getState().snapshot?.runs).toHaveLength(1);
    expect(controller.getState().detail?.run.runId).toBe("secret");
    controller.refresh();
    controller.refresh(true);
    controller.selectRun("secret", "secret:2");
    deny(status);
    snapshots[1]!.resolve(snapshot([run("late")]));
    details[1]!.resolve(studioRunDetail(run("late")));
    await settle();
    controller.refresh(true);
    controller.invalidate({ delayMs: 20 });
    controller.selectRun("other", "other:1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.getState()).toEqual({
      accessDenied: status,
      connected: false,
      detail: null,
      manualRefreshing: false,
      snapshot: null,
    });
    expect(service.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(service.loadRunDetail).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  }
);
