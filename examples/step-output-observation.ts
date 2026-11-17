import {
  createSteps,
  definePipeline,
  type PipelineStepOutputRecord,
  type StandardSchemaV1,
} from "tubeless";
import { v8StepCacheCodec } from "tubeless/node";

const textLength: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (value) =>
      typeof value === "string"
        ? { value: value.length }
        : { issues: [{ message: "Expected text" }] },
  },
};
const { step } = createSteps<{ text: string }>();
const count = step("count", {
  description: "Validate the text and publish its character count.",
  run: (_inputs, context) => context.options.text,
  outputSchema: textLength,
});

export const OutputObservationPipeline = definePipeline({
  id: "output-observation",
  implementationVersion: "text-length-v1",
  steps: [count],
  finalize: count,
});

/** This host keeps encoded raw values in memory; replace write with owned persistence. */
export async function runOutputObservationExample() {
  const records: PipelineStepOutputRecord[] = [];
  const run = await OutputObservationPipeline.run(
    { text: "hello" },
    {
      outputObserver: {
        encode: v8StepCacheCodec.encode,
        write(record) {
          records.push(record);
        },
      },
    }
  );
  // The raw text is captured before the schema transforms it into a number.
  const rawOutputs = await Promise.all(
    records.map(({ encodedValue }) => v8StepCacheCodec.decode(encodedValue))
  );
  return { run, records, rawOutputs };
}
