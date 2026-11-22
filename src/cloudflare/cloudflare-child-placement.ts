import type { ChildPlacement } from "../core/child-placement.js";
import {
  boundedRunnerJson,
  runnerChildControls,
  runnerValue,
  type RunnerJob,
  type RunnerStageResult,
} from "../hosting/runner-protocol.js";
import { abortableSleep, throwIfAborted } from "../utilities/abort.js";

export interface RunnerStageStore {
  enqueueStage(job: RunnerJob & { kind: "stage" }): Promise<void>;
  readStage(launchId: string, id: string): Promise<RunnerStageResult | undefined>;
  cancelStage(launchId: string, id: string): Promise<void>;
}

export function placeCloudflareChild(options: {
  readonly definitions: ReadonlyMap<string, string>;
  readonly launchId: string;
  readonly deploymentId: string;
  readonly deadlineAtMs: number;
  readonly flush: () => Promise<void>;
  readonly store: () => RunnerStageStore;
}): ChildPlacement {
  return ({ pipeline, plan, options: input, controls, context, stepId }) => {
    const definitionId = options.definitions.get(pipeline.id);
    if (!definitionId) return undefined;
    return (async () => {
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
      const job = {
        kind: "stage",
        id: crypto.randomUUID(),
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
      const store = options.store();
      await store.enqueueStage(job);
      try {
        for (;;) {
          throwIfAborted(context.signal, "Wait for remote stage");
          const result = await store.readStage(job.launchId, job.id);
          if (result) {
            if ("error" in result) throw new Error(result.error);
            return result.report;
          }
          await abortableSleep(500, context.signal, "Wait for remote stage");
        }
      } finally {
        if (context.signal?.aborted) await store.cancelStage(job.launchId, job.id).catch(() => {});
      }
    })();
  };
}
