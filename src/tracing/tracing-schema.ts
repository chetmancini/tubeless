import {
  wireArray,
  wireBoolean,
  wireCustom,
  wireDefault,
  wireDiscriminatedUnion,
  wireEnum,
  wireLiteral,
  wireNumber,
  wireObject,
  wireOptional,
  wireRecord,
  wireRefine,
  wireString,
  wireTransform,
  wireUnion,
  type InferWireSchema,
  type WireJsonSchema,
  type WireSchema,
} from "./wire-schema.js";
import {
  PIPELINE_TRACE_DETAIL_BYTE_LIMIT,
  PIPELINE_TRACE_LIST_LIMIT,
  PIPELINE_TRACE_STRING_LIMIT,
  PIPELINE_TRACE_VERSION,
} from "./tracing-constants.js";

export const PIPELINE_ERROR_CODES = [
  "TUBELESS_CHILD_FAILED",
  "TUBELESS_DEFINITION_DEPENDENCY_CONTRADICTORY",
  "TUBELESS_DEFINITION_DEPENDENCY_CYCLE",
  "TUBELESS_DEFINITION_DEPENDENCY_DUPLICATE",
  "TUBELESS_DEFINITION_DEPENDENCY_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_DEPENDENCY_SELF_REFERENCE",
  "TUBELESS_DEFINITION_FINALIZER_STEP_NOT_IN_STEPS",
  "TUBELESS_DEFINITION_PIPELINE_ID_BLANK",
  "TUBELESS_DEFINITION_IMPLEMENTATION_VERSION_INVALID",
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
] as const;

export const PIPELINE_ERROR_KINDS = [
  "cancellation",
  "child",
  "definition",
  "finalization",
  "selection",
  "step",
  "validation",
] as const;

export const PIPELINE_ERROR_PHASES = [
  "definition",
  "execution",
  "finalization",
  "planning",
] as const;

const PIPELINE_RUN_STATUSES = ["cancelled", "completed", "failed"] as const;
const PIPELINE_STEP_SKIP_REASONS = [
  "dry-run",
  "failed-dependency",
  "fail-fast",
  "filtered",
  "policy",
  "unmet-dependency",
] as const;
const PIPELINE_PROGRESS_STATUSES = [
  "cancelled",
  "completed",
  "failed",
  "pending",
  "running",
  "skipped",
] as const;

const openString = wireString({ allowEmpty: true });
const requiredString = wireString();
const boundedString = wireString({ allowEmpty: true, maxLength: PIPELINE_TRACE_STRING_LIMIT });
const nonnegativeInteger = wireNumber({ integer: true, minimum: 0 });
const finiteNumber = wireNumber();
const stringList = wireArray(requiredString);
const boundedStringList = wireArray(requiredString, {
  maxItems: PIPELINE_TRACE_LIST_LIMIT,
  noun: "strings",
});

type PipelineErrorCauseContract = {
  cause?: PipelineErrorCauseContract;
  message: string;
  name?: string;
  sourceCode?: string;
};

function decodeCause(
  value: unknown,
  path: string,
  depth: number,
  fanOut: boolean
): PipelineErrorCauseContract {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  if ((!fanOut && depth >= 16) || (fanOut && depth > 8)) {
    throw new Error(
      fanOut ? "error.fanOut cause exceeds its depth limit" : "error.cause exceeds 16 levels"
    );
  }
  // SAFETY: The object guard above excludes null and arrays, so named properties are safe to read.
  const source = value as Record<string, unknown>;
  const decodeText = (key: "message" | "name" | "sourceCode"): string | undefined => {
    const item = source[key];
    if (item === undefined) return undefined;
    if (typeof item !== "string") throw new Error(`${path}.${key} must be a string`);
    return item;
  };
  const cause: PipelineErrorCauseContract = { message: decodeText("message") ?? "" };
  const name = decodeText("name");
  const sourceCode = decodeText("sourceCode");
  if (name !== undefined) cause.name = name;
  if (sourceCode !== undefined) cause.sourceCode = sourceCode;
  if (
    fanOut &&
    [cause.message, cause.name, cause.sourceCode].some(
      (item) => item !== undefined && item.length > 1024
    )
  ) {
    throw new Error("error.fanOut cause strings exceed 1024 code units");
  }
  if (source.cause !== undefined) {
    cause.cause = decodeCause(source.cause, path, depth + 1, fanOut);
  }
  return cause;
}

