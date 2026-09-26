import { canonicalJsonValue } from "../utilities/canonical-json.js";
import type { PipelineMetadata } from "../tracing/graph-metadata.js";
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

function iterationFields(
  nested: NonNullable<PipelineDefinitionSnapshot["steps"][number]["nestedPipeline"]>
) {
  if (nested.mode !== "iterate") return {};
  const controls = nested.controls;
  const normalizedControls = {
    ...(controls?.dryRun !== undefined ? { dryRun: controls.dryRun } : {}),
    ...(controls?.continueOnError !== undefined
      ? { continueOnError: controls.continueOnError }
      : {}),
    ...(controls?.maxConcurrency !== undefined ? { maxConcurrency: controls.maxConcurrency } : {}),
    ...(controls?.targets !== undefined ? { targets: [...controls.targets].sort() } : {}),
    ...(controls?.stepIds !== undefined ? { stepIds: [...controls.stepIds].sort() } : {}),
  };
  return {
    maxIterations: nested.maxIterations,
    ...(Object.keys(normalizedControls).length > 0 ? { controls: normalizedControls } : {}),
  };
}

/** Canonical snapshot. Execution order matters; dependency and target sets do not. */
export function compileDefinitionSnapshot(input: {
  metadata?: PipelineMetadata;
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
      ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
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
              ...iterationFields(nested),
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
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
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

/** Preserve v1/v2 hashes; metadata and its ancestors use v3. */
export function createDefinitionIdentity(
  input: Omit<PipelineDefinitionSnapshot, "identity">,
  implementationVersion: string | undefined
): PipelineDefinitionIdentity {
  const hasMetadata =
    input.metadata !== undefined ||
    input.steps.some(
      (step) => step.metadata !== undefined || step.nestedPipeline?.identity?.version === 3
    );
  const version = hasMetadata
    ? 3
    : input.steps.some(
          (step) =>
            step.nestedPipeline?.mode === "iterate" || step.nestedPipeline?.identity?.version === 2
        )
      ? 2
      : 1;
  // Child handler versions participate in the combined identity, never the graph fingerprint.
  const structuralFingerprint = fingerprint({
    version,
    ...(input.metadata === undefined ? {} : { metadata: canonicalJsonValue(input.metadata) }),
    steps: input.steps.map((step) => ({
      id: step.id,
      ...(step.metadata === undefined ? {} : { metadata: canonicalJsonValue(step.metadata) }),
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
              ...iterationFields(step.nestedPipeline),
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
    version,
    structuralFingerprint,
    ...(implementationVersion !== undefined ? { implementationVersion } : {}),
    definitionId: fingerprint({
      version,
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
