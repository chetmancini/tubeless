import { abortableSleep, throwIfAborted } from "./abort.js";

export class RateLimiter {
  private nextAt = 0;
  private readonly pending: { slot: number }[] = [];

  constructor(private readonly intervalMs: number) {
    if (!Number.isFinite(intervalMs)) {
      throw new Error(`intervalMs must be a finite number, got ${intervalMs}`);
    }
  }

  async wait(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "Rate limit wait");
    if (this.intervalMs <= 0) return;

    const slot = Math.max(Date.now(), this.nextAt);
    this.nextAt = slot + this.intervalMs;
    const reservation = { slot };
    this.pending.push(reservation);

    try {
      const waitMs = Math.max(0, slot - Date.now());
      if (waitMs > 0) {
        await abortableSleep(waitMs, signal, "Rate limit wait");
      }
    } catch (error) {
      this.release(reservation);
      throw error;
    } finally {
      this.forget(reservation);
    }
  }

  private forget(reservation: { slot: number }): void {
    const index = this.pending.indexOf(reservation);
    if (index >= 0) this.pending.splice(index, 1);
  }

  private release(reservation: { slot: number }): void {
    this.forget(reservation);
    this.nextAt =
      this.pending.length === 0
        ? reservation.slot
        : Math.max(...this.pending.map((item) => item.slot)) + this.intervalMs;
  }
}
