import { createSteps, definePipeline, type PipelineError } from "tubeless";

interface ShardOptions {
  records: readonly string[];
  shardId: string;
}

const shardStep = createSteps<ShardOptions>();

const processRecords = shardStep("process-records", {
  description: "Process every record in one shard",
  run: async (_inputs, context) => {
    const processed: string[] = [];
    for (const [index, record] of context.options.records.entries()) {
      processed.push(record.toUpperCase());
      context.reportProgress({
        completed: index + 1,
        message: record,
        total: context.options.records.length,
      });
    }
    return { processed, shardId: context.options.shardId };
  },
});

export const ShardPipeline = definePipeline({
  id: "process-shard",
  steps: [processRecords],
  finalize: (outputs) => outputs["process-records"],
});

interface FanOutOptions {
  concurrency: number;
  shards: readonly { id: string; records: readonly string[] }[];
}

const fanOutStep = createSteps<FanOutOptions>();

const processShards = fanOutStep.forEachPipeline.skippable("process-shards", {
  pipeline: ShardPipeline,
  description: "Process shards with bounded concurrency and stable identities",
  skip: (_inputs, context) =>
    context.options.shards.length === 0 ? { reason: "no shards selected", value: [] } : false,
  items: (_inputs, context) => context.options.shards,
  key: (shard) => shard.id,
  concurrency: (_inputs, context) => context.options.concurrency,
  progress: { itemNoun: "shards" },
  mapOptions: (shard) => ({ records: shard.records, shardId: shard.id }),
});

export const FanOutPipeline = definePipeline({
  id: "fan-out",
  steps: [processShards],
  finalize: (outputs) => outputs["process-shards"] ?? [],
});

/** Select only fully identified failures; callers decide whether and when to rerun. */
export function failedShards(options: FanOutOptions, error: PipelineError) {
  const diagnostics = error.fanOut;
  if (!diagnostics || diagnostics.omittedFailureCount > 0) return undefined;
  if (diagnostics.failures.some((failure) => failure.keyTruncated)) return undefined;
  const keys = new Set(diagnostics.failures.map((failure) => failure.key));
  return options.shards.filter((shard) => keys.has(shard.id));
}
