import type { StandardSchemaV1 } from "../core/pipeline.js";

export function schema<Input, Output = Input>(
  validate: StandardSchemaV1<Input, Output>["~standard"]["validate"],
  descriptor: Record<string, unknown> = {}
): StandardSchemaV1<Input, Output> {
  return {
    "~standard": { version: 1, vendor: "test", validate, jsonSchema: { input: () => descriptor } },
  };
}

export const emptyInput = schema<{}>(() => ({ value: {} }), { type: "object", properties: {} });
export const numberSchema = schema<number>(
  (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? { value }
      : { issues: [{ message: "Expected number" }] },
  { type: "number" }
);
export const textSchema = schema<string>(
  (value) => (typeof value === "string" ? { value } : { issues: [{ message: "Expected text" }] }),
  { type: "string" }
);
