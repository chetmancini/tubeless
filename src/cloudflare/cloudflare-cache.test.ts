import { describe, expect, it } from "vitest";
import { createR2CacheStore, jsonCacheCodec, type R2BucketLike } from "./cloudflare-cache.js";

function memoryBucket(): R2BucketLike & { keys(): string[] } {
  const objects = new Map<string, { value: Uint8Array; customMetadata?: Record<string, string> }>();
  return {
    async get(key) {
      const object = objects.get(key);
      return object
        ? {
            arrayBuffer: async () => object.value.slice().buffer,
            customMetadata: object.customMetadata,
            uploaded: new Date(5),
          }
        : null;
    },
    async put(key, value, options) {
      objects.set(key, { value, customMetadata: options?.customMetadata });
    },
    keys: () => [...objects.keys()],
  };
}

describe("R2 cache store", () => {
  it("round-trips bytes and creation time under a prefix", async () => {
    const bucket = memoryBucket();
    const store = createR2CacheStore(bucket, { prefix: "p/" });
    expect(await store.get("k", {})).toBeUndefined();
    await store.set("k", { value: new Uint8Array([1, 2]), createdAtMs: 42 }, {});
    expect(bucket.keys()).toEqual(["p/k"]);
    expect(await store.get("k", {})).toEqual({ value: new Uint8Array([1, 2]), createdAtMs: 42 });
  });

  it("falls back to the upload time when metadata is missing", async () => {
    const bucket = memoryBucket();
    await bucket.put("tubeless-cache/k", new Uint8Array([1]));
    expect((await createR2CacheStore(bucket).get("k", {}))?.createdAtMs).toBe(5);
  });
});

describe("JSON cache codec", () => {
  it("round-trips plain JSON", async () => {
    const value = { a: [1, "two", true, null], nested: { ok: 1.5 } };
    expect(await jsonCacheCodec.decode(await jsonCacheCodec.encode(value))).toEqual(value);
  });

  it.each([
    ["a Date", { at: new Date(0) }],
    ["a Map", new Map()],
    ["undefined", { missing: undefined }],
    ["NaN", [Number.NaN]],
    ["a bigint", { n: 1n }],
    [
      "a class instance",
      new (class Point {
        x = 1;
      })(),
    ],
  ])("rejects %s", async (_label, value) => {
    await expect(async () => jsonCacheCodec.encode(value)).rejects.toThrow(/jsonCacheCodec/);
  });
});
