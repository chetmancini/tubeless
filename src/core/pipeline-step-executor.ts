import { artifactRecordSchema, type ArtifactRecord } from "../tracing/artifact-metadata.js";
import type { AnyStep } from "./pipeline-steps.js";
import type {
  PipelineExecutionContext,
  PipelineLogger,
  PipelineStepProgress,
  StepSkipDecision,
} from "./pipeline-types.js";
import type { PipelineTraceAttributes } from "../tracing/tracing-contracts.js";
import { validateStandardSchema } from "./pipeline-validation.js";

export interface NormalizedStepSkipDecision {
  reason: string;
  value?: unknown;
}

function normalizeStepSkipDecision(decision: StepSkipDecision): NormalizedStepSkipDecision | null {
  if (decision == null || decision === false) return null;
  if (typeof decision === "string") {
    const reason = decision.trim();
    return reason.length > 0 ? { reason } : null;
  }
  if (typeof decision === "object" && typeof decision.reason === "string") {
    const reason = decision.reason.trim();
    if (reason.length === 0) return null;
    return { reason, value: decision.value };
  }
  return null;
}

export async function evaluateStepSkip<TOptions extends object>(
  step: AnyStep<TOptions>,
  inputs: Record<string, unknown>,
  context: PipelineExecutionContext<TOptions>
): Promise<NormalizedStepSkipDecision | null> {
  if (typeof step.skip !== "function") return null;
  return normalizeStepSkipDecision(await step.skip(inputs, context));
}

export async function validateStepOutput<TOptions extends object>(
  step: AnyStep<TOptions>,
  value: unknown,
  boundary: string
): Promise<unknown> {
  return step.outputSchema
    ? validateStandardSchema(step.outputSchema, value, boundary)
    : Promise.resolve(value);
}

export async function executeStepAttempt<TOptions extends object>(input: {
  attemptId: string;
  context: PipelineExecutionContext<TOptions>;
  dryRun: boolean;
  inputs: Record<string, unknown>;
  log: PipelineLogger;
  onArtifact?(record: ArtifactRecord, preview: boolean): void;
  onProgress(progress: PipelineStepProgress): void;
  onReportAttempt(attempt: number, attributes?: PipelineTraceAttributes): void;
  outputBoundary: string;
  step: AnyStep<TOptions>;
}): Promise<unknown> {
  const { step } = input;
  let acceptsReports = true;
  const stepContext = {
    ...input.context,
    recordArtifact: (record: ArtifactRecord) => {
      if (!acceptsReports) return;
      const snapshot = artifactRecordSchema.decode(record, "artifact record");
      const preview =
        input.dryRun && (typeof step.dryRun === "function" || snapshot.operation === "write");
      input.onArtifact?.(snapshot, preview);
    },
    attemptId: input.attemptId,
    log: input.log,
    reportAttempt: input.onReportAttempt,
    reportProgress: (progress: PipelineStepProgress) => {
      if (acceptsReports) input.onProgress(progress);
    },
  };
  let output: unknown;
  try {
    output =
      input.dryRun && typeof step.dryRun === "function"
        ? await step.dryRun(input.inputs, stepContext)
        : await step.run(input.inputs, stepContext);
  } finally {
    acceptsReports = false;
  }
  return validateStepOutput(step, output, input.outputBoundary);
}