const pipelineErrorCauseJsonSchema: WireJsonSchema = {
  additionalProperties: false,
  properties: {
    cause: { $ref: "#/components/schemas/PipelineErrorCause" },
    message: { type: "string" },
    name: { type: "string" },
    sourceCode: { type: "string" },
  },
  required: ["message"],
  type: "object",
};

const pipelineErrorCauseSchema = wireCustom<PipelineErrorCauseContract>(
  pipelineErrorCauseJsonSchema,
  (value, path) => decodeCause(value, path, 0, false)
);

const fanOutCauseSchema = wireCustom<PipelineErrorCauseContract>(
  { $ref: "#/components/schemas/PipelineErrorCause" },
  (value, path) => decodeCause(value, path, 0, true)
);

const validationPathSchema = wireCustom<readonly (number | string)[]>(
  {
    items: {
      oneOf: [{ type: "number" }, { type: "string", maxLength: PIPELINE_TRACE_STRING_LIMIT }],
    },
    maxItems: PIPELINE_TRACE_LIST_LIMIT,
    type: "array",
  },
  (value, path) => {
    if (
      !Array.isArray(value) ||
      value.length > PIPELINE_TRACE_LIST_LIMIT ||
      !value.every(
        (part) => typeof part === "string" || (typeof part === "number" && Number.isFinite(part))
      )
    ) {
      throw new Error(`${path} must contain strings or finite numbers`);
    }
    if (
      value.some((part) => typeof part === "string" && part.length > PIPELINE_TRACE_STRING_LIMIT)
    ) {
      throw new Error(`${path} string exceeds ${PIPELINE_TRACE_STRING_LIMIT} code units`);
    }
    return value;
  }
);
const validationIssueSchema = wireObject({
  message: wireString({ maxLength: PIPELINE_TRACE_STRING_LIMIT }),
  path: wireOptional(validationPathSchema),
});

const validationIssuesSchema = wireCustom<readonly InferWireSchema<typeof validationIssueSchema>[]>(
  {
    items: validationIssueSchema.jsonSchema,
    maxItems: PIPELINE_TRACE_LIST_LIMIT,
    type: "array",
  },
  (value, path) => {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (value.length > PIPELINE_TRACE_LIST_LIMIT) {
      throw new Error(`${path} must contain at most ${PIPELINE_TRACE_LIST_LIMIT} entries`);
    }
    return value.map((issue, index) => validationIssueSchema.decode(issue, `${path}[${index}]`));
  }
);

const fanOutFailureSchema = wireObject({
  cancelled: wireBoolean(),
  error: fanOutCauseSchema,
  index: nonnegativeInteger,
  key: wireString({ allowEmpty: true, maxLength: 1024 }),
  keyTruncated: wireBoolean(),
});

const fanOutSchema = wireRefine(
  wireObject({
    failureCount: nonnegativeInteger,
    failures: wireArray(fanOutFailureSchema, { maxItems: 32, noun: "entries" }),
    omittedFailureCount: nonnegativeInteger,
    schedulerError: wireOptional(fanOutCauseSchema),
  }),
  (fanOut) => {
    if (fanOut.failureCount - fanOut.failures.length !== fanOut.omittedFailureCount) {
      throw new Error("error.fanOut counts do not match failures");
    }
    let previousIndex = -1;
    for (const failure of fanOut.failures) {
      if (failure.index <= previousIndex) {
        throw new Error("error.fanOut indices must be in input order");
      }
      previousIndex = failure.index;
    }
  }
);

