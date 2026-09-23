import type { StandardSchemaV1 } from "tubeless";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRows(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((row: unknown) => typeof row === "string");
}

export interface AirflowResult {
  rows: string[];
  count: number;
  runId: string;
  preview: boolean;
}

// This example uses native JSON XComs, not custom serialized Python objects.
export const airflowResultSchema: StandardSchemaV1<unknown, AirflowResult> = {
  "~standard": {
    vendor: "airflow-example",
    version: 1,
    validate(value) {
      if (
        isRecord(value) &&
        isRows(value.rows) &&
        value.count === value.rows.length &&
        typeof value.runId === "string" &&
        value.runId.length > 0 &&
        typeof value.preview === "boolean"
      ) {
        return {
          value: {
            rows: value.rows,
            count: value.rows.length,
            runId: value.runId,
            preview: value.preview,
          },
        };
      }
      return {
        issues: [{ message: "Expected a Tubeless run ID, rows, matching count, and preview flag" }],
      };
    },
  },
};
