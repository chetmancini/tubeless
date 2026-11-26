import {
  checkReportCompleteness,
  type CheckReportResult,
} from "../../dist/utilities/check-report.js";

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

export const controlId = "portable-node-check-v1";
const repository = "chetmancini/tubeless";

export function workload(variant: Variant) {
  return {
    id: controlId as typeof controlId,
    variant,
    repository,
    ...revisions[variant],
    lockfileDigest: "o6aigou_MMjFfEGoQYWUPbCeo0pHl3K73p-sP5qJkvo",
    planDigest: "sPrELDQ3XiH-aOApNno0cgz96krMppsK4_iavG71y70",
  };
}

const representativeWorkloads = [
  {
    id: "vitepress-docs-v1",
    commit: "40d9273a74c36cc69c848827641c08992fb74bee",
    treeSha: "bb31ab12efb7971bc3f074f7be2c5cffbb2854cd",
    lockfileDigest: "l5pRMLCS7CMSdYAolyEwaeUaRDXMv8isFaHVI2h-49M",
    planDigest: "g50eExgXIvjF69dkB3T8zdQmPD3O1lXf_5l0QXPlHMA",
    test: { file: "docs-build.test.js", title: "renders the upstream VitePress guide" },
  },
  {
    id: "esbuild-source-map-v1",
    commit: "ed5c9fee3590a4452c5f0e570c2520af4965b4ed",
    treeSha: "33b7a2ee66d9ecccc00b7073b4359e7ed7e7bc77",
    lockfileDigest: "kW8NqiSb2vsgadMEZkGbUoLyqPXHwUXMVwtYrgpoYfw",
    planDigest: "8fpNpcEvoXCXJBREmTRMHmKuewEm_vbBQS9chxf83sI",
    test: { file: "source-map.test.mjs", title: "passes upstream esbuild source-map verification" },
  },
] as const;

export const workloadIds = [controlId, ...representativeWorkloads.map(({ id }) => id)] as const;
type WorkloadId = (typeof workloadIds)[number];
export type Workload = Omit<ReturnType<typeof workload>, "id"> & { id: WorkloadId };

export function selectWorkload(id: string, variant: string): Workload | undefined {
  const selected = variants.find((option) => option === variant);
  if (!selected) return;
  if (id === controlId) return workload(selected);
  if (selected !== "pass") return;
  const representative = representativeWorkloads.find((definition) => definition.id === id);
  if (!representative) return;
  const { test: _test, ...identity } = representative;
  return { ...identity, repository, variant: selected };
}

export function expectedOutcome(variant: Variant) {
  return variant === "pass" ? "passed" : "assertion-failure";
}

export function checkOutcome(
  identity: Workload,
  status: "completed" | "failed" | "cancelled",
  result: CheckReportResult | undefined
) {
  const representative = representativeWorkloads.find(({ id }) => id === identity.id);
  if (status === "completed" && !representative) return "passed";
  if (status === "cancelled") return "cancelled";
  if (result?.state !== "available") return "failed";
  const { report } = result;
  if (report.process?.status === "timed-out") return "timed-out";
  if (representative) {
    const [test] = report.tests;
    return status === "completed" &&
      checkReportCompleteness(report) === "complete" &&
      report.process.exitCode === 0 &&
      report.context.stepId === "test" &&
      report.failures.length === 0 &&
      report.tests.length === 1 &&
      test?.file === representative.test.file &&
      test.title === representative.test.title &&
      !test.ambiguous &&
      test.outcome === "passed" &&
      test.failures.length === 0
      ? "passed"
      : "failed";
  }
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
