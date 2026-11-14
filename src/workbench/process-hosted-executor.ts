import type { HostedCommand, HostedOutput } from "../hosting/hosting-commands.js";
import type { HostedExecutor } from "../hosting/run-coordinator.js";
import type { StudioIngest } from "../hosting/run-contract.js";
import { runHostedJob } from "../hosting/run.js";

/**
 * Reference executor for one Node process. The owner supplies the collector and
 * output, stops dispatch before close, and closes storage only after close drains.
 * Launch ids are retained for this executor's lifetime; restart never resumes jobs.
 * This is cooperative execution, not process isolation or a distributed lease.
 */
export function createProcessHostedExecutor(options: {
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly output: HostedOutput;
  ingest(): StudioIngest;
}): HostedExecutor & { drain(): Promise<void>; close(): Promise<void> } {
  const started = new Set<string>();
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let closed = false;
  const drain = async () => {
    while (active.size > 0) await Promise.all([...active.values()].map((run) => run.done));
  };
  return {
    async start(job) {
      if (closed) throw new Error("The process executor is closed.");
      if (started.has(job.launchId)) return;
      started.add(job.launchId);
      const controller = new AbortController();
      // Dispatch on the next microtask so cancellation and draining own the run
      // even when preparation fails synchronously. Never leave a rejected task unobserved.
      const done = Promise.resolve()
        .then(() => runHostedJob({ ...options, job, controller }))
        .catch(async (error: unknown) => {
          await options
            .ingest()
            .reportFailure(job.launchId, error instanceof Error ? error.message : String(error));
        })
        .catch((error: unknown) => console.error(error))
        .finally(() => active.delete(job.launchId));
      active.set(job.launchId, { controller, done });
    },
    async cancel(launchId) {
      const run = active.get(launchId);
      if (!run || run.controller.signal.aborted) return false;
      run.controller.abort(new DOMException("The run was cancelled.", "AbortError"));
      return true;
    },
    drain,
    async close() {
      closed = true;
      for (const run of active.values())
        run.controller.abort(new DOMException("The executor is stopping.", "AbortError"));
      await drain();
    },
  };
}
