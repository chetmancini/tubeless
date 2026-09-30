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

/** Fold a selected subtree in event order, then return its runs in parent-first order. */
export async function readPipelineRunTree(
  reader: Pick<PipelineRunEventReader, "listEvents">,
  root: StoredPipelineRun
): Promise<StoredPipelineRun[]> {
  const projector = createPipelineRunProjector({ retainLogs: false, retainArtifacts: false });
  for await (const page of readPipelineEventPages(reader, { rootRunId: root.runId }))
    projector.append(page);
  const children = new Map<string, StoredPipelineRun[]>();
  for (const run of projector.snapshot().runs) {
    if (run.parentRunId === undefined) continue;
    const siblings = children.get(run.parentRunId) ?? [];
    siblings.push(run);
    children.set(run.parentRunId, siblings);
  }
  const runs = [root];
  const visited = new Set([root.runId]);
  for (let index = 0; index < runs.length; index++) {
    for (const run of children.get(runs[index]!.runId) ?? []) {
      if (visited.has(run.runId)) continue;
      visited.add(run.runId);
      runs.push(run);
    }
  }
  return runs;
}
