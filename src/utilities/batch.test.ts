import { describe, expect, it, vi } from "vitest";
import { runBatched, runConcurrent, runConcurrentPartial } from "./batch.js";

describe("runBatched", () => {
  it("returns an empty array without running the worker for empty input", async () => {
    const worker = vi.fn(async (batch: number[]) => batch);
    await expect(runBatched([], { size: 3 }, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("runs a single batch when size exceeds the array length", async () => {
    await expect(runBatched([1, 2], { size: 10 }, async (batch) => batch)).resolves.toEqual([
      [1, 2],
    ]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])("rejects invalid batch size %p", async (size) => {
    const worker = vi.fn(async () => 0);
    await expect(runBatched([1, 2, 3], { size }, worker)).rejects.toThrow(/positive integer/);
    expect(worker).not.toHaveBeenCalled();
  });

  it("chunks items and runs the worker per batch, preserving order", async () => {
    const seen: number[][] = [];
    const results = await runBatched([1, 2, 3, 4, 5], { size: 2 }, async (batch) => {
      seen.push(batch);
      return batch.reduce((sum, value) => sum + value, 0);
    });
    expect(results).toEqual([3, 7, 5]);
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("passes the batch index to the worker", async () => {
    const indices: number[] = [];
    await runBatched([1, 2, 3, 4], { size: 2 }, async (_batch, index) => {
      indices.push(index);
      return index;
    });
    expect(indices).toEqual([0, 1]);
  });

  it("limits in-flight batches to the configured concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    await runBatched([1, 2, 3, 4, 5, 6], { size: 1, concurrency: 2 }, async (batch) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return batch[0];
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("defaults to concurrency 1 (sequential) when unset", async () => {
    let active = 0;
    let maxActive = 0;
    await runBatched([1, 2, 3], { size: 1 }, async (batch) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return batch[0];
    });
    expect(maxActive).toBe(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    "rejects invalid concurrency %p",
    async (concurrency) => {
      const worker = vi.fn(async () => 0);

      await expect(runBatched([1, 2, 3], { size: 1, concurrency }, worker)).rejects.toThrow(
        /concurrency/
      );

      expect(worker).not.toHaveBeenCalled();
    }
  );

  it("does not run any batch when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const worker = vi.fn();

    await expect(
      runBatched([1, 2, 3], { size: 1, signal: controller.signal }, worker)
    ).rejects.toThrow("Batch run aborted: stop");
    expect(worker).not.toHaveBeenCalled();
  });

  it("stops scheduling further batches once the signal is aborted mid-run", async () => {
    const controller = new AbortController();
    const seen: number[] = [];

    await expect(
      runBatched([1, 2, 3, 4], { size: 1, signal: controller.signal }, async (batch, index) => {
        seen.push(index);
        if (index === 0) {
          controller.abort("stop");
        }
        return batch[0];
      })
    ).rejects.toThrow("Batch run aborted: stop");
    expect(seen).toEqual([0]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const rejectionValues = [undefined, false, null, "worker failed", new Error("worker failed")];

describe("runConcurrent", () => {
  it.each(rejectionValues)("rejects with the original worker rejection %p", async (failure) => {
    const run = runConcurrent([0], {}, async () => {
      throw failure;
    });
    await expect(run).rejects.toBe(failure);
  });

  it("returns successful undefined outputs", async () => {
    await expect(runConcurrent([0, 1], {}, async () => undefined)).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("rejects only after active workers drain", async () => {
    const active = deferred<number>();
    const failure = new Error("first failure");
    const seen: number[] = [];
    const run = runConcurrent([0, 1, 2], { concurrency: 2 }, (item) => {
      seen.push(item);
      return item === 0 ? Promise.reject(failure) : active.promise;
    });
    const rejected = vi.fn();
    void run.catch(rejected);
    await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
    active.resolve(1);
    await expect(run).rejects.toBe(failure);
    expect(seen).toEqual([0, 1]);
  });

  it("rejects with the original cancellation Error", async () => {
    const failure = new Error("stop");
    await expect(
      runConcurrent([0], { signal: AbortSignal.abort(failure) }, async () => 0)
    ).rejects.toBe(failure);
  });
});

describe("runConcurrentPartial", () => {
  it("schedules lazily within the limit and orders results by original input indexes", async () => {
    const workers = [deferred<string>(), deferred<string>(), deferred<string>()];
    const controller = new AbortController();
    const worker = vi.fn(
      (_item: string, index: number, _signal?: AbortSignal) => workers[index]!.promise
    );
    const run = runConcurrentPartial(
      ["a", "b", "c"],
      { concurrency: 2, signal: controller.signal },
      worker
    );

    expect(worker.mock.calls).toEqual([
      ["a", 0, controller.signal],
      ["b", 1, controller.signal],
    ]);
    workers[1]!.resolve("second");
    await Promise.resolve();
    expect(worker.mock.calls).toEqual([
      ["a", 0, controller.signal],
      ["b", 1, controller.signal],
      ["c", 2, controller.signal],
    ]);
    workers[2]!.resolve("third");
    workers[0]!.resolve("first");
    const partial = await run;
    expect(partial).toEqual({
      ok: true,
      results: ["first", "second", "third"],
      completedIndexes: new Set([0, 1, 2]),
    });
    expect(partial).not.toHaveProperty("failure");
  });

  it("defaults to sequential scheduling and records successful undefined outputs", async () => {
    const first = deferred<undefined>();
    const worker = vi.fn(() => first.promise);
    const run = runConcurrentPartial([0, 1], {}, worker);
    expect(worker).toHaveBeenCalledTimes(1);
    first.resolve(undefined);
    const partial = await run;
    expect(worker).toHaveBeenCalledTimes(2);
    expect(partial).toEqual({
      ok: true,
      results: [undefined, undefined],
      completedIndexes: new Set([0, 1]),
    });
    expect(Object.keys(partial.results)).toEqual(["0", "1"]);
  });

  it.each(rejectionValues)("records rejection %p separately from success", async (failure) => {
    const worker = vi.fn(async () => {
      throw failure;
    });
    const partial = await runConcurrentPartial([0, 1], {}, worker);
    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error("Expected a failed outcome");
    expect(partial.failure).toBe(failure);
    expect(partial.results).toHaveLength(2);
    expect(Object.keys(partial.results)).toEqual([]);
    expect(partial.completedIndexes.size).toBe(0);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("stops queued work and retains successful outputs that arrive during draining", async () => {
    const workers = [
      deferred<string | undefined>(),
      deferred<string | undefined>(),
      deferred<string | undefined>(),
    ];
    const controller = new AbortController();
    const worker = vi.fn((_item: number, index: number, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      return workers[index]!.promise;
    });
    const run = runConcurrentPartial(
      [0, 1, 2, 3],
      { concurrency: 3, signal: controller.signal },
      worker
    );
    const resolved = vi.fn();
    void run.then(resolved);
    workers[1]!.reject(undefined);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    workers[2]!.resolve(undefined);
    workers[0]!.resolve("late success");
    const partial = await run;
    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error("Expected a failed outcome");
    expect(partial.failure).toBeUndefined();
    expect(partial.results).toHaveLength(4);
    expect(partial.results[0]).toBe("late success");
    expect(partial.results[2]).toBeUndefined();
    expect(Object.keys(partial.results)).toEqual(["0", "2"]);
    expect(partial.completedIndexes).toEqual(new Set([0, 2]));
    expect(worker.mock.calls.map(([, index]) => index)).toEqual([0, 1, 2]);
    expect(controller.signal.aborted).toBe(false);
  });

  it.each(rejectionValues)(
    "preserves first observed rejection %p over later failures and abort",
    async (failure) => {
      const workers = [deferred<number>(), deferred<number>()];
      const controller = new AbortController();
      const run = runConcurrentPartial(
        [0, 1, 2],
        { concurrency: 2, signal: controller.signal },
        (_item, index) => workers[index]!.promise
      );
      workers[1]!.reject(failure);
      await Promise.resolve();
      controller.abort(new Error("later abort"));
      workers[0]!.reject(new Error("later worker failure"));
      const partial = await run;
      expect(partial.ok).toBe(false);
      if (partial.ok) throw new Error("Expected a failed outcome");
      expect(partial.failure).toBe(failure);
      expect(partial.completedIndexes.size).toBe(0);
    }
  );

  it("does not start workers for a pre-aborted signal", async () => {
    const failure = new Error("already cancelled");
    const worker = vi.fn(async () => 0);
    const partial = await runConcurrentPartial(
      [0, 1],
      { signal: AbortSignal.abort(failure) },
      worker
    );
    expect(partial).toMatchObject({ ok: false, failure, completedIndexes: new Set() });
    if (partial.ok) throw new Error("Expected a failed outcome");
    expect(partial.failure).toBe(failure);
    expect(Object.keys(partial.results)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("stops admission on mid-run cancellation and drains active successes", async () => {
    const controller = new AbortController();
    const failure = new Error("operator stop");
    const workers = [deferred<number>(), deferred<number>()];
    const worker = vi.fn((_item: number, index: number) => workers[index]!.promise);
    const run = runConcurrentPartial(
      [0, 1, 2],
      { concurrency: 2, signal: controller.signal },
      worker
    );
    const resolved = vi.fn();
    void run.then(resolved);
    controller.abort(failure);
    workers[0]!.resolve(10);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    workers[1]!.resolve(20);
    const partial = await run;
    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error("Expected a failed outcome");
    expect(partial.failure).toBe(failure);
    expect(partial.results.slice(0, 2)).toEqual([10, 20]);
    expect(partial.completedIndexes).toEqual(new Set([0, 1]));
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it("preserves an observed cancellation over a later worker rejection", async () => {
    const controller = new AbortController();
    const failure = new Error("operator stop");
    const workers = [deferred<number>(), deferred<number>()];
    const run = runConcurrentPartial(
      [0, 1],
      { concurrency: 2, signal: controller.signal },
      (_item, index) => workers[index]!.promise
    );
    controller.abort(failure);
    workers[0]!.resolve(10);
    await Promise.resolve();
    workers[1]!.reject(undefined);
    const partial = await run;
    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error("Expected a failed outcome");
    expect(partial.failure).toBe(failure);
    expect(partial.completedIndexes).toEqual(new Set([0]));
  });

  it.each([undefined, AbortSignal.abort("stop")])(
    "succeeds for empty input even when aborted",
    async (signal) => {
      const worker = vi.fn(async () => 0);
      const partial = await runConcurrentPartial([], { signal }, worker);
      expect(partial).toEqual({ ok: true, results: [], completedIndexes: new Set() });
      expect(worker).not.toHaveBeenCalled();
    }
  );

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    "throws for invalid concurrency %p even with empty input",
    async (concurrency) => {
      const worker = vi.fn(async () => 0);
      for (const items of [[], [0]]) {
        await expect(runConcurrentPartial(items, { concurrency }, worker)).rejects.toThrow(
          /concurrency/
        );
        await expect(runConcurrent(items, { concurrency }, worker)).rejects.toThrow(/concurrency/);
      }
      expect(worker).not.toHaveBeenCalled();
    }
  );
});
