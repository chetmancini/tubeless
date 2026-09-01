import { describe, expect, it } from "vitest";
import {
  createSteps,
  definePipeline,
  PIPELINE_FINALIZE_STEP_ID,
  PipelineDefinitionError,
  requireOutputs,
  type AnyStep,
  type PipelineError,
  type PipelineErrorCode,
  type PipelineErrorKind,
  type PipelineErrorPhase,
  type StandardSchemaV1,
} from "./pipeline.js";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"],
  vendor = "test"
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor, version: 1 } };
}

function firstError(errors: readonly PipelineError[] | undefined): PipelineError {
  const error = errors?.[0];
  if (!error) throw new Error("expected a pipeline diagnostic");
  return error;
}

function definitionError(define: () => unknown): PipelineError {
  try {
    define();
  } catch (error) {
    if (error instanceof PipelineDefinitionError) return firstError(error.errors);
    throw error;
  }
  throw new Error("expected PipelineDefinitionError");
}

function selectionPipeline() {
  const step = createSteps();
  const build = step("build", { run: () => "built" });
  const write = step("write", { dependsOn: [build], run: () => "written" });
  return definePipeline({
    id: "codes",
    steps: [build, write],
    targets: [write],
    finalize: () => undefined,
  });
}

type DiagnosticContract = {
  phase: PipelineErrorPhase;
  kind: PipelineErrorKind;
  emit: () => PipelineError | Promise<PipelineError>;
};

