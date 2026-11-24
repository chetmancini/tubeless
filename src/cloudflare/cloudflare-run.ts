import { SqliteExecutionJournal } from "../hosting/execution-journal-sqlite.js";
import type { HostedCommand } from "../hosting/hosting-commands.js";
import {
  runHostedJob,
  type HostedChildPlacement,
  type HostedJobOwnership,
} from "../hosting/run.js";
import type { RunJob } from "../hosting/run-contract.js";
import type { PipelineTraceExporterOptions } from "../tracing/tracing.js";
import { boundCloudflareTraceExporter } from "./cloudflare-tracing.js";
import type { DurableStorageLike } from "./cloudflare-storage.js";
import type { CloudflareStudioIngest } from "./cloudflare-studio-ingest.js";
import {
  MAX_RUN_DURATION_MS,
  HOST_TERMINATED,
  type CloudflareRunTraceContext,
} from "./cloudflare-run-contract.js";

const boundedDuration = (job: RunJob) => Math.min(job.maxRunDurationMs, MAX_RUN_DURATION_MS);

export async function runCloudflareJob(
  options: HostedJobOwnership & {
    readonly job: RunJob;
    readonly commands: ReadonlyMap<string, HostedCommand>;
    readonly controller: AbortController;
    readonly tracing?: PipelineTraceExporterOptions<CloudflareRunTraceContext>;
    readonly deploymentId?: string;
    readonly placeChild?: HostedChildPlacement;
  }
): ReturnType<typeof runHostedJob> {
  const { job } = options;
  let mismatch: string | undefined;
  if (job.deploymentId !== undefined && job.deploymentId !== options.deploymentId)
    mismatch = "The launch deployment no longer matches the run host; user code was not executed.";
  else if (
    job.recoveryDefinitionId !== undefined &&
    options.commands.get(job.commandId)?.command.plan().definition?.identity.definitionId !==
      job.recoveryDefinitionId
  )
    mismatch = "The journaled pipeline definition no longer matches the admitted release.";
  if (mismatch) {
    await options.ingest().reportFailure(job.launchId, mismatch, "deployment_unavailable");
    return;
  }
  return runHostedJob({
    ...options,
    job: { ...job, maxRunDurationMs: boundedDuration(job) },
    output: {
      cwd: "/tmp",
      stdout: { write: (chunk) => console.log(chunk.trimEnd()) },
      stderr: { write: (chunk) => console.error(chunk.trimEnd()) },
    },
    wrapExporter: boundCloudflareTraceExporter,
  });
}

type CloudflareChildPlacement = (
  ...input: [...Parameters<HostedChildPlacement>, generation?: number]
) => ReturnType<HostedChildPlacement>;

interface RecoveryAttempt {
  readonly journal: SqliteExecutionJournal;
  readonly generation: number;
  readonly deadlineAtMs: number;
}

/** Alarm-driven execution state machine for one launch. Never rethrows from alarm(). */
export class RunObjectCore {
  #controller: AbortController | undefined;
  readonly #now: () => number;

  constructor(
    private readonly deps: {
      readonly storage: DurableStorageLike;
      readonly commands: ReadonlyMap<string, HostedCommand>;
      readonly ingest: () => CloudflareStudioIngest;
      readonly now?: () => number;
      readonly tracing?: PipelineTraceExporterOptions<CloudflareRunTraceContext>;
      readonly deploymentId?: string;
      readonly placeChild?: CloudflareChildPlacement;
    }
  ) {
    this.#now = deps.now ?? Date.now;
  }

  async start(job: RunJob): Promise<void> {
    const { storage } = this.deps;
    await storage.transaction(async () => {
      if ((await storage.get("state")) !== undefined || (await storage.get("job")) !== undefined)
        return;
      await Promise.all([
        storage.put("job", job),
        storage.put("state", "pending"),
        storage.setAlarm(this.#now()),
      ]);
    });
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
      // The persisted watchdog owns restart scheduling.
      console.error(error);
    }
  }

  async #runAlarm(): Promise<void> {
    const { storage } = this.deps;
    const job = await storage.get<RunJob>("job");
    if (!job) return;
    let recovery: RecoveryAttempt | undefined;
    if (job.recoveryDefinitionId !== undefined) {
      recovery = await this.#openRecoveryAttempt(job);
    } else if ((await storage.get("state")) === "running") {
      // Alarms never overlap, so a running state here means an earlier attempt died.
      await this.deps
        .ingest()
        .reportFailure(job.launchId, HOST_TERMINATED, "host_terminated")
        .catch((error: unknown) => {
          console.error(error);
        });
      await this.#finish();
      return;
    } else {
      await storage.transaction(async () => {
        await Promise.all([
          storage.put("state", "running"),
          // Post-mortem watchdog: fires only if this invocation is killed before clearing it.
          storage.setAlarm(this.#now() + boundedDuration(job) + 60_000),
        ]);
      });
    }
    const controller = new AbortController();
    this.#controller = controller;
    let confirmed = false;
    try {
      confirmed = (await this.#runAttempt(job, controller, recovery)) !== "unconfirmed";
    } finally {
      this.#controller = undefined;
      if (!recovery || confirmed) await this.#finish(recovery);
    }
  }

  #openRecoveryAttempt(job: RunJob): Promise<RecoveryAttempt> {
    const { storage } = this.deps;
    const journal = new SqliteExecutionJournal(storage);
    return storage.transaction(async () => {
      const attempt = journal.advance(this.#now() + boundedDuration(job));
      // The wake-up cannot overlap this alarm. It provides a short post-mortem delay.
      await storage.setAlarm(this.#now() + 2_000);
      return { journal, ...attempt };
    });
  }

  async #runAttempt(
    job: RunJob,
    controller: AbortController,
    attempt?: RecoveryAttempt
  ): ReturnType<typeof runCloudflareJob> {
    const { placeChild } = this.deps;
    const ingest = () => this.deps.ingest();
    let ownership: HostedJobOwnership = { ingest };
    if (attempt) {
      const { generation, deadlineAtMs, journal } = attempt;
      // An unavailable Studio leaves the job and its wake intact.
      const { admitted } = await ingest().admit(job.launchId, generation);
      if (!admitted) return;
      if (this.#now() >= deadlineAtMs) {
        await ingest().reportFailure(
          job.launchId,
          "The recovery deadline expired.",
          "host_terminated",
          generation
        );
        return;
      }
      ownership = {
        ingest: () => ({
          appendEvents: (id, sequence, events) =>
            ingest().appendEvents(id, sequence, events, generation),
          reportFailure: (id, message, reason) =>
            ingest().reportFailure(id, message, reason, generation),
        }),
        recovery: { journal: journal.open(job.launchId, generation), deadlineAtMs },
      };
    }
    try {
      return await runCloudflareJob({
        ...this.deps,
        ...ownership,
        job,
        controller,
        placeChild: placeChild && ((...args) => placeChild(...args, attempt?.generation)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reported = ownership.ingest().reportFailure(job.launchId, `Run host error: ${message}`);
      if (attempt) await reported;
      else await reported.catch(() => {});
    }
  }

  async #finish(owner?: RecoveryAttempt): Promise<void> {
    const { storage } = this.deps;
    await storage.transaction(async () => {
      if (owner && !owner.journal.owns(owner.generation)) return;
      owner?.journal.clear();
      // Keep a small receipt for duplicate dispatches and discard the job's input values.
      await Promise.all([
        storage.put("state", "finished"),
        storage.delete("job"),
        storage.deleteAlarm(),
      ]);
    });
  }
}
