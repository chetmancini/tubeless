import {
  buildIterationStep,
  buildLoadArtifactStep,
  buildMappedPipelineStep,
  buildPipelineStep,
  buildRemoteStep,
  buildSaveArtifactStep,
  type IterationStepConfig,
  type MappedChildStepConfig,
  type RemoteStepConfig,
  type SingleChildStepConfig,
} from "./pipeline-step-builders.js";
import type { ArtifactLoader, ArtifactSaver, ArtifactResult } from "./pipeline-artifacts.js";
import type { IterationDecision, IterationState } from "./iteration.js";
import { STEP_OPTIONS_SCHEMA } from "./pipeline-step-metadata.js";
import type { PipelineMetadata } from "../tracing/graph-metadata.js";
import type {
  AnyStep,
  ChildPipelineStepDefinition,
  ChildPipelineStepDefinitionBase,
  MappedChildPipelineStepDefinition,
  OptionalInputs,
  PipelineOptionsOf,
  PipelineResultOf,
  PipelineRunControlsOf,
  PlainStepFields,
  PolicySkippedOutput,
  RemoteStepDefinitionBase,
  RequiredInputs,
  SchemaStepFields,
  Step,
  StepDefinitionBody,
  StepSkipPredicate,
} from "./pipeline-step-types.js";
import type {
  InferSchemaInput,
  InferSchemaOutput,
  Pipeline,
  PipelineExecutionContext,
  PipelineRun,
  PipelineStepContext,
  StandardSchemaV1,
  StepSkipDecision,
} from "./pipeline-types.js";

export type {
  AnyStep,
  MappedChildProgressOptions,
  Step,
  StepOutput,
} from "./pipeline-step-types.js";

/** Step constructors scoped to one pipeline's domain option types. */
type StepFactory<
  TOptions extends object,
  TInputOptions extends object = TOptions,
  TOptionsSchema extends StandardSchemaV1 | undefined = undefined,
> = ReturnType<typeof createStepFactory<TOptions, TInputOptions, TOptionsSchema>>;

/**
 * Create typed step constructors for one pipeline definition.
 * Returns a step factory scoped to one pipeline's domain options. Pass built-in
 * run controls as the second argument to `run` / `runOrThrow`, or through a
 * child step's separate `controls` field.
 */
export function createSteps<TOptions extends object = {}>(): StepFactory<TOptions>;
export function createSteps<const TSchema extends StandardSchemaV1<object, object> | undefined>(
  optionsSchema: TSchema
): StepFactory<
  TSchema extends StandardSchemaV1 ? InferSchemaOutput<TSchema> : object,
  TSchema extends StandardSchemaV1 ? InferSchemaInput<TSchema> : object,
  TSchema
>;
export function createSteps(
  optionsSchema?: StandardSchemaV1<object, object>
): StepFactory<object, object, StandardSchemaV1 | undefined> {
  return createStepFactory<object, object, StandardSchemaV1 | undefined>(optionsSchema);
}

function createStepFactory<
  TOptions extends object,
  TInputOptions extends object = TOptions,
  TOptionsSchema extends StandardSchemaV1 | undefined = undefined,
