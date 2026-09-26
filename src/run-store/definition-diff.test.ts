import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type PipelineMetadata } from "../core/pipeline.js";
import { compareDefinitions } from "./definition-diff.js";

function definition(metadata?: PipelineMetadata) {
  const { step } = createSteps();
  return definePipeline({
    id: "metadata-diff",
    metadata,
    steps: [step("work", { metadata, run: () => 1 })],
  }).definition;
}

describe("definition metadata comparison", () => {
  it("uses identity's recursive key ordering for pipeline and step metadata", () => {
    const before = definition({
      owner: "data",
      annotations: { z: [{ b: 2, a: 1 }], a: { y: false, x: null } },
    });
    const after = definition({
      annotations: { a: { x: null, y: false }, z: [{ a: 1, b: 2 }] },
      owner: "data",
    });
    expect(before.identity).toEqual(after.identity);
    expect(compareDefinitions(before, after)).toEqual([]);
  });

  it.each([
    [{ annotations: { nested: { value: 1 } } }, { annotations: { nested: { value: 2 } } }],
    [{ annotations: { list: [1, 2] } }, { annotations: { list: [2, 1] } }],
    [{ tags: ["a", "b"] }, { tags: ["b", "a"] }],
    [undefined, {}],
    [{ owner: "data" }, undefined],
  ] satisfies [PipelineMetadata | undefined, PipelineMetadata | undefined][])(
    "retains real metadata changes and array order (%#)",
    (left, right) => {
      const before = definition(left);
      const after = definition(right);
      expect(before.identity).not.toEqual(after.identity);
      expect(
        compareDefinitions(before, after).map(({ field, stepId }) => ({ field, stepId }))
      ).toEqual([
        { field: "Metadata", stepId: undefined },
        { field: "Metadata", stepId: "work" },
      ]);
    }
  );
});
