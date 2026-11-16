export const AGENT_TURN_STEPS = Object.freeze({
  decide: "decide",
  calls: "calls",
  reduce: "reduce",
} as const);

export const AGENT_TRACE_ATTRIBUTES = Object.freeze({
  runId: "agent.runId",
  turn: "agent.turn",
  stateVersion: "agent.stateVersion",
  callsAdmitted: "agent.callsAdmitted",
  decision: "agent.decision",
  callCount: "agent.callCount",
  callId: "agent.callId",
  tool: "agent.tool",
  parentAttemptId: "agent.parentAttemptId",
  checkpointReused: "agent.checkpointReused",
} as const);

export const AGENT_MODEL_COUNTERS = Object.freeze([
  "inputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "cacheWrite30mTokens",
  "cacheWrite12hTokens",
] as const);

export type AgentModelCounter = (typeof AGENT_MODEL_COUNTERS)[number];

const counterAttributes = Object.fromEntries(
  AGENT_MODEL_COUNTERS.map((name) => [name, `agent.model.${name}`])
) as { readonly [Name in AgentModelCounter]: `agent.model.${Name}` };

export const AGENT_MODEL_ATTRIBUTES = Object.freeze({
  ...counterAttributes,
  provider: "agent.model.provider",
  name: "agent.model.name",
  operation: "agent.model.operation",
  request: "agent.model.request",
  responseReceived: "agent.model.responseReceived",
  durationMs: "agent.model.durationMs",
  httpStatus: "agent.model.httpStatus",
} as const);
