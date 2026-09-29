import { expect, it } from "vitest";
import { parameter } from "./openai-protocol.js";

it.each([
  { $ref: "#" },
  {
    type: "object",
    properties: { value: { $ref: "#/$defs/word" } },
    $defs: { word: { type: "string" } },
  },
  { anyOf: [{ type: "array", items: { $ref: "https://example.com/item" } }] },
  { $defs: { node: { properties: { next: { $dynamicRef: "#node" } } } } },
  { additionalProperties: { $recursiveRef: "#" } },
  { dependentSchemas: { value: { allOf: [{ $ref: "#/properties/value" }] } } },
])("rejects references before relocating a schema: %j", (schema) => {
  expect(() => parameter("input", schema)).toThrow("require inline schemas");
});

it("leaves literal data and property names that resemble reference keywords unchanged", () => {
  const schema = {
    type: "object",
    properties: {
      $ref: { type: "string" },
      default: {
        type: "object",
        properties: { $ref: { type: "string" } },
        required: ["$ref"],
        additionalProperties: false,
        const: { $ref: "literal" },
      },
      examples: { type: "string", enum: ["$dynamicRef"] },
    },
    default: { $ref: "literal" },
    examples: [{ $recursiveRef: "literal" }],
    required: ["$ref", "default", "examples"],
    additionalProperties: false,
  };
  expect(parameter("input", schema)).toEqual({
    type: "object",
    properties: { input: schema },
    required: ["input"],
    additionalProperties: false,
  });
});

it.each([
  { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  { type: "object", additionalProperties: true },
  { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
  {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["other"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a", "a"],
    additionalProperties: false,
  },
  { type: "array", items: { type: ["object", "null"], additionalProperties: true } },
  {
    anyOf: [
      { type: "object", additionalProperties: false, properties: { value: { type: "string" } } },
    ],
  },
])("rejects non-strict object schemas at every nesting level: %j", (schema) => {
  expect(() => parameter("input", schema)).toThrow("OpenAI strict schema at input");
});

it("accepts required nullable fields and strict objects nested in arrays and unions", () => {
  const item = {
    type: ["object", "null"],
    properties: { value: { type: ["string", "null"] } },
    required: ["value"],
    additionalProperties: false,
  };
  const schema = { anyOf: [{ type: "array", items: item }, { type: "null" }] };
  expect(parameter("input", schema).properties.input).toBe(schema);
});
