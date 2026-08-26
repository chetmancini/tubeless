import { createCommand } from "./cli-command.js";
import { flagName } from "./cli-parser.js";
import type {
  CliBooleanParam,
  CliCheckpointConfig,
  CliCommandConfig,
  CliCommandDescriptor,
  CliContext,
  CliParams,
  CliParamsSchema,
  CliStringParam,
} from "./cli-types.js";
import { markPipelineCommand } from "./pipeline-command-marker.js";
import {
  type Pipeline,
  type PipelineHooks,
  type PipelinePlan,
  type PipelineRunControls,
  type PipelineRunOptions,
} from "./pipeline.js";
import { createPipelineReporter, type PipelineReporterConfig } from "./reporter-entry.js";
import { TUBELESS_WORKBENCH_EXIT_CODE } from "./workbench-shared.js";

export type PipelineCliBuiltins = {
  step: CliStringParam & { multiple: true };
  target: CliStringParam & { multiple: true };
  continueOnError: CliBooleanParam;
};

export type PipelineCliValues<TSchema extends CliParamsSchema> = CliParams<TSchema> & {
  step: readonly string[];
  target: readonly string[];
  continueOnError: boolean;
};

export type PipelineCliParseResult<TSchema extends CliParamsSchema> =
  | { kind: "values"; values: PipelineCliValues<TSchema> }
  | { kind: "help"; helpText: string }
  | { kind: "error"; errors: readonly string[]; helpText: string };

/** Selection-only input for a side-effect-free pipeline command plan. */
export interface PipelineCommandPlanInput {
  dryRun?: boolean;
  step?: readonly string[];
  target?: readonly string[];
}

export interface PipelineCommand<TSchema extends CliParamsSchema, TResult> {
  readonly descriptor: CliCommandDescriptor;
  /** Plan without parsing or requiring domain parameters. */
  plan(input?: PipelineCommandPlanInput): PipelinePlan;
  parse(argv?: readonly string[], context?: Partial<CliContext>): PipelineCliParseResult<TSchema>;
  /** Validate structured form values without tokenizing argv. */
  parseValues(
    values: Record<string, unknown>,
    context?: Partial<CliContext>
  ): PipelineCliParseResult<TSchema>;
  /** Execute already validated form values. */
  execute(values: PipelineCliValues<TSchema>, context?: Partial<CliContext>): Promise<TResult>;
  run(argv?: readonly string[], context?: Partial<CliContext>): Promise<TResult>;
  main(argv?: readonly string[], context?: Partial<CliContext>): Promise<void>;
}

export interface PipelineCommandHookContext<TSchema extends CliParamsSchema> {
  context: CliContext;
  values: PipelineCliValues<TSchema>;
}

export type PipelineCommandHookSets<TResult> =
  | PipelineHooks<TResult>
  | readonly PipelineHooks<TResult>[];

export type PipelineCommandHookConfig<TResult, TSchema extends CliParamsSchema> =
  | PipelineCommandHookSets<TResult>
  | ((input: PipelineCommandHookContext<TSchema>) => PipelineCommandHookSets<TResult> | undefined);

type PipelineCommandMapOptions<TOptions extends object, TSchema extends CliParamsSchema> = (
  values: PipelineCliValues<TSchema>,
  context: CliContext
) => PipelineRunOptions<TOptions> | Promise<PipelineRunOptions<TOptions>>;

type DefaultPipelineCommandOptions<TSchema extends CliParamsSchema> = Omit<
  PipelineCliValues<TSchema>,
  "continueOnError" | "dryRun" | "resume" | "step" | "target"
>;

type CanDefaultPipelineCommandOptions<TOptions extends object, TSchema extends CliParamsSchema> =
  DefaultPipelineCommandOptions<TSchema> extends TOptions
    ? Exclude<keyof TSchema, keyof TOptions> extends never
      ? true
      : false
    : false;

interface DefinePipelineCommandConfigBase<TResult, TSchema extends CliParamsSchema> {
  /** Defaults to pipeline.id. */
  name?: string;
  description?: string;
  /** Extra flags beyond the command and pipeline built-ins. */
  params?: TSchema;
  /** Extra parameter keys accepted in positional order. */
  positionals?: readonly (keyof TSchema & string)[];
  checkpoint?: CliCheckpointConfig;
  /** Additional lifecycle hooks, or a factory resolved from parsed values and CLI context. */
  hooks?: PipelineCommandHookConfig<TResult, TSchema>;
  /** Configure plain/interactive reporting, or disable it. Defaults to automatic mode. */
  reporter?: false | PipelineReporterConfig;
  /** Print domain-specific result lines after a successful run. */
  summarize?(
    result: TResult,
    values: PipelineCliValues<TSchema>,
    context: CliContext
  ): readonly string[] | void;
  validate?(values: PipelineCliValues<TSchema>, context: CliContext): string[] | void;
}

