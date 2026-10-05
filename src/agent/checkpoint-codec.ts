import { agentError } from "./agent-state.js";
import type { AgentCheckpointCodec } from "./checkpoint-types.js";

type Encoded =
  | ["undefined"]
  | ["null"]
  | ["string", string]
  | ["boolean", boolean]
  | ["number", string]
  | ["array", number, [string, Encoded][]]
  | ["record" | "null-record", [string, Encoded][]];

function encode(value: unknown, ancestors: Set<object>): Encoded {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number" && Number.isFinite(value))
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("Expected acyclic finite plain data");
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error("Expected a plain array; supply a lossless codec for array subclasses");
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Expected an array or plain record; supply a lossless codec for other values");
  ancestors.add(value);
  const properties: [string, Encoded][] = [];
  for (const key of Reflect.ownKeys(value).sort((a, b) =>
    String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
  )) {
    if (array && key === "length") continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in property) || !property.enumerable)
      throw new Error("Expected enumerable data properties");
    properties.push([key, encode(property.value, ancestors)]);
  }
  ancestors.delete(value);
  return array
    ? ["array", value.length, properties]
    : [Object.getPrototypeOf(value) === null ? "null-record" : "record", properties];
}

function decode(value: unknown): unknown {
  if (!Array.isArray(value)) throw new Error("Invalid checkpoint value");
  const [tag, payload, properties] = value;
  if (tag === "undefined" && value.length === 1) return undefined;
  if (tag === "null" && value.length === 1) return null;
  if (tag === "string" && value.length === 2 && typeof payload === "string") return payload;
  if (tag === "boolean" && value.length === 2 && typeof payload === "boolean") return payload;
  if (
    tag === "number" &&
    value.length === 2 &&
    typeof payload === "string" &&
    Number.isFinite(Number(payload)) &&
    (payload === "-0" || String(Number(payload)) === payload)
  )
    return Number(payload);
  const array =
    tag === "array" &&
    value.length === 3 &&
    Number.isSafeInteger(payload) &&
    payload >= 0 &&
    payload <= 0xffff_ffff;
  const entries = array
    ? properties
    : (tag === "record" || tag === "null-record") && value.length === 2
      ? payload
      : undefined;
  if (!Array.isArray(entries)) throw new Error("Invalid checkpoint properties");
  const result: unknown[] | Record<string, unknown> = array
    ? new Array(payload)
    : tag === "null-record"
      ? Object.create(null)
      : {};
  for (const entry of entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      Object.hasOwn(result, entry[0])
    )
      throw new Error("Invalid or duplicate checkpoint property");
    Object.defineProperty(result, entry[0], {
      value: decode(entry[1]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (array && (result as unknown[]).length !== payload)
    throw new Error("Invalid checkpoint array length");
  return result;
}

/** Lossless, tagged JSON codec for finite plain data; preserves undefined and sparse arrays. */
export const plainAgentCheckpointCodec: AgentCheckpointCodec = Object.freeze({
  encode: (value: unknown) => {
    try {
      return JSON.stringify(encode(value, new Set()));
    } catch (cause) {
      throw agentError(
        "TUBELESS_AGENT_CHECKPOINT_CODEC",
        "Cannot encode agent checkpoint losslessly",
        cause
      );
    }
  },
  decode: (checkpoint: string) => {
    try {
      return decode(JSON.parse(checkpoint));
    } catch (cause) {
      throw agentError(
        "TUBELESS_AGENT_CHECKPOINT_CODEC",
        "Invalid encoded agent checkpoint",
        cause
      );
    }
  },
});
