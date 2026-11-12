// Type-checked only: never executed.
import { runBatched, runConcurrentPartial, type ConcurrentPartialResult } from "tubeless/batch";
import { RateLimiter } from "tubeless/rate-limit";
import { withRetry, type RetryOptions } from "tubeless/retry";
import { composeTraceExporters, type PipelineTraceExporter } from "tubeless/tracing";

const limiter = new RateLimiter(100);
const retryOptions: RetryOptions = { baseDelayMs: 250, maxAttempts: 3, jitter: true };
const retried: Promise<number> = withRetry(async () => 1, retryOptions);

const batchSizes: Promise<number[]> = runBatched(
  ["alpha", "beta"],
  { size: 1, concurrency: 2 },
  async (batch) => batch.reduce((total, item) => total + item.length, 0)
);
const partial: Promise<ConcurrentPartialResult<number>> = runConcurrentPartial(
  [1, 2],
  { concurrency: 2 },
  async (item) => item * 2
);

const exporter: PipelineTraceExporter = { export: () => {} };
const composed: PipelineTraceExporter = composeTraceExporters([exporter]);
const waited: Promise<void> = limiter.wait();
