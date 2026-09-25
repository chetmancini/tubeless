import { createDefinitionIdentity } from "../core/pipeline-definition-identity.js";
import { decodePipelineTraceEvent } from "../tracing/tracing-codec.js";
import type { PipelineTraceEvent } from "../tracing/tracing-contracts.js";

/** Validate persisted contents before they enter history or Studio projections. */
export function decodeStoredTraceEvent(value: unknown): PipelineTraceEvent {
  const event = decodePipelineTraceEvent(value);
  if (event.name === "pipeline.started" && event.payload.definitionSnapshot) {
    const snapshot = event.payload.definitionSnapshot;
    const expected = createDefinitionIdentity(snapshot, snapshot.identity.implementationVersion);
    if (snapshot.identity.version !== expected.version) {
      throw new Error("Definition snapshot identity version does not match its contents");
    }
    if (snapshot.identity.structuralFingerprint !== expected.structuralFingerprint) {
      throw new Error("Definition snapshot structural fingerprint does not match its contents");
    }
    if (snapshot.identity.definitionId !== expected.definitionId) {
      throw new Error("Definition snapshot definition ID does not match its contents");
    }
  }
  return event;
}
