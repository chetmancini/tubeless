import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readCheckReport,
  decodeCheckReportResult,
  type CheckReport,
} from "../utilities/check-report.js";
import { decodePipelineTraceEvent } from "./tracing-codec.js";

describe("paired portable failure fixtures", () => {
  it("derives incompleteness for pending tests and unavailable process observations", () => {
    const content = readFileSync(
      new URL("../../fixtures/diagnostics/vitest-failure-v1.json", import.meta.url),
      "utf8"
    );
    for (const change of [
      (report: CheckReport) => {
        report.tests[0].outcome = "pending";
      },
      (report: CheckReport) => {
        report.process = {
          status: "unavailable",
          exitCode: null,
          signal: null,
          outputComplete: false,
        };
      },
      (report: CheckReport) => {
        report.process.outputComplete = false;
      },
      (report: CheckReport) => {
        report.truncated = true;
        report.omittedTests = 2;
      },
    ]) {
      const report = JSON.parse(content);
      change(report);
      expect(readCheckReport(JSON.stringify(report))).toMatchObject({
        state: "available",
        report: { completeness: "incomplete" },
      });
    }
    const contradictory = JSON.parse(content);
    contradictory.process = {
      status: "unavailable",
      exitCode: 0,
      signal: "SIGTERM",
      outputComplete: false,
    };
    expect(readCheckReport(JSON.stringify(contradictory))).toEqual({ state: "malformed" });
  });

  it("selects only fields allowed by the result envelope variant", () => {
    const report = JSON.parse(
      readFileSync(
        new URL("../../fixtures/diagnostics/vitest-failure-v1.json", import.meta.url),
        "utf8"
      )
    );
    expect(
      decodeCheckReportResult({
        state: "available",
        report: { ...report, unknown: true },
        unknown: true,
      })
    ).toEqual({ state: "available", report });
    expect(decodeCheckReportResult({ state: "malformed", report: "x".repeat(100_000) })).toEqual({
      state: "malformed",
    });
    expect(
      decodeCheckReportResult({ state: "available", report: { version: 99 } })
    ).toBeUndefined();
  });
  it("decodes the same report consumed by Cloud", () => {
    const content = readFileSync(
      new URL("../../fixtures/diagnostics/vitest-failure-v1.json", import.meta.url),
      "utf8"
    );
    const result = readCheckReport(content);
    expect(result).toEqual({ state: "available", report: JSON.parse(content) });
  });
  it("preserves classification and nested causes through the existing trace codec", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../fixtures/diagnostics/framework-failure-v3.json", import.meta.url),
        "utf8"
      )
    );
    const events = fixture.events.map((value: unknown) => decodePipelineTraceEvent(value));
    const failed = events.find((event: { name: string }) => event.name === "step.failed");
    expect({ ...failed.error, stepId: failed.stepId }).toEqual(fixture.run.errors[0]);
    expect(failed.error).toMatchObject({
      code: "TUBELESS_STEP_FAILED",
      sourceCode: "NATIVE_EXIT",
      cause: { sourceCode: "EASSERT" },
    });
  });
});
