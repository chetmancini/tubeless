import type { PipelineDefinitionSnapshot } from "../../core/pipeline.js";
import { copyStepPlan } from "../step-plan-projection.js";
import type {
  StoredPipelineDefinition,
  StoredPipelineDefinitionStep,
  StoredPipelineEvent,
  StoredPipelineRun,
} from "../run-store.js";

function definitionStep(
  event: Extract<StoredPipelineEvent, { name: "step.planned" }>
): StoredPipelineDefinitionStep {
  const { description, name, ...plan } = copyStepPlan(event.payload);
  return {
    ...plan,
    dryRun: event.payload.dryRun,
    id: event.stepId,
    runtimeSkipPossible: event.payload.runtimeSkipPossible,
    ...(description ? { description } : {}),
    ...(name ? { name } : {}),
  };
}

export class DefinitionProjection {
  #snapshot?: PipelineDefinitionSnapshot;
  #definitionRun: { id: string; startedAtMs: number; startedEventId: number } | undefined;
  #firstSeenAtMs: number;
  #lastSeenAtMs: number;
  readonly #latestSteps = new Map<string, StoredPipelineDefinitionStep>();
  readonly #runStarts = new Map<string, { atMs: number; eventId: number; targetIds: string[] }>();
  #targetIds: string[] = [];

  constructor(event: StoredPipelineEvent) {
    this.#firstSeenAtMs = event.timestampMs;
    this.#lastSeenAtMs = event.timestampMs;
    this.append(event);
  }

  append(event: StoredPipelineEvent): void {
    this.#firstSeenAtMs = Math.min(this.#firstSeenAtMs, event.timestampMs);
    this.#lastSeenAtMs = Math.max(this.#lastSeenAtMs, event.timestampMs);
    if (event.name === "pipeline.started") {
      if (event.payload.definitionSnapshot)
        this.#snapshot = structuredClone(event.payload.definitionSnapshot);
      this.#runStarts.set(event.runId, {
        atMs: event.timestampMs,
        eventId: event.id,
        targetIds: [...event.payload.targetIds],
      });
    }
    if (event.name !== "step.planned" || !event.stepId) return;
    const start = this.#runStarts.get(event.runId);
    if (!start) return;
    const current = this.#definitionRun;
    if (
      !current ||
      start.atMs > current.startedAtMs ||
      (start.atMs === current.startedAtMs && start.eventId > current.startedEventId)
    ) {
      this.#definitionRun = {
        id: event.runId,
        startedAtMs: start.atMs,
        startedEventId: start.eventId,
      };
      this.#latestSteps.clear();
      this.#targetIds = start.targetIds;
    }
    if (event.runId === this.#definitionRun?.id) {
      this.#latestSteps.set(event.stepId, definitionStep(event));
    }
  }

  snapshot(pipelineRuns: readonly StoredPipelineRun[]): StoredPipelineDefinition {
    const identity = pipelineRuns[0].definitionIdentity;
    const snapshot = this.#snapshot;
    return {
      activeRuns: pipelineRuns.filter(({ status }) => status === "running").length,
      firstSeenAtMs: this.#firstSeenAtMs,
      lastSeenAtMs: this.#lastSeenAtMs,
      pipelineId: pipelineRuns[0].pipelineId,
      ...(identity ? { identity: { ...identity } } : {}),
      ...(snapshot ? { snapshot: structuredClone(snapshot) } : {}),
      runCount: pipelineRuns.length,
      steps: [...this.#latestSteps.values()].map((step) => structuredClone(step)),
      targetIds: [...(snapshot?.targetIds ?? this.#targetIds)],
    };
  }
}
