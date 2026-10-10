/**
 * Shared `AbortSignal` handling for every module that accepts one (pipeline execution,
 * retry/backoff, rate limiting, batching). Centralized so they all produce the same
 * abort-error shape and the same cancellable-sleep behavior, differing only in the
 * `label` used in error messages (e.g. "Retry", "Pipeline run").
 */

const abortErrors = new WeakSet<Error>();

/**
 * Largest delay `setTimeout` honors (2^31 - 1 ms, ~24.8 days). Node and browsers
 * clamp larger values and fire almost immediately, which would turn a long
 * backoff wait into a tight retry loop, so every timer-based delay is bounded by it.
 */
export const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

/** True only for standard AbortErrors or errors created from an observed abort signal. */
export function isAbortError(cause: unknown): cause is Error {
  return cause instanceof Error && (cause.name === "AbortError" || abortErrors.has(cause));
}

export function createAbortError(signal: AbortSignal, label: string): Error {
  const { reason } = signal;
  const error =
    reason instanceof Error
      ? reason
      : new Error(reason === undefined ? `${label} aborted` : `${label} aborted: ${reason}`);
  abortErrors.add(error);
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) {
    throw createAbortError(signal, label);
  }
}

/** Stop waiting on abort; the operation owner must use the signal to release its resources. */
export function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal, label));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Always observe settlement, including a late rejection after cancellation.
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

export function abortableSleep(
  durationMs: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<void> {
  if (durationMs <= 0) {
    return Promise.resolve();
  }

  const delayMs = Math.min(durationMs, MAX_TIMEOUT_DELAY_MS);

  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError(signal, label));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError(signal, label));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
