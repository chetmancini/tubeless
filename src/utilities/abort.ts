/**
 * Shared `AbortSignal` handling for every module that accepts one (pipeline execution,
 * retry/backoff, rate limiting, batching). Centralized so they all produce the same
 * abort-error shape and the same cancellable-sleep behavior, differing only in the
 * `label` used in error messages (e.g. "Retry", "Pipeline run").
 */

const abortErrors = new WeakSet<Error>();

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

export function abortableSleep(
  durationMs: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<void> {
  if (durationMs <= 0) {
    return Promise.resolve();
  }

  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError(signal, label));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(createAbortError(signal, label));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
