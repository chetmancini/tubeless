export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isAgentCallId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && value.trim().length > 0;
}

export function isAgentToolName(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function isToolReplayPolicy(value: unknown): value is "safe" | "unsafe" {
  return value === "safe" || value === "unsafe";
}
