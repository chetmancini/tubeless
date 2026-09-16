import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createSteps, definePipeline, requireOutputs } from "./pipeline.js";
import { makePipeline, standardSchema, thrownDefinitionErrors } from "./pipeline.test-support.js";

describe("definePipeline run and selection", () => {
  it("returns one versioned run with public identities and timestamps", async () => {
    const log = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    let timestampMs = 100;
    const step = createSteps<{ source: string }>();
    let executionRunId = "";
    const load = step("load", {
      run: (_inputs, context) => {
        executionRunId = context.runId;
        expect(context.correlationId).toBe("job-public");
        expect(context.runId).toMatch(/^public-run-model:/);
        expect(context.parentRunId).toBe("run-parent");
        expect(context.attemptId).toBe(`${context.runId}:attempt:1`);
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

    const result = await pipeline.run({ source: "rows.json" }, undefined, {
      cwd: "/tmp",
      log,
      now: () => timestampMs++,
      parentRunId: "run-parent",
      correlationId: "job-public",
    });

    expect(result).toMatchObject({
      correlationId: "job-public",
      parentRunId: "run-parent",
      pipelineId: "public-run-model",
      runId: executionRunId,
      status: "completed",
      version: 2,
    });
    expect(result.finishedAtMs).toBeGreaterThanOrEqual(result.startedAtMs);
    const report = result.steps[0]!;
    expect(report.finishedAtMs).toBeGreaterThanOrEqual(report.startedAtMs!);
    expect(report).toMatchObject({
      attemptId: `${executionRunId}:attempt:1`,
      id: "load",
      status: "completed",
    });
    expect(log.log).toHaveBeenCalledWith("loading", "rows.json");
  });

  it("ignores forged Studio preallocation symbols", async () => {
    const step = createSteps();
    const pipeline = definePipeline({
      id: "private-run-identity",
      steps: [step("work", { run: () => "ok" })],
      finalize: () => "ok",
    });
    const forgedContext = {
      correlationId: "job-private",
      [Symbol.for("tubeless.pipeline.preallocatedRunId")]: "forged-run-id",
    };

    const result = await pipeline.run({}, undefined, forgedContext);

    expect(result.runId).toMatch(/^private-run-identity:/);
    expect(result.runId).not.toBe("forged-run-id");
    expect(result.correlationId).toBe("job-private");
  });

  it("exports one completed token for run, step, and progress-detail statuses", () => {
    expectTypeOf<
      import("./pipeline.js").PipelineStepCompleteReport["status"]
    >().toEqualTypeOf<"completed">();
    expectTypeOf<import("./pipeline.js").PipelineRunStatus>().toEqualTypeOf<
      "cancelled" | "completed" | "failed"
    >();
    expectTypeOf<import("./pipeline.js").PipelineStepReportStatus>().toEqualTypeOf<
      "cancelled" | "completed" | "failed" | "skipped"
    >();
    expectTypeOf<import("./pipeline.js").PipelineStepLifecycleStatus>().toEqualTypeOf<
      import("./pipeline.js").PipelineStepStatus["status"]
    >();
    expectTypeOf<import("./pipeline.js").PipelineStepProgressDetailStatus>().toEqualTypeOf<
      "cancelled" | "completed" | "failed" | "pending" | "running" | "skipped"
    >();
    expectTypeOf<import("./pipeline.js").MappedChildProgressOptions["itemNoun"]>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("does not observe continueOnError mutations after run starts", async () => {
    const controls = { continueOnError: true };
    const step = createSteps();
    const fail = step("fail", {
      run: async () => {
        controls.continueOnError = false;
        throw new Error("boom");
      },
    });
    const later = step("later", { run: () => "ok" });
    const pipeline = definePipeline({
      id: "snapshot-controls",
      steps: [fail, later],
      finalize: (outputs) => outputs.later,
    });

    const result = await pipeline.run({}, controls);

    expect(result.status).not.toBe("completed");
    expect(result.finalized).toBe(true);
    expect(result.value).toBe("ok");
    expect(result.steps.map(({ id, status }) => [id, status])).toEqual([
      ["fail", "failed"],
      ["later", "completed"],
    ]);
  });

  it("reads dryRun from prototype getters on the controls object", async () => {
    class DryRunControls {
      get dryRun(): boolean {
        return true;
      }
    }
    const sideEffect = vi.fn();
    const step = createSteps();
    const write = step("write", { dryRun: "skip", run: sideEffect });
    const pipeline = definePipeline({
      id: "class-dry-run-controls",
      steps: [write],
      finalize: () => "ok",
    });

    await expect(pipeline.runOrThrow({}, new DryRunControls())).resolves.toBe("ok");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("rejects steps mixed across options-schema scopes", () => {
    const schemaA = standardSchema<object, object>((value) => ({ value: value as object }), "a");
    const schemaB = standardSchema<object, object>((value) => ({ value: value as object }), "b");
    const first = createSteps(schemaA)("first", { run: () => 1 });
    const second = createSteps(schemaB)("second", { run: () => 2 });

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({
          id: "mixed-options-schemas",
          steps: [first, second],
          finalize: () => undefined,
        })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_OPTIONS_SCHEMA_CONFLICT",
      kind: "definition",
      phase: "definition",
    });
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

    expect(
      thrownDefinitionErrors(() =>
        definePipeline({ id: "named", steps: [invalid], finalize: () => undefined })
      )[0]
    ).toMatchObject({
      code: "TUBELESS_DEFINITION_STEP_NAME_BLANK",
      kind: "definition",
      phase: "definition",
      stepId: "normalize-data",
    });
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
    const result = await makePipeline("test").run({}, { stepIds: ["missing" as never] });
    expect(result.status).not.toBe("completed");
    expect(result.steps).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_STEP_UNKNOWN",
      kind: "selection",
      phase: "planning",
    });
  });

  it("rejects an empty stepIds array during planning and execution", async () => {
    const pipeline = makePipeline("empty-selection");

    const plan = pipeline.plan({ stepIds: [] });
    expect(plan.ok).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_STEP_SELECTION_EMPTY",
      kind: "selection",
      phase: "planning",
    });

    const result = await pipeline.run({}, { stepIds: [] });
    expect(result.status).not.toBe("completed");
    expect(result.steps).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_PLANNING_STEP_SELECTION_EMPTY",
      kind: "selection",
      phase: "planning",
    });
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

    const selected = await pipeline.run({}, { stepIds: ["build"] });
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
    const result = await pipeline.run({}, { targets: ["publish"] });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("source:none");
    expect(ran).toEqual(["source", "validate", "publish"]);

    ran.length = 0;
    failValidation = true;
    const failedGate = await pipeline.run({}, { continueOnError: true, targets: ["publish"] });
    expect(failedGate.steps.find(({ id }) => id === "publish")).toMatchObject({
      dependencyId: "validate",
      reason: "failed-dependency",
      status: "skipped",
    });
    expect(ran).toEqual(["source", "validate"]);
  });
});