/** Configuration for a typed pipeline command. Mapping is optional only for compatible flags. */
export type DefinePipelineCommandConfig<
  TOptions extends object,
  TResult,
  TSchema extends CliParamsSchema,
> = DefinePipelineCommandConfigBase<TResult, TSchema> &
  (CanDefaultPipelineCommandOptions<TOptions, TSchema> extends true
    ? {
        /** Override the default same-name flag-to-option mapping. */
        mapOptions?: PipelineCommandMapOptions<TOptions, TSchema>;
      }
    : {
        /** Required when parsed flags do not already satisfy the pipeline's domain options. */
        mapOptions: PipelineCommandMapOptions<TOptions, TSchema>;
      });

const PIPELINE_COMMAND_KEYS = new Set(["continueOnError", "plan", "step", "target"]);
const PIPELINE_COMMAND_FLAGS = new Set(["continue-on-error", "plan", "step", "target"]);

function assertNoPipelineCommandConflicts(params: CliParamsSchema): void {
  for (const [key, param] of Object.entries(params)) {
    if (PIPELINE_COMMAND_KEYS.has(key)) {
      throw new Error(
        `"${key}" is a reserved parameter provided automatically by pipeline commands; remove it from params.`
      );
    }
    const flag = flagName(key, param);
    if (PIPELINE_COMMAND_FLAGS.has(flag)) {
      throw new Error(
        `--${flag} is a reserved flag provided automatically by pipeline commands; remove "${key}" from params or give it a different flag name.`
      );
    }
  }
}

function normalizePipelineCliValues<TSchema extends CliParamsSchema>(
  values: CliParams<PipelineCliBuiltins & TSchema>
): PipelineCliValues<TSchema> {
  // SAFETY: `PipelineCliValues<TSchema>` is `CliParams<TSchema>` plus the builtin
  // `step`/`target`/`continueOnError` keys, all of which `CliParams<PipelineCliBuiltins & TSchema>`
  // already provides, so the runtime shape matches the target type.
  const pipelineValues = values as PipelineCliValues<TSchema>;
  const { continueOnError, step, target } = pipelineValues;
  return {
    ...pipelineValues,
    continueOnError,
    step,
    target: target ?? [],
  };
}

function normalizePipelineHookSets<TResult>(
  hooks: PipelineCommandHookSets<TResult> | undefined
): PipelineHooks<TResult>[] {
  if (!hooks) return [];
  // SAFETY: a non-array `PipelineCommandHookSets` is always a single `PipelineHooks`.
  return Array.isArray(hooks) ? [...hooks] : [hooks as PipelineHooks<TResult>];
}

function isHookConfigFunction<TResult, TSchema extends CliParamsSchema>(
  config: PipelineCommandHookConfig<TResult, TSchema> | undefined
): config is (
  input: PipelineCommandHookContext<TSchema>
) => PipelineCommandHookSets<TResult> | undefined {
  return typeof config === "function";
}

function defaultPipelineCommandOptions<TSchema extends CliParamsSchema>(
  values: PipelineCliValues<TSchema>
): DefaultPipelineCommandOptions<TSchema> {
  const { continueOnError, dryRun, resume, step, target, ...domainValues } = values;
  return domainValues;
}

/** Turn a typed pipeline into a command with selection, plan, and reporting defaults. */
export function definePipelineCommand<
  TOptions extends object,
  TResult,
  const TSchema extends CliParamsSchema = {},
