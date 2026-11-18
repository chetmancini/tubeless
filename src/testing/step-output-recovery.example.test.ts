import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createSteps, definePipeline, type PipelineRun, type StandardSchemaV1 } from "tubeless";
import {
  createRecoveryPipeline,
  RecoveryPipeline,
  recoveryInputIdentity,
  runRecoveryExample,
} from "../../examples/step-output-recovery.js";
import { openRecoveryStore } from "../../examples/recovery/file-output-store.js";

const execute = promisify(execFile);
const worker = fileURLToPath(new URL("./step-output-recovery.test-support.ts", import.meta.url));
async function invokeWorker(
  path: string,
  mode: string
): Promise<{ run: PipelineRun<number>; calls: string[] }> {
  const { stdout } = await execute("bun", [worker, path, mode], { timeout: 10_000 });
  return JSON.parse(stdout) as { run: PipelineRun<number>; calls: string[] };
}

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "tubeless-recovery-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const input = { seed: 10 };
const execution = { executionId: "job-42", inputIdentity: recoveryInputIdentity(input) };
const increment = async (_stepId: string, value: number) => String(value + 1);

it("runs the public recipe across fresh pipeline and host instances", async () => {
  const {
    directory: path,
    failed,
    resumed,
    firstCalls,
    resumedCalls,
  } = await runRecoveryExample(await directory());
  expect(failed).toMatchObject({ status: "failed", finalized: false });
  expect(firstCalls).toEqual(RecoveryPipeline.stepIds.slice(0, 7));
  expect(resumed).toMatchObject({
    status: "completed",
    finalized: true,
    value: await RecoveryPipeline.runOrThrow(input),
  });
  expect(resumedCalls).toEqual(["step-7", "step-8", "step-9"]);
  expect(resumed.steps.slice(0, 6).every((step) => step.outputSource === "supplied")).toBe(true);
  expect((await readdir(path)).filter((file) => file.endsWith(".json"))).toHaveLength(9);
});

it("recovers after terminating the first host process, with only six files retained", async () => {
  const path = await directory();
  const first = await invokeWorker(path, "fail");
  expect(first.run.status).toBe("failed");
  expect(await readdir(path)).toHaveLength(6);
  const restored = await invokeWorker(path, "resume");
  const baseline = await invokeWorker(path, "baseline");
  expect(restored.run).toMatchObject({
    status: "completed",
    value: baseline.run.value,
    finalized: true,
  });
  expect(restored.calls).toEqual(["step-7", "step-8", "step-9"]);
  expect(baseline.calls).toEqual(RecoveryPipeline.stepIds);
  expect(restored.run.runId).not.toBe(first.run.runId);
}, 20_000);

it("restores only a supplied intermediate when upstream steps are excluded", async () => {
  const path = await directory();
  const first = createRecoveryPipeline(async (stepId, value) => {
    if (stepId === "step-7") throw new Error("stop");
    return String(value + 1);
  });
  const store = await openRecoveryStore(path, first, execution);
  await first.run(input, { outputObserver: store.observer });
  const calls: string[] = [];
  const fresh = createRecoveryPipeline(async (stepId, value) => {
    calls.push(stepId);
    return String(value + 1);
  });
  const freshStore = await openRecoveryStore(path, fresh, execution);
  const restored = await freshStore.load();
  const write = vi.fn(freshStore.observer.write);
  const controls = {
    stepIds: ["step-6", "step-7", "step-8", "step-9"] as const,
    suppliedOutputs: new Map<"step-6", unknown>([["step-6", restored.get("step-6")]]),
    outputObserver: { ...freshStore.observer, write },
  };
  expect(
    fresh
      .plan(controls)
      .steps.slice(5)
      .every((step) => !step.skipReason)
  ).toBe(true);
  expect(await fresh.runOrThrow(input, controls)).toBe(19);
  expect(calls).toEqual(["step-7", "step-8", "step-9"]);
  expect(write.mock.calls.map(([record]) => record.stepId)).toEqual(calls);
});

