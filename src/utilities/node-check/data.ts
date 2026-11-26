import { isJsonObject } from "../canonical-json.js";

export function exactFields(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new TypeError(`Invalid ${label} fields.`);
  return value;
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}
