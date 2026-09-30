import type {
  PipelineRunEventQuery,
  PipelineRunEventReader,
  StoredPipelineEvent,
  StoredPipelineRun,
} from "./run-store.js";
import { createPipelineRunProjector } from "./run-store.js";

/**
 * Read an event source to exhaustion with bounded, ordered pages. A reader may
 * impose a smaller page cap than requested; only a page that cannot advance the
 * cursor ends the scan. The caller owns the reader and backpressure between pages.
 */
export async function* readPipelineEventPages(
  reader: Pick<PipelineRunEventReader, "listEvents">,
  query: PipelineRunEventQuery = {}
): AsyncGenerator<readonly StoredPipelineEvent[]> {
  const selection = { ...query, limit: query.limit ?? 20_000 };
  let afterId = query.afterId;
  for (;;) {
    const page = await reader.listEvents({ ...selection, afterId });
    const ordered = [...page]
      .filter((event) => afterId === undefined || event.id > afterId)
      .sort((left, right) => left.id - right.id);
    if (ordered.length === 0) return;
    const next: StoredPipelineEvent[] = [];
    for (const event of ordered) {
      if (afterId !== undefined && event.id <= afterId) continue;
      afterId = event.id;
      if (selection.runId !== undefined && event.runId !== selection.runId) continue;
      if (selection.parentRunId !== undefined && event.parentRunId !== selection.parentRunId)
        continue;
      if (selection.pipelineId !== undefined && event.pipelineId !== selection.pipelineId) continue;
      next.push(event);
    }
    if (next.length > 0) yield next;
  }
}

/** Read only the selected run's descendants, with a separate ordered fold per parent query. */
export async function readPipelineRunTree(
  reader: Pick<PipelineRunEventReader, "listEvents">,
  root: StoredPipelineRun
): Promise<StoredPipelineRun[]> {
  const runs = [root];
  const visited = new Set([root.runId]);
  for (let index = 0; index < runs.length; index++) {
    const projector = createPipelineRunProjector({ retainLogs: false, retainArtifacts: false });
    for await (const page of readPipelineEventPages(reader, { parentRunId: runs[index]!.runId }))
      projector.append(page);
    for (const run of projector.snapshot().runs) {
      if (visited.has(run.runId)) continue;
      visited.add(run.runId);
      runs.push(run);
    }
  }
  return runs;
}
