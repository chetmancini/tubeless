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
      if (selection.pipelineId !== undefined && event.pipelineId !== selection.pipelineId) continue;
      next.push(event);
    }
    if (next.length > 0) yield next;
  }
}

/** Fold an adapter-selected subtree in event order, retaining the supplied root snapshot. */
export async function readPipelineRunTree(
  reader: Pick<PipelineRunEventReader, "listEvents">,
  root: StoredPipelineRun
): Promise<StoredPipelineRun[]> {
  const projector = createPipelineRunProjector({ retainLogs: false, retainArtifacts: false });
  for await (const page of readPipelineEventPages(reader, { rootRunId: root.runId }))
    projector.append(page);
  return [root, ...projector.snapshot().runs.filter((run) => run.runId !== root.runId)];
}
