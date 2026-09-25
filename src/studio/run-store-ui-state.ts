import {
  createPipelineRunProjector,
  type PipelineRunEventReader,
  type PipelineRunStoreSnapshot,
  type StoredPipelineEvent,
} from "../run-store/run-store.js";
import { readPipelineEventPages } from "../run-store/run-store-reader.js";

export interface PipelineRunStudioHistoryMaintenance {
  clear(): void | Promise<void>;
  isBusy?(): boolean | Promise<boolean>;
}

export class PipelineRunStudioHistoryBusyError extends Error {
  constructor() {
    super("Wait for active runs to finish before clearing history.");
    this.name = "PipelineRunStudioHistoryBusyError";
  }
}

/** Serializes incremental store reads and history clearing for one studio server. */
export class PipelineRunStudioEventState {
  #lastEventId: number | undefined;
  #operation: Promise<void> = Promise.resolve();
  #projector = createPipelineRunProjector({ retainLogs: false });

  constructor(private readonly store: Pick<PipelineRunEventReader, "listEvents">) {}

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #appendNewEvents(): Promise<void> {
    for await (const page of readPipelineEventPages(this.store, {
      afterId: this.#lastEventId,
      limit: 100_000,
    })) {
      this.#projector.append(page);
      this.#lastEventId = page.at(-1)!.id;
    }
  }

  async #listRunEvents(runId: string): Promise<readonly StoredPipelineEvent[]> {
    const events: StoredPipelineEvent[] = [];
    for await (const page of readPipelineEventPages(this.store, { limit: 100_000, runId })) {
      events.push(...page);
    }
    return events;
  }

  readRun(runId: string): Promise<readonly StoredPipelineEvent[]> {
    return this.#serialize(() => this.#listRunEvents(runId));
  }

  snapshot(now?: number): Promise<PipelineRunStoreSnapshot> {
    return this.#serialize(async () => {
      await this.#appendNewEvents();
      return this.#projector.snapshot(now);
    });
  }

  clear(
    history: PipelineRunStudioHistoryMaintenance
  ): Promise<{ eventCount: number; runCount: number }> {
    return this.#serialize(async () => {
      if (await history.isBusy?.()) throw new PipelineRunStudioHistoryBusyError();
      await this.#appendNewEvents();
      const snapshot = this.#projector.snapshot();
      await history.clear();
      this.#lastEventId = undefined;
      this.#projector.clear();
      return {
        eventCount: snapshot.runs.reduce((n, run) => n + run.eventCount, 0),
        runCount: snapshot.runs.length,
      };
    });
  }
}
