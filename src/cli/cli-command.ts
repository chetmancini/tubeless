import * as path from "path";
import { openCheckpoint, type CheckpointStore } from "../node/checkpoint.js";
import {
  assertNoDuplicateFlags,
  assertValidEnvironmentFallbacks,
  assertValidMultipleParams,
  assertValidPositionals,
  buildEffectiveSchema,
  commandDescriptor,
  renderHelp,
  resolveParam,
  tokenize,
  type ResolvedParamValue,
} from "./cli-parser.js";
import {
  CliHelpRequested,
  CliValidationError,
  type CliCommand,
  type CliCommandConfig,
  type CliContext,
  type CliParams,
  type CliParamsSchema,
  type CliParseResult,
} from "./cli-types.js";
import {
  cliValidationReportLines,
  isCliValidationError,
  isPipelineExecutionError,
  toExitCode,
} from "./cli-exit.js";
import { onFirstProcessSignal } from "./cli-signal.js";

function resolveContext(overrides?: Partial<CliContext>): CliContext {
  return {
    cwd: overrides?.cwd ?? process.cwd(),
    env: overrides?.env ?? process.env,
    log: overrides?.log ?? console,
    reporterOutput: overrides?.reporterOutput,
    pipelineContext: overrides?.pipelineContext,
    signal: overrides?.signal,
    checkpoint: overrides?.checkpoint,
  };
}

interface ManagedMainSignal {
  context: CliContext;
  /** Conventional exit code for the signal that interrupted the run, if any. */
  exitCode(): number | undefined;
  wasInterrupted(): boolean;
  cleanup(): void;
}

/** Conventional 128 + signal number exit codes. */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Give real CLI entrypoints graceful cancellation without making `run()` or
 * `parse()` mutate process-global signal handlers. Embedded callers can pass
 * their own signal through the context instead.
 */
function manageMainSignal(context: CliContext): ManagedMainSignal {
  if (context.signal) {
    return { context, exitCode: () => undefined, wasInterrupted: () => false, cleanup: () => {} };
  }

  const controller = new AbortController();
  let interruptedBy: keyof typeof SIGNAL_EXIT_CODES | undefined;
  const cleanup = onFirstProcessSignal(["SIGINT", "SIGTERM"], (signal) => {
    interruptedBy = signal as keyof typeof SIGNAL_EXIT_CODES;
    context.log.warn(`${signal} received; cancelling pipeline work.`);
    controller.abort();
  });

  return {
    context: { ...context, signal: controller.signal },
    exitCode: () => (interruptedBy ? SIGNAL_EXIT_CODES[interruptedBy] : undefined),
    wasInterrupted: () => interruptedBy !== undefined,
    cleanup,
  };
}

function inMemoryCheckpointView(seed: ReadonlyMap<string, unknown>): CheckpointStore {
  const entries = new Map(seed);
  return {
    has: (key) => entries.has(key),
    record: (key, meta) => {
      entries.set(key, meta);
    },
    entries: () => entries,
    flush: () => {},
    clear: () => {
      entries.clear();
    },
  };
}

