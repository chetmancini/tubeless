import { createSteps, definePipeline, type StandardSchemaV1 } from "tubeless";
import { createWorkerThreadAdapter } from "tubeless/node";

const countSchema: StandardSchemaV1<unknown, number> = {
  "~standard": {
    vendor: "example",
    version: 1,
    validate: (value) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? { value }
        : { issues: [{ message: "Expected a non-negative integer count" }] },
  },
};

// Compile this file and prime-worker.ts to JavaScript before running with Node.
// Creation is lazy: importing or planning starts no threads. The caller owns close().
export const primeAdapter = createWorkerThreadAdapter<number>({
  module: new URL("./prime-worker.js", import.meta.url),
  exportName: "countPrimes",
  poolSize: 4,
});

const { fromRemote } = createSteps();
const counts = [100_000, 200_000, 300_000, 400_000].map((limit) =>
  fromRemote(`primes-${limit}`, {
    description: `Count primes through ${limit} on a worker thread`,
    adapter: primeAdapter,
    mapInput: () => limit,
    outputSchema: countSchema,
    // Pure computation is safe during dry runs; writes would need an explicit policy.
  })
);

export const WorkerPrimesPipeline = definePipeline({
  id: "worker-primes",
  steps: counts,
  finalize: (outputs) => Object.values(outputs),
});

// Repeated calls and direct pipeline runs share this adapter. The application must
// await primeAdapter.close() at shutdown, after every caller has settled.
export async function runWorkerThreadsExample() {
  // DAG concurrency admits four calls; the shared adapter bounds CPU execution to four threads.
  return WorkerPrimesPipeline.runOrThrow({}, { maxConcurrency: 4 });
}
