import {
  RUN_MODEL_VERSION,
  type PipelineRunStatus,
  type PipelineStepLifecycleStatus,
  type PipelineStepProgressDetail,
} from "./pipeline.js";
import { hasVisibleStepProgress } from "./progress.js";
import type {
  PipelineTraceAttributeValue,
  PipelineTraceError,
  PipelineTraceEvent,
  PipelineTraceExporter,
} from "./tracing.js";

/** One trace event after it has been appended to a durable local store. */
export interface StoredPipelineEvent extends PipelineTraceEvent {
  /** Store-local, monotonically increasing sequence. `0` is a valid first id. */
  id: number;
}

export interface PipelineRunEventQuery {
  /** Return events strictly after this store-local sequence. */
  afterId?: number;
  /** Restrict results to one pipeline definition. */
  pipelineId?: string;
  /** Restrict results to one run. */
  runId?: string;
  /** Maximum rows to return. Defaults to the store implementation's safe limit. */
  limit?: number;
}

/** Append-only persistence boundary used by the local studio. */
export interface PipelineRunEventStore extends PipelineTraceExporter {
  close(): void | Promise<void>;
  listEvents(query?: PipelineRunEventQuery): Promise<readonly StoredPipelineEvent[]>;
}

export type StoredPipelineRunStatus = PipelineRunStatus | "running";

export interface StoredNestedPipeline {
  mode: "for-each" | "single";
  pipelineId: string;
  stepCount: number;
  stepIds: string[];
}

export interface StoredRemote {
  engine: string;
  target?: string;
}

export interface StoredPipelineLog {
  attemptId?: string;
  id: number;
  level: "error" | "log" | "warn";
  message: string;
  stepId?: string;
  timestampMs: number;
}

export interface StoredPipelineAttempt {
  attemptId: string;
  durationMs?: number;
  finishedAtMs?: number;
  retries: number[];
  startedAtMs: number;
  status: Exclude<PipelineStepLifecycleStatus, "planned">;
}

export interface StoredPipelineStep {
  /** One execution attempt; `retries` carries `reportAttempt` telemetry. */
  attempt?: StoredPipelineAttempt;
  description?: string;
  durationMs?: number;
  finishedAtMs?: number;
  id: string;
  name?: string;
  nestedPipeline?: StoredNestedPipeline;
  remote?: StoredRemote;
  progress?: {
    completed: number;
    detailCount?: number;
    details?: PipelineStepProgressDetail[];
    message?: string;
    total?: number;
  };
  startedAtMs?: number;
  status: PipelineStepLifecycleStatus;
}

export interface StoredPipelineRun {
  dryRun: boolean;
  durationMs?: number;
  error?: PipelineTraceError;
  eventCount: number;
  finishedAtMs?: number;
  logCount: number;
  logs: StoredPipelineLog[];
  parentRunId?: string;
  pipelineId: string;
  runId: string;
  startedAtMs: number;
  status: StoredPipelineRunStatus;
  steps: StoredPipelineStep[];
  /** Run-record schema version. Projector output is always `RUN_MODEL_VERSION`. */
  version: typeof RUN_MODEL_VERSION;
}

export interface StoredPipelineDefinitionStep {
  dependencies: string[];
  description?: string;
  dryRun: string;
  id: string;
  name?: string;
  nestedPipeline?: StoredNestedPipeline;
  remote?: StoredRemote;
  optionalDependencies: string[];
  runtimeSkipPossible: boolean;
  skipAfterFailureOf: string[];
}

export interface StoredPipelineDefinition {
  activeRuns: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  pipelineId: string;
  runCount: number;
  steps: StoredPipelineDefinitionStep[];
  targetIds: string[];
}

export interface PipelineRunStoreSnapshot {
  activeRunCount: number;
  completedRunCount: number;
  definitions: StoredPipelineDefinition[];
  failedRunCount: number;
  generatedAtMs: number;
  lastEventId: number;
  runs: StoredPipelineRun[];
}

function isStringValue(value: PipelineTraceAttributeValue | undefined): value is string {
  return typeof value === "string";
}

function isNumberValue(value: PipelineTraceAttributeValue | undefined): value is number {
  return typeof value === "number";
}

function isBooleanValue(value: PipelineTraceAttributeValue | undefined): value is boolean {
  return typeof value === "boolean";
}

function stringAttribute(
  attributes: Readonly<Record<string, PipelineTraceAttributeValue | undefined>>,
  key: string
): string | undefined {
  const value = attributes[key];
  return isStringValue(value) ? value : undefined;
}

