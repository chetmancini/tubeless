import { expect, it } from "vitest";
import { defaultCacheKey } from "./cache-key.js";

it("sorts record keys without losing types, holes, or reference topology", () => {
  expect(defaultCacheKey({ a: 1, b: 2 }, {})).toBe(defaultCacheKey({ b: 2, a: 1 }, {}));
  const values = [
    undefined,
    null,
    "",
    0,
    -0,
    false,
    NaN,
    Infinity,
    -Infinity,
    "NaN",
    1n,
    {},
    { a: undefined },
    [],
    [undefined],
    new Array(1),
    new Date(0),
    "1970-01-01T00:00:00.000Z",
  ];
  expect(new Set(values.map((value) => defaultCacheKey(value, {}))).size).toBe(values.length);
  const shared = {};
  expect(defaultCacheKey({ a: shared, b: shared }, {})).not.toBe(
    defaultCacheKey({ a: {}, b: {} }, {})
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const other: Record<string, unknown> = {};
  other.self = other;
  expect(defaultCacheKey(cycle, {})).toBe(defaultCacheKey(other, {}));
  expect(defaultCacheKey({}, { input: 1 })).not.toBe(defaultCacheKey({}, { input: 2 }));
});

it("rejects unsupported keys instead of dropping information or invoking getters", () => {
  const values = [
    () => {},
    Symbol("x"),
    new Map(),
    new Set(),
    new Uint8Array(),
    new (class {})(),
    { [Symbol("x")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }),
    Object.defineProperty({}, "getter", {
      enumerable: true,
      get: () => {
        throw new Error("getter invoked");
      },
    }),
  ];
  for (const value of values)
    expect(() => defaultCacheKey({}, { value })).toThrow("provide cache.key");
});
