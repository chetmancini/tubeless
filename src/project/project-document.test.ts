import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compilePipelineDocument } from "./project-compiler.js";
import { PipelineDocumentError, validatePipelineDocument } from "./project-document.js";

const jsonSchema = JSON.parse(
  readFileSync(new URL("../../docs/pipeline-document.schema.json", import.meta.url), "utf8")
);
const pipeline = { steps: [{ id: "work", run: "work" }], finalize: { run: "done" } };
const document = { version: 1, pipelines: { example: pipeline } };

describe("pipeline document JSON Schema", () => {
  it("publishes draft 2020-12 shape for editors and agents", () => {
    expect(jsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://tubeless.io/schemas/pipeline-document-v1.schema.json",
      title: "Tubeless pipeline document v1",
      type: "object",
      additionalProperties: false,
      required: ["version", "pipelines"],
      properties: {
        version: { const: 1 },
        metadata: { $ref: "#/$defs/metadata" },
        pipelines: { type: "object", minProperties: 1 },
      },
      $defs: {
        metadata: {
          properties: {
            date: {
              type: "string",
              format: "date",
              pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
            },
          },
        },
        pipeline: {
          properties: {
            name: { $ref: "#/$defs/text" },
            description: { $ref: "#/$defs/text" },
          },
        },
      },
    });
    expect(Object.keys(jsonSchema.properties).sort()).toEqual([
      "$schema",
      "metadata",
      "pipelines",
      "version",
    ]);
    expect(Object.keys(jsonSchema.$defs).sort()).toEqual([
      "composition",
      "handler",
      "metadata",
      "names",
      "pipeline",
      "step",
      "text",
    ]);
  });
});

