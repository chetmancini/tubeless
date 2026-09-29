import type { AgentDecisionContext, AgentOutcome, Awaitable, Tools } from "./agent-types.js";

/** Per-run provider context and the latest ordered tool outcomes, never executable handlers. */
export interface AgentModelRequest {
  readonly instructions: string;
  readonly task: string;
  /** Provider-owned plain data; null on the first decision. */
  readonly conversation: unknown;
  readonly outcomes: readonly AgentOutcome<Tools>[];
}

/** An untrusted harness decision and plain-data conversation to retain after the batch succeeds. */
export interface AgentModelResponse {
  readonly decision: unknown;
  readonly conversation: unknown;
}

/** Pluggable model transport; the harness owns and isolates its returned conversation per run. */
export type AgentModel = (
  request: AgentModelRequest,
  context: AgentDecisionContext<{ task: string }>
) => Awaitable<AgentModelResponse>;
