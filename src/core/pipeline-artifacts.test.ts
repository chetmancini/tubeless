import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type ArtifactLoader,
  type ArtifactSaver,
} from "./pipeline.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";

function capture() {
  const events: PipelineTraceEvent[] = [];
  return {
    events,
    context: {
      tracing: {
        exporter: {
          export: (event: PipelineTraceEvent) => {
            events.push(decodePipelineTraceEvent(event));
          },
        },
      },
    },
    artifacts: () => events.filter((event) => event.name === "step.artifact"),
  };
}

describe("artifact steps", () => {
  it("rejects cache configuration on helpers, including structurally typed variables", () => {
    const { loadArtifact, saveArtifact } = createSteps();
    const load = vi.fn(() => ({ value: 1, artifact: { id: "input" } }));
    const save = vi.fn(() => ({ value: 1, artifact: { id: "output" } }));
    const loaderConfig = { cache: { version: "v1" }, load };
    const saverConfig = { cache: { version: "v1" }, save };
    expect(() => {
      // @ts-expect-error A variable with cache must be rejected, not just an excess-property literal.
      loadArtifact("load", loaderConfig);
    }).toThrow("Artifact helpers cannot configure caching");
    expect(() => {
      // @ts-expect-error Cache cannot skip the helper's unconditional write.
      saveArtifact("save", saverConfig);
    }).toThrow("Artifact helpers cannot configure caching");
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)(
    "retains committed batches when a later batch is %s",
    async (status) => {
      const { step } = createSteps();
      const controller = new AbortController();
      const persisted: number[] = [];
      const checkpointed: number[] = [];
      const write = step("write-batches", {
        dryRun: "skip",
        run: (_inputs, context) => {
          for (const batch of [1, 2, 3]) {
            if (batch === 3) {
              if (status === "cancelled") {
                controller.abort();
                context.signal?.throwIfAborted();
              }
              throw new Error("later batch failed");
            }
            persisted.push(batch);
            context.recordArtifact({ operation: "write", artifact: { id: `batch-${batch}` } });
            checkpointed.push(batch);
          }
        },
      });
      const trace = capture();
      const run = await definePipeline({ id: "batches", steps: [write] }).run(
        {},
        {},
        { ...trace.context, signal: controller.signal }
      );
      expect(run.status).toBe(status);
      expect(persisted).toEqual([1, 2]);
      expect(checkpointed).toEqual(persisted);
      expect(trace.artifacts().map((event) => event.payload.artifact.id)).toEqual([
        "batch-1",
        "batch-2",
      ]);
      expect(trace.artifacts().every((event) => event.attemptId === run.steps[0].attemptId)).toBe(
        true
      );
      expect(trace.events.findIndex((event) => event.name === "step.artifact")).toBeLessThan(
        trace.events.findIndex(
          (event) => event.name === (status === "failed" ? "step.failed" : "step.cancelled")
        )
      );
    }
  );

  it("preserves domain results and distinguishes reused releases from new writes", async () => {
    const { step } = createSteps<{ exists: boolean }>();
    const writes = vi.fn();
    const receipt = {
      path: "release/manifest.json",
      validation: { rows: 123 },
      domainValue: () => 42,
    };
    const release = step("release", {
      dryRun: "skip",
      run: (_inputs, context) => {
        if (!context.options.exists) writes();
        context.recordArtifact({
          operation: context.options.exists ? "reuse" : "write",
          artifact: { id: "release", version: "v1" },
        });
        return receipt;
      },
    });
    const consume = step("consume", {
      dependsOn: [release],
      run: ({ release: result }) => {
        expectTypeOf(result).toEqualTypeOf<typeof receipt>();
        return result;
      },
    });
    const pipeline = definePipeline({
      id: "release",
      steps: [release, consume],
      finalize: consume,
    });
    const trace = capture();
    for (const exists of [false, true]) {
      expect(await pipeline.runOrThrow({ exists }, {}, trace.context)).toBe(receipt);
    }
    expect(writes).toHaveBeenCalledOnce();
    expect(trace.artifacts().map((event) => event.payload.operation)).toEqual(["write", "reuse"]);
    expect(JSON.stringify(trace.events)).not.toContain("domainValue");
  });

  it("snapshots ordinary-step reports immediately and ignores reports after settlement", async () => {
    const { step } = createSteps();
    const metadata = { id: "original", metadata: { version: 1 } };
    let late = () => {};
    const work = step("work", {
      run: (_inputs, context) => {
        context.recordArtifact({ operation: "read", artifact: metadata });
        metadata.metadata.version = 2;
        late = () => context.recordArtifact({ operation: "write", artifact: { id: "late" } });
        return 1;
      },
    });
    const trace = capture();
    await definePipeline({ id: "snapshot", steps: [work] }).run({}, {}, trace.context);
    late();
    await Promise.resolve();
    expect(trace.artifacts()).toHaveLength(1);
    expect(trace.artifacts()[0].payload.artifact.metadata).toEqual({ version: 1 });
  });

  it("validates direct reports without tracing", async () => {
    const { step } = createSteps();
    for (const record of [
      { operation: "read", artifact: { id: "input", byteSize: -1 } },
      { operation: "delete", artifact: { id: "input" } },
    ]) {
      const work = step("invalid", {
        run: (_inputs, context) => context.recordArtifact(record as never),
      });
      expect((await definePipeline({ id: "invalid", steps: [work] }).run()).status).toBe("failed");
    }
  });

  it("marks dry-run write intentions and custom-handler reports as previews", async () => {
    const { step } = createSteps();
    const normal = step("normal", {
      run: (_inputs, context) => {
        context.recordArtifact({ operation: "read", artifact: { id: "input" } });
        context.recordArtifact({ operation: "reuse", artifact: { id: "existing" } });
        if (context.dryRun)
          context.recordArtifact({ operation: "write", artifact: { id: "intended" } });
      },
    });
    const custom = step("custom", {
      run: () => {
        throw new Error("must not execute");
      },
      dryRun: (_inputs, context) =>
        context.recordArtifact({ operation: "reuse", artifact: { id: "preview" } }),
    });
    const trace = capture();
    await definePipeline({ id: "previews", steps: [normal, custom] }).runOrThrow(
      {},
      { dryRun: true },
      trace.context
    );
    expect(
      trace.artifacts().map((event) => [event.payload.operation, event.payload.preview])
    ).toEqual([
      ["read", false],
      ["reuse", false],
      ["write", true],
      ["reuse", true],
    ]);
  });

  it("infers dependencies, keeps values out of traces, and snapshots metadata", async () => {
    const { loadArtifact, saveArtifact, step } = createSteps<{ source: string }>();
    const metadata = { id: "input", metadata: { revision: 1 } };
    const loader: ArtifactLoader<string, number> = (source, context) => {
      expect(source).toBe("input.json");
      expect(context.signal).toBeDefined();
      return { value: 42, artifact: metadata };
    };
    const saver: ArtifactSaver<number, { rows: number }> = (value) => ({
      value: { rows: value },
      artifact: { id: "output", byteSize: value },
    });
    const load = loadArtifact("load", {
      load: (_inputs, context) => loader(context.options.source, context),
    });
    const transform = step("transform", {
      dependsOn: [load],
      run: ({ load: value }) => {
        expectTypeOf(value).toEqualTypeOf<number>();
        return value + 1;
      },
    });
    const save = saveArtifact("save", {
      dependsOn: [transform],
      save: ({ transform: value }, context) => saver(value, context),
    });
    const trace = capture();
    const pipeline = definePipeline({
      id: "artifacts",
      steps: [load, transform, save],
      finalize: save,
    });
    const result = await pipeline.runOrThrow(
      { source: "input.json" },
      {},
      { ...trace.context, signal: new AbortController().signal }
    );
    expectTypeOf(result).toEqualTypeOf<{ rows: number }>();
    expect(result).toEqual({ rows: 43 });
    metadata.metadata.revision = 2;
    expect(trace.artifacts().map((event) => event.payload)).toEqual([
      { operation: "read", preview: false, artifact: { id: "input", metadata: { revision: 1 } } },
      { operation: "write", preview: false, artifact: { id: "output", byteSize: 43 } },
    ]);
    for (const event of trace.artifacts()) {
      expect(event.version).toBe(3);
      expect(event.attemptId).toBeTruthy();
      expect(event.runId).toBeTruthy();
      expect(event.payload).not.toHaveProperty("value");
    }
  });

  it("never calls savers in a dry run, and records previews separately from real reads", async () => {
    const { loadArtifact, saveArtifact } = createSteps();
    const load = loadArtifact("load", {
      load: () => ({ value: "data", artifact: { uri: "memory:input" } }),
    });
    const write = vi.fn(() => ({ value: "output", artifact: { uri: "memory:output" } }));
    const save = saveArtifact("save", { dependsOn: [load], save: write });
    const preview = saveArtifact("preview", {
      dependsOn: [load],
      save: write,
      dryRun: ({ load: value }) => ({ value, artifact: { uri: "memory:preview" } }),
    });
    const pipeline = definePipeline({ id: "dry-artifacts", steps: [load, save, preview] });
    expect(pipeline.plan().steps.map((entry) => entry.dryRun)).toEqual(["run", "skip", "custom"]);
    expect(write).not.toHaveBeenCalled();
    const trace = capture();
    const run = await pipeline.run({}, { dryRun: true }, trace.context);
    expect(run.status).toBe("completed");
    expect(write).not.toHaveBeenCalled();
    expect(run.steps.find((entry) => entry.id === "save")).toMatchObject({
      status: "skipped",
      reason: "dry-run",
    });
    expect(
      trace.artifacts().map((event) => [event.payload.operation, event.payload.preview])
    ).toEqual([
      ["read", false],
      ["write", true],
    ]);
  });

  it("supports typed loader previews and structurally skipped loads", async () => {
    const { loadArtifact } = createSteps();
    const load = vi.fn(() => ({ value: 42, artifact: { id: "actual" } }));
    const preview = loadArtifact("preview", {
      load,
      dryRun: () => ({ value: 0, artifact: { id: "intended" } }),
    });
    const skipped = loadArtifact("skipped", { load, dryRun: "skip" });
    const trace = capture();
    const run = await definePipeline({ id: "load-preview", steps: [skipped, preview] }).run(
      {},
      { dryRun: true },
      trace.context
    );
    expect(run.value).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(trace.artifacts()).toHaveLength(1);
    expect(trace.artifacts()[0].payload).toMatchObject({ operation: "read", preview: true });
  });

  it("propagates adapter failures and cancellation without fabricating lineage", async () => {
    const { loadArtifact, saveArtifact } = createSteps();
    const controller = new AbortController();
    const load = loadArtifact("load", {
      load: async (_inputs, context) => {
        expect(context.signal).toBe(controller.signal);
        controller.abort();
        context.signal?.throwIfAborted();
        return { value: 1, artifact: { id: "input" } };
      },
    });
    const save = saveArtifact("save", {
      dependsOn: [load],
      save: vi.fn(() => ({ value: "output", artifact: { id: "output" } })),
    });
    const trace = capture();
    const run = await definePipeline({ id: "cancel", steps: [load, save] }).run(
      {},
      {},
      { ...trace.context, signal: controller.signal }
    );
    expect(run.status).toBe("cancelled");
    expect(trace.artifacts()).toEqual([]);
    const failed = saveArtifact("failed", {
      save: () => {
        throw new Error("write failed");
      },
    });
    const failure = await definePipeline({ id: "failure", steps: [failed] }).run(
      {},
      {},
      trace.context
    );
    expect(failure.status).toBe("failed");
    expect(trace.artifacts()).toEqual([]);
  });

  it("validates metadata even without tracing and isolates exporter errors", async () => {
    const { loadArtifact, saveArtifact } = createSteps();
    const invalid = loadArtifact("invalid", {
      load: () => ({ value: "data", artifact: { id: "input", byteSize: -1 } }),
    });
    const pipeline = definePipeline({ id: "invalid-metadata", steps: [invalid] });
    expect((await pipeline.run()).status).toBe("failed");
    const save = saveArtifact("save", {
      save: () => ({ value: "output", artifact: { id: "output" } }),
    });
    const error = vi.fn();
    await expect(
      definePipeline({ id: "exporter-error", steps: [save] }).runOrThrow(
        {},
        {},
        {
          log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
          tracing: {
            onExporterError: error,
            exporter: {
              export: (event) => {
                if (event.name === "step.artifact") throw new Error("destination unavailable");
              },
            },
          },
        }
      )
    ).resolves.toBe("output");
    expect(error).toHaveBeenCalledOnce();
  });

  it("records child artifacts against the child run and preserves parent correlation", async () => {
    const { loadArtifact, fromPipeline } = createSteps();
    const load = loadArtifact("load", {
      load: () => ({ value: 1, artifact: { id: "child-input" } }),
    });
    const child = definePipeline({ id: "child", steps: [load] });
    const parent = definePipeline({
      id: "parent",
      steps: [fromPipeline("child-step", { pipeline: child })],
    });
    const trace = capture();
    const run = await parent.run({}, {}, { ...trace.context, correlationId: "job" });
    expect(trace.artifacts()).toHaveLength(1);
    expect(trace.artifacts()[0]).toMatchObject({
      pipelineId: "child",
      stepId: "load",
      parentRunId: run.runId,
      correlationId: "job",
    });
    expect(trace.artifacts()[0].runId).not.toBe(run.runId);
  });

  it("isolates concurrent runs and filtered steps", async () => {
    const { loadArtifact, saveArtifact } = createSteps<{ id: string }>();
    const load = loadArtifact("load", {
      load: async (_inputs, context) => {
        await Promise.resolve();
        return { value: context.options.id, artifact: { id: context.options.id } };
      },
    });
    const save = saveArtifact("save", {
      dependsOn: [load],
      save: ({ load: id }) => ({ value: id, artifact: { id: `${id}-out` } }),
    });
    const pipeline = definePipeline({ id: "concurrent", steps: [load, save] });
    const trace = capture();
    const runs = await Promise.all(
      ["a", "b"].map((id) => pipeline.run({ id }, { maxConcurrency: 2 }, trace.context))
    );
    for (const [index, run] of runs.entries()) {
      expect(
        trace
          .artifacts()
          .filter((event) => event.runId === run.runId)
          .map((event) => event.payload.artifact.id)
      ).toEqual([index === 0 ? "a" : "b", index === 0 ? "a-out" : "b-out"]);
    }
    const filtered = capture();
    await pipeline.run({ id: "filtered" }, { stepIds: ["save"] }, filtered.context);
    expect(filtered.artifacts()).toEqual([]);
  });
});
