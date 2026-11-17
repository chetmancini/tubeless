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
import type { RunJob, HostedRunTraceContext, StudioIngest } from "./run-contract.js";
import { BatchingTraceExporter } from "./trace-batching.js";
import { withRetry } from "../utilities/retry.js";

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
    default:
      break;
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

const isTopLevelStart = (event: PipelineTraceEvent) =>
  event.name === "pipeline.started" && event.parentRunId === undefined;

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
  const batches = new BatchingTraceExporter(
    async (sequence, events) => {
      const { accepted } = await withRetry(
        () => ingest().appendEvents(job.launchId, sequence, events),
        { maxAttempts: 5, baseDelayMs: 250 }
      );
      // Studio already failed this launch (for example, after an unconfirmed start), so
      // nothing more would be recorded and the run could not be cancelled.
      if (!accepted) controller.abort(new Error("Studio closed this launch; stopping the run."));
    },
    {
      maxEvents: 50,
      maxDelayMs: 250,
      onFailure: (error) => controller.abort(error),
    }
  );
  const { exitCode, history } = await executeHostedRun({
    job,
    entry,
    values: parsed.values,
    output,
    controller,
    exporter: batches,
    wrapExporter,
    tracing: options.tracing,
  });
  if (history.status === "unconfirmed") {
    // The run may be fully recorded locally yet unknown to Studio; tell it, best effort.
    const { error } = history;
    const message = error instanceof Error ? error.message : String(error);
    await ingest()
      .reportFailure(job.launchId, `Run events could not be delivered to Studio: ${message}`)
      .catch((reportError: unknown) => {
        console.error(reportError);
      });
  } else if (history.status === "absent") {
    const detail = output.tail();
    await ingest().reportFailure(
      job.launchId,
      `Pipeline command exited (${exitCode}) before recording a run.${detail ? `\n${detail}` : ""}`
    );
  }
}

/** Confirmed event extent after the delivery barrier, or explicit delivery uncertainty. */
export type HostedRunHistory =
  | { readonly status: "absent" | "partial" | "complete" }
  | { readonly status: "unconfirmed"; readonly error: unknown };

/** Execute an already-admitted command. Targets own admission, transport and failure evidence. */
export async function executeHostedRun(options: {
  readonly job: RunJob;
  readonly entry: HostedCommand;
  readonly values: Record<string, unknown>;
  readonly controller: AbortController;
  readonly output: HostedOutput;
  readonly exporter: PipelineTraceExporter & { flush(): Promise<void> };
  readonly wrapExporter?: (
    exporter: PipelineTraceExporter,
    deadlineAtMs: number
  ) => PipelineTraceExporter;
  readonly tracing?: PipelineTraceExporterOptions<HostedRunTraceContext>;
}): Promise<{ exitCode: number; history: HostedRunHistory }> {
  const { job, entry, controller, output, wrapExporter } = options;
  const deadlineAtMs = Date.now() + job.maxRunDurationMs;
  let rootRunId: string | undefined;
  let history: HostedRunHistory = { status: "absent" };
  const exporter: PipelineTraceExporter = {
    export(event) {
      if (isTopLevelStart(event) && rootRunId === undefined) {
        rootRunId = event.runId;
        history = { status: "partial" };
      } else if (
        event.name === "pipeline.completed" &&
        event.parentRunId === undefined &&
        event.runId === rootRunId
      ) {
        history = { status: "complete" };
      }
      return options.exporter.export(boundHostedEvent(event));
    },
    flush: () => options.exporter.flush(),
  };
  const deadline = setTimeout(
    () =>
      controller.abort(new DOMException("The run exceeded its maximum duration.", "TimeoutError")),
    Math.max(0, deadlineAtMs - Date.now())
  );
  let launchTracing: LaunchTracing | undefined;
  let exitCode: number;
  try {
    launchTracing = createLaunchTracing({
      context: {
        pipelineId: job.commandId,
        cwd: output.cwd,
        signal: controller.signal,
        launchId: job.launchId,
      },
      configurations: [entry.tracing, options.tracing],
      exporters: [exporter],
      wrapExporter: wrapExporter && ((destination) => wrapExporter(destination, deadlineAtMs)),
    });
    exitCode = await executeHostedCommand(
      entry.command,
      options.values,
      output,
      controller.signal,
      {
        tracing: launchTracing.prepare(),
      }
    );
  } finally {
    try {
      await launchTracing?.close();
    } finally {
      clearTimeout(deadline);
      try {
        await options.exporter.flush();
      } catch (error) {
        history = { status: "unconfirmed", error };
      }
    }
  }
  return { exitCode, history };
}
