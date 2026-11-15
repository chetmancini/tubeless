import type { HostedCommand, HostedOutput } from "./hosting-commands.js";
import type { HostedLaunchStore } from "./launch-store.js";
import type { RunJob, StudioIngest } from "./run-contract.js";
import { HostedRunCoordinator, type HostedExecutor } from "./run-coordinator.js";

/** Preserve trusted RPC admission/recovery without exposing it to owned workers. */
export function createTrustedHostedRun(
  options: {
    readonly commands: ReadonlyMap<string, HostedCommand>;
    readonly executor: HostedExecutor;
    readonly output: HostedOutput;
    readonly maxRunDurationMs: number;
    scheduleReconcile(): Promise<void>;
    readonly now?: () => number;
    readonly startTimeoutMs?: number;
  },
  store: HostedLaunchStore
) {
  const now = options.now ?? Date.now;
  const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      console.error(error);
      throw error;
    }
  };
  const launcher = new HostedRunCoordinator<RunJob>({
    ...options,
    driver: {
      prepare: (job) =>
        observe(async () => {
          await store.create(job.launchId, job.commandId, now());
          await options.scheduleReconcile();
          return job;
        }),
      start: (job) => observe(() => options.executor.start(job)),
      failUnadmitted: (launchId, message) =>
        observe(() => store.failUnadmitted(launchId, message, now())),
      async cancel(runId) {
        const launchId = await store.launchIdForRun(runId);
        return launchId !== undefined && (await options.executor.cancel(launchId));
      },
      liveRunIds: () => store.liveRunIds(),
    },
  });
  const ingest: StudioIngest = {
    async admit(launchId) {
      return { admitted: await store.admit(launchId) };
    },
    async appendEvents(launchId, sequence, events) {
      const ack = await store.acceptBatch(launchId, sequence, events);
      if (ack.accepted && ack.runId !== undefined)
        launcher.acknowledge(launchId, { accepted: true, runId: ack.runId });
      return { accepted: ack.accepted };
    },
    async reportFailure(launchId, message) {
      await store.fail(launchId, message, now());
      launcher.acknowledge(launchId, { accepted: false, errors: [message] });
    },
  };
  return { launcher, ingest };
}
