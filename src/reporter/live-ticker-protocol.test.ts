import { Worker } from "node:worker_threads";
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

  it("wakes a real cross-thread claim once the worker actually releases the lock", async () => {
    const parent = new TickerWorkerState();
    const holdMs = 150;
    const protocolUrl = new URL("../../dist/reporter/live-ticker-protocol.js", import.meta.url);
    const source = `
      import { parentPort, workerData } from "node:worker_threads";
      const { TickerWorkerState } = await import(${JSON.stringify(protocolUrl.href)});
      const state = new TickerWorkerState(workerData.buffer);
      state.withWorkerOutput(() => {
        parentPort.postMessage("acquired");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
      });
      parentPort.postMessage("released");
    `;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      workerData: { buffer: parent.buffer, holdMs },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (message) => {
          if (message === "acquired") resolve();
          else reject(new Error(`unexpected worker message: ${String(message)}`));
        });
      });

      // The worker genuinely holds the lock on its own OS thread right now: a
      // short-timeout claim from this thread must time out for real, not because
      // of same-thread simulation.
      expect(parent.claimOutput(10)).toBe(false);
      expect(parent.inlineRequested).toBe(true);

      await new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (message) => {
          if (message === "released") resolve();
          else reject(new Error(`unexpected worker message: ${String(message)}`));
        });
      });

      // Once the worker's own `withWorkerOutput` call actually returns (Atomics.store
      // + Atomics.notify on OUTPUT_LOCK), a fresh claim must succeed — proving the
      // wake-on-release path works across real threads, not just same-thread timing.
      expect(parent.claimOutput(1_000)).toBe(true);
    } finally {
      await worker.terminate();
    }
  });
});
