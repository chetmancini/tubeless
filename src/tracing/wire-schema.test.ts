import { expect, it } from "vitest";
import { wireLiteral, wireObject, wireOptional, wireString } from "./wire-schema.js";

it("encodes and validates null literals", () => {
  const schema = wireLiteral(null);
  expect(schema.jsonSchema).toEqual({ const: null, type: "null" });
  expect(schema.decode(null, "value")).toBeNull();
  for (const value of [undefined, false, 0, "null", {}])
    expect(() => schema.decode(value, "value")).toThrow("value must be null");
});

it("preserves tolerant history decoding while strict envelopes reject undeclared fields", () => {
  const shape = { id: wireString(), label: wireOptional(wireString()) };
  const reader = wireObject(shape);
  const envelope = wireObject(shape, { strict: true });
  expect(reader.decode({ id: "run", future: true }, "event")).toEqual({ id: "run" });
  expect(() => envelope.decode({ id: "run", future: true }, "request")).toThrow(
    "unsupported fields"
  );
  expect(() => envelope.decode(JSON.parse('{"id":"run","__proto__":{}}'), "request")).toThrow(
    "unsupported fields"
  );
  expect(envelope.decode({ id: "run" }, "request")).toEqual({ id: "run" });
  expect(envelope.decode({ id: "run", label: undefined }, "request")).toEqual({ id: "run" });
  expect(envelope.decode({ id: "run", label: "Root" }, "request")).toEqual({
    id: "run",
    label: "Root",
  });
});
