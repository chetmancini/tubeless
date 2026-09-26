import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { deserialize, serialize } from "node:v8";
import type { StepCacheCodec, StepCacheEntry, StepCacheStore } from "../core/pipeline-cache.js";

/** Node's structured serialization, including undefined, Maps, Dates, and BigInts. */
export const v8StepCacheCodec: StepCacheCodec = Object.freeze({
  encode: (value: unknown) => {
    const bytes = serialize(value);
    if (!isDeepStrictEqual(value, deserialize(bytes))) {
      throw new Error("Default cache codec cannot round-trip this value; provide cache.codec");
    }
    return bytes;
  },
  decode: (value: Uint8Array): unknown => deserialize(value),
});

/** Persist timestamped cache entries with atomic replacement in a dedicated directory. */
export function createFileStepCache(directory: string): StepCacheStore {
  const root = resolve(directory);
  const fileFor = (key: string) =>
    resolve(root, `${createHash("sha256").update(key).digest("hex")}.cache`);
  const receiptFor = (key: string, bytes: Uint8Array) => ({
    uri: pathToFileURL(fileFor(key)).href,
    byteSize: bytes.byteLength,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  return {
    async get(key, { signal }) {
      signal?.throwIfAborted();
      let bytes: Uint8Array;
      try {
        bytes = await readFile(fileFor(key), { signal });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
      const entry: unknown = deserialize(bytes);
      if (
        !entry ||
        typeof entry !== "object" ||
        !("createdAtMs" in entry) ||
        typeof entry.createdAtMs !== "number" ||
        !Number.isFinite(entry.createdAtMs) ||
        !("value" in entry) ||
        !(entry.value instanceof Uint8Array)
      )
        throw new Error("Invalid cache entry");
      return {
        createdAtMs: entry.createdAtMs,
        value: entry.value,
        artifact: receiptFor(key, bytes),
      };
    },
    async set(key, entry: StepCacheEntry, { signal }) {
      signal?.throwIfAborted();
      const bytes = serialize({ value: entry.value, createdAtMs: entry.createdAtMs });
      const file = fileFor(key);
      const temporary = `${file}.tmp-${randomUUID()}`;
      await mkdir(root, { recursive: true });
      try {
        await writeFile(temporary, bytes, { signal, flag: "wx" });
        signal?.throwIfAborted();
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return receiptFor(key, bytes);
    },
  };
}

function directorySegment(id: string): string {
  // Preserve common stable IDs; encode every other character injectively, including dots.
  // Bound long segments without letting case-insensitive filesystems merge distinct IDs.
  const readable = id.replace(
    /[^a-z0-9_-]/g,
    (character) => `~${character.codePointAt(0)!.toString(16)}~`
  );
  return readable.length <= 100
    ? readable
    : `${readable.slice(0, 60)}-${createHash("sha256").update(id).digest("hex")}`;
}

export function defaultFileStepCache(
  cwd: string,
  directory: string,
  pipelineId: string,
  stepId: string
): StepCacheStore {
  return createFileStepCache(
    resolve(cwd, directory, directorySegment(pipelineId), directorySegment(stepId))
  );
}