export const pipelineTraceErrorSchema = wireObject({
  cause: wireOptional(
    wireRefine(pipelineErrorCauseSchema, () => undefined, {
      $ref: "#/components/schemas/PipelineErrorCause",
    })
  ),
  code: wireEnum(PIPELINE_ERROR_CODES),
  fanOut: wireOptional(
    wireRefine(fanOutSchema, () => undefined, {
      $ref: "#/components/schemas/PipelineFanOutDiagnostics",
    })
  ),
  issues: wireOptional(validationIssuesSchema),
  kind: wireEnum(PIPELINE_ERROR_KINDS),
  message: wireDefault(openString, ""),
  phase: wireEnum(PIPELINE_ERROR_PHASES),
  sourceCode: wireOptional(openString),
  stack: wireOptional(openString),
});
const pipelineTraceErrorRefSchema = wireRefine(pipelineTraceErrorSchema, () => undefined, {
  $ref: "#/components/schemas/PipelineError",
});

const progressDetailSchema = wireObject({
  completed: wireOptional(finiteNumber),
  depth: wireOptional(finiteNumber),
  id: wireString({ maxLength: PIPELINE_TRACE_STRING_LIMIT }),
  label: wireOptional(boundedString),
  name: wireOptional(boundedString),
  status: wireOptional(wireEnum(PIPELINE_PROGRESS_STATUSES)),
  total: wireOptional(finiteNumber),
});

const progressDetailsSchema = wireRefine(
  wireArray(progressDetailSchema, { maxItems: PIPELINE_TRACE_LIST_LIMIT, noun: "details" }),
  (details, path) => {
    if (
      new TextEncoder().encode(JSON.stringify(details)).byteLength >
      PIPELINE_TRACE_DETAIL_BYTE_LIMIT
    ) {
      throw new Error(`${path} exceeds the ${PIPELINE_TRACE_DETAIL_BYTE_LIMIT}-byte limit`);
    }
  }
);

const progressSchema = wireTransform(
  wireRefine(
    wireObject({
      completed: finiteNumber,
      detailCount: wireOptional(nonnegativeInteger),
      details: wireOptional(progressDetailsSchema),
      message: wireOptional(openString),
      total: wireOptional(finiteNumber),
    }),
    (progress) => {
      if (
        progress.details !== undefined &&
        progress.detailCount !== undefined &&
        progress.detailCount < progress.details.length
      ) {
        throw new Error(
          "payload.progress.detailCount must be at least the retained details length"
        );
      }
    }
  ),
  (progress) =>
    progress.details !== undefined && progress.detailCount === undefined
      ? { ...progress, detailCount: progress.details.length }
      : progress
);

const nestedPipelineSchema = wireRefine(
  wireObject({
    mode: wireEnum(["for-each", "single"] as const, (path) => `${path} must be for-each or single`),
    pipelineId: requiredString,
    stepCount: nonnegativeInteger,
    stepIds: boundedStringList,
  }),
  (nested, path) => {
    if (nested.stepCount < nested.stepIds.length) {
      throw new Error(`${path}.stepCount must be at least the retained stepIds length`);
    }
  }
);

const remoteSchema = wireObject({
  engine: wireString({ maxLength: PIPELINE_TRACE_STRING_LIMIT }),
  target: wireOptional(boundedString),
});

/** Additive v2 metadata; its own version fixes the fingerprint semantics. */
export const pipelineDefinitionIdentitySchema = wireRefine(
  wireObject({
    version: wireLiteral(1),
    definitionId: wireString({ maxLength: 80 }),
    structuralFingerprint: wireString({ maxLength: 80 }),
    implementationVersion: wireOptional(wireString({ maxLength: 256 })),
  }),
  (identity, path) => {
    if (
      ![identity.definitionId, identity.structuralFingerprint].every((value) =>
        /^sha256:[a-f0-9]{64}$/.test(value)
      )
    ) {
      throw new Error(`${path} must contain SHA-256 fingerprints`);
    }
    if (
      identity.implementationVersion !== undefined &&
      identity.implementationVersion.trim().length === 0
    ) {
      throw new Error(`${path}.implementationVersion must not be blank`);
    }
  }
);

