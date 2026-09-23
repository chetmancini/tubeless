import { createSteps, definePipeline, requireOutputs } from "tubeless";

const { step } = createSteps<{ lines: readonly string[] }>();

const normalize = step("normalize", {
  description: "Normalize rows while cooperating with host cancellation",
  async run(_inputs, context) {
    const rows: string[] = [];
    for (const [index, line] of context.options.lines.entries()) {
      // Yield so cancellation can arrive even when this example does only local
      // work. Pass the same signal to fetch or other I/O in a real pipeline.
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

// This module has no Temporal imports and can also run locally or in another host.
export const TemporalPipeline = definePipeline({
  id: "temporal-normalize",
  implementationVersion: "temporal-example-v1",
  steps: [normalize, deduplicate],
  finalize: requireOutputs([deduplicate], ({ deduplicate }, context) => ({
    rows: deduplicate,
    count: deduplicate.length,
    runId: context.runId,
    preview: context.dryRun,
  })),
});
