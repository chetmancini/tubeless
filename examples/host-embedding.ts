import { createSteps, definePipeline, requireOutputs } from "tubeless";

const step = createSteps<{ lines: readonly string[] }>();
const normalize = step("normalize", {
  description: "Normalize rows within one host-owned invocation",
  run: (_inputs, context) => context.options.lines.map((line) => line.trim()),
});

export const HostedPipeline = definePipeline({
  id: "hosted-import",
  steps: [normalize],
  finalize: requireOutputs([normalize], ({ normalize }, context) => ({
    rows: normalize,
    preview: context.dryRun,
  })),
});

// A queue worker or activity handler supplies these values from its own job
// envelope. Validate external envelopes at the host ingress before calling this.
// The host owns retries, acknowledgements, persistence, and cancellation.
export async function handleHostJob(
  job: {
    runId: string;
    parentRunId: string;
    dryRun: boolean;
    lines: readonly string[];
  },
  signal?: AbortSignal
) {
  // Rejections deliberately escape: a failed/cancelled run must not be acked.
  return HostedPipeline.runOrThrow(
    { lines: job.lines },
    { dryRun: job.dryRun },
    { runId: job.runId, parentRunId: job.parentRunId, signal }
  );
}

export async function runHostEmbeddingExample() {
  return handleHostJob({
    runId: "host-job-42-attempt-1",
    parentRunId: "host-workflow-42",
    dryRun: true,
    lines: [" Alpha ", "Beta"],
  });
}
