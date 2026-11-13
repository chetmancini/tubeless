import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type ForEachItemFailurePolicy,
  type ForEachSettledItem,
  type Step,
} from "./pipeline.js";
import { defer, rejectWhenAborted } from "./child-pipeline.test-support.js";

interface ChildOptions {
  itemId: string;
}

/** A child that fails for ids starting with "bad" and records every id it started. */
function failingChild(started: string[] = []) {
  const { step } = createSteps<ChildOptions>();
  const process = step("process", {
    run: (_inputs, context) => {
      started.push(context.options.itemId);
      if (context.options.itemId.startsWith("bad"))
        throw new Error(`${context.options.itemId} exploded`);
      return context.options.itemId.toUpperCase();
    },
  });
  return definePipeline({ id: "policy-child", steps: [process], finalize: (o) => o.process });
}

function fanOut(
  items: readonly string[],
  onItemFailure: ForEachItemFailurePolicy,
  started: string[] = []
) {
  const { forEachPipeline } = createSteps();
  const children = forEachPipeline("children", {
    pipeline: failingChild(started),
    items: () => items,
    key: (item) => item,
    onItemFailure,
    mapOptions: (item) => ({ itemId: item }),
  });
  return definePipeline({ id: "policy-parent", steps: [children] });
}

const silent = { cwd: "/tmp", log: { log() {}, warn() {}, error() {} } };

