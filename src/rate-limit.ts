import { abortableSleep, throwIfAborted } from "./abort.js";

export class RateLimiter {
  private nextAt = 0;

  constructor(private readonly intervalMs: number) {
    if (!Number.isFinite(intervalMs)) {
      throw new Error(`intervalMs must be a finite number, got ${intervalMs}`);
    }
  }

  async wait(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "Rate limit wait");
    if (this.intervalMs <= 0) return;

    const now = Date.now();
    const waitMs = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;

    if (waitMs > 0) {
      await abortableSleep(waitMs, signal, "Rate limit wait");
    }
  }
}
