import type { CheckReportResult } from "../../dist/utilities/check-report.js";

export const variants = ["pass", "assertion-failure"] as const;
export type Variant = (typeof variants)[number];
const revisions = {
  pass: {
    commit: "115e87716d640e313e4481ac442a1096a7d0bf69",
    treeSha: "4fcc46d81391f63b1c8be22b2db5f8855c5095f7",
  },
  "assertion-failure": {
    commit: "d49bf983f9b36d5987ed9dd0f87636ef01f9c158",
    treeSha: "a5fad0c320f808b3991870301c91e24134b5bcf2",
  },
};

export function workload(variant: Variant) {
  return {
    id: "portable-node-check-v1" as const,
    variant,
    repository: "chetmancini/tubeless",
    ...revisions[variant],
    lockfileDigest: "o6aigou_MMjFfEGoQYWUPbCeo0pHl3K73p-sP5qJkvo",
    planDigest: "sPrELDQ3XiH-aOApNno0cgz96krMppsK4_iavG71y70",
  };
}

export type Workload = ReturnType<typeof workload>;

export function expectedOutcome(variant: Variant) {
  return variant === "pass" ? "passed" : "assertion-failure";
}

export function checkOutcome(
  status: "completed" | "failed" | "cancelled",
  result: CheckReportResult | undefined
) {
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
