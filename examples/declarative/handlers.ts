import type { PipelineDocumentRegistry } from "tubeless/project";

function rows(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((row: unknown) => typeof row === "string")) {
    throw new Error("Expected an array of strings");
  }
  return value;
}

/** Domain code stays independent of YAML parsing and document loading. */
export const registry: PipelineDocumentRegistry = {
  optionsSchemas: {
    lines: {
      "~standard": {
        version: 1,
        vendor: "example",
        validate(value) {
          if (typeof value !== "object" || value === null || !("lines" in value)) {
            return { issues: [{ message: "Expected lines", path: ["lines"] }] };
          }
          if (
            !Array.isArray(value.lines) ||
            !value.lines.every((line: unknown) => typeof line === "string")
          ) {
            return { issues: [{ message: "Expected string lines", path: ["lines"] }] };
          }
          return { value: { lines: value.lines } };
        },
      },
    },
  },
  steps: {
    loadRows: (_inputs, context) =>
      rows("lines" in context.options ? context.options.lines : undefined),
    normalizeRows: ({ load }) =>
      rows(load)
        .map((row) => row.trim().toLowerCase())
        .filter(Boolean),
  },
  finalizers: {
    normalizedRows: ({ normalize }) => rows(normalize),
    originalRows: ({ load }) => rows(load),
  },
};
