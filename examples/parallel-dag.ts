import { createSteps, definePipeline } from "tubeless";

interface OrderOptions {
  quantities: readonly number[];
  unitPrices: readonly number[];
}

const { step } = createSteps<OrderOptions>();

const quantities = step("quantities", {
  description: "Load order quantities independently of prices.",
  run: async (_inputs, context) => {
    await context.sleep(5, context.signal);
    return context.options.quantities;
  },
});

const prices = step("prices", {
  description: "Load unit prices independently of quantities.",
  run: async (_inputs, context) => {
    await context.sleep(5, context.signal);
    return context.options.unitPrices;
  },
});

const total = step("total", {
  description: "Compute the order total after both inputs are ready.",
  dependsOn: [quantities, prices],
  run: ({ quantities, prices }) =>
    quantities.reduce((sum, quantity, index) => sum + quantity * (prices[index] ?? 0), 0),
});

export const ParallelOrderPipeline = definePipeline({
  id: "parallel-order",
  steps: [quantities, prices, total],
});

export async function runParallelDagExample() {
  // Without this control, the two independent loaders run serially.
  // Fail-fast stops new steps but lets both active loaders settle. Use run()
  // to inspect every failure and the final reports in stable plan order.
  return ParallelOrderPipeline.runOrThrow(
    { quantities: [2, 3], unitPrices: [10, 5] },
    { maxConcurrency: 4 }
  );
}
