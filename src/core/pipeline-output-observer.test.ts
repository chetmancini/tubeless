import { describe, expect, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type PipelineStepOutputObserver,
  type PipelineStepOutputRecord,
  type StepCacheEntry,
} from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";
import { defer } from "./child-pipeline.test-support.js";
import { v8StepCacheCodec } from "../utilities/cache-storage.js";

function collector() {
  const records: PipelineStepOutputRecord[] = [];
  const observer: PipelineStepOutputObserver = {
    encode: v8StepCacheCodec.encode,
    write: (record) => {
      records.push(record);
    },
  };
  return { observer, records };
}

describe("step output observation", () => {
  it("detaches raw bytes before a mutating schema and publishes the transformed value", async () => {
    let buffer: Uint8Array | undefined;
    const validate = vi.fn((value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("text" in value) ||
        typeof value.text !== "string"
      )
        return { issues: [{ message: "Text required" }] };
      const count = value.text.length;
      value.text = "mutated";
      buffer?.fill(0);
      return { value: count };
    });
    const { step } = createSteps();
    const count = step("count", {
      run: () => ({ text: "hello" }),
      outputSchema: standardSchema<{ text: string }, number>(validate),
    });
    const pipeline = definePipeline({ id: "observe", implementationVersion: "v1", steps: [count] });
    const { observer, records } = collector();
    observer.encode = async (raw) => {
      buffer = await v8StepCacheCodec.encode(raw);
      return buffer;
    };
    const result = await pipeline.run({}, { outputObserver: observer });
    expect(result).toMatchObject({ status: "completed", value: 5 });
    expect(validate).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(await v8StepCacheCodec.decode(records[0].encodedValue)).toEqual({ text: "hello" });
    expect(records[0]).toMatchObject({
      pipelineId: "observe",
      stepId: "count",
      runId: result.runId,
      attemptId: result.steps[0].attemptId,
      definitionIdentity: pipeline.definition.identity,
      origin: "handler",
    });
  });

  it("awaits persistence before completion and before starting required dependents", async () => {
    const entered = defer();
    const release = defer();
    const complete = vi.fn();
    const next = vi.fn(() => 2);
    const { step } = createSteps();
    const first = step("first", { run: () => 1 });
    const second = step("second", { dependsOn: [first], run: next });
    const pipeline = definePipeline({ id: "await-write", steps: [first, second] });
    const { observer } = collector();
    observer.write = async ({ stepId }) => {
      if (stepId !== "first") return;
      entered.resolve();
      await release.promise;
    };
    const running = pipeline.run(
      {},
      { outputObserver: observer },
      { hooks: { onStepComplete: complete } }
    );
    await entered.promise;
    expect(next).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    release.resolve();
    expect(await running).toMatchObject({ status: "completed", value: 2 });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("keeps independent writes concurrent and drains them before returning", async () => {
    const bothEntered = defer();
    const release = defer();
    let active = 0;
    let maximum = 0;
    let settled = false;
    const { step } = createSteps();
    const third = vi.fn(() => 3);
    const steps = [
      step("first", { run: () => 1 }),
      step("second", { run: () => 2 }),
      step("third", { run: third }),
    ] as const;
    const pipeline = definePipeline({ id: "parallel-writes", steps });
    const { observer } = collector();
    observer.write = async () => {
      maximum = Math.max(maximum, ++active);
      if (active === 2) bothEntered.resolve();
      await release.promise;
      active--;
    };
    const running = pipeline
      .run({}, { outputObserver: observer, maxConcurrency: 2 })
      .then((run) => {
        settled = true;
        return run;
      });
    await bothEntered.promise;
    expect(settled).toBe(false);
    expect(maximum).toBe(2);
    expect(third).not.toHaveBeenCalled();
    release.resolve();
    expect(await running).toMatchObject({ status: "completed" });
    expect(active).toBe(0);
  });

  it("captures raw cache hits after normal cache writes and validates each publication once", async () => {
    const entries = new Map<string, StepCacheEntry>();
    const order: string[] = [];
    const run = vi.fn(() => "21");
    const validate = vi.fn((value: unknown) => ({ value: Number(value) }));
    const { step } = createSteps();
    const count = step("count", {
      run,
      outputSchema: standardSchema<string, number>(validate),
      cache: {
        version: "v1",
        codec: v8StepCacheCodec,
        store: {
          get: (key) => entries.get(key),
          set: (key, entry) => {
            entries.set(key, entry);
            order.push("cache");
          },
        },
      },
    });
    const pipeline = definePipeline({ id: "cache-observation", steps: [count] });
    const { observer, records } = collector();
    observer.write = (record) => {
      records.push(record);
      order.push("observer");
    };
    await pipeline.runOrThrow({}, { outputObserver: observer });
    const hit = await pipeline.run({}, { outputObserver: observer });
    expect(hit).toMatchObject({ value: 21, steps: [{ outputSource: "cache" }] });
    expect(run).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["cache", "observer", "observer"]);
    expect(records.map(({ origin }) => origin)).toEqual(["handler", "cache"]);
    expect(await v8StepCacheCodec.decode(records[1].encodedValue)).toBe("21");
  });

  it("stops dispatch on observation failure while draining another active write", async () => {
    const entered = defer();
    const fail = defer();
    const failed = defer();
    const release = defer();
    let active = 0;
    let settled = false;
    const pendingRun = vi.fn(() => 3);
    const { step } = createSteps();
    const first = step("first", { run: () => 1 });
    const second = step("second", { run: () => 2 });
    const pending = step("pending", { run: pendingRun });
    const pipeline = definePipeline({ id: "fail-fast-writes", steps: [first, second, pending] });
    const { observer } = collector();
    observer.write = async ({ stepId }) => {
      if (++active === 2) entered.resolve();
      if (stepId === "first") {
        await fail.promise;
        throw new Error("storage failed");
      }
      await release.promise;
    };
    const running = pipeline
      .run(
        {},
        { outputObserver: observer, maxConcurrency: 2 },
        {
          hooks: { onStepFail: () => failed.resolve() },
        }
      )
      .then((run) => {
        settled = true;
        return run;
      });
    await entered.promise;
    fail.resolve();
    await failed.promise;
    expect(settled).toBe(false);
    expect(pendingRun).not.toHaveBeenCalled();
    release.resolve();
    expect(await running).toMatchObject({
      status: "failed",
      steps: [
        { status: "failed" },
        { status: "completed" },
        { status: "skipped", reason: "fail-fast" },
      ],
    });
  });

  it("captures transformed policy values and explicit undefined without inventing an attempt", async () => {
    const { step } = createSteps();
    const skipped = step("skipped", {
      run: vi.fn(() => undefined),
      skip: () => ({ reason: "done", value: undefined }),
    });
    const parsed = step("parsed", {
      run: vi.fn(() => "0"),
      skip: () => ({ reason: "saved", value: "21" }),
      outputSchema: standardSchema<string, number>((value) => ({ value: Number(value) })),
    });
    const pipeline = definePipeline({ id: "policy-observation", steps: [skipped, parsed] });
    const { observer, records } = collector();
    const result = await pipeline.run({}, { outputObserver: observer });
    expect(result).toMatchObject({ status: "completed", value: 21 });
    expect(result.steps.map(({ status }) => status)).toEqual(["skipped", "skipped"]);
    expect(records.map(({ origin }) => origin)).toEqual(["policy", "policy"]);
    expect(records[0]).not.toHaveProperty("attemptId");
    expect(result.steps[0]).not.toHaveProperty("attemptId");
    expect(await v8StepCacheCodec.decode(records[0].encodedValue)).toBeUndefined();
    expect(await v8StepCacheCodec.decode(records[1].encodedValue)).toBe("21");
    expect(skipped.run).not.toHaveBeenCalled();
    expect(parsed.run).not.toHaveBeenCalled();
  });

  it("observes child, fan-out, iteration, and remote wrappers as atomic parent outputs", async () => {
    const leaf = createSteps().step("leaf", { run: () => 3 });
    const child = definePipeline({ id: "child", steps: [leaf] });
    const { fromPipeline, forEachPipeline, iteratePipeline, fromRemote } = createSteps();
    const single = fromPipeline("single", { pipeline: child });
    const many = forEachPipeline("many", {
      pipeline: child,
      items: () => [1, 2],
      key: String,
      mapOptions: () => ({}),
    });
    const loop = iteratePipeline("loop", {
      pipeline: child,
      maxIterations: 2,
      initialState: () => 0,
      mapOptions: () => ({}),
      transition: (result) => ({ kind: "finish", result }),
    });
    const remote = fromRemote("remote", {
      adapter: { engine: "test", invoke: async () => "42" },
      mapInput: () => ({}),
      outputSchema: standardSchema<string, number>((value) => ({ value: Number(value) })),
    });
    const pipeline = definePipeline({ id: "wrappers", steps: [single, many, loop, remote] });
    const { observer, records } = collector();
    expect(await pipeline.runOrThrow({}, { outputObserver: observer })).toBe(42);
    expect(records.map(({ stepId }) => stepId)).toEqual(["single", "many", "loop", "remote"]);
    expect(
      await Promise.all(records.map(({ encodedValue }) => v8StepCacheCodec.decode(encodedValue)))
    ).toEqual([3, [3, 3], 3, "42"]);
    expect(records.every(({ pipelineId }) => pipelineId === "wrappers")).toBe(true);
  });
});
