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

import { decodePipelineTraceError, decodePipelineTraceEvent } from "../tracing/tracing-codec.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a projected trace error at the Studio transport boundary. */
export function isPipelineTraceError(value: unknown): boolean {
  try {
    decodePipelineTraceError(value);
    return true;
  } catch {
    return false;
  }
}

/** Validate a stored event, including its store-local sequence id. */
export function isStoredPipelineEvent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 0
  ) {
    return false;
  }
  try {
    decodePipelineTraceEvent(value);
    return true;
  } catch {
    return false;
  }
}
