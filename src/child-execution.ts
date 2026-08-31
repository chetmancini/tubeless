import { throwIfAborted } from "./abort.js";
import { runConcurrent } from "./batch.js";
import {
  toMappedChildStepProgress,
  type MappedChildProgressSnapshot,
  type ToMappedChildStepProgressOptions,
} from "./mapped-child-progress.js";
import { duplicateValues, EXECUTE_COMPILED_RUN } from "./pipeline-plan.js";
import { hasVisibleStepProgress } from "./progress.js";
import type {
  Pipeline,
  PipelineContext,
  PipelineExecutionContext,
  PipelineHooks,
  PipelinePlan,
  PipelinePlanStep,
  PipelineRun,
  PipelineRunControls,
  PipelineRunOptions,
  PipelineStepContext,
} from "./pipeline-types.js";
import type { PipelineTracingOptions } from "./tracing.js";

export class PipelineChildError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PipelineChildError";
  }
}

type ChildPipeline = Pipeline<object, unknown, string, string>;

type ExecutableChild = ChildPipeline & {
  [EXECUTE_COMPILED_RUN]: (
    plan: PipelinePlan,
    options: PipelineRunOptions,
    controls: PipelineRunControls,
    context?: Partial<PipelineContext>
  ) => Promise<PipelineRun<unknown>>;
};

function executeCompiledChild(
  pipeline: ChildPipeline,
  plan: PipelinePlan,
  domainOptions: PipelineRunOptions,
  controls: PipelineRunControls,
  context: PipelineContext
): Promise<PipelineRun<unknown>> {
  // SAFETY: `definePipeline` stamps `EXECUTE_COMPILED_RUN` onto every returned
  // pipeline object; child runners only receive those compiled pipelines.
  return (pipeline as ExecutableChild)[EXECUTE_COMPILED_RUN](
    plan,
    domainOptions,
    controls,
    context
  );
}

type ChildInputs = Record<string, unknown>;

interface ChildExecutionDependencies<TParentOptions extends object> {
  createExecutionError(result: PipelineRun<unknown>, message: string): Error;
  isCancellation(cause: unknown, context: PipelineExecutionContext<TParentOptions>): boolean;
}

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

const CHILD_RUN_CONTROL_KEYS = ["continueOnError", "dryRun", "stepIds", "targets"] as const;

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
  dependencies: ChildExecutionDependencies<object>,
  messagePrefix = "",
  plan: PipelinePlan
): Promise<PipelineRun<unknown>> {

  if (!plan.ok) {
    const firstError = plan.errors[0];
    const result = await executeCompiledChild(
      pipeline,
      plan,
      domainOptions,
      controls,
      context
    );
    throw dependencies.createExecutionError(
      result,
      `${messagePrefix}could not start: ${firstError?.message ?? "invalid plan"}`
    );
  }

  const result = await executeCompiledChild(
    pipeline,
    plan,
    domainOptions,
    controls,
    { ...context, hooks }
  );
  if (result.status !== "completed") {
    const { failureLocation, message } = firstChildFailure(result);
    throw dependencies.createExecutionError(
      result,
      `${messagePrefix}failed at ${failureLocation}: ${message}`
    );
  }
  return result;
}

export function createSingleChildRunner<TParentOptions extends object>(
  config: SingleChildExecutionConfig<TParentOptions>,
  dependencies: ChildExecutionDependencies<TParentOptions>
): (inputs: ChildInputs, context: PipelineStepContext<TParentOptions>) => Promise<unknown> {
  return async (inputs, context) => {
    const { controls, domainOptions } = childRunBags(
      config.mapOptions(inputs, context),
      context.dryRun
    );
    const baseChildContext: PipelineContext = {
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
    const selectedStepCount = childPlan.ok
      ? childPlan.steps.filter((step) => step.selected).length
      : 0;
    const terminalSteps = new Set<string>();
    const report = (step: PipelinePlanStep, message: string, terminal = false): void => {
      if (terminal) terminalSteps.add(step.id);
      context.reportProgress({
        completed: terminalSteps.size,
        total: Math.max(1, selectedStepCount),
        message: `${config.pipeline.id}/${step.name ?? step.id}: ${message}`,
      });
    };
    const childHooks: PipelineHooks = {
      onStepStart: ({ step }) => report(step, "started"),
      onStepProgress: ({ progress, step }) => {
        if (!hasVisibleStepProgress(progress)) return;
        report(step, progress.message ?? `${progress.completed} completed`);
      },
      onStepComplete: ({ step }) => report(step, "complete", true),
      onStepSkip: ({ reason, step }) => report(step, `skipped: ${reason}`, reason !== "filtered"),
      onStepCancel: ({ error, step }) => report(step, `cancelled: ${error.message}`, true),
      onStepFail: ({ error, step }) => report(step, `failed: ${error.message}`, true),
    };
    const childResult = await runChildPipeline(
      config.pipeline,
      domainOptions,
      controls,
      baseChildContext,
      childHooks,
      dependencies,
      `Child pipeline ${config.pipeline.id} `,
      childPlan

[Showing lines 1-300 of 492. Use :301 to continue]