function numberAttribute(
  attributes: Readonly<Record<string, PipelineTraceAttributeValue | undefined>>,
  key: string
): number | undefined {
  const value = attributes[key];
  return isNumberValue(value) ? value : undefined;
}

function booleanAttribute(
  attributes: Readonly<Record<string, PipelineTraceAttributeValue | undefined>>,
  key: string
): boolean | undefined {
  const value = attributes[key];
  return isBooleanValue(value) ? value : undefined;
}

function stringArrayAttribute(
  attributes: Readonly<Record<string, PipelineTraceAttributeValue | undefined>>,
  key: string
): string[] {
  const value = stringAttribute(attributes, key);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseProgressDetails(
  attributes: Readonly<Record<string, PipelineTraceAttributeValue | undefined>>
): PipelineStepProgressDetail[] | undefined {
  const value = stringAttribute(attributes, "details");
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const details = parsed.flatMap((item): PipelineStepProgressDetail[] => {
      if (item === null || Array.isArray(item) || !(item instanceof Object)) return [];
      // SAFETY: JSON.parse leaves object fields untyped; isStringValue keeps strings only.
      const id = item.id as PipelineTraceAttributeValue | undefined;
      if (!("id" in item) || !isStringValue(id) || id.length === 0) return [];
      const detail: PipelineStepProgressDetail = { id: id.slice(0, 4_096) };
      // SAFETY: JSON.parse leaves object fields untyped; isStringValue keeps strings only.
      const label = ("label" in item ? item.label : undefined) as
        | PipelineTraceAttributeValue
        | undefined;
      if (isStringValue(label) && label) {
        detail.label = label.slice(0, 4_096);
      }
      // SAFETY: JSON.parse leaves object fields untyped; isStringValue keeps strings only.
      const status = ("status" in item ? item.status : undefined) as
        | PipelineTraceAttributeValue
        | undefined;
      if (
        isStringValue(status) &&
        (status === "completed" ||
          status === "failed" ||
          status === "pending" ||
          status === "running" ||
          status === "skipped")
      ) {
        detail.status = status;
      }
      return [detail];
    });
    return details.length > 0 ? details.slice(0, 128) : undefined;
  } catch {
    return undefined;
  }
}

function parseNestedPipeline(
  attributes: Readonly<Record<string, PipelineTraceAttributeValue | undefined>>
): NonNullable<StoredPipelineStep["nestedPipeline"]> | undefined {
  const value = stringAttribute(attributes, "nested_pipeline");
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || !(parsed instanceof Object)) return undefined;
    if (!("mode" in parsed) || !("pipelineId" in parsed) || !("stepIds" in parsed))
      return undefined;
    if (parsed.mode !== "for-each" && parsed.mode !== "single") return undefined;
    // SAFETY: JSON.parse leaves object fields untyped; isStringValue keeps strings only.
    const pipelineId = parsed.pipelineId as PipelineTraceAttributeValue | undefined;
    if (!isStringValue(pipelineId) || pipelineId.length === 0) return undefined;
    if (!Array.isArray(parsed.stepIds)) return undefined;
    const stepIds = parsed.stepIds
      .filter(isStringValue)
      .slice(0, 128)
      .map((item) => item.slice(0, 4_096));
    // SAFETY: JSON.parse leaves object fields untyped; isNumberValue keeps numbers only.
    const recorded = ("step_count" in parsed ? parsed.step_count : undefined) as
      | PipelineTraceAttributeValue
      | undefined;
    const recordedCount =
      isNumberValue(recorded) && Number.isFinite(recorded) ? Math.floor(recorded) : stepIds.length;
    return {
      mode: parsed.mode,
      pipelineId: pipelineId.slice(0, 4_096),
      stepCount: Math.max(stepIds.length, recordedCount),
      stepIds,
    };
  } catch {
    return undefined;
  }
}
function parseRemote(
  attributes: Readonly<Record<string, PipelineTraceAttributeValue | undefined>>
): StoredRemote | undefined {
  const value = stringAttribute(attributes, "remote");
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || Array.isArray(parsed) || !(parsed instanceof Object)) return undefined;
    if (!("engine" in parsed)) return undefined;
    // SAFETY: JSON.parse returned a plain object and we confirmed an engine key exists.
    const engine = parsed.engine as PipelineTraceAttributeValue | undefined;
    if (!isStringValue(engine) || engine.length === 0) return undefined;
    const remote: StoredRemote = { engine: engine.slice(0, 4_096) };
    if ("target" in parsed) {
      // SAFETY: target is optional metadata on the same parsed remote object.
      const target = parsed.target as PipelineTraceAttributeValue | undefined;
      if (isStringValue(target) && target.length > 0) remote.target = target.slice(0, 4_096);
    }
    return remote;
  } catch {
    return undefined;
  }
}

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

