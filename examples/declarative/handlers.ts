import type { ProjectRegistry } from "tubeless/project";

function rows(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((row: unknown) => typeof row === "string")) {
    throw new Error("Expected an array of strings");
  }
  return value;
}

/** Domain code stays independent of YAML parsing and document loading. */
export const registry: ProjectRegistry = {
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
    line: {
      "~standard": {
        version: 1,
        vendor: "example",
        validate(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            !("line" in value) ||
            typeof value.line !== "string"
          ) {
            return { issues: [{ message: "Expected a string line", path: ["line"] }] };
          }
          return { value: { line: value.line } };
        },
      },
    },
  },
  steps: {
    loadRows: (_inputs, context) =>
      rows("lines" in context.options ? context.options.lines : undefined),
    normalizeLine: (_inputs, context) =>
      "line" in context.options && typeof context.options.line === "string"
        ? context.options.line.trim().toLowerCase()
        : "",
  },
  finalizers: {
    normalizedRows: ({ normalize }) => rows(normalize),
    normalizedLine: ({ normalize }) => String(normalize),
    originalRows: ({ load }) => rows(load),
  },
  skipPredicates: {
    noRows: (_inputs, context) =>
      "lines" in context.options &&
      rows(context.options.lines).some((line) => line.trim().length > 0)
        ? false
        : { reason: "no non-empty rows", value: [] },
  },
  fromPipelineAdapters: {
    allRows: {
      mapOptions: (_inputs, context) => ({
        lines: "lines" in context.options ? rows(context.options.lines) : [],
      }),
    },
  },
  forEachPipelineAdapters: {
    eachRow: {
      items: (_inputs, context) =>
        ("lines" in context.options ? rows(context.options.lines) : []).filter(
          (line) => line.trim().length > 0
        ),
      key: (_line, index) => `row-${index + 1}`,
      mapOptions: (line) => ({ line }),
      progress: { itemNoun: "rows" },
    },
  },
};