describe("forEachPipeline onItemFailure", () => {
  it("runs every item before failing by default", async () => {
    const started: string[] = [];
    const result = await fanOut(["a", "bad-b", "c"], "fail", started).run({}, {}, silent);
    expect(started).toEqual(["a", "bad-b", "c"]);
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.fanOut?.failureCount).toBe(1);
  });

  it("starts no further items after the first failure under stop", async () => {
    const started: string[] = [];
    const result = await fanOut(["a", "bad-b", "c", "bad-d"], "stop", started).run({}, {}, silent);
    expect(started).toEqual(["a", "bad-b"]);
    expect(result.status).toBe("failed");
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_CHILD_FAILED",
      fanOut: { failureCount: 1, failures: [{ key: "bad-b", index: 1 }] },
    });
    expect(result.errors[0]?.message).toContain(
      "failed for 1 item(s) (stopped; 2 item(s) not started): bad-b"
    );
  });

  it("lets running items finish under stop", async () => {
    const slowStarted = defer();
    const releaseSlow = defer();
    let slowFinished = false;
    const { step } = createSteps<ChildOptions>();
    const process = step("process", {
      run: async (_inputs, context) => {
        if (context.options.itemId === "slow") {
          slowStarted.resolve();
          await releaseSlow.promise;
          slowFinished = true;
          return "slow";
        }
        await slowStarted.promise;
        throw new Error("fast failure");
      },
    });
    const child = definePipeline({ id: "drain-child", steps: [process] });
    const { forEachPipeline } = createSteps();
    const children = forEachPipeline("children", {
      pipeline: child,
      items: () => ["slow", "fast", "never"],
      key: (item) => item,
      concurrency: 2,
      onItemFailure: "stop",
      mapOptions: (item) => ({ itemId: item }),
    });
    const run = definePipeline({ id: "drain-parent", steps: [children] }).run({}, {}, silent);
    await slowStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseSlow.resolve();
    const result = await run;
    expect(slowFinished).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.errors[0]?.message).toContain("(stopped; 1 item(s) not started)");
  });

  it("completes with one JSON-safe settled entry per item under collect", async () => {
    const warn = vi.fn();
    const result = await fanOut(["a", "bad-b", "c"], "collect").run(
      {},
      {},
      { ...silent, log: { ...silent.log, warn } }
    );
    expect(result.status).toBe("completed");
    expect(result.value).toEqual([
      { key: "a", index: 0, ok: true, value: "A" },
      {
        key: "bad-b",
        index: 1,
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("bad-b exploded"),
        }),
      },
      { key: "c", index: 2, ok: true, value: "C" },
    ]);
    expect(JSON.parse(JSON.stringify(result.value))).toEqual(result.value);
    expect(warn).toHaveBeenCalledWith(
      "Mapped child pipeline policy-child collected 1 of 3 item failure(s)."
    );
  });

  it("does not warn when every collected item succeeds", async () => {
    const warn = vi.fn();
    const result = await fanOut(["a", "c"], "collect").run(
      {},
      {},
      { ...silent, log: { ...silent.log, warn } }
    );
    expect(result.value).toEqual([
      { key: "a", index: 0, ok: true, value: "A" },
      { key: "c", index: 1, ok: true, value: "C" },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("cancels instead of collecting when the run is cancelled", async () => {
    const controller = new AbortController();
    const started = defer();
    const { step } = createSteps<ChildOptions>();
    const process = step("process", {
      run: async (_inputs, context) => {
        started.resolve();
        await rejectWhenAborted(context.signal);
      },
    });
    const { forEachPipeline } = createSteps();
    const children = forEachPipeline("children", {
      pipeline: definePipeline({ id: "cancel-child", steps: [process] }),
      items: () => ["a", "b"],
      key: (item) => item,
      onItemFailure: "collect",
      mapOptions: (item) => ({ itemId: item }),
    });
    const run = definePipeline({ id: "cancel-parent", steps: [children] }).run(
      {},
      {},
      { ...silent, signal: controller.signal }
    );
    await started.promise;
    controller.abort("operator interrupt");
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(result.steps).toMatchObject([{ id: "children", status: "cancelled" }]);
  });

  it("rejects an unknown policy when the step is created", () => {
    const { forEachPipeline } = createSteps();
    expect(() =>
      forEachPipeline("children", {
        pipeline: failingChild(),
        items: () => ["a"],
        key: (item) => item,
        // @ts-expect-error -- untyped callers can pass any string.
        onItemFailure: "ignore",
        mapOptions: (item) => ({ itemId: item }),
      })
    ).toThrow("forEachPipeline onItemFailure must be one of fail, stop, collect, got ignore");
  });

  it("infers settled output only under collect", () => {
    interface ParentOptions {
      batch: string;
    }
    const { forEachPipeline } = createSteps<ParentOptions>();
    const base = {
      pipeline: failingChild(),
      items: () => ["a"],
      key: (item: string) => item,
      mapOptions: (item: string) => ({ itemId: item }),
    };
    expectTypeOf(forEachPipeline("plain", base)).toEqualTypeOf<
      Step<"plain", readonly (string | undefined)[], ParentOptions>
    >();
    expectTypeOf(forEachPipeline("stopped", { ...base, onItemFailure: "stop" })).toEqualTypeOf<
      Step<"stopped", readonly (string | undefined)[], ParentOptions>
    >();
    expectTypeOf(forEachPipeline("collected", { ...base, onItemFailure: "collect" })).toEqualTypeOf<
      Step<"collected", readonly ForEachSettledItem<string | undefined>[], ParentOptions>
    >();
    expectTypeOf(
      forEachPipeline("mapped", {
        ...base,
        onItemFailure: "collect",
        mapResult: (value) => String(value).length,
      })
    ).toEqualTypeOf<Step<"mapped", readonly ForEachSettledItem<number>[], ParentOptions>>();
    expectTypeOf(
      forEachPipeline("skippable", {
        ...base,
        onItemFailure: "collect",
        skip: () => ({ reason: "none", value: [] }),
      })
    ).toEqualTypeOf<
      Step<"skippable", readonly ForEachSettledItem<string | undefined>[], ParentOptions>
    >();
  });

  it("keeps the default-policy output when the policy may be undefined", () => {
    interface ParentOptions {
      policy?: "collect";
    }
    const { forEachPipeline } = createSteps<ParentOptions>();
    const policy = undefined as "collect" | undefined;
    const base = {
      pipeline: failingChild(),
      items: () => ["a"],
      key: (item: string) => item,
      mapOptions: (item: string) => ({ itemId: item }),
    };
    type Either = string | undefined | ForEachSettledItem<string | undefined>;
    expectTypeOf(forEachPipeline("optional", { ...base, onItemFailure: policy })).toEqualTypeOf<
      Step<"optional", readonly Either[], ParentOptions>
    >();
    const reusable: typeof base & { onItemFailure?: "collect" } = base;
    expectTypeOf(forEachPipeline("reusable", reusable)).toEqualTypeOf<
      Step<"reusable", readonly Either[], ParentOptions>
    >();
    expectTypeOf(
      forEachPipeline("explicit-undefined", { ...base, onItemFailure: undefined })
    ).toEqualTypeOf<Step<"explicit-undefined", readonly (string | undefined)[], ParentOptions>>();
  });
});
