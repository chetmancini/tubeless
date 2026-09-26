import type { PipelineMetadata } from "../tracing/graph-metadata.js";
import {
  type ArtifactLoader,
  type ArtifactSaver,
  type ArtifactResult,
} from "./pipeline-artifacts.js";
import { createMappedChildRunner, createSingleChildRunner } from "./child-execution.js";
import { createIterationRunner, type IterationDecision, type IterationState } from "./iteration.js";
import type { ToMappedChildStepProgressOptions } from "./mapped-child-progress.js";
import {
  STEP_NESTED_PIPELINE,
  STEP_OPTIONS_SCHEMA,
  STEP_REMOTE,
} from "./pipeline-step-metadata.js";
import type {
  InferSchemaInput,
  InferSchemaOutput,
  Pipeline,
  PipelineExecutionContext,
  PipelinePlanStep,
  PipelineRun,
  PipelineRunControls,
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

/** Runtime shape shared by every declared pipeline step. */
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
  readonly metadata?: PipelineMetadata;
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

/** Typed pipeline step carrying its stable ID, output, and option types. */
export interface Step<
  TId extends string,
  TOut,
  TOptions extends object,
  TInputOptions extends object = TOptions,
  TRunOut = TOut,
  TOptionsSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> extends AnyStep<TOptions> {
  readonly [STEP_OPTIONS_SCHEMA]?: TOptionsSchema;
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

type PipelineOptionsOf<TPipeline> =
  TPipeline extends Pipeline<infer TOptions, unknown, infer _TStepId, infer _TTargetId>
    ? TOptions
    : never;

type PipelineRunControlsOf<TPipeline> =
  TPipeline extends Pipeline<infer _TOptions, unknown, infer TStepId, infer TTargetId>
    ? PipelineRunControls<TStepId, TTargetId>
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
  metadata?: PipelineMetadata;
  dryRun?: "skip";
  controls?:
    | PipelineRunControlsOf<TChildPipeline>
    | ((
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineExecutionContext<TParentOptions>
      ) => PipelineRunControlsOf<TChildPipeline>);
} & ([TParentOptions] extends [PipelineOptionsOf<NoInfer<TChildPipeline>>]
  ? {
      mapOptions?(
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineExecutionContext<TParentOptions>
      ): PipelineOptionsOf<TChildPipeline>;
    }
  : {
      mapOptions(
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineExecutionContext<TParentOptions>
      ): PipelineOptionsOf<TChildPipeline>;
    });

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
  metadata?: PipelineMetadata;
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
  controls?:
    | PipelineRunControlsOf<TChildPipeline>
    | ((
        item: TItem,
        index: number,
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineExecutionContext<TParentOptions>
      ) => PipelineRunControlsOf<TChildPipeline>);
  mapOptions(
    item: TItem,
    index: number,
    inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
    context: PipelineExecutionContext<TParentOptions>
  ): PipelineOptionsOf<TChildPipeline>;
};

type StepSkipPredicate<
  TOptions extends object,
  TDeps extends readonly AnyStep<TOptions>[],
  TOptionalDeps extends readonly AnyStep<TOptions>[],
  TOut,
  TDecision extends StepSkipDecision<TOut> = StepSkipDecision<TOut>,
> = (
  inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
  context: PipelineExecutionContext<TOptions>
) => TDecision | Promise<TDecision>;

