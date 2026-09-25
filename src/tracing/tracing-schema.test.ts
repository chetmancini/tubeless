import { describe, expect, it } from "vitest";
import { createSteps, definePipeline, PIPELINE_ERROR_CODES } from "../core/pipeline.js";
import {
  pipelineTraceEventSchema,
  pipelineTraceEventSchemas,
  pipelineTraceOpenApiSchemas,
} from "./tracing-schema.js";
import { wireDiscriminatedUnion, wireEnum, wireObject } from "./wire-schema.js";

describe("pipeline trace schema", () => {
  it("publishes the decoder's error codes to OpenAPI", () => {
    expect(pipelineTraceOpenApiSchemas.PipelineError).toMatchObject({
      properties: { code: { enum: PIPELINE_ERROR_CODES } },
      required: expect.arrayContaining(["code", "kind", "message", "phase"]),
    });
  });

  it("publishes one typed OpenAPI variant for every decoded event", () => {
    const entries = Object.entries(pipelineTraceEventSchemas);
    expect(pipelineTraceOpenApiSchemas.StoredPipelineEvent.oneOf).toHaveLength(entries.length);
    for (const [index, [name]] of entries.entries()) {
      expect(pipelineTraceOpenApiSchemas.StoredPipelineEvent.oneOf[index]).toMatchObject({
        if: { properties: { version: { const: 2 } } },
        then: { properties: { iteration: false } },
        properties: {
          id: { minimum: 0, type: "integer" },
          name: { const: name },
          payload: { additionalProperties: false, type: "object" },
        },
        required: expect.arrayContaining(["id", "name", "payload"]),
      });
    }
  });

  it("makes reused discriminated-union variants disjoint in JSON Schema", () => {
    const sharedVariant = wireObject({ kind: wireEnum(["first", "second"] as const) });
    const union = wireDiscriminatedUnion("kind", {
      first: sharedVariant,
      second: sharedVariant,
    });

    expect(union.jsonSchema).toEqual({
      oneOf: [
        {
          allOf: [
            sharedVariant.jsonSchema,
            {
              properties: { kind: { const: "first", type: "string" } },
              required: ["kind"],
              type: "object",
            },
          ],
        },
        {
          allOf: [
            sharedVariant.jsonSchema,
            {
              properties: { kind: { const: "second", type: "string" } },
              required: ["kind"],
              type: "object",
            },
          ],
        },
      ],
    });
  });
});

describe("definition trace compatibility", () => {
  const { step } = createSteps();
  const work = step("work", { run: () => 1 });
  const definition = definePipeline({ id: "fixture", steps: [work], finalize: () => 0 }).definition;
  const started = {
    name: "pipeline.started",
    version: 2,
    pipelineId: "fixture",
    runId: "run",
    timestampMs: 0,
    payload: { dryRun: false, planOk: true, stepCount: 1, targetIds: [] },
  };
  const decode = (payload: object) => {
    const event = pipelineTraceEventSchema.decode(
      { ...started, payload: { ...started.payload, ...payload } },
      "event"
    );
    if (event.name !== "pipeline.started") throw new Error("Expected pipeline.started");
    return event;
  };

  it("accepts legacy starts and identity-only recordings", () => {
    expect(decode({})).toMatchObject({ name: "pipeline.started", payload: { dryRun: false } });
    expect(
      decode({ definitionIdentity: definition.identity }).payload.definitionSnapshot
    ).toBeUndefined();
  });

  it("rejects unsupported versions, invalid fingerprints, and mismatched snapshots", () => {
    expect(() => decode({ definitionIdentity: { ...definition.identity, version: 2 } })).toThrow(
      "requires identity version 1"
    );
    expect(() =>
      decode({ definitionIdentity: { ...definition.identity, definitionId: "invalid" } })
    ).toThrow("SHA-256");
    expect(() =>
      decode({
        definitionIdentity: { ...definition.identity, implementationVersion: "changed" },
        definitionSnapshot: definition,
      })
    ).toThrow("must match");
  });

  it("bounds the complete snapshot in UTF-8 bytes and list entries", () => {
    const oversized = {
      ...definition,
      targetIds: Array.from({ length: 100 }, () => "界".repeat(1000)),
    };
    expect(() =>
      decode({ definitionIdentity: definition.identity, definitionSnapshot: oversized })
    ).toThrow("262144-byte");
    expect(() =>
      decode({
        definitionIdentity: definition.identity,
        definitionSnapshot: { ...definition, targetIds: Array(4097).fill("a") },
      })
    ).toThrow("4096");
  });
});
