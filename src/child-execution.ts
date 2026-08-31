import { throwIfAborted } from "./abort.js";
import { runConcurrent } from "./batch.js";
import {
  toMappedChildStepProgress,
  type MappedChildProgressSnapshot,
  type ToMappedChildStepProgressOptions,
} from "./mapped-child-progress.js";
import { createRunId, RUN_MODEL_VERSION } from "./pipeline-ids.js";
import { hasVisibleStepProgress } from "./progress.js";
import type {
  Pipeline,
  PipelineContext,
  PipelineError,
  PipelineExecutionContext,
  PipelineHooks,
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

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
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
  // SAFETY: the view forwards to `options` with that object as the receiver, so
  // accessors and methods keep their original `this` after control keys are hidden.
  return new Proxy(options, {
    get(target, property) {
      if (isChildRunControlKey(property)) return undefined;
      const value = readChildOptionProperty(target, property);
      return value instanceof Function ? value.bind(target) : value;
    },
    has(target, property) {
      return !isChildRunControlKey(property) && Reflect.has(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((property) => !isChildRunControlKey(property));
    },
    getOwnPropertyDescriptor(target, property) {
      if (isChildRunControlKey(property)) return undefined;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    set(target, property, value) {
      if (isChildRunControlKey(property)) return true;
      return Reflect.set(target, property, value, target);
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

function failedPlanRun(
  pipeline: ChildPipeline,
  controls: PipelineRunControls,
  context: PipelineContext,
  errors: readonly PipelineError[]
): PipelineRun<unknown> {
  const now = context.now ?? Date.now;
  const startedAtMs = now();
  const result: PipelineRun<unknown> = {
    pipelineId: pipeline.id,
    dryRun: controls.dryRun === true,
    errors: [...errors],
    finalized: false,
    finishedAtMs: now(),
    runId: context.runId ?? createRunId(pipeline.id),
    startedAtMs,
    status: "failed",
    steps: [],
    version: RUN_MODEL_VERSION,
  };
  if (context.parentRunId) result.parentRunId = context.parentRunId;
  return result;
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
  messagePrefix = ""
): Promise<PipelineRun<unknown>> {
  const plan = pipeline.plan(controls);
  if (!plan.ok) {
    const firstError = plan.errors[0];
    const result = failedPlanRun(pipeline, controls, context, plan.errors);
    throw dependencies.createExecutionError(
      result,
      `${messagePrefix}could not start: ${firstError?.message ?? "invalid plan"}`
    );
  }

  const result = await pipeline.run(domainOptions, controls, { ...context, hooks });
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
    // Preview plan only for progress totals; invalid plans throw from runChildPipeline.
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
      `Child pipeline ${config.pipeline.id} `
    );

    return config.mapResult
      ? config.mapResult(childResult.value, childResult, context)
      : childResult.value;
  };
}

export function createMappedChildRunner<TParentOptions extends object>(
  config: MappedChildExecutionConfig<TParentOptions>,
  dependencies: ChildExecutionDependencies<TParentOptions>
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
      | { error: Error; key: string; ok: false };

    const active = new Map<string, string>();
    const childTerminalSteps = new Map<string, Set<string>>();
    let finishedItems = 0;
    let failedItems = 0;
    let stepsPerItem = 0;
    let plannedChildSteps = 0;
    let plannedItems = 0;
    let terminalChildSteps = 0;

    const publishProgress = (spotlight?: string): void => {
      const snapshot: MappedChildProgressSnapshot = {
        active,
        concurrency,
        failedItems,
        finishedItems,
        itemCount: items.length,
        plannedChildSteps,
        plannedItems,
        stepsPerItem,
        terminalChildSteps,
        spotlight,
      };
      context.reportProgress(toMappedChildStepProgress(snapshot, config.progress));
    };
    const markChildTerminal = (itemKey: string, stepId: string, label: string): void => {
      let seen = childTerminalSteps.get(itemKey);
      if (!seen) {
        seen = new Set();
        childTerminalSteps.set(itemKey, seen);
      }
      if (!seen.has(stepId)) {
        seen.add(stepId);
        terminalChildSteps += 1;
      }
      active.set(itemKey, label);
      publishProgress();
    };

    if (items.length === 0) {
      publishProgress();
      return [];
    }
    publishProgress();

    const outcomes = await runConcurrent(
      items,
      { concurrency, signal: context.signal },
      async (item, itemIndex): Promise<Outcome> => {
        const key = keys[itemIndex]!;
        active.set(key, "starting");
        publishProgress();
        try {
          throwIfAborted(context.signal, `Mapped child pipeline ${config.pipeline.id}`);
          const { controls, domainOptions } = childRunBags(
            config.mapOptions(item, itemIndex, inputs, context),
            context.dryRun
          );
          // Preview plan for live fan-out progress; invalid plans throw from runChildPipeline.
          const childPlan = config.pipeline.plan(controls);
          if (childPlan.ok) {
            const plannedSteps = childPlan.steps.filter((step) => step.selected).length;
            plannedChildSteps += plannedSteps;
            plannedItems += 1;
            if (plannedSteps > stepsPerItem) stepsPerItem = plannedSteps;
          }

          const childHooks: PipelineHooks = {
            onStepStart: ({ step }) => {
              active.set(key, step.name ?? step.id);
              publishProgress();
            },
            onStepProgress: ({ progress, step }) => {
              if (!hasVisibleStepProgress(progress)) return;
              const detail =
                progress.message ??
                (progress.total !== undefined
                  ? `${progress.completed}/${progress.total}`
                  : `${progress.completed}`);
              active.set(key, `${step.name ?? step.id}:${detail}`);
              publishProgress();
            },
            onStepComplete: ({ step }) =>
              markChildTerminal(key, step.id, `${step.name ?? step.id}:complete`),
            onStepSkip: ({ reason, step }) => {
              if (reason === "filtered") return;
              markChildTerminal(key, step.id, `${step.name ?? step.id}:skipped:${reason}`);
            },
            onStepCancel: ({ step }) =>
              markChildTerminal(key, step.id, `${step.name ?? step.id}:cancelled`),
            onStepFail: ({ step }) =>
              markChildTerminal(key, step.id, `${step.name ?? step.id}:failed`),
          };
          const childResult = await runChildPipeline(
            config.pipeline,
            domainOptions,
            controls,
            {
              cwd: context.cwd,
              log: context.log,
              now: context.now,
              parentRunId: context.runId,
              signal: context.signal,
              sleep: context.sleep,
              tracing: childTracingOptions(context, key),
            },
            childHooks,
            dependencies
          );

          const seen = childTerminalSteps.get(key) ?? new Set<string>();
          if (childPlan.ok) {
            for (const planStep of childPlan.steps) {
              if (!planStep.selected || seen.has(planStep.id)) continue;
              seen.add(planStep.id);
              terminalChildSteps += 1;
            }
          }
          childTerminalSteps.set(key, seen);

          const value = config.mapResult
            ? config.mapResult(childResult.value, childResult, item, itemIndex, context)
            : childResult.value;
          active.delete(key);
          finishedItems += 1;
          publishProgress(`${key}: completed`);
          return { key, ok: true, value };
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error));
          active.delete(key);
          failedItems += 1;
          publishProgress(`${key}: failed`);
          return { error: cause, key, ok: false };
        }
      }
    );

    const failures = outcomes.filter(
      (outcome): outcome is Extract<Outcome, { ok: false }> => !outcome.ok
    );
    if (failures.length > 0) {
      const details = failures.map(({ error, key }) => `${key}: ${error.message}`).join("; ");
      const cancelled = failures.every(({ error }) => dependencies.isCancellation(error, context));
      const primaryFailure = cancelled
        ? failures[0]
        : (failures.find(({ error }) => !dependencies.isCancellation(error, context)) ??
          failures[0]);
      throw new PipelineChildError(
        `Mapped child pipeline ${config.pipeline.id} failed for ${failures.length} item(s): ${details}`,
        cancelled,
        primaryFailure?.error
      );
    }
    // SAFETY: when failures.length === 0 every outcome was produced by the
    // success branch (return { key, ok: true, value }), so each outcome is
    // necessarily `{ ok: true }`; the assertion narrows the union accordingly.
    return outcomes.map((outcome) => (outcome as Extract<Outcome, { ok: true }>).value);
  };
}
