import { describe, expect, it, vi } from "vitest";
import {
  createSteps,
  definePipeline,
  type StepCacheEntry,
  type StepCacheStore,
  type PipelineStepContext,
} from "./pipeline.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { v8StepCacheCodec } from "../utilities/cache-storage.js";
import { standardSchema } from "./pipeline.test-support.js";

function fixture() {
  const entries = new Map<string, StepCacheEntry>();
  const store: StepCacheStore = {
    get: (key) => entries.get(key),
    set: (key, entry) => {
      entries.set(key, entry);
    },
  };
  const events: PipelineTraceEvent[] = [];
  const context = {
    now: () => 2000,
    tracing: {
      exporter: {
        export: (event: PipelineTraceEvent) => {
          events.push(event);
        },
      },
    },
  };
  const cache = { version: "v1", key: () => "private-key", store, codec: v8StepCacheCodec };
  const artifacts = () => events.filter((event) => event.name === "step.artifact");
  return { entries, store, events, context, cache, artifacts };
}

describe("cache artifact lineage", () => {
  it("records a stable cache identity across writes and reuse without replaying application writes", async () => {
    const f = fixture();
    const { step } = createSteps();
    const run = vi.fn((_inputs: unknown, context: PipelineStepContext<{}>) => {
      context.recordArtifact({ operation: "write", artifact: { id: "application-file" } });
      return "private-output";
    });
    const pipeline = definePipeline({
      id: "lineage",
      steps: [step("work", { cache: f.cache, run })],
    });
    await pipeline.runOrThrow({}, {}, f.context);
    await pipeline.runOrThrow({}, {}, { ...f.context, now: () => 2500 });
    const records = f.artifacts();
    expect(records.map((event) => event.payload.operation)).toEqual(["write", "write", "reuse"]);
    const write = records[1];
    const reuse = records[2];
    expect(write.payload.artifact.id).toMatch(/^tubeless:step-cache:[a-f0-9]{64}$/);
    expect(reuse.payload.artifact.id).toBe(write.payload.artifact.id);
    expect(write.payload.artifact.uri).toBeUndefined();
    expect(reuse.payload.artifact.metadata).toEqual({
      tubelessCache: {
        implementationVersion: "v1",
        createdAtMs: 2000,
        ageMs: 500,
      },
    });
    expect(reuse.runId).not.toBe(write.runId);
    expect(reuse.attemptId).not.toBe(write.attemptId);
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.events)).not.toMatch(/private-key|private-output/);
  });

  it("accepts store receipts and reserves cache identity and metadata", async () => {
    const f = fixture();
    const receipt = {
      id: "store-id",
      uri: "memory:entry",
      byteSize: 9,
      metadata: { owner: "test", tubelessCache: "cannot override" },
    };
    f.store.set = (key, entry) => {
      f.entries.set(key, { ...entry, artifact: receipt });
      return receipt;
    };
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "receipts",
      steps: [
        step("work", {
          cache: { ...f.cache, maxAge: "1 day" },
          run: () => 1,
        }),
      ],
    });
    await pipeline.runOrThrow({}, {}, f.context);
    await pipeline.runOrThrow({}, {}, f.context);
    receipt.metadata.owner = "changed";
    for (const record of f.artifacts()) {
      expect(record.payload.artifact).toMatchObject({
        uri: "memory:entry",
        byteSize: 9,
        metadata: { owner: "test", tubelessCache: { maxAgeMs: 86400000 } },
      });
      expect(record.payload.artifact.id).not.toBe("store-id");
    }
  });

  it.each(["bypass", "dry-run", "decode", "validation", "write", "receipt"])(
    "does not emit a successful cache operation for %s",
    async (mode) => {
      const f = fixture();
      if (mode === "decode" || mode === "validation")
        f.store.get = async () => ({
          value: mode === "decode" ? new Uint8Array([255]) : await v8StepCacheCodec.encode(1),
          createdAtMs: 2000,
        });
      if (mode === "write")
        f.store.set = () => {
          throw new Error("write failed");
        };
      if (mode === "receipt") f.store.set = () => ({ uri: "memory:bad", byteSize: -1 });
      const { step } = createSteps();
      const pipeline = definePipeline({
        id: "failure",
        steps: [
          step("work", {
            cache: f.cache,
            run: () => 1,
            outputSchema: standardSchema<number, number>((value) =>
              mode === "validation" || typeof value !== "number"
                ? { issues: [{ message: "invalid" }] }
                : { value }
            ),
          }),
        ],
      });
      await pipeline.run(
        {},
        { cache: mode === "bypass" ? "bypass" : "use", dryRun: mode === "dry-run" },
        f.context
      );
      expect(f.artifacts()).toEqual([]);
    }
  );

  it("records replacement writes without recording reuse of expired entries", async () => {
    const f = fixture();
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "expiration",
      steps: [
        step("work", {
          cache: { ...f.cache, maxAge: 100 },
          run: () => 1,
        }),
      ],
    });
    await pipeline.runOrThrow({}, {}, f.context);
    await pipeline.runOrThrow({}, {}, { ...f.context, now: () => 2100 });
    await pipeline.runOrThrow({}, { cache: "recompute" }, { ...f.context, now: () => 2150 });
    expect(f.artifacts().map((record) => record.payload.operation)).toEqual([
      "write",
      "write",
      "write",
    ]);
  });

  it("retains a completed write if cancellation arrives after persistence", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.store.set = (key, entry) => {
      f.entries.set(key, entry);
      controller.abort();
    };
    const { step } = createSteps();
    const pipeline = definePipeline({
      id: "cancel",
      steps: [step("work", { cache: f.cache, run: () => 1 })],
    });
    const report = await pipeline.run({}, {}, { ...f.context, signal: controller.signal });
    expect(report.status).toBe("cancelled");
    expect(f.artifacts().map((record) => record.payload.operation)).toEqual(["write"]);
  });
});
