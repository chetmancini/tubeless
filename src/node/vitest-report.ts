import { relative, resolve, isAbsolute } from "node:path";
import {
  CHECK_REPORT_LIMITS as L,
  readCheckReport,
  checkReportCompleteness,
  type CheckFailure,
  type CheckReport,
  type CheckReportResult,
  type CheckProcessOutcome,
  type CheckTest,
} from "../utilities/check-report.js";

/** Caller supplies actual process observations and invocation identity; no subprocess is launched. */
export interface VitestReportOptions {
  root: string;
  toolVersion: string;
  context: CheckReport["context"];
  process: CheckProcessOutcome;
}

function lastNonFailedTest(tests: readonly CheckTest[]): number {
  for (let index = tests.length - 1; index >= 0; index--)
    if (tests[index].outcome !== "failed") return index;
  return -1;
}

/** Adapt Vitest 5 JSON reporter output, never console text. Retries are final outcomes only. */
export function vitestCheckReport(
  content: string | undefined,
  options: VitestReportOptions
): CheckReportResult {
  if (content === undefined) return { state: "missing" };
  if (!/^5\.\d+\.\d+(?:[-+].*)?$/.test(options.toolVersion))
    return { state: "unsupported-version" };
  if (Buffer.byteLength(content) > L.inputBytes) return { state: "oversized" };
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    if (
      !raw ||
      !Array.isArray(raw.testResults) ||
      !Number.isSafeInteger(raw.numTotalTests) ||
      (raw.numTotalTests as number) < 0 ||
      typeof raw.success !== "boolean"
    )
      return { state: "malformed" };
    let truncated = false,
      observed = 0;
    const tests: CheckTest[] = [],
      failures: CheckFailure[] = [];
    const clip = (s: string, max: number): string => {
      if (s.length > max) truncated = true;
      return s.slice(0, max);
    };
    const detail = (s: string, file: string): CheckFailure => ({
      message: clip(s, L.message),
      stack: clip(s, L.stack),
      file,
    });
    const duplicates = new Map<string, { count: number; retained: CheckTest[] }>();
    for (const file of raw.testResults) {
      if (
        !file ||
        typeof file.name !== "string" ||
        !Array.isArray(file.assertionResults) ||
        typeof file.message !== "string" ||
        !["passed", "failed"].includes(file.status)
      )
        return { state: "malformed" };
      const path = relative(resolve(options.root), resolve(options.root, file.name)).replaceAll(
        "\\",
        "/"
      );
      // Never silently shorten identities or accept paths outside the source root.
      if (!path || path.startsWith("../") || isAbsolute(path) || path.length > L.identity)
        return { state: "malformed" };
      if (file.message && failures.length < 16) failures.push(detail(file.message, path));
      else if (file.message) truncated = true;
      for (const t of file.assertionResults) {
        observed++;
        if (
          !t ||
          typeof t.title !== "string" ||
          !Array.isArray(t.ancestorTitles) ||
          t.ancestorTitles.length > 32 ||
          !t.ancestorTitles.every((s: unknown) => typeof s === "string") ||
          !["passed", "failed", "skipped", "pending", "todo"].includes(t.status) ||
          !(
            t.failureMessages === null ||
            (Array.isArray(t.failureMessages) &&
              t.failureMessages.every((s: unknown) => typeof s === "string"))
          ) ||
          (t.duration != null &&
            (typeof t.duration !== "number" || !Number.isFinite(t.duration) || t.duration < 0)) ||
          (t.location != null &&
            (!Number.isSafeInteger(t.location.line) ||
              t.location.line < 1 ||
              !Number.isSafeInteger(t.location.column) ||
              t.location.column < 0))
        )
          return { state: "malformed" };
        const key = JSON.stringify([path, t.ancestorTitles, t.title]);
        const group = duplicates.get(key) ?? { count: 0, retained: [] };
        const id = JSON.stringify([path, t.ancestorTitles, t.title, group.count]);
        if (id.length > L.identity) return { state: "malformed" };
        for (const previous of group.retained) previous.ambiguous = true;
        group.count++;
        duplicates.set(key, group);
        if (tests.length >= L.tests) {
          truncated = true;
          const replace = t.status === "failed" ? lastNonFailedTest(tests) : -1;
          if (replace < 0) continue;
          tests.splice(replace, 1);
        }
        const test: CheckTest = {
          id,
          file: path,
          suite: t.ancestorTitles,
          title: t.title,
          ambiguous: group.count > 1,
          outcome: t.status,
          ...(t.duration == null ? {} : { durationMs: t.duration }),
          ...(t.location == null ? {} : { line: t.location.line, column: t.location.column }),
          failures: (t.failureMessages ?? [])
            .slice(0, L.failures)
            .map((s: string) => detail(s, path)),
        };
        if ((t.failureMessages?.length ?? 0) > L.failures) truncated = true;
        group.retained.push(test);
        tests.push(test);
      }
    }
    const report: CheckReport = {
      version: 1,
      tool: { name: "vitest", version: options.toolVersion },
      context: options.context,
      process: options.process,
      completeness:
        observed !== raw.numTotalTests ||
        (typeof raw.numPendingTestSuites === "number" && raw.numPendingTestSuites > 0)
          ? "incomplete"
          : "complete",
      truncated,
      omittedTests: Math.max(0, (raw.numTotalTests as number) - tests.length),
      tests,
      failures,
    };
    report.completeness = checkReportCompleteness(report);
    for (const entries of [report.tests, report.failures]) {
      while (Buffer.byteLength(JSON.stringify(report)) > L.bytes && entries.length) {
        const discard = entries === report.tests ? lastNonFailedTest(report.tests) : -1;
        entries.splice(discard < 0 ? entries.length - 1 : discard, 1);
        if (entries === report.tests) report.omittedTests++;
        report.truncated = true;
        report.completeness = "incomplete";
      }
    }
    return readCheckReport(JSON.stringify(report));
  } catch {
    return { state: "malformed" };
  }
}