it.each([
  "executionId",
  "inputIdentity",
  "pipelineId",
  "identityVersion",
  "definitionId",
  "structuralFingerprint",
  "implementationVersion",
  "codecIdentity",
  "formatVersion",
])("rejects an incompatible saved %s before decoding or running business work", async (field) => {
  const path = await directory();
  const first = await openRecoveryStore(path, RecoveryPipeline, execution);
  await RecoveryPipeline.run(input, { stepIds: ["step-1"], outputObserver: first.observer });
  const [file] = await readdir(path);
  const saved = JSON.parse(await readFile(join(path, file), "utf8")) as {
    scope: Record<string, unknown>;
    encodedValue: string;
  };
  saved.scope[field] = "incompatible";
  saved.encodedValue = "invalid payload that must not be decoded";
  await writeFile(join(path, file), JSON.stringify(saved));
  const perform = vi.fn(increment);
  const fresh = createRecoveryPipeline(perform);
  const store = await openRecoveryStore(path, fresh, execution);
  await expect(store.load()).rejects.toThrow("incompatible or malformed");
  expect(perform).not.toHaveBeenCalled();
});

it.each(["scope", "stepId", "encodedValue"])(
  "rejects a malformed %s field in an otherwise compatible file",
  async (field) => {
    const path = await directory();
    const store = await openRecoveryStore(path, RecoveryPipeline, execution);
    await RecoveryPipeline.run(input, { stepIds: ["step-1"], outputObserver: store.observer });
    const [file] = await readdir(path);
    const saved = JSON.parse(await readFile(join(path, file), "utf8")) as Record<string, unknown>;
    saved[field] = field === "stepId" ? "another-step" : null;
    await writeFile(join(path, file), JSON.stringify(saved));
    await expect(store.load()).rejects.toThrow("incompatible or malformed");
  }
);

it("checks the current execution, input, implementation, and graph instead of trusting stored metadata", async () => {
  const path = await directory();
  const store = await openRecoveryStore(path, RecoveryPipeline, execution);
  await RecoveryPipeline.run(input, { stepIds: ["step-1"], outputObserver: store.observer });
  for (const changed of [
    { ...execution, executionId: "another-job" },
    { ...execution, inputIdentity: recoveryInputIdentity({ seed: 99 }) },
  ])
    await expect((await openRecoveryStore(path, RecoveryPipeline, changed)).load()).rejects.toThrow(
      "incompatible"
    );
  const newImplementation = createRecoveryPipeline(increment, "arithmetic-v2");
  expect(newImplementation.definition.identity.structuralFingerprint).toBe(
    RecoveryPipeline.definition.identity.structuralFingerprint
  );
  await expect(
    (await openRecoveryStore(path, newImplementation, execution)).load()
  ).rejects.toThrow("incompatible");
  for (const stepId of ["step-1", "replacement"] as const) {
    const changedGraph = definePipeline({
      id: RecoveryPipeline.id,
      implementationVersion: "arithmetic-v1",
      steps: [createSteps().step(stepId, { run: () => "11" })],
    });
    await expect((await openRecoveryStore(path, changedGraph, execution)).load()).rejects.toThrow(
      "incompatible"
    );
  }
  const one = createSteps().step("step-1", { run: () => "11" });
  const unknownImplementation = definePipeline({ id: RecoveryPipeline.id, steps: [one] });
  await expect(openRecoveryStore(path, unknownImplementation, execution)).rejects.toThrow(
    "explicit implementationVersion"
  );
});

