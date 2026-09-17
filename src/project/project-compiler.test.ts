import { describe, expect, it, vi } from "vitest";
import { PipelineDefinitionError, type StandardSchemaV1 } from "../core/pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import {
  compilePipelineDocument,
  PipelineDocumentError,
  type PipelineDocument,
  type PipelineDocumentRegistry,
} from "./project.js";

function document(): PipelineDocument {
  return {
    version: 1,
    pipelines: {
      import: {
        targets: ["normalize"],
        steps: [
          { id: "normalize", run: "normalize", dependsOn: ["load"] },
          { id: "load", run: "load" },
        ],
        finalize: { run: "result", requireOutputs: ["normalize"] },
      },
    },
  };
}

function registry(): PipelineDocumentRegistry {
  return {
    steps: {
      load: vi.fn(() => "hello"),
      normalize: vi.fn(({ load }) => String(load).toUpperCase()),
    },
    finalizers: { result: vi.fn(({ normalize }) => normalize) },
  };
}

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"]
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

describe("declarative pipelines", () => {
  it("compiles multiple pipelines and forward references without invoking application code", async () => {
    const source = document();
    source.pipelines.preview = { ...source.pipelines.import };
    const handlers = registry();
    const pipelines = compilePipelineDocument(source, handlers);
    expect([...pipelines.keys()]).toEqual(["import", "preview"]);
    const pipeline = pipelines.get("import")!;
    expect(pipeline.plan({ targets: ["normalize"] }).steps).toMatchObject([
      { id: "load", selected: true },
      { id: "normalize", selected: true, dependencies: ["load"] },
    ]);
    expect(pipeline.toMermaid()).toContain("normalize");
    expect(handlers.steps.load).not.toHaveBeenCalled();
    expect(handlers.finalizers.result).not.toHaveBeenCalled();
    const runtime = createPipelineTestRuntime();
    await expect(pipeline.runOrThrow({}, {}, runtime.context)).resolves.toBe("HELLO");
    expect(handlers.steps.load).toHaveBeenCalledOnce();
  });

  it("snapshots wiring and resolved handlers at compilation", async () => {
    const source = document();
    const handlers = registry();
    const pipeline = compilePipelineDocument(source, handlers).get("import")!;
    source.pipelines.import.steps = [];
    handlers.steps = {
      load: () => {
        throw new Error("replacement");
      },
    };
    await expect(pipeline.runOrThrow({}, {}, createPipelineTestRuntime().context)).resolves.toBe(
      "HELLO"
    );
  });

  it("uses core dry-run skips, dependency blocking, and required finalizers", async () => {
    const source = document();
    source.pipelines.import.steps[1].dryRun = "skip";
    const handlers = registry();
    const pipeline = compilePipelineDocument(source, handlers).get("import")!;
    const result = await pipeline.run({}, { dryRun: true }, createPipelineTestRuntime().context);
    expect(result.status).toBe("failed");
    expect(result.steps).toMatchObject([
      { id: "load", status: "skipped", reason: "dry-run" },
      { id: "normalize", status: "skipped", reason: "unmet-dependency" },
    ]);
    expect(handlers.steps.load).not.toHaveBeenCalled();
    expect(handlers.steps.normalize).not.toHaveBeenCalled();
    expect(handlers.finalizers.result).not.toHaveBeenCalled();
  });

  it("resolves a custom dry-run handler with the normal step context", async () => {
    const source = document();
    source.pipelines.import.steps[1].dryRun = { run: "preview" };
    const handlers = registry();
    const preview = vi.fn((_inputs, context) => (context.dryRun ? "preview" : "wrong"));
    handlers.steps = { ...handlers.steps, preview };
    const pipeline = compilePipelineDocument(source, handlers).get("import")!;
    await expect(
      pipeline.runOrThrow({}, { dryRun: true }, createPipelineTestRuntime().context)
    ).resolves.toBe("PREVIEW");
    expect(handlers.steps.load).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledOnce();
  });

  it("preserves optional dependencies and failure gates under target selection", async () => {
    const source: PipelineDocument = {
      version: 1,
      pipelines: {
        publish: {
          steps: [
            { id: "check", run: "check" },
            { id: "extra", run: "extra" },
            {
              id: "publish",
              run: "publish",
              optionalDependsOn: ["extra"],
              skipAfterFailureOf: ["check"],
            },
          ],
          targets: ["publish"],
          finalize: { run: "result" },
        },
      },
    };
    const publish = vi.fn(() => "published");
    const extra = vi.fn();
    const pipeline = compilePipelineDocument(source, {
      steps: {
        check: () => {
          throw new Error("invalid");
        },
        publish,
        extra,
      },
      finalizers: { result: (outputs) => outputs },
    }).get("publish")!;
    const plan = pipeline.plan({ targets: ["publish"] });
    expect(plan.steps.find(({ id }) => id === "check")?.selected).toBe(true);
    expect(plan.steps.find(({ id }) => id === "extra")?.selected).toBe(false);
    const result = await pipeline.run(
      {},
      { targets: ["publish"], continueOnError: true },
      createPipelineTestRuntime().context
    );
    expect(result.status).toBe("failed");
    expect(publish).not.toHaveBeenCalled();
    expect(extra).not.toHaveBeenCalled();
  });

  it("runs asynchronous schemas only during execution and passes transformed options and outputs", async () => {
    const source = document();
    source.pipelines.import.optionsSchema = "options";
    source.pipelines.import.steps[1].outputSchema = "output";
    source.pipelines.import.resultSchema = "result";
    const validateOptions = vi.fn(async () => ({ value: { greeting: "options" } }));
    const handlers = registry();
    handlers.steps = {
      ...handlers.steps,
      load: (_inputs, context) =>
        "greeting" in context.options ? context.options.greeting : "missing",
    };
    handlers.optionsSchemas = { options: standardSchema(validateOptions) };
    handlers.schemas = {
      output: standardSchema(async (value) => ({ value: `${value}-output` })),
      result: standardSchema(async (value) => ({ value: `${value}-result` })),
    };
    const pipeline = compilePipelineDocument(source, handlers).get("import")!;
    pipeline.plan();
    expect(validateOptions).not.toHaveBeenCalled();
    await expect(pipeline.runOrThrow({}, {}, createPipelineTestRuntime().context)).resolves.toBe(
      "OPTIONS-OUTPUT-result"
    );
  });

  it.each(["options", "output", "result"] as const)(
    "retains core %s validation failures",
    async (boundary) => {
      const source = document();
      const handlers = registry();
      const invalid = standardSchema<object, object>(() => ({ issues: [{ message: "invalid" }] }));
      if (boundary === "options") {
        source.pipelines.import.optionsSchema = "invalid";
        handlers.optionsSchemas = { invalid };
      } else {
        handlers.schemas = { invalid };
        if (boundary === "output") source.pipelines.import.steps[1].outputSchema = "invalid";
        else source.pipelines.import.resultSchema = "invalid";
      }
      const pipeline = compilePipelineDocument(source, handlers).get("import")!;
      const result = await pipeline.run({}, {}, createPipelineTestRuntime().context);
      expect(result.status).toBe("failed");
      expect(result.errors.some((error) => error.kind === "validation")).toBe(true);
    }
  );

  it.each([
    [null, "$"],
    [{ version: 2, pipelines: {} }, "$.version"],
    [{ version: 1, pipelines: {} }, "$.pipelines"],
    [{ ...document(), imports: {} }, "$.imports"],
    [
      { version: 1, pipelines: { p: { steps: [], finalize: { run: "result" } } } },
      '$.pipelines["p"].steps',
    ],
  ])("rejects malformed documents with a document path", (value, path) => {
    expect(() => compilePipelineDocument(value, registry())).toThrow(
      expect.objectContaining({ name: "PipelineDocumentError", path })
    );
  });

  it.each([
    "run",
    "dependsOn",
    "optionalDependsOn",
    "skipAfterFailureOf",
    "outputSchema",
    "dryRun",
  ] as const)("rejects unknown %s references", (field) => {
    const source = document();
    const step = source.pipelines.import.steps[0];
    if (field === "run" || field === "outputSchema") step[field] = "missing";
    else if (field === "dryRun") step.dryRun = { run: "missing" };
    else step[field] = ["missing"];
    expect(() => compilePipelineDocument(source, registry())).toThrow(PipelineDocumentError);
  });

  it("does not resolve inherited registry names", () => {
    const source = document();
    source.pipelines.import.steps[0].run = "toString";
    expect(() => compilePipelineDocument(source, registry())).toThrow(
      'Unknown registered name "toString"'
    );
  });

  it.each(["optionsSchema", "resultSchema", "targets", "finalizer", "requireOutputs"])(
    "rejects unknown pipeline %s references",
    (field) => {
      const source = document();
      const definition = source.pipelines.import;
      if (field === "optionsSchema" || field === "resultSchema") definition[field] = "missing";
      if (field === "targets") definition.targets = ["missing"];
      if (field === "finalizer") definition.finalize.run = "missing";
      if (field === "requireOutputs") definition.finalize.requireOutputs = ["missing"];
      expect(() => compilePipelineDocument(source, registry())).toThrow(PipelineDocumentError);
    }
  );

  it.each([
    { id: "load", run: "load", dependsOn: "other" },
    { id: "load", run: "load", dryRun: "preview" },
    { id: "load", run: "load", dryRun: { run: "load", typo: true } },
    { id: "load", run: "load", dependsOn: [5] },
    { id: "load", run: "load", typo: true },
    { id: "load", run: "load", name: " " },
    { id: "load", run: null },
  ])("rejects invalid step fields before graph construction: %j", (step) => {
    const value = { version: 1, pipelines: { p: { steps: [step], finalize: { run: "result" } } } };
    expect(() => compilePipelineDocument(value, registry())).toThrow(PipelineDocumentError);
  });

  it("allows absent optional inputs and partial finalization", async () => {
    const source = document();
    source.pipelines.import.steps = [
      { id: "normalize", run: "normalize", optionalDependsOn: ["load"] },
      source.pipelines.import.steps[1],
    ];
    source.pipelines.import.finalize = { run: "result" };
    const handlers = registry();
    handlers.steps = { ...handlers.steps, normalize: ({ load }) => load ?? "absent" };
    const pipeline = compilePipelineDocument(source, handlers).get("import")!;
    await expect(
      pipeline.runOrThrow({}, { targets: ["normalize"] }, createPipelineTestRuntime().context)
    ).resolves.toBe("absent");
    expect(handlers.steps.load).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "cycle", "self", "contradiction", "target-finalizer"])(
    "delegates %s errors to the existing engine",
    (kind) => {
      const source = document();
      const definition = source.pipelines.import;
      if (kind === "duplicate") definition.steps = [...definition.steps, definition.steps[1]];
      if (kind === "cycle") definition.steps[1].dependsOn = ["normalize"];
      if (kind === "self") definition.steps[1].dependsOn = ["load"];
      if (kind === "contradiction") definition.steps[0].optionalDependsOn = ["load"];
      if (kind === "target-finalizer") definition.targets = ["load"];
      expect(() => compilePipelineDocument(source, registry())).toThrow(PipelineDefinitionError);
    }
  );
});
