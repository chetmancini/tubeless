import { createSteps, definePipeline } from "tubeless";
import { definePipelineCommand } from "tubeless/cli";

interface LiveTuiOptions {
  delay: number;
}

type DetailStatus = "completed" | "pending" | "running";

const SOURCES = ["west", "east", "north", "south"] as const;
const ARTIFACTS = ["index.json", "manifest.json", "checksums.txt"] as const;
const DEFAULT_DELAY_MS = 450;

const step = createSteps<LiveTuiOptions>();

function sequentialStatus(index: number, current: number): DetailStatus {
  if (index < current) return "completed";
  if (index === current) return "running";
  return "pending";
}

function overlappingStatus(index: number, head: number): DetailStatus {
  if (index < head) return "completed";
  if (index === head || index === head + 1) return "running";
  return "pending";
}

const discover = step("discover", {
  name: "Discover Sources",
  description: "Walk catalogs one at a time so nested running details shimmer.",
  run: async (_inputs, context) => {
    for (let current = 0; current < SOURCES.length; current += 1) {
      context.reportProgress({
        completed: current,
        total: SOURCES.length,
        message: "catalogs",
        details: SOURCES.map((source, index) => ({
          id: source,
          label: "scan",
          status: sequentialStatus(index, current),
        })),
      });
      await context.sleep(context.options.delay, context.signal);
    }
    return [...SOURCES];
  },
});

const fetch = step("fetch", {
  name: "Fetch Records",
  dependsOn: [discover],
  description: "Overlap two in-flight sources while later ones wait.",
  run: async ({ discover: sources }, context) => {
    const records = new Map<string, number>();
    for (const [head, source] of sources.entries()) {
      context.reportProgress({
        completed: head,
        total: sources.length,
        message: "sources",
        details: sources.map((id, index) => ({
          id,
          label: "download",
          status: overlappingStatus(index, head),
        })),
      });
      records.set(source, (head + 1) * 40);
      await context.sleep(context.options.delay, context.signal);
    }
    return records;
  },
});

const transform = step("transform", {
  name: "Transform Rows",
  dependsOn: [fetch],
  description: "Determinate parent progress without nested details.",
  run: async ({ fetch: records }, context) => {
    const batches = 6;
    let rows = 0;
    for (let completed = 1; completed <= batches; completed += 1) {
      rows += 12;
      context.reportProgress({
        completed,
        total: batches,
        message: "batches",
      });
      await context.sleep(context.options.delay, context.signal);
    }
    return { records, rows };
  },
});

const publish = step("publish", {
  name: "Publish Manifest",
  dependsOn: [transform],
  description: "Final named step before finalize.",
  run: async ({ transform: output }, context) => {
    for (let current = 0; current < ARTIFACTS.length; current += 1) {
      context.reportProgress({
        completed: current,
        total: ARTIFACTS.length,
        message: "files",
        details: ARTIFACTS.map((id, index) => ({
          id,
          label: "write",
          status: sequentialStatus(index, current),
        })),
      });
      await context.sleep(context.options.delay, context.signal);
    }
    return { artifacts: ARTIFACTS.length, rows: output.rows };
  },
});

export const LiveTuiPipeline = definePipeline({
  id: "live-tui",
  steps: [discover, fetch, transform, publish],
  targets: [publish],
  finalize: async (outputs, context) => {
    await context.sleep(context.options.delay * 2, context.signal);
    return outputs.publish ?? { artifacts: 0, rows: 0 };
  },
});

/**
 * Slow on purpose so the interactive reporter can be watched in a color TTY.
 *
 *   bun examples/live-tui.ts
 *   bun examples/live-tui.ts --delay 250
 */
export const LiveTuiCommand = definePipelineCommand(LiveTuiPipeline, {
  description: "Watch named steps, nested running details, and finalize on the live TUI.",
  params: {
    delay: {
      type: "number",
      optional: true,
      integer: true,
      min: 50,
      description: "Milliseconds to hold each progress tick (default 450).",
    },
  },
  mapOptions: (args) => ({ delay: args.delay ?? DEFAULT_DELAY_MS }),
  summarize: (result) => [`Published ${result.artifacts} artifact(s) from ${result.rows} rows.`],
});

if (import.meta.main) {
  void LiveTuiCommand.main();
}
