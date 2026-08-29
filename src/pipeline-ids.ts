/** Current persisted run-record schema version. */
export const RUN_MODEL_VERSION = 2 as const;

let nextRunSequence = 0;

/** Create a dependency-free opaque ID suitable for a pipeline run record. */
export function createRunId(pipelineId: string): string {
  nextRunSequence += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return random
    ? `${pipelineId}:${random}`
    : `${pipelineId}:${Date.now().toString(36)}:${nextRunSequence.toString(36)}`;
}
