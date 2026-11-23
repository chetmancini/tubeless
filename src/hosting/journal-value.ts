const JOURNAL_VALUE_BYTES = 65_536;

type Encoded =
  | null
  | boolean
  | number
  | string
  | ["u" | "-0"]
  | ["array", Encoded[]]
  | ["object", [string, Encoded][]];

function encode(value: unknown, seen: Set<object>): Encoded {
  if (value === undefined) return ["u"];
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value))
    return Object.is(value, -0) ? ["-0"] : value;
  if (!value || typeof value !== "object" || seen.has(value))
    throw new TypeError(
      "Journal values must be finite plain data without shared or circular references."
    );
  seen.add(value);
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
    throw new TypeError("Journal values must use plain objects and arrays.");
  const entries = Reflect.ownKeys(value).flatMap((key): [string, Encoded][] => {
    if (array && key === "length") return [];
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
      throw new TypeError("Journal values must use enumerable string data properties.");
    return [[key, encode(descriptor.value, seen)]];
  });
  if (!array) return ["object", entries];
  if (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
    throw new TypeError("Journal arrays must be dense and contain only indexed values.");
  return ["array", entries.map(([, item]) => item)];
}

export function encodeJournalValue(value: unknown): string {
  const text = JSON.stringify(encode(value, new Set()));
  if (new TextEncoder().encode(text).byteLength > JOURNAL_VALUE_BYTES)
    throw new TypeError("Journal value must fit within 64 KiB.");
  return text;
}

function decode(value: Encoded): unknown {
  if (!Array.isArray(value)) return value;
  switch (value[0]) {
    case "u":
      return undefined;
    case "-0":
      return -0;
    case "array":
      return value[1].map(decode);
    case "object":
      return Object.fromEntries(value[1].map(([key, item]) => [key, decode(item)]));
  }
}

/** Decode only the bytes written by this journal codec. */
export function decodeJournalValue(value: string): unknown {
  return decode(JSON.parse(value) as Encoded);
}
