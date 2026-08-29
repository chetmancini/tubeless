import { createSteps, definePipeline } from "tubeless";

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
});

interface FanOutOptions {
  concurrency: number;
  shards: readonly { id: string; records: readonly string[] }[];
}

const fanOutStep = createSteps<FanOutOptions>();

const processShards = fanOutStep.forEachPipeline("process-shards", {
  pipeline: ShardPipeline,
  description: "Process shards with bounded concurrency and stable identities",
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
