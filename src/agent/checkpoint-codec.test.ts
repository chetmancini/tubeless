import { expect, it } from "vitest";
import { plainAgentCheckpointCodec as codec } from "./checkpoint-codec.js";

it("preserves undefined, negative zero, sparse arrays and own __proto__ properties", () => {
  const array = new Array(3);
  array[1] = undefined;
  const value = {
    array,
    zero: -0,
    missing: undefined,
    proto: JSON.parse('{"__proto__":{"safe":true}}'),
  };
  const roundTrip = codec.decode(codec.encode(value));
  expect(roundTrip).toEqual(value);
  expect(Object.is((roundTrip as typeof value).zero, -0)).toBe(true);
  expect(Object.hasOwn((roundTrip as typeof value).array, 0)).toBe(false);
  expect(Object.hasOwn((roundTrip as typeof value).array, 1)).toBe(true);
  expect(codec.encode({ a: 1, b: 2 })).toBe(codec.encode({ b: 2, a: 1 }));
  expect(Object.getPrototypeOf(codec.decode(codec.encode(Object.create(null))))).toBeNull();
});

it("rejects lossy or executable values without invoking accessors", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let read = false;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => {
      read = true;
      return 1;
    },
  });
  for (const value of [NaN, Infinity, () => {}, Symbol(), 1n, new Map(), new Date(), cycle, getter])
    expect(() => codec.encode(value)).toThrow("losslessly");
  expect(read).toBe(false);
});

it.each([
  '["number",""]',
  '["number","Infinity"]',
  '["record",[["a",["null"]],["a",["null"]]]]',
  '["array",-1,[]]',
  '["null",1]',
  "{}",
])("rejects malformed encoded values: %s", (value) => {
  expect(() => codec.decode(value)).toThrow("Invalid encoded");
});
