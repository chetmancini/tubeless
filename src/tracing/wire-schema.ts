/** JSON Schema fragment emitted from a dependency-free runtime wire schema. */
export type WireJsonSchema = Readonly<Record<string, unknown>>;

const wireType = Symbol("tubeless.wire-schema.type");

/** A dependency-free decoder paired with the JSON Schema for its decoded value. */
export interface WireSchema<T> {
  readonly [wireType]?: T;
  readonly jsonSchema: WireJsonSchema;
  readonly optionalInput: boolean;
  readonly optionalOutput: boolean;
  decode(value: unknown, path: string): T;
}

export type InferWireSchema<TSchema extends WireSchema<unknown>> =
  TSchema extends WireSchema<infer TValue> ? TValue : never;

type WireShape = Readonly<Record<string, WireSchema<unknown>>>;
type OptionalShapeKeys<TShape extends WireShape> = {
  [TKey in keyof TShape]-?: undefined extends InferWireSchema<TShape[TKey]> ? TKey : never;
}[keyof TShape];
type RequiredShapeKeys<TShape extends WireShape> = Exclude<keyof TShape, OptionalShapeKeys<TShape>>;
type InferWireShape<TShape extends WireShape> = {
  [TKey in RequiredShapeKeys<TShape>]: InferWireSchema<TShape[TKey]>;
} & {
  [TKey in OptionalShapeKeys<TShape>]?: Exclude<InferWireSchema<TShape[TKey]>, undefined>;
};

interface StringOptions {
  readonly allowEmpty?: boolean;
  readonly maxLength?: number;
}

interface NumberOptions {
  readonly integer?: boolean;
  readonly minimum?: number;
}

interface ArrayOptions {
  readonly maxItems?: number;
  readonly noun?: string;
}

function schema<T>(
  jsonSchema: WireJsonSchema,
  decode: WireSchema<T>["decode"],
  options: { readonly optionalInput?: boolean; readonly optionalOutput?: boolean } = {}
): WireSchema<T> {
  return {
    decode,
    jsonSchema,
    optionalInput: options.optionalInput ?? false,
    optionalOutput: options.optionalOutput ?? false,
  };
}

