import {
  createMappedChildRunner,
  createSingleChildRunner,
  type MappedChildExecutionConfig,
  type SingleChildExecutionConfig,
} from "./child-execution.js";
import type { ToMappedChildStepProgressOptions } from "./mapped-child-progress.js";
import { isPipelineCancellation, PipelineExecutionError } from "./pipeline-execute.js";
import { STEP_NESTED_PIPELINE, STEP_OPTIONS_SCHEMA, STEP_REMOTE } from "./pipeline-plan.js";
import type {
  InferSchemaInput,
  InferSchemaOutput,
  Pipeline,
  PipelineExecutionContext,
  PipelinePlanStep,
  PipelineRun,
  PipelineRunOptions,
  PipelineStepContext,
  RemoteStepAdapter,
  StandardSchemaV1,
  StepSkipDecision,
} from "./pipeline-types.js";

/**
 * A step's dependencies are references to the dependency's own step object, not string ids
 * into a hand-maintained output-type map. This buys two things no amount of extra generics
 * on a string-keyed design could:
 *  - a step used before its dependency exists is a compile error (JS temporal dead zone on
 *    `const`), so out-of-order and self/cyclic dependencies are caught by the language, not
 *    a bespoke runtime check
 *  - each step only ever states its own id/deps; the output-type map is derived, never
 *    restated, and callers of `definePipeline`/`createSteps` never write out its generics
 */
type AnyStepDryRunHandler<TOptions extends object> = {
  bivarianceHack(
    inputs: Record<string, unknown>,
    context: PipelineStepContext<TOptions>
  ): unknown | Promise<unknown>;
}["bivarianceHack"];

export interface AnyStep<TOptions extends object = object> {
  readonly [STEP_NESTED_PIPELINE]?: NonNullable<PipelinePlanStep["nestedPipeline"]>;
  readonly [STEP_REMOTE]?: NonNullable<PipelinePlanStep["remote"]>;
  readonly [STEP_OPTIONS_SCHEMA]?: StandardSchemaV1;
  readonly id: string;
  readonly dependsOn?: readonly AnyStep<TOptions>[];
  readonly optionalDependsOn?: readonly AnyStep<TOptions>[];
  readonly skipAfterFailureOf?: readonly AnyStep<TOptions>[];
  /** Optional human-facing display name. Stable machine identity remains `id`. */
  readonly name?: string;
  readonly description?: string;
  /**
   * Dry-run policy. Omitted runs the normal handler, `"skip"` structurally
   * skips it, and a handler substitutes for `run` while preserving its output.
   */
  readonly dryRun?: "skip" | AnyStepDryRunHandler<TOptions>;
  /** Optional Standard Schema for values published by this step. */
  readonly outputSchema?: StandardSchemaV1;
  /**
   * Optional runtime skip. Return a non-empty reason (or `{ reason, value }`) to
   * skip without calling `run`. Policy skips unlock dependents; structural skips
   * (dry-run, filtered, …) do not use this hook.
   */
  skip?(
    inputs: Record<string, unknown>,
    context: PipelineExecutionContext<TOptions>
  ): StepSkipDecision | Promise<StepSkipDecision>;
  run(inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>): unknown;
}

/** The step fields that `buildStep` merges onto the id-bearing shell. */
type StepDefinitionBody<TOptions extends object> = Omit<AnyStep<TOptions>, "id">;

export interface Step<
  TId extends string,
  TOut,
  TOptions extends object,
  TInputOptions extends object = TOptions,
  TRunOut = TOut,
> extends AnyStep<TOptions> {
  readonly id: TId;
  run(
    inputs: Record<string, unknown>,
    context: PipelineStepContext<TOptions>
  ): TRunOut | Promise<TRunOut>;
  /** Type-only: carries this step's output type for sibling inference. Never set at runtime. */
  readonly __outputType?: TOut;
  /** Type-only: carries pre-validation run options for pipeline call-site inference. */
  readonly __inputOptionsType?: TInputOptions;
}

/**
 * Extract a step's output type for dependency typing.
 * Prefer matching `Step<…, TOut, …>` over `{ __outputType?: infer T }`: optional-property
 * inference collapses `TOut | undefined` to `TOut`, which hides policy-skip widening.
 */
export type StepOutput<S> =
  S extends Step<string, infer TOut, infer _TOptions, infer _TInputOptions, infer _TRunOut>
    ? TOut
    : never;

