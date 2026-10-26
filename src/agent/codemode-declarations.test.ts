import { describe, expect, it } from "vitest";
import { codemodeDeclarations, renderSchemaType } from "./codemode-declarations.js";

describe("code-mode declarations", () => {
  it("renders JSON Schema inputs and outputs as TypeScript declarations", () => {
    const text = codemodeDeclarations([
      {
        name: "docs__search-pages",
        description: "Search */ pages",
        inputJsonSchema: {
          type: "object",
          $defs: { mode: { enum: ["fast", "deep"] } },
          properties: {
            query: { type: "string", description: "Query text" },
            limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
            mode: { $ref: "#/$defs/mode" },
            tags: { type: "array", items: { type: ["string", "number"] } },
            pair: { type: "array", prefixItems: [{ type: "string" }, { const: 1 }] },
            meta: { type: "object", additionalProperties: { type: "boolean" } },
            external: { $ref: "https://example.com/schema" },
          },
          required: ["query", "limit", "mode"],
          additionalProperties: false,
        },
      },
      {
        name: "ping",
        description: "Ping",
        inputJsonSchema: {},
        outputJsonSchema: { type: "null" },
      },
    ]);
    expect(text).toBe(`declare const tools: {
  /** Search *\\/ pages */
  "docs__search-pages"(input: {
    /** Query text */
    query: string;
    limit: number | null;
    mode: "fast" | "deep";
    tags?: (string | number)[];
    pair?: [string?, 1?, ...unknown[]];
    meta?: Record<string, boolean>;
    external?: unknown;
  }): Promise<unknown>;
  /** Ping */
  ping(input: unknown): Promise<null>;
};`);
  });

  it("keeps tuple positions optional and index signatures compatible with named properties", () => {
    const text = codemodeDeclarations([
      {
        name: "shapes",
        description: "Shapes",
        inputJsonSchema: {
          type: "object",
          properties: {
            exact: {
              type: "array",
              prefixItems: [{ type: "string" }, { type: "number" }],
              minItems: 2,
              items: false,
            },
            open: { type: "array", prefixItems: [{ type: "string" }], items: { type: "boolean" } },
            union: { type: "array", prefixItems: [{ type: ["string", "number"] }], items: false },
            mixed: {
              type: "object",
              properties: { name: { type: "string" } },
              additionalProperties: { type: "number" },
            },
          },
          required: ["exact", "open", "union", "mixed"],
        },
      },
    ]);
    expect(text).toContain("exact: [string, number];");
    expect(text).toContain("open: [string?, ...boolean[]];");
    expect(text).toContain("union: [(string | number)?];");
    expect(text).toContain("name?: string;\n      [key: string]: number | string;");
  });

  it("bounds recursion and keeps unknown branches permissive", () => {
    const recursive = {
      $defs: { node: { type: "array", items: { $ref: "#/$defs/node" } } },
      $ref: "#/$defs/node",
    };
    const text = codemodeDeclarations([
      { name: "tree", description: "Tree", inputJsonSchema: recursive },
      { name: "any", description: "Any", inputJsonSchema: { anyOf: [{ type: "string" }, true] } },
    ]);
    expect(text).toContain("tree(input: unknown[][][][][][]): Promise<unknown>;");
    expect(text).toContain("any(input: unknown): Promise<unknown>;");
  });

  it("decodes JSON Pointer and URI escapes in local references", () => {
    expect(
      renderSchemaType(
        {
          type: "object",
          properties: {
            slash: { $ref: "#/$defs/text~1value" },
            tilde: { $ref: "#/$defs/a~0b" },
            space: { $ref: "#/$defs/two%20words" },
          },
          required: ["slash", "tilde", "space"],
          $defs: {
            "text/value": { type: "string" },
            "a~b": { type: "number" },
            "two words": { type: "boolean" },
          },
        },
        1000
      )
    ).toBe("{\n  slash: string;\n  tilde: number;\n  space: boolean;\n}");
  });

  it("stops rendering once a declaration exceeds its budget, including exponential expansion", () => {
    // Each definition references the next ten times: unbounded rendering would never finish.
    const $defs = Object.fromEntries(
      Array.from({ length: 12 }, (_, level) => [
        `d${level}`,
        {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
              `p${index}`,
              { $ref: `#/$defs/d${level + 1}` },
            ])
          ),
        },
      ])
    );
    const started = Date.now();
    expect(renderSchemaType({ $ref: "#/$defs/d0", $defs }, 49_152)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(
      codemodeDeclarations(
        [{ name: "big", description: "Big", inputJsonSchema: { $ref: "#/$defs/d0", $defs } }],
        49_152
      )
    ).toBeUndefined();
    expect(
      codemodeDeclarations([{ name: "ping", description: "Ping", inputJsonSchema: {} }], 10)
    ).toBeUndefined();
  });
});
