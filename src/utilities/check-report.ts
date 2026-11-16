export {
  STRUCTURED_ERROR_LIMITS,
  structuredError,
  projectStructuredErrors,
  type StructuredError,
  type StructuredErrors,
} from "./structured-error.js";

/** Portable, untrusted check observations. Never execution or deployment authority. */
export const CHECK_REPORT_LIMITS = {
  bytes: 32_768,
  inputBytes: 2_000_000,
  tests: 128,
  failures: 4,
  message: 2000,
  stack: 4000,
  identity: 2048,
} as const;

/** Native outcome observed by the caller, independent of claimed test results. */
export type CheckProcessOutcome =
  | { status: "exited"; exitCode: number; signal: null; outputComplete: boolean }
  | { status: "signalled"; exitCode: null; signal: string; outputComplete: boolean }
  | {
      status: "timed-out" | "cancelled";
      exitCode: number | null;
      signal: string | null;
      outputComplete: boolean;
    }
  | {
      status: "spawn-failed" | "unavailable";
      exitCode: null;
      signal: null;
      outputComplete: boolean;
    };

/** One bounded runner failure; absent location or stack means unavailable. */
export interface CheckFailure {
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  column?: number;
}

/** Identity is [relative file, suite ancestry, title, duplicate ordinal] encoded as JSON. */
export interface CheckTest {
  id: string;
  file: string;
  suite: string[];
  title: string;
  ambiguous: boolean;
  outcome: "passed" | "failed" | "skipped" | "pending" | "todo";
  durationMs?: number;
  line?: number;
  column?: number;
  failures: CheckFailure[];
}

/** Version 1 describes one invocation, not whole-repository coverage. */
export interface CheckReport {
  version: 1;
  tool: { name: "vitest"; version: string };
  context: {
    pipelineId: string;
    runId: string;
    stepId: string;
    attemptId?: string;
    source?: string;
    rawOutputArtifact?: string;
  };
  process: CheckProcessOutcome;
  completeness: "complete" | "incomplete";
  truncated: boolean;
  omittedTests: number;
  tests: CheckTest[];
  /** Collection/setup errors can exist without any failed test. */
  failures: CheckFailure[];
}

/** Missing is distinct from invalid data; incomplete/truncated are valid report properties. */
export type CheckReportResult =
  | { state: "available"; report: CheckReport }
  | { state: "missing" | "malformed" | "unsupported-version" | "oversized" };

/** Conservatively derive completeness; a declared incomplete report is never upgraded. */
export function checkReportCompleteness(
  report: Pick<CheckReport, "completeness" | "truncated" | "omittedTests" | "process" | "tests">
): CheckReport["completeness"] {
  return report.completeness === "incomplete" ||
    report.truncated ||
    report.omittedTests > 0 ||
    !report.process.outputComplete ||
    report.process.status !== "exited" ||
    report.tests.some((test) => test.outcome === "pending")
    ? "incomplete"
    : "complete";
}

