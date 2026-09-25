import { createHash } from "node:crypto";
import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import type { AgentState } from "./agent-types.js";

export function agentError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

/** Copy plain data into owned, frozen snapshots; repeated references are copied, cycles fail. */
function copy(value: unknown, ancestors: Set<object>, json: boolean): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined && !json) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) throw new Error("Expected finite plain data");
  if (ancestors.has(value)) throw new Error("Cyclic data is not supported");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error("Expected an array or plain record");
  }
  ancestors.add(value);
  const result: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? new Array(value.length)
    : {};
  const keys = Reflect.ownKeys(value);
  if (json) keys.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in property) || !property.enumerable) {
      throw new Error("State and descriptors require enumerable data properties");
    }
    Object.defineProperty(result, key, {
      value: copy(property.value, ancestors, json),
      enumerable: true,
    });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

export function ownState<T>(state: T): AgentState<T> {
  try {
    // SAFETY: copying retains every plain-data value and only adds deep readonly ownership.
    return copy(state, new Set(), false) as AgentState<T>;
  } catch (cause) {
    throw agentError(
      "TUBELESS_AGENT_INVALID_STATE",
      "Agent state must contain finite primitives, arrays, and plain records",
      cause
    );
  }
}

export function checkSchema(schema: StandardSchemaV1, label: string): void {
  if (schema?.["~standard"]?.version !== 1 || typeof schema["~standard"].validate !== "function") {
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      `${label} requires a Standard Schema validator`
    );
  }
}

export function jsonDescriptor(
  schema: StandardSchemaV1,
  explicit: Readonly<Record<string, unknown>> | undefined,
  label: string
): Readonly<Record<string, unknown>> {
  checkSchema(schema, label);
  try {
    const descriptor =
      explicit ?? schema["~standard"].jsonSchema?.input({ target: "draft-2020-12" });
    if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor))
      throw new Error("Missing JSON Schema object");
    // SAFETY: the object guard and plain JSON copy validate the descriptor's representation.
    return copy(descriptor, new Set(), true) as Readonly<Record<string, unknown>>;
  } catch (cause) {
    throw agentError(
      "TUBELESS_AGENT_INVALID_DEFINITION",
      `${label} requires a JSON Schema input descriptor or explicit fallback`,
      cause
    );
  }
}

export function descriptorFingerprint(descriptor: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`;
}
