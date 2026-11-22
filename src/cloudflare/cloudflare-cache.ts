import { encodePlainJson } from "../utilities/plain-json.js";
import type { StepCacheCodec, StepCacheStore } from "../core/pipeline.js";

/** Structural subset of an R2 object body that the cache store reads. */
export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly customMetadata?: Record<string, string>;
  readonly uploaded: Date;
}

/** Structural subset of an R2 bucket binding that the cache store uses. */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: { customMetadata?: Record<string, string> }
  ): Promise<unknown>;
}

/**
 * Step cache entries in R2. Core still enforces versions, keys and maxAge.
 * Pass a getter to bind the bucket later; it is resolved on every read and write.
 */
export function createR2CacheStore(
  bucket: R2BucketLike | (() => R2BucketLike),
  options: { readonly prefix?: string } = {}
): StepCacheStore {
  const prefix = options.prefix ?? "tubeless-cache/";
  const resolve = typeof bucket === "function" ? bucket : () => bucket;
  return {
    async get(key) {
      const object = await resolve().get(prefix + key);
      if (!object) return undefined;
      const raw = object.customMetadata?.createdAtMs ?? "";
      const recorded = raw.trim() === "" ? Number.NaN : Number(raw);
      return {
        value: new Uint8Array(await object.arrayBuffer()),
        createdAtMs: Number.isFinite(recorded) ? recorded : object.uploaded.getTime(),
      };
    },
    async set(key, entry) {
      await resolve().put(prefix + key, entry.value, {
        customMetadata: { createdAtMs: String(entry.createdAtMs) },
      });
    },
  };
}

/** Lossless JSON codec for Workers, where the default V8 codec is unavailable. */
export const jsonCacheCodec: StepCacheCodec = {
  encode(value) {
    return encodePlainJson(
      value,
      (path, reason) => new Error(`jsonCacheCodec cannot store ${path}: ${reason}`)
    );
  },
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
  },
};
