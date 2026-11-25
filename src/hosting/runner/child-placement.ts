import { failExecutionJournal } from "../../core/execution-journal.js";
import { JOURNAL_OUTCOME_UNKNOWN } from "../../tracing/tracing-constants.js";
import { sha256Hex } from "../../utilities/sha256.js";
import { createSingleChildTraceProgress } from "../../core/child-progress.js";
import type { StoredPipelineEvent } from "../../run-store/run-store.js";
import type { ChildPlacement } from "../../core/child-placement.js";
import {
  runnerChildControls,
  runnerValue,
  type RunnerStageRequest,
  type RunnerStageResult,
} from "../runner-protocol.js";
import { abortableSleep, awaitWithAbort, throwIfAborted } from "../../utilities/abort.js";
import { withRetry } from "../../utilities/retry.js";

export type RunnerStageObservation = {
  readonly events: readonly StoredPipelineEvent[];
} & (
  | { readonly hasMore: true; readonly result?: never }
  | { readonly hasMore?: false; readonly result?: RunnerStageResult }
);

export interface RunnerStageStore {
  enqueueStage(job: RunnerStageRequest): Promise<void>;
  readStage(launchId: string, id: string, afterId: number): Promise<RunnerStageObservation>;
  cancelStage(launchId: string, id: string): Promise<void>;
}

export function placeRunnerChild(options: {
  readonly definitions: ReadonlyMap<string, string>;
  readonly launchId: string;
  readonly deploymentId: string;
  readonly recover: boolean;
  readonly shouldRetry: (error: unknown) => boolean;
  readonly dispatchAttempts: number;
  readonly interruptedStage: "failed" | "outcome_unknown";
  readonly flush: () => Promise<void>;
  readonly store: RunnerStageStore;
}): ChildPlacement {
  const { store, shouldRetry } = options;
  return ({
    pipeline,
    plan,
    options: input,
    controls,
    context,
    stepId,
    reportProgress,
    journalPath,
  }) => {
    const definitionId = options.definitions.get(pipeline.id);
    if (!definitionId) return undefined;
    return (async () => {
      const recovery = options.recover;
      if (
        plan.definition?.identity.definitionId !== definitionId ||
        context.parentRunId === undefined
      )
        throw new Error(`The deployed definition for ${pipeline.id} does not match this child.`);
      const stage = {
        parentRunId: context.parentRunId,
        stepId,
        correlationId: context.correlationId,
        itemKey: context.tracing?.itemKey,
        // The source validates transfer shape. The destination owns domain validation.
        input: runnerValue(input, "Remote stage input") as object,
        controls: runnerChildControls(controls),
      };
      if (recovery && journalPath === undefined)
        failExecutionJournal(context, new Error("A recovered stage requires a journal path."));
      const job = {
        kind: "stage",
        id: !recovery
          ? crypto.randomUUID()
          : await sha256Hex(new TextEncoder().encode(JSON.stringify(journalPath))),
        launchId: options.launchId,
        deploymentId: options.deploymentId,
        pipelineId: pipeline.id,
        definitionId,
        stage,
      } as const;
      await options.flush();
      throwIfAborted(context.signal, "Queue remote stage");
      const onProgress = createSingleChildTraceProgress(plan, reportProgress);
      let afterId = -1;
      let delayMs = 500;
      try {
        try {
          await withRetry(() => store.enqueueStage(job), {
            maxAttempts: options.dispatchAttempts,
            maxDelayMs: 5_000,
            shouldRetry,
            signal: context.signal,
          });
        } catch (error) {
          throwIfAborted(context.signal, "Queue remote stage");
          if (recovery) failExecutionJournal(context, error);
          throw error;
        }
        for (;;) {
          throwIfAborted(context.signal, "Wait for remote stage");
          let observation: RunnerStageObservation;
          try {
            const read = store.readStage(job.launchId, job.id, afterId);
            observation = context.signal
              ? await awaitWithAbort(read, context.signal, "Wait for remote stage")
              : await read;
          } catch (error) {
            if (!shouldRetry(error)) throw error;
            await abortableSleep(delayMs, context.signal, "Reconnect to Studio");
            delayMs = Math.min(delayMs * 2, 5_000);
            continue;
          }
          for (const event of observation.events) {
            afterId = event.id;
            onProgress(event);
          }
          const { result } = observation;
          if (result) {
            if ("error" in result) {
              if (result.interrupted && options.interruptedStage === "outcome_unknown")
                failExecutionJournal(
                  context,
                  Object.assign(
                    new Error(`Execution ${job.launchId}, stage ${job.id}: ${result.error}`),
                    { code: JOURNAL_OUTCOME_UNKNOWN }
                  )
                );
              throw new Error(result.error);
            }
            return result.report;
          }
          delayMs = 500;
          if (observation.hasMore) continue;
          await abortableSleep(delayMs, context.signal, "Wait for remote stage");
        }
      } finally {
        if (context.signal?.aborted) await store.cancelStage(job.launchId, job.id).catch(() => {});
      }
    })();
  };
}