function childPath(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

export function wireBoolean(): WireSchema<boolean> {
  return schema({ type: "boolean" }, (value, path) => {
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
    return value;
  });
}

export function wireNumber(options: NumberOptions = {}): WireSchema<number> {
  const jsonSchema: Record<string, unknown> = { type: options.integer ? "integer" : "number" };
  if (options.minimum !== undefined) jsonSchema.minimum = options.minimum;
  return schema(jsonSchema, (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number`);
    }
    if (
      options.integer &&
      (!Number.isSafeInteger(value) || value < (options.minimum ?? -Infinity))
    ) {
      if (options.minimum === 0) throw new Error(`${path} must be a nonnegative safe integer`);
      throw new Error(`${path} must be a safe integer`);
    }
    if (options.minimum !== undefined && value < options.minimum) {
      throw new Error(`${path} must be at least ${options.minimum}`);
    }
    return value;
  });
}

export function wireString(options: StringOptions = {}): WireSchema<string> {
  const jsonSchema: Record<string, unknown> = { type: "string" };
  if (options.allowEmpty !== true) jsonSchema.minLength = 1;
  if (options.maxLength !== undefined) jsonSchema.maxLength = options.maxLength;
  return schema(jsonSchema, (value, path) => {
    if (typeof value !== "string" || (options.allowEmpty !== true && value.length === 0)) {
      throw new Error(
        options.allowEmpty === true
          ? `${path} must be a string`
          : `${path} must be a non-empty string`
      );
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      throw new Error(`${path} exceeds ${options.maxLength} code units`);
    }
    return value;
  });
}

export function wireLiteral<const TValue extends boolean | number | string>(
  value: TValue,
  message?: (path: string) => string
): WireSchema<TValue> {
  return schema({ const: value, type: typeof value }, (input, path) => {
    if (input !== value) throw new Error(message?.(path) ?? `${path} must be ${String(value)}`);
    return value;
  });
}

export function wireEnum<const TValues extends readonly string[]>(
  values: TValues,
  message: (path: string) => string = (path) => `${path} is unsupported`
): WireSchema<TValues[number]> {
  const accepted = new Set<string>(values);
  return schema({ enum: values, type: "string" }, (value, path) => {
    if (typeof value !== "string" || !accepted.has(value)) throw new Error(message(path));
    // SAFETY: Set membership proves the string is one of the const tuple's values.
    return value as TValues[number];
  });
}

export function wireOptional<T>(inner: WireSchema<T>): WireSchema<T | undefined> {
  return schema(
    inner.jsonSchema,
    (value, path) => (value === undefined ? undefined : inner.decode(value, path)),
    { optionalInput: true, optionalOutput: true }
  );
}

export function wireDefault<T>(inner: WireSchema<T>, fallback: T): WireSchema<T> {
  return schema(
    inner.jsonSchema,
    (value, path) => (value === undefined ? fallback : inner.decode(value, path)),
    { optionalInput: true }
  );
}

export function wireArray<T>(
  item: WireSchema<T>,
  options: ArrayOptions = {}
): WireSchema<readonly T[]> {
  const jsonSchema: Record<string, unknown> = { items: item.jsonSchema, type: "array" };
  if (options.maxItems !== undefined) jsonSchema.maxItems = options.maxItems;
  return schema(jsonSchema, (value, path) => {
    if (
      !Array.isArray(value) ||
      (options.maxItems !== undefined && value.length > options.maxItems)
    ) {
      const bound =
        options.maxItems === undefined
          ? ""
          : ` of at most ${options.maxItems}${options.noun ? ` ${options.noun}` : ""}`;
      throw new Error(`${path} must be an array${bound}`);
    }
    return value.map((entry, index) => item.decode(entry, `${path}[${index}]`));
  });
}

export function wireObject<const TShape extends WireShape>(
  shape: TShape
): WireSchema<InferWireShape<TShape>> {
  const required = Object.entries(shape)
    .filter(([, child]) => !child.optionalOutput)
    .map(([key]) => key);
  const properties = Object.fromEntries(
    Object.entries(shape).map(([key, child]) => [key, child.jsonSchema])
  );
  return schema(
    {
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
      type: "object",
    },
    (value, path) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      // SAFETY: The object guard above excludes null and arrays, so named properties are safe to read.
      const source = value as Record<string, unknown>;
      const decoded: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape)) {
        const item = child.decode(source[key], childPath(path, key));
        if (item !== undefined) decoded[key] = item;
      }
      // SAFETY: Every declared field was decoded by its schema and optional undefined fields were omitted.
      return decoded as InferWireShape<TShape>;
    }
  );
}

export function wireRecord<T>(
  valueSchema: WireSchema<T>,
  message?: (path: string) => string
): WireSchema<Readonly<Record<string, T>>> {
  return schema({ additionalProperties: valueSchema.jsonSchema, type: "object" }, (value, path) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    const decoded: Record<string, T> = {};
    for (const [key, item] of Object.entries(value)) {
      try {
        decoded[key] = valueSchema.decode(item, `${path}.${key}`);
      } catch {
        throw new Error(message?.(path) ?? `${path} contains an unsupported value`);
      }
    }
    return decoded;
  });
}

export function wireUnion<const TSchemas extends readonly WireSchema<unknown>[]>(
  schemas: TSchemas,
  message?: (path: string) => string
): WireSchema<InferWireSchema<TSchemas[number]>> {
  return schema({ oneOf: schemas.map((entry) => entry.jsonSchema) }, (value, path) => {
    for (const candidate of schemas) {
      try {
        // SAFETY: A successful candidate decoder returns one member of the requested schema union.
        return candidate.decode(value, path) as InferWireSchema<TSchemas[number]>;
      } catch {
        // Try the next branch; the union owns the final diagnostic.
      }
    }
    throw new Error(message?.(path) ?? `${path} is unsupported`);
  });
}

export function wireRefine<T>(
  inner: WireSchema<T>,
  check: (value: T, path: string) => void,
  jsonSchema: WireJsonSchema = inner.jsonSchema
): WireSchema<T> {
  return schema(
    jsonSchema,
    (value, path) => {
      const decoded = inner.decode(value, path);
      check(decoded, path);
      return decoded;
    },
    { optionalInput: inner.optionalInput, optionalOutput: inner.optionalOutput }
  );
}

export function wireTransform<TInput, TOutput>(
  inner: WireSchema<TInput>,
  transform: (value: TInput) => TOutput
): WireSchema<TOutput> {
  return schema(inner.jsonSchema, (value, path) => transform(inner.decode(value, path)), {
    optionalInput: inner.optionalInput,
    optionalOutput: inner.optionalOutput,
  });
}

export function wireCustom<T>(
  jsonSchema: WireJsonSchema,
  decode: WireSchema<T>["decode"]
): WireSchema<T> {
  return schema(jsonSchema, decode);
}

export function wireDiscriminatedUnion<
  TKey extends string,
  const TVariants extends Readonly<Record<string, WireSchema<unknown>>>,
>(key: TKey, variants: TVariants): WireSchema<InferWireSchema<TVariants[keyof TVariants]>> {
  return schema(
    { oneOf: Object.values(variants).map((variant) => variant.jsonSchema) },
    (value, path) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      // SAFETY: The object guard above excludes null and arrays, so the discriminator is safe to read.
      const discriminator = (value as Record<string, unknown>)[key];
      if (typeof discriminator !== "string" || !(discriminator in variants)) {
        throw new Error(`${key} is unsupported`);
      }
      // SAFETY: The membership check selects a declared variant whose decoder returns a union member.
      return variants[discriminator]!.decode(value, path) as InferWireSchema<
        TVariants[keyof TVariants]
      >;
    }
  );
}
