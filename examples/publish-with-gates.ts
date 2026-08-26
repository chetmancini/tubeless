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

const publishArtifact = step("publish-artifact", {
  dependsOn: [buildArtifact],
  optionalDependsOn: [validateArtifact],
  skipAfterFailureOf: [validateArtifact],
  description: "Publish only on real runs, and only after validation has not failed.",
  dryRun: "skip",
  run: ({ "build-artifact": artifact }) => ({
    publishedId: `artifact-${artifact.size}`,
  }),
});

export const PublishPipeline = definePipeline({
  id: "publish",
  steps: [buildArtifact, validateArtifact, publishArtifact],
  finalize: (outputs) => ({
    artifact: outputs["build-artifact"],
    publishedId: outputs["publish-artifact"]?.publishedId,
    valid: outputs["validate-artifact"]?.valid === true,
  }),
});

export async function runPublishDryRunExample() {
  return PublishPipeline.runOrThrow({ source: "release notes", dryRun: true });
}
