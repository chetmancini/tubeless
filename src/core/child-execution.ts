import { throwIfAborted } from "../utilities/abort.js";
import { emitRejectedPlanLifecycle } from "./lifecycle.js";
import { runConcurrentSettled } from "../utilities/batch.js";
import { isPipelineCancellation, PipelineExecutionError } from "./pipeline-execute.js";
import type { ToMappedChildStepProgressOptions } from "./mapped-child-progress.js";
import { createRunId, RUN_MODEL_VERSION } from "./pipeline-ids.js";
import { duplicateValues } from "../utilities/collections.js";
import { EXECUTE_COMPILED_RUN, isCompiledPipeline } from "./pipeline-identity.js";
import { createMappedChildProgress, createSingleChildProgress } from "./child-progress.js";
import type {
  Pipeline,
  PipelineContext,
  PipelineExecutionContext,
  PipelineHooks,
  PipelinePlan,
  PipelineRun,
  PipelineRunControls,
  PipelineRunOptions,
  PipelineRuntime,
  PipelineStepContext,
} from "./pipeline-types.js";
import type { PipelineTracingOptions } from "../tracing/tracing-contracts.js";

export class PipelineChildError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
    cause?: unknown,
    readonly fanOut?: {
      failures: readonly { error: Error; key: string; index: number; cancelled: boolean }[];
      failureCount: number;
      schedulerError?: Error;
    }
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PipelineChildError";
  }
}

type ChildPipeline = Pipeline<object, unknown, string, string>;

type CompiledChildExecute = (
  plan: PipelinePlan,
  options: PipelineRunOptions,
  controls: PipelineRunControls,
  context?: Partial<PipelineContext>
) => Promise<PipelineRun<unknown>>;

type ExecutableChild = ChildPipeline & {
  [EXECUTE_COMPILED_RUN]?: CompiledChildExecute;
};

function compiledChildExecute(pipeline: ChildPipeline): CompiledChildExecute | undefined {
  if (!isCompiledPipeline(pipeline)) return undefined;
  // SAFETY: branded pipelines are the `definePipeline` object, which always
  // stamps `EXECUTE_COMPILED_RUN`. Wrappers that inherit the symbol are rejected
  // by the identity check above.
  return (pipeline as ExecutableChild)[EXECUTE_COMPILED_RUN];
}

function executeCompiledChild(
  pipeline: ChildPipeline,
  plan: PipelinePlan,
  domainOptions: PipelineRunOptions,
  controls: PipelineRunControls,
  context: PipelineContext
): Promise<PipelineRun<unknown>> {
  const execute = compiledChildExecute(pipeline);
  if (execute === undefined) {
    return pipeline.run(domainOptions, controls, context);
  }
  return execute(plan, domainOptions, controls, context);
}

function publicChildRuntime(context: PipelineContext): PipelineRuntime {
  const runtime: PipelineRuntime = {
    cwd: context.cwd,
    log: context.log,
    now: context.now ?? Date.now,
    sleep: context.sleep ?? (async () => undefined),
  };
  if (context.correlationId !== undefined) runtime.correlationId = context.correlationId;
  if (context.hooks) runtime.hooks = context.hooks;
  if (context.parentRunId) runtime.parentRunId = context.parentRunId;
  if (context.signal) runtime.signal = context.signal;
  if (context.tracing) runtime.tracing = context.tracing;
  return runtime;
}

async function failedPublicChildPlanRun(
  pipeline: ChildPipeline,
  plan: PipelinePlan,
  controls: PipelineRunControls,
  context: PipelineContext
): Promise<PipelineRun<unknown>> {
  const runtime = publicChildRuntime(context);
  const startedAtMs = runtime.now();
  const result: PipelineRun<unknown> = {
    pipelineId: pipeline.id,
    dryRun: controls.dryRun === true,
    errors: [...plan.errors],
    finalized: false,
    finishedAtMs: runtime.now(),
    runId: createRunId(pipeline.id),
    startedAtMs,
    status: "failed",
    steps: [],
    version: RUN_MODEL_VERSION,
  };
  const correlationId = context.correlationId;
  if (correlationId !== undefined) result.correlationId = correlationId;
  if (context.parentRunId) result.parentRunId = context.parentRunId;
  await emitRejectedPlanLifecycle(pipeline.id, pipeline.targetIds, plan, runtime, result);
  return result;
}

