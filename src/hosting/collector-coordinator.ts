import type { HostedAttemptStore } from "./attempt-store.js";
import { assertAttemptId } from "./attempt-store.js";
import type { HostedCollectorStore } from "./collector-store.js";
import type { HostedCommand, HostedOutput } from "./hosting-commands.js";
import type { HostedLaunchStore } from "./launch-store.js";
import type { CollectorRunJob } from "./collector-run.js";
import { provisionCollectorAttempt } from "./collector-credentials.js";
import { createHostedCollector } from "./collector-http.js";
import { HostedRunCoordinator } from "./run-coordinator.js";

export type CollectorLaunchStore = HostedCollectorStore &
  Pick<HostedAttemptStore, "liveAttemptRunIds" | "requestAttemptRunCancellation"> &
  Pick<HostedLaunchStore, "failUnadmitted">;

/** Private dispatch packet. Never serialize credentials into application values or browser replies. */
export interface CollectorDispatch {
  readonly job: CollectorRunJob;
  readonly token: string;
}

/** Compose owned launches and authenticated ingest; targets supply dispatch and lifecycle policy. */
export function createCollectorHostedRun(input: {
  readonly store: CollectorLaunchStore;
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly deploymentId: string;
  readonly output: HostedOutput;
  readonly maxRunDurationMs: number;
  readonly credentialTtlMs: number;
  readonly startTimeoutMs?: number;
  readonly now?: () => number;
  start(dispatch: CollectorDispatch): Promise<void>;
}) {
  const options = { ...input };
  const { store, deploymentId } = options;
  assertAttemptId(deploymentId);
  if (!Number.isSafeInteger(options.credentialTtlMs) || options.credentialTtlMs <= 0)
    throw new Error("Invalid collector credential lifetime.");
  const now = options.now ?? Date.now;
  const launcher = new HostedRunCoordinator<CollectorDispatch>({
    ...options,
    driver: {
      async prepare(input) {
        const job = { ...input, attemptId: crypto.randomUUID() };
        const createdAtMs = now();
        const token = await provisionCollectorAttempt(
          store,
          {
            launchId: job.launchId,
            attemptId: job.attemptId,
            commandId: job.commandId,
            pipelineId: job.commandId,
            deploymentId,
            createdAtMs,
          },
          createdAtMs + options.credentialTtlMs
        );
        return { job, token };
      },
      start: (dispatch) => options.start(dispatch),
      failUnadmitted: (launchId, message) => store.failUnadmitted(launchId, message, now()),
      cancel: (runId) => store.requestAttemptRunCancellation(runId, deploymentId),
      liveRunIds: () => store.liveAttemptRunIds(deploymentId),
    },
  });
  const collector = createHostedCollector({
    store: {
      getCollectorCredential: store.getCollectorCredential.bind(store),
      claimCollectorAttempt: store.claimCollectorAttempt.bind(store),
      collectorCancellationRequested: store.collectorCancellationRequested.bind(store),
      async acceptCollectorBatch(authority, workerId, body) {
        const ack = await store.acceptCollectorBatch(authority, workerId, body);
        if (ack.accepted)
          launcher.acknowledge(authority.launchId, { accepted: true, runId: ack.runId });
        return ack;
      },
      async reportCollectorFailure(authority, workerId, body) {
        const recorded = await store.reportCollectorFailure(authority, workerId, body);
        if (recorded)
          launcher.acknowledge(authority.launchId, {
            accepted: false,
            errors: [
              "The hosted worker stopped before its start could be confirmed. Check history before launching again.",
            ],
          });
        return recorded;
      },
    },
    now,
  });
  return { launcher, collector };
}
