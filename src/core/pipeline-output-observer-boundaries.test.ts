import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type PipelineRunControls,
  type PipelineStepOutputObserver,
} from "./pipeline.js";
import { standardSchema } from "./pipeline.test-support.js";
import { defer } from "./child-pipeline.test-support.js";
import { v8StepCacheCodec } from "../utilities/cache-storage.js";
import { createPipelineTestRuntime, overrideStep } from "../testing/testing.js";

function observer(): PipelineStepOutputObserver {
  return { encode: vi.fn(v8StepCacheCodec.encode), write: vi.fn() };
}

describe("output observer boundaries", () => {
  it.each([null, {}, { encode: () => new Uint8Array() }, { encode: true, write: () => {} }])(
    "rejects invalid observers before execution %#",
    async (invalid) => {
      const run = vi.fn(() => 1);
      const load = createSteps().step("load", { run });
      const pipeline = definePipeline({ id: "invalid-observer", steps: [load] });
      const controls = { outputObserver: invalid } as unknown as PipelineRunControls<
        "load",
        "load"
      >;
      expect(pipeline.plan(controls)).toMatchObject({
        ok: false,
        errors: [
          { code: "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID", phase: "planning", kind: "validation" },
        ],
      });
      expect(await pipeline.run({}, controls)).toMatchObject({ status: "failed", steps: [] });
      await expect(pipeline.runOrThrow({}, controls)).rejects.toMatchObject({
        result: { status: "failed" },
      });
      expect(run).not.toHaveBeenCalled();
    }
  );

  it("keeps planning pure, binds callback receivers, and snapshots methods at admission", async () => {
    const sink = {
      records: 0,
      encode(raw: unknown) {
        expect(this).toBe(sink);
        return v8StepCacheCodec.encode(raw);
      },
      write() {
        this.records++;
      },
    };
    const release = defer();
    const load = createSteps().step("load", {
      run: async () => {
        await release.promise;
        return 1;
      },
    });
    const pipeline = definePipeline({ id: "observer-snapshot", steps: [load] });
    const definition = JSON.stringify(pipeline.definition);
    expect(pipeline.plan({ outputObserver: sink }).ok).toBe(true);
    expect(sink.records).toBe(0);
    const running = pipeline.run({}, { outputObserver: sink });
    sink.encode = () => {
      throw new Error("replaced encoder");
    };
    sink.write = () => {
      throw new Error("replaced writer");
    };
    release.resolve();
    expect(await running).toMatchObject({ status: "completed", value: 1 });
    expect(sink.records).toBe(1);
    expect(JSON.stringify(pipeline.definition)).toBe(definition);
    expect(await pipeline.run()).toMatchObject({ status: "completed", value: 1 });
    expect(sink.records).toBe(1);
  });

  it.each(["handler", "validation", "cache-write"] as const)(
    "never writes an unsuccessful %s output",
    async (stage) => {
      const { step } = createSteps();
      const load = step("load", {
        run: () => {
          if (stage === "handler") throw new Error("handler failure");
          return "raw";
        },
        outputSchema: standardSchema<string, string>((value) =>
          stage === "validation" ? { issues: [{ message: "invalid" }] } : { value: String(value) }
        ),
        cache:
          stage === "cache-write"
            ? {
                version: "v1",
                codec: v8StepCacheCodec,
                store: {
                  get: () => undefined,
                  set: () => {
                    throw new Error("cache unavailable");
                  },
                },
              }
            : undefined,
      });
      const pipeline = definePipeline({ id: "unsuccessful-observation", steps: [load] });
      const sink = observer();
      expect(await pipeline.run({}, { outputObserver: sink })).toMatchObject({ status: "failed" });
      expect(sink.write).not.toHaveBeenCalled();
      if (stage === "handler") expect(sink.encode).not.toHaveBeenCalled();
    }
  );

  it.each(["encode", "write", "invalid-bytes"] as const)(
    "fails closed on %s failure and preserves independent branches",
    async (stage) => {
      const { step } = createSteps();
      const first = step("first", { run: () => 1 });
      const blockedRun = vi.fn(() => 2);
      const blocked = step("blocked", { dependsOn: [first], run: blockedRun });
      const independent = step("independent", { run: () => 3 });
      const pipeline = definePipeline({
        id: "observer-failure",
        steps: [first, blocked, independent],
      });
      const sink = observer();
      let calls = 0;
      sink.encode = (value) => {
        if (++calls === 1) {
          if (stage === "encode") throw new Error("encode unavailable");
          if (stage === "invalid-bytes") return "invalid" as never;
        }
        return v8StepCacheCodec.encode(value);
      };
      sink.write = ({ stepId }) => {
        if (stage === "write" && stepId === "first") throw new Error("write unavailable");
      };
      const result = await pipeline.run({}, { outputObserver: sink, continueOnError: true });
      expect(result).toMatchObject({
        status: "failed",
        errors: [
          {
            code: "TUBELESS_STEP_OUTPUT_OBSERVATION_FAILED",
            kind: "step",
            phase: "execution",
            stepId: "first",
          },
        ],
      });
      expect(result.steps.map(({ status }) => status)).toEqual(["failed", "skipped", "completed"]);
      expect(blockedRun).not.toHaveBeenCalled();
      await expect(
        pipeline.runOrThrow(
          {},
          {
            outputObserver: {
              encode: () => {
                throw new Error("failed");
              },
              write: vi.fn(),
            },
          }
        )
      ).rejects.toMatchObject({ result: { status: "failed" } });
    }
  );

  it.each(["encode", "validation", "write"] as const)(
    "honors cancellation during %s and drains the callback",
    async (stage) => {
      const entered = defer();
      const release = defer();
      const controller = new AbortController();
      let settled = false;
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const load = createSteps().step("load", {
        run: () => "raw",
        outputSchema: standardSchema<string, string>(async (value) => {
          if (stage === "validation") await pause();
          return { value: String(value) };
        }),
      });
      const pipeline = definePipeline({ id: "cancel-observation", steps: [load] });
      const sink = observer();
      sink.encode = async (value, context) => {
        expect(context.signal).toBe(controller.signal);
        if (stage === "encode") await pause();
        return v8StepCacheCodec.encode(value);
      };
      const write = vi.fn(async () => {
        if (stage === "write") await pause();
      });
      sink.write = write;
      const running = pipeline
        .run({}, { outputObserver: sink }, { signal: controller.signal })
        .then((run) => {
          settled = true;
          return run;
        });
      await entered.promise;
      controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      expect(await running).toMatchObject({
        status: "cancelled",
        steps: [{ status: "cancelled" }],
      });
      expect(write).toHaveBeenCalledTimes(stage === "write" ? 1 : 0);
    }
  );

  it.each(["encode", "write"] as const)("fails a policy skip when its %s fails", async (stage) => {
    const { step } = createSteps();
    const skipped = step("skipped", { run: () => undefined, skip: () => "already done" });
    const dependent = step("dependent", { dependsOn: [skipped], run: vi.fn(() => 1) });
    const pipeline = definePipeline({ id: "policy-write-failure", steps: [skipped, dependent] });
    const sink = observer();
    sink[stage] = () => {
      throw new Error("storage unavailable");
    };
    expect(await pipeline.run({}, { outputObserver: sink })).toMatchObject({
      status: "failed",
      steps: [
        { status: "failed", error: { code: "TUBELESS_STEP_OUTPUT_OBSERVATION_FAILED" } },
        { status: "skipped" },
      ],
    });
    expect(dependent.run).not.toHaveBeenCalled();
  });

  it("rejects output observers before snapshotting authored fan-out and iteration controls", () => {
    const { step, forEachPipeline, iteratePipeline } = createSteps();
    const leaf = step("leaf", { run: () => 1 });
    const child = definePipeline({ id: "child", steps: [leaf] });
    const controls = { outputObserver: observer() } as never;
    expect(() =>
      forEachPipeline("invalid-many", {
        pipeline: child,
        controls,
        items: () => [1],
        key: String,
        mapOptions: () => ({}),
      })
    ).toThrow("direct pipeline run");
    expect(() =>
      iteratePipeline("invalid-loop", {
        pipeline: child,
        controls,
        maxIterations: 1,
        initialState: () => 0,
        mapOptions: () => ({}),
        transition: (result) => ({ kind: "finish", result }),
      })
    ).toThrow("direct pipeline run");
  });

  it("never calls observers for dry runs, filtered work, or cancellation before dispatch", async () => {
    const { step } = createSteps();
    const write = step("write", { run: () => 1, dryRun: "skip" });
    const preview = step("preview", { run: () => 2, dryRun: () => 3 });
    const skipped = step("skipped", { run: () => 4, skip: () => "already done" });
    const pipeline = definePipeline({ id: "no-observation", steps: [write, preview, skipped] });
    const sink = observer();
    await pipeline.run({}, { outputObserver: sink, dryRun: true });
    const controller = new AbortController();
    controller.abort();
    await pipeline.run({}, { outputObserver: sink }, { signal: controller.signal });
    expect(sink.encode).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
    await pipeline.run({}, { outputObserver: sink, stepIds: ["write"] });
    expect(sink.write).toHaveBeenCalledTimes(1);
  });

  it("rejects observer/test-override combinations without disturbing override execution", async () => {
    const load = createSteps().step("load", { run: vi.fn(() => 1) });
    const pipeline = definePipeline({ id: "override-observation", steps: [load] });
    const test = createPipelineTestRuntime();
    const sink = observer();
    expect(
      await test.run(pipeline, {}, { overrides: [overrideStep(load, 2)], outputObserver: sink })
    ).toMatchObject({
      status: "failed",
      errors: [{ code: "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID" }],
    });
    expect(load.run).not.toHaveBeenCalled();
    expect(sink.encode).not.toHaveBeenCalled();
    expect(await test.runOrThrow(pipeline, {}, { overrides: [overrideStep(load, 2)] })).toBe(2);
  });

  it("rejects observers in static and dynamic child controls and keeps values out of telemetry", async () => {
    const { step, fromPipeline } = createSteps();
    const load = step("load", { run: vi.fn(() => "PRIVATE OUTPUT") });
    const child = definePipeline({ id: "private-child", steps: [load] });
    const sink = observer();
    expect(() =>
      fromPipeline("invalid", { pipeline: child, controls: { outputObserver: sink } as never })
    ).toThrow("direct pipeline run");
    const invalid = fromPipeline("invalid-dynamic", {
      pipeline: child,
      controls: () => ({ outputObserver: sink }) as never,
    });
    expect(await definePipeline({ id: "dynamic-parent", steps: [invalid] }).run()).toMatchObject({
      status: "failed",
    });
    expect(load.run).not.toHaveBeenCalled();
    const metadata: unknown[] = [];
    const run = await child.run(
      {},
      { outputObserver: sink },
      {
        hooks: {
          onStepStatus: (event) => {
            metadata.push(event);
          },
        },
        tracing: {
          exporter: {
            export: (event) => {
              metadata.push(event);
            },
          },
        },
      }
    );
    expect(run.status).toBe("completed");
    const serialized = JSON.stringify([metadata, run.steps]);
    expect(serialized).not.toContain("PRIVATE OUTPUT");
    expect(serialized).not.toContain("encodedValue");
    expectTypeOf<(typeof child.stepIds)[number]>().toEqualTypeOf<"load">();
  });
});
