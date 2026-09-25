import type {
  RUN_MODEL_VERSION,
  PipelineRunStatus,
  PipelineDefinitionIdentity,
  PipelineDefinitionSnapshot,
  PipelineStepLifecycleStatus,
  PipelineStepProgressDetail,
} from "../core/pipeline.js";
import type {
  PipelineTraceError,
  PipelineTraceEvent,
  PipelineTraceExporter,
} from "../tracing/tracing-contracts.js";
import { RunProjection } from "./run-projection.js";
import { DefinitionProjection } from "./definition-projection.js";
export { projectPipelineRun } from "./run-projection.js";

/** One trace event after it has been appended to a durable local store. */
export type StoredPipelineEvent = PipelineTraceEvent & {
  /** Store-local, monotonically increasing sequence. `0` is a valid first id. */
  id: number;
};

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

/** Read-only event source consumed by run history and the local studio. */
export interface PipelineRunEventReader {
  close(): void | Promise<void>;
  listEvents(query?: PipelineRunEventQuery): Promise<readonly StoredPipelineEvent[]>;
}

/**
 * Append-only persistence boundary used by the local studio.
 * SQLite `export()` may return before the row is durable; call `flush()` or
 * `close()` before another connection can observe the tail.
 */
export interface PipelineRunEventStore extends PipelineRunEventReader, PipelineTraceExporter {}

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
  outputSource?: "override";
  attemptId: string;
  durationMs?: number;
  finishedAtMs?: number;
  retries: number[];
  startedAtMs: number;
  status: Exclude<PipelineStepLifecycleStatus, "planned">;
}

export type StoredPipelineArtifact = Extract<
  PipelineTraceEvent,
  { name: "step.artifact" }
>["payload"] & {
  attemptId: string;
  timestampMs: number;
};

export interface StoredPipelineStep {
  artifacts?: StoredPipelineArtifact[];
  outputSource?: "override";
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
  definitionIdentity?: PipelineDefinitionIdentity;
  correlationId?: string;
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
  identity?: PipelineDefinitionIdentity;
  snapshot?: PipelineDefinitionSnapshot;
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

function definitionKey(pipelineId: string, definitionId: string | undefined): string {
  return JSON.stringify([pipelineId, definitionId ?? null]);
}

export interface PipelineRunProjector {
  append(events: readonly StoredPipelineEvent[]): void;
  clear(): void;
  snapshot(now?: number): PipelineRunStoreSnapshot;
}

/**
 * Incrementally fold accepted store events into the current run-history snapshot.
 * `{ retainLogs: false }` keeps `logCount` without retaining or cloning log bodies.
 * `{ retainArtifacts: false }` omits artifact metadata for workspace summaries.
 */
export function createPipelineRunProjector(
  options: { readonly retainLogs?: boolean; readonly retainArtifacts?: boolean } = {}
): PipelineRunProjector {
  const pipelines = new Map<string, DefinitionProjection>();
  const runs = new Map<string, RunProjection>();
  let cached: PipelineRunStoreSnapshot | undefined;
  let lastAcceptedId: number | undefined;

  function applyEvent(event: StoredPipelineEvent): void {
    const run = runs.get(event.runId);
    if (run) run.append(event);
    else runs.set(event.runId, new RunProjection(event, options));

    const key = definitionKey(event.pipelineId, runs.get(event.runId)!.definitionId);
    const pipeline = pipelines.get(key);
    if (pipeline) pipeline.append(event);
    else pipelines.set(key, new DefinitionProjection(event));
  }

  function materialize(generatedAtMs: number): PipelineRunStoreSnapshot {
    const projectedRuns = [...runs.values()]
      .map((run) => run.snapshot())
      .sort((left, right) => right.startedAtMs - left.startedAtMs);
    const runsByPipeline = new Map<string, StoredPipelineRun[]>();
    for (const run of projectedRuns) {
      const key = definitionKey(run.pipelineId, run.definitionIdentity?.definitionId);
      const pipelineRuns = runsByPipeline.get(key) ?? [];
      pipelineRuns.push(run);
      runsByPipeline.set(key, pipelineRuns);
    }
    const definitions = [...runsByPipeline.entries()]
      .map(([key, pipelineRuns]): StoredPipelineDefinition => {
        return pipelines.get(key)!.snapshot(pipelineRuns);
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
