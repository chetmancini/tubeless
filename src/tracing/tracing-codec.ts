import type {
  PipelineErrorCause,
  PipelineErrorCode,
  PipelineErrorKind,
  PipelineErrorPhase,
  PipelineFanOutDiagnostics,
  PipelineRunStatus,
  PipelineStepProgressDetail,
  PipelineStepSelectionReason,
  PipelineStepSkipReason,
  PipelineValidationIssue,
} from "../core/pipeline.js";
import type {
  PipelineTraceAttributes,
  PipelineTraceError,
  PipelineTraceEvent,
  PipelineTraceEventName,
  PipelineTraceNestedPipeline,
  PipelineTraceProgress,
  PipelineTraceRemote,
} from "./tracing.js";
import {
  PIPELINE_TRACE_DETAIL_BYTE_LIMIT,
  PIPELINE_TRACE_LIST_LIMIT,
  PIPELINE_TRACE_STRING_LIMIT,
  PIPELINE_TRACE_VERSION,
} from "./tracing-constants.js";

const eventNames: ReadonlySet<string> = new Set<PipelineTraceEventName>([
  "pipeline.completed",
  "pipeline.log",
  "pipeline.started",
  "pipeline.finalize.completed",
  "pipeline.finalize.failed",
  "pipeline.finalize.started",
  "step.attempted",
  "step.cancelled",
  "step.failed",
  "step.planned",
  "step.running",
  "step.skipped",
  "step.complete",
]);
const runStatuses: ReadonlySet<string> = new Set<PipelineRunStatus>([
  "cancelled",
  "completed",
  "failed",
]);
const skipReasons: ReadonlySet<string> = new Set<PipelineStepSkipReason>([
  "dry-run",
  "failed-dependency",
  "fail-fast",
  "filtered",
  "policy",
  "unmet-dependency",
]);
const progressStatuses = new Set([
  "cancelled",
  "completed",
  "failed",
  "pending",
  "running",
  "skipped",
]);
const errorKinds: ReadonlySet<string> = new Set([
  "cancellation",
  "child",
  "definition",
  "finalization",
  "selection",
  "step",
  "validation",
]);
const errorPhases: ReadonlySet<string> = new Set([
  "definition",
  "execution",
  "finalization",
  "planning",
]);
const errorCodes: ReadonlySet<string> = new Set([
  "TUBELESS_CHILD_FAILED",
  "TUBELESS_DEFINITION_DEPENDENCY_CONTRADICTORY",
  "TUBELESS_DEFINITION_DEPENDENCY_CYCLE",
  "TUBELESS_DEFINITION_DEPENDENCY_DUPLICATE",
  "TUBELESS_DEFINITION_DEPENDENCY_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_DEPENDENCY_SELF_REFERENCE",
  "TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_PIPELINE_ID_BLANK",
  "TUBELESS_DEFINITION_OPTIONS_SCHEMA_CONFLICT",
  "TUBELESS_DEFINITION_STEP_ID_BLANK",
  "TUBELESS_DEFINITION_STEP_ID_RESERVED",
  "TUBELESS_DEFINITION_STEP_IDS_DUPLICATE",
  "TUBELESS_DEFINITION_STEP_NAME_BLANK",
  "TUBELESS_DEFINITION_TARGET_FINALIZER_MISMATCH",
  "TUBELESS_DEFINITION_TARGET_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_TARGETS_DUPLICATE",
  "TUBELESS_FINALIZATION_CANCELLED",
  "TUBELESS_FINALIZATION_FAILED",
  "TUBELESS_FINAL_RESULT_VALIDATION_FAILED",
  "TUBELESS_OPTIONS_VALIDATION_FAILED",
  "TUBELESS_PLANNING_SELECTION_CONFLICT",
  "TUBELESS_PLANNING_STEP_SELECTION_DUPLICATE",
  "TUBELESS_PLANNING_STEP_SELECTION_EMPTY",
  "TUBELESS_PLANNING_STEP_UNKNOWN",
  "TUBELESS_PLANNING_TARGET_SELECTION_DUPLICATE",
  "TUBELESS_PLANNING_TARGET_SELECTION_EMPTY",
  "TUBELESS_PLANNING_TARGET_UNDECLARED",
  "TUBELESS_PLANNING_TARGET_UNKNOWN",
  "TUBELESS_RUN_CANCELLED",
  "TUBELESS_STEP_OUTPUT_VALIDATION_FAILED",
  "TUBELESS_STEP_FAILED",
]);