/** Decode a service report envelope once, discarding fields outside its state variant. */
export function decodeCheckReportResult(value: unknown): CheckReportResult | undefined {
  const result = object(value);
  if (result.state === "available") {
    try {
      const decoded = readCheckReport(JSON.stringify(result.report));
      return decoded.state === "available" ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  switch (result.state) {
    case "missing":
    case "malformed":
    case "unsupported-version":
    case "oversized":
      return { state: result.state };
    default:
      return undefined;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, max: number = CHECK_REPORT_LIMITS.identity): value is string {
  return typeof value === "string" && value.length <= max;
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function optionalLocation(value: unknown, minimum: number): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= minimum);
}
function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}
function processOutcome(value: unknown): CheckProcessOutcome {
  const p = object(value);
  const exitCode = p.exitCode,
    signal = p.signal,
    outputComplete = p.outputComplete;
  if (
    !(exitCode === null || count(exitCode)) ||
    !(signal === null || text(signal, 120)) ||
    typeof outputComplete !== "boolean" ||
    (exitCode !== null && signal !== null)
  )
    throw new Error("Invalid process outcome");
  switch (p.status) {
    case "exited":
      if (exitCode === null || signal !== null) throw new Error("Invalid process exit");
      return { status: p.status, exitCode, signal, outputComplete };
    case "signalled":
      if (exitCode !== null || !signal) throw new Error("Invalid process signal");
      return { status: p.status, exitCode, signal, outputComplete };
    case "spawn-failed":
    case "unavailable":
      if (exitCode !== null || signal !== null) throw new Error("Unavailable process exit");
      return { status: p.status, exitCode, signal, outputComplete };
    case "timed-out":
    case "cancelled":
      return { status: p.status, exitCode, signal, outputComplete };
    default:
      throw new Error("Unsupported process outcome");
  }
}
function failure(value: unknown): CheckFailure {
  const f = object(value);
  if (
    !text(f.message, CHECK_REPORT_LIMITS.message) ||
    (f.stack !== undefined && !text(f.stack, CHECK_REPORT_LIMITS.stack)) ||
    (f.file !== undefined && !text(f.file)) ||
    !optionalLocation(f.line, 1) ||
    !optionalLocation(f.column, 0)
  )
    throw new Error("Invalid failure");
  return {
    message: f.message,
    ...(f.stack === undefined ? {} : { stack: f.stack as string }),
    ...(f.file === undefined ? {} : { file: f.file as string }),
    ...(f.line === undefined ? {} : { line: f.line as number }),
    ...(f.column === undefined ? {} : { column: f.column as number }),
  };
}
function failures(value: unknown, max: number): CheckFailure[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid failures");
  return value.map(failure);
}

/** Decode bounded JSON, selecting known fields and rejecting unsupported schemas. */
export function readCheckReport(content: string | undefined): CheckReportResult {
  if (content === undefined) return { state: "missing" };
  if (new TextEncoder().encode(content).byteLength > CHECK_REPORT_LIMITS.bytes)
    return { state: "oversized" };
  try {
    const r = object(JSON.parse(content));
    if (r.version !== 1)
      return { state: r.version === undefined ? "malformed" : "unsupported-version" };
    const tool = object(r.tool),
      context = object(r.context);
    const process = processOutcome(r.process);
    if (
      tool.name !== "vitest" ||
      !text(tool.version, 120) ||
      !["pipelineId", "runId", "stepId"].every(
        (key) => text(context[key]) && context[key] !== ""
      ) ||
      !["attemptId", "source", "rawOutputArtifact"].every(
        (key) => context[key] === undefined || text(context[key])
      ) ||
      !["complete", "incomplete"].includes(r.completeness as string) ||
      typeof r.truncated !== "boolean" ||
      !count(r.omittedTests) ||
      !Array.isArray(r.tests) ||
      r.tests.length > CHECK_REPORT_LIMITS.tests
    )
      throw new Error("Invalid report");
    const ids = new Set<string>();
    const tests = r.tests.map((value): CheckTest => {
      const t = object(value);
      if (
        !text(t.id) ||
        !t.id ||
        ids.has(t.id) ||
        !text(t.file) ||
        !t.file ||
        !text(t.title) ||
        !Array.isArray(t.suite) ||
        t.suite.length > 32 ||
        !t.suite.every((s) => text(s)) ||
        typeof t.ambiguous !== "boolean" ||
        !["passed", "failed", "skipped", "pending", "todo"].includes(t.outcome as string) ||
        !optionalNumber(t.durationMs) ||
        !optionalLocation(t.line, 1) ||
        !optionalLocation(t.column, 0)
      )
        throw new Error("Invalid test");
      ids.add(t.id);
      return {
        id: t.id,
        file: t.file,
        title: t.title,
        suite: t.suite as string[],
        ambiguous: t.ambiguous,
        outcome: t.outcome as CheckTest["outcome"],
        ...(t.durationMs === undefined ? {} : { durationMs: t.durationMs as number }),
        ...(t.line === undefined ? {} : { line: t.line as number }),
        ...(t.column === undefined ? {} : { column: t.column as number }),
        failures: failures(t.failures, CHECK_REPORT_LIMITS.failures),
      };
    });
    const report: CheckReport = {
      version: 1,
      tool: { name: "vitest", version: tool.version },
      context: {
        pipelineId: context.pipelineId as string,
        runId: context.runId as string,
        stepId: context.stepId as string,
        ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId as string }),
        ...(context.source === undefined ? {} : { source: context.source as string }),
        ...(context.rawOutputArtifact === undefined
          ? {}
          : { rawOutputArtifact: context.rawOutputArtifact as string }),
      },
      process,
      completeness: r.completeness as CheckReport["completeness"],
      truncated: r.truncated,
      omittedTests: r.omittedTests,
      tests,
      failures: failures(r.failures, 16),
    };
    report.completeness = checkReportCompleteness(report);
    return new TextEncoder().encode(JSON.stringify(report)).byteLength > CHECK_REPORT_LIMITS.bytes
      ? { state: "oversized" }
      : { state: "available", report };
  } catch {
    return { state: "malformed" };
  }
}