>(
  pipeline: Pipeline<TOptions, TResult>,
  config: DefinePipelineCommandConfig<NoInfer<TOptions>, TResult, TSchema>
): PipelineCommand<TSchema, TResult> {
  // SAFETY: `config.params` is declared as `TSchema`; the empty-object fallback is only
  // reached when the caller omits `params`, which is exactly the `{}` schema case.
  const userParams = config.params ?? ({} as TSchema);
  assertNoPipelineCommandConflicts(userParams);

  const targetFlagEnabled = pipeline.targetIds.length > 0;
  const bridgeParams: CliParamsSchema = {
    step: {
      type: "string",
      multiple: true,
      choices: pipeline.stepIds,
      description: `Run exactly this step. Steps: ${pipeline.stepIds.join(", ")}`,
    },
    continueOnError: {
      type: "boolean",
      description: "Continue independent work after a step fails.",
    },
  };
  if (targetFlagEnabled) {
    bridgeParams.target = {
      type: "string",
      multiple: true,
      choices: pipeline.targetIds,
      description: `Run this declared target and its prerequisites. Targets: ${pipeline.targetIds.join(", ")}`,
    };
  }

  // SAFETY: `bridgeParams` supplies the `PipelineCliBuiltins` keys and `userParams` is
  // `TSchema`, so the merged object satisfies `PipelineCliBuiltins & TSchema`.
  const params = { ...bridgeParams, ...userParams } as PipelineCliBuiltins & TSchema;

  const commandConfig = {
    name: config.name ?? pipeline.id,
    description: config.description,
    params,
    positionals: config.positionals,
    checkpoint: config.checkpoint,
    validate: (values, context) => {
      const pipelineValues = normalizePipelineCliValues<TSchema>(values);
      const errors = config.validate?.(pipelineValues, context) ?? [];
      if (pipelineValues.step.length > 0 && pipelineValues.target.length > 0) {
        return ["--step and --target cannot be used together.", ...errors];
      }
      return errors.length > 0 ? errors : undefined;
    },
    run: async (values, cliContext) => {
      const pipelineValues = normalizePipelineCliValues<TSchema>(values);
      let mapped: TOptions;
      if (config.mapOptions) {
        mapped = await config.mapOptions(pipelineValues, cliContext);
      } else {
        // SAFETY: `defaultPipelineCommandOptions` returns exactly the domain options the
        // `CanDefaultPipelineCommandOptions` constraint guarantees map to `TOptions`.
        mapped = defaultPipelineCommandOptions(pipelineValues) as TOptions;
      }
      const controls: PipelineRunControls = {
        dryRun: values.dryRun,
        continueOnError: pipelineValues.continueOnError,
      };
      if (pipelineValues.step.length > 0) {
        controls.stepIds = pipelineValues.step;
      }
      if (targetFlagEnabled && pipelineValues.target.length > 0) {
        controls.targets = pipelineValues.target;
      }

      const reporter =
        config.reporter === false
          ? undefined
          : createPipelineReporter<TResult>({ log: cliContext.log, ...(config.reporter ?? {}) });
      const runtimeContext = reporter ? { ...cliContext, log: reporter.log } : cliContext;
      let result: TResult;
      try {
        const configuredHooks = isHookConfigFunction(config.hooks)
          ? config.hooks({ context: runtimeContext, values: pipelineValues })
          : config.hooks;
        const hooks: PipelineHooks<TResult>[] = [
          ...normalizePipelineHookSets(cliContext.pipelineContext?.hooks),
          ...(reporter ? [reporter.hooks] : []),
          ...normalizePipelineHookSets(configuredHooks),
        ];

        // SAFETY: `mapped` is `TOptions` and `controls` is `PipelineRunControls`, so the
        // merged object satisfies `PipelineRunOptions<TOptions>`.
        const options = { ...mapped, ...controls } as PipelineRunOptions<TOptions>;
        result = await pipeline.runOrThrow(options, {
          ...cliContext.pipelineContext,
          cwd: runtimeContext.cwd,
          log: runtimeContext.log,
          hooks: hooks.length > 0 ? hooks : undefined,
          signal: runtimeContext.signal,
        });
      } finally {
        reporter?.dispose();
      }
      for (const line of config.summarize?.(result, pipelineValues, cliContext) ?? []) {
        cliContext.log.log(line);
      }
      return result;
    },
  } satisfies CliCommandConfig<PipelineCliBuiltins & TSchema, TResult>;

  const command = createCommand(commandConfig, undefined, {
    validation: TUBELESS_WORKBENCH_EXIT_CODE.validation,
  });

  function parse(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): PipelineCliParseResult<TSchema> {
    const result = command.parse(argv, contextOverrides);
    return result.kind === "values"
      ? { kind: "values", values: normalizePipelineCliValues<TSchema>(result.values) }
      : result;
  }

  function plan(input: PipelineCommandPlanInput = {}): PipelinePlan {
    const controls: PipelineRunControls = {
      dryRun: input.dryRun === true,
    };
    if (input.step && input.step.length > 0) {
      controls.stepIds = input.step;
    }
    if (input.target && input.target.length > 0) {
      controls.targets = input.target;
    }
    return pipeline.plan(controls);
  }

  function parseValues(
    values: Record<string, unknown>,
    contextOverrides?: Partial<CliContext>
  ): PipelineCliParseResult<TSchema> {
    const result = command.parseValues(values, contextOverrides);
    return result.kind === "values"
      ? { kind: "values", values: normalizePipelineCliValues<TSchema>(result.values) }
      : result;
  }

  return markPipelineCommand({
    descriptor: command.descriptor,
    execute: (values, contextOverrides) =>
      // SAFETY: `execute` receives `PipelineCliValues<TSchema>` from the public interface,
      // which is a subtype of `CliParams<PipelineCliBuiltins & TSchema>`.
      command.execute(values as CliParams<PipelineCliBuiltins & TSchema>, contextOverrides),
    parse,
    parseValues,
    plan,
    run: command.run,
    main: command.main,
  });
}
