import { createSteps, definePipeline, requireOutputs, type StandardSchemaV1 } from "tubeless";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"]
): StandardSchemaV1<TInput, TOutput> {
  return {
    "~standard": {
      validate,
      vendor: "example",
      version: 1,
    },
  };
}

const optionsSchema = standardSchema<{ source: string }, { limit: number; source: string }>(
  (value) => {
    // SAFETY: value is unvalidated external input; the optional `source` field is only
    // read so the typeof check below can validate it before any use.
    const source = (value as { source?: unknown }).source;
    return typeof source === "string"
      ? { value: { limit: 100, source } }
      : { issues: [{ message: "Expected a source path", path: ["source"] }] };
  }
);

const rowsSchema = standardSchema<readonly string[], { readonly rows: readonly string[] }>(
  (value) =>
    Array.isArray(value)
      ? // SAFETY: Array.isArray proved an array; this minimal example trusts element
        // types instead of checking every item.
        { value: { rows: value as readonly string[] } }
      : { issues: [{ message: "Expected rows" }] }
);

const resultSchema = standardSchema<
  { count: number; source: string },
  { count: number; source: string; validated: true }
>((value) => {
  // SAFETY: the result schema validates this pipeline's own finalize output, which is
  // constructed as { count, source } by the finalize below — internal data, not external input.
  const result = value as { count: number; source: string };
  return { value: { ...result, validated: true } };
});

const step = createSteps(optionsSchema);

const load = step("load", {
  outputSchema: rowsSchema,
  run: (_inputs, context) => [context.options.source].slice(0, context.options.limit),
});

export const ValidatedPipeline = definePipeline({
  id: "validated-import",
  steps: [load],
  resultSchema,
  finalize: requireOutputs([load], ({ load }, context) => ({
    count: load.rows.length,
    source: context.options.source,
  })),
});

export async function runValidatedExample() {
  const result = await ValidatedPipeline.runOrThrow({ source: "rows.txt" });
  return result.validated;
}

if (false) {
  // @ts-expect-error Options are inferred from the schema input.
  ValidatedPipeline.runOrThrow({});

  // SAFETY: an empty array literal has no elements that could violate readonly string[].
  const duplicate = step("load", { run: () => [] as readonly string[] });
  // @ts-expect-error Literal duplicate step IDs are rejected at definition time.
  definePipeline({ id: "duplicate", steps: [load, duplicate], finalize: () => undefined });
}
