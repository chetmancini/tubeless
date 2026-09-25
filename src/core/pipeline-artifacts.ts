import type { ArtifactMetadata } from "../tracing/artifact-metadata.js";
import type { PipelineStepContext } from "./pipeline-types.js";

/** Adapter result: the value flows to dependents; only artifact metadata is recorded. */
export interface ArtifactResult<TValue> {
  readonly value: TValue;
  readonly artifact: ArtifactMetadata;
}

/** Application-owned read boundary. Forward context.signal to cancellable I/O. */
export type ArtifactLoader<TInput, TValue, TOptions extends object = {}> = (
  input: TInput,
  context: PipelineStepContext<TOptions>
) => ArtifactResult<TValue> | Promise<ArtifactResult<TValue>>;

/** Application-owned write boundary returning a typed receipt and separate trace metadata. */
export type ArtifactSaver<TInput, TValue, TOptions extends object = {}> = (
  input: TInput,
  context: PipelineStepContext<TOptions>
) => ArtifactResult<TValue> | Promise<ArtifactResult<TValue>>;
