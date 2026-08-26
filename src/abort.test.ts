import { describe, expect, it, vi } from "vitest";
import { abortableSleep, createAbortError, isAbortError, throwIfAborted } from "./abort";

describe("createAbortError", () => {
  it("builds a message with just the label when reason is undefined", () => {
    // A real AbortController.abort() with no argument sets `reason` to an AbortError
    // DOMException, never `undefined` — so this branch only fires for a hand-built
    // AbortSignal-like object, not real-world abort() calls. Still worth covering since
    // callers may construct signals another way.
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    const error = createAbortError(signal, "Retry");
    expect(error.message).toBe("Retry aborted");
    expect(isAbortError(error)).toBe(true);
  });

  it("passes a real AbortController's default AbortError reason through unchanged", () => {
    const controller = new AbortController();
    controller.abort();
    expect(createAbortError(controller.signal, "Retry")).toBe(controller.signal.reason);
    expect(isAbortError(controller.signal.reason)).toBe(true);
  });

  it("appends a string reason to the label", () => {
    const controller = new AbortController();
    controller.abort("stop");
    expect(createAbortError(controller.signal, "Retry").message).toBe("Retry aborted: stop");
  });

  it("passes an Error reason through unchanged instead of wrapping it", () => {
    const reason = new Error("network down");
    const controller = new AbortController();
    controller.abort(reason);
    expect(createAbortError(controller.signal, "Retry")).toBe(reason);
    expect(isAbortError(reason)).toBe(true);
  });

  it("does not classify an ordinary error as cancellation", () => {
    expect(isAbortError(new Error("database failed"))).toBe(false);
  });
});

describe("throwIfAborted", () => {
  it("does nothing when there is no signal", () => {
    expect(() => throwIfAborted(undefined, "Retry")).not.toThrow();
  });

  it("does nothing when the signal has not been aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal, "Retry")).not.toThrow();
  });

  it("throws an abort error once the signal has been aborted", () => {
    const controller = new AbortController();
    controller.abort("stop");
    expect(() => throwIfAborted(controller.signal, "Retry")).toThrow("Retry aborted: stop");
  });
});

describe("abortableSleep", () => {
  it("resolves immediately for a zero or negative duration without touching the signal", async () => {
    const controller = new AbortController();
    await expect(abortableSleep(0, controller.signal, "Retry")).resolves.toBeUndefined();
    await expect(abortableSleep(-1, controller.signal, "Retry")).resolves.toBeUndefined();
  });

  it("resolves after the duration when never aborted", async () => {
    vi.useFakeTimers();
    const promise = abortableSleep(50, undefined, "Retry");
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it("rejects and clears the timer when aborted mid-sleep", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = abortableSleep(50, controller.signal, "Retry");
    const assertion = expect(promise).rejects.toThrow("Retry aborted: stop");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort("stop");
    await assertion;
    vi.useRealTimers();
  });

  it("rejects immediately when the signal is already aborted before the call", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort("stop");
    const promise = abortableSleep(50, controller.signal, "Retry");
    const assertion = expect(promise).rejects.toThrow("Retry aborted: stop");
    // The "abort" event already fired in the past; a listener attached now would never
    // see it. Advancing the fake clock proves the rejection didn't come from a timeout
    // that happened to also fire — nothing should still be pending.
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
