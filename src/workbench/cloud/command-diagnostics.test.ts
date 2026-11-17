import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  readCheckReport,
  structuredError,
  STRUCTURED_ERROR_LIMITS,
} from "../../utilities/check-report.js";
import { runCloud } from "./command.js";
import { parseCliRun } from "./protocol.js";
import { captureIo } from "../workbench.test-support.js";
import { baseRun, fixture, pipeline, service } from "./command.test-support.js";

describe("Cloud structured failure handling", () => {
  it("returns bounded decoded fields rather than the raw service values", async () => {
    const report = JSON.parse(
      await readFile(
        new URL("../../../fixtures/diagnostics/vitest-failure-v1.json", import.meta.url),
        "utf8"
      )
    );
    const error = structuredError({
      message: "\0".repeat(2000),
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      phase: "execution",
      sourceCode: "\0".repeat(120),
    })!;
    const run = parseCliRun({
      ...baseRun,
      steps: [
        {
          id: "test",
          name: "Test",
          status: "failed",
          durationMs: 1,
          dependencies: [],
          error: "failed",
          structuredError: error,
        },
      ],
      diagnostics: {
        version: 1,
        state: "available",
        omitted: 0,
        unknown: true,
        reports: [
          {
            artifact: "test.check-report.json",
            unknown: true,
            result: { state: "available", report: { ...report, unknown: true } },
          },
          {
            artifact: "invalid.check-report.json",
            result: { state: "malformed", report: "x".repeat(100_000) },
          },
        ],
      },
    });
    expect(run.steps[0]?.structuredError).toEqual(error);
    expect(Buffer.byteLength(JSON.stringify(error))).toBeLessThanOrEqual(
      STRUCTURED_ERROR_LIMITS.bytes
    );
    expect(run.diagnostics).toEqual({
      version: 1,
      state: "available",
      omitted: 0,
      reports: [
        { artifact: "test.check-report.json", result: { state: "available", report } },
        { artifact: "invalid.check-report.json", result: { state: "malformed" } },
      ],
    });
  });
  it("keeps the paired report, native exit and framework causes in machine JSON and keeps failure exit status", async () => {
    const result = readCheckReport(
      await readFile(
        new URL("../../../fixtures/diagnostics/vitest-failure-v1.json", import.meta.url),
        "utf8"
      )
    );
    expect(result.state).toBe("available");
    const framework = {
      message: "Vitest exited with code 1",
      code: "TUBELESS_STEP_FAILED",
      kind: "step",
      phase: "execution",
      stepId: "test",
      sourceCode: "NATIVE_EXIT",
      stack: "Error: Vitest exited",
      cause: { message: "assertion failure", sourceCode: "EASSERT" },
    };
    const run = {
      ...baseRun,
      status: "failed" as const,
      error: framework.message,
      structuredErrors: [framework],
      omittedStructuredErrors: 0,
      steps: [
        {
          id: "test",
          name: "Test",
          status: "failed" as const,
          durationMs: 5,
          dependencies: [],
          attemptId: "attempt-1",
          error: framework.message,
          structuredError: framework,
        },
      ],
      nativeCommands: [{ id: "check", exitCode: 1, durationMs: 5 }],
      diagnostics: {
        version: 1 as const,
        state: "available" as const,
        reports: [{ artifact: "vitest.check-report.json", result }],
        omitted: 0,
      },
    };
    expect(parseCliRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
    const io = captureIo(await fixture());
    expect(await runCloud(["run", pipeline.slug, "--json"], io, service({ admission: run }))).toBe(
      6
    );
    const output = JSON.parse(io.output.join(""));
    expect(output.diagnostics).toEqual(run.diagnostics);
    expect(output.steps[0].structuredError).toEqual(framework);
    expect(output.nativeCommands).toEqual(run.nativeCommands);
  });

  it("accepts old string errors and rejects invalid new response shapes", () => {
    expect(parseCliRun({ ...baseRun, error: "old error" }).error).toBe("old error");
    for (const diagnostics of [
      { version: 2, state: "available", reports: [], omitted: 0 },
      {
        version: 1,
        state: "available",
        reports: [
          { artifact: "bad.json", result: { state: "available", report: { version: 99 } } },
        ],
        omitted: 0,
      },
      { version: 1, state: "missing", reports: [], omitted: -1 },
    ])
      expect(() => parseCliRun({ ...baseRun, diagnostics })).toThrow("Invalid Cloud run");
    expect(
      parseCliRun({
        ...baseRun,
        diagnostics: { version: 1, state: "unavailable", reports: [], omitted: 0 },
      }).diagnostics?.state
    ).toBe("unavailable");
  });
});
