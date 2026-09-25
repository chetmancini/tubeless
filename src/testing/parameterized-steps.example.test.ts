import { describe, expect, expectTypeOf, it } from "vitest";
import { createSteps, definePipeline } from "tubeless";
import type { PipelineTraceEvent } from "tubeless/tracing";
import { createPipelineTestRuntime } from "tubeless/testing";
import {
  checks,
  defineRangeChecks,
  OrderChecksPipeline,
  prices,
  quantities,
  runParameterizedStepsExample,
} from "../../examples/parameterized-steps.js";

const options = { quantities: [2, 3], prices: [10, 5] };

describe("parameterized step recipe", () => {
  it("preserves tuple positions, literal IDs, and dependency outputs", async () => {
    expectTypeOf(checks[0].id).toEqualTypeOf<"positive-quantities">();
    expectTypeOf(checks[1].id).toEqualTypeOf<"bounded-quantities">();
    expectTypeOf(checks[2].id).toEqualTypeOf<"valid-prices">();
    expectTypeOf(checks.length).toEqualTypeOf<3>();
    const { step } = createSteps<typeof options>();
    const join = step("join", {
      dependsOn: checks,
      run: (inputs) => {
        expectTypeOf(inputs["positive-quantities"]).toEqualTypeOf<number>();
        expectTypeOf(inputs["bounded-quantities"]).toEqualTypeOf<number>();
        expectTypeOf(inputs["valid-prices"]).toEqualTypeOf<number>();
        // @ts-expect-error The family does not widen dependency keys to string.
        inputs["typo"];
        return Object.values(inputs).reduce((sum, count) => sum + count, 0);
      },
    });
    const pipeline = definePipeline({ id: "joined", steps: [quantities, prices, ...checks, join] });
    await expect(pipeline.runOrThrow(options)).resolves.toBe(6);
    await expect(runParameterizedStepsExample()).resolves.toEqual({
      quantityCount: 2,
      priceCount: 2,
    });

    // oxlint-disable-next-line no-constant-condition -- typecheck-only compile probes
    if (false) {
      // @ts-expect-error Step IDs remain literal after spreading the tuple.
      OrderChecksPipeline.plan({ stepIds: ["typo"] });
      // @ts-expect-error Target IDs remain literal after spreading the tuple.
      OrderChecksPipeline.plan({ targets: ["typo"] });
      // @ts-expect-error A source step is not a declared target.
      OrderChecksPipeline.plan({ targets: ["quantities"] });
      // @ts-expect-error Duplicate literal IDs remain visible to definition validation.
      definePipeline({ id: "duplicate-literal", steps: [quantities, checks[0], checks[0]] });
      const text = step("text", { run: () => "not numeric data" });
      // @ts-expect-error Specs require a source publishing numeric arrays.
      defineRangeChecks([{ id: "bad", description: "Bad source", source: text, min: 0, max: 1 }]);
    }
  });

  it("exposes ordinary expanded steps and selects only a target's prerequisites", () => {
    const plan = OrderChecksPipeline.plan({ targets: ["valid-prices"] });
    expect(plan.ok).toBe(true);
    expect(plan.steps.filter((s) => s.selected).map((s) => s.id)).toEqual([
      "prices",
      "valid-prices",
    ]);
    for (const check of checks) {
      expect(plan.steps.find((s) => s.id === check.id)).toMatchObject({
        dependencies: check.dependsOn?.map((s) => s.id),
        description: check.description,
      });
      expect(OrderChecksPipeline.toMermaid()).toContain(check.id);
    }
    expect(plan.steps).toHaveLength(6);
  });

  it("runs pure checks during dry runs and supports concurrent execution", async () => {
    for (const dryRun of [false, true]) {
      const runtime = createPipelineTestRuntime();
      const run = await runtime.run(OrderChecksPipeline, options, { dryRun, maxConcurrency: 3 });
      expect(run.status).toBe("completed");
      expect(run.value).toEqual({ quantityCount: 2, priceCount: 2 });
      expect(run.steps).toHaveLength(6);
    }
  });

  it("reports a failed check and blocks its dependent while other checks finish", async () => {
    const runtime = createPipelineTestRuntime();
    const run = await runtime.run(
      OrderChecksPipeline,
      { ...options, quantities: [101] },
      {
        continueOnError: true,
        maxConcurrency: 3,
      }
    );
    expect(run.status).toBe("failed");
    expect(run.steps.find((s) => s.id === "bounded-quantities")?.status).toBe("failed");
    expect(run.steps.find((s) => s.id === "valid-prices")?.status).toBe("completed");
    expect(run.steps.find((s) => s.id === "summarize")).toMatchObject({
      status: "skipped",
      reason: "unmet-dependency",
    });
  });

  it("traces each expanded step without a family wrapper", async () => {
    const events: PipelineTraceEvent[] = [];
    const runtime = createPipelineTestRuntime();
    await OrderChecksPipeline.runOrThrow(
      options,
      {},
      {
        ...runtime.context,
        tracing: {
          exporter: {
            export: (event) => {
              events.push(event);
            },
          },
        },
      }
    );
    expect(
      events.filter((event) => event.name === "step.running").map((event) => event.stepId)
    ).toEqual(["quantities", "prices", ...checks.map((check) => check.id), "summarize"]);
  });

  it("retains ordinary cancellation and graph validation", async () => {
    const runtime = createPipelineTestRuntime();
    runtime.abort();
    const run = await runtime.run(OrderChecksPipeline, options);
    expect(run.status).toBe("cancelled");
    expect(run.steps.every((s) => s.status === "cancelled")).toBe(true);
    expect(defineRangeChecks([])).toEqual([]);
    const spec = {
      id: "duplicate",
      description: "Repeated ID",
      source: quantities,
      min: 0,
      max: 100,
    };
    // Widen the input to exercise runtime validation as well as literal checks.
    const duplicateChecks = defineRangeChecks([spec, spec]);
    expect(() =>
      definePipeline({ id: "duplicates", steps: [quantities, ...duplicateChecks] })
    ).toThrow();
    expect(() => definePipeline({ id: "missing-source", steps: [...checks] })).toThrow();
  });
});
