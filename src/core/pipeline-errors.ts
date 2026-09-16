import { brandTubelessError } from "../utilities/tubeless-error.js";
import { formatPipelineError } from "./pipeline-diagnostics.js";
import type {
  PipelineError,
  PipelineErrorCode,
  PipelineErrorKind,
  PipelineErrorPhase,
} from "./pipeline-types.js";

export function pipelineDiagnostic(
  code: PipelineErrorCode,
  phase: PipelineErrorPhase,
  kind: PipelineErrorKind,
  message: string,
  fields: Pick<PipelineError, "stepId"> = {}
): PipelineError {
  return { code, kind, message, phase, ...fields };
}

/** Programmer error raised immediately when a pipeline graph is invalid. */
export class PipelineDefinitionError extends Error {
  constructor(
    readonly pipelineId: string,
    readonly errors: readonly PipelineError[]
  ) {
    super(
      errors.length > 0
        ? `Invalid pipeline ${pipelineId}: ${errors.map((error) => formatPipelineError(error)).join("; ")}`
        : `Invalid pipeline ${pipelineId}`
    );
    this.name = "PipelineDefinitionError";
    brandTubelessError(this, "pipeline-definition");
  }
}
