import { pipelineDiagnostic } from "./pipeline-errors.js";
import type { PipelineError, PipelineRunControls } from "./pipeline-types.js";

type RunControlFields<TStepId extends string, TTargetId extends string> = Pick<
  PipelineRunControls<TStepId, TTargetId>,
  keyof PipelineRunControls
>;

/** Output recovery belongs to a direct invocation, not authored child policy. */
export function rejectChildOutputRecovery(controls: PipelineRunControls | undefined): void {
  if (controls?.outputObserver !== undefined || controls?.suppliedOutputs !== undefined)
    throw new TypeError("Output recovery belongs on a direct pipeline run, not child controls");
}

/** Admit invocation-only capabilities without adding them to persisted graph controls. */
export function prepareRunControls<TStepId extends string, TTargetId extends string>(
  controls: PipelineRunControls<TStepId, TTargetId>
): { controls: PipelineRunControls<TStepId, TTargetId>; errors: PipelineError[] } {
  const snapshot = snapshotRunControls(controls);
  const errors: PipelineError[] = [];
  if (controls.suppliedOutputs !== undefined) {
    try {
      const supplied = controls.suppliedOutputs;
      if (typeof supplied.get !== "function" || typeof supplied.has !== "function")
        throw new TypeError("Expected a readable map");
      const entries = new Map(supplied);
      for (const value of entries.values()) {
        if (
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          "then" in value &&
          typeof value.then === "function"
        )
          throw new TypeError("Expected resolved values");
      }
      snapshot.suppliedOutputs = entries;
    } catch {
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID",
          "planning",
          "validation",
          "suppliedOutputs must be a readable map of resolved values"
        )
      );
    }
  }
  const observer = controls.outputObserver;
  if (observer !== undefined) {
    if (
      observer !== null &&
      typeof observer === "object" &&
      "encode" in observer &&
      typeof observer.encode === "function" &&
      "write" in observer &&
      typeof observer.write === "function"
    ) {
      snapshot.outputObserver = Object.freeze({
        encode: observer.encode.bind(observer),
        write: observer.write.bind(observer),
      });
    } else {
      errors.push(
        pipelineDiagnostic(
          "TUBELESS_RUN_OUTPUT_RECOVERY_INVALID",
          "planning",
          "validation",
          "outputObserver requires encode and write callbacks"
        )
      );
    }
  }
  return { controls: snapshot, errors };
}

export function snapshotRunControls<TStepId extends string, TTargetId extends string>(
  controls?: PipelineRunControls<TStepId, TTargetId>
): PipelineRunControls<TStepId, TTargetId>;
export function snapshotRunControls<TStepId extends string, TTargetId extends string>(
  controls: RunControlFields<TStepId, TTargetId> | undefined
): RunControlFields<TStepId, TTargetId>;
export function snapshotRunControls<TStepId extends string, TTargetId extends string>(
  controls: RunControlFields<TStepId, TTargetId> = {}
): RunControlFields<TStepId, TTargetId> {
  const { cache, continueOnError, dryRun, maxConcurrency, stepIds, targets } = controls;
  const snapshot: RunControlFields<TStepId, TTargetId> = {};
  // Persisted definition hashes depend on this property insertion order.
  if (cache !== undefined) snapshot.cache = cache;
  if (dryRun !== undefined) snapshot.dryRun = dryRun;
  if (continueOnError !== undefined) snapshot.continueOnError = continueOnError;
  if (maxConcurrency !== undefined) snapshot.maxConcurrency = maxConcurrency;
  if (targets !== undefined) snapshot.targets = [...targets];
  if (stepIds !== undefined) snapshot.stepIds = [...stepIds];
  return snapshot;
}
