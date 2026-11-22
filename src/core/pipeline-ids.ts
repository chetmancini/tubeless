/** Current persisted run-record schema version. */
export const RUN_MODEL_VERSION = 2 as const;

/** Create a dependency-free opaque ID suitable for a pipeline run record. */
export function createRunId(pipelineId: string): string {
  return `${pipelineId}:${crypto.randomUUID()}`;
}

/** IDs authored in pipeline definitions may contain any nonblank text. */
export function isAuthoredPipelineId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
