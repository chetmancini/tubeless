import { createSteps, definePipeline } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";

const { step } = createSteps<{ text: string }>();
const load = step("load", { run: (_inputs, context) => context.options.text });
const count = step("count", {
  dependsOn: [load],
  cache: { version: "count-v1" },
  // The default key hashes dependency inputs and validated options.
  // Use cache.key when only a subset matters, or inputs need custom encoding.
  // Return plain data; class results need a cache.codec that reconstructs them.
  run: ({ load }, context) => {
    context.log.log("Counting characters");
    return load.length;
  },
});

export const CachedCountPipeline = definePipeline({
  id: "cached-count",
  steps: [load, count],
  cache: { maxAge: "30 days" },
  finalize: count,
});

// Cache writes and reuse appear automatically as artifacts in history and Studio.
// Results live under <run cwd>/.cache/cached-count/count/.
// The built-in --cache recompute or --cache bypass overrides cache policy.
export const CachedCountCommand = definePipelineCommand(CachedCountPipeline, {
  params: { text: { type: "string", required: true } },
});
