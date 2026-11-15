import type { HostedCommand } from "../hosting/hosting-commands.js";
import type { PipelineRunEventReader } from "../run-store/run-store.js";
import {
  createCollectorHostedRun,
  type CollectorLaunchStore,
} from "../hosting/collector-coordinator.js";
import { createStudioHost, type StudioHostOptions } from "../hosting/hosting-studio.js";
import { collectorWorkerBudgets, startCollectorWorker } from "./collector-worker.js";
import { collectorBaseUrl } from "../hosting/collector-transport.js";
import type { HostedRunDiagnostic } from "../hosting/run-coordinator.js";

export interface CollectorWorkerCommand extends HostedCommand {
  readonly module: URL;
  readonly exportName?: string;
}

/** Internal Node host. The application routes/authenticates Studio and serves collector separately. */
export async function createCollectorWorkerHost(input: {
  readonly store: CollectorLaunchStore & Pick<PipelineRunEventReader, "listEvents">;
  readonly commands: ReadonlyMap<string, CollectorWorkerCommand>;
  readonly deploymentId: string;
  readonly collectorUrl: string;
  readonly clientScript: string;
  readonly authenticate: NonNullable<StudioHostOptions["authenticate"]>;
  readonly maxRunDurationMs: number;
  readonly startTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: HostedRunDiagnostic) => void | Promise<void>;
  readonly worker: Pick<
    Parameters<typeof startCollectorWorker>[0],
    "cwd" | "env" | "fetch" | "startupTimeoutMs" | "cancelGraceMs"
  >;
}) {
  const options = {
    store: input.store,
    commands: input.commands,
    deploymentId: input.deploymentId,
    collectorUrl: input.collectorUrl,
    clientScript: input.clientScript,
    authenticate: input.authenticate,
    maxRunDurationMs: input.maxRunDurationMs,
    startTimeoutMs: input.startTimeoutMs,
    onDiagnostic: input.onDiagnostic?.bind(input),
    worker: {
      cwd: input.worker.cwd,
      fetch: input.worker.fetch,
      startupTimeoutMs: input.worker.startupTimeoutMs,
      cancelGraceMs: input.worker.cancelGraceMs,
      env: input.worker.env && { ...input.worker.env },
    },
  };
  if (typeof options.authenticate !== "function")
    throw new Error("Studio requires explicit authentication.");
  const collectorUrl = collectorBaseUrl(options.collectorUrl);
  const budgets = collectorWorkerBudgets({
    ...options.worker,
    maxRunDurationMs: options.maxRunDurationMs,
  });
  const commands = new Map<string, CollectorWorkerCommand>();
  for (const [id, entry] of options.commands) {
    if (id !== entry.command.id || id !== entry.descriptor.id || entry.module.protocol !== "file:")
      throw new Error(
        "Worker catalog requires matching command identities and compiled file modules."
      );
    commands.set(id, { ...entry, module: new URL(entry.module.href) });
  }
  const active = new Set<ReturnType<typeof startCollectorWorker>>();
  const { launcher, collector } = createCollectorHostedRun({
    store: options.store,
    commands,
    deploymentId: options.deploymentId,
    output: { cwd: options.worker.cwd, stdout: { write() {} }, stderr: { write() {} } },
    maxRunDurationMs: options.maxRunDurationMs,
    startTimeoutMs: options.startTimeoutMs,
    onDiagnostic: options.onDiagnostic,
    credentialTtlMs:
      budgets.startupTimeoutMs + options.maxRunDurationMs + budgets.cancelGraceMs + 60_000,
    async start({ job, token }) {
      const entry = commands.get(job.commandId);
      if (!entry) throw new Error("Pipeline command not found.");
      const worker = startCollectorWorker({
        ...options.worker,
        ...budgets,
        job,
        token,
        baseUrl: collectorUrl,
        deploymentId: options.deploymentId,
        module: entry.module,
        exportName: entry.exportName,
      });
      active.add(worker);
      void worker.completed.then(
        () => active.delete(worker),
        () => active.delete(worker)
      );
    },
  });
  const studio = await createStudioHost({
    store: options.store,
    launcher,
    clientScript: options.clientScript,
    authenticate: options.authenticate,
  });
  const drain = async () => {
    await launcher.drain();
    while (active.size > 0) await Promise.all([...active].map((worker) => worker.completed));
  };
  return {
    studio,
    collector,
    drain,
    async close() {
      const pending = launcher.close();
      for (const worker of active) worker.cancel();
      await pending;
      await drain();
    },
  };
}
