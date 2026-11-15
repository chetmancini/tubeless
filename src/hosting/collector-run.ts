import type { HostedCommand, HostedOutput } from "./hosting-commands.js";
import { hostedCommandContext } from "./hosting-commands.js";
import type { RunJob } from "./run-contract.js";
import { BatchingTraceExporter, executeHostedRun } from "./run.js";
import { createHostedCollectorClient } from "./collector-client.js";
import { COLLECTOR_BATCH_EVENTS } from "./collector-protocol.js";
import { MAX_TIMEOUT_DELAY_MS, throwIfAborted } from "../utilities/abort.js";

export interface CollectorRunJob extends RunJob {
  readonly attemptId: string;
}
export type CollectorRunResult =
  | { readonly status: "refused" | "unconfirmed" }
  | { readonly status: "finished"; readonly recorded: boolean; readonly delivered: boolean };

/** Claim once before loading user code. The supervisor owns failure reporting after worker exit. */
export async function runCollectorJob(options: {
  readonly job: CollectorRunJob;
  readonly baseUrl: string;
  readonly token: string;
  /** Trusted worker configuration, compared with the provisioned executable revision by the collector. */
  readonly deploymentId: string;
  readonly controller: AbortController;
  readonly output: HostedOutput;
  readonly fetch?: typeof fetch;
  loadCommands(): Promise<ReadonlyMap<string, HostedCommand>>;
  onClaim(workerId: string): Promise<void>;
}): Promise<CollectorRunResult> {
  const { controller, output, loadCommands, onClaim } = options;
  const job = structuredClone(options.job);
  if (
    !Number.isSafeInteger(job.maxRunDurationMs) ||
    job.maxRunDurationMs <= 0 ||
    job.maxRunDurationMs > MAX_TIMEOUT_DELAY_MS
  )
    throw new Error("Invalid hosted execution budget.");
  if (controller.signal.aborted) return { status: "refused" };
  const client = createHostedCollectorClient({
    baseUrl: options.baseUrl,
    launchId: job.launchId,
    attemptId: job.attemptId,
    deploymentId: options.deploymentId,
    token: options.token,
    fetch: options.fetch,
  });
  try {
    if (!(await client.claim())) return { status: "refused" };
  } catch {
    return { status: "unconfirmed" };
  }
  let delivered = true;
  const batches = new BatchingTraceExporter(
    async (_sequence, events) => {
      if (!(await client.append(events)).accepted) throw new Error("Collector closed the attempt.");
    },
    {
      maxEvents: COLLECTOR_BATCH_EVENTS,
      maxDelayMs: 250,
      retries: 0,
      retryDelayMs: 0,
      onFailure(error) {
        delivered = false;
        controller.abort(error);
      },
    }
  );
  try {
    await onClaim(client.workerId);
    throwIfAborted(controller.signal, "Worker execution");
    const entry = (await loadCommands()).get(job.commandId);
    throwIfAborted(controller.signal, "Worker execution");
    if (!entry) throw new Error("Pipeline command not found.");
    const parsed = entry.command.parseValues(
      job.values,
      hostedCommandContext(output, controller.signal)
    );
    if (parsed.kind !== "values") throw new Error("Invalid pipeline command values.");
    const { recorded } = await executeHostedRun({
      job,
      entry,
      values: parsed.values,
      output,
      controller,
      exporter: batches,
    });
    return { status: "finished", recorded, delivered };
  } catch {
    return { status: "finished", recorded: false, delivered: false };
  } finally {
    await batches.flush().catch(() => {});
  }
}
