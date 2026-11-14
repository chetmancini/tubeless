import {
  executeHostedCommand,
  hostedCommandContext,
  type HostedCommand,
  type HostedOutput,
} from "./hosting-commands.js";
import type {
  PipelineTraceEvent,
  PipelineTraceExporter,
  PipelineTraceExporterOptions,
} from "../tracing/tracing.js";
import { createLaunchTracing, type LaunchTracing } from "./launch-tracing.js";
import { type RunJob, type HostedRunTraceContext, type StudioIngest } from "./run-contract.js";

/**
 * Durable Object SQLite rejects a string or row over 2 MB. These trace strings have no
 * schema limit, so bound each one here; one oversized event would otherwise fail its batch.
 */
export const HOSTED_TRACE_TEXT_LIMIT = 65_536;

function boundHostedText(text: string): string {
  if (text.length <= HOSTED_TRACE_TEXT_LIMIT) return text;
  return `${text.slice(0, HOSTED_TRACE_TEXT_LIMIT)}… [truncated ${text.length - HOSTED_TRACE_TEXT_LIMIT} characters]`;
}

/** Bound hosted history text without changing the original event or local history. */
export function boundHostedEvent(event: PipelineTraceEvent): PipelineTraceEvent {
  let bounded = event;
  switch (event.name) {
    case "pipeline.log": {
      const message = boundHostedText(event.payload.message);
      if (message !== event.payload.message) {
        bounded = { ...event, payload: { ...event.payload, message } };
      }
      break;
    }
    case "step.running": {
      const progress = event.payload.progress;
      if (progress?.message !== undefined) {
        const message = boundHostedText(progress.message);
        if (message !== progress.message) {
          bounded = { ...event, payload: { ...event.payload, progress: { ...progress, message } } };
        }
      }
      break;
    }
    case "step.skipped": {
      if (event.payload.message !== undefined) {
        const message = boundHostedText(event.payload.message);
        if (message !== event.payload.message) {
          bounded = { ...event, payload: { ...event.payload, message } };
        }
      }
      break;
    }
  }
  if ("error" in bounded && bounded.error) {
    const error = bounded.error;
    const message = boundHostedText(error.message);
    const stack = error.stack === undefined ? undefined : boundHostedText(error.stack);
    if (message !== error.message || stack !== error.stack) {
      return {
        ...bounded,
        error: { ...error, message, ...(stack === undefined ? {} : { stack }) },
      };
    }
  }
  return bounded;
}

export interface BatchingOptions {
  readonly maxEvents: number;
  readonly maxDelayMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  onFailure(error: unknown): void;
  readonly sleep?: (ms: number) => Promise<void>;
}

const isTopLevelStart = (event: PipelineTraceEvent) =>
  event.name === "pipeline.started" && event.parentRunId === undefined;

/** Deliver numbered batches in order; the collector applies each sequence at most once. */
export class BatchingTraceExporter implements PipelineTraceExporter {
  #pending: PipelineTraceEvent[] = [];
  #sequence = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #failed = false;

  constructor(
    private readonly send: (sequence: number, events: PipelineTraceEvent[]) => Promise<void>,
    private readonly options: BatchingOptions
  ) {}

  export(event: PipelineTraceEvent): void | Promise<void> {
    this.#pending.push(event);
    if (isTopLevelStart(event) || this.#pending.length >= this.options.maxEvents) {
      return this.flush();
    }
    this.#timer ??= setTimeout(() => void this.flush().catch(() => {}), this.options.maxDelayMs);
  }

  flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const events = this.#pending.splice(0);
    if (events.length > 0) {
      const sequence = this.#sequence++;
      this.#chain = this.#chain.then(() => this.#deliver(sequence, events));
    }
    return this.#chain;
  }

  async #deliver(sequence: number, events: PipelineTraceEvent[]): Promise<void> {
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.send(sequence, events);
        return;
      } catch (error) {
        if (attempt >= this.options.retries) {
          if (!this.#failed) {
            this.#failed = true;
            this.options.onFailure(error);
          }
          throw error;
        }
        await sleep(this.options.retryDelayMs * 2 ** attempt);
      }
    }
  }
}

function capturingOutput(output: HostedOutput): HostedOutput & { tail(): string } {
  const lines: string[] = [];
  const keep = (chunk: string) => {
    lines.push(chunk);
    if (lines.length > 20) lines.shift();
  };
  return {
    cwd: output.cwd,
    stdout: output.stdout,
    stderr: {
      write: (chunk) => {
        keep(chunk);
        return output.stderr.write(chunk);
      },
    },
    tail: () => lines.join("").trim().slice(-2_000),
  };
}

