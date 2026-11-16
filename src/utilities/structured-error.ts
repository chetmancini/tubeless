/** Encoded error and collection bounds shared by producers, services and clients. */
export const STRUCTURED_ERROR_LIMITS = { bytes: 12_000, count: 8, omitted: 1_000_000 } as const;

/** Bounded projection of the existing OSS PipelineError, including legacy message-only errors. */
export interface StructuredError {
  message: string;
  code?: string;
  kind?: string;
  phase?: string;
  stepId?: string;
  sourceCode?: string;
  stack?: string;
  cause?: ErrorCause;
  issues?: { message: string; path?: (string | number)[] }[];
  fanOut?: {
    failures: {
      index: number;
      key: string;
      keyTruncated: boolean;
      cancelled: boolean;
      error: ErrorCause;
    }[];
    failureCount: number;
    omittedFailureCount: number;
    schedulerError?: ErrorCause;
  };
  truncated?: true;
}
interface ErrorCause {
  message: string;
  name?: string;
  sourceCode?: string;
  cause?: ErrorCause;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Select existing framework error fields and enforce the final serialized byte bound. */
export function structuredError(value: unknown): StructuredError | undefined {
  const input = object(value);
  if (typeof input.message !== "string") return;
  let truncated = input.truncated === true;
  const clip = (s: string, max: number) => {
    if (s.length > max) truncated = true;
    return s.slice(0, max);
  };
  const fields = (source: Record<string, unknown>, keys: string[], target: object) => {
    for (const key of keys)
      if (typeof source[key] === "string")
        Object.assign(target, { [key]: clip(source[key], key === "stack" ? 4000 : 120) });
  };
  const cause = (value: unknown, depth = 0): ErrorCause | undefined => {
    const c = object(value);
    if (typeof c.message !== "string") return;
    const result: ErrorCause = { message: clip(c.message, 1000) };
    fields(c, ["name", "sourceCode"], result);
    if (c.cause !== undefined) {
      if (depth < 3) result.cause = cause(c.cause, depth + 1);
      else truncated = true;
    }
    return result;
  };
  const result: StructuredError = { message: clip(input.message, 2000) };
  fields(input, ["code", "kind", "phase", "stepId", "sourceCode", "stack"], result);
  if (input.cause !== undefined) result.cause = cause(input.cause);
  if (Array.isArray(input.issues)) {
    if (input.issues.length > 8) truncated = true;
    result.issues = input.issues.slice(0, 8).flatMap((value) => {
      const issue = object(value);
      if (typeof issue.message !== "string") return [];
      const path = Array.isArray(issue.path)
        ? issue.path
            .slice(0, 8)
            .flatMap<string | number>((v) =>
              typeof v === "string"
                ? [clip(v, 120)]
                : typeof v === "number" && Number.isFinite(v)
                  ? [v]
                  : []
            )
        : undefined;
      if (Array.isArray(issue.path) && issue.path.length > 8) truncated = true;
      return [{ message: clip(issue.message, 500), ...(path ? { path } : {}) }];
    });
  }
  const fan = object(input.fanOut);
  if (Array.isArray(fan.failures)) {
    const failures = fan.failures.slice(0, 8).flatMap((value) => {
      const f = object(value),
        error = cause(f.error);
      if (!error || !Number.isSafeInteger(f.index) || typeof f.key !== "string") return [];
      return [
        {
          index: f.index as number,
          key: clip(f.key, 1024),
          keyTruncated: f.keyTruncated === true || f.key.length > 1024,
          cancelled: f.cancelled === true,
          error,
        },
      ];
    });
    const total =
      typeof fan.failureCount === "number" && Number.isSafeInteger(fan.failureCount)
        ? Math.max(fan.failureCount, fan.failures.length)
        : fan.failures.length;
    result.fanOut = {
      failures,
      failureCount: total,
      omittedFailureCount: total - failures.length,
      schedulerError: cause(fan.schedulerError),
    };
    if (total > failures.length) truncated = true;
  }
  if (truncated) result.truncated = true;
  const size = () => new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (size() > STRUCTURED_ERROR_LIMITS.bytes) {
    delete result.stack;
    delete result.fanOut;
    delete result.issues;
    delete result.cause;
    result.truncated = true;
    // JSON escaping can make even the bounded message exceed the byte budget.
    // The remaining fixed-size classification fields fit with an empty message.
    const characters = Array.from(result.message);
    let low = 0,
      high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      result.message = characters.slice(0, middle).join("");
      if (size() <= STRUCTURED_ERROR_LIMITS.bytes) low = middle;
      else high = middle - 1;
    }
    result.message = characters.slice(0, low).join("");
  }
  return result;
}

/** Bounded run-level error observations; omissions include invalid or unretained entries. */
export interface StructuredErrors {
  structuredErrors: StructuredError[];
  omittedStructuredErrors: number;
}

/** Apply the same error-list projection at every execution and retrieval boundary. */
export function projectStructuredErrors(
  errors: readonly unknown[],
  omitted: unknown = 0
): StructuredErrors {
  const structuredErrors = errors.slice(0, STRUCTURED_ERROR_LIMITS.count).flatMap((value) => {
    const error = structuredError(value);
    return error ? [error] : [];
  });
  return {
    structuredErrors,
    omittedStructuredErrors: Math.min(
      STRUCTURED_ERROR_LIMITS.omitted,
      errors.length -
        structuredErrors.length +
        (typeof omitted === "number" && Number.isSafeInteger(omitted) ? Math.max(0, omitted) : 0)
    ),
  };
}
