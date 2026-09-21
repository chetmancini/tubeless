import { describe, expect, expectTypeOf, it } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { defineProject, isPipelineProject } from "./pipeline-project.js";

const { step: alphaStep } = createSteps<{ value: string }>();
const alpha = definePipeline({
  id: "alpha",
  steps: [alphaStep("read-alpha", { run: (_inputs, context) => context.options.value })],
});

const { step: betaStep } = createSteps<{ value: number }>();
const beta = definePipeline({
  id: "beta",
  steps: [betaStep("read-beta", { run: (_inputs, context) => context.options.value })],
});

describe("pipeline project", () => {
  it("keeps pipelines discoverable by their literal ids", async () => {
    const project = defineProject("example", [alpha, beta]);

    expect(project.id).toBe("example");
    expect(project.pipelineIds).toEqual(["alpha", "beta"]);
    expect(project.get("alpha")).toBe(alpha);
    await expect(project.get("beta").runOrThrow({ value: 42 })).resolves.toBe(42);
    expectTypeOf(project.pipelineIds).toEqualTypeOf<readonly ["alpha", "beta"]>();
    expectTypeOf(project.id).toEqualTypeOf<"example">();
    expectTypeOf(project.get("alpha")).toEqualTypeOf<typeof alpha>();
    expectTypeOf(project.get("beta").runOrThrow).parameter(0).toEqualTypeOf<{ value: number }>();
  });

  it("takes an immutable snapshot and rejects duplicate ids", () => {
    const pipelines = [alpha];
    const project = defineProject("example", pipelines);
    pipelines.push(alpha);

    expect(project.pipelines).toEqual([alpha]);
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.pipelines)).toBe(true);
    expect(isPipelineProject(project)).toBe(true);
    expect(isPipelineProject({ ...project })).toBe(false);
    expect(() => defineProject("duplicate", [alpha, alpha])).toThrow(
      'pipeline id "alpha" is declared more than once'
    );
    expect(() => defineProject("", [alpha])).toThrow("Project id must be a non-empty string");
  });

  it("defines the same project shape from a parsed pipeline document", async () => {
    const project = defineProject(
      "declarative-example",
      {
        version: 1,
        pipelines: {
          greeting: {
            steps: [{ id: "greet", run: "greet" }],
            finalize: { run: "result", requireOutputs: ["greet"] },
          },
        },
      },
      {
        steps: { greet: () => "hello" },
        finalizers: { result: ({ greet }) => greet },
      }
    );

    expect(project).toMatchObject({ id: "declarative-example", pipelineIds: ["greeting"] });
    await expect(project.get("greeting").runOrThrow({})).resolves.toBe("hello");
  });
});
