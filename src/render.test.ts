import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type PipelineError } from "./pipeline";
import { renderPipelineError, renderPipelinePlan } from "./render";

function makeTargetPlan() {
  const step = createSteps();
  const source = step("source", {
    name: "Load Source",
    description: "Read source records.",
    run: () => "source",
  });
  const hint = step("hint", { run: () => "hint" });
  const publish = step("publish", {
    dependsOn: [source],
    optionalDependsOn: [hint],
    run: () => "published",
  });
  const pipeline = definePipeline({
    id: "rendered-plan",
    steps: [source, hint, publish],
    targets: [publish],
    finalize: (outputs) => outputs.publish,
  });
  return pipeline.plan({ targets: ["publish"] });
}

describe("pipeline rendering", () => {
  it("renders a human plan from its structured selection provenance", () => {
    const rendered = renderPipelinePlan(makeTargetPlan());

    expect(rendered).toContain("Pipeline rendered-plan: plan");
    expect(rendered).toContain("Load Source [source]: run");
    expect(rendered).toContain("required by publish for target publish");
    expect(rendered).toContain("hint: skip: filtered");
    expect(rendered).toContain("optional-only input to publish for target publish");
    expect(rendered).toContain("publish: run (target publish)");
  });

  it("can omit explanations without changing the plan", () => {
    const plan = makeTargetPlan();
    const rendered = renderPipelinePlan(plan, { explain: false });

    expect(rendered).toContain("Load Source [source]: run");
    expect(rendered).toContain("hint: skip: filtered");
    expect(rendered).not.toContain("required by");
    expect(rendered).not.toContain("optional-only");
    expect(plan.steps[0]?.selectionReasons).toEqual([
      { dependentId: "publish", kind: "required-dependency", targetId: "publish" },
    ]);
  });

  it("renders the same plan as compact or pretty machine-readable JSON", () => {
    const plan = makeTargetPlan();
    const compact = renderPipelinePlan(plan, { format: "json" });
    const pretty = renderPipelinePlan(plan, { format: "json", pretty: true });

    expect(JSON.parse(compact)).toEqual(plan);
    expect(JSON.parse(pretty)).toEqual(plan);
    expect(compact).not.toContain("\n");
    expect(pretty).toContain("\n");
  });

  it("identifies opaque child-pipeline steps without flattening their plan", () => {
    const childStep = createSteps();
    const read = childStep("read", { run: () => "read" });
    const write = childStep("write", { dependsOn: [read], run: () => "written" });
    const child = definePipeline({ id: "child", steps: [read, write], finalize: () => true });
    const parentStep = createSteps();
    const nested = parentStep.fromPipeline("nested", {
      pipeline: child,
      mapOptions: () => ({}),
    });
    const parent = definePipeline({ id: "parent", steps: [nested], finalize: () => true });

    const plan = parent.plan({});

    expect(plan.steps[0]?.nestedPipeline).toEqual({
      mode: "single",
      pipelineId: "child",
      stepIds: ["read", "write"],
    });
    expect(renderPipelinePlan(plan)).toContain("child pipeline child (2 declared steps)");
  });

  it("identifies remote steps and says when a dry run contacts the engine", () => {
    const schema = {
      "~standard": {
        validate: () => ({ value: { ok: true as const } }),
        vendor: "test",
        version: 1 as const,
      },
    };
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: {
        engine: "lambda",
        target: "enrich-v2",
        invoke: async () => ({ ok: true as const }),
      },
      mapInput: () => ({}),
      outputSchema: schema,
    });
    const charge = step.fromRemote("charge", {
      adapter: {
        engine: "temporal",
        target: "chargeOrder",
        invoke: async () => ({ ok: true as const }),
      },
      mapInput: () => ({}),
      outputSchema: schema,
      dryRun: "skip",
    });
    const pipeline = definePipeline({
      id: "remote-render",
      steps: [enrich, charge],
      finalize: () => undefined,
    });

    const dry = pipeline.plan({ dryRun: true });
    const rendered = renderPipelinePlan(dry);
    expect(dry.steps[0]?.remote).toEqual({ engine: "lambda", target: "enrich-v2" });
    expect(rendered).toContain("enrich: run -> remote lambda (enrich-v2); dry-run contacts engine");
    expect(rendered).toContain("charge: skip: dry-run -> remote temporal (chargeOrder)");

    const live = renderPipelinePlan(pipeline.plan({}));
    expect(live).toContain("enrich: run -> remote lambda (enrich-v2)");
    expect(live).not.toContain("dry-run contacts engine");
  });

  it("uses one diagnostic rendering for human messages and JSON output", () => {
    const error: PipelineError = {
      cause: {
        message: "connection refused",
        name: "Error",
        sourceCode: "ECONNREFUSED",
      },
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "query failed",
      phase: "execution",
      sourceCode: "QUERY_FAILED",
      stepId: "query",
    };

    const human = renderPipelineError(error);

    expect(human).toContain("execution at step query");
    expect(human).toContain("TUBELESS_STEP_FAILED");
    expect(human).toContain("QUERY_FAILED");
    expect(human).toContain("ECONNREFUSED: connection refused");
    expect(JSON.parse(renderPipelineError(error, { format: "json" }))).toEqual(error);
  });
});
