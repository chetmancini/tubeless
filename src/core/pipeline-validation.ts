import type {
  InferSchemaOutput,
  PipelineValidationIssue,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./pipeline-types.js";

export class PipelineBoundaryValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly PipelineValidationIssue[],
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PipelineBoundaryValidationError";
  }
}

function normalizeValidationPath(
  path: StandardSchemaV1Issue["path"]
): readonly (number | string)[] | undefined {
  if (!path || path.length === 0) return undefined;
  return path.map((segment) => {
    const key = typeof segment === "object" && segment !== null ? segment.key : segment;
    return typeof key === "number" || typeof key === "string" ? key : String(key);
  });
}

function renderValidationIssue(issue: PipelineValidationIssue): string {
  const location = issue.path?.map(String).join(".");
  return location ? `${location}: ${issue.message}` : issue.message;
}

export async function validateStandardSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
  boundary: string
): Promise<InferSchemaOutput<TSchema>> {
  let result: StandardSchemaV1Result<InferSchemaOutput<TSchema>>;
  try {
    result = await schema["~standard"].validate(value);
  } catch (error) {
    throw new PipelineBoundaryValidationError(
      `${boundary} schema (${schema["~standard"].vendor}) threw while validating`,
      [],
      error
    );
  }
  if (result.issues) {
    const issues = result.issues.map((issue) => {
      const path = normalizeValidationPath(issue.path);
      const normalized: PipelineValidationIssue = { message: issue.message };
      if (path) normalized.path = path;
      return normalized;
    });
    throw new PipelineBoundaryValidationError(
      `${boundary} validation failed: ${issues.map(renderValidationIssue).join("; ")}`,
      issues
    );
  }
  return result.value;
}
