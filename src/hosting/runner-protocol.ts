import { encodePlainJson } from "../utilities/plain-json.js";

import { isAuthoredPipelineId, RUN_MODEL_VERSION } from "../core/pipeline-ids.js";
import type {
  PipelineChildRunControls,
  PipelineRun,
  PipelineRunControls,
} from "../core/pipeline-types.js";
import { isJsonObject } from "../utilities/canonical-json.js";
import { isStepCachePolicy } from "../tracing/tracing-constants.js";
import {
  pipelineDefinitionIdentitySchema,
  pipelineTraceErrorSchema,
  PIPELINE_STEP_SKIP_REASONS,
  stepOutputSourceSchema,
} from "../tracing/tracing-schema.js";
import {
  wireArray,
  wireBoolean,
  wireDiscriminatedUnion,
  wireEnum,
  wireLiteral,
  wireNumber,
  wireObject,
  wireOptional,
  wireRefine,
  wireString,
} from "../tracing/wire-schema.js";
import { isLaunchIdentifier } from "../utilities/launch-identifier.js";
import type { RunJob } from "./run-contract.js";

export const RUNNER_PATH = "/api/runner/v1";
export const RUNNER_VALUE_BYTES = 65_536;
export const RUNNER_REPLY_BYTES = RUNNER_VALUE_BYTES + 2_048;
export const MAX_RUNNER_MANIFEST_PIPELINES = 200;
export const RUNNER_LEASE_MS = 15_000;
export const RUNNER_HEARTBEAT_MS = 2_000;
export const RUNNER_DRAIN_MS = 5_000;
export const RUNNER_INTERRUPTED =
  "The local runner lost its claim. The attempt was interrupted and may have performed effects.";

interface RunnerJobIdentity {
  readonly id: string;
  readonly launchId: string;
  readonly deploymentId: string;
  readonly pipelineId: string;
  readonly definitionId: string;
}

export interface RunnerStageInput {
  readonly parentRunId: string;
  readonly stepId: string;
  readonly correlationId?: string;
  readonly itemKey?: string;
  readonly input: object;
  readonly controls: PipelineChildRunControls;
}

export type RunnerJob = RunnerJobIdentity &
  (
    | { readonly kind: "root"; readonly run: RunJob }
    | { readonly kind: "stage"; readonly stage: RunnerStageInput; readonly deadlineAtMs: number }
  );

export type RunnerClaim = {
  readonly job: RunnerJob;
  readonly token: string;
  readonly remainingMs: number;
};

export type RunnerStageResult =
  | { readonly report: PipelineRun<unknown> }
  | { readonly error: string; readonly interrupted?: true };

/** Encode an authored project ID as a safe HTTP header value. */
export function runnerProjectHeader(projectId: string): string {
  return encodeURIComponent(JSON.stringify(projectId));
}

export function parseRunnerManifest(value: unknown): ReadonlyMap<string, string> {
  if (!isJsonObject(value)) throw new TypeError("Invalid runner manifest.");
  const entries = Object.entries(value);
  if (
    entries.length > MAX_RUNNER_MANIFEST_PIPELINES ||
    entries.some(([id, definition]) => !isAuthoredPipelineId(id) || !isLaunchIdentifier(definition))
  )
    throw new TypeError("Invalid runner manifest.");
  return new Map(entries as [string, string][]);
}

export function decodeRunnerClaim(
  value: unknown,
  deploymentId: string,
  manifest: Readonly<Record<string, string>>
): RunnerClaim {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.job) ||
    !isLaunchIdentifier(value.token) ||
    typeof value.remainingMs !== "number" ||
    !Number.isSafeInteger(value.remainingMs) ||
    value.remainingMs < 1 ||
    !(value.job.kind === "root" || value.job.kind === "stage") ||
    value.job.deploymentId !== deploymentId ||
    !isLaunchIdentifier(value.job.id) ||
    !isLaunchIdentifier(value.job.launchId) ||
    !isAuthoredPipelineId(value.job.pipelineId) ||
    !Object.hasOwn(manifest, value.job.pipelineId) ||
    value.job.definitionId !== manifest[value.job.pipelineId]
  )
    throw new Error("The Worker returned an incompatible runner claim.");
  // The authenticated host supplies the pinned job; execution validates the command inputs.
  return value as unknown as RunnerClaim;
}

