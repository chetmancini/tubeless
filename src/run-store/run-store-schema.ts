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
      capabilities: wireArray(id),
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
      calls: wireArray(agentCall),
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
  logs: wireArray(
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
  steps: wireArray(
    wireObject({
      id,
      status: stepStatus,
      outputSource,
      description: wireOptional(text),
      name: wireOptional(text),
      durationMs: wireOptional(number),
      finishedAtMs: wireOptional(number),
      startedAtMs: wireOptional(number),
      nestedPipeline: wireOptional(nestedPipelineSchema),
      remote: wireOptional(remoteSchema),
      progress: wireOptional(progressSchema),
      attempt: wireOptional(
        wireObject({
          attemptId: id,
          outputSource,
          durationMs: wireOptional(number),
          finishedAtMs: wireOptional(number),
          retries: wireArray(positive),
          startedAtMs: number,
          status: wireEnum(["running", "completed", "failed", "cancelled", "skipped"]),
        })
      ),
      artifacts: wireOptional(
        wireArray(
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
  targetIds: wireArray(id),
  steps: wireArray(
    wireObject({
      dependencies: wireArray(id),
      description: wireOptional(text),
      dryRun: text,
      id,
      name: wireOptional(text),
      nestedPipeline: wireOptional(nestedPipelineSchema),
      remote: wireOptional(remoteSchema),
      optionalDependencies: wireArray(id),
      runtimeSkipPossible: wireBoolean(),
      skipAfterFailureOf: wireArray(id),
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
    names: wireArray(text, { maxItems: 3 }),
    message: wireOptional(text),
  }),
});
