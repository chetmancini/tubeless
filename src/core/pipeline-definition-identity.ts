import { createHash } from "node:crypto";
import type { CompiledStepGraph } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import {
  STEP_NESTED_PIPELINE,
  STEP_OPTIONS_SCHEMA,
  STEP_REMOTE,
} from "./pipeline-step-metadata.js";
import type { PipelineDefinitionIdentity, PipelineDefinitionSnapshot } from "./pipeline-types.js";

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
      ? { requiredFinalizerStepIds: input.requiredFinalizerSteps.map(({ id }) => id).sort() }
      : {}),
    optionsValidated: input.orderedSteps[0]?.[STEP_OPTIONS_SCHEMA] !== undefined,
    resultValidated: input.resultValidated,
  };
  return freezeSnapshot({
    identity: createDefinitionIdentity(semantics, input.implementationVersion),
    ...semantics,
  });
}

/** Rebuild v1 hashes from explicit fields, independent of JSON object property order. */
export function createDefinitionIdentity(
  input: Omit<PipelineDefinitionSnapshot, "identity">,
  implementationVersion: string | undefined
): PipelineDefinitionIdentity {
  // Child handler versions participate in the combined identity, never the graph fingerprint.
  const structuralFingerprint = fingerprint({
    version: 1,
    steps: input.steps.map((step) => ({
      id: step.id,
      dependencies: [...step.dependencies].sort(),
      optionalDependencies: [...step.optionalDependencies].sort(),
      skipAfterFailureOf: [...step.skipAfterFailureOf].sort(),
      dryRun: step.dryRun,
      runtimeSkipPossible: step.runtimeSkipPossible,
      outputValidated: step.outputValidated,
      ...(step.nestedPipeline
        ? {
            nestedPipeline: {
              pipelineId: step.nestedPipeline.pipelineId,
              mode: step.nestedPipeline.mode,
              stepIds: [...step.nestedPipeline.stepIds],
              ...(step.nestedPipeline.identity
                ? {
                    identity: {
                      version: step.nestedPipeline.identity.version,
                      structuralFingerprint: step.nestedPipeline.identity.structuralFingerprint,
                    },
                  }
                : {}),
              ...(step.nestedPipeline.concurrency !== undefined
                ? { concurrency: step.nestedPipeline.concurrency }
                : {}),
            },
          }
        : {}),
      ...(step.remote
        ? {
            remote: {
              engine: step.remote.engine,
              ...(step.remote.target !== undefined ? { target: step.remote.target } : {}),
            },
          }
        : {}),
    })),
    targetIds: [...input.targetIds].sort(),
    ...(input.requiredFinalizerStepIds
      ? { requiredFinalizerStepIds: [...input.requiredFinalizerStepIds].sort() }
      : {}),
    optionsValidated: input.optionsValidated,
    resultValidated: input.resultValidated,
  });
  return {
    version: 1,
    structuralFingerprint,
    ...(implementationVersion !== undefined ? { implementationVersion } : {}),
    definitionId: fingerprint({
      version: 1,
      structuralFingerprint,
      implementationVersion,
      children: input.steps.map((step) => {
        const child = step.nestedPipeline?.identity;
        if (!child) return null;
        // Bind every recorded child identity field, not just its opaque definition ID.
        return {
          version: child.version,
          structuralFingerprint: child.structuralFingerprint,
          ...(child.implementationVersion !== undefined
            ? { implementationVersion: child.implementationVersion }
            : {}),
          definitionId: child.definitionId,
        };
      }),
    }),
  };
}