describe("validatePipelineDocument", () => {
  it.each([
    ["minimal document", document],
    ["empty optional metadata", { ...document, metadata: {} }],
    [
      "document metadata",
      {
        ...document,
        metadata: {
          name: "Peloton",
          description: "Race day",
          authors: ["Maintainer"],
          date: "2024-02-29",
        },
      },
    ],
    ["editor association", { ...document, $schema: "https://example.invalid/no-fetch.json" }],
    [
      "dry-run handler",
      {
        version: 1,
        pipelines: {
          example: {
            ...pipeline,
            steps: [
              { id: "work", run: "work", dryRun: { run: "preview" }, outputSchema: "result" },
            ],
          },
        },
      },
    ],
    [
      "all graph fields",
      {
        version: 1,
        pipelines: {
          example: {
            ...pipeline,
            name: "Example pipeline",
            description: "Run the full example workflow.",
            optionsSchema: "options",
            resultSchema: "result",
            targets: ["work"],
            steps: [
              {
                id: "work",
                run: "work",
                name: "Work",
                description: "Do work",
                dependsOn: ["other"],
                optionalDependsOn: [],
                skipAfterFailureOf: [],
                dryRun: "skip",
              },
            ],
          },
        },
      },
    ],
    [
      "runtime skip and child composition",
      {
        version: 1,
        pipelines: {
          parent: {
            steps: [
              {
                id: "single",
                fromPipeline: { pipeline: "child", adapter: "single" },
                skip: "skipSingle",
                dryRun: "skip",
              },
              {
                id: "many",
                forEachPipeline: { pipeline: "child", adapter: "many" },
              },
            ],
            finalize: { run: "done" },
          },
          child: pipeline,
        },
      },
    ],
  ])("accepts %s", (_label, value) => {
    expect(() => validatePipelineDocument(value)).not.toThrow();
  });

  it.each([
    null,
    [],
    { ...document, version: 2 },
    { ...document, version: "1" },
    { ...document, pipelines: {} },
    { ...document, pipelines: { " ": pipeline } },
    { ...document, $schema: " " },
    { ...document, metadata: null },
    { ...document, metadata: { name: " " } },
    { ...document, metadata: { description: 1 } },
    { ...document, metadata: { authors: "Maintainer" } },
    { ...document, metadata: { authors: [""] } },
    { ...document, metadata: { date: "2025-02-29" } },
    { ...document, metadata: { date: "2026-04-31" } },
    { ...document, metadata: { date: "2026-09-17T00:00:00Z" } },
    { ...document, metadata: { typo: "unknown" } },
    { ...document, typo: true },
    { version: 1, pipelines: { example: { ...pipeline, steps: [] } } },
    { version: 1, pipelines: { example: { ...pipeline, name: " " } } },
    { version: 1, pipelines: { example: { ...pipeline, description: 1 } } },
    {
      version: 1,
      pipelines: {
        example: { ...pipeline, steps: [{ id: "work", run: "work", dryRun: "preview" }] },
      },
    },
    {
      version: 1,
      pipelines: {
        example: { ...pipeline, steps: [{ id: "work", run: "work", dependsOn: "other" }] },
      },
    },
    {
      version: 1,
      pipelines: { example: { ...pipeline, steps: [{ id: "work" }] } },
    },
    {
      version: 1,
      pipelines: {
        example: {
          ...pipeline,
          steps: [
            {
              id: "work",
              run: "work",
              fromPipeline: { pipeline: "child", adapter: "single" },
            },
          ],
        },
      },
    },
    {
      version: 1,
      pipelines: {
        example: {
          ...pipeline,
          steps: [
            {
              id: "work",
              fromPipeline: { pipeline: "child", adapter: "single", typo: true },
            },
          ],
        },
      },
    },
    {
      version: 1,
      pipelines: {
        example: {
          ...pipeline,
          steps: [
            {
              id: "work",
              forEachPipeline: { pipeline: "child", adapter: "many" },
              outputSchema: "result",
            },
          ],
        },
      },
    },
    {
      version: 1,
      pipelines: {
        example: {
          ...pipeline,
          steps: [
            {
              id: "work",
              fromPipeline: { pipeline: "child", adapter: "single" },
              dryRun: { run: "preview" },
            },
          ],
        },
      },
    },
    {
      version: 1,
      pipelines: { example: { ...pipeline, finalize: { run: "done", unknown: true } } },
    },
    { version: 1, pipelines: { example: { ...pipeline, targets: [4] } } },
  ])("rejects invalid documents: %j", (value) => {
    expect(() => validatePipelineDocument(value)).toThrow(PipelineDocumentError);
  });

  it("preserves a snapshot of metadata without changing graph semantics or calling handlers", () => {
    const metadata = { name: "Peloton", authors: ["Maintainer"], date: "2026-09-17" };
    const validated = validatePipelineDocument({ ...document, metadata });
    expect(validated.metadata).toEqual(metadata);
    metadata.authors.push("Another maintainer");
    expect(validated.metadata?.authors).toEqual(["Maintainer"]);
    const registry = {
      steps: {
        work: () => {
          throw new Error("must not execute");
        },
      },
      finalizers: { done: () => undefined },
    };
    expect(compilePipelineDocument(validated, registry).get("example").plan()).toEqual(
      compilePipelineDocument(document, registry).get("example").plan()
    );
  });

  it("preserves pipeline presentation through compilation", () => {
    const compiled = compilePipelineDocument(
      {
        version: 1,
        pipelines: {
          example: {
            ...pipeline,
            name: "Example pipeline",
            description: "Run the example workflow.",
          },
        },
      },
      { steps: { work: () => true }, finalizers: { done: () => true } }
    ).get("example");

    expect(compiled).toMatchObject({
      id: "example",
      name: "Example pipeline",
      description: "Run the example workflow.",
    });
  });

  it("leaves semantic graph checking to compilation", () => {
    const value = { version: 1, pipelines: { example: { ...pipeline, targets: ["missing"] } } };
    expect(() => validatePipelineDocument(value)).not.toThrow();
    expect(() =>
      compilePipelineDocument(value, { steps: { work: () => 1 }, finalizers: { done: () => 1 } })
    ).toThrow('Unknown step "missing"');
  });
});
