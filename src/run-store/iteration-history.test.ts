import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, type PipelineRunControls } from "../core/pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import { decodeStoredTraceEvent } from "./run-store-event-decoder.js";
import { projectPipelineRunStore, type StoredPipelineEvent } from "./run-store.js";
import { renderPipelinePlan } from "../render/render.js";

const { step } = createSteps<{ page: number }>();
const page = step("page", { run: (_inputs, context) => context.options.page + 1 });
const child = definePipeline({ id: "page", steps: [page], finalize: page });

function repeated(maxIterations = 3, controls?: PipelineRunControls<"page", "page">) {
  const { iteratePipeline } = createSteps();
  const repeat = iteratePipeline("repeat", {
    pipeline: child,
    maxIterations,
    controls,
    initialState: () => 0,
    mapOptions: (state) => ({ page: state }),
    transition: (result) =>
      result === 2 ? { kind: "finish", result } : { kind: "next", state: result },
  });
  return definePipeline({ id: "history", steps: [repeat], finalize: repeat });
}

async function record() {
  const pipeline = repeated();
  const events: StoredPipelineEvent[] = [];
  const runtime = createPipelineTestRuntime();
  const run = await pipeline.run(
    {},
    {},
    {
      ...runtime.context,
      tracing: {
        exporter: {
          export: (event) => {
            events.push({
              ...decodeStoredTraceEvent(JSON.parse(JSON.stringify(event))),
              id: events.length,
            });
          },
        },
      },
    }
  );
  expect(runtime.logs.filter((entry) => entry.level === "warn")).toEqual([]);
  return { pipeline, events, run };
}

describe("iteration recording compatibility", () => {
  it("round trips trace v3, iteration parentage, bounded plans, and projected history", async () => {
    const { pipeline, events, run } = await record();
    expect(run.status).toBe("completed");
    expect(events.every((event) => event.version === 3)).toBe(true);
    const starts = events.filter((event) => event.name === "pipeline.started");
    expect(starts).toHaveLength(3);
    const children = starts.filter((event) => event.pipelineId === "page");
    expect(children.map((event) => event.iteration?.index)).toEqual([1, 2]);
    expect(new Set(children.map((event) => event.runId)).size).toBe(2);
    const attemptId = run.steps[0]?.attemptId;
    for (const event of children) {
      expect(event.parentRunId).toBe(run.runId);
      expect(event.iteration).toMatchObject({ runId: run.runId, stepId: "repeat", attemptId });
    }
    const snapshot = projectPipelineRunStore(events);
    expect(
      snapshot.runs
        .filter((entry) => entry.iteration)
        .map((entry) => entry.iteration?.index)
        .sort()
    ).toEqual([1, 2]);
    expect(snapshot.definitions.find((entry) => entry.pipelineId === "history")?.snapshot).toEqual(
      pipeline.definition
    );
    expect(
      snapshot.runs.find((entry) => entry.runId === run.runId)?.steps[0]?.nestedPipeline
    ).toMatchObject({ mode: "iterate", maxIterations: 3 });
    expect(renderPipelinePlan(pipeline.plan())).toContain("at most 3");
    expect(pipeline.toMermaid()).toContain("at most 3 iterations");
  });

  it("retains v1 fingerprints and promotes only extended definitions and their parents", () => {
    const { step, fromPipeline } = createSteps();
    const legacy = definePipeline({ id: "fixture", steps: [step("work", { run: () => 1 })] });
    // Captured from the pre-iteration implementation, not recomputed by the new hash code.
    expect(legacy.definition.identity).toEqual({
      version: 1,
      structuralFingerprint:
        "sha256:89ee73ee5ef05bdfc5eca082377998c83f156af7732250327a779ae25ec4d3a6",
      definitionId: "sha256:294df4c0266eba54df2f01b326c41c345094fe125b55d7fdf30ce988e7e7668c",
    });
    const a = repeated();
    const b = repeated(4);
    const c = repeated(3, { maxConcurrency: 2 });
    expect(a.definition.identity.version).toBe(2);
    expect(
      new Set([a, b, c].map((pipeline) => pipeline.definition.identity.definitionId)).size
    ).toBe(3);
    const wrap = fromPipeline("wrap", { pipeline: a });
    expect(definePipeline({ id: "outer", steps: [wrap] }).definition.identity.version).toBe(2);
    expect(child.definition.identity.version).toBe(1);
  });

  it("reads legacy v2 recordings but rejects new metadata disguised as v2", async () => {
    const { events } = await record();
    const root = events.find(
      (event) => event.name === "pipeline.started" && event.pipelineId === "history"
    )!;
    expect(() => decodeStoredTraceEvent({ ...root, version: 2 })).toThrow(
      "requires identity version 1"
    );
    const inner = events.find((event) => event.iteration)!;
    expect(() => decodeStoredTraceEvent({ ...inner, version: 2 })).toThrow(
      "requires trace version 3"
    );
    const legacy = { ...inner, version: 2, iteration: undefined };
    expect(decodeStoredTraceEvent(legacy).version).toBe(2);
    expect(() =>
      decodeStoredTraceEvent({ ...inner, iteration: { ...inner.iteration, index: 0 } })
    ).toThrow();
    expect(() => decodeStoredTraceEvent({ ...inner, version: 4 })).toThrow();
  });

  it("rejects forged bounds and keeps identity stable across repeated executions", async () => {
    const first = await record();
    const second = await record();
    expect(first.pipeline.definition).toEqual(second.pipeline.definition);
    const start = first.events.find(
      (event) => event.name === "pipeline.started" && event.pipelineId === "history"
    );
    if (start?.name !== "pipeline.started" || !start.payload.definitionSnapshot)
      throw new Error("Missing definition snapshot");
    const tampered = structuredClone(start);
    tampered.payload.definitionSnapshot!.steps[0]!.nestedPipeline!.maxIterations = 99;
    expect(() => decodeStoredTraceEvent(tampered)).toThrow("structural fingerprint");
  });
});
