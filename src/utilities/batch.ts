import { throwIfAborted } from "./abort.js";

/** Scheduling and cancellation settings for bounded concurrent work. */
export interface RunConcurrentOptions {
  /** Maximum in-flight workers. Defaults to one for deterministic sequential work. */
  concurrency?: number;
  /** Stops scheduling new items once aborted; in-flight workers are allowed to settle. */
  signal?: AbortSignal;
}

/** Asynchronous worker invoked for one input item by the concurrency helpers. */
export type ConcurrentWorker<T, R> = (item: T, index: number, signal?: AbortSignal) => Promise<R>;

/** Split an input collection into fixed-size batches. */
function chunk<T>(items: readonly T[], size: number): T[][] {
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

/** Execution outcome returned by `runConcurrentPartial`, discriminated by `ok`. */
export type ConcurrentPartialResult<R> =
  | {
      ok: true;
      /** One successful output per input, in input order. R may include undefined. */
      results: readonly R[];
      completedIndexes: ReadonlySet<number>;
    }
  | {
      ok: false;
      /** Sparse: holes are items never started or failed. */
      results: ReadonlyArray<R | undefined>;
      /** Successful indexes, including workers that returned undefined. */
      completedIndexes: ReadonlySet<number>;
      /** First worker rejection or observed abort error; may itself be undefined. */
      failure: unknown;
    };

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

/**
 * Return complete or partial results, discriminated by `ok`.
 * Stops scheduling on the first observed failure or cancellation and drains
 * active workers, retaining their successful outputs without cancelling siblings.
 * Invalid concurrency still throws as an authoring error.
 */
export async function runConcurrentPartial<T, R>(
  items: readonly T[],
  options: RunConcurrentOptions,
  worker: ConcurrentWorker<T, R>
): Promise<ConcurrentPartialResult<R>> {
  return runConcurrentPartialWithLabel(items, options, worker, "Concurrent run");
}

async function runConcurrentWithLabel<T, R>(
  items: readonly T[],
  options: RunConcurrentOptions,
  worker: ConcurrentWorker<T, R>,
  label: string
): Promise<R[]> {
  const partial = await runConcurrentPartialWithLabel(items, options, worker, label);
  if (!partial.ok) {
    throw partial.failure;
  }
  // SAFETY: the internal helper owns a mutable array; ok guarantees every slot
  // was assigned by a successful worker. Preserve runConcurrent's mutable return.
  return partial.results as R[];
}

async function runConcurrentPartialWithLabel<T, R>(
  items: readonly T[],
  options: RunConcurrentOptions,
  worker: ConcurrentWorker<T, R>,
  label: string
): Promise<ConcurrentPartialResult<R>> {
  const concurrency = resolveConcurrency(options.concurrency);
  if (items.length === 0) {
    return { ok: true, completedIndexes: new Set(), results: [] };
  }

  const results = new Array<R | undefined>(items.length);
  const completedIndexes = new Set<number>();
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
        completedIndexes.add(index);
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
  if (failed) return { ok: false, completedIndexes, failure, results };
  // SAFETY: without failure or cancellation every input was successfully assigned.
  return { ok: true, completedIndexes, results: results as R[] };
}

/** Run fixed-size input batches with bounded concurrency and input-order results. */
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
