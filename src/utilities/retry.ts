import { abortableSleep, throwIfAborted as throwIfSignalAborted } from "./abort.js";

/** Default `RetryOptions.maxAttempts` when omitted. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default `RetryOptions.baseDelayMs` when omitted. */
export const DEFAULT_BASE_DELAY_MS = 100;

/** Backoff, cancellation, and retry policy settings for `withRetry`. */
export interface RetryOptions {
  /** Total attempts before giving up. Defaults to `DEFAULT_MAX_ATTEMPTS` (3). */
  maxAttempts?: number;
  /** Delay before the second attempt; doubles each attempt after. Defaults to `DEFAULT_BASE_DELAY_MS` (100). */
  baseDelayMs?: number;
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

/** Operation invoked once per retry attempt until it succeeds or the policy stops. */
export type RetryOperation<T> = (context: RetryAttemptContext) => Promise<T>;

function computeDelayMs(attempt: number, baseDelayMs: number, options: RetryOptions): number {
  const raw = baseDelayMs * 2 ** (attempt - 1);
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

/** Retry an asynchronous operation with exponential backoff and optional jitter. */
export async function withRetry<T>(
  operation: RetryOperation<T>,
  options: RetryOptions = {},
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error(`baseDelayMs must be a non-negative finite number, got ${baseDelayMs}`);
  }
  if (
    options.maxDelayMs !== undefined &&
    (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0)
  ) {
    throw new Error(`maxDelayMs must be a non-negative finite number, got ${options.maxDelayMs}`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await operation({
        attempt,
        maxAttempts,
        signal: options.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = computeDelayMs(attempt, baseDelayMs, options);
      onRetry?.(attempt, error, delayMs);
      await sleepBeforeRetry(delayMs, options);
    }
  }

  throw lastError;
}