export function createCommand<const TSchema extends CliParamsSchema, TResult = void>(
  config: CliCommandConfig<TSchema, TResult>,
  mainExits?: { validation?: number }
): CliCommand<TSchema, TResult> {
  const effectiveParams = buildEffectiveSchema(config.params, config.checkpoint, config.resume);
  assertNoDuplicateFlags(effectiveParams);
  assertValidMultipleParams(effectiveParams);
  assertValidEnvironmentFallbacks(effectiveParams);
  const positionals = [...(config.positionals ?? [])];
  assertValidPositionals(positionals, effectiveParams);
  const descriptor = commandDescriptor(config, effectiveParams, positionals);

  function resolveValues(
    readValue: (key: string, param: CliParamsSchema[string]) => unknown,
    context: CliContext,
    errors: string[],
    helpText: string,
    input: "argv" | "structured" = "argv"
  ): CliParseResult<TSchema> {
    const values: Record<string, ResolvedParamValue> = { resume: false };
    for (const [key, param] of Object.entries(effectiveParams)) {
      const errorCount = errors.length;
      const raw = readValue(key, param);
      if (errors.length > errorCount) continue;
      const envValue = raw === undefined && param.env ? context.env?.[param.env] : undefined;
      const resolutionSource =
        raw !== undefined
          ? input === "structured"
            ? "structured"
            : "argv"
          : envValue !== undefined
            ? "env"
            : "default";
      Object.defineProperty(values, key, {
        value: resolveParam(key, param, raw ?? envValue, context.cwd, errors, resolutionSource),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (errors.length > 0) return { kind: "error", errors, helpText };
    // SAFETY: resolveParam populated every effective schema key and all input checks passed.
    const typedValues = values as CliParams<TSchema>;
    const validationErrors = config.validate?.(typedValues, context) ?? [];
    return validationErrors.length > 0
      ? { kind: "error", errors: validationErrors, helpText }
      : { kind: "values", values: typedValues };
  }

  function parseWithContext(argv: readonly string[], context: CliContext): CliParseResult<TSchema> {
    const helpText = renderHelp(
      descriptor.name,
      descriptor.description,
      effectiveParams,
      positionals
    );
    const tokenized = tokenize(argv, effectiveParams, positionals);
    if (tokenized.help) return { kind: "help", helpText };
    return resolveValues(
      (key) => tokenized.values.get(key),
      context,
      [...tokenized.errors],
      helpText
    );
  }

  function parse(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): CliParseResult<TSchema> {
    return parseWithContext(argv, resolveContext(contextOverrides));
  }

  function parseStructuredWithContext(
    structuredValues: Record<string, unknown>,
    context: CliContext
  ): CliParseResult<TSchema> {
    const helpText = renderHelp(
      descriptor.name,
      descriptor.description,
      effectiveParams,
      positionals
    );
    const errors: string[] = [];
    for (const key of Object.keys(structuredValues)) {
      if (!Object.prototype.hasOwnProperty.call(effectiveParams, key)) {
        errors.push(`Unknown parameter: ${key}`);
      }
    }
    return resolveValues(
      (key) => (Object.hasOwn(structuredValues, key) ? structuredValues[key] : undefined),
      context,
      errors,
      helpText,
      "structured"
    );
  }

  function attachCheckpoint(context: CliContext, values: CliParams<TSchema>): CliContext {
    const checkpointConfig = config.checkpoint;
    if (!checkpointConfig) {
      return context;
    }
    const resolvedPath = path.isAbsolute(checkpointConfig.path)
      ? checkpointConfig.path
      : path.join(context.cwd, checkpointConfig.path);
    const store = context.checkpoint ?? openCheckpoint(resolvedPath);
    const hadExisting = store.entries().size > 0;

    if (values.resume) {
      if (hadExisting) {
        context.log.log(
          `Resuming from checkpoint: ${store.entries().size} item(s) already recorded.`
        );
      } else {
        context.log.warn(
          `--resume was passed, but no checkpoint was found at ${resolvedPath}; starting fresh.`
        );
      }
    } else if (hadExisting) {
      if (values.dryRun) {
        context.log.log("Dry run: leaving existing checkpoint untouched (would start fresh).");
      } else {
        store.clear();
        context.log.log("Starting fresh — cleared existing checkpoint.");
      }
    }

    const checkpoint = values.dryRun
      ? inMemoryCheckpointView(!values.resume && hadExisting ? new Map() : store.entries())
      : store;
    return { ...context, checkpoint };
  }

  /**
   * No-op unless `config.checkpoint` is set, a store is attached, and the run completed
   * without a dry run or caller cancellation.
   */
  function finalizeCheckpoint(context: CliContext, values: CliParams<TSchema>): void {
    const checkpointConfig = config.checkpoint;
    if (!checkpointConfig || !context.checkpoint || values.dryRun || context.signal?.aborted) {
      return;
    }
    if (checkpointConfig.clearOnSuccess === false) {
      return;
    }
    context.checkpoint.clear();
  }

  async function executeValues(values: CliParams<TSchema>, context: CliContext): Promise<TResult> {
    const runContext = attachCheckpoint(context, values);
    const value = await config.run(values, runContext);
    finalizeCheckpoint(runContext, values);
    return value;
  }

  function parseValues(
    values: Record<string, unknown>,
    contextOverrides?: Partial<CliContext>
  ): CliParseResult<TSchema> {
    const context = resolveContext(contextOverrides);
    return parseStructuredWithContext(values, context);
  }

  async function execute(
    values: CliParams<TSchema>,
    contextOverrides?: Partial<CliContext>
  ): Promise<TResult> {
    return executeValues(values, resolveContext(contextOverrides));
  }

  async function run(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): Promise<TResult> {
    const context = resolveContext(contextOverrides);
    const result = parseWithContext(argv, context);
    if (result.kind === "help") throw new CliHelpRequested(result.helpText);
    if (result.kind === "error") throw new CliValidationError(result.errors, result.helpText);
    return executeValues(result.values, context);
  }

  async function main(
    argv: readonly string[] = process.argv.slice(2),
    contextOverrides?: Partial<CliContext>
  ): Promise<void> {
    const context = resolveContext(contextOverrides);
    let result: CliParseResult<TSchema>;
    try {
      result = parseWithContext(argv, context);
    } catch (error) {
      context.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode =
        mainExits || isCliValidationError(error) || isPipelineExecutionError(error)
          ? toExitCode(error)
          : 1;
      return;
    }
    if (result.kind === "help") {
      context.log.log(result.helpText);
      process.exitCode = 0;
      return;
    }
    if (result.kind === "error") {
      for (const line of cliValidationReportLines(result.errors, result.helpText)) {
        context.log.error(line);
      }
      process.exitCode = mainExits?.validation ?? 1;
      return;
    }
    const managedSignal = manageMainSignal(context);
    try {
      const runContext = attachCheckpoint(managedSignal.context, result.values);
      await config.run(result.values, runContext);
      if (!managedSignal.wasInterrupted()) {
        finalizeCheckpoint(runContext, result.values);
      }
    } catch (error) {
      context.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = managedSignal.wasInterrupted()
        ? managedSignal.exitCode()
        : mainExits || isCliValidationError(error) || isPipelineExecutionError(error)
          ? toExitCode(error)
          : 1;
    } finally {
      if (managedSignal.wasInterrupted()) {
        process.exitCode = managedSignal.exitCode();
      }
      managedSignal.cleanup();
    }
  }

  return { descriptor, execute, parse, parseValues, run, main };
}

/** Create a typed command from a declarative parameter schema and run handler. */
export function defineCommand<const TSchema extends CliParamsSchema, TResult = void>(
  config: CliCommandConfig<TSchema, TResult>
): CliCommand<TSchema, TResult> {
  return createCommand(config);
}
