import { createSteps, definePipeline } from "tubeless";

interface PublishOptions {
  source: string;
}

interface Artifact {
  body: string;
  size: number;
}

const step = createSteps<PublishOptions>();

const buildArtifact = step("build-artifact", {
  description: "Build an artifact that can be validated and published.",
  run: (_inputs, context): Artifact => ({
    body: context.options.source.trim(),
    size: context.options.source.trim().length,
  }),
});

const validateArtifact = step("validate-artifact", {
  dependsOn: [buildArtifact],
  description: "Fail before publishing if the artifact is empty.",
  run: ({ "build-artifact": artifact }) => {
    if (artifact.size === 0) {
      throw new Error("artifact is empty");
    }
    return { valid: true };
  },
});

const checkDiagnostics = step("check-diagnostics", {
  description: "Collect independent diagnostics that can continue after validation failure.",
  run: () => ({ checked: true }),
});

const publishArtifact = step("publish-artifact", {
  dependsOn: [buildArtifact],
  description: "Publish only on real runs, and only after validation has not failed.",
  dryRun: "skip",
  optionalDependsOn: [validateArtifact],
  skipAfterFailureOf: [validateArtifact],
  run: ({ "build-artifact": artifact }) => ({
    publishedId: `artifact-${artifact.size}`,
  }),
});

export const PublishPipeline = definePipeline({
  id: "publish",
  steps: [buildArtifact, validateArtifact, checkDiagnostics, publishArtifact],
  targets: [publishArtifact],
  finalize: (outputs) => ({
    artifact: outputs["build-artifact"],
    diagnostics: outputs["check-diagnostics"],
    publishedId: outputs["publish-artifact"]?.publishedId,
    valid: outputs["validate-artifact"]?.valid === true,
  }),
});

export function runBestEffortPublish(source: string) {
  return PublishPipeline.run({ source }, { continueOnError: true });
}
