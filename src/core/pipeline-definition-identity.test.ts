import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createSteps, definePipeline, requireOutputs } from "./pipeline.js";
import { createPipelineTestRuntime } from "../testing/testing.js";
import type { PipelineTraceEvent } from "../tracing/tracing.js";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";

function pipeline(
  input: { version?: string; name?: string; handler?: number; dryRun?: "skip" } = {}
) {
  const { step } = createSteps();
  const a = step("a", {
    name: input.name,
    description: input.name,
    dryRun: input.dryRun,
    run: () => input.handler ?? 1,
  });
  return definePipeline({
    id: "identity",
    implementationVersion: input.version,
    steps: [a],
    targets: [a],
    finalize: requireOutputs([a], (outputs) => outputs.a),
  });
}

describe("compiled definition identity", () => {
  it("separates implementation and presentation from graph semantics", () => {
    const original = pipeline().definition!;
    expect(pipeline({ name: "Renamed", handler: 2 }).definition).toEqual(original);
    const updated = pipeline({ version: "build:two" }).definition!;
    expect(updated.identity.structuralFingerprint).toBe(original.identity.structuralFingerprint);
    expect(updated.identity.definitionId).not.toBe(original.identity.definitionId);
    expect(pipeline({ dryRun: "skip" }).definition!.identity.structuralFingerprint).not.toBe(
      original.identity.structuralFingerprint
    );
  });

  it("has a reproducible v1 canonical SHA-256 fingerprint", () => {
    const snapshot = pipeline().definition!;
    expect(snapshot.identity).toEqual({
      version: 1,
      structuralFingerprint:
        "sha256:18ab385bd9821bc0b921c1bff063c950c4bed4c8e5720e14df7a628b0e7b5fce",
      definitionId: "sha256:45e74b7aa6f3d769d86b1691a26e01e855420c9ff55e4cb1865af0c11a663245",
    });
    const { identity: _identity, ...semantics } = snapshot;
    const hash = createHash("sha256")
      .update(JSON.stringify({ version: 1, ...semantics }))
      .digest("hex");
    expect(snapshot.identity.structuralFingerprint).toBe(`sha256:${hash}`);
  });

  it("ignores run controls and retains frozen metadata in plans and results", async () => {
    const p = pipeline({ version: "git:abc" });
    expect(p.plan({ dryRun: true, stepIds: ["a"] }).definition).toBe(p.definition);
    expect(p.plan({ targets: [] }).definition).toBe(p.definition);
    expect(Object.isFrozen(p.definition!.steps[0]!.dependencies)).toBe(true);
    const run = await p.run({}, {}, createPipelineTestRuntime().context);
    expect(run.definitionIdentity).toEqual(p.definition!.identity);
  });

  it("records identities and snapshots even when selection fails before planning", async () => {
    const events: PipelineTraceEvent[] = [];
    const p = pipeline();
    await p.run(
      {},
      { targets: [] },
      {
        ...createPipelineTestRuntime().context,
        tracing: {
          exporter: {
            export: (event) => {
              events.push(event);
            },
          },
        },
      }
    );
    const start = events.find((event) => event.name === "pipeline.started")!;
    expect(start.payload.definitionIdentity).toEqual(p.definition!.identity);
    expect(start.payload.definitionSnapshot).toEqual(p.definition);
    expect(decodePipelineTraceEvent(JSON.parse(JSON.stringify(start)))).toEqual(start);
  });

  it("fingerprints all edge types, targets, finalizer requirements and execution order", () => {
    const { step } = createSteps();
    const a = step("a", { run: () => 1 });
    const b = step("b", { run: () => 2 });
    const build = (kind: "none" | "required" | "optional" | "gate") => {
      const c = step("c", {
        dependsOn: kind === "required" ? [a] : [],
        optionalDependsOn: kind === "optional" ? [a] : [],
        skipAfterFailureOf: kind === "gate" ? [a] : [],
        run: () => 3,
      });
      return definePipeline({ id: "edges", steps: [a, b, c], finalize: () => 0 }).definition!
        .identity.structuralFingerprint;
    };
    expect(new Set([build("none"), build("required"), build("optional"), build("gate")]).size).toBe(
      4
    );
    const base = definePipeline({ id: "edges", steps: [a, b], targets: [], finalize: () => 0 });
    for (const changed of [
      definePipeline({ id: "edges", steps: [b, a], targets: [], finalize: () => 0 }),
      definePipeline({ id: "edges", steps: [a, b], targets: [a], finalize: () => 0 }),
      definePipeline({
        id: "edges",
        steps: [a, b],
        targets: [],
        finalize: requireOutputs([a], () => 0),
      }),
    ])
      expect(changed.definition!.identity.structuralFingerprint).not.toBe(
        base.definition!.identity.structuralFingerprint
      );
    const targets = (reverse: boolean) =>
      definePipeline({
        id: "edges",
        steps: [a, b],
        targets: reverse ? [b, a] : [a, b],
        finalize: () => 0,
      });
    expect(targets(true).definition).toEqual(targets(false).definition);
  });

  it("canonicalizes required finalizer steps as a set", () => {
    const { step } = createSteps();
    const a = step("a", { run: () => 1 });
    const b = step("b", { dependsOn: [a], run: () => 2 });
    const forward = definePipeline({
      id: "finalizer",
      steps: [a, b],
      finalize: requireOutputs([a, b], () => 0),
    });
    const reverse = definePipeline({
      id: "finalizer",
      steps: [a, b],
      finalize: requireOutputs([b, a], () => 0),
    });
    const fewer = definePipeline({
      id: "finalizer",
      steps: [a, b],
      finalize: requireOutputs([a], () => 0),
    });
    expect(reverse.definition.requiredFinalizerStepIds).toEqual(["a", "b"]);
    expect(reverse.definition).toEqual(forward.definition);
    expect(fewer.definition.identity.structuralFingerprint).not.toBe(
      forward.definition.identity.structuralFingerprint
    );
  });

  it("records resolved default targets when targets and finalize are omitted", () => {
    const { step } = createSteps();
    const load = step("load", { run: () => 1 });
    const publish = step("publish", { dependsOn: [load], run: () => 2 });
    const defaults = definePipeline({ id: "defaults", steps: [publish, load] });
    const explicit = definePipeline({
      id: "defaults",
      steps: [publish, load],
      targets: [publish],
      finalize: (outputs) => outputs.publish,
    });
    expect(defaults.definition.steps.map(({ id }) => id)).toEqual(["load", "publish"]);
    expect(defaults.definition.targetIds).toEqual(["publish"]);
    expect(defaults.definition).toEqual(explicit.definition);
  });

  it("propagates child structural and implementation changes separately", () => {
    const { fromPipeline, forEachPipeline } = createSteps();
    const parent = (version: string, dryRun?: "skip") => {
      const child = fromPipeline("child", {
        pipeline: pipeline({ version, dryRun }),
        mapOptions: () => ({}),
      });
      return definePipeline({ id: "parent", steps: [child], finalize: () => 0 }).definition!;
    };
    expect(parent("one").identity.structuralFingerprint).toBe(
      parent("two").identity.structuralFingerprint
    );
    expect(parent("one").identity.definitionId).not.toBe(parent("two").identity.definitionId);
    expect(parent("one").identity.structuralFingerprint).not.toBe(
      parent("one", "skip").identity.structuralFingerprint
    );
    const fanout = (concurrency: number) => {
      const child = forEachPipeline("child", {
        pipeline: pipeline(),
        concurrency,
        items: () => [1],
        key: String,
        mapOptions: () => ({}),
      });
      return definePipeline({ id: "parent", steps: [child], finalize: () => 0 }).definition!;
    };
    expect(fanout(1).identity.structuralFingerprint).not.toBe(
      fanout(2).identity.structuralFingerprint
    );
  });

  it("rejects unbounded or blank implementation versions", () => {
    for (const version of ["", " ", "x".repeat(257)])
      expect(() => pipeline({ version })).toThrow(/Implementation version/);
  });

  it("omits an oversized snapshot without truncating the fingerprint or dropping events", async () => {
    const { step } = createSteps();
    const a = step("x".repeat(4097), { run: () => 1 });
    const p = definePipeline({ id: "large", steps: [a], finalize: () => 0 });
    const events: PipelineTraceEvent[] = [];
    await p.run(
      {},
      {},
      {
        ...createPipelineTestRuntime().context,
        tracing: {
          exporter: {
            export: (event) => {
              events.push(event);
            },
          },
        },
      }
    );
    const start = events.find((event) => event.name === "pipeline.started")!;
    expect(start.payload.definitionIdentity).toEqual(p.definition!.identity);
    expect(start.payload.definitionSnapshot).toBeUndefined();
    expect(events.at(-1)!.name).toBe("pipeline.completed");
  });
});