function isErrorCode(value: string): value is PipelineErrorCode {
  return errorCodes.has(value);
}

function isErrorKind(value: string): value is PipelineErrorKind {
  return errorKinds.has(value);
}

function isErrorPhase(value: string): value is PipelineErrorPhase {
  return errorPhases.has(value);
}

function isEventName(value: string): value is PipelineTraceEventName {
  return eventNames.has(value);
}

function isProgressStatus(
  value: string
): value is NonNullable<PipelineStepProgressDetail["status"]> {
  return progressStatuses.has(value);
}

function isRunStatus(value: string): value is PipelineRunStatus {
  return runStatuses.has(value);
}

function isSkipReason(value: string): value is PipelineStepSkipReason {
  return skipReasons.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value: Record<string, unknown>, key: string, label = key): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return item;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  label = key
): string | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== "string") throw new Error(`${label} must be a string`);
  return item;
}

function requiredBoolean(value: Record<string, unknown>, key: string, label = key): boolean {
  const item = value[key];
  if (typeof item !== "boolean") throw new Error(`${label} must be a boolean`);
  return item;
}

function finiteNumber(value: Record<string, unknown>, key: string, label = key): number {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item)) {
    throw new Error(`${label} must be a finite number`);
  }
  return item;
}

function optionalFiniteNumber(
  value: Record<string, unknown>,
  key: string,
  label = key
): number | undefined {
  return value[key] === undefined ? undefined : finiteNumber(value, key, label);
}

