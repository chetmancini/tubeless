import { isAbortError, throwIfAborted } from "../utilities/abort.js";
import { PipelineOutputObservationFailure } from "./pipeline-execution-error.js";
import type {
  PipelineStepOutputContext,
  PipelineStepOutputObserver,
  PipelineStepOutputRecord,
} from "./pipeline-types.js";

export function isStepOutputObserver(value: unknown): value is PipelineStepOutputObserver {
  return (
    value !== null &&
    typeof value === "object" &&
    "encode" in value &&
    typeof value.encode === "function" &&
    "write" in value &&
    typeof value.write === "function"
  );
}

export interface RunOutputObservation extends PipelineStepOutputContext {
  readonly observer: PipelineStepOutputObserver;
  readonly pipelineId: string;
  readonly runId: string;
  readonly definitionIdentity: PipelineStepOutputRecord["definitionIdentity"];
}

/** Validation has succeeded; commit remains deferred until normal cache work finishes. */
export interface PreparedStepOutput {
  readonly value: unknown;
  readonly commit?: () => Promise<void>;
}

async function outputOperation<T>(
  context: PipelineStepOutputContext,
  run: () => T | Promise<T>
): Promise<T> {
  throwIfAborted(context.signal, "Step output observation");
  try {
    const result = await run();
    throwIfAborted(context.signal, "Step output observation");
    return result;
  } catch (cause) {
    throwIfAborted(context.signal, "Step output observation");
    if (isAbortError(cause)) throw cause;
    throw new PipelineOutputObservationFailure(cause);
  }
}

/** Capture before validation; a writer exists only once valid, detached bytes are ready. */
export async function prepareStepOutput(
  raw: unknown,
  validate: ((value: unknown) => Promise<unknown>) | undefined,
  observation: RunOutputObservation | undefined,
  step: Pick<PipelineStepOutputRecord, "stepId" | "attemptId" | "origin">
): Promise<PreparedStepOutput> {
  if (!observation) return { value: validate ? await validate(raw) : raw };
  const context = Object.freeze({ signal: observation.signal });
  const encodedValue = await outputOperation(context, async () => {
    const encoded = await observation.observer.encode(raw, context);
    if (!(encoded instanceof Uint8Array)) throw new TypeError("Output encoder must return bytes");
    return Uint8Array.from(encoded);
  });
  const value = validate ? await validate(raw) : raw;
  return {
    value,
    commit: () =>
      outputOperation(context, () =>
        observation.observer.write(
          {
            pipelineId: observation.pipelineId,
            runId: observation.runId,
            definitionIdentity: { ...observation.definitionIdentity },
            stepId: step.stepId,
            ...(step.attemptId !== undefined ? { attemptId: step.attemptId } : {}),
            origin: step.origin,
            encodedValue,
          },
          context
        )
      ),
  };
}
