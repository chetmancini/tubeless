import type { StandardSchemaV1 } from "./pipeline-types.js";
import { PipelineBoundaryValidationError, validateStandardSchema } from "./pipeline-validation.js";

export async function validatePipelineOptions(
  schema: StandardSchemaV1 | undefined,
  input: object,
  boundary: string
): Promise<object> {
  const value = schema ? await validateStandardSchema(schema, input, boundary) : input;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new PipelineBoundaryValidationError(`${boundary} returned a non-object value`, [
      { message: "Expected the validated options value to be an object" },
    ]);
  return value;
}

/** Private validation receipt, bound to its schema and raw input; never a public bypass. */
export class PreparedOptions {
  private constructor(
    private readonly schema: StandardSchemaV1 | undefined,
    private readonly input: object,
    private readonly value: object
  ) {}

  static async prepare(schema: StandardSchemaV1 | undefined, input: object, boundary: string) {
    return new PreparedOptions(
      schema,
      input,
      await validatePipelineOptions(schema, input, boundary)
    );
  }

  /** Internal recovery only: restore a receipt after its owning definition and journal were checked. */
  static restore(
    schema: StandardSchemaV1 | undefined,
    input: object,
    value: object
  ): PreparedOptions {
    return new PreparedOptions(schema, input, value);
  }

  read(schema: StandardSchemaV1 | undefined, input: object): object {
    if (schema !== this.schema || input !== this.input)
      throw new Error("Prepared pipeline options do not match this invocation");
    return this.value;
  }
}
