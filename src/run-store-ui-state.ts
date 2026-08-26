import {
  createPipelineRunProjector,
  type PipelineRunEventQuery,
  type PipelineRunEventStore,
  type PipelineRunStoreSnapshot,
  type StoredPipelineEvent,
} from "./run-store.js";

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
  #events: readonly StoredPipelineEvent[] = [];
  #lastEventId: number | undefined;
  #operation: Promise<void> = Promise.resolve();
  #projector = createPipelineRunProjector();

  constructor(private readonly store: PipelineRunEventStore) {}

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #appendNewEvents(): Promise<readonly StoredPipelineEvent[]> {
    let cursor = this.#lastEventId;
    for (;;) {
      const query: PipelineRunEventQuery = { limit: 100_000 };
      if (cursor !== undefined) query.afterId = cursor;
      const page = await this.store.listEvents(query);
      const next = [...page]
        .filter((event) => cursor === undefined || event.id > cursor)
        .sort((left, right) => left.id - right.id);
      if (next.length === 0) break;
      this.#events = [...this.#events, ...next];
      this.#projector.append(next);
      cursor = next.at(-1)!.id;
    }
    this.#lastEventId = cursor;
    return this.#events;
  }

  readAll(): Promise<readonly StoredPipelineEvent[]> {
    return this.#serialize(() => this.#appendNewEvents());
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
      const events = await this.#appendNewEvents();
      const snapshot = this.#projector.snapshot();
      await history.clear();
      this.#events = [];
      this.#lastEventId = undefined;
      this.#projector.clear();
      return { eventCount: events.length, runCount: snapshot.runs.length };
    });
  }
}
