import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { wireCustom, wireOptional, type WireSchema } from "../tracing/wire-schema.js";

export function optionalToolField<T>(schema: WireSchema<T>) {
  return wireOptional(
    wireCustom<T | null>({ anyOf: [schema.jsonSchema, { type: "null" }] }, (value, path) =>
      value === null ? null : schema.decode(value, path)
    )
  );
}

/** Reuse the runtime wire decoders for the built-in tools' Standard Schema boundaries. */
export function toolSchema<T>(schema: WireSchema<T>): StandardSchemaV1<T> {
  const properties = schema.jsonSchema.properties;
  const fields = properties && typeof properties === "object" ? Object.keys(properties) : [];
  return {
    "~standard": {
      version: 1,
      vendor: "tubeless",
      // Models supply nullable options explicitly; application calls may omit them.
      jsonSchema: { input: () => ({ ...schema.jsonSchema, required: fields }) },
      validate(value) {
        try {
          if (
            value &&
            typeof value === "object" &&
            Object.keys(value).some((key) => !fields.includes(key))
          )
            throw new Error("Unknown tool argument");
          return { value: schema.decode(value, "tool") };
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
  };
}
