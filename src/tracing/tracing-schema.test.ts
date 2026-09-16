import { describe, expect, it } from "vitest";
import { PIPELINE_ERROR_CODES } from "../core/pipeline.js";
import { pipelineTraceEventSchemas, pipelineTraceOpenApiSchemas } from "./tracing-schema.js";

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
        properties: {
          id: { minimum: 0, type: "integer" },
          name: { const: name },
          payload: { additionalProperties: false, type: "object" },
        },
        required: expect.arrayContaining(["id", "name", "payload"]),
      });
    }
  });
});
