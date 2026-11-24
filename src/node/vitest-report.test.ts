import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { vitestCheckReport } from "./vitest-report.js";
import {
  CHECK_REPORT_LIMITS as L,
  readCheckReport,
  type CheckProcessOutcome,
} from "../utilities/check-report.js";

const options = {
  root: process.cwd(),
  toolVersion: "5.1.0",
  context: {
    pipelineId: "check",
    runId: "fixture-run",
    stepId: "test",
    attemptId: "attempt-1",
    source: "fixture-sha",
    rawOutputArtifact: "vitest.json",
  },
  process: { status: "exited" as const, exitCode: 1, signal: null, outputComplete: true },
};
const raw = (extra: object = {}) =>
  JSON.stringify({
    numTotalTests: 1,
    success: false,
    testResults: [
      {
        name: join(options.root, "test/ü.spec.ts"),
        status: "failed",
        message: "",
        assertionResults: [
          {
            title: "fails",
            ancestorTitles: ["suite"],
            status: "failed",
            failureMessages: ["expected 4 to be 5"],
            location: { line: 3, column: 2 },
          },
        ],
      },
    ],
    ...extra,
  });

describe("optional Vitest structured adapter", () => {
  it("reproduces the paired Cloud fixture from the actual runner JSON", async () => {
    const expected = JSON.parse(
      await readFile(
        new URL("../../fixtures/diagnostics/vitest-failure-v1.json", import.meta.url),
        "utf8"
      )
    );
    const content = await readFile(
      new URL("../../fixtures/diagnostics/vitest-json-v5.json", import.meta.url),
      "utf8"
    );
    expect(
      vitestCheckReport(content, {
        root: "/fixture",
        toolVersion: expected.tool.version,
        context: expected.context,
        process: expected.process,
      })
    ).toEqual({ state: "available", report: expected });
  });
  it("runs a controlled failure with the real JSON reporter, independent of console output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tubeless-vitest-"));
    try {
      const output = join(directory, "report.json");
      const child = spawn(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          "fixtures/diagnostics/vitest/vitest.config.ts",
          "--reporter=json",
          `--outputFile=${output}`,
        ],
        { stdio: "ignore" }
      );
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      expect(exitCode).toBe(1);
      if (exitCode !== 1) throw new Error("The controlled fixture must exit with code 1.");
      const result = vitestCheckReport(await readFile(output, "utf8"), {
        ...options,
        process: { ...options.process, exitCode },
      });
      expect(result.state).toBe("available");
      if (result.state !== "available") throw new Error(result.state);
      expect(result.report.completeness).toBe("complete");
      const failed = result.report.tests.find((test) => test.outcome === "failed")!;
      expect(failed).toMatchObject({
        file: "fixtures/diagnostics/vitest/failure.spec.ts",
        title: "reports the expected value",
        line: 4,
      });
      expect(failed.failures[0]?.message).toContain("expected 4 to be 5");
      expect(failed.durationMs).toBeGreaterThanOrEqual(0);
      expect(
        result.report.tests.filter((t) => t.title === "duplicate").every((t) => t.ambiguous)
      ).toBe(true);
      expect(new Set(result.report.tests.map((t) => t.id)).size).toBe(9);
      expect(result.report.tests.find((t) => t.title === "retried")?.outcome).toBe("passed");
      expect(readCheckReport(JSON.stringify(result.report))).toEqual(result);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("distinguishes missing, malformed, oversized, unsupported and incomplete reports", () => {
    expect(vitestCheckReport(undefined, options).state).toBe("missing");
    expect(
      vitestCheckReport(undefined, { ...options, process: { ...options.process, exitCode: 0 } })
        .state
    ).toBe("missing");
    expect(vitestCheckReport("{", options).state).toBe("malformed");
    expect(vitestCheckReport(" ".repeat(L.inputBytes + 1), options).state).toBe("oversized");
    expect(vitestCheckReport(raw(), { ...options, toolVersion: "6.0.0" }).state).toBe(
      "unsupported-version"
    );
    expect(readCheckReport('{"version":2}').state).toBe("unsupported-version");
    expect(readCheckReport(" ".repeat(L.bytes + 1)).state).toBe("oversized");
    const result = vitestCheckReport(raw({ numTotalTests: 2 }), options);
    expect(result).toMatchObject({
      state: "available",
      report: { completeness: "incomplete", omittedTests: 1 },
    });
    expect(
      vitestCheckReport(raw(), {
        ...options,
        process: { ...options.process, outputComplete: false },
      })
    ).toMatchObject({ report: { completeness: "incomplete" } });
  });

  it("bounds hostile details and reports omissions instead of silently clipping identity", () => {
    const input = JSON.parse(raw());
    input.testResults[0].assertionResults[0].failureMessages = ["\u001b[31m" + "ü".repeat(4500)];
    input.testResults[0].assertionResults = Array.from({ length: 200 }, (_, i) => ({
      ...input.testResults[0].assertionResults[0],
      title: `test ${i}`,
    }));
    input.numTotalTests = 200;
    const result = vitestCheckReport(JSON.stringify(input), options);
    expect(result).toMatchObject({
      state: "available",
      report: { completeness: "incomplete", truncated: true },
    });
    if (result.state !== "available") throw new Error(result.state);
    expect(result.report.omittedTests).toBe(200 - result.report.tests.length);
    expect(Buffer.byteLength(JSON.stringify(result.report))).toBeLessThanOrEqual(L.bytes);
  });

  it.each(["../outside.spec.ts", resolve(options.root, "../outside.spec.ts")])(
    "rejects report paths outside the source root (%s)",
    (path) => {
      const input = JSON.parse(raw());
      input.testResults[0].name = path;
      expect(vitestCheckReport(JSON.stringify(input), options).state).toBe("malformed");
    }
  );

  it.each([
    ["test-count", L.tests, 0],
    ["byte", 32, 700],
  ] as const)("retains a late failed test when applying the %s limit", (_, count, padding) => {
    const input = JSON.parse(raw());
    const failed = input.testResults[0].assertionResults[0];
    const passing = Array.from({ length: count }, (_, i) => ({
      ...failed,
      title: `passes ${i} ${"x".repeat(padding)}`,
      status: "passed",
      failureMessages: [],
    }));
    input.testResults[0].assertionResults = [...passing, failed];
    input.numTotalTests = count + 1;
    const result = vitestCheckReport(JSON.stringify(input), options);
    expect(result).toMatchObject({
      state: "available",
      report: { completeness: "incomplete", truncated: true },
    });
    if (result.state !== "available") throw new Error(result.state);
    expect(result.report.tests.filter((test) => test.outcome === "failed")).toEqual([
      expect.objectContaining({
        id: JSON.stringify(["test/ü.spec.ts", ["suite"], "fails", 0]),
        title: "fails",
        line: 3,
        column: 2,
        failures: [expect.objectContaining({ message: "expected 4 to be 5" })],
      }),
    ]);
    expect(result.report.tests.length).toBeLessThanOrEqual(L.tests);
    expect(result.report.omittedTests).toBe(input.numTotalTests - result.report.tests.length);
    expect(result.report.omittedTests).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.report))).toBeLessThanOrEqual(L.bytes);
  });

  it("keeps process failure independent of passing claims and unavailable timing", () => {
    const input = JSON.parse(raw());
    input.success = true;
    input.testResults[0].status = "passed";
    input.testResults[0].assertionResults[0].status = "passed";
    const outcomes: CheckProcessOutcome[] = [
      { status: "exited", exitCode: 2, signal: null, outputComplete: true },
      { status: "signalled", exitCode: null, signal: "SIGTERM", outputComplete: true },
      { status: "timed-out", exitCode: null, signal: null, outputComplete: false },
      { status: "cancelled", exitCode: null, signal: null, outputComplete: false },
      { status: "spawn-failed", exitCode: null, signal: null, outputComplete: false },
      { status: "unavailable", exitCode: null, signal: null, outputComplete: false },
    ];
    for (const process of outcomes) {
      const { status } = process;
      const result = vitestCheckReport(JSON.stringify(input), { ...options, process });
      expect(result).toMatchObject({
        state: "available",
        report: { process: { status }, tests: [{ outcome: "passed" }] },
      });
      if (result.state === "available")
        expect(result.report.tests[0]).not.toHaveProperty("durationMs");
    }
  });
});
