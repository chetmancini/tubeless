export interface TubelessJob {
  lines: readonly string[];
  dryRun?: boolean;
  parentRunId?: string;
}

// TypeScript types do not validate payloads on the wire; every remote host must call this.
export function assertTubelessJob(value: unknown): asserts value is TubelessJob {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lines" in value) ||
    !Array.isArray(value.lines) ||
    !value.lines.every((line: unknown) => typeof line === "string") ||
    ("dryRun" in value && value.dryRun !== undefined && typeof value.dryRun !== "boolean") ||
    ("parentRunId" in value &&
      value.parentRunId !== undefined &&
      (typeof value.parentRunId !== "string" || value.parentRunId.length === 0))
  ) {
    throw new Error("Expected string rows and optional dryRun/parentRunId");
  }
}
