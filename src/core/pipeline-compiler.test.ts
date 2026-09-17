import { describe, expect, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type AnyStep,
  type PipelineExecutionContext,
  type StandardSchemaV1,
} from "./pipeline.js";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"],
  vendor = "test"
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor, version: 1 } };
}

describe("pipeline compilation", () => {
  it("plans from the compiled graph after define, ignoring later definition mutations", async () => {
    const { step } = createSteps();
    const build = step("build", { run: () => "built" });
    const definition = {
      id: "sealed",
      steps: [build],
      finalize: () => "ok" as const,
    };
    const pipeline = definePipeline(definition);
    (definition as { steps: AnyStep[] }).steps = [build, build];

    const plan = pipeline.plan();
    expect(plan.ok).toBe(true);
    expect(plan.errors).toEqual([]);
    expect(plan.steps.map((planned) => planned.id)).toEqual(["build"]);

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.steps.map((report) => report.id)).toEqual(["build"]);
    expect(result.value).toBe("ok");
  });

  it("plans from snapshotted dependency arrays after define", async () => {
    const { step } = createSteps();
    const build = step("build", { run: () => "built" });
    const extra = step("extra", { run: () => "extra" });
    const dependsOn = [build];
    const write = step("write", {
      dependsOn,
      run: ({ build }) => `${build}+write`,
    });
    const pipeline = definePipeline({
      id: "sealed-deps",
      steps: [build, write],
      finalize: (outputs) => outputs.write,
    });
    // SAFETY: mutate the authoring array after define to prove the compiled
    // graph snapshotted original membership; extra is a different step id.
    (dependsOn as AnyStep[]).push(extra);

    const plan = pipeline.plan();
    expect(plan.ok).toBe(true);
    expect(plan.steps.find((planned) => planned.id === "write")?.dependencies).toEqual(["build"]);

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value).toBe("built+write");
    expect(result.steps.map((report) => report.id)).toEqual(["build", "write"]);
  });

  it("defines a pipeline from frozen steps with dependencies", async () => {
    const { step } = createSteps();
    const build = step("build", { run: () => "built" });
    const write = step("write", {
      dependsOn: [build],
      run: ({ build }) => `${build}+write`,
    });
    Object.freeze(write);
    const pipeline = definePipeline({
      id: "frozen-step",
      steps: [build, write],
      finalize: (outputs) => outputs.write,
    });

    const plan = pipeline.plan();
    expect(plan.ok).toBe(true);
    expect(plan.steps.find((planned) => planned.id === "write")?.dependencies).toEqual(["build"]);

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value).toBe("built+write");
  });

  it("plans from snapshotted absent dependency fields after define", async () => {
    const { step } = createSteps();
    const later = step("later", { run: () => "later" });
    const earlier = step("earlier", { run: () => "earlier" });
    const pipeline = definePipeline({
      id: "absent-deps",
      steps: [later, earlier],
      finalize: (outputs) => `${outputs.later}+${outputs.earlier}`,
    });
    Object.assign(later, { dependsOn: [earlier] });

    const plan = pipeline.plan();
    expect(plan.ok).toBe(true);
    expect(plan.steps.find((planned) => planned.id === "later")?.dependencies).toEqual([]);
    expect(plan.steps.find((planned) => planned.id === "later")?.skipReason).toBeUndefined();

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value).toBe("later+earlier");
    expect(result.steps.map((report) => report.id)).toEqual(["later", "earlier"]);
  });

  it("compiles immutable step metadata, handlers, schemas, and dependency graphs", async () => {
    const originalSchema = standardSchema<string, string>((value) => ({
      value: `validated:${value as string}`,
    }));
    const replacementSchema = standardSchema<string, string>(() => ({
      issues: [{ message: "replacement schema ran" }],
    }));
    const originalValidate = vi.spyOn(originalSchema["~standard"], "validate");
    const replacementValidate = vi.spyOn(replacementSchema["~standard"], "validate");
    const { step } = createSteps();
    const required = step("required", { run: () => "required" });
    const optional = step("optional", { run: () => "optional" });
    const gate = step("gate", { run: () => "gate" });

    class MethodStep implements AnyStep {
      readonly #prefix = "private";
      id = "work";
      name = "Original name";
      description = "Original description";
      outputSchema: StandardSchemaV1 = originalSchema;
      dependsOn: AnyStep[] = [required];
      optionalDependsOn: AnyStep[] = [optional];
      skipAfterFailureOf: AnyStep[] = [gate];

      skip() {
        return this.#prefix === "private" ? false : "unreachable";
      }

      dryRun() {
        return `${this.#prefix}:dry`;
      }

      run(inputs: Record<string, unknown>) {
        return `${this.#prefix}:${inputs.required}:${inputs.optional}`;
      }
    }

    const work = new MethodStep();
    const pipeline = definePipeline({
      id: "immutable-steps",
      steps: [required, optional, gate, work],
      targets: [work],
      finalize: (outputs) => outputs.work,
    });

    Reflect.set(required, "id", "renamed-required");
    Reflect.set(required, "run", () => "mutated-required");
    Reflect.set(optional, "id", "renamed-optional");
    Reflect.set(gate, "id", "renamed-gate");
    Reflect.set(work, "id", "renamed-work");
    Reflect.set(work, "name", "Mutated name");
    Reflect.set(work, "description", "Mutated description");
    Reflect.set(work, "run", () => "mutated-run");
    Reflect.set(work, "skip", () => "mutated-skip");
    Reflect.set(work, "dryRun", "skip");
    Reflect.set(work, "outputSchema", replacementSchema);
    work.dependsOn.length = 0;
    work.optionalDependsOn.length = 0;
    work.skipAfterFailureOf.length = 0;

    expect(pipeline.stepIds).toEqual(["required", "optional", "gate", "work"]);
    expect(pipeline.targetIds).toEqual(["work"]);
    expect(pipeline.plan().steps.at(-1)).toMatchObject({
      dependencies: ["required"],
      description: "Original description",
      dryRun: "custom",
      id: "work",
      name: "Original name",
      optionalDependencies: ["optional"],
      runtimeSkipPossible: true,
      skipAfterFailureOf: ["gate"],
    });
    expect(pipeline.toMermaid({ includeDescriptions: true })).toContain(
      "Original name — Original description"
    );
    expect(pipeline.toMermaid({ includeDescriptions: true })).not.toContain("Mutated");

    await expect(pipeline.runOrThrow({})).resolves.toBe("validated:private:required:optional");
    await expect(pipeline.runOrThrow({}, { dryRun: true })).resolves.toBe("validated:private:dry");
    expect(originalValidate).toHaveBeenCalledTimes(2);
    expect(replacementValidate).not.toHaveBeenCalled();
  });

  it("runs class steps whose contract members live on the prototype", async () => {
    const deps: AnyStep[] = [];
    class PrototypeStep implements AnyStep {
      constructor(readonly id: string) {}

      get dependsOn() {
        return deps;
      }

      skip(_inputs: Record<string, unknown>, _context: PipelineExecutionContext<object>): false {
        return false;
      }

      run() {
        return "from-class";
      }
    }

    const work = new PrototypeStep("work");
    const pipeline = definePipeline({
      id: "class-step",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });
    deps.push(work);

    const plan = pipeline.plan();
    expect(plan.ok).toBe(true);
    expect(plan.steps.find((planned) => planned.id === "work")?.dependencies).toEqual([]);

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value).toBe("from-class");
  });

  it("runs class steps whose accessors use private fields", async () => {
    class PrivateStep implements AnyStep {
      #id: string;
      #label: string;
      constructor(id: string, label: string) {
        this.#id = id;
        this.#label = label;
      }

      get id() {
        return this.#id;
      }

      get name() {
        return this.#label;
      }

      run() {
        return this.#label;
      }
    }

    const work = new PrivateStep("work", "from-private");
    const pipeline = definePipeline({
      id: "private-step",
      steps: [work],
      finalize: (outputs) => outputs.work,
    });

    const plan = pipeline.plan();
    expect(plan.ok).toBe(true);
    expect(plan.steps.find((planned) => planned.id === "work")?.name).toBe("from-private");

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value).toBe("from-private");
  });

  it("invokes a method-style finalizer with the original definition as this", async () => {
    const { step } = createSteps();
    const work = step("work", { run: () => "ok" });
    const definition = {
      id: "finalize-this",
      marker: "from-definition",
      steps: [work] as const,
      finalize() {
        return this.marker;
      },
    };
    const pipeline = definePipeline(definition);

    const result = await pipeline.run({});
    expect(result.status).toBe("completed");
    expect(result.value).toBe("from-definition");
  });
});
