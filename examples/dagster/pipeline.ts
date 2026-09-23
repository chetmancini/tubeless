import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createSteps, definePipeline, type PipelineStepContext } from "tubeless";
import { writeJson } from "tubeless/node";

interface DatasetOptions {
  lines: readonly string[];
  outputPath: string;
}

const { step } = createSteps<DatasetOptions>();
const normalize = step("normalize", {
  description: "Normalize and deduplicate dataset rows",
  async run(_inputs, context) {
    const rows = new Set<string>();
    for (const [index, line] of context.options.lines.entries()) {
      await context.sleep(1, context.signal); // Yield for cooperative host cancellation.
      const row = line.trim().toLowerCase();
      if (row) rows.add(row);
      context.reportProgress({ completed: index + 1, total: context.options.lines.length });
    }
    return [...rows];
  },
});
const validate = step("validate", {
  dependsOn: [normalize],
  run: ({ normalize }) => {
    if (normalize.length === 0)
      throw new Error("The dataset must contain at least one nonblank row");
    return normalize;
  },
});

function describeArtifact(rows: readonly string[], context: PipelineStepContext<DatasetOptions>) {
  return {
    path: resolve(context.cwd, context.options.outputPath),
    rowCount: rows.length,
    // Content identity, independent of host attempt and Tubeless run ID.
    dataVersion: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    runId: context.runId,
    preview: context.dryRun,
  };
}

const publish = step("publish", {
  dependsOn: [validate],
  run: ({ validate: rows }, context) => {
    const artifact = describeArtifact(rows, context);
    writeJson(artifact.path, { rows });
    context.log.log(`Wrote ${artifact.rowCount} rows to ${artifact.path}`);
    return artifact;
  },
  dryRun: ({ validate: rows }, context) => describeArtifact(rows, context),
});

// No Dagster imports: the same pipeline also runs from the local project/CLI.
export const DagsterPipeline = definePipeline({
  id: "dagster-dataset",
  implementationVersion: "dagster-example-v1",
  steps: [normalize, validate, publish],
  finalize: publish,
});
