import { createSteps, definePipeline } from "tubeless";

interface AuditOptions {
  failLinks?: boolean;
}

const step = createSteps<AuditOptions>();

const checkLinks = step("check-links", {
  description: "Validate links independently",
  run: (_inputs, context) => {
    if (context.options.failLinks) throw new Error("broken links found");
    return { checked: 12 };
  },
});

const checkMetadata = step("check-metadata", {
  description: "Validate metadata independently",
  run: () => ({ checked: 8 }),
});

export const BestEffortAuditPipeline = definePipeline({
  id: "best-effort-audit",
  steps: [checkLinks, checkMetadata],
  finalize: (outputs) => ({
    links: outputs["check-links"],
    metadata: outputs["check-metadata"],
  }),
});

export async function runBestEffortExample() {
  const result = await BestEffortAuditPipeline.run({
    failLinks: true,
    continueOnError: true,
  });

  return {
    errors: result.errors,
    metadataStillCompleted: result.value?.metadata?.checked === 8,
    reports: result.steps,
  };
}
