import {
  wireBoolean,
  wireDiscriminatedUnion,
  wireEnum,
  wireLiteral,
  wireNumber,
  wireObject,
  wireOptional,
  wireString,
  type InferWireSchema,
  type WireSchema,
} from "../../tracing/wire-schema.js";
import { hostedExecutionStatusSchema } from "../execution-status.js";

export const EXECUTION_FOLLOW_CAPABILITY = { version: 1, transport: "ndjson" } as const;
export const EXECUTION_FOLLOW_MEDIA_TYPE = "application/x-ndjson";
export const EXECUTION_FOLLOW_LINE_BYTES = 48 * 1024;
export const EXECUTION_FOLLOW_WINDOW_BYTES = 6 * 1024 * 1024;

const text = wireString({ allowEmpty: true });
const number = wireNumber();
const empty = wireObject({});
const attribution = {
  runId: text,
  pipelineId: text,
  parentRunId: wireOptional(text),
  stepId: wireOptional(text),
  attemptId: wireOptional(text),
  truncated: wireOptional(wireBoolean()),
};
const envelope = {
  version: wireLiteral(EXECUTION_FOLLOW_CAPABILITY.version),
  executionId: text,
  cursor: wireNumber({ integer: true, minimum: 0 }),
};
function frame<const T extends string, P>(type: T, payload: WireSchema<P>) {
  return wireObject({ ...envelope, type: wireLiteral(type), payload });
}

export const executionFollowEventSchema = wireDiscriminatedUnion("type", {
  snapshot: frame("snapshot", hostedExecutionStatusSchema),
  status: frame("status", hostedExecutionStatusSchema),
  terminal: frame("terminal", hostedExecutionStatusSchema),
  log: frame(
    "log",
    wireObject({
      ...attribution,
      level: wireEnum(["log", "warn", "error"]),
      message: text,
    })
  ),
  progress: frame(
    "progress",
    wireObject({
      ...attribution,
      completed: number,
      total: wireOptional(number),
      message: wireOptional(text),
    })
  ),
  gap: frame("gap", wireObject({ reason: wireLiteral("history_unavailable") })),
  heartbeat: frame("heartbeat", empty),
  end: frame("end", empty),
});

export type ExecutionFollowEvent = InferWireSchema<typeof executionFollowEventSchema>;
export type ExecutionFollowOutput = Extract<ExecutionFollowEvent, { type: "log" | "progress" }>;