const definitionString = wireString({ maxLength: 4096 });
const definitionStrings = wireArray(definitionString, { maxItems: 4096 });
const definitionStepSchema = wireObject({
  id: definitionString,
  dependencies: definitionStrings,
  optionalDependencies: definitionStrings,
  skipAfterFailureOf: definitionStrings,
  dryRun: wireEnum(["custom", "run", "skip"] as const),
  runtimeSkipPossible: wireBoolean(),
  outputValidated: wireBoolean(),
  nestedPipeline: wireOptional(
    wireObject({
      pipelineId: definitionString,
      mode: wireEnum(["single", "for-each"] as const),
      identity: wireOptional(pipelineDefinitionIdentitySchema),
      stepIds: definitionStrings,
      concurrency: wireOptional(wireUnion([finiteNumber, wireLiteral("dynamic")])),
    })
  ),
  remote: wireOptional(remoteSchema),
});

export const pipelineDefinitionSnapshotSchema = wireRefine(
  wireObject({
    identity: pipelineDefinitionIdentitySchema,
    steps: wireArray(definitionStepSchema, { maxItems: 4096 }),
    targetIds: definitionStrings,
    requiredFinalizerStepIds: wireOptional(definitionStrings),
    optionsValidated: wireBoolean(),
    resultValidated: wireBoolean(),
  }),
  (value, path) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
      throw new Error(`${path} exceeds the 262144-byte definition limit`);
    }
  }
);

export type PipelineDefinitionIdentityContract = InferWireSchema<
  typeof pipelineDefinitionIdentitySchema
>;
export type PipelineDefinitionSnapshotContract = InferWireSchema<
  typeof pipelineDefinitionSnapshotSchema
>;

const selectionReasonSimpleSchema = wireObject({
  kind: wireEnum(["all", "exact", "not-selected", "outside-target-closure"] as const),
});
const selectionReasonTargetSchema = wireObject({
  kind: wireLiteral("target"),
  targetId: requiredString,
});
const selectionReasonDependencySchema = wireObject({
  dependentId: requiredString,
  kind: wireEnum(["failure-gate", "optional-only", "required-dependency"] as const),
  targetId: requiredString,
});
const selectionReasonSchema = wireDiscriminatedUnion("kind", {
  all: selectionReasonSimpleSchema,
  exact: selectionReasonSimpleSchema,
  "failure-gate": selectionReasonDependencySchema,
  "not-selected": selectionReasonSimpleSchema,
  "optional-only": selectionReasonDependencySchema,
  "outside-target-closure": selectionReasonSimpleSchema,
  "required-dependency": selectionReasonDependencySchema,
  target: selectionReasonTargetSchema,
});
const selectionReasonsSchema = wireArray(selectionReasonSchema, {
  maxItems: PIPELINE_TRACE_LIST_LIMIT,
  noun: "reasons",
});

const traceAttributesSchema = wireRecord(
  wireUnion([wireBoolean(), finiteNumber, openString]),
  (path) => `${path} values must be booleans, finite numbers, or strings`
);

const traceBaseShape = {
  correlationId: wireOptional(openString),
  itemKey: wireOptional(openString),
  parentRunId: wireOptional(openString),
  pipelineId: requiredString,
  runId: requiredString,
  timestampMs: finiteNumber,
  version: wireLiteral(PIPELINE_TRACE_VERSION),
} as const;
const traceAttemptShape = {
  attemptId: wireOptional(openString),
  durationMs: wireOptional(finiteNumber),
} as const;
const traceStepShape = { stepId: requiredString } as const;
const emptyPayloadSchema = wireObject({});

