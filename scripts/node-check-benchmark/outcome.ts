import type { CheckReportResult } from "../../dist/utilities/check-report.js";
import type { Sample } from "./sample.ts";

export function checkOutcome(
  status: "completed" | "failed" | "cancelled",
  result: CheckReportResult | undefined
): Sample["execution"]["outcome"] {
  if (status === "completed") return "passed";
  if (status === "cancelled") return "cancelled";
  if (result?.state !== "available") return "failed";
  const { report } = result;
  if (report.process?.status === "timed-out") return "timed-out";
  if (
    report.completeness === "complete" &&
    report.process?.exitCode === 1 &&
    report.tests.some(
      (test) =>
        test.file === "app.test.js" &&
        test.title === "returns the expected answer" &&
        test.outcome === "failed" &&
        test.failures.some(({ message }) =>
          message.startsWith("AssertionError: expected 41 to be 42")
        )
    )
  )
    return "assertion-failure";
  return "failed";
}