export function boundedRunnerJson(value: unknown, label: string): string {
  const text = JSON.stringify(value);
  if (text === undefined || new TextEncoder().encode(text).byteLength > RUNNER_VALUE_BYTES)
    throw new TypeError(`${label} must fit within 64 KiB.`);
  return text;
}

const authoredId = wireRefine(wireString(), (value, path) => {
  if (!isAuthoredPipelineId(value)) throw new TypeError(`${path} must not be blank.`);
});
// Core derives trace run and attempt IDs from authored names. Only lease IDs are ASCII.
const traceId = wireString();
const text = wireOptional(wireString({ allowEmpty: true }));
const time = wireNumber();
const optionalTime = wireOptional(time);
const stepShape = {
  id: authoredId,
  name: text,
  description: text,
  finishedAtMs: time,
  startedAtMs: optionalTime,
  attemptId: wireOptional(traceId),
  outputSource: wireOptional(stepOutputSourceSchema),
};
const startedStep = { ...stepShape, startedAtMs: time, attemptId: traceId };
const stepReport = wireDiscriminatedUnion("status", {
  completed: wireObject({ ...startedStep, status: wireLiteral("completed") }),
  failed: wireObject({
    ...startedStep,
    status: wireLiteral("failed"),
    error: pipelineTraceErrorSchema,
  }),
  cancelled: wireObject({
    ...stepShape,
    status: wireLiteral("cancelled"),
    error: pipelineTraceErrorSchema,
  }),
  skipped: wireObject({
    ...stepShape,
    status: wireLiteral("skipped"),
    reason: wireEnum(PIPELINE_STEP_SKIP_REASONS),
    message: text,
    dependencyId: wireOptional(authoredId),
  }),
});
const stageReport = wireObject({
  version: wireLiteral(RUN_MODEL_VERSION),
  pipelineId: authoredId,
  runId: traceId,
  parentRunId: traceId,
  correlationId: text,
  dryRun: wireBoolean(),
  finalized: wireBoolean(),
  status: wireEnum(["completed", "failed", "cancelled"]),
  startedAtMs: time,
  finishedAtMs: time,
  definitionIdentity: pipelineDefinitionIdentitySchema,
  errors: wireArray(pipelineTraceErrorSchema),
  steps: wireArray(stepReport),
});

export function decodeRunnerReport(value: unknown): PipelineRun<unknown> {
  try {
    if (!isJsonObject(value)) throw new TypeError();
    const { finalized, steps, ...identity } = stageReport.decode(value, "Remote stage result");
    const report = {
      ...identity,
      steps: steps.map((step) => ({ name: step.name, description: step.description, ...step })),
    };
    const { value: result } = value;
    if (!finalized && Object.hasOwn(value, "value")) throw new TypeError();
    // The in-process report has an explicit value field even when finalization returns void.
    return finalized
      ? {
          ...report,
          finalized,
          value: result === undefined ? undefined : runnerValue(result, "Remote stage result"),
        }
      : { ...report, finalized, value: undefined };
  } catch {
    throw new TypeError("Invalid remote stage result.");
  }
}

export function runnerChildControls(controls: PipelineRunControls): PipelineChildRunControls {
  const { dryRun, continueOnError, cache, maxConcurrency, targets, stepIds } = controls;
  if (
    (dryRun !== undefined && typeof dryRun !== "boolean") ||
    (continueOnError !== undefined && typeof continueOnError !== "boolean") ||
    (cache !== undefined && !isStepCachePolicy(cache)) ||
    (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) ||
    (targets !== undefined && stepIds !== undefined) ||
    (targets !== undefined && (!Array.isArray(targets) || !targets.every(isAuthoredPipelineId))) ||
    (stepIds !== undefined && (!Array.isArray(stepIds) || !stepIds.every(isAuthoredPipelineId)))
  )
    throw new TypeError("Unsupported remote stage controls.");
  const base = { dryRun, continueOnError, cache, maxConcurrency };
  return targets === undefined ? { ...base, stepIds } : { ...base, targets };
}

export function runnerValue(value: unknown, label: string): unknown {
  const bytes = encodePlainJson(
    value,
    (path, reason) => new TypeError(`${label} cannot transfer ${path}: ${reason}`)
  );
  if (bytes.byteLength > RUNNER_VALUE_BYTES)
    throw new TypeError(`${label} must fit within 64 KiB.`);
  return JSON.parse(new TextDecoder().decode(bytes));
}