interface MutableRunProjection {
  completed: StoredPipelineEvent | undefined;
  eventCount: number;
  first: StoredPipelineEvent;
  logCount: number;
  logs: StoredPipelineLog[];
  retainLogs: boolean;
  started: StoredPipelineEvent;
  stepOrder: string[];
  steps: Map<string, StoredPipelineStep>;
}

interface MutablePipelineProjection {
  definitionRunId: string | undefined;
  definitionRunStartedEventId: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  latestSteps: Map<string, StoredPipelineDefinitionStep>;
  runStartedEventIds: Map<string, number>;
  runTargetIds: Map<string, string[]>;
  targetIds: string[];
}

function applyRunEvent(projection: MutableRunProjection, event: StoredPipelineEvent): void {
  projection.eventCount += 1;
  if (event.name === "pipeline.started" && projection.started.name !== "pipeline.started") {
    projection.started = event;
  }
  if (event.name === "pipeline.completed") projection.completed = event;
  if (event.name === "pipeline.log") {
    projection.logCount += 1;
    if (!projection.retainLogs) return;
    const level = stringAttribute(event.attributes, "level");
    const log: StoredPipelineLog = {
      id: event.id,
      level: level === "error" || level === "warn" ? level : "log",
      message: stringAttribute(event.attributes, "message") ?? "",
      timestampMs: event.timestampMs,
    };
    if (event.attemptId) log.attemptId = event.attemptId;
    if (event.stepId) log.stepId = event.stepId;
    projection.logs.push(log);
    return;
  }
  if (!event.stepId || !event.name.startsWith("step.")) return;

  let step = projection.steps.get(event.stepId);
  if (!step) {
    step = { id: event.stepId, status: "planned" };
    projection.steps.set(event.stepId, step);
    projection.stepOrder.push(event.stepId);
  }
  if (event.name === "step.planned") {
    step.name = stringAttribute(event.attributes, "name");
    step.description = stringAttribute(event.attributes, "description");
    const nestedPipeline = parseNestedPipeline(event.attributes);
    if (nestedPipeline) step.nestedPipeline = nestedPipeline;
    const remote = parseRemote(event.attributes);
    if (remote) step.remote = remote;
    return;
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
    if (event.name === "step.attempted") {
      const retry = numberAttribute(event.attributes, "attempt");
      if (retry !== undefined) attempt.retries.push(retry);
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
    const completedUnits = numberAttribute(event.attributes, "completed");
    if (completedUnits !== undefined) {
      const progress: StoredPipelineStep["progress"] = { completed: completedUnits };
      const message = stringAttribute(event.attributes, "message");
      if (message) progress.message = message;
      const total = numberAttribute(event.attributes, "total");
      if (total !== undefined) progress.total = total;
      const details = parseProgressDetails(event.attributes);
      if (details) progress.details = details;
      const detailCount = numberAttribute(event.attributes, "detail_count");
      if (detailCount !== undefined) progress.detailCount = detailCount;
      else if (details) progress.detailCount = details.length;
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

function createRunProjection(event: StoredPipelineEvent, retainLogs = true): MutableRunProjection {
  const projection: MutableRunProjection = {
    completed: undefined,
    eventCount: 0,
    first: event,
    logCount: 0,
    logs: [],
    retainLogs,
    started: event,
    stepOrder: [],
    steps: new Map(),
  };
  applyRunEvent(projection, event);
  return projection;
}

function cloneStep(step: StoredPipelineStep): StoredPipelineStep {
  const cloned: StoredPipelineStep = { ...step };
  if (step.attempt) cloned.attempt = { ...step.attempt, retries: [...step.attempt.retries] };
  if (step.progress) {
    cloned.progress = { ...step.progress };
    if (step.progress.details)
      cloned.progress.details = step.progress.details.map((detail) => ({ ...detail }));
  }
  if (step.nestedPipeline) {
    cloned.nestedPipeline = { ...step.nestedPipeline, stepIds: [...step.nestedPipeline.stepIds] };
  }
  if (step.remote) cloned.remote = { ...step.remote };
  return cloned;
}

function materializeRun(projection: MutableRunProjection): StoredPipelineRun {
  const { completed, eventCount, first, logs, started, stepOrder, steps } = projection;
  const statusValue = completed && stringAttribute(completed.attributes, "status");
  const status: StoredPipelineRunStatus =
    statusValue === "cancelled" || statusValue === "completed" || statusValue === "failed"
      ? statusValue
      : "running";

  const run: StoredPipelineRun = {
    dryRun: booleanAttribute(started.attributes, "dry_run") ?? false,
    eventCount,
    logCount: projection.logCount,
    logs: projection.retainLogs ? logs.map((log) => ({ ...log })) : [],
    pipelineId: first.pipelineId,
    runId: first.runId,
    startedAtMs: started.timestampMs,
    status,
    steps: stepOrder.map((stepId) => cloneStep(steps.get(stepId)!)),
    version: RUN_MODEL_VERSION,
  };
  if (completed?.durationMs !== undefined) run.durationMs = completed.durationMs;
  if (completed?.error) run.error = completed.error;
  if (completed) run.finishedAtMs = completed.timestampMs;
  if (first.parentRunId) run.parentRunId = first.parentRunId;
  return run;
}

/** Fold one run's append-only events into a UI-friendly current snapshot. */
export function projectPipelineRun(events: readonly StoredPipelineEvent[]): StoredPipelineRun {
  if (events.length === 0) throw new Error("Cannot project an empty pipeline run event list.");
  const ordered = [...events].sort((left, right) => left.id - right.id);
  const projection = createRunProjection(ordered[0]!);
  for (const event of ordered.slice(1)) applyRunEvent(projection, event);
  return materializeRun(projection);
}

function definitionStep(event: StoredPipelineEvent): StoredPipelineDefinitionStep {
  const step: StoredPipelineDefinitionStep = {
    dependencies: stringArrayAttribute(event.attributes, "dependencies"),
    dryRun: stringAttribute(event.attributes, "dry_run") ?? "run",
    id: event.stepId!,
    optionalDependencies: stringArrayAttribute(event.attributes, "optional_dependencies"),
    runtimeSkipPossible: booleanAttribute(event.attributes, "runtime_skip_possible") ?? false,
    skipAfterFailureOf: stringArrayAttribute(event.attributes, "skip_after_failure_of"),
  };
  const description = stringAttribute(event.attributes, "description");
  if (description) step.description = description;
  const name = stringAttribute(event.attributes, "name");
  if (name) step.name = name;
  const nestedPipeline = parseNestedPipeline(event.attributes);
  if (nestedPipeline) step.nestedPipeline = nestedPipeline;
  const remote = parseRemote(event.attributes);
  if (remote) step.remote = remote;
  return step;
}

function createPipelineProjection(event: StoredPipelineEvent): MutablePipelineProjection {
  const projection: MutablePipelineProjection = {
    definitionRunId: undefined,
    definitionRunStartedEventId: -1,
    firstSeenAtMs: event.timestampMs,
    lastSeenAtMs: event.timestampMs,
    latestSteps: new Map(),
    runStartedEventIds: new Map(),
    runTargetIds: new Map(),
    targetIds: [],
  };
  applyPipelineEvent(projection, event);
  return projection;
}

function applyPipelineEvent(
  projection: MutablePipelineProjection,
  event: StoredPipelineEvent
): void {
  projection.lastSeenAtMs = event.timestampMs;
  if (event.name === "pipeline.started") {
    projection.runStartedEventIds.set(event.runId, event.id);
    projection.runTargetIds.set(event.runId, stringArrayAttribute(event.attributes, "target_ids"));
  }
  if (event.name !== "step.planned" || !event.stepId) return;
  const runStartedEventId = projection.runStartedEventIds.get(event.runId);
  if (runStartedEventId === undefined) return;
  if (runStartedEventId > projection.definitionRunStartedEventId) {
    projection.definitionRunId = event.runId;
    projection.definitionRunStartedEventId = runStartedEventId;
    projection.latestSteps.clear();
    projection.targetIds = projection.runTargetIds.get(event.runId) ?? [];
  }
  if (event.runId === projection.definitionRunId) {
    projection.latestSteps.set(event.stepId, definitionStep(event));
  }
}

function cloneDefinitionStep(step: StoredPipelineDefinitionStep): StoredPipelineDefinitionStep {
  const cloned: StoredPipelineDefinitionStep = {
    ...step,
    dependencies: [...step.dependencies],
    optionalDependencies: [...step.optionalDependencies],
    skipAfterFailureOf: [...step.skipAfterFailureOf],
  };
  if (step.nestedPipeline) {
    cloned.nestedPipeline = { ...step.nestedPipeline, stepIds: [...step.nestedPipeline.stepIds] };
  }
  if (step.remote) cloned.remote = { ...step.remote };
  return cloned;
}

export interface PipelineRunProjector {
  append(events: readonly StoredPipelineEvent[]): void;
  clear(): void;
  snapshot(now?: number): PipelineRunStoreSnapshot;
}

/**
 * Incrementally fold accepted store events into the current run-history snapshot.
 * `{ retainLogs: false }` keeps `logCount` without retaining or cloning log bodies.
 */
export function createPipelineRunProjector(
  options: { readonly retainLogs?: boolean } = {}
): PipelineRunProjector {
  const retainLogs = options.retainLogs !== false;
  const pipelines = new Map<string, MutablePipelineProjection>();
  const runs = new Map<string, MutableRunProjection>();
  let cached: PipelineRunStoreSnapshot | undefined;
  let lastAcceptedId: number | undefined;

  function applyEvent(event: StoredPipelineEvent): void {
    const run = runs.get(event.runId);
    if (run) applyRunEvent(run, event);
    else runs.set(event.runId, createRunProjection(event, retainLogs));

    const pipeline = pipelines.get(event.pipelineId);
    if (pipeline) applyPipelineEvent(pipeline, event);
    else pipelines.set(event.pipelineId, createPipelineProjection(event));
  }

  function materialize(generatedAtMs: number): PipelineRunStoreSnapshot {
    const projectedRuns = [...runs.values()]
      .map(materializeRun)
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
    const runsByPipeline = new Map<string, StoredPipelineRun[]>();
    for (const run of projectedRuns) {
      const pipelineRuns = runsByPipeline.get(run.pipelineId) ?? [];
      pipelineRuns.push(run);
      runsByPipeline.set(run.pipelineId, pipelineRuns);
    }
    const definitions = [...runsByPipeline.entries()]
      .map(([pipelineId, pipelineRuns]): StoredPipelineDefinition => {
        const pipeline = pipelines.get(pipelineId)!;
        return {
          activeRuns: pipelineRuns.filter(({ status }) => status === "running").length,
          firstSeenAtMs: pipeline.firstSeenAtMs,
          lastSeenAtMs: pipeline.lastSeenAtMs,
          pipelineId,
          runCount: pipelineRuns.length,
          steps: [...pipeline.latestSteps.values()].map(cloneDefinitionStep),
          targetIds: [...pipeline.targetIds],
        };
      })
      .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs);

    return {
      activeRunCount: projectedRuns.filter(({ status }) => status === "running").length,
      completedRunCount: projectedRuns.filter(({ status }) => status === "completed").length,
      definitions,
      failedRunCount: projectedRuns.filter(({ status }) => status === "failed").length,
      generatedAtMs,
      lastEventId: lastAcceptedId ?? 0,
      runs: projectedRuns,
    };
  }

  return {
    append(events) {
      const incoming = [...events]
        .filter((event) => lastAcceptedId === undefined || event.id > lastAcceptedId)
        .sort((left, right) => left.id - right.id);
      if (incoming.length === 0) return;
      for (const event of incoming) {
        if (lastAcceptedId !== undefined && event.id <= lastAcceptedId) continue;
        applyEvent(event);
        lastAcceptedId = event.id;
        cached = undefined;
      }
    },
    clear() {
      cached = undefined;
      lastAcceptedId = undefined;
      pipelines.clear();
      runs.clear();
    },
    snapshot(now) {
      if (!cached) {
        cached = materialize(now ?? Date.now());
        return cached;
      }
      if (now === undefined || now === cached.generatedAtMs) return cached;
      cached = { ...cached, generatedAtMs: now };
      return cached;
    },
  };
}

/** Fold an event stream into run history and observed pipeline definitions. */
export function projectPipelineRunStore(
  events: readonly StoredPipelineEvent[],
  generatedAtMs = Date.now()
): PipelineRunStoreSnapshot {
  const projector = createPipelineRunProjector();
  projector.append(events);
  return projector.snapshot(generatedAtMs);
}
