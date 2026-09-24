import { createSteps, definePipeline, requireOutputs } from "tubeless";

const { step } = createSteps<{ lines: readonly string[] }>();

const normalize = step("normalize", {
  description: "Trim and normalize nonblank rows",
  async run(_inputs, context) {
    const rows: string[] = [];
    for (const [index, line] of context.options.lines.entries()) {
      // Yield so Lambda's deadline can interrupt this small, otherwise synchronous job.
      // Real I/O should receive context.signal too.
      await context.sleep(1, context.signal);
      const row = line.trim().toLowerCase();
      if (row) rows.push(row);
      context.reportProgress({ completed: index + 1, total: context.options.lines.length });
    }
    return rows;
  },
});

const deduplicate = step("deduplicate", {
  dependsOn: [normalize],
  run: ({ normalize }, context) => {
    const rows = [...new Set(normalize)];
    context.log.log(`Normalized ${rows.length} distinct rows`);
    return rows;
  },
});

// No AWS imports: use the same pipeline locally through the example project.
export const StepFunctionsPipeline = definePipeline({
  id: "step-functions-normalize",
  implementationVersion: "step-functions-example-v1",
  steps: [normalize, deduplicate],
  finalize: requireOutputs([deduplicate], ({ deduplicate }, context) => ({
    rows: deduplicate,
    count: deduplicate.length,
    runId: context.runId,
    preview: context.dryRun,
  })),
});
