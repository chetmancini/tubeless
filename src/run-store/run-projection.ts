import type { PipelineDefinitionIdentity } from "../core/pipeline-types.js";
import type { PipelineTraceError } from "../tracing/tracing-contracts.js";
import { RUN_MODEL_VERSION } from "../core/pipeline-ids.js";
import { hasVisibleStepProgress } from "../core/progress.js";
import type {
  StoredPipelineEvent,
  StoredPipelineRun,
  StoredPipelineRunStatus,
  StoredPipelineStep,
  StoredPipelineAttempt,
  StoredPipelineLog,
} from "./run-store.js";

function terminalStepStatus(event: StoredPipelineEvent): StoredPipelineStep["status"] | undefined {
  switch (event.name) {
    case "step.cancelled":
      return "cancelled";
    case "step.complete":
      // Shipped trace name; projected snapshot uses the live success token.
      return "completed";
    case "step.failed":
      return "failed";
    case "step.skipped":
      return "skipped";
    default:
      return undefined;
  }
}

function attemptStatus(status: StoredPipelineStep["status"]): StoredPipelineAttempt["status"] {
  return status === "planned" ? "running" : status;
}

/** Own the mutable state of one recorded run. */
export class RunProjection {
  #completed:
    | {
        status: StoredPipelineRunStatus;
        timestampMs: number;
        durationMs?: number;
        error?: PipelineTraceError;
      }
    | undefined;
  #eventCount = 0;
  readonly #identity: Pick<
    StoredPipelineEvent,
    "pipelineId" | "runId" | "correlationId" | "parentRunId"
  >;
  #logCount = 0;
  readonly #logs: StoredPipelineLog[] = [];
  #startedAtMs: number;
  #startObserved = false;
  #dryRun = false;
  #definitionIdentity: PipelineDefinitionIdentity | undefined;
  readonly #steps = new Map<string, StoredPipelineStep>();

  constructor(
    event: StoredPipelineEvent,
    private readonly options: {
      readonly retainLogs?: boolean;
      readonly retainArtifacts?: boolean;
    } = {}
  ) {
    this.#identity = {
      pipelineId: event.pipelineId,
      runId: event.runId,
      correlationId: event.correlationId,
      parentRunId: event.parentRunId,
    };
    this.#startedAtMs = event.timestampMs;
    this.append(event);
  }

  get definitionId(): string | undefined {
    return this.#definitionIdentity?.definitionId;
  }

  append(event: StoredPipelineEvent): void {
    this.#eventCount += 1;
    if (event.name === "pipeline.started" && !this.#startObserved) {
      this.#startObserved = true;
      this.#startedAtMs = event.timestampMs;
      this.#dryRun = event.payload.dryRun;
      this.#definitionIdentity = event.payload.definitionIdentity
        ? { ...event.payload.definitionIdentity }
        : undefined;
    }
    if (event.name === "pipeline.completed") {
      this.#completed = {
        status: event.payload.status,
        timestampMs: event.timestampMs,
        durationMs: event.durationMs,
        error: event.error ? structuredClone(event.error) : undefined,
      };
    }
    if (event.name === "pipeline.log") {
      this.#logCount += 1;
      if (this.options.retainLogs === false) return;
      const log: StoredPipelineLog = {
        id: event.id,
        level: event.payload.level,
        message: event.payload.message,
        timestampMs: event.timestampMs,
      };
      if (event.attemptId) log.attemptId = event.attemptId;
      if (event.stepId) log.stepId = event.stepId;
      this.#logs.push(log);
      return;
    }
    if (!event.stepId || !event.name.startsWith("step.")) return;

    let step = this.#steps.get(event.stepId);
    if (!step) {
      step = { id: event.stepId, status: "planned" };
      this.#steps.set(event.stepId, step);
    }
    if (event.name === "step.planned") {
      step.name = event.payload.name;
      step.description = event.payload.description;
      if (event.payload.nestedPipeline) {
        step.nestedPipeline = {
          ...event.payload.nestedPipeline,
          stepIds: [...event.payload.nestedPipeline.stepIds],
        };
      }
      if (event.payload.remote) step.remote = { ...event.payload.remote };
      return;
    }
    if (event.name === "step.artifact") {
      if (this.options.retainArtifacts === false) return;
      (step.artifacts ??= []).push({
        ...structuredClone(event.payload),
        attemptId: event.attemptId,
        timestampMs: event.timestampMs,
      });
      return;
    }
    if ("outputSource" in event.payload && event.payload.outputSource === "override") {
      step.outputSource = "override";
    }
    if (event.attemptId) {
      let attempt = step.attempt;
      if (!attempt) {
        attempt = {
          attemptId: event.attemptId,
          retries: [],
          startedAtMs: event.timestampMs,
          status: "running",
        };
        step.attempt = attempt;
      }
      if (step.outputSource) attempt.outputSource = step.outputSource;
      if (event.name === "step.attempted") {
        attempt.retries.push(event.payload.attempt);
      }
      const terminal = terminalStepStatus(event);
      if (terminal) {
        attempt.status = attemptStatus(terminal);
        attempt.finishedAtMs = event.timestampMs;
        attempt.durationMs = event.durationMs;
      }
    }
    if (event.name === "step.running") {
      step.status = "running";
      step.startedAtMs ??= event.timestampMs;
      if (event.payload.progress) {
        const progress: StoredPipelineStep["progress"] = {
          ...event.payload.progress,
          details: event.payload.progress.details?.map((detail) => ({ ...detail })),
        };
        if (!step.progress || hasVisibleStepProgress(progress)) step.progress = progress;
      }
      return;
    }
    const terminal = terminalStepStatus(event);
    if (terminal) {
      step.status = terminal;
      step.finishedAtMs = event.timestampMs;
      step.durationMs = event.durationMs;
      if (event.durationMs !== undefined) step.startedAtMs = event.timestampMs - event.durationMs;
    }
  }

  snapshot(): StoredPipelineRun {
    const completed = this.#completed;
    const run: StoredPipelineRun = {
      dryRun: this.#dryRun,
      eventCount: this.#eventCount,
      logCount: this.#logCount,
      logs: this.options.retainLogs === false ? [] : this.#logs.map((log) => ({ ...log })),
      pipelineId: this.#identity.pipelineId,
      runId: this.#identity.runId,
      startedAtMs: this.#startedAtMs,
      status: completed?.status ?? "running",
      steps: [...this.#steps.values()].map((step) => structuredClone(step)),
      version: RUN_MODEL_VERSION,
    };
    if (this.#definitionIdentity) run.definitionIdentity = { ...this.#definitionIdentity };
    if (this.#identity.correlationId !== undefined)
      run.correlationId = this.#identity.correlationId;
    if (completed?.durationMs !== undefined) run.durationMs = completed.durationMs;
    if (completed?.error) run.error = structuredClone(completed.error);
    if (completed) run.finishedAtMs = completed.timestampMs;
    if (this.#identity.parentRunId) run.parentRunId = this.#identity.parentRunId;
    return run;
  }
}

/** Fold one run's append-only events into a UI-friendly current snapshot. */
export function projectPipelineRun(events: readonly StoredPipelineEvent[]): StoredPipelineRun {
  if (events.length === 0) throw new Error("Cannot project an empty pipeline run event list.");
  const ordered = [...events].sort((left, right) => left.id - right.id);
  const projection = new RunProjection(ordered[0]!);
  for (const event of ordered.slice(1)) projection.append(event);
  return projection.snapshot();
}
