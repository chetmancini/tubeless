/**
 * Compile-only probes for #287: output observation is public; supply remains proposed.
 * Run through design/tsconfig.json, never execute this file.
 */
import { expectTypeOf } from "vitest";
import {
  createSteps,
  definePipeline,
  type Pipeline,
  type PipelineContext,
  type PipelineChildRunControls,
  type PipelineHooks,
  type PipelinePlan,
  type PipelineResult,
  type PipelineRun,
  type PipelineRunControls,
  type PipelineStepOutputObserver,
  type PipelineStepOutputRecord,
  type StandardSchemaV1,
} from "tubeless";

// Supply remains a local proposal; observation uses the real public declarations.
type ProposedRunControls<TStepId extends string, TTargetId extends string> = PipelineRunControls<
  TStepId,
  TTargetId
> & {
  readonly suppliedOutputs?: ReadonlyMap<TStepId, unknown>;
};

// This facade probes adding controls to the existing call shape without widening
// inference from the pipeline. It supplies no implementation or default-options overload.
declare const proposed: {
  run<TOptions extends object, TResult, TStepId extends string, TTargetId extends string>(
    pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
    options: NoInfer<TOptions>,
    controls?: ProposedRunControls<NoInfer<TStepId>, NoInfer<TTargetId>>,
    context?: Partial<PipelineContext>
  ): Promise<PipelineRun<TResult>>;
  plan<TOptions extends object, TResult, TStepId extends string, TTargetId extends string>(
    pipeline: Pipeline<TOptions, TResult, TStepId, TTargetId>,
    controls?: ProposedRunControls<NoInfer<TStepId>, NoInfer<TTargetId>>
  ): PipelinePlan;
};

declare const numericText: StandardSchemaV1<string, number>;
declare const decodedFromStorage: unknown;
declare const encodeLosslessly: (value: unknown) => Promise<Uint8Array>;
declare const save: (record: PipelineStepOutputRecord) => Promise<void>;

const { step } = createSteps<{ source: string }>();
const parse = step("parse", {
  description: "Parse the source text into a numeric value.",
  outputSchema: numericText,
  run: (_inputs, context) => context.options.source,
});
const finish = step("finish", {
  dependsOn: [parse],
  description: "Consume the validated numeric output.",
  run: ({ parse }) => {
    expectTypeOf(parse).toEqualTypeOf<number>();
    return parse * 2;
  },
});
const pipeline = definePipeline({
  id: "recoverable-parse",
  implementationVersion: "parse-v1",
  steps: [parse, finish],
  targets: [finish],
  finalize: finish,
});

// 1. The replay representation is the pre-schema result, not the published value.
expectTypeOf<Awaited<ReturnType<typeof parse.run>>>().toEqualTypeOf<string>();
expectTypeOf<PipelineResult<typeof pipeline>>().toEqualTypeOf<number>();

const observer: PipelineStepOutputObserver<"parse" | "finish"> = {
  async encode(value, context) {
    expectTypeOf(value).toEqualTypeOf<unknown>();
    expectTypeOf(context.signal).toEqualTypeOf<AbortSignal | undefined>();
    // The host captures bytes before any validator can mutate the raw value.
    return encodeLosslessly(value);
  },
  async write(record, context) {
    expectTypeOf(record.stepId).toEqualTypeOf<"parse" | "finish">();
    expectTypeOf(record.attemptId).toEqualTypeOf<string | undefined>();
    expectTypeOf(record.encodedValue).toEqualTypeOf<Uint8Array>();
    expectTypeOf(context.signal).toEqualTypeOf<AbortSignal | undefined>();
    await save(record);
  },
};

// 2. Decoded values are intentionally unknown; schemas validate them at runtime.
const supplied = new Map<"parse", unknown>([["parse", decodedFromStorage]]);
const run = proposed.run(
  pipeline,
  { source: "21" },
  {
    suppliedOutputs: supplied,
    outputObserver: observer,
    stepIds: ["parse", "finish"],
  }
);
expectTypeOf(run).toEqualTypeOf<Promise<PipelineRun<number>>>();
expectTypeOf(
  proposed.plan(pipeline, { suppliedOutputs: supplied, targets: ["finish"] })
).toEqualTypeOf<PipelinePlan>();

// @ts-expect-error Recovery controls must not widen required domain options.
void proposed.run(pipeline, {}, { suppliedOutputs: supplied });
// @ts-expect-error A supplied map cannot widen the pipeline's known step IDs.
void proposed.run(pipeline, { source: "21" }, { suppliedOutputs: new Map([["missing", 1]]) });
// @ts-expect-error Recovery controls must preserve declared target IDs.
proposed.plan(pipeline, { targets: ["parse"], suppliedOutputs: supplied });
// @ts-expect-error Exact selection and target selection remain mutually exclusive.
proposed.plan(pipeline, { stepIds: ["parse"], targets: ["finish"] });

// 3. Presence and value are independent. A saved undefined is a valid supplied slot.
const noValue = createSteps().step("no-value", { run: (): undefined => undefined });
const undefinedPipeline = definePipeline({ id: "undefined-output", steps: [noValue] });
expectTypeOf(
  proposed.run(
    undefinedPipeline,
    {},
    {
      suppliedOutputs: new Map([["no-value", undefined]]),
    }
  )
).toEqualTypeOf<Promise<PipelineRun<undefined>>>();

// 4. The encoding/write split supports async persistence and rejects a raw-value sink.
const synchronousObserver: PipelineStepOutputObserver = {
  encode: () => new Uint8Array(),
  write: () => {},
};
const invalidEncoder: PipelineStepOutputObserver = {
  // @ts-expect-error Encoding must produce bytes, not an arbitrary domain value.
  encode: () => ({ text: "not encoded" }),
  write: () => {},
};
const invalidWriter: PipelineStepOutputObserver = {
  encode: () => new Uint8Array(),
  // @ts-expect-error A writer receives encoded bytes and metadata, not raw schema input.
  write: (_record: { readonly value: string }) => {},
};
void [synchronousObserver, invalidEncoder, invalidWriter];

// 5. A wrapper is one recovery slot; its child's internal IDs do not enter the map.
const { fromPipeline } = createSteps<{ source: string }>();
const childControls: PipelineChildRunControls<"parse" | "finish", "finish"> = {
  targets: ["finish"],
  maxConcurrency: 2,
};
fromPipeline("configured-child", { pipeline, controls: childControls });
const wrapped = fromPipeline("wrapped", { pipeline });
const parent = definePipeline({ id: "recovery-parent", steps: [wrapped] });
void proposed.run(parent, { source: "21" }, { suppliedOutputs: new Map([["wrapped", 42]]) });
// @ts-expect-error The child's parse step is outside the parent's recovery scope.
void proposed.run(parent, { source: "21" }, { suppliedOutputs: supplied });

// 6. Supply is still absent; observation is accepted by the shipped run controls.
// @ts-expect-error Production run controls do not expose supplied outputs yet.
void pipeline.run({ source: "21" }, { suppliedOutputs: supplied });
void pipeline.run({ source: "21" }, { outputObserver: observer });
// @ts-expect-error Output observation is invocation-local, not an authored child control.
fromPipeline("invalid-observer", { pipeline, controls: { outputObserver: observer } });
const hooks: PipelineHooks = {
  onStepComplete(event) {
    // @ts-expect-error Step lifecycle hooks remain metadata-only.
    void event.value;
  },
};
void hooks;