export const pipelineTraceEventSchemas = {
  "pipeline.completed": wireObject({
    ...traceBaseShape,
    durationMs: wireOptional(finiteNumber),
    error: wireOptional(pipelineTraceErrorRefSchema),
    name: wireLiteral("pipeline.completed"),
    payload: wireObject({
      dryRun: wireBoolean(),
      errorCount: nonnegativeInteger,
      finalized: wireBoolean(),
      status: wireEnum(
        PIPELINE_RUN_STATUSES,
        (path) => `${path} must be cancelled, completed, or failed`
      ),
      stepCount: nonnegativeInteger,
    }),
  }),
  "pipeline.finalize.completed": wireObject({
    ...traceBaseShape,
    durationMs: finiteNumber,
    name: wireLiteral("pipeline.finalize.completed"),
    payload: emptyPayloadSchema,
  }),
  "pipeline.finalize.failed": wireObject({
    ...traceBaseShape,
    durationMs: finiteNumber,
    error: pipelineTraceErrorRefSchema,
    name: wireLiteral("pipeline.finalize.failed"),
    payload: emptyPayloadSchema,
  }),
  "pipeline.finalize.started": wireObject({
    ...traceBaseShape,
    name: wireLiteral("pipeline.finalize.started"),
    payload: emptyPayloadSchema,
  }),
  "pipeline.log": wireObject({
    ...traceBaseShape,
    attemptId: wireOptional(openString),
    name: wireLiteral("pipeline.log"),
    payload: wireObject({
      level: wireEnum(
        ["error", "log", "warn"] as const,
        (path) => `${path} must be error, log, or warn`
      ),
      message: wireDefault(openString, ""),
    }),
    stepId: wireOptional(openString),
  }),
  "pipeline.started": wireObject({
    ...traceBaseShape,
    name: wireLiteral("pipeline.started"),
    payload: wireRefine(
      wireObject({
        definitionIdentity: wireOptional(pipelineDefinitionIdentitySchema),
        definitionSnapshot: wireOptional(pipelineDefinitionSnapshotSchema),
        dryRun: wireBoolean(),
        planOk: wireBoolean(),
        stepCount: nonnegativeInteger,
        targetIds: stringList,
      }),
      (payload) => {
        if (
          payload.definitionSnapshot &&
          JSON.stringify(payload.definitionSnapshot.identity) !==
            JSON.stringify(payload.definitionIdentity)
        ) {
          throw new Error("Definition snapshot must match the run definition identity");
        }
      }
    ),
  }),
  "step.attempted": wireObject({
    ...traceBaseShape,
    ...traceAttemptShape,
    ...traceStepShape,
    name: wireLiteral("step.attempted"),
    payload: wireObject({ attempt: finiteNumber, attributes: traceAttributesSchema }),
  }),
  "step.cancelled": wireObject({
    ...traceBaseShape,
    ...traceAttemptShape,
    ...traceStepShape,
    error: pipelineTraceErrorRefSchema,
    name: wireLiteral("step.cancelled"),
    payload: wireObject({ status: wireLiteral("cancelled") }),
  }),
  "step.complete": wireObject({
    ...traceBaseShape,
    ...traceAttemptShape,
    ...traceStepShape,
    name: wireLiteral("step.complete"),
    payload: wireObject({ status: wireLiteral("completed") }),
  }),
  "step.failed": wireObject({
    ...traceBaseShape,
    ...traceAttemptShape,
    ...traceStepShape,
    error: pipelineTraceErrorRefSchema,
    name: wireLiteral("step.failed"),
    payload: wireObject({ status: wireLiteral("failed") }),
  }),
  "step.planned": wireObject({
    ...traceBaseShape,
    ...traceStepShape,
    name: wireLiteral("step.planned"),
    payload: wireObject({
      dependencies: stringList,
      description: wireOptional(openString),
      dryRun: wireEnum(
        ["custom", "run", "skip"] as const,
        (path) => `${path} must be custom, run, or skip`
      ),
      name: wireOptional(openString),
      nestedPipeline: wireOptional(nestedPipelineSchema),
      optionalDependencies: stringList,
      remote: wireOptional(remoteSchema),
      runtimeSkipPossible: wireBoolean(),
      selected: wireBoolean(),
      selectionReasons: selectionReasonsSchema,
      skipAfterFailureOf: stringList,
    }),
  }),
  "step.running": wireObject({
    ...traceBaseShape,
    ...traceStepShape,
    attemptId: requiredString,
    name: wireLiteral("step.running"),
    payload: wireObject({ progress: wireOptional(progressSchema) }),
  }),
  "step.skipped": wireObject({
    ...traceBaseShape,
    ...traceAttemptShape,
    ...traceStepShape,
    name: wireLiteral("step.skipped"),
    payload: wireObject({
      dependencyId: wireOptional(openString),
      message: wireOptional(openString),
      reason: wireEnum(PIPELINE_STEP_SKIP_REASONS),
      status: wireLiteral("skipped"),
    }),
  }),
} as const satisfies Readonly<Record<string, WireSchema<unknown>>>;

