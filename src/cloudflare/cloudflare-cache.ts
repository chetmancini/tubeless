import type { StepCacheCodec, StepCacheStore } from "../core/pipeline.js";

export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly customMetadata?: Record<string, string>;
  readonly uploaded: Date;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { customMetadata?: Record<string, string> }
  ): Promise<unknown>;
}

/** Step cache entries in R2. Core still enforces versions, keys and maxAge. */
export function createR2CacheStore(
  bucket: R2BucketLike,
  options: { readonly prefix?: string } = {}
): StepCacheStore {
  const prefix = options.prefix ?? "tubeless-cache/";
  return {
    async get(key) {
      const object = await bucket.get(prefix + key);
      if (!object) return undefined;
      const recorded = Number(object.customMetadata?.createdAtMs);
      return {
        value: new Uint8Array(await object.arrayBuffer()),
        createdAtMs: Number.isFinite(recorded) ? recorded : object.uploaded.getTime(),
      };
    },
    async set(key, entry) {
      await bucket.put(prefix + key, entry.value, {
        customMetadata: { createdAtMs: String(entry.createdAtMs) },
      });
    },
  };
}

function assertPlainJson(value: unknown, path: string): void {
  const reject = (): never => {
    throw new Error(
      `jsonCacheCodec cannot store ${path}: only plain objects, arrays, strings, finite numbers, booleans and null round-trip.`
    );
  };
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject();
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) reject();
    for (const [key, item] of Object.entries(value)) assertPlainJson(item, `${path}.${key}`);
    return;
  }
  reject();
}

/** Lossless JSON codec for Workers, where the default V8 codec is unavailable. */
export const jsonCacheCodec: StepCacheCodec = {
  encode(value) {
    assertPlainJson(value, "value");
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
  },
};
