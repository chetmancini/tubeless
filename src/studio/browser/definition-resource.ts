import { useCallback } from "preact/hooks";
import type { StoredDefinitionSummary } from "../../run-store/run-history.js";
import type { StoredPipelineDefinition } from "../../run-store/run-store.js";
import { useStudioResource, type StudioResource } from "./resource.js";
import type { StudioApi } from "./transport.js";

export function definitionKey(definition: StoredDefinitionSummary): string {
  return JSON.stringify([definition.pipelineId, definition.identity?.definitionId ?? null]);
}

export function useDefinitionResource(
  api: StudioApi | undefined,
  definition: StoredDefinitionSummary | undefined
): StudioResource<StoredPipelineDefinition> {
  const pipelineId = definition?.pipelineId;
  const definitionId = definition?.identity?.definitionId;
  // Legacy observations can replace their graph; a later run can complete an
  // identified definition's truncated snapshot.
  const revision = definitionId ? definition?.runCount : definition?.lastSeenAtMs;
  const load = useCallback(async () => {
    if (!api || !pipelineId) throw new Error("No definition selected.");
    return api.loadDefinition(pipelineId, definitionId);
  }, [api, pipelineId, definitionId, revision]);
  return useStudioResource(api, definition ? definitionKey(definition) : "", load);
}
