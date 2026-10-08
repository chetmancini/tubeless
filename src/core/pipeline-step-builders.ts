import type { PipelineMetadata } from "../tracing/graph-metadata.js";
import type { ArtifactLoader, ArtifactSaver } from "./pipeline-artifacts.js";
import { createMappedChildRunner, createSingleChildRunner } from "./child-execution.js";
import { createIterationRunner } from "./iteration.js";
import { STEP_NESTED_PIPELINE, STEP_REMOTE } from "./pipeline-step-metadata.js";
import type {
  AnyStep,
  AnyStepDryRunHandler,
  ChildPipelineStepDefinitionBase,
  MappedChildPipelineStepDefinition,
  StepDefinitionBody,
  StepSkipPredicate,
} from "./pipeline-step-types.js";
import type {
  Pipeline,
  PipelinePlanStep,
  PipelineRun,
  PipelineStepContext,
  RemoteStepAdapter,
  StandardSchemaV1,
} from "./pipeline-types.js";

/**
 * Runtime construction for each step kind. `createSteps` owns the typed overloads;
 * these builders receive the erased definitions and the factory's `buildStep`.
 */
export type BuildStep<TOptions extends object> = (
  id: string,
  definition: StepDefinitionBody<TOptions>
) => AnyStep<TOptions>;

type AnyDeps<TOptions extends object> = readonly AnyStep<TOptions>[];
type AnySkip<TOptions extends object> = StepSkipPredicate<
  TOptions,
  AnyDeps<TOptions>,
  AnyDeps<TOptions>,
  unknown
>;

type ArtifactStepFields<TOptions extends object> = Omit<
  StepDefinitionBody<TOptions>,
  "run" | "dryRun" | "cache" | "outputSchema" | "skip"
> & {
  cache?: unknown;
  skip?: AnySkip<TOptions>;
};

/** Read an artifact as an ordinary step, publishing only its typed value. */
export function buildLoadArtifactStep<TOptions extends object>(
  buildStep: BuildStep<TOptions>,
  id: string,
  definition: ArtifactStepFields<TOptions> & {
    dryRun?: "skip" | ArtifactLoader<Record<string, unknown>, unknown, TOptions>;
    load: ArtifactLoader<Record<string, unknown>, unknown, TOptions>;
  }
): AnyStep<TOptions> {
  const { cache, load, dryRun, ...fields } = definition;
  if (cache !== undefined) throw new Error("Artifact helpers cannot configure caching");
  const wrap =
    (handler: typeof load) =>
    async (inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>) => {
      const loaded = await handler(inputs, context);
      context.recordArtifact({ operation: "read", artifact: loaded.artifact });
      return loaded.value;
    };
  return buildStep(id, {
    ...fields,
    run: wrap(load),
    dryRun: typeof dryRun === "function" ? wrap(dryRun) : dryRun,
  });
}

/** Write an artifact as an ordinary step. Dry runs skip unless a preview is supplied. */
export function buildSaveArtifactStep<TOptions extends object>(
  buildStep: BuildStep<TOptions>,
  id: string,
  definition: ArtifactStepFields<TOptions> & {
    dryRun?: "skip" | ArtifactSaver<Record<string, unknown>, unknown, TOptions>;
    save: ArtifactSaver<Record<string, unknown>, unknown, TOptions>;
  }
): AnyStep<TOptions> {
  const { cache, save, dryRun, ...fields } = definition;
  if (cache !== undefined) throw new Error("Artifact helpers cannot configure caching");
  const wrap =
    (handler: typeof save) =>
    async (inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>) => {
      const saved = await handler(inputs, context);
      context.recordArtifact({ operation: "write", artifact: saved.artifact });
      return saved.value;
    };
  return buildStep(id, {
    ...fields,
    run: wrap(save),
    dryRun: typeof dryRun === "function" ? wrap(dryRun) : "skip",
  });
}

/** Erased `fromPipeline` definition. */
export type SingleChildStepConfig<TOptions extends object> = ChildPipelineStepDefinitionBase<
  TOptions,
  AnyDeps<TOptions>,
  AnyDeps<TOptions>,
  Pipeline<object, unknown>
> & {
  skip?: AnySkip<TOptions>;
  mapResult?: (
    value: unknown,
    result: PipelineRun<unknown>,
    context: PipelineStepContext<TOptions>
  ) => unknown;
};

export function buildPipelineStep<TOptions extends object>(
  buildStep: BuildStep<TOptions>,
  id: string,
  config: SingleChildStepConfig<TOptions>
): AnyStep<TOptions> {
  const definition: StepDefinitionBody<TOptions> = {
    [STEP_NESTED_PIPELINE]: {
      mode: "single" as const,
      pipelineId: config.pipeline.id,
      identity: config.pipeline.definition?.identity,
      stepIds: config.pipeline.stepIds,
    },
    dependsOn: config.dependsOn,
    optionalDependsOn: config.optionalDependsOn,
    skipAfterFailureOf: config.skipAfterFailureOf,
    name: config.name,
    description: config.description,
    metadata: config.metadata,
    dryRun: config.dryRun,
    run: createSingleChildRunner({ ...config, stepId: id }),
  };

  const skip = config.skip;
  if (skip !== undefined) {
    definition.skip = skip;
  }
  return buildStep(id, definition);
}