interface StepToken {
  readonly id: string;
  readonly __outputType?: unknown;
}

type RequiredInputs<TDeps extends readonly StepToken[]> = {
  [S in TDeps[number] as S["id"]]: StepOutput<S>;
};

type OptionalInputs<TDeps extends readonly StepToken[]> = {
  [S in TDeps[number] as S["id"]]?: StepOutput<S>;
};

type PipelineResultOf<TPipeline> =
  TPipeline extends Pipeline<object, infer TResult, infer _TStepId, infer _TTargetId>
    ? TResult
    : never;

type PipelineRunOptionsOf<TPipeline> =
  TPipeline extends Pipeline<infer TOptions, unknown, infer TStepId, infer TTargetId>
    ? PipelineRunOptions<TOptions, TStepId, TTargetId>
    : never;

type ChildPipelineStepDefinitionBase<
  TParentOptions extends object,
  TDeps extends readonly AnyStep<TParentOptions>[],
  TOptionalDeps extends readonly AnyStep<TParentOptions>[],
  TChildPipeline extends Pipeline<object, unknown>,
> = {
  pipeline: TChildPipeline;
  dependsOn?: TDeps;
  optionalDependsOn?: TOptionalDeps;
  skipAfterFailureOf?: readonly AnyStep<TParentOptions>[];
  name?: string;
  description?: string;
  dryRun?: "skip";
  mapOptions(
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineExecutionContext<TParentOptions>
  ): PipelineRunOptionsOf<TChildPipeline>;
};

/** Child step without policy skip (dependents see the full child result type). */
type ChildPipelineStepDefinition<
  TParentOptions extends object,
  TDeps extends readonly AnyStep<TParentOptions>[],
  TOptionalDeps extends readonly AnyStep<TParentOptions>[],
  TChildPipeline extends Pipeline<object, unknown>,
> = ChildPipelineStepDefinitionBase<TParentOptions, TDeps, TOptionalDeps, TChildPipeline>;

/**
 * Presentation options for opaque `forEachPipeline` progress.
 * Defaults are domain-neutral (`N/M items · K running · key/step`).
 * Override `formatMessage` when a domain wants its own noun (images, shards, …).
 */
export type MappedChildProgressOptions = ToMappedChildStepProgressOptions;

type MappedChildPipelineStepDefinition<
  TParentOptions extends object,
  TDeps extends readonly AnyStep<TParentOptions>[],
  TOptionalDeps extends readonly AnyStep<TParentOptions>[],
  TChildPipeline extends Pipeline<object, unknown>,
  TItem,
> = {
  pipeline: TChildPipeline;
  dependsOn?: TDeps;
  optionalDependsOn?: TOptionalDeps;
  skipAfterFailureOf?: readonly AnyStep<TParentOptions>[];
  name?: string;
  description?: string;
  dryRun?: "skip";
  items(
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineExecutionContext<TParentOptions>
  ): readonly TItem[] | Promise<readonly TItem[]>;
  key(item: TItem, index: number): string;
  concurrency?:
    | number
    | ((
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineExecutionContext<TParentOptions>
      ) => number);
  /**
   * How the opaque parent step reports live fan-out progress.
   * Purely presentational — does not change scheduling or results.
   */
  progress?: MappedChildProgressOptions;
  mapOptions(
    item: TItem,
    index: number,
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineExecutionContext<TParentOptions>
  ): PipelineRunOptionsOf<TChildPipeline>;
};

type StepSkipPredicate<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TOut,
> = (
  inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
  context: PipelineExecutionContext<TOptions>
) => StepSkipDecision<TOut> | Promise<StepSkipDecision<TOut>>;

type StepDryRunPolicy<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TOut,
> =
  | "skip"
  | ((
      inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
      context: PipelineStepContext<TOptions>
    ) => TOut | Promise<TOut>);

type PlainStepFields<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TOut,
> = {
  dependsOn?: TDeps;
  optionalDependsOn?: TOptionalDeps;
  skipAfterFailureOf?: readonly AnyStep<TOptions>[];
  name?: string;
  description?: string;
  dryRun?: StepDryRunPolicy<TOptions, TDeps, TOptionalDeps, TOut>;
  outputSchema?: never;
  run(
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineStepContext<TOptions>
  ): TOut | Promise<TOut>;
};

type SchemaStepFields<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TSchema extends StandardSchemaV1,
> = Omit<
  PlainStepFields<TOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>>,
  "outputSchema"
