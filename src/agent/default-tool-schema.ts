import type { StandardSchemaV1 } from "../core/pipeline-types.js";
import { wireCustom, wireObject, wireOptional, type WireSchema } from "../tracing/wire-schema.js";

export function optionalToolField<T>(schema: WireSchema<T>) {
  return wireOptional(
    wireCustom<T | null>({ anyOf: [schema.jsonSchema, { type: "null" }] }, (value, path) =>
      value === null ? null : schema.decode(value, path)
    )
  );
}

/** Build a built-in tool's object boundary from its declared field schemas. */
export function toolObject<const Shape extends Readonly<Record<string, WireSchema<unknown>>>>(
  shape: Shape
) {
  const schema = wireObject(shape);
  const fields = Object.keys(shape);
  const standard: StandardSchemaV1<ReturnType<typeof schema.decode>> = {
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
  return standard;
}
