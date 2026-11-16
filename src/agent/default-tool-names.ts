export const DEFAULT_AGENT_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "bash",
  "list",
  "search",
] as const);

/** A standard workspace tool an agent's setup may select. */
export type DefaultAgentToolName = (typeof DEFAULT_AGENT_TOOL_NAMES)[number];

export function isDefaultAgentToolSelection(
  value: unknown
): value is readonly DefaultAgentToolName[] {
  return (
    Array.isArray(value) &&
    value.every((name) => DEFAULT_AGENT_TOOL_NAMES.some((candidate) => candidate === name))
  );
}
