import { abortableSleep, throwIfAborted as throwIfSignalAborted } from "./abort.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
  random?: () => number;
  signal?: AbortSignal;
  sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Return false to stop retrying and rethrow the current error immediately.
   * The attempt number is the 1-based attempt that just failed. When omitted,
   * every error remains retryable until maxAttempts is reached.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/** Metadata supplied to each retry operation attempt. */
export interface RetryAttemptContext {
  /** 1-based attempt number. */
  attempt: number;
  /** Total allowed attempts from `RetryOptions.maxAttempts`. */
  maxAttempts: number;
  /** The same signal used for backoff and pre-attempt cancellation checks. */
  signal?: AbortSignal;
}

/** A no-argument async function remains assignable for simple retry callers. */
export type RetryOperation<T> = (context: RetryAttemptContext) => Promise<T>;

function computeDelayMs(attempt: number, options: RetryOptions): number {
  const raw = options.baseDelayMs * 2 ** (attempt - 1);
  const capped = options.maxDelayMs === undefined ? raw : Math.min(raw, options.maxDelayMs);
  if (!options.jitter) {
    return capped;
  }
  const jittered = capped + (options.random ?? Math.random)() * capped * 0.1;
  return options.maxDelayMs === undefined ? jittered : Math.min(jittered, options.maxDelayMs);
}

function throwIfAborted(signal?: AbortSignal): void {
  throwIfSignalAborted(signal, "Retry");
}

async function sleepBeforeRetry(durationMs: number, options: RetryOptions): Promise<void> {
  throwIfAborted(options.signal);
  if (options.sleep) {
    await options.sleep(durationMs, options.signal);
    throwIfAborted(options.signal);
    return;
  }
  await abortableSleep(durationMs, options.signal, "Retry");
}

export async function withRetry<T>(
  operation: RetryOperation<T>,
  options: RetryOptions,
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${options.maxAttempts}`);
  }
  if (!Number.isFinite(options.baseDelayMs) || options.baseDelayMs < 0) {
    throw new Error(`baseDelayMs must be a non-negative finite number, got ${options.baseDelayMs}`);
  }
  if (
    options.maxDelayMs !== undefined &&
    (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0)
  ) {
    throw new Error(`maxDelayMs must be a non-negative finite number, got ${options.maxDelayMs}`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await operation({
        attempt,
        maxAttempts: options.maxAttempts,
        signal: options.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= options.maxAttempts) {
        break;
      }
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = computeDelayMs(attempt, options);
      onRetry?.(attempt, error, delayMs);
      await sleepBeforeRetry(delayMs, options);
    }
  }

  throw lastError;
}
