import { describe, expect, it } from "vitest";
import {
  STRUCTURED_ERROR_LIMITS as L,
  structuredError,
  projectStructuredErrors,
} from "./structured-error.js";

describe("portable bounded framework error projection", () => {
  it("enforces the final JSON byte bound including escapes, classification and the loss flag", () => {
    const input = {
      message: "\0".repeat(2000),
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      phase: "execution",
      stepId: "test",
      sourceCode: "\0".repeat(120),
      stack: "\0".repeat(4000),
      cause: { message: "nested failure" },
    };
    const error = structuredError(input)!;
    expect(error).toMatchObject({
      code: input.code,
      kind: input.kind,
      phase: input.phase,
      sourceCode: input.sourceCode,
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(error))).toBeLessThanOrEqual(L.bytes);
    expect(error.message.length).toBeLessThan(input.message.length);
    expect(structuredError(JSON.parse(JSON.stringify(error)))).toEqual(error);
  });

  it("retains ordinary nested causes, validation issues and Unicode", () => {
    const error = {
      message: "Failed ü test 😀",
      code: "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
      kind: "validation",
      phase: "execution",
      cause: { message: "underlying cause", name: "Error", sourceCode: "EASSERT" },
      issues: [{ message: "bad input", path: ["field", 2] }],
    };
    expect(structuredError(error)).toEqual(error);
  });

  it("bounds and counts omitted or invalid run errors using one policy", () => {
    const inputs = [null, ...Array.from({ length: 12 }, (_, i) => ({ message: `failure ${i}` }))];
    const errors = projectStructuredErrors(inputs, 3);
    expect(errors.structuredErrors).toHaveLength(L.count - 1);
    expect(errors.omittedStructuredErrors).toBe(inputs.length - errors.structuredErrors.length + 3);
    expect(
      projectStructuredErrors(errors.structuredErrors, errors.omittedStructuredErrors)
    ).toEqual(errors);
    expect(projectStructuredErrors([], Number.MAX_SAFE_INTEGER).omittedStructuredErrors).toBe(
      L.omitted
    );
  });
});
