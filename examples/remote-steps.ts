import {
  createSteps,
  definePipeline,
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
  // SAFETY: example schema trusts adapter-returned enrich output in this compiled recipe.
  value: value as EnrichResult,
}));
const chargeSchema = standardSchema<ChargeResult, ChargeResult>((value) => ({
  // SAFETY: example schema trusts adapter-returned charge output in this compiled recipe.
  value: value as ChargeResult,
}));

interface RemoteStepsOptions {
  lines: readonly string[];
}

const step = createSteps<RemoteStepsOptions>();

const parse = step("parse", {
  outputSchema: parseSchema,
  run: (_inputs, context) => ({
    rows: context.options.lines.map((line) => line.trim()).filter((line) => line.length > 0),
  }),
});

const enrichAdapter: RemoteStepAdapter<
  RemoteStepsOptions,
  { dryRun: boolean; rows: readonly string[]; runId: string },
  EnrichResult
> = {
  engine: "lambda",
  target: "enrich-v2",
  invoke: async (payload, context) => {
    context.log.log("rehearsing enrich", payload.rows.length);
    return { orderId: "order-1", rows: payload.rows };
  },
};

const enrich = step.fromRemote("enrich", {
  dependsOn: [parse],
  adapter: enrichAdapter,
  mapInput: ({ parse }, ctx) => ({
    rows: parse.rows,
    runId: ctx.runId,
    dryRun: ctx.dryRun,
  }),
  outputSchema: enrichSchema,
});

const chargeAdapter: RemoteStepAdapter<RemoteStepsOptions, { orderId: string }, ChargeResult> = {
  engine: "temporal",
  target: "chargeOrder",
  invoke: async (payload) => ({ charged: true, orderId: payload.orderId }),
};

const charge = step.fromRemote("charge", {
  dependsOn: [enrich],
  adapter: chargeAdapter,
  mapInput: ({ enrich }) => ({ orderId: enrich.orderId }),
  outputSchema: chargeSchema,
  dryRun: "skip",
});

export const RemoteStepsPipeline = definePipeline({
  id: "remote-steps",
  steps: [parse, enrich, charge],
  targets: [charge],
  finalize: (outputs) => ({
    charged: outputs.charge?.charged === true,
    orderId: outputs.enrich?.orderId,
    rows: outputs.parse?.rows ?? [],
  }),
});

export async function runRemoteStepsExample() {
  return RemoteStepsPipeline.runOrThrow({ lines: [" Alpha ", "", "Beta"] });
}
