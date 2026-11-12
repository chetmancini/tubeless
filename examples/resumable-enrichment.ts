import { createSteps, definePipeline } from "tubeless";
import { runBatched } from "tubeless/batch";
import { definePipelineCommand } from "tubeless/cli";
import { withCheckpointedBatch } from "tubeless/node";
import { RateLimiter } from "tubeless/rate-limit";
import { withRetry } from "tubeless/retry";

interface EnrichmentOptions {
  items: readonly string[];
}

interface EnrichedItem {
  id: string;
  summary: string;
}

const { step } = createSteps<EnrichmentOptions>();

const loadPendingItems = step("load-pending-items", {
  description: "Skip work that was already checkpointed by a previous run.",
  run: (_inputs, context) => context.options.items.filter((item) => !context.checkpoint?.has(item)),
});

const enrichItems = step("enrich-items", {
  dependsOn: [loadPendingItems],
  description: "Process API work in small batches with retry and rate limiting.",
  dryRun: "skip",
  run: async ({ "load-pending-items": items }, context) => {
    const checkpoint = context.checkpoint;
    const limiter = new RateLimiter(100);

    return runBatched(items, { size: 5, concurrency: 2, signal: context.signal }, async (batch) => {
      const enriched = await Promise.all(
        batch.map((id) =>
          withRetry(
            async (): Promise<EnrichedItem> => {
              await limiter.wait(context.signal);
              return { id, summary: `summary for ${id}` };
            },
            {
              baseDelayMs: 250,
              maxAttempts: 3,
              signal: context.signal,
              sleep: context.sleep,
            }
          )
        )
      );

      const persist = async () => {
        // Persist `enriched` here before recording the checkpoint.
        void enriched;
      };
      if (checkpoint) await withCheckpointedBatch(checkpoint, batch, (id) => id, persist);
      else await persist();

      return enriched;
    });
  },
});

export const EnrichmentPipeline = definePipeline({
  id: "enrichment",
  steps: [loadPendingItems, enrichItems],
  finalize: (outputs) => ({
    enrichedCount: outputs["enrich-items"]?.flat().length ?? 0,
  }),
});

/** `--resume` skips recorded items; a full successful run clears the checkpoint. */
export const EnrichmentCommand = definePipelineCommand(EnrichmentPipeline, {
  description: "Enrich items in batches, resuming from a managed checkpoint.",
  checkpoint: { path: "enrichment.checkpoint.json" },
  params: {
    items: { type: "string", multiple: true, flag: "item", description: "Item ID to enrich." },
  },
});
