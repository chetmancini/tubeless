import { createSteps, defaultPipelineContext, definePipeline } from "tubeless";
import { withRetry } from "tubeless/retry";
import { createJsonTraceExporter } from "tubeless/tracing/json";

interface TracingExampleOptions {
  rows: readonly string[];
}

const step = createSteps<TracingExampleOptions>();
const normalize = step("normalize", {
  run: async (_inputs, context) =>
    withRetry(
      async ({ attempt }) => {
        context.reportAttempt(attempt, { operation: "normalize" });
        return context.options.rows.map((row) => row.trim().toLowerCase());
      },
      { baseDelayMs: 0, maxAttempts: 1 }
    ),
});

export const TracingExamplePipeline = definePipeline({
  id: "tracing-example",
  steps: [normalize],
  finalize: (outputs) => outputs.normalize ?? [],
});

export async function runTracingExample(rows: readonly string[]): Promise<readonly string[]> {
  return TracingExamplePipeline.runOrThrow({ rows }, undefined, {
    ...defaultPipelineContext(),
    tracing: { exporter: createJsonTraceExporter({ log: console }) },
  });
}