>(optionsSchema?: TOptionsSchema) {
  // Preserve the runtime schema in the step type so adapters cannot infer flags
  // from erased TypeScript-only options.
  type BuiltStep<
    TId extends string,
    TOut,
    TStepOptions extends object,
    TInput extends object,
    TRunOut = TOut,
  > = TOptionsSchema extends StandardSchemaV1
    ? Step<TId, TOut, TStepOptions, TInput, TRunOut, TOptionsSchema>
    : Step<TId, TOut, TStepOptions, TInput, TRunOut>;
  const buildStep = (id: string, definition: StepDefinitionBody<TOptions>): AnyStep<TOptions> => {
    const built: AnyStep<TOptions> = { id, ...definition };
    if (optionsSchema) {
      Object.defineProperty(built, STEP_OPTIONS_SCHEMA, { value: optionsSchema });
    }
    return built;
  };

  function step<
    TId extends string,
    TSchema extends StandardSchemaV1,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TDecision extends StepSkipDecision<InferSchemaInput<TSchema>> = StepSkipDecision<
      InferSchemaInput<TSchema>
    >,
  >(
    id: TId,
    definition: SchemaStepFields<TOptions, TDeps, TOptionalDeps, TSchema> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>, TDecision>
        | undefined;
    }
  ): BuiltStep<
    TId,
    PolicySkippedOutput<InferSchemaOutput<TSchema>, TDecision>,
    TOptions,
    TInputOptions,
    InferSchemaInput<TSchema>
  >;
  function step<
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TOut = unknown,
    TDecision extends StepSkipDecision<NoInfer<TOut>> = StepSkipDecision<NoInfer<TOut>>,
  >(
    id: TId,
    definition: PlainStepFields<TOptions, TDeps, TOptionalDeps, TOut> & {
      skip: StepSkipPredicate<TOptions, TDeps, TOptionalDeps, NoInfer<TOut>, TDecision> | undefined;
    }
  ): BuiltStep<TId, PolicySkippedOutput<TOut, TDecision>, TOptions, TInputOptions>;
  function step<
    TId extends string,
    TSchema extends StandardSchemaV1,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: SchemaStepFields<TOptions, TDeps, TOptionalDeps, TSchema> & { skip?: never }
  ): BuiltStep<TId, InferSchemaOutput<TSchema>, TOptions, TInputOptions, InferSchemaInput<TSchema>>;
  function step<
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TOut = unknown,
  >(
    id: TId,
    definition: PlainStepFields<TOptions, TDeps, TOptionalDeps, TOut> & { skip?: never }
  ): BuiltStep<TId, TOut, TOptions, TInputOptions>;
  function step(id: string, definition: StepDefinitionBody<TOptions>): AnyStep<TOptions> {
    return buildStep(id, definition);
  }

  /** Read an artifact as an ordinary step, publishing only its typed value. */
  function loadArtifact<
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TValue = unknown,
  >(
    id: TId,
    definition: Omit<
      PlainStepFields<TOptions, TDeps, TOptionalDeps, ArtifactResult<TValue>>,
      "run" | "cache"
    > & {
      cache?: never;
      load: ArtifactLoader<RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>, TValue, TOptions>;
    }
  ): BuiltStep<TId, TValue, TOptions, TInputOptions>;
  function loadArtifact(
    id: string,
    definition: Parameters<typeof buildLoadArtifactStep<TOptions>>[2]
  ): AnyStep<TOptions> {
    return buildLoadArtifactStep(buildStep, id, definition);
  }

  /** Write an artifact as an ordinary step. Dry runs skip unless a preview is supplied. */
  function saveArtifact<
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TValue = unknown,
  >(
    id: TId,
    definition: Omit<
      PlainStepFields<TOptions, TDeps, TOptionalDeps, ArtifactResult<TValue>>,
      "run" | "cache"
    > & {
      cache?: never;
      save: ArtifactSaver<RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>, TValue, TOptions>;
    }
  ): BuiltStep<TId, TValue, TOptions, TInputOptions>;
  function saveArtifact(
    id: string,
    definition: Parameters<typeof buildSaveArtifactStep<TOptions>>[2]
  ): AnyStep<TOptions> {
    return buildSaveArtifactStep(buildStep, id, definition);
  }

  function fromPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinition<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip?: never;
      mapResult?: undefined;
    }
  ): BuiltStep<TId, PipelineResultOf<TChildPipeline>, TOptions, TInputOptions>;
  function fromPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip?: never;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): BuiltStep<TId, Awaited<TOut>, TOptions, TInputOptions>;
  function fromPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TDecision extends StepSkipDecision<PipelineResultOf<TChildPipeline>> = StepSkipDecision<
      PipelineResultOf<TChildPipeline>
    >,
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip:
        | StepSkipPredicate<
            TOptions,
            TDeps,
            TOptionalDeps,
            PipelineResultOf<TChildPipeline>,
            TDecision
          >
        | undefined;
      mapResult?: undefined;
    }
  ): BuiltStep<
    TId,
    PolicySkippedOutput<PipelineResultOf<TChildPipeline>, TDecision>,
    TOptions,
    TInputOptions
  >;
  function fromPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TDecision extends StepSkipDecision<NoInfer<Awaited<TOut>>> = StepSkipDecision<
      NoInfer<Awaited<TOut>>
    >,
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, NoInfer<Awaited<TOut>>, TDecision>
        | undefined;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): BuiltStep<TId, PolicySkippedOutput<Awaited<TOut>, TDecision>, TOptions, TInputOptions>;
  function fromPipeline(
    id: string,
    definition: SingleChildStepConfig<TOptions>
  ): AnyStep<TOptions> {
    return buildPipelineStep(buildStep, id, definition);
  }

  function fromRemote<
    TId extends string,
    TSchema extends StandardSchemaV1,
    TPayload,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: RemoteStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TPayload, TSchema> & {
      skip?: never;
    }
  ): BuiltStep<TId, InferSchemaOutput<TSchema>, TOptions, TInputOptions, InferSchemaInput<TSchema>>;
  function fromRemote<
    TId extends string,
    TSchema extends StandardSchemaV1,
    TPayload,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TDecision extends StepSkipDecision<InferSchemaInput<TSchema>> = StepSkipDecision<
      InferSchemaInput<TSchema>
    >,
  >(
    id: TId,
    definition: RemoteStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TPayload, TSchema> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>, TDecision>
        | undefined;
    }
  ): BuiltStep<
    TId,
    PolicySkippedOutput<InferSchemaOutput<TSchema>, TDecision>,
    TOptions,
    TInputOptions,
    InferSchemaInput<TSchema>
  >;
  function fromRemote(id: string, definition: RemoteStepConfig<TOptions>): AnyStep<TOptions> {
    return buildRemoteStep(buildStep, id, definition);
  }

  function forEachPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TItem,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: MappedChildPipelineStepDefinition<
      TOptions,
      TDeps,
      TOptionalDeps,
      TChildPipeline,
      TItem
    > & {
      skip?: never;
      mapResult?: undefined;
    }
  ): BuiltStep<TId, readonly PipelineResultOf<TChildPipeline>[], TOptions, TInputOptions>;
  function forEachPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TItem,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: MappedChildPipelineStepDefinition<
      TOptions,
      TDeps,
      TOptionalDeps,
      TChildPipeline,
      TItem
    > & {
      skip?: never;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        item: TItem,
        index: number,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): BuiltStep<TId, readonly Awaited<TOut>[], TOptions, TInputOptions>;
  function forEachPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TItem,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TDecision extends StepSkipDecision<readonly PipelineResultOf<TChildPipeline>[]> =
      StepSkipDecision<readonly PipelineResultOf<TChildPipeline>[]>,
  >(
    id: TId,
    definition: MappedChildPipelineStepDefinition<
      TOptions,
      TDeps,
      TOptionalDeps,
      TChildPipeline,
      TItem
    > & {
      skip:
        | StepSkipPredicate<
            TOptions,
            TDeps,
            TOptionalDeps,
            readonly PipelineResultOf<TChildPipeline>[],
            TDecision
          >
        | undefined;
      mapResult?: undefined;
    }
  ): BuiltStep<
    TId,
    PolicySkippedOutput<readonly PipelineResultOf<TChildPipeline>[], TDecision>,
    TOptions,
    TInputOptions
  >;
  function forEachPipeline<
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TItem,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TDecision extends StepSkipDecision<NoInfer<readonly Awaited<TOut>[]>> = StepSkipDecision<
      NoInfer<readonly Awaited<TOut>[]>
    >,
  >(
    id: TId,
    definition: MappedChildPipelineStepDefinition<
      TOptions,
      TDeps,
      TOptionalDeps,
      TChildPipeline,
      TItem
    > & {
      skip:
        | StepSkipPredicate<
            TOptions,
            TDeps,
            TOptionalDeps,
            NoInfer<readonly Awaited<TOut>[]>,
            TDecision
          >
        | undefined;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        item: TItem,
        index: number,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): BuiltStep<
    TId,
    PolicySkippedOutput<readonly Awaited<TOut>[], TDecision>,
    TOptions,
    TInputOptions
  >;
  function forEachPipeline(
    id: string,
    definition: MappedChildStepConfig<TOptions>
  ): AnyStep<TOptions> {
    return buildMappedPipelineStep(buildStep, id, definition);
  }

  function iteratePipeline<
    const TId extends string,
    TChild extends Pipeline<object, unknown>,
    TState,
    TResult,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: {
      pipeline: TChild;
      name?: string;
      description?: string;
      metadata?: PipelineMetadata;
      dependsOn?: TDeps;
      maxIterations: number;
      dryRun?: "skip";
      controls?: PipelineRunControlsOf<TChild>;
      initialState(
        inputs: RequiredInputs<TDeps>,
        context: PipelineExecutionContext<TOptions>
      ): TState;
      mapOptions(
        state: IterationState<NoInfer<TState>>,
        inputs: RequiredInputs<TDeps>,
        context: PipelineExecutionContext<TOptions>
      ): PipelineOptionsOf<TChild>;
      transition(
        result: PipelineResultOf<TChild>,
        state: IterationState<NoInfer<TState>>,
        context: PipelineExecutionContext<TOptions>
      ):
        | IterationDecision<NoInfer<TState>, TResult>
        | Promise<IterationDecision<NoInfer<TState>, TResult>>;
    }
  ): BuiltStep<TId, Awaited<TResult>, TOptions, TInputOptions>;
  function iteratePipeline(
    id: string,
    definition: IterationStepConfig<TOptions>
  ): AnyStep<TOptions> {
    return buildIterationStep(buildStep, id, definition);
  }

  const factory = {
    step,
    loadArtifact,
    saveArtifact,
    fromPipeline,
    fromRemote,
    forEachPipeline,
    iteratePipeline,
  };

  return factory;
}
