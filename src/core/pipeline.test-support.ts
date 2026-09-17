import { expect } from "vitest";
import {
  createSteps,
  definePipeline,
  PipelineDefinitionError,
  type PipelineError,
  type StandardSchemaV1,
} from "./pipeline.js";

export interface TestOptions {
  failFinalize?: boolean;
  failStep?: string;
}

export function makePipeline(id: string, finalizeValue?: unknown, useFinalizeValue = false) {
  const { step } = createSteps<TestOptions>();

  const build = step("build", {
    run: (_inputs, context) => {
      if (context.options.failStep === "build") {
        throw new Error("build failed");
      }
      return "build";
    },
  });
  const write = step("write", {
    dependsOn: [build],
    run: (inputs) => `${inputs.build}+write`,
  });

  return definePipeline({
    id,
    steps: [build, write],
    targets: [build, write],
    finalize: (outputs, context) => {
      if (context.options.failFinalize) {
        throw new Error("finalize failed");
      }
      return useFinalizeValue ? finalizeValue : [outputs.build, outputs.write].filter(Boolean);
    },
  });
}

export function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"],
  vendor = "test"
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor, version: 1 } };
}

export function thrownDefinitionErrors(define: () => unknown): readonly PipelineError[] {
  try {
    define();
  } catch (error) {
    expect(error).toBeInstanceOf(PipelineDefinitionError);
    // SAFETY: the assertion above proves the caught value is a definition error.
    return (error as PipelineDefinitionError).errors;
  }
  throw new Error("expected PipelineDefinitionError");
}

export function inspectDependencyInputs(inputs: Record<string, unknown>, id: string) {
  const { [id]: value } = inputs;
  return {
    hasOwn: Object.hasOwn(inputs, id),
    proto: Object.getPrototypeOf(inputs),
    value,
  };
}
