import type { AgentLimits } from "./agent-types.js";

export const DEFAULT_AGENT_LIMITS: Required<AgentLimits> = Object.freeze({
  maxTurns: 20,
  maxCalls: 100,
  maxDecisions: 100,
  maxDepth: 4,
  maxConcurrency: 1,
});

export const minimumAgentLimit = (name: keyof AgentLimits) =>
  name === "maxCalls" || name === "maxDepth" ? 0 : 1;

export function validAgentLimit(name: keyof AgentLimits, value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimumAgentLimit(name)
  );
}
