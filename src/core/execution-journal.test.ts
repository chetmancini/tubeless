import { describe, expect, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  PipelineExecutionError,
  type PipelineExecutionJournal,
  type StandardSchemaV1,
} from "./pipeline.js";
import { createPipelineTestRuntime, overrideStep } from "../testing/testing.js";
import { retainedJournal } from "./execution-journal.test-support.js";
import { JOURNAL_OUTCOME_UNKNOWN } from "../tracing/tracing-constants.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";

const context = (executionJournal: PipelineExecutionJournal, signal?: AbortSignal) => ({
  executionJournal,
  signal,
  log: { log() {}, warn() {}, error() {} },
});
const version = { implementationVersion: "1" };
function schema<I, O>(validate: (input: unknown) => { value: O }): StandardSchemaV1<I, O> {
  return { "~standard": { version: 1, vendor: "journal-test", validate } };
}

it("recreates an executor and adapter, restoring validated undefined without rerunning transforms, cache or effects", async () => {
  const records = new Map<string, Buffer>();
  const effect = vi.fn(() => "raw");
  const transform = vi.fn(() => ({ value: undefined }));
  const cacheGet = vi.fn(async () => undefined);
  const artifacts = vi.fn();
  function pipeline() {
    const { step } = createSteps();
    const work = step("work", {
      run: effect,
      outputSchema: schema<string, undefined>(transform),
      cache: {
        version: "1",
        store: { get: cacheGet, set: async () => {} },
        codec: { encode: () => new Uint8Array([1]), decode: () => undefined },
      },
    });
    return definePipeline({ id: "restore", ...version, steps: [work] });
  }
  const first = await pipeline().run({}, {}, context(retainedJournal(records)));
  const second = await pipeline().run(
    {},
    {},
    {
      ...context(retainedJournal(records)),
      tracing: {
        exporter: {
          export: (event) => {
            if (event.name === "step.artifact") artifacts(event);
          },
        },
      },
    }
  );
  expect(first.status).toBe("completed");
  expect(second).toMatchObject({ status: "completed", finalized: true, value: undefined });
  expect(second.runId).not.toBe(first.runId);
  expect(effect).toHaveBeenCalledTimes(1);
  expect(transform).toHaveBeenCalledTimes(1);
  expect(cacheGet).toHaveBeenCalledTimes(1);
  expect(artifacts).not.toHaveBeenCalled();
});

it.each([false, true])(
  "settles a lost completion reply from durable state (committed=%s)",
  async (committed) => {
    const records = new Map<string, Buffer>();
    const effect = vi.fn(() => ({ count: 1 }));
    const { step } = createSteps();
    const work = step("work", { run: effect });
    const pipeline = definePipeline({ id: "lost-reply", ...version, steps: [work] });
    const host = retainedJournal(records);
    const failure = Object.assign(new Error("Lost acknowledgement"), { code: "HOST_WRITE" });
    const first = await pipeline.run(
      {},
      {},
      context({
        ...host,
        complete: async (path, value) => {
          if (committed) await host.complete(path, value);
          throw failure;
        },
      })
    );
    expect(first.errors[0]).toMatchObject({
      sourceCode: "HOST_WRITE",
      cause: { message: failure.message },
    });
    const second = await pipeline.run({}, {}, context(retainedJournal(records)));
    expect(second.status).toBe(committed ? "completed" : "failed");
    if (!committed) expect(second.errors[0]?.sourceCode).toBe("TUBELESS_JOURNAL_OUTCOME_UNKNOWN");
    expect(effect).toHaveBeenCalledTimes(1);
  }
);

it("blocks an incomplete intent before executing an effect, even when begin's reply was lost", async () => {
  const records = new Map<string, Buffer>();
  const host = retainedJournal(records);
  const run = vi.fn(() => 1);
  const { step } = createSteps();
  const pipeline = definePipeline({ id: "intent", ...version, steps: [step("work", { run })] });
  await pipeline.run(
    {},
    {},
    context({
      ...host,
      begin: async (...args) => {
        await host.begin(...args);
        throw new Error("lost intent reply");
      },
    })
  );
  const result = await pipeline.run({}, {}, context(retainedJournal(records)));
  expect(result.errors[0]?.sourceCode).toBe("TUBELESS_JOURNAL_OUTCOME_UNKNOWN");
  expect(run).not.toHaveBeenCalled();
});

