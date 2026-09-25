import { describe, expect, it, vi } from "vitest";
import { TickerWorkerState } from "./live-ticker-protocol.js";

describe("ticker output ownership", () => {
  it("shares log acknowledgements and shutdown completion between thread views", () => {
    const parent = new TickerWorkerState();
    const worker = new TickerWorkerState(parent.buffer);
    expect(parent.acceptedLogs).toBe(0);
    expect(parent.waitForStop(0)).toBe(false);
    worker.acknowledgeLog();
    worker.acknowledgeLog();
    expect(parent.acceptedLogs).toBe(2);
    worker.markStopped();
    expect(parent.waitForStop(0)).toBe(true);
  });

  it("releases output ownership even when a worker write throws", () => {
    const parent = new TickerWorkerState();
    const worker = new TickerWorkerState(parent.buffer);
    expect(() =>
      worker.withWorkerOutput(() => {
        throw new Error("output closed");
      })
    ).toThrow("output closed");
    expect(parent.claimOutput(0)).toBe(true);
    expect(worker.inlineRequested).toBe(true);
  });

  it("revokes future worker writes when takeover times out during an active write", () => {
    const parent = new TickerWorkerState();
    const worker = new TickerWorkerState(parent.buffer);
    worker.withWorkerOutput(() => {
      expect(parent.claimOutput(0)).toBe(false);
      expect(worker.inlineRequested).toBe(true);
    });
    const lateWrite = vi.fn();
    worker.withWorkerOutput(lateWrite);
    expect(lateWrite).not.toHaveBeenCalled();
    expect(parent.claimOutput(0)).toBe(true);
  });
});
