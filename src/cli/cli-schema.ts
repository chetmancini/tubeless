import type { StandardSchemaV1 } from "../core/pipeline.js";
import type { CliParam, CliParamsSchema } from "./cli-types.js";

type ScalarParam<T> = [T] extends [string]
  ? { type: "string"; choices: readonly T[] }
  : [T] extends [number]
    ? { type: "number" }
    : [T] extends [boolean]
      ? { type: "boolean" }
      : never;

/** Input types describe flag values; the runtime schema supplies their metadata. */
export type InferredCliParams<TOptions extends object> = {
  [K in keyof TOptions]-?: NonNullable<TOptions[K]> extends readonly (infer TItem)[]
    ? ScalarParam<TItem> & { multiple: true }
    : ScalarParam<NonNullable<TOptions[K]>> &
        (undefined extends TOptions[K] ? { optional: true } : {});
};

type FlagOverride = Pick<CliParam, "description" | "flag" | "short" | "env">;
export type InferredFlagOverrides<TOptions extends object> = {
  [K in keyof TOptions]?: FlagOverride;
};

function unsupported(location: string, reason: string): never {
  throw new Error(
    `Cannot infer CLI flags for ${location}: ${reason}. Supply explicit params and, if needed, mapOptions in definePipelineCommand.`
  );
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unsupported(location, "expected an object schema");
  }
  // SAFETY: the object guard above excludes null, primitives and arrays.
  return value as Record<string, unknown>;
}

function resolveSchema(
  value: unknown,
  root: Record<string, unknown>,
  location: string,
  seen = new Set<string>()
): Record<string, unknown> {
  const schema = record(value, location);
  if (schema.$ref === undefined) return schema;
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) {
    return unsupported(location, "only local JSON Schema references are supported");
  }
  if (seen.has(schema.$ref)) return unsupported(location, "recursive schema");
  seen.add(schema.$ref);
  let target: unknown = root;
  for (const segment of schema.$ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    const parent = record(target, location);
    target = Object.hasOwn(parent, key) ? parent[key] : undefined;
  }
  const { $ref: _ref, ...siblings } = schema;
  return { ...resolveSchema(target, root, location, seen), ...siblings };
}

function scalarParam(schema: Record<string, unknown>, location: string): CliParam {
  if (schema.anyOf || schema.oneOf || schema.allOf || schema.not || schema.if) {
    return unsupported(location, "union and conditional schemas need an explicit mapping");
  }
  const choices = schema.enum ?? (schema.const === undefined ? undefined : [schema.const]);
  const type = schema.type ?? (Array.isArray(choices) ? typeof choices[0] : undefined);
  if (choices !== undefined && type !== "string") {
    return unsupported(location, "non-string enum and const constraints need explicit parameters");
  }
  switch (type) {
    case "string": {
      if (
        choices !== undefined &&
        (!Array.isArray(choices) || !choices.every((v) => typeof v === "string"))
      ) {
        return unsupported(location, "expected string choices");
      }
      return { type: "string", ...(choices ? { choices } : {}) };
    }
    case "integer":
    case "number":
      return {
        type: "number",
        ...(type === "integer" ? { integer: true } : {}),
        ...(typeof schema.minimum === "number" ? { min: schema.minimum } : {}),
        ...(typeof schema.maximum === "number" ? { max: schema.maximum } : {}),
      };
    case "boolean":
      return { type: "boolean" };
    default:
      return unsupported(
        location,
        "expected a string, number, boolean, or repeatable scalar array"
      );
  }
}

/** Convert metadata only. Domain validation and transformations still belong to the pipeline. */
export function inferCliParams(
  optionsSchema: StandardSchemaV1,
  overrides: Record<string, FlagOverride | undefined> = {}
): CliParamsSchema {
  const converter = optionsSchema["~standard"].jsonSchema;
  if (!converter) {
    return unsupported(
      "pipeline options",
      "the options schema does not expose Standard JSON Schema input metadata"
    );
  }
  let root: Record<string, unknown>;
  try {
    root = converter.input({ target: "draft-2020-12" });
  } catch (cause) {
    throw new Error(
      "Cannot infer CLI flags: the options schema could not generate draft-2020-12 input metadata. Supply explicit params and, if needed, mapOptions in definePipelineCommand.",
      { cause }
    );
  }
  const schema = resolveSchema(root, root, "pipeline options");
  if (schema.type !== "object" || schema.anyOf || schema.oneOf || schema.allOf || schema.if) {
    return unsupported("pipeline options", "expected a flat object schema");
  }
  if (
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
    schema.patternProperties !== undefined
  ) {
    return unsupported("pipeline options", "dynamic property schemas need explicit parameters");
  }
  const properties = record(schema.properties ?? {}, "pipeline properties");
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const params: CliParamsSchema = {};
  for (const [key, value] of Object.entries(properties)) {
    const field = resolveSchema(value, root, key);
    let param: CliParam;
    if (field.type === "array") {
      if (
        field.default !== undefined ||
        field.prefixItems ||
        field.anyOf ||
        field.oneOf ||
        field.allOf
      ) {
        return unsupported(key, "array defaults, tuples and unions need an explicit mapping");
      }
      const item = scalarParam(resolveSchema(field.items, root, key), key);
      if (item.type !== "string" && item.type !== "number") {
        return unsupported(key, "repeatable flags require string or number items");
      }
      param = { ...item, multiple: true };
    } else {
      param = scalarParam(field, key);
      if (field.default !== undefined) {
        if (typeof field.default !== param.type)
          return unsupported(key, "default does not match the flag type");
        // SAFETY: the default's primitive type was checked against the parameter discriminant.
        param = { ...param, default: field.default } as CliParam;
      } else if (param.type !== "boolean" && !required.has(key)) {
        param.optional = true;
      }
    }
    if (typeof field.description === "string") param.description = field.description;
    Object.defineProperty(params, key, {
      value: { ...param, ...overrides[key] },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(properties, key)) unsupported(key, "override does not name an option");
  }
  return params;
}