it("summarizes an uncertain effect even when an earlier step also failed", async () => {
  const { step } = createSteps();
  let startSibling!: () => void;
  const siblingStarted = new Promise<void>((resolve) => {
    startSibling = resolve;
  });
  const uncertainEffect = vi.fn();
  const pipeline = definePipeline({
    id: "concurrent-errors",
    ...version,
    steps: [
      step("fail", {
        run() {
          startSibling();
          throw new Error("Sibling failed.");
        },
      }),
      step("uncertain", { run: uncertainEffect }),
    ],
  });
  const host = retainedJournal();
  const events: PipelineTraceEvent[] = [];
  const result = await pipeline.run(
    {},
    { maxConcurrency: 2 },
    {
      ...context({
        ...host,
        async begin(path, ...args) {
          if (path.at(-1) !== "uncertain") return host.begin(path, ...args);
          await siblingStarted;
          return { status: "incomplete" };
        },
      }),
      tracing: { exporter: { export: (event) => void events.push(event) } },
    }
  );
  expect(result.errors.map(({ stepId }) => stepId)).toEqual(["fail", "uncertain"]);
  expect(events.at(-1)).toMatchObject({
    name: "pipeline.completed",
    error: { sourceCode: JOURNAL_OUTCOME_UNKNOWN },
  });
  expect(uncertainEffect).not.toHaveBeenCalled();
});

it("retains outputs independently of later application mutation", async () => {
  const records = new Map<string, Buffer>();
  const { step } = createSteps();
  const value = { count: 1, optional: undefined, sparse: new Array(2) };
  const pipeline = definePipeline({
    id: "snapshot",
    ...version,
    steps: [step("work", { run: () => value })],
  });
  await pipeline.run({}, {}, context(retainedJournal(records)));
  value.count = 2;
  const restored = await pipeline.runOrThrow({}, {}, context(retainedJournal(records)));
  expect(restored!.count).toBe(1);
  expect(Object.hasOwn(restored!, "optional")).toBe(true);
  expect(Object.hasOwn(restored!.sparse, 0)).toBe(false);
  restored!.count = 3;
  expect((await pipeline.runOrThrow({}, {}, context(retainedJournal(records))))!.count).toBe(1);
});

describe("compatibility", () => {
  it.each(["input", "definition", "controls", "cwd", "validated"])(
    "rejects changed %s before another handler",
    async (change) => {
      const records = new Map<string, Buffer>();
      const work = vi.fn((_inputs, ctx) => ctx.options.value);
      let offset = 0;
      function build(implementationVersion = "1") {
        const { step } = createSteps(
          schema<{ value: number }, { value: number }>((input) => ({
            value: { value: (input as { value: number }).value + offset },
          }))
        );
        return definePipeline({
          id: "compatible",
          implementationVersion,
          steps: [step("work", { run: work })],
        });
      }
      expect((await build().run({ value: 1 }, {}, context(retainedJournal(records)))).status).toBe(
        "completed"
      );
      if (change === "validated") offset = 1;
      const result = await build(change === "definition" ? "2" : "1").run(
        { value: change === "input" ? 2 : 1 },
        change === "controls" ? { maxConcurrency: 2 } : {},
        { ...context(retainedJournal(records)), ...(change === "cwd" ? { cwd: "/other" } : {}) }
      );
      expect(result.errors[0]?.sourceCode).toBe("HOST_CONFLICT");
      expect(work).toHaveBeenCalledTimes(1);
    }
  );
  it("requires a version only when recovery is enabled", async () => {
    const { step } = createSteps();
    const run = vi.fn(() => 1);
    const pipeline = definePipeline({ id: "version", steps: [step("work", { run })] });
    expect((await pipeline.run({}, {}, context(retainedJournal()))).errors[0]?.sourceCode).toBe(
      "TUBELESS_JOURNAL_IMPLEMENTATION_VERSION_REQUIRED"
    );
    expect(run).not.toHaveBeenCalled();
    expect(await pipeline.runOrThrow()).toBe(1);
  });
});

it.each(["bypass", "recompute"] as const)(
  "distinguishes an absent cache override from explicit use with step policy %s",
  async (policy) => {
    for (const [initial, changed] of [
      [undefined, "use"],
      ["use", undefined],
    ] as const) {
      const records = new Map<string, Buffer>();
      const effect = vi.fn(() => 1);
      function pipeline() {
        const { step } = createSteps();
        return definePipeline({
          id: "cache-controls",
          ...version,
          steps: [
            step("work", {
              run: effect,
              cache: {
                version: "1",
                policy,
                store: { get: async () => undefined, set: async () => {} },
                codec: { encode: () => new Uint8Array([1]), decode: () => 1 },
              },
            }),
          ],
        });
      }
      expect(
        await pipeline().runOrThrow({}, { cache: initial }, context(retainedJournal(records)))
      ).toBe(1);
      const recovered = await pipeline().run(
        {},
        { cache: changed },
        context(retainedJournal(records))
      );
      expect(recovered.status).toBe("failed");
      expect(recovered.errors[0]?.sourceCode).toBe("HOST_CONFLICT");
      expect(
        await pipeline().runOrThrow({}, { cache: initial }, context(retainedJournal(records)))
      ).toBe(1);
      expect(effect).toHaveBeenCalledTimes(1);
    }
  }
);