function nonnegativeInteger(value: Record<string, unknown>, key: string, label = key): number {
  const item = finiteNumber(value, key, label);
  if (!Number.isSafeInteger(item) || item < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return item;
}

function optionalBoundedString(
  value: Record<string, unknown>,
  key: string,
  label = key
): string | undefined {
  const item = optionalString(value, key, label);
  if (item !== undefined && item.length > PIPELINE_TRACE_STRING_LIMIT) {
    throw new Error(`${label} exceeds ${PIPELINE_TRACE_STRING_LIMIT} code units`);
  }
  return item;
}

function stringArray(value: unknown, label: string, maxItems?: number): readonly string[] {
  if (!Array.isArray(value) || (maxItems !== undefined && value.length > maxItems)) {
    const bound = maxItems === undefined ? "" : ` of at most ${maxItems} strings`;
    throw new Error(`${label} must be an array${bound}`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function attributes(value: unknown, label = "payload.attributes"): PipelineTraceAttributes {
  const source = record(value, label);
  const parsed: Record<string, boolean | number | string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (
      typeof item !== "boolean" &&
      typeof item !== "string" &&
      (typeof item !== "number" || !Number.isFinite(item))
    ) {
      throw new Error(`${label} values must be booleans, finite numbers, or strings`);
    }
    parsed[key] = item;
  }
  return parsed;
}

function parseCause(value: unknown, depth = 0): PipelineErrorCause {
  const source = record(value, "error.cause");
  if (depth >= 16) throw new Error("error.cause exceeds 16 levels");
  const cause: PipelineErrorCause = { message: optionalString(source, "message") ?? "" };
  const name = optionalString(source, "name");
  if (name !== undefined) cause.name = name;
  const sourceCode = optionalString(source, "sourceCode");
  if (sourceCode !== undefined) cause.sourceCode = sourceCode;
  if (source.cause !== undefined) cause.cause = parseCause(source.cause, depth + 1);
  return cause;
}

function parseIssues(value: unknown): readonly PipelineValidationIssue[] {
  if (!Array.isArray(value)) throw new Error("error.issues must be an array");
  if (value.length > PIPELINE_TRACE_LIST_LIMIT) {
    throw new Error(`error.issues must contain at most ${PIPELINE_TRACE_LIST_LIMIT} entries`);
  }
  return value.slice(0, PIPELINE_TRACE_LIST_LIMIT).map((item, index) => {
    const issue = record(item, `error.issues[${index}]`);
    const message = requiredString(issue, "message", `error.issues[${index}].message`);
    if (message.length > PIPELINE_TRACE_STRING_LIMIT) {
      throw new Error(
        `error.issues[${index}].message exceeds ${PIPELINE_TRACE_STRING_LIMIT} code units`
      );
    }
    const parsed: PipelineValidationIssue = {
      message,
    };
    if (issue.path !== undefined) {
      if (
        !Array.isArray(issue.path) ||
        issue.path.length > PIPELINE_TRACE_LIST_LIMIT ||
        !issue.path.every(
          (part) => typeof part === "string" || (typeof part === "number" && Number.isFinite(part))
        )
      ) {
        throw new Error(`error.issues[${index}].path must contain strings or finite numbers`);
      }
      const path = issue.path.slice(0, PIPELINE_TRACE_LIST_LIMIT);
      if (
        path.some((part) => typeof part === "string" && part.length > PIPELINE_TRACE_STRING_LIMIT)
      ) {
        throw new Error(
          `error.issues[${index}].path string exceeds ${PIPELINE_TRACE_STRING_LIMIT} code units`
        );
      }
      parsed.path = path;
    }
    return parsed;
  });
}

function parseFanOutCause(value: unknown, depth = 0): PipelineErrorCause {
  const source = record(value, "error.fanOut cause");
  if (depth > 8) throw new Error("error.fanOut cause exceeds its depth limit");
  const cause: PipelineErrorCause = { message: optionalString(source, "message") ?? "" };
  for (const key of ["name", "sourceCode"] as const) {
    const item = optionalString(source, key);
    if (item !== undefined) cause[key] = item;
  }
  if (
    [cause.message, cause.name, cause.sourceCode].some(
      (item) => item !== undefined && item.length > 1024
    )
  ) {
    throw new Error("error.fanOut cause strings exceed 1024 code units");
  }
  if (source.cause !== undefined) cause.cause = parseFanOutCause(source.cause, depth + 1);
  return cause;
}

function parseFanOut(value: unknown): PipelineFanOutDiagnostics {
  const source = record(value, "error.fanOut");
  if (!Array.isArray(source.failures) || source.failures.length > 32) {
    throw new Error("error.fanOut.failures must be an array of at most 32 entries");
  }
  const failureCount = nonnegativeInteger(source, "failureCount", "error.fanOut.failureCount");
  const omittedFailureCount = nonnegativeInteger(
    source,
    "omittedFailureCount",
    "error.fanOut.omittedFailureCount"
  );
  if (failureCount - source.failures.length !== omittedFailureCount) {
    throw new Error("error.fanOut counts do not match failures");
  }
  let previousIndex = -1;
  const failures = source.failures.map((value) => {
    const failure = record(value, "error.fanOut failure");
    const index = nonnegativeInteger(failure, "index", "error.fanOut.index");
    if (index <= previousIndex) throw new Error("error.fanOut indices must be in input order");
    previousIndex = index;
    const key = optionalString(failure, "key", "error.fanOut key");
    if (key === undefined || key.length > 1024) {
      throw new Error("error.fanOut key must be a string of at most 1024 code units");
    }
    if (typeof failure.keyTruncated !== "boolean" || typeof failure.cancelled !== "boolean") {
      throw new Error("error.fanOut keyTruncated and cancelled must be booleans");
    }
    return {
      cancelled: failure.cancelled,
      error: parseFanOutCause(failure.error),
      index,
      key,
      keyTruncated: failure.keyTruncated,
    };
  });
  const parsed: PipelineFanOutDiagnostics = { failures, failureCount, omittedFailureCount };
  if (source.schedulerError !== undefined) {
    parsed.schedulerError = parseFanOutCause(source.schedulerError);
  }
  return parsed;
}

function parseError(value: unknown): PipelineTraceError {
  const source = record(value, "error");
  const code = requiredString(source, "code", "error.code");
  const kind = requiredString(source, "kind", "error.kind");
  const phase = requiredString(source, "phase", "error.phase");
  if (!isErrorCode(code)) throw new Error("error.code is unsupported");
  if (!isErrorKind(kind)) throw new Error("error.kind is unsupported");
  if (!isErrorPhase(phase)) throw new Error("error.phase is unsupported");
  const parsed: PipelineTraceError = {
    code,
    kind,
    message: optionalString(source, "message", "error.message") ?? "",
    phase,
  };
  if (source.cause !== undefined) parsed.cause = parseCause(source.cause);
  if (source.fanOut !== undefined) parsed.fanOut = parseFanOut(source.fanOut);
  if (source.issues !== undefined) parsed.issues = parseIssues(source.issues);
  const sourceCode = optionalString(source, "sourceCode", "error.sourceCode");
  if (sourceCode !== undefined) parsed.sourceCode = sourceCode;
  const stack = optionalString(source, "stack", "error.stack");
  if (stack !== undefined) parsed.stack = stack;
  return parsed;
}

function nestedPipeline(value: unknown, label: string): PipelineTraceNestedPipeline {
  const source = record(value, label);
  const mode = requiredString(source, "mode", `${label}.mode`);
  if (mode !== "for-each" && mode !== "single") {
    throw new Error(`${label}.mode must be for-each or single`);
  }
  const parsed: PipelineTraceNestedPipeline = {
    mode,
    pipelineId: requiredString(source, "pipelineId", `${label}.pipelineId`),
    stepCount: nonnegativeInteger(source, "stepCount", `${label}.stepCount`),
    stepIds: stringArray(source.stepIds, `${label}.stepIds`, PIPELINE_TRACE_LIST_LIMIT),
  };
  if (parsed.stepCount < parsed.stepIds.length) {
    throw new Error(`${label}.stepCount must be at least the retained stepIds length`);
  }
  return parsed;
}

function remote(value: unknown, label: string): PipelineTraceRemote {
  const source = record(value, label);
  const parsed: PipelineTraceRemote = {
    engine: requiredString(source, "engine", `${label}.engine`),
  };
  if (parsed.engine.length > PIPELINE_TRACE_STRING_LIMIT) {
    throw new Error(`${label}.engine exceeds ${PIPELINE_TRACE_STRING_LIMIT} code units`);
  }
  const target = optionalBoundedString(source, "target", `${label}.target`);
  if (target) parsed.target = target;
  return parsed;
}

function progressDetails(value: unknown, label: string): readonly PipelineStepProgressDetail[] {
  if (!Array.isArray(value) || value.length > PIPELINE_TRACE_LIST_LIMIT) {
    throw new Error(`${label} must be an array of at most ${PIPELINE_TRACE_LIST_LIMIT} details`);
  }
  const parsed = value.map((item, index) => {
    const source = record(item, `${label}[${index}]`);
    const detail: PipelineStepProgressDetail = {
      id: requiredString(source, "id", `${label}[${index}].id`),
    };
    if (detail.id.length > PIPELINE_TRACE_STRING_LIMIT) {
      throw new Error(`${label}[${index}].id exceeds ${PIPELINE_TRACE_STRING_LIMIT} code units`);
    }
    for (const key of ["name", "label"] as const) {
      const text = optionalBoundedString(source, key, `${label}[${index}].${key}`);
      if (text) detail[key] = text;
    }
    for (const key of ["depth", "completed", "total"] as const) {
      const number = optionalFiniteNumber(source, key, `${label}[${index}].${key}`);
      if (number !== undefined) detail[key] = number;
    }
    const status = optionalString(source, "status", `${label}[${index}].status`);
    if (status !== undefined) {
      if (!isProgressStatus(status)) throw new Error(`${label}[${index}].status is unsupported`);
      detail.status = status;
    }
    return detail;
  });
  if (
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength > PIPELINE_TRACE_DETAIL_BYTE_LIMIT
  ) {
    throw new Error(`${label} exceeds the ${PIPELINE_TRACE_DETAIL_BYTE_LIMIT}-byte limit`);
  }
  return parsed;
}

function progress(value: unknown): PipelineTraceProgress {
  const source = record(value, "payload.progress");
  const parsed: PipelineTraceProgress = { completed: finiteNumber(source, "completed") };
  const total = optionalFiniteNumber(source, "total");
  if (total !== undefined) parsed.total = total;
  const message = optionalString(source, "message");
  if (message !== undefined) parsed.message = message;
  if (source.details !== undefined)
    parsed.details = progressDetails(source.details, "payload.progress.details");
  if (source.detailCount !== undefined) {
    parsed.detailCount = nonnegativeInteger(source, "detailCount", "payload.progress.detailCount");
  } else if (parsed.details) {
    parsed.detailCount = parsed.details.length;
  }
  if (parsed.details && parsed.detailCount! < parsed.details.length) {
    throw new Error("payload.progress.detailCount must be at least the retained details length");
  }
  return parsed;
}

function selectionReasons(value: unknown): readonly PipelineStepSelectionReason[] {
  if (!Array.isArray(value) || value.length > PIPELINE_TRACE_LIST_LIMIT) {
    throw new Error(
      `payload.selectionReasons must be an array of at most ${PIPELINE_TRACE_LIST_LIMIT} reasons`
    );
  }
  return value.map((item, index) => {
    const source = record(item, `payload.selectionReasons[${index}]`);
    const kind = requiredString(source, "kind", `payload.selectionReasons[${index}].kind`);
    if (
      kind === "all" ||
      kind === "exact" ||
      kind === "outside-target-closure" ||
      kind === "not-selected"
    ) {
      return { kind };
    }
    if (kind === "target") {
      return { kind, targetId: requiredString(source, "targetId") };
    }
    if (kind === "required-dependency" || kind === "failure-gate" || kind === "optional-only") {
      return {
        dependentId: requiredString(source, "dependentId"),
        kind,
        targetId: requiredString(source, "targetId"),
      };
    }
    throw new Error(`payload.selectionReasons[${index}].kind is unsupported`);
  });
}

function eventName(value: unknown): PipelineTraceEventName {
  if (typeof value !== "string" || !isEventName(value)) throw new Error("name is unsupported");
  return value;
}

function base(source: Record<string, unknown>) {
  const parsed: {
    correlationId?: string;
    itemKey?: string;
    parentRunId?: string;
    pipelineId: string;
    runId: string;
    timestampMs: number;
    version: 2;
  } = {
    pipelineId: requiredString(source, "pipelineId"),
    runId: requiredString(source, "runId"),
    timestampMs: finiteNumber(source, "timestampMs"),
    version: PIPELINE_TRACE_VERSION,
  };
  const correlationId = optionalString(source, "correlationId");
  if (correlationId !== undefined) parsed.correlationId = correlationId;
  const itemKey = optionalString(source, "itemKey");
  if (itemKey !== undefined) parsed.itemKey = itemKey;
  const parentRunId = optionalString(source, "parentRunId");
  if (parentRunId !== undefined) parsed.parentRunId = parentRunId;
  return parsed;
}

function duration(source: Record<string, unknown>): number | undefined {
  return optionalFiniteNumber(source, "durationMs");
}

function attemptId(source: Record<string, unknown>): string | undefined {
  return optionalString(source, "attemptId");
}

function stepId(source: Record<string, unknown>): string {
  return requiredString(source, "stepId");
}

function parsePayloadV2(
  source: Record<string, unknown>,
  name: PipelineTraceEventName
): PipelineTraceEvent {
  const payload = record(source.payload, "payload");
  const common = base(source);
  switch (name) {
    case "pipeline.started":
      return {
        ...common,
        name,
        payload: {
          dryRun: requiredBoolean(payload, "dryRun"),
          planOk: requiredBoolean(payload, "planOk"),
          stepCount: nonnegativeInteger(payload, "stepCount", "payload.stepCount"),
          targetIds: stringArray(payload.targetIds, "payload.targetIds"),
        },
      };
    case "pipeline.log": {
      const level = requiredString(payload, "level", "payload.level");
      if (level !== "error" && level !== "log" && level !== "warn") {
        throw new Error("payload.level must be error, log, or warn");
      }
      const event: Extract<PipelineTraceEvent, { name: "pipeline.log" }> = {
        ...common,
        name,
        payload: { level, message: optionalString(payload, "message") ?? "" },
      };
      const attempt = attemptId(source);
      if (attempt !== undefined) event.attemptId = attempt;
      const step = optionalString(source, "stepId");
      if (step !== undefined) event.stepId = step;
      return event;
    }
    case "pipeline.completed": {
      const status = optionalString(payload, "status", "payload.status");
      if (status === undefined || !isRunStatus(status)) {
        throw new Error("payload.status must be cancelled, completed, or failed");
      }
      const event: Extract<PipelineTraceEvent, { name: "pipeline.completed" }> = {
        ...common,
        name,
        payload: {
          dryRun: requiredBoolean(payload, "dryRun"),
          errorCount: nonnegativeInteger(payload, "errorCount", "payload.errorCount"),
          finalized: requiredBoolean(payload, "finalized"),
          status,
          stepCount: nonnegativeInteger(payload, "stepCount", "payload.stepCount"),
        },
      };
      const elapsed = duration(source);
      if (elapsed !== undefined) event.durationMs = elapsed;
      if (source.error !== undefined) event.error = parseError(source.error);
      return event;
    }
    case "pipeline.finalize.started":
      return { ...common, name, payload: {} };
    case "pipeline.finalize.completed":
      return { ...common, durationMs: finiteNumber(source, "durationMs"), name, payload: {} };
    case "pipeline.finalize.failed":
      return {
        ...common,
        durationMs: finiteNumber(source, "durationMs"),
        error: parseError(source.error),
        name,
        payload: {},
      };
    case "step.planned": {
      const dryRun = requiredString(payload, "dryRun", "payload.dryRun");
      if (dryRun !== "custom" && dryRun !== "run" && dryRun !== "skip") {
        throw new Error("payload.dryRun must be custom, run, or skip");
      }
      const planned: Extract<PipelineTraceEvent, { name: "step.planned" }> = {
        ...common,
        name,
        payload: {
          dependencies: stringArray(payload.dependencies, "payload.dependencies"),
          dryRun,
          optionalDependencies: stringArray(
            payload.optionalDependencies,
            "payload.optionalDependencies"
          ),
          runtimeSkipPossible: requiredBoolean(payload, "runtimeSkipPossible"),
          selected: requiredBoolean(payload, "selected"),
          selectionReasons: selectionReasons(payload.selectionReasons),
          skipAfterFailureOf: stringArray(payload.skipAfterFailureOf, "payload.skipAfterFailureOf"),
        },
        stepId: stepId(source),
      };
      const description = optionalString(payload, "description");
      if (description !== undefined) planned.payload.description = description;
      const displayName = optionalString(payload, "name");
      if (displayName !== undefined) planned.payload.name = displayName;
      if (payload.nestedPipeline !== undefined) {
        planned.payload.nestedPipeline = nestedPipeline(
          payload.nestedPipeline,
          "payload.nestedPipeline"
        );
      }
      if (payload.remote !== undefined)
        planned.payload.remote = remote(payload.remote, "payload.remote");
      return planned;
    }
    case "step.running": {
      const running: Extract<PipelineTraceEvent, { name: "step.running" }> = {
        ...common,
        attemptId: requiredString(source, "attemptId"),
        name,
        payload: {},
        stepId: stepId(source),
      };
      if (payload.progress !== undefined) running.payload.progress = progress(payload.progress);
      return running;
    }
    case "step.attempted": {
      const event: Extract<PipelineTraceEvent, { name: "step.attempted" }> = {
        ...common,
        name,
        payload: {
          attempt: finiteNumber(payload, "attempt"),
          attributes: attributes(payload.attributes),
        },
        stepId: stepId(source),
      };
      const attempt = attemptId(source);
      if (attempt !== undefined) event.attemptId = attempt;
      return event;
    }
    case "step.complete": {
      const event: Extract<PipelineTraceEvent, { name: "step.complete" }> = {
        ...common,
        name,
        payload: { status: "completed" },
        stepId: stepId(source),
      };
      const attempt = attemptId(source);
      if (attempt !== undefined) event.attemptId = attempt;
      const elapsed = duration(source);
      if (elapsed !== undefined) event.durationMs = elapsed;
      return event;
    }
    case "step.skipped": {
      const reason = requiredString(payload, "reason", "payload.reason");
      if (!isSkipReason(reason)) throw new Error("payload.reason is unsupported");
      const event: Extract<PipelineTraceEvent, { name: "step.skipped" }> = {
        ...common,
        name,
        payload: { reason, status: "skipped" },
        stepId: stepId(source),
      };
      const dependencyId = optionalString(payload, "dependencyId");
      if (dependencyId !== undefined) event.payload.dependencyId = dependencyId;
      const message = optionalString(payload, "message");
      if (message !== undefined) event.payload.message = message;
      const attempt = attemptId(source);
      if (attempt !== undefined) event.attemptId = attempt;
      const elapsed = duration(source);
      if (elapsed !== undefined) event.durationMs = elapsed;
      return event;
    }
    case "step.cancelled": {
      const event: Extract<PipelineTraceEvent, { name: "step.cancelled" }> = {
        ...common,
        error: parseError(source.error),
        name,
        payload: { status: "cancelled" },
        stepId: stepId(source),
      };
      const attempt = attemptId(source);
      if (attempt !== undefined) event.attemptId = attempt;
      const elapsed = duration(source);
      if (elapsed !== undefined) event.durationMs = elapsed;
      return event;
    }
    case "step.failed": {
      const event: Extract<PipelineTraceEvent, { name: "step.failed" }> = {
        ...common,
        error: parseError(source.error),
        name,
        payload: { status: "failed" },
        stepId: stepId(source),
      };
      const attempt = attemptId(source);
      if (attempt !== undefined) event.attemptId = attempt;
      const elapsed = duration(source);
      if (elapsed !== undefined) event.durationMs = elapsed;
      return event;
    }
  }
}

/** Decode and validate a version 2 trace record. */
export function decodePipelineTraceEvent(value: unknown): PipelineTraceEvent {
  const source = record(value, "event");
  const name = eventName(source.name);
  if (source.version !== PIPELINE_TRACE_VERSION) {
    throw new Error(`version must be ${PIPELINE_TRACE_VERSION}`);
  }
  return parsePayloadV2(source, name);
}
