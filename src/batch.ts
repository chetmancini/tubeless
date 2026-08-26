import { throwIfAborted } from "./abort.js";

export interface RunConcurrentOptions {
  /** Maximum in-flight workers. Defaults to one for deterministic sequential work. */
  concurrency?: number;
  /** Stops scheduling new items once aborted; in-flight workers are allowed to settle. */
  signal?: AbortSignal;
}

export type ConcurrentWorker<T, R> = (item: T, index: number, signal?: AbortSignal) => Promise<R>;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function resolveConcurrency(concurrency: number | undefined): number {
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency <= 0)) {
    throw new Error(`concurrency must be a positive finite integer, got ${concurrency}`);
  }
  return Math.max(1, concurrency ?? 1);
}

/**
 * Run individual items with bounded, lazy scheduling and input-order results.
 *
 * The first worker failure (or abort) stops future scheduling. Workers already
 * in flight are allowed to settle before that failure is rethrown, avoiding
 * orphaned work while keeping active work bounded by `concurrency`.
 */
export async function runConcurrent<T, R>(
  items: readonly T[],
  options: RunConcurrentOptions,
  worker: ConcurrentWorker<T, R>
): Promise<R[]> {
  return runConcurrentWithLabel(items, options, worker, "Concurrent run");
}

async function runConcurrentWithLabel<T, R>(
  items: readonly T[],
  options: RunConcurrentOptions,
  worker: ConcurrentWorker<T, R>,
  label: string
): Promise<R[]> {
  const concurrency = resolveConcurrency(options.concurrency);
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let failed = false;
  let failure: unknown;
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (!failed) {
      try {
        throwIfAborted(options.signal, label);
      } catch (error) {
        failed = true;
        failure = error;
        return;
      }

      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(items[index]!, index, options.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()));
  if (failed) {
    throw failure;
  }
  return results;
}

export async function runBatched<T, R>(
  items: readonly T[],
  options: { size: number; concurrency?: number; signal?: AbortSignal },
  worker: (batch: T[], batchIndex: number) => Promise<R>
): Promise<R[]> {
  const batches = chunk(items, options.size);
  return runConcurrentWithLabel(
    batches,
    options,
    (batch, index) => worker(batch, index),
    "Batch run"
  );
}
