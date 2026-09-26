import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, querySteps, type PipelineMetadata } from "./pipeline.js";
import { createDefinitionIdentity } from "./pipeline-definition-identity.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { decodeStoredTraceEvent } from "../run-store/run-store-event-decoder.js";
import { compareDefinitions } from "../run-store/definition-diff.js";
import { validatePipelineDocument } from "../project/project-document.js";

describe("inert graph metadata", () => {
  it("snapshots and deeply freezes metadata when compiling, leaving author values mutable", async () => {
    const metadata = {
      tags: ["sensitive"],
      owner: "data",
      annotations: { retention: { days: 7 } },
    };
    const { step } = createSteps();
    const work = step("work", { metadata, run: () => 42 });
    const pipeline = definePipeline({ id: "meta", steps: [work], metadata });
    metadata.tags.push("later");
    metadata.annotations.retention.days = 30;
    metadata.owner = "other";
    const plan = pipeline.plan();
    expect(plan.steps[0]?.metadata).toEqual({
      tags: ["sensitive"],
      owner: "data",
      annotations: { retention: { days: 7 } },
    });
    expect(pipeline.metadata).toEqual(plan.steps[0]?.metadata);
    expect(Object.isFrozen(pipeline.metadata?.annotations?.retention)).toBe(true);
    expect(() => {
      (plan.steps[0]!.metadata!.tags as string[]).push("injected");
    }).toThrow();
    expect(pipeline.definition.metadata).toEqual(pipeline.metadata);
    expect(await pipeline.runOrThrow()).toBe(42);
  });

  it("queries with exact AND matches without selecting work or adding dependencies", async () => {
    const calls: string[] = [];
    const { step } = createSteps();
    const load = step("load", {
      metadata: { owner: "data", tags: ["pii"] },
      run: () => calls.push("load"),
    });
    const save = step("save", {
      dependsOn: [load],
      metadata: { owner: "data", domain: "billing", tags: ["pii", "write"] },
      dryRun: "skip",
      run: () => calls.push("save"),
    });
    const plain = step("plain", { run: () => calls.push("plain") });
    const pipeline = definePipeline({
      id: "query",
      steps: [load, save, plain],
      metadata: { owner: "pipeline-owner" },
    });
    const plan = pipeline.plan();
    expect(querySteps(plan, { tags: ["pii", "write"], owner: "data" }).map((s) => s.id)).toEqual([
      "save",
    ]);
    expect(querySteps(plan, { domain: "billing" }).map((s) => s.id)).toEqual(["save"]);
    expect(querySteps(plan, { owner: "DATA" })).toEqual([]);
    expect(querySteps(plan, { owner: "pipeline-owner" })).toEqual([]);
    expect(querySteps(plan)).toEqual(plan.steps);
    expect(
      querySteps(pipeline.plan({ stepIds: ["plain"] }), { owner: "data" }).every((s) => !s.selected)
    ).toBe(true);
    const graph = pipeline.toMermaid({ query: { tags: ["write"] }, includeMetadata: true });
    expect(graph).toContain("billing");
    expect(graph).not.toContain("-->");
    expect(graph).not.toContain("undefined");
    expect(pipeline.toMermaid({ query: { owner: "missing" } })).toBe("flowchart TD\n");
    await pipeline.runOrThrow(undefined, { dryRun: true });
    expect(calls).toEqual(["load", "plain"]);
    calls.length = 0;
    await pipeline.runOrThrow();
    expect(calls).toEqual(["load", "save", "plain"]);
  });

  it.each([
    null,
    [],
    { owner: " " },
    { tags: [1] },
    { domain: "x".repeat(257) },
    { custom: 1 },
    { annotations: { value: undefined } },
    { annotations: { value: NaN } },
    { annotations: { value: Infinity } },
    { annotations: { value: 1n } },
    { annotations: { value: new Date() } },
    { annotations: { value: () => 1 } },
    { annotations: { value: Array(2) } },
    { annotations: { value: "界".repeat(6000) } },
    { tags: Array.from({ length: 65 }, (_, i) => String(i)) },
  ])("rejects invalid metadata at compilation (%#)", (value) => {
    const { step } = createSteps();
    // SAFETY: exercise runtime validation for untyped callers.
    const metadata = value as PipelineMetadata;
    expect(() =>
      definePipeline({ id: "bad", steps: [step("work", { metadata, run: () => 1 })] })
    ).toThrow();
    expect(() => definePipeline({ id: "bad", metadata, steps: [] })).toThrow();
  });

  it("rejects cycles, accessors and excessive nesting without invoking getters", () => {
    let calls = 0;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const getter = {
      get secret() {
        calls++;
        return "secret";
      },
    };
    let deep: unknown = {};
    for (let i = 0; i < 10; i++) deep = { deep };
    for (const annotations of [cycle, getter, deep, { [Symbol("hidden")]: 1 }]) {
      // SAFETY: deliberately invalid JSON values exercise the runtime boundary.
      expect(() =>
        definePipeline({ id: "bad", steps: [], metadata: { annotations } as PipelineMetadata })
      ).toThrow();
    }
    expect(calls).toBe(0);
  });

  it("retains metadata in traces, binds it to identity, and detects tampering", async () => {
    const { step } = createSteps();
    const build = (owner: string) =>
      definePipeline({
        id: "traced",
        metadata: { domain: "finance" },
        steps: [step("work", { metadata: { owner }, run: () => 1 })],
      });
    const pipeline = build("data");
    const events: PipelineTraceEvent[] = [];
    await pipeline.run(undefined, undefined, {
      ...createPipelineTestRuntime().context,
      tracing: {
        exporter: {
          export: (event) => {
            events.push(event);
          },
        },
      },
    });
    const start = events.find((e) => e.name === "pipeline.started")!;
    expect(decodeStoredTraceEvent(JSON.parse(JSON.stringify(start)))).toMatchObject({
      payload: {
        definitionSnapshot: {
          metadata: { domain: "finance" },
          steps: [{ metadata: { owner: "data" } }],
        },
      },
    });
    const tampered = JSON.parse(JSON.stringify(start));
    tampered.payload.definitionSnapshot.steps[0].metadata.owner = "injected";
    expect(() => decodeStoredTraceEvent(tampered)).toThrow("fingerprint");
    expect(pipeline.definition.identity.version).toBe(3);
    expect(build("other").definition.identity).not.toEqual(pipeline.definition.identity);
    expect(compareDefinitions(pipeline.definition, build("other").definition)).toContainEqual({
      field: "Metadata",
      stepId: "work",
      before: '{"owner":"data"}',
      after: '{"owner":"other"}',
    });
    const reordered = { ...pipeline.definition, metadata: { annotations: { b: 2, a: 1 } } };
    expect(createDefinitionIdentity(reordered, undefined)).toEqual(
      createDefinitionIdentity(
        { ...reordered, metadata: { annotations: { a: 1, b: 2 } } },
        undefined
      )
    );
  });

  it("keeps child metadata isolated while propagating versioned child identity", () => {
    const { step, fromPipeline, forEachPipeline, iteratePipeline } = createSteps();
    const child = definePipeline({
      id: "child",
      metadata: { owner: "child-team" },
      steps: [step("inner", { metadata: { tags: ["private"] }, run: () => 1 })],
    });
    const wrappers = [
      fromPipeline("one", { pipeline: child, metadata: { owner: "parent-team" } }),
      forEachPipeline("many", {
        pipeline: child,
        items: () => [1],
        key: String,
        mapOptions: () => ({}),
        metadata: { domain: "batch" },
      }),
      iteratePipeline("repeat", {
        pipeline: child,
        maxIterations: 1,
        initialState: () => 0,
        mapOptions: () => ({}),
        transition: () => ({ kind: "finish", result: 1 }),
        metadata: { tags: ["loop"] },
      }),
    ];
    const pipeline = definePipeline({ id: "parent", steps: wrappers });
    expect(pipeline.definition.identity.version).toBe(3);
    expect(querySteps(pipeline.plan(), { owner: "child-team" })).toEqual([]);
    expect(pipeline.plan().steps.map((s) => s.metadata)).toEqual([
      { owner: "parent-team" },
      { domain: "batch" },
      { tags: ["loop"] },
    ]);
    expect(child.metadata?.owner).toBe("child-team");
  });

  it("keeps document v1 strict rather than accepting unversioned metadata fields", () => {
    expect(() =>
      validatePipelineDocument({
        version: 1,
        pipelines: [{ id: "doc", metadata: { owner: "team" }, steps: [] }],
      })
    ).toThrow();
    expect(() =>
      validatePipelineDocument({
        version: 1,
        pipelines: [
          { id: "doc", steps: [{ id: "work", run: "handler", metadata: { owner: "team" } }] },
        ],
      })
    ).toThrow();
  });
});
