import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, PipelineExecutionError } from "./pipeline.js";

function fixture(
  count: number,
  fail: (index: number) => void,
  key = (index: number) => `item-${index}`,
  phase: "options" | "child" | "result" = "options"
) {
  const childStep = createSteps<{ index: number }>();
  const work = childStep("work", {
    run: (_inputs, context) => {
      if (phase === "child") fail(context.options.index);
      return context.options.index;
    },
  });
  const child = definePipeline({ id: "child", steps: [work], finalize: (outputs) => outputs.work });
  const step = createSteps();
  const children = step.forEachPipeline("children", {
    pipeline: child,
    items: () => Array.from({ length: count }, (_, index) => index),
    key,
    concurrency: 3,
    mapOptions: (index) => {
      if (phase === "options") fail(index);
      return { index };
    },
    mapResult: (value, _run, _item, index) => {
      if (phase === "result") fail(index);
      return value;
    },
  });
  const downstream = step("downstream", { dependsOn: [children], run: () => true });
  return definePipeline({ id: "parent", steps: [children, downstream], finalize: () => true });
}

describe("fan-out diagnostics", () => {
  it("retains keyed failures in input order and the original primary cause", async () => {
    const first = Object.assign(new Error("first"), { code: "RETRY" });
    const second = new Error("second");
    const pipeline = fixture(4, (index) => {
      if (index === 1) throw first;
      if (index === 3) throw second;
    });
    const run = await pipeline.run({}, { continueOnError: true });
    expect(run.status).toBe("failed");
    expect(run.steps[1]).toMatchObject({ status: "skipped", reason: "unmet-dependency" });
    expect(run.errors[0]).toMatchObject({
      code: "TUBELESS_CHILD_FAILED",
      fanOut: {
        failureCount: 2,
        omittedFailureCount: 0,
        failures: [
          {
            index: 1,
            key: "item-1",
            keyTruncated: false,
            cancelled: false,
            error: { message: "first", sourceCode: "RETRY" },
          },
          {
            index: 3,
            key: "item-3",
            keyTruncated: false,
            cancelled: false,
            error: { message: "second" },
          },
        ],
      },
    });
    expect(JSON.parse(JSON.stringify(run.errors[0])).fanOut).toEqual(run.errors[0]?.fanOut);
    try {
      await pipeline.runOrThrow({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineExecutionError);
      expect((error as Error).cause).toMatchObject({ cause: first });
    }
  });

  it("bounds entries, keys, messages and circular causes with explicit omission counts", async () => {
    const error = new Error("x".repeat(2000));
    error.cause = error;
    const pipeline = fixture(
      40,
      () => {
        throw error;
      },
      (index) => `${index}-${"k".repeat(2000)}`
    );
    const run = await pipeline.run({});
    const diagnostics = run.errors[0]!.fanOut!;
    expect(diagnostics.failureCount).toBe(40);
    expect(diagnostics.omittedFailureCount).toBe(8);
    expect(diagnostics.failures).toHaveLength(32);
    expect(diagnostics.failures[0]).toMatchObject({
      index: 0,
      keyTruncated: true,
      error: { cause: { message: "Circular cause" } },
    });
    expect(diagnostics.failures[0]!.key).toHaveLength(1024);
    expect(diagnostics.failures[0]!.error.message).toHaveLength(1024);
  });

  it("keeps cancellation classification per item without changing parent failure precedence", async () => {
    const abort = Object.assign(new Error("stop"), { name: "AbortError" });
    const cancelled = await fixture(2, () => {
      throw abort;
    }).run({});
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errors[0]!.fanOut!.failures.every((failure) => failure.cancelled)).toBe(true);
    const mixed = await fixture(2, (index) => {
      throw index === 0 ? abort : new Error("failed");
    }).run({});
    expect(mixed.status).toBe("failed");
    expect(mixed.errors[0]!.fanOut!.failures.map((failure) => failure.cancelled)).toEqual([
      true,
      false,
    ]);
  });

  it.each(["child", "result"] as const)(
    "captures %s failures without retaining run objects",
    async (phase) => {
      const run = await fixture(
        1,
        () => {
          throw Object.assign(new Error("failed"), { code: "RETRY" });
        },
        undefined,
        phase
      ).run({});
      const failure = run.errors[0]!.fanOut!.failures[0]!;
      expect(failure).toMatchObject({ key: "item-0", index: 0, cancelled: false });
      expect(JSON.stringify(failure)).toContain("RETRY");
      expect(JSON.stringify(failure)).not.toContain('"steps"');
    }
  );

  it("separates scheduler cancellation from item failures and unstarted items", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("stop"), { name: "AbortError" });
    const run = await fixture(10, () => {
      controller.abort(reason);
      throw reason;
    }).run({}, {}, { signal: controller.signal });
    expect(run.status).toBe("cancelled");
    const diagnostics = run.errors[0]!.fanOut!;
    expect(diagnostics.schedulerError).toMatchObject({ message: "stop" });
    expect(diagnostics.failureCount).toBeLessThan(10);
    expect(diagnostics.failures).toHaveLength(diagnostics.failureCount);
  });

  it("does not attach item diagnostics to duplicate-key setup failures", async () => {
    const run = await fixture(
      2,
      () => {},
      () => "same"
    ).run({});
    expect(run.errors[0]!.fanOut).toBeUndefined();
  });
});
