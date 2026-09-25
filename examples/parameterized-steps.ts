import { createSteps, definePipeline, type Step } from "tubeless";

interface OrderOptions {
  quantities: readonly number[];
  prices: readonly number[];
}

const { step } = createSteps<OrderOptions>();

interface RangeCheckSpec {
  readonly id: string;
  readonly description: string;
  readonly source: Step<string, readonly number[], OrderOptions>;
  readonly min: number;
  readonly max: number;
}

function rangeCheck<const TId extends string>(spec: RangeCheckSpec & { readonly id: TId }) {
  return step(spec.id, {
    description: spec.description,
    dependsOn: [spec.source],
    run: (inputs) => {
      // The source is an ordinary step reference, so its output is readonly number[].
      const values = inputs[spec.source.id];
      if (values.some((value) => !Number.isFinite(value) || value < spec.min || value > spec.max)) {
        throw new Error(`${spec.id}: expected values between ${spec.min} and ${spec.max}`);
      }
      return values.length;
    },
  });
}

// Recipe-local helper: every check has the same output type. Keeping the factory
// concrete avoids claiming arbitrary callbacks preserve per-spec output types.
export function defineRangeChecks<const TSpecs extends readonly RangeCheckSpec[]>(specs: TSpecs) {
  // SAFETY: map calls rangeCheck once per specification in order. The factory
  // uses that specification's exact ID and always returns a numeric output.
  return specs.map((spec) => rangeCheck(spec)) as {
    readonly [K in keyof TSpecs]: ReturnType<typeof rangeCheck<TSpecs[K]["id"]>>;
  };
}

export const quantities = step("quantities", {
  description: "Read order quantities.",
  run: (_inputs, context) => context.options.quantities,
});

export const prices = step("prices", {
  description: "Read unit prices.",
  run: (_inputs, context) => context.options.prices,
});

// Expanded synchronously during module loading, before definePipeline validates
// the graph. IDs, constants, and dependencies remain visible in one declaration.
export const checks = defineRangeChecks([
  {
    id: "positive-quantities",
    description: "Require at least one item per order line.",
    source: quantities,
    min: 1,
    max: Infinity,
  },
  {
    id: "bounded-quantities",
    description: "Keep order quantities within the fulfillment limit.",
    source: quantities,
    min: 0,
    max: 100,
  },
  {
    id: "valid-prices",
    description: "Keep unit prices within the catalog range.",
    source: prices,
    min: 0,
    max: 10_000,
  },
]);

const summarize = step("summarize", {
  description: "Summarize the order after every range check passes.",
  dependsOn: checks,
  run: (inputs) => ({
    quantityCount: inputs["positive-quantities"],
    priceCount: inputs["valid-prices"],
  }),
});

export const OrderChecksPipeline = definePipeline({
  id: "order-checks",
  steps: [quantities, prices, ...checks, summarize],
  targets: [...checks, summarize],
});

export async function runParameterizedStepsExample() {
  return OrderChecksPipeline.runOrThrow({ quantities: [2, 3], prices: [10, 5] });
}
