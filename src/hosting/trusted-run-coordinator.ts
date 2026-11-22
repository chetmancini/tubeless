import type { HostedCommand, HostedOutput } from "./hosting-commands.js";
import type { HostedLaunchStore } from "./launch-store.js";
import type { RunJob, StudioIngest } from "./run-contract.js";
import { HostedRunCoordinator, type HostedExecutor } from "./run-coordinator.js";

/** Preserve trusted RPC admission/recovery without exposing it to owned workers. */
export function createTrustedHostedRun(
  input: {
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
  const { commands, output, executor, maxRunDurationMs, startTimeoutMs } = input;
  const scheduleReconcile = input.scheduleReconcile.bind(input);
  const now = input.now ?? Date.now;
  const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      console.error(error);
      throw error;
    }
  };
  const launcher = new HostedRunCoordinator<RunJob>({
    commands,
    output,
    maxRunDurationMs,
    startTimeoutMs,
    driver: {
      prepare: (job) =>
        observe(async () => {
          await store.create(job.launchId, job.commandId, now());
          await scheduleReconcile();
          return job;
        }),
      start: (job) => observe(() => executor.start(job)),
      failUnadmitted: (launchId, message) =>
        observe(() => store.failUnadmitted(launchId, message, now())),
      async cancel(runId) {
        const launchId = await store.launchIdForRun(runId);
        return launchId !== undefined && (await executor.cancel(launchId));
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
    async reportFailure(launchId, message, reason) {
      await store.fail(launchId, message, now(), reason);
      launcher.acknowledge(launchId, { accepted: false, errors: [message] });
    },
  };
  return { launcher, ingest };
}
