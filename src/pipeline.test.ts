import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  PIPELINE_FINALIZE_STEP_ID,
  PipelineDefinitionError,
  PipelineExecutionError,
  requireOutputs,
  type AnyStep,
  type StandardSchemaV1,
  type Step,
} from "./pipeline";

interface TestOptions {
  failFinalize?: boolean;
  failStep?: string;
}

function makePipeline(id: string, finalizeValue?: unknown, useFinalizeValue = false) {
  const step = createSteps<TestOptions>();

  const build = step("build", {
    run: (_inputs, context) => {
      if (context.options.failStep === "build") {
        throw new Error("build failed");
      }
      return "build";
    },
  });
  const write = step("write", {
    dependsOn: [build],
    run: (inputs) => `${inputs.build}+write`,
  });

  return definePipeline({
    id,
    steps: [build, write],
    targets: [build, write],
    finalize: (outputs, context) => {
      if (context.options.failFinalize) {
        throw new Error("finalize failed");
      }
      return useFinalizeValue ? finalizeValue : [outputs.build, outputs.write].filter(Boolean);
    },
  });
}

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"],
  vendor = "test"
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor, version: 1 } };
}

describe("definePipeline", () => {
  it("returns one versioned run with public identities and timestamps", async () => {
    const log = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    let timestampMs = 100;
    const step = createSteps<{ source: string }>();
    const load = step("load", {
      run: (_inputs, context) => {
        expect(context.runId).toBe("run-public");
        expect(context.parentRunId).toBe("run-parent");
        expect(context.attemptId).toMatch(/^run-public:attempt:/);
        expect(context.log).toBe(log);
        context.log.log("loading", context.options.source);
        context.reportProgress({ completed: 1, total: 1, message: "loaded" });
        return context.options.source;
      },
    });
    const pipeline = definePipeline({
      id: "public-run-model",
      steps: [load],
      finalize: requireOutputs([load], ({ load }) => load),
    });

    const result = await pipeline.run(
      { source: "rows.json" },
      {
        cwd: "/tmp",
        log,
        now: () => timestampMs++,
        parentRunId: "run-parent",
        runId: "run-public",
      }
    );

    expect(result).toMatchObject({
      parentRunId: "run-parent",
      pipelineId: "public-run-model",
      runId: "run-public",
      status: "completed",
      version: 2,
    });
    expect(result.finishedAtMs).toBeGreaterThanOrEqual(result.startedAtMs);
    const report = result.steps[0]!;
    expect(report.finishedAtMs).toBeGreaterThanOrEqual(report.startedAtMs!);
    expect(report).toMatchObject({
      attemptId: expect.stringMatching(/^run-public:attempt:/),
      id: "load",
      status: "completed",
    });
    expect(log.log).toHaveBeenCalledWith("loading", "rows.json");
  });

  it("exports one completed token for run, step, and progress-detail statuses", () => {
    expectTypeOf<
      import("./pipeline").PipelineStepCompleteReport["status"]
    >().toEqualTypeOf<"completed">();
    expectTypeOf<import("./pipeline").PipelineRunStatus>().toEqualTypeOf<
      "cancelled" | "completed" | "failed"
    >();
    expectTypeOf<import("./pipeline").PipelineStepReportStatus>().toEqualTypeOf<
      "cancelled" | "completed" | "failed" | "skipped"
    >();
    expectTypeOf<import("./pipeline").PipelineStepLifecycleStatus>().toEqualTypeOf<
      import("./pipeline").PipelineStepStatus["status"]
    >();
    expectTypeOf<import("./pipeline").PipelineStepProgressDetailStatus>().toEqualTypeOf<
      "completed" | "failed" | "pending" | "running" | "skipped"
    >();
    expectTypeOf<import("./pipeline").MappedChildProgressDetail>().toEqualTypeOf<
      import("./pipeline").PipelineStepProgressDetail
    >();
  });

  it("validates and transforms options, step outputs, and final results", async () => {
    const inputMarker = Symbol("input-options");
    class InputOptions {
      readonly hidden!: string;
      readonly [inputMarker] = "input-symbol";
      readonly #suffix = "!";

      constructor(readonly raw: string) {
        Object.defineProperty(this, "hidden", {
          enumerable: false,
          value: "input-non-enumerable",
        });
      }

      read(): string {
        return `${this.raw}${this.#suffix}`;
      }
    }
    const outputMarker = Symbol("validated-options");
    class ValidatedOptions {
      readonly hidden!: string;
      readonly [outputMarker] = "symbol-value";
      readonly #factor = 2;

      constructor(readonly count: number) {
        Object.defineProperty(this, "hidden", { enumerable: false, value: "non-enumerable" });
      }

      double(): number {
        return this.count * this.#factor;
      }

      get tripled(): number {
        return this.count * (this.#factor + 1);
      }
    }
    let validatedOptions: ValidatedOptions | undefined;
    const optionsSchema = standardSchema<InputOptions, ValidatedOptions>(async (value) => {
      const input = value as InputOptions;
      expect(input).toBeInstanceOf(InputOptions);
      expect(input.read()).toBe("4!");
      expect(input.hidden).toBe("input-non-enumerable");
      expect(input[inputMarker]).toBe("input-symbol");
      expect(Object.getOwnPropertyDescriptor(input, "hidden")?.enumerable).toBe(false);
      expect(Object.keys(input)).toEqual(["raw"]);
      expect(Reflect.ownKeys(input)).toHaveLength(3);
      expect(Reflect.ownKeys(input)).toEqual(
        expect.arrayContaining(["raw", "hidden", inputMarker])
      );
      expect(input).not.toHaveProperty("dryRun");
      expect("dryRun" in input).toBe(false);
      validatedOptions = new ValidatedOptions(Number(input.raw));
      return { value: validatedOptions };
    });
    const outputSchema = standardSchema<string, number>((value) =>
      typeof value === "string"
        ? { value: Number(value) }
        : { issues: [{ message: "Expected text output" }] }
    );
    const resultSchema = standardSchema<{ total: number }, string>((value) => ({
      value: `total:${(value as { total: number }).total}`,
    }));
    const step = createSteps(optionsSchema);
    const load = step("load", {
      outputSchema,
      run: (_inputs, context) => {
        expectTypeOf(context.options.count).toEqualTypeOf<number>();
        expect(context.options).toBe(validatedOptions);
        expect(context.options).toBeInstanceOf(ValidatedOptions);
        expect(context.options.double()).toBe(8);
        expect(context.options.tripled).toBe(12);
        expect(context.options.hidden).toBe("non-enumerable");
        expect(context.options[outputMarker]).toBe("symbol-value");
        expect(Object.getOwnPropertyDescriptor(context.options, "hidden")?.enumerable).toBe(false);
        expect(context.dryRun).toBe(true);
        expect(context.options).not.toHaveProperty("dryRun");
        expect(context.options).not.toHaveProperty("raw");
        return String(context.options.count + 1);
      },
    });
    expectTypeOf<Awaited<ReturnType<typeof load.run>>>().toEqualTypeOf<string>();
    const total = step("total", {
      dependsOn: [load],
      run: ({ load }) => {
        expectTypeOf(load).toEqualTypeOf<number>();
        return load * 2;
      },
    });
    const pipeline = definePipeline({
      id: "validated-boundaries",
      steps: [load, total],
      resultSchema,
      finalize: requireOutputs([total], ({ total }) => ({ total })),
    });

    const input = new InputOptions("4");
    const value = await pipeline.runOrThrow(Object.assign(input, { dryRun: true }));

    expectTypeOf(value).toEqualTypeOf<string>();
    expect(value).toBe("total:10");
    expect(validatedOptions).not.toHaveProperty("dryRun");
  });

  it("keeps reusable validated domain options separate from run controls", async () => {
    const reusable = { count: 3 };
    const optionsSchema = standardSchema<object, typeof reusable>(() => ({ value: reusable }));
    const step = createSteps(optionsSchema);
    const read = step("read", {
      run: (_inputs, context) => ({ count: context.options.count, dryRun: context.dryRun }),
    });
    const pipeline = definePipeline({
      id: "reusable-validated-options",
      steps: [read],
      finalize: requireOutputs([read], ({ read }) => read),
    });

    await expect(pipeline.runOrThrow({ dryRun: true })).resolves.toEqual({
      count: 3,
      dryRun: true,
    });
    expect(reusable).not.toHaveProperty("dryRun");
    await expect(pipeline.runOrThrow({})).resolves.toEqual({ count: 3, dryRun: false });
  });

  it("keeps flat run controls out of unvalidated step options", async () => {
    const step = createSteps<{ label: string }>();
    const read = step("read", {
      run: (_inputs, context) => {
        expect(context.options).toEqual({ label: "organic" });
        expect(context.options).not.toHaveProperty("dryRun");
        expect("dryRun" in context.options).toBe(false);
        return { dryRun: context.dryRun, label: context.options.label };
      },
    });
    const pipeline = definePipeline({
      id: "flat-run-controls",
      steps: [read],
      finalize: requireOutputs([read], ({ read }) => read),
    });

    await expect(pipeline.runOrThrow({ label: "organic", dryRun: true })).resolves.toEqual({
      dryRun: true,
      label: "organic",
    });
  });

  it("applies controls independently when an options schema returns its input", async () => {
    const optionsSchema = standardSchema<{ label: string }, { label: string }>((value) => ({
      value,
    }));
    const step = createSteps(optionsSchema);
    const fail = step("fail", {
      run: () => {
        throw new Error("expected failure");
      },
    });
    const observe = step("observe", {
      run: (_inputs, context) => context.options.label,
    });
    const pipeline = definePipeline({
      id: "identity-options-schema",
      steps: [fail, observe],
      finalize: (outputs) => outputs.observe,
    });

    const result = await pipeline.run({ label: "identity", continueOnError: true });

    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(true);
    expect(result.value).toBe("identity");
    expect(result.steps.map(({ id, status }) => [id, status])).toEqual([
      ["fail", "failed"],
      ["observe", "completed"],
    ]);
  });

  it("does not need to overlay controls on non-extensible validated options", async () => {
    class FrozenOptions {
      readonly #value = 7;

      read(): number {
        return this.#value;
      }
    }
    const frozen = Object.freeze(new FrozenOptions());
    const optionsSchema = standardSchema<object, FrozenOptions>(() => ({ value: frozen }));
    const step = createSteps(optionsSchema);
    const read = step("read", {
      run: (_inputs, context) => {
        expect(context.options).toBeInstanceOf(FrozenOptions);
        expect(context.options.read()).toBe(7);
        expect(context.dryRun).toBe(true);
        return context.options.read();
      },
    });
    const pipeline = definePipeline({
      id: "frozen-validated-options",
      steps: [read],
      finalize: requireOutputs([read], ({ read }) => read),
    });

    await expect(pipeline.runOrThrow({ dryRun: true })).resolves.toBe(7);
  });

  it("reports option validation issues before any step starts", async () => {
    const input = { source: "bad" };
    const validate = vi.fn((value: unknown) => {
      expect(value).toBe(input);
      return {
        issues: [
          { message: "Required", path: ["source"] },
          { message: "Nested", path: [{ key: "config" }, 0] },
        ],
      };
    });
    const optionsSchema = standardSchema<{ source: string }, { source: string }>(validate);
    const step = createSteps(optionsSchema);
    const load = step("load", { run: () => "never" });
    const pipeline = definePipeline({
      id: "invalid-options",
      steps: [load],
      finalize: () => undefined,
    });

    expect(pipeline.plan().ok).toBe(true);
    expect(validate).not.toHaveBeenCalled();

    const result = await pipeline.run(input);

    expect(result.status).not.toBe("completed");
    expect(validate).toHaveBeenCalledOnce();
    expect(result.steps).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_OPTIONS_VALIDATION_FAILED",
      issues: [
        { message: "Required", path: ["source"] },
        { message: "Nested", path: ["config", 0] },
      ],
      kind: "validation",
      phase: "execution",
    });
  });

  it("attaches output and final-result validation failures to their lifecycle boundaries", async () => {
    const rejectedOutput = standardSchema<string, string>(() => ({
      issues: [{ message: "Not publishable", path: ["slug"] }],
    }));
    const step = createSteps();
    const publish = step("publish", { outputSchema: rejectedOutput, run: () => "draft" });
    const outputPipeline = definePipeline({
      id: "invalid-output",
      steps: [publish],
      finalize: () => undefined,
    });

    const outputResult = await outputPipeline.run({});
    expect(outputResult.steps[0]).toMatchObject({
      status: "failed",
      error: {
        code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
        issues: [{ message: "Not publishable", path: ["slug"] }],
        stepId: "publish",
      },
    });

    const rejectedResult = standardSchema<number, number>(() => ({
      issues: [{ message: "Must be positive" }],
    }));
    const value = step("value", { run: () => -1 });
    const resultPipeline = definePipeline({
      id: "invalid-result",
      steps: [value],
      resultSchema: rejectedResult,
      finalize: () => -1,
    });

    const result = await resultPipeline.run({});
    expect(result.finalized).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_FINAL_RESULT_VALIDATION_FAILED",
      issues: [{ message: "Must be positive" }],
      kind: "validation",
      phase: "finalization",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
  });

  it("rejects steps mixed across options-schema scopes", () => {
    const schemaA = standardSchema<object, object>((value) => ({ value: value as object }), "a");
    const schemaB = standardSchema<object, object>((value) => ({ value: value as object }), "b");
    const first = createSteps(schemaA)("first", { run: () => 1 });
    const second = createSteps(schemaB)("second", { run: () => 2 });

    expect(() =>
      definePipeline({
        id: "mixed-options-schemas",
        steps: [first, second],
        finalize: () => undefined,
      })
    ).toThrow("mixes steps from different options-schema scopes");
  });

  it("generates a Mermaid flowchart without running the pipeline", () => {
    const step = createSteps();
    const runSource = vi.fn(() => "source");
    const source = step("source", {
      name: 'Load "Rows" #1 & <raw>',
      description: "Read safely.\nNo mutation.",
      run: runSource,
    });
    const hint = step("hint", { run: () => "hint" });
    const validate = step("validate", { run: () => true });
    const publish = step("publish", {
      dependsOn: [source],
      optionalDependsOn: [hint, validate],
      skipAfterFailureOf: [validate],
      run: () => "published",
    });
    const pipeline = definePipeline({
      id: "diagrammed",
      steps: [source, hint, validate, publish],
      finalize: () => undefined,
    });

    expect(pipeline.toMermaid({ direction: "LR", includeDescriptions: true })).toBe(
      [
        "flowchart LR",
        '  step0["Load #quot;Rows#quot; #35;1 #38; #60;raw#62; — Read safely. No mutation."]',
        '  step1["hint"]',
        '  step2["validate"]',
        '  step3["publish"]',
        "",
        "  step0 --> step3",
        "  step1 -. optional input .-> step3",
        "  step2 -. optional input + failure gate .-> step3",
        "",
      ].join("\n")
    );
    expect(runSource).not.toHaveBeenCalled();
  });

  it("uses top-down layout and concise display labels by default", () => {
    const step = createSteps();
    const normalize = step("normalize-data", {
      name: "Normalize Data",
      description: "Not included by default.",
      run: () => undefined,
    });
    const pipeline = definePipeline({
      id: "defaults",
      steps: [normalize],
      finalize: () => undefined,
    });

    expect(pipeline.toMermaid()).toBe(["flowchart TD", '  step0["Normalize Data"]', ""].join("\n"));
    expect(() => pipeline.toMermaid({ direction: "sideways" as never })).toThrowError(
      "Invalid Mermaid flowchart direction: sideways"
    );
  });

  it("carries an optional display name through plans and reports", async () => {
    const step = createSteps();
    const normalize = step("normalize-data", {
      name: "Normalize Data",
      run: () => "normalized",
    });
    const pipeline = definePipeline({
      id: "named",
      steps: [normalize],
      finalize: (outputs) => outputs["normalize-data"],
    });

    expect(pipeline.plan({}).steps[0]).toMatchObject({
      id: "normalize-data",
      name: "Normalize Data",
    });
    expect((await pipeline.run({})).steps[0]).toMatchObject({
      id: "normalize-data",
      name: "Normalize Data",
    });
  });

  it("rejects a blank display name when the pipeline is defined", () => {
    const step = createSteps();
    const invalid = step("normalize-data", { name: "  ", run: () => undefined });

    expect(() =>
      definePipeline({ id: "named", steps: [invalid], finalize: () => undefined })
    ).toThrow("step normalize-data has a blank display name");
  });

  it("exposes immutable step ids in definition order", () => {
    const pipeline = makePipeline("discoverable");

    expect(pipeline.stepIds).toEqual(["build", "write"]);
    expect(Object.isFrozen(pipeline.stepIds)).toBe(true);
  });

  it("allows runOrThrow for successful pipelines", async () => {
    await expect(
      makePipeline("void-pipeline", undefined, true).runOrThrow({})
    ).resolves.toBeUndefined();
  });

  it("passes each step's output only to declared dependents", async () => {
    const result = await makePipeline("test").run({});
    expect(result.value).toEqual(["build", "build+write"]);
  });

  it("fails before execution when requested step ids are unknown", async () => {
    const result = await makePipeline("test").run({ stepIds: ["missing"] });
    expect(result.status).not.toBe("completed");
    expect(result.steps).toEqual([]);
    expect(result.errors[0]?.message).toContain("requested unknown step ids: missing");
  });

  it("rejects an empty stepIds array during planning and execution", async () => {
    const pipeline = makePipeline("empty-selection");

    const plan = pipeline.plan({ stepIds: [] });
    expect(plan.ok).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_STEP_SELECTION_EMPTY",
      kind: "selection",
      message: expect.stringContaining("empty stepIds"),
      phase: "planning",
    });

    const result = await pipeline.run({ stepIds: [] });
    expect(result.status).not.toBe("completed");
    expect(result.steps).toEqual([]);
    expect(result.errors[0]?.message).toContain("empty stepIds");
  });

  it("runs every step when stepIds is omitted and preserves non-empty filtering", async () => {
    const pipeline = makePipeline("selection");

    expect(pipeline.plan({}).steps.map((step) => step.selectionReasons)).toEqual([
      [{ kind: "all" }],
      [{ kind: "all" }],
    ]);
    expect(
      pipeline
        .plan({ stepIds: ["build"] })
        .steps.map(({ id, selectionReasons }) => [id, selectionReasons])
    ).toEqual([
      ["build", [{ kind: "exact" }]],
      ["write", [{ kind: "not-selected" }]],
    ]);

    const allSteps = await pipeline.run({});
    expect(allSteps.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "completed"],
      ["write", "completed"],
    ]);

    const selected = await pipeline.run({ stepIds: ["build"] });
    expect(selected.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "completed"],
      ["write", "skipped"],
    ]);
  });

  it("runs targets with required inputs and failure gates but not optional-only inputs", async () => {
    const ran: string[] = [];
    let failValidation = false;
    const step = createSteps();
    const source = step("source", { run: () => (ran.push("source"), "source") });
    const optional = step("optional", { run: () => (ran.push("optional"), "optional") });
    const validate = step("validate", {
      dependsOn: [source],
      run: () => {
        ran.push("validate");
        if (failValidation) throw new Error("invalid");
        return true;
      },
    });
    const publish = step("publish", {
      dependsOn: [source],
      optionalDependsOn: [optional],
      skipAfterFailureOf: [validate],
      run: (inputs) => (ran.push("publish"), `${inputs.source}:${inputs.optional ?? "none"}`),
    });
    const unrelated = step("unrelated", { run: () => (ran.push("unrelated"), true) });
    const pipeline = definePipeline({
      id: "target-selection",
      steps: [source, optional, validate, publish, unrelated],
      targets: [publish],
      finalize: (outputs) => outputs.publish,
    });

    expect(
      pipeline
        .plan({ targets: ["publish"] })
        .steps.map(({ id, selected, selectionReasons }) => ({ id, selected, selectionReasons }))
    ).toEqual([
      {
        id: "source",
        selected: true,
        selectionReasons: [
          { dependentId: "publish", kind: "required-dependency", targetId: "publish" },
          { dependentId: "validate", kind: "required-dependency", targetId: "publish" },
        ],
      },
      {
        id: "optional",
        selected: false,
        selectionReasons: [{ dependentId: "publish", kind: "optional-only", targetId: "publish" }],
      },
      {
        id: "validate",
        selected: true,
        selectionReasons: [{ dependentId: "publish", kind: "failure-gate", targetId: "publish" }],
      },
      {
        id: "publish",
        selected: true,
        selectionReasons: [{ kind: "target", targetId: "publish" }],
      },
      {
        id: "unrelated",
        selected: false,
        selectionReasons: [{ kind: "outside-target-closure" }],
      },
    ]);
    const result = await pipeline.run({ targets: ["publish"] });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("source:none");
    expect(ran).toEqual(["source", "validate", "publish"]);

    ran.length = 0;
    failValidation = true;
    const failedGate = await pipeline.run({ continueOnError: true, targets: ["publish"] });
    expect(failedGate.steps.find(({ id }) => id === "publish")).toMatchObject({
      dependencyId: "validate",
      reason: "failed-dependency",
      status: "skipped",
    });
    expect(ran).toEqual(["source", "validate"]);
  });

  it("supports shared target inputs, policy skips, and dry-run target omission", async () => {
    let sourceRuns = 0;
    const step = createSteps();
    const source = step("source", { run: () => (sourceRuns += 1) });
    const valuedSkip = step.skippable("valued-skip", {
      dependsOn: [source],
      skip: () => ({ reason: "cached", value: "cached-value" }),
      run: () => "fresh-value",
    });
    const emptySkip = step.skippable("empty-skip", {
      dependsOn: [source],
      skip: () => "not needed",
      run: () => "unexpected",
    });
    const write = step("write", {
      dependsOn: [source],
      dryRun: "skip",
      run: () => "written",
    });
    const pipeline = definePipeline({
      id: "target-policies",
      steps: [source, valuedSkip, emptySkip, write],
      targets: [valuedSkip, emptySkip, write],
      finalize: (outputs) => outputs,
    });

    const skipped = await pipeline.run({ targets: ["valued-skip", "empty-skip"] });
    expect(skipped.status).toBe("completed");
    expect(skipped.value).toMatchObject({ "valued-skip": "cached-value" });
    expect(Object.prototype.hasOwnProperty.call(skipped.value, "empty-skip")).toBe(true);
    expect(sourceRuns).toBe(1);
    expect(
      pipeline
        .plan({ targets: ["valued-skip", "empty-skip"] })
        .steps.find(({ id }) => id === "source")?.selectionReasons
    ).toEqual([
      {
        dependentId: "valued-skip",
        kind: "required-dependency",
        targetId: "valued-skip",
      },
      {
        dependentId: "empty-skip",
        kind: "required-dependency",
        targetId: "empty-skip",
      },
    ]);

    const dryRun = await pipeline.run({ dryRun: true, targets: ["write"] });
    expect(dryRun.status).toBe("completed");
    expect(dryRun.steps.find(({ id }) => id === "write")).toMatchObject({
      reason: "dry-run",
      status: "skipped",
    });
    expect(pipeline.plan({ dryRun: true, targets: ["write"] }).steps.at(-1)).toMatchObject({
      selectionReasons: [{ kind: "target", targetId: "write" }],
      skipReason: "dry-run",
    });
  });

  it("rejects invalid target selections and combining targets with stepIds", () => {
    const pipeline = makePipeline("target-validation");

    expect(pipeline.plan({ targets: [] }).errors[0]?.message).toContain("empty targets");
    expect(pipeline.plan({ targets: ["build", "build"] }).errors[0]?.message).toContain(
      "duplicate targets: build"
    );
    expect(pipeline.plan({ targets: ["missing"] }).errors[0]?.message).toContain(
      "unknown targets: missing"
    );
    expect(pipeline.plan({ stepIds: ["build"], targets: ["write"] }).errors[0]?.message).toContain(
      "cannot combine exact stepIds"
    );
  });

  it("exposes only declared targets and rejects internal steps as targets", () => {
    const step = createSteps();
    const load = step("load", { run: () => "loaded" });
    const publish = step("publish", {
      dependsOn: [load],
      run: ({ load }) => `${load}:published`,
    });
    const pipeline = definePipeline({
      id: "declared-targets",
      steps: [load, publish],
      targets: [publish],
      finalize: (outputs) => outputs.publish,
    });

    expect(pipeline.targetIds).toEqual(["publish"]);
    expect(Object.isFrozen(pipeline.targetIds)).toBe(true);
    expectTypeOf(pipeline.targetIds).toEqualTypeOf<readonly "publish"[]>();
    expect(pipeline.plan({ targets: ["publish"] }).ok).toBe(true);
    // @ts-expect-error Internal steps are available through exact stepIds, not targets.
    pipeline.plan({ targets: ["load"] });
    expect(pipeline.plan({ targets: ["load" as never] }).errors[0]?.message).toContain(
      "requested undeclared targets: load"
    );
  });

  it("rejects declared targets that cannot satisfy required finalizer outputs", () => {
    const step = createSteps();
    const load = step("load", { run: () => "loaded" });
    const normalize = step("normalize", {
      dependsOn: [load],
      run: ({ load }) => load.toUpperCase(),
    });

    expect(() =>
      definePipeline({
        id: "invalid-target-result",
        steps: [load, normalize],
        targets: [load],
        finalize: requireOutputs([normalize], ({ normalize }) => normalize),
      })
    ).toThrow("target load cannot satisfy required finalizer output(s): normalize");
  });

  it("rejects duplicate and foreign target declarations", () => {
    const step = createSteps();
    const included = step("included", { run: () => true });
    const foreign = step("foreign", { run: () => true });

    expect(() =>
      definePipeline({
        id: "invalid-target-declarations",
        steps: [included],
        targets: [included, included, foreign],
        finalize: () => undefined,
      })
    ).toThrow(
      /declares duplicate targets: included.*declares target step\(s\) not included.*foreign/
    );
  });

  it("requires declared finalizer outputs without rejecting a published undefined", async () => {
    const step = createSteps();
    const build = step("build", { run: () => "built" });
    const write = step("write", {
      dependsOn: [build],
      run: () => undefined,
    });
    const pipeline = definePipeline({
      id: "required-finalizer-outputs",
      steps: [build, write],
      finalize: requireOutputs([build, write], (outputs) => {
        expectTypeOf(outputs.build).toEqualTypeOf<string>();
        expectTypeOf(outputs.write).toEqualTypeOf<undefined>();
        return `${outputs.build}:${String(outputs.write)}`;
      }),
    });

    await expect(pipeline.runOrThrow({})).resolves.toBe("built:undefined");

    const filtered = await pipeline.run({ stepIds: ["write"] });
    expect(filtered.status).toBe("failed");
    expect(filtered.finalized).toBe(false);
    expect(filtered.errors[0]).toMatchObject({
      message: "Required pipeline outputs missing: build, write",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
  });

  it("rejects required finalizer steps that are not in the pipeline", () => {
    const step = createSteps();
    const included = step("included", { run: () => true });
    const foreign = step("foreign", { run: () => true });

    expect(() =>
      definePipeline({
        id: "foreign-finalizer-output",
        steps: [included],
        finalize: requireOutputs([foreign], ({ foreign }) => foreign),
      })
    ).toThrow("requires finalizer output from step(s) not included in its steps list: foreign");
  });

  it("rejects duplicate step ids when the pipeline is defined", () => {
    const step = createSteps();
    const duplicate = step("build", { run: () => "a" });
    let thrown: unknown;
    try {
      const dynamicSteps: readonly AnyStep<object>[] = [duplicate, duplicate];
      definePipeline({
        id: "test",
        // Widened/dynamic definitions retain the runtime backstop; literal tuples
        // are rejected by TypeScript (covered by the validated-boundaries example).
        steps: dynamicSteps,
        finalize: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PipelineDefinitionError);
    expect((thrown as PipelineDefinitionError).errors[0]).toMatchObject({
      code: "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE",
      kind: "definition",
      message: expect.stringContaining("duplicate step ids: build"),
      phase: "definition",
    });
    expect((thrown as PipelineDefinitionError).message).toContain("definition");
    expect((thrown as PipelineDefinitionError).message).toContain(
      "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE"
    );
  });

  it("rejects blank, reserved, repeated, and contradictory graph declarations", () => {
    const step = createSteps();
    const source = step("source", { run: () => "source" });
    const contradictory = step("contradictory", {
      dependsOn: [source, source],
      optionalDependsOn: [source],
      run: () => "unreachable",
    });
    expect(() =>
      definePipeline({
        id: " ",
        steps: [source, contradictory],
        finalize: () => undefined,
      })
    ).toThrow(
      /Pipeline id must not be blank.*repeats dependsOn: source.*both required and optional/
    );

    const reserved = step(PIPELINE_FINALIZE_STEP_ID, { run: () => undefined });
    expect(() =>
      definePipeline({ id: "reserved", steps: [reserved], finalize: () => undefined })
    ).toThrow(`reserved step id ${PIPELINE_FINALIZE_STEP_ID}`);
  });

  it("skips dependent steps after a failed dependency with continueOnError", async () => {
    const result = await makePipeline("test").run({
      failStep: "build",
      continueOnError: true,
    });
    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(true);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "failed"],
      ["write", "skipped"],
    ]);
    expect(result.value).toEqual([]);
  });

  it("throws from runOrThrow when a best-effort run contains errors", async () => {
    await expect(
      makePipeline("test").runOrThrow({ failStep: "build", continueOnError: true })
    ).rejects.toThrow("Pipeline test failed");
  });

  it("tags finalize failures with a sentinel step id", async () => {
    const result = await makePipeline("test").run({ failFinalize: true });
    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(false);
    expect(result.errors[0]).toMatchObject({
      message: "finalize failed",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "completed"],
      ["write", "completed"],
    ]);
  });

  it("still throws from runOrThrow when finalize fails while continuing on error", async () => {
    await expect(
      makePipeline("test").runOrThrow({
        failStep: "build",
        failFinalize: true,
        continueOnError: true,
      })
    ).rejects.toThrow("Pipeline test failed");
  });

  it("optionalDependsOn passes the output through when the dependency ran", async () => {
    const step = createSteps();
    const a = step("a", { run: () => "a-value" });
    const b = step("b", {
      optionalDependsOn: [a],
      run: (inputs) => inputs.a ?? "fallback",
    });
    const pipeline = definePipeline({
      id: "optional",
      steps: [a, b],
      finalize: (outputs) => outputs.b ?? "",
    });
    const result = await pipeline.run({});
    expect(result.value).toBe("a-value");
  });

  it("optionalDependsOn does not auto-skip when the dependency was filtered out", async () => {
    const step = createSteps();
    const a = step("a", { run: () => "a-value" });
    const b = step("b", {
      optionalDependsOn: [a],
      run: (inputs) => inputs.a ?? "fallback",
    });
    const pipeline = definePipeline({
      id: "optional",
      steps: [a, b],
      finalize: (outputs) => outputs.b ?? "",
    });
    const result = await pipeline.run({ stepIds: ["b"] });
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["a", "skipped"],
      ["b", "completed"],
    ]);
    expect(result.value).toBe("fallback");
  });

  it("skipAfterFailureOf skips a step when the referenced step failed, even without a data dependency", async () => {
    const step = createSteps<TestOptions>();
    const a = step("a", {
      run: (_inputs, context) => {
        if (context.options.failStep === "a") {
          throw new Error("a failed");
        }
        return "a-value";
      },
    });
    const b = step("b", {
      skipAfterFailureOf: [a],
      run: () => "b-value",
    });
    const pipeline = definePipeline({
      id: "skip-after-failure",
      steps: [a, b],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({ failStep: "a", continueOnError: true });
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["a", "failed"],
      ["b", "skipped"],
    ]);
  });

  it("skipAfterFailureOf skips a step when the referenced step was cancelled", async () => {
    const step = createSteps();
    const cancelled = step("cancelled", {
      run: async (_inputs, context) => {
        const localController = new AbortController();
        localController.abort("local cancellation");
        await context.sleep(1, localController.signal);
      },
    });
    const publish = step("publish", {
      skipAfterFailureOf: [cancelled],
      run: () => "published",
    });
    const pipeline = definePipeline({
      id: "skip-after-cancellation",
      steps: [cancelled, publish],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({ continueOnError: true });

    expect(result.steps.map((report) => [report.id, report.status])).toEqual([
      ["cancelled", "cancelled"],
      ["publish", "skipped"],
    ]);
    expect(result.steps[1]).toMatchObject({
      dependencyId: "cancelled",
      reason: "failed-dependency",
      status: "skipped",
    });
  });

  it('dryRun: "skip" prevents the normal handler from running', async () => {
    const step = createSteps();
    const writeRan = vi.fn();
    const write = step("write", {
      description: "Persist output",
      dryRun: "skip",
      run: () => {
        writeRan();
        return "written";
      },
    });
    const pipeline = definePipeline({
      id: "effect-dry-run",
      steps: [write],
      finalize: (outputs) => outputs.write,
    });

    const plan = pipeline.plan({ dryRun: true });
    const result = await pipeline.run({ dryRun: true });

    expect(plan.steps[0]).toMatchObject({ dryRun: "skip", id: "write" });
    expect(writeRan).not.toHaveBeenCalled();
    expect(result.steps[0]).toMatchObject({ id: "write", reason: "dry-run", status: "skipped" });
  });

  it("uses a custom dry-run handler in place of run and publishes its typed output", async () => {
    const step = createSteps<{ source: string }>();
    const runWrite = vi.fn(() => ({ id: "live" }));
    const prepare = step("prepare", {
      run: (_inputs, context) => context.options.source.trim(),
    });
    const write = step("write", {
      dependsOn: [prepare],
      dryRun: ({ prepare: value }, context) => {
        expect(context.dryRun).toBe(true);
        return { id: `preview:${value}` };
      },
      run: runWrite,
    });
    const consume = step("consume", {
      dependsOn: [write],
      run: ({ write: result }) => result.id,
    });
    const pipeline = definePipeline({
      id: "custom-dry-run",
      steps: [prepare, write, consume],
      finalize: (outputs) => outputs.consume,
    });

    const plan = pipeline.plan({ dryRun: true });
    const result = await pipeline.runOrThrow({ source: " artifact ", dryRun: true });

    expect(plan.steps.map(({ dryRun: policy }) => policy)).toEqual(["run", "custom", "run"]);
    expect(runWrite).not.toHaveBeenCalled();
    expect(result).toBe("preview:artifact");

    await expect(pipeline.runOrThrow({ source: "artifact" })).resolves.toBe("live");
    expect(runWrite).toHaveBeenCalledOnce();
  });

  it("exposes a static execution plan without running steps", () => {
    const step = createSteps();
    let ran = false;
    const build = step("build", {
      run: () => {
        ran = true;
        return "built";
      },
    });
    const write = step("write", {
      dependsOn: [build],
      dryRun: "skip",
      run: () => "written",
    });
    const pipeline = definePipeline({
      id: "planned",
      steps: [write, build],
      finalize: (outputs) => outputs,
    });

    const plan = pipeline.plan({ dryRun: true, stepIds: ["write"] });

    expect(ran).toBe(false);
    expect(plan).toMatchObject({
      dryRun: true,
      ok: true,
      pipelineId: "planned",
      steps: [
        {
          dependencies: [],
          id: "build",
          optionalDependencies: [],
          selected: false,
          selectionReasons: [{ kind: "not-selected" }],
          skipAfterFailureOf: [],
          skipReason: "filtered",
        },
        {
          dependencies: ["build"],
          id: "write",
          optionalDependencies: [],
          selected: true,
          selectionReasons: [{ kind: "exact" }],
          skipAfterFailureOf: [],
          skipReason: "unmet-dependency",
        },
      ],
    });
  });

  // Characterization matrix for plan/run skip disposition (slice 071-2).
  // Covers the shared decideStepDisposition cases through public APIs only.
  it.each([
    {
      name: "filtered",
      run: async () => {
        const step = createSteps();
        const kept = step("kept", { run: () => "kept" });
        const dropped = step("dropped", { run: () => "dropped" });
        const pipeline = definePipeline({
          id: "disposition-filtered",
          steps: [kept, dropped],
          finalize: () => undefined,
        });
        return {
          plan: pipeline.plan({ stepIds: ["kept"] }),
          result: await pipeline.run({ stepIds: ["kept"] }),
        };
      },
      expect: (got: {
        plan: { steps: { id: string; selected: boolean; skipReason?: string }[] };
        result: { steps: { id: string; status: string; reason?: string }[] };
      }) => {
        expect(got.plan.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "dropped", selected: false, skipReason: "filtered" }),
            expect.objectContaining({ id: "kept", selected: true, skipReason: undefined }),
          ])
        );
        expect(got.result.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "dropped", status: "skipped", reason: "filtered" }),
            expect.objectContaining({ id: "kept", status: "completed" }),
          ])
        );
      },
    },
    {
      name: "planned unmet-dependency",
      run: async () => {
        const step = createSteps();
        const build = step("build", { run: () => "built" });
        const write = step("write", { dependsOn: [build], run: () => "written" });
        const pipeline = definePipeline({
          id: "disposition-unmet",
          steps: [build, write],
          finalize: () => undefined,
        });
        return {
          plan: pipeline.plan({ stepIds: ["write"] }),
          result: await pipeline.run({ stepIds: ["write"] }),
        };
      },
      expect: (got: {
        plan: { steps: { id: string; skipReason?: string }[] };
        result: { steps: { id: string; status: string; reason?: string; dependencyId?: string }[] };
      }) => {
        expect(got.plan.steps).toEqual([
          expect.objectContaining({ id: "build", skipReason: "filtered" }),
          expect.objectContaining({ id: "write", skipReason: "unmet-dependency" }),
        ]);
        expect(got.result.steps).toEqual([
          expect.objectContaining({ id: "build", status: "skipped", reason: "filtered" }),
          expect.objectContaining({
            id: "write",
            status: "skipped",
            reason: "unmet-dependency",
            dependencyId: "build",
          }),
        ]);
      },
    },
    {
      name: "dry-run",
      run: async () => {
        const step = createSteps();
        const write = step("write", { dryRun: "skip", run: () => "written" });
        const pipeline = definePipeline({
          id: "disposition-dry-run",
          steps: [write],
          finalize: () => undefined,
        });
        return {
          plan: pipeline.plan({ dryRun: true }),
          result: await pipeline.run({ dryRun: true }),
        };
      },
      expect: (got: {
        plan: { steps: { id: string; skipReason?: string }[] };
        result: { steps: { id: string; status: string; reason?: string }[] };
      }) => {
        expect(got.plan.steps[0]).toMatchObject({ id: "write", skipReason: "dry-run" });
        expect(got.result.steps[0]).toMatchObject({
          id: "write",
          status: "skipped",
          reason: "dry-run",
        });
      },
    },
    {
      name: "failed-dependency (continueOnError + skipAfterFailureOf)",
      run: async () => {
        const step = createSteps<TestOptions>();
        const gate = step("gate", {
          run: (_inputs, context) => {
            if (context.options.failStep === "gate") {
              throw new Error("gate failed");
            }
            return "ok";
          },
        });
        const publish = step("publish", {
          skipAfterFailureOf: [gate],
          run: () => "published",
        });
        const pipeline = definePipeline({
          id: "disposition-failed-dependency",
          steps: [gate, publish],
          finalize: () => undefined,
        });
        return {
          plan: pipeline.plan({}),
          result: await pipeline.run({ failStep: "gate", continueOnError: true }),
        };
      },
      expect: (got: {
        plan: { steps: { id: string; skipReason?: string }[] };
        result: { steps: { id: string; status: string; reason?: string; dependencyId?: string }[] };
      }) => {
        // Plan cannot see live failures; both steps would run.
        expect(got.plan.steps.every((step) => step.skipReason === undefined)).toBe(true);
        expect(got.result.steps).toEqual([
          expect.objectContaining({ id: "gate", status: "failed" }),
          expect.objectContaining({
            id: "publish",
            status: "skipped",
            reason: "failed-dependency",
            dependencyId: "gate",
          }),
        ]);
      },
    },
    {
      name: "fail-fast remainder",
      run: async () => {
        const result = await makePipeline("disposition-fail-fast").run({ failStep: "build" });
        return { plan: makePipeline("disposition-fail-fast").plan({}), result };
      },
      expect: (got: {
        plan: { steps: { id: string; skipReason?: string }[] };
        result: {
          steps: { id: string; status: string; reason?: string; message?: string }[];
        };
      }) => {
        expect(got.plan.steps.every((step) => step.skipReason === undefined)).toBe(true);
        expect(got.result.steps).toEqual([
          expect.objectContaining({ id: "build", status: "failed" }),
          expect.objectContaining({
            id: "write",
            status: "skipped",
            reason: "fail-fast",
            message: "Not run because fail-fast stopped after build failed.",
          }),
        ]);
      },
    },
    {
      name: "run (no skip)",
      run: async () => {
        const result = await makePipeline("disposition-run").run({});
        return { plan: makePipeline("disposition-run").plan({}), result };
      },
      expect: (got: {
        plan: { steps: { id: string; skipReason?: string; selected: boolean }[] };
        result: { status: string; steps: { id: string; status: string }[] };
      }) => {
        expect(got.plan.steps).toEqual([
          expect.objectContaining({ id: "build", selected: true, skipReason: undefined }),
          expect.objectContaining({ id: "write", selected: true, skipReason: undefined }),
        ]);
        expect(got.result.status).toBe("completed");
        expect(got.result.steps).toEqual([
          expect.objectContaining({ id: "build", status: "completed" }),
          expect.objectContaining({ id: "write", status: "completed" }),
        ]);
      },
    },
  ] as const)("step disposition table: $name", async ({ run, expect: assertDisposition }) => {
    assertDisposition(await run());
  });

  it("fail-fast (the default) records every not-run downstream step", async () => {
    const result = await makePipeline("test").run({ failStep: "build" });
    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(false);
    expect(
      result.steps.map((step) => [
        step.id,
        step.status,
        step.status === "skipped" ? step.reason : undefined,
      ])
    ).toEqual([
      ["build", "failed", undefined],
      ["write", "skipped", "fail-fast"],
    ]);
    expect(result.steps[1]).toMatchObject({
      message: "Not run because fail-fast stopped after build failed.",
    });
    expect(result.steps[1]?.status === "skipped" ? result.steps[1].message : undefined).toBe(
      "Not run because fail-fast stopped after build failed."
    );
    expect(result.errors).toEqual([
      {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "build failed",
        phase: "execution",
        stack: expect.any(String),
        stepId: "build",
      },
    ]);
  });

  it("emits distinct failed and skipped terminal states", async () => {
    const events: string[] = [];
    const result = await makePipeline("test").run(
      { failStep: "build" },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onStepFail: ({ error, step }) => events.push(`error:${step.id}:${error.message}`),
          onStepSkip: ({ reason, step }) => events.push(`skip:${step.id}:${reason}`),
        },
      }
    );
    expect(result.status).not.toBe("completed");
    expect(events).toEqual(["error:build:build failed", "skip:write:fail-fast"]);
  });

  it("retains the dependency id for a planned unmet-dependency skip after fail-fast", async () => {
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        throw new Error("failed");
      },
    });
    const filtered = step("filtered", { run: () => "filtered" });
    const requiresFiltered = step("requires-filtered", {
      dependsOn: [filtered],
      run: () => "unreachable",
    });
    const pipeline = definePipeline({
      id: "fail-fast-structural-skip",
      steps: [failing, filtered, requiresFiltered],
      finalize: () => undefined,
    });
    const skipEvents: unknown[] = [];

    await pipeline.run(
      { stepIds: ["failing", "requires-filtered"] },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onStepSkip: (event) => {
            skipEvents.push({
              dependencyId: event.dependencyId,
              reason: event.reason,
              stepId: event.step.id,
            });
          },
        },
      }
    );

    expect(skipEvents).toEqual([
      {
        dependencyId: undefined,
        reason: "filtered",
        stepId: "filtered",
      },
      {
        dependencyId: "filtered",
        reason: "unmet-dependency",
        stepId: "requires-filtered",
      },
    ]);
  });

  it("preserves a planned dry-run skip after fail-fast even when skipAfterFailureOf matches the failed step", async () => {
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        throw new Error("failed");
      },
    });
    const later = step("later", {
      dryRun: "skip",
      skipAfterFailureOf: [failing],
      run: () => "unreachable",
    });
    const pipeline = definePipeline({
      id: "fail-fast-dry-run-skip",
      steps: [failing, later],
      finalize: () => undefined,
    });
    const skipEvents: unknown[] = [];

    const result = await pipeline.run(
      { dryRun: true },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onStepSkip: (event) => {
            skipEvents.push({
              dependencyId: event.dependencyId,
              reason: event.reason,
              stepId: event.step.id,
            });
          },
        },
      }
    );

    expect(
      pipeline.plan({ dryRun: true }).steps.map((planned) => [planned.id, planned.skipReason])
    ).toEqual([
      ["failing", undefined],
      ["later", "dry-run"],
    ]);
    expect(
      result.steps.map((report) => [
        report.id,
        report.status,
        report.status === "skipped" ? report.reason : undefined,
      ])
    ).toEqual([
      ["failing", "failed", undefined],
      ["later", "skipped", "dry-run"],
    ]);
    expect(skipEvents).toEqual([
      {
        dependencyId: undefined,
        reason: "dry-run",
        stepId: "later",
      },
    ]);
  });

  it("preserves a thrown error code in the step report and run result", async () => {
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        throw Object.assign(new Error("request rejected"), { code: "REQUEST_REJECTED" });
      },
    });
    const pipeline = definePipeline({
      id: "coded-error",
      steps: [failing],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});

    expect(result.errors).toMatchObject([
      {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "request rejected",
        phase: "execution",
        sourceCode: "REQUEST_REJECTED",
        stepId: "failing",
      },
    ]);
    expect(result.steps[0]?.error).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      sourceCode: "REQUEST_REJECTED",
    });
    expect(result.steps[0]).toMatchObject({ status: "failed", error: result.errors[0] });
  });

  it("preserves JSON-safe cause chains and the original runOrThrow cause", async () => {
    const rootCause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const thrownError = new Error("query failed", { cause: rootCause });
    const step = createSteps();
    const query = step("query", {
      run: () => {
        throw thrownError;
      },
    });
    const pipeline = definePipeline({
      id: "causal",
      steps: [query],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});

    expect(result.errors[0]).toMatchObject({
      cause: {
        message: "connection refused",
        name: "Error",
        sourceCode: "ECONNREFUSED",
      },
      code: "TUBELESS_STEP_FAILED",
      message: "query failed",
      phase: "execution",
      stepId: "query",
    });
    expect(() => JSON.stringify(result)).not.toThrow();

    let thrown: unknown;
    try {
      await pipeline.runOrThrow({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PipelineExecutionError);
    expect((thrown as PipelineExecutionError).cause).toBe(thrownError);
    expect((thrown as PipelineExecutionError).result.errors[0]?.cause).toMatchObject({
      message: "connection refused",
      sourceCode: "ECONNREFUSED",
    });
    expect((thrown as PipelineExecutionError).message).toContain("Pipeline causal failed");
    expect((thrown as PipelineExecutionError).message).toContain("execution");
    expect((thrown as PipelineExecutionError).message).toContain("TUBELESS_STEP_FAILED");
    expect((thrown as PipelineExecutionError).message).toContain("step query");
    expect((thrown as PipelineExecutionError).message).toContain(
      "ECONNREFUSED: connection refused"
    );
  });

  it("normalizes non-Error and circular causes without retaining their objects", async () => {
    const circular = new Error("circular wrapper") as Error & { cause?: unknown };
    circular.cause = circular;
    const primitiveCause = new Error("primitive wrapper", { cause: "socket closed" });
    const step = createSteps();
    const circularStep = step("circular", {
      run: () => {
        throw circular;
      },
    });
    const primitiveStep = step("primitive", {
      run: () => {
        throw primitiveCause;
      },
    });
    const pipeline = definePipeline({
      id: "safe-causes",
      steps: [circularStep, primitiveStep],
      finalize: () => undefined,
    });

    const result = await pipeline.run({ continueOnError: true });

    expect(result.errors.map(({ cause }) => cause)).toEqual([
      { message: "Circular cause" },
      { message: "socket closed" },
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("bounds deeply nested cause chains", async () => {
    let cause: Error = new Error("root cause");
    for (let index = 0; index < 10; index += 1) {
      cause = new Error(`cause ${index}`, { cause });
    }
    const thrownError = new Error("top-level failure", { cause });
    const step = createSteps();
    const fail = step("fail", {
      run: () => {
        throw thrownError;
      },
    });
    const pipeline = definePipeline({
      id: "bounded-causes",
      steps: [fail],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});
    let deepestCause = result.errors[0]?.cause;
    while (deepestCause?.cause) deepestCause = deepestCause.cause;

    expect(deepestCause).toEqual({ message: "Cause chain truncated" });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("retains cancellation as the native cause of runOrThrow", async () => {
    const cancellation = new Error("operator stopped");
    cancellation.name = "AbortError";
    const step = createSteps();
    const work = step("work", {
      run: () => {
        throw cancellation;
      },
    });
    const pipeline = definePipeline({
      id: "causal-cancellation",
      steps: [work],
      finalize: () => undefined,
    });

    let thrown: unknown;
    try {
      await pipeline.runOrThrow({});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PipelineExecutionError);
    expect((thrown as PipelineExecutionError).cause).toBe(cancellation);
    expect((thrown as PipelineExecutionError).message).toContain(
      "Pipeline causal-cancellation cancelled"
    );
    expect((thrown as PipelineExecutionError).result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      stepId: "work",
    });
  });

  it("does not misclassify an unrelated step failure when its signal is also aborted", async () => {
    const controller = new AbortController();
    const step = createSteps();
    const failing = step("failing", {
      run: () => {
        controller.abort("stop");
        throw new Error("database write failed");
      },
    });
    const pipeline = definePipeline({
      id: "failure-during-abort",
      steps: [failing],
      finalize: () => undefined,
    });

    const result = await pipeline.run({}, { cwd: "/tmp", log: console, signal: controller.signal });

    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "database write failed",
    });
  });

  it("emits a skipped state with unmet-dependency metadata when a required step failed", async () => {
    const events: unknown[] = [];
    await makePipeline("test").run(
      { failStep: "build", continueOnError: true },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onStepSkip: (event) => {
            events.push({
              dependencyId: event.dependencyId,
              reason: event.reason,
              stepId: event.step.id,
            });
          },
        },
      }
    );
    expect(events).toEqual([
      { dependencyId: "build", reason: "unmet-dependency", stepId: "write" },
    ]);
  });

  it("emits onFinalizeError with the sentinel step id when finalize throws", async () => {
    const events: unknown[] = [];
    await makePipeline("test").run(
      { failFinalize: true },
      {
        cwd: "/tmp",
        log: console,
        hooks: {
          onFinalizeError: ({ error }) => events.push(error),
        },
      }
    );
    expect(events).toEqual([
      {
        code: "TUBELESS_FINALIZATION_FAILED",
        kind: "finalization",
        message: "finalize failed",
        phase: "finalization",
        stack: expect.any(String),
        stepId: PIPELINE_FINALIZE_STEP_ID,
      },
    ]);
  });

  it("does not misclassify an unrelated finalizer failure when its signal is also aborted", async () => {
    const controller = new AbortController();
    const step = createSteps();
    const work = step("work", { run: () => true });
    const pipeline = definePipeline({
      id: "finalizer-failure-during-abort",
      steps: [work],
      finalize: () => {
        controller.abort("stop");
        throw new Error("commit failed");
      },
    });

    const result = await pipeline.run({}, { cwd: "/tmp", log: console, signal: controller.signal });

    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_FINALIZATION_FAILED",
      kind: "finalization",
      message: "commit failed",
    });
  });

  it("emits lifecycle hooks in execution order", async () => {
    const events: string[] = [];
    const focusedEvents: string[] = [];
    const result = await makePipeline("hooked").run(
      {},
      {
        cwd: "/tmp",
        hooks: {
          onFinalizeComplete: () => events.push("finalize:complete"),
          onFinalizeStart: () => events.push("finalize:start"),
          onPipelineComplete: () => events.push("pipeline:complete"),
          onPipelineStart: () => events.push("pipeline:start"),
          onStepPlan: ({ step }) => focusedEvents.push(`planned:${step.id}`),
          onStepStart: ({ step }) => focusedEvents.push(`started:${step.id}`),
          onStepStatus: ({ status, step }) => events.push(`step:${status}:${step.id}`),
          onStepComplete: ({ step }) => focusedEvents.push(`complete:${step.id}`),
        },
        log: console,
      }
    );

    expect(result.status).toBe("completed");
    expect(events).toEqual([
      "pipeline:start",
      "step:planned:build",
      "step:planned:write",
      "step:running:build",
      "step:completed:build",
      "step:running:write",
      "step:completed:write",
      "finalize:start",
      "finalize:complete",
      "pipeline:complete",
    ]);
    expect(focusedEvents).toEqual([
      "planned:build",
      "planned:write",
      "started:build",
      "complete:build",
      "started:write",
      "complete:write",
    ]);
  });

  it("emits step-scoped progress snapshots from the running step", async () => {
    const step = createSteps();
    const work = step("work", {
      description: "Process records",
      run: (_inputs, context) => {
        context.reportProgress({ completed: 2, total: 10, message: "batch 1" });
        context.reportProgress({ completed: 7, total: 10, message: "batch 2" });
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "progressive",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    const events: unknown[] = [];

    await pipeline.run(
      {},
      {
        cwd: "/tmp",
        hooks: {
          onStepProgress: (event) => events.push(event),
        },
        log: console,
      }
    );

    expect(events).toEqual([
      {
        attemptId: expect.any(String),
        pipelineId: "progressive",
        progress: { completed: 2, total: 10, message: "batch 1" },
        status: "running",
        step: expect.objectContaining({ description: "Process records", id: "work" }),
      },
      {
        attemptId: expect.any(String),
        pipelineId: "progressive",
        progress: { completed: 7, total: 10, message: "batch 2" },
        status: "running",
        step: expect.objectContaining({ description: "Process records", id: "work" }),
      },
    ]);
  });

  it("does not emit empty running progress while a step awaits", async () => {
    const step = createSteps();
    const slow = step("slow", {
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "no-empty-progress",
      steps: [slow],
      finalize: (outputs) => outputs.slow,
    });
    const progressEvents: Array<{ completed: number; total?: number; message?: string }> = [];

    await pipeline.run(
      {},
      {
        cwd: "/tmp",
        hooks: {
          onStepProgress: ({ progress, step: progressStep }) => {
            if (progressStep.id === "slow") {
              progressEvents.push(progress);
            }
          },
        },
        log: console,
      }
    );

    expect(progressEvents).toEqual([]);
  });

  it("ignores progress published after its step has finished", async () => {
    const step = createSteps();
    let reportLater: (() => void) | undefined;
    const work = step("work", {
      run: (_inputs, context) => {
        context.reportProgress({ completed: 1 });
        reportLater = () => context.reportProgress({ completed: 2 });
      },
    });
    const pipeline = definePipeline({ id: "late-progress", steps: [work], finalize: () => true });
    const completed: number[] = [];

    await pipeline.run(
      {},
      {
        cwd: "/tmp",
        hooks: {
          onStepProgress: ({ progress }) => completed.push(progress.completed),
        },
        log: console,
      }
    );
    reportLater?.();

    expect(completed).toEqual([1]);
  });

  it("isolates failures between ordered hook sets", async () => {
    const completedSteps: string[] = [];
    const warn = vi.fn();
    const result = await makePipeline("isolated-hooks").run(
      {},
      {
        cwd: "/tmp",
        hooks: [
          {
            onStepStatus: (event) => {
              if (event.status === "completed") throw new Error("metrics unavailable");
            },
          },
          {
            onStepComplete: ({ step }) => completedSteps.push(step.id),
          },
        ],
        log: { error: vi.fn(), log: vi.fn(), warn },
      }
    );

    expect(result.status).toBe("completed");
    expect(completedSteps).toEqual(["build", "write"]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("Pipeline hook failed: metrics unavailable");
  });

  it("uses injected runtime timing for reports and results", async () => {
    let currentTime = 0;
    const step = createSteps();
    const work = step("work", {
      run: () => {
        currentTime += 7;
        return "worked";
      },
    });
    const pipeline = definePipeline({
      id: "timed",
      steps: [work],
      finalize: (outputs) => {
        currentTime += 3;
        return outputs.work;
      },
    });

    const result = await pipeline.run(
      {},
      {
        cwd: "/tmp",
        log: console,
        now: () => currentTime,
      }
    );

    expect(result.finishedAtMs - result.startedAtMs).toBe(10);
    expect(result.steps[0]!.finishedAtMs - result.steps[0]!.startedAtMs!).toBe(7);
  });

  it("uses an abort-aware default sleep, rejecting once the signal it was given aborts mid-wait", async () => {
    vi.useFakeTimers();
    const step = createSteps();
    const sleepController = new AbortController();
    const work = step("work", {
      run: async (_inputs, context) => {
        await context.sleep(1000, sleepController.signal);
        return "done";
      },
    });
    const pipeline = definePipeline({
      id: "sleepy",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });

    const resultPromise = pipeline.run({}, { cwd: "/tmp", log: console });
    const assertion = expect(resultPromise).resolves.toMatchObject({
      status: "cancelled",
      errors: [
        {
          code: "TUBELESS_RUN_CANCELLED",
          kind: "cancellation",
          message: "Pipeline sleep aborted: stop",
          stepId: "work",
        },
      ],
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      sleepController.abort("stop");
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops before running the next step when the runtime signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");

    const result = await makePipeline("aborted").run(
      {},
      {
        cwd: "/tmp",
        log: console,
        signal: controller.signal,
      }
    );

    expect(result.status).toBe("cancelled");
    expect(result.finalized).toBe(false);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "cancelled"],
      ["write", "cancelled"],
    ]);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      message: "Pipeline run aborted: stop",
      phase: "execution",
      stepId: "build",
    });
    expect(result.steps[0]).toMatchObject({
      status: "cancelled",
      error: {
        code: "TUBELESS_RUN_CANCELLED",
        kind: "cancellation",
        phase: "execution",
      },
    });
  });

  it("executes steps in dependency order even when the steps array lists them out of order", async () => {
    const step = createSteps();
    const order: string[] = [];
    const build = step("build", {
      run: () => {
        order.push("build");
        return "built";
      },
    });
    const write = step("write", {
      dependsOn: [build],
      run: (inputs) => {
        order.push("write");
        return `${inputs.build}+written`;
      },
    });
    // Listed backwards on purpose: `write` before its dependency `build`.
    const pipeline = definePipeline({
      id: "reordered",
      steps: [write, build],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(order).toEqual(["build", "write"]);
    expect(result.steps.map((step) => [step.id, step.status])).toEqual([
      ["build", "completed"],
      ["write", "completed"],
    ]);
  });

  it("rejects a missing dependency when the pipeline is defined", () => {
    const step = createSteps();
    const build = step("build", { run: () => "built" });
    const write = step("write", {
      dependsOn: [build],
      run: (inputs) => `${inputs.build}+written`,
    });
    // `build` is a real dependency but never listed in `steps` — a copy/paste bug.
    expect(() =>
      definePipeline({
        id: "missing-from-list",
        steps: [write],
        finalize: (outputs) => outputs,
      })
    ).toThrow("not included in its steps list: write -> build");
  });

  it("rejects a dependency cycle when the pipeline is defined", () => {
    // Impossible to construct through the normal `const`-reference API (that's the point —
    // TDZ rules this out at compile time). Simulate the defensive runtime check by hand-
    // building a cyclic graph the way a bug in a future refactor of `createSteps` might.
    const a: AnyStep<object> = {
      id: "a",
      run: () => "a",
    };
    const b: AnyStep<object> = {
      id: "b",
      dependsOn: [a],
      run: () => "b",
    };
    (a as { dependsOn?: readonly AnyStep[] }).dependsOn = [b];

    expect(() =>
      definePipeline({
        id: "cyclic",
        steps: [a, b],
        finalize: (outputs) => outputs,
      })
    ).toThrow("dependency cycle");
  });

  it("policy-skips a step with a yellow skip report and unlocks dependents", async () => {
    interface Options {
      enableWrite: boolean;
    }
    const step = createSteps<Options>();
    let writeRan = false;
    const build = step("build", { run: () => "built" });
    const write = step.skippable("write", {
      dependsOn: [build],
      skip: (_inputs, context) =>
        context.options.enableWrite
          ? false
          : { reason: "write disabled by config", value: "skipped-write" },
      run: () => {
        writeRan = true;
        return "written";
      },
    });
    const after = step("after", {
      dependsOn: [write],
      run: (inputs) => `after:${inputs.write}`,
    });
    const pipeline = definePipeline({
      id: "policy-skip",
      steps: [build, write, after],
      finalize: (outputs) => outputs.after,
    });
    const skipEvents: unknown[] = [];

    const result = await pipeline.run(
      { enableWrite: false },
      {
        cwd: "/tmp",
        hooks: {
          onStepSkip: (event) => {
            skipEvents.push({
              message: event.message,
              reason: event.reason,
              stepId: event.step.id,
            });
          },
        },
        log: console,
      }
    );

    expect(writeRan).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.value).toBe("after:skipped-write");
    expect(
      result.steps.map((step) => [
        step.id,
        step.status,
        step.status === "skipped" ? step.reason : undefined,
        step.status === "skipped" ? step.message : undefined,
      ])
    ).toEqual([
      ["build", "completed", undefined, undefined],
      ["write", "skipped", "policy", "write disabled by config"],
      ["after", "completed", undefined, undefined],
    ]);
    expect(skipEvents).toEqual([
      {
        message: "write disabled by config",
        reason: "policy",
        stepId: "write",
      },
    ]);
  });

  it("policy-skips with a bare string publish undefined and still unlock dependents", async () => {
    const step = createSteps();
    let writeRan = false;
    const write = step.skippable("write", {
      skip: () => "write disabled",
      run: () => {
        writeRan = true;
        return "written";
      },
    });
    const after = step("after", {
      dependsOn: [write],
      run: (inputs) => {
        expectTypeOf(inputs.write).toEqualTypeOf<string | undefined>();
        return { saw: inputs.write };
      },
    });
    const pipeline = definePipeline({
      id: "policy-skip-bare-string",
      steps: [write, after],
      finalize: (outputs) => outputs.after,
    });

    const result = await pipeline.run({}, { cwd: "/tmp", log: console });

    expect(writeRan).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ saw: undefined });
    expect(
      result.steps.map((step) => [
        step.id,
        step.status,
        step.status === "skipped" ? step.reason : undefined,
        step.status === "skipped" ? step.message : undefined,
      ])
    ).toEqual([
      ["write", "skipped", "policy", "write disabled"],
      ["after", "completed", undefined, undefined],
    ]);
  });

  it("records a skip-predicate throw as a failed PipelineRun instead of rejecting", async () => {
    const step = createSteps();
    let ran = false;
    const skipEvents: string[] = [];
    const failEvents: string[] = [];
    const gate = step.skippable("gate", {
      skip: () => {
        throw new Error("skip exploded");
      },
      run: () => {
        ran = true;
        return "ran";
      },
    });
    const after = step("after", {
      dependsOn: [gate],
      run: () => "after",
    });
    const pipeline = definePipeline({
      id: "skip-throw",
      steps: [gate, after],
      finalize: (outputs) => outputs.after,
    });
    let completedRun: unknown;
    const result = await pipeline.run(
      {},
      {
        cwd: "/tmp",
        hooks: {
          onPipelineComplete: (event) => {
            completedRun = event;
          },
          onStepFail: ({ step }) => {
            failEvents.push(step.id);
          },
          onStepSkip: ({ step }) => {
            skipEvents.push(step.id);
          },
        },
        log: console,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.finalized).toBe(false);
    expect(ran).toBe(false);
    expect(
      result.steps.map((report) => [
        report.id,
        report.status,
        report.status === "skipped" ? report.reason : undefined,
      ])
    ).toEqual([
      ["gate", "failed", undefined],
      ["after", "skipped", "fail-fast"],
    ]);
    expect(result.steps[0]).toMatchObject({
      error: {
        code: "TUBELESS_STEP_FAILED",
        kind: "step",
        message: "skip exploded",
        phase: "execution",
        stepId: "gate",
      },
      status: "failed",
    });
    expect(failEvents).toEqual(["gate"]);
    expect(skipEvents).not.toContain("gate");
    expect(completedRun).toBe(result);
  });

  it("records a skip-predicate abort as a cancelled PipelineRun and runOrThrow wraps it", async () => {
    vi.useFakeTimers();
    const step = createSteps();
    let ran = false;
    const gate = step.skippable("gate", {
      skip: async (_inputs, context) => {
        await context.sleep(100, context.signal);
        return false;
      },
      run: () => {
        ran = true;
        return "ran";
      },
    });
    const pipeline = definePipeline({
      id: "skip-abort",
      steps: [gate],
      finalize: (outputs) => outputs.gate,
    });
    const context = { cwd: "/tmp", log: console };

    try {
      const runController = new AbortController();
      const runPromise = pipeline.run({}, { ...context, signal: runController.signal });
      await vi.advanceTimersByTimeAsync(50);
      runController.abort("stop");
      const result = await runPromise;

      expect(result.status).toBe("cancelled");
      expect(ran).toBe(false);
      expect(result.steps[0]).toMatchObject({
        error: {
          code: "TUBELESS_RUN_CANCELLED",
          kind: "cancellation",
          stepId: "gate",
        },
        status: "cancelled",
      });

      const throwController = new AbortController();
      const throwPromise = pipeline.runOrThrow({}, { ...context, signal: throwController.signal });
      await vi.advanceTimersByTimeAsync(50);
      throwController.abort("stop");
      let thrown: unknown;
      try {
        await throwPromise;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PipelineExecutionError);
      expect((thrown as PipelineExecutionError).result.status).toBe("cancelled");
      expect((thrown as PipelineExecutionError).result).toMatchObject({
        status: "cancelled",
        steps: [
          {
            error: {
              code: "TUBELESS_RUN_CANCELLED",
              kind: "cancellation",
              stepId: "gate",
            },
            status: "cancelled",
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues independent later work when a skip predicate throws with continueOnError", async () => {
    const step = createSteps();
    let laterRan = false;
    const gate = step.skippable("gate", {
      skip: () => {
        throw new Error("skip exploded");
      },
      run: () => "ran",
    });
    const later = step("later", {
      run: () => {
        laterRan = true;
        return "later";
      },
    });
    const pipeline = definePipeline({
      id: "skip-throw-continue",
      steps: [gate, later],
      finalize: (outputs) => outputs,
    });

    const result = await pipeline.run({ continueOnError: true }, { cwd: "/tmp", log: console });

    expect(result.status).toBe("failed");
    expect(laterRan).toBe(true);
    expect(result.steps.map((report) => [report.id, report.status])).toEqual([
      ["gate", "failed"],
      ["later", "completed"],
    ]);
  });

  it("records an invalid policy-skip value with the live-run output-validation taxonomy", async () => {
    const rejectedOutput = standardSchema<string, string>(() => ({
      issues: [{ message: "Not publishable", path: ["slug"] }],
    }));
    const step = createSteps();
    const publish = step.skippable("publish", {
      outputSchema: rejectedOutput,
      skip: () => ({ reason: "preview only", value: "draft" }),
      run: () => "live",
    });
    const after = step("after", {
      dependsOn: [publish],
      run: () => "after",
    });
    const pipeline = definePipeline({
      id: "invalid-skip-output",
      steps: [publish, after],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});

    expect(result.status).toBe("failed");
    expect(result.finalized).toBe(false);
    expect(result.steps[0]).toMatchObject({
      error: {
        code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
        issues: [{ message: "Not publishable", path: ["slug"] }],
        kind: "validation",
        phase: "execution",
        stepId: "publish",
      },
      status: "failed",
    });
    expect(
      result.steps.map((report) => [
        report.id,
        report.status,
        report.status === "skipped" ? report.reason : undefined,
      ])
    ).toEqual([
      ["publish", "failed", undefined],
      ["after", "skipped", "fail-fast"],
    ]);
  });

  it("types skippable steps as TOut | undefined for dependents", () => {
    const step = createSteps();

    const plain = step("plain", { run: () => "ok" as const });
    expectTypeOf(plain).toEqualTypeOf<Step<"plain", "ok", object>>();

    const withSkip = step.skippable("with-skip", {
      skip: () => "disabled",
      run: () => "ok" as const,
    });
    expectTypeOf(withSkip).toEqualTypeOf<Step<"with-skip", "ok" | undefined, object>>();

    const dependent = step("dependent", {
      dependsOn: [withSkip],
      run: (inputs) => {
        expectTypeOf(inputs["with-skip"]).toEqualTypeOf<"ok" | undefined>();
        return inputs["with-skip"] ?? "fallback";
      },
    });
    expectTypeOf(dependent).toEqualTypeOf<Step<"dependent", "ok" | "fallback", object>>();

    // Config-gated: `skip: predicate | undefined` stays explicit and widens.
    const enableSkip = false as boolean;
    const gated = step.skippable("gated-skip", {
      skip: enableSkip ? () => "disabled" : undefined,
      run: () => "ok" as const,
    });
    expectTypeOf(gated).toEqualTypeOf<Step<"gated-skip", "ok" | undefined, object>>();

    const explicitUndefined = step.skippable("explicit-undefined-skip", {
      skip: undefined,
      run: () => "ok" as const,
    });
    expectTypeOf(explicitUndefined).toEqualTypeOf<
      Step<"explicit-undefined-skip", "ok" | undefined, object>
    >();

    step("skip-requires-skippable", {
      // @ts-expect-error Policy skip belongs on step.skippable.
      skip: () => "disabled",
      run: () => "ok" as const,
    });

    const reusableSkippingDefinition = {
      skip: () => "disabled",
      run: () => "ok" as const,
    };
    // @ts-expect-error Reusable definitions cannot bypass step.skippable.
    step("reusable-skip-requires-skippable", reusableSkippingDefinition);
  });
});
