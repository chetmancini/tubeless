import { describe, expect, it } from "vitest";
import {
  compilePipelineGraph,
  stepEdges,
  targetClosure,
  topologicalSort,
} from "./pipeline-graph.js";
import type { AnyStep } from "./pipeline-steps.js";

function step(id: string, fields: Partial<AnyStep> = {}): AnyStep {
  return { id, run: () => id, ...fields };
}

describe("pipeline graph", () => {
  it("deduplicates a dependency that participates in multiple policies", () => {
    const source = step("source");
    const consume = step("consume", {
      optionalDependsOn: [source],
      skipAfterFailureOf: [source],
    });

    expect(stepEdges(consume)).toEqual([source]);
  });

  it("orders dependencies before dependents while preserving declaration tie order", () => {
    const first = step("first");
    const second = step("second");
    const last = step("last", { dependsOn: [first, second] });

    expect(topologicalSort([last, second, first])).toEqual([second, first, last]);
  });

  it("returns null for a dependency cycle", () => {
    const first = step("first");
    const second = step("second", { dependsOn: [first] });
    Object.assign(first, { dependsOn: [second] });

    expect(topologicalSort([first, second])).toBeNull();
  });

  it("includes required inputs and failure gates but excludes optional-only inputs from targets", () => {
    const required = step("required");
    const optional = step("optional");
    const gate = step("gate");
    const target = step("target", {
      dependsOn: [required],
      optionalDependsOn: [optional],
      skipAfterFailureOf: [gate],
    });

    expect([...targetClosure([target])]).toEqual([target, required, gate]);
  });

  it("compiles immutable steps and dependency arrays", () => {
    const dependencies: AnyStep[] = [];
    const source = step("source");
    dependencies.push(source);
    const consume = step("consume", { dependsOn: dependencies });

    const compiled = compilePipelineGraph({ orderedSteps: [source, consume] });
    dependencies.length = 0;
    Object.assign(source, { id: "mutated" });

    expect(compiled.orderedSteps.map(({ id }) => id)).toEqual(["source", "consume"]);
    const [compiledSource, compiledConsume] = compiled.orderedSteps;
    expect(compiledConsume!.dependsOn).toEqual([compiledSource]);
    expect(compiledConsume!.dependsOn.map(({ id }) => id)).toEqual(["source"]);
    expect(Object.isFrozen(compiledConsume)).toBe(true);
    expect(Object.isFrozen(compiledConsume!.dependsOn)).toBe(true);
  });

  it("normalizes every edge policy onto compiled steps without touching author steps", () => {
    const required = step("required");
    const optional = step("optional");
    const gate = step("gate");
    const target = step("target", {
      dependsOn: [required],
      optionalDependsOn: [optional],
      skipAfterFailureOf: [gate],
    });

    const compiled = compilePipelineGraph({ orderedSteps: [required, optional, gate, target] });
    const compiledOf = (author: AnyStep) => compiled.compiledByAuthorStep.get(author)!;

    expect(compiledOf(target).dependsOn).toEqual([compiledOf(required)]);
    expect(compiledOf(target).optionalDependsOn).toEqual([compiledOf(optional)]);
    expect(compiledOf(target).skipAfterFailureOf).toEqual([compiledOf(gate)]);
    expect(compiledOf(required).dependsOn).toEqual([]);
    expect(stepEdges(compiledOf(target))).toEqual([required, optional, gate].map(compiledOf));
    expect(target.dependsOn).toEqual([required]);
    expect(Object.isFrozen(target)).toBe(false);
  });

  it("rejects dependencies that are not compiled before their dependents", () => {
    const source = step("source");
    const consume = step("consume", { dependsOn: [source] });

    expect(() => compilePipelineGraph({ orderedSteps: [consume, source] })).toThrow(
      "Compiled pipeline graph requires dependency source before step consume"
    );
  });
});
