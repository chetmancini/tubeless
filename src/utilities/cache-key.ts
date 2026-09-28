import { createHash } from "node:crypto";

const optionsHashCache = new WeakMap<object, string>();

function hashCanonicalValue(value: unknown): string {
  const seen = new Map<object, number>();
  const unsupported = () => {
    throw new Error(
      "Default cache keys require plain data; provide cache.key for unsupported values"
    );
  };
  const visit = (value: unknown): unknown => {
    if (value === null) return ["null"];
    switch (typeof value) {
      case "undefined":
        return ["undefined"];
      case "string":
        return ["string", value];
      case "boolean":
        return ["boolean", value];
      case "bigint":
        return ["bigint", String(value)];
      case "number":
        return ["number", Object.is(value, -0) ? "-0" : String(value)];
      case "object":
        break;
      default:
        return unsupported();
    }
    const previous = seen.get(value);
    if (previous !== undefined) return ["ref", previous];
    const id = seen.size;
    seen.set(value, id);
    if (Object.getOwnPropertySymbols(value).length > 0) return unsupported();
    if (value instanceof Date) {
      if (
        Object.getPrototypeOf(value) !== Date.prototype ||
        Object.getOwnPropertyNames(value).length > 0
      )
        return unsupported();
      return ["date", id, String(value.getTime())];
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    )
      return unsupported();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields: unknown[] = [];
    for (const key of Object.keys(descriptors).sort()) {
      if (array && key === "length") continue;
      const property = descriptors[key]!;
      if (!property.enumerable || !("value" in property)) return unsupported();
      fields.push([key, visit(property.value)]);
    }
    return array
      ? ["array", id, value.length, fields]
      : [prototype === null ? "null-record" : "record", id, fields];
  };
  return createHash("sha256").update(JSON.stringify(visit(value))).digest("hex");
}

function hashOptions(options: object): string {
  const cached = optionsHashCache.get(options);
  if (cached !== undefined) return cached;
  const hash = hashCanonicalValue(options);
  optionsHashCache.set(options, hash);
  return hash;
}

/** Canonical data-graph hash: sorted record keys, explicit types, holes, and references. */
export function defaultCacheKey(inputs: unknown, options: unknown): string {
  const inputsHash = hashCanonicalValue(inputs);
  const optionsHash =
    typeof options === "object" && options !== null
      ? hashOptions(options)
      : hashCanonicalValue(options);
  return `${inputsHash}:${optionsHash}`;
}
