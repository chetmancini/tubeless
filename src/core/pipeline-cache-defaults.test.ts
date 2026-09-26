import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type StepCacheEntry } from "./pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { defaultCacheKey } from "../utilities/cache-key.js";
import { v8StepCacheCodec } from "../utilities/cache-storage.js";
import { standardSchema } from "./pipeline.test-support.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "cache-defaults-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
function memoryStore() {
  const entries = new Map<string, StepCacheEntry>();
  return {
    get: vi.fn((key: string) => entries.get(key)),
    set: vi.fn((key: string, entry: StepCacheEntry) => {
      entries.set(key, entry);
    }),
  };
}

it("uses cwd/.cache/pipeline/step and separates cwd, pipeline, step, and implementation", async () => {
  const cwd = await directory();
  const elsewhere = await directory();
  const run = vi.fn(() => 1);
  const { step } = createSteps();
  const make = (id = "pipeline", version = "v1", stepId = "work") => {
    const work = step(stepId, { cache: true, run });
    return definePipeline({ id, steps: [work], implementationVersion: version, finalize: work });
  };
  const test = createPipelineTestRuntime();
  test.context.cwd = cwd;
  await test.run(make(), {});
  expect((await test.run(make(), {})).steps[0]?.outputSource).toBe("cache");
  expect(await readdir(join(cwd, ".cache", "pipeline", "work"))).toHaveLength(1);
  await test.run(make("other"), {});
  await test.run(make("pipeline", "v2"), {});
  await test.run(make("pipeline", "v1", "different"), {});
  test.context.cwd = elsewhere;
  await test.run(make(), {});
  expect(run).toHaveBeenCalledTimes(5);
});

it("does no persistence for unopted steps, planning, bypass, or dry runs", async () => {
  const cwd = await directory();
  const test = createPipelineTestRuntime();
  test.context.cwd = cwd;
  const { step } = createSteps();
  const ordinary = step("ordinary", { run: () => 1 });
  const cached = step("cached", { cache: true, run: () => 2 });
  const pipeline = definePipeline({
    id: "unused",
    implementationVersion: "v1",
    cache: { maxAge: "30 days" },
    steps: [ordinary, cached],
  });
  pipeline.plan();
  await test.run(pipeline, {}, { stepIds: ["ordinary"] });
  await test.run(pipeline, {}, { cache: "bypass" });
  await test.run(pipeline, {}, { dryRun: true });
  expect(await readdir(cwd)).toEqual([]);
});

it("supports shared defaults and step age overrides with store-independent expiration", async () => {
  const store = memoryStore();
  const { step } = createSteps();
  const shortRun = vi.fn(() => "short");
  const longRun = vi.fn(() => "long");
  const short = step("short", { cache: true, run: shortRun });
  const long = step("long", { cache: { maxAge: "2 seconds", version: "custom" }, run: longRun });
  const pipeline = definePipeline({
    id: "ages",
    implementationVersion: "v1",
    steps: [short, long],
    cache: { store, codec: v8StepCacheCodec, maxAge: "1s" },
  });
  const test = createPipelineTestRuntime();
  let now = 0;
  test.context.now = () => now;
  await test.run(pipeline, {});
  now = 999;
  await test.run(pipeline, {});
  expect(shortRun).toHaveBeenCalledTimes(1);
  expect(longRun).toHaveBeenCalledTimes(1);
  now = 1000;
  await test.run(pipeline, {});
  expect(shortRun).toHaveBeenCalledTimes(2);
  expect(longRun).toHaveBeenCalledTimes(1);
  now = 2000;
  await test.run(pipeline, {});
  expect(shortRun).toHaveBeenCalledTimes(3);
  expect(longRun).toHaveBeenCalledTimes(2);
  expect(pipeline.definition.steps.map((s) => s.cache)).toEqual([
    { version: "v1", policy: "use", maxAgeMs: 1000 },
    { version: "custom", policy: "use", maxAgeMs: 2000 },
  ]);
});

it("keys validated domain options and inputs, preserving absence versus published undefined", async () => {
  const store = memoryStore();
  const run = vi.fn(() => 1);
  const { step } = createSteps(
    standardSchema<{ n: string }, { n: number }>((value) => ({
      value: { n: Number((value as { n: string }).n) },
    }))
  );
  const dependency = step("dependency", { run: () => undefined });
  const value = step("value", { optionalDependsOn: [dependency], cache: true, run });
  const pipeline = definePipeline({
    id: "keys",
    implementationVersion: "v1",
    steps: [dependency, value],
    cache: { store },
  });
  const test = createPipelineTestRuntime();
  await test.run(pipeline, { n: "1" });
  expect((await test.run(pipeline, { n: "01" })).steps[1]?.outputSource).toBe("cache");
  await test.run(pipeline, { n: "1" }, { stepIds: ["value"] });
  await test.run(pipeline, { n: "2" });
  expect(run).toHaveBeenCalledTimes(3);
  expect(store.set.mock.calls[0]?.[0]).toContain(
    defaultCacheKey({ dependency: undefined }, { n: 1 })
  );
});

it.each([
  ["30 days", 2592000000],
  ["30d", 2592000000],
  ["12 hours", 43200000],
  ["12h", 43200000],
  ["45m", 2700000],
  ["500 milliseconds", 500],
  ["500ms", 500],
  ["1 week", 604800000],
  ["1.5 seconds", 1500],
  ["1.001s", 1001],
  ["1.009s", 1009],
  ["1.000000000000000000000000000000s", 1000],
  ["0.0001 minutes", 6],
  ["9007199254740991ms", Number.MAX_SAFE_INTEGER],
  ["0ms", 0],
  [500, 500],
] as const)("normalizes maxAge %s at definition time", (maxAge, milliseconds) => {
  const { step } = createSteps();
  const work = step("work", { cache: true, run: () => 1 });
  const pipeline = definePipeline({
    id: "duration",
    steps: [work],
    implementationVersion: "v1",
    cache: { maxAge },
  });
  expect(pipeline.definition.steps[0]?.cache?.maxAgeMs).toBe(milliseconds);
});