async function rejectedChildPlanResult(
  pipeline: ChildPipeline,
  plan: PipelinePlan,
  domainOptions: PipelineRunOptions,
  controls: PipelineRunControls,
  context: PipelineContext
): Promise<PipelineRun<unknown>> {
  const execute = compiledChildExecute(pipeline);
  if (execute === undefined) {
    return failedPublicChildPlanRun(pipeline, plan, controls, context);
  }
  return execute(plan, domainOptions, controls, context);
}

type ChildInputs = Record<string, unknown>;

export interface SingleChildExecutionConfig<TParentOptions extends object> {
  pipeline: ChildPipeline;
  mapOptions(
    inputs: ChildInputs,
    context: PipelineExecutionContext<TParentOptions>
  ): PipelineRunOptions;
  mapResult?(
    value: unknown,
    result: PipelineRun<unknown>,
    context: PipelineStepContext<TParentOptions>
  ): unknown;
}

export interface MappedChildExecutionConfig<TParentOptions extends object> {
  pipeline: ChildPipeline;
  items(
    inputs: ChildInputs,
    context: PipelineExecutionContext<TParentOptions>
  ): readonly unknown[] | Promise<readonly unknown[]>;
  key(item: unknown, index: number): string;
  concurrency?:
    | number
    | ((inputs: ChildInputs, context: PipelineExecutionContext<TParentOptions>) => number);
  progress?: ToMappedChildStepProgressOptions;
  mapOptions(
    item: unknown,
    index: number,
    inputs: ChildInputs,
    context: PipelineExecutionContext<TParentOptions>
  ): PipelineRunOptions;
  mapResult?(
    value: unknown,
    result: PipelineRun<unknown>,
    item: unknown,
    index: number,
    context: PipelineStepContext<TParentOptions>
  ): unknown;
}

function childTracingOptions(
  context: PipelineExecutionContext<object>,
  itemKey = context.trace?.itemKey
): PipelineTracingOptions | undefined {
  return context.tracing ? { ...context.tracing, itemKey } : undefined;
}

const CHILD_RUN_CONTROL_KEYS = [
  "continueOnError",
  "dryRun",
  "maxConcurrency",
  "stepIds",
  "targets",
] as const;

function isChildRunControlKey(
  property: PropertyKey
): property is (typeof CHILD_RUN_CONTROL_KEYS)[number] {
  return (
    typeof property === "string" &&
    // SAFETY: `includes` membership over the literal tuple guarantees the cast
    // target is exactly one of the declared run-control keys.
    CHILD_RUN_CONTROL_KEYS.includes(property as (typeof CHILD_RUN_CONTROL_KEYS)[number])
  );
}

interface ChildRunBags {
  controls: PipelineRunControls;
  domainOptions: PipelineRunOptions;
}

function splitChildRunOptions(options: PipelineRunOptions): ChildRunBags {
  const controls: PipelineRunControls = {};
  let hasControls = false;
  for (const key of CHILD_RUN_CONTROL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
    hasControls = true;
    Object.assign(controls, { [key]: options[key] });
  }
  if (!hasControls) {
    return { controls, domainOptions: options };
  }
  return { controls, domainOptions: createChildDomainOptionsView(options) };
}

function createChildDomainOptionsView(options: PipelineRunOptions): PipelineRunOptions {
  // SAFETY: proxy an empty facade so hiding non-configurable control keys on a
  // frozen mapOptions bag does not violate proxy invariants. Reads still use
  // `options` as the receiver so accessors and methods keep their original `this`.
  return new Proxy({} as PipelineRunOptions, {
    get(_target, property) {
      if (isChildRunControlKey(property)) return undefined;
      const value = readChildOptionProperty(options, property);
      return value instanceof Function ? value.bind(options) : value;
    },
    has(_target, property) {
      return !isChildRunControlKey(property) && property in options;
    },
    ownKeys() {
      return Reflect.ownKeys(options).filter((property) => !isChildRunControlKey(property));
    },
    getOwnPropertyDescriptor(_target, property) {
      if (isChildRunControlKey(property)) return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(options, property);
      if (descriptor === undefined) return undefined;
      return { ...descriptor, configurable: true };
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(options);
    },
    set(_target, property, value) {
      if (isChildRunControlKey(property)) return true;
      return Reflect.set(options, property, value, options);
    },
  });
}

