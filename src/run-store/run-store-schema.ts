import { RUN_MODEL_VERSION } from "../core/pipeline-ids.js";
import { artifactMetadataSchema, artifactOperationSchema } from "../tracing/artifact-metadata.js";
import {
  agentLimitsSchema,
  nestedPipelineSchema,
  pipelineDefinitionIdentitySchema,
  pipelineDefinitionSnapshotSchema,
  pipelineTraceErrorSchema,
  progressSchema,
  remoteSchema,
} from "../tracing/tracing-schema.js";
import {
  wireArray,
  wireBoolean,
  wireEnum,
  wireLiteral,
  wireNumber,
  wireObject,
  wireOptional,
  wireString,
  wireTransform,
  type WireSchema,
} from "../tracing/wire-schema.js";
import type { StoredPipelineRun, StoredPipelineDefinition } from "./run-store.js";
import type { StoredRunSummary, StoredDefinitionSummary } from "./run-history.js";

const text = wireString({ allowEmpty: true });
const id = wireString();
const number = wireNumber();
const count = wireNumber({ integer: true, minimum: 0 });
const positive = wireNumber({ integer: true, minimum: 1 });
const status = wireEnum(["running", "completed", "failed", "cancelled"]);
const stepStatus = wireEnum(["planned", "running", "completed", "failed", "cancelled", "skipped"]);
const outputSource = wireOptional(wireEnum(["override", "cache"]));
function array<T>(item: WireSchema<T>): WireSchema<T[]> {
  return wireTransform(wireArray(item), (items) => [...items]);
}
const nested = wireTransform(nestedPipelineSchema, (value) => ({
  ...value,
  stepIds: [...value.stepIds],
}));
const progress = wireTransform(progressSchema, (value) => ({
  ...value,
  details: value.details === undefined ? undefined : [...value.details],
}));
const agentCall = wireObject({
  agentRunId: id,
  turn: positive,
  callId: id,
  tool: id,
  parentAttemptId: id,
});

export const storedPipelineRunSchema: WireSchema<StoredPipelineRun> = wireObject({
  version: wireLiteral(RUN_MODEL_VERSION),
  agent: wireOptional(
    wireObject({
      stepId: id,
      limits: agentLimitsSchema,
      capabilities: array(id),
    })
  ),
  agentTurn: wireOptional(
    wireObject({
      agentRunId: id,
      index: positive,
      decision: wireOptional(wireEnum(["continue", "finish"])),
      stateVersion: wireOptional(count),
      nextStateVersion: wireOptional(count),
      callCount: wireOptional(count),
      callsAdmitted: wireOptional(count),
      calls: array(agentCall),
    })
  ),
  agentCall: wireOptional(agentCall),
  itemKey: wireOptional(text),
  iteration: wireOptional(wireObject({ runId: id, stepId: id, attemptId: id, index: positive })),
  definitionIdentity: wireOptional(pipelineDefinitionIdentitySchema),
  correlationId: wireOptional(text),
  parentRunId: wireOptional(text),
  dryRun: wireBoolean(),
  durationMs: wireOptional(number),
  error: wireOptional(pipelineTraceErrorSchema),
  eventCount: count,
  finishedAtMs: wireOptional(number),
  logCount: count,
  logs: array(
    wireObject({
      attemptId: wireOptional(text),
      id: count,
      level: wireEnum(["error", "log", "warn"]),
      message: text,
      stepId: wireOptional(text),
      timestampMs: number,
    })
  ),
  pipelineId: id,
  runId: id,
  startedAtMs: number,
  status,
  steps: array(
    wireObject({
      id,
      status: stepStatus,
      outputSource,
      description: wireOptional(text),
      name: wireOptional(text),
      durationMs: wireOptional(number),
      finishedAtMs: wireOptional(number),
      startedAtMs: wireOptional(number),
      nestedPipeline: wireOptional(nested),
      remote: wireOptional(remoteSchema),
      progress: wireOptional(progress),
      attempt: wireOptional(
        wireObject({
          attemptId: id,
          outputSource,
          durationMs: wireOptional(number),
          finishedAtMs: wireOptional(number),
          retries: array(positive),
          startedAtMs: number,
          status: wireEnum(["running", "completed", "failed", "cancelled", "skipped"]),
        })
      ),
      artifacts: wireOptional(
        array(
          wireObject({
            artifact: artifactMetadataSchema,
            operation: artifactOperationSchema,
            preview: wireBoolean(),
            attemptId: id,
            timestampMs: number,
          })
        )
      ),
    })
  ),
});

const definitionSummaryShape = {
  identity: wireOptional(pipelineDefinitionIdentitySchema),
  activeRuns: count,
  firstSeenAtMs: number,
  lastSeenAtMs: number,
  pipelineId: id,
  runCount: count,
};
export const storedDefinitionSummarySchema: WireSchema<StoredDefinitionSummary> =
  wireObject(definitionSummaryShape);
export const storedPipelineDefinitionSchema: WireSchema<StoredPipelineDefinition> = wireObject({
  ...definitionSummaryShape,
  snapshot: wireOptional(pipelineDefinitionSnapshotSchema),
  targetIds: array(id),
  steps: array(
    wireObject({
      dependencies: array(id),
      description: wireOptional(text),
      dryRun: text,
      id,
      name: wireOptional(text),
      nestedPipeline: wireOptional(nested),
      remote: wireOptional(remoteSchema),
      optionalDependencies: array(id),
      runtimeSkipPossible: wireBoolean(),
      skipAfterFailureOf: array(id),
    })
  ),
});
export const storedRunSummarySchema: WireSchema<StoredRunSummary> = wireObject({
  runId: id,
  pipelineId: id,
  correlationId: wireOptional(text),
  parentRunId: wireOptional(text),
  startedAtMs: number,
  status,
  dryRun: wireBoolean(),
  durationMs: wireOptional(number),
  eventCount: count,
  subtreeEventCount: count,
  stepCount: count,
  rootRunId: id,
  descendantCount: count,
  subtreeIsRunning: wireBoolean(),
  activity: wireObject({
    count,
    names: wireTransform(wireArray(text, { maxItems: 3 }), (items) => [...items]),
    message: wireOptional(text),
  }),
});