> & {
  outputSchema: TSchema;
};

interface StepConstructor<TOptions extends object, TInputOptions extends object = TOptions> {
  /** Ordinary steps never policy-skip, so dependents receive their full output. */
  <
    TId extends string,
    TSchema extends StandardSchemaV1,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: SchemaStepFields<TOptions, TDeps, TOptionalDeps, TSchema> & { skip?: never }
  ): Step<TId, InferSchemaOutput<TSchema>, TOptions, TInputOptions, InferSchemaInput<TSchema>>;

  <
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TOut = unknown,
  >(
    id: TId,
    definition: PlainStepFields<TOptions, TDeps, TOptionalDeps, TOut> & { skip?: never }
  ): Step<TId, TOut, TOptions, TInputOptions>;

  /** Explicit policy-skip constructor; dependents receive `TOut | undefined`. */
  skippable: SkippableStepConstructor<TOptions, TInputOptions>;
}

interface SkippableStepConstructor<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> {
  <
    TId extends string,
    TSchema extends StandardSchemaV1,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: SchemaStepFields<TOptions, TDeps, TOptionalDeps, TSchema> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>>
        | undefined;
    }
  ): Step<
    TId,
    InferSchemaOutput<TSchema> | undefined,
    TOptions,
    TInputOptions,
    InferSchemaInput<TSchema>
  >;

  <
    TId extends string,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
    TOut = unknown,
  >(
    id: TId,
    definition: PlainStepFields<TOptions, TDeps, TOptionalDeps, TOut> & {
      skip: StepSkipPredicate<TOptions, TDeps, TOptionalDeps, TOut> | undefined;
    }
  ): Step<TId, TOut | undefined, TOptions, TInputOptions>;
}

interface FromPipelineConstructor<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> {
  <
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
  ): Step<TId, PipelineResultOf<TChildPipeline>, TOptions, TInputOptions>;

  <
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
  ): Step<TId, TOut, TOptions, TInputOptions>;

  skippable: SkippableFromPipelineConstructor<TOptions, TInputOptions>;
}

interface SkippableFromPipelineConstructor<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> {
  <
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, PipelineResultOf<TChildPipeline>>
        | undefined;
      mapResult?: undefined;
    }
  ): Step<TId, PipelineResultOf<TChildPipeline> | undefined, TOptions, TInputOptions>;

  <
    TId extends string,
    TChildPipeline extends Pipeline<object, unknown>,
    TOut,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: ChildPipelineStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TChildPipeline> & {
      skip: StepSkipPredicate<TOptions, TDeps, TOptionalDeps, NoInfer<TOut>> | undefined;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): Step<TId, TOut | undefined, TOptions, TInputOptions>;
}

type RemoteStepDefinitionBase<
  TParentOptions extends object,
  TDeps extends readonly AnyStep<TParentOptions>[],
  TOptionalDeps extends readonly AnyStep<TParentOptions>[],
  TPayload,
  TSchema extends StandardSchemaV1,
> = {
  adapter: RemoteStepAdapter<TParentOptions, TPayload, InferSchemaInput<TSchema>>;
  mapInput(
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineStepContext<TParentOptions>
  ): TPayload;
  outputSchema: TSchema;
  dependsOn?: TDeps;
  optionalDependsOn?: TOptionalDeps;
  skipAfterFailureOf?: readonly AnyStep<TParentOptions>[];
  name?: string;
  description?: string;
  dryRun?: StepDryRunPolicy<TParentOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>>;
};

interface FromRemoteConstructor<TOptions extends object, TInputOptions extends object = TOptions> {
  <
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
  ): Step<TId, InferSchemaOutput<TSchema>, TOptions, TInputOptions, InferSchemaInput<TSchema>>;

  skippable: SkippableFromRemoteConstructor<TOptions, TInputOptions>;
}

interface SkippableFromRemoteConstructor<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> {
  <
    TId extends string,
    TSchema extends StandardSchemaV1,
    TPayload,
    const TDeps extends readonly AnyStep<TOptions>[] = [],
    const TOptionalDeps extends readonly AnyStep<TOptions>[] = [],
  >(
    id: TId,
    definition: RemoteStepDefinitionBase<TOptions, TDeps, TOptionalDeps, TPayload, TSchema> & {
      skip:
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>>
        | undefined;
    }
  ): Step<
    TId,
    InferSchemaOutput<TSchema> | undefined,
    TOptions,
    TInputOptions,
    InferSchemaInput<TSchema>
  >;
}

