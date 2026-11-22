import { deserialize, serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineStepOutputObserver } from "./pipeline.js";
import { defer } from "./child-pipeline.test-support.js";
import { retainedJournal } from "./execution-journal.test-support.js";
import { standardSchema } from "./pipeline.test-support.js";

it("acknowledges raw output observation before journal completion and restores without observing again", async () => {
  const records = new Map<string, Buffer>();
  const captured = new Map<string, Uint8Array>();
  const entered = defer();
  const release = defer();
  const effect = vi.fn(() => "hello");
  const next = vi.fn((value: number) => value + 1);
  const validate = vi.fn((value: unknown) =>
    typeof value === "string"
      ? { value: value.length }
      : { issues: [{ message: "Expected raw text" }] }
  );
  function pipeline() {
    const { step } = createSteps();
    const first = step("first", {
      run: effect,
      outputSchema: standardSchema<string, number>(validate),
    });
    const second = step("second", { dependsOn: [first], run: ({ first }) => next(first) });
    return definePipeline({
      id: "observed-journal",
      implementationVersion: "1",
      steps: [first, second],
    });
  }
  const observer: PipelineStepOutputObserver = {
    encode: vi.fn((value) => serialize(value)),
    write: vi.fn(async (record) => {
      if (record.stepId === "first") {
        entered.resolve();
        await release.promise;
      }
      captured.set(record.stepId, record.encodedValue);
    }),
  };
  const host = retainedJournal(records);
  const complete = vi.spyOn(host, "complete");
  const controls = { outputObserver: observer, suppliedOutputs: new Map() };
  const running = pipeline().run({}, controls, { executionJournal: host });
  await entered.promise;
  expect(complete).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
  release.resolve();
  expect(await running).toMatchObject({ status: "completed", value: 6 });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(deserialize(captured.get("first")!)).toBe("hello");

  expect(
    await pipeline().runOrThrow({}, controls, { executionJournal: retainedJournal(records) })
  ).toBe(6);
  expect(effect).toHaveBeenCalledOnce();
  expect(validate).toHaveBeenCalledOnce();
  expect(next).toHaveBeenCalledOnce();
  expect(observer.encode).toHaveBeenCalledTimes(2);
  expect(observer.write).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "rejects supplies before bypassing journal recovery (completed=%s)",
  async (completed) => {
    const records = new Map<string, Buffer>();
    const effect = vi.fn(() => 1);
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "supply-authority",
      implementationVersion: "1",
      steps: [step("work", { run: effect })],
    });
    if (completed)
      await pipeline.runOrThrow({}, {}, { executionJournal: retainedJournal(records) });
    const host = retainedJournal(records);
    const bind = vi.spyOn(host, "bind");
    const begin = vi.spyOn(host, "begin");
    const finish = vi.spyOn(host, "complete");
    const result = await pipeline.run(
      {},
      { suppliedOutputs: new Map([["work", 99]]) },
      { executionJournal: host }
    );
    expect(result.status).toBe("failed");
    expect(result.errors[0].sourceCode).toBe("TUBELESS_JOURNAL_SUPPLIED_OUTPUTS_UNSUPPORTED");
    expect(effect).toHaveBeenCalledTimes(completed ? 1 : 0);
    expect(bind).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  }
);

it.each(["encode", "write"] as const)(
  "does not acknowledge journal completion after observer %s fails",
  async (phase) => {
    const records = new Map<string, Buffer>();
    const effect = vi.fn(() => 1);
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "observer-failure",
      implementationVersion: "1",
      steps: [step("work", { run: effect })],
    });
    const host = retainedJournal(records);
    const complete = vi.spyOn(host, "complete");
    const result = await pipeline.run(
      {},
      {
        outputObserver: {
          encode(value) {
            if (phase === "encode") throw new Error("Encoding failed");
            return serialize(value);
          },
          write() {
            if (phase === "write") throw new Error("Persistence failed");
          },
        },
      },
      { executionJournal: host }
    );
    expect(result.status).toBe("failed");
    expect(complete).not.toHaveBeenCalled();
    const recreated = await pipeline.run({}, {}, { executionJournal: retainedJournal(records) });
    expect(recreated.errors[0].sourceCode).toBe("TUBELESS_JOURNAL_OUTCOME_UNKNOWN");
    expect(effect).toHaveBeenCalledOnce();
  }
);

it("previews supplied outputs without activating the journal or output observer", async () => {
  const records = new Map<string, Buffer>();
  const effect = vi.fn(() => 1);
  const encode = vi.fn((value: unknown) => serialize(value));
  const write = vi.fn();
  const { step } = createSteps();
  const pipeline = definePipeline({
    id: "preview-supply",
    implementationVersion: "1",
    steps: [step("work", { run: effect, dryRun: "skip" })],
  });
  expect(
    await pipeline.runOrThrow(
      {},
      {
        dryRun: true,
        suppliedOutputs: new Map([["work", 42]]),
        outputObserver: { encode, write },
      },
      { executionJournal: retainedJournal(records) }
    )
  ).toBe(42);
  expect(effect).not.toHaveBeenCalled();
  expect(encode).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(records.size).toBe(0);
});
