import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type StepCache,
  type StepCacheEntry,
  type StepCachePolicy,
  type PipelineResult,
} from "./pipeline.js";
import { v8StepCacheCodec } from "../utilities/cache-storage.js";
import { createPipelineTestRuntime, overrideStep } from "../testing/testing.js";
import { standardSchema, thrownDefinitionErrors } from "./pipeline.test-support.js";

function memoryCache() {
  const entries = new Map<string, StepCacheEntry>();
  return {
    version: "v1",
    codec: v8StepCacheCodec,
    key: vi.fn(() => "key"),
    store: {
      get: vi.fn((key: string) => entries.get(key)),
      set: vi.fn((key: string, value: StepCacheEntry) => {
        entries.set(key, value);
      }),
    },
    entries,
  };
}

describe("step output cache", () => {
  it("infers dependency inputs, keys relevant options, and publishes typed cache hits", async () => {
    const cache = memoryCache();
    const run = vi.fn((value: string) => value.length);
    const { step } = createSteps<{ text: string; locale: string; ignored?: number }>();
    const load = step("load", { run: (_inputs, context) => context.options.text });
    const count = step("count", {
      dependsOn: [load],
      cache: {
        ...cache,
        key: (inputs, context) => {
          expectTypeOf(inputs.load).toEqualTypeOf<string>();
          expectTypeOf(context.options.locale).toEqualTypeOf<string>();
          return JSON.stringify([inputs.load, context.options.locale]);
        },
      },
      run: ({ load }) => run(load),
    });
    const pipeline = definePipeline({ id: "count", steps: [load, count], finalize: count });
    expectTypeOf<PipelineResult<typeof pipeline>>().toEqualTypeOf<number>();
    const test = createPipelineTestRuntime();
    await test.run(pipeline, { text: "hi", locale: "en" });
    const hit = await test.run(pipeline, { text: "hi", locale: "en", ignored: 1 });
    expect(hit).toMatchObject({ finalized: true, value: 2 });
    expect(hit.steps[1]).toMatchObject({
      status: "completed",
      outputSource: "cache",
      attemptId: expect.any(String),
    });
    expect(run).toHaveBeenCalledTimes(1);
    await test.run(pipeline, { text: "bye", locale: "en" });
    await test.run(pipeline, { text: "bye", locale: "fr" });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("separates pipeline, step, implementation, and application keys and snapshots configuration", async () => {
    const cache = memoryCache();
    const run = vi.fn(() => 1);
    const { step } = createSteps();
    const build = (id: string, stepId: string, version: string) => {
      const value = step(stepId, { run, cache: { ...cache, version } });
      return definePipeline({ id, steps: [value], finalize: value });
    };
    for (const pipeline of [
      build("a", "x", "1"),
      build("a", "x", "2"),
      build("b", "x", "1"),
      build("a", "y", "1"),
    ]) {
      await pipeline.runOrThrow();
      await pipeline.runOrThrow();
    }
    expect(run).toHaveBeenCalledTimes(4);
    const value = step("snapshot", { run, cache });
    const pipeline = definePipeline({ id: "snapshot", steps: [value], finalize: value });
    cache.version = "changed";
    cache.key = vi.fn(() => "changed");
    await pipeline.runOrThrow();
    expect([...cache.entries.keys()].at(-1)).toContain('"v1","key"');
    expect(pipeline.definition.steps[0]?.cache).toEqual({ version: "v1", policy: "use" });
  });

  it.each([undefined, null, false, 0, ""])("distinguishes cached %s from a miss", async (value) => {
    const cache = memoryCache();
    const run = vi.fn(() => value);
    const { step } = createSteps();
    const output = step("output", { run, cache });
    const pipeline = definePipeline({ id: "values", steps: [output], finalize: output });
    await pipeline.runOrThrow();
    expect(await pipeline.run()).toMatchObject({
      finalized: true,
      value,
      steps: [{ outputSource: "cache" }],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caches raw values before transformations and validates hits exactly once", async () => {
    const cache = memoryCache();
    const validate = vi.fn((value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("text" in value) ||
        typeof value.text !== "string"
      )
        return { issues: [{ message: "text required" }] };
      const text = value.text;
      value.text = "mutated";
      return { value: text.length };
    });
    const { step } = createSteps();
    const parsed = step("parsed", {
      run: () => ({ text: "hello" }),
      cache,
      outputSchema: standardSchema<{ text: string }, number>(validate),
    });
    const pipeline = definePipeline({
      id: "schema",
      steps: [parsed],
      finalize: parsed,
      resultSchema: standardSchema<number, string>((n) => ({ value: `count:${n}` })),
    });
    await expect(pipeline.runOrThrow()).resolves.toBe("count:5");
    await expect(pipeline.runOrThrow()).resolves.toBe("count:5");
    expect(validate).toHaveBeenCalledTimes(2);
    const key = [...cache.entries.keys()][0]!;
    cache.entries.set(key, { value: await cache.codec.encode(123), createdAtMs: Date.now() });
    const failed = await pipeline.run();
    expect(failed.steps[0]).toMatchObject({
      status: "failed",
      outputSource: "cache",
      error: { code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED" },
    });
    expect(cache.store.set).toHaveBeenCalledTimes(1);
  });

  it("honors use, recompute, bypass, and null keys without executing cache I/O accidentally", async () => {
    const cache = memoryCache();
    let executions = 0;
    const { step } = createSteps<{ policy: StepCachePolicy; noKey?: boolean }>();
    const value = step("value", {
      run: () => ++executions,
      cache: {
        ...cache,
        policy: (_inputs, context) => context.options.policy,
        key: (_inputs, context) => (context.options.noKey ? null : "key"),
      },
    });
    const pipeline = definePipeline({ id: "policy", steps: [value], finalize: value });
    expect(await pipeline.runOrThrow({ policy: "use" })).toBe(1);
    expect(await pipeline.runOrThrow({ policy: "use" })).toBe(1);
    expect(await pipeline.runOrThrow({ policy: "recompute" })).toBe(2);
    expect(await pipeline.runOrThrow({ policy: "use" })).toBe(2);
    expect(await pipeline.runOrThrow({ policy: "bypass" })).toBe(3);
    expect(await pipeline.runOrThrow({ policy: "use", noKey: true })).toBe(4);
    expect(await pipeline.runOrThrow({ policy: "use" })).toBe(2);
    expect(cache.store.get).toHaveBeenCalledTimes(4);
    expect(cache.store.set).toHaveBeenCalledTimes(2);
  });

  it("bypasses cache for all dry-run policies, policy skips, filters, and test overrides", async () => {
    const cache = memoryCache();
    const { step } = createSteps();
    const normal = step("normal", { run: () => 1, cache });
    const preview = step("preview", { run: () => 2, dryRun: () => 3, cache });
    const write = step("write", { run: () => 4, dryRun: "skip", cache });
    const skipped = step("skipped", {
      run: () => 5,
      skip: () => ({ reason: "cached by app", value: 6 }),
      cache,
    });
    const pipeline = definePipeline({ id: "bypass", steps: [normal, preview, write, skipped] });
    await pipeline.run(undefined, { dryRun: true });
    await pipeline.run(undefined, { stepIds: ["skipped"] });
    const test = createPipelineTestRuntime();
    const overridden = await test.run(
      pipeline,
      {},
      { stepIds: ["normal"], overrides: [overrideStep(normal, 7)] }
    );
    expect(overridden.steps[0]).toMatchObject({ status: "completed", outputSource: "override" });
    expect(cache.key).not.toHaveBeenCalled();
    expect(cache.store.get).not.toHaveBeenCalled();
    expect(cache.store.set).not.toHaveBeenCalled();
  });

  it.each(["key", "read", "decode", "encode", "write"])(
    "fails closed on %s errors",
    async (operation) => {
      const cache = memoryCache();
      const fail = () => {
        throw new Error("broken adapter");
      };
      const { step } = createSteps();
      const run = vi.fn(() => 42);
      const value = step("value", {
        run,
        cache: {
          ...cache,
          key: operation === "key" ? fail : cache.key,
          codec: {
            encode: operation === "encode" ? fail : cache.codec.encode,
            decode: operation === "decode" ? fail : cache.codec.decode,
          },
          store: {
            get:
              operation === "read"
                ? fail
                : operation === "decode"
                  ? () => ({ value: new Uint8Array(), createdAtMs: Date.now() })
                  : cache.store.get,
            set: operation === "write" ? fail : cache.store.set,
          },
        },
      });
      const result = await definePipeline({ id: "failure", steps: [value], finalize: value }).run();
      expect(result).toMatchObject({ status: "failed", finalized: false });
      expect(result.errors[0]).toMatchObject({
        message: `Step cache ${operation} failed`,
        cause: { message: "broken adapter" },
      });
      expect(cache.entries.size).toBe(0);
      expect(run).toHaveBeenCalledTimes(["encode", "write"].includes(operation) ? 1 : 0);
    }
  );

  it.each(["handler", "validation"])("never writes after %s failure", async (boundary) => {
    const cache = memoryCache();
    const { step } = createSteps();
    const value = step("value", {
      cache,
      run: () => {
        if (boundary === "handler") throw new Error("failed");
        return 1;
      },
      outputSchema: standardSchema<number, number>(() => ({ issues: [{ message: "invalid" }] })),
    });
    await definePipeline({ id: "no-write", steps: [value] }).run();
    expect(cache.store.set).not.toHaveBeenCalled();
  });

  it.each(["read", "handler", "validation", "write"])(
    "cancels during %s without publishing a value",
    async (boundary) => {
      const cache = memoryCache();
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("stop"));
      const { step } = createSteps();
      const value = step("value", {
        cache: {
          ...cache,
          store: {
            get: () => {
              if (boundary === "read") cancel();
              return undefined;
            },
            set: () => {
              if (boundary === "write") cancel();
            },
          },
        },
        run: () => {
          if (boundary === "handler") cancel();
          return 1;
        },
        outputSchema: standardSchema<number, number>(() => {
          if (boundary === "validation") cancel();
          return { value: 1 };
        }),
      });
      const test = createPipelineTestRuntime();
      test.context.signal = controller.signal;
      const result = await test.run(
        definePipeline({ id: "cancel", steps: [value], finalize: value }),
        {}
      );
      expect(result).toMatchObject({
        status: "cancelled",
        finalized: false,
        steps: [{ status: "cancelled" }],
      });
    }
  );

  it("fails before writing lossy results and supports an explicit reconstructing codec", async () => {
    class Result {
      constructor(readonly value: number) {}
      double() {
        return this.value * 2;
      }
    }
    const cache = memoryCache();
    const { step } = createSteps();
    const build = (codec = v8StepCacheCodec) =>
      definePipeline({
        id: "result-shape",
        steps: [
          step("result", {
            cache: { ...cache, codec },
            run: () => new Result(21),
          }),
        ],
      });
    const failed = await build().run();
    expect(failed).toMatchObject({ status: "failed", finalized: false });
    expect(failed.errors[0]).toMatchObject({
      message: "Step cache encode failed",
      cause: { message: expect.stringContaining("provide cache.codec") },
    });
    expect(cache.store.set).not.toHaveBeenCalled();
    const pipeline = build({
      encode(value) {
        if (!(value instanceof Result)) throw new Error("Expected Result");
        return v8StepCacheCodec.encode(value.value);
      },
      async decode(bytes) {
        const value = await v8StepCacheCodec.decode(bytes);
        if (typeof value !== "number") throw new Error("Expected number");
        return new Result(value);
      },
    });
    const first = await pipeline.runOrThrow();
    const hit = await pipeline.runOrThrow();
    expect(first?.double()).toBe(42);
    expect(hit?.double()).toBe(42);
    expect(cache.store.set).toHaveBeenCalledTimes(1);
  });

  it("validates cache configuration without invoking handlers or I/O during authoring or planning", () => {
    const cache = memoryCache();
    const { step, fromPipeline } = createSteps();
    const value = step("value", { run: () => 1, cache });
    const pipeline = definePipeline({ id: "plan", steps: [value] });
    pipeline.plan();
    expect(cache.key).not.toHaveBeenCalled();
    for (const invalid of [
      { ...cache, version: " " },
      { ...cache, version: "v".repeat(257) },
      { ...cache, store: {} },
      { ...cache, codec: {} },
      { ...cache, policy: "invalid" },
    ]) {
      expect(
        thrownDefinitionErrors(() =>
          definePipeline({
            id: "invalid",
            steps: [step("value", { run: () => 1, cache: invalid as StepCache<{}> })],
          })
        )[0]?.code
      ).toBe("TUBELESS_DEFINITION_STEP_CACHE_INVALID");
    }
    const child = fromPipeline("child", { pipeline });
    Reflect.set(child, "cache", cache);
    expect(
      thrownDefinitionErrors(() => definePipeline({ id: "invalid-child", steps: [child] }))[0]?.code
    ).toBe("TUBELESS_DEFINITION_STEP_CACHE_INVALID");
  });
  it("preserves dependency blocking and exposes inner hits through child progress", async () => {
    const cache = memoryCache();
    const run = vi.fn(() => 42);
    const { step, fromPipeline } = createSteps();
    const output = step("output", { run, cache });
    const child = definePipeline({ id: "child-cache", steps: [output], finalize: output });
    const wrapper = fromPipeline("wrapper", { pipeline: child });
    const parent = definePipeline({ id: "parent-cache", steps: [wrapper], finalize: wrapper });
    const test = createPipelineTestRuntime();
    await test.run(parent, {});
    const details: unknown[] = [];
    test.context.hooks = {
      onStepProgress: (event) => details.push(...(event.progress.details ?? [])),
    };
    expect((await test.run(parent, {})).value).toBe(42);
    expect(run).toHaveBeenCalledTimes(1);
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed", outputSource: "cache" }),
      ])
    );
    const fail = step("fail", {
      run: () => {
        throw new Error("stop");
      },
    });
    const blocked = step("blocked", { dependsOn: [fail], run, cache });
    const pipeline = definePipeline({
      id: "blocked-cache",
      steps: [fail, blocked],
      finalize: () => 0,
    });
    const reads = cache.store.get.mock.calls.length;
    await test.run(pipeline, {}, { continueOnError: true });
    await test.run(pipeline, {}, { stepIds: ["blocked"] });
    expect(cache.store.get).toHaveBeenCalledTimes(reads);
  });

  it("records cache configuration in identity and invalidates on version or policy changes", () => {
    const cache = memoryCache();
    const { step } = createSteps();
    const build = (version: string, policy: StepCachePolicy = "use") =>
      definePipeline({
        id: "identity",
        steps: [step("value", { run: () => 1, cache: { ...cache, version, policy } })],
      }).definition;
    expect(build("1")).toEqual(build("1"));
    expect(build("1").identity).not.toEqual(build("2").identity);
    expect(build("1").identity).not.toEqual(build("1", "bypass").identity);
  });
});