it("rejects a structural definition change even with the same implementation version", async () => {
  const records = new Map<string, Buffer>();
  const { step } = createSteps();
  const effect = vi.fn(() => 1);
  const first = step("first", { run: effect });
  const changed = step("changed", { run: effect });
  await definePipeline({ id: "structure", ...version, steps: [first] }).run(
    {},
    {},
    context(retainedJournal(records))
  );
  const result = await definePipeline({ id: "structure", ...version, steps: [first, changed] }).run(
    {},
    {},
    context(retainedJournal(records))
  );
  expect(result.errors[0]?.sourceCode).toBe("HOST_CONFLICT");
  expect(effect).toHaveBeenCalledTimes(1);
});

it("recomputes skips and finalization but preserves ordinary step completion", async () => {
  const records = new Map<string, Buffer>();
  const { step } = createSteps();
  const effect = vi.fn(() => 1);
  const skip = vi.fn(() => false as const);
  const finalize = vi.fn((outputs) => outputs.work + 1);
  const pipeline = definePipeline({
    id: "callbacks",
    ...version,
    steps: [step("work", { run: effect, skip })],
    finalize,
  });
  expect(await pipeline.runOrThrow({}, {}, context(retainedJournal(records)))).toBe(2);
  expect(await pipeline.runOrThrow({}, {}, context(retainedJournal(records)))).toBe(2);
  expect(effect).toHaveBeenCalledTimes(1);
  expect(skip).toHaveBeenCalledTimes(2);
  expect(finalize).toHaveBeenCalledTimes(2);
});

it("does not repeat an effect whose output validation failed before completion", async () => {
  const records = new Map<string, Buffer>();
  const { step } = createSteps();
  const effect = vi.fn(() => 1);
  const outputSchema: StandardSchemaV1<number> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => ({ issues: [{ message: "invalid output" }] }),
    },
  };
  const pipeline = definePipeline({
    id: "invalid-output",
    ...version,
    steps: [step("work", { run: effect, outputSchema })],
  });
  expect((await pipeline.run({}, {}, context(retainedJournal(records)))).errors[0]?.kind).toBe(
    "validation"
  );
  expect(
    (await pipeline.run({}, {}, context(retainedJournal(records)))).errors[0]?.sourceCode
  ).toBe("TUBELESS_JOURNAL_OUTCOME_UNKNOWN");
  expect(effect).toHaveBeenCalledTimes(1);
});

it.each(["bind", "begin", "complete"] as const)(
  "makes %s failure fatal under continueOnError and retains the original cause",
  async (method) => {
    const { step } = createSteps();
    const effect = vi.fn(() => 1);
    const later = vi.fn(() => 2);
    const finalize = vi.fn(() => 0);
    const pipeline = definePipeline({
      id: "failure",
      ...version,
      steps: [step("first", { run: effect }), step("later", { run: later })],
      finalize,
    });
    const failure = Object.assign(new Error("fenced out"), {
      code: "HOST_FENCE",
      cause: new Error("owner changed"),
    });
    const host = {
      ...retainedJournal(),
      [method]: async () => {
        throw failure;
      },
    };
    const result = await pipeline.run({}, { continueOnError: true }, context(host));
    expect(result.status).toBe("failed");
    expect(result.errors[0]).toMatchObject({
      sourceCode: "HOST_FENCE",
      cause: { message: "fenced out", cause: { message: "owner changed" } },
    });
    expect(effect).toHaveBeenCalledTimes(method === "complete" ? 1 : 0);
    expect(later).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    await expect(pipeline.runOrThrow({}, {}, context(host))).rejects.toBeInstanceOf(
      PipelineExecutionError
    );
  }
);

it("rejects malformed responses instead of executing the handler", async () => {
  const { step } = createSteps();
  const effect = vi.fn();
  const pipeline = definePipeline({
    id: "malformed",
    ...version,
    steps: [step("work", { run: effect })],
  });
  const host = {
    ...retainedJournal(),
    begin: async () => ({ status: "completed" }),
  } as unknown as PipelineExecutionJournal;
  expect((await pipeline.run({}, {}, context(host))).errors[0]?.sourceCode).toBe(
    "TUBELESS_JOURNAL_INVALID_RESPONSE"
  );
  expect(effect).not.toHaveBeenCalled();
});

it("isolates planning, invalid plans, dry runs, and testing overrides from the host", async () => {
  const host: PipelineExecutionJournal = {
    key: "job",
    bind: vi.fn(),
    begin: vi.fn(),
    complete: vi.fn(),
    agentStore: { acquire: vi.fn() },
  };
  const { step } = createSteps();
  const effect = step("work", { dryRun: "skip", run: () => 1 });
  const pipeline = definePipeline({ id: "preview", ...version, steps: [effect] });
  pipeline.plan();
  await pipeline.run({}, { maxConcurrency: 0 }, context(host));
  await pipeline.run({}, { dryRun: true }, context(host));
  const runtime = createPipelineTestRuntime();
  runtime.context.executionJournal = host;
  expect((await runtime.run(pipeline, {}, { overrides: [overrideStep(effect, 5)] })).value).toBe(5);
  for (const method of [host.bind, host.begin, host.complete, host.agentStore!.acquire])
    expect(method).not.toHaveBeenCalled();
});
