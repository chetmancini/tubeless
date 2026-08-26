import { describe, expect, it, vi } from "vitest";
import { chunk, runBatched, runConcurrent } from "./batch";

describe("chunk", () => {
  it("splits an array into fixed-size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("returns a single chunk when size exceeds the array length", () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("rejects a zero or negative size instead of looping forever", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow(/positive integer/);
    expect(() => chunk([1, 2, 3], -1)).toThrow(/positive integer/);
  });

  it("rejects a non-integer size", () => {
    expect(() => chunk([1, 2, 3], 1.5)).toThrow(/positive integer/);
  });
});

describe("runBatched", () => {
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
      await new Promise((resolve) => setTimeout(resolve, 10));
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
      await new Promise((resolve) => setTimeout(resolve, 5));
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

describe("runConcurrent", () => {
  it("preserves input order while bounding active work", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await runConcurrent([3, 1, 2], { concurrency: 2 }, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, item));
      active -= 1;
      return item * 2;
    });

    expect(results).toEqual([6, 2, 4]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("passes each worker its index and signal", async () => {
    const controller = new AbortController();
    const seen: Array<[number, AbortSignal | undefined]> = [];

    await runConcurrent(["a", "b"], { signal: controller.signal }, async (_item, index, signal) => {
      seen.push([index, signal]);
      return index;
    });

    expect(seen).toEqual([
      [0, controller.signal],
      [1, controller.signal],
    ]);
  });

  it("stops scheduling after a worker failure while allowing active work to settle", async () => {
    let releaseSlowWorker: (() => void) | undefined;
    const slowWorkerSettled = new Promise<void>((resolve) => {
      releaseSlowWorker = resolve;
    });
    const seen: number[] = [];
    const run = runConcurrent([0, 1, 2], { concurrency: 2 }, async (item) => {
      seen.push(item);
      if (item === 0) {
        await slowWorkerSettled;
        return item;
      }
      throw new Error("worker failed");
    });

    await Promise.resolve();
    releaseSlowWorker?.();
    await expect(run).rejects.toThrow("worker failed");
    expect(seen).toEqual([0, 1]);
  });

  it("rethrows the first worker failure after concurrent workers settle", async () => {
    const firstFailure = new Error("first failure");
    const laterFailure = new Error("later failure");
    let rejectLaterWorker: ((reason?: unknown) => void) | undefined;
    const laterWorker = new Promise<never>((_resolve, reject) => {
      rejectLaterWorker = reject;
    });

    const run = runConcurrent([0, 1], { concurrency: 2 }, async (item) => {
      if (item === 0) throw firstFailure;
      await laterWorker;
      throw laterFailure;
    });

    await Promise.resolve();
    rejectLaterWorker?.(laterFailure);

    await expect(run).rejects.toBe(firstFailure);
  });

  it("stops scheduling after cancellation", async () => {
    const controller = new AbortController();
    const seen: number[] = [];

    await expect(
      runConcurrent([0, 1, 2], { concurrency: 1, signal: controller.signal }, async (item) => {
        seen.push(item);
        controller.abort("stop");
        return item;
      })
    ).rejects.toThrow("Concurrent run aborted: stop");
    expect(seen).toEqual([0]);
  });
});