it.each([
  "1 month",
  "1 year",
  "tomorrow",
  "30",
  "",
  "0.1ms",
  "1.0001s",
  "1.000000000000000000000000000001s",
  "9007199254740991.1ms",
  "9007199254740992ms",
  "-1s",
  Infinity,
  NaN,
  -1,
  Number.MAX_SAFE_INTEGER + 1,
])("rejects invalid maxAge %s before execution", (maxAge) => {
  const { step } = createSteps();
  expect(() => definePipeline({ id: "invalid", steps: [], cache: { maxAge } })).toThrow("maxAge");
  expect(() =>
    definePipeline({
      id: "invalid",
      implementationVersion: "v1",
      steps: [step("work", { cache: { maxAge }, run: () => 1 })],
    })
  ).toThrow("maxAge");
});

it("requires an explicit or inherited implementation version and preserves key overrides", async () => {
  const store = memoryStore();
  const { step } = createSteps<{ ignored: string; payload: Map<string, number> }>();
  const key = vi.fn(() => "same");
  const run = vi.fn(() => 1);
  const value = step("value", { cache: { version: "v1", key }, run });
  const pipeline = definePipeline({ id: "override", steps: [value], cache: { store } });
  const test = createPipelineTestRuntime();
  await test.run(pipeline, { ignored: "a", payload: new Map() });
  expect(
    (await test.run(pipeline, { ignored: "b", payload: new Map() })).steps[0]?.outputSource
  ).toBe("cache");
  expect(run).toHaveBeenCalledTimes(1);
  expect(() =>
    definePipeline({ id: "invalid", steps: [step("unversioned", { cache: true, run })] })
  ).toThrow("implementationVersion");
});

it("applies run policy to child caches without adding execution controls to keys", async () => {
  const store = memoryStore();
  const run = vi.fn(() => 1);
  const policy = vi.fn(() => "use" as const);
  const { step, fromPipeline } = createSteps();
  const value = step("value", { cache: { version: "v1", policy }, run });
  const child = definePipeline({ id: "child", steps: [value], cache: { store }, finalize: value });
  const wrapped = fromPipeline("wrapped", { pipeline: child });
  const parent = definePipeline({ id: "parent", steps: [wrapped], finalize: wrapped });
  const test = createPipelineTestRuntime();
  await test.run(parent, {});
  await test.run(parent, {});
  expect(run).toHaveBeenCalledTimes(1);
  await test.run(parent, {}, { cache: "recompute" });
  await test.run(parent, {}, { cache: "bypass" });
  expect(run).toHaveBeenCalledTimes(3);
  expect(policy).toHaveBeenCalledTimes(2);
  await test.run(parent, {}, { cache: "use" });
  expect(run).toHaveBeenCalledTimes(3);
  expect(store.set.mock.calls[0]?.[0]).toBe(store.set.mock.calls[1]?.[0]);
  expect(parent.plan({ cache: "invalid" as never }).errors[0]?.code).toBe(
    "TUBELESS_RUN_CACHE_INVALID"
  );
});

it("encodes unsafe ID segments and separates case-sensitive identities on disk", async () => {
  const cwd = await directory();
  const test = createPipelineTestRuntime();
  test.context.cwd = cwd;
  const { step } = createSteps();
  const run = vi.fn(() => 1);
  for (const id of ["../outside", "WORK", "work", "x".repeat(300)]) {
    const value = step(id, { cache: { version: "v1" }, run });
    await test.run(definePipeline({ id: "../pipeline", steps: [value] }), {});
  }
  expect(await readdir(cwd)).toEqual([".cache"]);
  const pipelines = await readdir(join(cwd, ".cache"));
  expect(pipelines).toHaveLength(1);
  expect(await readdir(join(cwd, ".cache", pipelines[0]!))).toHaveLength(4);
  expect(run).toHaveBeenCalledTimes(4);
});

it("keeps inherited code versions out of structural fingerprints while binding cache identities", () => {
  const { step } = createSteps();
  const work = step("work", { cache: true, run: () => 1 });
  const build = (implementationVersion: string, maxAge = "1 day") =>
    definePipeline({ id: "identity", steps: [work], implementationVersion, cache: { maxAge } })
      .definition.identity;
  expect(build("v1").structuralFingerprint).toBe(build("v2").structuralFingerprint);
  expect(build("v1").definitionId).not.toBe(build("v2").definitionId);
  expect(build("v1").structuralFingerprint).not.toBe(build("v1", "2 days").structuralFingerprint);
});

it("compiles the author cache once and retains its snapshot through graph construction", async () => {
  const { step } = createSteps();
  const store = memoryStore();
  const key = vi.fn(() => "key");
  let reads = 0;
  const cache = {
    get version() {
      reads++;
      if (reads > 1) throw new Error("cache configuration was compiled again");
      return "v1";
    },
    store,
    key,
  };
  const work = step("work", { cache, run: () => 1 });
  const pipeline = definePipeline({ id: "compile-once", steps: [work] });
  cache.key = vi.fn(() => "changed");
  await pipeline.runOrThrow();
  const hit = await pipeline.run();
  expect(reads).toBe(1);
  expect(key).toHaveBeenCalledTimes(2);
  expect(hit.steps[0].outputSource).toBe("cache");
  expect(pipeline.definition.steps[0].cache?.version).toBe("v1");
});
