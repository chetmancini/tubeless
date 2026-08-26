import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  it("resolves immediately for the first call", async () => {
    const limiter = new RateLimiter(1000);
    const start = Date.now();
    await limiter.wait();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("spaces out consecutive calls by the interval", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(100);

    await limiter.wait();
    const second = limiter.wait();
    let resolved = false;
    void second.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await second;
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it.each([0, -1])("does not wait when intervalMs is %p", async (intervalMs) => {
    const limiter = new RateLimiter(intervalMs);
    await limiter.wait();
    const start = Date.now();
    await limiter.wait();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it.each([NaN, Infinity, -Infinity])("rejects a non-finite intervalMs of %p", (intervalMs) => {
    expect(() => new RateLimiter(intervalMs)).toThrow(/intervalMs/);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const limiter = new RateLimiter(1000);
    const controller = new AbortController();
    controller.abort("stop");

    await expect(limiter.wait(controller.signal)).rejects.toThrow("Rate limit wait aborted: stop");
  });

  it("rejects a pending wait once the signal is aborted", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(100);
    const controller = new AbortController();

    await limiter.wait();
    const second = limiter.wait(controller.signal);
    const assertion = expect(second).rejects.toThrow("Rate limit wait aborted: stop");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort("stop");
    await assertion;
    vi.useRealTimers();
  });
});
