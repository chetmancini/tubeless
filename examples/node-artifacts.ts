import { createSteps, definePipeline } from "tubeless";
import { definePaths, writeJson } from "tubeless/node";

const paths = definePaths({ artifact: "build/artifacts/rows.json" });
const { step } = createSteps<{ rows: readonly string[] }>();

const normalize = step("normalize", {
  description: "Normalize the caller's rows before writing an artifact.",
  run: (_inputs, context) => context.options.rows.map((row) => row.trim().toLowerCase()),
});

const save = step("save", {
  description: "Atomically write the JSON artifact beneath the run's working directory.",
  dependsOn: [normalize],
  dryRun: "skip",
  run: ({ normalize: rows }, context) => {
    const { artifact } = paths(context.cwd);
    writeJson(artifact, rows);
    return artifact;
  },
});

export const NodeArtifactsPipeline = definePipeline({
  id: "node-artifacts",
  steps: [normalize, save],
  targets: [save],
  finalize: (outputs) => ({ rows: outputs.normalize, artifact: outputs.save }),
});
