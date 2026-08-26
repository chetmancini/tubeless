import { createSteps, definePipeline } from "tubeless";

interface CacheOptions {
  cachedValue?: string;
  refresh: boolean;
}

const step = createSteps<CacheOptions>();

const resolveValue = step.skippable("resolve-value", {
  description: "Reuse a cached value unless a refresh is required",
  skip: (_inputs, context) =>
    !context.options.refresh && context.options.cachedValue !== undefined
      ? { reason: "cached value is current", value: context.options.cachedValue }
      : false,
  run: async () => "fresh-value",
});

const formatValue = step("format-value", {
  dependsOn: [resolveValue],
  description: "Format the resolved value for the caller",
  run: ({ "resolve-value": value }) => {
    // A skippable step is always typed as T | undefined, even when this
    // policy skip publishes a value. Keep absence handling explicit.
    if (value === undefined) throw new Error("resolve-value produced no value");
    return value.toUpperCase();
  },
});

export const ConditionalCachePipeline = definePipeline({
  id: "conditional-cache",
  steps: [resolveValue, formatValue],
  finalize: (outputs) => outputs["format-value"] ?? "",
});

export async function runConditionalCacheExample() {
  return ConditionalCachePipeline.runOrThrow({
    cachedValue: "cached-value",
    refresh: false,
  });
}
