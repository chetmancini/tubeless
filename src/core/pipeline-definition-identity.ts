import { canonicalJsonValue } from "../utilities/canonical-json.js";
import type { PipelineMetadata } from "../tracing/graph-metadata.js";
import { createHash } from "node:crypto";
import type { CompiledStep } from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";
import { snapshotRunControls } from "./run-controls.js";
import {
  STEP_CACHE,
  STEP_NESTED_PIPELINE,
  STEP_OPTIONS_SCHEMA,
  STEP_REMOTE,
  STEP_AGENT,
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
  const normalizedControls = snapshotRunControls(nested.controls);
  if (normalizedControls.targets !== undefined)
    normalizedControls.targets = [...normalizedControls.targets].sort();
  if (normalizedControls.stepIds !== undefined)
    normalizedControls.stepIds = [...normalizedControls.stepIds].sort();
  return {
    maxIterations: nested.maxIterations,
    ...(Object.keys(normalizedControls).length > 0 ? { controls: normalizedControls } : {}),
  };
}

function structuralIdentityFields(identity: PipelineDefinitionIdentity) {
  return { version: identity.version, structuralFingerprint: identity.structuralFingerprint };
}

function fullIdentityFields(identity: PipelineDefinitionIdentity) {
  return {
    ...structuralIdentityFields(identity),
    ...(identity.implementationVersion !== undefined
      ? { implementationVersion: identity.implementationVersion }
      : {}),
    definitionId: identity.definitionId,
  };
}

type AgentMetadata = NonNullable<PipelineDefinitionSnapshot["steps"][number]["agent"]>;

function sortedCapabilities(agent: AgentMetadata) {
  return [...agent.capabilities].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function agentFields<TIdentity>(
  agent: AgentMetadata,
  projectIdentity: (identity: PipelineDefinitionIdentity) => TIdentity
) {
  return {
    limits: {
      maxTurns: agent.limits.maxTurns,
      maxCalls: agent.limits.maxCalls,
      maxDecisions: agent.limits.maxDecisions,
      ...(agent.limits.maxDepth !== undefined ? { maxDepth: agent.limits.maxDepth } : {}),
      maxConcurrency: agent.limits.maxConcurrency,
    },
    resultSchemaFingerprint: agent.resultSchemaFingerprint,
    capabilities: sortedCapabilities(agent).map((capability) => ({
      name: capability.name,
      description: capability.description,
      inputSchemaFingerprint: capability.inputSchemaFingerprint,
      identity: projectIdentity(capability.identity),
    })),
  };
}

/** Canonical snapshot. Execution order matters; dependency and target sets do not. */
export function compileDefinitionSnapshot(input: {
  metadata?: PipelineMetadata;
  orderedSteps: readonly CompiledStep[];
  targetIds: readonly string[];
  requiredFinalizerSteps: readonly AnyStep[] | undefined;
  resultValidated: boolean;
  implementationVersion: string | undefined;
}): PipelineDefinitionSnapshot {
  const steps = input.orderedSteps.map((step) => {
    const nested = step[STEP_NESTED_PIPELINE];
    const remote = step[STEP_REMOTE];
    const cache = step[STEP_CACHE];
    return {
      id: step.id,
      ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
      dependencies: step.dependsOn.map(({ id }) => id).sort(),
      optionalDependencies: step.optionalDependsOn.map(({ id }) => id).sort(),
      skipAfterFailureOf: step.skipAfterFailureOf.map(({ id }) => id).sort(),
      dryRun:
        step.dryRun === "skip"
          ? ("skip" as const)
          : step.dryRun
            ? ("custom" as const)
            : ("run" as const),
      runtimeSkipPossible: step.skip !== undefined,
      outputValidated: step.outputSchema !== undefined,
      ...(cache
        ? {
            cache: {
              version: cache.version,
              ...(cache.maxAge !== undefined ? { maxAgeMs: cache.maxAge } : {}),
              policy:
                typeof cache.policy === "function"
                  ? ("dynamic" as const)
                  : (cache.policy ?? ("use" as const)),
            },
          }
        : {}),
      ...(step[STEP_AGENT] ? { agent: agentFields(step[STEP_AGENT], fullIdentityFields) } : {}),
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
            step.agent !== undefined ||
            step.nestedPipeline?.mode === "iterate" ||
            step.nestedPipeline?.identity?.version === 2
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
      ...(step.cache
        ? {
            cache: {
              policy: step.cache.policy,
              ...(step.cache.maxAgeMs !== undefined ? { maxAgeMs: step.cache.maxAgeMs } : {}),
            },
          }
        : {}),
      ...(step.agent ? { agent: agentFields(step.agent, structuralIdentityFields) } : {}),
      ...(step.nestedPipeline
        ? {
            nestedPipeline: {
              pipelineId: step.nestedPipeline.pipelineId,
              mode: step.nestedPipeline.mode,
              ...iterationFields(step.nestedPipeline),
              stepIds: [...step.nestedPipeline.stepIds],
              ...(step.nestedPipeline.identity
                ? { identity: structuralIdentityFields(step.nestedPipeline.identity) }
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
      ...(input.steps.some((step) => step.cache)
        ? { cacheVersions: input.steps.map((step) => step.cache?.version ?? null) }
        : {}),
      children: input.steps.map((step) => {
        const child = step.nestedPipeline?.identity;
        if (step.agent)
          return {
            child: child ? fullIdentityFields(child) : undefined,
            capabilities: sortedCapabilities(step.agent).map(({ identity }) =>
              fullIdentityFields(identity)
            ),
          };
        return child ? fullIdentityFields(child) : null;
      }),
    }),
  };
}
