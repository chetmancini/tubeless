import { RunProjection } from "../../run-store/run-projection.js";
import type { PipelineRunEventReader, StoredPipelineRun } from "../../run-store/run-store.js";
import { readPipelineEventPages } from "../../run-store/run-store-reader.js";

/**
 * Detail projections retain log and artifact bodies. This keeps the selected run
 * and the expanded children touched most recently; an older open is rebuilt on demand.
 */
export const STUDIO_OPEN_RUN_LIMIT = 32;

interface RetainedRun {
  lastEventId: number;
  readonly projection: RunProjection;
}

/** Run detail retention; the server state serializes reads and clearing. */
export class StudioRunDetails {
  #runs = new Map<string, RetainedRun>();

  constructor(private readonly store: Pick<PipelineRunEventReader, "listEvents">) {}

  clear(): void {
    this.#runs.clear();
  }

  async read(runId: string): Promise<StoredPipelineRun | undefined> {
    // A new run stays local until every page folds, so a failed read rebuilds it.
    let retained = this.#runs.get(runId);
    // Pages hold only this run's events, ordered after the cursor.
    for await (const page of readPipelineEventPages(this.store, {
      afterId: retained?.lastEventId,
      limit: 100_000,
      runId,
    })) {
      for (const event of page) {
        if (retained) retained.projection.append(event);
        else retained = { lastEventId: event.id, projection: new RunProjection(event) };
        retained.lastEventId = event.id;
      }
    }
    if (!retained) return undefined;
    this.#retainRun(runId, retained);
    return retained.projection.snapshot();
  }

  #retainRun(runId: string, retained: RetainedRun): void {
    this.#runs.delete(runId);
    this.#runs.set(runId, retained);
    while (this.#runs.size > STUDIO_OPEN_RUN_LIMIT) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) return;
      this.#runs.delete(oldest);
    }
  }
}
