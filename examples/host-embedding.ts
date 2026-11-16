import {
  createSteps,
  definePipeline,
  requireOutputs,
  type PipelineExecutionJournal,
} from "tubeless";

const { step } = createSteps<{ lines: readonly string[] }>();
const normalize = step("normalize", {
  description: "Normalize rows within one host-owned invocation",
  run: (_inputs, context) => context.options.lines.map((line) => line.trim()),
});

export const HostedPipeline = definePipeline({
  id: "hosted-import",
  implementationVersion: "1",
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
    correlationId: string;
    parentRunId?: string;
    dryRun: boolean;
    lines: readonly string[];
  },
  signal?: AbortSignal,
  executionJournal?: PipelineExecutionJournal
) {
  // Rejections deliberately escape: a failed/cancelled run must not be acked.
  return HostedPipeline.runOrThrow(
    { lines: job.lines },
    { dryRun: job.dryRun },
    { correlationId: job.correlationId, parentRunId: job.parentRunId, signal, executionJournal }
  );
}

// A recovering host supplies a fenced journal bound to the same logical job key.
// Recreate it against retained storage, then call handleHostJob with unchanged
// inputs. Acknowledged outputs restore without running normalize again; run IDs
// remain fresh. Incomplete ordinary intents stop for reconciliation. Correlation
// IDs alone do not recover work. See docs/execution-journal.md for adapter duties.

export async function runHostEmbeddingExample() {
  return handleHostJob({
    correlationId: "host-job-42",
    dryRun: true,
    lines: [" Alpha ", "Beta"],
  });
}
