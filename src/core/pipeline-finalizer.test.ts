import { describe, expect, expectTypeOf, it } from "vitest";
import { createSteps, definePipeline, requireOutputs } from "./pipeline.js";
import { PIPELINE_FINALIZE_STEP_ID } from "./pipeline-step-metadata.js";

describe("pipeline finalizers", () => {
  it("requires declared finalizer outputs without rejecting a published undefined", async () => {
    const { step } = createSteps();
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

    const filtered = await pipeline.run({}, { stepIds: ["write"] });
    expect(filtered.status).toBe("failed");
    expect(filtered.finalized).toBe(false);
    expect(filtered.errors[0]).toMatchObject({
      message: "Required pipeline outputs missing: build, write",
      stepId: PIPELINE_FINALIZE_STEP_ID,
    });
  });

  it("snapshots required finalizer output ids when the pipeline is defined", async () => {
    const { step } = createSteps();
    const value = step("value", { run: () => 1 });
    const pipeline = definePipeline({
      id: "required-finalizer-id-snapshot",
      steps: [value],
      finalize: requireOutputs([value], ({ value }) => value),
    });

    Reflect.set(value, "id", "renamed");

    await expect(pipeline.runOrThrow({})).resolves.toBe(1);
  });
});
