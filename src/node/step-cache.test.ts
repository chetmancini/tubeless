import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFileStepCache, v8StepCacheCodec } from "./node.js";
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tubeless-cache-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it("persists timestamped bytes across instances and hashes unsafe keys", async () => {
  const root = await directory();
  const first = createFileStepCache(root);
  const second = createFileStepCache(root);
  const key = "../../outside/private-key";
  expect(await first.get(key, {})).toBeUndefined();
  const value = { nothing: undefined, big: 1n, map: new Map([["key", new Date(0)]]) };
  const receipt = await first.set(
    key,
    { value: await v8StepCacheCodec.encode(value), createdAtMs: 123 },
    {}
  );
  const entry = (await second.get(key, {}))!;
  expect(entry.artifact).toEqual(receipt);
  const storedBytes = await readFile(fileURLToPath(entry.artifact!.uri!));
  expect(entry.artifact).toMatchObject({
    byteSize: storedBytes.byteLength,
    checksum: `sha256:${createHash("sha256").update(storedBytes).digest("hex")}`,
  });
  expect(entry.createdAtMs).toBe(123);
  expect(await v8StepCacheCodec.decode(entry.value)).toEqual(value);
  expect(await readdir(root)).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.cache$/)]);
  expect(() => v8StepCacheCodec.encode(() => {})).toThrow();
});

it("atomically replaces entries and accepts concurrent writers", async () => {
  const root = await directory();
  const cache = createFileStepCache(root);
  await cache.set("key", { value: new Uint8Array([0]), createdAtMs: 0 }, {});
  await Promise.all(
    Array.from({ length: 8 }, () =>
      cache.set("key", { value: new Uint8Array([1, 2, 3]), createdAtMs: 1 }, {})
    )
  );
  const entry = (await cache.get("key", {}))!;
  expect(Array.from(entry.value)).toEqual([1, 2, 3]);
  expect(entry.createdAtMs).toBe(1);
  expect((await readdir(root)).length).toBe(1);
});

it("propagates storage failures and cancellation without replacing a valid entry", async () => {
  const root = await directory();
  const cache = createFileStepCache(root);
  const entry = { value: new Uint8Array([1]), createdAtMs: 0 };
  await cache.set("key", entry, {});
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(cache.set("key", entry, { signal: controller.signal })).rejects.toThrow("stop");
  await expect(cache.get("key", { signal: controller.signal })).rejects.toThrow("stop");
  expect(Array.from((await cache.get("key", {}))!.value)).toEqual([1]);
  const file = join(root, "file");
  await writeFile(file, "not a directory");
  await expect(createFileStepCache(file).get("key", {})).rejects.toThrow();
  await expect(createFileStepCache(file).set("key", entry, {})).rejects.toThrow();
});

it("rejects lossy default-codec results, including nested instances and changed prototypes", () => {
  class Result {
    value = 21;
    double() {
      return this.value * 2;
    }
  }
  const instance = new Result();
  for (const value of [
    instance,
    { nested: instance },
    new Map([["result", instance]]),
    new Set([instance]),
    Object.assign(Object.create(null), { value: 1 }),
  ]) {
    expect(() => v8StepCacheCodec.encode(value)).toThrow("provide cache.codec");
  }
});

it("round-trips supported structured results with cycles and shared references", async () => {
  const shared = { value: 1 };
  const value = {
    shared,
    alias: shared,
    date: new Date(0),
    bytes: new Uint8Array([1, 2]),
    set: new Set([1n, undefined]),
    map: new Map([[shared, "value"]]),
    cycle: {},
  };
  value.cycle = value;
  const decoded = await v8StepCacheCodec.decode(await v8StepCacheCodec.encode(value));
  expect(decoded).toStrictEqual(value);
});
