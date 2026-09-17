import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { describe, expect, it } from "vitest";
import {
  compilePipelineDocument,
  PipelineDocumentError,
  validatePipelineDocument,
} from "./project.js";

const jsonSchema = JSON.parse(
  readFileSync(new URL("../../docs/pipeline-document.schema.json", import.meta.url), "utf8")
);
const validateSchema = new Ajv2020({ allErrors: true, formats: fullFormats }).compile(jsonSchema);
const pipeline = { steps: [{ id: "work", run: "work" }], finalize: { run: "done" } };
const document = { version: 1, pipelines: { example: pipeline } };

describe("pipeline document JSON Schema", () => {
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
  ])("accepts %s in both validators", (_label, value) => {
    expect(validateSchema(value), JSON.stringify(validateSchema.errors)).toBe(true);
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
      pipelines: { example: { ...pipeline, finalize: { run: "done", unknown: true } } },
    },
    { version: 1, pipelines: { example: { ...pipeline, targets: [4] } } },
  ])("rejects invalid documents consistently: %j", (value) => {
    expect(validateSchema(value)).toBe(false);
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
    expect(compilePipelineDocument(validated, registry).get("example")!.plan()).toEqual(
      compilePipelineDocument(document, registry).get("example")!.plan()
    );
  });

  it("leaves semantic graph checking to compilation", () => {
    const value = { version: 1, pipelines: { example: { ...pipeline, targets: ["missing"] } } };
    expect(validateSchema(value)).toBe(true);
    expect(() => validatePipelineDocument(value)).not.toThrow();
    expect(() =>
      compilePipelineDocument(value, { steps: { work: () => 1 }, finalizers: { done: () => 1 } })
    ).toThrow('Unknown step "missing"');
  });
});
