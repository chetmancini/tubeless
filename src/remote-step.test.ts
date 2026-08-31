import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  defaultPipelineContext,
  definePipeline,
  type RemoteStepAdapter,
  type StandardSchemaV1,
  type Step,
} from "./pipeline";
import type { PipelineTraceEvent } from "./tracing.js";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"],
  vendor = "test"
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor, version: 1 } };
}

const resultSchema = standardSchema<{ ok: true }, { ok: true }>((value) => {
  if (
    value &&
    typeof value === "object" &&
    "ok" in value &&
    (value as { ok: unknown }).ok === true
  ) {
    return { value: value as { ok: true } };
  }
  return { issues: [{ message: "expected { ok: true }" }] };
});

function testAdapter<TPayload, TResult>(
  invoke: RemoteStepAdapter<object, TPayload, TResult>["invoke"],
  target = "enrich-v2"
): RemoteStepAdapter<object, TPayload, TResult> {
  return { engine: "test", target, invoke };
}

describe("fromRemote", () => {
  it("copies adapter engine and target onto the parent plan without flattening", () => {
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async () => ({ ok: true })),
      mapInput: () => ({ rows: [] }),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-plan",
      steps: [enrich],
      finalize: () => undefined,
    });

    const plan = pipeline.plan({});
    expect(plan.steps[0]?.remote).toEqual({ engine: "test", target: "enrich-v2" });
    expect(plan.steps[0]?.nestedPipeline).toBeUndefined();
    expect(plan.steps[0]?.dryRun).toBe("run");
  });

  it("contacts the adapter during a pipeline dry run when dryRun is omitted", async () => {
    const invoke = vi.fn(async (_payload: { dryRun: boolean }, context) => {
      expect(context.dryRun).toBe(true);
      return { ok: true as const };
    });
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(invoke),
      mapInput: (_inputs, ctx) => ({ dryRun: ctx.dryRun }),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-rehearse",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({ dryRun: true });
    expect(result.status).toBe("completed");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toEqual({ dryRun: true });
  });

  it("does not call invoke when dryRun is skip", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const }));
    const step = createSteps();
    const charge = step.fromRemote("charge", {
      adapter: testAdapter(invoke, "chargeOrder"),
      mapInput: () => ({ orderId: "1" }),
      outputSchema: resultSchema,
      dryRun: "skip",
    });
    const pipeline = definePipeline({
      id: "remote-skip",
      steps: [charge],
      finalize: () => undefined,
    });

    const result = await pipeline.run({ dryRun: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.steps[0]).toMatchObject({ status: "skipped", reason: "dry-run" });
    expect(pipeline.plan({ dryRun: true }).steps[0]).toMatchObject({
      dryRun: "skip",
      remote: { engine: "test", target: "chargeOrder" },
    });
  });

  it("does not call invoke when a preview handler is present", async () => {
    const invoke = vi.fn(async () => ({ ok: true as const }));
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(invoke),
      mapInput: () => ({ rows: [] }),
      outputSchema: resultSchema,
      dryRun: () => ({ ok: true as const }),
    });
    const pipeline = definePipeline({
      id: "remote-preview",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({ dryRun: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(pipeline.plan({ dryRun: true }).steps[0]?.dryRun).toBe("custom");
  });

  it("classifies adapter throws as ordinary step failures", async () => {
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async () => {
        throw new Error("lambda timeout");
      }),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-throw",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      message: "lambda timeout",
      phase: "execution",
      stepId: "enrich",
    });
  });

  it("keeps a thrown cause and code on TUBELESS_STEP_FAILED", async () => {
    const remote = Object.assign(new Error("activity failed"), { code: "ACTIVITY_FAILED" });
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async () => {
        throw Object.assign(new Error("workflow failed"), {
          cause: remote,
          code: "WORKFLOW_FAILED",
        });
      }),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-cause",
      steps: [enrich],
      finalize: () => undefined,
    });

    const result = await pipeline.run({});
    expect(result.errors[0]).toMatchObject({
      cause: {
        message: "activity failed",
        sourceCode: "ACTIVITY_FAILED",
      },
      code: "TUBELESS_STEP_FAILED",
      sourceCode: "WORKFLOW_FAILED",
      stepId: "enrich",
    });
  });

  it("forwards context.log from invoke to the injected logger and pipeline.log", async () => {
    const log = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    const events: PipelineTraceEvent[] = [];
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(async (_payload, context) => {
        context.log.log("remote line", 12);
        return { ok: true as const };
      }),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-log",
      steps: [enrich],
      finalize: () => undefined,
    });

    await pipeline.run(
      {},
      {
        ...defaultPipelineContext(),
        log,
        tracing: {
          exporter: { export: (event) => events.push(event), flush: async () => undefined },
        },
      }
    );

    expect(log.log).toHaveBeenCalledWith("remote line", 12);
    expect(events.some((event) => event.name === "pipeline.log" && event.stepId === "enrich")).toBe(
      true
    );
  });

  it("classifies abort during invoke as cancellation", async () => {
    const controller = new AbortController();
    const step = createSteps();
    const enrich = step.fromRemote("enrich", {
      adapter: testAdapter(
        (_payload, context) =>
          new Promise((_resolve, reject) => {
            const fail = () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (context.signal.aborted) fail();
            else context.signal.addEventListener("abort", fail, { once: true });
          })
      ),
      mapInput: () => ({}),
      outputSchema: resultSchema,
    });
    const pipeline = definePipeline({
      id: "remote-abort",
      steps: [enrich],
      finalize: () => undefined,
    });

    const pending = pipeline.run({}, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.errors[0]).toMatchObject({
      code: "TUBELESS_RUN_CANCELLED",
      kind: "cancellation",
      stepId: "enrich",
    });
  });

  it("requires outputSchema and keeps skip / dryRun tokens off the authoring surface", () => {
    const step = createSteps();
    const adapter = testAdapter(async (payload: { n: number }) => payload);
    const schema = standardSchema<{ n: number }, { n: number }>((value) => ({
      value: value as { n: number },
    }));

    const remote = step.fromRemote("enrich", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
    });
    expectTypeOf(remote).toEqualTypeOf<
      Step<"enrich", { n: number }, object, object, { n: number }>
    >();

    const skippable = step.fromRemote.skippable("maybe-enrich", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
      skip: () => "disabled",
    });
    expectTypeOf(skippable).toEqualTypeOf<
      Step<"maybe-enrich", { n: number } | undefined, object, object, { n: number }>
    >();

    const dependent = step("after", {
      dependsOn: [skippable],
      run: (inputs) => {
        expectTypeOf(inputs["maybe-enrich"]).toEqualTypeOf<{ n: number } | undefined>();
        return inputs["maybe-enrich"]?.n ?? 0;
      },
    });
    expectTypeOf(dependent).toEqualTypeOf<Step<"after", number, object>>();

    step.fromRemote("missing-schema", {
      adapter,
      mapInput: () => ({ n: 1 }),
      // @ts-expect-error outputSchema is required
    });

    step.fromRemote("skip-requires-skippable", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
      // @ts-expect-error Policy skip belongs on fromRemote.skippable.
      skip: () => "disabled",
    });

    step.fromRemote("dry-run-run-is-invalid", {
      adapter,
      mapInput: () => ({ n: 1 }),
      outputSchema: schema,
      // @ts-expect-error Authors do not write dryRun: "run".
      dryRun: "run",
    });
  });
});
