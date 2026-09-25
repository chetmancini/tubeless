import { createSteps, definePipeline, requireOutputs } from "tubeless";

const { step } = createSteps<{ lines: readonly string[] }>();

const normalize = step("normalize", {
  description: "Normalize rows and report progress",
  async run(_inputs, context) {
    const rows: string[] = [];
    for (const [index, line] of context.options.lines.entries()) {
      // Cooperate with local caller cancellation. Inngest cancellation does not
      // abort an already executing durable step.
      await context.sleep(0, context.signal);
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

// This module has no Inngest imports and can also run locally or in another host.
export const InngestPipeline = definePipeline({
  id: "inngest-normalize",
  implementationVersion: "inngest-example-v1",
  steps: [normalize, deduplicate],
  finalize: requireOutputs([deduplicate], ({ deduplicate }, context) => ({
    rows: deduplicate,
    count: deduplicate.length,
    runId: context.runId,
    preview: context.dryRun,
  })),
});
