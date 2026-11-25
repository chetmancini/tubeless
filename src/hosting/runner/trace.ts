import type { PipelineRun } from "../../core/pipeline-types.js";
import type { PipelineTraceEvent } from "../../tracing/tracing.js";
import { encodeAttemptBatches, encodeRunnerCompletion } from "../attempt/batch.js";
import { boundHostedEvent } from "../run.js";
import { BatchingTraceExporter } from "../trace-batching.js";

/** Serialize progress and terminal delivery against the same acknowledged sequence. */
export function createRunnerAttempt(options: {
  id: string;
  send(body: Uint8Array): Promise<void>;
  onFailure(error: unknown): void;
}) {
  let sequence = 0;
  const send = async (body: Uint8Array) => {
    await options.send(body);
    sequence++;
  };
  const exporter = new BatchingTraceExporter(
    async (_sequence, events) => {
      for (const body of encodeAttemptBatches(options.id, sequence, events.map(boundHostedEvent)))
        await send(body);
    },
    { maxEvents: 50, maxDelayMs: 250, onFailure: options.onFailure }
  );
  return {
    exporter,
    // The stage runner flushes progress before encoding its terminal batch.
    prepareCompletion(completion: PipelineTraceEvent, report: PipelineRun<unknown>) {
      return encodeRunnerCompletion(options.id, sequence, boundHostedEvent(completion), report);
    },
    send,
  };
}
