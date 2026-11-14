import type { HostedCommand } from "../hosting/hosting-commands.js";
import { runHostedJob } from "../hosting/run.js";
import type { RunJob, StudioIngest } from "../hosting/run-contract.js";
import type { PipelineTraceExporterOptions } from "../tracing/tracing.js";
import { boundCloudflareTraceExporter } from "./cloudflare-tracing.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";
import {
  MAX_RUN_DURATION_MS,
  HOST_TERMINATED,
  type CloudflareRunTraceContext,
} from "./cloudflare-run-contract.js";

const boundedDuration = (job: RunJob) => Math.min(job.maxRunDurationMs, MAX_RUN_DURATION_MS);

/** Apply Cloudflare's execution and application-tracing policy to the shared job runner. */
export function runCloudflareJob(options: {
  readonly job: RunJob;
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly ingest: () => StudioIngest;
  readonly controller: AbortController;
  readonly tracing?: PipelineTraceExporterOptions<CloudflareRunTraceContext>;
}): Promise<void> {
  return runHostedJob({
    ...options,
    job: { ...options.job, maxRunDurationMs: boundedDuration(options.job) },
    output: {
      cwd: "/tmp",
      stdout: { write: (chunk) => void console.log(chunk.trimEnd()) },
      stderr: { write: (chunk) => void console.error(chunk.trimEnd()) },
    },
    wrapExporter: boundCloudflareTraceExporter,
  });
}

/** Alarm-driven execution state machine for one launch. Never rethrows from alarm(). */
export class RunObjectCore {
  #controller: AbortController | undefined;
  readonly #now: () => number;

  constructor(
    private readonly deps: {
      readonly storage: DurableStorageLike;
      readonly commands: ReadonlyMap<string, HostedCommand>;
      readonly ingest: () => StudioIngest;
      readonly now?: () => number;
      readonly tracing?: PipelineTraceExporterOptions<CloudflareRunTraceContext>;
    }
  ) {
    this.#now = deps.now ?? Date.now;
  }

  async start(job: RunJob): Promise<void> {
    const { storage } = this.deps;
    if ((await storage.get("job")) !== undefined) return;
    await storage.put("job", job);
    await storage.put("state", "pending");
    await storage.setAlarm(this.#now());
  }

  cancel(): boolean {
    const controller = this.#controller;
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new DOMException("The run was cancelled.", "AbortError"));
    return true;
  }

  async alarm(): Promise<void> {
    try {
      await this.#runAlarm();
    } catch (error) {
      // Workers retries a throwing alarm up to 6 times; never re-run user code.
      console.error(error);
    }
  }

  async #runAlarm(): Promise<void> {
    const { storage } = this.deps;
    const job = await storage.get<RunJob>("job");
    if (!job) return;
    if ((await storage.get("state")) === "running") {
      // Alarms never overlap, so a running state here means an earlier attempt died.
      await this.deps
        .ingest()
        .reportFailure(job.launchId, HOST_TERMINATED)
        .catch((error: unknown) => {
          console.error(error);
        });
      await storage.deleteAlarm();
      await storage.deleteAll();
      return;
    }
    await storage.put("state", "running");
    // Post-mortem watchdog: fires only if this invocation is killed before clearing it.
    await storage.setAlarm(this.#now() + boundedDuration(job) + 60_000);
    const controller = new AbortController();
    this.#controller = controller;
    try {
      await runCloudflareJob({
        job,
        commands: this.deps.commands,
        ingest: this.deps.ingest,
        controller,
        tracing: this.deps.tracing,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps
        .ingest()
        .reportFailure(job.launchId, `Run host error: ${message}`)
        .catch(() => {});
    } finally {
      this.#controller = undefined;
      await storage.deleteAlarm();
      await storage.deleteAll();
    }
  }
}
