import { createSteps, defaultPipelineContext, definePipeline, requireOutputs } from "tubeless";
import { createPipelineRunProjector, type StoredPipelineEvent } from "tubeless/run-store";
import { openSqlitePipelineRunStore } from "tubeless/run-store/sqlite";
import { definePipelineStudio } from "tubeless/workbench/studio";
import {
  startPipelineRunStudio,
  type PipelineRunStudioLauncher,
  type PipelineRunStudioServer,
} from "tubeless/run-store/ui";

const step = createSteps<{ rows: readonly string[] }>();
const normalize = step("normalize", {
  description: "Normalize imported rows for publication.",
  run: (_inputs, context) => {
    context.log.log("normalizing", context.options.rows.length, "rows");
    return context.options.rows.map((row) => row.trim().toLowerCase());
  },
});

export const LocallyObservedPipeline = definePipeline({
  id: "locally-observed-import",
  steps: [normalize],
  targets: [normalize],
  finalize: requireOutputs([normalize], ({ normalize }) => normalize),
});

/** A checked-in catalog can register many command modules in one place. */
export const LocalStudioConfig = definePipelineStudio({
  commands: [{ file: "./cli-job.ts", export: "ImportCommand", name: "Import rows" }],
});

/**
 * Fold paged store events without walking the full history on every refresh.
 * Append only newer pages. Duplicate and out-of-order ids are ignored; `0` is a
 * valid first id. `projectPipelineRunStore` remains the one-shot wrapper.
 */
export function snapshotFromPages(pages: readonly (readonly StoredPipelineEvent[])[]) {
  const projector = createPipelineRunProjector();
  for (const page of pages) projector.append(page);
  return projector.snapshot();
}

/** Recording is opt-in; ordinary calls to the pipeline remain storage-free. */
export async function runWithLocalHistory(
  rows: readonly string[],
  filename = ".tubeless/runs.sqlite"
): Promise<readonly string[]> {
  const store = await openSqlitePipelineRunStore(filename);
  try {
    return await LocallyObservedPipeline.runOrThrow(
      { rows },
      {
        ...defaultPipelineContext(),
        tracing: { exporter: store },
      }
    );
  } finally {
    await store.close();
  }
}

/** The UI is another optional reader of the same append-only store. */
export async function serveLocalStudio(
  filename = ".tubeless/runs.sqlite",
  launcher?: PipelineRunStudioLauncher
): Promise<PipelineRunStudioServer> {
  const store = await openSqlitePipelineRunStore(filename);
  const server = await startPipelineRunStudio({
    history: { clear: () => store.clearHistory() },
    launcher,
    store,
  });
  return {
    ...server,
    close: async () => {
      await server.close();
      await store.close();
    },
  };
}
