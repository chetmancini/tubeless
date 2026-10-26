import { afterEach, describe, expect, it, vi } from "vitest";
import { studioRunDetail } from "../server/listener.test-support.js";
import { run } from "./graph/graph.test-support.js";
import { createRunHistoryIndex, summarizeRun } from "../../run-store/run-history.js";
import type { StudioRunDetail } from "./transport.js";
import { RunDetailLoader } from "./run-detail-loader.js";

function summary(id = "child", eventCount = 1) {
  const recorded = run({ runId: id, eventCount, status: "completed" });
  return summarizeRun(recorded, createRunHistoryIndex([recorded]));
}
function detail(id = "child", eventCount = 1) {
  return studioRunDetail(run({ runId: id, eventCount, status: "completed" }));
}
function deferred() {
  let resolve!: (detail: StudioRunDetail | null) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<StudioRunDetail | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
const loaders: RunDetailLoader[] = [];
function loader(api: ConstructorParameters<typeof RunDetailLoader>[0], id = "child") {
  const accept = vi.fn();
  const instance = new RunDetailLoader(api, id, accept, 50);
  loaders.push(instance);
  return { instance, accept };
}
afterEach(() => {
  loaders.splice(0).forEach((instance) => instance.dispose());
  vi.useRealTimers();
});

describe("RunDetailLoader", () => {
  it.each([{ subtreeEventCount: 2 }, { rootRunId: "new-root" }, { status: "failed" as const }])(
    "refreshes when the summary changes by %j",
    async (change) => {
      const loadRunDetail = vi.fn(async () => detail());
      const { instance } = loader({ loadRunDetail });
      const mutable = summary();
      instance.update(mutable);
      await settle();
      Object.assign(mutable, change);
      instance.update(mutable);
      await settle();
      instance.update(mutable);
      expect(loadRunDetail).toHaveBeenCalledTimes(2);
    }
  );

  it("publishes a slow success and coalesces revisions received during the read", async () => {
    const requests = [deferred(), deferred(), deferred()];
    const loadRunDetail = vi
      .fn()
      .mockReturnValueOnce(requests[0]!.promise)
      .mockReturnValueOnce(requests[1]!.promise)
      .mockReturnValueOnce(requests[2]!.promise);
    const { instance, accept } = loader({ loadRunDetail });
    instance.update(summary());
    instance.update(summary("child", 2));
    instance.update(summary("child", 3));
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    requests[0]!.resolve(detail());
    await settle();
    expect(accept).toHaveBeenLastCalledWith(detail());
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    instance.update(summary("child", 4));
    requests[1]!.resolve(detail("child", 3));
    await settle();
    expect(accept).toHaveBeenLastCalledWith(detail("child", 3));
    expect(loadRunDetail).toHaveBeenCalledTimes(3);
    requests[2]!.resolve(detail("child", 4));
    await settle();
    instance.update(summary("child", 4));
    expect(accept).toHaveBeenLastCalledWith(detail("child", 4));
    expect(loadRunDetail).toHaveBeenCalledTimes(3);
  });

  it.each(["missing", "failed", "wrong run"])(
    "retries %s responses without a revision change and retains success",
    async (outcome) => {
      vi.useFakeTimers();
      const requests = [deferred(), deferred(), deferred()];
      const loadRunDetail = vi
        .fn()
        .mockReturnValueOnce(requests[0]!.promise)
        .mockReturnValueOnce(requests[1]!.promise)
        .mockReturnValueOnce(requests[2]!.promise);
      const { instance, accept } = loader({ loadRunDetail });
      instance.update(summary());
      requests[0]!.resolve(detail());
      await settle();
      instance.update(summary("child", 2));
      if (outcome === "failed") requests[1]!.reject(new Error("offline"));
      else requests[1]!.resolve(outcome === "missing" ? null : detail("wrong"));
      await settle();
      instance.update(summary("child", 2));
      expect(accept).toHaveBeenCalledTimes(1);
      expect(loadRunDetail).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(50);
      requests[2]!.resolve(detail("child", 2));
      await settle();
      expect(accept).toHaveBeenLastCalledWith(detail("child", 2));
    }
  );

  it("retries an initially missing finished child without reloading a loaded sibling", async () => {
    vi.useFakeTimers();
    const loadRunDetail = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(detail("sibling"))
      .mockResolvedValueOnce(detail());
    const child = loader({ loadRunDetail });
    const sibling = loader({ loadRunDetail }, "sibling");
    child.instance.update(summary());
    sibling.instance.update(summary("sibling"));
    await settle();
    expect(child.accept).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(50);
    expect(child.accept).toHaveBeenLastCalledWith(detail());
    expect(sibling.accept).toHaveBeenCalledTimes(1);
    expect(loadRunDetail.mock.calls.map(([id]) => id)).toEqual(["child", "sibling", "child"]);
  });

  it("retires requests and timers on disposal, including when the same run is reopened", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const loadRunDetail = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(null);
    const old = loader({ loadRunDetail });
    old.instance.update(summary());
    old.instance.dispose();
    const reopened = loader({ loadRunDetail });
    reopened.instance.update(summary());
    pending.resolve(detail());
    await settle();
    expect(old.accept).not.toHaveBeenCalled();
    reopened.instance.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