export interface StepFactory<
  TOptions extends object,
  TInputOptions extends object = TOptions,
> extends StepConstructor<TOptions, TInputOptions> {
  fromPipeline: FromPipelineConstructor<TOptions, TInputOptions>;
  fromRemote: FromRemoteConstructor<TOptions, TInputOptions>;

  forEachPipeline<
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
      mapResult?: undefined;
    }
  ): Step<TId, readonly PipelineResultOf<TChildPipeline>[], TOptions, TInputOptions>;

  forEachPipeline<
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
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        item: TItem,
        index: number,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): Step<TId, readonly TOut[], TOptions, TInputOptions>;
}

/**
 * Returns a step factory scoped to one pipeline's domain options. Built-in run
 * controls are accepted alongside those options when the pipeline is invoked.
 */
export function createSteps<TOptions extends object = {}>(): StepFactory<TOptions>;
export function createSteps<const TSchema extends StandardSchemaV1<object, object>>(
  optionsSchema: TSchema
): StepFactory<InferSchemaOutput<TSchema>, InferSchemaInput<TSchema>>;
export function createSteps(optionsSchema?: StandardSchemaV1<object, object>): StepFactory<object> {
  return createStepFactory<object>(optionsSchema);
}

function createStepFactory<TOptions extends object, TInputOptions extends object = TOptions>(
  optionsSchema?: StandardSchemaV1
): StepFactory<TOptions, TInputOptions> {
  // Runtime construction is deliberately simple; the public factory owns the
  // distinction between ordinary and explicitly skippable constructors.
  const buildStep = (id: string, definition: StepDefinitionBody<TOptions>): AnyStep<TOptions> => {
    // SAFETY: `definition` carries the step's own fields; spreading it onto the
    // id-bearing shell yields a value whose shape matches `AnyStep<TOptions>`.
    const built = { id, ...definition } as AnyStep<TOptions>;
    if (optionsSchema) {
      Object.defineProperty(built, STEP_OPTIONS_SCHEMA, { value: optionsSchema });
    }
    return built;
  };

  // SAFETY: the closure's parameter and return shapes match the
  // `fromPipeline` constructor signature it is assigned to.
  const fromPipeline = ((
    id: string,
    config: ChildPipelineStepDefinitionBase<
      TOptions,
      readonly AnyStep<TOptions>[],
      readonly AnyStep<TOptions>[],
      Pipeline<object, unknown>
    > & {
      skip?: StepSkipPredicate<
        TOptions,
        readonly AnyStep<TOptions>[],
        readonly AnyStep<TOptions>[],
        unknown
      >;
      mapResult?: (
        value: unknown,
        result: PipelineRun<unknown>,
        context: PipelineStepContext<TOptions>
      ) => unknown;
    }
  ) => {
    const definition = {
      [STEP_NESTED_PIPELINE]: {
        mode: "single" as const,
        pipelineId: config.pipeline.id,
        stepIds: config.pipeline.stepIds,
      },
      dependsOn: config.dependsOn,
      optionalDependsOn: config.optionalDependsOn,
      skipAfterFailureOf: config.skipAfterFailureOf,
      name: config.name,
      description: config.description,
      dryRun: config.dryRun,
      // SAFETY: the config carries `pipeline` and `mapResult`; the runner
      // derives `mapOptions` from the same fields, so the config is a valid
      // single-child execution config at runtime.
      run: createSingleChildRunner(config as SingleChildExecutionConfig<TOptions>, {
        createExecutionError: (result, message) => new PipelineExecutionError(result, message),
        isCancellation: (error, childContext) => isPipelineCancellation(error, childContext),
      }),
    };

    if ("skip" in config && config.skip !== undefined) {
      const skip = config.skip;
      // SAFETY: the skip predicate is invoked with the step's own inputs and
      // returns a step-skip decision; the casts only align the generic
      // predicate signature with the concrete step context.
      return buildStep(id, {
        ...definition,
        skip: (
          inputs: RequiredInputs<readonly AnyStep<TOptions>[]> &
            OptionalInputs<readonly AnyStep<TOptions>[]>,
          context: PipelineExecutionContext<TOptions>
        ) => skip(inputs as never, context) as StepSkipDecision | Promise<StepSkipDecision>,
      });
    }
    return buildStep(id, definition);
  }) as StepFactory<TOptions, TInputOptions>["fromPipeline"];

  // SAFETY: the closure's parameter and return shapes match the
  // `fromRemote` constructor signature it is assigned to.
  const fromRemote = ((
    id: string,
    config: {
      adapter: RemoteStepAdapter<object, unknown, unknown>;
      mapInput: (
        inputs: Record<string, unknown>,
        context: PipelineStepContext<TOptions>
      ) => unknown;
      outputSchema: StandardSchemaV1;
      dependsOn?: readonly AnyStep<TOptions>[];
      optionalDependsOn?: readonly AnyStep<TOptions>[];
      skipAfterFailureOf?: readonly AnyStep<TOptions>[];
      name?: string;
      description?: string;
      dryRun?: "skip" | AnyStepDryRunHandler<TOptions>;
      skip?: StepSkipPredicate<
        TOptions,
        readonly AnyStep<TOptions>[],
        readonly AnyStep<TOptions>[],
        unknown
      >;
    }
  ) => {
    const remote: NonNullable<PipelinePlanStep["remote"]> = { engine: config.adapter.engine };
    if (config.adapter.target !== undefined) remote.target = config.adapter.target;
    const definition = {
      [STEP_REMOTE]: remote,
      dependsOn: config.dependsOn,
      optionalDependsOn: config.optionalDependsOn,
      skipAfterFailureOf: config.skipAfterFailureOf,
      name: config.name,
      description: config.description,
      dryRun: config.dryRun,
      outputSchema: config.outputSchema,
      run: (inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>) =>
        config.adapter.invoke(config.mapInput(inputs, context), context),
    };
    if ("skip" in config && config.skip !== undefined) {
      const skip = config.skip;
      return buildStep(id, {
        ...definition,
        // SAFETY: skippable fromRemote configs share the same dependency input map as the non-skippable overload.
        skip: (inputs, context) => skip(inputs as never, context),
      });
    }
    return buildStep(id, definition);
  }) as StepFactory<TOptions, TInputOptions>["fromRemote"];

  // SAFETY: the closure's parameter and return shapes match the
  // `forEachPipeline` constructor signature it is assigned to.
  const forEachPipeline = ((
    id: string,
    config: MappedChildPipelineStepDefinition<
      TOptions,
      readonly AnyStep<TOptions>[],
      readonly AnyStep<TOptions>[],
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
    }
  ) =>
    buildStep(id, {
      [STEP_NESTED_PIPELINE]: {
        mode: "for-each" as const,
        pipelineId: config.pipeline.id,
        stepIds: config.pipeline.stepIds,
      },
      dependsOn: config.dependsOn,
      optionalDependsOn: config.optionalDependsOn,
      skipAfterFailureOf: config.skipAfterFailureOf,
      name: config.name,
      description: config.description,
      dryRun: config.dryRun,
      // SAFETY: the config carries `pipeline`, `items`, `key`, and `mapResult`;
      // the runner derives the rest from those fields, so the config is a valid
      // mapped-child execution config at runtime.
      run: createMappedChildRunner(config as MappedChildExecutionConfig<TOptions>, {
        createExecutionError: (result, message) => new PipelineExecutionError(result, message),
        isCancellation: (error, childContext) => isPipelineCancellation(error, childContext),
      }),
    })) as StepFactory<TOptions, TInputOptions>["forEachPipeline"];

  // SAFETY: `buildStep` is a callable; attaching the constructor properties
  // yields exactly the `StepFactory` surface (call + skippable + fromPipeline +
  // forEachPipeline), so the single assertion is sound.
  const factory = Object.assign(buildStep, {
    skippable: buildStep,
    fromPipeline,
    fromRemote,
    forEachPipeline,
  }) as StepFactory<TOptions, TInputOptions>;
  // SAFETY: `fromPipeline` is the same callable as `factory.fromPipeline`; it
  // carries the skippable variant, so the assignment is sound.
  factory.fromPipeline.skippable = fromPipeline as StepFactory<
    TOptions,
    TInputOptions
  >["fromPipeline"]["skippable"];
  // SAFETY: `fromRemote` is the same callable as `factory.fromRemote`; it
  // carries the skippable variant, so the assignment is sound.
  factory.fromRemote.skippable = fromRemote as StepFactory<
    TOptions,
    TInputOptions
  >["fromRemote"]["skippable"];

  return factory;
}
