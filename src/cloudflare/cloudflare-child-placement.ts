import { failExecutionJournal } from "../core/execution-journal.js";
import { JOURNAL_OUTCOME_UNKNOWN } from "../tracing/tracing-constants.js";
import { digestCollectorBody } from "../hosting/collector-protocol.js";
import { createSingleChildTraceProgress } from "../core/child-progress.js";
import type { StoredPipelineEvent } from "../run-store/run-store.js";
import type { ChildPlacement } from "../core/child-placement.js";
import {
  boundedRunnerJson,
  runnerChildControls,
  runnerValue,
  type RunnerJob,
  type RunnerStageResult,
} from "../hosting/runner-protocol.js";
import { abortableSleep, awaitWithAbort, throwIfAborted } from "../utilities/abort.js";
import { withRetry } from "../utilities/retry.js";

export interface RunnerStageObservation {
  readonly result?: RunnerStageResult;
  readonly events: readonly StoredPipelineEvent[];
}

export interface RunnerStageStore {
  enqueueStage(job: RunnerJob & { kind: "stage" }, generation?: number): Promise<void>;
  readStage(launchId: string, id: string, afterId: number): Promise<RunnerStageObservation>;
  cancelStage(launchId: string, id: string, generation?: number): Promise<void>;
}

function canRetryRpc(error: unknown): boolean {
  return (
    error instanceof Error &&
    "retryable" in error &&
    error.retryable === true &&
    !("overloaded" in error && error.overloaded === true)
  );
}

export function placeCloudflareChild(options: {
  readonly definitions: ReadonlyMap<string, string>;
  readonly launchId: string;
  readonly deploymentId: string;
  readonly deadlineAtMs: number;
  readonly generation?: number;
  readonly flush: () => Promise<void>;
  readonly store: () => RunnerStageStore;
}): ChildPlacement {
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
      const { generation } = options;
      if (
        plan.definition?.identity.definitionId !== definitionId ||
        context.parentRunId === undefined
      )
        throw new Error(
          `The deployed local runner definition for ${pipeline.id} does not match this child.`
        );
      const stage = {
        parentRunId: context.parentRunId,
        stepId,
        correlationId: context.correlationId,
        itemKey: context.tracing?.itemKey,
        // The source validates transfer shape. The Bun pipeline owns domain validation.
        input: runnerValue(input, "Remote stage input") as object,
        controls: runnerChildControls(controls),
      };
      if (generation !== undefined && journalPath === undefined)
        failExecutionJournal(context, new Error("A recovered stage requires a journal path."));
      const job = {
        kind: "stage",
        id:
          generation === undefined
            ? crypto.randomUUID()
            : await digestCollectorBody(new TextEncoder().encode(JSON.stringify(journalPath))),
        launchId: options.launchId,
        deploymentId: options.deploymentId,
        pipelineId: pipeline.id,
        definitionId,
        deadlineAtMs: options.deadlineAtMs,
        stage,
      } as const;
      boundedRunnerJson(job, "Remote stage request");
      await options.flush();
      throwIfAborted(context.signal, "Queue remote stage");
      const onProgress = createSingleChildTraceProgress(plan, reportProgress);
      let afterId = -1;
      let delayMs = 500;
      try {
        if (generation === undefined) await options.store().enqueueStage(job);
        else {
          try {
            await withRetry(() => options.store().enqueueStage(job, generation), {
              shouldRetry: canRetryRpc,
              signal: context.signal,
            });
          } catch (error) {
            throwIfAborted(context.signal, "Queue remote stage");
            failExecutionJournal(context, error);
          }
        }
        for (;;) {
          throwIfAborted(context.signal, "Wait for remote stage");
          let observation: RunnerStageObservation;
          try {
            const read = options.store().readStage(job.launchId, job.id, afterId);
            observation = context.signal
              ? await awaitWithAbort(read, context.signal, "Wait for remote stage")
              : await read;
          } catch (error) {
            if (!canRetryRpc(error)) throw error;
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
              if (result.interrupted && generation !== undefined)
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
          await abortableSleep(delayMs, context.signal, "Wait for remote stage");
        }
      } finally {
        if (context.signal?.aborted)
          await options
            .store()
            .cancelStage(job.launchId, job.id, generation)
            .catch(() => {});
      }
    })();
  };
}