export const pipelineTraceEventSchema = wireDiscriminatedUnion("name", pipelineTraceEventSchemas);

export type PipelineErrorKindContract = (typeof PIPELINE_ERROR_KINDS)[number];
export type PipelineErrorPhaseContract = (typeof PIPELINE_ERROR_PHASES)[number];
export type PipelineTraceErrorContract = InferWireSchema<typeof pipelineTraceErrorSchema>;
type PipelineTraceEventOptionalFields = {
  attemptId?: string;
  durationMs?: number;
  error?: PipelineTraceErrorContract;
  stepId?: string;
};
type PublicPipelineTraceEvent<TEvent> = TEvent extends {
  name: "step.attempted";
  payload: infer TPayload;
}
  ? Omit<TEvent, "payload"> & {
      payload: Omit<TPayload, "attributes"> & {
        attributes: Readonly<Record<string, boolean | number | string | undefined>>;
      };
    }
  : TEvent extends {
        name:
          | "pipeline.finalize.completed"
          | "pipeline.finalize.failed"
          | "pipeline.finalize.started";
      }
    ? Omit<TEvent, "payload"> & { payload: Readonly<Record<string, never>> }
    : TEvent;
export type PipelineTraceEventContract =
  InferWireSchema<typeof pipelineTraceEventSchema> extends infer TEvent
    ? TEvent extends object
      ? PublicPipelineTraceEvent<TEvent & PipelineTraceEventOptionalFields>
      : never
    : never;
/** @public Shared with the separately built documentation website. */
export const pipelineTraceOpenApiSchemas = {
  PipelineError: pipelineTraceErrorSchema.jsonSchema,
  PipelineErrorCause: pipelineErrorCauseJsonSchema,
  PipelineFanOutDiagnostics: fanOutSchema.jsonSchema,
  PipelineFanOutFailure: fanOutFailureSchema.jsonSchema,
  PipelineProgressDetail: progressDetailSchema.jsonSchema,
  PipelineValidationIssue: validationIssueSchema.jsonSchema,
  StoredPipelineEvent: {
    oneOf: Object.values(pipelineTraceEventSchemas).map((eventSchema) => {
      // SAFETY: Every entry is created by `wireObject`, whose JSON Schema has these two fields.
      const eventJson = eventSchema.jsonSchema as {
        properties: Record<string, unknown>;
        required: readonly string[];
      };
      return {
        ...eventJson,
        properties: {
          ...eventJson.properties,
          id: { minimum: 0, type: "integer" },
        },
        required: [...eventJson.required, "id"],
      };
    }),
  },
} as const satisfies Readonly<Record<string, WireJsonSchema>>;
