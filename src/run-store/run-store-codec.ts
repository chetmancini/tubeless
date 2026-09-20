import {
  pipelineDefinitionIdentitySchema,
  pipelineDefinitionSnapshotSchema,
} from "../tracing/tracing-schema.js";

export function isDefinitionIdentity(value: unknown): boolean {
  try {
    pipelineDefinitionIdentitySchema.decode(value, "identity");
    return true;
  } catch {
    return false;
  }
}

export function isDefinitionSnapshot(value: unknown): boolean {
  try {
    pipelineDefinitionSnapshotSchema.decode(value, "snapshot");
    return true;
  } catch {
    return false;
  }
}

import { decodePipelineTraceError } from "../tracing/tracing-codec.js";

/** Validate a projected trace error at the Studio transport boundary. */
export function isPipelineTraceError(value: unknown): boolean {
  try {
    decodePipelineTraceError(value);
    return true;
  } catch {
    return false;
  }
}
