import { describe, expect, expectTypeOf, it } from "vitest";
import { createSteps, definePipeline } from "../core/pipeline.js";
import { defineProject, isPipelineProject } from "./pipeline-project.js";
import { PipelineDocumentError } from "./project-document.js";

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
    expect(project.name).toBe("example");
    expect(project.description).toBeUndefined();
    expect(project.pipelineIds).toEqual(["alpha", "beta"]);
    expect(project.get("alpha")).toBe(alpha);
    await expect(project.get("beta").runOrThrow({ value: 42 })).resolves.toBe(42);
    expectTypeOf(project.pipelineIds).toEqualTypeOf<readonly ["alpha", "beta"]>();
    expectTypeOf(project.id).toEqualTypeOf<"example">();
    expectTypeOf(project.get("alpha")).toEqualTypeOf<typeof alpha>();
    expectTypeOf(project.get("beta").runOrThrow).parameter(0).toEqualTypeOf<{ value: number }>();
  });

  it("snapshots optional presentation without changing identity or pipeline types", () => {
    const metadata = { name: "Example jobs", description: "Read alpha and beta values." };
    const project = defineProject("example", [alpha, beta], metadata);
    metadata.name = "Changed";
    metadata.description = "Changed";

    expect(project).toMatchObject({
      id: "example",
      name: "Example jobs",
      description: "Read alpha and beta values.",
    });
    expect(Object.isFrozen(project)).toBe(true);
    expectTypeOf(project.id).toEqualTypeOf<"example">();
    expectTypeOf(project.get("alpha")).toEqualTypeOf<typeof alpha>();
    expect(defineProject("example", [alpha], { description: "Read a value." }).name).toBe(
      "example"
    );
  });

  it("selects pipelines whose union or widened ids overlap the lookup", async () => {
    function variant(id: "union-alpha" | "union-beta") {
      return definePipeline({
        id,
        steps: [alphaStep("read", { run: (_inputs, context) => context.options.value })],
      });
    }
    const unionPipeline = variant("union-alpha");
    const project = defineProject("unions", [unionPipeline, beta]);
    const selected = project.get("union-alpha");
    expectTypeOf(selected).toEqualTypeOf<typeof unionPipeline>();
    expectTypeOf(project.get("beta")).toEqualTypeOf<typeof beta>();
    await expect(selected.runOrThrow({ value: "hello" })).resolves.toBe("hello");
    const selectEither = (id: "union-alpha" | "beta") => project.get(id);
    expectTypeOf(selectEither).returns.toEqualTypeOf<typeof unionPipeline | typeof beta>();

    const widePipeline = definePipeline({
      id: String("dynamic"),
      steps: [alphaStep("read", { run: (_inputs, context) => context.options.value })],
    });
    const mixed = defineProject("mixed", [widePipeline, beta]);
    expectTypeOf(mixed.get("dynamic")).toEqualTypeOf<typeof widePipeline>();
    expectTypeOf(mixed.get("beta")).toEqualTypeOf<typeof widePipeline | typeof beta>();
    const selectUnknown = (id: string) => mixed.get(id);
    expectTypeOf(selectUnknown).returns.toEqualTypeOf<typeof widePipeline | typeof beta>();
  });

  it.each([{ document: [] }, { document: [{ id: "not-a-pipeline" }] }])(
    "rejects an array document when a registry is supplied: $document",
    ({ document }) => {
      const registry = { steps: {}, finalizers: {} };
      expect(() => defineProject("invalid-document", document, registry)).toThrow(
        PipelineDocumentError
      );
      expect(() =>
        defineProject("invalid-document", document, registry, { name: "Document jobs" })
      ).toThrow("$: Expected an object");
      expect(defineProject("empty-typed", [], { name: "Typed jobs" }).name).toBe("Typed jobs");
    }
  );

  it.each(["", " ", null, 42])("rejects invalid presentation text %j", (value) => {
    for (const field of ["name", "description"] as const) {
      expect(() => defineProject("example", [alpha], { [field]: value })).toThrow(
        `Project ${field} must be a non-empty string.`
      );
    }
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
    const document = {
      version: 1,
      metadata: { name: "Greeting jobs", description: "Say hello." },
      pipelines: {
        greeting: {
          steps: [{ id: "greet", run: "greet" }],
          finalize: { run: "result", requireOutputs: ["greet"] },
        },
      },
    };
    const registry = {
      steps: { greet: () => "hello" },
      finalizers: { result: ({ greet }: Record<string, unknown>) => greet },
    };
    const project = defineProject("declarative-example", document, registry);

    expect(project).toMatchObject({
      id: "declarative-example",
      name: "Greeting jobs",
      description: "Say hello.",
      pipelineIds: ["greeting"],
    });
    await expect(project.get("greeting").runOrThrow({})).resolves.toBe("hello");
    expect(defineProject("override", document, registry, { name: "Custom name" })).toMatchObject({
      name: "Custom name",
      description: "Say hello.",
    });
    expect(
      defineProject("override", document, registry, { description: "Custom purpose" })
    ).toMatchObject({
      name: "Greeting jobs",
      description: "Custom purpose",
    });
    expect(defineProject("fallback", { ...document, metadata: undefined }, registry)).toMatchObject(
      {
        name: "fallback",
      }
    );
    expect(() => defineProject("invalid", document, registry, { name: " " })).toThrow(
      "Project name must be a non-empty string."
    );
  });
});
