import { createHash } from "node:crypto";
import type { CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import {
  STEP_NESTED_PIPELINE,
  STEP_OPTIONS_SCHEMA,
  STEP_REMOTE,
} from "./pipeline-step-metadata.js";
import type { PipelineDefinitionSnapshot } from "./pipeline-types.js";

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

/** Canonical v1 semantics. Execution order matters; dependency and target sets do not. */
export function compileDefinitionSnapshot(input: {
  orderedSteps: readonly AnyStep[];
  stepGraph: ReadonlyMap<AnyStep, CompiledStepGraph>;
  targetIds: readonly string[];
  requiredFinalizerSteps: readonly AnyStep[] | undefined;
  resultValidated: boolean;
  implementationVersion: string | undefined;
}): PipelineDefinitionSnapshot {
  const steps = input.orderedSteps.map((step) => {
    const graph = input.stepGraph.get(step)!;
    const nested = step[STEP_NESTED_PIPELINE];
    const remote = step[STEP_REMOTE];
    return {
      id: step.id,
      dependencies: graph.dependsOn.map(({ id }) => id).sort(),
      optionalDependencies: graph.optionalDependsOn.map(({ id }) => id).sort(),
      skipAfterFailureOf: graph.skipAfterFailureOf.map(({ id }) => id).sort(),
      dryRun:
        step.dryRun === "skip"
          ? ("skip" as const)
          : step.dryRun
            ? ("custom" as const)
            : ("run" as const),
      runtimeSkipPossible: step.skip !== undefined,
      outputValidated: step.outputSchema !== undefined,
      ...(nested
        ? {
            nestedPipeline: {
              pipelineId: nested.pipelineId,
              mode: nested.mode,
              stepIds: [...nested.stepIds],
              ...(nested.identity ? { identity: { ...nested.identity } } : {}),
              ...(nested.concurrency !== undefined ? { concurrency: nested.concurrency } : {}),
            },
          }
        : {}),
      ...(remote
        ? {
            remote: {
              engine: remote.engine,
              ...(remote.target !== undefined ? { target: remote.target } : {}),
            },
          }
        : {}),
    };
  });
  const semantics = {
    steps,
    targetIds: [...input.targetIds].sort(),
    ...(input.requiredFinalizerSteps
      ? { requiredFinalizerStepIds: input.requiredFinalizerSteps.map(({ id }) => id) }
      : {}),
    optionsValidated: input.orderedSteps[0]?.[STEP_OPTIONS_SCHEMA] !== undefined,
    resultValidated: input.resultValidated,
  };
  // Child handler versions participate in the combined identity, never the graph fingerprint.
  const structuralFingerprint = fingerprint({
    version: 1,
    ...semantics,
    steps: steps.map((step) => ({
      ...step,
      ...(step.nestedPipeline
        ? {
            nestedPipeline: {
              ...step.nestedPipeline,
              identity: step.nestedPipeline.identity
                ? {
                    version: step.nestedPipeline.identity.version,
                    structuralFingerprint: step.nestedPipeline.identity.structuralFingerprint,
                  }
                : undefined,
            },
          }
        : {}),
    })),
  });
  const identity = {
    version: 1 as const,
    structuralFingerprint,
    ...(input.implementationVersion !== undefined
      ? { implementationVersion: input.implementationVersion }
      : {}),
    definitionId: fingerprint({
      version: 1,
      structuralFingerprint,
      implementationVersion: input.implementationVersion,
      children: steps.map((step) => step.nestedPipeline?.identity?.definitionId ?? null),
    }),
  };
  return freezeSnapshot({ identity, ...semantics });
}
