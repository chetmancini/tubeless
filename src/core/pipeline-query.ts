import type { PipelineMetadata } from "../tracing/graph-metadata.js";
import type { PipelinePlan, PipelinePlanStep } from "./pipeline-types.js";

/** Discovery filters combine with AND; tags require every exact, case-sensitive tag. */
export interface PipelineStepQuery {
  readonly tags?: readonly string[];
  readonly owner?: string;
  readonly domain?: string;
}

export function matchesStepQuery(
  metadata: PipelineMetadata | undefined,
  query: PipelineStepQuery
): boolean {
  return (
    (query.owner === undefined || metadata?.owner === query.owner) &&
    (query.domain === undefined || metadata?.domain === query.domain) &&
    (query.tags === undefined || query.tags.every((tag) => metadata?.tags?.includes(tag)))
  );
}

/** Return matching plan steps in execution order without changing selection or including prerequisites. */
export function querySteps(plan: PipelinePlan, query: PipelineStepQuery = {}): PipelinePlanStep[] {
  return plan.steps.filter((step) => matchesStepQuery(step.metadata, query));
}
