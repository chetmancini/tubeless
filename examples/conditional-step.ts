import { createSteps, definePipeline } from "tubeless";

interface CacheOptions {
  cachedValue?: string;
  refresh: boolean;
}

const { step } = createSteps<CacheOptions>();

const resolveValue = step("resolve-value", {
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
  // Every policy-skip branch above supplies a string, so `value` stays `string`.
  run: ({ "resolve-value": value }) => value.toUpperCase(),
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
