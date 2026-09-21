import type { WorkerThreadContext } from "tubeless/node";

/** This synchronous CPU loop runs in a worker, not on the pipeline's event loop. */
export function countPrimes(limit: number, context: WorkerThreadContext): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Expected a non-negative integer");
  context.signal.throwIfAborted();
  context.log.log(`Counting primes through ${limit}`);
  let count = 0;
  for (let candidate = 2; candidate <= limit; candidate++) {
    let prime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
      if (candidate % divisor === 0) {
        prime = false;
        break;
      }
    }
    if (prime) count++;
    if (candidate % 10_000 === 0) context.reportProgress({ completed: candidate, total: limit });
  }
  context.reportProgress({ completed: limit, total: limit });
  return count;
}
