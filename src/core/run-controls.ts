import type { PipelineRunControls } from "./pipeline-types.js";

type RunControlFields<TStepId extends string, TTargetId extends string> = Pick<
  PipelineRunControls<TStepId, TTargetId>,
  keyof PipelineRunControls
>;

/** Output persistence is an invocation capability, not an authored child control. */
export function rejectChildOutputObserver(controls: PipelineRunControls | undefined): void {
  if (controls?.outputObserver !== undefined)
    throw new TypeError("outputObserver belongs on a direct pipeline run, not child controls");
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