function readChildOptionProperty(options: PipelineRunOptions, property: PropertyKey): unknown {
  // SAFETY: child mapOptions is an untyped bag; this index reads the requested
  // key on that original object so accessors keep it as `this`.
  return options[property as keyof PipelineRunOptions];
}

function childRunBags(options: PipelineRunOptions, dryRun: boolean): ChildRunBags {
  const { controls, domainOptions } = splitChildRunOptions(options);
  return { controls: { ...controls, dryRun }, domainOptions };
}

function isConcurrencyFunction<TOptions extends object>(
  concurrency:
    | number
    | ((inputs: ChildInputs, context: PipelineExecutionContext<TOptions>) => number)
    | undefined
): concurrency is (inputs: ChildInputs, context: PipelineExecutionContext<TOptions>) => number {
  return typeof concurrency === "function";
}

function firstChildFailure(result: PipelineRun<unknown>) {
  const firstFailedStep = result.steps.find(
    ({ status }) => status === "failed" || status === "cancelled"
  );
  const firstError =
    firstFailedStep && "error" in firstFailedStep ? firstFailedStep.error : result.errors[0];
  return {
    failureLocation: firstFailedStep?.id ?? firstError?.stepId ?? "unknown step",
    message: firstError?.message ?? "unknown error",
  };
}

async function runChildPipeline(
  pipeline: ChildPipeline,
  domainOptions: PipelineRunOptions,
  controls: PipelineRunControls,
  context: PipelineContext,
  hooks: PipelineHooks,
  messagePrefix = "",
  plan: PipelinePlan
): Promise<PipelineRun<unknown>> {
  if (!plan.ok) {
    const firstError = plan.errors[0];
    const result = await rejectedChildPlanResult(pipeline, plan, domainOptions, controls, {
      ...context,
      hooks,
    });
    throw new PipelineExecutionError(
      result,
      `${messagePrefix}could not start: ${firstError?.message ?? "invalid plan"}`
    );
  }

  const result = await executeCompiledChild(pipeline, plan, domainOptions, controls, {
    ...context,
    hooks,
  });
  if (result.status !== "completed") {
    const { failureLocation, message } = firstChildFailure(result);
    throw new PipelineExecutionError(
      result,
      `${messagePrefix}failed at ${failureLocation}: ${message}`
    );
  }
  return result;
}

function hasProgressObserver(context: PipelineContext): boolean {
  const hooks = Array.isArray(context.hooks) ? context.hooks : [context.hooks];
  return (
    Boolean(context.tracing) || hooks.some((hook) => hook?.onStepProgress || hook?.onStepStatus)
  );
}

export function createSingleChildRunner<TParentOptions extends object>(
  config: SingleChildExecutionConfig<TParentOptions>
): (inputs: ChildInputs, context: PipelineStepContext<TParentOptions>) => Promise<unknown> {
  return async (inputs, context) => {
    const { controls, domainOptions } = childRunBags(
      config.mapOptions(inputs, context),
      context.dryRun
    );
    const baseChildContext: PipelineContext = {
      correlationId: context.correlationId,
      cwd: context.cwd,
      log: context.log,
      now: context.now,
      parentRunId: context.runId,
      signal: context.signal,
      sleep: context.sleep,
      tracing: childTracingOptions(context),
    };
    // Plan once for progress totals and execution. Invalid plans fail before child.run.
    const childPlan = config.pipeline.plan(controls);
    const childHooks = hasProgressObserver(context)
      ? createSingleChildProgress(childPlan, context.reportProgress)
      : {};
    const childResult = await runChildPipeline(
      config.pipeline,
      domainOptions,
      controls,
      baseChildContext,
      childHooks,
      `Child pipeline ${config.pipeline.id} `,
      childPlan
    );

    return config.mapResult
      ? config.mapResult(childResult.value, childResult, context)
      : childResult.value;
  };
}