/** Erased `fromRemote` definition. */
export interface RemoteStepConfig<TOptions extends object> {
  adapter: RemoteStepAdapter<object, unknown, unknown>;
  mapInput(inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>): unknown;
  outputSchema: StandardSchemaV1;
  dependsOn?: AnyDeps<TOptions>;
  optionalDependsOn?: AnyDeps<TOptions>;
  skipAfterFailureOf?: AnyDeps<TOptions>;
  name?: string;
  description?: string;
  metadata?: PipelineMetadata;
  dryRun?: "skip" | AnyStepDryRunHandler<TOptions>;
  skip?: AnySkip<TOptions>;
}

export function buildRemoteStep<TOptions extends object>(
  buildStep: BuildStep<TOptions>,
  id: string,
  config: RemoteStepConfig<TOptions>
): AnyStep<TOptions> {
  const remote: NonNullable<PipelinePlanStep["remote"]> = { engine: config.adapter.engine };
  if (config.adapter.target !== undefined) remote.target = config.adapter.target;
  const definition: StepDefinitionBody<TOptions> = {
    [STEP_REMOTE]: remote,
    dependsOn: config.dependsOn,
    optionalDependsOn: config.optionalDependsOn,
    skipAfterFailureOf: config.skipAfterFailureOf,
    name: config.name,
    description: config.description,
    metadata: config.metadata,
    dryRun: config.dryRun,
    outputSchema: config.outputSchema,
    run: (inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>) =>
      config.adapter.invoke(config.mapInput(inputs, context), context),
  };
  const skip = config.skip;
  if (skip !== undefined) {
    definition.skip = skip;
  }
  return buildStep(id, definition);
}

/** Erased `forEachPipeline` definition. */
export type MappedChildStepConfig<TOptions extends object> = MappedChildPipelineStepDefinition<
  TOptions,
  AnyDeps<TOptions>,
  AnyDeps<TOptions>,
  Pipeline<object, unknown>,
  unknown
> & {
  mapResult?: (
    value: unknown,
    result: PipelineRun<unknown>,
    item: unknown,
    index: number,
    context: PipelineStepContext<TOptions>
  ) => unknown;
  skip?: AnySkip<TOptions>;
};

export function buildMappedPipelineStep<TOptions extends object>(
  buildStep: BuildStep<TOptions>,
  id: string,
  config: MappedChildStepConfig<TOptions>
): AnyStep<TOptions> {
  const configuredConcurrency = config.concurrency;
  if (
    typeof configuredConcurrency === "number" &&
    (!Number.isInteger(configuredConcurrency) || configuredConcurrency < 1)
  ) {
    throw new RangeError(
      `forEachPipeline concurrency must be a positive finite integer, got ${configuredConcurrency}`
    );
  }
  const definition: StepDefinitionBody<TOptions> = {
    [STEP_NESTED_PIPELINE]: {
      mode: "for-each" as const,
      concurrency:
        typeof configuredConcurrency === "function" ? "dynamic" : (configuredConcurrency ?? 1),
      pipelineId: config.pipeline.id,
      identity: config.pipeline.definition?.identity,
      stepIds: config.pipeline.stepIds,
    },
    dependsOn: config.dependsOn,
    optionalDependsOn: config.optionalDependsOn,
    skipAfterFailureOf: config.skipAfterFailureOf,
    name: config.name,
    description: config.description,
    metadata: config.metadata,
    dryRun: config.dryRun,
    run: createMappedChildRunner({ ...config, stepId: id }),
  };

  const skip = config.skip;
  if (skip !== undefined) {
    definition.skip = skip;
  }
  return buildStep(id, definition);
}

/** Erased `iteratePipeline` definition. */
export type IterationStepConfig<TOptions extends object> = Omit<
  Parameters<typeof createIterationRunner<TOptions>>[0],
  "stepId"
> & {
  name?: string;
  description?: string;
  metadata?: PipelineMetadata;
  dependsOn?: AnyDeps<TOptions>;
  dryRun?: "skip";
};

export function buildIterationStep<TOptions extends object>(
  buildStep: BuildStep<TOptions>,
  id: string,
  definition: IterationStepConfig<TOptions>
): AnyStep<TOptions> {
  if (!Number.isSafeInteger(definition.maxIterations) || definition.maxIterations < 1) {
    throw new RangeError("iteratePipeline maxIterations must be a positive safe integer");
  }
  const controls = definition.controls ? structuredClone(definition.controls) : undefined;
  if (controls) {
    if (controls.targets) Object.freeze(controls.targets);
    if (controls.stepIds) Object.freeze(controls.stepIds);
    Object.freeze(controls);
  }
  const config = { ...definition, stepId: id, controls };
  return buildStep(id, {
    [STEP_NESTED_PIPELINE]: {
      mode: "iterate",
      maxIterations: config.maxIterations,
      controls: config.controls,
      pipelineId: config.pipeline.id,
      identity: config.pipeline.definition?.identity,
      stepIds: config.pipeline.stepIds,
    },
    name: config.name,
    description: config.description,
    metadata: config.metadata,
    dependsOn: config.dependsOn,
    dryRun: config.dryRun,
    run: createIterationRunner(config),
  });
}
