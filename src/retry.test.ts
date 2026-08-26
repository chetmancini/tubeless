import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./retry";

describe("withRetry", () => {
  it("returns the result on first success without waiting", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(operation, { maxAttempts: 3, baseDelayMs: 10 });
    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries with exponential backoff until success", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    const sleeps: number[] = [];

    const result = await withRetry(
      operation,
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        sleep: async (durationMs) => {
          sleeps.push(durationMs);
        },
      },
      onRetry
    );

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 200);
  });

  it("fails immediately without sleeping when shouldRetry rejects an error", async () => {
    const permanent = new Error("permanent");
    const operation = vi.fn().mockRejectedValue(permanent);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(
      withRetry(
        operation,
        { maxAttempts: 5, baseDelayMs: 10, shouldRetry: () => false, sleep },
        onRetry
      )
    ).rejects.toBe(permanent);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries an error accepted by shouldRetry and then succeeds", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 10,
        shouldRetry: () => true,
        sleep,
      })
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("passes the failed attempt number and stops when the predicate rejects a later error", async () => {
    const transient = new Error("transient");
    const permanent = new Error("permanent");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(permanent);
    const attempts: number[] = [];
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(operation, {
        maxAttempts: 5,
        baseDelayMs: 10,
        shouldRetry: (error, attempt) => {
          attempts.push(attempt);
          return error instanceof Error && error.message === "transient";
        },
        sleep,
      })
    ).rejects.toBe(permanent);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws the last error after exhausting maxAttempts", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValue(new Error("always fails"));

    const promise = withRetry(operation, { maxAttempts: 2, baseDelayMs: 10 });
    const assertion = expect(promise).rejects.toThrow("always fails");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("caps backoff at maxDelayMs", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    const promise = withRetry(
      operation,
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 },
      onRetry
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(150);
    await promise;

    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 150);
    vi.useRealTimers();
  });

  it("adds up to 10% jitter on top of the backoff when jitter is enabled", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("ok");
    const onRetry = vi.fn();

    await withRetry(
      operation,
      {
        maxAttempts: 2,
        baseDelayMs: 100,
        jitter: true,
        random: () => 0.5,
        sleep: async () => {},
      },
      onRetry
    );

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 105);
  });

  it("keeps jitter within maxDelayMs", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("ok");
    const onRetry = vi.fn();

    await withRetry(
      operation,
      {
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 100,
        jitter: true,
        random: () => 1,
        sleep: async () => {},
      },
      onRetry
    );

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 100);
  });

  it("supplies each operation attempt with retry and cancellation context", async () => {
    const controller = new AbortController();
    const attempts: Array<{ attempt: number; maxAttempts: number; signal?: AbortSignal }> = [];

    await withRetry(
      async (context) => {
        attempts.push(context);
        if (context.attempt === 1) throw new Error("retry me");
        return "ok";
      },
      {
        maxAttempts: 3,
        baseDelayMs: 0,
        signal: controller.signal,
        sleep: async () => {},
      }
    );

    expect(attempts).toEqual([
      { attempt: 1, maxAttempts: 3, signal: controller.signal },
      { attempt: 2, maxAttempts: 3, signal: controller.signal },
    ]);
  });

  it("aborts before the first attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const operation = vi.fn().mockResolvedValue("ok");

    await expect(
      withRetry(operation, { maxAttempts: 3, baseDelayMs: 10, signal: controller.signal })
    ).rejects.toThrow("Retry aborted: stop");

    expect(operation).not.toHaveBeenCalled();
  });

  it("aborts during the backoff delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(new Error("try again"));

    const promise = withRetry(operation, {
      maxAttempts: 3,
      baseDelayMs: 100,
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort("cancelled");
    await expect(promise).rejects.toThrow("Retry aborted: cancelled");
    expect(operation).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes the abort signal to an injected sleep implementation", async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValueOnce(new Error("try again")).mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await withRetry(operation, {
      maxAttempts: 2,
      baseDelayMs: 25,
      signal: controller.signal,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(25, controller.signal);
  });

  it("rejects a non-positive or non-integer maxAttempts up front", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(operation, { maxAttempts: 0, baseDelayMs: 10 })).rejects.toThrow(
      /maxAttempts/
    );
    await expect(withRetry(operation, { maxAttempts: -1, baseDelayMs: 10 })).rejects.toThrow(
      /maxAttempts/
    );
    await expect(withRetry(operation, { maxAttempts: 1.5, baseDelayMs: 10 })).rejects.toThrow(
      /maxAttempts/
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a negative or non-finite baseDelayMs up front", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(operation, { maxAttempts: 3, baseDelayMs: -1 })).rejects.toThrow(
      /baseDelayMs/
    );
    await expect(
      withRetry(operation, { maxAttempts: 3, baseDelayMs: Number.POSITIVE_INFINITY })
    ).rejects.toThrow(/baseDelayMs/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a negative or non-finite maxDelayMs up front", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    await expect(
      withRetry(operation, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: -1 })
    ).rejects.toThrow(/maxDelayMs/);
    expect(operation).not.toHaveBeenCalled();
  });
});
