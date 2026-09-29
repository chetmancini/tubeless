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
      default: { type: "object", const: { $ref: "literal" } },
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