/** Ask Studio to admit the launch; any failure to confirm admission means do not execute. */
async function admitted(ingest: StudioIngest, launchId: string): Promise<boolean> {
  try {
    return (await ingest.admit(launchId)).admitted;
  } catch (error) {
    console.error(error);
    return false;
  }
}

/** Execute one admitted job; report failures that never produced a recorded run. */
export async function runHostedJob(options: {
  readonly job: RunJob;
  readonly commands: ReadonlyMap<string, HostedCommand>;
  readonly ingest: () => StudioIngest;
  readonly controller: AbortController;
  readonly output: HostedOutput;
  /** Target policy for optional application destinations; receives the actual execution deadline. */
  readonly wrapExporter?: (
    exporter: PipelineTraceExporter,
    deadlineAtMs: number
  ) => PipelineTraceExporter;
  readonly tracing?: PipelineTraceExporterOptions<HostedRunTraceContext>;
}): Promise<void> {
  const { job, ingest, controller, wrapExporter } = options;
  const entry = options.commands.get(job.commandId);
  if (!entry) {
    await ingest().reportFailure(job.launchId, "Pipeline command not found.");
    return;
  }
  const output = capturingOutput(options.output);
  const parsed = entry.command.parseValues(
    job.values,
    hostedCommandContext(output, controller.signal)
  );
  if (parsed.kind !== "values") {
    await ingest().reportFailure(
      job.launchId,
      parsed.kind === "error" ? parsed.errors.join("\n") : "Help is not a launchable value set."
    );
    return;
  }
  // Core does not await exporters, so a refused batch could arrive after a step's side effects.
  // Admission precedes command execution; a refused launch was already closed by Studio.
  if (!(await admitted(ingest(), job.launchId))) return;
  const deadlineAtMs = Date.now() + job.maxRunDurationMs;
  const traceContext = {
    pipelineId: job.commandId,
    cwd: output.cwd,
    signal: controller.signal,
    launchId: job.launchId,
  };
  let recorded = false;
  let deliveryFailure: { readonly error: unknown } | undefined;
  const batches = new BatchingTraceExporter(
    async (sequence, events) => {
      const { accepted } = await ingest().appendEvents(job.launchId, sequence, events);
      // Studio already failed this launch (for example, after an unconfirmed start), so
      // nothing more would be recorded and the run could not be cancelled.
      if (!accepted) controller.abort(new Error("Studio closed this launch; stopping the run."));
    },
    {
      maxEvents: 50,
      maxDelayMs: 250,
      retries: 4,
      retryDelayMs: 250,
      onFailure: (error) => {
        deliveryFailure = { error };
        controller.abort(error);
      },
    }
  );
  const exporter: PipelineTraceExporter = {
    export(event) {
      if (isTopLevelStart(event)) recorded = true;
      return batches.export(boundHostedEvent(event));
    },
    flush: () => batches.flush(),
  };
  const deadline = setTimeout(
    () =>
      controller.abort(new DOMException("The run exceeded its maximum duration.", "TimeoutError")),
    Math.max(0, deadlineAtMs - Date.now())
  );
  let exitCode: number;
  let launchTracing: LaunchTracing | undefined;
  try {
    launchTracing = createLaunchTracing({
      context: traceContext,
      configurations: [entry.tracing, options.tracing],
      exporters: [exporter],
      wrapExporter: wrapExporter && ((destination) => wrapExporter(destination, deadlineAtMs)),
    });
    exitCode = await executeHostedCommand(entry.command, parsed.values, output, controller.signal, {
      tracing: launchTracing.prepare(),
    });
  } finally {
    await launchTracing?.close();
    clearTimeout(deadline);
    // Drain pending events so no timer can deliver after the job's cleanup.
    await batches.flush().catch(() => {});
  }
  if (deliveryFailure) {
    // The run may be fully recorded locally yet unknown to Studio; tell it, best effort.
    const { error } = deliveryFailure;
    const message = error instanceof Error ? error.message : String(error);
    await ingest()
      .reportFailure(job.launchId, `Run events could not be delivered to Studio: ${message}`)
      .catch((reportError: unknown) => {
        console.error(reportError);
      });
  } else if (!recorded) {
    const detail = output.tail();
    await ingest().reportFailure(
      job.launchId,
      `Pipeline command exited (${exitCode}) before recording a run.${detail ? `\n${detail}` : ""}`
    );
  }
}
