import { describe, expect, it, vi } from "vitest";
import { createSteps, definePipeline } from "./pipeline.js";

describe("pipeline Mermaid rendering", () => {
  it("renders every dependency policy without running the pipeline", () => {
    const { step } = createSteps();
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
    const { step } = createSteps();
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
});
