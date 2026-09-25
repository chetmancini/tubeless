import { describe, expect, it } from "vitest";
import { artifactMetadataSchema } from "./artifact-metadata.js";
import { decodePipelineTraceEvent } from "./tracing-codec.js";

const decode = (artifact: unknown) => artifactMetadataSchema.decode(artifact, "artifact");

describe("artifact metadata trust boundary", () => {
  it("accepts a bounded JSON snapshot with logical, physical, and content identity", () => {
    const source = {
      id: "model",
      uri: "s3://bucket/model",
      version: "v1",
      checksum: "sha256:abc",
      byteSize: 0,
      mediaType: "application/json",
      schemaVersion: "2",
      metadata: { nested: [null, true, 1, "value", { branch: "main" }] },
    };
    const snapshot = decode(source);
    expect(snapshot).toEqual(source);
    expect(snapshot.metadata).not.toBe(source.metadata);
    expect(decode({ uri: "file:///tmp/model" })).toEqual({ uri: "file:///tmp/model" });
  });

  it.each([
    {},
    { id: "" },
    { id: 1 },
    { id: "a", byteSize: -1 },
    { id: "a", byteSize: 0.5 },
    { id: "a", byteSize: Infinity },
    { id: "a", byteSize: Number.MAX_SAFE_INTEGER + 1 },
    { id: "a", uri: undefined },
    { id: "a", extra: "not allowed" },
    { id: "a", metadata: [] },
    { id: "a", metadata: null },
    ...[
      undefined,
      NaN,
      Infinity,
      1n,
      () => {},
      Symbol("x"),
      new Date(),
      new Map(),
      new Set(),
      new Array(2),
    ].map((value) => ({ id: "a", metadata: { value } })),
  ])("rejects non-JSON or invalid metadata case %#", (value) => {
    expect(() => decode(value)).toThrow();
  });

  it("rejects getters, toJSON, cycles, excess depth, count, and encoded size", () => {
    let accessed = false;
    const accessor = {
      get secret() {
        accessed = true;
        return "secret";
      },
    };
    const serializer = {
      toJSON() {
        accessed = true;
        return {};
      },
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep = Array.from({ length: 10 }).reduce<object>((value) => ({ value }), {});
    const many = Array.from({ length: 256 }, () => null);
    for (const metadata of [
      accessor,
      serializer,
      cyclic,
      deep,
      { many },
      { text: "界".repeat(6000) },
    ]) {
      expect(() => decode({ id: "a", metadata })).toThrow();
    }
    expect(accessed).toBe(false);
  });

  it("preserves JSON keys without prototype assignment and validates persisted trace events", () => {
    const artifact = decode({ id: "a", metadata: JSON.parse('{"__proto__":{"polluted":true}}') });
    expect(Object.hasOwn(artifact.metadata!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(artifact.metadata)).toBe(Object.prototype);
    const event = {
      version: 2,
      name: "step.artifact",
      pipelineId: "p",
      runId: "r",
      stepId: "s",
      attemptId: "a",
      timestampMs: 0,
      payload: { operation: "write", preview: false, artifact },
    };
    expect(decodePipelineTraceEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(() => decodePipelineTraceEvent({ ...event, attemptId: undefined })).toThrow();
    expect(() =>
      decodePipelineTraceEvent({ ...event, payload: { ...event.payload, preview: "false" } })
    ).toThrow();
    expect(() =>
      decodePipelineTraceEvent({
        ...event,
        payload: { ...event.payload, artifact: { id: "a", metadata: { huge: "x".repeat(17000) } } },
      })
    ).toThrow();
  });
});