export function createMappedChildRunner<TParentOptions extends object>(
  config: MappedChildExecutionConfig<TParentOptions>
): (inputs: ChildInputs, context: PipelineStepContext<TParentOptions>) => Promise<unknown[]> {
  return async (inputs, context) => {
    const items = [...(await config.items(inputs, context))];
    const keys = items.map((item, index) => config.key(item, index));
    const duplicateKeys = duplicateValues(keys);
    if (duplicateKeys.length > 0) {
      throw new PipelineChildError(
        `Mapped child pipeline ${config.pipeline.id} received duplicate item keys: ${duplicateKeys.join(", ")}`
      );
    }
    const concurrency = Math.max(
      1,
      isConcurrencyFunction(config.concurrency)
        ? config.concurrency(inputs, context)
        : (config.concurrency ?? 1)
    );
    type Outcome =
      | { key: string; ok: true; value: unknown }
      | { error: Error; key: string; index: number; ok: false };

    const progress = hasProgressObserver(context)
      ? createMappedChildProgress(keys, concurrency, config.progress, context.reportProgress)
      : undefined;
    progress?.publish();
    if (items.length === 0) return [];

    const settled = await runConcurrentSettled(
      items,
      { concurrency, signal: context.signal },
      async (item, itemIndex): Promise<Outcome> => {
        const key = keys[itemIndex]!;
        progress?.start(key);
        try {
          throwIfAborted(context.signal, `Mapped child pipeline ${config.pipeline.id}`);
          const { controls, domainOptions } = childRunBags(
            config.mapOptions(item, itemIndex, inputs, context),
            context.dryRun
          );
          // Plan once per mapped-options bag for progress and execution.
          const childPlan = config.pipeline.plan(controls);
          const childHooks = progress?.plan(key, childPlan) ?? {};
          const childResult = await runChildPipeline(
            config.pipeline,
            domainOptions,
            controls,
            {
              correlationId: context.correlationId,
              cwd: context.cwd,
              log: context.log,
              now: context.now,
              parentRunId: context.runId,
              signal: context.signal,
              sleep: context.sleep,
              tracing: childTracingOptions(context, key),
            },
            childHooks,
            "",
            childPlan
          );

          progress?.childCompleted(key);

          const value = config.mapResult
            ? config.mapResult(childResult.value, childResult, item, itemIndex, context)
            : childResult.value;
          progress?.complete(key);
          return { key, ok: true, value };
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error));
          progress?.fail(key, cause, isPipelineCancellation(cause, context));
          return { error: cause, key, index: itemIndex, ok: false };
        }
      }
    );

    progress?.finish();
    const outcomes = settled.results.filter((outcome): outcome is Outcome => outcome !== undefined);
    const schedulerFailure =
      settled.failure === undefined
        ? undefined
        : settled.failure instanceof Error
          ? settled.failure
          : new Error(String(settled.failure));

    const failures = outcomes.filter(
      (outcome): outcome is Extract<Outcome, { ok: false }> => !outcome.ok
    );
    if (failures.length > 0 || schedulerFailure !== undefined) {
      const details = failures.map(({ error, key }) => `${key}: ${error.message}`).join("; ");
      const cancelled =
        failures.every(({ error }) => isPipelineCancellation(error, context)) &&
        (schedulerFailure === undefined || isPipelineCancellation(schedulerFailure, context));
      const primaryError = cancelled
        ? (failures[0]?.error ?? schedulerFailure)
        : (failures.find(({ error }) => !isPipelineCancellation(error, context))?.error ??
          failures[0]?.error ??
          schedulerFailure);
      const message =
        failures.length > 0
          ? `Mapped child pipeline ${config.pipeline.id} failed for ${failures.length} item(s): ${details}`
          : `Mapped child pipeline ${config.pipeline.id} failed: ${primaryError?.message ?? "aborted"}`;
      throw new PipelineChildError(message, cancelled, primaryError, {
        failures: failures.slice(0, 32).map(({ error, key, index }) => ({
          error,
          key,
          index,
          cancelled: isPipelineCancellation(error, context),
        })),
        failureCount: failures.length,
        schedulerError: schedulerFailure,
      });
    }
    // SAFETY: when failures.length === 0 every outcome was produced by the
    // success branch (return { key, ok: true, value }), so each outcome is
    // necessarily `{ ok: true }`; the assertion narrows the union accordingly.
    return outcomes.map((outcome) => (outcome as Extract<Outcome, { ok: true }>).value);
  };
}