const PIPELINE_ERROR_CODE_CONTRACTS = {
  TUBELESS_CHILD_FAILED: {
    phase: "execution",
    kind: "child",
    emit: async () => {
      const childStep = createSteps();
      const explode = childStep("explode", {
        run: () => {
          throw new Error("database unavailable");
        },
      });
      const child = definePipeline({
        id: "failing-child",
        steps: [explode],
        finalize: () => "unreachable",
      });
      const parentStep = createSteps();
      const stage = parentStep.fromPipeline("child-stage", {
        pipeline: child,
        mapOptions: () => ({}),
      });
      const parent = definePipeline({
        id: "failure-parent",
        steps: [stage],
        finalize: () => "parent-result",
      });
      return firstError((await parent.run({})).errors);
    },
  },
  TUBELESS_DEFINITION_DEPENDENCY_CONTRADICTORY: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const source = step("source", { run: () => "source" });
      const contradictory = step("contradictory", {
        dependsOn: [source],
        optionalDependsOn: [source],
        run: () => "unreachable",
      });
      return definitionError(() =>
        definePipeline({
          id: "contradictory",
          steps: [source, contradictory],
          finalize: () => undefined,
        })
      );
    },
  },
  TUBELESS_DEFINITION_DEPENDENCY_CYCLE: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const a: AnyStep<object> = { id: "a", run: () => "a" };
      const b: AnyStep<object> = { id: "b", dependsOn: [a], run: () => "b" };
      (a as { dependsOn?: readonly AnyStep[] }).dependsOn = [b];
      return definitionError(() =>
        definePipeline({ id: "cyclic", steps: [a, b], finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_DEPENDENCY_DUPLICATE: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const source = step("source", { run: () => "source" });
      const repeated = step("repeated", {
        dependsOn: [source, source],
        run: () => "unreachable",
      });
      return definitionError(() =>
        definePipeline({
          id: "duplicate-dependency",
          steps: [source, repeated],
          finalize: () => undefined,
        })
      );
    },
  },
  TUBELESS_DEFINITION_DEPENDENCY_NOT_IN_STEPS: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const build = step("build", { run: () => "built" });
      const write = step("write", { dependsOn: [build], run: () => "written" });
      return definitionError(() =>
        definePipeline({ id: "missing-from-list", steps: [write], finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_DEPENDENCY_SELF_REFERENCE: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const loop = step("loop", { run: () => "loop" });
      (loop as { dependsOn?: readonly AnyStep[] }).dependsOn = [loop];
      return definitionError(() =>
        definePipeline({ id: "self-reference", steps: [loop], finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const included = step("included", { run: () => true });
      const foreign = step("foreign", { run: () => true });
      return definitionError(() =>
        definePipeline({
          id: "foreign-finalizer-output",
          steps: [included],
          // @ts-expect-error Required finalizer steps must be in the pipeline.
          finalize: requireOutputs([foreign], ({ foreign }) => foreign),
        })
      );
    },
  },
  TUBELESS_DEFINITION_OPTIONS_SCHEMA_CONFLICT: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const schemaA = standardSchema<object, object>((value) => ({ value: value as object }), "a");
      const schemaB = standardSchema<object, object>((value) => ({ value: value as object }), "b");
      const first = createSteps(schemaA)("first", { run: () => 1 });
      const second = createSteps(schemaB)("second", { run: () => 2 });
      return definitionError(() =>
        definePipeline({
          id: "mixed-options-schemas",
          steps: [first, second],
          finalize: () => undefined,
        })
      );
    },
  },
  TUBELESS_DEFINITION_PIPELINE_ID_BLANK: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const only = step("only", { run: () => true });
      return definitionError(() =>
        definePipeline({ id: " ", steps: [only], finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_STEP_ID_BLANK: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const blank: AnyStep<object> = { id: " ", run: () => true };
      return definitionError(() =>
        definePipeline({ id: "blank-step-id", steps: [blank], finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_STEP_ID_RESERVED: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const reserved = step(PIPELINE_FINALIZE_STEP_ID, { run: () => undefined });
      return definitionError(() =>
        definePipeline({ id: "reserved", steps: [reserved], finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_STEP_IDS_DUPLICATE: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const duplicate = step("build", { run: () => "a" });
      const dynamicSteps: readonly AnyStep<object>[] = [duplicate, duplicate];
      return definitionError(() =>
        definePipeline({ id: "test", steps: dynamicSteps, finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_STEP_NAME_BLANK: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const invalid = step("normalize-data", { name: "  ", run: () => undefined });
      return definitionError(() =>
        definePipeline({ id: "named", steps: [invalid], finalize: () => undefined })
      );
    },
  },
  TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const load = step("load", { run: () => "loaded" });
      const normalize = step("normalize", {
        dependsOn: [load],
        run: ({ load }) => load.toUpperCase(),
      });
      return definitionError(() =>
        definePipeline({
          id: "invalid-target-result",
          steps: [load, normalize],
          targets: [load],
          finalize: requireOutputs([normalize], ({ normalize }) => normalize),
        })
      );
    },
  },
  TUBELESS_DEFINITION_TARGET_NOT_IN_STEPS: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const included = step("included", { run: () => true });
      const foreign = step("foreign", { run: () => true });
      return definitionError(() =>
        definePipeline({
          id: "foreign-target",
          steps: [included],
          // @ts-expect-error Foreign targets are rejected at definition time.
          targets: [foreign],
          finalize: () => undefined,
        })
      );
    },
  },
  TUBELESS_DEFINITION_TARGETS_DUPLICATE: {
    phase: "definition",
    kind: "definition",
    emit: () => {
      const step = createSteps();
      const included = step("included", { run: () => true });
      return definitionError(() =>
        definePipeline({
          id: "duplicate-targets",
          steps: [included],
          targets: [included, included] as never,
          finalize: () => undefined,
        })
      );
    },
  },
  TUBELESS_FINALIZATION_CANCELLED: {
    phase: "finalization",
    kind: "cancellation",
    emit: async () => {
      const controller = new AbortController();
      const step = createSteps();
      const work = step("work", {
        run: () => {
          controller.abort("stop");
          return true;
        },
      });
      const pipeline = definePipeline({
        id: "finalize-cancelled",
        steps: [work],
        finalize: () => "done",
      });
      return firstError(
        (
          await pipeline.run({}, undefined, {
            cwd: "/tmp",
            log: console,
            signal: controller.signal,
          })
        ).errors
      );
    },
  },
  TUBELESS_FINALIZATION_FAILED: {
    phase: "finalization",
    kind: "finalization",
    emit: async () => {
      const step = createSteps();
      const work = step("work", { run: () => true });
      const pipeline = definePipeline({
        id: "finalize-failed",
        steps: [work],
        finalize: () => {
          throw new Error("finalize failed");
        },
      });
      return firstError((await pipeline.run({})).errors);
    },
  },
  TUBELESS_FINAL_RESULT_VALIDATION_FAILED: {
    phase: "finalization",
    kind: "validation",
    emit: async () => {
      const rejectedResult = standardSchema<number, number>(() => ({
        issues: [{ message: "Must be positive" }],
      }));
      const step = createSteps();
      const value = step("value", { run: () => -1 });
      const pipeline = definePipeline({
        id: "invalid-result",
        steps: [value],
        resultSchema: rejectedResult,
        finalize: () => -1,
      });
      return firstError((await pipeline.run({})).errors);
    },
  },
  TUBELESS_OPTIONS_VALIDATION_FAILED: {
    phase: "execution",
    kind: "validation",
    emit: async () => {
      const optionsSchema = standardSchema<{ source: string }, { source: string }>(() => ({
        issues: [{ message: "Required", path: ["source"] }],
      }));
      const step = createSteps(optionsSchema);
      const load = step("load", { run: () => "never" });
      const pipeline = definePipeline({
        id: "invalid-options",
        steps: [load],
        finalize: () => undefined,
      });
      return firstError((await pipeline.run({ source: "rows.json" })).errors);
    },
  },
  TUBELESS_PLANNING_SELECTION_CONFLICT: {
    phase: "planning",
    kind: "selection",
    emit: () =>
      firstError(selectionPipeline().plan({ stepIds: ["build"], targets: ["write"] }).errors),
  },
  TUBELESS_PLANNING_STEP_SELECTION_DUPLICATE: {
    phase: "planning",
    kind: "selection",
    emit: () => firstError(selectionPipeline().plan({ stepIds: ["build", "build"] }).errors),
  },
  TUBELESS_PLANNING_STEP_SELECTION_EMPTY: {
    phase: "planning",
    kind: "selection",
    emit: () => firstError(selectionPipeline().plan({ stepIds: [] }).errors),
  },
  TUBELESS_PLANNING_STEP_UNKNOWN: {
    phase: "planning",
    kind: "selection",
    emit: () => firstError(selectionPipeline().plan({ stepIds: ["missing" as never] }).errors),
  },
  TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE: {
    phase: "planning",
    kind: "selection",
    emit: () => firstError(selectionPipeline().plan({ targets: ["write", "write"] }).errors),
  },
  TUBELESS_PLANNING_TARGET_SELECTION_EMPTY: {
    phase: "planning",
    kind: "selection",
    emit: () => firstError(selectionPipeline().plan({ targets: [] }).errors),
  },
  TUBELESS_PLANNING_TARGET_UNDECLARED: {
    phase: "planning",
    kind: "selection",
    emit: () => firstError(selectionPipeline().plan({ targets: ["build" as never] }).errors),
  },
  TUBELESS_PLANNING_TARGET_UNKNOWN: {
    phase: "planning",
    kind: "selection",
    emit: () => firstError(selectionPipeline().plan({ targets: ["missing" as never] }).errors),
  },
  TUBELESS_RUN_CANCELLED: {
    phase: "execution",
    kind: "cancellation",
    emit: async () => {
      const controller = new AbortController();
      controller.abort("stop");
      const step = createSteps();
      const work = step("work", { run: () => true });
      const pipeline = definePipeline({
        id: "run-cancelled",
        steps: [work],
        finalize: () => undefined,
      });
      return firstError(
        (
          await pipeline.run({}, undefined, {
            cwd: "/tmp",
            log: console,
            signal: controller.signal,
          })
        ).errors
      );
    },
  },
  TUBELESS_STEP_FAILED: {
    phase: "execution",
    kind: "step",
    emit: async () => {
      const step = createSteps();
      const failing = step("failing", {
        run: () => {
          throw new Error("step failed");
        },
      });
      const pipeline = definePipeline({
        id: "step-failed",
        steps: [failing],
        finalize: () => undefined,
      });
      return firstError((await pipeline.run({})).errors);
    },
  },
  TUBELESS_STEP_OUTPUT_VALIDATION_FAILED: {
    phase: "execution",
    kind: "validation",
    emit: async () => {
      const rejectedOutput = standardSchema<string, string>(() => ({
        issues: [{ message: "Not publishable", path: ["slug"] }],
      }));
      const step = createSteps();
      const publish = step("publish", { outputSchema: rejectedOutput, run: () => "draft" });
      const pipeline = definePipeline({
        id: "invalid-output",
        steps: [publish],
        finalize: () => undefined,
      });
      return firstError((await pipeline.run({})).errors);
    },
  },
} satisfies Record<PipelineErrorCode, DiagnosticContract>;

describe("PipelineErrorCode", () => {
  it.each(
    Object.entries(PIPELINE_ERROR_CODE_CONTRACTS) as [PipelineErrorCode, DiagnosticContract][]
  )("emits %s with stable phase and kind", async (code, { phase, kind, emit }) => {
    expect(await emit()).toMatchObject({ code, kind, phase });
  });
});