type PolicySkippedOutput<TOut, TDecision> = [
  Exclude<Awaited<TDecision>, false | null | undefined>,
] extends [{ reason: string; value: unknown }]
  ? TOut
  : TOut | undefined;

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
  metadata?: PipelineMetadata;
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
  metadata?: PipelineMetadata;
  dryRun?: StepDryRunPolicy<TParentOptions, TDeps, TOptionalDeps, InferSchemaInput<TSchema>>;
};

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
      "run"
    > & {
      load: ArtifactLoader<RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>, TValue, TOptions>;
    }
  ): BuiltStep<TId, TValue, TOptions, TInputOptions> {
    const { load, dryRun, ...fields } = definition;
    const wrap =
      (handler: typeof load) =>
      async (
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineStepContext<TOptions>
      ) => {
        const loaded = await handler(inputs, context);
        context.recordArtifact({ operation: "read", artifact: loaded.artifact });
        return loaded.value;
      };
    return step(id, {
      ...fields,
      run: wrap(load),
      dryRun: typeof dryRun === "function" ? wrap(dryRun) : dryRun,
    });
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
      "run"
    > & {
      save: ArtifactSaver<RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>, TValue, TOptions>;
    }
  ): BuiltStep<TId, TValue, TOptions, TInputOptions> {
    const { save, dryRun, ...fields } = definition;
    const wrap =
      (handler: typeof save) =>
      async (
        inputs: RequiredInputs<TDeps> & OptionalInputs<TOptionalDeps>,
        context: PipelineStepContext<TOptions>
      ) => {
        const saved = await handler(inputs, context);
        context.recordArtifact({ operation: "write", artifact: saved.artifact });
        return saved.value;
      };
    return step(id, {
      ...fields,
      run: wrap(save),
      dryRun: typeof dryRun === "function" ? wrap(dryRun) : "skip",
    });
  }

  const buildPipelineStep = (
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
      run: createSingleChildRunner(config),
    };

    const skip = config.skip;
    if (skip !== undefined) {
      definition.skip = skip;
    }
    return buildStep(id, definition);
  };

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
    definition: Parameters<typeof buildPipelineStep>[1]
  ): AnyStep<TOptions> {
    return buildPipelineStep(id, definition);
  }

  const buildRemoteStep = (
    id: string,
    config: {
      adapter: RemoteStepAdapter<object, unknown, unknown>;
      mapInput(inputs: Record<string, unknown>, context: PipelineStepContext<TOptions>): unknown;
      outputSchema: StandardSchemaV1;
      dependsOn?: readonly AnyStep<TOptions>[];
      optionalDependsOn?: readonly AnyStep<TOptions>[];
      skipAfterFailureOf?: readonly AnyStep<TOptions>[];
      name?: string;
      description?: string;
      metadata?: PipelineMetadata;
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
  };

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
  function fromRemote(
    id: string,
    definition: Parameters<typeof buildRemoteStep>[1]
  ): AnyStep<TOptions> {
    return buildRemoteStep(id, definition);
  }

  const buildMappedPipelineStep = (
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
      skip?: StepSkipPredicate<
        TOptions,
        readonly AnyStep<TOptions>[],
        readonly AnyStep<TOptions>[],
        unknown
      >;
    }
  ) => {
    const definition: StepDefinitionBody<TOptions> = {
      [STEP_NESTED_PIPELINE]: {
        mode: "for-each" as const,
        concurrency:
          typeof config.concurrency === "function" ? "dynamic" : (config.concurrency ?? 1),
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
      run: createMappedChildRunner(config),
    };

    const skip = config.skip;
    if (skip !== undefined) {
      definition.skip = skip;
    }
    return buildStep(id, definition);
  };

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
  ): BuiltStep<TId, readonly TOut[], TOptions, TInputOptions>;
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
    TDecision extends StepSkipDecision<NoInfer<readonly TOut[]>> = StepSkipDecision<
      NoInfer<readonly TOut[]>
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
        | StepSkipPredicate<TOptions, TDeps, TOptionalDeps, NoInfer<readonly TOut[]>, TDecision>
        | undefined;
      mapResult(
        value: PipelineResultOf<TChildPipeline>,
        result: PipelineRun<PipelineResultOf<TChildPipeline>>,
        item: TItem,
        index: number,
        context: PipelineStepContext<TOptions>
      ): TOut;
    }
  ): BuiltStep<TId, PolicySkippedOutput<readonly TOut[], TDecision>, TOptions, TInputOptions>;
  function forEachPipeline(
    id: string,
    definition: Parameters<typeof buildMappedPipelineStep>[1]
  ): AnyStep<TOptions> {
    return buildMappedPipelineStep(id, definition);
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
    definition: Omit<Parameters<typeof createIterationRunner<TOptions>>[0], "stepId"> & {
      name?: string;
      description?: string;
      metadata?: PipelineMetadata;
      dependsOn?: readonly AnyStep<TOptions>[];
      dryRun?: "skip";
    }
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