it("round-trips rich raw values before a mutating schema, with no value leakage into traces", async () => {
  const path = await directory();
  const schema: StandardSchemaV1<
    { privateText: string; date: Date; absent: undefined; large: bigint },
    number
  > = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value) {
        if (
          !value ||
          typeof value !== "object" ||
          !("privateText" in value) ||
          typeof value.privateText !== "string"
        )
          return { issues: [{ message: "Expected private text" }] };
        const length = value.privateText.length;
        value.privateText = "mutated";
        return { value: length };
      },
    },
  };
  const marker = "private-recovery-payload";
  const original = {
    privateText: marker,
    date: new Date("2026-01-01T00:00:00Z"),
    absent: undefined,
    large: 123n,
  };
  const firstHandler = vi.fn(() => ({ ...original }));
  function pipeline(run: typeof firstHandler) {
    const load = createSteps().step("load", { run, outputSchema: schema });
    return definePipeline({ id: "rich-recovery", implementationVersion: "rich-v1", steps: [load] });
  }
  const first = pipeline(firstHandler);
  const store = await openRecoveryStore(path, first, execution);
  const traces: string[] = [];
  const context = {
    tracing: {
      exporter: {
        export(event: unknown) {
          traces.push(JSON.stringify(event));
        },
      },
    },
  };
  expect(await first.runOrThrow({}, { outputObserver: store.observer }, context)).toBe(
    marker.length
  );
  const freshHandler = vi.fn(() => ({ ...original }));
  const fresh = pipeline(freshHandler);
  const freshStore = await openRecoveryStore(path, fresh, execution);
  const suppliedOutputs = await freshStore.load();
  expect(suppliedOutputs.get("load")).toStrictEqual(original);
  const write = vi.fn(freshStore.observer.write);
  expect(
    await fresh.runOrThrow(
      {},
      { suppliedOutputs, outputObserver: { ...freshStore.observer, write } },
      context
    )
  ).toBe(marker.length);
  expect((await freshStore.load()).get("load")).toStrictEqual(original);
  expect(freshHandler).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  for (const forbidden of [marker, "encodedValue", "suppliedOutputs"])
    expect(traces.join("\n")).not.toContain(forbidden);
});

it("reconciles a side effect after a hard process exit before output acknowledgement", async () => {
  const path = await directory();
  await expect(invokeWorker(path, "crash")).rejects.toMatchObject({ code: 91 });
  expect((await readdir(path)).filter((name) => name.endsWith(".json"))).toHaveLength(6);
  expect(await readFile(join(path, "worker-job-42-step-7.receipt"), "utf8")).toBe("17");
  const restored = await invokeWorker(path, "reconcile");
  expect(restored.run).toMatchObject({ status: "completed", value: 19 });
  expect(restored.calls).toEqual(["step-7", "step-8", "step-9"]);
  expect(await readFile(join(path, "effect-attempts"), "utf8")).toBe("attempt\nattempt\n");
  expect(await readFile(join(path, "effect-commits"), "utf8")).toBe("commit\n");
  expect(await readFile(join(path, "worker-job-42-step-7.receipt"), "utf8")).toBe("17");
}, 20_000);

it("does not record output after failed validation and rejects records from another pipeline", async () => {
  const path = await directory();
  const invalid = createRecoveryPipeline(async () => "invalid integer text");
  const store = await openRecoveryStore(path, invalid, execution);
  expect(await invalid.run(input, { outputObserver: store.observer })).toMatchObject({
    status: "failed",
  });
  expect(await readdir(path)).toEqual([]);
  const foreign = definePipeline({
    id: "foreign",
    implementationVersion: "v1",
    steps: [createSteps().step("step-1", { run: () => 1 })],
  });
  const result = await foreign.run({}, { outputObserver: store.observer });
  expect(result).toMatchObject({
    status: "failed",
    errors: [{ code: "TUBELESS_STEP_OUTPUT_OBSERVATION_FAILED" }],
  });
  expect(await readdir(path)).toEqual([]);
});

it("keeps previews free of host effects and output writes", async () => {
  const path = await directory();
  const perform = vi.fn(increment);
  const pipeline = createRecoveryPipeline(perform);
  const store = await openRecoveryStore(path, pipeline, execution);
  const write = vi.fn(store.observer.write);
  await pipeline.run(input, { dryRun: true, outputObserver: { ...store.observer, write } });
  expect(perform).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(await readdir(path)).toEqual([]);
});
