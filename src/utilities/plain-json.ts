type FormatError = (path: string, reason: string) => Error;

function dataValue(
  roundTripError: FormatError,
  descriptor: PropertyDescriptor | undefined,
  path: string
): unknown {
  if (!descriptor) throw roundTripError(path, "only own data properties round-trip.");
  if (!("value" in descriptor))
    throw roundTripError(path, "accessor properties do not round-trip.");
  if (!descriptor.enumerable)
    throw roundTripError(path, "non-enumerable properties do not round-trip.");
  return descriptor.value;
}

/** Canonical array index: "0", "1", ... but not "01", "-0" or "1.5". */
function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function assertPlainArray(
  roundTripError: FormatError,
  value: unknown[],
  path: string,
  seen: Set<object>
): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw roundTripError(path, "array subclasses do not round-trip.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length" && (typeof key !== "string" || !isArrayIndexKey(key))) {
      throw roundTripError(path, "arrays may only own index and length properties.");
    }
  }
  for (let index = 0; index < value.length; index++) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor) throw roundTripError(itemPath, "sparse arrays do not round-trip.");
    assertPlainJson(
      roundTripError,
      dataValue(roundTripError, descriptor, itemPath),
      itemPath,
      seen
    );
  }
}

function assertPlainObject(
  roundTripError: FormatError,
  value: object,
  path: string,
  seen: Set<object>
): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw roundTripError(path, "only objects with Object.prototype round-trip.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw roundTripError(path, "symbol keys do not round-trip.");
    const itemPath = `${path}.${key}`;
    assertPlainJson(
      roundTripError,
      dataValue(roundTripError, Object.getOwnPropertyDescriptor(value, key), itemPath),
      itemPath,
      seen
    );
  }
}

/**
 * Reject every value that would not come back identical from JSON.stringify and JSON.parse.
 * Inspects own properties through descriptors so no user getter runs during validation.
 * `seen` rejects shared and circular references, which JSON would duplicate or fail on.
 */
function assertPlainJson(
  roundTripError: FormatError,
  value: unknown,
  path: string,
  seen: Set<object>
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw roundTripError(path, "NaN and infinities do not round-trip.");
    if (Object.is(value, -0)) throw roundTripError(path, "-0 does not round-trip.");
    return;
  }
  if (typeof value !== "object") {
    throw roundTripError(
      path,
      "only plain objects, arrays, strings, finite numbers, booleans and null round-trip."
    );
  }
  if (seen.has(value)) {
    throw roundTripError(path, "shared or circular references do not round-trip.");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    assertPlainArray(roundTripError, value, path, seen);
  } else {
    assertPlainObject(roundTripError, value, path, seen);
  }
}

/** Validate without invoking getters, then encode a lossless plain JSON value. */
export function encodePlainJson(value: unknown, formatError: FormatError): Uint8Array {
  assertPlainJson(formatError, value, "value", new Set());
  return new TextEncoder().encode(JSON.stringify(value));
}
