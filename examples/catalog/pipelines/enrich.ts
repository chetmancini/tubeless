import {
  createSteps,
  definePipeline,
  requireOutputs,
  type RemoteStepAdapter,
  type StandardSchemaV1,
} from "tubeless";

function standardSchema<TInput, TOutput>(
  validate: StandardSchemaV1<TInput, TOutput>["~standard"]["validate"]
): StandardSchemaV1<TInput, TOutput> {
  return { "~standard": { validate, vendor: "example", version: 1 } };
}

interface ParseResult {
  readonly rows: readonly string[];
}

interface EnrichResult {
  readonly orderId: string;
  readonly rows: readonly string[];
}

interface ChargeResult {
  readonly charged: true;
  readonly orderId: string;
}

const parseSchema = standardSchema<ParseResult, ParseResult>((value) => ({
  // SAFETY: example schema trusts locally constructed parse output from the step run above.
  value: value as ParseResult,
}));
const enrichSchema = standardSchema<EnrichResult, EnrichResult>((value) => ({
  // SAFETY: example schema trusts test adapter enrich output in this catalog pipeline.
  value: value as EnrichResult,
}));
const chargeSchema = standardSchema<ChargeResult, ChargeResult>((value) => ({
  // SAFETY: example schema trusts test adapter charge output in this catalog pipeline.
  value: value as ChargeResult,
}));

interface EnrichOptions {
  lines: readonly string[];
}

const step = createSteps<EnrichOptions>();

const parseRows = step("parse-rows", {
  description: "Trim and drop blank rows from caller input.",
  outputSchema: parseSchema,
  run: (_inputs, context) => ({
    rows: context.options.lines.map((line) => line.trim()).filter((line) => line.length > 0),
  }),
});

const enrichAdapter: RemoteStepAdapter<
  EnrichOptions,
  { dryRun: boolean; rows: readonly string[]; runId: string },
  EnrichResult
> = {
  engine: "test",
  target: "enrich-rows",
  invoke: async (payload, context) => {
    context.log.log("rehearsing enrich", payload.rows.length);
    return { orderId: "order-1", rows: payload.rows };
  },
};

const enrichRows = step.fromRemote("enrich-rows", {
  dependsOn: [parseRows],
  description: "Rehearse a remote enrich during dry-run.",
  adapter: enrichAdapter,
  mapInput: ({ "parse-rows": parse }, ctx) => ({
    rows: parse.rows,
    runId: ctx.runId,
    dryRun: ctx.dryRun,
  }),
  outputSchema: enrichSchema,
});

const chargeAdapter: RemoteStepAdapter<EnrichOptions, { orderId: string }, ChargeResult> = {
  engine: "test",
  target: "charge-order",
  invoke: async (payload) => ({ charged: true, orderId: payload.orderId }),
};

const chargeOrder = step.fromRemote("charge-order", {
  dependsOn: [enrichRows],
  description: "Skip remote charge during dry-run.",
  adapter: chargeAdapter,
  mapInput: ({ "enrich-rows": enrich }) => ({ orderId: enrich.orderId }),
  outputSchema: chargeSchema,
  dryRun: "skip",
});

export const EnrichPipeline = definePipeline({
  id: "enrich",
  steps: [parseRows, enrichRows, chargeOrder],
  targets: [chargeOrder],
  finalize: requireOutputs([parseRows, enrichRows], (outputs) => ({
    orderId: outputs["enrich-rows"].orderId,
    rows: outputs["parse-rows"].rows,
  })),
});
