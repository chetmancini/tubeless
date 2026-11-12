// Type-checked only: never executed.
import { createSteps, definePipeline, type PipelineInput } from "tubeless";
import { createPipelineTestRuntime, overrideStep } from "tubeless/testing";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const { step } = createSteps<{ lines: readonly string[] }>();

const load = step("load", { run: (_inputs, context) => context.options.lines });
const count = step("count", {
  dependsOn: [load],
  run: ({ load: rows }) => {
    const rowsFlow: Equal<typeof rows, readonly string[]> = true; // dependency output → input
    void rowsFlow;
    return rows.length;
  },
});

const pipeline = definePipeline({ id: "packed-inference", steps: [load, count] });
const literalId: Equal<typeof pipeline.id, "packed-inference"> = true;
const input: Equal<PipelineInput<typeof pipeline>, { lines: readonly string[] }> = true;
// A definition without `finalize` publishes the union of every step output, plus absent.
const result: Promise<readonly string[] | number | undefined> = pipeline.runOrThrow({ lines: [] });
// @ts-expect-error The required option is preserved.
pipeline.runOrThrow({});

const test = createPipelineTestRuntime();
const run = test.run(
  pipeline,
  { lines: [] },
  { stepIds: ["load", "count"], overrides: [overrideStep(load, ["a"])] }
);
// @ts-expect-error An override preserves the step's validated output type.
const rejectedOverride = overrideStep(load, 42);
