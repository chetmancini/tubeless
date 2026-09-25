import type { MessagePort } from "node:worker_threads";

export interface LiveTickerWorkerData {
  color: boolean;
  columns?: number;
  fd: number;
  framePort: MessagePort;
  refreshIntervalMs: number;
  stateBuffer: SharedArrayBuffer;
  unicode: boolean;
}

export type TickerWorkerMessage =
  | { columns?: number; lines: string[]; logPane?: readonly string[]; type: "lines" }
  | { columns?: number; text: string; type: "log" }
  | { columns?: number; lines: string[]; logPane?: readonly string[]; type: "stop" };

const STOPPED = 0;
const ACCEPTED_LOGS = 1;
const INLINE_REQUESTED = 2;
const OUTPUT_LOCK = 3;

/** Shared output ownership and acknowledgements, viewed from either thread. */
export class TickerWorkerState {
  readonly #state: Int32Array;

  constructor(readonly buffer = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT)) {
    this.#state = new Int32Array(buffer);
  }

  get acceptedLogs(): number {
    return Atomics.load(this.#state, ACCEPTED_LOGS);
  }

  acknowledgeLog(): void {
    Atomics.add(this.#state, ACCEPTED_LOGS, 1);
  }

  get inlineRequested(): boolean {
    return Atomics.load(this.#state, INLINE_REQUESTED) === 1;
  }

  markStopped(): void {
    Atomics.store(this.#state, STOPPED, 1);
    Atomics.notify(this.#state, STOPPED);
  }

  waitForStop(timeoutMs: number): boolean {
    return Atomics.wait(this.#state, STOPPED, 0, timeoutMs) !== "timed-out";
  }

  withWorkerOutput(write: () => void): void {
    while (Atomics.compareExchange(this.#state, OUTPUT_LOCK, 0, 1) !== 0) {
      Atomics.wait(this.#state, OUTPUT_LOCK, 1);
    }
    try {
      if (!this.inlineRequested) write();
    } finally {
      Atomics.store(this.#state, OUTPUT_LOCK, 0);
      Atomics.notify(this.#state, OUTPUT_LOCK);
    }
  }

  /** Revoke worker writes, then acquire exclusive output ownership within the deadline. */
  claimOutput(timeoutMs: number): boolean {
    Atomics.store(this.#state, INLINE_REQUESTED, 1);
    const deadline = Date.now() + timeoutMs;
    while (Atomics.compareExchange(this.#state, OUTPUT_LOCK, 0, 1) !== 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      Atomics.wait(this.#state, OUTPUT_LOCK, 1, remainingMs);
    }
    return true;
  }

  /** Only an exit event guarantees that an abandoned lock no longer protects a write. */
  releaseOutputAfterWorkerExit(): void {
    Atomics.store(this.#state, OUTPUT_LOCK, 0);
  }
}
